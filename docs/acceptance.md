# DSH HUD 端到端验收报告（t8）

- 任务：`t8 — 端到端验收与回归清单`
- 验收人：qa（验收工程师）
- 日期：2026-11-06
- 产物根目录：`D:\DeepSeekData\workspace\dsh-hud`
- 结论：**逻辑层/契约层回归通过；真实 GUI 端到端验收被当前会话的 Windows 受限令牌硬阻断，未取得真实截图、内存/CPU 与冷启动数据。** 不是产品功能失败，但本轮不能签字“真机全通过”。
- **状态更新（2026-11-06 晚）：真机已跑通，D1–D5 全部处理，新增截图与用户实测证据见 §10。**

---

## 1. 结论摘要

| 维度 | 结果 | 说明 |
|---|---|---|
| 静态检查 | ✅ 19 个 JS `node --check` 全 0；2 个 package.json（Node `JSON.parse`）合法；plugin ESM 可导入 | 见 §5.1 |
| Headless 集成测试 | ✅ **20/20 通过**（exit 0） | 真实 `app/` 模块 + mock `electron`，覆盖窗口状态机/几何/持久化/热键/错误页/真实 main.js 启动，见 §5.2 |
| 插件桥契约测试 | ⚠️ **5/6 通过**，1 个契约用例失败 | 失败暴露真实缺陷 D1（`maxRespawns` 失效），见 §6.1 |
| DSH Web 鉴权矩阵 | ✅ 实测：无 token → 401；旧 discovery 端口 → ECONNREFUSED | 见 §5.4 |
| 真实 Electron 截图 | ❌ 0 张 | 沙箱内 Chromium 无法创建 Mojo 管道，FATAL 0x5，见 §7 |
| 常驻内存/CPU（<150MB） | ⏸ 未测 | 无 Electron 进程可测；live harness 已内置采集，见 §8 |
| 冷启动时间 | ⏸ 未测 | 同上 |
| 控制台持续报错 | ⏸ 真机未测；headless 无未捕获异常，仅有预期告警和 1 类插件写文件告警 | 见 §6.2 |

**一句话结论**：代码层面能跑通的状态机与错误路径都通过了自动化回归；但“开窗→截图→发消息→流式→多屏→内存”的真机验收在当前 DSH agent 会话里不可能完成，必须由用户在正常桌面执行 `tests\e2e\run-live.cmd` 回传结果后才能最终签字。

---

## 2. 验收环境

| 项 | 值 | 证据 |
|---|---|---|
| OS | Windows 11 25H2（`[Environment]::OSVersion` = 10.0.26200.0；注册表 ProductName 仍写 “Windows 10 Home China”，Build 26200.9711） | `artifacts/e2e/static-checks.log` |
| DSH 桌面应用 | `D:\deepseek\DeepSeek Harness.exe`，FileVersion `0.2.2-rc.1`，ProductVersion `0.2.2.0` | 文件版本信息 |
| DSH Web | `http://127.0.0.1:61352`（本会话 GUI URL，无 token 访问 401） | `artifacts/e2e/e2e-http.json` |
| Electron | `v45.2.2`，Chromium `156.0.8078.80`，Node `24.22.2`（`操作日志/spike/node_modules/electron/dist/electron.exe`） | `artifacts/e2e/electron-version.log` |
| 测试用 Node | `v24.21.0`（DSH bundled） | `artifacts/e2e/static-checks.log` |
| 显示环境 | 单屏 1707×1067，workArea 1707×1019，scaleFactor 1.5 | `probe-render.trace.log` |
| 会话权限 | Low Mandatory Level + restricted token（4 restricted SID），`ELECTRON_RUN_AS_NODE=1` 常驻 | §7 |

> 说明：当前环境只有一块显示器（1707×1067）。即使 Electron 能启动，“多屏拖动”也需要用户接入第二块屏或使用 `screen` mock（headless 已覆盖 mock 双屏几何）。

---

## 3. 场景逐项结论

| # | 场景 | 真机结果 | 自动化/替代证据 | 判定 |
|---|---|---|---|---|
| S1 | DSH 未启动，开浮窗 → 自绘错误页 | 未执行（无法开窗） | headless：无 discovery → `error.html?kind=unreachable`；陈旧 discovery 死端口 → `did-fail-load -102` → 错误页（2 个用例通过） | 逻辑通过，真机阻塞 |
| S2 | 启动 DSH → 插件拉起浮窗 | 未安装、未拉起 | 插件契约单测：discovery 原子写、`electron.exe --no-sandbox app` argv、env 清理、cwd/stdio/graceMs/signal 全部通过；`install_bundle` 被拒（需 danger-full-access） | 契约通过，真机阻塞 |
| S3 | 热键唤起 | 未按键 | headless：默认 `Control+Alt+Space` 注册成功、双向 toggle、注册失败仅告警不崩溃（4 个用例通过） | 逻辑通过，真机阻塞 |
| S4 | 发消息 | 未执行 | 无 live token（61352 强制 401；旧 token 端口已死），Web UI 无法加载 | 阻塞 |
| S5 | 流式回复 | 未执行 | 依赖 S4；live harness 已写 DOM 文本长度轮询 + 两帧截图 | 阻塞 |
| S6 | 换会话 | 未执行 | 依赖 S4；harness 用无障碍/文本启发式点击侧栏项 | 阻塞 |
| S7 | 收起/展开 | 未执行 | headless：Esc、blur、renderer 动画握手、280ms 兜底、`DSH_HUD_NO_ANIM=1` 立即收起、web-view detach 保活（5 个用例通过） | 逻辑通过，真机阻塞 |
| S8 | 多屏拖动 | 未执行 | headless：mock 双屏（1920×1040 / 1280×680@1.5）下胶囊恢复在副屏、面板钳位进目标 workArea、拖拽吸附边距 8 DIP、位置持久化（4 个用例通过） | 逻辑通过；真机还需第二块屏 |
| S9 | 重启恢复 | 未执行 | headless：`window-state.json` 400ms 防抖、原子 tmp+rename、重启读取恢复通过；live harness 分两阶段进程重启校验 | 逻辑通过，真机阻塞 |
| S10 | 常驻内存/CPU < 150MB | 未测 | harness 用 `app.getAppMetrics()` 聚合 workingSetSize/CPU，写入 `live-report.json.metrics[].totalMB` 并给 budget 判定 | 无数据 |
| S11 | 冷启动时间 | 未测 | harness 用 `DSH_HUD_E2E_T0` 到 capsule/panel ready 计时 | 无数据 |
| S12 | 控制台无持续报错 | 未测（真机） | headless 20 用例无未捕获异常；出现 1 条预期 `[hud] web did-fail-load -102`；插件测试暴露 `control.json write failed: ENOENT`（缺陷 D2） | 部分 |

