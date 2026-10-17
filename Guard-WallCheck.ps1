# WallCheck Guardian 1.9.3: wake/login recovery, never forces a healthy agent.
$ErrorActionPreference='Stop'
$d=$PSScriptRoot
$logs=Join-Path $d 'logs'
$loop=Join-Path $d 'Watch-WallCheck-Loop.ps1'
$watch=Join-Path $d 'Watch-WallCheck.ps1'
$ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$healthUrl='http://127.0.0.1:17654/healthz'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$healthFile=Join-Path $logs 'guardian-health.json'
$mutex=New-Object System.Threading.Mutex($false,'Local\Charlie_WallCheck_Guardian_V193')
$locked=$false
function Write-GuardianState([string]$state,[string]$detail,[bool]$agentOk){
    $entry=@{
        time=(Get-Date).ToString('o')
        state=$state
        detail=$detail
        agentOk=$agentOk
    } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($healthFile,$entry,
        (New-Object System.Text.UTF8Encoding($false)))
}
function Test-LocalAgent(){
    try{
        $h=Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2 -ErrorAction Stop
        return [bool]($h.ok -and $h.agent -eq 'wallcheck-portable-v1.6.1')
    }catch{return $false}
}
function Test-FreshSupervisorHeartbeat(){
    $file=Join-Path $logs 'watchdog-health.json'
    try{
        $h=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
        $age=([DateTimeOffset]::Now-[DateTimeOffset]::Parse($h.time)).TotalSeconds
        return [bool]($age -ge -5 -and $age -le 150 -and
            $h.state -in @('OK','RECOVERED'))
    }catch{return $false}
}
try{
    $locked=$mutex.WaitOne(0)
    if(-not $locked){exit 0}
    if((Test-Path (Join-Path $logs 'paused.flag')) -or
       (Test-Path (Join-Path $logs 'watchdog-loop.stop'))){
        Write-GuardianState 'PAUSED' 'User stop marker; no automatic recovery' $false
        exit 0
    }
    if(-not (Test-Path -LiteralPath $loop)){throw 'Supervisor script is missing'}
    # Windows WMI sometimes hides CommandLine for a background PowerShell.
    # A fresh heartbeat plus an actual healthz reply are stronger evidence.
    $agentReady=Test-LocalAgent
    $supervisorReady=Test-FreshSupervisorHeartbeat
    if($agentReady -and $supervisorReady){
        Write-GuardianState 'OK' 'Fresh supervisor heartbeat and agent health verified' $true
        exit 0
    }
    $pattern='(?i)-File\s+"?'+[regex]::Escape($loop)+'(?:"|\s|$)'
    $running=@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
        Where-Object {$_.CommandLine -match $pattern})
    $supervisorStarted=$false
    if($running.Count -eq 0 -and -not $supervisorReady){
        $argsLine='-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$loop+'"'
        Start-Process -FilePath $ps -ArgumentList $argsLine -WindowStyle Hidden | Out-Null
        $supervisorStarted=$true
        for($n=0;$n -lt 16;$n++){
            if(Test-FreshSupervisorHeartbeat){$supervisorReady=$true;break}
            Start-Sleep -Milliseconds 500
        }
    }
    if(-not $supervisorReady){$supervisorReady=Test-FreshSupervisorHeartbeat}
    if($agentReady -and $supervisorReady){
        $state=if($supervisorStarted){'RECOVERED_SUPERVISOR'}else{'OK'}
        Write-GuardianState $state 'Supervisor heartbeat and agent health verified' $true
        exit 0
    }
    if(-not (Test-Path -LiteralPath $watch)){throw 'Recovery script is missing'}
    # A wake/resume task must not wait another 60 seconds for supervisor polling.
    # Existing watchdog mutex prevents two concurrent recovery runs.
    $argsLine='-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$watch+'"'
    $recovery=Start-Process -FilePath $ps -ArgumentList $argsLine -WindowStyle Hidden -PassThru -Wait
    for($i=0;$i -lt 18;$i++){
        if(Test-LocalAgent){
            $fresh=Test-FreshSupervisorHeartbeat
            if($fresh){
                Write-GuardianState 'RECOVERED_AGENT' ('Health and supervisor verified after wake; recovery exit '+$recovery.ExitCode) $true
                exit 0
            }
        }
        Start-Sleep -Milliseconds 500
    }
    Write-GuardianState 'AGENT_UNAVAILABLE' ('Still offline; recovery exit '+$recovery.ExitCode) $false
    exit 1
}catch{
    Write-GuardianState 'ERROR' $_.Exception.Message $false
    exit 1
}finally{
    if($locked){$mutex.ReleaseMutex()}
    $mutex.Dispose()
}
