# DSH HUD — control-bridge（控制桥）与单实例重拉去抖（t11）

本文档说明 app 侧如何被外部（Cordis 插件）驱动，以及 D4 单实例去抖与真机取证开关。实现位置：`app/src/control.js`、`app/src/discovery.js`（`controlPath()`）、`app/src/hud-window.js`（`focusIfVisible()` / `reloadWeb()`）、`app/main.js`。

## 1. 控制通道（D3）

两个**等价**通道，统一收敛到同一套 `{seq, action, at}` 去重逻辑：

| 通道 | 位置 | 触发方式 |
|------|------|----------|
| control.json | 与 `discovery.json` 同目录（默认 `%LOCALAPPDATA%\dsh-hud\control.json`） | `fs.watch` 该目录 + 2s 轮询兜底 |
| stdin | 进程标准输入 | newline 分隔的 JSON 行 |

### 1.1 control.json 格式

```json
{ "seq": 3, "action": "show", "at": "2026-11-06T06:00:00.000Z" }
```

- `seq`：单调递增序号（数值），用于跨通道去重与跨重启去重。
- `action`：`toggle` | `show` | `hide` | `reload`。
- `at`：ISO 时间戳（仅作记录，逻辑不依赖）。

插件按 discovery.json 同款方式原子写（`tmp` + `rename`）。

### 1.2 action 语义（app 侧映射）

| action | app 行为 |
|--------|----------|
| `toggle` | `hud.toggle()`（胶囊 ↔ 面板） |
| `show` | `hud.showPanel()`（展开面板） |
| `hide` | `hud.showCapsule()`（收起为胶囊） |
| `reload` | `hud.reloadWeb()`（重读 discovery + 重铸 cookie） |

### 1.3 去重

- 单次运行内：`seq <= 已见最大值` 直接丢弃（去重 `fs.watch` 多次触发 + 轮询 + stdin 三路重复）。
- 跨重启：已见最大 `seq` 持久化到 `userData/control-state.json`（`{lastSeq:N}`）。重启后首次读到旧 `control.json` 不会重放。

## 2. reloadWeb（D3）

`hud.reloadWeb()` → `WebEmbed.reload({ forceToken: true })`：

1. 重新 `readDiscovery()`（读最新 `discovery.json`）。
2. 用新鲜 `tokenUrl` 加载 → DSH 服务端 `303` + `Set-Cookie dsh-auth-*` 重铸 cookie 并跳回 clean URL。
3. 此后按 cookie 鉴权（`bootstrapped=true`）。
4. 失败路径：`did-fail-load` → 自绘错误页（unreachable）；HTTP 401 时若 discovery 新鲜（<60s）则回退一次 token，否则停在自绘错误页（auth）。

## 3. 单实例重拉去抖（D4）

`app/main.js` 的 `second-instance` 处理器改为：

- 仅调用 `hud.focusIfVisible()`：窗口可见 → 聚焦（面板态还聚焦内嵌 Web UI）；不可见 → **不弹面板**。
- `showPanel()` 增加重拉守卫：面板已展开且可见时，重复 `showPanel()` 只聚焦，不重排/不重挂载 `WebContentsView`。

实际 `show/toggle` 由 `control.json` 的 `seq` 去重后驱动，避免「插件 re-launch + control.json」双重触发导致的连续 `showPanel`。

## 4. 真机取证开关（DSH_HUD_CAPTURE）

仅在显式设置 `DSH_HUD_CAPTURE=<png 路径>` 时激活；**不设置则默认行为完全不变**。

流程：

1. 启动后直接展开面板。
2. 内嵌 Web UI 首次 `did-finish-load` 后延迟 1.5s（等渲染稳定），抓两张：
   - `<path>.png` —— shell 面板态（面板卡片/顶栏）。
   - `<path>.web.png` —— 内嵌 DSH Web UI。
3. 切回胶囊态，等 600ms 抓一张 `<path>.capsule.png`。
4. `app.quit()` 退出。

兜底：若 8s 内 Web UI 未加载完成（discovery 缺失/错误页），仍按时抓取。

> 说明：`capturePage()` 分别抓 shell 的 `webContents` 与 `WebContentsView` 的 `webContents`（两者是独立合成层，无法单次合成）。取证时三张图对照即可判断胶囊态/面板态/内嵌内容。

## 5. 手动验证（沙箱外）

> 守 t1 约束：agent 会话内禁启 electron.exe，以下命令在**用户侧普通终端**执行。

```bat
cd /d D:\DeepSeekData\workspace\dsh-hud
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_ENABLE_LOGGING=1"
"spike\node_modules\electron\dist\electron.exe" --no-sandbox app
```

**D3 — control.json：**

```bat
echo {"seq":1,"action":"show","at":"2026-11-06T06:00:00Z"}> %LOCALAPPDATA%\dsh-hud\control.json
```

预期：面板展开。再写 `{"seq":2,"action":"hide",...}` → 收起为胶囊；`{"seq":3,"action":"reload",...}` → 内嵌 UI 用新 token 重载；重复写 `seq:1` 应**不**再触发（去重）。

**D3 — stdin（等价通道）：**

```bat
echo {"seq":4,"action":"toggle","at":"2026-11-06T06:00:00Z"} | "spike\node_modules\electron\dist\electron.exe" --no-sandbox app
```

预期：胶囊 ↔ 面板切换（与 control.json 同 seq 空间去重）。

**D4 — second-instance：**

先启动一个实例，再启动第二个实例（不写 control.json）。预期：第二个实例退出，第一个实例**仅被聚焦**、**不**弹面板。

**DSH_HUD_CAPTURE：**

```bat
set "DSH_HUD_CAPTURE=D:\DeepSeekData\workspace\dsh-hud\shots\hud.png"
"spike\node_modules\electron\dist\electron.exe" --no-sandbox app
```

预期：进程退出后 `shots\hud.png`、`shots\hud.web.png`、`shots\hud.capsule.png` 三张图存在。

**语法自检（沙箱内可跑）：**

```bat
cmd /c D:\DeepSeekData\workspace\dsh-hud\app\scripts\check-hud.cmd
```

## 6. 环境变量

| 变量 | 作用 |
|------|------|
| `DSH_HUD_DISCOVERY` | 覆盖 discovery.json 路径（control.json 随其目录联动） |
| `DSH_HUD_CONTROL` | 覆盖 control.json 路径（dev/test） |
| `DSH_HUD_CAPTURE` | 真机取证截图路径（默认关闭） |
| `DSH_HUD_USER_DATA` | 覆盖 Electron userData 目录 |
| `DSH_HUD_DEV` | `1` 放行 devtools |
