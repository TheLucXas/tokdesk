using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;

namespace Tokdesk;

/// <summary>
/// Anota los pasos del inicio de sesión de una página de TikTok: solo la ruta, el estado que responde
/// y una huella corta del código del QR para distinguirlo, nunca tokens ni direcciones con datos.
/// </summary>
static class LoginTrace
{
    public static void Attach(CoreWebView2 wv, string name, Func<bool> active, Action<string> qrError = null)
    {
        string last = null;
        wv.WebResourceResponseReceived += async (_, e) =>
        {
            if (!active()) return;
            try
            {
                var uri = e.Request.Uri;
                if (e.Request.Method == "OPTIONS" || (!uri.Contains("passport") && !uri.Contains("qrconnect") && !uri.Contains("/sso/"))) return;
                var path = new Uri(uri).AbsolutePath;
                var status = "";
                if (e.Response.StatusCode == 200 && (e.Response.Headers.GetHeader("content-type") ?? "").Contains("json"))
                {
                    using var s = await e.Response.GetContentAsync();
                    if (s != null)
                    {
                        using var r = new StreamReader(s);
                        var b = await r.ReadToEndAsync();
                        status = string.Join(" ", Regex.Matches(b, "\"(status|error_code|message|description)\":\\s*(\"[^\"]{0,60}\"|\\d{1,8})").Select(m => m.Value));
                        var code = Regex.Match(status, @"""error_code"":\s*(\d+)").Groups[1].Value;
                        if (path.Contains("check_qrconnect") && code.Length > 0) qrError?.Invoke(code);
                    }
                }
                var token = Regex.Match(uri, @"[?&]token=([^&]+)").Groups[1].Value;
                var mark = token.Length > 0 ? " código " + Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(token)))[..4] : "";
                var line = $"{path} {e.Response.StatusCode} {status}{mark}";
                if (line != last) { last = line; Log.Write($"Inicio de sesión ({name}): {line}"); }
            }
            catch { }
        };
        wv.NavigationStarting += (_, e) =>
        {
            if (active() && Uri.TryCreate(e.Uri, UriKind.Absolute, out var u)) Log.Write($"Inicio de sesión ({name}): va a {u.Host}{u.AbsolutePath}");
        };
    }
}
