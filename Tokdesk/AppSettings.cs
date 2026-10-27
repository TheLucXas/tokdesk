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
