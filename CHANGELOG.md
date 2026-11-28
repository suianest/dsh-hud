# Changelog

本项目的重要变更记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)：

- 应用（`app/package.json`）在 `0.x` 阶段按语义版本递增；
- 插件（`plugin/package.json`）独立版本，改协议时双方 `protocolVersion` 必须对齐；
- 每个版本的条目在发版前写好，正文直接复制进 GitHub Release。

## [0.5.11] - 2026-11-24

### Fixed

- **HUD 比 DSH 活得久时不会自己重连**：DSH 重启后插件重新 apply，若胶囊进程仍在（`capsule already running`），
  它手里还是上一次的 origin/token，只能等自己 5 s 轮询。现在这一支会立刻 `sendControl('reload')`，
  并在 2.5 s 后再补一次，面板基本无感恢复。
- **我们拉起 HUD 之后补一次 reload**：`startHudDirect()` / 计划任务兜底确认进程起来后，4 s 再发一次 reload，
  避免视图在 token/端口还没稳定时先加载成 401/空白。
- **discovery 的 url 变化也会触发重载**（同端口换 token 的场景），有 600 ms 延迟合并抖动。

### Tests

- 全量 **96/96**（新增逻辑只走打包态 auto-start 分支，单测环境用 `DSH_HUD_AUTOSTART_WITH_DSH=0` 避开）。

## [App 0.5.9] - 2026-11-24

> 应用侧版本（Electron）。插件版本仍是 **0.5.10**，本次没有插件改动。

### Fixed

- **HUD 面板空白/假死可诊断了**：`app/src/web-embed.js` 的加载链路原先全走 `console.*`，打包版看不到任何视图日志。
  现在 `web load` / `web loaded` / `web load failed` / `web http status` 全部写进 `udd/hud.log`，视图事件通过
  `this.web.log = (msg) => this._log(msg)` 接进同一份日志。
- **渲染进程崩溃后不再永久空白**：新增 `render-process-gone`（400 ms 后自动 `reload`）与 `unresponsive` / `responsive` 监听。
- **并发导航冲突**：`load()` 在已有导航在途时先 `webContents.stop()` 再发起新导航（取消-重载），
  避免 `startDsh` / 5 s 恢复循环 / `hud:web-retry` 同时 `loadURL` 把视图留在空白页。
- **自启请求走错 IPC 目录**：`app/src/autostart.js` 的 `requestHostApply()` 仍写 `REPO_ROOT/artifacts/ipc` 且 `at` 用 ISO 字符串，
  现已改用 `loadConfig().ipcDir`（`%LOCALAPPDATA%\dsh-hud\ipc`）与数字时间戳，与 0.5.8 起的桥接规范一致。

### Tests

- 全量 **96/96** 通过（含 `web-embed` 视图日志、取消-重载语义回归）。

## [0.5.10] - 2026-11-23

### Fixed

- **命令面板「打开 DSH 桌面窗口」不再静默失败**：HUD 与插件原先各写各的 IPC 目录（`<app>/artifacts/ipc` vs 仓库 `artifacts/ipc`），
  桥接永远超时后回退到直接 `spawn`，DSH 已在运行时只会起一个无窗口的第二实例。现在两端统一使用 `%LOCALAPPDATA%\dsh-hud\ipc`，
  插件启动时用 `icacls /setintegritylevel Low` 放开低完整性写入；HUD 侧超时 6 s → 12 s，并在「DSH 已在运行但无法置前」时给出可见通知而不是静默退出。
- **IPC 轮询死循环**：多个目录里的 `request.json` 共用一个 `lastRequestId` 去重，两个不同 id 会每 500 ms 互相覆盖，
  导致「过期日志 + 重放 autostart」无限循环（表现为反复弹窗、反复重写开机启动项）。改为按 id 集合去重，处理或丢弃后删除 `request.json`，
  并兼容字符串形式的 `at`。
- **通知不显示**：`app.setAppUserModelId("com.suianest.dsh-hud")`，否则 Windows 上 `Notification.isSupported()` 为 false。
- **兼容旧版应用**：0.5.7 及更早的 HUD 会把请求写到 `<root>/app/artifacts/ipc`，插件现在同时轮询该路径，
  所以「先升级插件、后升级应用」的中间状态也能聚焦窗口，不会退回静默 spawn。

