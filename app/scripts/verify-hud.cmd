@echo off
rem ===========================================================================
rem DSH HUD 用户侧验证脚本（必须在 DSH agent 沙箱外运行）
rem
rem agent 会话内禁止启动 electron（受限令牌会杀掉渲染进程），所以本脚本只用于
rem 一次性人工验证：打印默认热键 + 手测清单，然后启动 HUD 供交互验证。
rem ===========================================================================
setlocal
set "ROOT=%~dp0..\.."
set "EXE=%ROOT%\spike\node_modules\electron\dist\electron.exe"

if not exist "%EXE%" (
  echo [verify] electron.exe not found: %EXE%
  echo [verify] run scripts\install-electron.cmd first (see README-ENV.md).
  exit /b 1
)

echo ===========================================================================
echo  DSH HUD 验证（胶囊 <-> 面板联动 + 内嵌 DSH Web UI）
echo ===========================================================================
echo.
echo  默认热键: Ctrl+Alt+Space   (在胶囊/面板之间切换)
echo.
echo  前置: DSH 桌面端已运行且已安装 token 桥插件（写入 discovery.json）。
echo        可核对 %%LOCALAPPDATA%%\dsh-hud\discovery.json 是否存在且 url 含 ?token=。
echo.
echo  手测清单（逐项观察）:
echo    1) 启动后右下角出现 280x64 胶囊，置顶、任务栏无图标
echo    2) 点击胶囊        -> 展开为 520x720 面板，内嵌 DSH Web UI 加载
echo    3) 面板内可直接发消息，回复流式显示（DSH Web UI 自身能力）
echo    4) Ctrl+Alt+Space  -> 面板收起为胶囊，焦点还给上一个窗口
echo    5) Ctrl+Alt+Space  -> 再次展开面板（复用已加载的 Web UI，无白屏重载）
echo    6) 拖动胶囊到屏幕边缘 -> 松开后自动吸附到边缘(留 8px 边距)
echo    7) 拖动胶囊到别处     -> 松开后位置被记住(重启后回到该处)
echo    8) 按 Esc 或点击别处  -> 面板收起(带 140ms 淡出缩放动画)
echo    9) 面板点 "-"       -> 收起；面板/胶囊点 "x" -> 退出进程
echo   10) 停掉 DSH 服务再展开 -> 显示自绘错误页(重试/启动 DSH 按钮)
echo   11) 透明黑底时: set DSH_HUD_OPAQUE=1 后不透明圆角兜底可显示
echo   12) set DSH_HUD_DEV=1 后展开 -> 内嵌页面打开 devtools(开发模式)
echo.
echo  按任意键启动 HUD（验证结束后点面板/胶囊的 x 退出）...
pause >nul

rem CRITICAL: 清空 DSH 导出的 ELECTRON_RUN_AS_NODE，否则 electron 当纯 Node 跑。
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_ENABLE_LOGGING=1"

"%EXE%" --no-sandbox "%ROOT%\app"
exit /b %ERRORLEVEL%
