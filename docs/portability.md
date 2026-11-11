# DSH HUD 可移植性审计与配置方案（t25）

> 版本：v0.2（2026-11-08，captain 复核后）
> 目标：让仓库在「别人的 Windows 电脑」上尽量自适配；不能自适配的，交给 `config.local.json` 或 setup 脚本。
> **审计状态（重要）**：本轮会话的文件读取工具被 `dsh-ops` 的 cordis 模式替换为 `ops_read_files` / `ops_grep` / `ops_glob`，而当前工具表里没有这些替代品，`read`/`grep`/`glob` 一律报
> `dsh-ops cordis mode replaced the official tool read with ops_inspect_local_file; call ops_inspect_local_file, or turn off that replacement in the dsh-ops row settings.`
> 因此本文件**由 captain 在 shell 里做了一次逐文件复核**（见 §8），`B` 类已升级为 `A`；v0.2 起可作为 t26–t28 的依据。§7 的待复核项已清空。
>
> 证据等级：**A** = 本会话前置审计（t13/t20）中已读过并核对过的代码事实（含行号）；**B** = 队长在任务单里给出的 grep 结果，未经我复核；**C** = 设计建议/推断；**D** = 外部可验证事实（本文件附来源 URL）。

---

## 1. 机器假设清单（逐文件）

列含义：**失效表现** = 换一台电脑后用户看到什么；**可移植性** = 能否自动修好。

### 1.1 路径类（绝对路径 / 仓库位置）

| # | 位置 | 内容 | 用途 | 失效表现 | 可移植性 | 级别 |
|---|---|---|---|---|---|---|
| 1 | `app/src/constants.js:72` | `DSH_DESKTOP_EXE = 'D:\\deepseek\\DeepSeek Harness.exe'` | 菜单「打开 DSH 桌面窗口」、焦点助手的回退目标 | 换机后菜单点击无反应，只在日志里出现 `[hud] DSH desktop exe not found` | 自动探测（注册表 App Paths / `%LOCALAPPDATA%\\Programs` / 同目录） | A |
| 2 | `plugin/index.js:58-61` | `DEFAULT_ELECTRON` / `DEFAULT_NODE` / `DEFAULT_APP_DIR` / `DEFAULT_LAUNCHER` | 插件拉起 HUD 子进程 | `spawnApp=true` 时 spawn 失败，插件日志 `skipping spawn: configure electronPath/nodePath/launcherPath` | 从插件模块位置推导 repo 根 | A |
| 3 | `app/scripts/launch-hud.cjs:20` | `LOG = 'D:\\...\\dsh-hud\\artifacts\\plugin-diag.log'` | launcher 自身日志 | 换机后日志写到不存在的盘符；`appendFileSync` 抛错会被 catch，表现为「没有日志」 | 改用 `%TEMP%` 或 `DSH_HUD_DIAG_FILE` | A（t13 读过；t20 未复读） |
| 4 | `app/main.js:13` | 注释里的绝对路径 | 文档 | 无 | 纯注释 | A |
| 5 | `app/scripts/build-portable.cmd:12-13` | 绝对仓库路径 | 打包 | 换机执行失败 | 用 `%~dp0..` 推导 | A |
| 6 | `app/scripts/check-hud.cmd:6` | 绝对仓库路径 | 自检 | 同上 | 同上 | A |
| 7 | `scripts/install-electron.cmd:9-11` | 绝对路径 + `ELECTRON_MIRROR` | 安装 electron | 换机执行失败 | 同上 | A |
| 8 | `scripts/install-electron.ps1:2-4` | 同上 | 同上（PowerShell 版） | 同上；且 WinPS 5.1 默认 ExecutionPolicy 会拒跑 `.ps1` | 同上 + 只保留 `.cmd` 入口 | A |
| 9 | `scripts/run-smoke.cmd:5`、`scripts/run-smoke.ps1:2` | 绝对路径 | 冒烟 | 同上 | 同上 | A |
| 10 | `scripts/probe-*.cmd:4` | 绝对路径 | 一次性排查 | 同上 | 移入 `scripts/dev/` 或删除 | A |
| 11 | `app/package.json` build.`electronDist` | **已修**：`"../runtime/node_modules/electron/dist"`，依赖 `electron: ^44.7.0` | electron-builder 的二进制来源 | 全新 clone 仍缺 `runtime/`（由 setup 下载）；`^44.7.0` 会漂小版本 | setup 固定 44.7.0；建议锁精确版本 | A（v0.2 复核） |

