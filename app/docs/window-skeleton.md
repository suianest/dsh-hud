# DSH HUD 悬浮窗骨架 + 联动（window-skeleton）

> 任务 t4（骨架）+ t5（联动）交付物。实现无边框 520×720 圆角面板 + 胶囊态小窗，含置顶、拖拽、位置记忆、单实例、多屏 DPI、skipTaskbar、Esc/失焦收起，以及 t5 新增的**全局热键、焦点策略、边缘吸附、展开/收起动画**。

## 1. 目录结构

```
app/
  main.js                入口：单实例锁、userData 覆盖、启动 HudWindow、热键清理
  preload.js             contextBridge 暴露 window.hud（drag/collapse/quit/onState/onCollapseAnim/collapseDone）
  src/
    constants.js         尺寸/阈值/状态文件/热键/动画常量（全为 DIP）
    window-state.js      位置记忆：userData/window-state.json 读写（防抖 + 原子写）
    hotkeys.js           全局热键控制器：注册/更新/持久化（userData/hotkey.json）
    hud-window.js        核心：单窗口两态状态机 + 拖拽/收起/热键/焦点/吸附/多屏钳位
  renderer/
    index.html           胶囊（鲸鱼圆标）+ 面板两套布局（web-host 为 DSH Web UI 注入点）
    hud.css              透明窗口圆角/阴影、鲸鱼圆标与面板样式、展开收起动画、opaque 兜底
    hud.js               手动拖拽（发 delta）+ 点击展开 + 状态同步 + 动画握手 + 胶囊边界上报
    whale.svg            DSH 鲸鱼图标（胶囊态，复制自 build/favicon.svg）
  docs/
    window-skeleton.md   本文档
  scripts/
    run-hud.cmd          沙箱外启动命令（复用 spike 的 electron.exe）
    check-hud.cmd        语法自检（node --check，无需启动 electron）
    verify-hud.cmd       用户侧交互验证脚本（打印热键 + 手测清单 + 启动 HUD）
```

## 2. 状态机

单一 `BrowserWindow`（frameless / transparent / alwaysOnTop / skipTaskbar / resizable:false），在两种尺寸间用 `setContentSize()` 切换（透明窗口不可用户缩放但可编程缩放，见 README-ENV §5.2）。

```
            点击胶囊(click) / second-instance / 热键 / activate
   capsule ─────────────────────────────────────────────────▶ panel
    (64×64)                                                   (520×720)
       ▲                                                        │
       │   Esc / 失焦(blur) / 收起按钮(-) / 热键(收起带动画)      │
       └────────────────────────────────────────────────────────┘
```

- **capsule（常驻）**：启动即显示，`showInactive()` 不抢焦点；点击=展开，拖动=移动（松开后吸附边缘并记忆位置）。
- **panel（临时）**：展开时 `show()+focus()`，renderer 聚焦输入框；Esc、失焦、点「—」、热键收起回胶囊。
- **热键**（默认 `Ctrl+Alt+Space`）双向切换：胶囊→面板直接展开；面板→胶囊走收起动画。
- 每次拖动结束（位移超过 4 DIP）写 `window-state.json`；位移小于 4 DIP 判定为点击。

## 3. 关键实现点

| 需求 | 实现 |
|---|---|
| 无边框圆角 | `frame:false` + `transparent:true` + CSS `border-radius`（`.panel-shell` 留 6 DIP padding 放阴影） |
| 置顶 | `alwaysOnTop:true` + `setAlwaysOnTop(true, 'screen-saver')` 盖住全屏应用 |
| 拖拽 | 手动拖拽：renderer 用 `event.screenX/screenY - window.screenX/screenY` 算窗口左上角，main `setPosition` |
| 位置记忆 | `userData/window-state.json`：`{ version, capsule:{x,y}, panel:{x,y} }`，防抖 400ms + tmp 原子替换 |
| 单实例 | `app.requestSingleInstanceLock()`；二次启动触发 `second-instance` → 展开面板 |
| 多屏 DPI | 所有坐标用 DIP；`screen.getDisplayNearestPoint()` + workArea 钳位；监听 `display-added/removed/metrics-changed` 重新钳位 |
| skipTaskbar | `skipTaskbar:true` |
| Esc 收起 | 主进程 `before-input-event` 捕获 `Escape`（权威，不依赖 renderer 焦点） |
| 失焦收起 | `win.on('blur')` → 若为 panel 态则收起 |
| **全局热键** | `src/hotkeys.js` 用 `globalShortcut` 注册，默认 `Control+Alt+Space`；加速键可 `update()` 并持久化到 `userData/hotkey.json`；注册失败（被占用）仅告警，胶囊点击仍可用 |
| **焦点策略(展开)** | panel 展开后 renderer `requestAnimationFrame` 里 `input.focus()` 聚焦输入框 |
| **焦点策略(收起)** | `showCapsule()` 先 `win.hide()`（Windows 把前台焦点还给 Z 序上一个窗口）再 `win.showInactive()` 显示胶囊不抢焦点 |
| **边缘吸附** | 胶囊拖动结束时，若距某工作区边缘 ≤ 24 DIP，`_snapCapsule()` 吸附到该边缘（留 8 DIP 边距） |
| **展开/收起动画** | 展开：主进程先切面板尺寸，renderer 播 `expand-in`（fade+scale, 180ms）；收起：renderer 播 `collapse-out`（fade+scale, 140ms），`animationend` 后发 `hud:collapse-done`，主进程再缩窗；主进程 280ms 兜底超时强制收起 |

