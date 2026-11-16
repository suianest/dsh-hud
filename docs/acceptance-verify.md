# t12 修复复核报告（D1–D5 + 两项真机反馈）

- 复核对象：`docs/acceptance.md` §10（第 311–347 行）及当前 `app/`、`plugin/` 实现
- 复核快照：2026-11-06 16:36:20 +08:00（代码仍在复核期间变动，见 §0.2）
- 复核方式：静态读码 + `node --check` + mock Electron 的 headless 集成测试 + 控制契约探针 + 真机产物时间线核对
- 未执行：Electron 真实渲染。本会话仍是受限令牌环境，渲染会 `FATAL platform_channel.cc:112 (0x5)`；按任务要求不尝试，也不把真机步骤写成已跑。
- 产出文件：本报告；`tests/e2e/logs/*-t12-final.txt`；`tests/e2e/README.md` 已更新命令

## 0. 总结论

**有条件通过：核心功能链（D1/D3/D4/D5）当前实现与测试成立；D2 的“启动清理”声明不成立；§10.3 的三张截图是本轮修复前的旧证据，不能证明修复；shell 侧的拖动/原子 bounds 修复没有重启后的真机证据。**

| 复核项 | 结论 | 一句话依据 |
|---|---|---|
| D1 重拉无限循环 | **通过** | 上限 :243、稳定 30s 后清零 :323-326、exit 0 不重拉 :339-341；8/8 插件测试通过 |
| D2 并发 tmp + 启动清理 | **不通过（声明不实）** | 唯一 tmp/串行写已实现；`cleanupTmpFiles` 只在 dispose 调用（:455），启动不清理；探针启动后仍保留 `control.json.999.1.tmp`、`orphan.tmp` |
| D3 HUD 侧控制接收器 | **通过（复核期间才修好）** | 16:31 前 stdin 发 `{type}` 而 ControlBridge 只读 `action`，且先推进 seq；当前 :198/:218 与 control.js :124-135 已一致，探针通过 |
| D4 second-instance 弹面板 | **通过** | main.js:57-61 只 `focusIfVisible()`；hud-window.js:196-201 不可见直接 return；headless 用例按新契约 |
| D5 subprocess 守卫误报 | **通过** | plugin/index.js:269-273 为空服务显式跳过，日志 `subprocess service unavailable; skipping spawn` |
| 原子 setBounds / 拖动放大 | **部分通过（真机未验证）** | 静态/headless 通过；`_applyBounds` 仍有 `setPosition` 分支（:295）；16:35 的 diag 仍来自旧 shell 进程，不能证明 thickFrame 修复 |
| 标题栏 app-region | **通过（静态）** | hud.css:115-116；hud.js 仅在 :144 给 capsule 挂手写拖动，panel 已改用原生拖动 |
| preload `data-windows-titlebar` 时序 | **通过（真机有正向证据）** | clicks.log 第 24 行起 frame 不再有 `sidebarDrawer`，sidebar 从 -38/0 变为 10,6 停靠；DSH asar 逻辑与属性名一致 |
| C9 drawerMask 兜底 | **通过（静态）；真机未单独归因** | compact-css.js:52-53；clicks.log 后段已不走 drawer，mask 不再出现，无法把点击恢复单独归因给 C9 |
| 回归（static / headless / plugin） | **通过** | 27 个 JS 全 0；28/28 headless；8/8 plugin；EXIT=0 |
| §10.3 真机证据 | **不通过（证据时效）** | 三张 png 与 capture-out.log 均为 15:27，早于 16:07-16:35 的修复；diag 16:35 仍出现当前 hud.js 不可能产生的 `drag-start mode=panel`，说明 shell 未重启 |

**判定**：不能把 §10 当作“D1–D5 全部修复且真机验证完成”的验收签字。D2 需改文档或补一行启动清理；两条用户反馈需在重启 HUD 后重新截图/采集；其余逻辑项可以通过。

## 0.1 复核期间代码在变（重要）

复核开始时（16:27）D3 仍是坏的；16:31–16:35 captain 连续修改了以下文件，本报告结论以 16:36:20 快照为准：

| 文件 | 最后修改 |
|---|---|
| `app/src/control.js` | 16:31:48 |
| `plugin/index.js` | 16:34:29 |
| `app/renderer/hud.js` | 16:32:02 |
| `app/src/hud-window.js` | 16:34:14 |
| `app/renderer/web-preload.js` | 16:35:27 |

