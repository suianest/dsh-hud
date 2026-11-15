# DSH HUD v0.3.0

为 DeepSeek Harness 做的 Windows 桌面浮窗：**一颗鲸鱼胶囊常驻桌面，点开就是 520×720 的 DSH 对话面板**，面板里嵌的就是 DSH Web UI 本体（同一份服务端、同一套插件与主题）。

## 亮点

- **胶囊即入口** —— 64×64 鲸鱼圆标常驻，悬停沿鲸鱼轮廓走一圈蓝光，单击展开面板，再点收起
- **面板内嵌 DSH Web UI** —— 不是仿制界面，是同一个 web UI；DSH 里装的主题、插件在面板里照常生效
- **主题跟随** —— 内嵌页切深色/浅色，外壳配色跟着变
- **命令面板** —— 标题栏 ⌘ 或 `Ctrl+K`，动作来自右键菜单 + 扩展点，可自己注册
- **拖边改尺寸** —— 按住左/右/上/下边缘拖，最小 520×420，展开时按需加宽
- **右键菜单** —— 打开 DSH 桌面窗口 / 打开 DSH 浮窗 / Token 补充 / 退出 / 开机自启
- **插件形态** —— Cordis 插件自动定位 HUD、写发现文件、提供 `/dsh-hud show|hide|toggle|reload` 与 IPC 桥（宿主进程负责把 DSH 桌面窗口顶到前台）

## 安装

### 1. 拿到应用包

下载本 Release 的 `DSH-HUD-0.3.0-win-x64.zip`（约 151 MB），解压到任意目录，例如 `D:\Apps\DSH HUD\`。

> **不要双击 `app\DSH HUD.exe`**。0.3.0 的便携包需要 `--no-sandbox` 与专属 user-data 目录才能启动，
> 双击 exe 在部分机器上会静默退出（Chromium 在 JS 之前就退出，日志里是 `0x80000003`）。
> 正确入口是解压目录里的 **`DSH HUD.lnk`**（或 `启动 DSH HUD.cmd`）。

### 2. 启动

双击 `DSH HUD.lnk`，桌面右下角出现鲸鱼胶囊。
右键胶囊 → 勾选 **开机自启**，之后登录自动出现。

### 3. 装 DSH 插件（可选，但推荐）

插件负责把 HUD 和 DSH 连起来：写 `discovery.json`（带 token 的 Web UI 地址）、提供 `/dsh-hud` 命令、把 DSH 桌面窗口顶到前台。

在 DSH 里 **添加插件**，填以下任意一种：

```text
github:suianest/dsh-hud
```

或者指向解压后仓库的本地目录（`plugin/` 或仓库根）。

装好后 `/dsh-hud toggle` 可以开合浮窗；DSH 重启后插件会自动刷新 discovery，HUD 会自动重连。

## 校验

```powershell
certutil -hashfile DSH-HUD-0.3.0-win-x64.zip SHA256
```

应为：

```text
9b6506fee02cc496bc31dc06250e2e8f29092d47af55e66d18a5854b6a61e059
```

## 已知限制

- **Windows 10/11 x64**；需要 WebView2 运行时（Win11 自带，Win10 通常已由 Edge 安装）
- 未做代码签名，首次运行 SmartScreen 可能提示「更多信息 → 仍要运行」
- 双屏 / 跨 DPI 缩放场景尚未系统测试（已知限制，欢迎 issue）
- 便携包不含 electron-builder 的完整安装器；如需要 NSIS 安装包请提 issue

## 反馈

- Bug: <https://github.com/suianest/dsh-hud/issues/new?template=bug_report.md>
- 功能建议: <https://github.com/suianest/dsh-hud/issues/new?template=feature_request.md>

---

**完整改动**：见 [CHANGELOG.md](https://github.com/suianest/dsh-hud/blob/main/CHANGELOG.md)


---


A small floating window for DeepSeek Harness on Windows. A whale capsule sits on your desktop. Click it and you get a 520×720 chat panel. The panel is the real DSH web UI — same server, same plugins, same themes.

## What you get

- **The capsule is the door** — a 64×64 whale icon stays on your desktop. Hover it and a blue light runs around the whale outline. Click to open the panel, click again to close it.
- **Real DSH web UI inside** — not a copy of the interface. It is the same web UI. Themes and plugins you installed in DSH work here too.
- **Follows the theme** — when the page goes dark or light, the window colors follow.
- **Command palette** — press `Ctrl+K` (or the ⌘ button in the title bar). The list comes from the right-click menu plus the extension points, so you can add your own entries.
- **Drag the edges to resize** — grab the left, right, top or bottom edge. The smallest size is 520×420.
- **Right-click menu** — open the DSH desktop window / open the floating panel / top up token / quit / start at login.
- **Plugin form** — the Cordis plugin finds the HUD by itself, writes a discovery file, and gives you `/dsh-hud show|hide|toggle|reload`. It also has an IPC bridge, so the DSH host process can bring the DSH desktop window to the front.

## Install

### Step 1: get the app

Download `DSH-HUD-0.3.0-win-x64.zip` from this release (about 151 MB). Unzip it anywhere, for example `D:\Apps\DSH HUD\`.

> **Do not double-click `DSH HUD.exe`.** The portable build needs `--no-sandbox` and its own user-data folder to start. On some machines a plain double-click quits right away with no window and no error (Chromium exits before any app code runs; the event log shows `0x80000003`).
> Use **`DSH HUD.lnk`** in the unzipped folder instead (or `启动 DSH HUD.cmd` — the file name is Chinese, it just starts the app).

### Step 2: start it

Double-click `DSH HUD.lnk`. The whale capsule shows up at the bottom right of your screen.
Right-click the capsule and tick **start at login** if you want it every time.

### Step 3: install the DSH plugin (optional, but recommended)

The plugin connects the HUD to DSH: it writes `discovery.json` (the web UI URL with a token), adds the `/dsh-hud` command, and brings the DSH desktop window to the front.

In DSH, open **Add plugin** and enter one of these:

```text
github:suianest/dsh-hud
```

Or point it at the local repo folder (`plugin/`, or the repo root).

After that, `/dsh-hud toggle` opens and closes the panel. When DSH restarts, the plugin refreshes discovery and the HUD reconnects by itself.

## Check the download

```powershell
certutil -hashfile DSH-HUD-0.3.0-win-x64.zip SHA256
```

It should print:

```text
9b6506fee02cc496bc31dc06250e2e8f29092d47af55e66d18a5854b6a61e059
```

## Known limits

- **Windows 10/11 x64 only.** The WebView2 runtime is needed. Windows 11 has it. Windows 10 usually got it from Edge.
- The build is not code-signed. Windows SmartScreen may warn you the first time — pick "More info → Run anyway".
- Two monitors and mixed DPI scaling are not tested yet. Known limit, issue reports welcome.
- This is a portable zip, not a full installer. If you want an NSIS installer, open an issue.

## Feedback

- Bug: <https://github.com/suianest/dsh-hud/issues/new?template=bug_report.md>
- Feature idea: <https://github.com/suianest/dsh-hud/issues/new?template=feature_request.md>

---

**Full change list**: see [CHANGELOG.md](https://github.com/suianest/dsh-hud/blob/main/CHANGELOG.md)
