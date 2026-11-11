@echo off
rem One-shot real-machine capture: expands the panel, waits for the embedded
rem DSH Web UI, writes three PNGs, then exits.
rem Everything electron prints is mirrored into artifacts\capture-out.log.
rem Usage: scripts\run-hud-capture.cmd  (optional: set DSH_HUD_ELECTRON)
setlocal
for %%i in ("%~dp0..") do set "ROOT=%%~fi"
if not defined DSH_HUD_ELECTRON set "DSH_HUD_ELECTRON=%ROOT%\runtime\node_modules\electron\dist\electron.exe"
set "EXE=%DSH_HUD_ELECTRON%"
set "ART=%ROOT%\artifacts"
set "ELECTRON_RUN_AS_NODE="
if not exist "%ART%" mkdir "%ART%"

rem The caller may be a low-integrity shell (DSH-spawned cmd). %LOCALAPPDATA%
rem is then not writable, which breaks Chromium's singleton lock and makes the
rem app quit silently. Keep the capture profile inside the workspace -- and keep
rem it SEPARATE from the interactive HUD's fallback profile (%ROOT%\artifacts\
rem udd-hud), otherwise the cleanup below kills the window the user is using.
set "DSH_HUD_USER_DATA=%ART%\udd-capture"
if defined DSH_HUD_RESET if exist "%DSH_HUD_USER_DATA%" rd /s /q "%DSH_HUD_USER_DATA%" >nul 2>&1
mkdir "%DSH_HUD_USER_DATA%" >nul 2>&1
set "DSH_HUD_CAPTURE=%ART%\hud-capture.png"

echo [capture] root=%ROOT%
echo [capture] electron=%EXE%
echo [capture] user-data=%DSH_HUD_USER_DATA%
if not exist "%EXE%" (
  echo [capture] FATAL electron not found
  echo FATAL electron not found: %EXE% > "%ART%\capture-out.log"
  exit /b 1
)
if not exist "%ROOT%\app\main.js" (
  echo [capture] FATAL app main.js not found
  echo FATAL app main.js not found >> "%ART%\capture-out.log"
  exit /b 1
)

rem Kill only leftover CAPTURE instances (same --user-data-dir=*udd-capture*).
rem The interactive HUD uses udd-hud (or %LOCALAPPDATA%\dsh-hud\userdata) and is
rem deliberately NOT matched: running a capture must never close a live window.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -like '*udd-capture*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
del /q "%ART%\hud-capture*.png" >nul 2>&1
del /q "%ART%\capture-out.log" >nul 2>&1

echo [capture] launching...
"%EXE%" --no-sandbox --enable-logging=stderr "--user-data-dir=%DSH_HUD_USER_DATA%" "%ROOT%\app" > "%ART%\capture-out.log" 2>&1
set "CODE=%ERRORLEVEL%"
echo [capture] exit=%CODE%
echo ---- files ----
dir /b "%ART%\hud-capture*.png" 2>nul
echo ---- log tail ----
powershell -NoProfile -Command "if (Test-Path '%ART%\capture-out.log') { Get-Content '%ART%\capture-out.log' -Tail 20 }"
exit /b %CODE%
