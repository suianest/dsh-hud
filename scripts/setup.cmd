@echo off
rem setup.cmd - one-command bootstrap for a fresh clone of dsh-hud.
rem ASCII + CRLF only (do not put non-ASCII text in this file).

rem Resolve node from PATH first; give a clear hint when missing.
where node >nul 2>&1
if errorlevel 1 (
  echo [setup] node.exe was not found on PATH.
  echo [setup] Install Node.js 20 or newer: https://nodejs.org/en/download
  echo [setup] Then re-open this terminal and run scripts\setup.cmd again.
  exit /b 1
)

call node "%~dp0setup.mjs" %*
exit /b %ERRORLEVEL%