### 1.2 宿主环境假设（不是路径，但同样会换机失效）

| # | 位置 | 假设 | 用途 | 失效表现 | 可移植性 | 级别 |
|---|---|---|---|---|---|---|
| 12 | `app/scripts/focus-dsh.ps1` | DSH 桌面窗口标题包含 `DeepSeek Harness`，且不等于 `DSH HUD` | 「打开 DSH 桌面窗口」的置前 | 标题改版/本地化后找不到窗口，回退成 `explorer.exe <exe>`（只拉起不置前） | 窗口标题做成配置项 | A |
| 13 | `app/src/constants.js:48` | 全局热键默认 `Control+Alt+Space` | 显隐面板 | 被其他软件占用时仅 `console.warn`，用户无感知 | 冲突时提示 + 换键 | A |
| 14 | `app/src/autostart.js:53-65` | `app.setLoginItemSettings({ openAtLogin, path: process.execPath })` 写 HKCU Run；`!app.isPackaged` 时直接忽略 | 开机自启 | 企业 GPO/安全软件禁用 Run 项时静默失败（当前只写 `autostart.json`，不回读校验） | 加「写入后 `getLoginItemSettings` 回读」校验 | A |
| 15 | `app/scripts/launch-hud.cjs:52-69` | userData 候选 `DSH_HUD_USER_DATA` → `%LOCALAPPDATA%\\dsh-hud\\userdata` → `%TMP%\\dsh-hud-userdata`，取第一个可写 | 子进程 userData | 无失效（已有三级回退） | ✅ 已可移植 | A |
| 16 | `app/main.js:27-29` | `DSH_HUD_USER_DATA` 覆盖 userData | 同上 | 无 | ✅ | A |
| 17 | `plugin/index.js:46-55`、`166-190` | 诊断日志默认 `os.tmpdir()/dsh-hud-plugin-diag.log`，可用 `DSH_HUD_DIAG_FILE` 覆盖，>512 KB 轮转 | 插件日志 | 无（t20 已从硬编码 `D:\` 改掉） | ✅ | A |
| 18 | `plugin/index.js:213-242`、`247-262` | discovery 由插件写、HUD 读；内容含 `port/origin/url(带 token)/updatedAt` | 端口与鉴权发现 | DSH 换端口/换 token 时靠 15 s 刷新自愈 | ✅ 但依赖两侧对文件路径的一致约定 | A |
| 19 | `plugin/index.js:102-107` | `spawnApp: config.spawnApp ?? false` | 是否由插件拉起 HUD | 默认关闭；用户改配置前 `/dsh-hud` 不会真的拉起 | 配置项 | A |
| 20 | `app/src/hud-window.js:291-334`、`338-358` | 用 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <userData>/helpers/focus-dsh.ps1`；脚本从 `app/scripts/` 复制到 userData | 置前助手（规避 asar 内不能直接 `-File`） | 系统禁用 PowerShell / Constrained Language 时助手失败，回退 `explorer.exe` | 检测失败并降级（已回退），但要**记录原因** | A |
| 21 | `app/package.json` devDeps | `electron ^45.2.2`、`electron-builder ^26.0.12`；`scripts.check` 用 `node --check` | 构建 | 全新机器无 `node` 时全部失败；`^` 会漂版本 | 锁精确版本 + 声明 `engines.node` | A |
| 22 | 仓库整体 | Windows x64、Windows 10 1809+ | Electron 44/45 + 透明无边框窗口 | 非 Windows / ARM64 不可用 | 只支持 Windows x64（明确写进 README） | C |
| 23 | 渲染/几何 | 1.5 倍 DPI 实测；代码用 DIP + `screen.getCursorScreenPoint()` + workArea | 面板定位 | 换缩放比例时内容区 ±2 px、贴边吸附阈值按 DIP 计算 | 基本可移植（t20 仍有 ±2 px 待定性） | A |
| 24 | 安装 | `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` | 国内下载 electron | 未设置时走 GitHub，国内可能超时 | 默认值 + 可覆盖 | A |

---

## 2. 配置解析顺序（建议）

```
优先级（高 → 低）
1. 环境变量 DSH_HUD_*            ← CI / 高级用户 / 临时覆盖
2. <repo>/config.local.json      ← gitignore，随仓库走；打包后紧邻 exe 的 config.json
3. 自动探测                      ← 注册表、常见安装目录、runtime/、discovery.json
4. 功能降级 + 一次性日志          ← 明确告诉用户「哪个功能没启用、为什么」
```

