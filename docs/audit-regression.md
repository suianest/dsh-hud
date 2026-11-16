# t42 回归与流程可执行性验证

- 复核时间：2026-11-16 13:00–13:50（Asia/Shanghai）
- 仓库：`D:\DeepSeekData\workspace\dsh-hud`
- 环境：Windows 11 x64；bundled Node v24.21.0；bundled pnpm；DSH Web GUI `http://127.0.0.1:57756`；Git HEAD `927cd4a`（`init: DSH HUD 0.3.0`），无 tag，工作树 46 项 modified/untracked。
- 边界：未修改产品代码；未启动/终止 HUD；未重建 `dist/`；网络不可用，两项需要 GitHub 的脚本只能记录为“未验证”。

## 0. 结论

**不通过（release-blocked）。**

单测、语法检查、`check-hud`、`pnpm pack` 本身均通过；但**当前 `dist/` 不是当前源码的产物**：`src/config.js` 与 `scripts/check-hud.cmd` 在打包后又被修改，asar 内仍是旧版本（详见 §3）。同时 0.4.1 的源码未提交、无 tag，安装器资产也没有进入发布流程。因此当前树上的 0.4.1 不能作为可复现、可发布的候选。

阻塞项：**B1 陈旧 dist**。发布前必须退出正在运行的 HUD，重建 `dist/`，重新生成 zip 与 manifest，并复跑本报告 §2 的检查。

## 1. 全量单测

### 1.1 任务给出的命令在受限沙箱不可用

逐个文件执行：

```powershell
node --test --test-force-exit tests/e2e/unit/<file>
```

9 个文件全部失败，均为：

```text
Error: spawn EPERM
errno: -4048, code: 'EPERM', syscall: 'spawn'
```

原因：`node --test` 默认给每个测试文件 spawn 子进程，DSH 受限令牌下 `CreateProcess` 被拒绝。这不是测试失败，而是执行方式不兼容。

### 1.2 改用单进程隔离后全部通过

```powershell
node --test --test-isolation=none --test-force-exit tests/e2e/unit/<file>
```

在 13:31 代码变更后重跑（`plugin/index.js` 13:29:07、`check-hud.cmd` 13:31:47）：

| 套件 | 结果 |
|---|---|
| config.test.cjs | 4/4 |
| core.test.cjs | 5/5 |
| extensions.test.cjs | 6/6 |
| hud-window.test.cjs | 29/29 |
| main-boot.test.cjs | 2/2 |
| shortcut.test.cjs | 6/6 |
| updater.test.cjs | 8/8 |
| plugin-relocation.test.mjs | 1/1 |
| plugin.test.mjs | 20/20 |
| **合计** | **81/81，FAIL=0** |

与 `AGENTS.md` 记录的 81/81 一致（plugin 当前为 20 条）。任务文本中的“27+ 个 JS”在当前树已增长；本报告按实际文件计数。

## 2. 关键脚本与产物

### 2.1 语法检查与 check-hud

```powershell
# app/plugin/tools/tests/scripts 下全部 JS/CJS/MJS
node --check <each>
# 结果
TOTAL=48 PASS=48 FAIL=0
```

```powershell
cmd /c app\scripts\check-hud.cmd
# 结果
18 个文件 PASS
RESULT=ALL_PASS
exit 0
```

`check-hud.cmd` 的 mtime 为 13:31:47，已包含 `updater.js`、`shortcut.js`、`extensions.js`；18 项全部存在。

### 2.2 make-portable：因 HUD 正在运行，只做静态审查

`Get-Process -Name 'DSH HUD'` 返回 **5 个进程**，路径全部是：

```text
D:\DeepSeekData\workspace\dsh-hud\dist\win-unpacked\app\DSH HUD.exe
```

这 5 个是同一个 Electron 应用的主进程/GPU/renderer 子进程（不是 5 个独立实例）。为避免打断用户正在使用的 HUD，**未执行** `node app/scripts/make-portable.js --no-zip`。

静态审查（`app/scripts/make-portable.js`，340 行）：

