# DSH HUD 第二轮隐藏 bug 审计（t20）

- 审计对象：`D:\DeepSeekData\workspace\dsh-hud`（t14–t20 合入后的当前工作树）
- 审计方式：只读静态审计 + 既有运行时证据（`artifacts\diag.log`、`artifacts\plugin-diag.log`、`artifacts\capture-out.log`、截图、`dist\win-unpacked\resources\app.asar`）+ 本会话新增探针（`artifacts\asar-list.cjs`）
- 审计基线（本地时间 2026-11-06 22:30）：`app\src\hud-window.js` 22:21:59 / 29787 B、`app\src\web-embed.js` 21:56:06、`plugin\index.js` 21:53:36、`app\renderer\hud.css` 19:44:48、`app\renderer\hud.js` 18:49:31、`app\main.js` 17:35:53、`app\package.json` 19:59:53
- ⚠️ 审计期间 `hud-window.js` 仍在被修改（22:21 刚改过），**下文行号以 22:30 的文件为准**；若文件再变，按代码片段检索即可定位
- 验证边界：本机 agent 会话处于受限令牌沙箱，真实 Electron 窗口无法在会话内启动（Chromium 命名管道 `0x5`），所以"能否复现"一栏区分「静态/日志已证」「需真机一次」两种；截图结论来自用户侧 19:10 的真实运行产物
- 分级：**blocker** = 分发即坏 / **high** = 用户可感知的功能错误 / **medium** = 特定路径可触发或长期劣化 / **low** = 卫生问题

---

## 1. 结论摘要

| 级别 | 数量 | 主要问题 |
| --- | --- | --- |
| blocker | 1 | 打包产物 `app.asar` 缺 `scripts/**`，且 `dist` 是 14:15 的旧构建、exe 为 45.2.2（开发验证用的是 44.7.0） |
| high | 3 | 错误页自动重连无限循环（每 5–30s 重载）；WebContentsView 在展开动画期间测量且事后不重测（视图比容器小约 4%）；`/dsh-hud` 命令在 HUD 正在运行时恒回「未在运行」 |
| medium | 8 | ±2px 日志仍在、900ms 焦点定时器未跟踪、`hudLikelyRunning` 快照过期、收起后仍后台重连、`startDsh` 的 2s timer 未跟踪、shell 无 CSP、单实例重复拉起、菜单重复启动 |
| low | 5 | 未使用导入、热键失败无提示、打包残留 `app/scripts/make-*.js`、`move` 去抖 timer、dist 体积 |

**一句话**：t14–t19 那批修复（单实例、原子写、控制序号、stdin 字段、窗口导航拦截、拖拽守卫、`thickFrame:false`）基本都落到了代码里；这一轮的主要风险从"代码逻辑"转移到了**打包与度量**——分发产物是旧的且缺文件，而视图矩形是在动画中途量出来的。

---

## 2. 主表（按严重度排序）

