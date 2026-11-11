# t29 开箱可移植性验收报告

- 日期：2026-11-08
- 任务：复核 t26（app 可移植化）、t27（plugin 可移植化）、t28（setup 脚本），补齐 README / ENVIRONMENT
- 尝试：attempt 3，attempt_id `9baff921-501f-4253-9fa1-c6becb063d02`
- 结论：**通过（有环境偏差与未联网验证边界）**

## 1. 逐项结论

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| 1 | app/plugin/scripts 无 `D:\DeepSeekData` / `C:\Users\` / `D:\deepseek` | **通过** | 代码 0 命中；仅 `app/docs` 9 行历史示例，已列白名单；见 §2 |
| 2 | 临时副本 node --check / 三个单测 / setup --offline | **通过（有环境偏差）** | 副本 38 JS 全 0；三个指定单测 26/26（加 config 30/30）；setup --offline exit 1 且给出可执行指引；见 §3 |
| 3 | 仓库移动后 plugin 路径推导仍成立 | **通过** | `tests/e2e/unit/plugin-relocation.test.mjs`，原仓库与副本各 1/1 |
| 4 | `docs/environment.md` 环境与不可适配项 | **通过** | 支持矩阵、setup 行为、8 类无法自动适配项；见 §5 |
| 5 | README 顶部 5 行快速开始 | **通过** | README.md:7-13；构建段改为仓库相对路径；见 §5 |
| 6 | 全量回归 | **通过** | 原仓库 30/30 unit（4 文件）、plugin 13/13、relocation 1/1；见 §6 |

最终判定：**可以对外宣称“可移植、可离线检查”**。启动链的 launcher 诊断日志已改为 env / repo / OS temp 推导，不再写死构建机路径；仅剩沙箱环境导致的副本路径偏差，以及未联网下载 Electron、未启动真实 GUI 两项边界。

## 2. 硬编码扫描

扫描范围：`app/`、`plugin/`、`scripts/`，排除 `node_modules`；输出见 `tests/e2e/logs/t29-v3-grep.txt`。

| 搜索 | 命中 |
|---|---|
| `DeepSeekData` | `app/docs/{control-bridge,web-embed,window-skeleton}.md` 共 9 行（**文档历史，白名单**）；`app/`、`plugin/`、`scripts/` 的运行代码 0 命中 |
| `C:\Users` | 0 |
| `D:\deepseek`（含 JS 双反斜杠写法） | 0 |

### 2.1 launcher 日志路径（attempt 2 的阻塞项，已修复）

attempt 2 发现 `app/scripts/launch-hud.cjs:20` 为：

```js
const LOG = 'D:\\DeepSeekData\\workspace\\dsh-hud\\artifacts\\plugin-diag.log';
```

现已改为（`app/scripts/launch-hud.cjs:20-30`）：

```js
function resolveLog() {
  const explicit = process.env.DSH_HUD_DIAG_FILE;
  if (explicit) return explicit;
  const appDir = process.env.DSH_HUD_APP_DIR;
  if (appDir) return path.join(path.dirname(appDir), 'artifacts', 'launcher.log');
  return path.join(os.tmpdir(), 'dsh-hud-launch.log');
}

