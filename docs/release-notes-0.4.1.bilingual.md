# DSH HUD v0.4.1

修复版，只包含两条修复，不涉及新功能。**从 0.4.0 起可以直接用「检查更新」升级，也可以重新下载整包。**

## 修复

- **收起面板时左上角残影**：面板→胶囊的过渡里，窗口先缩到 64×64、渲染层还没切到胶囊态，
  会有 1–2 帧露出面板的标题和 ⌘ 按钮。现在收起动画的结束帧（全透明）会保持到胶囊态就绪，
  过渡期间不会闪旧画面。
- **「检查更新」在部分网络下打不开**：以前只读 `raw.githubusercontent.com`，现在按顺序回退
  raw → jsDelivr → Release 资产 → GitHub REST API，四条都失败时会把每条的原因列出来。

## 安装

1. 下载本 Release 的 `DSH-HUD-0.4.1-win-x64.zip`（约 151 MB），解压到任意目录。
2. 双击目录里的 **`DSH HUD.lnk`**（或 `启动 DSH HUD.cmd`）。
   > **不要双击 `app\DSH HUD.exe`**：它必须带 `--no-sandbox --user-data-dir=…` 才能启动，
   > 零参数会在 Chromium 初始化阶段直接崩（`0x80000003`）。快捷方式里已经写好了参数。
3. 第一次运行若弹出 SmartScreen「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」
   （exe 未做代码签名）。

升级已有安装：右键胶囊 →「检查更新」，或者用新 zip 覆盖解压（`udd/` 目录保留即可）。

## 校验

```powershell
certutil -hashfile "DSH-HUD-0.4.1-win-x64.zip" SHA256
```

SHA-256 见下方附件说明。

## 已知限制

- exe 未签名，SmartScreen 会提示；企业环境可能直接阻断。
- 双屏 / 跨 DPI（100% ↔ 150%）缩放场景尚未系统测试。
- 插件形态依赖计划任务（`dsh-hud-launch`）来拉起应用，个别受组策略限制的机器可能用不了。

---

# DSH HUD v0.4.1 (English)

Maintenance release with two fixes, no new features.

## Fixed

- **Top-left ghost while collapsing**: the window was resized to 64×64 before the renderer
  switched to the capsule state, so for a frame or two the panel's title bar showed inside the
  pill. The fade-out end frame is now kept until the capsule state arrives.
- **"Check for updates" could not reach GitHub on some networks**: the updater now falls back
  raw → jsDelivr → release asset → GitHub REST API instead of relying on raw.githubusercontent.com only.

## Install

Download `DSH-HUD-0.4.1-win-x64.zip` (~151 MB), extract anywhere, then double-click
**`DSH HUD.lnk`** (or `启动 DSH HUD.cmd`). Do **not** double-click `app\DSH HUD.exe`: it needs
`--no-sandbox --user-data-dir=…` and crashes with `0x80000003` without them. The shortcut already
passes those flags.

The executable is unsigned, so SmartScreen may warn on first launch — choose
"More info → Run anyway".

## Known limitations

- Unsigned executable (SmartScreen warning; some corporate machines block it outright).
- Multi-monitor / mixed-DPI setups are not systematically tested yet.
- Plugin mode uses a scheduled task (`dsh-hud-launch`) to start the app; locked-down machines
  may disallow it.
