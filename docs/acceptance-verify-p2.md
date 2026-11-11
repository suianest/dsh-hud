# DSH HUD — P2 修复复核（t16/t17）

- 复核对象：`t14`（overlay P2：#12/#16/#18/#19/#23/#24）与 `t15`（plugin P2：#21/#22）
- 方式：只读代码审计 + headless 回归 + 独立探针；未改 `app/`、`plugin/`
- 环境：Windows 11 build 26200.9711；bundled Node `C:\Users\35263\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`；单屏 1707×1067 / workArea 1707×1019 / scale 1.5
- 本轮为 **t17 最终收口（2026-11-06 18:05）**：B2 用 18:04 最终代码后的真机截图关闭；B4/B6 按当前代码复核并重跑回归；B3 保留为唯一未闭环真机项。t16 attempt 2 的历史结论与证据保留在 §3/§4 以便追溯。

## 1. 结论

**有条件通过**。8 项修复均能从代码位置与回归中闭环；t16 attempt 1 的 P2-B1 已修复并复验。B2（真机证据时效）已由 2026-11-06 18:04 的最终代码后截图满足；B4（诊断默认路径）与 B6（rename 瞬时 EPERM）已修并复核。唯一未闭环项是 **B3：#12 真实双屏/混合 DPI 拖动仍未验证**——不影响单屏逻辑结论，但不能据此宣称 P2 全量真机验收完成。

| 项目 | 结论 | 关键依据 |
|---|---|---|
| #12 跨屏拖动改主进程光标计算 | ✅ 静态通过；真机双屏未验（B3） | `hud.js:96-138`、`hud-window.js:482-496` |
| #16 状态写失败可见 | ✅ 静态通过 | `window-state.js:55-69`，`catch` 内 `console.error` `:67` |
| #18 control-state 原子写 | ✅ 静态通过 | `control.js:149-162`，tmp + rename |
| #19 destroy 回收 IPC/screen 监听 | ✅ 通过 | `hud-window.js:564-595`；探针 10/10 |
| #21 spawn 风暴去重 | ✅ 通过（B1 已修） | `plugin/index.js:197-206,457-470,529-539`；B1 探针 4/4 |
| #22 诊断日志可控/轮转 | ✅ 通过（B4 已修） | `plugin/index.js:46,166-190`；探针 3/3 |
| #23 onLoaded 时序 | ✅ 静态通过 | `main.js:187-192` |
| #24 拖动中忽略 web-bounds | ✅ 静态通过 | `hud-window.js:527-533`，drag-end `:515-516` |

## 2. 逐项核对

### #12 跨屏拖动 — 通过（静态）

- `app/renderer/hud.js:96-138`：拖动只发送 `{ offsetX, offsetY }` 与空 move，不再发送绝对 `screenX/screenY`。
- `app/src/hud-window.js:482-496`：`_onDragMove` 用 `screen.getCursorScreenPoint()` 加按下偏移计算目标，再 `_clampToWorkArea()` 后一次 `setBounds`；`_onDragEnd` 用光标点收尾。
- `app/renderer/hud.js:141-145`：panel 只依赖 `.panel-header { -webkit-app-region: drag }`，没有第二条手写拖动路径。
- 局限：没有第二块真实显示器；headless mock 只验证几何，未验证混合 DPI 手感。

### #16 状态写失败可见 — 通过（静态）

`app/src/window-state.js:55-69`：`writeFileSync(tmp)` → `renameSync(tmp, p)`，失败进入 `catch` 并 `console.error('[hud] window-state save failed:', e && e.message)` `:67`；不再静默。未注入磁盘只读做故障测试。

### #18 control-state 原子写 — 通过（静态）

`app/src/control.js:149-162`：`_saveSeq` 先 `mkdir`，写 `${statePath}.tmp`，再 `renameSync`；失败 `console.error('[hud] control state save failed:', ...)` `:159-161`。固定 tmp 名在单进程内由调用顺序串行，未发现第二条并发写路径。

### #19 destroy 回收监听 — 通过

- `app/src/hud-window.js:542-550`：9 个具名 IPC handler 通过 `ipcMain.on` 注册；`:564-595` 的 `destroy()` 逐个 `ipcMain.removeListener`。
- `:464-466` 注册 3 个 `screen` 事件，`:585-589` 逐个移除；`:565-568` 调 `web.destroy()`；`:591-594` 清 collapse timer；重复 destroy 幂等。
- `app/main.js:113-119`：`will-quit` 中先注销全局热键、停 control，再 `hud.destroy()`。
- 独立探针 `tests/e2e/probe-t16-p2.cjs`：注册后 9 个 IPC 全为 1、3 个 screen 全为 1；destroy 后全为 0；view 置空；二次 destroy 无异常（10/10 PASS，`tests/e2e/logs/t16-a2-p2.txt`，20 行）。

