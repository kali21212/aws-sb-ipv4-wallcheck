# WallCheck desktop notifier (local Windows component)

The user-scoped watchdog keeps checking the local WallCheck probe. To avoid labeling native notifications as "Windows PowerShell", recovery alerts are sent by a separate \`WallCheck.exe\` with Windows file description **WallCheck** and explicit AppUserModelID \`Charlie.WallCheck\`.

The source is \`WallCheck.cs\`. It uses WinForms \`NotifyIcon\`, contains no network or third-party dependencies, and accepts only the states \`RECOVERED\`, \`BLOCKED\`, and \`ERROR\`. The helper is not the probe agent.

## Build on Windows PowerShell 5.1

Run from the repository root with the .NET Framework C# compiler installed:

\`\`\`powershell
New-Item -ItemType Directory -Force notifier | Out-Null
Add-Type -Path .\notifier\WallCheck.cs -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly .\notifier\WallCheck.exe -OutputType WindowsApplication
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-WallCheck-Notifier.ps1
\`\`\`

The installer creates/verifies a per-user \`WallCheck.lnk\` shortcut in the Start Menu and sets its \`System.AppUserModel.ID\` property to \`Charlie.WallCheck\` via \`ShortcutAppId.cs\`. It must match the identity in \`WallCheck.cs\`. It does **not** modify global PowerShell policies or require administrative privileges.

The production bundle keeps the generated executable under \`notifier/WallCheck.exe\`, but the git repository tracks source code, not the executable.

The Windows toast/balloon may still be suppressed by Windows notification settings or Focus Assist. The watchdog logs attempts and errors; receipt in the notification center is separate from successful invocation. The browser extension's persistent in-page IP alerts are independent of this helper.

Reference: https://learn.microsoft.com/en-us/windows/win32/shell/enable-desktop-toast-with-appusermodelid
