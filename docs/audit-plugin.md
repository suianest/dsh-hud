# 插件侧全流程审计（t40）

> 审计对象：`plugin/index.js`（1347 行）、`plugin/package.json`、根 `package.json`、根 `cordis.patch.yml`、`plugin/cordis.patch.yml`
> 对照文档：`docs/install-via-npm.md`、`docs/plugin-app-bridge.md`、`README.md`、`docs/release.md`
> 方式：只读逐行审计 + 运行日志对照（`%TEMP%\dsh-hud-plugin-diag.log`，1798 行，2026-11-16）+ `node --check plugin/index.js`（exit 0）
> 边界：**未修改 `app/`、`plugin/` 任何代码**；涉及 app 侧的行号仅用于证明两端契约，不重复 t13/t20 的 app 审计。
> 真实 Electron 渲染在本会话仍不可用（受限令牌，见 `docs/environment.md`），因此"下载→解压→启动"链路以代码推理 + 既有测试日志为准。

## 0. 结论速览

| 级别 | 数量 | 编号 |
| --- | --- | --- |
| blocker | 1 | P-01 |
| high | 4 | P-02 ~ P-05 |
| medium | 9 | P-06 ~ P-14 |
| low | 6 | P-15 ~ P-20 |
| 文档不一致 | 5 | D-01 ~ D-05 |
| 已验证为假问题 | 8 | F-01 ~ F-08 |

一句话：**包结构与命令面是健康的，首次"npm 一键安装"这条主链在同一个 DSH 会话里走不完**——自动下载成功后插件仍拿着 apply 时的 `hud` 快照，计划任务/登录自启/快捷方式全部被跳过，`/dsh-hud on` 也拉不起来，只能重启 DSH。

## 1. 八条流程逐条判定

| # | 流程 | 结论 | 关键位置 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | apply 启动 IIFE 顺序 | **缺陷** | `plugin/index.js:915-962` | 顺序与文档一致；但安装完成后不重解析 `hud`（P-01），且失败会连带跳过后面全部步骤（P-03） |
| 2 | installHudApp | **缺陷** | `plugin/index.js:211-263` | 资产正则、sha256、Expand-Archive、目标 exe 校验都在；缺超时/重试/镜像，digest 可选（P-04）、并发无锁（P-06）、失败留残骸（P-07） |
| 3 | ensureLaunchTask / removeLaunchTask | **缺陷** | `plugin/index.js:1174-1212` | `-Force` 幂等、exe 与 `%TEMP%` 守卫都在；但调用点被嵌在首启分支（P-05），删除/禁用路径不可靠（P-12/P-13） |
| 4 | autostart 三态 + first-run + autoStartWithDsh | **缺陷** | `plugin/index.js:1038-1085, 928-958` | 三态判定本身正确；首次自动安装后 `packagedLauncher()` 为 null，首次自启装不上（P-01 的连带） |
| 5 | `/dsh-hud on\|off\|status\|toggle\|show\|hide\|reload` | **部分通过** | `plugin/index.js:804-899` | 文案误报已修（`hudRunning()`）；仍有 -1 误判（P-08）、自定义动作假成功（P-09）、visible 漂移（P-10） |
| 6 | IPC 桥 | **缺陷** | `plugin/index.js:976-983, 1280-1310`；`app/src/config.js:63`、`app/src/hud-window.js:725-739` | TTL 与串行写在；但 npm/zip 布局下两边目录对不上（P-02） |
| 7 | npm 包结构 | **通过** | 根 `package.json`、`cordis.patch.yml` | `files`/`exports`/`dsh.bundle.patch` 与 insert `name: dsh-hud-capsule` 一致；`plugin/package.json` 嵌套不影响 pnpm 解析 |
| 8 | catch/finally 吞错 | **缺陷** | `plugin/index.js:959-961` | 单个 catch 覆盖整条启动链，日志标签还是 `discovery write failed`（P-03） |

## 2. 缺陷明细

### P-01（blocker）自动安装成功后 `hud` 快照不刷新，首装会话里什么都启动不了

