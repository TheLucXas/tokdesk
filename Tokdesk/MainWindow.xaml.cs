using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;

namespace Tokdesk;

public partial class MainWindow : Window
{
    const string UiHost = "app.tokdesk";

    CoreWebView2Environment _env;
    Engine _engine;
    SidePage _side;
    Tray _tray;
    bool _exiting, _checkedOnce;
    Updater.Info _pendingUpdate;
    readonly AppSettings _settings = AppSettings.Load();
    static readonly HttpClient Http = new();
    Offline _off;
    Task _offClean = Task.CompletedTask;

    public MainWindow()
    {
        InitializeComponent();
        Updater.CleanupOld();
        RestoreWindow();
        _tray = new Tray(ShowFromTray, () => _ = CheckUpdates(true), ExitApp);
        UpdateTray();

        Loaded += async (_, _) =>
        {
            try { await Init(); }
            catch (Exception ex)
            {
                Log.Write("Init falló: " + ex);
                MessageBox.Show(ex.Message + "\n\nSi falta el componente WebView2, instálalo desde https://go.microsoft.com/fwlink/p/?LinkId=2124703",
                    "Tokdesk");
            }
        };
        SourceInitialized += (_, _) => { HwndSource.FromHwnd(new WindowInteropHelper(this).Handle).AddHook(WndProc); ApplyMediaKeys(); };
        SizeChanged += (_, _) => { _engine?.UpdateBounds(); _side?.UpdateBounds(); };
        StateChanged += (_, _) =>
        {
            PostToUi(new { t = "winstate", max = WindowState == WindowState.Maximized });
            SendWinState();
            if (WindowState == WindowState.Minimized && _settings.MinimizeToTray) HideToTray();
        };
        Closing += OnClosing;
        // La página no se entera sola de que la ventana se minimizó o perdió el foco: se le avisa
        Activated += (_, _) => SendWinState();
        Deactivated += (_, _) => SendWinState();
        IsVisibleChanged += (_, _) => SendWinState();
    }

    // ---------- Ventana, bandeja y ajustes nativos ----------

    void RestoreWindow()
    {
        Topmost = _settings.AlwaysOnTop;
        if (_settings.RememberWindow && _settings.Width is > 200 && _settings.Height is > 300)
        {
            var vs = SystemParameters.VirtualScreenWidth; var vh = SystemParameters.VirtualScreenHeight;
            if (_settings.Left is double l && _settings.Top is double t && l < vs - 100 && t < vh - 100 && l > -100 && t > -50)
            {
                WindowStartupLocation = WindowStartupLocation.Manual;
                Left = l; Top = t;
            }
            Width = _settings.Width.Value; Height = _settings.Height.Value;
            if (_settings.Maximized) WindowState = WindowState.Maximized;
        }
        var args = Environment.GetCommandLineArgs();
        if (_settings.StartMinimized || args.Contains("--minimized"))
        {
            if (_settings.MinimizeToTray) { ShowActivated = false; Loaded += (_, _) => HideToTray(); }
            WindowState = WindowState.Minimized;
        }
    }

    void SaveWindow()
    {
        if (!_settings.RememberWindow) return;
        var r = WindowState == WindowState.Normal ? new Rect(Left, Top, Width, Height) : RestoreBounds;
        if (!r.IsEmpty) { _settings.Left = r.Left; _settings.Top = r.Top; _settings.Width = r.Width; _settings.Height = r.Height; }
        _settings.Maximized = WindowState == WindowState.Maximized;
        _settings.Save();
    }

    void SendWinState() => PostToUi(new { t = "win", minimized = WindowState == WindowState.Minimized || !IsVisible, focused = IsActive });

    void UpdateTray() => _tray.Visible = _settings.MinimizeToTray || _settings.CloseToTray || !IsVisible;

    void HideToTray()
    {
        _tray.Visible = true;
        Hide();
    }

    public void ShowFromTray()
    {
        Show();
        if (WindowState == WindowState.Minimized) WindowState = _settings.Maximized ? WindowState.Maximized : WindowState.Normal;
        Activate();
        UpdateTray();
    }

    void ExitApp()
    {
        _exiting = true;
        Close();
    }

    /// <summary>Cierre forzado (actualización): no se va a la bandeja aunque esté activado.</summary>
    public void ExitNow() => ExitApp();

