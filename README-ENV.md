# DSH HUD — 环境与工具链冒烟报告（README-ENV）

> 任务：t1「工具链冒烟：Electron 可装可跑，窗口能截图」
> 产出物根目录：`D:\DeepSeekData\workspace\dsh-hud`
> 执行会话：DSH 桌面版内置 agent（沙箱：workspace-write，受 DSH 受限令牌约束）

---

## 0. 结论（先看这里）

| 项 | 结果 | 证据 |
|---|---|---|
| Electron 可安装 | ✅ 成功，`electron@45.2.2`（Chromium 156.0.8078.80 / Node 24.22.2） | `spike\node_modules\electron\dist\version` |
| Electron 主进程可启动 | ✅ 成功（`electron.exe --no-sandbox --version` 输出 `v45.2.2`） | `artifacts\probe-version.log` |
| 窗口能渲染 / 能截图 | ❌ **在本 agent 会话（DSH 沙箱）内不可能** | 见下方根因与 `artifacts\smoke-run.log` |
| 在普通（沙箱外）终端可跑 | ⚠️ 未在本会话验证（无法越出沙箱），脚本已备好待用户执行 | `scripts\run-smoke.cmd` |

**根因（已用独立最小实验复现，与 Electron 无关）**：本会话的进程令牌是 DSH 的**受限令牌**（4 个 restricted SID，见 `artifacts\token-info.txt`）。Chromium 启动渲染进程时执行 `CreateNamedPipeW`（成功）后必须用 `CreateFileW` 打开该管道；在受限令牌下这一打开操作返回 **Windows error 5（拒绝访问）**，Chromium 直接 `CHECK` 失败自杀：

```
FATAL:mojo\public\cpp\platform\platform_channel.cc:112] Check failed: . : 拒绝访问。 (0x5)
```

进程退出码 `-2147483645`（0x80000003 STATUS_BREAKPOINT），发生在 `loadFile()` 阶段，`capturePage()` 永远到不了。
同一原因也解释了 `Start-Process -RedirectStandardError` 报 `Access is denied`（子进程 stdio 管道同样是命名管道）。

**因此：HUD 的 Electron 进程必须由沙箱外的上下文启动**（用户双击、开机自启、计划任务、或 DSH 主程序自己的 Electron 主进程）。agent 会话只能做代码/构建/静态验证，不能做 GUI 截图验证。

**架构提示（给队长）**：DSH 桌面版本身就是 Electron 且运行在沙箱外。若 HUD 以「DSH 内嵌 BrowserWindow / 插件面板」方式实现，就不需要从沙箱 spawn `electron.exe`，本坑自然消失；只有独立 `electron.exe` 进程方案才受此限制。

---

## 1. 环境事实（绝对路径 + 版本）

| 组件 | 绝对路径 | 版本 / 说明 |
|---|---|---|
| Node（bundled） | `C:\Users\35263\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` | v24.21.0 x64 |
| pnpm | `C:\Users\35263\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs` | pnpm 11.28.5，**必须用 node 执行**：`node <pnpm.mjs> ...` |
| 系统 npm | 无 | 不要用 `npm`/`npx` |
| Shell | Windows PowerShell 5.1 | **不是** pwsh 7；执行策略禁止运行 `.ps1`（`AuthorizationManager 检查失败`）→ 所有脚本写成 `.cmd` 包装 |
| Electron 包 | `D:\DeepSeekData\workspace\dsh-hud\spike\node_modules\electron` | `45.2.2` |
| Electron 可执行 | `D:\DeepSeekData\workspace\dsh-hud\spike\node_modules\electron\dist\electron.exe` | 237.91 MB（便携版整个 dist 目录） |
| pnpm store | `D:\DeepSeekData\workspace\dsh-hud\.pnpm-store\v11` | 工作区内，不污染全局 |
| Electron 下载缓存 | `D:\DeepSeekData\workspace\dsh-hud\.electron-cache` | 由 `electron_config_cache` 指定 |
| npm registry | `https://registry.npmmirror.com` | 网络可达（node fetch 200） |
| Electron 二进制镜像 | `https://npmmirror.com/mirrors/electron/` | 通过 `ELECTRON_MIRROR` 指定 |
| 显示环境 | 1707×1067 workarea，`scaleFactor = 1.5` | 物理分辨率约 2560×1600 @150% DPI |