因此本报告与 §10 的行号会有漂移（见 V2）；如果之后继续改动，需重新跑本报告 §4 的三条命令。

## 1. D1 重拉无限循环 —— 通过

**§10 声明**：`plugin/index.js:315-322` 只在稳定运行后清零计数；`:239` 上限生效；新增“退出码 0 不重拉”。

**当前实现**（行号已漂移）：

- `plugin/index.js:54` `const STABLE_MS = 30_000;`
- `plugin/index.js:117` `let respawnCount = 0;`（apply 生命周期只初始化一次）
- `plugin/index.js:243` `if (respawnCount >= cfg.maxRespawns)` → 记 `respawn limit reached; giving up auto-restart` 后不再拉
- `plugin/index.js:323-326` `stableTimer = setTimeout(..., STABLE_MS)`，30 秒稳定后才 `if (!disposed && child === handle) respawnCount = 0`
- `plugin/index.js:339-341` `if (outcome && outcome.code === 0) { log('HUD exited cleanly; not respawning'); return; }`

**验证**：`tests/e2e/unit/plugin.test.mjs` 的 `respawn: linear backoff, then stops at maxRespawns` 通过；合并套件与单独插件套件均 8/8。旧 t8 的 `4 !== 3` 失败已消失。

**保留意见**：`artifacts/plugin-diag.log` 里那条 `respawn limit reached` 不是用户真机产生，而是 t12 测试进程（见 V6）；它只能作为代码路径的辅助证据，不能作为“用户侧稳定”的证据。D1 的通过依据是当前代码 + 可重复测试，不是该日志。

## 2. D2 control.json 并发 + 启动清理 —— 不通过（声明不实）

**§10 原文**：

> 唯一临时名 `${cFile}.${pid}.${seq}.tmp` + 串行写链 + 启动时清理残留 `*.tmp`（`plugin/index.js:177-210`）

**实际实现**：

- `plugin/index.js:204` 唯一临时名：`const tmp = \`${cFile}.${process.pid}.${seq}.tmp\`;` —— 成立
- `plugin/index.js:206-214` `controlChain = controlChain.then(...)` 串行写 + rename —— 成立
- `plugin/index.js:178-190` `cleanupTmpFiles` 定义了，但全文只有一处调用：
  - `plugin/index.js:455` `void cleanupTmpFiles().catch(() => {});`，位于 dispose 路径
  - **apply / 启动路径没有调用**

**探针证据**（`tests/e2e/logs/contract-t12-final.txt`）：

```text
{"phase":"startup","files":["control.json.999.1.tmp","discovery.json","orphan.tmp"]}
...
{"phase":"dispose","files":[]}
```

启动后预置的 `control.json.999.1.tmp` 与 `orphan.tmp` 仍在；只有 dispose 才清空。**“启动时清理残留”这句话与实现不符。**

**影响**：残留 tmp 不参与 control.json 读取，功能上不致命；但会随崩溃/重装累积，且验收文档把未实现的行为写成已实现。修复只需在 `apply()` 初始化后、首次写 discovery 前 `await cleanupTmpFiles()`，或把调用放到 `sendControl` 首次写之前。

**结论**：D2 的“并发写不 ENOENT”通过；D2 的“启动清理”不通过。整体按不通过记录。

## 3. D3 ControlBridge —— 通过（但复核期间才修好）

### 3.1 复核开始时的真实失败

16:27 首次探针时：

- `plugin/index.js` stdin 写的是 `{ type: action, seq }`；
- `app/src/control.js` 只读 `obj.action`；
- 且旧版 `_dispatch` 在 action 校验前就推进 `_lastSeq`。

探针输出：

```text
afterType {"calls":[],"lastSeq":1}
afterAction {"calls":["show"],"lastSeq":2}
afterRestart {"calls":[],"lastSeq":10}   # 插件重启后 seq=1 被持久化的 10 永久压住
```

后果：`spawnApp=true` 时 stdin 先到，动作被丢弃但 seq 被烧掉；随后同一 seq 的 control.json 被去重 → 所有 `/dsh-hud` 命令失效。这不是“文档缺口”，是实际断链。

### 3.2 16:31 后的当前实现

