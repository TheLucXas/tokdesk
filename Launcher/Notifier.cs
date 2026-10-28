using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace TokdeskLauncher;

/// <summary>
/// Notificaciones de actividad con la app cerrada (Tokdesk.exe --notify).
/// Proceso liviano sin WebView2: consulta los avisos de TikTok con las cookies que deja la app
/// (cifradas con DPAPI) y los muestra como notificaciones de Windows.
/// </summary>
static class Notifier
{
    static readonly string DataDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Tokdesk");
    static readonly string ConfigFile = Path.Combine(DataDir, "notify.dat");
    static readonly string StateFile = Path.Combine(DataDir, "notify-state.txt");

    static NotifyIcon _icon;
    static Control _ui;
    static Dictionary<string, string> _cfg = new Dictionary<string, string>();
    static readonly Dictionary<int, long> Last = new Dictionary<int, long>();
    static DateTime _pausedUntil;
    static int _busy;

    public static int Run()
    {
        using var mutex = new Mutex(true, "Tokdesk.Notifier", out var first);
        if (!first) return 0;
        ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
        LoadConfig();
        LoadState();

        _ui = new Control();
        _ui.CreateControl();
        var menu = new ContextMenuStrip();
        menu.Items.Add(S("open", "Abrir Tokdesk"), null, (_, _) => OpenApp());
        menu.Items.Add(S("pause", "Pausar 1 hora"), null, (_, _) => _pausedUntil = DateTime.Now.AddHours(1));
        menu.Items.Add(S("quit", "Salir"), null, (_, _) => Application.Exit());
        _icon = new NotifyIcon
        {
            Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location),
            Text = "Tokdesk",
            ContextMenuStrip = menu,
            Visible = true,
        };
        _icon.BalloonTipClicked += (_, _) => OpenApp();
        _icon.DoubleClick += (_, _) => OpenApp();

        // La app pide cerrar este proceso (al actualizarse o al desactivar las notificaciones)
        var exit = new EventWaitHandle(false, EventResetMode.AutoReset, "Tokdesk.NotifierExit");
        new Thread(() => { exit.WaitOne(); _ui.BeginInvoke(new Action(Application.Exit)); }) { IsBackground = true }.Start();

