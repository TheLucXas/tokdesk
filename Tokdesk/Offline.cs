using System.IO;
using System.Net.Http;
using System.Text.Json;

namespace Tokdesk;

/// <summary>
/// Videos guardados en disco: "buffer" (los próximos del feed, para que arranquen al instante)
/// y "saved" (la biblioteca sin conexión, hasta el tamaño que elija el usuario).
/// La interfaz los reproduce desde https://offline.tokdesk/&lt;tipo&gt;/&lt;id&gt;.mp4.
/// </summary>
sealed class Offline
{
    public const string Host = "offline.tokdesk";
    public static readonly string Dir = Path.Combine(AppInfo.DataDir, "offline");
    const int BufferKeep = 15;

    readonly HttpClient _http;
    readonly Func<Task<string>> _cookies;
    readonly Func<string> _ua;

    public Offline(HttpClient http, Func<Task<string>> cookies, Func<string> ua)
    {
        _http = http; _cookies = cookies; _ua = ua;
        Directory.CreateDirectory(Path.Combine(Dir, "buffer"));
        Directory.CreateDirectory(Path.Combine(Dir, "saved"));
    }

    static string Folder(string kind) => Path.Combine(Dir, kind == "saved" ? "saved" : "buffer");
    static string Safe(string id) => string.Concat((id ?? "").Where(char.IsLetterOrDigit));
    public static string UrlOf(string kind, string file) => $"https://{Host}/{(kind == "saved" ? "saved" : "buffer")}/{file}";

    /// <summary>Descarga el video (y su portada) y guarda los datos del item. Devuelve la dirección local o null.</summary>
    public async Task<string> Save(string kind, string id, string url, string cover, string meta)
    {
        id = Safe(id);
        if (id.Length == 0 || string.IsNullOrEmpty(url)) return null;
        var dir = Folder(kind);
        var mp4 = Path.Combine(dir, id + ".mp4");
        if (File.Exists(mp4)) { File.SetLastWriteTimeUtc(mp4, DateTime.UtcNow); return UrlOf(kind, id + ".mp4"); }
        var tmp = mp4 + ".part";
        try
        {
            await Fetch(url, tmp);
            File.Move(tmp, mp4, true);
            if (!string.IsNullOrEmpty(cover))
                try { await Fetch(cover, Path.Combine(dir, id + ".jpg")); } catch { }
            if (!string.IsNullOrEmpty(meta)) await File.WriteAllTextAsync(Path.Combine(dir, id + ".json"), meta);
            if (kind != "saved") Trim(dir, BufferKeep);
            return UrlOf(kind, id + ".mp4");
        }
        catch (Exception ex)
        {
            Log.Write("Sin conexión: no se pudo guardar " + id + ": " + ex.Message);
            try { File.Delete(tmp); } catch { }
            return null;
        }
    }

    async Task Fetch(string url, string file)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Referrer = new Uri("https://www.tiktok.com/");
        req.Headers.TryAddWithoutValidation("User-Agent", _ua());
        req.Headers.TryAddWithoutValidation("Cookie", await _cookies());
        using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
        resp.EnsureSuccessStatusCode();
        await using var src = await resp.Content.ReadAsStreamAsync();
        await using var fs = File.Create(file);
        await src.CopyToAsync(fs);
    }

    // Deja solo los N videos más recientes del búfer
    static void Trim(string dir, int keep)
    {
        foreach (var f in new DirectoryInfo(dir).GetFiles("*.mp4").OrderByDescending(f => f.LastWriteTimeUtc).Skip(keep))
            Delete(dir, Path.GetFileNameWithoutExtension(f.Name));
    }

    static void Delete(string dir, string id)
    {
        foreach (var ext in new[] { ".mp4", ".jpg", ".json" })
            try { File.Delete(Path.Combine(dir, id + ext)); } catch { }
    }

    public long Size(string kind) =>
        new DirectoryInfo(Folder(kind)).GetFiles().Sum(f => f.Length);

    public void Clear(string kind)
    {
        foreach (var f in new DirectoryInfo(Folder(kind)).GetFiles())
            try { f.Delete(); } catch { }
    }

    /// <summary>Lista de items guardados (los datos que mandó la interfaz) con sus direcciones locales.</summary>
    public object List(string kind)
    {
        var dir = Folder(kind);
        var items = new List<JsonElement>();
        foreach (var f in new DirectoryInfo(dir).GetFiles("*.json").OrderByDescending(f => f.LastWriteTimeUtc))
        {
            var id = Path.GetFileNameWithoutExtension(f.Name);
            if (!File.Exists(Path.Combine(dir, id + ".mp4"))) continue;
            try { items.Add(JsonDocument.Parse(File.ReadAllText(f.FullName)).RootElement.Clone()); } catch { }
        }
        return new
        {
            t = "offlist", kind, items, size = Size(kind),
            ids = new DirectoryInfo(dir).GetFiles("*.mp4").Select(f => Path.GetFileNameWithoutExtension(f.Name)).ToArray(),
        };
    }
}