- `plugin/index.js:198` `controlSeq = Math.max(controlSeq + 1, Date.now());` —— 跨插件重载单调，避免重启后 seq 回到 1 被 HUD 持久化的 lastSeq 吞掉
- `plugin/index.js:200` payload `{ seq, action, at }`
- `plugin/index.js:218` stdin `JSON.stringify({ action, seq })`
- `app/src/control.js:118-136`：先 `seq` 有限性/去重检查，再取 `obj.action` 并查 handler；**校验通过后才** `this._lastSeq = seq; this._saveSeq(seq); fn();`（:133-135）；未知 action 只打日志不推 seq（:126-131）
- `app/main.js:76-85` 接线正确：`toggle→hud.toggle()`、`show→hud.showPanel()`、`hide→hud.showCapsule()`、`reload→hud.reloadWeb()`
- `app/main.js:113` `will-quit` 调 `control.stop()`
- `hud-window.js:196-201` `focusIfVisible()`；`:206-208` `reloadWeb()`

**探针当前输出**：

```text
{"phase":"startup","files":["control.json.999.1.tmp","discovery.json","orphan.tmp"]}
{"phase":"control","afterType":{"calls":[],"lastSeq":-1},"afterAction":{"calls":["show"],"lastSeq":2},"afterRestart":{"calls":["show"],"lastSeq":1793954175552,"freshSeq":1793954175552}}
```

`afterType` 不再烧 seq（lastSeq 仍 -1）；`afterAction` 能执行 show；`afterRestart` 的 freshSeq 能被接受。

**结论**：当前 D3 通过。但必须记住：这是 16:31 之后才成立的；如果回滚到 16:27 的代码，D3 立即恢复为不通过。

## 4. D4 second-instance —— 通过

- `app/main.js:57-61` `app.on('second-instance', () => { if (hud) hud.focusIfVisible(); });`，不再无条件 `showPanel()`
- `app/src/hud-window.js:196-201`：窗口不存在/已销毁/不可见直接 return；可见才 `win.focus()`
- `tests/e2e/unit/main-boot.test.cjs` 已按“第二次启动不展开面板、只 focus”更新并通过

**行为风险**：HUD 隐藏时用户再次双击应用不会出现任何窗口，只能靠热键/胶囊。当前设计是“胶囊常驻、面板隐藏”，可接受；若将来胶囊也被隐藏，应改为“不可见时 showCapsule”。

## 5. D5 subprocess 守卫 —— 通过

`plugin/index.js:269-273`：

```js
if (!subprocess || typeof subprocess.spawn !== 'function') {
  log('subprocess service unavailable; skipping spawn');
  return;
}
```

不再进入 `subprocess.spawn` 抛 TypeError，也不会被 catch 误记成 `spawn failed`。`plugin.test.mjs` 的 degradation 用例通过，日志文案正确。

## 6. 本轮两处新修

### 6.1 拖动放大 / 原子 setBounds —— 部分通过，真机未验证

**代码**：

- `app/src/hud-window.js:96-99` 新增 `thickFrame: false`，意图去掉 Windows 隐形 WS_THICKFRAME 边框
- `app/src/hud-window.js:278-298` `_applyBounds`：先取 `getContentSize()`；尺寸差 >2 时 `setBounds({x,y,width,height})`（:293），否则 `setPosition`（:295）
- `app/src/hud-window.js:478-485` drag-move：`_clampToWorkArea` 后一次 `setBounds`
- `app/src/hud-window.js:490-491` drag-end：再次 `_applyBounds` 并保存 state
- `app/renderer/hud.js:144` 只给 `capsuleDrag` 挂手写拖动；panel 走 CSS `-webkit-app-region: drag`

**headless 测试**：mock 的 `setBounds` 已补齐，窗口几何用例 28/28 通过。

**真机证据不足**：

- `artifacts/diag.log` 在 16:35 仍出现 `drag-start mode=panel`。当前 `hud.js` 只在 :144 给 capsule 挂 `attachDrag`，panel 不再发 `hud:drag-start`；因此该 diag 来自 **16:32 之前启动、未重启的 shell 进程**。
- 同一文件 16:35:27–16:35:31 仍记录 `content=[282,64]`、`[284,64]`、`[520,722]`，但这些数字是旧 shell 的；不能拿来证明 `thickFrame:false` 无效，也不能证明有效。
- §10.2 说“统一用原子 setBounds”，但 `_applyBounds` 在尺寸差 ≤2 时仍走 `setPosition`；这是有意的防抖分支，不是 bug，但“统一”表述不准确。

**结论**：静态与 headless 通过；**需要重启 HUD 后复测一次拖动/展开收起并采集新的 diag**，否则这条只能算“无法验证”。

### 6.2 标题栏 app-region —— 通过（静态）