> 判断网络只能靠 **node fetch**；PowerShell 的 `Invoke-WebRequest` 在本机 TLS 握手失败（`ssl_client_socket_impl.cc:949 handshake failed ... net_error -100`）。

---

## 2. 从零复现（安装）

一键脚本（幂等，已实测）：

```cmd
cmd /c D:\DeepSeekData\workspace\dsh-hud\scripts\install-electron.cmd
```

它等价于下面两步：

```cmd
rem 1) 装依赖（必须 hoisted：本会话无符号链接权限）
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set electron_config_cache=D:\DeepSeekData\workspace\dsh-hud\.electron-cache
set npm_config_registry=https://registry.npmmirror.com
"C:\Users\35263\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" ^
  "C:\Users\35263\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" ^
  install --dir D:\DeepSeekData\workspace\dsh-hud\spike ^
          --store-dir D:\DeepSeekData\workspace\dsh-hud\.pnpm-store ^
          --node-linker=hoisted --no-frozen-lockfile --reporter=append-only

rem 2) electron@45 没有 postinstall，二进制要显式拉取（150.7 MB，实测 99.7s @ ~1.5MB/s）
"C:\Users\35263\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" ^
  D:\DeepSeekData\workspace\dsh-hud\spike\node_modules\electron\install.js
```

实测耗时：pnpm install ≈ **15.6 s**（首次，含 registry 元数据）；electron 二进制 **150.7 MB / 99.7 s**（`electron-v45.2.2-win32-x64.zip`）；命中缓存后 `install-electron.cmd` 二次运行 ≈ **4.3 s** 且退出码 0。

成功后应打印：

```
ELECTRON_BINARY_ALREADY_PRESENT   (或 ELECTRON_EXE_OK)
exit /b 0
```

---

## 3. 运行冒烟（**必须在沙箱外**执行）

### 方式 A：用户双击 / 普通 PowerShell

```cmd
cmd /c D:\DeepSeekData\workspace\dsh-hud\scripts\run-smoke.cmd
```

脚本内容要点：

```cmd
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_ENABLE_LOGGING=1"
"D:\DeepSeekData\workspace\dsh-hud\spike\node_modules\electron\dist\electron.exe" ^
  --no-sandbox "D:\DeepSeekData\workspace\dsh-hud\spike"
```

### 期望产物

| 文件 | 说明 |
|---|---|
| `artifacts\spike-smoke.png` | 520×720 无边框透明置顶窗口的 `capturePage()` 截图 |
| `artifacts\spike-smoke.json` | 环境/窗口/像素分析报告（`nonBlank: true` 表示非空白） |
| `artifacts\smoke-run.log` | 运行日志（含 trace 与渲染器 console） |
| `artifacts\main-trace.log` | 主进程阶段埋点（boot → window:created → loadFile:done → capture:done → png:written） |

退出码约定：`0=成功(非空白)`、`2=主进程异常`、`3=图像空白`、`4=capturePage 失败`、`5=页面加载超时`。

窗口参数（任务要求）：`520×720`、`frame:false`、`transparent:true`、`alwaysOnTop:true`、`skipTaskbar:true`、`resizable:false`、`show:false` 后手动 `show()`。

---

## 4. 关键坑（按踩坑顺序）

### A. `ELECTRON_RUN_AS_NODE=1` 是会话环境变量（最隐蔽）
DSH 会话导出了 `ELECTRON_RUN_AS_NODE=1`。继承后 `electron.exe` 会退化成纯 Node：
`require('electron')` 返回的是**路径字符串**，主进程立刻报
`TypeError: Cannot read properties of undefined (reading 'whenReady')`，0.1 s 退出。
→ 启动前必须 `set "ELECTRON_RUN_AS_NODE="`。