## 4. 默认热键

- **默认**：`Ctrl+Alt+Space`（Electron accelerator `Control+Alt+Space`）。
- **可配置**：加速键存于 `userData/hotkey.json`，格式 `{ "accelerator": "..." }`。改文件后重启生效；或由后续设置 UI 调用 `hotkeys.update(next)` 运行时改并持久化。
- 作用：在**胶囊**与**面板**之间双向切换。

## 5. 如何被调用（沙箱外）

Electron 二进制复用 spike 已装好的（避免重复 150MB 下载）：

```cmd
cmd /c D:\DeepSeekData\workspace\dsh-hud\app\scripts\run-hud.cmd
```

等价于（`ELECTRON_RUN_AS_NODE` 必须清空，见 README-ENV §4.A）：

```cmd
set "ELECTRON_RUN_AS_NODE="
"D:\DeepSeekData\workspace\dsh-hud\spike\node_modules\electron\dist\electron.exe" ^
  --no-sandbox "D:\DeepSeekData\workspace\dsh-hud\app"
```

后续由 Cordis 插件「发现与拉起」时，插件只需：
1. 若进程未运行 → spawn 上述命令（或指向 app 目录）；
2. 若已运行 → 再次 spawn 同一命令，`second-instance` 会自动把面板拉起（单实例锁保证）。

> 可选环境变量：
> - `DSH_HUD_USER_DATA=<dir>`：覆盖 userData（沙箱内调试写工作区时用）。
> - `DSH_HUD_OPAQUE=1`：透明窗口渲染黑底的 GPU/RDP 兜底，改用不透明窗口。
> - `DSH_HUD_NO_ANIM=1`：关闭展开/收起动画（直接切换，便于排查动画问题）。

## 6. 如何验证

**Step 0（本机可执行，无需 GUI）——语法自检：**

```cmd
cmd /c D:\DeepSeekData\workspace\dsh-hud\app\scripts\check-hud.cmd
```

期望输出全部 `PASS`、退出码 0（`node --check` 只解析不执行，故可在 agent 会话内跑）。

**Step 1（用户侧，沙箱外一次性执行）——真实渲染：**

```cmd
cmd /c D:\DeepSeekData\workspace\dsh-hud\app\scripts\verify-hud.cmd
```

脚本会先打印默认热键与手测清单，按任意键后启动 HUD。逐项手测：

| # | 验证点 | 期望 |
|---|---|---|
| 1 | 启动 | 右下角出现 64×64 圆形鲸鱼图标，置顶、任务栏无图标 |
| 2 | 点击胶囊 | 展开为 520×720 圆角面板，输入框自动聚焦（光标闪烁） |
| 3 | `Ctrl+Alt+Space` | 面板收起为胶囊，焦点还给上一个窗口 |
| 4 | `Ctrl+Alt+Space` | 再次展开面板 |
| 5 | 拖动胶囊到屏幕边缘 | 松开后自动吸附到边缘（留 8px 边距） |
| 6 | 拖动胶囊到别处 | 松开后位置被记住，重启后回到该处 |
| 7 | Esc / 点击别处 | 面板收起（带 140ms 淡出缩放动画） |
| 8 | 点面板「—」/「×」 | 「—」收起；「×」退出进程 |
| 9 | 展开时改 DPI / 拔插显示器 | 窗口始终完整落在某个显示器工作区内 |
| 10 | 透明黑底时 | `set DSH_HUD_OPAQUE=1` 后不透明圆角兜底可显示 |

## 7. 已知取舍