**截图**：本轮 **0 张真实截图**。任务要求的 `artifacts/e2e-*.png` 无法生成，原因是 §7 的 Chromium 启动失败，不是截图代码问题。live harness 已定义 11 张截图（`artifacts/e2e/live/shots/e2e-01..11-*.png`），待在沙箱外执行后补齐。

---

## 4. 证据索引

| 文件 | 大小 | 说明 |
|---|---|---|
| `artifacts/e2e/unit-tests.log` | 5.1 KB | headless 20/20 通过，exit 0；含唯一预期告警 `did-fail-load -102` |
| `artifacts/e2e/plugin-tests.log` | 6.7 KB | 插件契约 5/6；D1 失败详情；D2 ENOENT 告警 |
| `artifacts/e2e/static-checks.log` | 1.0 KB | 19 个 `node --check`、JSON.parse、OS/Electron 版本 |
| `artifacts/e2e/e2e-http.json` | 2.2 KB | 401/404/ECONNREFUSED、CSP/XFO/COOP 均缺失、token cookie 回放失败 |
| `artifacts/e2e/probe-render.trace.log` | 334 B | `app:ready` → 单屏信息 → `window:created 521×721 / 520×720` → 随后 FATAL |
| `artifacts/e2e/probe-render.stdout.log` | 1.4 KB | `FATAL:mojo\public\cpp\platform\platform_channel.cc:112` 原文 |
| `artifacts/e2e/edge-headless-probe.log` | 406 B | 系统 Edge `--headless=new` 同样 `0x80000003` 退出，排除 “Electron 特有 bug” |
| `artifacts/e2e/single-process-probe.log` | 465 B | `--single-process` 120s 挂起、无 trace，无可用 workaround |
| `artifacts/e2e/electron-version.log` | 10 B | 清空 `ELECTRON_RUN_AS_NODE` 后 `v45.2.2` |
| `tests/e2e/README.md` | — | 三层测试的复跑说明 |
| `tests/e2e/live/live-report.json` | 待生成 | 沙箱外 live harness 输出（步骤状态/指标/冷启动/控制台） |
| `tests/e2e/live/shots/*.png` | 待生成 | 11 张计划截图 |

历史 t1 证据仍在 `artifacts/`（`smoke-run.log`、`main-trace.log`、`named-pipe-probe.txt`、`token-info.txt`、`winforms-probe.png`），本轮未重复。

---

## 5. 实际执行记录

### 5.1 静态检查

```
node --check app/main.js app/preload.js src/{constants,window-state,hotkeys,hud-window,discovery,compact-css,web-embed,autostart}.js renderer/{hud,web-preload}.js
  => 12/12 exit 0
node --check plugin/index.js => 0
node --check tests/e2e/live/main.cjs + 5 个测试文件 => 0
node JSON.parse(app/package.json) => valid dsh-hud 0.2.0
node JSON.parse(plugin/package.json) => valid @dsh-hud/token-bridge 1.0.0
import(plugin/index.js) => exports: apply
```

> 注意：用 PowerShell `ConvertFrom-Json` 读 `app/package.json` 会因控制台编码把中文 description 读成乱码并误报 INVALID；**以 Node `JSON.parse` 为准**。这是 QA 工具的假阳性，不是产品缺陷。

### 5.2 Headless 集成测试（20/20）

命令：

```powershell
node --test --test-isolation=none --test-reporter=spec `
  tests\e2e\unit\core.test.cjs `
  tests\e2e\unit\hud-window.test.cjs `
  tests\e2e\unit\main-boot.test.cjs
```

结果：`tests 20 / pass 20 / fail 0`，`EXIT=0`，耗时 2.35s。

覆盖点：

- `discovery`：文件缺失/损坏/有效、tokenURL、cleanURL、age（Infinity 容错）
- `window-state`：默认值、immediate 原子写、400ms 防抖合并、损坏容错、坐标 round
- `hotkeys`：默认注册、trigger、`update` 持久化、dispose、注册失败非致命
- 窗口：无边框透明 280×64、`screen-saver` 置顶、skipTaskbar；胶囊点击 → 520×720 面板（位置 1392,280）；拖拽 → 吸附 8,500 → 防抖持久化 → 重启恢复；面板位置独立记忆
- 收起：Esc、blur、renderer `collapse-out` 握手、280ms 兜底、`DSH_HUD_NO_ANIM=1` 立即收起
- 双屏：副屏恢复 `2000,600`；面板钳位 `2000,8`
- WebEmbed：无 discovery → error.html（unreachable）；死端口 → error；token→clean→401 刷新→auth 错误页；HTTP 500→http 错误页；子帧响应忽略；`web-bounds` IPC、collapse detach 保活；重试强制 token reload；startDsh 复用 discovery
- `main.js`：单实例、只建 1 窗、热键注册、加载 `renderer/index.html`、ready-to-show 显示胶囊、second-instance 展开 520×720、will-quit 注销热键；无锁进程 quit 且 0 窗口

> 必须加 `--test-isolation=none`：默认 runner 为每个测试文件 spawn 子进程（pipe stdio），在本会话受限令牌下直接 `Error: spawn EPERM`（errno -4048）。这是环境限制，不是测试代码问题。

### 5.3 插件契约测试（5/6）

```powershell
node --test --test-isolation=none --test-reporter=spec tests\e2e\unit\plugin.test.mjs
```

通过：discovery 写入（token URL、pid、port、updatedAt、不落 origin）、spawn 参数/环境、origin 变化触发 reload、`/dsh-hud` 四命令与 stdin 通知、dispose 清理、缺 subprocess 服务不崩溃。

失败：`respawn: linear backoff, then stops at maxRespawns` → `4 !== 3`。原因见 §6.1 D1。

### 5.4 DSH Web 鉴权矩阵（真实 HTTP）

`tests/e2e/probe-http.mjs` → `artifacts/e2e/e2e-http.json`：

| 请求 | 结果 |
|---|---|
| `GET http://127.0.0.1:61352/` | **401**，68B，`dsh web authentication required; reopen the URL printed by dsh web.` |
| `GET /api/health` | **401**，12B，`unauthorized` |
| `GET /assets/` | **404**，0B（未带 cookie 的静态资源不可达） |
| `GET http://127.0.0.1:50265/`（旧 discovery） | **ECONNREFUSED** |
| `GET http://127.0.0.1:50265/?token=d29T…` | **ECONNREFUSED** |
| 响应头 | `content-security-policy` / `x-frame-options` / `cross-origin-*-policy` 均为 `null` |

