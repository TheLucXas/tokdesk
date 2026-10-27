using System.IO;
using System.Reflection;

namespace Tokdesk;

/// <summary>Rutas, versión y archivos incrustados de la aplicación.</summary>
static class AppInfo
{
    public static readonly string DataDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Tokdesk");

    public static string ExePath => Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "Tokdesk.exe");

    /// <summary>
    /// El .exe que abre el usuario: el lanzador si la app vino desde él (--launcher ruta), si no la propia app.
    /// Es el que se registra en el inicio de Windows y el que reemplaza el actualizador.
    /// </summary>
    public static string StartPath
    {
        get
        {
            var args = Environment.GetCommandLineArgs();
            var i = Array.IndexOf(args, "--launcher");
            return i >= 0 && i + 1 < args.Length && File.Exists(args[i + 1]) ? args[i + 1] : ExePath;
        }
    }

    public static Version Version => Assembly.GetExecutingAssembly().GetName().Version ?? new Version(1, 0, 0);

    public static string VersionText => $"{Version.Major}.{Version.Minor}.{Version.Build}";

    static AppInfo() => Directory.CreateDirectory(DataDir);

    /// <summary>
    /// Perfil del navegador (sesión de TikTok). Si existe el perfil viejo junto al .exe, se mueve
    /// a la carpeta de datos para no perder la sesión iniciada.
    /// </summary>
    public static string ProfileDir()
    {
        var target = Path.Combine(DataDir, "Perfil");
        var old = Path.Combine(AppContext.BaseDirectory, "Perfil");
        try
        {
            // Se copia (Move no funciona entre discos) y el viejo queda renombrado como respaldo
            if (Directory.Exists(old))
            {
                if (Directory.Exists(target)) Directory.Delete(target, true);
                CopyDir(old, target);
                Directory.Move(old, old + ".migrado");
            }
        }
        catch (Exception ex) { Log.Write("No se pudo mover el perfil: " + ex.Message); }
        return target;
    }

    static void CopyDir(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var f in Directory.GetFiles(from))
        {
            try { File.Copy(f, Path.Combine(to, Path.GetFileName(f)), true); } catch (IOException) { }
        }
        // La caché se regenera sola: no hace falta copiarla
        foreach (var d in Directory.GetDirectories(from))
            if (!Path.GetFileName(d).Contains("Cache", StringComparison.OrdinalIgnoreCase))
                CopyDir(d, Path.Combine(to, Path.GetFileName(d)));
    }

    /// <summary>
    /// Carpeta de la interfaz. En desarrollo se usa la carpeta "web" junto al .exe; en la versión
    /// de un solo archivo se extrae la copia incrustada (una vez por versión).
    /// </summary>
    public static string WebDir()
    {
        var dev = Path.Combine(AppContext.BaseDirectory, "web");
        if (File.Exists(Path.Combine(dev, "index.html"))) return dev;

        // Carpeta por compilación (no solo por versión), para no reutilizar la interfaz de otro build
        var build = Assembly.GetExecutingAssembly().ManifestModule.ModuleVersionId.ToString("N")[..8];
        var root = Path.Combine(DataDir, "web");
        var dir = Path.Combine(root, VersionText + "-" + build);
        try { foreach (var d in Directory.Exists(root) ? Directory.GetDirectories(root) : Array.Empty<string>()) if (d != dir) Directory.Delete(d, true); } catch { }
        if (File.Exists(Path.Combine(dir, "index.html"))) return dir;

        var asm = Assembly.GetExecutingAssembly();
        foreach (var name in asm.GetManifestResourceNames().Where(n => n.StartsWith("web/")))
        {
            var file = Path.Combine(dir, name[4..].Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            using var src = asm.GetManifestResourceStream(name)!;
            using var dst = File.Create(file);
            src.CopyTo(dst);
        }
        return dir;
    }

    /// <summary>Lee un recurso incrustado de texto (o null si no existe).</summary>
    public static string Resource(string name)
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        if (s == null) return null;
        using var r = new StreamReader(s);
        return r.ReadToEnd();
    }
}
