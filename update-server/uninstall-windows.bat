@echo off
REM ============================================================
REM  SNKRS Bot — remove the auto-update system completely.
REM  RUN AS ADMINISTRATOR.
REM
REM  Removes the force-install policy, the logon task, and stops the
REM  server. Managed extension copies disappear from profiles once the
REM  policy is gone (that is expected!) — load unpacked again afterwards
REM  if you want to keep using the bot without auto-update.
REM ============================================================
setlocal enableextensions
set "TASK_NAME=SNKRS Bot Update Server"
set "PORT=38473"

net session >nul 2>&1
if errorlevel 1 (
  echo ERROR: Run this as Administrator.
  pause & exit /b 1
)

echo Removing the Chrome force-install policy (HKLM + HKCU)...
for %%H in (HKLM HKCU) do (
  reg delete "%%H\Software\Policies\Google\Chrome\ExtensionInstallForcelist" /v 1 /f >nul 2>&1
)

echo Removing the logon task...
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

echo Stopping the update server (port %PORT%)...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT%" ^| findstr LISTENING') do taskkill /PID %%P /F >nul 2>&1

echo.
echo ============================================================
echo  Auto-update removed.
echo    1. Quit Chrome completely, reopen.
echo    2. chrome://policy -^> Reload policies -^> confirm the
echo       ExtensionInstallForcelist entry is gone.
echo    3. The managed extension copy is removed by Chrome. To keep
echo       using the bot, Load unpacked in each profile again.
echo ============================================================
pause