### #21 spawn 风暴去重 — 通过（attempt 1 的 B1 已修复）

去重逻辑：

- `plugin/index.js:197` 在写入前快照 `preExistingDiscovery`；`:199-206` 的 `hudLikelyRunning()` 检查 discovery 新鲜度 `<30s`、pid 为正整数、`process.kill(pid, 0)` 存活（EPERM 视为存活）。
- `:457-470` 的 `ensureRunning()` 顺序为：已有 child → 已疑似运行 → 才 spawn；启动 `:535`、respawn `:354` 统一走它。
- 独立探针连续 apply 两次：`spawns=1`，第二次日志 `skip spawn: HUD likely already running (fresh discovery pid=...)`；`t16-a2-p2.txt:11-12`。

attempt 1 的 P2-B1（已修复）：

- 旧代码在 `:489-490` 同时发起 `cleanupTmpFiles()` 与 `writeDiscovery()`，cleanup 删除所有 `*.tmp`（含正在写的 `discovery.json.tmp`），导致 rename ENOENT，`.then` 不执行，`spawnApp=true` 首次不拉起 HUD。
- 当前 `plugin/index.js:252-273` 的 `cleanupTmpFiles` 只删除 `mtime > STALE_TMP_MS (60s)` 的 tmp（`:264`，常量 `:55`），不再碰新写入的 tmp。
- 当前 `:529-539` 用 async IIFE **先 `await cleanupTmpFiles()`，再 `await writeDiscovery()`**；成功后才执行 `ensureRunning()` `:535`，失败只记 `discovery write failed` `:537`。
- 复验：
  - `tests/e2e/probe-t16-b1.cjs`（600KB diag 触发轮转 + spawnApp=true）：discovery 存在、spawns=1、stale tmp 被清理、无 discovery 写失败，4/4 PASS（`t16-a2-b1.txt`，6 行）。
  - `tests/e2e/probe-t16-diag.cjs` 连跑 5 次：每次 3/3，无 ENOENT（`t16-a2-diag-loop.txt`，50 行）。
  - 新增单元用例 `startup sweep: deletes stale *.tmp only, never a fresh one, and still writes discovery`（`tests/e2e/unit/plugin.test.mjs:375`）通过。

设计限制（非阻塞，已记录）：`hudLikelyRunning()` 用 discovery 里的**宿主 DSH pid**，不是 HUD 自身 pid；HUD 被用户关闭后插件仍每 15s 刷新 discovery，自动拉起会被永久抑制。若产品意图是“关闭后不再打扰”则一致；若要自动恢复，需要 HUD 心跳或子进程存活信号，不能把该启发式当真实存活检测。

### #22 诊断日志可控/轮转 — 通过（B4 已闭环）

- `plugin/index.js:46`：`DEFAULT_DIAG_FILE = path.join(os.tmpdir(), 'dsh-hud-plugin-diag.log')`，默认落在用户临时目录，避免宿主 Low Mandatory Level 无法写 `%LOCALAPPDATA%` 的问题；`:42-45` 注释记录了该原因。
- `:166`：`diagFile = process.env.DSH_HUD_DIAG_FILE || DEFAULT_DIAG_FILE`，环境变量仍可覆盖。
- `:168-180`：`statSync` > 512KB 时 `renameSync(diagFile, diagFile + '.1')`；已有 `.1` 会被替换。
- `:182-190`：`log()` 先 rotate 再 append，异常吞掉。
- 探针 `probe-t16-diag.cjs` 5 次均 3/3：600KB 首轮轮转、新日志 199B、已有 `.1` 时二轮替换成功；该探针本身用 `DSH_HUD_DIAG_FILE` 指向临时目录，覆盖了环境变量分支。

本机 `os.tmpdir()` 实测为 `C:\Users\35263\AppData\Local\Temp\dsh-uWlBSi`，默认日志路径为 `...\dsh-uWlBSi\dsh-hud-plugin-diag.log`。B4 的原“绝对路径且不建目录”问题已不存在（父目录由 `os.tmpdir()` 保证存在）。

### #23 onLoaded 时序 — 通过（静态）

`app/main.js:187-192`：

```js
if (hud.web) hud.web.onLoaded = () => setTimeout(capturePanel, 1500);
hud.showPanel();
```

`onLoaded` 在 `showPanel()` 之前赋值。`captureFlow` 仅 `DSH_HUD_CAPTURE` 时执行；未在真实 Electron 中触发 captureFlow，故为静态通过。

### #24 拖动中忽略 web-bounds — 通过（静态）

`app/src/hud-window.js:527-533`：

```js
this._webBounds = b;
if (!this.dragSession && this.web) this.web.setBounds(b);
```

