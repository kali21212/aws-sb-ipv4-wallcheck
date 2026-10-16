$ErrorActionPreference='Stop'
$base=$PSScriptRoot
$exe=Join-Path $base 'notifier\WallCheck.exe'
$interop=Join-Path $base 'notifier\ShortcutAppId.cs'
$appId='Charlie.WallCheck'
if(-not (Test-Path -LiteralPath $exe)){throw 'WallCheck notifier binary missing'}
if(-not (Test-Path -LiteralPath $interop)){throw 'WallCheck shortcut registration source missing'}
$dir=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$link=Join-Path $dir 'WallCheck.lnk'
$shell=New-Object -ComObject WScript.Shell
if(Test-Path -LiteralPath $link){
    $old=$shell.CreateShortcut($link)
    if($old.TargetPath -and $old.TargetPath -ne $exe){
        throw 'Existing WallCheck shortcut belongs to another application: refusing overwrite'
    }
}
$shortcut=$shell.CreateShortcut($link)
$shortcut.TargetPath=$exe
$shortcut.WorkingDirectory=Split-Path $exe
$shortcut.Description='WallCheck 本地检测提醒'
$shortcut.IconLocation=$exe+',0'
$shortcut.Save()
Add-Type -Path $interop -ErrorAction Stop
[WallCheckShortcutAppId]::SetAppId($link,$appId)
$folder=(New-Object -ComObject Shell.Application).NameSpace($dir)
$item=$folder.ParseName('WallCheck.lnk')
$actual=[string]$item.ExtendedProperty('System.AppUserModel.ID')
if($actual -ne $appId){throw ('AppUserModelID verification failed: '+$actual)}
Write-Host ('WallCheck notifier registered: '+$actual)
