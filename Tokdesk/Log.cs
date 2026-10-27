using System.IO;

namespace Tokdesk;

static class Log
{
    static readonly string File = Path.Combine(AppInfo.DataDir, "log.txt");
    static readonly object Gate = new();

    static Log()
    {
        try { System.IO.File.WriteAllText(File, ""); } catch { }
    }

    public static void Write(string msg)
    {
        lock (Gate)
        {
            try { System.IO.File.AppendAllText(File, $"{DateTime.Now:HH:mm:ss.fff} {msg}{Environment.NewLine}"); } catch { }
        }
    }
}
