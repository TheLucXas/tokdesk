using System.Windows;

namespace Tokdesk;

public partial class App : Application
{
    Mutex _single;
    EventWaitHandle _showSignal;

    protected override void OnStartup(StartupEventArgs e)
    {
        DispatcherUnhandledException += (_, a) => { Log.Write("ERROR UI: " + a.Exception); a.Handled = true; };
        AppDomain.CurrentDomain.UnhandledException += (_, a) => Log.Write("ERROR: " + a.ExceptionObject);

        // Una sola instancia: si ya está abierta, se le pide que se muestre y esta se cierra
        // El modo de pruebas (TOKDESK_DUMP=1) usa su propia instancia para poder correr junto a la app normal
        var dev = Environment.GetEnvironmentVariable("TOKDESK_DUMP") == "1" ? ".Dev" : "";
        _single = new Mutex(true, "Tokdesk.SingleInstance" + dev, out var first);
        _showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, "Tokdesk.Show" + dev);
        // Un enlace de TikTok recibido (argumento o tokdesk://) se abre en la ventana, sea esta u otra instancia
        var link = Links.FromArgs(e.Args);
        if (!first && !e.Args.Contains("--updated"))
        {
            if (link != null) Links.SetPending(link);
            _showSignal.Set();
            Shutdown();
            return;
        }
        if (link != null) Links.SetPending(link);
        // Tras actualizar, espera a que se cierre la versión vieja
        if (!first) { try { _single.WaitOne(TimeSpan.FromSeconds(10)); } catch (AbandonedMutexException) { } }

        new Thread(() =>
        {
            while (_showSignal.WaitOne())
                Dispatcher.BeginInvoke(() => { (MainWindow as MainWindow)?.ShowFromTray(); (MainWindow as MainWindow)?.OpenPendingLink(); });
        }) { IsBackground = true }.Start();

        base.OnStartup(e);
        MainWindow = new MainWindow();
        MainWindow.Show();
    }
}