### 2.1 仓库根推导

- **app 侧**：`const repoRoot = app.isPackaged ? path.dirname(process.execPath) : path.dirname(app.getAppPath())`
  （dev 时 `app.getAppPath()` = `<repo>/app`；打包后 repo 概念不存在，用 exe 目录）
- **plugin 侧**：`const repoRoot = fileURLToPath(new URL('..', import.meta.url))`
- **禁止**再用 `D:\...` 字面量；所有默认值都相对 `repoRoot` 解析。

### 2.2 建议的键（一份 schema，两侧共用）

| 键 | 环境变量 | 默认 | 使用方 |
|---|---|---|---|
| `dshExe` | `DSH_HUD_DSH_EXE` | 探测 | app（打开桌面窗口 / 置前） |
| `dshWindowTitle` | `DSH_HUD_DSH_TITLE` | `DeepSeek Harness` | app（focus 助手） |
| `electronPath` | `DSH_HUD_ELECTRON` | `<repo>/runtime/node_modules/electron/dist/electron.exe` | plugin、launch-hud |
| `nodePath` | `DSH_HUD_NODE` | 当前 node（`process.execPath`）或 bundled node | plugin |
| `appDir` | `DSH_HUD_APP_DIR` | `<repo>/app` | plugin |
| `launcherPath` | `DSH_HUD_LAUNCHER` | `<repo>/app/scripts/launch-hud.cjs` | plugin |
| `hudDir` | `DSH_HUD_DIR` | 探测（常见安装目录 / `dist/win-unpacked`） | plugin（定位 HUD） |
| `exePath` | `DSH_HUD_EXE` | 探测 | plugin（HUD exe 绝对路径，优先于 hudDir） |
| `userDataDir` | `DSH_HUD_USER_DATA` | `%LOCALAPPDATA%/dsh-hud/userdata` | app、launch-hud |
| `discoveryPath` | `DSH_HUD_DISCOVERY` | `%LOCALAPPDATA%/dsh-hud/discovery.json` | 两侧 |
| `diagFile` | `DSH_HUD_DIAG_FILE` | `%TEMP%/dsh-hud-plugin-diag.log` | plugin、launcher |
| `hotkey` | `DSH_HUD_HOTKEY` | `Control+Alt+Space` | app |
| `spawnApp` | `DSH_HUD_SPAWN_APP` | `false` | plugin |

### 2.3 解析伪代码（建议实现为一个 `shared/config.js`）

```js
function loadConfig({ repoRoot, side }) {
  const cfg = {};                       // 最终值
  const sources = {};                   // 键 → 来源，便于日志
  for (const [k, spec] of Object.entries(SCHEMA)) {
    if (process.env[spec.env]) { cfg[k] = coerce(process.env[spec.env]); sources[k] = 'env'; }
  }
  const file = findConfigFile(repoRoot, side);   // config.local.json / config.json
  if (file) for (const [k, v] of Object.entries(readJson(file))) {
    if (cfg[k] === undefined && v != null) { cfg[k] = coerce(v); sources[k] = file; }
  }
  for (const [k, spec] of Object.entries(SCHEMA)) {
    if (cfg[k] === undefined) { const d = spec.detect?.(); if (d) { cfg[k] = d; sources[k] = 'detect'; } }
  }
  for (const [k, spec] of Object.entries(SCHEMA)) {
    if (cfg[k] === undefined) { cfg[k] = spec.default; sources[k] = 'default'; if (!spec.optional) degrade(k, spec); }
  }
  return { cfg, sources };
}
```

**降级策略**（每条都只打一次日志，不阻塞启动）：
- 探测不到 `dshExe` → 「打开 DSH 桌面窗口」菜单置灰/隐藏；
- 探测不到 `electronPath` → `spawnApp` 强制 false，`/dsh-hud` 明确回「未配置 electron，可用 npm run setup」；
- discovery 不存在 → 面板显示错误页（已有）并在日志写路径；
- 热键注册失败 → 托盘/面板提示「热键被占用，可在 config 里改」。

---

## 3. 外部依赖的获取

