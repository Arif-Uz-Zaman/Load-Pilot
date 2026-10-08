<#
  LoadPilot one-step build.

  Builds the controller and agent executables, then both installers:
    installer\dist\LoadPilot-Setup.exe        (controller PC)
    installer\dist\LoadPilot-Agent-Setup.exe  (worker PCs)

  Easiest: double-click build.bat in the same folder.
  Or:      powershell -ExecutionPolicy Bypass -File build.ps1 [-SkipNpmInstall] [-OpenFolder]

  Needs: Node.js 18+ and Inno Setup 6 (offers to install Inno Setup with winget
  if it is missing), plus an internet connection the first time (npm packages
  and the pkg Node base binary are downloaded once, then cached).
#>
param(
  [switch]$SkipNpmInstall,  # reuse the existing node_modules folders (faster, works offline)
  [switch]$OpenFolder       # open installer\dist when the build succeeds
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$started = Get-Date
$script:step = 0
$total = 6

# npx downloads the packaging tool (@yao-pkg/pkg) on first use and would stop
# to ask "Ok to proceed?" - answer yes so the build never hangs on a prompt.
$env:npm_config_yes = 'true'
$env:npm_config_fund = 'false'
$env:npm_config_audit = 'false'

function Step([string]$text) {
  $script:step++
  Write-Host ''
  Write-Host ('[{0}/{1}] {2}' -f $script:step, $total, $text) -ForegroundColor Cyan
}
function Ok([string]$text) { Write-Host "      OK  $text" -ForegroundColor Green }
function Fail([string]$text) {
  Write-Host ''
  Write-Host "BUILD FAILED: $text" -ForegroundColor Red
  exit 1
}

# Run a program in a folder and stop the whole build if it fails.
function Run([string]$dir, [string]$exe, [string[]]$argList, [string]$what) {
  Push-Location $dir
  try {
    & $exe @argList
    if ($LASTEXITCODE -ne 0) { Fail "$what (exit code $LASTEXITCODE). See the messages above." }
  } finally {
    Pop-Location
  }
}

function Find-Iscc {
  $candidates = @()
  if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe' }
  if (${env:ProgramFiles(x86)}) { $candidates += Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe' }
  if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe' }
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $keys = @(
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1'
  )
  foreach ($k in $keys) {
    $loc = (Get-ItemProperty $k -ErrorAction SilentlyContinue).InstallLocation
    if ($loc -and (Test-Path (Join-Path $loc 'ISCC.exe'))) { return (Join-Path $loc 'ISCC.exe') }
  }
  return $null
}

# Every file an installer script packs (its Source: lines), resolved from installer\.
function Get-IssSources([string]$iss) {
  $dir = Split-Path $iss -Parent
  foreach ($line in Get-Content $iss) {
    if ($line -match '^\s*Source:\s*"([^"]+)"') {
      [IO.Path]::GetFullPath((Join-Path $dir $Matches[1]))
    }
  }
}

$ctrlDir   = Join-Path $root 'controller'
$agentDir  = Join-Path $root 'agent'
$instDir   = Join-Path $root 'installer'
$ctrlExe   = Join-Path $ctrlDir 'dist\loadpilot-controller.exe'
$agentExe  = Join-Path $agentDir 'dist\loadpilot-agent.exe'
$ctrlIss   = Join-Path $instDir 'loadpilot.iss'
$agentIss  = Join-Path $instDir 'agent.iss'
$ctrlSetup  = Join-Path $instDir 'dist\LoadPilot-Setup.exe'
$agentSetup = Join-Path $instDir 'dist\LoadPilot-Agent-Setup.exe'

Write-Host 'LoadPilot build - executables and installers in one go' -ForegroundColor White
Write-Host "Folder: $root"

# ---------------------------------------------------------------------------
Step 'Checking what the build needs'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js is not installed. Install the LTS version from https://nodejs.org (18 or newer), then run this again.'
}
$nodeVer = (& node --version).Trim().TrimStart('v')
if ([int]($nodeVer.Split('.')[0]) -lt 18) { Fail "Node.js $nodeVer is too old - LoadPilot needs version 18 or newer." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm was not found (it comes with Node.js). Reinstall Node.js.' }
Ok "Node.js $nodeVer"

$iscc = Find-Iscc
if (-not $iscc) {
  Write-Host '      Inno Setup 6 (makes the installers) is not installed.' -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $answer = Read-Host '      Install it now with winget? (Y/N)'
    if ($answer -match '^(y|yes)$') {
      & winget install --id JRSoftware.InnoSetup -e --accept-source-agreements --accept-package-agreements
      $iscc = Find-Iscc
    }
  }
  if (-not $iscc) { Fail 'Inno Setup 6 is needed. Install it from https://jrsoftware.org/isdl.php (or: winget install JRSoftware.InnoSetup), then run this again.' }
}
Ok "Inno Setup: $iscc"

foreach ($iss in @($ctrlIss, $agentIss)) {
  if (-not (Test-Path $iss)) { Fail "$iss is missing." }
}
# Files the installers pack that this script does NOT build (bundles, scripts,
# README): check them now rather than after several minutes of building.
$missing = @()
foreach ($iss in @($ctrlIss, $agentIss)) {
  foreach ($src in Get-IssSources $iss) {
    if ($src -notmatch '\\dist\\' -and -not (Test-Path $src)) { $missing += $src }
  }
}
if ($missing.Count) {
  $list = ($missing | Sort-Object -Unique | ForEach-Object { "        $_" }) -join "`n"
  Fail "these files are needed by the installers but missing:`n$list`n      (controller\bundles\jmeter.zip and jre.zip are large downloads kept in the repository - check they are there.)"
}
Ok 'JMeter and JRE bundles, scripts and README are present'

# A program running from dist\ keeps its exe locked and the build could not replace it.
foreach ($exe in @($ctrlExe, $agentExe)) {
  if (Test-Path $exe) {
    try { $fs = [IO.File]::Open($exe, 'Open', 'ReadWrite', 'None'); $fs.Close() }
    catch { Fail "$exe is in use. Close the LoadPilot program that is running from that file, then run this again." }
  }
}
Ok 'No running program is holding the old executables'

# ---------------------------------------------------------------------------
function Build-Exe([string]$dir, [string]$name, [string]$exe) {
  if (-not $SkipNpmInstall) {
    $hasModules = Test-Path (Join-Path $dir 'node_modules')
    $hasLock = Test-Path (Join-Path $dir 'package-lock.json')
    if (-not $hasModules -and $hasLock) {
      Write-Host '      installing packages (npm ci)...'
      Run $dir 'npm.cmd' @('ci', '--no-audit', '--no-fund') "Installing the $name packages failed"
    } else {
      Write-Host '      checking packages (npm install)...'
      Run $dir 'npm.cmd' @('install', '--no-audit', '--no-fund') "Installing the $name packages failed"
    }
  }
  Write-Host '      packaging the exe (pkg)...'
  Run $dir 'npm.cmd' @('run', 'build') "Building the $name exe failed"
  if (-not (Test-Path $exe) -or (Get-Item $exe).LastWriteTime -lt $started) { Fail "$exe was not produced." }
  Ok ('{0}  ({1:N1} MB)' -f $exe, ((Get-Item $exe).Length / 1MB))
}

Step 'Building the controller (loadpilot-controller.exe)'
Build-Exe $ctrlDir 'controller' $ctrlExe

Step 'Building the agent (loadpilot-agent.exe)'
Build-Exe $agentDir 'agent' $agentExe

# ---------------------------------------------------------------------------
Step 'Making the controller installer (LoadPilot-Setup.exe)'
Run $instDir $iscc @('/Q', $ctrlIss) 'Making the controller installer failed'
Ok $ctrlSetup

Step 'Making the agent installer (LoadPilot-Agent-Setup.exe)'
Run $instDir $iscc @('/Q', $agentIss) 'Making the agent installer failed'
Ok $agentSetup

# ---------------------------------------------------------------------------
Step 'Checking the results'
foreach ($f in @($ctrlExe, $agentExe, $ctrlSetup, $agentSetup)) {
  if (-not (Test-Path $f)) { Fail "$f is missing." }
  if ((Get-Item $f).LastWriteTime -lt $started) { Fail "$f is from an earlier build - this build did not update it." }
}
$mins = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)

Write-Host ''
Write-Host "BUILD SUCCEEDED in $mins min" -ForegroundColor Green
Write-Host ''
Write-Host '  Ready to install:' -ForegroundColor White
Write-Host ('    {0}  ({1:N0} MB)  - run on the controller PC' -f $ctrlSetup, ((Get-Item $ctrlSetup).Length / 1MB))
Write-Host ('    {0}  ({1:N0} MB)  - run on each worker PC' -f $agentSetup, ((Get-Item $agentSetup).Length / 1MB))
Write-Host ''
Write-Host '  Worker PCs that already have an agent: copy agent\dist\loadpilot-agent.exe,'
Write-Host '  agent\update-agent.bat and agent\update-agent.ps1 to them and run update-agent.bat.'

if ($OpenFolder) { Start-Process explorer.exe (Join-Path $instDir 'dist') }
exit 0
