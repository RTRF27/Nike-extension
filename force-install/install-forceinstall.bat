@echo off
REM ============================================================
REM  SNKRS Bot - force-install the extension into EVERY Chrome profile
REM  (current and future) via Chrome enterprise policy.
REM
REM  This is the reliable replacement for --load-extension, which Chrome
REM  ignores when Chrome is already running and disables entirely in newer
REM  versions. A force-installed extension appears in all profiles
REM  automatically and cannot be turned off by the user.
REM
REM  RUN THIS AS ADMINISTRATOR (right-click -> Run as administrator).
REM ============================================================
setlocal enableextensions

set "EXT_ID=gkfbgibdipccnmamfeflgpahoehpbebf"

REM --- must be elevated (writes to HKLM) ---
net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo  ERROR: This script must be run as Administrator.
  echo  Right-click install-forceinstall.bat  ->  "Run as administrator".
  echo.
  pause
  exit /b 1
)

REM --- resolve repo root (parent of this force-install folder) ---
pushd "%~dp0.."
set "ROOT=%CD%"
popd

set "CRX=%ROOT%\snkrs-bot.crx"
set "UPDATEXML=%~dp0update.xml"

if not exist "%CRX%" (
  echo.
  echo  ERROR: %CRX% not found.
  echo  Pack it first:  node pack-crx.cjs   (or pull the repo which ships it^)
  echo.
  pause
  exit /b 1
)

REM --- read the version straight from manifest.json (keeps update.xml in sync) ---
set "VER=1.0"
for /f "delims=" %%v in ('node -e "process.stdout.write(require(process.argv[1]).version)" "%ROOT%\manifest.json"') do set "VER=%%v"

REM --- build file:/// URLs (Chrome wants forward slashes) ---
set "CRX_URL=file:///%CRX:\=/%"
set "XML_URL=file:///%UPDATEXML:\=/%"

REM --- generate the update manifest Chrome polls ---
> "%UPDATEXML%" echo ^<?xml version="1.0" encoding="UTF-8"?^>
>>"%UPDATEXML%" echo ^<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"^>
>>"%UPDATEXML%" echo   ^<app appid="%EXT_ID%"^>
>>"%UPDATEXML%" echo     ^<updatecheck codebase="%CRX_URL%" version="%VER%" /^>
>>"%UPDATEXML%" echo   ^</app^>
>>"%UPDATEXML%" echo ^</gupdate^>

REM --- write the Chrome policies (HKLM = all users on this machine) ---
set "POL=HKLM\Software\Policies\Google\Chrome"
reg add "%POL%\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "%EXT_ID%;%XML_URL%" /f >nul
reg add "%POL%\ExtensionInstallSources"   /v 1 /t REG_SZ /d "file:///*" /f >nul

echo.
echo  Force-install configured:
echo      extension: %EXT_ID%
echo      crx:       %CRX%
echo      version:   %VER%
echo      update:    %XML_URL%
echo.
echo  NEXT:
echo    1. Quit Chrome COMPLETELY (close every window; end chrome.exe in Task Manager).
echo    2. Reopen Chrome. The extension installs into every profile automatically.
echo    3. Check chrome://extensions - it shows "Installed by enterprise policy".
echo.
echo  (To verify the policy loaded, visit chrome://policy and look for
echo   ExtensionInstallForcelist.)
echo.
pause
