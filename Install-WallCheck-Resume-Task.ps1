# WallCheck 1.9.3: explicit user-approved TaskScheduler wake/unlock trigger install.
# No privilege elevation is performed by this script. Use an already elevated
# PowerShell, or explicitly approve normal Windows UAC when launching.
param([ValidateSet('Install','Verify')][string]$Mode='Verify')
$ErrorActionPreference='Stop'
$d=$PSScriptRoot
$guard=Join-Path $d 'Guard-WallCheck.ps1'
$taskName='Charlie-WallCheck-Guardian'
$eventId='WallCheck-PowerResume-V193'
$unlockId='WallCheck-SessionUnlock-V193'
$backupRoot=Join-Path $env:LOCALAPPDATA 'Charlie\WallCheck\backups'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($identity)
if(-not (Test-Path -LiteralPath $guard)){throw 'Guard-WallCheck.ps1 missing'}
$service=New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder=$service.GetFolder('\')
$task=$folder.GetTask($taskName)
$def=$task.Definition
$existingCommand=[string]$def.Actions.Item(1).Path
$existingArguments=[string]$def.Actions.Item(1).Arguments
if($existingCommand -notmatch '(?i)powershell\.exe$' -or
   $existingArguments -notlike ('*'+$guard+'*')){
    throw 'Existing Guardian action does not match this WallCheck installation'
}
$triggerIds=@()
for($i=1;$i -le $def.Triggers.Count;$i++){
    $triggerIds+=([string]$def.Triggers.Item($i).Id)
}
if($Mode -eq 'Install'){
    if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
        throw 'ADMIN_REQUIRED: User must approve Windows UAC to modify this task'
    }
    New-Item -ItemType Directory -Force -Path $backupRoot|Out-Null
    $originalXml=$task.Xml
    $originalPath=Join-Path $backupRoot ('Guardian-before-wake-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.xml')
    [IO.File]::WriteAllText($originalPath,$originalXml,(New-Object Text.UTF8Encoding($false)))
    if($triggerIds -notcontains $eventId){
        # TASK_TRIGGER_EVENT=0: System Power-Troubleshooter Event 1, resume.
        $evt=$def.Triggers.Create(0)
        $evt.Id=$eventId
        $evt.Enabled=$true
        $evt.Subscription='<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name="Microsoft-Windows-Power-Troubleshooter"] and (EventID=1)]]</Select></Query></QueryList>'
        $evt.Delay='PT3S'
    }
    if($triggerIds -notcontains $unlockId){
        # TASK_TRIGGER_SESSION_STATE_CHANGE=11, TASK_SESSION_UNLOCK=8.
        $unlock=$def.Triggers.Create(11)
        $unlock.Id=$unlockId
        $unlock.Enabled=$true
        $unlock.StateChange=8
        $unlock.UserId=$identity.Name
        $unlock.Delay='PT3S'
    }
    # This is the same interactive, limited-privilege per-user task.
    # Do NOT raise the task RunLevel, change password policy or boot credentials.
    $def.Principal.RunLevel=0
    $registered=$folder.RegisterTaskDefinition(
        $taskName,$def,6,$identity.Name,$null,3,$null)
    if(-not $registered){throw 'TaskScheduler register failed'}
    Write-Output ('TASK_XML_BACKUP='+$originalPath)
}
# Always obtain a fresh COM definition to verify persisted task settings.
$task=$folder.GetTask($taskName)
$def=$task.Definition
$triggerIds=@()
for($i=1;$i -le $def.Triggers.Count;$i++){
    $triggerIds+=([string]$def.Triggers.Item($i).Id)
}
$validWake=$triggerIds -contains $eventId
$validUnlock=$triggerIds -contains $unlockId
$validHeartbeat=[bool](Test-Path -LiteralPath (Join-Path $d 'Watch-WallCheck-Loop.ps1'))
$validLimited=([int]$def.Principal.RunLevel -eq 0)
Write-Output ('WAKE_TRIGGER='+$validWake)
Write-Output ('UNLOCK_TRIGGER='+$validUnlock)
Write-Output ('LIMITED_RUNLEVEL='+$validLimited)
Write-Output ('WATCHDOG_FILE='+$validHeartbeat)
Write-Output ('TRIGGERS='+($triggerIds -join ','))
if($Mode -eq 'Install' -and -not ($validWake -and $validUnlock -and $validLimited)){
    throw 'TASK_READBACK_FAILED - backup XML saved for controlled rollback'
}
