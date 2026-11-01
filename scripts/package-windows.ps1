# Build the Windows release: dist\Samo (portable folder), a .zip and an Inno Setup installer.
#   pwsh scripts/package-windows.ps1 [-Version 0.1.0] [-NoBuild]
param([string]$Version = "", [switch]$NoBuild)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if ($Version -notmatch '^v?\d') { $Version = (Select-String -Path Cargo.toml -Pattern '^version = "(.*)"').Matches[0].Groups[1].Value }
$Version = $Version.TrimStart("v")
if (-not $env:CEF_PATH) { throw "CEF_PATH is not set" }
if (-not $NoBuild) { cargo build --release -p samo; if ($LASTEXITCODE) { throw "cargo build failed" } }

$cef = Get-ChildItem -Directory -Path $env:CEF_PATH -Recurse -Filter "cef_windows_x86_64" | Select-Object -First 1
if (-not $cef) { throw "CEF runtime not found under $env:CEF_PATH" }
$out = "dist\Samo"
if (Test-Path dist) { Remove-Item -Recurse -Force dist }
New-Item -ItemType Directory -Force $out | Out-Null

Copy-Item target\release\samo.exe $out
# CEF runtime: DLLs, resources, ICU/V8 data, locales. No headers, libs or sandbox bootstrap.
Get-ChildItem $cef.FullName -File | Where-Object { $_.Extension -in ".dll", ".pak", ".dat", ".bin", ".json" -and $_.Name -ne "archive.json" } |
  Copy-Item -Destination $out
Copy-Item (Join-Path $cef.FullName "CREDITS.html") (Join-Path $out "CEF-CREDITS.html") -ErrorAction SilentlyContinue
Copy-Item -Recurse (Join-Path $cef.FullName "locales") (Join-Path $out "locales")
Copy-Item -Recurse ui (Join-Path $out "ui")
Remove-Item -Recurse -Force (Join-Path $out "ui\dev"), (Join-Path $out "ui\pages\dev-mock.js")
Copy-Item LICENSE, README.md $out

$zip = "dist\Samo-$Version-windows-x64-portable.zip"
Compress-Archive -Path $out -DestinationPath $zip
Write-Host "Portable: $zip"

$iscc = (Get-Command iscc -ErrorAction SilentlyContinue).Source
if (-not $iscc) { $iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" }
& $iscc "/DAppVersion=$Version" "/DSourceDir=$(Resolve-Path $out)" "/DOutputDir=$(Resolve-Path dist)" packaging\windows\samo.iss
if ($LASTEXITCODE) { throw "Inno Setup failed" }
Get-ChildItem dist -File | Format-Table Name, Length
