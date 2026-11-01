using System.IO;

namespace Tokdesk;

static class Log
{
    // El modo de pruebas escribe en su propio registro, para no pisar el de la app normal
    static readonly string File = Path.Combine(AppInfo.DataDir,
        Environment.GetEnvironmentVariable("TOKDESK_DUMP") == "1" ? "log-pruebas.txt" : "log.txt");
    static readonly object Gate = new();
    const string CleanExit = "== Cierre normal ==";

    static Log()
    {
        // El registro de la vez anterior se guarda aparte (si se cerró de golpe, ahí está lo que pasó antes)
        try
        {
            var prev = Path.ChangeExtension(File, ".anterior.txt");
            bool crashed = false;
            if (System.IO.File.Exists(File))
            {
                var text = System.IO.File.ReadAllText(File);
                crashed = text.Length > 0 && !text.TrimEnd().EndsWith(CleanExit);
                System.IO.File.Copy(File, prev, true);
            }
            System.IO.File.WriteAllText(File, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} Tokdesk {AppInfo.VersionText}{Environment.NewLine}");
            if (crashed) Write("La vez anterior Tokdesk se cerró sin terminar bien (ver " + Path.GetFileName(prev) + ")");
        }
        catch { }
    }

    /// <summary>Marca que la app se cerró bien (si falta, la próxima vez se avisa en el registro).</summary>
    public static void Closed() => Write(CleanExit);

    public static void Write(string msg)
    {
        lock (Gate)
        {
            try { System.IO.File.AppendAllText(File, $"{DateTime.Now:HH:mm:ss.fff} {msg}{Environment.NewLine}"); } catch { }
        }
    }
}
