@echo off
REM ============================================================
REM  SNKRS Bot — auto-update installer (Windows).
REM  RUN AS ADMINISTRATOR (right-click -> Run as administrator).
REM
REM  What it does, IN THIS ORDER (order is the whole point):
REM    1. Pack + sign the .crx           (node pack.js, self-verified)
REM    2. Install a logon task that keeps the local update server up
REM    3. Start the server NOW
REM    4. VERIFY end-to-end: update.xml + crx actually download and the
REM       crx starts with the "Cr24" magic bytes
REM    5. ONLY THEN write ExtensionInstallForcelist
REM
REM  The old force-install wrote the policy first and hoped the server
REM  worked; when it didn't, Chrome dropped the extension everywhere.
REM  Here the policy is never written unless the pipeline provably works,
REM  and once an extension IS installed by policy Chrome keeps it even if
REM  the server is down at startup (it just can't update until it's back).
REM ============================================================
setlocal enableextensions
set "TASK_NAME=SNKRS Bot Update Server"
set "SCRIPT_DIR=%~dp0"
set "PORT=38473"
set "BASE=http://127.0.0.1:%PORT%"
set "ORIG_ID=gkfbgibdipccnmamfeflgpahoehpbebf"
REM Permit pack.js to MINT a signing key if none exists (first migration). If a
REM key already exists in .keys\, pack reuses it and the ID does not change.
set "SNKRS_CRX_REGEN=1"

net session >nul 2>&1
if errorlevel 1 (
  echo ERROR: Run this as Administrator ^(right-click -^> Run as administrator^).
  pause & exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is required but 'node' was not found on PATH.
  echo Install it from https://nodejs.org/ and re-run.
  pause & exit /b 1
)

