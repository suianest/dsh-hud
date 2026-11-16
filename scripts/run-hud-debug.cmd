@echo off
setlocal
rem Dev run with resize diagnostics on. Close it, reproduce the edge-resize
rem bug, then send the tail of artifacts\diag.log.
set "ELECTRON_RUN_AS_NODE="
set "DSH_HUD_DEBUG=1"
set "DSH_HUD_DIAG_LOG=%~dp0..\artifacts\diag.log"
set "DSH_HUD_USER_DATA=%~dp0..\artifacts\udd-hud"
cd /d "%~dp0.."
"%~dp0..\runtime\node_modules\electron\dist\electron.exe" --no-sandbox "%~dp0..\app"
