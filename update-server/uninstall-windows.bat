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

echo Removing the Chrome management policies (whole keys, HKLM + HKCU)...
REM Delete the ENTIRE keys, not just value "1" — a leftover forcelist entry
REM makes Chrome treat the browser as managed and DISABLE developer-mode
REM (unpacked) extensions on restart, which is why the extension "disappears".
for %%H in (HKLM HKCU) do (
  reg delete "%%H\Software\Policies\Google\Chrome\ExtensionInstallForcelist" /f >nul 2>&1
  reg delete "%%H\Software\Policies\Google\Chrome\ExtensionInstallSources"   /f >nul 2>&1
)

echo Removing the logon task...
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

echo Stopping the update server (port %PORT%)...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT%" ^| findstr LISTENING') do taskkill /PID %%P /F >nul 2>&1

echo.
echo Remaining Chrome policies (should be empty / none of ours)...
reg query "HKLM\Software\Policies\Google\Chrome" 2>nul
reg query "HKCU\Software\Policies\Google\Chrome" 2>nul

echo.
echo ============================================================
echo  Management policies removed.
echo    1. Quit Chrome COMPLETELY (Task Manager -^> end every chrome.exe), reopen.
echo    2. chrome://policy -^> Reload policies -^> ExtensionInstallForcelist GONE.
echo    3. chrome://extensions -^> turn Developer mode ON (it should now STAY on;
echo       if it still says "managed by your organization", another policy
echo       remains — check the reg query output above).
echo    4. Load unpacked the extension in each profile that lost it. It will now
echo       persist across restarts.
echo ============================================================
pause