- `CANONICAL_FILES` 是静态数组，共 **25 项**，包含 `scripts/focus-dsh.ps1`、`scripts/launch-hud.cjs`、`src/hud-window.js`、`renderer/host-bounds.js` 等。
- `assertSourceFiles()`：源文件缺任一即 `process.exit(1)`。
- `assertAsarContents()`：asar 缺任一 canonical 项即 `process.exit(1)`。
- 通过后全量重建 `dist/win-unpacked/`。

本次未构造缺件、未执行脚本；缺件路径的代码审查结论为“会非 0 退出”，但没有本轮执行证据，报告不把它计为已验证。

### 2.3 verify-release 与安装器 CheckOnly：被网络阻断

```powershell
node tools/verify-release.mjs
# 4 次 download attempt N/4 failed: fetch failed
# download failed: fetch failed
# exit 1
```

```powershell
powershell -File installer/install-dsh-hud.ps1 -CheckOnly
# [X] 查询 GitHub 失败：基础连接已经关闭: 接收时发生错误。
# exit 1
```

两者都依赖 GitHub API/下载，离线不可验证；**不能据此判定脚本代码有缺陷**，但“最新版本可查”未闭环。

### 2.4 pnpm pack

使用 bundled pnpm 打包成功：

```text
package: dsh-hud-capsule@0.4.1
tarball: artifacts/dsh-hud-capsule-0.4.1.tgz
size: 25847 bytes
sha256: 0f1acaada0785b05becaf1ea96a9978010da89506b99363a5323083e7ce3d0ab
```

10 个文件：

```text
package/LICENSE
package/package.json
package/README.md
package/cordis.patch.yml
package/plugin/index.js
package/plugin/package.json
package/plugin/cordis.patch.yml
package/plugin/icon.svg
package/plugin/locale/en.json
package/plugin/locale/zh.json
```

清单完整；root `package.json` 的 `files=3`（`README.md`、`cordis.patch.yml`、`plugin/`）与产物一致。`docs/install-via-npm.md` 写的 25.8 KB 与本轮 25,847 B 基本一致，此项**通过**。

## 3. 产物一致性：发现 B1 陈旧 asar

### 3.1 版本与 zip

```text
dist/win-unpacked/app/version             44.7.0
dist/win-unpacked/app/DSH HUD.exe         FileVersion/ProductVersion 44.7.0
dist/win-unpacked/app/resources/app.asar  504863 B
                                          sha256 2b99723cde0f50c340a82886ea8058f9fbade3a42ae3db38ac954b67c4046ea6
manifest.json                             appAsar size 504863，sha256 2b99723c...6ea6
dist/DSH-HUD-0.4.1-win-x64.zip            158635388 B，mtime 2026-11-15 19:07:10
zip 内 app/resources/app.asar             504863 B，sha256 2b99723c...6ea6（与 manifest 一致）
zip 内 app/version                        6 B（44.7.0）
zip 内 DSH HUD.lnk                        1362 B
zip 内 manifest.json                      245 B
```

也就是说：`manifest.json`、zip 内 asar、`dist/win-unpacked` 的 asar **三者内部一致**，但都是 2026-11-15 19:02 构建的旧 asar。

### 3.2 与当前源码逐文件比较（`@electron/asar` extractFile）

| 文件 | asar 内 | 当前源码 | 结论 |
|---|---|---|---|
| `src/config.js` | 5611 B / `5356bf9f308007b9…` | 5991 B / `90e1eac5ce30e2e8…` | **DIFF** |
| `scripts/check-hud.cmd` | 1147 B / `eb6be00bc7027f91…` | 1196 B / `2d29832b750b17d6…` | **DIFF** |
| `src/hud-window.js` | 59807 B / `1c533cb4ac8f89b4…` | 59807 B / 同 | MATCH |
| `renderer/hud.js` | 14568 B / `6859e6f5b3f38097…` | 14568 B / 同 | MATCH |

