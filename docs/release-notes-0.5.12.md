# DSH HUD 0.5.12

**应用 0.5.12 / 插件 0.5.12** — 本轮是打磨版本，两个修复都来自你反馈的「面板空白」「重启后不重连」。

## 修复

- **插件重载会打断在途导航**：插件的 `reload` 提示以前会 `stop()` 掉正在进行的
  `401 → 错误页 → token 重试` 导航，面板空 8–15 秒；现在等导航结束再刷新。
- **apply 幂等**：一次 DSH 启动重复挂载插件时不再重复执行副作用（自启/拉起/建快捷方式）。
- **`discovery.port` 类型**：字符串 → 数字，并补了 `docs/discovery-contract.md` 契约文档。

## 升级

- 应用：胶囊右键 →「检查更新」，或下载 `DSH-HUD-0.5.12-win-x64.zip`。
- 插件：`pnpm add dsh-hud-capsule@0.5.12`（或 `npm i -g` 场景同理），然后**重启 DSH**。

## 校验

zip sha256 与 `manifest.json` 见 Release 正文；可运行 `certutil -hashfile <zip> SHA256` 对照。

---

# DSH HUD 0.5.12 (English)

**App 0.5.12 / plugin 0.5.12** — polish release, both fixes come from the blank-panel report.

## Fixed

- The plugin's `reload` nudge no longer aborts an in-flight navigation
  (`401 → error page → token retry`); it waits up to ~3 s for the view to go idle.
- `apply()` is idempotent per process: a duplicate mount no longer re-runs autostart,
  launch or shortcut side effects.
- `discovery.port` is now a number, documented in `docs/discovery-contract.md`.

## Upgrade

- App: right-click the capsule → "Check for updates", or grab the 0.5.12 zip.
- Plugin: `pnpm add dsh-hud-capsule@0.5.12`, then restart DSH.