    void OnClosing(object sender, System.ComponentModel.CancelEventArgs e)
    {
        if (!_exiting && _settings.CloseToTray)
        {
            // "Cerrar minimiza": a la bandeja si está activada, si no a la barra de tareas
            e.Cancel = true;
            if (_settings.MinimizeToTray) HideToTray(); else WindowState = WindowState.Minimized;
            return;
        }
        SaveWindow();
        _tray.Dispose();
        // Sin segundo plano, el notificador vive solo mientras la app está abierta
        if (!_settings.NotifyBackground) NotifyService.Stop();
    }

    // Textos traducidos e idioma que manda la interfaz para el notificador
    Dictionary<string, string> _notifyStrings;
    string _notifyLang;

    object SettingsDto() => new
    {
        t = "settings",
        s = _settings,
        version = AppInfo.VersionText,
        updates = Updater.Configured,
        downloads = DownloadDir(),
    };

    void ApplySetting(string key, JsonElement v)
    {
        switch (key)
        {
            case "StartWithWindows": _settings.StartWithWindows = v.GetBoolean(); _settings.ApplyStartup(); break;
            case "StartMinimized": _settings.StartMinimized = v.GetBoolean(); break;
            case "MinimizeToTray": _settings.MinimizeToTray = v.GetBoolean(); break;
            case "CloseToTray": _settings.CloseToTray = v.GetBoolean(); break;
            case "AlwaysOnTop": _settings.AlwaysOnTop = Topmost = v.GetBoolean(); break;
            case "RememberWindow": _settings.RememberWindow = v.GetBoolean(); break;
            case "HardwareAcceleration": _settings.HardwareAcceleration = v.GetBoolean(); break;
            case "AutoCheckUpdates": _settings.AutoCheckUpdates = v.GetBoolean(); break;
            case "AutoInstallUpdates": _settings.AutoInstallUpdates = v.GetBoolean(); break;
            case "GlobalMediaKeys": _settings.GlobalMediaKeys = v.GetBoolean(); ApplyMediaKeys(); break;
            case "StartMenuShortcut": _settings.StartMenuShortcut = v.GetBoolean(); _settings.ApplyShortcuts(); break;
            case "DesktopShortcut": _settings.DesktopShortcut = v.GetBoolean(); _settings.ApplyShortcuts(); break;
            case "AskDownloadFolder": _settings.AskDownloadFolder = v.GetBoolean(); break;
            case "Notifications": case "NotifyBackground": case "NotifyMessages": case "NotifyLikes":
            case "NotifyComments": case "NotifyMentions": case "NotifyFollowers": case "NotifyOther":
                typeof(AppSettings).GetProperty(key)!.SetValue(_settings, v.GetBoolean());
                _ = NotifyService.Update(_settings, _engine, _notifyStrings, _notifyLang);
                break;
            case "LinkHandler":
                _settings.LinkHandler = v.GetBoolean();
                Links.ApplyHandler(_settings.LinkHandler);
                break;
            case "NotifyInterval":
                _settings.NotifyInterval = Math.Clamp(v.GetInt32(), 1, 60);
                _ = NotifyService.Update(_settings, _engine, _notifyStrings, _notifyLang);
                break;
            case "Zoom":
                _settings.Zoom = Math.Clamp(v.GetDouble(), 0.5, 2.0);
                Ui.ZoomFactor = _settings.Zoom;
                break;
        }
        _settings.Save();
        UpdateTray();
        PostToUi(SettingsDto());
    }

    // ---------- Teclas multimedia globales (opcional) ----------

    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    static readonly (int id, uint vk, string action)[] MediaKeys = { (1, 0xB3, "toggle"), (2, 0xB0, "next"), (3, 0xB1, "prev") };

    void ApplyMediaKeys()
    {
        var h = new WindowInteropHelper(this).Handle;
        if (h == IntPtr.Zero) return;
        foreach (var k in MediaKeys)
        {
            UnregisterHotKey(h, k.id);
            if (_settings.GlobalMediaKeys && !RegisterHotKey(h, k.id, 0, k.vk))
                Log.Write("Tecla multimedia ocupada por otra app: " + k.action);
        }
    }

