# DSH HUD 插件 ↔ 悬浮窗集成（t7）

在 t2 token 桥之上，让 Host 插件负责**发现、（可选）拉起、通知、命令与生命周期**，把 DSH 与 Electron 悬浮窗缝合成一个整体。拉起 HUD 现在是**默认关闭的可选项**（`spawnApp: false`），默认路径是「HUD 自行启动（登录项/用户双击）」，插件只负责 discovery token 与 `/dsh-hud` 命令。

## 确切 API（经 cordis_inspect_query host Service.listService 确认）

| 用途 | 真实方法 |
| --- | --- |
| 取带 token 的 Web URL | `connection.authenticatedUrl(webApp.getAdvertisedUrl())`，兜底 `webServer.getOrigin()` |
| 拉起 app | `subprocess.spawn(spec: SubprocessSpawnSpec): SubprocessHandle`（同步返回 live handle） |
| 注册命令 | `commands.register(definition: CommandDefinition): () => void`（返回卸载器） |

`SubprocessSpawnSpec` / `SubprocessHandle`（引用类型原文）：

```ts
interface SubprocessSpawnSpec {
  argv: readonly string[];
  cwd: string;
  stdio: SubprocessStdio;          // { stdin, stdout, stderr, control? }
  graceMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}
interface SubprocessHandle {
  readonly stdin: Writable | undefined;
  readonly stdout: Readable | undefined;
  readonly stderr: Readable | undefined;
  readonly control: Duplex | undefined;
  readonly done: Promise<SubprocessOutcome>;  // { exitCode, signal }
  terminate(): void;
  waitForExit(signal?): Promise<boolean>;
}
```

## 插件行为

1. **发现（t2）**：启动即写 `%LOCALAPPDATA%\dsh-hud\discovery.json`，`{pid,port,url,updatedAt}`，每 15s 刷新（token 一次性，须保鲜）。
2. **拉起（两条路径，均已默认关闭）**：
   - `spawnApp`（默认 `false`）：`subprocess.spawn` 启动 `node.exe <launch-hud.cjs>`（`cwd=<appDir>`），launcher 用清理后的环境拉起 `electron.exe --no-sandbox <appDir>`。
   - `shellLaunch`（默认 `false`）：写 `<udd>/launch-hud.cmd` 后交给 `explorer.exe`，由 Explorer 在交互上下文里执行。实测会弹出 Windows 的**人工允许**提示，每次都需要用户点确认，因此默认不启用。
   - **为什么默认不直接 spawn**：Host 进程本身是 Medium 完整性（能写 `%LOCALAPPDATA%`，Low 的工具 shell 不能），但它的 Electron 子进程创建 crashpad/mojo 命名管道失败（`crashpad_client_win.cc:867 not connected`，退出码 `0xFFFF7003`）；同一台机器上由用户 shell 启动 Electron 则正常。故默认路径是「HUD 自行启动（登录 Startup 项 / 双击 / 托盘菜单）」。
   - **关键环境变量**：注入 `DSH_HUD_ELECTRON`、`DSH_HUD_APP_DIR`、`DSH_HUD_DISCOVERY`，并删除 `ELECTRON_RUN_AS_NODE`（DSH 导出为 `1`；`node.exe` 自身忽略该变量，由 `launch-hud.cjs` 清理后重新拉起 Electron）。
   - **skip 日志**：`spawnApp=false` 时若有路径尝试拉起，记 `skip spawn: spawnApp is disabled (HUD self-starts via login item / double-click)`；`subprocess` 服务缺失时记 `subprocess service unavailable; skipping spawn`（不再误报 `spawn failed`，D5）。
3. **重连**：监听 `handle.done`；子进程异常退出且插件未注销时，按线性退避（3s×N，上限 5 次）重新 spawn。重拉计数**只在子进程稳定运行 ≥30s 后重置**（D1），连续崩溃达到 `maxRespawns` 后停止并记 `respawn limit reached; giving up auto-restart`。
4. **通知重载**：同一 DSH 进程内若 Web UI 的 origin（scheme://host:port）变化（如 webServer 换端口），写 `control.json` 并向子进程 stdin 发送 `reload`。token 每 15s 变化**不**触发 reload（避免每 15s 打断面板）。
5. **命令**：`/dsh-hud [toggle|show|hide|reload]`，默认 toggle；仅在 `spawnApp=true` 时先 `ensureRunning()`，否则只写 `control.json`（自启动的 HUD 通过文件监听响应）。
6. **生命周期**：DSH 注销（dispose）→ `abort()` + `child.terminate()` + 删除 discovery.json / control.json + 卸载命令。DSH 退出时子进程被终止，**无残留进程**。

## 通知契约（浮窗侧需消费其一或两者）

