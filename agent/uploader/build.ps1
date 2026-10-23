# Сборка ZIP агента для раздачи через портал (страница «Агенты», админ).
# Запуск: .\build.ps1 -Version 0.1.0  → dist-zip\zewex-uploader-0.1.0.zip
param([Parameter(Mandatory = $true)][string]$Version)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
npm run build
if ($LASTEXITCODE -ne 0) { throw "build failed" }
(Get-Content src/protocol.ts) -replace 'AGENT_VERSION = "[^"]+"', "AGENT_VERSION = `"$Version`"" | Set-Content src/protocol.ts -Encoding utf8
(Get-Content dist/protocol.js) -replace 'AGENT_VERSION = "[^"]+"', "AGENT_VERSION = `"$Version`"" | Set-Content dist/protocol.js -Encoding utf8
$stage = "dist-zip\zewex-uploader"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item -Recurse dist "$stage\dist"
Copy-Item package.json, package-lock.json, README.md $stage
# Зависимости без dev: отдельная установка в папку сборки
Push-Location $stage
npm ci --omit=dev --ignore-scripts
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm ci (prod) failed" }
Pop-Location
@"
@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Нужен Node.js 22: https://nodejs.org & pause & exit /b 1)
node dist\index.js
pause
"@ | Set-Content "$stage\ZewexUploader.cmd" -Encoding ascii
$zip = "dist-zip\zewex-uploader-$Version.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path "$stage\*" -DestinationPath $zip
Write-Host "Готово: $zip"
