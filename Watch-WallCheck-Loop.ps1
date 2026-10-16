param([switch]$Once)
$ErrorActionPreference='Continue'
$base=$PSScriptRoot
$watch=Join-Path $base 'Watch-WallCheck.ps1'
$logs=Join-Path $base 'logs'
$healthFile=Join-Path $logs 'watchdog-health.json'
$probeUrl='http://127.0.0.1:17654/healthz'
$expectedAgent='wallcheck-portable-v1.6.1'
New-Item -ItemType Directory -Path $logs -Force | Out-Null

function Write-Heartbeat([string]$state,[string]$detail) {
    try {
        $result=@{
            time=(Get-Date).ToString('o')
            state=$state
            detail=$detail
        } | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText(
            $healthFile,$result,
            (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        $line=(Get-Date).ToString('o')+' HEARTBEAT_WRITE_ERROR '+$_.Exception.Message
        Add-Content -LiteralPath (Join-Path $logs 'supervisor-errors.log') -Value $line -Encoding UTF8
    }
}

# Production uses a single durable supervisor. -Once tests use a different
# mutex and temporary folder; they never kill or replace the live agent.
$mutexName=if($Once){'Local\Charlie_WallCheck_Supervisor_Test_V17'}else{'Local\Charlie_WallCheck_Supervisor_V17'}
$mutex=New-Object System.Threading.Mutex($false,$mutexName)
$locked=$false
try {
    $locked=$mutex.WaitOne(0)
    if(-not $locked){exit 0}
    while(-not (Test-Path -LiteralPath (Join-Path $logs 'watchdog-loop.stop'))) {
        try {
            if(Test-Path -LiteralPath (Join-Path $logs 'paused.flag')) {
                Write-Heartbeat 'PAUSED' 'manually stopped'
            } else {
                $healthy=$false
                try {
                    $health=Invoke-RestMethod -Uri $probeUrl -TimeoutSec 2 -ErrorAction Stop
                    $healthy=($health.ok -and $health.agent -eq $expectedAgent)
                } catch {
                    $healthy=$false
                }
                if($healthy) {
                    # No process launch on the healthy path. Only a local
                    # health probe runs in the existing PowerShell host.
                    Write-Heartbeat 'OK' 'agent available'
                } else {
                    # Existing guarded restart, evidence log and notifier.
                    $powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
                    if(-not (Test-Path -LiteralPath $watch)) {
                        Write-Heartbeat 'ERROR' 'recovery script missing'
                    } else {
                        & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $watch | Out-Null
                        if($LASTEXITCODE -ne 0) {
                            $line=(Get-Date).ToString('o')+' RECOVERY_EXIT '+$LASTEXITCODE
                            Add-Content -LiteralPath (Join-Path $logs 'supervisor-errors.log') -Value $line -Encoding UTF8
                        }
                    }
                }
            }
        } catch {
            $line=(Get-Date).ToString('o')+' SUPERVISOR_ERROR '+$_.Exception.Message
            Add-Content -LiteralPath (Join-Path $logs 'supervisor-errors.log') -Value $line -Encoding UTF8
        }
        if($Once){break}
        Start-Sleep -Seconds 60
    }
} finally {
    if($locked){$mutex.ReleaseMutex()}
    $mutex.Dispose()
}