1. **透明窗口无原生阴影**：改用 CSS `box-shadow`（`.shell` 的 padding 为阴影留白）。真透明窗口边缘在个别远程桌面/老驱动下黑底，此时用 `DSH_HUD_OPAQUE=1` 兜底为不透明窗口；不透明态无法得到真圆角窗口边缘（Windows frameless 不透明窗四角为直角，卡片内部仍是圆角），已作为取舍记录。
2. **手动拖拽而非 `-webkit-app-region`**：app-region 的 drag 区域收不到 click，无法区分「点胶囊展开」与「拖胶囊移动」，故用 screen 坐标手动拖拽，代价是拖拽期间靠 `mousemove` 事件驱动（比原生拖拽多一次 IPC，但对 280/520 小窗无感）。
3. **1px 尺寸抖动**（README-ENV §5.9）：构造与缩放均用 `useContentSize:true` + `setContentSize`，实测 `win.getSize()` 可能返回 521×721，属 Windows/Chrome 已知现象，对内容区无影响。
4. **收起动画用「先缩窗再播动画」的对偶**：展开动画是主进程先切到面板尺寸、renderer 再播 fade/scale-in（透明窗已到位，卡片淡入）；收起动画是 renderer 先播 fade/scale-out、`animationend` 后主进程再缩窗（卡片淡出后才缩）。若 renderer 卡死，主进程 280ms 兜底超时仍会强制收起，窗口不会卡在面板态。
5. **焦点归还依赖 Windows 默认行为**：收起时用 `hide()+showInactive()` 让系统把焦点还给 Z 序上一个窗口，未引入原生模块精确捕获「上一个窗口句柄」；在绝大多数场景下等效，极端多窗口/特殊焦点场景若有偏差可后续加原生模块精确还原。
6. **面板内容为内嵌 DSH Web UI**：`renderer/index.html` 的 `#web-host` 由主进程 `WebContentsView`（`src/web-embed.js`）覆盖注入，加载 discovery.json 提供的带 token 的 DSH Web UI；胶囊态时 view 分离保活、面板态重新挂载。详见 `docs/web-embed.md`。

## 8. 胶囊形态：鲸鱼圆标（t18）

t18 按用户新设计把胶囊从「长条 pill（280×64）」改为「DSH 白黑鲸鱼圆形图标」。

- **尺寸**：窗口常量 `CAPSULE` 由 `280×64` 改为 `64×64` DIP；`.capsule-shell` padding 4px，`.capsule-icon` 圆形白底 → 56px 圆标。白底保证黑色鲸鱼（`renderer/whale.svg`，复制自 `build/favicon.svg`）在任意壁纸上清晰可见。
- **左键点击**：展开为 520×720 面板（与旧胶囊行为一致；`renderer/hud.js` 的拖拽/点击判定不变，仍以「位移 < 4 DIP 为点击」）。
- **右键菜单**：renderer 的 `contextmenu` 事件由主进程 `win.webContents.on('context-menu')` 捕获，`Menu.buildFromTemplate(hud.buildContextMenu()).popup()` 弹出原生菜单。菜单项（数组 + separator 分组，可扩展）：
  1. **打开 DSH 桌面窗口** — 用可移植配置解析桌面 exe（`config.dshExe`：env `DSH_HUD_DSH_EXE` → `config.local.json` → 自动探测安装位置/运行中进程）；探测不到时仅按窗口标题置前（`focus-dsh.ps1` 的 FindApp 回退），不再硬编码路径（t26）。
  2. **打开 DSH 浮窗** — `showPanel()`（与左键点击等价）。
  3. **关闭 DSH 浮窗** — `hud.quit()`：先持久化当前位置到 `window-state.json` 再 `app.quit()`。
  - 分隔线之后保留「开机自启」checkbox（t9 功能）。
- **× 关闭按钮**：默认隐藏（opacity 0 + pointer-events none），鼠标移到图标上才淡入（`transition: opacity 140ms`）。
- **去阴影边**：`.panel-shell` padding 10→6、`.panel-card` 阴影 `0 18px 48px rgba(0,0,0,.45)` → `0 8px 24px rgba(0,0,0,.28)`；胶囊圆标只留一层轻阴影 `0 3px 10px rgba(0,0,0,.22)`（圆形白底，无方形灰边）。`html/body` 与 `.shell` 无残留不透明背景。
- **内嵌页圆角裁切修复（t19）**：内嵌 DSH 页面的左上角侧边栏开关曾被 14px 圆角裁掉，根因是注入样式 `#root,[class*="frame"]{overflow:hidden}`（`src/compact-css.js` C6）裁掉了页面自己的贴边控件——不是 shell 的 `.web-host`（WebContentsView 是原生视图，DOM 的 `overflow`/`border-radius` 裁不到它）。修法选 **A（去掉内层裁切，外层卡片负责圆角）**：C6 只保留 `border-radius:14px`（圆化页面自身背景以融入卡片）、去掉 `overflow:hidden`；同时移除 `.web-host` 上冗余的 `border-radius/overflow`。这样按钮完整可见可点击，面板外观仍由 `.panel-card` 的 20px 圆角负责。

## 9. 验收对应

- 状态机完整：capsule ↔ panel 双态 + 触发源（点击/二次实例/热键/activate → panel；Esc/失焦/按钮/热键 → capsule）+ 位置记忆 + 边缘吸附 + 多屏钳位。
- 热键注册逻辑完整：`src/hotkeys.js` 注册/更新/持久化 + `main.js` `will-quit` 统一 `unregisterAll()`；默认 `Ctrl+Alt+Space` 并写入 docs。
- 语法检查通过：`scripts/check-hud.cmd`（node --check，覆盖 7 个 JS 文件）。
- docs 写明默认热键与验证步骤：本文档 §4、§6。