| # | 严重度 | 标题 | 文件:行号 | 现象与触发条件 | 证据 | 建议修法 | 本会话可否验证 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **blocker** | 打包 asar 缺 `scripts/**`，且 dist 是旧构建 / 版本不一致 | `app\package.json:22,27-34`；`dist\win-unpacked\resources\app.asar` | 分发版 `focus-dsh.ps1`、`launch-hud.cjs` 不在 asar 里。用户点「打开 DSH 桌面窗口」只走 explorer 启动、不再置前；插件 `spawnApp:true` 时 launcher 路径不存在直接跳过。另外 asar 内 `hud-window.js` 只有 15106 B（当前源码 29787 B），是 14:15 的旧快照 | `node artifacts\asar-list.cjs dist\win-unpacked\resources\app.asar` → `entries=16`、`[check] scripts/focus-dsh.ps1: MISSING`、`[check] scripts/launch-hud.cjs: MISSING`；`DSH HUD.exe` FileVersion=45.2.2；`spike\node_modules\electron\dist` 现有 `electron.exe.bak`（无 `electron.exe`），`version`=45.2.2；开发运行用的是 `runtime\node_modules\electron\dist`=44.7.0 | ① 重新 `pnpm build` 并在 `afterPack` 里断言 asar 含 `scripts/focus-dsh.ps1`；② `electronDist` 改指 `runtime\node_modules\electron\dist`（44.7.0）或把 `electron` 依赖固定到 44.7.0；③ 在 `dist` 里放 `build-info.json`（git rev + 时间）避免旧包误发 | 是（已证） |
| 2 | **high** | 错误页自动重连无限循环，2 分钟上限失效 | `app\src\web-embed.js:308-317, 322-346` | DSH 不可达时：`showError()` 每次都 `_startRecovery()` 并把 `_recoveryTicks` 归零；插件每 15s 刷新 `discovery.json`（`updatedAt` 变化）→ 每 5s 的 tick 里 `key` 变化 → `reload()` → 再失败 → 再 `showError()` → 再归零。于是错误页每 5s 闪一次，永不停止；即使 key 不变，`ticks%6===0` 也会每 30s 触发一次，同样因归零而无限 | 代码路径 `showError` → `_startRecovery`（316）→ 计时器（328-344）→ `reload`（342）→ `did-fail-load`（182-187）→ `showError`；`plugin\index.js:556-561` 每 `refreshMs` 用新 `updatedAt` 原子重写 discovery（`index.js:240`） | 用"连续失败次数"而非"本轮 tick 数"：失败计数放实例字段、只在 `did-finish-load` 成功时清零；给 `_startRecovery` 加 `attempt` 参数与指数退避（5s/10s/20s/40s，上限 5 次），超限后只保留手动「重试」；或在错误页存活期间忽略 `updatedAt` 变化、只认 `url`/`port` 变化 | 是（静态已证；真机可用"停掉 DSH 后观察错误页刷新间隔"复现） |
| 3 | **high** | 内嵌视图在展开动画期间测量，动画结束后不再重测 | `app\renderer\hud.js:62-79, 152-159`；`app\renderer\hud.css:154-163`；`app\src\hud-window.js:399-412` | `setMode('panel')` 先 `playExpand()`（加 `anim-expand`，`scale(0.96)→1`，180ms）再 `requestAnimationFrame(reportWebBounds)`；`getBoundingClientRect()` 在动画进行中返回**缩放后的**矩形（宽高变小、中心偏移）。`animationend` 的 `expand-in` 分支只移除类、不重报，`ResizeObserver` 也因 transform 不改变布局尺寸而不触发 → WebContentsView 永久停在动画中途的矩形上 | 用户侧截图：`hud-capture.web.png` = **692×914 px** @1.5 = **461.3×609.3 DIP**，而 `#web-host` 理论矩形是 `{x:14,y:60,w:492,h:646}`（=738×969 px，`hud-window.js:405-410` 的估算值与 CSS 一致）。比例 0.9377/0.9432 与"动画中途 scale"吻合（当前 keyframe 起点 0.96，19:10 截图时的 CSS 是 19:44 之前的版本） | 在 `animationend('expand-in')` 里补一次 `reportWebBounds()`（并 `setTimeout(..., ANIM_EXPAND_MS+20)` 兜底）；或把测量改为 `offsetWidth/offsetHeight` + 元素位置（不受 transform 影响），例如用 `webHost.offsetWidth/offsetHeight` 与 `panelCard.getBoundingClientRect()` 反推 | 是（截图与代码双向印证；精确比例需真机打印 `web.view.getBounds()`） |
| 4 | **high** | `/dsh-hud` 命令在 HUD 正在运行时恒回「未在运行」 | `plugin\index.js:502-505`（`note()`）、`472-485`（`ensureRunning`）、`494-527`（命令） | `spawnApp` 默认 `false`，`ensureRunning()` 在 spawnApp 关闭时不会被调用，`child` 恒为 `null`；`note()` 用 `child ? okText : failText` 判成功。结果：control.json 已经写了、HUD 也已经消费并打开了面板，命令却回「已发送显示指令，但 HUD 未在运行（指令被忽略）」 | `plugin\index.js:498` `if (cfg.spawnApp) ensureRunning();`；`502-505` `text: child ? okText : failText`；默认值 `spawnApp: config.spawnApp ?? false`（102-107） | 成功判定改为 `child || hudLikelyRunning() || 写入后 300ms 内 discovery 的 pid 存活`；或直接在 `sendControl` 返回值里带"是否写入成功"，文案只报写入结果 | 是（静态已证） |
| 5 | medium | 内容区 ±2px 仍出现在日志里，`_applyBounds` 的严格比较可能反复纠正 | `app\src\hud-window.js:428-445` | `diag.log` 最近 400 条 `applyBounds` 的 content 仍有 `[522,720]`×76、`[520,722]`×31、`[522,722]`×19、`[282,64]`×59、`[282,66]`×57、`[284,64]`×3、`[524,724]`×1。`_applyBounds` 用 `cw !== w || ch !== h` 判定，任何 1px 读数都会再 `setBounds` 一次；而 diag 是 `setBounds` 之后**同一 tick** 立刻读 `getContentSize()`，可能读到尚未生效/中间值 | `diag.log`（1,111,350 B，17:12 停写）统计；`hud-window.js:438-444`；对照：`hud-capture.png` = 780×1080 = 520×720 @1.5，说明**最终**内容尺寸是对的 | ① 真机跑一次探针：一次 `setBounds` 前后分别打印 `getBounds()`/`getContentBounds()`/`getContentSize()` + `setTimeout(0/50ms)` 复读，确认是"异步读数"还是"真漂移"；② 若为读数问题，diag 改到 `setTimeout(50ms)` 或 `resize` 事件里记录；③ 若为真漂移，统一用 `setContentSize` + `setPosition` 并保留 `thickFrame:false` | 部分（日志可证；定性需真机一次探针） |
| 6 | medium | 900ms 置前定时器未跟踪，退出/重复点击会多拉一次进程 | `app\src\hud-window.js:257-267` | 每次「打开 DSH 桌面窗口」都会：explorer 启动 DSH + `setTimeout(() => this._focusDshDesktop({quiet:true}), 900)`。定时器没有保存/清除：① 900ms 内退出仍会 spawn PowerShell；② 连续点两次菜单会启动两次 DSH 实例（第二次被单实例锁踢掉，但会闪一下）；③ 面板已销毁时回调仍执行（内部有 `fs.existsSync` 保护，但会 spawn） | `hud-window.js:263-266`；`_focusDshDesktop` 无 `disposed/isDestroyed` 早退（291-295） | 保存 `this._focusTimer`，在 `destroy()` 里 `clearTimeout`；回调首行加 `if (this.win?.isDestroyed()) return;`；对同一菜单项做 1.5s 去抖 | 是（静态） |
| 7 | medium | `hudLikelyRunning()` 用 apply 时的快照，HUD 后启动就永远判 false | `plugin\index.js:197-206, 472-485` | `preExistingDiscovery` 在 apply 时读一次，之后 discovery 被刷新也不更新。若 apply 时 HUD 没开、之后用户手动启动 HUD：`spawnApp:true` 下每次 `/dsh-hud` 都会 `spawnChild()` 拉一个会被单实例锁踢掉的进程（日志噪音 + 启动开销），成功文案也仍按 `child` 判断 | `197` `const preExistingDiscovery = readJsonFileSync(dFile);`；`199-206` 只读该常量 | `hudLikelyRunning()` 改为每次现读 `dFile`（读失败就 false），或在 refresh 回调里更新这个变量 | 是（静态） |
| 8 | medium | 面板收起后自动重连仍在后台跑 | `app\src\web-embed.js:322-346`；`app\src\hud-window.js:422-426` | 收起只 `detach()` 视图，`_recoveryTimer` 不停：错误页存在时即使胶囊态也在每 5–30s `loadURL` 一次（不可见、纯耗电/耗网） | `_hideWeb()` 只 `this.web.detach()`；`_stopRecovery` 只在 `destroy()`/成功加载时调用 | `detach()` 时 `_stopRecovery()`，`attach()` 时若 `lastKind==='error'` 再 `_startRecovery()` | 是（静态） |
| 9 | medium | `startDsh()` 的 2s 重载 timer 未跟踪 | `app\src\web-embed.js:355-375` | 点错误页「启动 DSH」后立刻收起/退出：2s 后仍会 `reload()`，此时视图可能已 detach/销毁 → `load()` 里 `create()` 会重建一个孤儿视图 | `startDsh` 里 `setTimeout(() => this.reload({forceToken:true}), 2000)` 未保存句柄；`destroy()` 只 `_stopRecovery` | 保存 `this._startTimer`，`destroy()`/`detach()` 里清除 | 是（静态） |
| 10 | medium | shell 渲染器无 CSP | `app\renderer\index.html`（无 meta CSP） | 每次启动打印 `Electron Security Warning (Insecure Content-Security-Policy)`；虽只加载本地文件，但一旦将来引入远程内容就没有第二道闸 | `artifacts\capture-out.log:3-18`（两条警告） | 加 `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'">` | 是（日志已证） |
| 11 | medium | 全屏展开时重复拉起 DSH 桌面进程 | `app\src\hud-window.js:257-285` | 见 #6：`_openDshDesktop` 无条件走 explorer 启动，即使 DSH 已在运行。单实例锁能兜住，但会有一个实例闪退、且可能抢焦点 | 同上 | 先用 `focus-dsh.ps1` 探测窗口（`focused`/`notfound`），`notfound` 才启动；或启动前检查 discovery.pid 存活 + 桌面进程名 | 是（静态） |
| 12 | low | 未使用的导入 | `app\src\web-embed.js`（`ageMs`） | 上一轮去掉 60s 门槛后残留 | `require('./discovery')` 里仍解构 `ageMs` | 删掉 | 是（静态） |
| 13 | low | 全局热键注册失败只 warn | `app\src\hotkeys.js:62-67` | 被其它程序占用时用户只会觉得"热键没反应"，没有任何 UI 提示 | `console.warn('[hud] 全局热键注册失败（可能被其他程序占用）: ...')` | 在面板标题栏/菜单里显示"热键未生效"提示，并提供"重新注册"菜单项 | 是（静态） |
| 14 | low | `app/scripts/make-*.js` 被打进 asar | `app\package.json:32` + `app\scripts\` | 开发脚本随包分发（~9 KB），增加攻击面/噪音 | `files: "scripts/**/*"` 同时包含 `make-icon.js`、`make-portable.js` | 用 `!scripts/make-*.js` 排除，只保留 `focus-dsh.ps1`、`launch-hud.cjs` | 是（静态） |
| 15 | low | `move` 的 400ms 去抖 timer 未在 destroy 清除 | `app\src\hud-window.js:569-580, 704-735` | 关窗后最多 400ms 内回调仍会跑（内部有 `isDestroyed` 守卫，无实际副作用） | `destroy()` 只清 `_collapseTimer` | 顺手清理 | 是（静态） |
| 16 | low | `dist` 产物占 158 MB zip + 249 MB exe | `dist\` | 工作区体积膨胀，且旧包易被误当新包（见 #1） | `dist\DSH-HUD-0.2.0-win-x64.zip` 158,058,209 B；`dist\win-unpacked\DSH HUD.exe` 249,469,440 B | 交付后移出工作区或加 `.gitignore`；构建前清 `dist` | 是（已证） |

---

## 3. 本轮确认已修复（对照 t13 的 24 条）

| t13 编号 | 原问题 | 现状证据 |
| --- | --- | --- |
| #1 | 控制序号每次 apply 归零 | `plugin\index.js:310-311` `controlSeq = Math.max(controlSeq + 1, Date.now())` |
| #2 | stdin 写 `{type,action}` 字段名错 | `plugin\index.js` 写 `{action, seq}`；`control.js:118-136` 先校验 action 再推进 seq |
| #3 | 无 `setWindowOpenHandler`/`will-navigate` | `web-embed.js:90-102` 外链一律 `deny` + `shell.openExternal`，同源才放行 |
| #4 | 拖拽无 `e.buttons` 守卫 | `renderer\hud.js:121-125` 松手即 `dragEnd` |
| #5/#6 | 标题栏双重拖拽 / 按钮冒泡 | `hud.js:101` 过滤 `button, [role=button], .panel-btn`；`hud.js:145` 只给胶囊绑手动拖拽 |
| #8 | token 重试受 60s 年龄限制 | `web-embed.js:191-208` 只看 `lastKind==='clean' && !_tokenRetried && _hasDiscovery()` |
| #9 | 展开后不 focus 内嵌视图 | `hud-window.js:166-193` 两条路径都 `this.web.focus()` |
| #10 | 收起动画中热键被吞 | `hud-window.js:361-371` `toggle()` 先 `_finishCollapse()` |
| #11 | 拖动不 clamp | `hud-window.js` `_onDragMove` 走 `_clampToWorkArea`（KEEP=48） |
| #12 | 跨 DPI 用 renderer 屏坐标 | `_onDragMove` 用 `screen.getCursorScreenPoint()`；renderer 只传 `clientX/clientY` 偏移 |
| #13 | view 内 Esc 一律劫持 | `web-embed.js:111-118` 仅 `DSH_HUD_WEB_ESC==='1'` 时劫持 |
| #17 | 开发态写 HKCU Run | `autostart.js` `if (enabled && !app.isPackaged) return false`（并写回 `enabled:false`） |
| #18 | control-state 非原子写 | `control.js` `_saveSeq` 改 tmp+rename |
| #19 | 监听器/视图不释放 | `hud-window.js:704-735` `destroy()` 摘 9 个 ipc（688-720）+ 3 个 screen，`web.destroy()` |
| #21 | 每次 apply 都 spawn | `plugin\index.js:472-485` 先 `child` 再 `hudLikelyRunning()`（快照问题见主表 #7） |
| #23 | `onLoaded` 赋值晚于 `showPanel` | `main.js:190-192` 先赋值 `hud.web.onLoaded` 再 `showPanel()` |
| #7 | 内容区 +2px | `thickFrame:false` 已加（`hud-window.js:100`）、严格比较已改（432-443），但日志仍见 522/282 → **部分修复**，见主表 #5 |

---

## 4. 假问题（验证后不成立，避免下一轮重复排查）

1. **「`fallbackLaunch` 与 `settled` 双重触发 / 8s 兜底与 close 竞态」** — 当前代码已没有 `fallbackLaunch`/`settled`：`_openDshDesktop()` 改为 explorer 启动 + 900ms 后置前（`hud-window.js:257-267`），置前失败只记日志不回落启动，不存在双触发路径。
2. **「右键菜单改完后 `quit()` 没有入口」** — 面板标题栏「×」与胶囊悬浮「×」都调 `hud.quit()`（`renderer\hud.js:147-149`），菜单里移除「关闭浮窗」是有意为之（避免误退）。
3. **「右键菜单自启 checkbox 状态不刷新」** — 每次 `context-menu` 都 `Menu.buildFromTemplate(this.buildContextMenu())`，`checked: autostart.isEnabled()` 现算，不存在缓存。
4. **「asar 内 `.ps1` 无法被 `powershell -File` 读取」** — 实现上先 `_materializeHelperScript()` 复制到 `userData\helpers\` 再执行（`hud-window.js:338-358`），从不直接执行 asar 路径；打包版缺文件是 `files`/旧构建问题（主表 #1），不是 asar 可读性问题。
5. **「`ctx.get` 每次 tick 会引用不稳定/旧实例残留」** — `resolveDiscovery()` 每次现取 `ctx.get('webApp')/('webServer')/('connection')`，是对"apply 时捕获 undefined"的修复（`plugin\index.js:209-242`），取不到时回退 apply 时的实例，异常在 551-553/560 都 `catch`。
6. **「unique tmp 无限堆积」** — 启动时与 dispose 各扫一次，只删 mtime > 60s 的 `*.tmp`（`plugin\index.js:267-289`），写失败有 `renameWithRetry` 兜底；每次写用 `discovery.json.<pid>.<n>.tmp` 唯一名。
7. **「`focus-dsh.ps1` 的 spawn 泄漏句柄」** — 脚本只做 `EnumWindows`/`SetForegroundWindow`，不启动子进程；`spawn` 的 powershell 在 close/error/8s 超时三条路径都会结束并被 `clearTimeout`（`hud-window.js:306-333`）。
8. **「`_hideWeb` 后视图会白屏」** — 收起是 `detach()` 保留 WebContents，重新展开 `attach()` 复用同一实例，不会重新加载（`hud-window.js:420-424`、`web-embed.js:261-282`）。

---

## 5. 建议修复顺序

**P0（发布前必须）**
1. 主表 #1：重建 `dist`，`afterPack` 断言 asar 含 `scripts/focus-dsh.ps1` 与 `scripts/launch-hud.cjs`；`electronDist` 与运行时版本对齐（44.7.0）；`dist` 加 `build-info.json`。

**P1（用户可感知）**
2. 主表 #2：重连循环改成"连续失败计数 + 指数退避 + 上限"，成功加载才清零。
3. 主表 #3：`animationend('expand-in')` 补一次 `reportWebBounds()`；测量改不随 transform 变化的方式。
4. 主表 #4：命令成功文案改用 `child || hudLikelyRunning()`。

**P2（稳定性/体验）**
5. 主表 #5：真机跑一次 `getBounds/getContentBounds/getContentSize` 对照探针，再决定是改 diag 时机还是改 API。
6. 主表 #6/#7：900ms 定时器纳入 `destroy()`；`hudLikelyRunning()` 现读。
7. 主表 #8/#9：detach 时停恢复；`startDsh` 的 timer 纳入生命周期。

**P3（卫生）**
8. CSP、热键失败提示、未使用导入、`files` 排除 `make-*.js`、`dist` 清理。

---

## 6. 证据与复现命令

```bat
:: 1) 打包内容（本会话新增探针）
node artifacts\asar-list.cjs dist\win-unpacked\resources\app.asar
:: 期望输出 entries=16；scripts/focus-dsh.ps1 = MISSING（即主表 #1）

