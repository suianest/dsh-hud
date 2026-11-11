# 520×720 内嵌 DSH Web UI：可行性评估与 CSS 适配清单

> 评估对象：本机正在运行的 DSH Web UI（`http://127.0.0.1:50265`，token 由 t2 桥插件写入 `%LOCALAPPDATA%\dsh-hud\discovery.json`）。
> 方法：node fetch 拉取真实 `index.html` / `assets/*.js` / `assets/*.css` / 三个 plugin combo bundle，静态阅读布局与聊天模块源码；布局列宽用 bundle 内的**原函数**在 Node 里复算。
> 状态：静态分析已完成；**像素级验证（`artifacts/gate-embed.png`）尚未产生**，见 §12 占位。

---

## 0. 结论摘要（TL;DR）

| 问题 | 结论 | 依据 |
|---|---|---|
| 能否直接嵌入（iframe / BrowserWindow loadURL） | **能**。响应无 CSP、无 `X-Frame-Options`、无 COOP/COEP | §1.3 |
| 520 宽会不会天然崩版 | **不会**。侧栏在 <1024 自动收成 56px 图标栏，右栏在可用空间 <300px 时归 0，聊天内容宽度用 `max-width` 语义 | §2、§3 |
| 是否需要注入 CSS | **需要，约 6 组**。隐藏拖拽手柄、压缩 header/输入区、隐藏右栏入口、紧凑滚动条、圆角/透明、禁皮肤 | §4 |
| 深色主题 | 原生支持（`data-ds-dark-theme` + `prefers-color-scheme`），HUD 侧用 `nativeTheme.themeSource='dark'` 对齐即可 | §8 |
| 是否需要自带外壳 | 面板态**不需要**（Web UI 本身就是 `inset:0` 全屏应用壳）；胶囊态需要独立小窗 | §9 |
| Go/No-Go | **条件 Go**：按 §4 注入 CSS，即可以 520×720 直接嵌入整套 UI；唯一未定的风险是 header 在 464px 下是否挤压（需 gate 截图确认） | §10 |

**一句话**：520 宽下 Web UI 的真实形态是 `56px 图标栏 + 464px 聊天区 + 0px 右栏`，且核心容器都用 `max-width`，不会出现"固定 680px 把面板撑破"的问题；只需注入少量 CSS 把 header/输入区收紧、隐藏拖拽手柄与右栏入口。

---

## 1. 证据与复现

### 1.1 发现文件（t2 桥插件产物）

```
%LOCALAPPDATA%\dsh-hud\discovery.json
{"pid":22896,"port":"50265","url":"http://127.0.0.1:50265/?token=<one-shot>","updatedAt":"2026-11-04T17:03:11Z"}
```

### 1.2 鉴权链路（实测）

| 请求 | 结果 |
|---|---|
| `GET /?token=…` | **303** `Location: ./` + `Set-Cookie: dsh-auth-<hash>=v1.eyJ…`（HttpOnly） |
| `GET /`（带 cookie） | **200**，43709 B，`<title>DeepSeek Harness</title>` |
| `GET /assets/index-BgUyXZcc.js`（不带 cookie） | **404** —— 静态资源同样受 token/cookie 保护 |

→ 结论：**HUD 只需用带 token 的 URL 加载一次**，cookie 落到该 window 的 session partition，之后同源导航（含刷新、HMR）都不再需要 token。token 是一次性的，不能写死在 HTML 里。

### 1.3 响应头（`GET /`）

```
content-security-policy: (none)
x-frame-options:          (none)
cross-origin-opener-policy / embedder-policy: (none)
permissions-policy:       (none)
cache-control:            (none)
```

→ 无 `frame-ancestors`、无 `X-Frame-Options`，**iframe 嵌入不被服务端阻止**（但仍推荐 §9 的直接加载方案）。

### 1.4 抓取产物（可复现）

