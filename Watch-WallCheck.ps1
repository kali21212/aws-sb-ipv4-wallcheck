$ErrorActionPreference='Stop'
$base=$PSScriptRoot
$exe=Join-Path $base 'WallCheck-Agent.exe'
$logs=Join-Path $base 'logs'
$paused=Join-Path $logs 'paused.flag'
$healthUrl='http://127.0.0.1:17654/healthz'
$expected='wallcheck-portable-v1.6.1'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$logFile=Join-Path $logs 'watchdog-events.jsonl'
$stateFile=Join-Path $logs 'watchdog-health.json'
function Write-State([string]$state,[string]$detail){
    try {
        $entry=@{time=(Get-Date).ToString('o');state=$state;detail=$detail}
        $json=ConvertTo-Json $entry -Compress
        [System.IO.File]::WriteAllText($stateFile,$json,(New-Object System.Text.UTF8Encoding($false)))
    } catch {}
}
function Write-Event([string]$kind,[string]$detail){
    try {
        if((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 2097152){
            Move-Item -LiteralPath $logFile -Destination ($logFile+'.previous') -Force
        }
        $entry=@{time=(Get-Date).ToString('o');event=$kind;detail=$detail}
        $line=ConvertTo-Json $entry -Compress
        [System.IO.File]::AppendAllText($logFile,$line+[char]13+[char]10,(New-Object System.Text.UTF8Encoding($false)))
    } catch {}
}
function Show-FaultBalloon([string]$state,[string]$detail){
    $stampFile=Join-Path $logs 'watchdog-notification.json'
    try {
        if(Test-Path -LiteralPath $stampFile){
            $last=Get-Content -LiteralPath $stampFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $seconds=([DateTimeOffset]::Now-[DateTimeOffset]::Parse($last.time)).TotalSeconds
            if($seconds -ge 0 -and $seconds -lt 3600){return}
        }
        $notifier=Join-Path $base 'notifier\WallCheck.exe'
        if(-not (Test-Path -LiteralPath $notifier)){
            Write-Event 'NOTIFY_UNAVAILABLE' 'dedicated WallCheck notifier executable missing'
            return
        }
        $cleanDetail=$detail.Replace('"','')
        $argsLine=$state+' "'+$cleanDetail+'"'
        $process=Start-Process -FilePath $notifier -ArgumentList $argsLine -WindowStyle Hidden -PassThru -Wait -ErrorAction Stop
        if($process.ExitCode -ne 0){
            throw ('WallCheck notifier exit code '+$process.ExitCode)
        }
        $json=ConvertTo-Json @{time=(Get-Date).ToString('o');state=$state;detail=$detail} -Compress
        [System.IO.File]::WriteAllText($stampFile,$json,(New-Object System.Text.UTF8Encoding($false)))
        Write-Event 'NOTIFY_ATTEMPTED' $state
    } catch {
        Write-Event 'NOTIFY_UNAVAILABLE' $_.Exception.Message
    }
}
$mutex=New-Object System.Threading.Mutex($false,'Local\Charlie_WallCheck_Watchdog_V17')
$locked=$false
try {
    $locked=$mutex.WaitOne(0)
    if(-not $locked){exit 0}
    if(Test-Path -LiteralPath $paused){Write-State 'PAUSED' 'manually stopped';exit 0}
    try {
        $h=Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        if($h.ok -and $h.agent -eq $expected){
            Write-State 'OK' 'agent available'
            exit 0
        }
    }catch{}
    Write-Event 'MISSING' 'health probe unavailable'
    $occupied=Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 17654 -State Listen -ErrorAction SilentlyContinue
    if($occupied){
        Write-State 'BLOCKED' ('port occupied; pid='+$occupied.OwningProcess)
        Write-Event 'BLOCKED' ('port occupied; pid='+$occupied.OwningProcess)
        Show-FaultBalloon 'BLOCKED' 'WallCheck 检测端口被其他进程占用，未能启动。'
        exit 2
    }
    if(-not (Test-Path -LiteralPath $exe)){
        Write-State 'ERROR' 'agent executable missing'
        Write-Event 'ERROR' 'agent executable missing'
        Show-FaultBalloon 'ERROR' 'WallCheck 检测程序文件缺失，请检查安装目录。'
        exit 3
    }
    Start-Process -FilePath $exe -ArgumentList '--listen','127.0.0.1:17654','--node','local' -WindowStyle Hidden | Out-Null
    for($i=0;$i -lt 16;$i++){
        Start-Sleep -Milliseconds 500
        try{
            $h=Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
            if($h.ok -and $h.agent -eq $expected){
                Write-State 'RECOVERED' 'agent restarted and health checked'
                Write-Event 'RECOVERED' 'agent restarted successfully'
                Show-FaultBalloon 'RECOVERED' '检测服务曾停止，本机巡检已自动重新启动并验证恢复。'
                exit 0
            }
        }catch{}
    }
    Write-State 'ERROR' 'agent failed to become healthy within 8 sec'
    Write-Event 'ERROR' 'startup timeout'
    Show-FaultBalloon 'ERROR' 'WallCheck 检测服务启动超时，当前无法正常检测 IP。'
    exit 4
} catch {
    Write-State 'ERROR' $_.Exception.Message
    Write-Event 'ERROR' $_.Exception.Message
    Show-FaultBalloon 'ERROR' 'WallCheck 巡检遇到异常，请检查本地日志。'
    exit 5
} finally {
    if($locked){$mutex.ReleaseMutex()}
    $mutex.Dispose()
}
