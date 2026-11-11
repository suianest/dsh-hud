# DSH HUD

Windows 常驻悬浮胶囊 + 520px 紧凑面板（豆包式）。点胶囊或按全局热键即可直接对话——面板内嵌整套 DSH Web UI，不用切回浏览器。

技术栈：Electron（44.7.0，随包分发）+ 一个很薄的 Cordis 插件（写发现文件、开机自启、IPC 桥）。

---

## 两种形态

| | 形态 A · 便携版 | 形态 B · DSH 插件形态 |
|---|---|---|
| 用户看到什么 | 一个解压目录，双击 `DSH HUD.lnk` | DSH 里多一个插件；登录后胶囊自己出现，**桌面没有快捷方式** |
| 需要准备 | 应用包（zip） | 应用包（zip）+ 在 DSH 里装插件 |
| 怎么起来 | 双击快捷方式 / 开机自启 | 插件写登录启动项（或 `/dsh-hud show`） |
| 插件是否必需 | 是（否则面板连不上 DSH，显示错误页） | 是 |

> 注意：**两种形态都需要本地有一份应用包**。插件运行在 DSH 的宿主进程里，它拉起 Electron 会被系统拒绝（这也是为什么默认关闭自动拉起）。所以“插件形态”指的是**装完就不用管快捷方式**，不是“只有插件就能跑”。

---

## 形态 A · 便携版（最简单）

1. 获取 `DSH-HUD-<版本>-win-x64.zip`（Release 或本地 `make-portable` 产物），解压到任意目录。
2. **双击 `DSH HUD.lnk`** 或 `启动 DSH HUD.cmd`。
3. 屏幕边缘出现胶囊即成功；右键胶囊 → 勾选「开机自启」。

> ⚠️ **不要双击 `DSH HUD.exe`**。它必须带 `--no-sandbox --user-data-dir=…` 才能在这类环境下启动，零参数会在 Chromium 初始化阶段直接崩（`0x80000003`，连日志都来不及写）。快捷方式里已经写好参数。见 `操作日志/待解决问题.md` 的 P-06。

---

## 形态 B · DSH 插件形态（无桌面快捷方式）

1. 同上解压应用包到任意目录（例如 `%LOCALAPPDATA%\DSH HUD`），**不需要建任何快捷方式**。
2. 在 DSH 里安装插件：
   ```bash
   # DSH 插件管理界面填仓库地址，或等价命令
   plugin_manager install_bundle https://github.com/<owner>/dsh-hud
   # 本地目录安装
   plugin_manager install_bundle D:\DeepSeekData\workspace\dsh-hud
   # 只装最小子包
   plugin_manager install_bundle D:\DeepSeekData\workspace\dsh-hud\plugin
   ```
3. 插件负责：写 `%LOCALAPPDATA%\dsh-hud\discovery.json`（每 15s 刷新）、按配置写登录启动项、处理 `/dsh-hud` 命令与 IPC 桥。
4. 重新登录一次（或 `DSH_HUD` 就绪后手动跑 `/dsh-hud show`），胶囊出现，之后完全不用碰快捷方式。

插件定位应用包的顺序：`config.hudDir` / `config.exePath` → 环境变量 `DSH_HUD_DIR` / `DSH_HUD_EXE` → `config.local.json` → 常见安装目录（`%LOCALAPPDATA%\DSH HUD\…`）→ 仓库 `dist\win-unpacked\DSH HUD.exe`。都找不到时在日志和 `/dsh-hud` 里给出可读提示，不会崩。

---

## 首次配置：发现文件

面板靠**发现文件**找到正在运行的 DSH 服务，由插件写入：

```json
// %LOCALAPPDATA%\dsh-hud\discovery.json
{ "pid": 1234, "port": "50265", "url": "http://127.0.0.1:50265/?token=…", "updatedAt": "…" }
```

