@echo off
rem Syntax self-check for the HUD app (node --check parses only, never launches
rem electron), so this CAN run inside the DSH agent sandbox.
setlocal
set "ROOT=%~dp0.."
rem Resolve node (portable, t26): DSH_HUD_NODE env -> PATH -> clear error.
set "NODE="
if defined DSH_HUD_NODE set "NODE=%DSH_HUD_NODE%"
if not defined NODE (
  where node >nul 2>&1 && set "NODE=node"
)
if not defined NODE (
  echo [check] ERROR: node.exe not found on PATH and DSH_HUD_NODE is not set.
  echo [check]        Install Node.js ^>=20 and add it to PATH, or set DSH_HUD_NODE.
  exit /b 1
)

set "FAIL=0"
for %%F in (main.js preload.js src\constants.js src\window-state.js src\hotkeys.js src\hud-window.js src\discovery.js src\compact-css.js src\web-embed.js src\autostart.js src\control.js src\config.js renderer\hud.js renderer\web-preload.js renderer\host-bounds.js) do (
  "%NODE%" --check "%ROOT%\%%F" >nul 2>&1
  if errorlevel 1 (
    echo [check] FAIL %%F
    "%NODE%" --check "%ROOT%\%%F"
    set "FAIL=1"
  ) else (
    echo [check] PASS %%F
  )
)

if "%FAIL%"=="1" (
  echo [check] RESULT=FAIL
  exit /b 1
)
echo [check] RESULT=ALL_PASS
exit /b 0