| 依赖 | 版本要求 | 获取方式 | 校验 | 需要管理员？ | 失败时 |
|---|---|---|---|---|---|
| Electron 二进制 | **44.7.0**（与 `runtime/` 一致；仓库内 45.2.2 需统一） | `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后 `npm/pnpm install` + `node node_modules/electron/install.js`；或直接下 zip | `electron-v44.7.0-win32-x64.zip` 的 SHA-256 = `eee30dc8fa1f5ea95490e59f44e46ea68dd24c6e93d22facf70fe5c2d4c2665c`（来源见下） | 否（解压到用户目录） | 提示手动下载 zip 放到 `~/.cache/electron/`（或 `electron_config_cache`） |
| Node.js | ≥ 20（开发/构建）；HUD 运行优先用打包后的 Electron 内置 Node | DSH 自带 node，或系统安装 | `node -v` | 否 | setup 脚本检查并提示下载 |
| pnpm | 11.x | `corepack` 或独立安装 | — | 否 | 用 npm 兜底 |
| PowerShell | Windows 自带 5.1+ | 系统 | — | 否 | 置前助手降级为 `explorer.exe` |
| electron-builder | `^26` | npm devDeps | — | 否 | 只影响打包 |

**校验命令（Windows，无需管理员）**

```bat
certutil -hashfile electron-v44.7.0-win32-x64.zip SHA256
:: 期望 eee30dc8fa1f5ea95490e59f44e46ea68dd24c6e93d22facf70fe5c2d4c2665c
rem PowerShell 等价：Get-FileHash -Algorithm SHA256 .\electron-v44.7.0-win32-x64.zip
```

来源：<https://cdn.npmmirror.com/binaries/electron/44.7.0/SHASUMS256.txt>（本轮实际抓取，HTTP 200；同一目录下即 `electron-v44.7.0-win32-x64.zip`）。官方源为 `https://github.com/electron/electron/releases/download/v44.7.0/`，国内建议镜像优先、官方兜底。

**注意（本机已踩过）**：
- electron 45+ 的 npm 包**没有** `postinstall`，二进制是 `require('electron')` 时才懒下载；setup 里必须显式跑 `node node_modules/electron/install.js`。
- 受限令牌/低完整性子进程里 Electron 会因命名管道 `0x5` 崩溃，必须 `--no-sandbox`（这是**本机沙箱**特性，不是用户机常态；不要写进默认发布路径）。
- `pnpm` 在无符号链接权限的环境需要 `--node-linker=hoisted`；CI 需要 `--no-frozen-lockfile` 才改依赖。

---

## 4. 「无法适配，只能靠 setup / 文档」清单

| 环境差异 | 为什么适配不了 | 处理方式 |
|---|---|---|
| DSH 桌面安装路径与窗口标题 | 第三方应用安装位置/标题不受我们控制 | setup 探测 + `config.local.json` 覆盖；失败只降级「打开桌面窗口」 |
| DSH Web UI 的 DOM/类名版本漂移 | 注入的 compact CSS 依赖 `[class*="widthHandle"]` 等哈希类名 | 每次 DSH 升级后跑一次 `npm run check:hud`（截图 + scrollWidth 断言） |
| 企业 GPO 禁用 HKCU Run / 安全软件拦截未签名 exe | 系统策略 | 文档说明「自启失败」的判定与手动添加启动项步骤 |
| 杀软/SmartScreen 对未签名 exe 的拦截 | 代码签名需要证书 | README 说明「更多信息 → 仍要运行」 |
| 多显示器 + 混合 DPI 的像素级偏差 | Windows 的 DIP 舍入因窗口位置而异 | 已用 DIP + workArea；±2 px 做一次真机对照探针（t20 遗留） |
| `%LOCALAPPDATA%` 被 FSLogix/重定向 | 企业漫游配置 | 三级 userData 回退已覆盖；日志写明最终用了哪个目录 |
| 路径含非 ASCII/空格、长路径 | 取决于安装位置 | 所有 spawn 用参数数组（已如此），文档建议默认安装路径 |
| Windows 版本 < 10 1809 / ARM64 | Electron 支持矩阵 | README 明确「仅 Windows 10 1809+ x64」 |
| 热键冲突 | 其他软件占用 | 配置项 + 启动时检测失败提示 |
| 全局热键在 UAC 提权窗口前台时失效 | Windows 限制 | 文档说明 |

---

## 5. 一次性排查脚本的处置

