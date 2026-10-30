using System.Diagnostics;
using System.IO;
using System.Net.Http;
using Microsoft.Win32;

namespace Tokdesk;

/// <summary>
/// Enlaces de TikTok que se abren en la app (como la app de Android): por argumento (Tokdesk.exe &lt;enlace&gt;),
/// por el protocolo tokdesk:// y, si el usuario lo activa, como gestor de enlaces web de Windows
/// (los que no son de TikTok los reenvía el lanzador al navegador de siempre).
/// </summary>
static class Links
{
    // Los mismos dominios de TikTok que abre la app de Android (sin tienda ni servicios internos)
    static readonly string[] Hosts = { "tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "t.tiktok.com", "us.tiktok.com" };
    static readonly string[] Short = { "vm.tiktok.com", "vt.tiktok.com", "t.tiktok.com" };
    static readonly string Pending = Path.Combine(AppInfo.DataDir, "pending-link.txt");
    const string ProgId = "TokdeskURL";

    public static bool IsTikTok(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && (u.Scheme == "http" || u.Scheme == "https") && Hosts.Contains(u.Host.ToLowerInvariant());

    /// <summary>Primer argumento que sea un enlace de TikTok o tokdesk://, ya convertido a https.</summary>
    public static string FromArgs(IEnumerable<string> args)
    {
        foreach (var a in args)
        {
            var s = UrlFromFile(a.Trim('"')) ?? a.Trim('"');
            if (s.StartsWith("tokdesk:", StringComparison.OrdinalIgnoreCase))
            {
                // tokdesk://open?u=<enlace> o tokdesk://www.tiktok.com/...
                var rest = s.Substring(8).TrimStart('/');
                if (rest.StartsWith("open?u=", StringComparison.OrdinalIgnoreCase)) s = Uri.UnescapeDataString(rest.Substring(7));
                else s = "https://" + rest;
            }
            if (IsTikTok(s)) return s;
        }
        return null;
    }

    /// <summary>
    /// Accesos directos de Internet (.url, .website) o un .txt con el enlace: los que llegan por el clic derecho
    /// «Abrir en Tokdesk» o por «Enviar a».
    /// </summary>
    static string UrlFromFile(string path)
    {
        try
        {
            var ext = Path.GetExtension(path).ToLowerInvariant();
            if (ext is not (".url" or ".website" or ".txt") || !File.Exists(path) || new FileInfo(path).Length > 64 * 1024) return null;
            foreach (var line in File.ReadLines(path))
            {
                var l = line.Trim();
                if (l.StartsWith("URL=", StringComparison.OrdinalIgnoreCase)) l = l[4..];
                var m = System.Text.RegularExpressions.Regex.Match(l, @"https?://[^\s""'<>]+");
                if (m.Success && IsTikTok(m.Value)) return m.Value;
            }
        }
        catch { }
        return null;
    }

    /// <summary>
    /// «Enviar a > Tokdesk» (para accesos directos .url, como los que se crean al arrastrar un enlace al escritorio).
    /// El menú del navegador sobre un enlace es del navegador, y en los .url Windows ignora los verbos agregados.
    /// </summary>
    public static void RegisterShellMenu()
    {
        if (!AppInfo.HasLauncher) return;
        try
        {
            var sendTo = Environment.GetFolderPath(Environment.SpecialFolder.SendTo);
            var lnk = Path.Combine(sendTo, "Tokdesk.lnk");
            if (!File.Exists(lnk) && Directory.Exists(sendTo))
            {
                var shell = Type.GetTypeFromProgID("WScript.Shell");
                dynamic ws = Activator.CreateInstance(shell);
                dynamic sc = ws.CreateShortcut(lnk);
                sc.TargetPath = AppInfo.StartPath;
                sc.IconLocation = AppInfo.StartPath + ",0";
                sc.Description = "Abrir el enlace de TikTok en Tokdesk";
                sc.Save();
            }
        }
        catch (Exception ex) { Log.Write("Menú contextual: " + ex.Message); }
    }

    // Otra instancia recibió un enlace: lo deja en un archivo para la ventana que ya está abierta
    public static void SetPending(string url) { try { File.WriteAllText(Pending, url); } catch { } }
    public static string TakePending()
    {
        try { if (!File.Exists(Pending)) return null; var u = File.ReadAllText(Pending).Trim(); File.Delete(Pending); return u; }
        catch { return null; }
    }

    /// <summary>Los enlaces cortos (vm.tiktok.com/…) redirigen al video: se sigue la redirección.</summary>
    public static async Task<string> Resolve(HttpClient http, string url)
    {
        try
        {
            if (!Short.Contains(new Uri(url).Host.ToLowerInvariant())) return url;
            using var resp = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
            return resp.RequestMessage?.RequestUri?.ToString() ?? url;
        }
        catch { return url; }
    }

    [System.Runtime.InteropServices.ComImport, System.Runtime.InteropServices.Guid("1f76a169-f994-40ac-8fc8-0959e8874710"),
     System.Runtime.InteropServices.InterfaceType(System.Runtime.InteropServices.ComInterfaceType.InterfaceIsIUnknown)]
    interface IApplicationAssociationRegistrationUI
    {
        [System.Runtime.InteropServices.PreserveSig]
        int LaunchAdvancedAssociationUI([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string appRegistryName);
    }

    // API de Windows para mostrar los valores predeterminados de una app registrada (la elección la hace el usuario)
    static bool OpenAppDefaults(string app)
    {
        try
        {
            var t = Type.GetTypeFromCLSID(new Guid("1968106d-f3b5-44cf-890e-116fcb9ecef1"));
            var ui = (IApplicationAssociationRegistrationUI)Activator.CreateInstance(t);
            var hr = ui.LaunchAdvancedAssociationUI(app);
            Log.Write($"Gestor de enlaces: página de {app} (hr=0x{hr:X8})");
            return hr == 0;
        }
        catch (Exception ex) { Log.Write("Gestor de enlaces: " + ex.Message); return false; }
    }

    /// <summary>Registra tokdesk:// para el usuario (sin administrador).</summary>
    public static void RegisterProtocol()
    {
        if (!AppInfo.HasLauncher) return;
        try
        {
            using var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\tokdesk");
            k.SetValue("", "URL:Tokdesk");
            k.SetValue("URL Protocol", "");
            using var c = k.CreateSubKey(@"shell\open\command");
            c.SetValue("", $"\"{AppInfo.StartPath}\" \"%1\"");
        }
        catch (Exception ex) { Log.Write("Protocolo tokdesk: " + ex.Message); }
    }

    /// <summary>
    /// Ofrece Tokdesk como app para enlaces web (http/https). Windows no deja que una app se ponga sola como
    /// predeterminada: el usuario la elige en Configuración. Se recuerda el navegador anterior para reenviarle
    /// los enlaces que no son de TikTok.
    /// </summary>
    public static void ApplyHandler(bool on)
    {
        if (!AppInfo.HasLauncher) return;
        try
        {
            if (on)
            {
                using (var choice = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice"))
                {
                    var prev = choice?.GetValue("ProgId") as string;
                    if (!string.IsNullOrEmpty(prev) && prev != ProgId)
                        using (var t = Registry.CurrentUser.CreateSubKey(@"Software\Tokdesk")) t.SetValue("ForwardProgId", prev);
                }
                using (var p = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{ProgId}"))
                {
                    p.SetValue("", "Enlace de TikTok (Tokdesk)");
                    p.SetValue("URL Protocol", "");
                    using (var i = p.CreateSubKey("DefaultIcon")) i.SetValue("", AppInfo.StartPath + ",0");
                    using (var c = p.CreateSubKey(@"shell\open\command")) c.SetValue("", $"\"{AppInfo.StartPath}\" \"%1\"");
                }
                using (var cap = Registry.CurrentUser.CreateSubKey(@"Software\Tokdesk\Capabilities"))
                {
                    cap.SetValue("ApplicationName", "Tokdesk");
                    cap.SetValue("ApplicationDescription", "Abre los enlaces de TikTok en Tokdesk y el resto en tu navegador");
                    using var url = cap.CreateSubKey("URLAssociations");
                    url.SetValue("http", ProgId);
                    url.SetValue("https", ProgId);
                }
                using (var reg = Registry.CurrentUser.CreateSubKey(@"Software\RegisteredApplications")) reg.SetValue("Tokdesk", @"Software\Tokdesk\Capabilities");
                // Página de valores predeterminados de Tokdesk (la que Windows muestra para una app concreta);
                // si no se puede, la lista general de apps predeterminadas
                // (En Windows 10 la API de la página por app solo muestra un cartel: se va directo a la lista)
                Process.Start(new ProcessStartInfo("ms-settings:defaultapps") { UseShellExecute = true });
            }
            else
            {
                // Deja de ofrecerse, pero el ProgId queda: si Tokdesk sigue siendo el predeterminado, el lanzador
                // sigue reenviando los enlaces al navegador hasta que el usuario elija otro en Configuración
                using (var reg = Registry.CurrentUser.OpenSubKey(@"Software\RegisteredApplications", true)) reg?.DeleteValue("Tokdesk", false);
                Registry.CurrentUser.DeleteSubKeyTree(@"Software\Tokdesk\Capabilities", false);
            }
        }
        catch (Exception ex) { Log.Write("Gestor de enlaces: " + ex.Message); }
    }
}