目录 `D:\DeepSeekData\workspace\dsh-hud\artifacts\embed-assets\`：

| 文件 | 大小 | 内容 |
|---|---|---|
| `index.html` | 43.7 KB | 应用壳 + `window.__DSH_BOOT__` 引导数据 |
| `assets_index-BgUyXZcc.js` | 970 770 B | 应用入口 |
| `assets_vendor-BUMdD3V7.js` | 741 528 B | React 等 vendor |
| `assets_index-lh_YM6sT.css` | 87 126 B | 壳层样式（61 个 `@media`，**0 个宽度断点**） |
| `assets_vendor-DV2921Zo.css` | 27 312 B | vendor 样式 |
| `combo-1.js` | 7 359 532 B | 第一批 57 个客户端插件（含 layout / chat / 设置页） |
| `combo-2.js` | 5 935 583 B | 第二批插件（含皮肤、终端、文件面板） |
| `combo-3.js` | 46 622 B | client-modules 引导 |

抓取/分析脚本（同目录）：`fetch-webui.mjs`、`fetch-combos.mjs`、`analyze-css.mjs`、`analyze-combos.mjs`、`ctx-combos.mjs`、`dig-chat.mjs`、`math.mjs`、`composer-css.cjs`、`composer-headers.cjs`、`dig-drag.cjs`；文本报告 `css-analysis.txt`、`combo-analysis.txt`、`layout-consts.txt`、`width-media-and-math.txt`、`chat-css.txt`。

---

## 2. 布局数学（源码逐字，`@deepseek-ai/dsh-client-ui-layout`）

```js
const SIDEBAR_AUTO_COLLAPSE = 1024;
const RIGHTBAR_MAX_RATIO = .7;
const RIGHTBAR_DEFAULT_RATIO = .45;

function clampWidth(px, min, max) { return Math.min(max, Math.max(min, Math.round(px))); }

function computeColumns(viewport, sidebar, rightbar, collapsedWidth = 56, centeredSidebar = false) {
  const s = sidebar === 0 ? collapsedWidth
          : centeredSidebar ? viewport / 2
          : clampWidth(sidebar, 264, 420);
  const available = viewport - s - 400;
  const r = rightbar === 0 || available < 300 ? 0
          : Math.min(available, clampWidth(rightbar, 300, viewport * RIGHTBAR_MAX_RATIO));
  return { sidebar: s, center: Math.max(0, viewport - s - r), rightbar: r };
}

