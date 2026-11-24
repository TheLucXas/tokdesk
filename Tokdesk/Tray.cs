using System.IO;
using WinForms = System.Windows.Forms;

namespace Tokdesk;

/// <summary>Ícono en la bandeja del sistema (área de notificación) con su menú.</summary>
sealed class Tray : IDisposable
{
    readonly WinForms.NotifyIcon _icon;

    public Tray(Action open, Action checkUpdates, Action exit)
    {
        var menu = new WinForms.ContextMenuStrip();
        menu.Items.Add("Abrir Tokdesk", null, (_, _) => open());
        menu.Items.Add("Buscar actualizaciones", null, (_, _) => checkUpdates());
        menu.Items.Add(new WinForms.ToolStripSeparator());
        menu.Items.Add("Salir", null, (_, _) => exit());

        using var s = System.Windows.Application.GetResourceStream(new Uri("pack://application:,,,/app.ico"))?.Stream;
        _icon = new WinForms.NotifyIcon
        {
            Text = "Tokdesk",
            Icon = s != null ? new System.Drawing.Icon(s) : System.Drawing.SystemIcons.Application,
            ContextMenuStrip = menu,
            Visible = false,
        };
        _icon.MouseClick += (_, e) => { if (e.Button == WinForms.MouseButtons.Left) open(); };
        _icon.BalloonTipClicked += (_, _) => { Log.Write("Aviso de Windows: tocado"); var a = _onClick ?? open; _onClick = null; a(); };
        _icon.BalloonTipShown += (_, _) => Log.Write("Aviso de Windows: mostrado");
        _icon.BalloonTipClosed += (_, _) => Log.Write("Aviso de Windows: se cerró sin tocarlo");
    }

    bool _wanted;
    public bool Visible { get => _wanted; set { _wanted = value; _icon.Visible = value; } }

    // El aviso necesita el ícono visible: si estaba oculto se muestra un momento.
    // Al tocarlo se hace lo que pidió quien lo mostró (abrir un chat); sin eso, se abre la ventana
    Action _onClick;
    public void Notify(string title, string text, Action onClick = null)
    {
        _onClick = onClick;
        _icon.Visible = true;
        _icon.ShowBalloonTip(6000, title, text, WinForms.ToolTipIcon.None);
        // Mientras el aviso puede seguir en el centro de actividades, el ícono tiene que existir para recibir el clic
        if (!_wanted) Task.Delay(30000).ContinueWith(_ => System.Windows.Application.Current?.Dispatcher.Invoke(() => _icon.Visible = _wanted));
    }

    public void Dispose()
    {
        _icon.Visible = false;
        _icon.Dispose();
    }
}
