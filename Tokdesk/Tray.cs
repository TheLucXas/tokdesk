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

    public bool Visible { get => _icon.Visible; set => _icon.Visible = value; }

    public void Notify(string title, string text) => _icon.ShowBalloonTip(3000, title, text, WinForms.ToolTipIcon.None);

    public void Dispose()
    {
        _icon.Visible = false;
        _icon.Dispose();
    }
}
