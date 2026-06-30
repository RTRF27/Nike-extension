@echo off
REM ============================================================
REM  SNKRS Bot - HTTP force-install (works on modern Chrome)
REM
REM  Serves the .crx over http://127.0.0.1 from a tiny local Node
REM  server, points Chrome's force-install policy at it, and runs
REM  the server automatically at login via Task Scheduler. The
REM  extension then auto-installs into EVERY profile (current and
REM  future) with no per-profile loading.
REM
REM  RUN AS ADMINISTRATOR (right-click -> Run as administrator).
REM ============================================================
setlocal enableextensions

set "EXT_ID=gkfbgibdipccnmamfeflgpahoehpbebf"
set "PORT=38473"
set "TASK=SNKRS Bot Extension Server"

REM --- must be elevated (writes HKLM + scheduled task) ---
net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo  ERROR: Run this as Administrator.
  echo  Right-click install-http-forceinstall.bat -^> "Run as administrator".
  echo.
  pause & exit /b 1
)

REM --- node must be installed ---
where node >nul 2>nul
if errorlevel 1 (
  echo  ERROR: Node.js not found on PATH. Install from https://nodejs.org and retry.
  pause & exit /b 1
)

REM --- resolve paths ---
pushd "%~dp0.."
set "ROOT=%CD%"
popd
set "VBS=%~dp0run-server-hidden.vbs"

if not exist "%ROOT%\snkrs-bot.crx" (
  echo  ERROR: %ROOT%\snkrs-bot.crx not found. Pack it first: node pack-crx.cjs
  pause & exit /b 1
)

REM --- 1) Chrome policy: force-install pointing at the local server ---
set "POL=HKLM\Software\Policies\Google\Chrome"
reg add "%POL%\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "%EXT_ID%;http://127.0.0.1:%PORT%/update.xml" /f >nul
reg add "%POL%\ExtensionInstallSources"   /v 1 /t REG_SZ /d "http://127.0.0.1:%PORT%/*" /f >nul

REM --- 2) Scheduled task: start the hidden server at every logon ---
schtasks /query /tn "%TASK%" >nul 2>&1
if not errorlevel 1 schtasks /delete /tn "%TASK%" /f >nul 2>&1
schtasks /create /tn "%TASK%" /tr "wscript.exe \"%VBS%\"" /sc onlogon /rl highest /f >nul

REM --- 3) Start the server now so install works immediately ---
start "" wscript.exe "%VBS%"

REM --- 4) Quick health check ---
ping -n 3 127.0.0.1 >nul
echo.
echo  Verifying server...
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%PORT%/health).Content } catch { 'SERVER NOT RESPONDING YET' }"

echo.
echo  HTTP force-install configured:
echo      extension: %EXT_ID%
echo      server:    http://127.0.0.1:%PORT%  (auto-starts at login)
echo      crx:       %ROOT%\snkrs-bot.crx
echo.
echo  NEXT:
echo    1. Quit Chrome COMPLETELY (close all windows; end chrome.exe in Task Manager).
echo    2. Reopen Chrome - the extension installs into every profile automatically.
echo    3. Remove any old "Load unpacked" copy from chrome://extensions to avoid duplicates.
echo    4. Verify at chrome://policy (ExtensionInstallForcelist shows the http URL)
echo       and chrome://extensions ("Installed by enterprise policy").
echo.
pause