### 方式 A：`control.json`（文件监听，推荐）

`%LOCALAPPDATA%\dsh-hud\control.json`，原子替换，仅在真实事件时更新。写入用**唯一临时文件名**（`control.json.<pid>.<seq>.tmp`）再 `rename`，并发写不再因共享 tmp 而 ENOENT（D2）：

```json
{ "seq": 3, "action": "reload", "at": "2026-11-06T05:30:00.000Z" }
```

`action ∈ reload | show | hide | toggle`，`seq` 单调递增。浮窗 `fs.watch` 该文件即可，不需要任何 stdin 解析。

### 方式 B：子进程 stdin（管道）

插件以 `stdio.stdin: 'pipe'` 拉起，子进程 stdin 收到换行分隔 JSON：

```
{"type":"reload","seq":3}
{"type":"toggle","seq":4}
```

`type ∈ reload | show | hide | toggle`。

## 浮窗侧集成钩子（待 app 侧落地，不在本次 plugin 内）

> 以下为「集成契约」的参考实现，需由 app（t4/t5/t6 产物 `dsh-hud/app/`）侧接线；本次仅交付插件与契约，未改 app 文件。

```js
// app/main.js 追加（约 12 行，additive）：
const fs = require('fs');
const CONTROL = process.env.DSH_HUD_CONTROL
  || require('./src/discovery').discoveryPath().replace(/discovery\.json$/, 'control.json');
function applyControl(msg) {
  const a = msg && msg.action || msg && msg.type;
  if (a === 'reload') { hud && hud.reloadWeb(); }
  else if (a === 'show') { hud && hud.showPanel(); }
  else if (a === 'hide') { hud && hud.showCapsule(); }
  else if (a === 'toggle') { hud && hud.toggle(); }
}
let lastSeq = 0;
try {
  fs.watch(require('path').dirname(CONTROL), (_e, name) => {
    if (name !== 'control.json') return;
    try {
      const m = JSON.parse(fs.readFileSync(CONTROL, 'utf8'));
      if (m && m.seq > lastSeq) { lastSeq = m.seq; applyControl(m); }
    } catch {}
  });
} catch {}
```

要点：
- 插件会删除 `discovery.json` 与 `control.json`；浮窗读到文件缺失即进入错误页 / 隐藏。
- `reloadWeb()` 需重新走 t6 的「token URL 铸 cookie → 切 clean URL」流程（t6 `WebEmbed`）。
- `show`/`hide`/`toggle` 对应 t5 `HudWindow` 的 `showPanel` / `showCapsule` / `toggle`。

## 配置项（优先级：row `config` → `DSH_HUD_*` 环境变量 → `config.local.json` → 默认值）

| key | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `spawnApp` | `DSH_HUD_SPAWN_APP` | `false` | 直接子进程拉起 HUD（在本机会崩，仅供排查） |
| `shellLaunch` | `DSH_HUD_SHELL_LAUNCH` | `false` | 交给 Explorer 执行 `launch-hud.cmd`；会弹人工允许提示，默认关闭 |
| `electronPath` | `DSH_HUD_ELECTRON` | `<repo>/runtime/node_modules/electron/dist/electron.exe` | electron.exe 路径（仅 spawnApp=true） |
| `nodePath` | `DSH_HUD_NODE` | `process.execPath`（宿主即 Node） | 运行 launcher 的 node（仅 spawnApp=true） |
| `launcherPath` | `DSH_HUD_LAUNCHER` | `<repo>/app/scripts/launch-hud.cjs` | 清理环境后拉起 Electron 的 launcher |
| `appDir` | `DSH_HUD_APP_DIR` | `<repo>/app` | HUD app 目录（含 main.js） |
| `dshExe` | `DSH_HUD_DSH_EXE` | `D:\deepseek\DeepSeek Harness.exe` | DSH 桌面 exe（桌面置前/ipc 启动用） |
| `refreshMs` | — | `15000` | discovery 刷新周期 |
| `respawnDelayMs` | — | `3000` | 重连退避基数 |
| `maxRespawns` | — | `5` | 连续重连上限 |

> `config.local.json` 位于仓库根（`<repo>/config.local.json`，gitignore，与 app 侧同名字段），
> 支持 `electronPath`/`nodePath`/`appDir`/`launcherPath`/`dshExe`/`spawnApp`/`shellLaunch`；env 优先于文件。
> 所有「文件不存在」的路径降级为 skip + 一行日志，不抛异常。
## 验收（待 Full access 安装后执行）

