$ErrorActionPreference='Stop'
$taskName='Charlie-WallCheck-Watchdog'
$watch=Join-Path $PSScriptRoot 'Watch-WallCheck.ps1'
if(-not (Test-Path -LiteralPath $watch)){throw 'Watch-WallCheck.ps1 missing'}
$pwsh=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action=New-ScheduledTaskAction -Execute $pwsh -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$watch+'"')
$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$logon=New-ScheduledTaskTrigger -AtLogOn -User $user
$repeat=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon,$repeat) -Settings $settings -Description 'Keeps local AWS.SB IPv4 WallCheck on 127.0.0.1:17654 healthy and logs recoveries' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName,State
Get-ScheduledTaskInfo -TaskName $taskName | Select-Object LastRunTime,LastTaskResult,NextRunTime
