# 运行环境与兼容性

本文说明 DSH HUD 在「别人的 Windows 电脑」上需要什么、`scripts/setup.mjs` 会准备什么，以及哪些差异无法自动适配、必须靠安装脚本或人工处理。

## 1. 支持矩阵

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 10 1809+ / Windows 11，x64 | Electron 44.7.0 的透明无边框窗口只在 Windows x64 上验证；不支持 ARM64 / 非 Windows |
| Node.js | >= 20（仅安装/构建/自检需要） | HUD 运行时使用打包 Electron 内置 Node；`setup.mjs` 会检查版本 |
| Electron | 44.7.0 | 由 `scripts/setup.mjs` 下载到 `<repo>/runtime/`，不要手工混用 45.x |
| PowerShell | Windows PowerShell 5.1+ | 仅「打开 DSH 桌面窗口」的置前助手和部分探测使用；受限环境会降级 |
| DSH 桌面版 | 0.2.x（当前验证 0.2.2-rc.1） | 内嵌的是 DSH Web UI；DSH 必须处于运行状态才能取得 token |
| 管理员权限 | **不需要** | Electron 解压、`config.local.json`、HKCU 登录项都在当前用户范围内 |
| 网络 | 首次安装需要 | 从 npm registry / npmmirror 下载 Electron；离线环境走手动 fallback |

> 只支持 Windows x64。macOS/Linux、Windows ARM64 不在当前支持范围。

## 2. 一键准备

在仓库根目录运行：

```bat
node scripts/setup.mjs
```

脚本会：

1. 检查 Node.js >= 20；
2. 检测 `<repo>/runtime/node_modules/electron/dist/electron.exe` 是否为 44.7.0；
3. 缺失时下载 Electron 44.7.0（npm registry 优先，失败回退 npmmirror；二进制固定走 `ELECTRON_MIRROR`）；
4. 写 `<repo>/config.local.json`（`electronPath` / `appDir` / `nodePath`）；
5. 做 `version` 文件和 `electron --version` 的 best-effort 校验，并打印后续步骤。

常用参数：

| 参数 | 作用 |
| --- | --- |
| `--offline` | 只检查，不下载；缺少 Electron 时给出可执行的手动指引并退出 |
| `--dry-run` | 只打印将要做的动作，不落盘 |
| `--force` | 重新下载/覆盖 runtime |
| `--help` | 参数说明 |

`config.local.json` 是本机配置，不随仓库提交。键名与 app/plugin 共用：`electronPath`、`appDir`、`nodePath`、`dshExe`（可省略，app 会探测 DSH 安装位置）。环境变量 `DSH_HUD_*` 的优先级高于该文件。

## 3. 无法自动适配 / 必须 setup 或人工处理

| 项目 | 现象 | 处理方式 |
| --- | --- | --- |
| 宿主子进程直接启动 Electron | DSH 宿主进程的受限/低完整性令牌下，Chromium 子进程在 `platform_channel.cc` 报 `拒绝访问 (0x5)`，退出码 `-2147483645`；这不是用户机常态 | 插件默认 `spawnApp=false`、`shellLaunch=false`；让 HUD 从登录 Startup 或双击启动。只有明确开启且宿主环境允许时才由插件拉起 |
| Startup 目录低完整性不可写 | HUD 以 Low IL 运行时写 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` 会失败 | 打包态用 `app.setLoginItemSettings`（HKCU Run）；开发态把写请求交给 Medium IL 的宿主插件经 `artifacts/ipc` 代写；都失败时由用户手动创建启动快捷方式 |
| Explorer 代启动需要人工确认 | `shellLaunch=true` 时插件生成 `.cmd` 交给 Explorer；Windows 可能弹出「是否允许此应用」 | 保留为 opt-in；文档明确告知需要用户点一次允许，不能静默自动化 |
| DSH 桌面安装路径 / 窗口标题 | 第三方安装位置和标题不受本项目控制 | `config.local.json` 的 `dshExe` 或 `DSH_HUD_DSH_EXE` 覆盖；探测不到时只降级「打开 DSH 桌面窗口」，不影响胶囊/对话 |
| DSH Web UI 的类名/结构升级 | 紧凑 CSS 依赖哈希类名（如 `widthHandle`、`drawerMask`） | 每次 DSH 升级后跑一次 `check-hud`/真机截图；失效时更新 `app/src/compact-css.js`，不要假设永久稳定 |
| 企业 GPO / 杀软 / SmartScreen | 禁用 HKCU Run、拦截未签名 exe | 文档说明自启失败判定和手动启动方式；未签名 exe 需用户选择「仍要运行」 |
| 混合 DPI / 多显示器 | 个别位置可能有 ±2 px 舍入差 | 代码用 DIP + workArea + 光标点；更换缩放后需真机复核拖动与吸附 |
| 全局热键被占用 | 注册失败只告警，不崩溃 | 修改用户数据目录下 `hotkey.json`，或继续用胶囊点击 |

## 4. 首次运行检查清单

1. `node scripts/setup.mjs` 退出码为 0，且 `<repo>/runtime/node_modules/electron/dist/electron.exe` 存在；
2. DSH 已启动，`%LOCALAPPDATA%\dsh-hud\discovery.json` 出现且 `updatedAt` 新鲜（插件每 15s 刷新）；
3. 双击 `DSH HUD.exe` 或运行 `app`，屏幕边缘出现胶囊；
4. 点击胶囊展开 520×720 面板，内嵌 Web UI 能发消息并收到流式回复；
5. 右键胶囊勾选「开机自启」，注销/重启后确认胶囊出现；
6. 若失败：先看 `%TEMP%\dsh-hud-plugin-diag.log`（可用 `DSH_HUD_DIAG_FILE` 覆盖）和 `%APPDATA%\DSH HUD\` 下的状态文件，再对照本文第 3 节。

## 5. 证据与边界

- 可移植性回归：`docs/portability-verify.md`。
- 已知未闭环：`app/scripts/launch-hud.cjs` 仍把 launcher 诊断日志写死到构建机路径；不影响启动，但换机后该日志会静默丢失，修复前不要把它当作排障证据。
- 本文件描述的是「源码/便携目录」运行方式；打包后的 exe 不再有 `<repo>` 概念，路径以 exe 所在目录和 `%APPDATA%\DSH HUD` 为准。
