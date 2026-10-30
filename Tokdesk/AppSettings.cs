using System.IO;
using System.Text.Json;
using Microsoft.Win32;

namespace Tokdesk;

/// <summary>Ajustes nativos de la ventana (los de la interfaz se guardan en la propia UI).</summary>
sealed class AppSettings
{
    public bool StartWithWindows { get; set; }
    public bool StartMinimized { get; set; }
    public bool MinimizeToTray { get; set; }
    public bool CloseToTray { get; set; }
    public bool AlwaysOnTop { get; set; }
    public bool RememberWindow { get; set; } = true;
    public bool HardwareAcceleration { get; set; } = true;
    public double Zoom { get; set; } = 1.0;
    public bool AutoCheckUpdates { get; set; } = true;
    public bool AutoInstallUpdates { get; set; }
    public bool GlobalMediaKeys { get; set; }
    public bool AskDownloadFolder { get; set; }
    public string DownloadFolder { get; set; }
    // Versión 1.0.1: la caché vieja tenía imágenes vacías guardadas por error; se borra una sola vez
    public bool ImageCacheFixed { get; set; }
    public bool StartMenuShortcut { get; set; }
    public bool DesktopShortcut { get; set; }

    // Notificaciones de Windows (actividad con el notificador liviano; mensajes con la app abierta)
    public bool Notifications { get; set; } = true;
    public bool NotifyBackground { get; set; } = true;
    public bool NotifyMessages { get; set; } = true;
    public bool NotifyLikes { get; set; } = true;
    public bool NotifyComments { get; set; } = true;
    public bool NotifyMentions { get; set; } = true;
    public bool NotifyFollowers { get; set; } = true;
    public bool NotifyOther { get; set; } = true;
    public bool NotifyUpdates { get; set; } = true;
    public int NotifyInterval { get; set; } = 2;

    // Abrir los enlaces de TikTok del navegador en Tokdesk (gestor de enlaces web de Windows)
    public bool LinkHandler { get; set; }

    public double? Left { get; set; }
    public double? Top { get; set; }
    public double? Width { get; set; }
    public double? Height { get; set; }
    public bool Maximized { get; set; }

    static readonly string File = Path.Combine(AppInfo.DataDir, "settings.json");
    static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public static AppSettings Load()
    {
        try
        {
            if (System.IO.File.Exists(File))
                return JsonSerializer.Deserialize<AppSettings>(System.IO.File.ReadAllText(File)) ?? new();
        }
        catch (Exception ex) { Log.Write("Ajustes ilegibles: " + ex.Message); }
        return new();
    }

    public void Save()
    {
        try { System.IO.File.WriteAllText(File, JsonSerializer.Serialize(this, Json)); }
        catch (Exception ex) { Log.Write("No se pudieron guardar los ajustes: " + ex.Message); }
    }

    // Campos que esta versión no conoce (de una más nueva): se conservan al guardar en vez de perderse
    [System.Text.Json.Serialization.JsonExtensionData]
    public Dictionary<string, JsonElement> Extra { get; set; }

    static string StartMenuLnk => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Tokdesk.lnk");
    static string DesktopLnk => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Tokdesk.lnk");

    /// <summary>
    /// Crea o borra los accesos directos del menú Inicio y del escritorio. Al abrir la app
    /// (<paramref name="startup"/>) nunca borra: si el acceso existe pero la opción figura apagada
    /// (una versión vieja guardó los ajustes sin conocerla), se adopta. Devuelve true si cambió algo.
    /// </summary>
    public bool ApplyShortcuts(bool startup = false)
    {
        // La build de desarrollo no crea accesos: quedarían apuntando a su .exe en vez del lanzador
        if (!AppInfo.HasLauncher) return false;
        var changed = false;
        if (startup && !StartMenuShortcut && System.IO.File.Exists(StartMenuLnk)) { StartMenuShortcut = true; changed = true; }
        if (startup && !DesktopShortcut && System.IO.File.Exists(DesktopLnk)) { DesktopShortcut = true; changed = true; }
        Shortcut(StartMenuLnk, StartMenuShortcut);
        Shortcut(DesktopLnk, DesktopShortcut);
        return changed;
    }

    static void Shortcut(string lnk, bool create)
    {
        try
        {
            if (!create) { if (System.IO.File.Exists(lnk)) System.IO.File.Delete(lnk); return; }
            // WScript.Shell viene con Windows y es la forma más simple de crear un .lnk
            var shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")!);
            dynamic sc = ((dynamic)shell).CreateShortcut(lnk);
            sc.TargetPath = AppInfo.StartPath;
            sc.WorkingDirectory = Path.GetDirectoryName(AppInfo.StartPath);
            sc.IconLocation = AppInfo.StartPath + ",0";
            sc.Description = "Tokdesk";
            sc.Save();
        }
        catch (Exception ex) { Log.Write("Acceso directo falló: " + ex.Message); }
    }
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    /// <summary>Registra (o quita) la app del inicio de Windows del usuario actual.</summary>
    public void ApplyStartup()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, true);
            if (key == null) return;
            if (StartWithWindows) key.SetValue("Tokdesk", $"\"{AppInfo.StartPath}\" --autostart");
            else key.DeleteValue("Tokdesk", false);
        }
        catch (Exception ex) { Log.Write("Inicio con Windows falló: " + ex.Message); }
    }
}
