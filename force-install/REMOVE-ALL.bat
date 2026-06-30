@echo off
REM ============================================================
REM  WIPE the SNKRS Bot auto-install (force-install) completely.
REM
REM  This removes the Chrome enterprise policy that was force-pushing
REM  the extension, the login scheduled task, and the local server.
REM  After this, Chrome stops managing the extension and your MANUAL
REM  "Load unpacked" copy will persist across restarts.
REM
REM  RUN AS ADMINISTRATOR (right-click -> Run as administrator).
REM ============================================================
setlocal enableextensions

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo  ERROR: Run this as Administrator.
  echo  Right-click REMOVE-ALL.bat  -^>  "Run as administrator".
  echo.
  pause & exit /b 1
)

echo  Removing Chrome force-install policy (HKLM and HKCU)...
for %%H in (HKLM HKCU) do (
  reg delete "%%H\Software\Policies\Google\Chrome\ExtensionInstallForcelist" /v 1 /f >nul 2>&1
  reg delete "%%H\Software\Policies\Google\Chrome\ExtensionInstallSources"   /v 1 /f >nul 2>&1
)

echo  Removing the login scheduled task...
schtasks /delete /tn "SNKRS Bot Extension Server" /f >nul 2>&1

echo  Stopping the local update server...
set "PIDFILE=%~dp0.server.pid"
if exist "%PIDFILE%" (
  set /p SRVPID=<"%PIDFILE%"
  if defined SRVPID taskkill /PID %SRVPID% /F >nul 2>&1
  del "%PIDFILE%" >nul 2>&1
)
REM Also stop any stray hidden server still bound to the update port.
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":38473" ^| findstr LISTENING') do taskkill /PID %%P /F >nul 2>&1

echo.
echo  ============================================================
echo   Auto-install removed. Now do this:
echo     1. Quit Chrome COMPLETELY (Task Manager -^> end all chrome.exe).
echo     2. Reopen Chrome.
echo     3. chrome://policy  -^>  Reload policies  -^>  confirm
echo        ExtensionInstallForcelist is GONE.
echo     4. In each profile: chrome://extensions  -^>  Developer mode ON
echo        -^>  Load unpacked  -^>  select the extension folder.
echo     It will now STAY loaded across restarts.
echo  ============================================================
echo.
pause