旧 discovery：`pid 22896, port 50265, updatedAt 2026-11-04T17:31:12.024Z`，探测时已陈旧 **131,802,441 ms（约 36.6 小时）**。这同时证明：

1. 运行中的 DSH Web 强制 token（裸 URL 401）；
2. 旧 discovery 不会被自动清理（DSH 异常退出时插件来不及 dispose），HUD 打开时会走“错误页”路径——这正是 S1 的真实输入。

---

## 6. 缺陷与风险

### 6.1 D1（高）插件 `maxRespawns` 失效，HUD 崩溃会无限重拉

- 文件：`plugin/index.js:227`（`respawnCount = 0;` 在**每次 spawn 成功后**清零）
- 复现：`node --test --test-isolation=none tests/e2e/unit/plugin.test.mjs`，用例 `respawn: linear backoff...`；`maxRespawns: 2` 时第 3 次退出仍会拉第 4 个进程（`4 !== 3`）。
- 预期：连续异常退出的重拉次数达到 `maxRespawns` 后停止并只记日志。
- 实际：每次 spawn 都把计数清零，`respawnCount >= maxRespawns` 永远不成立，形成无限“退出→重拉”，每次重拉都重新注册单实例失败分支（见 D4）。
- 建议：仅在子进程稳定运行一段时间（如 ≥30s）后再重置计数；或把 reset 移到“首次成功加载 Web UI”之后。

### 6.2 D2（中）`control.json` 并发写竞争，最后一次动作可能丢失

- 文件：`plugin/index.js:150-163`（所有 `sendControl` 共用一个 `control.json.tmp`，各自 `writeFile`+`rename`）
- 复现：连续快速调用 `/dsh-hud show|hide|toggle|reload`；`plugin-tests.log` 出现
  `control.json write failed: ENOENT ... rename control.json.tmp -> control.json`。
- 影响：文件 watcher 可能看到旧动作；配合 D3，HUD 侧本来就没接收器，问题被掩盖。
- 建议：串行化写入队列（单一 promise chain）或每动作唯一 tmp 名；失败重试一次。

### 6.3 D3（阻塞集成，高）HUD 侧没有 control.json/stdin 接收器

- 证据：`docs/plugin-app-bridge.md` 的“浮窗侧集成钩子（待 app 侧落地，不在本次 plugin 内）”明确列出待办；`app/src/hud-window.js`/`main.js` 中搜索不到 `control.json`、`fs.watch`、stdin 解析，也没有文档示例调用的 `hud.reloadWeb()`。
- 影响：即使插件安装成功：
  - `/dsh-hud show|hide|toggle|reload` 只写文件/管道，HUD 不响应；
  - DSH 端口换绑（origin 变化）时插件发 `reload`，HUD 不会重载 Web UI；
  - 只能靠用户点胶囊/按热键，命令面板形同虚设。
- 建议：在 app 主进程加 ~12 行接收器（fs.watch control.json + `process.stdin` newline JSON），映射到 `showPanel/showCapsule/reload`；或在插件内改为直接调用 HUD 的现有 IPC/HTTP 控制通道。

### 6.4 D4（中高，未真机复现）单实例 + 重拉导致面板反复弹出

- 路径：插件 spawn 新 HUD → 拿不到 `requestSingleInstanceLock` → `app.quit()` → `child.done` → 插件重拉 → `second-instance` 事件让已运行 HUD `showPanel()`。
- 结合 D1，会无限循环，每次都可能把面板弹到前台（打断用户输入）。
- 建议：插件 spawn 前探测单实例（如命名互斥/控制文件 pid 存活）；`child.done` 在“已有一个 HUD 在跑”时不要重拉。

### 6.5 D5（低）`subprocess` 缺失时的守卫写法会误报 “spawn failed”

- 文件：`plugin/index.js:203`：`if (subprocess && typeof subprocess.spawn !== 'function') return;`；`subprocess` 为 undefined 时继续执行，213 行抛 TypeError，被 catch 记成 `spawn failed: Cannot read properties of undefined`。
- 已用 `plugin.test.mjs` 的 degradation 用例锁定：不崩溃、token 桥仍工作，但日志误导。
- 建议：改成 `if (!subprocess || typeof subprocess.spawn !== 'function') { log('subprocess service unavailable'); return; }`。

### 6.6 观察项（非缺陷）

- 陈旧 discovery 不会自动删除：DSH 崩溃/强杀时插件没机会 dispose，HUD 会先看到死端口错误页，等新 DSH + 插件写入后才恢复。符合设计（错误页可重试），但用户提示“约 15 秒内可重试”在 DSH 未启动时不成立，建议文案区分“等待 DSH/插件”。
- 环境版本显示冲突：注册表 `ProductName=Windows 10 Home China`，build 26200.9711 实际为 Windows 11 25H2；验收记录以 build 为准。

---

## 7. 真实 GUI 被阻断的证据（本会话）

### 7.1 根因

DSH agent 进程运行在 **Low Mandatory Level + restricted token** 下（4 个 restricted SID，仅 `SeChangeNotifyPrivilege`）。Chromium 子进程能创建命名管道，但 `CreateFileW` 打开管道被拒（Windows error 5）。Electron 主进程能 `app.whenReady()`、能 `new BrowserWindow()`，但在首次渲染时崩溃。

### 7.2 复现命令与结果

```powershell
$env:ELECTRON_RUN_AS_NODE=''
spike\node_modules\electron\dist\electron.exe --no-sandbox --out artifacts\e2e tests\e2e\probe-render
```

输出（`artifacts/e2e/probe-render.trace.log` + `probe-render.stdout.log`）：

