using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Tokdesk;

/// <summary>
/// Segundo motor para lo que la web solo permite desde su propia interfaz:
/// chats (enviar un video a un amigo) y el formulario de reporte.
/// Se mantiene oculto salvo cuando hay que mostrar una pantalla oficial.
/// </summary>
sealed class SidePage
{
    const string Messages = "https://www.tiktok.com/messages";

    readonly CoreWebView2Environment _env;
    readonly IntPtr _parent;
    readonly MainWindow _win;
    CoreWebView2Controller _ctl;
    CoreWebView2 _wv;
    bool _visible;
    TaskCompletionSource<bool> _nav;

    public SidePage(CoreWebView2Environment env, IntPtr parent, MainWindow win)
    {
        _env = env;
        _parent = parent;
        _win = win;
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern IntPtr GetParent(IntPtr h);

    readonly List<IntPtr> _hwnds = new();
    bool _background;

    List<IntPtr> DirectChildren()
    {
        var list = new List<IntPtr>();
        EnumChildWindows(_parent, (h, _) => { if (GetParent(h) == _parent) list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }

    // Ventanas propias del controlador, detectadas comparando los hijos antes y después de crearlo
    void ZOrder(bool top)
    {
        const uint noSizeMoveActivate = 0x0001 | 0x0002 | 0x0010;
        foreach (var h in _hwnds) SetWindowPos(h, top ? IntPtr.Zero : new IntPtr(1), 0, 0, 0, 0, noSizeMoveActivate);
    }

    /// <summary>
    /// Deja la página "visible" pero detrás de la interfaz, para que funcione su carga diferida
    /// (mensajes anteriores) sin mostrarse.
    /// </summary>
    public async Task SetBackground(bool on)
    {
        await Ensure();
        if (_visible) return;
        _background = on;
        UpdateBounds();
        _ctl.IsVisible = on;
        if (on) ZOrder(false);
    }

    async Task Ensure()
    {
        if (_wv != null) return;
        var before = DirectChildren();
        _ctl = await _env.CreateCoreWebView2ControllerAsync(_parent);
        _hwnds.AddRange(DirectChildren().Except(before));
        _ctl.IsVisible = false;
        _wv = _ctl.CoreWebView2;
        _wv.IsMuted = true;
        _wv.Settings.IsStatusBarEnabled = false;
        foreach (var ctx in new[] { CoreWebView2WebResourceContext.Media, CoreWebView2WebResourceContext.Image, CoreWebView2WebResourceContext.Font })
            _wv.AddWebResourceRequestedFilter("*", ctx);
        _wv.WebResourceRequested += (_, e) =>
        {
            if (!_visible) e.Response = _env.CreateWebResourceResponse(null, 204, "No Content", "Cache-Control: no-store");
        };
        _wv.NavigationCompleted += (_, e) => _nav?.TrySetResult(e.IsSuccess);
        // No hace falta esperar a que termine de cargar toda la página: los scripts esperan sus elementos
        _wv.DOMContentLoaded += (_, _) => _nav?.TrySetResult(true);
    }

    async Task Go(string url)
    {
        await Ensure();
        // Mientras el usuario ve una página oficial (denunciar, subir, etc.) no se la cambia por detrás
        if (Busy) throw new InvalidOperationException("página oficial en uso");
        if (_wv.Source != null && _wv.Source.StartsWith(url)) return;
        _nav = new TaskCompletionSource<bool>();
        _wv.Navigate(url);
        await Task.WhenAny(_nav.Task, Task.Delay(20000));
    }

    async Task<string> Eval(string js)
    {
        var r = await _wv.ExecuteScriptAsync(js);
        return r == "null" ? null : JsonSerializer.Deserialize<string>(r);
    }

    // Espera hasta que el script devuelva algo distinto de null
    async Task<string> Poll(string js, int ms)
    {
        for (var t = 0; t < ms; t += 400)
        {
            var r = await Eval(js);
            if (r != null) return r;
            await Task.Delay(400);
        }
        return null;
    }

    public bool Visible => _visible;

    // Mientras se ve una página oficial o se usa el formulario de denuncia, nada más la mueve
    // Mientras está bloqueada la página queda "visible" detrás de la ventana: oculta, Chromium frena sus
    // temporizadores y el formulario tardaba ~15 s en aparecer
    bool _lockedValue, _bgWas;
    bool _locked
    {
        get => _lockedValue;
        set
        {
            if (value == _lockedValue) return;
            _lockedValue = value;
            if (value) _bgWas = _background;
            _ = SetBackground(value || _bgWas);
        }
    }
    bool Busy => _visible || _locked;

    // Estado del formulario oficial de denuncia, para mostrarlo en la interfaz propia
    const string ReportStateJs = """
        (() => {
          const f = document.querySelector('[data-e2e="report-form"]');
          if (!f) return JSON.stringify({ closed: true });
          const title = ((f.querySelector('[data-e2e="report-title"]') || {}).textContent || '').trim();
          const reasons = [...f.querySelectorAll('[data-e2e^="report-card-reason"]')].map(e => e.textContent.trim());
          const buttons = [...f.querySelectorAll('button')].map((b, i) => ({ i, e2e: b.dataset.e2e || '', text: b.textContent.trim(), off: !!b.disabled }));
          const skip = new Set([title, ...reasons, ...buttons.map(b => b.text)]);
          const lines = f.innerText.split('\n').map(s => s.trim()).filter(s => s && !skip.has(s));
          return JSON.stringify({ title, reasons, buttons, text: lines.join('\n').slice(0, 1500) });
        })()
        """;

    /// <summary>Abre (oculto) el formulario oficial de denuncia de un video o comentario.</summary>
    public async Task<string> OpenReport(string url, string comment)
    {
        if (await OpenLocked(url, string.IsNullOrEmpty(comment) ? ReportVideoJs : ReportCommentJs(comment), "Denuncia") == null) return null;
        await Task.Delay(300);
        return await Eval(ReportStateJs);
    }

    /// <summary>
    /// Lleva la página a <paramref name="url"/> y la bloquea hasta que <paramref name="js"/> devuelva algo.
    /// Primero prueba la navegación interna de la web (sin recargar, ~1 s); si no sirve, carga la página entera.
    /// </summary>
    async Task<string> OpenLocked(string url, string js, string what)
    {
        _locked = false;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        await Ensure();
        string opened = null;
        if (await GoFast(url)) { _locked = true; opened = await Poll(js, 8000); }
        if (opened == null)
        {
            _locked = false;
            await Reload(url);
            // TikTok a veces responde 403 a la primera carga: se reintenta una vez
            if ((_wv.Source ?? "").StartsWith("chrome-error") || await Eval("location.protocol") == "chrome-error:")
            {
                await Task.Delay(2000);
                await Reload(url);
            }
            _locked = true;
            opened = await Poll(js, 20000);
        }
        Log.Write($"{what}: listo en {sw.ElapsedMilliseconds} ms ({(opened == null ? "falló" : "ok")})");
        if (opened == null) _locked = false;
        return opened;
    }

    public async Task Warm()
    {
        await Ensure();
        if (Busy || (_wv.Source ?? "").StartsWith("https://www.tiktok.com/")) return;
        try { await Go(Messages); } catch { }
    }

    async Task<bool> GoFast(string url)
    {
        var src = _wv.Source ?? "";
        if (!src.StartsWith("https://www.tiktok.com/")) return false;
        if (src.StartsWith(url)) return true;
        var path = new Uri(url).PathAndQuery;
        return await Eval($$"""
            (() => {
              history.pushState({}, '', {{JsonSerializer.Serialize(path)}});
              dispatchEvent(new PopStateEvent('popstate', { state: {} }));
              return 'ok';
            })()
            """) != null;
    }

    async Task Reload(string url)
    {
        _nav = new TaskCompletionSource<bool>();
        _wv.Navigate(url);
        await Task.WhenAny(_nav.Task, Task.Delay(20000));
    }
    /// <summary>Hace clic en un motivo o en un botón del formulario y devuelve el estado nuevo.</summary>
    public async Task<string> ReportAct(string kind, int index)
    {
        if (!_locked) return null;
        var sel = kind == "reason" ? "[data-e2e^=\"report-card-reason\"]" : "button";
        await Eval($$"""
            (() => {
              const f = document.querySelector('[data-e2e="report-form"]');
              const el = f && f.querySelectorAll('{{sel}}')[{{index}}];
              if (el) el.click();
              return null;
            })()
            """);
        await Task.Delay(1200);
        return await Eval(ReportStateJs);
    }

    public async Task ReportClose()
    {
        if (!_locked) return;
        try { await Eval("(() => { const c = document.querySelector('[data-e2e=\"report-card-cancel\"]'); if (c) c.click(); return null; })()"); }
        finally { _locked = false; }
    }

    // ---------- Editar perfil: el formulario oficial corre oculto y se muestra en la interfaz propia ----------

    const string EditStateJs = """
        (() => {
          const q = (s) => document.querySelector(s);
          const save = q('[data-e2e="edit-profile-save"]');
          if (!save) return JSON.stringify({ closed: true });
          const txt = (n) => ((q('[data-e2e="' + n + '"]') || {}).innerText || '').trim();
          const img = q('[data-e2e="edit-profile-avatar"] img');
          // Pasos encima del formulario (recorte de foto, confirmaciones): botones sin data-e2e dentro del mismo modal
          const btns = [...(save.closest('[role="dialog"]') || document).querySelectorAll('button')]
            .filter((b) => !b.closest('[data-e2e^="edit-profile"]') && b.textContent.trim());
          const extra = btns.map((b, i) => ({ i, text: b.textContent.trim(), off: !!b.disabled }));
          let box = btns.length ? btns[0] : null;
          while (box && box.parentElement && !box.parentElement.querySelector('[data-e2e="edit-profile-save"]')) box = box.parentElement;
          const extraText = box ? (box.innerText || '').split('\n').map((s) => s.trim()).filter((s) => s && !extra.some((b) => b.text === s)).join('\n').slice(0, 600) : '';
          const err = [...document.querySelectorAll('[data-e2e^="edit-profile"] [class*="Error"], [data-e2e^="edit-profile"] [class*="error"], [role="alert"]')]
            .map((e) => e.innerText.trim()).filter(Boolean).join('\n');
          return JSON.stringify({
            username: (q('[data-e2e="edit-profile-username-input"] input') || {}).value || '',
            name: (q('[data-e2e="edit-profile-name-input"] input') || {}).value || '',
            bio: (q('[data-e2e="edit-profile-bio-input"]') || {}).value || '',
            userTip: txt('edit-profile-username-tip'), nameTip: txt('edit-profile-name-input'),
            avatar: img ? img.src : '', saveOff: !!save.disabled, error: err, extra, extraText,
          });
        })()
        """;

    /// <summary>Abre (oculto) el formulario oficial de «Editar perfil» y devuelve sus datos.</summary>
    public async Task<string> OpenEditProfile(string user)
    {
        const string js = """
            (() => {
              if (document.querySelector('[data-e2e="edit-profile-save"]')) return 'ok';
              const b = document.querySelector('[data-e2e="edit-profile-entrance"]');
              if (b) b.click();
              return null;
            })()
            """;
        if (await OpenLocked("https://www.tiktok.com/@" + user, js, "Editar perfil") == null) return null;
        await Task.Delay(300);
        return await Eval(EditStateJs);
    }
    /// <summary>Escribe los campos (como si se tipearan) y toca Guardar.</summary>
    public async Task<string> EditProfileSave(string username, string name, string bio)
    {
        if (!_locked) return null;
        await Eval($$"""
            (() => {
              const set = (el, v) => {
                if (!el || el.value === v) return;
                Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v);
                el.dispatchEvent(new Event('input', { bubbles: true }));
              };
              set(document.querySelector('[data-e2e="edit-profile-username-input"] input'), {{JsonSerializer.Serialize(username ?? "")}});
              set(document.querySelector('[data-e2e="edit-profile-name-input"] input'), {{JsonSerializer.Serialize(name ?? "")}});
              set(document.querySelector('[data-e2e="edit-profile-bio-input"]'), {{JsonSerializer.Serialize(bio ?? "")}});
              return null;
            })()
            """);
        await Task.Delay(700);
        await Eval("(() => { const s = document.querySelector('[data-e2e=\"edit-profile-save\"]'); if (s && !s.disabled) s.click(); return null; })()");
        // Se espera a que el formulario se cierre (guardado) o aparezca un error o una confirmación
        string state = null;
        for (var t = 0; t < 8000; t += 500)
        {
            await Task.Delay(500);
            state = await Eval(EditStateJs);
            if (state == null || state.Contains("\"closed\":true") || state.Contains("\"extra\":[{") || !state.Contains("\"error\":\"\"")) break;
        }
        if (state != null && state.Contains("\"closed\":true")) _locked = false;
        return state;
    }

    /// <summary>Sube una foto nueva al campo de archivo del formulario (vía DevTools, sin diálogo).</summary>
    public async Task<string> EditProfileAvatar(string file)
    {
        if (!_locked) return null;
        var doc = JsonDocument.Parse(await _wv.CallDevToolsProtocolMethodAsync("DOM.getDocument", "{\"depth\":0}"));
        var root = doc.RootElement.GetProperty("root").GetProperty("nodeId").GetInt32();
        var found = JsonDocument.Parse(await _wv.CallDevToolsProtocolMethodAsync("DOM.querySelector",
            JsonSerializer.Serialize(new { nodeId = root, selector = "[data-e2e=\"edit-profile-photo\"] input[type=file], [data-e2e^=\"edit-profile\"] input[type=file]" })));
        var node = found.RootElement.GetProperty("nodeId").GetInt32();
        if (node == 0) return await Eval(EditStateJs);
        await _wv.CallDevToolsProtocolMethodAsync("DOM.setFileInputFiles", JsonSerializer.Serialize(new { files = new[] { file }, nodeId = node }));
        await Task.Delay(1500);
        return await Eval(EditStateJs);
    }

    /// <summary>Toca un botón de un diálogo encima del formulario (p. ej. «Aplicar» en el recorte).</summary>
    public async Task<string> EditProfileAct(int index)
    {
        if (!_locked) return null;
        await Eval($$"""
            (() => {
              const save = document.querySelector('[data-e2e="edit-profile-save"]');
              const list = [...((save && save.closest('[role="dialog"]')) || document).querySelectorAll('button')]
                .filter((b) => !b.closest('[data-e2e^="edit-profile"]') && b.textContent.trim());
              const b = list[{{index}}];
              if (b) b.click();
              return null;
            })()
            """);
        await Task.Delay(1500);
        var state = await Eval(EditStateJs);
        if (state != null && state.Contains("\"closed\":true")) _locked = false;
        return state;
    }

    public async Task EditProfileClose()
    {
        if (!_locked) return;
        try { await Eval("(() => { const c = document.querySelector('[data-e2e=\"edit-profile-cancel\"]'); if (c) c.click(); return null; })()"); }
        finally { _locked = false; }
    }

    // Abre la ventana oficial de denuncia del video (menú ⋯ › Denunciar)
    public const string ReportVideoJs = """
        (() => {
          if (document.querySelector('[data-e2e="report-form"]')) return 'ok';
          const r = document.querySelector('[data-e2e="more-menu-popover_report"]');
          if (r) { r.click(); return null; }
          const m = document.querySelector('[data-e2e="more-menu-icon"]');
          if (m) { ['mouseover', 'mouseenter'].forEach(t => m.dispatchEvent(new MouseEvent(t, { bubbles: true }))); m.click(); }
          return null;
        })()
        """;

    // Abre la ventana oficial de denuncia de un comentario, buscándolo por su texto
    public static string ReportCommentJs(string text) => $$"""
        (() => {
          if (document.querySelector('[data-e2e="report-form"]')) return 'ok';
          const want = {{JsonSerializer.Serialize((text ?? "").Trim())}}.slice(0, 40);
          const rep = document.querySelector('[data-e2e="comment-report"]');
          if (rep) { rep.click(); return null; }
          // Los comentarios solo se cargan al tocar el ícono de comentarios del video
          const list = document.querySelector('[class*="DivCommentListContainer"]');
          if (!list) { const i = document.querySelector('[data-e2e="comment-icon"]'); if (i) i.click(); return null; }
          const item = [...list.querySelectorAll('[class*="DivCommentItemWrapper"]')]
            .find(e => [...e.querySelectorAll('[data-e2e^="comment-level"]')].some(s => s.textContent.includes(want)));
          if (!item) {
            // Puede estar más abajo: se desplaza la lista para que cargue más
            let sc = list;
            while (sc && sc.scrollHeight <= sc.clientHeight + 20) sc = sc.parentElement;
            if (sc) sc.scrollTop = sc.scrollHeight;
            return null;
          }
          item.scrollIntoView({ block: 'center' });
          const more = item.querySelector('[class*="DivMoreTriggerWrapper"]');
          if (more) ['mousedown', 'mouseup', 'click'].forEach(t => more.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
          return null;
        })()
        """;

    // Para el modo de prueba
    public async Task<string> Run(string js) { await Ensure(); return await _wv.ExecuteScriptAsync(js); }
    public Task Open(string url) => Go(url);

    public async Task Show(string url, string autoScript = null)
    {
        await Ensure();
        _visible = true;
        _wv.IsMuted = false;
        UpdateBounds();
        _ctl.IsVisible = true;
        ZOrder(true);
        _nav = new TaskCompletionSource<bool>();
        _wv.Navigate(url);
        await Task.WhenAny(_nav.Task, Task.Delay(20000));
        if (autoScript != null) await Poll(autoScript, 15000);
    }

    public void Hide()
    {
        if (_ctl == null) return;
        _visible = false;
        _wv.IsMuted = true;
        _ctl.IsVisible = _background;
        if (_background) ZOrder(false);
    }

    public void UpdateBounds()
    {
        if (_ctl != null) _ctl.Bounds = _win.EngineBounds();
    }

    // Chats y actividad tal como los muestra la página oficial de mensajes
    const string InboxJs = """
        (() => {
          // Busca en las props internas de React (la página carga las fotos solo cuando se ven)
          const reactUrl = (el, re) => {
            const k = el && Object.keys(el).find(k => k.startsWith('__reactFiber'));
            for (let f = k && el[k], i = 0; f && i < 14; f = f.return, i++) {
              const p = f.memoizedProps;
              if (!p || typeof p !== 'object') continue;
              for (const key of Object.keys(p)) {
                const v = p[key];
                if (re.test(key) && typeof v === 'string' && /^https?:/.test(v)) return v;
                if (re.test(key) && v && typeof v === 'object' && Array.isArray(v.url_list || v.urlList)) return (v.url_list || v.urlList)[0];
              }
            }
            return '';
          };
          const convEls = [...document.querySelectorAll('[data-e2e="dm-new-conversation-item"]')];
          if (!convEls.length) return null;
          const convs = convEls.slice(0, 400).map(el => {
            const nick = el.querySelector('[data-e2e="dm-new-conversation-nickname"]');
            const img = el.querySelector('[data-e2e="dm-new-conversation-avatar"] img');
            const info = nick ? nick.parentElement : el;
            const body = info.querySelector(':scope > p:not([data-e2e])');
            const lastEl = body && body.querySelector('p');
            const timeEl = body && body.querySelector(':scope > span');
            const badge = [...el.querySelectorAll('span, div')].find(x => !x.children.length && /^\d{1,3}\+?$/.test(x.textContent.trim()) && x !== timeEl);
            const name = nick ? nick.textContent.trim() : '';
            const time = timeEl ? timeEl.textContent.trim() : '';
            const last = lastEl ? lastEl.textContent.trim() : '';
            const unread = badge ? parseInt(badge.textContent, 10) : 0;
            const avatar = (img && img.getAttribute('src')) || reactUrl(img || el, /avatar/i);
            return { id: el.dataset.convId, name, avatar, last, time,
              unread, active: el.getAttribute('aria-selected') === 'true' };
          });
          const activity = [...document.querySelectorAll('[data-e2e="inbox-list-item"]')].slice(0, 40).map(el => {
            const t = el.querySelector('[data-e2e="inbox-title"]');
            const c = el.querySelector('[data-e2e="inbox-content"]');
            const imgs = [...el.querySelectorAll('img')].map(i => i.src);
            return { title: t ? t.textContent.trim() : '', content: c ? c.textContent.trim() : el.textContent.trim(),
              avatar: imgs[0] || '', thumb: imgs.length > 1 ? imgs[imgs.length - 1] : '' };
          });
          return JSON.stringify({ convs, activity });
        })()
        """;

    // Mensajes de la conversación abierta; los propios se reconocen porque su avatar no es el del otro
    const string ConvJs = """
        (() => {
          // Busca en las props internas de React (la página carga las fotos solo cuando se ven)
          const reactUrl = (el, re) => {
            const k = el && Object.keys(el).find(k => k.startsWith('__reactFiber'));
            for (let f = k && el[k], i = 0; f && i < 14; f = f.return, i++) {
              const p = f.memoizedProps;
              if (!p || typeof p !== 'object') continue;
              for (const key of Object.keys(p)) {
                const v = p[key];
                if (re.test(key) && typeof v === 'string' && /^https?:/.test(v)) return v;
                if (re.test(key) && v && typeof v === 'object' && Array.isArray(v.url_list || v.urlList)) return (v.url_list || v.urlList)[0];
              }
            }
            return '';
          };
          const box = document.querySelector('[data-e2e="dm-new-chatbox"]');
          const list = box && box.querySelector('[data-e2e="dm-new-message-list"]');
          if (!list) return null;
          const uid = (box.querySelector('[data-e2e="chat-uniqueid"]') || {}).textContent || '';
          const other = '/' + uid.trim().replace(/^\/?/, '');
          const nick = (box.querySelector('[data-e2e="dm-new-chat-nickname"]') || {}).textContent || '';
          const top = box.querySelector('[data-e2e="top-chat-avatar"] img');
          const out = [];
          let idx = -1;
          list.querySelectorAll('[data-e2e="dm-new-time-separator"], [data-e2e="dm-new-chat-item"]').forEach(el => {
            if (el.dataset.e2e === 'dm-new-time-separator') { out.push({ sep: el.textContent.trim() }); return; }
            const a = el.querySelector('[data-e2e="chat-avatar"]');
            const link = a && a.closest('a');
            const href = link ? link.getAttribute('href') : '';
            const txt = el.querySelector('[data-e2e="dm-new-message-text"]');
            const vid = el.querySelector('a[href*="/video/"]');
            const ref = el.querySelector('[class*="RefTextContent"]');
            const imgs = [...el.querySelectorAll('img')].filter(i => !a || !a.contains(i)).map(i => i.src);
            // Video compartido: la portada es un fondo CSS y no hay enlace; se guarda su número de orden
            const shared = el.querySelector('[data-e2e="dm-new-shared-video"]');
            let cover = '', sharedBy = '', itemId = '';
            if (shared) {
              const bg = [shared, ...shared.querySelectorAll('*')].map(e => getComputedStyle(e).backgroundImage).find(b => b && b.startsWith('url('));
              cover = bg ? bg.slice(5, -2) : '';
              sharedBy = (shared.querySelector('p') || {}).textContent || '';
              // El id del video está en las props internas de React del mensaje
              const fk = Object.keys(shared).find(k => k.startsWith('__reactFiber'));
              for (let f = fk && shared[fk], i = 0; f && i < 12; f = f.return, i++) {
                const p = f.memoizedProps;
                if (p && /^\d{15,20}$/.test(String(p.itemId || ''))) { itemId = String(p.itemId); break; }
              }
            }
            idx++;
            out.push({
              idx,
              mine: !!href && href !== other,
              avatar: (a && a.querySelector('img') && a.querySelector('img').getAttribute('src')) || reactUrl(a, /avatar/i),
              text: txt ? txt.textContent : '',
              video: vid ? vid.href : '',
              image: shared ? cover : (!txt && imgs.length ? imgs[0] : ''),
              shared: shared ? [...list.querySelectorAll('[data-e2e="dm-new-shared-video"]')].indexOf(shared) : -1,
              sharedBy,
              itemId,
              ref: ref ? ref.textContent.trim() : '',
              reaction: (() => { const r = el.querySelector('[data-e2e="dm-new-reaction-display"]'); return r ? ([...r.querySelectorAll('img')].map(i => i.alt).join('') || r.textContent.trim()) : ''; })(),
              other: !txt && !vid && !shared && !imgs.length ? (el.textContent || '').trim().slice(0, 200) : ''
            });
          });
          const topEl = box.querySelector('[data-e2e="top-chat-avatar"]');
          return JSON.stringify({ nick: nick.trim(), uid: uid.trim(), avatar: (top && top.getAttribute('src')) || reactUrl(topEl, /avatar/i), messages: out });
        })()
        """;

    /// <summary>Chats recientes y notificaciones de actividad.</summary>
    public async Task<string> LoadInbox()
    {
        if (Busy) return null;
        await Go(Messages);
        if (await Poll(InboxJs, 30000) == null) return null;
        // La actividad (me gusta, comentarios, seguidores) se carga al abrir el panel de notificaciones
        await Eval("""
            (() => {
              if (!document.querySelector('[data-e2e="inbox-list-item"]')) {
                const b = document.querySelector('[data-e2e="inbox-icon"]');
                if (b) b.click();
              }
              return null;
            })()
            """);
        await Poll("document.querySelector('[data-e2e=\"inbox-list-item\"]') ? 'ok' : null", 5000);
        return await Eval(InboxJs);
    }

    async Task<bool> SelectConv(string convId)
    {
        await Go(Messages);
        if (await Poll(InboxJs, 30000) == null) return false;
        var sel = JsonSerializer.Serialize($"[data-conv-id=\"{convId}\"]");
        var ok = await Eval($"(() => {{ const el = document.querySelector({sel}); if (!el) return null; if (el.getAttribute('aria-selected') !== 'true') el.click(); return 'ok'; }})()");
        if (ok == null) return false;
        return await Poll($"(() => {{ const el = document.querySelector({sel}); return el && el.getAttribute('aria-selected') === 'true' && document.querySelector('[data-e2e=\"dm-new-message-list\"]') ? 'ok' : null; }})()", 8000) != null;
    }

    /// <summary>Abre (si hace falta) la conversación y devuelve sus mensajes.</summary>
    public async Task<string> ReadConv(string convId)
    {
        if (Busy) return null;
        if (!await SelectConv(convId)) return null;
        await Task.Delay(300);
        return await Poll(ConvJs, 6000);
    }

    /// <summary>Abre el video compartido número <paramref name="n"/> del chat y devuelve su enlace.</summary>
    public async Task<string> OpenShared(string convId, int n)
    {
        if (Busy) return null;
        if (!await SelectConv(convId)) return null;
        var start = _wv.Source;
        await Eval($"(() => {{ const v = document.querySelectorAll('[data-e2e=\"dm-new-shared-video\"]')[{n}]; if (v) v.click(); return null; }})()");
        // La web abre el video en otra ruta o en una ventana superpuesta con el enlace en la barra
        string url = null;
        for (var t = 0; t < 6000 && url == null; t += 300)
        {
            await Task.Delay(300);
            url = await Eval("(() => { const m = /\\/video\\/(\\d+)/.exec(location.href); if (m) return location.href; const a = document.querySelector('a[href*=\"/video/\"]:not([data-e2e=\"dm-new-shared-video\"] a)'); return null; })()");
        }
        if (_wv.Source != start) { _nav = new TaskCompletionSource<bool>(); _wv.Navigate(Messages); await Task.WhenAny(_nav.Task, Task.Delay(15000)); }
        return url;
    }
    /// <summary>Baja la lista de conversaciones para que la página cargue las más antiguas.</summary>
    public async Task<string> LoadMoreConvs()
    {
        if (Busy) return null;
        await Go(Messages);
        if (await Poll(InboxJs, 30000) == null) return null;
        const string countJs = "String(document.querySelectorAll('[data-e2e=\"dm-new-conversation-item\"]').length)";
        var before = await Eval(countJs);
        await Eval("""
            (() => {
              const item = document.querySelector('[data-e2e="dm-new-conversation-item"]');
              let el = item && item.parentElement;
              while (el && !(/auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 5)) el = el.parentElement;
              if (el) { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll', { bubbles: true })); }
              return null;
            })()
            """);
        for (var t = 0; t < 4000; t += 400)
        {
            await Task.Delay(400);
            if (await Eval(countJs) != before) { await Task.Delay(300); break; }
        }
        return await Eval(InboxJs);
    }

    /// <summary>Sube hasta el principio de la conversación para que la página cargue mensajes anteriores.</summary>
    public async Task<string> LoadOlder(string convId)
    {
        if (Busy) return null;
        if (!await SelectConv(convId)) return null;
        const string countJs = "String(document.querySelectorAll('[data-e2e=\"dm-new-chat-item\"]').length)";
        var before = await Eval(countJs);
        await Eval("""
            (() => {
              // El contenedor que desplaza es un hijo sin nombre: se elige el de mayor contenido oculto
              const box = document.querySelector('[data-e2e="dm-new-chatbox"]');
              const target = [...box.querySelectorAll('*')]
                .filter(e => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 20)
                .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
              if (!target) return null;
              target.scrollTop = 0;
              target.dispatchEvent(new Event('scroll', { bubbles: true }));
              return null;
            })()
            """);
        // Espera a que aparezcan mensajes nuevos arriba (o se rinde a los 4 s)
        for (var t = 0; t < 8000; t += 400)
        {
            await Task.Delay(400);
            if (await Eval(countJs) != before) break;
        }
        return await Eval(ConvJs);
    }

    // Pasa el mouse por el mensaje número index (así la web muestra sus botones) y hace clic en uno de ellos
    async Task<bool> MessageButton(string convId, int index, string e2e)
    {
        if (!await SelectConv(convId)) return false;
        var js = $$"""
            (() => {
              // Solo los mensajes de la conversación (no otros elementos de la página con el mismo atributo)
              const list = document.querySelector('[data-e2e="dm-new-message-list"]');
              const el = list && list.querySelectorAll('[data-e2e="dm-new-chat-item"]')[{{index}}];
              if (!el) return null;
              ['mouseover', 'mouseenter', 'mousemove'].forEach(t => el.dispatchEvent(new MouseEvent(t, { bubbles: true })));
              const b = el.querySelector('[data-e2e="{{e2e}}"]');
              if (!b) return null;
              b.click();
              return 'ok';
            })()
            """;
        return await Eval(js) != null;
    }

    /// <summary>Reacciona a un mensaje con un emoji, usando el botón de reacciones de la web.</summary>
    public async Task<bool> React(string convId, int index, string emoji)
    {
        if (Busy) return false;
        if (!await MessageButton(convId, index, "dm-new-reaction-btn")) return false;
        var e = JsonSerializer.Serialize(emoji);
        var picked = await Poll($$"""
            (() => {
              const e = {{e}};
              const opt = [...document.querySelectorAll('img, span, div, button')].find(x =>
                (x.alt === e || (!x.children.length && x.textContent.trim() === e)) &&
                !x.closest('[data-e2e="dm-new-message-text"]') && !x.closest('[data-e2e="dm-new-reaction-display"]'));
              if (!opt) return null;
              opt.click();
              return 'ok';
            })()
            """, 3000);
        return picked != null;
    }

    /// <summary>Responde a un mensaje: activa "responder" en la web y envía el texto.</summary>
    public async Task<bool> Reply(string convId, int index, string text)
    {
        if (Busy) return false;
        if (!await MessageButton(convId, index, "dm-new-reply-btn")) return false;
        await Task.Delay(300);
        return await SendText(convId, text);
    }
    /// <summary>Escribe y envía un mensaje de texto en la conversación indicada.</summary>
    public async Task<bool> SendText(string convId, string text)
    {
        if (Busy) return false;
        if (!await SelectConv(convId)) return false;
        var found = await Poll("""
            (() => {
              const ed = document.querySelector('[data-e2e="dm-new-input-editor"] [contenteditable="true"]')
                || document.querySelector('[data-e2e="dm-new-input-editor"][contenteditable="true"]')
                || document.querySelector('[data-e2e="message-input-area"] [contenteditable="true"]');
              if (!ed) return null;
              ed.focus();
              return 'ok';
            })()
            """, 8000);
        if (found == null) return false;
        await _wv.CallDevToolsProtocolMethodAsync("Input.insertText", JsonSerializer.Serialize(new { text }));
        await Task.Delay(300);
        await _wv.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent",
            "{\"type\":\"rawKeyDown\",\"key\":\"Enter\",\"code\":\"Enter\",\"windowsVirtualKeyCode\":13}");
        await _wv.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent",
            "{\"type\":\"char\",\"key\":\"Enter\",\"text\":\"\\r\"}");
        await _wv.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent",
            "{\"type\":\"keyUp\",\"key\":\"Enter\",\"code\":\"Enter\",\"windowsVirtualKeyCode\":13}");
        await Task.Delay(900);
        return true;
    }


}