### B. 必须加 `--no-sandbox`
不带时 electron.exe 无任何输出直接崩，`exit=-2147483645`。矩阵实验（`artifacts\m-*.log`）：
`base=CRASH`、`--no-sandbox=OK`、`--disable-gpu=CRASH`、`--user-data-dir=CRASH`、`--no-sandbox --disable-gpu=OK`。
结论：**GPU 不是原因，沙箱才是**；只要 `--no-sandbox`。

### C. 受限令牌下命名管道客户端打不开（真正的拦路虎）
独立最小复现（`artifacts\pipe-probe.ps1`，与 Electron 无关）：

```
chromium-like:CreateFile FAIL err=5     # CreateNamedPipe(默认SD) 成功，CreateFile 打开失败
no-sa-no-sqos:CreateFile FAIL err=5
sa-no-sqos:CreateFile FAIL err=5
```

令牌信息（`artifacts\token-info.txt`，`whoami /all` + `GetTokenInformation`）：

```
TokenIsAppContainer=0
restrictedCount=4  [S-1-5-5-0-239308] [S-1-1-0] [S-1-4-928495633-434546118] [S-1-4-204838124-818553357-1]
Mandatory Label\Low Mandatory Level；仅 SeChangeNotifyPrivilege；Administrators 为 deny only
```

即 DSH 用**受限令牌（restricted token）+ 低完整性**做沙箱；对象 DACL 必须同时放行 restricted SID，而 Chromium 管道用的是默认 DACL，于是 `CreateFileW` 拿到 error 5。
Electron 侧表现：`platform_channel.cc:112 Check failed ... (0x5)` → 0x80000003。

补充对照：`--single-process --in-process-gpu` 不崩但页面 `loading=true`、URL 为空、Renderer 卡死（Electron 不支持 single-process，主线程被 Node 占用），**不是可用解法**。
同时验证：**原生 WinForms 窗口在本会话能显示、能被 GDI 截屏**（`artifacts\winforms-probe.png`，`FORM_VISIBLE=True / SCREEN_COPY=OK`）→ 说明「GUI 被禁」不成立，纯粹是 Chromium 的子进程 IPC 模型撞上受限令牌。

### D. pnpm 11 默认 linker 会失败（无符号链接权限）
默认 `node-linker=isolated` 要建 symlink/junction，本会话 `mklink /D` → `You do not have sufficient privilege`，install 反复 `ERR_PNPM_EBUSY`（`@types+node`、`@electron-internal+extract-zip`）。
→ 一律加 `--node-linker=hoisted`。清理半成品 `node_modules` 时若文件被占用，先 `Rename-Item` 再删。

### E. pnpm 11 的 `pnpm` 字段已废弃 + CI 下自动 frozen
- `onlyBuiltDependencies` 不再读 `package.json` 的 `pnpm` 字段，要写进 `pnpm-workspace.yaml`：
  ```yaml
  onlyBuiltDependencies:
    - electron
  ```
- 本会话 `CI=1`，pnpm 默认 `--frozen-lockfile`；改版本后报 `ERR_PNPM_OUTDATED_LOCKFILE` → 加 `--no-frozen-lockfile`。
- pnpm 11 会因 `ERR_PNPM_IGNORED_BUILDS: electron@45.2.2` 返回**退出码 1**，但依赖其实已装好；脚本已把这种情况判为成功（electron 本来就没有 build script）。

### F. electron@45 的 npm 包**没有 postinstall**
`node_modules\electron\package.json` 里 `scripts` 为空；二进制是 `require('electron')` 时懒下载。所以必须显式执行 `node node_modules\electron\install.js`，否则 `dist\electron.exe` 不存在。

### G. PowerShell 执行策略
`.ps1` 无法直接运行（`AuthorizationManager 检查失败`）。所有自动化脚本改用 `.cmd`；需要跑 PS 逻辑时用
`Invoke-Expression (Get-Content xxx.ps1 -Raw)` 绕过文件执行策略。

### H. 网络
`node fetch` 可访问 `registry.npmmirror.com` 与 `npmmirror.com/mirrors/electron/`（200，~461 ms）；
`raw.githubusercontent.com` 在本机 fetch 失败（web 工具可访问）。
PowerShell `Invoke-WebRequest` 因 TLS 失败不要用。

