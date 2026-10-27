using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Tokdesk;

/// <summary>
/// Motor oculto: carga la web oficial con la sesión del usuario y le pasa a la UI
/// las respuestas de la API que esa misma página recibe. No genera firmas propias:
/// los pedidos extra los hace el código de la propia página (que los firma solo).
/// </summary>
sealed class Engine
{
    public const string Home = "https://www.tiktok.com/foryou";
    // La página vuelve a agregar estos parámetros al enviar, así que no se copian
    static readonly string[] SignParams = { "X-Bogus", "X-Gnarly", "X-Dynosaur", "_signature", "msToken" };
    static readonly string[] FeedOnlyParams = { "count", "cursor", "pullType", "itemID", "insertedItemID", "coverFormat", "aweme_id", "item_id", "comment_id" };
    static readonly bool Dump = Environment.GetEnvironmentVariable("TOKDESK_DUMP") == "1";

    readonly CoreWebView2Environment _env;
    readonly IntPtr _parent;
    readonly MainWindow _win;
    CoreWebView2Controller _ctl;
    CoreWebView2 _wv;

    string _feedUrl;
    TaskCompletionSource _feedReady = new();
    bool _visible;
    bool _loadingMore;
    int _nextId;
    readonly Dictionary<int, TaskCompletionSource<(int status, string body)>> _pending = new();
    readonly List<string> _feedBodies = new();
    readonly HashSet<string> _seenFeedUrls = new();

    public CoreWebView2 View => _wv;

    public Engine(CoreWebView2Environment env, IntPtr parent, MainWindow win)
    {
        _env = env;
        _parent = parent;
        _win = win;
    }

    public async Task Start()
    {
        _ctl = await _env.CreateCoreWebView2ControllerAsync(_parent);
        _ctl.IsVisible = false;
        _wv = _ctl.CoreWebView2;
        _wv.IsMuted = true;
        _wv.Settings.IsStatusBarEnabled = false;

        // Mientras está oculto no hace falta bajar videos, imágenes ni fuentes
        foreach (var ctx in new[] { CoreWebView2WebResourceContext.Media, CoreWebView2WebResourceContext.Image, CoreWebView2WebResourceContext.Font })
            _wv.AddWebResourceRequestedFilter("*", ctx);
        _wv.WebResourceRequested += (_, e) =>
        {
            if (!_visible)
                e.Response = _env.CreateWebResourceResponse(null, 204, "No Content", "Cache-Control: no-store");
        };

        _wv.WebResourceResponseReceived += OnResponse;
        _wv.WebMessageReceived += OnPageMessage;
        _wv.NavigationCompleted += async (_, e) =>
        {
            Log.Write($"Motor cargó {Short(_wv.Source)} ok={e.IsSuccess} {e.WebErrorStatus}");
            await SendMe();
        };
        await _wv.AddScriptToExecuteOnDocumentCreatedAsync(PageScript);
        _wv.Navigate(Home);
    }

    public void Restart()
    {
        _feedUrl = null;
        _feedReady = new();
        _feedBodies.Clear();
        _seenFeedUrls.Clear();
        _wv.Navigate(Home);
    }

    // Con url navega ahí (p. ej. la pantalla de inicio de sesión); sin url recarga la página actual
    public void SetVisible(bool visible, string url = null)
    {
        _visible = visible;
        _wv.IsMuted = !visible;
        UpdateBounds();
        _ctl.IsVisible = visible;
        if (!visible) return;
        if (url != null) _wv.Navigate(url); else _wv.Reload();
        _ctl.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
    }

    public void UpdateBounds()
    {
        if (_ctl == null) return;
        _ctl.Bounds = _win.EngineBounds();
    }

    public void ReplayFeed()
    {
        foreach (var body in _feedBodies)
            _win.PostToUi(new { t = "feed", kind = "foryou", body });
        _ = SendMe();
    }

    // Usuario con sesión iniciada (o null), según el contexto que la propia web incrusta
    async Task SendMe()
    {
        try
        {
            var json = await _wv.ExecuteScriptAsync("window.__tp ? __tp.me() : null");
            // Idioma de la cuenta en la web de TikTok: lo usa la interfaz en modo automático
            var lang = JsonSerializer.Deserialize<string>(await _wv.ExecuteScriptAsync("window.__tp ? __tp.lang() : null") is var l && l != "null" ? l : "null");
            _win.PostToUi(new { t = "me", user = json == "null" ? null : JsonSerializer.Deserialize<string>(json), lang });
        }
        catch (Exception ex) { Log.Write("me falló: " + ex.Message); }
    }