### Tests

- 新增 `tests/e2e/unit/plugin-ipc.test.mjs`（8 条）：覆盖 id 去重、数字/ISO 时间戳过期、TTL 边界，
  以及「两个目录不同 id 不再互踢」的循环回归；全量 **96/96**。
- `artifacts/harness-ipc.mjs` 真机 harness 两个场景（stale / legacy）均通过。
## [0.5.9] - 2026-11-22

### Changed

- **npm 页面中英双语**：`README.md` 改为英文在前、中文在后（npm 首页默认展示英文）；
  `package.json` 的 `description` 换成英文。代码无改动，应用侧仍为 0.5.7。

## [0.5.8] - 2026-11-21

### Fixed

- **npm 重发**：0.5.7 发布后 tarball 返回 404（registry 元数据已有该版本但文件缺失），无法安装。
  本次仅提升插件包版本号后重发，代码与 0.5.7 完全一致；应用侧仍为 0.5.7。

## [0.5.7] - 2026-11-20

### Changed

- **安装包瘦身**：Electron 自带 55 个语言包（约 49 MB），只保留 `en-US` / `zh-CN` / `zh-TW`
  三个（Chromium 找不到对应语言包会自动回落 en-US）。
- 压缩改由 `make-portable.js` 内置的 Node 写入器完成（deflate level 9、UTF-8 文件名、自动跳过 junction、无 zip64）：
  `Compress-Archive` 在源目录上持续 `PermissionDenied`（asar 被占用），`robocopy /XJ` 的 .NET 方案在 PowerShell 5.1
  又缺 4 参重载，因此改为自写压缩，产物可复现且不会把 `app/resources/artifacts` 这个开发用 junction 展开成上 GB 的无用文件。

### Removed

- 命令面板里的临时条目「测试」（0.5.5 起用于验证「仓库改动 → 构建 → 面板」链路），连通性自检由
  「检查更新」与插件更新提示覆盖。

### Notes

- 本版是「中版」起点：功能面收敛，后续按用户体验反馈再出终版（见 `docs/roadmap.md`）。

## [0.5.6] - 2026-11-20

### Added

- **插件版本提示（P-14 方案 A）**：插件每 6 小时查一次 npm 上 `dsh-hud-capsule` 的最新版本
  （10 s 超时，失败只记一条日志、不打扰用户），发现比本地新就通过 `control.json` 通知 HUD。
- HUD 侧：`⌘` 按钮右上角出现橙色小圆点，命令面板多一项
  「插件有新版本 vX.Y.Z（复制升级命令）」；点它把 `pnpm add dsh-hud-capsule@X.Y.Z` 复制到剪贴板并关闭面板。
  **不自动替换任何文件**——升级动作始终由用户执行。

### Fixed

- HUD 对插件上报的版本做二次校验：`latest` 不高于当前版本（含降级）时直接忽略，并清掉之前显示的徽标/条目。

### Tests

- 新增 3 条 hud-window 单测：有更新时的状态/面板条目/剪贴板、空值不出现、同版本与降级被忽略；全套 **87/87**。

## [0.5.5] - 2026-11-18

### Changed

- 默认启动方式改为「插件直接 spawn 应用」，不再默认注册计划任务 `dsh-hud-launch`（P-13 根因：悟空等安全软件会把「计划任务自动拉起未签名 exe」判为可疑）。2026-11-18 复测确认：只要子进程带上 `--no-sandbox` 与可写 `--user-data-dir`，从 DSH 宿主直接 spawn 就能正常起来（此前 `0x80000003` 是子进程回落到共享 `%APPDATA%\Electron` 配置导致的）。
- 计划任务降级为兜底：直接拉不起来时才回退；也可以用 `DSH_HUD_USE_TASK=1` 强制走计划任务，或在旧机器上排查时临时启用。

### Fixed

- 「检查更新」不再无限挂起：清单请求加 15 s 超时、asar 下载加 120 s 超时，超时会落到下一个清单源，全部失败则弹「检查更新失败」并带原因。2026-11-18 线上验收时观察到 github.com 直连在本机会卡住 3 分钟以上（同 URL 用 node 的 fetch 只要 0.7 s），旧代码没有任何超时，界面会一直停在“检查中”。
- 新增单测守住这条：manifest 与 asar 两次 fetch 都必须带 `AbortSignal`。

