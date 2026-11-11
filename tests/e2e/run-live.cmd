@echo off
REM ---------------------------------------------------------------------------
REM t8 live end-to-end run. MUST be executed from a normal Windows terminal
REM (outside the DSH agent sandbox): Electron renderers cannot start under the
REM restricted token used by the agent session.
REM
REM   tests\e2e\run-live.cmd
REM
REM Phase 1 runs the scenario and writes shots + live-report.json.
REM Phase 2 starts a fresh Electron process against the same profile and checks
REM that the saved capsule position is restored.
REM ---------------------------------------------------------------------------
setlocal
set "ROOT=%~dp0..\.."
pushd "%ROOT%"

if not defined DSH_HUD_E2E_ELECTRON set "DSH_HUD_E2E_ELECTRON=%ROOT%\spike\node_modules\electron\dist\electron.exe"
if not exist "%DSH_HUD_E2E_ELECTRON%" (
  echo [run-live] electron.exe not found: %DSH_HUD_E2E_ELECTRON%
  exit /b 2
)

REM Critical: an inherited ELECTRON_RUN_AS_NODE=1 makes electron.exe run as a
REM plain Node process and every window call fails.
set "ELECTRON_RUN_AS_NODE="
set "DSH_HUD_OPAQUE=1"
if not defined DSH_HUD_E2E_OUT set "DSH_HUD_E2E_OUT=%ROOT%\artifacts\e2e\live"
if not exist "%DSH_HUD_E2E_OUT%" mkdir "%DSH_HUD_E2E_OUT%"

for /f "delims=" %%i in ('powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()"') do set "DSH_HUD_E2E_T0=%%i"

echo [run-live] phase=run electron=%DSH_HUD_E2E_ELECTRON%
"%DSH_HUD_E2E_ELECTRON%" --no-sandbox "tests\e2e\live\main.cjs" --phase=run
set "RC1=%ERRORLEVEL%"
echo [run-live] phase=run exit=%RC1%

echo [run-live] phase=restore
"%DSH_HUD_E2E_ELECTRON%" --no-sandbox "tests\e2e\live\main.cjs" --phase=restore
set "RC2=%ERRORLEVEL%"
echo [run-live] phase=restore exit=%RC2%

echo [run-live] report: %DSH_HUD_E2E_OUT%\live-report.json
echo [run-live] shots : %DSH_HUD_E2E_OUT%\shots
if not "%RC1%"=="0" exit /b %RC1%
if not "%RC2%"=="0" exit /b %RC2%
exit /b 0
