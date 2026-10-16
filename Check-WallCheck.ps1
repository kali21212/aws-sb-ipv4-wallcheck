$ErrorActionPreference='SilentlyContinue'
$root=$PSScriptRoot
if(Test-Path -LiteralPath (Join-Path $root 'logs\paused.flag')){
 Write-Host 'WallCheck: PAUSED by user';exit 2
}
try{
 $h=Invoke-RestMethod 'http://127.0.0.1:17654/healthz' -TimeoutSec 2
 if(-not ($h.ok -and $h.agent -eq 'wallcheck-portable-v1.6.1')){throw 'health not expected'}
 Write-Host 'WallCheck: AGENT_RUNNING'
 $f=Join-Path $root 'logs\watchdog-health.json'
 if(-not (Test-Path $f)){Write-Host 'Watchdog: NO_HEARTBEAT';exit 2}
 $w=Get-Content -LiteralPath $f -Raw -Encoding UTF8|ConvertFrom-Json
 $age=([DateTimeOffset]::Now-[DateTimeOffset]::Parse($w.time)).TotalSeconds
 if($age -gt 150){Write-Host ('Watchdog: STALE '+[int]$age+' seconds');exit 2}
 Write-Host ('Watchdog: '+$w.state+' at '+$w.time)
 exit 0
}catch{Write-Host ('WallCheck: AGENT_OFFLINE '+$_.Exception.Message);exit 1}
