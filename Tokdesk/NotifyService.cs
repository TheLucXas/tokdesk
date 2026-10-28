using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace Tokdesk;

/// <summary>
/// Controla el notificador liviano del lanzador (Tokdesk.exe --notify): le deja las cookies, el idioma,
/// las categorías elegidas y los textos traducidos (cifrados con DPAPI), lo inicia, lo detiene y lo pone
/// a arrancar con Windows.
/// </summary>
static class NotifyService
{
    static readonly string ConfigFile = Path.Combine(AppInfo.DataDir, "notify.dat");
    const string RunName = "TokdeskNotify";

    // Solo existe con el lanzador (la build de desarrollo se abre sin él)
    public static bool Available => AppInfo.HasLauncher;

    static string Groups(AppSettings s) => string.Join(",", new[]
    {
        s.NotifyComments ? "2" : null, s.NotifyLikes ? "3" : null, s.NotifyMentions ? "6" : null,
        s.NotifyFollowers ? "7" : null, s.NotifyOther ? "509" : null,
    }.Where(x => x != null));

    public static async Task Update(AppSettings s, Engine engine, IReadOnlyDictionary<string, string> strings, string lang)
    {
        try
        {
            if (!s.Notifications || !Available || engine == null)
            {
                Stop();
                ApplyStartup(false);
                try { File.Delete(ConfigFile); } catch { }
                return;
            }
            var cookie = await engine.CookieHeader();
            if (string.IsNullOrEmpty(cookie) || !cookie.Contains("sessionid")) return; // sin sesión no hay avisos
            var sb = new StringBuilder();
            void Add(string k, string v) => sb.Append(k).Append('=').Append((v ?? "").Replace("\r", "").Replace("\n", "\\n")).Append('\n');
            Add("cookie", cookie);
            Add("ua", engine.UserAgent);
            Add("lang", string.IsNullOrEmpty(lang) ? "es" : lang);
            Add("groups", Groups(s));
            Add("interval", s.NotifyInterval.ToString());
            if (strings != null) foreach (var kv in strings) Add("s." + kv.Key, kv.Value);
            var data = ProtectedData.Protect(Encoding.UTF8.GetBytes(sb.ToString()), null, DataProtectionScope.CurrentUser);
            await File.WriteAllBytesAsync(ConfigFile, data);
            ApplyStartup(s.NotifyBackground);
            Restart();
        }
        catch (Exception ex) { Log.Write("Notificaciones: " + ex.Message); }
    }

    /// <summary>Reinicia el notificador para que use la versión actual del lanzador y la configuración nueva.</summary>
    static void Restart()
    {
        Stop();
        for (var i = 0; i < 30 && Running(); i++) Thread.Sleep(100);
        Process.Start(new ProcessStartInfo(AppInfo.StartPath, "--notify") { UseShellExecute = false });
    }

    static bool Running()
    {
        if (!Mutex.TryOpenExisting("Tokdesk.Notifier", out var m)) return false;
        m.Dispose();
        return true;
    }

    public static void Stop()
    {
        try { if (EventWaitHandle.TryOpenExisting("Tokdesk.NotifierExit", out var ev)) using (ev) ev.Set(); } catch { }
    }

    static void ApplyStartup(bool on)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
            if (on && Available) key.SetValue(RunName, $"\"{AppInfo.StartPath}\" --notify");
            else key.DeleteValue(RunName, false);
        }
        catch { }
    }
}