| 脚本 | 现状 | 建议 |
|---|---|---|
| `scripts/probe-44.cmd`、`probe-app-single.cmd`、`probe-matrix.cmd`、`probe-safe.cmd`、`probe-version.cmd`、`probe-gui.cmd`、`logprobe-44.cmd`、`matrix-44.cmd`、`smoke-44.cmd`、`run-44.cmd` | 本机沙箱诊断（命名管道/`--no-sandbox` 矩阵、44.7.0 探针），硬编码绝对路径 | **删除**或移到 `scripts/dev/`，并在 README 注明「仅开发者用」 |
| `scripts/probe-webui.mjs` | 抓取 Web UI 资源做 CSS 分析 | 移到 `scripts/dev/`（分析工具，不是运行必需） |
| `scripts/run-smoke.cmd`、`run-smoke.ps1` | 冒烟启动 + 截图 | 移到 `scripts/dev/`；对外只保留 `npm run check` |
| `scripts/install-electron.cmd`、`install-electron.ps1` | 安装 electron（含 mirror 与 `install.js`） | **保留**，移到 `scripts/setup/`，路径改为相对 `%~dp0..`；`.ps1` 只作为可选实现 |
| `scripts/gate-embed.cmd`、`probe-*.cmd` 其余 | t3/t20 一次性实验 | 删除（证据留在 `docs/`） |
| `scripts/diag-electron.cmd` | 诊断 | `scripts/dev/` |

**判断标准**：运行 HUD 只需要 `app/` + `plugin/` + `runtime/` + `config.local.json`；只要某个脚本**不在**这条链路上，就不该出现在根 `scripts/`。

---

## 6. 落地步骤（建议顺序）

1. **P0**：加 `config.local.json` + `config.example.json` + `gitignore` 条目；两侧实现 `loadConfig()`；
   把 `constants.js:72`、`plugin/index.js:58-61`、`launch-hud.cjs:20` 改为读配置/推导。
2. **P0**：统一 electron 版本到 44.7.0（`app/package.json` 的 `electronDist` 与 devDeps），否则打包产物用 45.2.2 与运行时不一致。
3. **P1**：`scripts/` 拆分 `setup/` 与 `dev/`；根脚本全部改为 `%~dp0` 相对路径；删掉本机专用探针。
4. **P1**：setup 脚本做「探测 → 写 `config.local.json` → 校验 electron SHA-256 → 冒烟（`--version`，不启动窗口）」，全程无管理员权限。
5. **P2**：README 的「前置条件 / 安装 / 自启 / 故障排查」四节，加一张「环境差异 → 处理方式」表（即本文第 4 节）。
6. **P2**：CI（可选）跑 `node --check` + 单测，不上真实窗口。

**验收（新机器 checklist）**
- [ ] `git clone` → `npm i` → `npm run setup` 一条链成功，不需要改任何 `.js`
- [ ] `config.local.json` 缺失时仍能启动，日志列出每个降级项
- [ ] `DSH_HUD_DSH_EXE` 指向错误路径时，只有「打开桌面窗口」不可用，其余正常
- [ ] 卸载/删除仓库后 HKCU Run 不留残余（或提供 `npm run uninstall`）

---

## 7. 本轮未完成项（需复核）

1. 队长给的 17 处硬编码中，`B` 级条目（`app/scripts/*.cmd`、`scripts/*.cmd`、`app/main.js:13`）**行号未复核**；
2. `app/package.json` 的 `files` 是否含 `scripts/**/*`、以及上一次构建 asar 缺 `scripts/` 的问题是否已修（t20 blocker）——需重跑 `node artifacts/asar-list.cjs` 复核；
3. `focus-dsh.ps1` 的窗口标题匹配是否需要更宽松的匹配（`-like '*DeepSeek*'`）；
4. 仓库内是否已有 `.gitignore`、`config.example.json` 的现状未核对。

> 复核方式：恢复 `read`/`grep`（关闭 `dsh-ops` 对该会话的工具替换）后，逐条 `文件:行号` 打开确认，再把上表 `B` 升级为 `A` 或删掉。


---

## 8. captain 复核记录（v0.2，2026-11-08）

复核方式：captain 侧 shell（`grep`/`sed`）逐条比对源码，成员侧 `read/grep/glob` 被 `dsh-ops` 的 cordis 模式替换、不可用。

