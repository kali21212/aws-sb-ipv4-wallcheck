$ErrorActionPreference='Stop'
$base=$PSScriptRoot
$logs=Join-Path $base 'logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $logs 'paused.flag'), (Get-Date).ToString('o'))
$url='http://127.0.0.1:17654/healthz'
try{
    $h=Invoke-RestMethod $url -TimeoutSec 2
    if($h.agent -ne 'wallcheck-portable-v1.6.1'){ throw 'unexpected agent identity' }
}catch{
    Write-Host 'No confirmed local WallCheck listener; watchdog paused.'
    exit 0
}
$exe=(Resolve-Path (Join-Path $base 'WallCheck-Agent.exe')).Path
$found=@(Get-CimInstance Win32_Process -Filter "name='WallCheck-Agent.exe'" |
    Where-Object { $_.ExecutablePath -eq $exe })
foreach($item in ($found | Sort-Object -Property ParentProcessId -Descending)){
    Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Host 'WallCheck stopped. Watchdog paused until manual Start.' -ForegroundColor Green
