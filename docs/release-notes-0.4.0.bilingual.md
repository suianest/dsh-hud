# DSH HUD 0.4.0 — 便携包换布局、首次运行自动装、应用内更新 / A tidier package, first-run setup, in-app updates

## 简体中文

### 这次最需要知道的一件事

**包里的 `DSH HUD.exe` 挪进了 `app\` 子目录**，别再双击根目录里的 exe（那里也没有了）。

请双击 **`DSH HUD.lnk`**，或者 `启动 DSH HUD.cmd`。它们会自动带好参数，双击 exe 会直接闪退——这是 Chromium 在没有参数时不工作，不是包坏了。

### 新增

- **应用内更新**：右键菜单 / 命令面板里的「检查更新」，只下载 `app.asar`（约 0.5 MB），校验后自动替换并重启。
- **首次运行自动装开机启动**：插件第一次找到便携版时会写好登录启动项；右键菜单里关掉后不会再装回来。
- **开始菜单快捷方式**：首次运行同时创建，Win 键搜「DSH HUD」就能打开。
- **外部扩展目录**：`<exe 同级>/extensions/*.js` 与 `%LOCALAPPDATA%\DSH HUD\extensions\*.js` 启动时加载，不用改源码重新打包。
- **面板右键菜单**：在面板任意位置右键 = 胶囊菜单。

### 改进

- 标题栏 48px + 发丝分隔线；按钮 28×28、按下缩放、键盘焦点环；内容区留白 12px。
- 命令面板：半透明背板、主题蓝选中条、底部快捷键提示、圆角 16px。
- 命令面板遮罩跟随窗口圆角裁切，不再有直角暗块。

### 修复

- 命令面板关不掉 / 误关（点空白不再关闭，只有 ⌘、Ctrl+K、Esc、执行命令）。
- 内嵌页左上角侧栏按钮被裁（C10）。
- 拖边缩放长按会持续变大。
- 首次启动浅色主题会闪一下深色。

### 下载与校验

- 附件：`DSH-HUD-0.4.0-win-x64.zip`（158,634,394 B，79 条目）
- SHA-256：`a02addbf2b05e2ac48a9f9007d6a6f0ebc0abd01038095a4fe9c876cf09d75bb`
- 同时上传 `app.asar`（502,096 B，SHA-256 `fb300c892781dbfc59b51b2a0268744118844c18e3fc4f9d77804d67c1eeeda9`），供应用内更新使用
- 校验：`certutil -hashfile DSH-HUD-0.4.0-win-x64.zip SHA256`

---

## English (plain words)

### One thing to know first

The `DSH HUD.exe` now lives inside the `app\` folder. Do **not** double-click the exe — there is none in the root anymore.

Double-click **`DSH HUD.lnk`** or `启动 DSH HUD.cmd` (the file name is Chinese; it just starts the app). Those add the flags the app needs. The bare exe quits right away without them — that is Chromium, not a broken download.

### Added

- **Check for updates** in the right-click menu / command palette: downloads only `app.asar` (~0.5 MB), verifies it, swaps it in and restarts.
- **Auto-run on first install**: the plugin writes the logon startup entry the first time it finds the portable build. Turning it off in the menu keeps it off.
- **Start Menu shortcut**: created on first run; search "DSH HUD" in the Start menu.
- **Extensions folder**: drop `*.js` into `<exe folder>/extensions/` or `%LOCALAPPDATA%\DSH HUD\extensions\` — no rebuild needed.
- **Right-click menu on the panel** — same menu as the capsule.

### Improved

- 48px title bar with a hairline, 28×28 buttons with press/focus states, 12px content inset.
- Command palette: dimmed backdrop, accent selection bar, shortcut hints, 16px radius.

### Fixed

- Palette would not close / closed by accident.
- Clipped sidebar toggle in the embedded page.
- Edge-drag resize kept growing while the button was held.
- First launch flashed dark before switching to the light theme.

### Download & verify

- Asset: `DSH-HUD-0.4.0-win-x64.zip` (158,634,394 B, 79 entries)
- SHA-256: `a02addbf2b05e2ac48a9f9007d6a6f0ebc0abd01038095a4fe9c876cf09d75bb`
- Also upload `app.asar` (502,096 B, SHA-256 `fb300c892781dbfc59b51b2a0268744118844c18e3fc4f9d77804d67c1eeeda9`) — the in-app updater downloads this one.
- `certutil -hashfile DSH-HUD-0.4.0-win-x64.zip SHA256`