拖动期间只记录，不设置 view bounds；`_onDragEnd` 在 `:515-516` 调 `_syncWebBounds()` 补最终值。panel 原生 app-region 拖动不走 `dragSession`，但不会产生每帧 `hud:web-bounds`；未真机测量 view 跟随抖动。

## 3. 回归结果

全部使用 bundled Node；日志在 `tests/e2e/logs/`。

| 命令 | 结果 | 退出码 | 输出 |
|---|---|---|---|
| `node --check`（31 个 app/plugin/tests 的 `.js/.cjs/.mjs`，排除 node_modules） | 31/31 OK，FAIL=0 | 0 | `t16-a2-static.txt`，1 行（仅汇总） |
| `node --test --test-isolation=none core.test.cjs hud-window.test.cjs main-boot.test.cjs` | 20 tests / 20 pass / 0 fail | 0 | `t16-a2-unit.txt`，32 行 |
| `node --test --test-isolation=none plugin.test.mjs` | 10 tests / 10 pass / 0 fail | 0 | `t16-a2-plugin-loop1.txt`，54 行；连续 5 次全绿 |
| `node artifacts/control-bridge-test.cjs` | 9/9 pass | 0 | `t16-a2-control.txt`，11 行 |
| `node tests/e2e/probe-t16-p2.cjs` | 10/10 pass | 0 | `t16-a2-p2.txt`，20 行 |
| `node tests/e2e/probe-t16-b1.cjs` | 4/4 pass | 0 | `t16-a2-b1.txt`，6 行 |
| `node tests/e2e/probe-t16-diag.cjs` ×5 | 每次 3/3 pass | 0 | `t16-a2-diag-loop.txt`，50 行 |
| `node tests/e2e/probe-t16-discovery-race.cjs`（small） | 8 runs，0 write failure | 0 | `t16-a2-race.txt`，54 行 |
| `node tests/e2e/probe-t16-discovery-race.cjs --prefill` | 8 runs，0 write failure | 0 | 同上 |

复跑要点：`--test-isolation=none` 是沙箱内必须项，默认 runner 会为每个测试文件 spawn 子进程并以 `EPERM` 失败。

**t17 最终代码独立复跑（2026-11-06 18:06，B4/B6 修复后）**：

| 命令 | 结果 | 退出码 | 输出 |
|---|---|---|---|
| `node --check`（31 个 app/plugin/tests 的 `.js/.cjs/.mjs`） | 31/31 OK，FAIL=0 | 0 | 汇总输出 `static total=31 fail=0` |
| `node --test --test-isolation=none core.test.cjs hud-window.test.cjs main-boot.test.cjs` | 20/20 pass | 0 | `tests/e2e/logs/t17-unit.txt`，39 行 |
| `node --test --test-isolation=none plugin.test.mjs` ×5 | 每次 10/10 pass | 0 | `tests/e2e/logs/t17-plugin.txt`、`t17-plugin-loop2..5.txt`，各 72 行 |
| `node artifacts/control-bridge-test.cjs` | 9/9 pass | 0 | `tests/e2e/logs/t17-control.txt`，11 行 |

**B6 闭环**：`plugin/index.js:279-292` 新增 `renameWithRetry(from,to,attempts=4)`，仅对 `EPERM/EBUSY` 以 25/50/75ms 退避重试；`writeDiscovery` 的 `:245` 与 `sendControl` 的 `:312` 都走它，文件中已无裸 `rename(` 调用（`:283` 是包装器内部唯一调用）。t17 连续 5 次 plugin 10/10（含 command 用例）均绿，未再出现 EPERM。t16 attempt 2 首轮那次 `control.json rename EPERM` 仍作为历史记录保留，但已有重试兜底。

## 4. 真机证据核对（与静态/headless 证据分开）

| 证据 | 时间 | 尺寸/内容 | 能证明什么 |
|---|---|---|---|
| `artifacts/hud-capture.png` | **2026-11-06 18:04:39** | **780×1080**（520×720 DIP @1.5） | 最终代码后采集：面板外壳 520×720 真机渲染 |
| `artifacts/hud-capture.capsule.png` | **18:04:40** | **420×96**（280×64 DIP @1.5） | 最终代码后采集：胶囊态真机渲染 |
| `artifacts/hud-capture.web.png` | **18:04:39** | **680×902**；DSH 新会话欢迎页（“探索未至之境”、输入框、模型名） | WebContentsView 内嵌 DSH Web UI 真机可用，不是空壳 |
| `artifacts/capture-out.log` | **18:04:40** | 首行热键注册失败；三张 `capture written` | 采集确实由最终代码执行；渲染/尺寸有效，但不证明热键可用 |
| 历史：同三张图 | 17:21:07 | 780×1080 / 420×96 / 681×903；真实对话页 | 仅作历史参考，不再作为最终代码证据 |