- **位置**：`plugin/index.js:395-401`（apply 顶部 `const hud = resolveHud(...)` 只执行一次）、`:922-927`（`!resolveHud().found` 触发安装）、`:933-958`（自启/计划任务/快捷方式/跟随启动全部依赖 `packagedLauncher()`）、`:1013-1018`（`packagedLauncher()` 只读 `hud.mode`）、`:1223-1224`（`startHudViaTask()` 也依赖它）。
- **现象**：npm/GitHub 装法的第一次 apply：`resolveHud()` 返回 `missing` → `installHudApp()` 把 151 MB 解压到 `%LOCALAPPDATA%\DSH HUD` 并**成功** → 但内存里的 `hud` 仍是 `missing`，于是：
  1. `packagedLauncher()` 恒 `null` → `installFirstRunAutostart()` / `ensureLaunchTask()` / `ensureStartMenuShortcut()` 全部提前 return；
  2. `cfg.autoStartWithDsh && packagedLauncher()` 为假 → 不拉胶囊；
  3. 用户按 README 敲 `/dsh-hud on` → `startHudViaTask()` → `ensureLaunchTask()` → `packagedLauncher()===null` → 返回 false → 回「启动失败：没有找到打包版 HUD…」。
- **后果**：首次安装的整个会话里，胶囊既不随 DSH 启动、也没有登录自启、没有快捷方式，且提示与事实相反（HUD 明明已经装好）。必须重启 DSH（重新 apply）才恢复正常——这与 README 「装完即可用 / 否则 `/dsh-hud on`」的承诺冲突。
- **证据**：`plugin/index.js:395` 的 `const hud` 在 `apply()` 内只赋值一次；`:922` 虽调用了 `resolveHud()`，但只取 `.found` 做判断，结果被丢弃。测试日志里自动安装与启动从不在同一个 apply 内（`%TEMP%\dsh-hud-plugin-diag.log:1780-1784` 是"上一次 apply 已装好、这一次 apply 才 found"），所以既有测试没有覆盖该路径。
- **建议修法**：安装成功后重建快照，例如把 `hud` 改成 `let` 并在 `installHudApp()` 返回 `ok` 后 `hud = resolveHud({...})`；或者把依赖 `hud` 的步骤改成每次调用 `resolveHud()`（纯函数、开销可接受，一次 apply 内 3~5 次）。同时给 `/dsh-hud on` 加一次"未找到 → 先 `installHudApp()` 再重试"的兜底。

### P-02（high）IPC 桥在 npm / Release-zip 布局下两端目录对不上

- **位置**：`plugin/index.js:976-983`（轮询 `<pkg>/artifacts/ipc` 与 `%LOCALAPPDATA%\dsh-hud\ipc`）；`app/src/config.js:63`（`ipcDir` 默认恒为 `<repoRoot>/artifacts/ipc`）；`app/src/hud-window.js:68`（`this.config = loadConfig(...)`）、`:725-739`（`if (this.config.ipcDir) return this.config.ipcDir;` 优先返回）；`app/scripts/make-portable.js:124-146`（构建时创建 `resources/artifacts` → 构建机仓库 `artifacts` 的 junction）。
- **现象**：HUD 侧 `_ipcDir()` 永远命中第一分支（config 恒有值），打包后 `app.getAppPath()` 是 `<root>\resources\app.asar`，于是目录是 `<root>\resources\artifacts\ipc`。开发仓库里靠 `make-portable` 建的 junction 指回仓库 `artifacts`，插件第一条候选正好也是它，能对上；但用户从 Release 自动安装到 `%LOCALAPPDATA%\DSH HUD` 时，junction 的目标是**构建机路径**（`fs.symlinkSync(target, ...)` 写的是绝对路径），在用户机上不存在 → HUD `mkdirSync` 失败 → `_requestDesktopFocus()` 直接 `resolve(null)`。
- **后果**：`打开 DSH 桌面窗口` 永远走 `host request timeout`（`hud-window.js:704-708` 的 6 s 轮询），退化到本地 `_launchDshDesktop()`；而在本机受限环境下本地启动会崩（0x80000003）。`hud-window.js:731-738` 里那条 `%LOCALAPPDATA%\dsh-hud\ipc` 分支是不可达的死代码，插件轮询的第二条候选因此永远空转。
- **证据**：`make-portable.js:117-119` 的注释自己写明"两者必须指到同一份文件，否则『打开 DSH 桌面窗口』永远 host timeout"；`config.js:63` 无空值路径；插件 `ipcDirectories()` 没有 `<root>\resources\artifacts\ipc` 候选。
- **建议修法**（任选其一，推荐 1）：① 插件把 `path.join(hud.root, 'resources', 'artifacts', 'ipc')` 加入候选（`hud.root` 已由 `portableRootOf()` 算好）；② 或让 HUD 在 `config.ipcDir` 不存在时回退到 `%LOCALAPPDATA%\dsh-hud\ipc`（把 `config.js` 的默认值改成空串，交给 `_ipcDir()` 分级）；③ 发布包里不要带 junction，改为解压后由插件/HUD 创建真实目录。