:: 2) 版本对照
for /f %i in (spike\node_modules\electron\dist\version) do @echo spike=%i
for /f %i in (runtime\node_modules\electron\dist\version) do @echo runtime=%i
:: 期望：spike=45.2.2（且只有 electron.exe.bak），runtime=44.7.0（有 electron.exe）

:: 3) ±2px 现状
powershell -NoProfile -Command "Select-String -Path artifacts\diag.log -Pattern 'content=\[' | Select-Object -Last 400 | ForEach-Object { ($_.Line -split 'content=')[1] } | Group-Object | Sort-Object Count -Descending | Select-Object -First 12 Count,Name"
```

- 截图证据：`artifacts\hud-capture.png`（780×1080 = 520×720@1.5，shell 正常）、`artifacts\hud-capture.capsule.png`（96×96 = 64×64@1.5，鲸鱼图标正常）、`artifacts\hud-capture.web.png`（692×914，主表 #3 的直接证据）
- 日志证据：`artifacts\capture-out.log`（19:10 真实运行，含热键注册与两条 CSP 警告）、`artifacts\diag.log`（3965 条 applyBounds、119 条 drag-end）、`artifacts\plugin-diag.log`（166 KB，含 spawn / respawn / discovery 刷新）
- 审计基线文件时间戳：见文首；`hud-window.js` 22:21:59 仍在改，行号以该版本为准

---

## 7. 边界声明

- 本会话无法启动真实 Electron 窗口（受限令牌 → Chromium 命名管道 `拒绝访问 0x5`），因此"窗口行为"类结论优先引用用户侧 19:10 的真实截图与 `diag.log`，其次才是静态推导。
- 主表 #2/#3/#4/#5 的"能否复现"标注为"静态已证"，意思是有确定代码路径与既有日志/截图佐证；不等于已在真机上跑过该场景。真机复现只需各自一步（停 DSH 看错误页刷新间隔 / 展开后打印 `view.getBounds()` / 运行 `/dsh-hud` 看文案 / 跑一次 bounds 对照探针）。
- 审计期间工作树仍在变动（`hud-window.js` 22:21、`web-embed.js` 21:56、`plugin/index.js` 21:53）。若这些文件在修复时被改动，以文中的代码片段检索为准，不要依赖行号。