REM ── Managed-machine gate ─────────────────────────────────────
REM Chrome only force-installs a SELF-HOSTED extension (our local update URL)
REM if the browser is enterprise-managed (domain-joined or enrolled in Chrome
REM Browser Cloud Management). On a plain personal PC Chrome BLOCKS it — you'll
REM see "[BLOCKED] ... not detected as enterprise managed" at chrome://policy.
REM Detect the common "managed" signals; if none, warn before doing anything.
set "MANAGED="
reg query "HKLM\SOFTWARE\Policies\Google\Chrome\CloudManagementEnrollmentToken" >nul 2>nul && set "MANAGED=1"
reg query "HKLM\SOFTWARE\Policies\Google\Chrome\CloudManagementEnrollmentMandatory" >nul 2>nul && set "MANAGED=1"
if not defined MANAGED if defined USERDNSDOMAIN set "MANAGED=1"
if not defined MANAGED (
  echo.
  echo  ============================================================
  echo   WARNING: this PC does NOT look enterprise-managed.
  echo   Chrome will BLOCK a self-hosted force-install ^(you'd see
  echo   "[BLOCKED] ... not detected as enterprise managed" at
  echo   chrome://policy^), so this installer would not actually work.
  echo.
  echo   To make force-install work, first enroll in Chrome Browser
  echo   Cloud Management ^(free^) — see update-server\README.md,
  echo   section "Unmanaged machines". OR skip force-install and keep
  echo   Load-unpacked ^(one full Chrome restart updates every profile^).
  echo  ============================================================
  echo.
  set /p GO="Continue anyway? (y/N): "
  if /I not "%GO%"=="y" (
    echo Aborted — nothing was changed.
    pause & exit /b 1
  )
)

echo [1/5] Packing + signing the extension...
node "%SCRIPT_DIR%pack.js"
if errorlevel 1 (
  echo PACK FAILED — nothing was installed or changed.
  pause & exit /b 1
)

REM Read the extension ID the pack step produced.
for /f "usebackq delims=" %%I in (`node -p "require('%SCRIPT_DIR:\=\\%dist\\info.json').id"`) do set "EXT_ID=%%I"
if not defined EXT_ID (
  echo ERROR: could not read extension ID from dist\info.json
  pause & exit /b 1
)
echo       Extension ID: %EXT_ID%

echo [2/5] Installing the logon task that keeps the server running...
schtasks /create /f /tn "%TASK_NAME%" /sc onlogon ^
  /tr "wscript.exe \"%SCRIPT_DIR%run-hidden.vbs\"" >nul
if errorlevel 1 (
  echo ERROR: could not create the scheduled task.
  pause & exit /b 1
)

echo [3/5] Starting the server now...
schtasks /run /tn "%TASK_NAME%" >nul

echo [4/5] Verifying the update pipeline end-to-end...
powershell -NoProfile -Command ^
  "$ok=$false;" ^
  "for($i=0;$i -lt 15;$i++){" ^
  "  try{" ^
  "    $x=Invoke-WebRequest -UseBasicParsing '%BASE%/update.xml';" ^
  "    $c=Invoke-WebRequest -UseBasicParsing '%BASE%/snkrs-bot.crx';" ^
  "    $magic=[Text.Encoding]::ASCII.GetString($c.Content[0..3]);" ^
  "    if($x.StatusCode -eq 200 -and $c.StatusCode -eq 200 -and $magic -eq 'Cr24' -and $x.Content -match '%EXT_ID%'){$ok=$true;break}" ^
  "  }catch{}" ^
  "  Start-Sleep 1" ^
  "};" ^
  "if(-not $ok){exit 1};" ^
  "Write-Host ('      update.xml OK, crx OK ('+$c.Content.Length+' bytes, Cr24 magic verified)')"
if errorlevel 1 (
  echo.
  echo VERIFICATION FAILED — the policy was NOT written, Chrome is untouched.
  echo Check: is something else on port %PORT%?  Try:  node "%SCRIPT_DIR%server.js"
  echo and open %BASE%/version.json in a browser.
  pause & exit /b 1
)

echo [5/5] Writing the Chrome force-install policy (verified pipeline only)...
reg add "HKLM\Software\Policies\Google\Chrome\ExtensionInstallForcelist" ^
  /v 1 /t REG_SZ /d "%EXT_ID%;%BASE%/update.xml" /f >nul
if errorlevel 1 (
  echo ERROR: could not write the policy registry key.
  pause & exit /b 1
)

echo.
echo ============================================================
echo  DONE. Auto-update is live.
echo    Extension ID : %EXT_ID%
echo    Update URL   : %BASE%/update.xml
echo    Server task  : "%TASK_NAME%"  (starts hidden at every logon)
echo.
if /I "%EXT_ID%"=="%ORIG_ID%" (
  echo  Your signing key was found — the ID is UNCHANGED ^(gkfbg...^).
  echo  The native host and every profile already trust it, so this is clean.
) else (
  echo  NOTE: no original key was found, so a NEW ID was minted:
  echo        %EXT_ID%
  echo  This differs from your old unpacked copies ^(%ORIG_ID%^),
  echo  so after the managed copy appears you MUST remove the old unpacked
  echo  ones or the bot will run TWICE per profile.
)
echo.
echo  BACK UP the signing key so the ID never changes again:
echo    copy  "%SCRIPT_DIR%..\.keys\crx-signing-key.pem"  somewhere safe.
echo.
echo  Now:
echo    1. Quit Chrome COMPLETELY (Task Manager -^> end every chrome.exe), reopen.
echo    2. chrome://policy -^> Reload policies -^> confirm ExtensionInstallForcelist
echo       shows the ID above.
echo    3. chrome://extensions in a couple of profiles -^> the extension should
echo       appear as "Installed by enterprise policy".
echo    4. THEN remove the old "Load unpacked" copies from every profile
echo       (chrome://extensions -^> Remove) so only the managed copy remains.
echo    5. If the launcher shows OFFLINE afterwards, re-run
echo       native-host\install-windows.bat once (re-registers the matching ID).
echo.
echo  To publish an update later: bump "version" in manifest.json, run
echo    node "%SCRIPT_DIR%pack.js"  — every profile auto-updates within ~5h
echo    (or hit Update in chrome://extensions). No key regen, no ID change.
echo ============================================================
pause
