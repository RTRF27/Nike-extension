@echo off
REM ============================================================
REM  Remove the SNKRS Bot force-install policy.
REM  After running, the extension is no longer pushed to profiles
REM  (already-installed copies are removed by Chrome on next launch).
REM  RUN AS ADMINISTRATOR.
REM ============================================================
setlocal enableextensions

net session >nul 2>&1
if errorlevel 1 (
  echo  ERROR: Run this as Administrator.
  pause
  exit /b 1
)

set "POL=HKLM\Software\Policies\Google\Chrome"
reg delete "%POL%\ExtensionInstallForcelist" /v 1 /f >nul 2>&1
reg delete "%POL%\ExtensionInstallSources"   /v 1 /f >nul 2>&1

echo.
echo  Force-install policy removed. Restart Chrome to apply.
echo.
pause
