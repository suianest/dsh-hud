# DSH HUD v0.5.4 — 被安全软件拦住时不再静默 / Say something when AV blocks the launch

## 中文

这个版本不换任何界面，只解决三个「装完了但没反应」的坑。

### Fixed

- **拉起失败不再静默**：spawn 报错、HUD 启动后 5 秒内退出、计划任务跑完但没有进程出现——这三种情况现在都会在 `%LOCALAPPDATA%\dsh-hud\hud.log` 写一行说明，并提示「可能被安全软件（悟空/360/火绒/Defender）拦截，请把 `DSH HUD.exe` 加白名单」。之前这类失败只有一行 `launched`，用户完全不知道发生了什么。
- **错误页给出下一步**：面板连不上 DSH 时，错误页多一行「还要在 DSH 里装插件 `dsh-hud-capsule`」。只装了应用包的人不会再把「没装插件」误认为「装坏了」。
- **安装器提示装插件**：`install-dsh-hud.cmd` 装完会打印「下一步：DSH → 设置 → 插件 → 添加插件 → 填 `dsh-hud-capsule`」，不再停在装了一半的状态。

### Docs

- README 安装路线按推荐顺序重排：**C npm 包名（首选）→ A 安装器（兜底）→ B1 GitHub（需 git）→ B2 本地目录（无需 git）**。
- 新增「安全软件拦截（悟空 / 360 / 火绒 / Defender）」章节：现象、原因（未签名 + 后台自动拉起）、三种处理办法。
- 安装 PDF 的 FAQ 增加「第一次没出现胶囊」条目，版本号刷到 0.5.4。

### 安装

```text
npm / DSH 插件：dsh-hud-capsule
安装器：见下方附件 install-dsh-hud.cmd
手动：DSH-HUD-0.5.4-win-x64.zip → 解压 → 双击 DSH HUD.lnk
```

### 校验

- `DSH-HUD-0.5.4-win-x64.zip` SHA-256：`0b00b561574714e6b49d5c907c2c7575d838dea934dc16b30e8259dc97247aa9`（158,637,260 B）
- `app.asar` SHA-256：`105f3a5c72fac7b2f2b952248ba8545b76cdd275dfd6f8cc3c237ca9b6bfb45d`（509,491 B）

---

## English

This release changes no UI. It only fixes three "installed but nothing happened" traps.

### Fixed

- **Launch failures are no longer silent**: a spawn error, a HUD that exits within 5 seconds, or a scheduled task that finishes without a process now all write an explanatory line to `%LOCALAPPDATA%\dsh-hud\hud.log`, pointing at antivirus interception (悟空/360/火绒/Defender) and telling the user to whitelist `DSH HUD.exe`. Previously such failures left only a `launched` line and no clue.
- **Actionable error page**: when the panel cannot reach DSH, the error page now says the `dsh-hud-capsule` plugin must be installed in DSH, so a standalone app install is no longer mistaken for a broken one.
- **Installer prints the next step**: after installing, `install-dsh-hud.cmd` tells the user to add the `dsh-hud-capsule` plugin in DSH instead of stopping half-way.

### Docs

- README routes reordered by recommendation: **C npm package (default) → A installer (fallback) → B1 GitHub (needs git) → B2 local directory (no git)**.
- New "Antivirus interception" section explaining the unsigned-exe + background-launch cause and three workarounds.
- Install PDF FAQ gains a "capsule did not appear the first time" row; version bumped to 0.5.4.

### Verify

- `DSH-HUD-0.5.4-win-x64.zip` SHA-256: `0b00b561574714e6b49d5c907c2c7575d838dea934dc16b30e8259dc97247aa9`
- `app.asar` SHA-256: `105f3a5c72fac7b2f2b952248ba8545b76cdd275dfd6f8cc3c237ca9b6bfb45d`