### P-03（high）apply 的单一 try/catch 吞掉整条启动链，且诊断标签错误

- **位置**：`plugin/index.js:917-961`。
- **现象**：`writeDiscovery → installHudApp → autostart 三分支 → ensureLaunchTask → ensureStartMenuShortcut → spawnApp/autoStartWithDsh` 全部在同一个 `try` 里顺序执行；任意一步抛出（最典型是网络导致的自动安装失败），`catch` 只记一行 `discovery write failed: <err>`，其后的所有步骤被**永久跳过**（本次 apply 内不再重试）。
- **后果**：用户看到的是"插件装了但什么都没发生"：没有登录自启、没有快捷方式、没有计划任务、不跟随启动，而日志把原因写成"写 discovery 失败"，排查方向被带偏（discovery 其实成功了）。
- **证据**：日志 `%TEMP%\dsh-hud-plugin-diag.log` 中 `discovery written port=…` 之后若出现异常，只会出现该条错误标签；代码 `:959-961` 是唯一 catch。
- **建议修法**：把每个步骤包进各自的 `try/catch`（或抽 `safeStep(name, fn)`），失败只影响该步并保留准确标签；自动安装失败时可降级为"记一条可重试状态文件"，供 `/dsh-hud on` 重试。

### P-04（high）自动安装缺超时、缺重试、缺镜像回退；校验强度低于文档描述

- **位置**：`plugin/index.js:234`（`fetch(RELEASE_API)`）、`:238`（`downloadTo`）、`:239-246`（digest 可选）、`:214-219`（`fetch(url, {redirect:'follow'})` 无 `signal`）；对照 `installer/install-dsh-hud.ps1:36-46`（安装器有 `ghfast.top` 镜像与多源重试）。
- **现象**：
  1. 三个请求都没有超时，网络半开时 `await` 会挂到 TCP 超时（可达数分钟），期间整条 apply 停在 P-03 的 try 里；
  2. 没有重试、没有镜像回退。GitHub 直连不稳的用户（正是插件形态的目标用户）会直接失败，唯一的提示是 `%TEMP%` 里的日志；
  3. `asset.digest` 为空时**静默跳过**校验（GitHub 并非所有历史资产都带 `digest`），且全流程没有任何 `asset.size` 校验——`docs/install-via-npm.md:37` 与 `README.md:43` 都写成"校验 asset.size 与 sha256"（见 D-01/D-03）。
- **后果**：一键安装在国内网络下成功率不可控；校验承诺与实现不符，给"可复现的安全下载"留下空档。
- **建议修法**：`fetch` 加 `AbortSignal.timeout(15_000)`（元数据）/ 下载用 30 分钟上限并统计字节数；下载 URL 依次尝试 `asset.browser_download_url` → `https://ghfast.top/<url>`；`digest` 缺失时回退拉 `SHASUMS256.txt`（Release 里已有），仍拿不到则至少校验 `size === asset.size` 并在日志里声明"仅校验大小"。

### P-05（high）`ensureLaunchTask()` 被嵌在"首次运行自启"分支里

