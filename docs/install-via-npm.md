# 通过 npm 包名一键安装（流程摸底）

> 状态：**包结构已改好、未发布**。卡在 npm 账号与包名；本文把整条链路和剩余动作写清楚。

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

## 剩余动作

1. **发布**：需要一个有 publish 权限的 npm 账号（Automation token），`npm publish --access public`。
2. **验证**：在干净 profile 里用包名安装 → 三件事：插件被加载（日志 `apply pid=...`）、HUD 自动下载安装、胶囊出现。
3. **文档**：README 增加「npm 一键安装」一节，与现有「本地目录 / 便携版」并列。
4. 备注：装好后如果本机已有应用包（比如 `dist/win-unpacked`），会被当成"未找到"而重新下载一份到
   `%LOCALAPPDATA%\DSH HUD`；想复用自己的包就设 `hudDir` 或 `DSH_HUD_DIR`。

## GitHub 路线已验证（2026-11-16）

根 `package.json` 改成插件包后，仓库同时支持两种装法：

```bash
# ① 从 GitHub 装（需要 git；仓库名与包名不同也没关系，pnpm 以 package.json 的 name 为准）
pnpm add github:suianest/dsh-hud      # → node_modules/dsh-hud-capsule

# ② 从 npm 装（发布后）
pnpm add dsh-hud-capsule
```

实测：`pnpm add github:suianest/dsh-hud` → `+ dsh-hud-capsule 0.4.1`，目录内 `cordis.patch.yml` 存在，
且该文件 insert 的 `name` 正是 `dsh-hud-capsule`（与安装目录同名，Cordis 能解析）。

注意：改动前仓库里 `package.json` 还叫 `dsh-hud`，那时 `github:` 装出来是 `node_modules/dsh-hud`，
和根 patch 里的名字对不上；现在两者一致了。

## 现在能用的两条路

- **本地目录**：DSH → 添加插件 → 填 `D:\DeepSeekData\workspace\dsh-hud\plugin`（需要本机有仓库）。
- **便携版**：从 Release 下载 zip（或用 `installer\安装 DSH HUD.cmd` 一键装），双击 `DSH HUD.lnk`。

## 附：git 已就位

`D:\DevTools\PortableGit`（2.56.1）已解压，`cmd` 已加入用户 PATH；重启 DSH 后 `github:suianest/dsh-hud` 这类 git 安装也能走通（走的还是仓库，不含 150 MB 应用包）。