const narrow = viewport < SIDEBAR_AUTO_COLLAPSE;                  // 520 → true
const windowsTitlebar = document.documentElement.hasAttribute("data-windows-titlebar");
const drawer = viewport < 768 && !windowsTitlebar;                // 独立 HUD 窗口 → true
const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0;
const drawerOpen = drawer && !sidebarCollapsed;
const sidebarWidth = drawer ? Math.min(layoutInfo.sidebar || 280, Math.max(0, viewport - 48)) : cols.sidebar;
// 默认 store: layoutInfo = { sidebar: 280, narrowExpanded: false, ... }
```

复算（`math.mjs`，用上面原函数）：

| viewport | sidebarPref | 结果 `{sidebar, center, rightbar}` |
|---|---|---|
| **520** | 0（窄屏默认收起） | **`{56, 464, 0}`** |
| 700 | 0 | `{56, 644, 0}` |
| 768 | 0 | `{56, 712, 0}` |
| 900 | 0 | `{56, 844, 0}` |
| 1024 | 280 | `{280, 744, 0}` |
| 1280 | 280 | `{280, 1000, 0}` |
| 1707（当前桌面） | 280 | `{280, 1427, 0}` |

要点：

* 520 时 `narrow=true`、`narrowExpanded` 默认 `false` → 侧栏**收成 56px 图标栏**，不占 280px。
* 520 时 `drawer=true`（独立窗口没有 `data-windows-titlebar`）→ 点侧栏按钮打开的是 **280px 浮层抽屉**，覆盖内容而非挤压。
* 右栏 `available = 520 - 56 - 400 = 64 < 300` → **r = 0**，右栏列宽归零。
* grid 模板：`` `${cols.sidebar}px minmax(${cols.rightbar === 0 ? 0 : 400}px, 1fr) minmax(0px, ${rightbarMax}px)` `` —— 520 下等价于 `56px minmax(0,1fr) minmax(0,0)`。

---

## 3. 真实断点盘点

| 来源 | 宽度相关断点 | 评价 |
|---|---|---|
| `assets_index-*.css`（壳层） | **0 个**（61 个 `@media` 全是 hover / pointer / reduced-motion / print） | 壳层不自适应宽度 |
| `combo-1.js`（第一批插件） | 9 个：`(width<=1200px)` `(width<=1100px)` `(width<=767px)` `(width<768px)` `(width>=768px)` `(width<=760px)` `(width<=560px)` `(width<=480px)` `(width<=400px)`；另有 8 个容器查询：`(width<=440px)` `(width<600px)` `(width<372px)` `(width<=460px)` `(width<=520px)` `(width<=560px)` `(width<=900px)` `(width<=540px)` | 有窄屏分支，但都是"顺手加的"，非 520 专用 |
| `combo-2.js`（第二批插件） | 19 个：`(width<=1080px)` `(width<=767px)` `(width<=760px)` `(width<=720px)` `(width<=700px)` `(width<=640px)` `(width<=600px)` `(width<=520px)` `(width<=420px)` `(width<=860px)` `(width<=960px)` `(width<=1099px),(height<=680px)` `(width>=1100px) and (height>=681px)` `(width<=700px) and (orientation:portrait)` `(max-width:560px)` `(max-width:600px)` `(max-width:680px)` | 设置/外观页有手机档 |
| 皮肤插件 `@smalltailqwq/dsh-client-ui-skin-maid-atelier` | `PHONE_MAX_WIDTH = 700`、`MOBILE_QUERY = (max-width:700px),(pointer:coarse)`、`DRAWER_AUTO_COLLAPSE = 1024` | 仅 `body[data-dsh-maid-atelier]` 存在时生效 |

**结论：整套代码没有任何 `520px` 专用适配，但也没有任何"最小宽度 + 横向滚动"的硬约束。** 520 落在 `(width<=560px)` / `(width<=520px)` 容器查询的覆盖范围内，属于"可用的手机档"，而不是"设计目标档"——所以需要 §4 的补充 CSS 把留白收紧。

---

## 4. 需要注入的 CSS（必须 / 建议）

> 约定：所有 class 名都是 hash（如 `.an3WzG_body`），**跨版本不可靠**。选择器优先用稳定锚点：`[data-phase]`、`[data-composer-seat]`、`[data-slot=conversation\.session]`、`[class*="scrollBody"]`；能用 CSS 变量解决的绝不写 class。注入方式：`webContents.insertCSS()`（主进程侧、可整组替换/移除），或由 HUD 的 Cordis 客户端插件注入 `<style data-hud-compact>`。

| 级别 | 组 | 何时注入 |
|---|---|---|
| **M（必须）** | C2 隐藏拖拽手柄、C4 滚动/尺寸基础、C5 右栏入口、C6 圆角/透明/拖拽带 | 所有面板态 |
| **C（建议/条件）** | C1 内容宽度、C3 header 压缩、C7 皮肤覆盖 | 按 gate 截图结果取用 |

**关键陷阱（已踩）**：`--dsh-chat-content-width` 是在 `.an3WzG_body` **元素自身上**声明的（`--dsh-chat-content-width: var(--dsh-chat-user-width, clamp(680px, …))`）。往祖先元素（`:root`、`[data-phase]`）写同名变量**无效**——元素自身的声明永远赢过继承值，加 `!important` 也一样。必须改用它的**上游覆盖变量** `--dsh-chat-user-width`（见 C1）。

### C1. 收紧聊天内容宽度（可选；走 `--dsh-chat-user-width` 后门）

现状：520 下 `--dsh-chat-content-width = clamp(680px, 列宽*0.64, 920px) = 680px > 464px` 聊天区。因为下游消费方用的是 `max-width` 语义，**不会溢出**；只是输入卡两侧各 16px 的 `side-clearance` 会让卡片几乎贴边。app 自带一个 embedded 变体（`min(calc(100% - 32px), 920px)`），我们复刻其语义，但要绕开"元素自身声明"的陷阱：

```css
/* 上游覆盖变量：.an3WzG_body 会读它，set 了就不再走 clamp(680px, …) 的兜底 */
:root {
  --dsh-chat-user-width: min(calc(100vw - 80px), 680px);   /* 520 - 56 轨 - 24 边距 ≈ 440 */
}
```

* `100vw` 而非 `100%`：自定义属性里的百分比要到使用处才解析，`vw` 语义确定、窗口缩放即时生效。
* 若以后 app 把用户拖拽宽度写进 `--dsh-chat-user-width`（body 内联样式），这个后门会失效——但 C2 已经把手柄藏了，正常不会触发。
* 该变量同时带动 `--dsh-composer-card-max-width = calc(content + 32px)`，所以输入卡会同步收敛，不用单独改。

### C2. 隐藏会话拖拽手柄

`.an3WzG_widthHandle { width: min(10px, calc((100% - var(--dsh-chat-content-width)) / 2 - 48px)) }`，520 下括号内为负 → 宽度声明非法被丢弃，手柄仍会以 `position:absolute` 存在并响应 `cursor:col-resize`。直接关掉：

```css
[class*="widthHandle"] { display: none !important; }
```

### C3. 压缩 header（先收内边距，再按需压高度）

`.an3WzG_header { min-height:76px; padding:10px 28px 0 20px; grid-template-columns:auto minmax(0,1fr) }`。464px 下 28px 右内边距 + 20px 左内边距纯属浪费，但**高度不要盲改**：header 是 `grid`，76px 里可能有两行（标题行 + 会话 tab 行），压到 48 会把第二行裁掉。分两步：

第一步（安全）：只收水平内边距

```css
[data-phase] :where([class*="header"]) { padding-right: 12px !important; padding-left: 12px !important; }
```

第二步（仅在 gate 截图证明 header 只有一行、且纵向留白过大时）：压高度 + 隐藏次级项

```css
[data-phase] :where([class*="header"]) { min-height: 48px !important; padding-top: 6px !important; }
[data-phase] :where([class*="viewsMore"],          /* 视图切换 "…" */
                    [class*="workspaceCrumb"])     /* 工作区面包屑 */
  { display: none !important; }
