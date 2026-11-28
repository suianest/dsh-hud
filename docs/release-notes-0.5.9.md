# DSH HUD v0.5.9 — 面板空白可诊断 / 视图自愈

## 中文

应用侧修复（插件维持 0.5.10，无需重装插件）：

- **视图日志进 hud.log**：`web load / web loaded / web load failed / web http status` 现在都会写进 `udd/hud.log`，
  面板再空白时能直接看出是加载失败、401 还是渲染进程崩了。
- **渲染进程崩溃自愈**：`render-process-gone` 400 ms 后自动重载；并监听 `unresponsive` / `responsive`。
- **并发导航保护**：同一视图不再同时发起两次导航（取消-重载），修掉「切换/重试后整块空白」。
- **自启请求目录修正**：`requestHostApply()` 改走 `%LOCALAPPDATA%\dsh-hud\ipc`，时间戳改数字。

## English

App-side only (plugin stays 0.5.10, no reinstall needed):

- **Web view logs now land in `udd/hud.log`** (`web load / web loaded / web load failed / web http status`),
  so a blank panel is diagnosable.
- **Self-healing on renderer crash**: `render-process-gone` reloads after 400 ms; `unresponsive` / `responsive` are observed too.
- **Concurrent navigation guard**: cancel-and-reload instead of two overlapping `loadURL` calls.
- **Autostart IPC path fix**: `requestHostApply()` now targets `%LOCALAPPDATA%\dsh-hud\ipc` with a numeric timestamp.
