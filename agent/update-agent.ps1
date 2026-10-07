# LoadPilot agent updater — updates this worker PC to the newest agent while
# PRESERVING the existing agent name(s), count, and controller URL from the
# previous install. Launched (elevated) by update-agent.bat.
#
# Detection order for the existing setup:
#   1. Scheduled tasks  "LoadPilotAgent*"        (--install / install-service.bat)
#   2. Startup shortcuts "LoadPilot Agent *.lnk"  (LoadPilot-Agent-Setup.exe wizard)
#   3. config.json next to the exe                (fallback for the name/url)
#   4. Prompt                                     (fresh PC, nothing found)

$ErrorActionPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here 'loadpilot-agent.exe'

function Done($msg, $color) { Write-Host ""; Write-Host $msg -ForegroundColor $color; Read-Host 'Press Enter to close' }
if (-not (Test-Path $exe)) { Done "ERROR: loadpilot-agent.exe not found next to this script ($here)." Red; exit 1 }

# ---------- detect the existing install ----------
$names = New-Object System.Collections.Generic.List[string]
$url = $null

# 1) scheduled tasks
Get-ScheduledTask | Where-Object { $_.TaskName -like 'LoadPilotAgent*' } | ForEach-Object {
  $a = ($_.Actions | Select-Object -First 1).Arguments
  if ($a -match '--name\s+("([^"]+)"|(\S+))') { $names.Add(($Matches[2] + $Matches[3])) }
  if (-not $url -and $a -match '(https?://[^\s"]+)') { $url = $Matches[1] }
}

# 2) startup shortcuts (wizard) — name is encoded in the filename
$startupDirs = @()
Get-ChildItem "$env:SystemDrive\Users" -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $startupDirs += (Join-Path $_.FullName 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup')
}
$startupDirs += (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Startup')
$wsh = New-Object -ComObject WScript.Shell
foreach ($d in $startupDirs) {
  Get-ChildItem (Join-Path $d 'LoadPilot Agent *.lnk') -ErrorAction SilentlyContinue | ForEach-Object {
    $nm = $_.BaseName -replace '^LoadPilot Agent ', ''
    if ($nm) { $names.Add($nm) }
    if (-not $url) { try { $ar = $wsh.CreateShortcut($_.FullName).Arguments; if ($ar -match '(https?://[^\s"]+)') { $url = $Matches[1] } } catch {} }
  }
}

# keep first-seen order, drop duplicates — and KEEP it a list: `Select-Object
# -Unique` would turn one name into a plain string ($names[0] = its first
# letter) and zero names into $null (no task would be registered at all).
$uniq = New-Object System.Collections.Generic.List[string]
foreach ($n in $names) { if ($n -and -not $uniq.Contains($n)) { $uniq.Add($n) } }
$names = $uniq

# 3) fall back to config.json for name + url
$cfgFile = Join-Path $here 'config.json'
if (Test-Path $cfgFile) {
  try {
    $cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json
    if ($names.Count -eq 0 -and $cfg.name) { $names.Add($cfg.name) }
    if (-not $url -and $cfg.controller) { $url = $cfg.controller }
  } catch {}
}

# 4) nothing detected → prompt (fresh PC)
$detected = $names.Count -gt 0
if (-not $detected) {
  $base = Read-Host "Agent name [$env:COMPUTERNAME]"; if (-not $base) { $base = $env:COMPUTERNAME }
  $cntIn = Read-Host "How many agents on this PC [1]"; $cnt = 1; if ($cntIn) { [int]::TryParse($cntIn, [ref]$cnt) | Out-Null; if ($cnt -lt 1) { $cnt = 1 } }
  for ($i = 1; $i -le $cnt; $i++) { if ($i -eq 1) { $names.Add($base) } else { $names.Add("$base-$i") } }
}
if (-not $url) { $url = Read-Host "Controller URL [http://192.168.2.156:4000]"; if (-not $url) { $url = 'http://192.168.2.156:4000' } }
$url = $url.TrimEnd('/')

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "  LoadPilot agent updater"
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ("  detected     : {0}" -f $(if ($detected) { 'yes — keeping existing name(s) & count' } else { 'no — new setup' }))
Write-Host ("  controller   : {0}" -f $url)
Write-Host ("  agent(s)     : {0}" -f ($names -join ', '))
Write-Host ""

# ---------- stop & remove the old install ----------
Write-Host "Stopping and removing the old agent..."
Get-ScheduledTask | Where-Object { $_.TaskName -like 'LoadPilotAgent*' } | ForEach-Object {
  Stop-ScheduledTask -TaskName $_.TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false -ErrorAction SilentlyContinue
}
Stop-Process -Name loadpilot-agent -Force -ErrorAction SilentlyContinue
foreach ($d in $startupDirs) { Get-ChildItem (Join-Path $d 'LoadPilot Agent *.lnk') -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# ---------- firewall (control endpoint for discovery / redirect) ----------
Write-Host "Opening firewall port 4101..."
netsh advfirewall firewall delete rule name="LoadPilot Agent Control" | Out-Null
netsh advfirewall firewall add rule name="LoadPilot Agent Control" dir=in action=allow protocol=TCP localport=4101 | Out-Null

# ---------- install the new agent (one SYSTEM boot task per name) ----------
Write-Host "Installing the new agent..."
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
# Windows' task defaults would stop the agent after 3 days, never start it on a
# laptop running on battery, and not restart it after a crash — override all three.
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$failed = 0
for ($i = 0; $i -lt $names.Count; $i++) {
  $nm = $names[$i]
  $tn = if ($i -eq 0) { 'LoadPilotAgent' } else { "LoadPilotAgent-$($i + 1)" }
  # structured Execute/Argument = no manual quoting of the exe path; the name is
  # quoted so "QA PC" stays one name
  $action = New-ScheduledTaskAction -Execute $exe -Argument "$url --name `"$nm`" --no-stub"
  try {
    Register-ScheduledTask -TaskName $tn -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $tn -ErrorAction SilentlyContinue
    Write-Host ("  - {0}" -f $nm) -ForegroundColor Green
  } catch {
    $failed++
    Write-Host ("  - {0}: FAILED ({1})" -f $nm, $_.Exception.Message) -ForegroundColor Red
  }
}

if ($failed -gt 0) { Done "$failed agent(s) could not be installed - see the messages above. Run update-agent.bat again as Administrator." Red; exit 1 }
Done "Done. This PC should reconnect in the controller's Agents tab shortly." Green