- `app/renderer/hud.css:115` `.panel-header { -webkit-app-region: drag; }`
- `app/renderer/hud.css:116` `.panel-btn { -webkit-app-region: no-drag; }`
- `app/renderer/hud.js` 只保留 capsule 手写拖动（:144），panel 不再双路径

没有真机拖动截图，但代码路径唯一，静态通过。

### 6.3 preload `data-windows-titlebar` 时序 —— 通过（真机有正向证据）

**实现**：`app/renderer/web-preload.js:23-42`

- `DESKTOP_LAYOUT = process.env.DSH_HUD_DESKTOP_LAYOUT !== '0'`（默认开）
- `markDesktopLayout()` 在 `document.documentElement` 存在时立即 `setAttribute('data-windows-titlebar','')`
- 首次失败时挂 `readystatechange` + `DOMContentLoaded` 重试；成功后移除 readystatechange 监听
- `file:` 本地错误页跳过，避免给错误页加假标题栏（t13 #20）

**DSH 侧契约**（从 `D:/deepseek/resources/app.asar` 内提取，非猜测）：

```js
const windowsTitlebar = document.documentElement.hasAttribute("data-windows-titlebar");
const drawer = viewport < 768 && !windowsTitlebar;
const collapsedWidth = drawer || darwin || windowsTitlebar ? 0 : 56;
```

属性名、设置位置（documentElement）与 DSH 的 `hasAttribute` 一致；CSS 也有 `[data-windows-titlebar]` 分支。

**真机证据**：`artifacts/clicks.log` 第 23 行之前 frame 含 `"sidebarDrawer":"true"`、sidebar 为 `-38,6` 或 `0,0,300,...`，点击常命中 `mP3x-q_drawerMask`；第 24 行起 frame 不再含 `sidebarDrawer`，sidebar 变为 `10,6,48,48` 停靠，点击命中真实 BUTTON/SVG/HEADER。该切换与“属性生效、drawer=false”完全吻合，说明某次 webview 重载后新 preload 已生效。

**限制**：clicks.log 没有时间戳，也没有 session 分隔，无法证明切换发生在 16:08 修复之后还是更晚；但布局形态与属性语义一致，且旧进程不可能自行从 drawer 变成 docked。按“真机正向证据”记录，置信度中高。

### 6.4 C9 drawerMask pointer-events —— 静态通过，真机未单独归因

`app/src/compact-css.js:52-53`：

```css
[class*="drawerMask"] { pointer-events: none !important; opacity: 0 !important; background: transparent !important; }
[class*="sidebarCol"] { pointer-events: auto !important; }
```

C8 同时把 `--dsh-windows-titlebar-height` 置 0（:47），避免标题栏占位。

clicks.log 后段已进入 docked 布局，drawerMask 根本不再出现，所以无法把“点击恢复”单独归因给 C9；C9 的正确性目前只有静态依据。**风险**：如果将来 DSH 又走 drawer 分支，mask 被设为不可点，用户点背景无法关闭抽屉，只能点侧栏按钮或按 Esc。

## 7. 回归结果（2026-11-06 16:36 快照）

全部使用 bundled Node：

```text
C:\Users\35263\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
```

| 命令 | 结果 | 日志 |
|---|---|---|
| `node --check` 遍历 `app/`、`plugin/`、`tests/` 下 `.js/.cjs/.mjs`（排除 node_modules） | **27 个，FAIL=0** | `tests/e2e/logs/static-t12-final.txt` |
| `node --test --test-isolation=none tests/e2e/unit/{core,hud-window,main-boot}.test.cjs tests/e2e/unit/plugin.test.mjs` | **28 tests / 28 pass / 0 fail / EXIT=0**，3.4s | `tests/e2e/logs/regression-t12-final.txt` |
| `node --test --test-isolation=none tests/e2e/unit/plugin.test.mjs` | **8/8 pass / EXIT=0** | `tests/e2e/logs/plugin-t12-final.txt` |
| `node tests/e2e/probe-contract.mjs` | EXIT=0，输出见 §2/§3 | `tests/e2e/logs/contract-t12-final.txt` |
| `Get-Content app/package.json,plugin/package.json \| ConvertFrom-Json` | `dsh-hud 0.2.0`、`@dsh-hud/token-bridge 1.0.0` 合法 | 命令输出 |

说明：