### Docs

- README 的「安全软件拦截」章节说明新的默认启动方式，以及 `DSH_HUD_USE_TASK=1` 的用途。
- 新增 `docs/roadmap.md`，记录未完成计划；本次把「代码签名」列为 R-1（P-13 长期方案，目标 0.6.x）。

### Planned（未完成，见 `docs/roadmap.md`）

- **R-1 代码签名**：本版只去掉了「计划任务自动拉起」这条会被判可疑的特征，**exe 仍未签名**，第一次运行仍可能被 SmartScreen / 悟空 / 360 / 火绒提示。解决方案（Azure Trusted Signing / OV / EV 证书）与构建链改造见 `docs/roadmap.md`。
- **R-2 GitHub 路线换机验收**：npm 路线已通过；GitHub 路线需在目标机器先装 git。
- **R-3 安装包瘦身**：当前 zip 158.6 MB，Electron 运行时占大头。

## [0.5.4] - 2026-11-18

### Fixed

- 拉起失败不再静默：spawn 报错、HUD 5 秒内退出、计划任务跑完但进程没出现，都会在 `hud.log` 写一条「可能被安全软件（悟空/360/火绒/Defender）拦截」的处理提示（P-13）。
- 错误页补一行操作指引：连不上 DSH 时提示「还要在 DSH 里装插件 `dsh-hud-capsule`」，避免只装应用包的人以为装坏了。
- 安装器结束时打印「下一步：在 DSH 里装插件」，不再让用户停在“装了一半”的状态。

### Docs

- README 安装路线改为按推荐顺序排列：**C npm 包名（首选）→ A 安装器（兜底）→ B1 GitHub（需 git）→ B2 本地目录（无需 git）**。
- 新增「安全软件拦截（悟空 / 360 / 火绒 / Defender）」章节：现象、原因（未签名 + 自动拉起）、三种处理办法。

## [0.5.3] - 2026-11-17

### Fixed