        var timer = new System.Windows.Forms.Timer { Interval = 5000 };
        timer.Tick += (_, _) =>
        {
            timer.Interval = Math.Max(1, Int("interval", 2)) * 60000;
            if (DateTime.Now >= _pausedUntil) Task.Run(Poll);
        };
        timer.Start();
        _ui.BeginInvoke(new Action(Trim));
        Application.Run();
        _icon.Visible = false;
        _icon.Dispose();
        return 0;
    }

    static void OpenApp()
    {
        try { Process.Start(new ProcessStartInfo(Assembly.GetExecutingAssembly().Location) { UseShellExecute = false }); } catch { }
    }

    static string S(string key, string def) => _cfg.TryGetValue("s." + key, out var v) && v.Length > 0 ? v : def;
    static int Int(string key, int def) => _cfg.TryGetValue(key, out var v) && int.TryParse(v, out var n) ? n : def;

    // ---------- Configuración que escribe la app (cookies, idioma, categorías y textos traducidos) ----------

    static void LoadConfig()
    {
        try
        {
            var raw = ProtectedData.Unprotect(File.ReadAllBytes(ConfigFile), null, DataProtectionScope.CurrentUser);
            var cfg = new Dictionary<string, string>();
            foreach (var line in Encoding.UTF8.GetString(raw).Split('\n'))
            {
                var i = line.IndexOf('=');
                if (i > 0) cfg[line.Substring(0, i)] = line.Substring(i + 1).Replace("\\n", "\n");
            }
            _cfg = cfg;
        }
        catch { }
    }

    static void LoadState()
    {
        try
        {
            foreach (var line in File.ReadAllLines(StateFile))
            {
                var p = line.Split('=');
                if (p.Length == 2 && int.TryParse(p[0], out var g) && long.TryParse(p[1], out var t)) Last[g] = t;
            }
        }
        catch { }
    }

    static void SaveState()
    {
        try { File.WriteAllLines(StateFile, Last.Select(kv => kv.Key + "=" + kv.Value)); } catch { }
    }

    // ---------- Consulta ----------

    static void Poll()
    {
        if (Interlocked.Exchange(ref _busy, 1) == 1) return;
        try
        {
            LoadConfig(); // la app la renueva al abrirse (cookies y preferencias)
            if (!_cfg.ContainsKey("cookie")) return;
            var groups = (_cfg.TryGetValue("groups", out var gs) ? gs : "").Split(',')
                .Select(x => int.TryParse(x, out var n) ? n : 0).Where(n => n > 0).ToArray();
            var news = new List<string>();
            foreach (var g in groups)
            {
                var list = Fetch(g);
                if (list == null) continue;
                var known = Last.TryGetValue(g, out var last);
                long max = last;
                foreach (Dictionary<string, object> n in list)
                {
                    var t = Convert.ToInt64(n.TryGetValue("create_time", out var ct) ? ct : 0);
                    if (t > max) max = t;
                    // La primera vez solo se toma nota de lo que ya había, sin avisar
                    if (known && t > last) { var text = Describe(g, n); if (text != null) news.Add(text); }
                }
                Last[g] = max;
            }
            SaveState();
            if (news.Count > 0) _ui.BeginInvoke(new Action(() => Show(news)));
        }
        catch { }
        finally { Interlocked.Exchange(ref _busy, 0); Trim(); }
    }

    // Entre consultas no hace nada: se devuelve la memoria al sistema (queda en pocos MB)
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    static extern bool SetProcessWorkingSetSize(IntPtr process, IntPtr min, IntPtr max);

    static void Trim()
    {
        GC.Collect();
        GC.WaitForPendingFinalizers();
        try { SetProcessWorkingSetSize(Process.GetCurrentProcess().Handle, (IntPtr)(-1), (IntPtr)(-1)); } catch { }
    }

    static ArrayList Fetch(int group)
    {
        var lang = _cfg.TryGetValue("lang", out var l) ? l : "es";
        var gl = Uri.EscapeDataString("[{\"count\":5,\"is_mark_read\":0,\"group\":" + group + ",\"max_time\":0,\"min_time\":0}]");
        var url = $"https://www.tiktok.com/api/notice/multi/?aid=1988&app_language={lang}&device_platform=web_pc&group_list={gl}";
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.Referer = "https://www.tiktok.com/";
        req.UserAgent = _cfg.TryGetValue("ua", out var ua) ? ua : "Mozilla/5.0";
        req.Headers["Cookie"] = _cfg["cookie"];
        req.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
        req.Timeout = 20000;
        using var resp = (HttpWebResponse)req.GetResponse();
        using var reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8);
        var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.DeserializeObject(reader.ReadToEnd()) as Dictionary<string, object>;
        if (json == null || !(json.TryGetValue("notice_lists", out var nl) && nl is object[] lists) || lists.Length == 0) return null;
        return (lists[0] as Dictionary<string, object>)?.TryGetValue("notice_list", out var items) == true && items is object[] arr ? new ArrayList(arr) : null;
    }

    static object Get(object o, params string[] path)
    {
        foreach (var k in path)
        {
            if (o is Dictionary<string, object> d && d.TryGetValue(k, out var v)) o = v;
            else if (o is object[] a && int.TryParse(k, out var i) && i < a.Length) o = a[i];
            else return null;
        }
        return o;
    }

    static string Str(object o, params string[] path) => Get(o, path) as string ?? "";

    // Texto de cada aviso según su grupo (2 comentarios, 3 me gusta, 6 menciones, 7 seguidores, 509 otra actividad)
    static string Describe(int group, Dictionary<string, object> n)
    {
        switch (group)
        {
            case 2:
                {
                    var nick = Str(n, "comment", "comment", "user", "nickname");
                    var text = Str(n, "comment", "comment", "text");
                    var reply = Get(n, "comment", "reply_comment", "text") != null;
                    return nick + " " + string.Format(S(reply ? "reply" : "comment", reply ? "respondió a tu comentario: {0}" : "comentó: {0}"), text);
                }
            case 6:
                {
                    var nick = Str(n, "at", "user_info", "nickname");
                    if (nick.Length == 0) nick = Str(n, "at", "comment", "user", "nickname");
                    var text = Str(n, "at", "content");
                    return nick + " " + string.Format(S("mention", "te mencionó: {0}"), text);
                }
            case 7:
                return Str(n, "follow", "from_user", "nickname") + " " + S("follow", "comenzó a seguirte");
            default:
                {
                    var nick = Str(n, "template_notice", "notice", "title", "from_users", "0", "nickname");
                    var count = Convert.ToInt32(Get(n, "template_notice", "notice", "title", "merge_count") ?? 1);
                    var ev = Str(n, "template_notice", "notice", "event");
                    if (ev.Length == 0) return null;
                    if (count > 1) nick += " " + string.Format(S("more", "y {0} más"), count - 1);
                    return (nick + " " + ev).Trim();
                }
        }
    }

    static void Show(List<string> news)
    {
        var text = string.Join("\n", news.Take(3));
        if (news.Count > 3) text += "\n" + string.Format(S("andmore", "y {0} más"), news.Count - 3);
        _icon.ShowBalloonTip(8000, "Tokdesk", text, ToolTipIcon.None);
    }
}
