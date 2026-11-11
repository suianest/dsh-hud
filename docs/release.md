# 发布流程（Release）

面向维护者的发版步骤。按顺序执行，每步都有可核对的输出；不要求真在 CI 里跑。

产物只有一个：**便携 zip**（解压即用，无安装器）。插件不进 zip，随仓库发布。

---

## 0. 前置条件

- Windows x64，Node.js ≥ 20（只有构建机需要；HUD 运行时用打包 Electron 内置的 Node）。
- 构建机已有 `runtime/node_modules/electron/dist/electron.exe`（44.7.0）。没有就跑：

  ```bat
  node scripts\setup.mjs
  ```

  它会检查版本、必要时下载 Electron 44.7.0（~150 MB）、写 `config.local.json`。
- 版本号已改：`app/package.json` 的 `version`；插件 `plugin/package.json` 独立版本。
  改动通信协议时，两侧 `protocolVersion` 必须同时加。
- `CHANGELOG.md` 已写好对应版本的条目（发版正文直接复制）。

## 1. 语法检查

```bat
app\scripts\check-hud.cmd
```

对 `main.js`、`preload.js`、`src/*.js`、`renderer/*.js` 逐个 `node --check`。
改过代码的话再跑一遍单测：

```bat
node --test
```

任何一步失败都不要出包。

## 2. 打包

在**仓库根目录**执行：

```bat
node app\scripts\make-portable（会自动产出 `dist/DSH-HUD-<version>-win-x64.zip`）.js
```

脚本做四件事，任一断言失败都会以非 0 退出：

1. `assertSourceFiles()`：22 个 canonical 源文件（`main.js`、`src/*.js`、`renderer/*`、
   `scripts/focus-dsh.ps1`、`scripts/launch-hud.cjs` …）缺一即停；
2. 全量重建 `dist/win-unpacked/`（Electron 44.7.0 + `app.asar`，不残留旧版本 dll）；
3. `assertAsarContents()`：asar 内必须包含同一份 22 个 canonical 条目；
4. 收尾：`electron.exe` → `DSH HUD.exe`，补 `启动 DSH HUD.cmd`、`DSH HUD.lnk`、
   `resources/artifacts` 目录联接。

核对输出（数字与路径应一致）：

```text
[make-portable] source files assertion OK (22 canonical files present)
[make-portable] asar content assertion OK (22 canonical entries present)
[make-portable] app.asar entries: <N>
[make-portable] exe: ...\dist\win-unpacked\DSH HUD.exe OK
[make-portable] app.asar: ...\dist\win-unpacked\resources\app.asar <bytes> bytes
[make-portable] done: ...\dist\win-unpacked
```

看到 `ASSERTION FAILED` 或 `MISSING` 就回去修源文件，**不要**手工往 asar 里补文件。

> 需要图标/版本资源时用 `app\scripts\build-portable.cmd`（electron-builder）；但它在
> agent 沙箱内可能因 spawn 限制失败，日常发版以 `make-portable.js` 的产物为准。

## 3. 冒烟

```bat
app\scripts\run-hud.cmd
```

逐项确认：胶囊出现 → 点击展开 520×720 面板 → 内嵌页能发消息并流式回复 → 右键菜单五项可用 →
「收起 / 关闭」正常。可选跑 `app\scripts\verify-hud.cmd` 做自动检查。

## 4. 打 zip

PowerShell 5.1+：

```powershell
$v = (Get-Content app\package.json -Raw | ConvertFrom-Json).version
Remove-Item dist\win-unpacked\udd -Recurse -Force -ErrorAction SilentlyContinue
Compress-Archive -Path dist\win-unpacked\* -DestinationPath "dist\DSH-HUD-$v-win-x64.zip" -Force
```

- 命名固定 `DSH-HUD-<version>-win-x64.zip`（历史产物：`dist\DSH-HUD-0.2.0-win-x64.zip`）。
- `udd\` 是构建机的用户数据目录，先删掉再压，避免把登录态/位置发出去。
- 若存在 `extensions\` 且里面有第三方脚本，确认它们允许随包分发后再压。

## 5. 核对产物

| 检查项 | 期望 |
| --- | --- |
| `dist\win-unpacked\DSH HUD.exe` | 存在（`make-portable.js` 不写 exe 图标/版本资源；需要资源信息时改跑 `build-portable.cmd`） |
| `resources\app.asar` | 含 `scripts/focus-dsh.ps1`、`scripts/launch-hud.cjs`（第 2 步断言已保证） |
| zip 解开后双击 | 干净机器上能出胶囊；出错时先看第 7 节 |
| zip 大小 | ~150 MB（Electron 占绝大部分） |

## 6. GitHub Release

1. 打标签并推送：`git tag v<version>` → `git push origin v<version>`。
2. Release 标题：`v<version> — <一句话>`；正文从 `CHANGELOG.md` 对应小节复制。
3. **必须上传** `DSH-HUD-<version>-win-x64.zip`。只发源码 zip 用户跑不起来。
4. 插件不进 Release：它随仓库发布，用户在 DSH 里通过插件市场或
   `github:<user>/dsh-hud` 安装（`plugin/package.json` 的 `dsh.bundle.patch` 指向
   `plugin/cordis.patch.yml`）。
5. 首次使用说明贴 README 的「快速开始」三步：装插件 → 下载解压 → 双击 / 勾选开机自启。

## 7. Release 说明里必须写的「已知限制」

> **宿主子进程直接启动 Electron 会崩。** 在 DSH 宿主进程的受限 / 低完整性令牌下，
> Chromium 子进程会在 `platform_channel.cc` 报 `拒绝访问 (0x5)` 并以
> `-2147483645` 退出，这不是安装失败。
>
> 因此插件默认 `spawnApp=false`、`shellLaunch=false`：请用**登录自启**或**双击
> `DSH HUD.exe`** 启动。需要手动拉起时，插件会提示而不是静默失败。

同时附上 `docs/environment.md` 第 3 节的「无法自动适配」表（GPO 禁 Run、未签名 exe 的
SmartScreen、混合 DPI、热键被占用等）。

## 8. 回滚与撤回

- 用户侧卸载：README「卸载」四步（取消自启 → 退出 → 删目录 → 删
  `%LOCALAPPDATA%\dsh-hud\`）。
- 维护侧：`git revert` 对应提交，发一个 patch 版本。
- 已发布的 zip **不要**用同名文件覆盖：GitHub Release 保留历史附件，便于用户回退。