```

> `:where()` 不增加特异性，配合 `!important` 仍可覆盖；`[class*="header"]` 会命中所有名字含 header 的节点，所以先用第一步、截图确认无副作用再上第二步。

### C4. 紧凑滚动条 + 禁止二次滚动

```css
* { scrollbar-width: thin; }
html, body { overflow: hidden !important; height: 100%; }
::-webkit-scrollbar { width: 6px; height: 6px; }
```

app 自己管滚动（`.an3WzG_scrollBody { overflow-y:auto }`），HUD **不要**再包一层滚动容器，否则会出现双滚动条 + 输入区 sticky 失效。

### C5. 隐藏右栏入口（520 下右栏宽度恒为 0）

右栏在 520 下被 `computeColumns` 归零，但工具栏按钮仍在，点了会在 0 宽列里渲染出不可见面板：

```css
[class*="rightbar"], [class*="rightBar"], [data-slot="rightbar"] { display: none !important; }
[aria-label*="终端"], [aria-label*="浏览器"] { display: none; }
```

（具体按钮的 `aria-label` 名称待 gate 截图核对后定稿。）

### C6. 圆角 / 透明 / 拖拽带

```css
html, body { background: transparent !important; }
#root, [class*="frame"] { border-radius: 14px; overflow: hidden; }
/* HUD 自绘的顶部拖拽带（32px，避开窗口控制区） */
.hud-drag { position: fixed; top: 0; left: 0; right: 0; height: 32px;
            -webkit-app-region: drag; z-index: 2147483000; }
