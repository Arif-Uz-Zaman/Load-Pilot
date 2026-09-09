; LoadPilot AGENT installer (Inno Setup)
; Installs the agent on a worker PC. Asks for the controller URL, an agent name,
; and how MANY agents to run on this PC (a powerful PC can host several to
; generate more load). Each agent auto-starts at logon via its own Startup
; shortcut with a distinct --name. No scheduled task / SYSTEM persistence, so it
; doesn't trip antivirus behavioral heuristics.

#define AppName "LoadPilot Agent"
#define AppExe "loadpilot-agent.exe"

[Setup]
AppId={{9F2C7A10-4E6B-4E2A-9C3D-LOADPILOTAGENT}}
AppName={#AppName}
AppVersion=1.1.0
AppPublisher=OnnoRokom
DefaultDirName={autopf}\LoadPilotAgent
DisableProgramGroupPage=yes
DisableDirPage=no
OutputDir=dist
OutputBaseFilename=LoadPilot-Agent-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "Start automatically when I log in (recommended)"; GroupDescription: "Auto-start:"

[Files]
Source: "..\agent\dist\loadpilot-agent.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\agent\uninstall-agent.bat"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Remove LoadPilot Agent auto-start"; Filename: "{app}\uninstall-agent.bat"; Comment: "Stop the agent and remove it from startup (run as admin if it used the old scheduled task)"

[Code]
var
  CfgPage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  CfgPage := CreateInputQueryPage(wpSelectDir,
    'LoadPilot agent setup',
    'Controller address and agent name',
    'Enter the controller address (shown on the controller PC, e.g. http://192.168.2.156:4000).' + #13#10 +
    'Agent name identifies this PC in the controller. To run SEVERAL agents on this' + #13#10 +
    'one PC (for more load), set the count above 1 — they will be named NAME, NAME-2, ...');
  CfgPage.Add('Controller URL:', False);
  CfgPage.Add('Agent name:', False);
  CfgPage.Add('How many agents on this PC (1-8):', False);
  CfgPage.Values[0] := 'http://';
  CfgPage.Values[1] := GetComputerNameString();
  CfgPage.Values[2] := '1';
end;

function GetUrl(): String;
begin
  Result := Trim(CfgPage.Values[0]);
  if (Result = '') or (Result = 'http://') then
    Result := ExpandConstant('{param:CONTROLLERURL|http://localhost:4000}');
end;

function GetName(): String;
begin
  Result := Trim(CfgPage.Values[1]);
  if Result = '' then Result := ExpandConstant('{param:AGENTNAME|' + GetComputerNameString() + '}');
end;

function GetCount(): Integer;
var n: Integer;
begin
  n := StrToIntDef(Trim(CfgPage.Values[2]), 1);
  if n < 1 then n := 1;
  if n > 8 then n := 8;
  Result := n;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var u: String;
begin
  Result := True;
  if CurPageID = CfgPage.ID then
  begin
    u := Trim(CfgPage.Values[0]);
    if (Pos('http://', u) <> 1) and (Pos('https://', u) <> 1) then
    begin
      MsgBox('Please enter the controller URL starting with http:// (e.g. http://192.168.2.156:4000).', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

// Launch args for instance i (1-based): "URL --name NAME[-i] --no-stub".
function ArgsFor(i: Integer): String;
var nm: String;
begin
  nm := GetName();
  if i > 1 then nm := nm + '-' + IntToStr(i);
  Result := GetUrl() + ' --name ' + nm + ' --no-stub';
end;

// After install: for EACH instance create a Startup + Start-Menu shortcut and
// launch it now. The agent is windowless, so it appears in the Agents tab with
// no window to close. (A separate rc var — never the loop counter — receives
// Exec's result, or the loop would be corrupted.)
procedure CurStepChanged(CurStep: TSetupStep);
var
  i, count, rc: Integer;
  exe, nm: String;
begin
  if CurStep <> ssPostInstall then Exit;
  count := GetCount();
  exe := ExpandConstant('{app}\{#AppExe}');
  for i := 1 to count do
  begin
    nm := GetName();
    if i > 1 then nm := nm + '-' + IntToStr(i);
    CreateShellLink(ExpandConstant('{autoprograms}') + '\LoadPilot Agent ' + nm + '.lnk',
      'LoadPilot agent ' + nm, exe, ArgsFor(i), ExpandConstant('{app}'), '', 0, SW_SHOWNORMAL);
    if WizardIsTaskSelected('autostart') then
      CreateShellLink(ExpandConstant('{userstartup}') + '\LoadPilot Agent ' + nm + '.lnk',
        'LoadPilot agent ' + nm, exe, ArgsFor(i), ExpandConstant('{app}'), '', 0, SW_SHOWNORMAL);
    rc := 0;
    Exec(exe, ArgsFor(i), ExpandConstant('{app}'), SW_SHOWNORMAL, ewNoWait, rc);
  end;
end;

procedure CurUninstallStepChanged(CurStep: TUninstallStep);
var i, rc: Integer; base, nm: String;
begin
  if CurStep <> usUninstall then Exit;
  base := GetComputerNameString();
  for i := 1 to 8 do
  begin
    nm := base;
    if i > 1 then nm := nm + '-' + IntToStr(i);
    DeleteFile(ExpandConstant('{userstartup}') + '\LoadPilot Agent ' + nm + '.lnk');
    DeleteFile(ExpandConstant('{autoprograms}') + '\LoadPilot Agent ' + nm + '.lnk');
  end;
  // Also remove the OLD scheduled task from install-service.bat (if present),
  // and stop any running agent.
  Exec(ExpandConstant('{cmd}'), '/c schtasks /Delete /F /TN "LoadPilotAgent"', '', SW_HIDE, ewWaitUntilTerminated, rc);
  Exec(ExpandConstant('{cmd}'), '/c taskkill /F /IM loadpilot-agent.exe', '', SW_HIDE, ewWaitUntilTerminated, rc);
end;