    // Ventana sin borde: al maximizar se limita al área de trabajo del monitor para no tapar la barra de tareas
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MINMAXINFO { public POINT Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)] struct MONITORINFO { public int Size; public RECT Monitor, Work; public uint Flags; }
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    static void FitToWorkArea(IntPtr hwnd, IntPtr lParam)
    {
        var mon = MonitorFromWindow(hwnd, 2 /* MONITOR_DEFAULTTONEAREST */);
        var info = new MONITORINFO { Size = Marshal.SizeOf<MONITORINFO>() };
        if (mon == IntPtr.Zero || !GetMonitorInfo(mon, ref info)) return;
        var mmi = Marshal.PtrToStructure<MINMAXINFO>(lParam);
        mmi.MaxPosition.X = info.Work.Left - info.Monitor.Left;
        mmi.MaxPosition.Y = info.Work.Top - info.Monitor.Top;
        mmi.MaxSize.X = info.Work.Right - info.Work.Left;
        mmi.MaxSize.Y = info.Work.Bottom - info.Work.Top;
        Marshal.StructureToPtr(mmi, lParam, true);
    }

    IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == 0x0024 /* WM_GETMINMAXINFO */) { FitToWorkArea(hwnd, lParam); return IntPtr.Zero; }
        const int WM_HOTKEY = 0x0312;
        if (msg == WM_HOTKEY)
        {
            var k = MediaKeys.FirstOrDefault(x => x.id == wParam.ToInt32());
            if (k.action != null) { PostToUi(new { t = "hotkey", a = k.action }); handled = true; }
        }
        return IntPtr.Zero;
    }

    // ---------- Actualizaciones ----------

    async Task CheckUpdates(bool manual)
    {
        if (!Updater.Configured)
        {
            PostToUi(new { t = "update", status = "noconfig" });
            return;
        }
        try
        {
            _pendingUpdate = await Updater.Check();
            if (_pendingUpdate == null)
            {
                PostToUi(new { t = "update", status = "none", manual });
                if (manual && !IsVisible) _tray.Notify("Tokdesk", "Ya tienes la última versión.");
                return;
            }
            PostToUi(new { t = "update", status = "available", version = _pendingUpdate.Tag, notes = _pendingUpdate.Notes, manual });
            if (!IsVisible) _tray.Notify("Tokdesk", $"Hay una versión nueva ({_pendingUpdate.Tag}).");
            if (_settings.AutoInstallUpdates && !manual) await InstallUpdate();
        }
        catch (Exception ex)
        {
            Log.Write("Buscar actualización falló: " + ex.Message);
            PostToUi(new { t = "update", status = "error", error = ex.Message, manual });
        }
    }

    async Task InstallUpdate()
    {
        if (_pendingUpdate == null) return;
        try
        {
            SaveWindow();
            await Updater.Install(_pendingUpdate, p => Dispatcher.Invoke(() => PostToUi(new { t = "updprogress", p })));
        }
        catch (Exception ex)
        {
            Log.Write("Instalar actualización falló: " + ex.Message);
            PostToUi(new { t = "update", status = "error", error = ex.Message, manual = true });
        }
    }

    async Task Init()
    {
        var profile = AppInfo.ProfileDir();
        var options = new CoreWebView2EnvironmentOptions(
            "--autoplay-policy=no-user-gesture-required " +
            "--disable-background-timer-throttling --disable-renderer-backgrounding " +
            "--disable-backgrounding-occluded-windows" +
            // H.265 por hardware: TikTok suele dar el 1080p solo en H.265
            " --enable-features=PlatformHEVCDecoderSupport,PlatformHEVCEncoderSupport" +
            (_settings.HardwareAcceleration ? "" : " --disable-gpu"));
        _env = await CoreWebView2Environment.CreateAsync(null, profile, options);

        await Ui.EnsureCoreWebView2Async(_env);
        var ui = Ui.CoreWebView2;
        if (!_settings.ImageCacheFixed)
        {
            await ui.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.DiskCache);
            _settings.ImageCacheFixed = true;
            _settings.Save();
        }
        ui.Settings.AreDefaultContextMenusEnabled = false;
        ui.Settings.IsStatusBarEnabled = false;
        ui.Settings.IsZoomControlEnabled = false;
        ui.Settings.AreBrowserAcceleratorKeysEnabled = false;
        ui.SetVirtualHostNameToFolderMapping(UiHost, AppInfo.WebDir(),
            CoreWebView2HostResourceAccessKind.Allow);
        // Videos guardados en disco (búfer y sin conexión)
        _off = new Offline(Http, () => _engine.CookieHeader(), () => _engine.UserAgent);
        _offClean = Task.Run(_off.CleanSilent);
        ui.SetVirtualHostNameToFolderMapping(Offline.Host, Offline.Dir, CoreWebView2HostResourceAccessKind.Allow);

        // Los CDN de video e imagen exigen el Referer de la web oficial
        ui.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.Media);
        ui.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.Image);
        // Audio aparte (.m4a): lo sirve la propia app desde su carpeta, con rangos (el reproductor los pide así)
        ui.AddWebResourceRequestedFilter("https://audio.tokdesk/*", CoreWebView2WebResourceContext.All);
        ui.WebResourceRequested += (_, e) =>
        {
            if (e.Request.Uri.StartsWith("https://audio.tokdesk/")) { e.Response = ServeAudio(ui, e.Request); return; }
            if (!e.Request.Uri.Contains(UiHost))
                e.Request.Headers.SetHeader("Referer", "https://www.tiktok.com/");
        };
        ui.WebMessageReceived += OnUiMessage;
        Ui.ZoomFactor = _settings.Zoom;
        // Respaldo de las preferencias de la interfaz: se entregan antes de que cargue la página
        try
        {
            var prefs = File.Exists(PrefsFile) ? File.ReadAllText(PrefsFile) : "{}";
            using (JsonDocument.Parse(prefs)) { }
            await ui.AddScriptToExecuteOnDocumentCreatedAsync($"window.__hostPrefs = {prefs};");
        }
        catch (Exception ex) { Log.Write("Preferencias: " + ex.Message); }
        ui.Navigate($"https://{UiHost}/index.html");

        if (Environment.GetEnvironmentVariable("TOKDESK_DUMP") == "1") StartTestHook();

        // Los accesos directos se rehacen al abrir: así apuntan siempre al lanzador actual
        _settings.ApplyShortcuts();
        Links.RegisterProtocol();

        // Nombre e ícono propios en el mezclador de volumen (las sesiones aparecen al empezar a sonar)
        var mixer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
        // Los mezcladores leen mejor un .ico suelto que un ícono dentro del .exe
        var ico = Path.Combine(AppInfo.DataDir, "tokdesk.ico");
        try
        {
            using var src = Application.GetResourceStream(new Uri("pack://application:,,,/app.ico")).Stream;
            using var dst = File.Create(ico);
            src.CopyTo(dst);
        }
        catch (Exception ex) { Log.Write("Ícono para el mezclador: " + ex.Message); }
        Task.Run(() => AudioSessions.Watch("Tokdesk", Environment.GetEnvironmentVariable("TOKDESK_ICON") ?? AppInfo.ExePath));
        // EarTrumpet no lee bien un .ico suelto (mostraba una "T"): se usa el ícono del propio .exe
        ico = Environment.GetEnvironmentVariable("TOKDESK_ICON") ?? AppInfo.ExePath;
        mixer.Tick += (_, _) => Task.Run(() => AudioSessions.Label("Tokdesk", ico));
        mixer.Start();

        var hwnd = new WindowInteropHelper(this).Handle;
        _side = new SidePage(_env, hwnd, this);
        _engine = new Engine(_env, hwnd, this);
        await _engine.Start();
    }

    public void PostToUi(object msg)
    {
        Ui.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(msg));
    }

    async void OnUiMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var m = doc.RootElement;
            string S(string k) => m.TryGetProperty(k, out var v) ? v.ToString() : null;
            switch (S("t"))
            {
                case "ready":
                    _engine?.ReplayFeed();
                    PostToUi(SettingsDto());
                    if (_settings.AutoCheckUpdates && Updater.Configured && !_checkedOnce) { _checkedOnce = true; _ = CheckUpdates(false); }
                    _uiReady = true;
                    // Si la ventana abrió sin foco, Activated/Deactivated nunca llegan: se avisa el estado real
                    SendWinState();
                    OpenPendingLink();
                    // La página oculta se precarga para que denunciar o editar el perfil abran rápido la primera vez
                    _ = Dispatcher.InvokeAsync(async () => { await Task.Delay(8000); await _side.Warm(); });
                    break;
                case "more": await _engine.LoadMore(); break;
                case "api":
                {
                    var query = m.GetProperty("q").EnumerateObject().Select(p => (p.Name, p.Value.ToString()));
                    var (status, body) = await _engine.Api(S("m"), S("path"), query);
                    PostToUi(new { t = "api", rid = m.GetProperty("rid").GetInt32(), status, body });
                    break;
                }
                case "offsave":
                    {
                        var kind = S("kind"); var id = S("id");
                        var url = await _off.Save(kind, id, S("url"), S("cover"), S("meta"), S("alt"));
                        PostToUi(new { t = "offsaved", kind, id, url, size = _off.Size(kind) });
                        break;
                    }
                case "audiofix":
                    {
                        // Video HEVC sin sonido: se arma un .m4a con solo el audio de la variante H.264
                        var id = S("id");
                        var cookie = await _engine.CookieHeader();
                        var ua = _engine.UserAgent;
                        var file = await Mp4Audio.Extract(Http, id, S("url"), req =>
                        {
                            req.Headers.Referrer = new Uri("https://www.tiktok.com/");
                            req.Headers.TryAddWithoutValidation("User-Agent", ua);
                            req.Headers.TryAddWithoutValidation("Cookie", cookie);
                        });
                        PostToUi(new { t = "audiofixed", id, url = file == null ? null : $"https://audio.tokdesk/{Path.GetFileName(file)}" });
                        break;
                    }
                case "offlist": await _offClean; PostToUi(_off.List(S("kind"))); break;
                case "offclear": _off.Clear(S("kind")); PostToUi(_off.List(S("kind"))); break;
                case "download": await Download(S("url"), S("name"), S("ext") ?? "mp4", m.TryGetProperty("rid", out var dr) ? dr.GetInt32() : 0); break;
                case "showfile":
                    if (File.Exists(S("file"))) Process.Start("explorer.exe", $"/select,\"{S("file")}\"");
                    else Process.Start("explorer.exe", $"\"{DownloadDir()}\"");
                    break;
                case "pickfolder": PickDownloadFolder(); break;
                case "getsettings": PostToUi(SettingsDto()); break;
                case "setsetting": ApplySetting(S("k"), m.GetProperty("v")); break;
                case "checkupdate": await CheckUpdates(true); break;
                case "installupdate": await InstallUpdate(); break;
                case "openfolder": Process.Start("explorer.exe", $"\"{AppInfo.DataDir}\""); break;
                case "clearcache":
                    await Ui.CoreWebView2.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.DiskCache | CoreWebView2BrowsingDataKinds.CacheStorage);
                    PostToUi(new { t = "toast", m = "Caché borrada" });
                    break;
                case "logout":
                    await Ui.CoreWebView2.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.AllProfile);
                    PostToUi(new { t = "reset" });
                    _engine.Restart();
                    break;
                case "restart":
                    _exiting = true;
                    SaveWindow();
                    Process.Start(new ProcessStartInfo(AppInfo.StartPath) { UseShellExecute = false });
                    Application.Current.Shutdown();
                    break;
                case "open":
                    // Los enlaces de TikTok se quedan en la app, salvo que se pida la web a propósito (LIVE, «abrir en el navegador»)
                    if (!m.TryGetProperty("browser", out _) && Links.IsTikTok(S("url"))) { Links.SetPending(S("url")); OpenPendingLink(); }
                    // Con Tokdesk como gestor de enlaces, la web se abre por el lanzador para no volver a la app
                    else if (_settings.LinkHandler && AppInfo.HasLauncher && S("url").StartsWith("http"))
                        Process.Start(new ProcessStartInfo(AppInfo.StartPath, $"--browser \"{S("url")}\"") { UseShellExecute = false });
                    else Process.Start(new ProcessStartInfo(S("url")) { UseShellExecute = true });
                    break;
                case "reportopen":
                    PostToUi(new { t = "reportstate", s = await _side.OpenReport(S("url"), S("comment")) });
                    break;
                case "reportact":
                    PostToUi(new { t = "reportstate", s = await _side.ReportAct(S("kind"), m.GetProperty("i").GetInt32()) });
                    break;
                case "reportclose": await _side.ReportClose(); break;
                case "sharevideo":
                    {
                        var people = m.GetProperty("people").EnumerateArray().Select(x => x.GetString()).ToArray();
                        var ok = await _side.ShareVideo(S("url"), people, S("msg"));
                        PostToUi(new { t = "shared", ok, rid = m.GetProperty("rid").GetInt32() });
                        break;
                    }
                case "hevcuninstall":
                    {
                        var err = await Hevc.Uninstall();
                        PostToUi(new { t = "hevc", state = err == null ? "removed" : "error", msg = err });
                        break;
                    }
                case "hevcinstall":
                case "hevcreinstall":
                    {
                        // Reparar = quitar y volver a instalar
                        if (m.GetProperty("t").GetString() == "hevcreinstall") await Hevc.Uninstall();
                        var err = await Hevc.Install(Http, (st, p) => Dispatcher.Invoke(() => PostToUi(new { t = "hevc", state = st, p })));
                        PostToUi(new { t = "hevc", state = err == null ? "done" : "error", msg = err });
                        break;
                    }
                case "prefs":
                    try { File.WriteAllText(PrefsFile, m.GetProperty("v").GetRawText()); } catch (Exception ex) { Log.Write("Preferencias: " + ex.Message); }
                    break;
                case "notifystrings":
                    _notifyStrings = m.GetProperty("s").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString());
                    _notifyLang = S("lang");
                    await NotifyService.Update(_settings, _engine, _notifyStrings, _notifyLang);
                    break;
                case "notify":
                    if (_settings.Notifications && _settings.NotifyMessages && !IsActive) _tray.Notify(S("title"), S("text"));
                    break;
                case "editopen":
                    PostToUi(new { t = "editstate", s = await _side.OpenEditProfile(S("user")) });
                    break;
                case "editsave":
                    PostToUi(new { t = "editstate", s = await _side.EditProfileSave(S("username"), S("name"), S("bio")) });
                    break;
                case "editavatar":
                    {
                        var dlg = new Microsoft.Win32.OpenFileDialog { Filter = "Imágenes|*.jpg;*.jpeg;*.png;*.webp" };
                        if (dlg.ShowDialog(this) != true) { PostToUi(new { t = "editstate", s = (string)null, keep = true }); break; }
                        PostToUi(new { t = "editstate", s = await _side.EditProfileAvatar(dlg.FileName) });
                        break;
                    }
                case "editact":
                    PostToUi(new { t = "editstate", s = await _side.EditProfileAct(m.GetProperty("i").GetInt32()) });
                    break;
                case "editclose": await _side.EditProfileClose(); break;
                case "report":
                    ShowPanel(_side);
                    await _side.Show(S("url"), string.IsNullOrEmpty(S("comment")) ? SidePage.ReportVideoJs : SidePage.ReportCommentJs(S("comment")));
                    break;
                case "web":
                    ShowPanel(_side);
                    await _side.Show(S("url"));
                    break;
                case "inbox":
                    PostToUi(new { t = "inbox", data = await _side.LoadInbox() });
                    break;
                case "conv":
                    PostToUi(new { t = "conv", id = S("id"), data = await _side.ReadConv(S("id")) });
                    break;
                case "openshared":
                    PostToUi(new { t = "sharedurl", url = await _side.OpenShared(S("id"), m.GetProperty("n").GetInt32()) });
                    break;
                case "inboxmore":
                    PostToUi(new { t = "inbox", more = true, data = await _side.LoadMoreConvs() });
                    break;
                case "chatvis": _side.ChatOpen = m.GetProperty("on").GetBoolean(); await _side.SetBackground(_side.ChatOpen); break;
                case "convold":
                    PostToUi(new { t = "conv", id = S("id"), older = true, data = await _side.LoadOlder(S("id")) });
                    break;
                case "text":
                    PostToUi(new { t = "text", rid = m.GetProperty("rid").GetInt32(), body = await FetchText(S("url")) });
                    break;
                case "dmreact":
                    PostToUi(new { t = "dmreact", ok = await _side.React(S("id"), m.GetProperty("i").GetInt32(), S("emoji")) });
                    break;
                case "dmreply":
                    PostToUi(new { t = "dm", id = S("id"), ok = await _side.Reply(S("id"), m.GetProperty("i").GetInt32(), S("text")) });
                    break;
                case "dm":
                {
                    var ok = await _side.SendText(S("id"), S("text"));
                    PostToUi(new { t = "dm", id = S("id"), ok });
                    break;
                }
                case "login": ShowPanel(_engine, "https://www.tiktok.com/login"); WatchLogin(); break;
                case "verify": ShowPanel(_engine); break;
                case "log": Log.Write("UI: " + S("m")); break;
                case "drag": DragWindow(); break;
                case "min": WindowState = WindowState.Minimized; break;
                case "max": WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized; break;
                case "top":
                    Topmost = !Topmost;
                    PostToUi(new { t = "topmost", on = Topmost });
                    break;
                case "close": Close(); break;
                case "exit": ExitApp(); break;
                case "tiktoklang": await _engine.SetLanguage(S("code")); break;
            }
        }
        catch (Exception ex) { Log.Write("Mensaje UI falló: " + ex); }
    }

    object _panel;

    // Muestra la web oficial (para iniciar sesión, verificar o reportar) en lugar de la UI
    void ShowPanel(object which, string url = null)
    {
        _panel = which;
        LoginBar.Visibility = Visibility.Visible;
        Ui.Visibility = Visibility.Collapsed;
        PanelText.Text = which == _engine
            ? "Iniciar sesión"
            : "TikTok";
        Dispatcher.InvokeAsync(() =>
        {
            if (which == _engine) _engine.SetVisible(true, url);
            else _side.UpdateBounds();
        }, System.Windows.Threading.DispatcherPriority.Loaded);
    }

    CoreWebView2WebResourceResponse ServeAudio(CoreWebView2 ui, CoreWebView2WebResourceRequest req)
    {
        try
        {
            var name = Path.GetFileName(new Uri(req.Uri).AbsolutePath);
            var file = Path.Combine(Mp4Audio.Dir, name);
            if (!name.EndsWith(".m4a") || !File.Exists(file)) return _env.CreateWebResourceResponse(null, 404, "Not Found", "");
            var all = File.ReadAllBytes(file);
            long a = 0, b = all.Length - 1;
            var range = req.Headers.Contains("Range") ? req.Headers.GetHeader("Range") : null;
            var m = range == null ? null : System.Text.RegularExpressions.Regex.Match(range, @"bytes=(\d*)-(\d*)");
            if (m != null && m.Success)
            {
                if (m.Groups[1].Value.Length > 0) a = long.Parse(m.Groups[1].Value);
                if (m.Groups[2].Value.Length > 0) b = Math.Min(b, long.Parse(m.Groups[2].Value));
            }
            var part = new MemoryStream(all, (int)a, (int)(b - a + 1), false);
            var headers = $"Content-Type: audio/mp4\r\nAccept-Ranges: bytes\r\nContent-Length: {b - a + 1}\r\nAccess-Control-Allow-Origin: *";
            return m != null && m.Success
                ? _env.CreateWebResourceResponse(part, 206, "Partial Content", headers + $"\r\nContent-Range: bytes {a}-{b}/{all.Length}")
                : _env.CreateWebResourceResponse(part, 200, "OK", headers);
        }
        catch (Exception ex) { Log.Write("Audio aparte (servir): " + ex.Message); return _env.CreateWebResourceResponse(null, 500, "Error", ""); }
    }

    static readonly string PrefsFile = Path.Combine(AppInfo.DataDir, "prefs.json");

    bool _uiReady;

    /// <summary>Abre en la interfaz el enlace de TikTok que llegó por argumento, tokdesk:// u otra instancia.</summary>
    public async void OpenPendingLink()
    {
        if (!_uiReady) return; // se abre cuando la interfaz avise que está lista
        var url = Links.TakePending();
        if (url == null) return;
        url = await Links.Resolve(Http, url);
        Log.Write("Enlace: " + url);
        PostToUi(new { t = "openlink", url });
    }

    // Al terminar de iniciar sesión (aparece una cookie de sesión nueva) se vuelve sola a la app
    async void WatchLogin()
    {
        static string Session(string cookies) =>
            System.Text.RegularExpressions.Regex.Match(cookies ?? "", @"(?:^|;\s*)sessionid=([^;]*)").Groups[1].Value;
        var before = Session(await _engine.CookieHeader());
        while (_panel == _engine && LoginBar.Visibility == Visibility.Visible)
        {
            await Task.Delay(1500);
            var now = Session(await _engine.CookieHeader());
            if (now.Length > 0 && now != before && _panel == _engine)
            {
                Log.Write("Sesión iniciada: se vuelve a la app");
                await Task.Delay(1500); // deja que la web termine de guardar la sesión
                DoneButton_Click(null, null);
                return;
            }
        }
    }

    void DoneButton_Click(object sender, RoutedEventArgs e)
    {
        LoginBar.Visibility = Visibility.Collapsed;
        Ui.Visibility = Visibility.Visible;
        if (_panel == _engine)
        {
            _engine.SetVisible(false);
            PostToUi(new { t = "reset" });
            _engine.Restart();
        }
        else _side.Hide();
        _panel = null;
    }

    public System.Drawing.Rectangle EngineBounds()
    {
        var p = EngineHost.TranslatePoint(new Point(0, 0), this);
        var s = System.Windows.Media.VisualTreeHelper.GetDpi(this).DpiScaleX;
        return new System.Drawing.Rectangle((int)(p.X * s), (int)(p.Y * s), (int)(EngineHost.ActualWidth * s), (int)(EngineHost.ActualHeight * s));
    }

    // Descarga un archivo de texto del CDN (subtítulos) con el Referer y cookies de la web
    async Task<string> FetchText(string url)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Referrer = new Uri("https://www.tiktok.com/");
            req.Headers.TryAddWithoutValidation("User-Agent", _engine.UserAgent);
            req.Headers.TryAddWithoutValidation("Cookie", await _engine.CookieHeader());
            using var resp = await Http.SendAsync(req);
            return resp.IsSuccessStatusCode ? await resp.Content.ReadAsStringAsync() : null;
        }
        catch (Exception ex) { Log.Write("Texto falló: " + ex.Message); return null; }
    }

    // ---------- Descargas ----------

    static string DefaultDownloadDir() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "Tokdesk");

    string DownloadDir() => string.IsNullOrWhiteSpace(_settings.DownloadFolder) ? DefaultDownloadDir() : _settings.DownloadFolder;

    void PickDownloadFolder()
    {
        using var dlg = new System.Windows.Forms.FolderBrowserDialog
        {
            Description = "Carpeta de descargas de Tokdesk",
            UseDescriptionForTitle = true,
            SelectedPath = DownloadDir(),
        };
        if (dlg.ShowDialog() == System.Windows.Forms.DialogResult.OK)
        {
            _settings.DownloadFolder = dlg.SelectedPath;
            _settings.Save();
        }
        PostToUi(SettingsDto());
    }

    /// <summary>
    /// Descarga un archivo del CDN con el Referer y las cookies de la web, informando el progreso.
    /// <paramref name="ext"/> decide la extensión (mp4, mp3, jpg).
    /// </summary>
    async Task Download(string url, string name, string ext, int rid)
    {
        string file = null;
        try
        {
            var safe = string.Concat(name.Split(Path.GetInvalidFileNameChars())) + "." + ext;
            if (_settings.AskDownloadFolder)
            {
                var dlg = new Microsoft.Win32.SaveFileDialog
                {
                    FileName = safe,
                    InitialDirectory = DownloadDir(),
                    Filter = ext switch { "mp3" => "Audio MP3|*.mp3", "jpg" => "Imagen JPG|*.jpg", _ => "Video MP4|*.mp4" },
                };
                if (dlg.ShowDialog(this) != true) { PostToUi(new { t = "dl", rid, state = "cancel" }); return; }
                file = dlg.FileName;
            }
            else
            {
                Directory.CreateDirectory(DownloadDir());
                file = Path.Combine(DownloadDir(), safe);
            }

            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Referrer = new Uri("https://www.tiktok.com/");
            req.Headers.TryAddWithoutValidation("User-Agent", _engine.UserAgent);
            req.Headers.TryAddWithoutValidation("Cookie", await _engine.CookieHeader());
            using var resp = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
            resp.EnsureSuccessStatusCode();
            var total = resp.Content.Headers.ContentLength ?? 0;
            await using (var src = await resp.Content.ReadAsStreamAsync())
            await using (var fs = File.Create(file))
            {
                var buf = new byte[81920];
                long done = 0; int read, last = -1;
                while ((read = await src.ReadAsync(buf)) > 0)
                {
                    await fs.WriteAsync(buf.AsMemory(0, read));
                    done += read;
                    var p = total > 0 ? (int)(done * 100 / total) : -1;
                    if (p != last && p % 5 == 0) { last = p; PostToUi(new { t = "dl", rid, state = "progress", p }); }
                }
            }
            PostToUi(new { t = "dl", rid, state = "done", file, name = Path.GetFileName(file) });
        }
        catch (Exception ex)
        {
            Log.Write("Descarga falló: " + ex.Message);
            try { if (file != null && File.Exists(file)) File.Delete(file); } catch { }
            PostToUi(new { t = "dl", rid, state = "error" });
        }
    }
    // Modo de prueba: cada línea escrita en test.txt se ejecuta como JS en la UI; "shot" guarda una captura
    void StartTestHook()
    {
        var file = Path.Combine(AppContext.BaseDirectory, "test.txt");
        File.WriteAllText(file, "");
        var timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(500) };
        timer.Tick += async (_, _) =>
        {
            string[] lines;
            try { lines = File.ReadAllLines(file); if (lines.Length == 0) return; File.WriteAllText(file, ""); }
            catch { return; }
            foreach (var line in lines)
            {
                if (line.StartsWith("shot"))
                {
                    var target = Path.Combine(AppContext.BaseDirectory, line.Length > 5 ? line[5..].Trim() : "shot.png");
                    await using var fs = File.Create(target);
                    await Ui.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, fs);
                }
                else if (line.StartsWith("http:")) { var r = await FetchText(line[5..]); Log.Write("TEST http " + (r == null ? "null" : r[..Math.Min(r.Length, 1500)])); }
                else if (line.StartsWith("sideinit:")) { await _side.AddInitScript(line[9..]); Log.Write("TEST sideinit ok"); }
                else if (line.StartsWith("sidego:")) { await _side.Open(line[7..]); Log.Write("TEST side en " + line[7..]); }
                else if (line.StartsWith("side:")) Log.Write("TEST " + await _side.Run(line[5..]));
                else Log.Write("TEST " + await Ui.CoreWebView2.ExecuteScriptAsync(line));
            }
        };
        timer.Start();
    }

    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    void DragWindow()
    {
        if (WindowState == WindowState.Maximized) return;
        ReleaseCapture();
        SendMessage(new WindowInteropHelper(this).Handle, 0xA1 /* WM_NCLBUTTONDOWN */, (IntPtr)2 /* HTCAPTION */, IntPtr.Zero);
    }
}
