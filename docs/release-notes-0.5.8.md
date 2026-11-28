# DSH HUD v0.5.8 — 修复「打开 DSH 桌面窗口」与 IPC 轮询死循环

**发布日期 / Released:** 2026-11-23 · **插件 / Plugin:** `dsh-hud-capsule@0.5.10`

---

## 中文

这一版是修 bug 的版本，没有新功能。两个问题都来自 HUD（Low IL）与插件（Medium IL）之间的文件桥接。

### 修复

- **「打开 DSH 桌面窗口」静默失败**
  以前 HUD 把请求写到 `<安装目录>/app/artifacts/ipc`，插件却在仓库目录和 `%LOCALAPPDATA%` 里找，两边永远碰不上；
  6 秒超时后 HUD 回退到直接 `spawn`，DSH 已经在运行时只会起一个无窗口的第二实例，看起来就是「点了没反应」。
  现在两端统一使用 `%LOCALAPPDATA%\dsh-hud\ipc`，插件启动时用 `icacls /setintegritylevel Low` 让低权限的 HUD 也能写入；
  超时放宽到 12 秒；如果确实无法置前，会弹一条可见通知告诉你原因，而不是静默退出。

- **IPC 轮询死循环（反复弹窗 / 反复重写开机启动项）**
  多个目录里的 `request.json` 共用一个去重变量，两个不同 id 会每 500 ms 互相覆盖，
  表现为诊断日志里一直刷「过期请求 + 重装自启」。现在按 id 集合去重，处理或丢弃后立即删除请求文件，
  并且同时识别数字和 ISO 字符串两种时间戳。

- **通知不显示**：补上 `AppUserModelID`，Windows 上 `Notification.isSupported()` 才会为真。

- **兼容旧版应用**：0.5.7 及更早的 HUD 仍写 `<root>/app/artifacts/ipc`，插件现在同时轮询该路径，
  「先升级插件、后升级应用」的中间状态也能正常工作。

### 测试

- 单测 **96/96**，其中新增 `tests/e2e/unit/plugin-ipc.test.mjs` 8 条（去重、两种时间戳、TTL 边界、互踢循环回归）。
- 真机 harness 两个场景（stale / legacy）均通过。

### 升级

- 应用：任意版本点「检查更新」→ 下载 `app.asar`（约 0.5 MB）→ 自动重启到 0.5.8。
- 插件：`dsh-hud-capsule@0.5.10`，在 DSH 里更新插件后重启 DSH。

---

## English

A bug-fix release — no new features. Both issues lived in the file bridge between the HUD (Low IL) and the plugin (Medium IL).

### Fixed

- **"Open DSH desktop window" failed silently**
  The HUD wrote requests to `<install>/app/artifacts/ipc` while the plugin polled the repo folder and `%LOCALAPPDATA%`,
  so the two never met. After a 6 s timeout the HUD fell back to spawning the desktop app, which only produced a
  windowless second instance. Both sides now use `%LOCALAPPDATA%\dsh-hud\ipc`, the plugin lowers the folder's integrity
  with `icacls /setintegritylevel Low` so the low-IL HUD can write, the timeout is 12 s, and a visible notification
  explains the failure instead of exiting quietly.

- **IPC polling loop (repeated pop-ups / rewritten Startup entry)**
  A single de-duplication slot was shared across directories, so two request files with different ids overwrote each
  other every 500 ms. De-duplication is now a bounded id set, handled/expired request files are deleted, and both
  epoch numbers and ISO strings are accepted for `at`.

- **Notifications were not shown**: added `AppUserModelID`.

- **Compatibility with older apps**: builds up to 0.5.7 still write to `<root>/app/artifacts/ipc`; the plugin now polls
  that path too, so "plugin first, app later" upgrades keep working.

### Tests

- **96/96** unit tests, including the new `tests/e2e/unit/plugin-ipc.test.mjs` (8 cases).
- Live harness scenarios (`stale`, `legacy`) both pass.

### Upgrading

- App: click "Check for updates" → downloads `app.asar` (~0.5 MB) → restarts into 0.5.8.
- Plugin: `dsh-hud-capsule@0.5.10`; restart DSH after updating it.
