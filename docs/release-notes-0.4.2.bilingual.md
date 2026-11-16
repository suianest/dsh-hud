# DSH HUD 0.4.2

审计驱动的一轮修复：26 条问题里修掉 1 个 blocker、4 个 high 与 2 个 medium，全部是稳定性问题，没有新功能。
An audit-driven fix release: one blocker, four highs and two mediums from the code audit — stability only, no new features.

## 修了什么 / What changed

- **首次安装后不刷新应用定位**（blocker）：装完插件后「随 DSH 启动 / 计划任务 / 快捷方式」要重启 DSH 才生效。现在安装成功后立即重新解析。
- **启动链单点失败会跳过后续步骤**：discovery 写失败会连带跳过自启、任务、快捷方式。现在每段独立 try/catch。
- **老用户拿不到计划任务**：原来只给首次运行注册，已有自启记录的用户永远不会重注册。
- **打包版「打开 DSH 桌面窗口」必超时**：HUD 与插件找的 IPC 目录不一致（构建机靠 junction 掩盖）。现在两端都指向 `<安装目录>/artifacts/ipc`。
- **自动安装无超时/镜像/大小校验**：加 30s 清单超时、180s 下载超时、失败自动走 `ghfast.top` 镜像、校验 `asset.size`。
- **安装器覆盖运行中的 HUD**：解压前检测进程并提示结束，避免半更新状态。
- **打包清单漏 `src/config.js`**、**更新器不校验 manifest.size**、**check-hud 清单缺 3 个文件**、**登录项可能指向临时目录 exe**：均已修。

## 安装 / Install

1. 下载 `DSH-HUD-0.4.2-win-x64.zip`（约 151 MB）并解压到有写权限的目录。
2. **双击目录里的 `DSH HUD.lnk`**（不要双击 `app\DSH HUD.exe`，它必须带启动参数）。
3. 想接进 DSH：DSH → 设置 → 插件 → 添加插件 → 填 `dsh-hud-capsule`，重启 DSH 即可；也能在 DSH 里用 `/dsh-hud on|off|status` 开关胶囊。
4. 一键安装（可选）：下载 `安装 DSH HUD.cmd` 双击，脚本会自己下载、解压、问你要不要启动。

1. Download and unzip `DSH-HUD-0.4.2-win-x64.zip` into a writable folder.
2. **Double-click `DSH HUD.lnk`** — never `app\DSH HUD.exe` (it needs the flags from the shortcut).
3. Optional: add the plugin inside DSH with the package name `dsh-hud-capsule`, then use `/dsh-hud on|off|status`.
4. One-click install: run `安装 DSH HUD.cmd` (the file name is Chinese, it just starts the installer); it downloads, unzips, and offers to launch.

## 校验 / Verify

```powershell
certutil -hashfile "DSH-HUD-0.4.2-win-x64.zip" SHA256
```

- zip：`0daf8d816bb74f0c1af43a527ca11c7f6968cc76b089797227acd70461c19db1`（158,635,653 B）
- app.asar：`d81c03753f55f0b0df4235dc59ac8e1ea9d0141c0690f852177a97dd0f5f317c`（505,627 B）

## 已知限制 / Known limits

- 未签名，首次运行会出现 SmartScreen：点「更多信息 → 仍要运行」。
- 公司电脑可能被组策略拦计划任务，此时「随 DSH 启动」不生效，手动双击 `DSH HUD.lnk` 即可。
- 插件形态下若安装目录不在 `%LOCALAPPDATA%\DSH HUD`，需要通过 `hudDir` 或 `DSH_HUD_DIR` 指路。

完整改动见 [CHANGELOG](https://github.com/suianest/dsh-hud/blob/main/CHANGELOG.md)。
