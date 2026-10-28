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
            var s = a.Trim('"');
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
                Process.Start(new ProcessStartInfo("ms-settings:defaultapps") { UseShellExecute = true });
            }
            else
            {
                // Deja de ofrecerse, pero el ProgId queda: si Tokdesk sigue siendo el predeterminado, el lanzador
                // sigue reenviando los enlaces al navegador hasta que el usuario elija otro en Configuración
                using (var reg = Registry.CurrentUser.OpenSubKey(@"Software\RegisteredApplications", true)) reg?.DeleteValue("Tokdesk", false);
                Registry.CurrentUser.DeleteSubKeyTree(@"Software\Tokdesk\Capabilities", false);
                Process.Start(new ProcessStartInfo("ms-settings:defaultapps") { UseShellExecute = true });
            }
        }
        catch (Exception ex) { Log.Write("Gestor de enlaces: " + ex.Message); }
    }
}
