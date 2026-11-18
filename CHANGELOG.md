# Changelog

本项目的重要变更记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)：

- 应用（`app/package.json`）在 `0.x` 阶段按语义版本递增；
- 插件（`plugin/package.json`）独立版本，改协议时双方 `protocolVersion` 必须对齐；
- 每个版本的条目在发版前写好，正文直接复制进 GitHub Release。

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
