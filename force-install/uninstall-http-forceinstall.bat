@echo off
REM ============================================================
REM  Remove the HTTP force-install: deletes the Chrome policy,
REM  removes the login scheduled task, and stops the server.
REM  RUN AS ADMINISTRATOR.
REM ============================================================
setlocal enableextensions

set "TASK=SNKRS Bot Extension Server"

net session >nul 2>&1
if errorlevel 1 ( echo  ERROR: Run as Administrator. & pause & exit /b 1 )

REM --- remove Chrome policy ---
set "POL=HKLM\Software\Policies\Google\Chrome"
reg delete "%POL%\ExtensionInstallForcelist" /v 1 /f >nul 2>&1
reg delete "%POL%\ExtensionInstallSources"   /v 1 /f >nul 2>&1

REM --- remove the scheduled task ---
schtasks /delete /tn "%TASK%" /f >nul 2>&1

REM --- stop the running server via its PID file ---
set "PIDFILE=%~dp0.server.pid"
if exist "%PIDFILE%" (
  set /p SRVPID=<"%PIDFILE%"
  if defined SRVPID taskkill /PID %SRVPID% /F >nul 2>&1
  del "%PIDFILE%" >nul 2>&1
)

echo.
echo  HTTP force-install removed. Restart Chrome to apply.
echo  (The extension will be removed from profiles on next Chrome launch.)
echo.
pause