```
app:ready electron=45.2.2 chrome=156.0.8078.80
displays=[{"id":3656128256,"bounds":{"x":0,"y":0,"width":1707,"height":1067},"workArea":{"x":0,"y":0,"width":1707,"height":1019},"scaleFactor":1.5,"primary":true}]
window:created size=[521,721] content=[520,720]
[...:FATAL:mojo\public\cpp\platform\platform_channel.cc:112] Check failed: . : 拒绝访问。 (0x5)
```

进程退出码 `-2147483645`（0x80000003），无 PNG 产出。

### 7.3 排除项

| 尝试 | 结果 | 结论 |
|---|---|---|
| 系统 Edge `--headless=new --disable-gpu --screenshot` | 同样退出码 `-2147483645`，无截图 | 不是 Electron 特有缺陷，任何 Chromium renderer 都不行 |
| Electron `--single-process` | 120s 挂起，无 trace/JSON，留下 zombie pid 18104（taskkill 也 Access denied） | 不可用 workaround |
| 清空 `ELECTRON_RUN_AS_NODE` + `--no-sandbox` | 主进程可到 `window:created`，仍 FATAL | 环境限制，不是参数问题 |
| `Start-Process -RedirectStandardError` | Access denied | 受限令牌禁止重定向管道 |

因此本轮无法完成“每步截图 / 真机发消息 / 内存 / 冷启动 / 多屏拖动”。**任何把本轮写成“真机通过”的报告都是不真实的。**

---

## 8. 沙箱外复跑指南（补全截图与指标）

### 8.1 准备

1. 安装 Cordis 插件（需要 Full access / danger-full-access 的会话）或手动把 `plugin/` 作为 bundle 安装；确认 `%LOCALAPPDATA%\dsh-hud\discovery.json` 在 DSH 启动后 15s 内出现且 URL 带 `?token=`。
2. 正常启动 DSH 桌面版（`D:\deepseek\DeepSeek Harness.exe`）。
3. 打开一个普通 PowerShell（**不是** DSH agent 会话），进入 `D:\DeepSeekData\workspace\dsh-hud`。

### 8.2 执行

```bat
tests\e2e\run-live.cmd
```

或手动：

```powershell
$env:ELECTRON_RUN_AS_NODE=''
$env:DSH_HUD_OPAQUE='1'
$env:DSH_HUD_E2E_T0=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
spike\node_modules\electron\dist\electron.exe --no-sandbox tests\e2e\live\main.cjs --phase=run
spike\node_modules\electron\dist\electron.exe --no-sandbox tests\e2e\live\main.cjs --phase=restore
```

输出：

- `artifacts/e2e/live/live-report.json`：每步 status、窗口 bounds、冷启动 ms、`metrics[].totalMB/totalCPU`、budget 判定、控制台错误。
- `artifacts/e2e/live/shots/e2e-01-capsule.png` … `e2e-11-restart-restored.png`。
- `artifacts/e2e/live/profile/`：userData（`window-state.json`）。

### 8.3 仍需人工确认的 3 项

| 项 | 操作 | 通过标准 |
|---|---|---|
| 全局热键 | 收起状态下按 `Control+Alt+Space`，再按一次 | 双向切换；无焦点抢占异常；日志有 `[hud] 全局热键已注册` |
| 多屏拖动 | 接第二块屏，把胶囊拖过去再拖回 | 吸附/钳位正确；重启后仍在最后位置；面板不出屏 |
| 插件命令 | DSH 里执行 `/dsh-hud show/hide/toggle/reload` | 浮窗响应（**当前会被 D3 阻断，需先修**） |

### 8.4 真机检查清单（12 条，任何一条失败即回归失败）

1. 未启动 DSH 双击 HUD：出现自绘“无法连接 DSH”，不是白屏/崩溃
2. 错误页“重试”在 DSH 启动后能加载出 Web UI
3. 插件拉起 HUD，`discovery.json` 出现且 token URL 可 200
4. 胶囊点击 → 520×720 面板，位置在胶囊上方且不出屏
5. `Control+Alt+Space` 双向切换，面板展开后输入框有焦点
6. 面板内发出消息，出现流式回复，滚动/输入不卡顿
7. 切换会话后内容刷新，无空白
8. `Esc`/失焦/收起按钮均回胶囊，焦点还给前一个窗口
9. 胶囊拖到屏幕边缘吸附 24 DIP 内，位置重启保持
10. 多屏下胶囊在副屏、面板钳位进副屏 workArea，拔插显示器后不消失
11. 重启 HUD/DSH 后位置与模式正确恢复，单实例不重复开窗
12. 常驻 10 分钟：内存 <150MB、CPU 空闲接近 0、控制台无持续报错

---

## 9. 未覆盖 / 下一步

- [ ] 真实截图 11 张（阻塞于 §7；`run-live.cmd` 已就绪但本轮**未执行**）
- [ ] 内存/CPU 与冷启动实测（同上）
- [ ] 发消息/流式/换会话（需要 live token；本轮未拿到）
- [ ] 多屏真机（当前只有一块屏）
- [ ] 插件安装后的 `/dsh-hud` 命令（先修 D3）
- [ ] 修复 D1/D2/D4/D5 后重跑 `plugin.test.mjs`（期望 6/6）
- [ ] 修复 D3 后补一条 app 侧集成测试（control watcher/stdin）

报告结束。所有“未执行/未测”项均未使用推断数据填充；`live-report.json` 与截图缺失即代表真机验收尚未完成。

---

## 10. 修复复核与真机补证（2026-11-06 晚，captain）

本轮解决了 §7 的阻断（根因是共享 `%APPDATA%\Electron` 配置目录损坏，而非令牌/二进制），HUD 已在真实桌面跑通，并修掉 t8 的 D1–D5 与两项用户反馈。

### 10.1 缺陷状态