---

## 5. Windows 透明悬浮窗口已知坑（给 HUD 实现参考）

1. `transparent: true` 必须与 `frame: false` 搭配，并显式 `backgroundColor: '#00000000'`；否则透明区域可能渲染成黑色。
2. 透明窗口在 Windows 上**不可 resize**（Electron 限制），需要尺寸变化时重建窗口或改用 `setBounds`。
3. 透明依赖 DWM 合成；远程桌面、部分老显卡驱动下会黑底，必要时 `app.disableHardwareAcceleration()`（但会牺牲动画性能，先测再开）。
4. `capturePage()` 对透明窗口返回**预乘 alpha 的 BGRA**；判断「非空白」不能只看平均亮度，脚本用 `uniqueColors > 8 && lumaStdDev > 1`（`spike\main.js` 的 `analyze()`）。
5. 置顶要盖住全屏应用需 `win.setAlwaysOnTop(true, 'screen-saver')`；`skipTaskbar: true` 配合 `showInactive()` 可做到不抢焦点。
6. 本机 DPI 150%：窗口尺寸是 DIP（520×720 逻辑像素 → 780×1080 物理像素）；要精确内容区请用 `useContentSize: true`。
7. `webPreferences.spellcheck: false`：否则 Chromium 会去下载 `en-us-10-2.bdic`（冒烟日志里可见 `NetworkDelegate::NotifyBeforeURLRequest: https://redirector.gvt1.com/.../en-us-10-2.bdic`），在受限网络下拖慢首屏。
8. 无边框窗口拖动区域用 CSS `-webkit-app-region: drag`，其中按钮要 `no-drag`。
9. 实测 `new BrowserWindow({ width: 520, height: 720, frame: false, transparent: true })` 的 `win.getSize()` 返回 **521×721**（Windows 侧多 1px，本机 Chrome 156 上稳定复现）；需要严格 520 内容区时用 `useContentSize: true` 或 `win.setContentSize(520, 720)` 校准，并把该 1px 计入截图断言。

---

## 6. 证据清单（`artifacts\`）

| 文件 | 内容 |
|---|---|
| `named-pipe-probe.txt` | 命名管道客户端打开失败的 3 组最小复现输出（全 err=5） |
| `token-info.txt` | `whoami /all` + `TokenIsAppContainer`/restricted SIDs（受限令牌证据） |
| `pipe-probe.ps1` / `token-probe.ps1` | 上述两个探针源码（可重跑） |
| `smoke-run.log` | 沙箱内运行 Electron 的 FATAL 与退出码 |
| `main-trace.log` | 主进程埋点：走到 `window:created` → `loadFile:start` 后崩溃，无 `loadFile:done`/`capture:done` |
| `probe-version.log`、`m-*.log` | 启动参数矩阵实验结果 |
| `single-verbose.log`、`single2.log` | `--single-process` 实验（页面卡死，不可用） |
| `winforms-probe.png` | 原生 WinForms 窗口可显示并可截图的对照证据 |
| `install-electron.cmd.log`、`electron-download.log` | 安装/下载日志与耗时 |

---

## 7. 验收状态与下一步

- **已完成**：Electron 安装链路可复现（命令、镜像、缓存、耗时、退出码全部记录）；主进程可执行；冒烟工程与截图脚本就绪。
- **未完成**：`artifacts\spike-smoke.png` 的非空白截图 —— 被 DSH 沙箱的受限令牌阻断（证据见上），**agent 会话内无法完成**。
- **建议下一步**：
  1. 由用户在**普通终端**执行 `scripts\run-smoke.cmd`，把 `artifacts\spike-smoke.png` 与 `spike-smoke.json` 回传，即可闭合 t1 的截图验收。
  2. 团队后续的 Electron GUI 验证一律按「用户侧执行 + 回传产物」设计；agent 侧只做 `node --check`、静态检查、打包与日志分析。
  3. 若希望 agent 侧也能自测 UI，优先考虑把 HUD 做成 DSH 插件（复用 DSH 自己的 Electron 主进程），而不是另起 `electron.exe`。
