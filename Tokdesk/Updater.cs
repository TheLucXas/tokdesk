using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;

namespace Tokdesk;

/// <summary>
/// Busca versiones nuevas en las Releases de GitHub y reemplaza el .exe en uso.
/// El repositorio y el token de solo lectura vienen incrustados en update.json (fuera de git).
/// </summary>
static class Updater
{
    public sealed record Info(Version Version, string Tag, string Notes, string AssetUrl, long Size);

    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(10) };
    static readonly (string repo, string token) Config = LoadConfig();

    public static bool Configured => !string.IsNullOrEmpty(Config.repo);

    static (string, string) LoadConfig()
    {
        try
        {
            var json = AppInfo.Resource("update.json");
            if (json == null) return (null, null);
            using var doc = JsonDocument.Parse(json);
            var r = doc.RootElement;
            return (r.GetProperty("repo").GetString(), r.TryGetProperty("token", out var t) ? t.GetString() : null);
        }
        catch (Exception ex) { Log.Write("update.json inválido: " + ex.Message); return (null, null); }
    }

    static HttpRequestMessage Request(string url, string accept)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.UserAgent.ParseAdd("Tokdesk/" + AppInfo.VersionText);
        req.Headers.Accept.ParseAdd(accept);
        if (!string.IsNullOrEmpty(Config.token))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Config.token);
        return req;
    }

    /// <summary>Devuelve la última versión publicada si es más nueva que la actual; null si no hay.</summary>
    public static async Task<Info> Check()
    {
        if (!Configured) throw new InvalidOperationException("Actualizaciones sin configurar");
        using var resp = await Http.SendAsync(Request($"https://api.github.com/repos/{Config.repo}/releases/latest", "application/vnd.github+json"));
        if ((int)resp.StatusCode == 404) return null; // todavía no hay releases
        resp.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
        var r = doc.RootElement;
        var tag = r.GetProperty("tag_name").GetString() ?? "";
        if (!Version.TryParse(tag.TrimStart('v', 'V'), out var v)) return null;
        var asset = r.GetProperty("assets").EnumerateArray()
            .FirstOrDefault(a => a.GetProperty("name").GetString()!.EndsWith(".exe", StringComparison.OrdinalIgnoreCase));
        if (asset.ValueKind != JsonValueKind.Object) return null;
        var current = AppInfo.Version;
        if (new Version(v.Major, v.Minor, Math.Max(0, v.Build)) <= new Version(current.Major, current.Minor, Math.Max(0, current.Build))) return null;
        return new Info(v, tag, r.TryGetProperty("body", out var b) ? b.GetString() : "",
            asset.GetProperty("url").GetString(), asset.GetProperty("size").GetInt64());
    }

    /// <summary>Descarga la versión nueva, reemplaza el .exe y reinicia la app.</summary>
    public static async Task Install(Info info, Action<int> progress)
    {
        // Se reemplaza el lanzador (o la app si se abrió sin él); al reiniciar extrae la versión nueva
        var exe = AppInfo.StartPath;
        var tmp = exe + ".new";
        using (var resp = await Http.SendAsync(Request(info.AssetUrl, "application/octet-stream"), HttpCompletionOption.ResponseHeadersRead))
        {
            resp.EnsureSuccessStatusCode();
            var total = resp.Content.Headers.ContentLength ?? info.Size;
            await using var src = await resp.Content.ReadAsStreamAsync();
            await using var dst = File.Create(tmp);
            var buf = new byte[81920];
            long done = 0; int read, last = -1;
            while ((read = await src.ReadAsync(buf)) > 0)
            {
                await dst.WriteAsync(buf.AsMemory(0, read));
                done += read;
                var p = total > 0 ? (int)(done * 100 / total) : 0;
                if (p != last) { last = p; progress(p); }
            }
        }
        // Windows permite renombrar un .exe en uso: se aparta el viejo y se pone el nuevo en su lugar
        var old = exe + ".old";
        if (File.Exists(old)) File.Delete(old);
        File.Move(exe, old);
        File.Move(tmp, exe);
        // El lanzador nuevo espera a que este proceso termine antes de extraer y abrir la versión nueva
        Process.Start(new ProcessStartInfo(exe, $"--updated --wait {Environment.ProcessId}") { UseShellExecute = false });
        (System.Windows.Application.Current.MainWindow as MainWindow)?.ExitNow();
        System.Windows.Application.Current.Shutdown();
    }

    /// <summary>Borra el .exe anterior que quedó de una actualización.</summary>
    public static void CleanupOld()
    {
        var old = AppInfo.StartPath + ".old";
        for (var i = 0; i < 10 && File.Exists(old); i++)
        {
            try { File.Delete(old); } catch { Thread.Sleep(300); }
        }
    }
}
