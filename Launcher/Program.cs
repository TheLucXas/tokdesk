using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace TokdeskLauncher;

static class Program
{
    const string RuntimeUrl = "https://aka.ms/dotnet/8.0/windowsdesktop-runtime-win-x64.exe";

    static readonly string DataDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Tokdesk");

    [STAThread]
    static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            if (!HasRuntime() && !InstallRuntime()) return 1;
            var app = ExtractApp();
            var self = Assembly.GetExecutingAssembly().Location;
            var argLine = string.Join(" ", args.Select(Quote).Concat(new[] { "--launcher", Quote(self) }));
            Process.Start(new ProcessStartInfo(app, argLine) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(app) });
            return 0;
        }
        catch (Exception ex)
        {
            MessageBox.Show("No se pudo iniciar Tokdesk:\n\n" + ex.Message, "Tokdesk", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    static string Quote(string a) => "\"" + a.Replace("\"", "\\\"") + "\"";

    // ---------- .NET 8 Desktop Runtime ----------

    static IEnumerable<string> DotnetRoots()
    {
        var env = Environment.GetEnvironmentVariable("DOTNET_ROOT");
        if (!string.IsNullOrEmpty(env)) yield return env;
        string reg = null;
        try
        {
            using var k = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry32)
                .OpenSubKey(@"SOFTWARE\dotnet\Setup\InstalledVersions\x64");
            reg = k?.GetValue("InstallLocation") as string;
        }
        catch { }
        if (!string.IsNullOrEmpty(reg)) yield return reg;
        yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "dotnet");
    }

    static bool HasRuntime()
    {
        foreach (var root in DotnetRoots())
        {
            var dir = Path.Combine(root, "shared", "Microsoft.WindowsDesktop.App");
            if (!Directory.Exists(dir)) continue;
            foreach (var d in Directory.GetDirectories(dir))
                if (Version.TryParse(Path.GetFileName(d).Split('-')[0], out var v) && v.Major >= 8) return true;
        }
        return false;
    }

    /// <summary>Avisa, descarga e instala el runtime con una ventana de progreso.</summary>
    static bool InstallRuntime()
    {
        var ask = MessageBox.Show(
            "Tokdesk necesita el componente gratuito de Microsoft «.NET 8 Desktop Runtime», que no está instalado.\n\n" +
            "Se va a descargar (unos 55 MB) e instalar automáticamente. Windows te pedirá permiso de administrador.\n\n¿Continuar?",
            "Tokdesk", MessageBoxButtons.OKCancel, MessageBoxIcon.Information);
        if (ask != DialogResult.OK) return false;

        var file = Path.Combine(Path.GetTempPath(), "windowsdesktop-runtime-8-x64.exe");
        using var form = new ProgressForm();
        Exception error = null;
        form.Shown += async (_, _) =>
        {
            try
            {
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)12288; // TLS 1.2 y 1.3
                using (var wc = new WebClient())
                {
                    wc.DownloadProgressChanged += (_, e) => form.SetProgress(e.ProgressPercentage, $"Descargando .NET 8… {e.ProgressPercentage}%");
                    await wc.DownloadFileTaskAsync(RuntimeUrl, file);
                }
                form.SetProgress(-1, "Instalando .NET 8… (puede tardar un minuto)");
                var p = Process.Start(new ProcessStartInfo(file, "/install /quiet /norestart") { UseShellExecute = true, Verb = "runas" });
                await System.Threading.Tasks.Task.Run(() => p.WaitForExit());
            }
            catch (Exception ex) { error = ex; }
            finally
            {
                try { File.Delete(file); } catch { }
                form.Close();
            }
        };
        Application.Run(form);

        if (HasRuntime()) return true;
        var msg = error is Win32Exception ? "La instalación se canceló." : "No se pudo instalar automáticamente" + (error != null ? ": " + error.Message : ".");
        if (MessageBox.Show(msg + "\n\n¿Abrir la página de descarga de Microsoft para instalarlo a mano?", "Tokdesk",
                MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
            Process.Start(new ProcessStartInfo("https://dotnet.microsoft.com/download/dotnet/8.0") { UseShellExecute = true });
        return false;
    }

    // ---------- App incrustada ----------

    /// <summary>Copia la app a la carpeta de datos si falta o si este lanzador trae otra versión.</summary>
    static string ExtractApp()
    {
        var dir = Path.Combine(DataDir, "app");
        Directory.CreateDirectory(dir);
        var exe = Path.Combine(dir, "Tokdesk.App.exe");
        var stamp = Path.Combine(dir, "version.txt");
        // Versión + identificador de compilación: cada lanzador nuevo reemplaza la app aunque la versión no cambie
        var version = Assembly.GetExecutingAssembly().GetName().Version + "-" + Assembly.GetExecutingAssembly().ManifestModule.ModuleVersionId.ToString("N");
        if (File.Exists(exe) && File.Exists(stamp) && File.ReadAllText(stamp).Trim() == version) return exe;

        var tmp = exe + ".tmp";
        using (var src = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.exe"))
        using (var dst = File.Create(tmp))
            src.CopyTo(dst);
        // Tras una actualización la versión vieja puede seguir cerrándose: se reintenta unos segundos
        for (var i = 0; ; i++)
        {
            try
            {
                if (File.Exists(exe)) File.Delete(exe);
                File.Move(tmp, exe);
                break;
            }
            catch (IOException) when (i < 40) { Thread.Sleep(250); }
            catch (UnauthorizedAccessException) when (i < 40) { Thread.Sleep(250); }
        }
        File.WriteAllText(stamp, version);
        return exe;
    }
}

sealed class ProgressForm : Form
{
    readonly Label _label = new() { Dock = DockStyle.Top, Height = 34, TextAlign = ContentAlignment.MiddleLeft, Text = "Preparando…" };
    readonly ProgressBar _bar = new() { Dock = DockStyle.Top, Height = 18, Maximum = 100 };

    public ProgressForm()
    {
        Text = "Tokdesk";
        Width = 420; Height = 130;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Padding = new Padding(14);
        ControlBox = false;
        try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }
        Controls.Add(_bar);
        Controls.Add(_label);
    }

    public void SetProgress(int percent, string text)
    {
        if (InvokeRequired) { BeginInvoke(new Action(() => SetProgress(percent, text))); return; }
        _label.Text = text;
        _bar.Style = percent < 0 ? ProgressBarStyle.Marquee : ProgressBarStyle.Blocks;
        if (percent >= 0) _bar.Value = Math.Min(100, percent);
    }
}