    async void OnResponse(object sender, CoreWebView2WebResourceResponseReceivedEventArgs e)
    {
        var uri = e.Request.Uri;
        try
        {
            if (uri.Contains("captcha") || uri.Contains("verifycenter") || uri.Contains("/verify/"))
            {
                Log.Write("Verificación detectada: " + Short(uri));
                _win.PostToUi(new { t = "captcha" });
                return;
            }
            if (!uri.Contains("/api/")) return;
            if (Dump) Log.Write($"API {e.Response.StatusCode} {e.Request.Method} {uri}");

            if (uri.Contains("/recommend/item_list") || uri.Contains("/preload/item_list"))
            {
                _feedUrl = uri;
                _feedReady.TrySetResult();
                if (!_seenFeedUrls.Add(uri)) return;
                var body = await ReadBody(e.Response);
                if (HasItems(body)) PushFeed(body);
                else Log.Write($"Feed sin videos ({body?.Length ?? 0} bytes)");
            }
        }
        catch (Exception ex) { Log.Write("Respuesta falló: " + ex.Message); }
    }

    static async Task<string> ReadBody(CoreWebView2WebResourceResponseView resp)
    {
        using var stream = await resp.GetContentAsync();
        if (stream == null) return null;
        using var reader = new StreamReader(stream);
        return await reader.ReadToEndAsync();
    }

    static bool HasItems(string body) => !string.IsNullOrEmpty(body) && body.Contains("\"itemList\"");

    void PushFeed(string body)
    {
        _feedBodies.Add(body);
        if (_feedBodies.Count > 20) _feedBodies.RemoveAt(0);
        _win.PostToUi(new { t = "feed", kind = "foryou", body });
    }

    public async Task LoadMore()
    {
        if (_loadingMore) return;
        _loadingMore = true;
        try
        {
            if (_feedUrl != null)
            {
                var (status, body) = await PageFetch(Rebuild(_feedUrl, null, true), "GET");
                if (HasItems(body)) { PushFeed(body); return; }
                Log.Write($"Pedido directo sin videos (status {status}, {body?.Length ?? 0} bytes); avanzo el feed oculto");
            }
            await AdvanceHiddenFeed();
        }
        finally { _loadingMore = false; }
    }