- **位置**：`plugin/index.js:928-939`（`:938` 的缩进也暴露了它不属于 `else if` 之外的任何显式块）。
- **现象**：只有 `autostartDesired() === null`（既没有打包版 cookie 也没有开发版 cookie）且 `packagedLauncher()` 非空时才执行 `ensureLaunchTask()`。一旦用户机器上已经有 `autostart.json`（`true` 或 `false`），apply 就再也不会重建 `dsh-hud-launch` 任务。
- **后果**：任务被 Windows 更新清掉、被组策略删除、或被用户手动删掉后，插件启动时不会恢复；`/dsh-hud on` 与"跟随 DSH 启动"虽然会惰性重建，但 `README.md:93` 说的"插件负责注册计划任务"在常规路径下并不成立，`autoStartWithDsh` 的第一跳也就成了"先失败一次再补建"。
- **建议修法**：把 `await ensureLaunchTask()` 移出 `else if`，与 `ensureStartMenuShortcut()` 并列；保留 `DSH_HUD_NO_LAUNCH_TASK=1` 的关闭开关。

### P-06（medium）并发 apply 会并发安装同一个包

- **位置**：`plugin/index.js:231-263`（zip 路径只由 `asset.id` 决定，目标目录固定，无互斥锁）。
- **现象**：DSH 重新加载 bundle（配置变更、插件更新、多 profile 同时挂载）时 `apply()` 可能被并发调用；两次调用同时进入 `installHudApp()` → 同时写 `%TEMP%\dsh-hud-<assetId>.zip`（`createWriteStream` 截断）→ 先完成者 `Expand-Archive` 读到的可能是另一个写入者尚未 flush 的文件；先完成者 `rm(zip)` 后另一方的管道报 ENOENT/EPERM。
- **后果**：解压出半套文件；`existsSync(exe)` 偶然为真时返回成功，实际 `app.asar` 可能损坏（下次启动才暴露）。
- **建议修法**：进程内用模块级 `let installPromise = null` 复用同一次安装；跨进程用 `%TEMP%\dsh-hud-install.lock`（`fs.open(...,'wx')` + 过期清理）。

### P-07（medium）安装失败残留：zip 不清理、旧版本文件不清理

