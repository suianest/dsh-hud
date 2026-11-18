# DSH HUD v0.5.5

**默认启动方式改成了「插件直接 spawn 应用」**，不再注册计划任务 —— 这是国产安全软件误判的主要来源。

## 变更

- 默认不再注册计划任务 `dsh-hud-launch`：插件直接从 DSH 进程拉起 `DSH HUD.exe`（子进程带 `--no-sandbox` + 可写 `--user-data-dir`）。
  - 2026-11-18 复测：此前记录的 `0x80000003` 崩溃并非「宿主不能 spawn Electron」，而是子进程回落到共享 `%APPDATA%\Electron` 配置导致的；参数给对后，直接 spawn 在真机验证通过。
- 计划任务降级为兜底：直接拉起 6 秒内没有进程才回退；`DSH_HUD_USE_TASK=1` 可强制走计划任务。
- 自动清理旧版本留下的 `dsh-hud-launch` 计划任务（默认模式下）。
- 子进程环境会剔除 `ELECTRON_RUN_AS_NODE`，避免被当纯 Node 进程启动、没有窗口。

## 修复

- **「检查更新」不再无限挂起**：清单请求 15 s 超时、asar 下载 120 s 超时；超时自动切下一个清单源，全部失败会弹「检查更新失败」并写明原因。线上验收时实测：直连 `github.com` 在本机会卡住 3 分钟以上（同一 URL 用 node 的 fetch 只要 0.7 s），旧代码没有任何超时，界面会一直停在“检查中”。
- 新增单测守住这条：manifest 与 asar 两次请求都必须带 `AbortSignal`。

## 线上验收（2026-11-18）

用一个预发布清单走完了真实的应用内更新：0.5.4 → 0.5.5，asar 510,459 B 经 `ghfast.top` 镜像 5.5 s 下载、sha256 校验通过、helper 替换并自动重启；重启后命令面板出现新条目，再点「检查更新」返回「已是最新版本」。

## Planned（未完成，见 `docs/roadmap.md`）

- **R-1 代码签名**：本版只去掉了「计划任务自动拉起」这一条特征，**`DSH HUD.exe` 仍未签名**，第一次运行时 SmartScreen / 悟空 / 360 / 火绒仍可能提示一次。签名方案（Azure Trusted Signing → OV → EV）与构建链改造记录在 roadmap，目标是 0.6.x。
- **R-2 GitHub 路线换机验收**：npm 路线已在第二台机器通过；GitHub 路线需要目标机器先装 git（`github:` 走 `git ls-remote`）。
- **R-3 安装包瘦身**：当前 zip 158.6 MB，Electron 运行时占大头。

## 安装

- **推荐**：在 DSH 里装插件 `dsh-hud-capsule`（`dsh-hud-capsule@0.5.5`），首次运行会自动下载应用包。
- 兜底：Release 里下载 `DSH-HUD-0.5.5-win-x64.zip`，解压后双击 `DSH HUD.lnk`；或在 DSH 里填 `github:suianest/dsh-hud`（需要 git）。

## 校验

- `app.asar` sha256：见 `manifest.json`
- zip sha256：见下方附件说明

---

# DSH HUD v0.5.5 (English)

The default launcher now spawns the app directly from the plugin process instead of registering a scheduled task — the scheduled task was the main trigger for AV false positives.

- No more `dsh-hud-launch` task by default; the plugin spawns `DSH HUD.exe` itself (`--no-sandbox` + writable `--user-data-dir`).
- The scheduled task is now a fallback only (used when the direct spawn produces no process within 6s); `DSH_HUD_USE_TASK=1` forces it.
- Legacy `dsh-hud-launch` tasks are removed automatically in the default mode.
- `ELECTRON_RUN_AS_NODE` is stripped from the child environment so the app never starts as a headless Node process.

**Planned (not done yet):** code signing (R-1) — the exe is still unsigned, so the first run may still trigger SmartScreen / Chinese AV prompts. See `docs/roadmap.md`. Also planned: GitHub-route acceptance on a machine with git (R-2) and installer slimming (R-3).
