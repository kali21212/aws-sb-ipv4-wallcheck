using System;
using System.Drawing;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("WallCheck")]
[assembly: AssemblyProduct("WallCheck")]
[assembly: AssemblyDescription("WallCheck local agent status notifier")]
[assembly: AssemblyCompany("Charlie")]
[assembly: AssemblyVersion("203.0.113.102")]
[assembly: AssemblyFileVersion("203.0.113.102")]

internal static class Program
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    [STAThread]
    private static int Main(string[] args)
    {
        if (args == null || args.Length != 2)
            return 2;
        string state = args[0] ?? "";
        if (state != "RECOVERED" && state != "BLOCKED" && state != "ERROR")
            return 3;
        string message = (args[1] ?? "").Trim();
        if (message.Length > 240)
            message = message.Substring(0, 240);
        if (message.Length == 0)
            return 4;

        try
        {
            if (SetCurrentProcessExplicitAppUserModelID("Charlie.WallCheck") < 0)
                return 6;
            using (NotifyIcon notice = new NotifyIcon())
            {
                notice.Icon = SystemIcons.Warning;
                notice.Text = "WallCheck";
                notice.Visible = true;
                notice.ShowBalloonTip(8000, "WallCheck 本地检测提醒",
                    message, state == "RECOVERED" ? ToolTipIcon.Info : ToolTipIcon.Warning);

                // Keep the independent WallCheck process alive long enough for the
                // desktop notification manager to consume the event.
                for (int i = 0; i < 40; i++)
                {
                    Application.DoEvents();
                    Thread.Sleep(75);
                }
                notice.Visible = false;
            }
            return 0;
        }
        catch
        {
            return 5;
        }
    }
}