- **位置**：`plugin/index.js:237`（zip 落在 `%TEMP%`）、`:250-257`（Expand-Archive 失败直接 reject，`:258` 的 `rm(zip)` 不可达）、`:249`（`-Force` 只覆盖同名文件）。
- **现象**：下载中断留下半截 150 MB zip；解压失败留下完整 zip；重复安装旧版本时，新版本没有的文件（例如改名前后的 `runtime\`、旧的 `app.asar.unpacked`）会留在 `%LOCALAPPDATA%\DSH HUD`。
- **后果**：磁盘占用；残留文件可能被旧路径解析到（例如旧的 `runtime\node_modules\electron\dist\electron.exe` 让 `resolveHud()` 走 dev 分支）。
- **建议修法**：`try/finally` 保证 `rm(zip)`；安装前先解压到 `%LOCALAPPDATA%\DSH HUD.new`，成功后整体改名替换（Windows 上先删旧目录再 rename）；或解压前清空目标 `app\` 与 `runtime\`。

### P-08（medium）`hudProcessCount()` 失败返回 -1，被当成"未运行"

- **位置**：`plugin/index.js:1214-1221`（`code !== 0` 或解析失败返回 `-1`）、`:846-848`（`off` 分支 `<= 0` 直接回「DSH HUD 未在运行」）、`:859-865`（`status` 同理）。
- **现象**：PowerShell 被安全软件拦截、超时（默认 15 s）、或 `Get-Process` 出错时，`-1` 落入 `<= 0` 分支：`off` 连退出指令都不发就报"未在运行"；`status` 报"未运行"。
- **后果**：用户看到的状态与实际相反，`off` 静默失效。
- **建议修法**：把 `-1` 单独处理为「无法确认（PowerShell 查询失败）」，`off` 仍然 `sendControl('quit')` 并提示"已发送退出指令，但无法确认进程状态"。

### P-09（medium）自定义动作透传回"已发送"，HUD 侧实际丢弃

- **位置**：`plugin/index.js:867-876`（`builtins` 之外一律 `sendControl(action)` 并返回 success）。
- **现象**：目前 app 侧 `ControlBridge` 只认 `toggle/show/hide/reload`（另加 host 扩展点；未注册扩展时）→ 收到未知动作只打印 `[hud] unknown control action: <x>`（见 t13 审计后的 control.js 行为）。插件却回「已发送自定义动作：x」。
- **后果**：扩展点在没有注册 handler 的情况下表现为"成功但无效果"。
- **建议修法**：回执改成「已发送自定义动作 X（若未注册扩展处理器则会被忽略）」，或在 discovery 里带上插件侧已知的动作清单做校验。

### P-10（medium）`visible` 是纯本地猜测，回执与实际状态漂移

- **位置**：`plugin/index.js:359`（`let visible = false`）、`:837, 856, 880, 884, 891`（本地翻转后用于文案）。
- **现象**：用户用热键/托盘展开或收起时插件不知道；`toggle` 只翻转本地值，文案与实际相反。
- **建议修法**：从 `discovery.json` 之外再读一个 HUD 写出的 `state.json`（`visibility`），或让 HUD 在状态变化时更新 discovery 的 `state` 字段，命令回执以文件为准。

### P-11（medium）IPC 请求文件不删除，插件重启后会重放 120 s 内的旧请求

- **位置**：`plugin/index.js:1287-1293`（只比 `lastRequestId`，不删 `request.json`）、`:986`（`IPC_REQUEST_TTL_MS = 120_000`）。
- **现象**：`lastRequestId` 只在内存里；插件重启（DSH 重启/热重载）后，磁盘上 2 分钟内的最后一个请求会再执行一次——典型后果是"刚重启 DSH，又自动拉起一次桌面窗口并抢焦点"。
- **建议修法**：处理完即 `rm(request.json)`（或写 `result.json` 后删除）；TTL 缩短到 30 s 并记录 `servedAt` 以便重启后跳过。

### P-12（medium）`removeLaunchTask` 的错误处理是假的；`%TEMP%` 前缀判定会误伤

- **位置**：`plugin/index.js:1179`（`runPowerShell(...).catch(() => {})`，而 `runPowerShell` 从不 reject）、`:1181`（无论成败都记 `launch task removed`）、`:1192-1193`（`startsWith(tmp)`）。
- **现象**：PowerShell 失败、任务正在运行导致 `Unregister-ScheduledTask` 失败时，日志仍然说"removed"；`os.tmpdir()` 为 `C:\...\Temp` 时，`C:\...\Temp2\...` 也会被判为临时路径并触发删除。
- **建议修法**：检查 `code` 后再记日志；前缀判定改为 `p === tmp || p.startsWith(tmp + path.sep)`。

### P-13（medium）`launchTaskReady` 不反映任务被禁用/删除，失败无诊断

- **位置**：`plugin/index.js:1209`；`:1224-1226`（`if (!launchTaskReady && !(await ensureLaunchTask())) return false;` 之后不再校验任务状态）。
- **现象**：注册成功一次后 `launchTaskReady = true` 永久为真；之后用户在任务计划程序里禁用/删除该任务，`Start-ScheduledTask` 失败只返回 `false`，最终命令回「启动失败…详见插件诊断日志」。
- **建议修法**：`startHudViaTask()` 失败时把 `launchTaskReady = false` 并重试一次 `ensureLaunchTask()`；日志输出 PowerShell 的 stderr。

### P-14（medium）`countElectron()` 统计全部 electron.exe，会误判 shell 启动成功

- **位置**：`plugin/index.js:625-642`；`shellLaunch` 分支 `:643-672`。
- **现象**：`Get-Process electron` 不区分来源；DSH 自身从源码运行时、或用户同时开着别的 Electron 应用时，`n > 0` 立即成立 → `launchViaShell()` 返回 true → 不再回退 `startChild()`。
- **后果**：`shellLaunch=true` 的调试路径可能"假成功"（该路径默认关闭，影响有限）。
- **建议修法**：改为按命令行/路径过滤（`Get-CimInstance Win32_Process | Where CommandLine -like '*DSH HUD*'`），或在启动前后各取一次快照做差。

### P-15（low）`startupCmdFile()` 在 `%APPDATA%` 缺失时退化为相对路径

- **位置**：`plugin/index.js:999-1008`（`path.join(process.env.APPDATA || '', 'Microsoft', ...)`）。
- **现象**：`APPDATA` 未设置时得到 `Microsoft\Windows\...\dsh-hud.cmd`，`mkdir` 会在进程 cwd 下建目录并写文件。
- **建议修法**：`APPDATA` 为空时直接返回 null，`applyAutostart` 记一条并跳过。

### P-16（low）日志轮转有竞态，且 `.1` 会被覆盖

- **位置**：`plugin/index.js:366-390`。
- **现象**：每次写日志前 `statSync` + `renameSync`；两次写入并发时后者可能把前一次刚写的内容覆盖掉，`.1` 也没有多代轮转。
- **建议修法**：改成按天文件，或用 `appendFileSync` + 单次 `size > N` 时截断/切换（接受偶发丢行）。

### P-17（low）`handleDesktopRequest` 固定等 900 ms 再 focus，无重试

- **位置**：`plugin/index.js:1274`。
- **现象**：冷启动 DSH 桌面端常超过 900 ms，`runFocusHelper()` 找不到窗口 → 返回 `notfound` → `{ok:false}`，HUD 侧退化为本地启动。
- **建议修法**：按 0.5 s 间隔重试 3~4 次（`focus-dsh.ps1` 本身幂等）。

### P-18（low）IPC 忙标志让单个请求阻塞后续最长约 9 s

- **位置**：`plugin/index.js:1280-1281, 1294-1308`。
- **现象**：`handleDesktopRequest` 内含 900 ms + 最长 8 s 的 focus helper；期间 `ipcBusy=true`，其他请求（如托盘菜单的 `autostart`）排队。
- **建议修法**：`autostart` 这类轻请求优先处理，或把 focus 放到 `void` 异步、结果仍写 `result.json`。

### P-19（low）计划任务触发器 `-Once -At (Get-Date).AddYears(1)` 的语义

- **位置**：`plugin/index.js:1203`。
- **现象**：任务只被 `Start-ScheduledTask` 手动触发，触发器只是占位；一年后触发器过期，Windows 可能把任务标记为"不会再运行"。手动启动仍可用，但任务计划程序里会出现红色提示，用户容易误判。
- **建议修法**：改用 `-At (Get-Date).AddYears(100)`，或 `New-ScheduledTaskTrigger -Once -At ([datetime]::MaxValue.AddDays(-1))`，并在文档里说明"仅供手动启动使用"。

### P-20（low）首装失败没有重试入口，状态也不可见

- **位置**：`plugin/index.js:922-927`（仅 apply 时尝试一次）、`:859-865`（`status` 不显示安装状态）。
- **现象**：首次自动安装失败后，用户唯一的选择是重启 DSH；`/dsh-hud status` 只说"未运行 · 未找到安装目录"。
- **建议修法**：把安装结果写进 `%LOCALAPPDATA%\dsh-hud\install-state.json`（`{ok, at, message}`），`status` 里展示；`/dsh-hud install` 作为手动重试入口。

## 3. 文档与实现不一致

| 编号 | 文档 | 声明 | 实际 |
| --- | --- | --- | --- |
| D-01 | `docs/install-via-npm.md:37` | 「校验 asset.size 与 sha256（digest 字段）」 | 只校验 digest，且 digest 为空时跳过；没有 size 校验（`plugin/index.js:239-246`） |
| D-02 | `docs/install-via-npm.md:63-64` | 本机已有 `dist/win-unpacked` 会被当成"未找到"而重新下载 | 候选列表已包含 `<repo>/dist/win-unpacked/app/DSH HUD.exe`（`plugin/index.js:183,186`），日志实测命中（diag `:1742`） |
| D-03 | `README.md:43` | 「校验 SHA-256 后解压」 | 同 D-01：digest 缺失时不校验 |
| D-04 | `README.md:93-95` | 插件注册计划任务；「重新登录一次（或 `/dsh-hud on`）」 | 首次自动安装的同一会话里两者都不成立（P-01/P-05） |
| D-05 | `docs/plugin-app-bridge.md:66` | stdin 契约是 `{"type":"reload","seq":3}` | 代码写的是 `{"action":...,"seq":...}`（`plugin/index.js:554`），app 侧读 `obj.action` |

## 4. 已验证为假问题

| 编号 | 疑点 | 结论 |
| --- | --- | --- |
| F-01 | 资产正则 `/^DSH-HUD-.*-win-x64\\.zip$/` 多了一层反斜杠 | 读取工具会把 `\.` 显示成 `\\.`；实际是 `\.zip`，能匹配 `DSH-HUD-0.4.1-win-x64.zip` |
| F-02 | 根 `cordis.patch.yml`（`dsh-hud-capsule`）与 `plugin/cordis.patch.yml`（`@dsh-hud/token-bridge`）冲突 | 两条安装路径各自匹配目录名，互不影响 |
| F-03 | `spawnApp=false` 时命令误报"未运行" | 已修：`hudRunning() = Boolean(child) \|\| hudLikelyRunning()`（`plugin/index.js:819`） |
| F-04 | 日志里的 `child.stdout not available` | `subprocess` 服务不提供流句柄，插件已有 `pipe()` 守卫（`:739-749`），非缺陷 |
| F-05 | `resolveHud()` 找不到 HUD 会抛异常 | 全部返回 `{found:false, reason}`，`apply` 只记日志（`:405-409`） |
| F-06 | 插件重启后 `seq` 归零导致命令被吞 | 已修：`controlSeq = Math.max(controlSeq + 1, Date.now())`（`:534`） |
| F-07 | `Expand-Archive` 命令有注入风险 | 路径经 `q()` 单引号转义（`:248-249`），zip 路径由 `os.tmpdir()` + asset id 生成，可控 |
| F-08 | `/dsh-hud off` 的 2.4 s 等待太短 | HUD 的 quit 路径是同步存状态后 `app.quit()`，实测日志无超时；超时也会明确报错 |

## 5. 建议修复顺序

1. **P0（阻断 npm 一键安装闭环）**：P-01（重解析 `hud` + `on` 兜底）→ P-05（计划任务移出分支）→ P-02（IPC 候选目录补 `hud.root/resources/artifacts/ipc`）。
2. **P1（失败可诊断/可恢复）**：P-03（分步 try/catch + 正确标签）→ P-04（超时/重试/镜像/校验）→ P-07（finally 清理）→ P-06（安装互斥）。
3. **P2（行为一致性）**：P-08、P-09、P-10、P-11、P-12、P-13、P-14。
4. **P3（打磨）**：P-15 ~ P-20 + D-01 ~ D-05 的文档修订。

## 6. 取证命令（可复现）

```text
# 1) 语法（交付前已跑，exit 0）
node --check plugin/index.js