    // Plan B: avanzar el feed de la página oculta para que ella misma pida más videos
    async Task AdvanceHiddenFeed()
    {
        for (int i = 0; i < 6; i++)
        {
            await _wv.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent",
                "{\"type\":\"rawKeyDown\",\"key\":\"ArrowDown\",\"code\":\"ArrowDown\",\"windowsVirtualKeyCode\":40}");
            await _wv.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent",
                "{\"type\":\"keyUp\",\"key\":\"ArrowDown\",\"code\":\"ArrowDown\",\"windowsVirtualKeyCode\":40}");
            await Task.Delay(250);
        }
        await _wv.ExecuteScriptAsync("window.__tp && __tp.scrollAll()");
    }

    /// <summary>Pedido genérico a la API de la web, hecho desde la propia página.</summary>
    public async Task<(int status, string body)> Api(string method, string path, IEnumerable<(string k, string v)> query)
    {
        await Task.WhenAny(_feedReady.Task, Task.Delay(10000));
        var q = query.ToArray();
        var result = await PageFetch(Rebuild(_feedUrl, "https://www.tiktok.com" + path, false, q), method);
        if (result.status == 200 && string.IsNullOrEmpty(result.body))
        {
            // TikTok devuelve 200 vacío cuando la sesión de la página quedó vieja (msToken vencido):
            // se recarga la página oficial y se reintenta una vez
            Log.Write($"API {method} {path}: respuesta vacía; se refresca la sesión y se reintenta");
            await RefreshSession();
            result = await PageFetch(Rebuild(_feedUrl, "https://www.tiktok.com" + path, false, q), method);
        }
        if (result.status != 200 || string.IsNullOrEmpty(result.body))
            Log.Write($"API {method} {path}: status {result.status}, {result.body?.Length ?? 0} bytes");
        else if (Dump)
            Log.Write($"API {method} {path} -> {result.body[..Math.Min(300, result.body.Length)]}");
        return result;
    }

    Task _refreshing;
    DateTime _lastRefresh;

    // Una sola recarga a la vez, y no más de una cada 20 s aunque fallen varios pedidos juntos
    Task RefreshSession()
    {
        if (_refreshing != null && !_refreshing.IsCompleted) return _refreshing;
        if (DateTime.Now - _lastRefresh < TimeSpan.FromSeconds(20)) return Task.CompletedTask;
        _lastRefresh = DateTime.Now;
        return _refreshing = Reload();

        async Task Reload()
        {
            _feedReady = new();
            _wv.Reload();
            await Task.WhenAny(_feedReady.Task, Task.Delay(15000));
            await Task.Delay(500);
        }
    }

    // Arma la URL con los mismos parámetros de sesión que usa la página, sin sus firmas
    static string Rebuild(string baseUrl, string path, bool keepFeedParams, params (string k, string v)[] extra)
    {
        baseUrl ??= "https://www.tiktok.com/api/recommend/item_list/?aid=1988&app_name=tiktok_web&device_platform=web_pc";
        var qi = baseUrl.IndexOf('?');
        // Se trabaja sobre el texto crudo para conservar exactamente la codificación de la web
        var parts = baseUrl[(qi + 1)..].Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Where(p =>
            {
                var k = p.Split('=')[0];
                return !SignParams.Contains(k) && (keepFeedParams || !FeedOnlyParams.Contains(k))
                    && !extra.Any(x => x.k == k);
            })
            .Concat(extra.Select(x => x.k + "=" + Uri.EscapeDataString(x.v)));
        return (path ?? baseUrl[..qi]) + "?" + string.Join("&", parts);
    }

    async Task<(int status, string body)> PageFetch(string url, string method)
    {
        var id = ++_nextId;
        var tcs = new TaskCompletionSource<(int status, string body)>();
        _pending[id] = tcs;
        await _wv.ExecuteScriptAsync($"window.__tp && __tp.req({id}, {JsonSerializer.Serialize(method)}, {JsonSerializer.Serialize(url)})");
        var done = await Task.WhenAny(tcs.Task, Task.Delay(15000));
        _pending.Remove(id);
        return done == tcs.Task ? tcs.Task.Result : (0, null);
    }

    void OnPageMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var m = doc.RootElement;
            if (!m.TryGetProperty("id", out var idEl)) return;
            if (_pending.TryGetValue(idEl.GetInt32(), out var tcs))
                tcs.TrySetResult((m.GetProperty("status").GetInt32(), m.GetProperty("body").GetString()));
        }
        catch (Exception ex) { Log.Write("Mensaje del motor falló: " + ex.Message); }
    }

    public async Task<string> CookieHeader()
    {
        var cookies = await _wv.CookieManager.GetCookiesAsync("https://www.tiktok.com");
        return string.Join("; ", cookies.Select(c => c.Name + "=" + c.Value));
    }

    /// <summary>Cambia el idioma de la web de TikTok (las mismas cookies que usa su selector de idioma) y recarga.</summary>
    public async Task SetLanguage(string code)
    {
        if (string.IsNullOrWhiteSpace(code)) return;
        foreach (var name in new[] { "tiktok_webapp_lang", "tiktok_pc_web_lang" })
        {
            var c = _wv.CookieManager.CreateCookie(name, code, ".tiktok.com", "/");
            c.Expires = DateTime.Now.AddDays(300);
            c.IsSecure = true;
            _wv.CookieManager.AddOrUpdateCookie(c);
        }
        await Task.Yield();
        Restart();
    }
    public string UserAgent => _wv.Settings.UserAgent;

    public static string Short(string uri)
    {
        var i = uri.IndexOf('?');
        return i < 0 ? uri : uri[..i];
    }

    const string PageScript = """
        (() => {
          if (window.__tp) return;
          const post = (m) => window.chrome && chrome.webview && chrome.webview.postMessage(m);
          const appContext = () => {
            try {
              const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
              return JSON.parse(el.textContent).__DEFAULT_SCOPE__['webapp.app-context'] || {};
            } catch { return {}; }
          };
          window.__tp = {
            // XHR igual que la propia web, para que sus pedidos salgan tal cual los haría ella
            // Primero con fetch; si vuelve vacío, con XHR (la web firma una u otra vía según su versión)
            req(id, method, url) {
              const headers = {};
              if (method === 'POST') {
                headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
                const csrf = appContext().csrfToken;
                if (csrf) headers['tt-csrf-token'] = csrf;
              }
              fetch(url, { method, credentials: 'include', headers, body: method === 'POST' ? '' : undefined })
                .then(r => r.text().then(t => ({ s: r.status, t })))
                .then(({ s, t }) => t ? post({ id, status: s, body: t }) : this.xhr(id, method, url))
                .catch(() => this.xhr(id, method, url));
            },
            xhr(id, method, url) {
              const x = new XMLHttpRequest();
              x.open(method, url, true);
              x.withCredentials = true;
              if (method === 'POST') {
                x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
                const csrf = appContext().csrfToken;
                if (csrf) x.setRequestHeader('tt-csrf-token', csrf);
              }
              x.onload = () => post({ id, status: x.status, body: x.responseText || '' });
              x.onerror = () => post({ id, status: 0, body: '' });
              x.send(method === 'POST' ? '' : null);
            },
            lang() {
              const c = appContext();
              return c.language || (c.user && c.user.language) || null;
            },
            me() {
              const u = appContext().user;
              return u && u.uid ? JSON.stringify(u) : null;
            },
            scrollAll() {
              document.querySelectorAll('*').forEach(el => {
                if (el.scrollHeight > el.clientHeight + 50) el.scrollTop = el.scrollHeight;
              });
              window.scrollTo(0, document.body.scrollHeight);
            }
          };
        })();
        """;
}
