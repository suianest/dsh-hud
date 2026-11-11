@echo off
setlocal

REM build-portable.cmd - build Windows portable (unpacked dir + zip) with electron-builder.
REM Run in a NORMAL terminal (outside the DSH agent sandbox). Packaging does not launch
REM the renderer, but electron-builder spawns pnpm to collect node_modules, which hits
REM the sandbox's EPERM boundary.
REM Output: dsh-hud\dist\  (win-unpacked\ + *.zip). Reuses spike's electron dist (no ~150MB download).

set "ROOT=%~dp0..\.."
set "APP_DIR=%~dp0.."
rem Resolve node (portable, t26): DSH_HUD_NODE env -> PATH -> clear error.
set "NODE="
if defined DSH_HUD_NODE set "NODE=%DSH_HUD_NODE%"
if not defined NODE (
  where node >nul 2>&1 && set "NODE=node"
)
if not defined NODE (
  echo [build-portable] ERROR: node.exe not found on PATH and DSH_HUD_NODE is not set.
  echo [build-portable]        Install Node.js ^>=20 and add it to PATH, or set DSH_HUD_NODE.
  exit /b 1
)

rem Resolve pnpm (portable, t26): DSH_HUD_PNPM env -> PATH -> clear error.
rem A *.mjs value is the standalone pnpm script (run via node); otherwise it is
rem the pnpm shim (corepack/npm) and runs directly.
set "PNPM="
set "PNPM_IS_MJS=0"
if defined DSH_HUD_PNPM (
  set "PNPM=%DSH_HUD_PNPM%"
) else (
  where pnpm >nul 2>&1 && set "PNPM=pnpm"
)
if not defined PNPM (
  echo [build-portable] ERROR: pnpm not found on PATH and DSH_HUD_PNPM is not set.
  echo [build-portable]        Run "corepack enable" or set DSH_HUD_PNPM to pnpm.
  exit /b 1
)
echo %PNPM% | findstr /i "\.mjs$" >nul && set "PNPM_IS_MJS=1"

set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "npm_config_registry=https://registry.npmmirror.com"

echo [build-portable] [1/3] install deps (electron-builder) ...
pushd "%APP_DIR%"
if "%PNPM_IS_MJS%"=="1" (
  "%NODE%" "%PNPM%" install --registry https://registry.npmmirror.com --node-linker=hoisted --no-frozen-lockfile --store-dir "%ROOT%\.pnpm-store"
) else (
  "%PNPM%" install --registry https://registry.npmmirror.com --node-linker=hoisted --no-frozen-lockfile --store-dir "%ROOT%\.pnpm-store"
)
if errorlevel 1 (
  popd
  echo [build-portable] dependency install FAILED
  exit /b 1
)

echo [build-portable] [2/3] build unpacked dir + zip ...
"%NODE%" "node_modules\electron-builder\out\cli\cli.js" --win --x64
if errorlevel 1 (
  popd
  echo [build-portable] build FAILED
  exit /b 1
)
popd

echo [build-portable] [3/3] done. artifacts in "%ROOT%\dist"
exit /b 0
