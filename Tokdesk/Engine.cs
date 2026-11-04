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
        _wv.ProcessFailed += (_, e) => { Log.Write($"ERROR motor: {e.ProcessFailedKind} motivo={e.Reason} código={e.ExitCode}"); if (e.ProcessFailedKind != CoreWebView2ProcessFailedKind.BrowserProcessExited) try { _wv.Reload(); } catch { } };
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
        LoginTrace.Attach(_wv, "visible", () => _visible);
        _wv.WebMessageReceived += OnPageMessage;
        _wv.NewWindowRequested += (_, e) =>
        {
            Log.Write("Ventana aparte: " + (Uri.TryCreate(e.Uri, UriKind.Absolute, out var u) ? u.Host : "?"));
            _win.PostToUi(new { t = "loginpopup" });
        };
        _wv.NavigationCompleted += async (_, e) =>
        {
            Log.Write($"Motor cargó {Short(_wv.Source)} ok={e.IsSuccess} {e.WebErrorStatus}");
            if (_wv.Source.Contains("/login")) await _wv.ExecuteScriptAsync(LoginStyleJs);
            _loginLoaded?.TrySetResult();
            await SendMe();
        };
        await _wv.AddScriptToExecuteOnDocumentCreatedAsync(PageScript);
        _wv.Navigate(Home);
    }

    // Formulario oficial de inicio de sesión dentro de la app: oscuro y sin lo que es propio del sitio web
    public const string LoginStyleJs = """
        (()=>{const op=window.open;window.open=function(...a){return window.__pop=op.apply(this,a)};
        document.documentElement.setAttribute('data-theme','dark');
        const s=document.createElement('style');
        s.textContent='[data-e2e="tiktok-logo"],[data-e2e="feedback-entrance"],[data-e2e="back-btn"],[class*="DivFooterContainer"],[class*="DivHeaderContainer"],div:has(> select){display:none!important}html,body{background:#121212!important}[class*="DivBodyContainer"]{margin-top:-50px!important}*{font-family:"Segoe UI",system-ui,sans-serif!important}';
        document.head.append(s)})()
        """;

    TaskCompletionSource _loginLoaded;

    // El formulario se carga y se arregla con la página oculta, para no mostrar la web mientras tanto
    public async Task LoadLoginHidden(string url)
    {
        Unpark();
        _loginLoaded = new();
        _wv.Navigate(url);
        await Task.WhenAny(_loginLoaded.Task, Task.Delay(12000));
        _loginLoaded = null;
        await Task.Delay(300);
    }

    // Facebook, Google o Apple: toca el botón oficial en la página oculta y queda solo la ventana del servicio.
    // Sin marcarlo como gesto del usuario, el navegador bloquearía esa ventana.
    public async Task<bool> ClickLoginChannel(string brand)
    {
        await LoadLoginHidden("https://www.tiktok.com/login");
        var js = $$"""(()=>{const e=[...document.querySelectorAll('[data-e2e="channel-item"]')].find(x=>x.textContent.includes({{JsonSerializer.Serialize(brand)}}));if(!e)return false;e.click();return true})()""";
        var args = JsonSerializer.Serialize(new { expression = js, userGesture = true, returnByValue = true });
        for (var i = 0; i < 16; i++)
        {
            var r = await _wv.CallDevToolsProtocolMethodAsync("Runtime.evaluate", args);
            using var doc = JsonDocument.Parse(r);
            if (doc.RootElement.GetProperty("result").TryGetProperty("value", out var v) && v.ValueKind == JsonValueKind.True) return true;
            await Task.Delay(500);
        }
        return false;
    }

    public Task<string> RunForTest(string js) => _wv.ExecuteScriptAsync(js);
    public string BoundsForTest() => _ctl.Bounds.ToString();

    // Con la pantalla del QR abierta, esta página no debe tocar las cookies que comparte con la del código:
    // TikTok lo invalida (error 2135) si cambian entre el escaneo y la confirmación
    bool _parked;
    TaskCompletionSource _unpark;
    public bool Parked => _parked;
    public void Park()
    {
        _parked = true;
        _unpark = new();
        _wv.Navigate("about:blank");
    }
    void Unpark()
    {
        _parked = false;
        _unpark?.TrySetResult();
    }

    // -1 sin ventana, 0 abierta, 1 ya se cerró
    public async Task<int> LoginPopupState()
    {
        var r = await _wv.ExecuteScriptAsync("window.__pop ? (window.__pop.closed ? 1 : 0) : -1");
        return int.TryParse(r, out var v) ? v : -1;
    }

    public void Restart()
    {
        Unpark();
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
                else
                {
                    Log.Write($"Feed sin videos ({body?.Length ?? 0} bytes)");
                    // Pasa al abrir la web sin datos (tras cerrar sesión): sin esto el feed quedaba esperando
                    if (_feedBodies.Count == 0) _ = RefreshSession();
                }
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
        if (_loadingMore || _parked) return;
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
    public async Task<(int status, string body)> Api(string method, string path, IEnumerable<(string k, string v)> query, string form = null)
    {
        if (_parked) await _unpark.Task;
        await Task.WhenAny(_feedReady.Task, Task.Delay(10000));
        var q = query.ToArray();
        // Los directos usan webcast.tiktok.com (la web los pide igual, desde la misma página)
        var full = path.StartsWith("https://webcast.tiktok.com/") ? path : "https://www.tiktok.com" + path;
        var result = await PageFetch(Rebuild(_feedUrl, full, false, q), method, form);
        // El detalle de un video responde vacío aunque la sesión esté bien (bloqueo de TikTok): la interfaz
        // lo lee de la página del video, así que no se pierde tiempo recargando
        if (result.status == 200 && string.IsNullOrEmpty(result.body) && path != "/api/item/detail/")
        {
            // TikTok devuelve 200 vacío cuando la sesión de la página quedó vieja (msToken vencido):
            // se recarga la página oficial y se reintenta una vez
            Log.Write($"API {method} {path}: respuesta vacía; se refresca la sesión y se reintenta");
            await RefreshSession();
            result = await PageFetch(Rebuild(_feedUrl, full, false, q), method, form);
        }
        // «invalid csrf token»: el token de la página quedó viejo; se recarga la página oficial y se reintenta una vez
        if (result.body != null && result.body.Contains("\"status_code\":10402"))
        {
            Log.Write($"API {method} {path}: token csrf vencido; se refresca la sesión y se reintenta");
            await RefreshSession();
            result = await PageFetch(Rebuild(_feedUrl, full, false, q), method, form);
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
        // Durante el inicio de sesión no se recarga: se perdería lo que la persona está escribiendo o el código
        if (_parked || _visible || _wv.Source.Contains("/login")) return Task.CompletedTask;
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

    async Task<(int status, string body)> PageFetch(string url, string method, string form = null)
    {
        var id = ++_nextId;
        var tcs = new TaskCompletionSource<(int status, string body)>();
        _pending[id] = tcs;
        await _wv.ExecuteScriptAsync($"window.__tp && __tp.req({id}, {JsonSerializer.Serialize(method)}, {JsonSerializer.Serialize(url)}, {JsonSerializer.Serialize(form)})");
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

    /// <summary>Token de seguridad más reciente (lo trae cada página de TikTok que carga la página oculta).</summary>
    public async Task SetCsrf(string token)
    {
        if (_wv == null || string.IsNullOrEmpty(token)) return;
        try { await _wv.ExecuteScriptAsync("window.__tpCsrf = " + JsonSerializer.Serialize(token)); } catch { }
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
          // Cada página de TikTok que se carga renueva el token: si la oculta de mensajes cargó después que esta,
          // el de esta queda viejo y TikTok rechaza las acciones («invalid csrf token»). La app le pasa el último
          const csrfNow = () => window.__tpCsrf || appContext().csrfToken;
          const appContext = () => {
            try {
              const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
              return JSON.parse(el.textContent).__DEFAULT_SCOPE__['webapp.app-context'] || {};
            } catch { return {}; }
          };
          window.__tp = {
            // XHR igual que la propia web, para que sus pedidos salgan tal cual los haría ella
            // Primero con fetch; si vuelve vacío, con XHR (la web firma una u otra vía según su versión)
            req(id, method, url, body) {
              const headers = {};
              if (method === 'POST') {
                headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
                const csrf = csrfNow();
                if (csrf) headers['tt-csrf-token'] = csrf;
              }
              // Respuestas binarias (protobuf del chat de los directos): se piden con __b64=1 y vuelven en base64
              const bin = /[?&]__b64=1/.test(url);
              if (bin) url = url.replace(/([?&])__b64=1&?/, '$1');
              fetch(url, { method, credentials: 'include', headers, body: method === 'POST' ? (body || '') : undefined })
                .then(r => bin ? r.arrayBuffer().then(a => {
                    const u8 = new Uint8Array(a); let s = '';
                    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
                    return { s: r.status, t: 'b64:' + btoa(s) };
                  }) : r.text().then(t => ({ s: r.status, t })))
                .then(({ s, t }) => t ? post({ id, status: s, body: t }) : this.xhr(id, method, url, body))
                .catch(() => this.xhr(id, method, url, body));
            },
            xhr(id, method, url, body) {
              const x = new XMLHttpRequest();
              x.open(method, url, true);
              x.withCredentials = true;
              if (method === 'POST') {
                x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
                const csrf = csrfNow();
                if (csrf) x.setRequestHeader('tt-csrf-token', csrf);
              }
              x.onload = () => post({ id, status: x.status, body: x.responseText || '' });
              x.onerror = () => post({ id, status: 0, body: '' });
              x.send(method === 'POST' ? (body || '') : null);
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
