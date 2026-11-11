# DSH HUD token 桥（token bridge）

为 Windows 常驻悬浮胶囊 + 520px 紧凑面板提供「发现与拉起」所必需的带 token 的 DSH Web URL。

## 产物

| 路径 | 说明 |
| --- | --- |
| `plugin/` | 最小 Cordis Host 插件 bundle（`@dsh-hud/token-bridge`） |
| `plugin/index.js` | Host 插件入口：取 URL、写发现文件、注销时删除 |
| `plugin/package.json` | bundle 清单，`dsh.bundle.patch` 指向 `cordis.patch.yml` |
| `plugin/cordis.patch.yml` | 插入插件行 `dsh-hud-token-bridge` |
| `plugin/locale/{en,zh}.json` | 插件清单展示元数据 |
| `plugin/icon.svg` | 插件图标 |

## 取 token 的确切 API

通过 `cordis_inspect_query`（host `Service.listService`）确认的真实方法：

```
baseUrl = ctx.webApp.getAdvertisedUrl()      // 配置的 publicUrl，否则监听 origin
url     = ctx.connection.authenticatedUrl(baseUrl)  // 在 baseUrl 上追加一次性进程登录 token
```

关键签名（来自 Host 运行时目录，非猜测）：

- `webApp.getAdvertisedUrl(): string`
  - 返回配置的 `publicUrl`，否则返回监听器 origin；也用于 `DSH_WEB_URL` 与启动 URL 行。
- `connection.authenticatedUrl(baseUrl: string): string`
  - 「Add the fresh process token to an ordinary Web application URL.」
  - 返回用于初始登录的 token 化 URL；挂载代理会先剥离前缀再交给 `authorizeIndex`。
- `webServer.getOrigin(): string`
  - 返回本地客户端访问监听器所用的根 URL，形如 `http://127.0.0.1:3080`；作为兜底 base URL。

## token 的来源与生命周期

token 由 Host 的 `connection` 服务铸造，属于「进程 token」，特点是：

1. **一次性**：`connection.authenticatedUrl()` 每次调用都会铸造一个全新的 token（文档措辞 `fresh process token`）。
2. **入口消费**：前端首次加载该 URL 时，`connection.authorizeIndex(request, response)` 校验 token，成功后铸造认证 cookie（`Secure` 取决于监听器是否 TLS）并重定向；失败返回 401。相关方法还有 `deepseekAccount.resolveToken(url)` / `rejectToken(token)`（resolve 后 reject 是一次性令牌的典型模式）。
3. **持久凭据是 cookie**：token 只用于「初始登录」，登录后浏览器/Electron 会话持有 cookie，后续请求不再需要 token。

因此插件**每 15 秒刷新一次** `discovery.json`，保证桌面胶囊在任意时刻读取到的都是尚未被消费的新鲜 token。若胶囊只在启动时读取一次，也始终有效。

## discovery.json 约定

路径：`%LOCALAPPDATA%\dsh-hud\discovery.json`（典型 `C:\Users\<user>\AppData\Local\dsh-hud\discovery.json`）。

```json
{
  "pid": 12345,
  "port": "50265",
  "url": "http://127.0.0.1:50265/?token=...",
  "updatedAt": "2026-11-05T00:36:55.000Z"
}
```

- `pid`：DSH Host 进程 id（`process.pid`）。
- `port`：从 URL 解析出的端口字符串；无端口时按协议补 80/443。
- `url`：带 token 的完整登录 URL。
- `updatedAt`：ISO 8601 时间戳。

写入采用「临时文件 + `rename`」的原子替换，避免读者读到半截 JSON。插件注销（dispose）时删除 `discovery.json`。

## 兜底策略

若服务层拿不到 token（`ctx.get('connection')` 为 undefined，或 `authenticatedUrl` 不存在）：

1. 先退化为裸 `baseUrl`（`webApp.getAdvertisedUrl()` → `webServer.getOrigin()`），仍写入 discovery.json 供胶囊定位服务。
2. 裸 URL 加载时会被 `authorizeIndex` 挡下返回 401 —— 见下方验证：当前运行时裸 URL 实测返回 401。
3. 可行的替代：由 Electron 胶囊在拿到 401 时触发一次「打开 DSH 桌面端 / 提示登录」，或在 DSH 侧开启不校验的本地信任来源。但正常桌面运行时 `connection` 服务始终随 web 前端存在，故主路径即可满足，兜底仅作防御。

## 验证

**URL 有效性基线（已实测，用 node fetch，非 Invoke-WebRequest）：**

```
node -e "fetch('http://127.0.0.1:50265',{redirect:'manual'}).then(r=>console.log(r.status))"
# => 401  （无 token 裸 URL，证明 token 必需）
```

**安装后完整验收（待执行，见下）：**

1. `plugin_manager` `install_bundle` 安装 `D:\DeepSeekData\workspace\dsh-hud\plugin`。
2. 确认 `%LOCALAPPDATA%\dsh-hud\discovery.json` 出现且 `url` 含 `?token=`。
3. 用 node fetch 验证该 `url` 返回 200 而非 401：

```powershell
$node = "C:\Users\35263\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node -e "fetch(process.argv[1],{redirect:'follow'}).then(r=>console.log(r.status))" "<url-from-discovery.json>"
```

> 注意：node fetch（undici）不自动持久化 cookie，token 被消费后紧跟的裸 URL 重定向可能仍返回 401；Electron 会话会持久化 cookie，因此以真实面板加载为准。验证时若需确认 token 本身有效，可在同一 fetch 上下文内携带 Set-Cookie 重放，或直接观察 302→200 且无 401。

## 手动安装（bundle 交付）

本会话为受限子代理，`plugin_manager` 需要 `danger-full-access`，已被自动拒绝，故**未安装验证**。安装方式二选一：

- 在具备 Full access 的会话里对队长执行：`plugin_manager install_bundle`，`target` = `D:\DeepSeekData\workspace\dsh-hud\plugin`。
- 或由用户在 Harness Web UI 的插件管理里添加本地 bundle 目录 `D:\DeepSeekData\workspace\dsh-hud\plugin`。
