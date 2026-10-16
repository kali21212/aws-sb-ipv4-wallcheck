$ErrorActionPreference='Continue'
$base=$PSScriptRoot
$watch=Join-Path $base 'Watch-WallCheck.ps1'
$logs=Join-Path $base 'logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$mutex=New-Object System.Threading.Mutex($false,'Local\Charlie_WallCheck_Supervisor_V17')
$locked=$false
try {
    $locked=$mutex.WaitOne(0)
    if(-not $locked){exit 0}
    while(-not (Test-Path -LiteralPath (Join-Path $logs 'watchdog-loop.stop'))){
        try{
            & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $watch | Out-Null
        }catch{
            $line=(Get-Date).ToString('o')+' SUPERVISOR_ERROR '+$_.Exception.Message
            Add-Content -LiteralPath (Join-Path $logs 'supervisor-errors.log') -Value $line -Encoding UTF8
        }
        Start-Sleep -Seconds 60
    }
} finally {
    if($locked){$mutex.ReleaseMutex()}
    $mutex.Dispose()
}
