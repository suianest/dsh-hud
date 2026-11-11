@echo off
rem Run the DSH HUD floating window (capsule + panel), interactively.
rem Runtime: runtime\node_modules\electron\dist\electron.exe by default;
rem override with DSH_HUD_ELECTRON=...
setlocal
for %%i in ("%~dp0..\..") do set "ROOT=%%~fi"
if not defined DSH_HUD_ELECTRON set "DSH_HUD_ELECTRON=%ROOT%\runtime\node_modules\electron\dist\electron.exe"
set "EXE=%DSH_HUD_ELECTRON%"
set "ELECTRON_RUN_AS_NODE="

rem Pick a user-data-dir the CURRENT process can actually write. A low-integrity
rem shell (DSH-spawned cmd) cannot write %LOCALAPPDATA%; Chromium would then fail
rem to create its singleton lock and the app would quit silently.
if not defined DSH_HUD_USER_DATA set "DSH_HUD_USER_DATA=%LOCALAPPDATA%\dsh-hud\userdata"
if not exist "%DSH_HUD_USER_DATA%" mkdir "%DSH_HUD_USER_DATA%" >nul 2>&1
echo probe>"%DSH_HUD_USER_DATA%\.write-probe" >nul 2>&1
if not exist "%DSH_HUD_USER_DATA%\.write-probe" (
  set "DSH_HUD_USER_DATA=%ROOT%\artifacts\udd-hud"
  echo [hud] LOCALAPPDATA not writable, using %DSH_HUD_USER_DATA%
  if not exist "%DSH_HUD_USER_DATA%" mkdir "%DSH_HUD_USER_DATA%" >nul 2>&1
) else (
  del /q "%DSH_HUD_USER_DATA%\.write-probe" >nul 2>&1
)

if not exist "%EXE%" (
  echo [hud] electron.exe not found: %EXE%
  exit /b 1
)

echo [hud] electron=%EXE%
echo [hud] user-data=%DSH_HUD_USER_DATA%
if "%DSH_HUD_DEBUG%"=="1" (
  if not defined DSH_HUD_CLICK_LOG set "DSH_HUD_CLICK_LOG=%ROOT%\artifacts\clicks.log"
  if not defined DSH_HUD_DIAG_LOG set "DSH_HUD_DIAG_LOG=%ROOT%\artifacts\diag.log"
  set "DSH_HUD_DEBUG_CLICKS=1"
  if not defined DSH_HUD_DUMP_DOM set "DSH_HUD_DUMP_DOM=1"
  echo [hud] debug ON: diag=%DSH_HUD_DIAG_LOG% clicks=%DSH_HUD_CLICK_LOG%
)
if "%DSH_HUD_DEBUG_CLICKS%"=="1" (
  if not defined DSH_HUD_CLICK_LOG set "DSH_HUD_CLICK_LOG=%ROOT%\artifacts\clicks.log"
  echo [hud] click-debug ON, log=%DSH_HUD_CLICK_LOG%
)
"%EXE%" --no-sandbox "--user-data-dir=%DSH_HUD_USER_DATA%" "%ROOT%\app"
set "CODE=%ERRORLEVEL%"
echo [hud] exit=%CODE%
exit /b %CODE%
