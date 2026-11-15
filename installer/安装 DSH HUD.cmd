@echo off
chcp 936 >nul
setlocal
title DSH HUD 一键安装
set "PS1=%~dp0install-dsh-hud.ps1"
if not exist "%PS1%" (
  echo 正在获取安装脚本...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/suianest/dsh-hud/main/installer/install-dsh-hud.ps1' -OutFile '%PS1%' } catch { exit 1 }"
  if not exist "%PS1%" (
    echo 获取安装脚本失败，请检查网络后重试。
    pause
    exit /b 1
  )
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
echo.
pause
