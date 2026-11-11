# DSH HUD 隐藏 bug 审计（t13）

> 审计对象：`D:\DeepSeekData\workspace\dsh-hud\app\`（190+36+~1500 行）与 `plugin\index.js`（444 行）
> 审计方式：**只读**（未改动 `app/` 与 `plugin/` 任何一行），证据来自 ① 源码逐行阅读 ② `grep` 反证 ③ 可执行的 harness（不含 Electron） ④ `artifacts/diag.log`（15289 行真实运行日志） ⑤ `plugin-diag.log`（52 KB 插件日志） ⑥ 运行时文件/进程现场
> 渲染限制：本会话的进程是受限令牌 + Low IL，独立 `electron.exe` 的 Chromium 子进程建管道失败（`FATAL:mojo\public\cpp\platform\platform_channel.cc:112 Check failed: . : 拒绝访问。(0x5)`），**无法在本会话内起真实窗口**；凡涉及真实渲染/焦点的结论都标了「不可（需真机）」。

---

## 1. 结论摘要

共 24 条，按严重度排序：

| 严重度 | 条数 | 编号 |
| --- | --- | --- |
| blocker | 1 | #1 |
| high | 3 | #2 #3 #4 |
| medium | 10 | #5 – #14 |
| low | 10 | #15 – #24 |

**必须先修的三件事**：

1. **#1 控制序号归零**：DSH 重启后 `/dsh-hud` 的前 `n` 次命令被 HUD 静默丢弃（`n` = 上一会话发过的命令数）。已用 harness 复现（7/7 PASS）。
2. **#2 stdin 控制通道字段名写错**：插件写 `{type,seq}`，HUD 读 `obj.action` → 每次都是 `unknown control action: undefined`，而且**会把 seq 烧掉**，与 `control.json` 通道存在竞态（谁先到谁吃 seq）。
3. **#3 内嵌 Web UI 没有任何导航/新窗口策略**：聊天里的外链会在面板内跳走（preload 仍挂着），或弹出无人管理的窗口。

---

## 2. 主表

> 列说明：「行号」均为当前文件绝对行号；「可验证」= 本会话能否给出运行证据。

| # | 严重度 | 标题 | 文件:行号 | 现象与触发条件 | 证据 | 建议修法 | 可验证 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **blocker** | 控制序号每次插件激活都归零，重启后命令被吞 | `plugin/index.js:116`、`plugin/index.js:194-196`；`app/src/control.js:32`、`app/src/control.js:118-124` | 插件侧 `let controlSeq = 0;`，每次 apply/重载从 0 开始；HUD 侧把见过的最大 seq 持久化到 `control-state.json` 并且 `if (seq <= this._lastSeq) return;`。DSH 重启（或插件重载）后第一条命令 `seq=1`，若上一会话发过 ≥1 条命令（`lastSeq>=1`）就被判为旧命令丢弃；要连续按 `n` 次 `/dsh-hud` 才恢复。`notifyReloadIfChanged` 的 origin 变化 reload 同样被吞 | harness 实测：预置 `{"lastSeq":5}` 后投递 `{seq:1,action:'show'}` → 处理器 0 次调用（`artifacts/control-bridge-test.cjs`，7/7 PASS）；`control-state.json` 在真实 userData 里不存在（尚未发过命令），所以现场还没触发 | seq 改成单调时钟：`const seq = Math.max(controlSeq + 1, Date.now())`；或把插件侧计数器持久化到与 `discovery.json` 同目录。HUD 侧可选：把「拒绝」也打日志，便于排障 | **已证（harness）** |
| 2 | **high** | stdin 控制通道字段名不匹配 + 无效动作也消耗 seq | `plugin/index.js:212-218`（`{ type: action, seq }`）；`app/src/control.js:126-132`（读 `obj.action`）；`control.js:122-124`（先推 seq 再校验） | 走 stdin 的每条命令都会打出 `[hud] unknown control action: undefined`，并且 `_lastSeq` 已经被推进；若 stdin 行比 `fs.watch` 的 `control.json` 事件先到（完全可能，文件写入有两次 rename 延迟），则同 seq 的文件通道副本随后被当成重复丢弃 → 动作丢失 | harness 实测 3 条：`{type:'show',seq:6}` 不派发 / 打出 `unknown control action: undefined` / `lastSeq` 变 6，随后 `{seq:6,action:'show'}` 被丢弃 | ① 写 `{ action, seq }`；② 先校验动作再落 seq：`const fn = this.handlers[action]; if (!fn) { console.error(...); return; }` 之后才 `_lastSeq = seq` | **已证（harness）** |
| 3 | **high** | 内嵌 WebContentsView 无 `setWindowOpenHandler` / `will-navigate` | `app/src/web-embed.js:46-71`、`189-198`；全仓 grep 无命中 | 聊天里的链接直接在被嵌入的 view 里导航到外网：preload（`web-embed.js:50`）继续生效并把 `webBridge` 暴露给外部源（`web-preload.js:41-44`），还会给外网页面加 `data-windows-titlebar`；`target=_blank`/`window.open` 则弹出**没有 parent、没有控制**的 BrowserWindow。面板没有后退/刷新入口，用户只能 Esc 收起再展开 | `grep -n "setWindowOpenHandler\|will-navigate" app/**` 只有两处无关命中（`web-embed.js:212 removeChildView`、`277 destroy()`） | `view.webContents.setWindowOpenHandler(({url}) => { shell.openExternal(url); return { action: 'deny' }; })`；`will-navigate` 里只放行 discovery origin，其余 `preventDefault()` + `shell.openExternal` | **已证（静态+grep）** |
| 4 | **high** | 手动拖拽没有 `e.buttons` 守卫 → 拖拽卡死 | `app/renderer/hud.js:109-115` | `mousemove` 只判 `if (!dragging) return;`。`mouseup` 监听在 `window` 上（`hud.js:117-125`），一旦松手落在窗口外/HUD 失去事件，`dragging` 永远为 true：此后鼠标在窗口上任何移动都会继续 `dragMove` 搬窗口（不用按任何键），直到下一次在窗口内按下再松开 | `diag.log` 08:00:54.528 `drag-start mode=panel offset=301,40` **没有对应的 drag-end**；配对脚本 `artifacts/drag-pairs.cjs` 统计 starts=106 / orphan-ends=0 / unmatched-starts=1（日志在增长，计数随之变，结论不变） | `mousemove` 里加 `if (!(e.buttons & 1)) { dragging = false; hud.dragEnd({...}); return; }`；或整体换 pointer events + `setPointerCapture` | **已证（日志）** |
| 5 | medium | 标题栏双重拖拽：OS app-region 与 renderer 手动拖同时绑在同一节点 | `app/renderer/hud.css:115`、`116`；`app/renderer/index.html:21`、`24-25`；`app/renderer/hud.js:129` | `#panel-drag` 就是 `.panel-header`：CSS 给它 `-webkit-app-region: drag`，同时 `attachDrag(panelDrag)` 给它绑了 `mousedown`。`.panel-btn` 虽然是 `no-drag`，但它的 mousedown 会**冒泡**到 header 处理器 → 按「收起/关闭」按钮并移动 >4px 时，renderer 的 `dragMove` 会搬窗口（且 click 仍然触发）；此时两套拖动同时存在 | 08:10:32.674 `focus mode=panel` 后立刻 `drag-start mode=panel offset=492,31`，58 ms 后 `drag-end moved=false content=[522,722]`；08:12:12.817 同型 `offset=464,40`。两个 offset.x 正好是 520/522 宽窗口里按钮的位置（右侧按钮 x≈464-492），说明 mousedown 来自按钮而非空白标题区 | 删掉 `attachDrag(panelDrag)`（OS 拖动 + `move` 事件持久化已经覆盖），仅保留胶囊的手动拖动；若必须保留，则在 `mousedown` 里加 `if (e.target.closest('.panel-btn')) return;` | **已证（日志+代码）** |
| 6 | medium | 胶囊关闭按钮同样会启动拖拽 | `app/renderer/index.html:11-15`、`app/renderer/hud.js:128` | `#capsule-drag`（`.capsule-pill`）内含 `#capsule-close` 按钮，`attachDrag` 绑在 pill 上且不过滤 target → 按 × 的同时移动会先搬窗口再退出 | 同 #5 的机制；`hud.js:96` 的处理器没有 target 判断 | 同 #5 的 target 守卫 | **已证（静态）** |
| 7 | medium | 内容区永远比设计大 2px（±2 漂移的根因） | `app/src/hud-window.js:85`（`useContentSize: true` 只对初始尺寸生效）、`272`（`getContentSize()`）、`277-281`（容差 `> 2` 才 `setBounds`） | 窗口初始 520×720 内容正确；但之后所有移动都走 `setBounds`（**窗口**坐标），frameless+transparent 窗口带 2px 边框，内容变成 522×722；`_applyBounds` 又用 `getContentSize()` 和请求值比、且容差正好 2 → 永不纠正。`_clamp` 仍按 520×720 计算，右/下贴边时会多出 2px | 实测分布（`diag.log` 3899 次 applyBounds）：panel `[522,720]` 840 次、`[522,722]` 737、`[520,722]` 505、`[520,720]` 499、`[524,724]` 1；capsule `[282,64]` 739、`[282,66]` 290、`[280,64]` 151、`[280,66]` 133、`[280,68]` 2、`[284,66]` 1 | 首选 `thickFrame: false`（去掉 WS_THICKFRAME → 窗口尺寸==内容尺寸，`setBounds` 精确且不会再现 520↔522 抖动；`resizable:false` 本来也不需要 resize 边框）。备选：把 `_applyBounds` 的坐标系统一成窗口尺寸（比 `getBounds()`，不再比 `getContentSize()`） | **已证（日志统计）**，修复需真机验证 |
| 8 | medium | token 新鲜度用「发现文件年龄 <60s」判断，而非 token 有效性 | `app/src/web-embed.js:174-177`（被 `159-170` 的 401 处理调用） | 401 时只在 discovery 文件 60s 内才用 token 重试，否则直接错误页。若 discovery 恰好过期（DSH 忙/插件被停用/刚开机）而 token 仍可用，用户看到「不可达」错误页，必须手动 reload | 代码路径读：`_freshTokenAvailable()` 只看 `ageMs(d) < 60_000`；真实 discovery 每 15s 刷新（`updatedAt 08:22:25 → 08:24:10`）所以正常态掩盖了该分支 | 去掉年龄门槛：只要有 `url` 就强制重试一次，重试仍 401 再显示错误页；或先主动重读 discovery 再判断 | **已证（静态）** |
| 9 | medium | 从胶囊展开时不给内嵌 view 焦点 | `app/src/hud-window.js:161-184` | 「已展开」分支（`164-174`）会 `this.web.focus()`，但**正常展开路径**（`_applyBounds` → `win.show()` → `win.focus()` → `_showWeb()`）没有。热键/点击展开后键盘焦点停在 shell 窗口，直接打字进不了输入框，必须再点一下 | 代码对比即可复现；真实焦点行为需真机（本会话无法起窗口） | `_showWeb()` 之后调用 `this.web.focus()`；首次加载在 `did-finish-load` 后再补一次 focus | 不可（需真机） |
| 10 | medium | 收起过程中再按热键会被吞掉 | `app/src/hud-window.js:203-206`、`211-220` | `collapse()` 开头 `if (this.mode !== 'panel' \|\| this._animatingOut) return;`，`_animatingOut` 只在 `_finishCollapse` 里清。140–280ms 的收起窗口期内 `toggle()` 直接返回，用户双击热键只得到「收起」，不会重新展开 | 代码路径；日志里 08:12:12.875→08:12:13.030 的收起→胶囊切换耗时 155ms，与 140ms 动画 + 280ms 兜底一致 | 在 `toggle()` 里记住 `_reopenPending = true`，`_finishCollapse` 末尾若置位则立即 `showPanel()` | **已证（静态+时序）** |
| 11 | medium | 拖动过程完全不 clamp，胶囊可被拖出屏幕 | `app/src/hud-window.js:450-457`（`hud:drag-move` 直接 `setBounds`）；`_applyBounds`（`263-283`）也不 clamp | 只有 `showCapsule/showPanel` 会 `_clamp`。把胶囊拖到屏幕外（或拖到已拔掉的副屏坐标）后，窗口不可见也抓不到，只能靠热键/重启/`display-metrics-changed` 复位 | 代码路径；日志里拖动终点坐标 x=1369/1394（1707 宽屏上正常），无越界样本 | `drag-move` 里先 `_clamp({x,y,...}, this._workAreaForPoint(x,y))` 再 `setBounds`；至少 `drag-end` 时 clamp 一次 | **已证（静态）** |
| 12 | medium | 跨不同缩放的显示器拖动会跳 | `app/renderer/hud.js:100-114` | 用 `e.screenX - window.screenX` 算绝对坐标，`screenX` 是**当前窗口所在显示器缩放**下的 CSS px，而 `setBounds` 吃的是虚拟桌面 DIP；跨 150%↔100% 显示器时位移被放大/缩小。全仓没有 `screen.getCursorScreenPoint()`（grep 无命中） | 代码路径；本机缩放 1.5（README-ENV 记录 1707×1067@1.5），副屏是否同缩放未知 | renderer 只发 delta（`e.screenX - startX`），主进程用 `win.getPosition()` + delta；或用 `screen.getCursorScreenPoint()` 统一在主进程算 | 不可（需双屏真机） |
| 13 | medium | 内嵌 UI 里的 Esc 被无条件劫持 | `app/src/web-embed.js:82-87`；`app/src/hud-window.js:407-411` | view 的 `before-input-event` 对任何 Esc 都 `preventDefault()` + `collapse()`。DSH UI 自身用 Esc 关弹窗/取消编辑时，面板会整个收起 | 代码路径；`hud-window.js:116` 把 `web.onEscape` 直接接到 `collapse()` | 只在页面没有活动模态时才收起：`executeJavaScript('!!document.querySelector("[aria-modal=true],dialog[open]")')` 为 false 才 collapse；或干脆去掉 view 级监听，只保留 shell 级 | 不可（需真机） |
| 14 | medium | 全局热键注册失败静默 | `app/src/hotkeys.js:43-67` | `register()` 失败只 `console.warn`。若 `Control+Alt+Space` 被别的软件占用，HUD 就没有热键，用户无任何提示（只剩胶囊可点） | 代码路径（`62-67` 只有 warn，无回退、无 UI 反馈） | 失败时尝试备用 accelerator 并在右键菜单/胶囊气泡显示「热键不可用」；把失败写进 diag | **已证（静态）** |
| 15 | medium | HUD 关掉后 `/dsh-hud` 无法拉起，但命令仍回「已打开」 | `plugin/index.js:102`（`spawnApp` 默认 false）、`351-356`（spawn 被跳过也返回 true）、`365-389` | 用户关闭 HUD 后，命令只往 `control.json` 写一条动作，没有进程读它；`ensureRunning()` 在 spawnApp=false 时直接 return true → 命令回「DSH 浮窗已打开」，实际什么也没发生 | 代码路径；`%LOCALAPPDATA%\dsh-hud` 里没有 `control.json`（从未成功发过命令） | 命令前探测存活（例如 HUD 启动时写一个 heartbeat 文件、或 discovery 里的 pid 是否存活），失败时回「HUD 未运行，请从开始菜单/登录项启动」；或允许 spawnApp=true 时自动拉起 | **已证（静态）** |
| 16 | medium | 状态写入失败被完全吞掉，无法诊断 | `app/src/window-state.js:55-65`（`try/catch {}`）；`app/scripts/launch-hud.cjs:44-71`（userData 候选目录回退） | 位置/热键/自启状态写失败时没有任何日志。若 launcher 选到临时目录（`%TEMP%\dsh-hud-userdata`），每次启动位置都重置，用户只会觉得「HUD 记不住位置」 | `%LOCALAPPDATA%\dsh-hud\userdata` 存在但为空（15:16 创建）；当前运行实例实际写的是 `artifacts\udd-hud\window-state.json`（16:25:44）——说明目录由环境变量决定，一旦回退到 temp 就静默丢状态 | 写状态失败时 `diag()` 记录；右键菜单显示「数据目录」；launcher 把选中的 userData 写进 diag（现在只在 launcher 自己的日志里，且该日志在沙箱里可能不可写） | **已证（现场文件）** |
| 17 | low | 开发态把 `electron.exe` 写进 HKCU Run | `app/src/autostart.js:53-65`、`69-73` | 未打包时 `process.execPath` 是 `runtime\node_modules\electron\dist\electron.exe`，勾选「开机自启」会写入这条命令；`apply()` 每次启动都会重写 | 代码路径（`path: process.execPath`） | `if (!app.isPackaged) return false;` 或改写成启动 `launch-hud.cjs` 的快捷方式 | **已证（静态）** |
| 18 | low | `control-state.json` 非原子写 | `app/src/control.js:146-153`、`135-144` | 写一半崩溃/被杀 → JSON 损坏 → `_loadSeq()` 返回 -1 → 下次启动可能重放最后一条命令（例如自己弹出面板） | 代码路径；`window-state.js` 用了 tmp+rename，这里是裸 `writeFileSync` | 同 `window-state.js`：tmp + rename | **已证（静态）** |
| 19 | low | `web.destroy()` 从不调用；ipcMain/screen 监听从不移除 | `app/src/web-embed.js:277-280`；`app/src/hud-window.js:439-501`、`358-365` | 单窗口场景无实际泄漏；但 `ipcMain.on` 是全局的，将来若支持「关闭后再开」或第二个窗口，处理器会重复注册（一次点击搬两次窗口） | 代码路径 + `grep destroy(` 只有定义 | `closed` 里 `web.destroy()` 并 removeAllListeners（或把 handler 提到模块级只注册一次） | **已证（静态）** |
| 20 | low | `data-windows-titlebar` 默认注入（与自身注释相反），error.html 也被注入 | `app/renderer/web-preload.js:23-39`；`app/src/web-embed.js:240-245` | 注释写「Opt-in (…=1)」，实际 `!== '0'` 默认开；错误页也走同一个 preload，于是错误页 `html` 上也有 `data-windows-titlebar`，DSH UI 的桌面分支（标题栏/抽屉判据）在本该是纯展示页的地方也生效 | 代码路径（`23` 行 vs 注释） | 改成 `=== '1'`；preload 里判断 `location.pathname` 不是 `error.html` 再标记 | **已证（静态）** |
| 21 | low | HUD 已在运行时，每次插件 apply 都会 spawn 一个立刻退出的进程 | `plugin/index.js:402-407`、`351-356`、`326-338` | 每次 apply 都 `ensureRunning()` → `spawnChild()`；新进程拿不到单实例锁 → `app.quit()` → 退出码 0 → 插件记「HUD exited cleanly; not respawning」。于是一次配置刷新就多一对 node+electron 进程 | `plugin-diag.log` 08:24:20.359–08:24:20.705 出现 5 条 `spawned HUD`，间隔 ~350ms，随后 `HUD exited cleanly; not respawning` | main.js 里让单实例失败用非 0 退出码（如 `app.exit(17)`），插件侧据此判「已在运行」不再重启；或 spawn 前先看 `discovery.json.pid` 是否存活 | **已证（日志）** |
| 22 | low | 诊断日志路径两处硬编码绝对路径，且无限增长 | `plugin/index.js:41`；`app/scripts/launch-hud.cjs:20` | `D:\DeepSeekData\workspace\dsh-hud\artifacts\plugin-diag.log` 写死在插件和 launcher 里；换机器/换目录就静默失败（catch 吞掉），当前已 52 KB 无轮转 | 文件实测 52667 B；两处常量 | 用 `process.env.DSH_HUD_DIAG` 或 `app.getPath('userData')` 派生；按大小轮转（保留最后 1 MB） | **已证（文件）** |
| 23 | low | `onLoaded` 在 `showPanel()` 之后才赋值，首屏可能错过 | `app/main.js:182-187`、`150-190` | `showPanel()` 先执行（可能触发 load），随后才 `hud.web.onLoaded = ...`；若 `did-finish-load` 已经发生，就只能等 8s 兜底才截图 | 代码顺序 | 先赋 `onLoaded` 再 `showPanel()` | **已证（静态）** |
| 24 | low | 拖动时 resize/尺寸 IPC 抖动（性能噪音） | `app/renderer/hud.js:109-115`；`app/src/hud-window.js:450-457` | `mousemove` 每帧一次 `dragMove` → 主进程 `setBounds` → 触发 `resize` → renderer 的 ResizeObserver 又回报 web bounds → 再 `setBounds`。日志里 resize 11159 次 vs applyBounds 3899 次 | `diag.log`：08:15:52.712 `drag-start` 后 50ms 内 9 条 `resize content=280x64`；08:23:07.334 起同样成串（**这是拖动所致，不是自增循环**，见第 4 节） | `hud:web-bounds` 用 rAF 合并；拖动期间跳过 resize 日志；`_webBounds` 未变化则不调 `view.setBounds` | **已证（日志）** |

---

## 3. 队长两条线索的专项回答

### 3.1 双重拖拽（`drag-start` 仍然出现）

**确认是重复逻辑，归 medium，编号 #5/#6。**

- 绑定面：`app/renderer/index.html:21` 的 `#panel-drag` 就是 `.panel-header`；`hud.css:115` 给同一个元素加了 `-webkit-app-region: drag`；`hud.js:129` 又给它 `attachDrag`。
- 为什么会「按钮也触发」：`hud.css:116` 只把 `.panel-btn` 设成 `no-drag`，但 `no-drag` 只影响**系统命中测试**，不阻止 DOM 事件冒泡；`hud.js:96` 的 `mousedown` 没有 target 过滤，所以按「收起/关闭」时也会 `dragStart`。
- 日志指纹：两次 `drag-start` 的 offset 分别是 `492,31` 与 `464,40`，正好落在右侧按钮区域（520/522 宽窗口），且 58ms 后 `drag-end moved=false` —— 是「点按钮时轻微抖了一下」，不是拖标题栏。
- 两套拖动会不会打架：**标题空白区**由 OS 接管（app-region），renderer 的 `dragMove` 也会同时被喂坐标并 `setBounds`——OS 的 move loop 与 `setBounds` 争同一矩形，表现为偶发 1 帧抖动；**按钮区**只有 renderer 一套，会把「点按钮」变成「搬窗口」。
- 建议：直接删除 `attachDrag(panelDrag)`（`move` 事件已经把位置持久化，见 `hud-window.js:394-404`），保留胶囊的 `attachDrag`（胶囊没有 app-region）；或在 `mousedown` 里 `if (e.target.closest('.panel-btn')) return;`。

### 3.2 ±2px 尺寸漂移

**根因：#7。** `create()` 用 `useContentSize: true` 只对**初始尺寸**生效（`hud-window.js:85` 的注释「width/height refer to the web page (exact 520 content area)」只在创建时成立）；之后所有移动走 `setBounds`（窗口坐标），这个 frameless+transparent 窗口带 2px 边框，内容就变成 522×722。`_applyBounds`（`272`）用 `getContentSize()` 与请求值比较、且容差正好是 `> 2`（`277`），于是永远判定「已经对了」，再也不会修正。

影响面（逐条）：

| 面 | 影响 | 判断 |
| --- | --- | --- |
| 圆角裁切 | 内容比设计大 2px，圆角本身按 CSS 14px 画，不会被裁 | 无可见问题 |
| shell 24px 内缩 vs 内嵌 view | view 的 bounds 来自 `getBoundingClientRect()`（相对 522×722 的视口），与 shell 的 padding 是同一坐标系，所以**不会错位**；但整个面板比设计宽 2px | 低 |
| 贴边 clamp | `_clamp` 用 520×720 算，右下贴边时窗口实际多出 2px（可能压住 2px 工作区边缘/其他窗口） | 低 |
| 高 DPI | 150% 下 2px 边框取整会出现 280×66 / 282×64 / 284×66 等组合（日志里都有），不是稳定常数 | 中（视觉上表现为 1px 抖动） |
| `100vw` 语义 | compact CSS 的 `100vw` = 522，`--dsh-chat-user-width: min(100vw - 80px, 680px)` 得 442 而非 440 | 可忽略 |

建议（按优先级）：

1. **`thickFrame: false`**（`hud-window.js:82-108` 的 BrowserWindow 选项）：去掉 WS_THICKFRAME → 窗口矩形==内容矩形，`setBounds` 直接精确，也不会再出现当年 `setContentSize` 每帧调用导致的 520↔522 抖动（那段实验记录在 `267-276` 的注释里）。`resizable:false` 本来就不需要 resize 边框。需真机确认：圆角/阴影（`hasShadow:false` 已关）、以及 `setAlwaysOnTop('screen-saver')` 不受影响。
2. 若不想动窗口样式：把 `_applyBounds` 统一到**窗口坐标**——比较 `this.win.getBounds()` 而不是 `getContentSize()`，容差 0；`_clamp` 也改用窗口尺寸。
3. 不要在 `constants.js` 里做 `-2` 补偿：边框宽度不是契约（不同 DPI/系统主题下会变），补偿会在某台机器上变成 −1 或 −3。

### 3.3 08:11:39–08:11:59 的 `move saved` 基线

**成立，可以作为「原子 setBounds + app-region 修复有效」的反证基线。** 该段有 10 条 `move saved mode=panel`（pos 795,200 → 170,87），其间 `resize` 行数为 0，也没有 `applyBounds`。原因：这 10 次是 OS 拖动循环在搬窗口，没有经过 renderer 的 `setBounds`，所以不产生 `resize`（Windows 在纯移动时不发 WM_SIZE）。对比 08:15:52 的胶囊拖动（renderer 手动拖，每帧 `setBounds`）才有成串 `resize`。结论：**移动本身不再引发尺寸抖动**；剩余的尺寸抖动只来自 #7 的 2px 边框与 #24 的每帧 `setBounds`。

---

## 4. 已验证为假问题（避免下一轮重复排查）

| # | 怀疑 | 结论与证据 |
| --- | --- | --- |
| F1 | 图片/日志里的 `resize` 爆发是「自增循环」（282×66 → 282×68 → …） | **否**。`diag.log` 里最大尺寸只有 `526×726`（12 次）与 `524×724`（11 次），没有单调增长；08:23:07 的成串 `resize content=280x64` 前一行就是 `08:23:07.334 drag-start mode=capsule offset=118,40`，是拖动中每帧 `setBounds` 的产物，不是失控循环 |
| F2 | 单实例失效 / 插件与用户启动造成双窗口 | **未发现双窗口**。插件日志里 08:24:20 连续 5 次 `spawned HUD`，随后每条都跟 `HUD exited cleanly; not respawning`（新进程拿不到锁、`app.quit()` 退出码 0）；现存 5 个 `electron.exe`（16:10:39–44，同一 `runtime\...\electron.exe`）更像一个 Chromium 实例的 browser/gpu/utility/2×renderer。真正的问题是「每次都 spawn 一次再被锁踢掉」（#21），不是多实例 |
| F3 | `will-resize` 需要防（窗口被用户拉大） | **不需要**。`diag.log` 15289 行里 `will-resize` 0 次，`resizable:false` 生效；`hud-window.js` 里的 `preventDefault` 是死代码但无害 |
| F4 | 全局热键与 Esc 冲突 | **否**。全局热键是 `Control+Alt+Space`（`constants.js:48`），Esc 只在窗口有焦点时生效，两者不重叠；`before-input-event` 只拦 F12/Ctrl+Shift+I/J（`main.js:34-46`） |
| F5 | token URL 泄漏/每次刷新要重新认证 | **否**。t3 已实测：`GET /?token=…` → 303 + `Set-Cookie: dsh-auth-*`；之后 `_resolveTarget`（`web-embed.js:189-198`）在 `bootstrapped` 后切到 `cleanUrl`（`discovery.js:54-64` 删掉 token），cookie 由 `persist:dsh-web` 分区保存 |
| F6 | 控制文件原子写会留下 `.tmp` 垃圾 | **当前没有**。`%LOCALAPPDATA%\dsh-hud` 只有 `discovery.json`，无 `*.tmp`；插件的 `cleanupTmpFiles`（`plugin/index.js:178-190`）+ dispose 清理（`439-441`）有效 |
| F7 | `window-all-closed → app.quit()` 会让「隐藏到胶囊」被误杀 | **否**。胶囊态是 `win.hide()`（`hud-window.js:148-150`），窗口对象仍在，不会触发 `window-all-closed`；只有用户点 × / 菜单退出才真正 quit |
| F8 | `CLICK_THRESHOLD` 两处常量不一致导致点击判定错乱 | **否**。`constants.js:29` 与 `hud.js` 里都是 4，语义一致（超 4px 才算拖动） |
| F9 | 收起动画的兜底 timer 会阻塞退出 | **否**。`setTimeout` 不会阻止 `app.quit()`；`will-quit`（`main.js:111-114`）只做 unregister/stop |
| F10 | `blur` 会自动收起、导致点面板外就消失 | **默认不会**。`hud-window.js` 里 `blur` 仅在 `DSH_HUD_BLUR_COLLAPSE === '1'` 时才 collapse；日志 24 条 `blur ... collapseEnabled=false` 全部没有收起 |

---

## 5. 建议修复顺序

1. **P0（阻断功能）**：#1、#2 —— 控制通道两端协议对齐（seq 用时钟、字段名统一、先校验再落 seq）。改完用 `artifacts/control-bridge-test.cjs` 回归（期望 7/7）。
2. **P0（安全/体验）**：#3（外链策略）、#4（拖拽卡死）。
3. **P1（几何/交互）**：#5、#6、#7、#11、#12。
4. **P1（可用性）**：#9、#10、#13、#15。
5. **P2**：其余 low + #8、#16 的诊断补强。

---

## 6. 证据与复现

| 产物 | 说明 |
| --- | --- |
| `artifacts/control-bridge-test.cjs` | 纯 Node 复现 #1/#2：`node artifacts/control-bridge-test.cjs` → `SUMMARY 7/7 passed`（不依赖 Electron） |
| `artifacts/drag-pairs.cjs` | 统计 `diag.log` 里未配对的 drag-start：#4 证据（starts=106 / unmatched=1 / 08:00:54.528） |
| `artifacts/diag.log` | 15289 行真实运行日志（applyBounds 分布、resize 计数、drag 时序） |
| `artifacts/plugin-diag.log` | 52 KB 插件/launcher 日志（apply 次数、spawn 风暴、exit 码） |
| `artifacts/clicks.log` | 内嵌 UI 点击测试坐标（`sidebar=10,6,48,48` 折叠轨道 / `0,0,301,602` 展开抽屉，均 `mask=none`） |
| `docs/embed-feasibility.md` | t3 的 520×720 内嵌可行性结论（compact CSS 清单），本审计 #7/#9 的几何前提来自那里 |

复现命令（本会话可跑）：

```powershell
$node='C:\Users\35263\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node D:\DeepSeekData\workspace\dsh-hud\artifacts\control-bridge-test.cjs
& $node D:\DeepSeekData\workspace\dsh-hud\artifacts\drag-pairs.cjs
Select-String -Path D:\DeepSeekData\workspace\dsh-hud\artifacts\diag.log -Pattern 'drag-start' | Measure-Object   # 106（随日志增长）
```

---

## 7. 审计边界声明

- 未修改 `app/**`、`plugin/**`（只读）；新增文件仅在 `artifacts/`（两个 harness）与本文档。
- 依赖真实渲染/真实焦点的条目（#9、#12、#13，以及 #7/#10 的最终确认）标注为「需真机」；本会话的受限令牌使独立 Electron 的 Chromium 子进程无法建立 IPC 通道，窗口截图与焦点实验不可行（详见 `README-ENV.md` 与 t1 结论）。
- 日志里的「08:xxZ」为 UTC，对应本地 16:xx（UTC+8）。

---

## 8. 修复记录（t15 · P2 plugin 收尾）

### #21 每次 apply 重复 spawn（spawn 风暴）

- **根因**：`ensureRunning()` 只判 `child` 非空；插件每次 apply（配置刷新会连触发 5 次）时 `child` 都是新作用域里的 `null`，于是每次 `ensureRunning()` → `spawnChild()` 都拉起一个拿不到单实例锁、退出码 0 的 HUD（plugin-diag 08:24:20 连续 5 条 `spawned HUD`）。
- **改法**（`plugin/index.js`）：apply 开头对**写入前已存在**的 `discovery.json` 做快照；`ensureRunning()` 在「无活 child」时先走 `hudLikelyRunning()` —— 若快照存在、`updatedAt` 距今 <30s、`pid` 是正整数且 `process.kill(pid,0)` 存活（EPERM 也视为存活），则判定 HUD 已在运行并 `skip spawn`，日志写明 pid/updatedAt/ageMs 判断依据。respawn、命令、启动统一走 `ensureRunning()` 这一个入口（`scheduleRespawn` 定时器不再直接 `spawnChild()`）。
- **注意**：`discovery.json.pid` 是**宿主（DSH）进程 pid**（插件写 `process.pid`），HUD 侧不写自己的 pid（`app/src/discovery.js` 只读、无 heartbeat）。因此该探测是「最近 30s 有新鲜 discovery 且宿主存活」的启发式代理，用于抑制「同一宿主进程内反复 apply」的重复拉起；它**不能**区分「HUD 被用户主动关闭」。要彻底消除歧义，需 app 侧落地一个 pid/heartbeat 文件（不在本任务范围）。

### #22 诊断日志硬编码 + 无轮转

- **根因**：`plugin/index.js:41` 把 `D:\DeepSeekData\workspace\dsh-hud\artifacts\plugin-diag.log` 写死，换机器/目录即静默失败（catch 吞掉），且无限增长（实测已 52 KB+）。launcher 侧 `app/scripts/launch-hud.cjs:20` 同样硬编码（本任务不动 app/，已标注）。
- **改法**（`plugin/index.js`）：`DIAG_FILE` 改为 `process.env.DSH_HUD_DIAG_FILE || DEFAULT_DIAG_FILE`（默认仍为 workspace `artifacts/plugin-diag.log`）；`log()` 每次写入前 `statSync` 检查大小，超过 512 KB 先 `renameSync(diagFile, diagFile + '.1')` 轮转（只保留一份 `.1`）。
- **未改**：`app/scripts/launch-hud.cjs` 的 `LOG` 常量仍硬编码（out of scope「不要动 app/ 源码」）；launcher 改由 `DSH_HUD_DIAG_FILE` 接管需另开 app 侧任务。

### 测试

- `node --check plugin/index.js` 与 `node --check app/scripts/launch-hud.cjs` 均通过。
- `node --test --test-isolation=none tests/e2e/unit/plugin.test.mjs`：8 条原有 + 1 条新增「re-apply: fresh pre-existing discovery skips duplicate spawn」= **9/9 通过**。

---

## 9. 修复记录（t14 · P2 app 收尾）

本轮按 P2 清单修 app/ 侧 6 条，只改 `dsh-hud/app`、`dsh-hud/tests` 与本文档。未引入新依赖；未动 `plugin/` 与 `app/scripts` 启动脚本。改动 JS 全部通过 bundled `node --check`；三个 e2e unit 用例全绿（core 4 / hud-window 14 / main-boot 2 = **20/20**）。

### 改动文件清单

| 文件 | 关联缺陷 |
| --- | --- |
| `app/src/window-state.js` | #16 |
| `app/src/control.js` | #18 |
| `app/src/hud-window.js` | #19、#24、#12 |
| `app/main.js` | #19、#23 |
| `app/renderer/hud.js` | #12 |
| `tests/e2e/unit/helpers/mock-electron.cjs` | #12（测试桩） |
| `tests/e2e/unit/hud-window.test.cjs` | #12（断言同步） |

### #16 状态写失败全吞（medium）

- **改前**：`window-state.js` 的 `write()` 里 `catch (e) { /* Best-effort persistence: never crash the HUD over a state-file write. */ }` 空吞；launcher 回退 temp 目录导致位置重置时无任何日志，用户只会看到窗口「跳回默认位」而不知原因。
- **改后**：catch 内 `console.error('[hud] window-state save failed:', e && e.message);`。内存 `state` 对象保持不变，下次防抖触发（`SAVE_DEBOUNCE_MS`）仍会用「上一次的数值」重试，不再静默。

### #18 control-state.json 非原子写（low）

- **改前**：`control.js` `_saveSeq()` 裸 `fs.writeFileSync(this.statePath, JSON.stringify({ lastSeq: seq }))`，断电/异常中断可能留下半截 JSON，下次 `_loadSeq` 读到损坏内容（虽会回退 0，但会丢失去重水位）。
- **改后**：`fs.mkdirSync(dir, {recursive:true})` + 写 `${statePath}.tmp` 后 `fs.renameSync(tmp, statePath)` 原子落盘；失败走 `console.error`。

### #19 资源回收（low）

- **改前**：`hud-window.js` `_wireEvents()` 里 9 个 `ipcMain.on`（hud:drag-start/move/end、hud:collapse、hud:collapse-done、hud:quit、hud:web-bounds、hud:web-retry、hud:web-start-dsh）与 3 个 `screen.on`（display-added/removed/metrics-changed）全是匿名 handler，从不移除；`WebEmbed.destroy()`（已存在但无人调用）也不会被调到。单实例锁下主进程长期存活、窗口反复销毁/重建时会累积重复监听，触发一次 IPC 被多个旧 handler 同时处理。
- **改后**：全部 handler 提为具名 `this._onXxx` / `this._reclamp`；新增 `HudWindow.destroy()`——调 `web.destroy()`、遍历 `_ipcPairs` 用 `ipcMain.removeListener(channel, fn)` 移除、`screen.removeListener` ×3、清 `_collapseTimer`。`main.js` 的 `will-quit` 里调用 `if (hud) hud.destroy();`。

### #23 onLoaded 时序（low）

- **改前**：`main.js` `runCaptureFlow()` 先 `hud.showPanel()`，之后才 `hud.web.onLoaded = () => setTimeout(capturePanel, 1500)`。若面板首次加载在赋值前就完成（`did-finish-load` 早于赋值），回调永久错过，只能等 8s 兜底定时器。
- **改后**：把 `hud.web.onLoaded` 的赋值移到 `hud.showPanel()` 之前，保证首次加载回调必被捕获。

### #24 拖动期间 resize/IPC 抖动（low）

- **改前**：拖动中 renderer 每帧 `dragMove`→`setBounds`→`resize`→`ResizeObserver` 又上报 `hud:web-bounds`→主进程再 `setBounds`，形成「setBounds → 反馈 setBounds」的震荡回路，拖动帧率与 WebContentsView 位置抖动。
- **改后**：`hud:web-bounds` handler 改为 `this._webBounds = b; if (!this.dragSession && this.web) this.web.setBounds(b);`——拖动中只记录边界不 `setBounds`；`hud:drag-end` 末尾补一次 `_syncWebBounds()` 用最终尺寸校正 view。

### #12 跨缩放显示器拖动（medium）

- **改前**：`renderer/hud.js` 用 `offsetX = startX - window.screenX`，mousemove 发 `{x: e.screenX - offsetX, y: e.screenY - offsetY}` 的**绝对坐标**。`screenX` 是当前窗口所在显示器缩放下的 CSS px，而主进程 `setBounds` 吃虚拟桌面 DIP；跨 150%↔100% 显示器拖动时，位移被缩放系数放大/缩小，窗口「漂移」。
- **改后**：renderer 只在 mousedown 记录 `offsetX/offsetY = e.clientX/e.clientY`（CSS px == DIP，与缩放无关），mousemove 发空 payload `hud.dragMove({})`、dragEnd 只发 `{ moved }`；主进程 `_onDragMove/_onDragEnd` 用 `screen.getCursorScreenPoint()` 取光标的虚拟桌面 DIP，再 `_clampToWorkArea(cursor.x - offsetX, cursor.y - offsetY, size)` 计算目标位置，跨显示器缩放不再跳变。配套：`mock-electron.cjs` 新增 `screen.getCursorScreenPoint/setCursorScreenPoint` 桩；`hud-window.test.cjs` 两处拖拽断言同步改为 set 光标点。

### 测试输出摘要

```
core.test.cjs        4/4  PASS  （discovery 1 + window-state 1 + hotkeys 2）
hud-window.test.cjs 14/14 PASS  （create/expand/drag/吸附/持久化/Esc/blur/热键/多屏/错误页/401/web-bounds）
main-boot.test.cjs   2/2  PASS  （单窗口启动 + 二次实例拿锁即退）
```

- 运行方式：`node --test --test-isolation=none <file>`（本沙箱默认 `node --test` 的 test runner 会 spawn 子进程 + piped stdio，撞受限令牌命名管道边界报 `spawn EPERM`；`--test-isolation=none` 同进程运行规避）。
- `node --check` 通过：`window-state.js` / `control.js` / `main.js` / `hud-window.js` / `renderer/hud.js` / `mock-electron.cjs` / `hud-window.test.cjs`。

### 遗留（需真机，本轮不覆盖）

- #12 的实际跨屏拖动手感（150%↔100% 双显示器）依赖真实渲染 + 真实光标，本会话受限令牌无法做窗口交互；当前修复为「主进程按 `getCursorScreenPoint` 取虚拟桌面 DIP」的规范化实现，逻辑上消除缩放跳变，需用户侧真机复核。
- #9/#13 等「需真机」条目不在 P2 范围。

## 9. t16 复核阻塞项（P2-B1）修复记录

### P2-B1：启动清理与首次 discovery 写入竞态

- **现象**（qa t16）：`plugin/index.js` 启动时 `void cleanupTmpFiles()` 与 `void writeDiscovery()` 并发、互不 await；`cleanupTmpFiles()` 会删除目录下**所有** `*.tmp`，包括 `writeDiscovery()` 正在写的 `discovery.json.tmp`，随后 `rename(dTmp, dFile)` 抛 `ENOENT`。实测日志 `discovery write failed: ENOENT ... discovery.json.tmp -> discovery.json`（`tests/e2e/logs/t16-probe-diag.txt`）；该失败还会让 `.then()` 里的 `ensureRunning()` 不执行，`spawnApp: true` 时首次 apply 拉不起 HUD。
- **改法**（`plugin/index.js`）：
  1. 新增 `STALE_TMP_MS = 60_000`；`cleanupTmpFiles()` 改为**只删 mtime 超过 60s 的 tmp**（写入前先 `stat`），新鲜 tmp 可能属于仍在进行的写入，一律保留。
  2. 启动流程改为单一串行 async IIFE：先 `await cleanupTmpFiles()`，再 `writeDiscovery()`，成功后才 `notifyReloadIfChanged()` / `ensureRunning()`。
- **回归**（`tests/e2e/unit/plugin.test.mjs` 新增用例「startup sweep: deletes stale *.tmp only, never a fresh one, and still writes discovery」）：预置一个新鲜 tmp + 一个 mtime 120s 前的 tmp → apply 后断言 discovery 正常写入、无 `discovery write failed`、新鲜 tmp 仍在、陈旧 tmp 被删。plugin 测试 10/10 PASS（`node --check plugin/index.js` exit 0）。