.hud-drag :is(button, a, input) { -webkit-app-region: no-drag; }
```

> 注意：**不要**给 `<html>` 加 `data-windows-titlebar`。它会让 `drawer=false`（侧栏从"浮层抽屉"退化成"轨道收起"）、给 frame 加 `padding-top: var(--dsh-windows-titlebar-height)` 并用 `:before` 画一条 drag 带（48px 高），在 520 面板里是纯浪费。HUD 自己画 32px 拖拽带即可。

### C7. 禁用/覆盖皮肤插件（若该皮肤被启用）

只在 `body[data-dsh-maid-atelier]` 存在时相关，否则可跳过。皮肤把 hero 输入卡最小宽度钉在 `clamp(560px, 41vw, 740px)`、active 态 `max(720px, …)`，520 下必溢出。若无法禁用皮肤，用两条直击声明覆盖（`--dsh-chat-user-width` 仍走 C1 的后门）：

```css
body[data-dsh-maid-atelier] [data-phase=hero] {
  --dsh-chat-content-width: min(calc(100vw - 80px), 680px) !important;
}
body[data-dsh-maid-atelier] [data-composer-card] { max-width: 100% !important; }
```

**MVP 建议：HUD 窗口里不启用任何皮肤插件**（Cordis 侧按 profile/窗口来源关闭），CSS 覆盖只作兜底。

---

## 5. 需要隐藏或合并的栏

| 区域 | 520 下的原生行为 | 建议 |
|---|---|---|
| 左侧栏 | 56px 图标轨道（`narrow=true` 且 `narrowExpanded=false`） | **保留**（相当于豆包的会话入口）；若要纯聊天可再收 0，但需覆盖内联 `grid-template-columns`，风险高，不推荐 |
| 侧栏展开态 | 280px 浮层抽屉（`drawer=true`，覆盖内容） | 保留，抽屉带遮罩，Esc/点外部关闭（app 已实现） |
| 右栏（终端/文件/浏览器） | 列宽 0，面板不可见但按钮仍在 | **隐藏入口**（C5），或让面板以全屏 overlay 打开 |
| 顶部 header | 76px，`grid: auto minmax(0,1fr)` | 先收水平内边距（C3 第一步）；只有确认单行时才压到 48px |
| 工作区行（hero 下） | `padding: 0 16px 0 20px` | 收到 10px（可选，与 C1 同批） |
| 会话拖拽手柄 | 负宽度、无视觉但可交互 | `display:none`（C2） |
| 窗口标题栏 | 独立窗口**没有** `data-windows-titlebar` | HUD 自绘 32px 拖拽带（C6） |

---

## 6. 缩放比例

| `zoomFactor` | 等效 CSS 视口（520 物理） | 聊天区等效宽度 | 评价 |
|---|---|---|---|
| 1.0 | 520 | 464 | **推荐**；命中 `<=520` 容器查询分支 |
| 0.95 | 547 | 491 | 略微增加信息量，字号 13.3px |
| 0.9 | 578 | 522 | 字号 12.6px，Windows 下偏小 |
| 0.85 | 612 | 556 | 不推荐（hit target < 32px） |

结论：**1.0 起步**，用 C1/C3 收紧留白来换信息密度，而不是缩放；只有当 gate 截图证明 header 仍然放不下时才降到 0.95。

---

## 7. 滚动容器

* 滚动由 app 独占：`.an3WzG_scrollBody { overflow-y:auto; scrollbar-gutter:stable }`，输入区 `[data-composer-seat]` 绝对定位贴在 `bottom:0`（有 `[data-conversation-composer-overlay]` 时）。
* HUD 侧要求：`html, body { height:100%; overflow:hidden }`（C4），**不要**给 `#root` 或 HUD 包装层加 `overflow:auto`。
* 窗口尺寸变化时 app 用 `ResizeObserver` 重算列宽（`computeColumns`），无需 HUD 主动通知。
* 拖拽带（32px）需要 `pointer-events` 只在自身生效，不能覆盖滚动区域；建议 `position:fixed` + 半透明渐变，避免遮挡 header 第一行按钮。

