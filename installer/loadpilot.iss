; LoadPilot controller installer (Inno Setup)
; Builds LoadPilot-Setup.exe: a normal Windows wizard — pick install drive/folder,
; desktop + Start Menu icons, one-click launch afterwards.

#define AppName "LoadPilot"
#define AppVersion "1.0.0"
#define AppPublisher "OnnoRokom"
#define AppExe "loadpilot-controller.exe"

[Setup]
AppId={{9F2C7A10-4E6B-4E2A-9C3D-LOADPILOT001}}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
; User picks the drive + folder here (defaults to Program Files); the wizard's
; "Browse" lets them choose any drive, exactly like other installers.
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=LoadPilot-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
; Install per-user by default so no admin/UAC prompt is needed — anyone can
; install and run it. The wizard's Browse still lets them pick any drive/folder,
; and they can choose "all users" (admin) via the dialog if they prefer.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
; The controller app (self-contained exe — no Node/dependencies needed).
Source: "..\controller\dist\loadpilot-controller.exe"; DestDir: "{app}"; Flags: ignoreversion
; JMeter bundle agents download from the controller (and controller extracts for reports).
Source: "..\controller\bundles\jmeter.zip"; DestDir: "{app}\bundles"; Flags: ignoreversion
; JRE fallback for worker PCs without Java installed.
Source: "..\controller\bundles\jre.zip"; DestDir: "{app}\bundles"; Flags: ignoreversion
; The agent installer files, so admins can copy them out to worker PCs.
Source: "..\agent\dist\loadpilot-agent.exe"; DestDir: "{app}\agent"; Flags: ignoreversion
Source: "..\agent\uninstall-agent.bat"; DestDir: "{app}\agent"; Flags: ignoreversion
; One-double-click updater to roll the new agent out to a worker PC
; (keeps the existing agent name/count/URL from the previous install).
Source: "..\agent\update-agent.bat"; DestDir: "{app}\agent"; Flags: ignoreversion
Source: "..\agent\update-agent.ps1"; DestDir: "{app}\agent"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion isreadme

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; Comment: "Start the LoadPilot controller and open the web UI"
Name: "{group}\Agent files (for worker PCs)"; Filename: "{app}\agent"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon; Comment: "Start LoadPilot"

[Run]
; Offer to launch immediately after install (opens the console + browser UI).
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName} now"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Leave user data (data\, config.json) in place on uninstall; only remove what we shipped.
Type: filesandordirs; Name: "{app}\runtime"
