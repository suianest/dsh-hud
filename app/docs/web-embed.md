# DSH HUD · Web 内容嵌入（t6）

内嵌 DSH Web UI 到 520×720 面板的实现说明。依赖 t3 的 `docs/embed-feasibility.md` 结论与 t4/t5 的单窗口双态骨架。

## 架构

面板态下，主进程用一个 `WebContentsView`（`src/web-embed.js`）覆盖在 shell 的 `#web-host` 矩形上；胶囊态下 detach（保留实例，不销毁）。DSH Web UI 自身带完整外壳（header / 侧栏 / 对话区 / 输入卡），因此 shell 只保留 46px 顶栏（拖拽 + 收起/退出），不再有本地输入条。

```
[ BrowserWindow (transparent, frameless) ]
  contentView
   ├─ shell WebContents (renderer/index.html)   ← 胶囊 + 面板顶栏 + #web-host 占位
   └─ WebContentsView (src/web-embed.js)        ← DSH Web UI / error.html
        bounds = #web-host 的 getBoundingClientRect（renderer 经 IPC 上报）
```

## 文件

| 路径 | 说明 |
| --- | --- |
| `src/discovery.js` | 读 `%LOCALAPPDATA%\dsh-hud\discovery.json`；`tokenUrl()`/`cleanUrl()`/`ageMs()`；`DSH_HUD_DISCOVERY` 覆盖路径 |
| `src/compact-css.js` | t3 CSS 注入载荷（`COMPACT_CSS` 字符串，`webContents.insertCSS`） |
| `src/web-embed.js` | `WebEmbed` 类：加载/鉴权回退/错误页/stub/devtools |
| `renderer/web-preload.js` | 内嵌视图的 preload：`window.webBridge`（错误页按钮）+ 可选 `window.dshDesktop` stub |
| `renderer/error.html` | 自绘错误页（unreachable / auth），带「重试」「启动 DSH」 |
| `renderer/index.html` / `hud.js` / `hud.css` | 面板体改为单个 `#web-host`，renderer 上报其边界 |
| `src/hud-window.js` | 集成 `WebEmbed`：展开 attach+load、收起 detach、3 条 IPC |

## 鉴权链路（冷启动）

1. `showPanel()` → `_showWeb()` → `web.load()`。
2. `_resolveTarget(false)`：`bootstrapped === false` → 用 **token URL**（discovery 的 `url`）。
3. `loadURL(tokenUrl)` → 服务端 303 + `Set-Cookie dsh-auth-*` → 200，`did-finish-load` 置 `bootstrapped = true`。
4. 之后的 reload（含错误页「重试」前的 token 回退路径）→ 用 **clean URL**（去掉 `?token=`，cookie 鉴权）。
5. 若 clean URL 收到 401 且 discovery 里有 <60s 的新鲜 token → 自动回退一次 token URL；否则显示错误页。

持久化：分区 `persist:dsh-web`（`constants.WEB_PARTITION`）。Chromium 只落盘「带显式过期时间」的 cookie；DSH 的 `dsh-auth-*` 是 session cookie（无 Max-Age），因此跨进程冷启动不靠 cookie、而靠 discovery 的新鲜 token 重新铸造 cookie——这正是「冷启动加载成功」的路径。

## 错误态

- **unreachable**：`did-fail-load`（非 `-3 ERR_ABORTED`）或 discovery 缺失 → 错误页「无法连接 DSH / 端口不可达」。
- **auth（401）**：HTTP 401 是合法响应，不走 `did-fail-load`；用 `session.webRequest.onCompleted` 监听 mainFrame `statusCode >= 400` 捕获。
- **http**：其它 4xx/5xx。
- 错误页按钮：`重试` → `hud:web-retry`（`reload({forceToken:true})`）；`启动 DSH` → `hud:web-start-dsh`（先重读 discovery；若设了 `DSH_HUD_DSH_EXE` 则 detached spawn，2 秒后重试一次）。真正的「发现与拉起」由 Cordis 插件负责，这里只是兜底。

## window.dshDesktop stub

真实证据（`artifacts/embed-assets/combo-1.js` / `combo-2.js`）：Web UI 对 `dshDesktop` 全部是**守卫式访问**——`"dshDesktop" in globalThis`、`window.dshDesktop?.fileActions`、`globalThis.dshDesktop?.deviceInfo` 等，缺失时自动降级为 web 模式（这正是它在普通浏览器里的运行方式）。因此**默认不注入 stub**，避免「UI 以为自己在桌面模式 → 调用缺失方法 → 崩溃」。

`DSH_HUD_DESKTOP_STUB=1` 时，`web-preload.js` 注入一个最小占位对象（`platform`/`fileActions`/`deviceInfo`/`shortcuts`/`keyboard` + 两个 no-op），仅供未来桌面集成实验。

## CSS 注入（t3 清单）

`src/compact-css.js` 汇入：C2（隐藏 widthHandle）、C4（细滚动条/禁双层滚动）、C5（隐藏右栏入口）、C6（透明 body + 圆角裁剪，**不含** `.hud-drag` 拖拽带——shell 顶栏才是拖拽手柄）、C1（`--dsh-chat-user-width` 后门）、C3 step 1（header 水平内边距）。C3 step 2（压 header 高）与 C7（皮肤覆盖）待 gate 截图确认后再加。

## 开发模式

`DSH_HUD_DEV=1`：内嵌页面 `did-finish-load` 后 `openDevTools({mode:'detach'})`。默认不开。

## 沙箱外验证

```cmd
D:\DeepSeekData\workspace\dsh-hud\app\scripts\verify-hud.cmd
```

前置：DSH 桌面端运行中且已安装 token 桥插件（`%LOCALAPPDATA%\dsh-hud\discovery.json` 存在、`url` 含 `?token=`）。详见 `scripts/verify-hud.cmd` 的 12 条手测清单。

## 已知取舍 / 待验证

- **未启动 electron**（守 t1 约束）：本任务只做 `node --check` + 静态自检；冷启动、流式消息、401 错误页、CSS 前后截图对比均由用户侧一次性批量验证。
- 面板 46px 顶栏 + Web UI 自身 header（~76px）会叠加约 122px 顶部 chrome；若 gate 截图显示过挤，可再走 C3 step 2 压 header 高。
- WebContentsView 的透明背景用 `view.setBackgroundColor('#00000000')`（有 `typeof` 守卫）+ 注入 `html,body{background:transparent}`；部分 GPU/RDP 仍需 `DSH_HUD_OPAQUE=1` 兜底（沿用 t4）。
