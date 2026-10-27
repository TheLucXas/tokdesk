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
        _single = new Mutex(true, "Tokdesk.SingleInstance", out var first);
        _showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, "Tokdesk.Show");
        if (!first && !e.Args.Contains("--updated"))
        {
            _showSignal.Set();
            Shutdown();
            return;
        }
        // Tras actualizar, espera a que se cierre la versión vieja
        if (!first) { try { _single.WaitOne(TimeSpan.FromSeconds(10)); } catch (AbandonedMutexException) { } }

        new Thread(() =>
        {
            while (_showSignal.WaitOne())
                Dispatcher.BeginInvoke(() => (MainWindow as MainWindow)?.ShowFromTray());
        }) { IsBackground = true }.Start();

        base.OnStartup(e);
        MainWindow = new MainWindow();
        MainWindow.Show();
    }
}
