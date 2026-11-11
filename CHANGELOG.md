# Changelog

本项目的重要变更记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)：

- 应用（`app/package.json`）在 `0.x` 阶段按语义版本递增；
- 插件（`plugin/package.json`）独立版本，改协议时双方 `protocolVersion` 必须对齐；
- 每个版本的条目在发版前写好，正文直接复制进 GitHub Release。

## [Unreleased]

### Added

- 外部扩展目录（P-03，`docs/extending.md`）：`<exe>/extensions/*.js` 与
  `%LOCALAPPDATA%\DSH HUD\extensions\*.js` 启动时自动加载，支持函数式与
  `activate(api)` 两种导出、`protocolVersion` 校验、`DSH_HUD_NO_EXTENSIONS=1` 关闭。
- `make-portable.js` 现在会额外产出 `dist/DSH-HUD-<version>-win-x64.zip`（`--no-zip` 可跳过），
  打 zip 前会临时摘掉 IPC junction，避免把仓库目录卷进包里。
- 发布文档：`docs/release.md`、`.github/ISSUE_TEMPLATE/` 两个模板、本文件。

### Changed

- 首次启动且没有 `theme.json` 缓存时，用系统浅/深色偏好作为初始主题（L1：不再先画深色再闪成浅色）。
- `plugin.test.mjs` 的临时目录清理改为对 `ENOTEMPTY/EBUSY/EPERM` 退避重试（M1：消掉偶发红）。
- 单测命令统一加 `--test-force-exit`：`main-boot` 用例结束后仍有 stdin/文件监听句柄，
  进程不自己退出（不影响被测行为，只影响 CI 的退出码）。
- 命令面板快捷键改为切换：再按一次 Ctrl+K 收起（此前只能打开）。

- 回退 660×900 鲸鱼边框实验：面板恢复 520×720，窗口尺寸、卡片圆角、透明外边距一并还原，
  字号与间距回到 0.3.0 的取值（`app/src/constants.js`、`app/renderer/hud.css`）。

### Fixed

- 拖动：鼠标在窗口外释放时收不到 `mouseup`，窗口会一直跟随光标；现在按 `MouseEvent.buttons`
  判定按键已松开并结束拖动（`app/renderer/hud.js` 的 `mousemove` 处理器）。
- 拖动：按钮上的 `mousedown` 冒泡进拖拽处理器，按住「收起 / 关闭」移动会意外拖动窗口，
  单击也可能留下未闭合的拖拽会话；现在只在非交互子元素上启动拖动，面板标题栏交给原生
  `-webkit-app-region: drag`，手动拖拽只绑胶囊图标。

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