# 2) 关键行号（在仓库根执行；输出 "行号 内容"）
node -e "const fs=require('fs');for(const f of ['plugin/index.js']){const s=fs.readFileSync(f,'utf8').split(/\r?\n/);s.forEach((l,i)=>{if(/const hud = resolveHud|installHudApp\(|ipcDirectories|ensureLaunchTask|removeLaunchTask|controlSeq = Math\.max/.test(l))console.log(f+':'+(i+1)+'  '+l.trim())})}"

# 3) 两端 IPC 目录
node -e "const fs=require('fs');for(const f of ['app/src/config.js','app/src/hud-window.js','app/scripts/make-portable.js']){const s=fs.readFileSync(f,'utf8').split(/\r?\n/);s.forEach((l,i)=>{if(/ipcDir|_ipcDir|'artifacts'/.test(l))console.log(f+':'+(i+1)+'  '+l.trim())})}"

# 4) 运行日志（插件每次 apply / 安装 / 计划任务都会写）
type %TEMP%\dsh-hud-plugin-diag.log
```

## 7. 边界声明

- 本审计为**只读**：未修改 `app/`、`plugin/`、`dist/` 任何文件。
- 未能真机验证的三条：P-01 的完整首装链路（需要干净 profile + 真实 Release）、P-02 的 junction 在用户机上的实际解析结果、P-14 的 `shellLaunch` 误判（该路径默认关闭）。
- 其余结论均落在可指认的代码行或同一台机器上的日志行上。
