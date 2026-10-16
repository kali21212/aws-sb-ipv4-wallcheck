$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$source=Join-Path $repo 'Watch-WallCheck-Loop.ps1'
$pwsh=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$isolated=Join-Path $env:TEMP ('WallCheck-supervisor-smoke-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $isolated -Force | Out-Null
try {
    $script=Join-Path $isolated 'Watch-WallCheck-Loop.ps1'
    Copy-Item -LiteralPath $source -Destination $script -Force
    & $pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -Once | Out-Null
    if($LASTEXITCODE -ne 0){throw 'healthy once-test returned nonzero'}
    $status=Get-Content (Join-Path $isolated 'logs\watchdog-health.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if($status.state -ne 'OK'){throw ('expected OK, got '+$status.state)}
    Set-Content -Path (Join-Path $isolated 'logs\paused.flag') -Value 'test only' -Encoding ASCII
    & $pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -Once | Out-Null
    if($LASTEXITCODE -ne 0){throw 'paused once-test returned nonzero'}
    $status=Get-Content (Join-Path $isolated 'logs\watchdog-health.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if($status.state -ne 'PAUSED'){throw ('expected PAUSED, got '+$status.state)}
    Write-Output 'WATCHDOG_SMOKE_PASS OK->PAUSED; agent untouched'
} finally {
    Remove-Item -LiteralPath $isolated -Recurse -Force -ErrorAction SilentlyContinue
}
