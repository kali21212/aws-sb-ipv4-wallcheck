# Optional non-admin autorun fallback for interactive Windows login.
# Task Scheduler event triggers handle power resume when installed separately.
param([ValidateSet('Install','Verify','Remove')][string]$Mode='Verify')
$ErrorActionPreference='Stop'
$d=$PSScriptRoot
$guard=Join-Path $d 'Guard-WallCheck.ps1'
$ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$startup=[Environment]::GetFolderPath('Startup')
$link=Join-Path $startup 'WallCheck-Guardian.lnk'
$expected='-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$guard+'"'
if(-not (Test-Path $guard)){throw 'WallCheck Guardian executable script not found'}
$wsh=New-Object -ComObject WScript.Shell
if($Mode -eq 'Install'){
    if(Test-Path -LiteralPath $link){
        $old=$wsh.CreateShortcut($link)
        if($old.TargetPath -ne $ps -or $old.Arguments -ne $expected){
            throw 'Existing startup shortcut points elsewhere; refusing to overwrite'
        }
    }else{
        $shortcut=$wsh.CreateShortcut($link)
        $shortcut.TargetPath=$ps
        $shortcut.Arguments=$expected
        $shortcut.WorkingDirectory=$d
        $shortcut.WindowStyle=7
        $shortcut.Description='WallCheck guardian startup fallback (single-instance)'
        $shortcut.Save()
    }
}
if($Mode -eq 'Remove'){
    if(Test-Path -LiteralPath $link){
        $old=$wsh.CreateShortcut($link)
        if($old.TargetPath -ne $ps -or $old.Arguments -ne $expected){
            throw 'Shortcut no longer owned by this WallCheck installation'
        }
        Remove-Item -LiteralPath $link -Force
    }
}
$exists=Test-Path -LiteralPath $link
$valid=$false
if($exists){
    $shortcut=$wsh.CreateShortcut($link)
    $valid=($shortcut.TargetPath -eq $ps -and
        $shortcut.Arguments -eq $expected)
}
Write-Output ('USER_STARTUP_SHORTCUT='+$exists)
Write-Output ('SHORTCUT_TARGET_VALID='+$valid)
Write-Output ('GUARDIAN_SOURCE_PRESENT='+(Test-Path $guard))
if($Mode -eq 'Install' -and -not $valid){throw 'Startup link readback failed'}