- `exports` 增加 `"./package.json"`，第三方工具可以 `require('dsh-hud-capsule/package.json')` 读版本（0.5.2 之前会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`）。
- 移除误加进 `package.json` 的 `dependencies: {"dsh-hud-capsule": "^0.5.0"}` 自依赖（本地安装自检时被 pnpm 自动写入，幸好未进入已发布的 0.5.2 包）。

## [0.5.2] - 2026-11-17
### Fixed
- **国内网络下下载链路不可用**（三条路线复现性实测 2026-11-17）：GitHub 直连 151 MB 包实测 14.8 KB/s 且中途 `Connection was reset`；`ghfast.top` 不可达；`raw.githubusercontent.com` 与 `cdn.jsdelivr.net` 在 TCP 层就失败。
  - 安装器：镜像从 `ghfast.top` 单一源改为 **ghproxy.net → gh-proxy.com → ghfast.top → 直连** 依次尝试，并优先用 `curl.exe -C -` 断点续传（Windows 10 1809+ 自带 curl），超时 600 s → 1800 s。
  - 插件自动安装：`downloadTo()` 同样按 4 个源轮换，单源超时 180 s → 600 s；失败时清理半包再换源。
  - 应用内更新：清单源顺序改为 **raw → Release 附件 → jsDelivr → REST API**，并给 Release 补传 `manifest.json` 附件，让 `releases/latest/download/manifest.json` 这条兜底真正可用（此前 404）。
- `make-portable.js` 发现 `udd/` 被运行中的 HUD 重建时直接报错，避免把 Chromium 缓存（约 13 MB、含本机数据）打进 zip。

## [0.5.1] - 2026-11-16
### Fixed
- **胶囊展开/收起时闪一帧错位内容**：窗口先 resize、renderer 后重绘，旧布局在新尺寸里露了一帧（用户 2026-11-16 报「图标先在左上角位移一帧」）。改为切换前 `setOpacity(0)`，renderer 画完新一帧回 `hud:painted` 再显示，160 ms 定时兜底；顺带补了 2 个单测。

## [Unreleased] - 0.5.0
### Fixed
- **应用内更新此前在真机上从未成功**：`app/updater.cjs` 在 `ELECTRON_RUN_AS_NODE=1` 下被 Electron 的 fs shim 拦截，替换 `app.asar` 报 `ENOENT ... not found in app.asar`；改为文件顶部 `process.noAsar = true`。
- **更新后窗口不回来**：helper 把 `ELECTRON_RUN_AS_NODE=1` 继承给重启进程，新实例以纯 Node 启动、无窗口即退出；relaunch 前复制的 env 中删除该变量。
- `downloadUpdate()` 返回值缺 `version`（清单字段是 `latest`），已兼容两者。
- `make-portable.js` 的 `CANONICAL_FILES` 补 `updater.cjs`，helper 被误删时打包直接报错。

### Added

- **npm 包名一键安装**：`dsh-hud-capsule@0.5.0` 已发布到 npm
  （<https://www.npmjs.com/package/dsh-hud-capsule>）。DSH「添加插件」填包名即可，
  应用包仍由插件首次运行自动下载。新增 `tools/publish-npm.mjs` 作为发布脚本。
- `package.json` 补齐 npm 元数据（description / repository / homepage / bugs / keywords / `dsh.bundle.patch`）。

### Notes

- npm 2026 起默认 **staged publishing**：`publish` 只会进暂存区，维护者需在 npmjs.com 的
  Staged Packages 页（或 `npm stage approve --otp`）用 2FA 批准后版本才上线；
  首次发布还会生成 `0.0.0-stage` 占位版本（已 deprecate）。

## [0.4.2] - 2026-11-16

审计驱动的一轮修复（t40 插件侧 / t41 app 侧 / t42 回归），全部为问题修复，无新功能。

### Fixed

- **首次安装后不刷新 HUD 定位**（t40 P-01，blocker）：插件只在启动时解析一次 `hud`，
  自动安装成功后本次会话里的「随 DSH 启动 / 计划任务 / 快捷方式 / `/dsh-hud on`」全部失效，
  必须重启 DSH。现在安装成功后 `refreshHud()` 重新解析并记录日志。
- **启动链单点失败会跳过后续步骤**（t40 P-03）：整条启动流程原来裹在一个 try 里，
  写 discovery 失败会连带跳过自动安装、自启、任务、快捷方式、拉起。现在六段各自 try/catch。
- **老用户拿不到计划任务**（t40 P-05）：`ensureLaunchTask()` 原来嵌在「首次运行」分支里，
  已有 autostart cookie 的安装永远不会重新注册任务。现在无条件执行（带 exe 有效性守卫）。
- **打包版「打开 DSH 桌面窗口」必超时**（t40 P-02）：HUD 侧 `ipcDir` 打包后落在
  `resources/artifacts/ipc`（构建机靠 junction 掩盖），插件只在 `<root>/artifacts/ipc` 找。
  现在 HUD 侧按 `<root>/artifacts/ipc` 推导，插件侧再补两个候选目录。
- **自动安装无超时/无镜像/无大小校验**（t40 P-04）：加 30s 清单超时、180s 下载超时、
  失败自动走 `ghfast.top` 镜像重下一次、校验 `asset.size`；digest 缺失时只告警。
- **安装器覆盖运行中的 HUD**（t41 M1）：解压前检测 `DSH HUD` 进程，提示并结束；拒绝则退出。
- **打包清单漏 `src/config.js`**（t41 M2）：补进 `CANONICAL_FILES`。
- **更新器不校验 manifest.size**（t41 low）：按清单大小校验，截断响应直接报 `size mismatch`。
- **`check-hud.cmd` 清单缺文件**（t41 low）：补 `src/updater.js`、`src/shortcut.js`、`src/extensions.js`。
- **登录项可能指向临时目录的 exe**：`applyAutostart` 增加临时路径守卫，测试 fixture 需显式
  `DSH_HUD_ALLOW_TEMP_AUTOSTART=1` 才放行；单测在文件顶部统一关闭计划任务/快捷方式/自动安装。

## [0.4.1] - 2026-11-15

修复版：收起动画的残影，以及更新清单的多源回退。

### Fixed

- **收起时残留面板左上角**：面板→胶囊的动画结束后，渲染层立刻移除了 `anim-collapse`
  （`forwards` 的 opacity:0），而主进程此时才把窗口缩到 64×64，于是新窗口里短暂露出
  面板的左上角（标题 + ⌘ 按钮）再出现胶囊。现在收起动画的结束帧保持到 `hud:state`
  切到胶囊态才清除，过渡期窗口内容为透明，不再闪旧画面。

- **检查更新在部分网络下打不开**：`manifest.json` 改为按顺序尝试 raw / jsDelivr / Release 资产 / GitHub REST API 四条源，前一条失败自动换下一条，全失败时错误信息列出每条原因。

## [0.4.0] - 2026-11-13

包布局调整 + 首次运行体验 + 应用内更新 + UI 打磨。**从 0.3.0 起请从 Release 页下载新包。**

### Added

- **应用内更新（P-09）**：右键菜单 / 命令面板里的「检查更新」。读取仓库根 `manifest.json`，
  只下载 `app.asar`（约 0.5 MB），sha256 校验后写入 `userData/update/app.asar.new` 与
  `update-pending.json`，由 `app/resources/updater.cjs` 等文件锁释放后替换（保留 `app.asar.bak`）
  并重启。运行时永不替换 `DSH HUD.exe`。
- **首次运行自动装开机启动（P-07）**：插件首次定位到打包版 HUD 且没有 `autostart.json` 时，
  自动写 `Startup\dsh-hud.cmd` 并记 `{enabled:true, by:"plugin-first-run"}`；菜单关掉后不会再装回。
  `DSH_HUD_NO_AUTOSTART=1` 可关。
- **开始菜单快捷方式（P-08）**：插件首次运行同时创建 `%APPDATA%\...\Programs\DSH HUD.lnk`
  （HUD 进程是低完整性，写不了该目录，所以由 Medium 权限的插件代建）。
- **外部扩展目录（P-03）**：`<exe>/extensions/*.js` 与 `%LOCALAPPDATA%\DSH HUD\extensions\*.js`
  在启动时加载，支持函数导出与 `activate(api)`，`protocolVersion` 不匹配跳过，
  `DSH_HUD_NO_EXTENSIONS=1` 关闭。详见 `docs/extending.md`。
- **`discovery.json` 增加 `protocolVersion`（P-02）**：HUD 读到不匹配的值只记一条警告、不阻塞加载（插件版本 1.1.0）。
- **面板右键菜单**：面板任意位置右键 = 胶囊菜单（打开桌面窗口 / Token 补充 / 检查更新 / 退出 / 开机自启）。
- **跟随 DSH 启动**：DSH 一启动就通过计划任务把胶囊拉起来（静默、无确认）；右键菜单关掉「开机自启」或不想要时设 `DSH_HUD_AUTOSTART_WITH_DSH=0`。
- **在 DSH 里开关胶囊**：`/dsh-hud on` 启动（计划任务 `dsh-hud-launch`，无需人工确认）、`off` 退出、`status` 查看。

### Changed

- **便携包布局（P-06）**：Electron 运行时（exe/resources/dll/locales）挪进 `dist/win-unpacked/app/`，
  根目录只剩 `DSH HUD.lnk`、`启动 DSH HUD.cmd`、`README.txt`、`udd/`。插件探测路径同步支持新旧两种布局。
- **UI 打磨**：标题栏 48px + 发丝分隔线；面板按钮 28×28、按下缩放、键盘焦点环；内容区留白 12px；
  命令面板加半透明背板、选中项主题蓝 + 左侧强调条、底部快捷键提示、输入框 15px、圆角 16px。
- 命令面板遮罩移进卡片内部，跟随窗口 22px 圆角裁切，不再露出直角暗块。

### Fixed

- **命令面板关不掉**：背板会吞掉标题栏按钮点击，且主进程关闭面板时没有通知渲染层。
  现在背板 `pointer-events: none`，`_closePalette()` 会发 `hud:palette-close` 同步隐藏 DOM。
- **命令面板误关**：移除「点空白处关闭」，现在只有 ⌘/Ctrl+K、Esc、执行命令三种关闭方式。
- **内嵌页左上角侧栏按钮被裁（P-10）**：`compact-css.js` 新增 C10，把 `[data-sidebar-toggle]`
  下移 14px 回到自己的行内。
- **拖边缩放时长按持续变大**：缩放改用渲染层 pointer delta，交叉轴锁 session 快照，
  不再从 `getBounds()` 回读被 Windows 隐藏边框污染的尺寸。
- **首启闪深色（L1）**：`_loadTheme()` 在 `theme.json` 缺失时回退 `nativeTheme.shouldUseDarkColors`。


## [0.3.0] - 2026-11-09

### Added

- 胶囊改为圆形鲸鱼图标（`app/renderer/whale.svg`，64×64 窗口；悬停才显示关闭按钮）。
- 右键菜单：打开 DSH 桌面窗口 / 打开 DSH 浮窗 / Token 补充 / 退出 DSH 浮窗 / 开机自启（复选）。
- 命令入口雏形：`/dsh-hud <action>` 控制动作表，加上 `registerMenuItem` / `registerControlAction` /
  `registerCss` 三个扩展点（`app/src/extensions.js`，用法见 `docs/extending.md`）。
- 可移植化安装：`scripts/setup.mjs` 检查 Node ≥ 20、准备 Electron 44.7.0、写 `config.local.json`；
  `docs/environment.md` 给出支持矩阵与「无法自动适配」清单。
- 内嵌页打开右侧栏时，面板向右加宽到 900 DIP（`PANEL_WIDE`），不再把右侧栏压成抽屉。

### Fixed

- 窗口内容尺寸抖动：改用 `useContentSize: true` + `thickFrame: false`，消除 ±1–2 px 漂移。
- 内嵌页外链：`setWindowOpenHandler` / `will-navigate` 一律交给系统浏览器，面板不再被导航走。
- 控制桥：`seq` 改为 `Math.max(seq + 1, Date.now())`，DSH 重启后不再丢控制指令；
  子进程 stdin 与 `control.json` 的字段名统一为 `action`。
- 401 重试改为「一次 + 发现文件存在」，不再用 60 秒文件年龄当 token 有效性判据。
- 收起动画期间的第二次热键不再被丢弃：先立即结束收起（回到胶囊），下一次按键即可展开。

### Changed

- 透明窗口去掉原生阴影与外壳内边距（`SHELL_INSET = 0`），圆角改由 CSS 绘制。
- 内嵌页按 `Escape` 默认不再收起面板（改为 `DSH_HUD_WEB_ESC=1` 显式开启），避免抢走页面内对话框的 Esc。

## [0.2.0] - 2026-11-06

### Added

- 首个可运行版本：常驻悬浮胶囊（点击展开）+ 520×720 无边框透明面板。
- 面板内嵌 DSH Web UI（`WebContentsView`，`persist:dsh-web` 分区），按 520 宽度注入紧凑 CSS。
- 全局热键 `Ctrl+Alt+Space` 切换胶囊/面板；位置记忆、边缘吸附、多显示器钳位。
- 发现文件（`%LOCALAPPDATA%\dsh-hud\discovery.json`）+ token→cookie 鉴权；
  自绘错误页，带「重试 / 启动 DSH」两个按钮与自动重连。
- 开机自启（`app.setLoginItemSettings`）与右键退出；首次运行不主动触碰登录项。

## [App 0.5.12] - 2026-11-28

### Fixed

- **P-15-2 让路**：插件的 `reload` 提示不再打断正在进行的导航。视图处于
  `401 → 错误页 → token 重试` 序列时，旧实现会 `stop()` 掉在途导航
  （日志 `web load: cancelled the in-flight navigation`），面板空 8–15 秒；
  现在改为等导航结束（最多约 3 秒）再刷新，空闲时立即刷新。
  `control.json {action:"reload"}` 走新的 `reloadWebDeferred()`。

### Tests

- `hud-window.test.cjs`: nudge reload 在导航进行中不发起第二次 load、不调用 `stop()`，
  导航结束后恰好刷新一次。
- 全量 98/98。

## [0.5.12] - 2026-11-28

### Fixed

- **P-15-1 apply 幂等**：同一 DSH 进程内重复挂载插件时，第二次 `apply()`
  直接跳过（日志 `apply skipped (duplicate)`），不再重复写自启、拉 HUD、
  建快捷方式；dispose 时从集合移除，正常 reload 不受影响。
- **P-15-2 discovery.port 类型**：`discovery.json` 的 `port` 由字符串改为数字
  （契约文档见 `docs/discovery-contract.md`）。

### Added

- `docs/discovery-contract.md`：discovery / control / ipc 三类文件的字段与兼容规则。

### Tests

- `plugin.test.mjs`: `apply skipped (duplicate)` 用例、`port` 类型断言。
- `plugin-ipc.test.mjs`: 双目录互踢回归（8 条）。
