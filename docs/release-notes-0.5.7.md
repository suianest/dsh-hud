# DSH HUD v0.5.7

**安装包瘦身 + 收掉临时测试条目**，这一版作为「中版」起点：功能面收敛，之后按用户体验反馈再出终版。

## 变化

- **瘦身：语言包裁剪**。Electron 运行时自带 55 个语言包（约 49 MB），HUD 只服务中文/英文用户，
  现在只保留 `en-US` / `zh-CN` / `zh-TW`；Chromium 找不到对应语言包会自动回落 en-US，行为不变。
- **压缩方式升级**：改用 .NET `ZipArchive` 的 `SmallestSize`（比 PowerShell `Compress-Archive -Optimal` 更小），
  并且先 `robocopy /XJ` 拷一份不含 junction 的临时副本再压（避免把开发用的 `app/resources/artifacts`
  展开成上 GB 的无用文件）。
- **移除命令面板里的「测试」条目**：它是 0.5.5 用来验证「仓库改动 → 构建 → 面板」链路的临时探针，
  现在连通性由「检查更新」与插件更新提示覆盖。

## 数据

| | 0.5.6 | 0.5.7 |
|---|---|---|
| zip | 158,638,705 B | 见 Release 附件（约 147 MB） |
| 解压后 | 381 MB（locales 49 MB） | 约 334 MB（locales 3 个） |

## 安装

三条路线任选，见 [README](https://github.com/suianest/dsh-hud#安装)。

- A 便携版：Release 里的 `DSH-HUD-0.5.7-win-x64.zip`（或 `install-dsh-hud.cmd` 一键安装）
- B `github:suianest/dsh-hud`（需要 git）
- C npm：`dsh-hud-capsule`

## Planned

- R-1 代码签名（SmartScreen / 悟空误判）、R-2 第二台机器 GitHub 路线、R-3 进一步瘦身，
  见 `docs/roadmap.md`。

---

# DSH HUD v0.5.7 (English)

**Slimmer package + the temporary test entry is gone.** This release marks the start of the
"mid" line: features are frozen, the final version will follow user-experience feedback.

- **Smaller download** — only `en-US` / `zh-CN` / `zh-TW` locale packs are shipped (Chromium falls back
  to en-US when a locale is missing); the zip is now written with .NET `ZipArchive` at `SmallestSize`
  from a junction-free staging copy.
- **Removed** — the "测试" palette entry used during 0.5.5 to verify the repo → build → palette chain.
- **Known limitations** — `DSH HUD.exe` is still unsigned (R-1 in `docs/roadmap.md`).
