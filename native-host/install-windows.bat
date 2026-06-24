@echo off
REM ============================================================
REM Installs the SNKRS Bot native messaging host on Windows.
REM Run this once by double-clicking it (or from a terminal).
REM ============================================================
setlocal enableextensions

set "HOST_NAME=com.snkrs.launcher"
set "SCRIPT_DIR=%~dp0"
set "HOST_SCRIPT=%SCRIPT_DIR%snkrs-launcher.js"
set "WRAPPER=%SCRIPT_DIR%snkrs-launcher.bat"
set "MANIFEST=%SCRIPT_DIR%%HOST_NAME%.json"

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is required but 'node' was not found on PATH.
  echo Install Node from https://nodejs.org/ and re-run.
  pause
  exit /b 1
)

REM Chrome on Windows must point at an executable. Create a .bat wrapper
REM that runs the host script through node.
> "%WRAPPER%" echo @echo off
>> "%WRAPPER%" echo node "%HOST_SCRIPT%" %%*

REM Rewrite the manifest so its "path" points at the wrapper .bat.
REM (JSON needs doubled backslashes, so let Node write it for us.)
node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));m.path=process.argv[2];fs.writeFileSync(process.argv[1],JSON.stringify(m,null,2));" "%MANIFEST%" "%WRAPPER%"

REM Register the manifest for Chrome (current user).
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul

echo.
echo Installed native host:
echo     manifest: %MANIFEST%
echo     wrapper:  %WRAPPER%
echo     registry: HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%
echo.
echo Next:
echo   1. Load the extension (chrome://extensions, Developer mode, Load unpacked).
echo   2. Open the SNKRS dashboard and click "Test launcher connection".
echo.
pause
