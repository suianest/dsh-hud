# DSH HUD v0.5.6

**插件更新现在会提醒你了**：HUD 的 `⌘` 按钮会出现一个橙色小圆点，命令面板里多一项
「插件有新版本 vX.Y.Z（复制升级命令）」。点一下就把升级命令复制到剪贴板——升级仍然由你自己执行。

## 新增

- **插件版本提示（P-14 方案 A）**
  - 插件每 6 小时查一次 npm 上 `dsh-hud-capsule` 的最新版本（10 s 超时；失败只写日志，不弹任何东西）。
  - 发现比本地新 → 通过 `control.json` 通知 HUD，同一个版本只提醒一次。
  - HUD 收到后：`⌘` 按钮加橙色角标 + 命令面板最后一项显示版本号；点击复制
    `pnpm add dsh-hud-capsule@X.Y.Z` 并关闭面板。
  - **不替换任何文件**：插件保持 `link:` 目录形态时，`pnpm`/DSH 会把它改回去，自动替换只会制造半更新状态，所以这里只做「发现 + 提示」。

## 修复

- HUD 对插件上报的版本做二次校验：`latest` 不高于当前版本（含降级）时忽略，并清掉之前显示的角标与面板条目。

## 测试

- 新增 3 条 hud-window 单测（有更新时状态/条目/剪贴板、空值不出现、同版本与降级被忽略）；
  全套 **87/87**。
- 真机验收（2026-11-20）：注入 `plugin-update` → 日志 `plugin update: current=0.5.5 latest=0.5.6`、
  `⌘` 出现橙点、面板出现条目、点击后剪贴板为 `pnpm add dsh-hud-capsule@0.5.6`、
  同版本上报被记为 `plugin update ignored`；插件侧真实请求写入了
  `plugin-update.json`（`lastCheckAt` / `current` / `latest`），6 小时节流生效。

---

# DSH HUD v0.5.6 (English)

**The HUD now tells you when the plugin has an update**: a small orange dot appears on the `⌘`
button and the command palette gains an entry "插件有新版本 vX.Y.Z（复制升级命令）".
Clicking it copies `pnpm add dsh-hud-capsule@X.Y.Z` — you still run the upgrade yourself.

- **Added** — plugin update discovery (P-14 plan A): the plugin checks npm `dsh-hud-capsule`
  every 6 hours (10 s timeout, silent on failure), notifies the HUD through `control.json` at most
  once per version; the HUD shows a badge + palette entry and copies the upgrade command.
  Nothing is replaced automatically.
- **Fixed** — the HUD now ignores a reported `latest` that is not newer than the current version
  (and clears the previous badge), guarding against a misbehaving plugin.
- **Tests** — 3 new hud-window unit tests, 87/87 total; real-machine verification on 2026-11-20.

## 安装

三条路线任选，见 [README](https://github.com/suianest/dsh-hud#安装)。

- A 便携版：Release 里的 `DSH-HUD-0.5.6-win-x64.zip`（或 `install-dsh-hud.cmd` 一键安装）
- B `github:suianest/dsh-hud`（需要 git）
- C npm：`dsh-hud-capsule`

## 校验

```powershell
certutil -hashfile "DSH-HUD-0.5.6-win-x64.zip" SHA256
```

## Known limitations

- `DSH HUD.exe` 仍未签名，首次运行 SmartScreen / 悟空 / 360 / 火绒可能提示一次（R-1 计划中）。