**B2 已满足**：`plugin/index.js` 最终修改 17:51:59、app 侧最后修改 17:37:01，均早于 18:04:39 的截图采集；三张尺寸精确等于 `520×720 @1.5`、`280×64 @1.5`，Web 截图为真实的 DSH 新会话欢迎页。`capture-out.log` 的写入时间与三张图一致。

**最终采集的额外限制**：`capture-out.log:2` 记录 `[hud] 全局热键注册失败（可能被其他程序占用）: Control+Alt+Space`。因此 18:04 证据能证明“最终代码下窗口/胶囊/内嵌 Web UI 可渲染且尺寸正确”，**不能证明全局热键在当次运行可用**（17:21 那轮日志曾显示注册成功）。热键注册失败的具体占用者未定位，不排除上一实例或测试进程残留；作为真机限制记录，不据此否定 B2 的尺寸/时效结论。

其他真机限制：

- 没有第二块显示器，`#12` 的双屏手感未验证（B3 仍未闭环）。
- 最终采集时全局热键注册失败（`capture-out.log:2`），没有“用户在最终代码上按热键唤起”的证据；命中/未命中占用者未定位。
- 没有内存/CPU 采样数据。
- 最终 `capture-out.log` 未再出现上一版日志中的 DSH UI `TypeError: fileMentions is not a function`；但仍有 Electron “Insecure Content-Security-Policy” 安全警告（Electron 自身对开发态/未设 CSP 的提示），不是 HUD 业务错误。历史日志中的 `fileMentions` 属宿主页面脚本，不能算 HUD 控制台错误，也不能据此判定宿主无报错。

## 5. 未闭环项与 requiredFix

| 编号 | 状态 | 严重度 | 问题/处置 | 证据 |
|---|---|---|---|---|
| P2-B2 | **已满足** | 证据缺口（已关闭） | 18:04:39/40 在最终代码后重采，尺寸 780×1080、420×96、Web 680×902 | 本报告 §4；`artifacts/capture-out.log` |
| P2-B3 | **未闭环** | 未验证 | #12 真实双屏/混合 DPI 拖动仍未验证 | 本机只有单屏；headless mock 只覆盖几何 |
| P2-B4 | **已闭环** | 中（已修） | 默认诊断路径改为 `path.join(os.tmpdir(),'dsh-hud-plugin-diag.log')`，仍可由 `DSH_HUD_DIAG_FILE` 覆盖 | `plugin/index.js:46,166`；§2/#22；本机 tmp 路径实测 |
| P2-B5 | 保留 | 低/设计 | `hudLikelyRunning()` 用宿主 pid，用户关闭 HUD 后仍会抑制自动拉起 | `plugin/index.js:199-206`；需产品明确语义 |
| P2-B6 | **已闭环** | 中/偶发（已修） | `renameWithRetry` 对 EPERM/EBUSY 退避 4 次；discovery 与 control 两处 rename 均使用 | `plugin/index.js:279-292,245,312`；§3 t17 连续 5 次 10/10 |

已关闭：P2-B1（启动清理与 discovery 写入竞争），修复位置 `plugin/index.js:55,252-273,529-539`，复验见 §2/#21。

## 6. 本次 QA 改动

只改测试与文档，未改 `app/`、`plugin/`：

- `tests/e2e/probe-t16-p2.cjs`：连续 apply 两次 + destroy 前后 listenerCount，10 项断言。
- `tests/e2e/probe-t16-b1.cjs`：600KB 日志轮转 + stale tmp + spawnApp=true，验证首次 discovery 与 spawn 各一次，4 项断言。
- `tests/e2e/probe-t16-diag.cjs`：诊断日志 512KB 轮转 + `.1` 已存在时二次轮转。
- `tests/e2e/probe-t16-discovery-race.cjs`：8 次 fresh apply 的 discovery 写入检查；`--prefill` 模式。
- `tests/e2e/README.md`：测试总数改为 30（20 + 10），补充 t16 探针命令。
- `docs/acceptance-verify-p2.md`：本报告。

## 7. 判定

- 8 项修复均闭环；t16 attempt 1 的阻塞项 B1 已修复复验，B2/B4/B6 已在 t17 关闭。
- **最终结论：有条件通过**。条件只剩 **B3**——#12 的双屏/混合 DPI 真机手感未验证；这是真机覆盖缺口，不是已证实的代码缺陷。
- P2-B5（宿主 pid 启发式的产品语义）保留为设计说明，不阻塞。
- 建议下一步：在双屏机器上补一次 1.5x+1x 的 capsule/panel 拖动记录（落点、钳位、跨屏吸附）；若通过，可把 B3 关闭并转“通过”。热键在 18:04 采集时注册失败，建议在干净会话中单独复核热键唤起，不要与本次尺寸证据混为一谈。