当前源码 mtime：`src/config.js` 2026-11-16 13:15:54，`scripts/check-hud.cmd` 13:31:47；asar mtime 为 2026-11-15 19:02:22。**改动发生在打包之后**，所以当前 dist/zip 不是当前源码的产物。这会让 0.4.1 安装包继续携带旧的 `config.js` 和旧的 `check-hud.cmd`，即使 manifest 的 hash 自洽。

修复动作（需要用户侧先退出 HUD）：

1. 确认 `Get-Process -Name 'DSH HUD'` 为 0；
2. `node app/scripts/make-portable.js --no-zip`；
3. 重跑 §1 的 81/81 与 §2.1 的 48/48、18/18；
4. 重新压 zip，更新 `manifest.json` 的 size/sha256；
5. 用 §3.2 的逐文件比较确认全部 MATCH。

## 4. 文档、版本与发布流程一致性

| 项 | 证据 | 判定 |
|---|---|---|
| 根/app/plugin/manifest/README/CHANGELOG 版本 | 0.4.1 / 0.4.1 / 1.1.0 / 0.4.1 / 0.4.1 / 0.4.1 | 通过（plugin 独立版本） |
| `docs/release.md` canonical 数量 | 正文写 22、24，样例输出 22；实际 `CANONICAL_FILES=25` | **不通过（medium）** |
| README 路线 A 安装器资产 | README:51/63 要求 Release 下载 `安装 DSH HUD.cmd`；`docs/release.md §8` 只列 zip + app.asar；仓库无 release workflow（`.github` 仅 issue 模板） | **不通过（high，远端附件未验证）** |
| `app/package.json` 的 `scripts.check` | 15 个文件；`check-hud.cmd` 18 个，缺 `updater.js`/`shortcut.js`/`extensions.js` | **不通过（medium）** |
| `docs/portability.md` | 仍写 npm 包 `dsh-hud@0.4.0` 与旧 files 列表；实际 root `dsh-hud-capsule@0.4.1`，files=3 | **不通过（medium）** |
| `README.md` discovery 示例 | 示例 port 50265；当前 57756 | 观察（low，示例性） |
| `docs/install-via-npm.md` 包体积 | 25.8 KB；实际 25,847 B | 通过（此前“27.5KB”猜测不成立） |

## 5. .gitignore 实际生效

```powershell
git check-ignore -v .ph-token.txt *.token dist artifacts 操作日志
```

- `.ph-token.txt`、`*.token`、`dist/`、`artifacts/`、`操作日志/` 均命中；
- exit 0，无未忽略项。

结论：**通过**。

## 6. 自启、计划任务与 discovery

### 6.1 自启条目