| 缺陷 | 状态 | 修复位置 | 证据 |
|---|---|---|---|
| D1 重拉无限循环 | 已修 | `plugin/index.js:315-322` 只在稳定运行后清零计数；`:239` 上限生效；新增「退出码 0 不重拉」（单实例移交/用户主动关闭） | `artifacts/plugin-diag.log` 出现 `respawn limit reached; giving up auto-restart` |
| D2 control.json 并发 ENOENT | 部分（t12 复核后补修） | 唯一临时名 `${cFile}.${pid}.${seq}.tmp` + 串行写链；**启动时**清理残留 `*.tmp`（t12 指出原先只在 dispose 清理，已在 `apply` 开头补 `cleanupTmpFiles()`） | 并发用例不再报 ENOENT；启动清理目前仅静态验证，待重启插件后复核 |
| D3 HUD 侧无控制接收器 | 已实现 | 新增 `app/src/control.js`（ControlBridge，control.json + stdin 双通道，seq 去重持久化 `userData/control-state.json`）；`app/main.js:74-85` 接 `toggle/show/hide/reload` | `hud-window.js:198 reloadWeb()`、`:188 focusIfVisible()` 已存在并被调用 |
| D4 重拉反复弹面板 | 已修 | `app/main.js:57-61` second-instance → `hud.focusIfVisible()`，不可见时不再 `showPanel` | 与 D1、exit0 不重拉共同消除循环 |
| D5 守卫误报 spawn failed | 已修 | `plugin/index.js:265` 改为 `if (!subprocess \|\| typeof subprocess.spawn !== 'function')`，直接跳过并记日志 | 日志文案 `subprocess service unavailable; skipping spawn` |

### 10.2 用户反馈的两处真 bug

1. **拖动时窗口无限制放大**：diag 显示拖动期间 `resize content=282x66 → 282x68 → … → 364x118`，且**没有任何 applyBounds 调用**——逐帧 `setPosition` 让 Windows 重新套用内容尺寸并叠加隐形边框。改法：拖动与展开/收起统一用原子 `setBounds({x,y,width,height})`（`hud-window.js:274-282, 456`）；面板标题栏改为原生拖动区 `-webkit-app-region: drag`（按钮 `no-drag`），位置由窗口 `move` 事件防抖落盘。
2. **打开侧栏后左侧点不动**：clicks.log 显示所有点击都命中 `mP3x-q_drawerMask`——视口 474px < 768 时 UI 走 narrow drawer 分支，遮罩压在侧栏之上。改法：默认走桌面分支（preload 设 `data-windows-titlebar`，并修复 preload 早于 DOM 导致标志丢失的时序），另加 CSS `C9` 让 mask `pointer-events:none` 兜底。`DSH_HUD_DESKTOP_LAYOUT=0` 可关。

### 10.3 真机证据

> **证据时效说明（t12 复核提出，已更新）**：15:27 的三张 png 是修复前基线。**17:21 重新采集的产物已包含 `thickFrame:false` 修复**，尺寸回到精确值：
>
> | 证据 | 修复前 (15:27) | 修复后 (17:21) | 换算 CSS px |
> |---|---|---|---|
> | `hud-capture.png` | 783×1083 | **780×1080** | 520×720 ✅ |
> | `hud-capture.capsule.png` | 423×99 | **420×96** | 280×64 ✅ |
> | `hud-capture.web.png` | 708×939 | 681×903 | 454×602 |
>
> 面板/胶囊的 ±2px 漂移（522×722 / 282×66）已消失。拖动过程的 `diag.log` 仍待一次交互式复采（用户本轮未开 `DSH_HUD_DEBUG`）。
>
> **最终真机回归（18:04，P2 代码冻结后重采）**：`hud-capture.png` 780×1080（520×720）、`hud-capture.capsule.png` 420×96（280×64）、`hud-capture.web.png` 680×902；内嵌页渲染出 DSH 新会话欢迎页（主题完整、输入框可用）。这组产物晚于 17:34–17:47 的最终代码，可作为 P2 后验收证据。
>
> 采集时的踩坑与修复：交互 HUD 在 Low IL 终端里回退到 `artifacts\udd-hud`，与 capture 的清理匹配串 `*udd-hud*` 撞名，导致「跑 capture 把用户正在用的窗口杀掉」。capture 专用 profile 已改为 `artifacts\udd-capture`，清理只匹配 `*udd-capture*`；`smoke-44/matrix-44/probe-44/logprobe-44` 里的 `taskkill /f /im electron.exe` 也一并换成 `*udd-*` 精确过滤。

| 证据 | 内容 |
|---|---|
| `artifacts/hud-capture.png` | 520×720 无边框圆角面板，标题「DSH 助手」，— / × 按钮 |
| `artifacts/hud-capture.web.png` | 面板内嵌 DSH Web UI 真实渲染（onboarding「预览版说明」弹窗） |
| `artifacts/hud-capture.capsule.png` | 蓝紫渐变胶囊 + 绿点 + ×，280×64 |
| `artifacts/capture-out.log` | `[hud] 全局热键已注册: Control+Alt+Space`、三张 capture written、exit 0 |
| `%LOCALAPPDATA%\dsh-hud\discovery.json` | 16:13:05Z 仍在刷新（pid 10548, port 61352），token 桥在线 |
| 用户实测 | 「基本功能能用，能够正常对话」；修完两处后「都可以了」 |

### 10.4 仍未闭环

- `spawnApp` 与 `shellLaunch` 均为**默认关闭的可选路径**（用户 m02731：「保留两个启动方式，默认人工允许的那条命令是关闭的」）：直接子进程在本机会以 `0x80000003` 崩（crashpad/mojo 管道被拒），Explorer 代启动会弹人工允许框。默认路径是登录 Startup 脚本 + 双击/托盘菜单，插件只负责 discovery token、`/dsh-hud` 命令、窗口置前请求与 autostart 校准。
  - `Startup\dsh-hud.cmd` 由宿主（Medium）代写（HUD 是 Low，写不了 Startup 目录），内容在 `docs/plugin-app-bridge.md` 的 autostart 段。
  - launcher 的 user-data 目录优先 `app/../artifacts/udd-hud`，与 `run-hud.cmd` 的回退路径一致，避免两条启动路径各持一个单实例锁、出现两个胶囊。
- portable 产物 `dist\DSH HUD.exe` 未嵌图标/版本资源（electron-builder 在沙箱内 spawn EPERM，需沙箱外跑 `build-portable.cmd`）。
- 开机自启代码已就绪（`app/src/autostart.js`）但未启用。
- 常驻内存/CPU、冷启动、多屏仍无实测数据。
- `/dsh-hud` 命令的端到端真机验证（control.json → HUD 响应）尚未由用户在桌面执行确认。
- **B3 跨屏拖动**：150%↔100% 双显示器的手感需真实光标，本机单屏无法验证（代码已改为主进程 `getCursorScreenPoint` 归一化）。
- **UI 待办（18:04 截图发现）**：内嵌 DSH 页在 HUD 里仍渲染右上角的窗口控制按钮（最小化/最大化/关闭），在悬浮面板里是多余的；下一轮 UI 优化时应与 `data-windows-titlebar` 分支一起收掉。
- 已闭环于 P2：B1（清理/写入竞态）、B4（诊断日志默认路径改到 `os.tmpdir()`）、B6（control rename 的 EPERM/EBUSY 退避重试）。

