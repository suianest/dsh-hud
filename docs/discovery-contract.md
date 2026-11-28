# discovery.json / control.json 契约

HUD（Electron 伴生应用）与 `dsh-hud-capsule` 插件之间的两个文件契约。
**改字段类型 = 改协议**，两侧都要同步：应用侧在 `app/src/discovery.js`，插件侧在
`plugin/index.js`（`resolveDiscovery()` / `writeDiscovery()` / `sendControl()`）。

两者默认都在 `%LOCALAPPDATA%\dsh-hud\`（`DSH_HUD_DISCOVERY` / `DSH_HUD_CONTROL` 可覆盖路径），
`ipcDir` 则是 `%LOCALAPPDATA%\dsh-hud\ipc\`（由插件创建并 `icacls /setintegritylevel Low`，
否则 Low IL 的 HUD 写不进去）。

版本号：`protocolVersion` 当前为 **1**，两侧常量分别是 `plugin/index.js` 的
`PROTOCOL_VERSION` 与 `app/src/discovery.js` 的 `PROTOCOL_VERSION`。

---

## 1. discovery.json（插件 → HUD）

插件每 15 s 重写一次；HUD 在启动、恢复轮询（5 s）与 `reload` 时读取。
写入是原子的：临时文件名带 pid + 序号，`fs.rename` 覆盖，避免并发写互相覆盖。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `pid` | `number` | 写文件的 DSH 进程 pid，HUD 用它判断「这条 discovery 是不是活的」 |
| `port` | `number \| null` | DSH Web UI 端口。**0.5.12 起为数字**（`P-15-2`）；旧版插件曾写成字符串 `"50265"`，所以 HUD 侧不要做严格相等比较 |
| `url` | `string` | 带一次性登录 token 的 URL：`http://127.0.0.1:<port>/?token=...`。token 首次加载即被消费（应用侧换 cookie），所以必须每 15 s 刷新 |
| `updatedAt` | `string` | ISO 8601 时间戳；HUD 用它算 `ageMs()` 判断新鲜度 |
| `protocolVersion` | `number` | 协议版本（当前 1）；缺省表示旧版插件 |
| `dshExe` | `string` | DSH 桌面端可执行文件路径（Medium IL 才能取到；HUD 是 Low IL，用它做「打开 DSH 桌面窗口」的兜底） |

不落盘的字段：`origin`（只在插件内存里用于日志/比较；HUD 不要依赖）。

示例：

```json
{
  "pid": 33656,
  "port": 55507,
  "url": "http://127.0.0.1:55507/?token=REDACTED",
  "updatedAt": "2026-11-28T12:10:37.631Z",
  "protocolVersion": 1,
  "dshExe": "D:\\deepseek\\DeepSeek Harness.exe"
}
```

安全：`url` 里的 token 是一次性凭据，日志/截图/issue 里必须打码（应用侧日志统一写 `token=***`）。

---

## 2. control.json（插件 → HUD，单向下发）

插件用 `sendControl(action, data?)` 写：

```json
{ "seq": 1795440185612, "action": "reload", "at": 1795440185612, "data": { } }
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `seq` | `number` | 单调递增（毫秒时间戳），HUD 用它去重 |
| `action` | `string` | 见下表 |
| `at` | `number \| string` | 0.5.12 起统一写 `number`（毫秒）；旧版可能写 ISO 字符串，消费方需兼容 |
| `data` | `object?` | 仅部分动作带 |

动作：

| action | 附带 data | HUD 行为 |
| --- | --- | --- |
| `toggle` | — | 胶囊 ↔ 面板切换 |
| `show` | — | 展开面板 |
| `hide` | — | 收起为胶囊 |
| `reload` | — | 重载内嵌 DSH 视图 |
| `quit` | — | 退出 HUD |
| `plugin-update` | `{ current, latest }` | 面板 `⌘` 显示橙点，命令面板出现「插件有新版本 vX（复制升级命令）」 |

`data` 由 `app/main.js` 的 ControlBridge 透传给 `hud.setPluginUpdate(obj.data)` 等处理函数。

---

## 3. ipc/request.json ↔ ipc/result.json（HUD → 插件，需要 Medium IL 的动作）

HUD 是 Low IL，无法把 DSH 窗口提到前台、也无法改 `Startup`，所以把请求写进
`%LOCALAPPDATA%\dsh-hud\ipc\request.json`，插件每 500 ms 轮询执行后写 `result.json`。

请求示例：

```json
{ "id": "20232-1795524789167", "action": "desktop", "exe": "D:\\deepseek\\DeepSeek Harness.exe", "at": 1795524789167 }
```

- `id`：`<pid>-<毫秒>`，插件按 id 去重（`handledRequestIds`，上限 64）；处理完/过期后插件删除 `request.json`
- `action`：`desktop`（聚焦 DSH 窗口）、`autostart`（写/删登录启动项）
- `at`：毫秒时间戳；TTL 120 s，过期请求只记 `ipc request expired, ignored: …` 并删除
- 结果：`result.json` 形如 `{ "id": "...", "ok": true, "out": "focused 67790 23524 DeepSeek Harness ..." }`

注意：`at` 一律写数字。0.5.11 之前 `autostart` 请求写 ISO 字符串，导致过期判定被绕过、
与另一目录的请求来回「踢皮球」（2026-11-23 弹窗风暴），已在 0.5.10/0.5.12 修掉。

---

## 4. 兼容性规则（改协议前先读）

1. **加字段安全、改类型不安全**：读侧一律做类型容错（`Number(x)` / `Date.parse`），写侧保持文档类型。
2. **删字段**要先让读侧容忍缺省至少一个版本。
3. `protocolVersion` 变化时，两侧行为要能降级（HUD 读到更高版本 → 走错误页提示升级）。
4. 改动必须同时更新：本文件、`app/src/discovery.js` 顶部注释、`plugin/index.js` 的 `PROTOCOL_VERSION`（若语义变了）。