1. 安装 bundle 后，`%LOCALAPPDATA%\dsh-hud\discovery.json` 出现且 `url` 含 `?token=`；用 node fetch 验证该 url 返回 200 而非 401。
2. （配置 `spawnApp: true` 后）浮窗进程被拉起（`node.exe launch-hud.cjs` → `electron.exe --no-sandbox ...app`）；`/dsh-hud` 命令可切换打开/隐藏。
3. 改 DSH webServer 端口（或重启 DSH）后 `control.json` `seq` 递增、浮窗重载到新 origin。
4. 退出 DSH / 卸载 bundle 后，浮窗进程消失、`discovery.json`/`control.json` 被删除。

## Desktop focus bridge (Low-IL HUD -> Medium-IL host)

The HUD is started from a user shell, so it runs at Low Mandatory Level. UIPI
silently drops `ShowWindow`/`SetForegroundWindow` aimed at the Medium-IL DSH
window: the helper still exits 0 and prints `focused <hwnd> <pid>`, but the
foreground window never changes (verified: `ShowWindow(SW_MINIMIZE)` was a no-op
and `SetForegroundWindow` returned `nofocus`).

The Cordis host process is Medium, so the desktop action is delegated to it:

1. HUD writes `<appDir>/../artifacts/ipc/request.json`
   `{ id, action: "desktop", exe, at }` (atomic tmp + rename).
2. The plugin polls that file every 500 ms (dedupes by `id`), spawns the DSH
   desktop exe itself (Medium token, so the single-instance hand-off works),
   waits ~900 ms, then runs `app/scripts/focus-dsh.ps1` from the host.
3. The plugin writes `ipc/result.json` `{ id, ok, out, at }`; the HUD polls it
   for up to 6 s and shows a tray notification with the target window title.
4. If no result arrives (plugin disabled), the HUD falls back to the old local
   launch + local helper, which cannot raise the window but still surfaces a
   notification.

Override the directory with `DSH_HUD_IPC_DIR` on both sides when the app and
plugin live in different roots.

## Why the bridge exists: UIPI

The HUD's Electron process runs at **Low integrity** (DSH sandbox); the desktop
app runs at **Medium**. Windows UIPI silently drops window operations from a
lower-integrity process against a higher-integrity window:

| call (from Low, target Medium) | result |
| --- | --- |
| `ShowWindow(SW_MINIMIZE)` | returns "ok", window does not move |
| `SetForegroundWindow` | returns true, `GetForegroundWindow()` unchanged |
| `SetWindowPos(HWND_TOP)` | returns **false** (access denied) |

That is why every "local" attempt logged `focused <hwnd>` while nothing
happened: the target was already foreground, so the verification passed. The
Cordis host process itself is Medium (it writes `%LOCALAPPDATA%\dsh-hud\`), so
it is the only side that can actually raise the window.

## Finding the window (no hardcoded handles)

`focus-dsh.ps1` re-enumerates top-level windows on every call. Identity order:

1. `-ExePath <install>\DeepSeek Harness.exe` → match the window's owning
   **process image** via `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` +
   `QueryFullProcessImageNameW`. Stable across restarts and session renames.
   Among matches, the **largest** visible window without an owner (GW_OWNER)
   wins, so splash/tool windows are skipped.
2. Title ends with `— DeepSeek Harness` (excludes `DSH HUD`, Explorer windows,
   editors that merely contain the name).
3. Title contains `DeepSeek Harness` (last resort).

A window handle (`132596` in logs) is only a diagnostic value: it changes on
every app restart and is never stored in config.

## Success semantics

`SetForegroundWindow` can be refused even from Medium (the host process did not
receive the click). The script therefore raises the window to `HWND_TOPMOST`
for 380 ms and drops the flag; a successful raise counts as success, because
that is the visible effect the user asked for. Verification uses 3 retries at
200 ms before falling back to `SwitchToThisWindow` and an `AttachThreadInput`
hand-off.

### Autostart (`action: "autostart"`)

The HUD runs at Low Mandatory Level and **cannot** write
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` (probed: EPERM),
so the menu checkbox persists the choice to
`<app>/../artifacts/udd-hud/autostart.json` and posts

```json
{ "id": "autostart-1720000000000", "action": "autostart", "enabled": true, "at": "..." }
```

The host (Medium) writes or removes `Startup\dsh-hud.cmd`:

```bat
@echo off
set "ELECTRON_RUN_AS_NODE="
start "" "<electron.exe>" --no-sandbox --user-data-dir="<repo>\artifacts\udd-hud" "<app>"
```

On every apply the plugin also reconciles `autostart.json` → Startup file, so a
missing script heals itself after a DSH restart.

**Why not spawn the HUD from the plugin?** A `subprocess.spawn` child of the host
cannot initialise Chromium (crashpad `not connected`, exit `0x80000003` /
`0xFFFF7003`). Explorer, at logon, is the only context in this setup that can
start Electron — hence the logon script instead of `spawnApp`.
