$ErrorActionPreference = 'Stop'
$base = $PSScriptRoot
$exe = Join-Path $base 'WallCheck-Agent.exe'
$healthUrl = 'http://127.0.0.1:17654/healthz'

if (-not (Test-Path $exe)) {
    Write-Host 'ERROR: WallCheck-Agent.exe not found.' -ForegroundColor Red
    exit 1
}

try {
    $h = Invoke-RestMethod $healthUrl -TimeoutSec 1
    if ($h.ok -and $h.agent -eq 'wallcheck-portable-v1.6') {
        Write-Host 'WallCheck already running.' -ForegroundColor Green
        Write-Host ($h | ConvertTo-Json -Compress)
        exit 0
    }
} catch {}

$listener = Get-NetTCPConnection -LocalPort 17654 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    Write-Host 'ERROR: TCP port 17654 is occupied by another process.' -ForegroundColor Red
    Write-Host ('PID: ' + $listener.OwningProcess)
    exit 2
}

Start-Process -FilePath $exe -ArgumentList @(
    '--listen', '127.0.0.1:17654',
    '--node', 'local'
) -WindowStyle Hidden

for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $h = Invoke-RestMethod $healthUrl -TimeoutSec 1
        if ($h.ok -and $h.agent -eq 'wallcheck-portable-v1.6') {
            Write-Host 'WallCheck started successfully.' -ForegroundColor Green
            Write-Host ($h | ConvertTo-Json -Compress)
            exit 0
        }
    } catch {}
}

Write-Host 'ERROR: WallCheck did not become healthy within 10 seconds.' -ForegroundColor Red
exit 3