- 任务里写“19 个 JS”，当前树已增至 27 个（新增 control.js、launch-hud.cjs、probe 脚本、t12 测试），检查范围更宽，不减少覆盖。
- `--test-isolation=none` 是沙箱内必需：默认 runner 会为每个测试文件 spawn 子进程，受限令牌下 `spawn EPERM (-4048)`。
- 合并套件不加 `--test-force-exit` 也能在 3.4s 内退出，说明失败时跳过 `will-quit` 导致的挂起已解决。
- **没有执行 Electron 真实渲染**；沙箱内尝试会 `FATAL platform_channel.cc:112 (0x5)`，且任务明确说不要求复现真机。

## 8. 真机证据时间线（为什么 §10.3 不能直接签字）

| 产物 | 时间 | 结论 |
|---|---|---|
| `hud-capture.png` / `.web.png` / `.capsule.png` | 15:27:20 | 证明“HUD 能在真实桌面渲染、Web UI 能显示”，但早于 compact-css(16:07)、web-preload(16:08)、hud-window(16:34) 的所有修复 |
| `capture-out.log` | 15:27:17–15:27:20 | 热键已注册 + 三张 capture written；同样是修复前 |
| `clicks.log` | 创建 15:51:10，最后写 16:30:37 | 含修复前后两种布局；后段无 drawer，可作 titlebar 正向证据，但无时间戳、无 session 标记 |
| `diag.log` | 创建 15:49:19，最后写 16:35:32 | 16:35 仍有 `drag-start mode=panel`，当前 hud.js 不可能产生 → shell 未重启；不能用于验证 thickFrame/原子 bounds |
| `plugin-diag.log` | 创建 14:42:02，最后 16:33:46 | 尾部含 t12 测试进程（临时 LOCALAPPDATA、`spawnApp=true`、`launch-hud.cjs`）；§10 引用的 `respawn limit reached` 可能是测试产物，不是用户真机 |
| `discovery.json` | 16:28 左右仍在刷新（pid 10548/port 61352） | 证明 token 桥在线；不证明 D1–D5 |

**V3（证据时效）**：§10.3 把 15:27 的截图放在“修复复核与真机补证”下，容易被读成“修复后截图”。实际上它们只能证明基线可运行。修复后的 shell 外观、拖动、面板展开还没有截图。

**V4（shell 未重启）**：diag 16:35 的 `drag-start mode=panel` 是最硬的证据：当前渲染器只给胶囊挂拖动，面板不会发这个 IPC。说明 16:34 的 hud-window 修复没有被真实加载过。需要用户退出 HUD 后重新启动 `app\scripts\run-hud.cmd`，再拖动/展开并回传新的 diag 与截图。

## 9. 发现项清单

| ID | 严重度 | 问题 | 位置 | 要求 |
|---|---|---|---|---|
| V1 | 中 | D2“启动时清理残留”未实现，只有 dispose 调用 `cleanupTmpFiles` | `plugin/index.js:178-190`、`:455` | 启动时调用一次；或把 §10 的措辞改为“dispose 清理” |
| V2 | 低 | §10.1/§10.2 的行号已漂移（如 D1 实际 243/323-326/339-341，D2 实际 178-190/204/455，D3 实际 hud-window 196/206，§10.2 实际 278-298/478-485） | `docs/acceptance.md:319-328` | 更新行号或在报告中注明“按当时快照” |
| V3 | 中 | §10.3 三张截图与 capture-out 均为 15:27，早于全部修复，不能作为修复后证据 | `docs/acceptance.md:330-339` | 重新采集修复后截图；旧图标注为基线 |
| V4 | 中 | 16:35 diag 仍来自旧 shell（panel drag IPC），thickFrame/原子 bounds 未经真机加载 | `artifacts/diag.log` 16:35 | 重启 HUD 后复测，采新 diag + 截图 |
| V5 | 低 | C9 的真机效果无法与 titlebar 分支切换分离；且 mask 不可点会让 drawer 无法点背景关闭 | `app/src/compact-css.js:52-53` | 接受为兜底；在 DSH 升级后回归 drawer 场景 |
| V6 | 低 | §10 引用 `plugin-diag.log` 作为 D1 真机证据，但文件尾部是测试进程产物 | `docs/acceptance.md:319`、`artifacts/plugin-diag.log` | 改用可重复的插件测试作为证据；如需真机证据，单独采一份干净日志 |
| V7 | 低 | 当前 `_applyBounds` 并非“统一 setBounds”，≤2px 时走 `setPosition`；表述应改“尺寸变化时原子 setBounds” | `app/src/hud-window.js:292-295` | 文档措辞；功能可保留 |
| V8 | 信息 | `/dsh-hud` 命令仍无真机端到端确认（§10.4 已承认）；本报告的 probe 是合成探针 | `docs/acceptance.md:347` | 安装插件后真机执行一次 `show/hide/reload` |

