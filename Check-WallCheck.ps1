$ErrorActionPreference = 'SilentlyContinue'
try {
    $h = Invoke-RestMethod 'http://127.0.0.1:17654/healthz' -TimeoutSec 2
    if ($h.ok -and $h.agent -eq 'wallcheck-portable-v1.6.1') {
        Write-Host 'WallCheck: RUNNING' -ForegroundColor Green
        Write-Host ($h | ConvertTo-Json -Compress)
        exit 0
    }
} catch {}

Write-Host 'WallCheck: NOT RUNNING' -ForegroundColor Yellow
exit 1