---

## 8. 深色主题

主题由 `index.html` 内联 boot 脚本决定（逐字）：

```js
const preference = "system"                        // 来自服务端用户偏好
const systemDark = preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches
const dark = preference === 'dark' || systemDark
document.documentElement.dataset.dsThemeSource = preference
document.body.toggleAttribute('data-ds-dark-theme', dark)
```

* 属性挂在 **`body`** 上：`body[data-ds-dark-theme]`（bundle 内有 21 / 159 处 CSS 依赖它），`html` 上只有 `data-ds-theme-source`。
* 深色 token 走 `--dsw-alias-*`（如 `--dsw-alias-bg-base`）。

**HUD 侧做法**：`nativeTheme.themeSource = 'dark'`，让 `prefers-color-scheme` 上报 dark，boot 脚本自己就会挂上 `data-ds-dark-theme`——**不需要注入 JS 改属性**；这同时避免加载瞬间白闪（boot CSS 里浅色底是 `#fff`）。

透明窗口额外要求：

```js
win.setBackgroundColor('#00000000');   // 透明
```

```css
/* body 的 boot 背景是 #fff / #151517，必须打掉，否则窗口不透明 */
html, body { background: transparent !important; }
```

* 透明 + 深色时给内容容器圆角与 `background: var(--dsw-alias-bg-base)`，否则四角透出桌面。
* 字号可调（boot 内联：`--dsh-content-font-size:14px`、`--dsh-code-font-size:11px`、`--dsh-terminal-font-size:13px`）：
  ```css
  body { --dsh-content-font-size: 13px !important; }
  ```
* 已知坑（来自 t1）：Windows 下 `transparent:true` + `frame:false` 会多算 1px（`getSize()` 返回 521×721），布局按 `innerWidth` 自适应即可，不要用 `getSize()` 做数学。

---

## 9. 是否必须自带外壳

### 两种集成方式对比

| 方式 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A. 直接加载 Web UI | `win.loadURL(tokenUrl)` → 303 → cookie；注入 CSS | 同源、无 iframe 限制、键盘/快捷键/剪贴板全通、省内存 | 需要自绘拖拽带、窗口控制 | **推荐（MVP）** |
| B. 壳页 + iframe | HUD 自己的 HTML 里放 `<iframe src=tokenUrl>` | 壳页可放胶囊/边框/角标 | iframe 内 cookie 需同一 partition 且 SameSite 校验；拖拽带要覆盖 iframe（需 `pointer-events` 技巧）；焦点/快捷键易丢 | 备选，仅在需要"壳页装饰"时用 |

**外壳需求**：面板态不需要（Web UI 自身是 `position:fixed; inset:0` 的应用壳，自带 header/侧栏/输入区）；胶囊态（常驻 56×56 或 120×36 小窗）**需要独立窗口**，且不应加载整套 Web UI（太浪费），用纯静态 HTML + Canvas/Web Animations 画胶囊即可。

窗口建议：

```
胶囊窗：120×40, frame:false, transparent:true, alwaysOnTop, skipTaskbar, resizable:false, focusable:false（点击时再 focus）
面板窗：520×720, frame:false, transparent:true, alwaysOnTop("floating"), skipTaskbar, resizable:true, minWidth:420
```

---

## 10. Go/No-Go

**条件 Go。**

* 静态证据已足以支撑"520 宽可直接嵌入整套 Web UI"：列宽自动收敛、无固定宽度撑破、无 CSP/XFO 阻止、token→cookie 链路干净。
* 剩余不确定项只有两个，都必须在 gate 截图中确认：
  1. header 在 464px 下是否横向溢出（`grid auto minmax(0,1fr)` 理论上能收，但按钮组是 `display:flex` 且未设 `min-width:0`）；
  2. hero 输入卡在 `--dsh-chat-content-width=680 > 464` 时，`width:min(calc(...), 100%)` 是否真的被 100% 截住（源码如此，但要眼见为实）。