## 10. 仍未闭环 / 剩余风险

1. **修复后真机截图为零**：面板外壳、Web UI、胶囊、拖动、展开收起都需要在重启进程后重拍；当前 15:27 的图只能当基线。
2. **常驻内存/CPU、冷启动、多屏**：仍无数据（§10.4 已列）。目标 <150MB 未验证。
3. **插件命令端到端**：ControlBridge 的单元/探针通过，但插件是否已安装、`/dsh-hud` 在真实 DSH 里能否驱动 HUD，未验证。
4. **spawnApp 默认 false**：HUD 目前手动启动；插件只写 discovery/control。若用户不先开 HUD，`/dsh-hud` 没有接收方。
5. **portable 产物**：`dist\DSH HUD.exe` 无图标/版本资源；开机自启未启用。
6. **DSH 版本耦合**：titlebar 属性、drawer 断点、`drawerMask` 类名都依赖 0.2.2-rc.1 的实现；DSH 升级后需回归 §6.3/§6.4。
7. **D2 残留 tmp**：不致命，但会在多次崩溃后堆积；修复成本一行，建议本轮顺手补。
8. **ControlBridge 启动重放**：若 `control-state.json` 被删除而 control.json 仍在，HUD 启动可能重放最后一条动作（例如直接 show）。当前场景影响小，建议在验收清单里注明。

## 11. 本次 QA 改动披露（未改 app/plugin）

- `tests/e2e/unit/helpers/mock-electron.cjs`：新增 `MockBrowserWindow.setBounds`，否则无法覆盖新几何代码。
- `tests/e2e/unit/hud-window.test.cjs`：blur 契约改为“默认不收起，`DSH_HUD_BLUR_COLLAPSE=1` 才收起”。
- `tests/e2e/unit/main-boot.test.cjs`：second-instance 断言改为“不展开、只 focus”。
- `tests/e2e/unit/plugin.test.mjs`：新增 exit code 0 不重拉用例；stdin 断言从旧 `type` 改为 `action`（当前契约）。
- `tests/e2e/probe-contract.mjs`：ControlBridge 双通道/seq 探针。
- `tests/e2e/probe-asar-layout.cjs`：只读 DSH asar 提取 titlebar/drawer 逻辑。
- `tests/e2e/README.md`：更新 28 tests + probe 命令。
- 本报告：`docs/acceptance-verify.md`。

以上改动都在 `docs/` 与 `tests/` 内，未触碰 `app/`、`plugin/` 实现。

## 12. 复跑命令（沙箱内外都可用，除 live 外）

```powershell
$node = 'C:\Users\35263\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
Set-Location 'D:\DeepSeekData\workspace\dsh-hud'

# 1) 静态检查（27 个文件）
Get-ChildItem -Recurse -File -Include *.js,*.cjs,*.mjs -Path app,plugin,tests |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
  ForEach-Object { & $node --check $_.FullName }

# 2) headless 全量（28）
& $node --test --test-isolation=none tests\e2e\unit\core.test.cjs `
  tests\e2e\unit\hud-window.test.cjs tests\e2e\unit\main-boot.test.cjs `
  tests\e2e\unit\plugin.test.mjs

# 3) 控制契约探针
& $node tests\e2e\probe-contract.mjs

# 4) 真机（普通桌面，先退出旧 HUD 再跑；本会话不要执行）
tests\e2e\run-live.cmd
```

## 13. 复核判定

- **D1 / D3 / D4 / D5：通过**（D3 是 16:31 后快照；此前确实不通过）。
- **D2：不通过**，因为“启动清理”与实现不符；并发写本身通过。
- **两项用户反馈：静态通过，真机只对 titlebar 有间接正向证据；thickFrame/原子 bounds 未验证。**
- **回归：通过**（27 静态、28 headless、8 plugin、探针、manifest）。
- **验收文档：有条件通过**——需要修 V1/V2/V3/V4/V6 后才能作为“修复完成”的签字页。

> 本报告不把任何未执行的 GUI 步骤写成已通过；所有“通过”均有命令输出或代码行号支撑，所有“无法验证”均说明缺哪份证据。