- `url` 带一次性 `?token=`，HUD 用它换鉴权 cookie，之后自动切回无 token 的干净地址。
- 插件每 15s 原子刷新；DSH 退出时删除。
- 插件没装 / DSH 没起时，面板显示自绘错误页，带「重试」「启动 DSH」两个按钮，并每 5s 自动重连一次（最多约 2 分钟）。

---

## 使用

| 操作 | 效果 |
| --- | --- |
| 点击胶囊 | 展开 520×720 面板 |
| `Ctrl+Alt+Space` | 全局热键，展开 / 收起 |
| `Ctrl+K` 或面板标题栏 ⌘ 按钮 | 命令面板（可搜索的动作列表） |
| 拖动胶囊 / 面板标题栏 | 移动窗口，胶囊松手后吸附屏幕边缘（留 8px） |
| 拖面板左/右/上/下边缘 | 按住拖动改宽高（不按不动，不会自己长） |
| 面板「—」按钮 / `Esc` | 收起为胶囊 |
| 右键胶囊 | 打开 DSH 桌面窗口 / 打开 DSH 浮窗 / Token 补充 / 退出 DSH 浮窗 / 开机自启 |

- **面板失焦默认不收起**（想恢复旧行为：`DSH_HUD_BLUR_COLLAPSE=1`）。
- 位置（胶囊与面板各自）记在用户数据目录，下次启动沿用；多屏 / DPI 变化会重新钳位。
- 内嵌页有完整输入框，直接对话即可（流式）。

---

## 目录结构

```
dsh-hud/
├─ app/                     # Electron 应用本体
│  ├─ main.js               # 单实例锁 / userData / 启动探针 / 扩展加载
│  ├─ preload.js            # shell 的 contextBridge（拖拽/收起/命令面板/缩放）
│  ├─ src/
│  │  ├─ hud-window.js      # 单窗口双态状态机 + 菜单 + 缩放 + 主题
│  │  ├─ web-embed.js       # WebContentsView 内嵌 DSH Web UI
│  │  ├─ discovery.js       # 读 discovery.json
│  │  ├─ compact-css.js     # 520 紧凑 CSS 注入
│  │  ├─ extensions.js      # 扩展点（菜单/控制动作/CSS/外部扩展目录）
│  │  ├─ hotkeys.js         # 全局热键
│  │  ├─ autostart.js       # 开机自启（写 Startup 脚本）
│  │  └─ constants.js       # 尺寸/阈值
│  ├─ renderer/             # shell 界面（胶囊 / 面板 / 命令面板）
│  └─ scripts/              # run / check / build / make-icon
├─ plugin/                  # Cordis 插件（discovery / IPC 桥 / autostart / 命令）
├─ scripts/                 # setup.mjs（一键环境）、run-hud-capture.cmd、probe-webui.mjs
├─ tests/e2e/               # 单元与集成测试
├─ docs/                    # 设计、发布、可移植性、扩展说明
├─ 操作日志/                # 一次性取证与实验归档（不入库）
└─ dist/                    # 打包产物（make-portable.js）
```

---

## 开发

```bash
node scripts/setup.mjs          # 检查 Node、下载 Electron 44.7.0、写 config.local.json
node tests/e2e/unit/hud-window.test.cjs   # 单测（--test-force-exit）
node app/scripts/make-portable.js         # 打包到 dist/win-unpacked + zip + 快捷方式
```

跑测试用 `node --test --test-force-exit tests/e2e/unit/`，否则 `main-boot` 会因残留句柄不退出。

---

## 已知限制

- 这台机器（Win11 25H2）上必须带 `--no-sandbox` 启动；快捷方式 / 启动脚本已内置，直接双击 exe 会崩。
- 双屏、跨 DPI（100% ↔ 150%）缩放尚未真机验证。
- 打包为纯 JS 兜底（沙箱里 electron-builder 的 spawn 会被拒），exe 未嵌图标/版本资源。
- 插件从 DSH 宿主直接拉起 Electron 不可行（系统拒绝），所以插件形态靠登录自启；`spawnApp` / `shellLaunch` 默认关闭。

## 许可证

MIT，见 [LICENSE](LICENSE)。
