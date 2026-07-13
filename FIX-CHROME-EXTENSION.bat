@echo off
REM ============================================================
REM  FIX: "the extension keeps disappearing from my Chrome profiles"
REM
REM  Cause: a leftover Chrome MANAGEMENT policy (from a force-install
REM  attempt) makes Chrome treat the browser as enterprise-managed, which
REM  DISABLES developer-mode (unpacked) extensions on restart. Removing the
REM  policy un-manages the browser so your Load-unpacked copy sticks.
REM
REM  This removes ONLY the SNKRS-bot / force-install policy leftovers. It
REM  prints any other Chrome policies (it does NOT delete those) so you can
REM  see if something else is still managing the browser.
REM
REM  RIGHT-CLICK -> RUN AS ADMINISTRATOR.
REM ============================================================
setlocal enableextensions
set "TASK_NAME=SNKRS Bot Update Server"
set "PORT=38473"

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   ERROR: Run this as Administrator.
  echo   Right-click FIX-CHROME-EXTENSION.bat  ->  "Run as administrator".
  echo.
  pause & exit /b 1
)

echo [1/4] Removing the force-install / management policy leftovers...
for %%H in (HKLM HKCU) do (
  reg delete "%%H\Software\Policies\Google\Chrome\ExtensionInstallForcelist" /f >nul 2>&1
  reg delete "%%H\Software\Policies\Google\Chrome\ExtensionInstallSources"   /f >nul 2>&1
  REM CBCM enrollment token (would keep the browser "managed") — remove if present.
  reg delete "%%H\Software\Policies\Google\Chrome" /v CloudManagementEnrollmentToken /f >nul 2>&1
)

echo [2/4] Removing the update-server logon task...
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

echo [3/4] Stopping the local update server (port %PORT%)...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT%" ^| findstr LISTENING') do taskkill /PID %%P /F >nul 2>&1

echo [4/4] Any REMAINING Chrome policies (should be empty / not ours):
echo   --- HKLM ---
reg query "HKLM\Software\Policies\Google\Chrome" 2>nul || echo   (none)
echo   --- HKCU ---
reg query "HKCU\Software\Policies\Google\Chrome" 2>nul || echo   (none)

echo.
echo ============================================================
echo  DONE. Now:
echo    1. Quit Chrome COMPLETELY (Task Manager -^> end every chrome.exe), reopen.
echo    2. chrome://policy -^> Reload policies -^> ExtensionInstallForcelist is GONE.
echo    3. chrome://extensions -^> turn Developer mode ON. It should now STAY on
echo       across restarts. If it still says "managed by your organization",
echo       another policy remains (see the list above) — tell Claude what it is.
echo    4. In each profile that lost the extension: Load unpacked -^>
echo       select this folder. It will now PERSIST across restarts.
echo    5. Update all profiles later with the dashboard's  Update All  button.
echo ============================================================
echo.
pause