**验收清单（拿到 `artifacts/gate-embed.png` 后逐条打勾）**：

- [ ] 520×720 下无横向滚动条（`document.documentElement.scrollWidth <= 520`）
- [ ] 侧栏为 56px 图标轨道，非 280px
- [ ] 右栏列宽 0，且没有可见的右栏按钮
- [ ] header 高度 76px，右侧按钮未被裁切
- [ ] 输入卡左右留白 ≥ 8px，未贴边、未溢出
- [ ] 发送一条消息后，`[data-phase=active]` 下内容不横向滚动
- [ ] 深色主题生效（body 背景非白）
- [ ] 缩放 100% 时字号 ≥ 12px

**No-Go 触发条件**：header 无论如何压缩都溢出，或输入卡在 464px 下横向溢出且无法用 `min(100%, …)` 修正 → 转 §11 降级方案。

---

## 11. 降级方案

| 级别 | 方案 | 代价 | 触发条件 |
|---|---|---|---|
| L1 | 仅注入 §4 CSS + 隐藏右栏入口 + header 压缩 | 无（首选） | 默认 |
| L2 | L1 + `zoomFactor=0.95` + 隐藏视图切换/工作区行 | 字号变小 | header 仍溢出 |
| L3 | 只嵌入会话区（隐藏侧栏 56px，`grid-template-columns` 覆盖为 `0 minmax(0,1fr) 0`；会话列表用 HUD 自绘抽屉） | 需要覆盖内联样式，版本升级易碎 | 需要极简"只聊天"形态 |
| L4 | 自带轻量聊天 UI（HUD 直接调 DSH HTTP/WS 接口） | 需要协议/事件契约，工作量最大；但 520 下体验最好 | 上游 UI 明确不做窄屏适配 |

**当前建议**：MVP 走 L1；把 L2 作为开关（`hud.zoom` 配置）；L3/L4 只在 L1 实测失败时启动。

---

## 12. 待验证（等待用户侧截图证据）

`scripts/gate-embed.cmd` 由 captain 提供（入口 `gate\main.js`，520×720 无边框窗口 + `capturePage()` + 布局指标采集），产物应为 `artifacts/gate-embed.json` + `artifacts/gate-embed.png`。**截至本文定稿（2026-11-05 01:27）json/png 均未产生**：01:16 那次只留下 2 B 空日志；01:22 / 01:26 我在会话内复跑两次，分别拿到 MODULE_NOT_FOUND 与 `0xC0000005` 秒崩（见下）。因此 §10 的 8 条验收清单全部为「待验证」。

> **本次会话内实测（2026-11-05 01:22，`Start-Process cmd /c scripts\gate-embed.cmd`）**：`EXIT=1`，`gate-embed.log` 从 2 B 变成 **994 B**：
>
> ```
> Error: Cannot find module 'electron'
> Require stack:
> - D:\DeepSeekData\workspace\dsh-hud\gate\main.js
>   code: 'MODULE_NOT_FOUND'
> Node.js v24.22.2
> ```
>
> 原因不是渲染崩溃，而是**先退化成了 Node**：本会话继承了 `ELECTRON_RUN_AS_NODE=1`，electron.exe 以 Node v24.22.2 身份执行 `操作日志/gate/main.js`；而 `gate/` 不在 `spike/node_modules` 的解析路径上，`require('electron')` 直接 MODULE_NOT_FOUND，连窗口都没创建。
>
> **给 captain 的启动行修正（三行缺一不可）**：
> ```bat
> set "ELECTRON_RUN_AS_NODE="
> set "ELECTRON_ENABLE_LOGGING=1"
> "%EL%" --no-sandbox "%ROOT%\gate\main.js"
> ```
> 清掉环境变量后 `require('electron')` 走 Electron 内建模块解析；`--no-sandbox` 修 t1 的 `0x80000003` 秒崩。**但本会话仍然跑不出图**：我用 `artifacts\run-gate-test.cmd`（同上三行 + 重定向）复跑一次，结果 `EXIT=-1073741819`（`0xC0000005`）、stdout/stderr 仅 2 B、`gate-embed.json/.png` 未生成——与 t1 的结论同源：受限令牌下 Chromium 子进程打不开命名管道。所以 gate 必须在**沙箱外的普通终端**跑一次，产物拷回 `artifacts/`。

