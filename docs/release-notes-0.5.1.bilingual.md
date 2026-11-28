# DSH HUD v0.5.1

> 状态：**已构建，待发布**（0.5.0 保持公开不动）
> 构建 2026-11-16

## 中文

### 为什么会有这个版本

0.5.0 修好「应用内更新」后，你反馈了一个小闪帧：**点胶囊展开的一瞬间，胶囊图标会先在新窗口左上角位移一帧，然后才消失**。收起方向是对称的。根源是主进程先放大窗口、再通知渲染进程切换，那一帧里旧胶囊的 DOM 被摆进了新尺寸的视口。

这一版把窗口切换改成「等下画面再显示」：切换前先把窗口设成透明，渲染进程在两帧 rAF 之后回一个 `hud:painted`，主进程收到再恢复不透明度；160 ms 定时器兜底，ack 丢了也不会让窗口卡住不显示。

### 变更

- **修复**：展开 / 收起胶囊时的单帧错位（`app/src/hud-window.js`、`app/preload.js`、`app/renderer/hud.js`）
- **测试**：新增 2 条窗口单测（hold 到 ack、无 ack 时兜底），全量 83/83
- **构建**：`make-portable.js` 在 `udd/` 被运行中的 HUD 重新生成时直接报错，避免把 Chromium 缓存（约 13 MB、含本机数据）打进 zip

### 校验

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| `DSH-HUD-0.5.1-win-x64.zip` | 158,638,518 B | `c80426b84bae1074a5336685e7b56361b7bbbff2fbfcb05faa372ead52e04193` |
| `app.asar` | 508,889 B | `56204a60decdf45080306dbe6bf97ead3082614a759ba2c3143aa21758f9933d` |

### 安装

1. 下载 `DSH-HUD-0.5.1-win-x64.zip`，解压到有写权限的目录（推荐 `%LOCALAPPDATA%\DSH HUD`）
2. 双击 `DSH HUD.lnk`（或 `启动 DSH HUD.cmd`）——**不要**双击 `app\DSH HUD.exe`
3. 已装过旧版的：直接覆盖解压即可，`udd\` 可以删（会丢窗口位置/主题缓存）

### 已知限制

- 仍未签名：首次运行可能被 SmartScreen 拦，点「更多信息 → 仍要运行」
- 应用内更新的清单来自仓库 `manifest.json`；发布后需把它指向本版 `app.asar`

## English

### Why this release

v0.5.0 finally made in-app updates work. You then reported a one-frame flash: when the capsule expands, the old capsule DOM shows up in the new window's top-left corner for a frame before the panel paints (symmetric when collapsing). The main process resized the window before telling the renderer to switch views.

This release holds the window invisible across the switch: opacity goes to 0, the renderer acknowledges after two `requestAnimationFrame`s with `hud:painted`, and the main process restores opacity. A 160 ms timer is the fallback so a missing ack can never leave the window blank.

### Changes

- **Fixed**: single-frame jump on expand / collapse (`app/src/hud-window.js`, `app/preload.js`, `app/renderer/hud.js`)
- **Tests**: 2 new window specs (hold until ack, timer fallback) — 83/83 overall
- **Build**: `make-portable.js` now refuses to zip when `udd/` reappears (a running HUD recreates the Chromium cache, ~13 MB of per-machine data)

### Checksums

| File | Size | SHA-256 |
| --- | --- | --- |
| `DSH-HUD-0.5.1-win-x64.zip` | 158,638,518 B | `c80426b84bae1074a5336685e7b56361b7bbbff2fbfcb05faa372ead52e04193` |
| `app.asar` | 508,889 B | `56204a60decdf45080306dbe6bf97ead3082614a759ba2c3143aa21758f9933d` |

### Install

1. Download `DSH-HUD-0.5.1-win-x64.zip` and extract it somewhere writable (e.g. `%LOCALAPPDATA%\DSH HUD`)
2. Run `DSH HUD.lnk` (or `启动 DSH HUD.cmd`) — do **not** double-click `app\DSH HUD.exe`
3. Upgrading: extract over the old folder; `udd\` may be deleted (loses window position / theme cache)

### Known limitations

- Still unsigned: SmartScreen may warn on first run ("More info → Run anyway")
- In-app updates read `manifest.json` from the repo; it must point at this release's `app.asar` after publishing
