$ErrorActionPreference = 'SilentlyContinue'
$healthUrl = 'http://127.0.0.1:17654/healthz'

$owned = $false
try {
    $h = Invoke-RestMethod $healthUrl -TimeoutSec 1
    if ($h.ok -and $h.agent -eq 'wallcheck-portable-v1.6') {
        $owned = $true
    }
} catch {}

$listener = Get-NetTCPConnection -LocalPort 17654 -State Listen -ErrorAction SilentlyContinue
if (-not $listener) {
    Write-Host 'WallCheck is not running.'
    exit 0
}

if (-not $owned) {
    Write-Host 'Port 17654 is in use, but it is not confirmed as WallCheck Portable. Nothing was stopped.' -ForegroundColor Yellow
    Write-Host ('PID: ' + $listener.OwningProcess)
    exit 2
}

Stop-Process -Id $listener.OwningProcess -Force
Start-Sleep -Milliseconds 300
Write-Host 'WallCheck stopped.' -ForegroundColor Green