拿到产物后需要补录的真实测量值（写回本节）：

| 指标 | 期望值 | 实测 |
|---|---|---|
| `documentElement.scrollWidth` | ≤ 520 | 待验证 |
| `documentElement.scrollHeight` | ≤ 720 | 待验证 |
| 侧栏实际宽度 | 56 | 待验证 |
| 右栏实际宽度 | 0 | 待验证 |
| header 高度 | 76（注入前）/ 48（注入后） | 待验证 |
| 输入卡宽度 / 左右留白 | ≈ 464 / ≥ 8 | 待验证 |
| body 背景色（深色） | 非 `rgb(255,255,255)` | 待验证 |
| 截图非空白（像素方差 > 阈值） | true | 待验证 |

> t1 已证实：本会话的受限令牌（Low IL + 受限 SID）下，Chromium 子进程 `CreateFileW` 打开命名管道被拒 → `FATAL:mojo\public\cpp\platform\platform_channel.cc:112 Check failed: . : 拒绝访问。 (0x5)`。所以 gate 只能由**沙箱外普通终端**执行一次，产物拷回 `artifacts/` 后本节即可填满。

---

## 附录 A：关键源码片段（便于复核）

聊天模块（`@deepseek-ai/dsh-client-ui-chat`，`combo-1.js`）：

```css
.an3WzG_body{ --dsh-chat-content-width: var(--dsh-chat-user-width, clamp(680px, calc(var(--dsh-conversation-column-width,0px) * .64), 920px));
              --dsh-composer-card-max-width: calc(var(--dsh-chat-content-width) + 32px);
              --dsh-composer-side-clearance: 16px; --dsh-composer-dock-inset: 8px; }
.an3WzG_embeddedBody{ --dsh-chat-content-width: min(calc(100% - 32px),920px);
                      --dsh-composer-card-max-width: min(calc(100% - 16px),952px);
                      --dsh-composer-side-clearance: 8px; overflow:hidden; }
.an3WzG_header{ min-height:76px; padding:10px 28px 0 20px;
                grid-template-columns: auto minmax(0,1fr); display:grid; }
.an3WzG_composerHero{ width: min(calc(var(--dsh-composer-card-max-width) + 2 * var(--dsh-composer-side-clearance)), 100%);
                      align-self:center; gap:8px; padding-bottom:32px; }
.an3WzG_scrollBody{ overflow-y:auto; scrollbar-gutter:stable; }
.an3WzG_widthHandle{ width: min(10px, calc((100% - var(--dsh-chat-content-width)) / 2 - 24px - 24px)); }
```

`data-windows-titlebar` 只被 layout 模块的 CSS 与 JS 读取，客户端插件**没有任何** `setAttribute("data-windows-titlebar")` 调用 → 该属性由 DSH 桌面 shell 注入；独立 HUD 窗口不会有它，因此 `drawer=true`。

## 附录 B：复现命令

```cmd
set "NODE=C:\Users\35263\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
cd /d D:\DeepSeekData\workspace\dsh-hud\artifacts
%NODE% fetch-webui.mjs      :: 拉 index.html + 资产 -> embed-assets\
%NODE% fetch-combos.mjs     :: 拉三个 combo bundle
%NODE% analyze-css.mjs      :: 断点盘点 -> css-analysis.txt
%NODE% analyze-combos.mjs   :: combo 断点 -> combo-analysis.txt
%NODE% math.mjs             :: 列宽复算 -> 上表
%NODE% composer-headers.cjs :: 响应头 + 输入区 CSS
```

> 注意：`fetch-*.mjs` 从 `%LOCALAPPDATA%\dsh-hud\discovery.json` 读 token，token 由 t2 插件每 15s 刷新；若 401 说明 token 过期，重跑即可。
