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
    }

    bool _wanted;
    public bool Visible { get => _wanted; set { _wanted = value; _icon.Visible = value; } }

    // El aviso necesita el ícono visible: si estaba oculto se muestra un momento
    public void Notify(string title, string text)
    {
        _icon.Visible = true;
        _icon.ShowBalloonTip(6000, title, text, WinForms.ToolTipIcon.None);
        if (!_wanted) Task.Delay(10000).ContinueWith(_ => System.Windows.Application.Current?.Dispatcher.Invoke(() => _icon.Visible = _wanted));
    }

    public void Dispose()
    {
        _icon.Visible = false;
        _icon.Dispose();
    }
}