### 10.5 打包重建 / 内嵌尺寸 / 重连生命周期（t21 · overlay）

依据 `docs/bug-audit-2.md`（spike/t20）的三条状态：

| # | 缺陷 | 状态 | 修复 |
|---|------|------|------|
| 1 | P0 BLOCKER 打包失效（asar 缺 scripts/**，dist 是旧 45.2.2 构建） | ✅ 已闭环 | `make-portable.js` 改用 `runtime/node_modules/electron/dist`（44.7.0）全量重建 + 打包 `scripts/` + afterPack 断言；`package.json` electronDist 指向 runtime |
| 2 | P1 HIGH 内嵌视图偏小约 4%（展开动画期间测量且事后不重测） | ✅ 已闭环 | 新增 `renderer/host-bounds.js`（offsetWidth/offsetHeight 取尺寸，不受 transform 影响）；`hud.js` 先量后播 + animationend 强制重测 |
| 3 | P1 HIGH 错误页无限重连（reload→showError 反复清零 ticks） | ✅ 已闭环 | `web-embed.js` 恢复期只允许一个 episode（`_recovering` 存在时不清零 ticks），成功加载或 destroy 时复位 |

验证：

- `node --check` 全部通过；`app/scripts/check-hud.cmd` 14 文件 `RESULT=ALL_PASS`（exit 0）。
- 单测 `node --test --test-isolation=none tests/e2e/unit/*`：**37/37**（core 5 / hud-window 18 / main-boot 2 / plugin 12，含新增 2 条：host-bounds 布局尺寸、recovery 单 episode）。
- 重建 dist：`dist/win-unpacked/version` = **44.7.0**；`DSH HUD.exe` 246MB；`resources/app.asar` 30 条目（@electron/asar listPackage）/ 27 文件（artifacts/asar-list.cjs），关键项 `scripts/focus-dsh.ps1`(3673B)、`scripts/launch-hud.cjs`(2899B)、`src/hud-window.js`(31176B，已非旧 15106B 快照) 均 PRESENT。
- 会话内仍无法跑 electron-builder：其 node 模块收集阶段 spawn pnpm（piped stdio）撞 DSH 沙箱命名管道边界（EPERM，与 t9 同类），故走 `make-portable.js` 纯 JS 路径（`@electron/asar` + `fs.copyFileSync`，零子进程 spawn）。

遗留（需用户侧沙箱外）：`build-portable.cmd`（electron-builder）跑一次以嵌入图标/版本资源 + 生成 zip；真机确认内嵌页不再缩小。

### 10.6 打包缺件断言静态化 / detach 停恢复（t24 · overlay）

依据 `docs/acceptance-verify-p3.md`（t23）的两条状态：

| # | 缺陷 | 状态 | 修复 |
|---|------|------|------|
| 1 | HIGH afterPack 断言对 src/renderer 用 readdirSync 动态生成清单，删掉 src/hud-window.js 后仍 exit 0 | ✅ 已闭环 | `make-portable.js` 新增静态 `CANONICAL_FILES`（21 项逐条写死）+ 打包前 `assertSourceFiles()`（缺件立刻 exit 1 打印缺失项）+ `assertAsarContents` 改用同一静态清单 |
| 2 | MEDIUM `web-embed.js` detach()/destroy() 未停恢复计时器（t20 #8） | ✅ 已闭环 | `detach()` 开头加 `_stopRecovery()`（destroy 原有保持不变）；补单测验证 detach/destroy 均清 `_recovering` + `_recoveryTimer` |

验证：

- `node --check` 改动 JS 全通过；`app/scripts/check-hud.cmd` 15 文件 `RESULT=ALL_PASS`（exit 0）。
- 单测 `node --test --test-isolation=none tests/e2e/unit/*`：**38/38**（core 5 / hud-window 19 / main-boot 2 / plugin 12，含新增 1 条：detach/destroy 停恢复）。
- 缺件负测：复制 app 到临时目录删 `src/hud-window.js`，`DSH_HUD_APP_DIR=<temp> node make-portable.js` → **exit 1** 并打印 `SOURCE FILE ASSERTION FAILED — missing: src/hud-window.js`。
- 正常重建：`node app\scripts\make-portable.js` → exit 0，`source files assertion OK (21)` / `asar content assertion OK (21)` / `app.asar entries: 30`；`artifacts/asar-list.cjs` 复核 **27 文件**，`src/hud-window.js`(31641B)、`scripts/focus-dsh.ps1`、`scripts/launch-hud.cjs` 均 PRESENT。
- `make-portable.js` 新增 `DSH_HUD_APP_DIR` 环境变量覆盖（仅覆盖 APP_DIR，供负测；正常构建不设置）。

遗留（需用户侧沙箱外）：真机确认胶囊收拢后错误页不再后台轮询重连（代码已由 detach 停恢复保证，待交互验证）。


## 11. 后续 UI 优化（用户 m02976 六条决定）

状态：**进行中**。第 1、3 条已实现；第 2 条等用户手绘设计稿；第 4、5 条列待办。

| # | 用户决定 | 状态 |
| --- | --- | --- |
| 1 | 内嵌页右上角那组很淡的 DSH 自带窗口控件：整组隐藏 | **进行中** — 先用 `DSH_HUD_DUMP_DOM=1` 抓 `artifacts/embed-dom.json` 定位真实选择器，再写隐藏规则（不靠猜 class） |
| 2 | 面板/胶囊视觉收口：配色跟随 DSH 主题、圆角与状态点语义、hover/按下态 | 等用户手绘概念图（m02976 第 6 条） |
| 3 | 图标去掉白色圆底只留鲸鱼；hover 不再显示 ×；「退出 DSH 浮窗」并入右键菜单 | **已完成** — `.capsule-icon` 透明底 + 鲸鱼白描边/投影、删除 `#capsule-close`、菜单新增`退出 DSH 浮窗`（`hud-window.js` `buildContextMenu`） |
| 4 | 472px 走 DSH 窄宽分支（drawer/遮罩已关），不做专用紧凑布局 | 待定计划（m02976 第 4 条） |
| 5 | 未做：面板内命令面板入口、拖拽中的边缘吸附提示动画 | 待办 — 仿豆包悬浮球的做法（m02976 第 5 条） |
| 6 | UI 设计：用户手绘概念图后上传 | 等图中 |

## 12. 鲸鱼边框 UI（2026-11-10 落地）

用户从豆包 Seedream 生成的素材里定稿了「Q 版鲸鱼头 + 海浪细线稿」装饰带与尾鳍，落地要点：

- 几何：`CARD 600×816` + 透明外边距 `30/30/30/54` → 窗口 **660×900**；`PANEL_WIDE` 1040×900；内嵌页内缩 `13/101/13/57`（574×658）。
- 素材：`renderer/assets/band-wave.png`（装饰带，62% 宽居中）、`tail-fin-flat.png`（纯卡片底色 `#191d36`，无描边，底部居中，宽 112）。
- 样式：卡片 `#191d36`、圆角 28；无内容框描边；两侧灰色竖线；底部内联 SVG 蝴蝶结；标题 + –/× 浮于装饰带之上。
- 已删除：卡片外描边、装饰带整宽白线、内容区白框（均按用户逐条反馈）。
- 验证：单测 53 全绿（hud-window 23）；真机截图 `artifacts/hud-capture.png`（660×900 @1.5 = 990×1350）与合成图 `art/mockup-final.png`；打包 39 条目、28 canonical 全在。

### 12.1 标题栏/按钮态 + 展开收起动画曲线（t30 · overlay）

- 标题 `.panel-title`：15px / 600 / letter-spacing 0.4px / line-height 20px（基线固定，不随装饰带 `.frame-band` 变化）。
- 按钮 `.panel-btn` 32×32、圆角 12、`-webkit-app-region:no-drag`（顶栏 `.panel-header` 仍 drag），三态颜色（深色卡片 `#191d36` 上）：
  - 默认：背景 `rgba(255,255,255,0.14)`、文字 `#eef1ff`
  - hover：`rgba(255,255,255,0.26)`（`.danger` hover `rgba(255,92,122,0.6)`）
  - active：`rgba(255,255,255,0.34)` + `transform:scale(0.94)`（`.danger` active `rgba(255,92,122,0.8)`）
  - focus-visible：2px 半透明蓝环 `box-shadow:0 0 0 2px rgba(79,124,255,0.5)`，仅键盘导航显示（鼠标点击不显示）
- 动画（时长与 `constants.ANIM_EXPAND_MS=180` / `ANIM_COLLAPSE_MS=140` 一致）：
  - 展开 `expand-in` 180ms `cubic-bezier(0.22,1,0.36,1)`：opacity 0→1 + scale(0.97→1) + translateY(-6px→0)
  - 收起 `collapse-out` 140ms `cubic-bezier(0.4,0,1,1) forwards`：opacity 1→0 + scale(1→0.97)
  - `@media (prefers-reduced-motion:reduce)`：重定义两段 keyframes，只保留 opacity 淡入/淡出（去 scale/位移）
- 测量保障：动画 transform 作用在 `.panel-card`（非 `#web-host`）；`readHostBounds` 用 offsetWidth/offsetHeight 取尺寸（忽略 transform），展开前 + `animationend` 后各测一次，故动画期间 ResizeObserver 不被 transform 打断、动画结束后 web view 边界与静止态一致。
- 验证：`node --check` 通过；`hud-window.test.cjs` 23/23、`core.test.cjs` 5/5。

## 13. 主题跟随（内嵌页 → 面板/胶囊配色）（2026-11-10 · t34 · overlay）

内嵌 DSH Web UI 切换浅/深主题时，HUD 外壳与胶囊跟着换配色（520×720 版，鲸鱼边框已回退）。链路：

1. `renderer/web-preload.js`：`detectTheme()` 优先读 `document.documentElement.dataset.theme`（兼容 `data-theme`/`data-ds-theme`），再 `data-ds-dark-theme`，再 className 关键字，最后 body 背景亮度（lum<140=dark）；`reportTheme()` 变化时发 `ipcRenderer.send('hud:web-theme', { theme })`；`MutationObserver` 观察 `<html>`/`<body>` 的 `data-theme/data-ds-theme/data-ds-dark-theme/class` 即时上报 + `setInterval` 700ms 兜底。
2. `src/hud-window.js`：`_onWebTheme` 兼容 `{theme}` 对象与裸字符串；`setEmbeddedTheme` 归一化非 `light` → `dark`；`_pushTheme` 发 `win.webContents.send('hud:theme', t)` 并 `_saveTheme` 原子写 `userData/theme.json`；`load()` 里 `did-finish-load` 时先用 `_loadTheme()` 缓存值推给 shell（避免二次启动闪深色）。
3. `renderer/hud.js`：`hud.onTheme` 写 `document.documentElement.dataset.hudTheme = 'light'|'dark'`。
4. `renderer/hud.css`：`html[data-hud-theme="light"]` 覆盖 CSS 变量；`:root` 即深色默认（未上报不闪变）。

CSS 变量（深色默认 → 浅色覆盖）：

| token | 深色(:root) | 浅色(data-hud-theme=light) |
|---|---|---|
| `--card-bg` | `#191d36` | `#f5f6fb` |
| `--card-title` | `#eef1ff` | `#1a1f36` |
| `--btn-bg` / hover / active | `rgba(255,255,255,.14/.24/.3)` | `rgba(23,30,56,.06/.12/.18)` |
| `--btn-fg` | `#eef1ff` | `#1a1f36` |
| `--bg` | `#161a2b` | `#eef0f5` |
| `--fg` / `--fg-muted` | `#eef1ff` / `#9aa4c9` | `#1a1f36` / `#5a6273` |
| `--line`（鲸鱼白描边） | `rgba(255,255,255,.95)` | `rgba(26,31,54,.7)` |

手工验证：真机打开面板 → 在 DSH 内嵌页切浅色主题 → 面板卡片/标题/按钮/胶囊描边应在 ~1s 内跟着变浅；切回深色恢复；重启 HUD 后首次展开应直接用上次缓存的主题（无深色闪烁）。约束：不改窗口几何；不重建 WebContentsView、不 reload（主题上报是旁路）；`prefers-reduced-motion` 下主题切换无动画依赖。

验证：`node --check` 4 个改动 JS 通过；`check-hud.cmd` 15 文件 ALL_PASS；`hud-window.test.cjs` 24/24（新增「theme from embedded page is pushed to the shell renderer and persisted (t34)」：`{theme:'light'}`→shell 收 `hud:theme light`、`{theme:'bogus'}`→`dark`、裸字符串兼容、`theme.json` 落盘）；`core.test.cjs` 5/5、`main-boot.test.cjs` 2/2。



## 14. 命令面板 + 胶囊边缘吸附提示（2026-11-10 · t35 · overlay）

**命令面板**：面板展开时按 `Ctrl+K`（或点标题栏 ⌘ 按钮）打开；`Esc` 关闭。打开前主进程先 `web.detach()` 让出 DOM 层，关闭后重新 `attach` 并把焦点还给内嵌页输入框。面板列出右键菜单项 + 三条内置（打开 DSH 桌面窗口 / 打开 DSH 浮窗 / Token 补充），输入框按子串模糊过滤（无匹配显示「无匹配命令」），↑↓ 选择、`Enter` 执行。样式随主题（`--card-bg` + 1px 描边 + 14px 圆角，宽度 80% 最大 520）。

**胶囊边缘吸附提示**：拖拽胶囊距工作区边缘 ≤24 DIP 时，最近边显示 2px 高亮（`rgba(96,165,250,.9)`）淡入；松手吸附后 180ms 淡出。提示只改 CSS class（`.capsule-snap-left/right/top/bottom`），最终 `setPosition` 仍由主进程 `_snapCapsule` 决定。

改动：`preload.js`(+paletteOpen/paletteExec/paletteClose/onPaletteOpen)、`hud-window.js`(+_openPalette/_closePalette/_onPaletteExec/_onPaletteClose/_onPaletteOpenRequest + before-input-event Ctrl+K + ipcMain 3 通道 + destroy 清理)、`web-embed.js`(+onCommand + Ctrl+K before-input-event)、`renderer/index.html`(⌘ 按钮 + palette DOM)、`renderer/hud.js`(palette 渲染/过滤/键盘 + snap hint)、`renderer/hud.css`(.palette-* + .capsule-snap-*)、`hud-window.test.cjs`(+1)。验证：node --check 4 改动 JS 通过；check-hud.cmd 15 文件 ALL_PASS；hud-window 25/25、core 5/5、main-boot 2/2。

---

## §13 收尾批（2026-11-10 晚）：t38 复验 / P-03 / L1 / M1 / Release zip

### t38 复验（captain 用探针收口，qa 报告见 `docs/acceptance-verify-ui2.md`）
| 项 | 结果 |
|---|---|
| B1 缩放后拖动被重置 | 已修（`_panelUserSize` + `_panelSize()`），`probe-t38-drag-resize.cjs` → `allKeep: true`（right 720、bottom 780 都保持） |
| H1 面板开着收起后 Ctrl+K 失效 | 已修（`collapse()` 先 `_closePalette()`），`probe-t38-palette-esc.cjs` → exit 0、`attached:false` |
| Ctrl+K 再按不收起 | 已修（`_togglePalette()`），单测「palette shortcut toggles」通过 |

### 本轮新增/修复
- **P-03 外部扩展目录**：`app/src/extensions.js` 的 `loadExtensionFiles()`，建窗前加载
  `<exe>/extensions/*.js` 与 `%LOCALAPPDATA%\DSH HUD\extensions\*.js`；支持函数式导出、
  `setup()`、`activate(api)`；`protocolVersion !== 1` 跳过；`DSH_HUD_NO_EXTENSIONS=1` 关闭；
  失败只写 boot log 不影响启动。单测 `extensions.test.cjs` 6/6。
- **L1 首启闪深色**：`_loadTheme()` 在无 `theme.json` 缓存时回退 `nativeTheme.shouldUseDarkColors`。
- **M1 测试偶发红**：`plugin.test.mjs` 的临时目录清理对 `ENOTEMPTY/EBUSY/EPERM` 退避重试，
  连跑 6 次全绿。
- **Release zip**：`make-portable.js` 的 `writeZip()` 自动产出
  `dist/DSH-HUD-<version>-win-x64.zip`（`--no-zip` 可跳过）；Compress-Archive 不跟随 junction，
  包内无 `artifacts/**`。
- **单测命令**：统一加 `--test-force-exit`（`main-boot` 结束后仍有 stdin/文件监听句柄）。
- `make-portable.js` 的 `rmrf()` 先摘除 junction 再删目录，修掉重建时 `EPERM` 的问题。

### 验证数据
- 单测：7 个套件全绿（config 4 / core 5 / extensions 6 / hud-window 28 / main-boot 2 / plugin 15 / relocation 1）。
- 真机包：`app.asar` 481,558 B；`DSH-HUD-0.3.0-win-x64.zip` 158,625,617 B、77 条目，
  含 `DSH HUD.exe`、`resources\app.asar`、`启动 DSH HUD.cmd`、`DSH HUD.lnk`，`artifacts` 条目数 0。
- 真机复测（captain 本机会话）：横向拖动后高度固定 720，纵向拖动后宽度固定 520。

---

## 14. 用户真机确认（2026-11-11）

用户在装有 0.3.0 便携包的机器上逐项验收，确认「现在都没问题了」的三项：

| 项 | 行为 | 结论 |
|---|---|---|
| 面板失焦 | 点窗口外不再自动收起（默认行为，`DSH_HUD_BLUR_COLLAPSE=1` 才恢复旧逻辑） | ✅ |
| 命令面板 | 标题栏 ⌘ 按钮 / `Ctrl+K` 打开；再按一次收起（`_togglePalette()`） | ✅ |
| 边缘改尺寸 | 按住左/右/上/下边缘拖动才改宽高；松开或按住不动尺寸不变（交叉轴取 session 快照，不再被 Windows 隐形边框带偏） | ✅ |

补充确认（2026-11-11 同一轮）：

| 项 | 结论 |
|---|---|
| 主题跟随 | ✅ 用户提供浅色 / 深色 / 第三方 UI 主题三种截图，壳配色跟着变 |
| 开机自启 | ✅ 重启后胶囊自动出现 |
| 双屏 / 跨 DPI | ⏸ 用户暂无第二块屏，暂不验证；保留为已知限制 |

新发现待分析：默认主题下内嵌页左上角侧栏按钮被裁（见 `操作日志/待解决问题.md` P-10）。
