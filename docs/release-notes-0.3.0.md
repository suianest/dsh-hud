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
