; Inno Setup script for Samo. Built by scripts/package-windows.ps1:
;   iscc /DAppVersion=0.1.0 /DSourceDir=dist\Samo /DOutputDir=dist packaging\windows\samo.iss
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\dist\Samo"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\dist"
#endif

[Setup]
AppId={{6E1F4C2A-5B7D-4E8A-9C3B-2F6D8A1E4B70}
AppName=Samo
AppVersion={#AppVersion}
AppVerName=Samo {#AppVersion}
AppPublisher=Sileyesi
AppPublisherURL=https://github.com/Sileyesi/samo
AppSupportURL=https://github.com/Sileyesi/samo/issues
DefaultDirName={autopf}\Samo
DefaultGroupName=Samo
DisableProgramGroupPage=yes
; Per-user install by default (no admin prompt); the user may choose all-users.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=Samo-{#AppVersion}-windows-x64-setup
SetupIconFile=..\icons\samo.ico
UninstallDisplayIcon={app}\samo.exe
LicenseFile=..\..\LICENSE
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "ukrainian"; MessagesFile: "compiler:Languages\Ukrainian.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Samo"; Filename: "{app}\samo.exe"
Name: "{group}\{cm:UninstallProgram,Samo}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Samo"; Filename: "{app}\samo.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\samo.exe"; Description: "{cm:LaunchProgram,Samo}"; Flags: nowait postinstall skipifsilent