const LOG = resolveLog();
```

行为：插件传入 `DSH_HUD_DIAG_FILE` 时用显式路径；否则写到 `<repo>/artifacts/launcher.log`；再退到 `os.tmpdir()`。`mkdirSync(..., {recursive:true})` 保证父目录存在，`appendFileSync` 仍保留 try/catch。

### 2.2 白名单（文档历史，不作为运行路径）

`app/docs/` 是开发/历史说明，示例中包含本机路径，不影响运行：

- `app/docs/control-bridge.md:80,109,118`
- `app/docs/web-embed.md:63`
- `app/docs/window-skeleton.md:77,84,85,102,110`

另外 `app/src/config.js:83` 的 `'deepseek'` 是 `%LOCALAPPDATA%\Programs\deepseek\DeepSeek Harness.exe` 的相对目录名，不是 `D:\deepseek`，属于 DSH 安装位置自动探测，**不是硬编码**。

## 3. 临时副本验证

### 3.1 路径偏差（必须记录）

任务要求复制到：

```
C:\Users\35263\AppData\Local\Temp\dsh-hud-portable-test
```

本会话是 workspace-write 受限子代理，`mkdir` 该目录返回 `Permission denied`（未重试、未申请提权）。为完成可移植性验证，改在 workspace 内复制：

```
D:\DeepSeekData\workspace\.portable-test-v3\dsh-hud
```

副本内容：`app/`、`plugin/`、`scripts/`、`tests/`、`docs/`、`README.md`、`README-ENV.md`、`pnpm-workspace.yaml`；显式排除 `node_modules`、`runtime`、`artifacts`、`dist`、`spike`、缓存目录。清单见 `tests/e2e/logs/t29-v3-js-files.txt` 与 `tests/e2e/logs/t29-v3-check.txt`：149 files，上述目录均 absent，`config.local.json` absent（模拟全新 clone）。副本与当前源码的 `app/scripts/launch-hud.cjs` SHA-256 一致（`5041720c3757ea79...`），排除了“复制到旧快照”的风险。

### 3.2 结果

| 命令（副本内，bundled Node 24） | 结果 | 日志 |
|---|---|---|
| `node --check` 所有 `.js/.cjs/.mjs`（38 个） | `TOTAL=38 PASS=38 FAIL=0`，exit 0 | `tests/e2e/logs/t29-v3-check.txt` |
| `node --test --test-isolation=none core/hud-window/main-boot` | 26 tests / 26 pass / 0 fail，exit 0 | `tests/e2e/logs/t29-v3-unit.txt` |
| 同上 + `config.test.cjs`（额外验证 config 解析） | 30 tests / 30 pass / 0 fail，exit 0 | `tests/e2e/logs/t29-v3-unit4.txt` |
| `node scripts/setup.mjs --offline` | 识别 electron missing；打印 4 步 Manual fallback；exit 1；未创建 config.local.json | `tests/e2e/logs/t29-v3-setup-offline.txt` |
| `node --test ... plugin-relocation.test.mjs` | 1/1 pass，exit 0 | `tests/e2e/logs/t29-v3-portable-relocation.txt` |

`setup --offline` 的关键输出：

```
[setup] electron@44.7.0: missing
[setup] offline check FAILED: electron not present. See manual fallback below.
[setup] Manual fallback — prepare electron yourself:
[setup]   1. In a networked terminal run:  npm install electron@44.7.0
[setup]   2. Copy the result so the binary lands at:
[setup]      ...\runtime\node_modules\electron\dist\electron.exe
[setup]   3. Re-run:  node scripts/setup.mjs --offline
[setup]   4. Then re-run:  node scripts/setup.mjs   (to write config.local.json)
```

这是**预期行为**：缺少 runtime 时明确报错并给出可执行指引，不是崩溃。未验证联网下载（本轮只跑 `--offline`）。

说明：副本内没有 `runtime/node_modules/electron`，`plugin.test.mjs` 的 spawn 分支会按设计降级为 “skipping spawn: missing or unset electronPath”，因此**不以副本 plugin.test 作为移动后集成结论**；plugin 回归在原仓库跑（§6），移动后路径由专门的 relocation 测试覆盖（§4）。

## 4. 仓库移动后的 plugin 路径

`tests/e2e/unit/plugin-relocation.test.mjs`（只加测试，不改 plugin）：

1. 在临时目录创建 `moved-repo/plugin/index.js` 和 `moved-repo/app/scripts/launch-hud.cjs`；
2. 创建假的 `moved-repo/runtime/node_modules/electron/dist/electron.exe`；
3. 用该副本的 `import.meta.url` 导入 plugin，`spawnApp=true`，mock subprocess；
4. 断言 spawn 的 `cwd === moved-repo/app`、`argv[1] === moved-repo/app/scripts/launch-hud.cjs`、`DSH_HUD_APP_DIR`/`DSH_HUD_ELECTRON` 都指向 moved-repo。

结果：原仓库 1/1（`tests/e2e/logs/t29-v3-original-relocation.txt`），副本 1/1（`tests/e2e/logs/t29-v3-portable-relocation.txt`）；日志中实际输出 `spawned HUD ...\moved-repo\app`。这证明 `plugin/index.js:66-69` 的 `REPO_ROOT` 推导在移动后成立，而不是依赖构建机路径。

## 5. README 与 ENVIRONMENT

- `README.md` 第 7-13 行新增 5 步快速开始：clone → `node scripts/setup.mjs` → 安装 `plugin/` → 启动 HUD → 右键胶囊勾选自启。
- `README.md` 构建段的绝对路径已改为仓库相对 `app\scripts\build-portable.cmd`，并说明复用 `runtime/node_modules/electron/dist`（由 setup 准备）。
- 新增 `docs/environment.md`：
  - 支持矩阵：Windows 10 1809+/11 x64、Node >= 20、Electron 44.7.0、PowerShell 5.1、DSH 0.2.x、无需管理员；
  - `setup` 行为、参数、`config.local.json` 与环境变量优先级；
  - 8 类“无法自动适配/必须 setup/人工”的项：宿主子进程 Electron 崩溃、Startup 低完整性、Explorer 代启动需人工确认、DSH 安装路径/标题、Web UI 类名漂移、GPO/杀软、混合 DPI、热键冲突；
  - 首次运行检查清单与证据边界。

## 6. 全量回归（原仓库）

| 命令 | 结果 | 日志 |
|---|---|---|
| 38 个 app/plugin/scripts/tests JS `node --check`（排除 node_modules） | `TOTAL=38 PASS=38 FAIL=0` | `tests/e2e/logs/t29-v3-original-static.txt` |
| core + hud-window + main-boot + config 单测 | 30 tests / 30 pass / 0 fail，exit 0 | `tests/e2e/logs/t29-v3-original-unit.txt` |
| plugin 单测 | 13 tests / 13 pass / 0 fail，exit 0 | `tests/e2e/logs/t29-v3-original-plugin.txt` |
| relocation 单测 | 1/1，exit 0 | `tests/e2e/logs/t29-v3-original-relocation.txt` |

## 7. 未闭环 / 边界

1. 副本路径未能按任务要求放在 `C:\Users\...\Temp`，因沙箱拒绝；已在 workspace 内等价验证并记录（§3.1）。这不影响“副本无 runtime/node_modules、能独立检查”的结论。
2. 未执行联网下载 Electron；`setup.mjs` 的下载分支（npm → npmmirror）本轮只做了代码核对和 `--offline` 行为验证。
3. 未启动真实 GUI；本轮范围是路径/配置/脚本可移植性，不涉及渲染。
4. 副本内未把 `plugin.test.mjs` 当作通过项（缺 runtime 会按设计跳过 spawn），移动后路径由 relocation 测试覆盖。

## 8. 复核判定

- 结论：**通过**。attempt 2 的唯一代码级阻塞项（launcher 日志硬编码）已修复并经 grep / 副本 / 原仓库回归复核。
- 验证链：grep 代码 0 命中 → 38 JS check → 30/30 unit → plugin 13/13 → relocation 原仓库与副本各 1/1 → setup --offline 明确退出 1 并给手动指引。
- 建议：发布前在联网环境跑一次 `node scripts/setup.mjs`（真实下载 Electron 44.7.0），并在普通终端启动一次 GUI；两项均已在 §7 标注为环境边界，不属于本轮代码阻塞。