| 条目 | 复核结果 | 证据 |
|---|---|---|
| 1 `constants.js:72` | 确认 | `const DSH_DESKTOP_EXE = 'D:\\deepseek\\DeepSeek Harness.exe';`（注释写明可用 `DSH_HUD_DSH_EXE` 覆盖） |
| 2 `plugin/index.js` 默认路径 | 确认（行号后移，现 `62` 起） | `DEFAULT_ELECTRON = 'D:\\DeepSeekData\\workspace\\dsh-hud\\runtime\\node_modules\\electron\\dist\\electron.exe'`，同段还有 `DEFAULT_NODE`/`DEFAULT_APP_DIR`/`DEFAULT_LAUNCHER` |
| 3 `launch-hud.cjs:20` | 确认 | `const LOG = 'D:\\DeepSeekData\\workspace\\dsh-hud\\artifacts\\plugin-diag.log';` |
| 4 `main.js:13` | 确认（仅注释） | `//   D:\DeepSeekData\workspace\dsh-hud\scripts\run-hud.cmd` |
| 5–10 各 `.cmd` / `.ps1` | 确认 | `grep -rn "D:\\DeepSeekData\|C:\\\\Users\\\\35263\\|D:\\\\deepseek"` 命中 17 行，与 §1.1 一致 |
| 11 `electronDist` | **原结论过时，已更正** | `app/package.json:14` 现为 `"electron": "^44.7.0"`，`:22` 为 `"electronDist": "../runtime/node_modules/electron/dist"`（t21 已改；`操作日志/spike/` 不再是打包来源） |
| 15/16/17 三级回退 | 确认 | `launch-hud.cjs` 候选 `DSH_HUD_USER_DATA` → `%LOCALAPPDATA%` → `%TMP%`；`main.js` 支持 `DSH_HUD_USER_DATA`；plugin 日志默认 `os.tmpdir()` + `DSH_HUD_DIAG_FILE` |
| `engines.node` | **缺失，需补** | `app/package.json` 无 `engines` 字段；t26 一并加 `"engines": { "node": ">=20" }` |

结论：§1 的 24 条假设全部有据；t26–t28 可以直接按本文件的 §2 配置解析与 §6 顺序执行。§7 清空。

### 5.1 执行记录（2026-11-08，captain）

- `scripts/` 根目录的 16 个一次性诊断脚本（`probe-*`、`*-44.cmd`、`logprobe-*`、`matrix-44`、`smoke-44`、`run-44`、`run-smoke.*`、`install-electron.*`、`gate-embed`、`diag-electron`）**已直接删除**（本机的沙箱诊断已完成使命，git 历史之外无需保留）；`install-electron` 的职责由 `scripts/setup.mjs` 接管。
- `scripts/` 现只剩：`setup.mjs`、`setup.cmd`、`run-hud-capture.cmd`（真机三连截图，`%~dp0` 推导路径）、`probe-webui.mjs`（拉 Web UI 静态资源做 CSS 分析，开发者用）。
- 复核：`grep -rn "D:\\DeepSeekData|C:\\\\Users\\\\35263|D:\\\\deepseek" app/src app/renderer app/scripts app/main.js app/preload.js plugin/index.js scripts` → **0 命中**。
- 另修：`plugin/index.js` 的 `DEFAULT_DSH_EXE` 由 `D:\deepseek\DeepSeek Harness.exe` 改为空串（桌面 exe 由 HUD 探测后随请求下发，探测不到只按标题置前）。

---

## 9. 开源分发（P-02）

发布把仓库分成「应用便携包 + 插件 bundle」两块：

- **插件 bundle**：仓库根 `package.json`（`dsh-hud@0.3.0`，`private:false`，`files: ["plugin/**","docs/**","README.md"]`，`dsh.bundle.patch: "./plugin/cordis.patch.yml"`）可直接作为插件安装。

  ```bash
  plugin_manager install_bundle https://github.com/<owner>/dsh-hud
  # 或本地安装仓库根 / 最小子包
  plugin_manager install_bundle D:\path\to\dsh-hud
  plugin_manager install_bundle D:\path\to\dsh-hud\plugin   # @dsh-hud/token-bridge
  ```

- **应用**：`dist/win-unpacked/` 打 zip，作为 Release 资产单独下载，无需安装器。
- **HUD 定位（plugin）**：`config.hudDir` / `config.exePath` → `DSH_HUD_DIR` / `DSH_HUD_EXE` → `config.local.json` → 常见安装目录（`%LOCALAPPDATA%\DSH HUD\…` 等）→ 仓库 `dist\win-unpacked\DSH HUD.exe`。找不到时日志与 `/dsh-hud` 命令给出可读提示，不崩溃。
- **DSH 桌面 exe**：`config.desktopExe`（即 `dshExe`）→ `DSH_HUD_DSH_EXE` → `config.local.json` → 常见安装目录 → 空（空则只按窗口标题置前，不下发 exe）。