最终快照（13:37:01 重写后）：

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dsh-hud.cmd
start "" "D:\DeepSeekData\workspace\dsh-hud\dist\win-unpacked\app\DSH HUD.exe" --no-sandbox --user-data-dir="D:\...\dist\win-unpacked\udd"
```

target 存在；`dist/win-unpacked/udd/autostart.json` 为 `{"enabled": true}`。

复核期间曾出现一次瞬时旧值：13:26 首读时该文件指向已删除的 `C:\Users\35263\AppData\Local\Temp\dsh-hud-exe-cWO7Ht\DSH HUD.exe`，13:37:01 被重写为上面的有效路径。报告以重写后的快照为准；但说明该文件会被安装/启动流程重写，验收时需注明读取时间。

### 6.2 计划任务

```text
schtasks /Query /TN dsh-hud-launch
ERROR: The system cannot find the path specified.
```

全表没有 `dsh-hud` 任务。当前启动路径是 Startup 文件，不是计划任务；若期望 `/dsh-hud on` 的计划任务模式，需要先执行该命令后再验。“当前不存在”本身不构成本次启动失败，但属于未覆盖路径。

### 6.3 discovery

```json
{
  "pid": 27368,
  "port": "57756",
  "updatedAt": "2026-11-16T05:50:04.975Z",
  "protocolVersion": 1
}
```

端口与当前 DSH Web GUI `57756` 一致，读取时 age 约 0 分钟；token 未写入报告。

## 7. Git 与发布可复现性

```text
HEAD            927cd4a  init: DSH HUD 0.3.0 — floating capsule for DeepSeek Harness
git tag -l      空
工作树          46 项 modified/untracked
```

0.4.1 的全部源码改动未提交、无 tag，当前发布物无法从 git 复现，也无法用 tag 回滚。**high**。

requiredFix：提交 0.4.1 改动，打 `v0.4.1` tag，再执行打包与发布。若 0.4.1 已发布，仍需补 tag 与源码提交，否则后续 patch 无法定位基线。

## 8. 逐项通过/失败清单

| 编号 | 项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 全量单测 81/81 | 通过 | §1.2；需 `--test-isolation=none` |
| 2 | 48 个 JS 语法检查 | 通过 | §2.1 |
| 3 | check-hud 18/18 | 通过 | §2.1 |
| 4 | make-portable 实际重建 | **未执行** | 5 个 HUD 进程占用；仅静态审查 |
| 5 | verify-release | 未验证 | 网络 fetch failed |
| 6 | installer -CheckOnly | 未验证 | 网络 GitHub 查询失败 |
| 7 | pnpm pack 清单 | 通过 | 25,847 B，10 文件 |
| 8 | 版本号一致 | 通过 | 0.4.1 / 1.1.0 |
| 9 | dist 与当前源码一致 | **不通过（blocker）** | config.js / check-hud.cmd DIFF |
| 10 | zip/manifest 内部一致 | 通过 | asar 504863 / 2b99723c… |
| 11 | release 文档 canonical 数量 | **不通过（medium）** | 22/24 vs 25 |
| 12 | installer 进入发布流程 | **不通过（high）** | README 要求，release 文档未列 |
| 13 | app 的 npm check 覆盖 | **不通过（medium）** | 15 vs 18 |
| 14 | portability 文档版本 | **不通过（medium）** | 仍写 0.4.0 |
| 15 | gitignore | 通过 | git check-ignore 全部命中 |
| 16 | 自启最终快照 | 通过 | 13:37 重写后 target 存在 |
| 17 | 计划任务 | 观察 | 不存在；当前走 Startup |
| 18 | discovery 端口 | 通过 | 57756，与 GUI 一致 |

## 9. 未闭环/需要人工执行

1. **B1（blocker）**：退出 HUD → 重建 dist → 重跑测试 → 重打 zip/manifest → 逐文件 hash 复核。
2. **B2（high）**：提交 0.4.1 源码并打 `v0.4.1` tag。
3. **H1（high）**：把 `安装 DSH HUD.cmd` 加入 Release 发布清单/自动上传，或改 README 指向仓库 raw；远端附件本次因网络无法核实。
4. **网络**：`verify-release.mjs` 与 `installer -CheckOnly` 需要可访问 GitHub 的环境复跑。
5. **make-portable 实际执行**：需在无 HUD 进程时执行；本报告只有静态审查。
6. **计划任务模式**：若产品承诺 `/dsh-hud on` 创建计划任务，需在干净环境执行并检查任务/Startup 二选一。

## 10. 证据命令索引

- `node --test --test-isolation=none --test-force-exit tests/e2e/unit/<file>` → 81/81
- `node --check`（app/plugin/tools/tests/scripts 下 48 个 JS）→ 48/48
- `cmd /c app\scripts\check-hud.cmd` → RESULT=ALL_PASS
- `node tools/verify-release.mjs` → exit 1（网络）
- `powershell -File installer/install-dsh-hud.ps1 -CheckOnly` → exit 1（网络）
- `pnpm pack` → `artifacts/dsh-hud-capsule-0.4.1.tgz`，25,847 B
- `@electron/asar.extractFile` 对比 asar ↔ 源码 → config.js/check-hud.cmd DIFF
- `unzipper` 读取 zip 内 asar → 504863 / 2b99723c…，与 manifest 一致
- `git check-ignore -v` → 全部命中
- `schtasks /Query /TN dsh-hud-launch` → 未找到
- `Get-Process -Name 'DSH HUD'` → 5 个同路径 Electron 进程
