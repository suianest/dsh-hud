# 通过 npm 包名一键安装（流程摸底）

> 状态：**已发布 0.5.0**（2026-11-16，<https://www.npmjs.com/package/dsh-hud-capsule>）。本文记录整条链路、staged publishing 的坑和验证结果。

## 目标

在 DSH 的「添加插件」里填一个包名 → 安装完重启 DSH → 胶囊出现，全程不用手动下载 150 MB 的包、不用设置路径。

## 为什么不能直接填 `suianest/dsh-hud`

`app.asar` 里的 `parseInstallSpec()` 只认三类输入：

| 输入 | 判定 | 说明 |
|---|---|---|
| 绝对路径，如 `D:\...\dsh-hud\plugin` | `kind:"path"` | 本地目录安装（现在能用） |
| `github:` / `git:` / `git@` / `https://host/user/repo` | `kind:"git"` | 需要机器上有 `git` 可执行文件 |
| 其他（不含 `/`，或以 `@scope/` 开头） | npm 包名 | 走 registry + 镜像 |

`suianest/dsh-hud` 三条都不满足（不是绝对路径、没有 `github:` 前缀、又不是合法 npm 名），所以点「安装」不会有结果。

## 整条链路（发布后）

```
DSH「添加插件」填包名
       │
       ▼
pnpm add <包名>  → 装进 profile 的 node_modules
       │            （包内只有 plugin/，约 30 KB）
       ▼
DSH 重启 → Cordis 按 package.json 的 dsh.bundle.patch 插入插件
       │
       ▼
插件 apply()：
  1. 找 HUD：%LOCALAPPDATA%\DSH HUD\app\DSH HUD.exe 等候选位置
  2. 找不到 → 首次自动从 GitHub Release 下载 zip
     · 读 api.github.com/repos/suianest/dsh-hud/releases/latest
     · 校验 asset.size 与 sha256（digest 字段）
     · Expand-Archive 解压到 %LOCALAPPDATA%\DSH HUD
  3. 写 discovery / 注册计划任务 / 写登录自启 / 建开始菜单与桌面快捷方式
  4. 用计划任务把胶囊拉起来（不弹 UAC）
       │
       ▼
桌面出现鲸鱼胶囊；以后随 DSH 启动
```

第 2 步已经在 `plugin/index.js` 里实现（`installHudApp()`，`DSH_HUD_NO_AUTO_INSTALL=1` 可关），并用本地 HTTP 假源做过端到端验证：下载 → sha256 → 解压 → `app\DSH HUD.exe` 存在，4.6 秒（本地环回；真实网络约 1–2 分钟，150 MB）。

## 已完成（2026-11-16）

- **包结构已改**：根 `package.json` 现在就是插件包 —— `name: dsh-hud-capsule`、`type: module`、
  `main: ./plugin/index.js`、`exports` 含 locale/icon、`dsh.bundle.patch: ./cordis.patch.yml`。
- 新增根级 `cordis.patch.yml`（insert `name: dsh-hud-capsule`），**没有动** `plugin/cordis.patch.yml`
  —— 后者仍插 `@dsh-hud/token-bridge`，供现有的「本地目录 = plugin/」安装方式使用，两条路互不影响。
- `pnpm pack` 产物 `artifacts/dsh-hud-capsule-0.4.1.tgz`（25.8 KB），解包到 `node_modules/dsh-hud-capsule`
  后 import 成功，导出 `apply / installHudApp / resolveDesktopExe / resolveHud`；在该布局下
  `resolveHud()` 返回 `missing`（本地 dist 不在候选里），符合预期地会触发首次自动下载。

## 已完成（2026-11-16）

| 步骤 | 结果 |
|---|---|
| npm 账号 / token | `suianest`，granular token（`Read and write (publish and stage)`，Bypass 2FA） |
| 发布 | `dsh-hud-capsule@0.5.0`，latest 指向 0.5.0 |
| 产物一致性 | registry tarball 与本地 `artifacts/dsh-hud-capsule-0.5.0.tgz` 同为 27,957 B、sha1 `391e64873a134f0ed980ec3d1c8849955dd33539` |
| 真实安装 | `pnpm add dsh-hud-capsule` → `+ dsh-hud-capsule 0.5.0`（41.6 s），导出 `apply/installHudApp/resolveDesktopExe/resolveHud` |
| 占位版本 | `0.0.0-stage` 已 deprecate（指向 0.5.0） |

### ⚠️ npm 2026 的 staged publishing

第一次 `publish` 报成功，但 registry 上只有 **`0.0.0-stage`**（description 为
`Temporary package placeholder for staged publishing`），`0.5.0` 是 404 —— 因为 npm 已把
**暂存发布**设为 GA：上传先进暂存区，必须由维护者用 **2FA 批准**才会上线
（[文档](https://docs.npmjs.com/staged-publishing)、[npm-stage](https://docs.npmjs.com/cli/v11/commands/npm-stage)）。

批准方式二选一：

1. npmjs.com → 左侧 **Staged Packages** → 选中版本 → **Approve** → 输入 2FA 验证码；
2. `npm stage approve <stage-id> --otp=<code>`（需要 npm CLI；本机只有 pnpm）。

批准后 `dist-tags.latest` 自动指向新版本。**以后每次发版都要走这一步**；如果不想每次手工批准，
可在包设置里调整发布策略（或改用 OIDC trusted publishing + `npm stage publish`）。

## GitHub 路线已验证（2026-11-16）

根 `package.json` 改成插件包后，仓库同时支持两种装法：

```bash
# ① 从 GitHub 装（需要 git；仓库名与包名不同也没关系，pnpm 以 package.json 的 name 为准）
pnpm add github:suianest/dsh-hud      # → node_modules/dsh-hud-capsule

# ② 从 npm 装（已发布）
pnpm add dsh-hud-capsule
```

实测：`pnpm add github:suianest/dsh-hud` → `+ dsh-hud-capsule 0.4.1`，目录内 `cordis.patch.yml` 存在，
且该文件 insert 的 `name` 正是 `dsh-hud-capsule`（与安装目录同名，Cordis 能解析）。

注意：改动前仓库里 `package.json` 还叫 `dsh-hud`，那时 `github:` 装出来是 `node_modules/dsh-hud`，
和根 patch 里的名字对不上；现在两者一致了。

## 现在能用的三条路

- **npm 包名**：DSH → 添加插件 → 填 `dsh-hud-capsule`（已发布 0.5.0；应用包首次自动下载）。
- **本地目录**：DSH → 添加插件 → 填 `D:\DeepSeekData\workspace\dsh-hud\plugin`（需要本机有仓库）。
- **便携版**：从 Release 下载 zip（或用 Release 里的 `install-dsh-hud.cmd` 一键装，仓库内同名文件为 `installer/安装 DSH HUD.cmd`），双击 `DSH HUD.lnk`。

## 附：git 已就位

`D:\DevTools\PortableGit`（2.56.1）已解压，`cmd` 已加入用户 PATH；重启 DSH 后 `github:suianest/dsh-hud` 这类 git 安装也能走通（走的还是仓库，不含 150 MB 应用包）。
