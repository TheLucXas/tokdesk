using System.Runtime.InteropServices;

namespace Tokdesk;

/// <summary>
/// El sonido sale de los procesos de WebView2, así que el mezclador de volumen de Windows los mostraba
/// como "Microsoft Edge WebView2". Esto busca esas sesiones de audio (las de procesos hijos de esta app)
/// y les pone el nombre y el ícono de Tokdesk.
/// </summary>
static class AudioSessions
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        int GetCount(out int count);
        int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
        int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
        int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        int GetCount(out int count);
        int GetSession(int index, out IAudioSessionControl2 session);
    }

    // IAudioSessionControl2 hereda de IAudioSessionControl: los métodos van en el orden de la vtable
    [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        int GetState(out int state);
        int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
        int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
        int GetGroupingParam(out Guid group);
        int SetGroupingParam(ref Guid group, ref Guid context);
        int RegisterAudioSessionNotification(IntPtr client);
        int UnregisterAudioSessionNotification(IntPtr client);
        int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetProcessId(out uint pid);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32
    {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    /// <summary>Procesos descendientes de esta app (los de WebView2).</summary>
    static HashSet<uint> Descendants()
    {
        var parent = new Dictionary<uint, uint>();
        var snap = CreateToolhelp32Snapshot(0x2 /* TH32CS_SNAPPROCESS */, 0);
        try
        {
            var e = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32>() };
            for (var ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e))
                parent[e.th32ProcessID] = e.th32ParentProcessID;
        }
        finally { CloseHandle(snap); }

        var mine = new HashSet<uint> { (uint)Environment.ProcessId };
        for (var changed = true; changed;)
        {
            changed = false;
            foreach (var (pid, ppid) in parent)
                if (!mine.Contains(pid) && mine.Contains(ppid)) { mine.Add(pid); changed = true; }
        }
        return mine;
    }

    static readonly Guid Ctx = Guid.Empty;

    /// <summary>Pone nombre e ícono a las sesiones de audio de la app en todos los dispositivos de salida.</summary>
    public static void Label(string name, string iconPath)
    {
        try
        {
            var mine = Descendants();
            var devices = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            devices.EnumAudioEndpoints(0 /* eRender */, 1 /* DEVICE_STATE_ACTIVE */, out var list);
            list.GetCount(out var n);
            var iid = typeof(IAudioSessionManager2).GUID;
            for (var d = 0; d < n; d++)
            {
                list.Item(d, out var dev);
                dev.Activate(ref iid, 0x17 /* CLSCTX_ALL */, IntPtr.Zero, out var o);
                ((IAudioSessionManager2)o).GetSessionEnumerator(out var sessions);
                sessions.GetCount(out var count);
                for (var i = 0; i < count; i++)
                {
                    sessions.GetSession(i, out var s);
                    var hr = s.GetProcessId(out var pid);
                    if (hr != 0 || !mine.Contains(pid)) continue;
                    s.GetDisplayName(out var current);
                    if (current == name) continue;
                    var ctx = Ctx;
                    s.SetDisplayName(name, ref ctx);
                    s.SetIconPath(iconPath, ref ctx);
                    Log.Write($"Mezclador: sesión de audio {pid} renombrada");
                }
            }
        }
        catch (Exception ex) { Log.Write("Mezclador de volumen: " + ex.Message); }
    }
}
