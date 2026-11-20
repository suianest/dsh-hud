# 0.5.6 QA 验收清单（P-14 方案 A：插件版本提示）

> 版本状态：**未发布**。根 `package.json` / `app/package.json` 仍是 `0.5.5`，
> `manifest.json` 仍是已发布 v0.5.5 的值（`8bb97d6e…` / 510,459），
> 本地 `dist/win-unpacked/app/resources/app.asar` 是待验收的新构建（512,508 B）。

## 0. 前置

```powershell
# 让 HUD 用最新源码构建（会杀掉正在运行的 HUD）
Get-Process -Name 'DSH HUD' -ErrorAction SilentlyContinue | Stop-Process -Force
node app/scripts/make-portable.js --no-zip      # 会改写 manifest.json，验收后要手工改回 v0.5.5
```

> `make-portable` 一定会把 `manifest.json` 改成本地新 asar 的哈希；
> 验完记得恢复成已发布值：
> `{"version":"0.5.5","appAsar":{"url":"https://github.com/suianest/dsh-hud/releases/download/v0.5.5/app.asar","sha256":"8bb97d6efb5049a6ec64087e6e4696a9fa538bd80bda41b7975ad52396af77f3","size":510459}}`
> 否则 0.5.5 用户点「检查更新」会拿错哈希而更新失败。

## 1. 应用侧 UI（不用等 npm）

1. 启动 HUD：`dist\win-unpacked\DSH HUD.lnk`（**不要**直接双击 exe）。
2. 模拟插件上报（模拟一次"有新版"）：

```powershell
node -e "const fs=require('fs'),p=require('path');const d=p.join(process.env.LOCALAPPDATA,'dsh-hud');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'control.json'),JSON.stringify({seq:Date.now(),action:'plugin-update',at:new Date().toISOString(),data:{current:'0.5.5',latest:'0.5.6'}},null,2))"
```

3. 预期：
   - `dist/win-unpacked/udd/hud.log` 出现 `plugin update: current=0.5.5 latest=0.5.6`；
   - 展开面板后 `⌘` 按钮右上角有 **橙色小圆点**；
   - 点 `⌘`，命令面板最后一项是 **「插件有新版本 v0.5.6（复制升级命令）」**；
   - 点它 → 面板关闭，剪贴板为 `pnpm add dsh-hud-capsule@0.5.6`（`Get-Clipboard` 可查），
     日志多一行 `palette: plugin update guide copied (…)`。

参考截图：`artifacts/pal-plugin-update.png`（条目已确认；橙点因截图只截到面板左侧未入镜）。

## 2. 没有更新时不打扰

清掉状态后再触发一次（`latest` 为空或等于 `current`）：

```powershell
node -e "const fs=require('fs'),p=require('path');const d=p.join(process.env.LOCALAPPDATA,'dsh-hud');fs.writeFileSync(p.join(d,'control.json'),JSON.stringify({seq:Date.now(),action:'plugin-update',at:new Date().toISOString(),data:{current:'0.5.5',latest:'0.5.5'}},null,2))"
```

预期：日志无 `plugin update available`；`⌘` 无橙点；面板无该条目。
（`latest` 为空字符串时插件侧也不会发；应用侧 `setPluginUpdate` 直接 return。）

## 3. 插件侧真实检查（需要重启 DSH）

1. 重启 DSH 桌面端（插件代码是 `link:` 到仓库的，重启才会重新 `apply`）。
2. 等 10 秒以上，看插件诊断日志：

```powershell
Get-Content "$env:TEMP\dsh-hud-plugin-diag.log" -Tail 20
```

3. 预期：
   - 首次会写一条与 `plugin update` 相关的日志（检查过 / 失败 / 无更新都算通路正常）；
   - 因为 npm 上还没有 0.5.6，这一次**不应**提示更新；
   - 6 小时内不会重复请求（状态文件 `%LOCALAPPDATA%\dsh-hud\plugin-update.json` 有 `lastCheckAt`）。
4. 想立刻验证"有新版"链路：临时把根 `package.json` 的 `version` 改小（如 `0.5.0`）后重启 DSH，
   插件会把 npm 上的 `0.5.5` 判为更新并推 `plugin-update`。

## 4. 回归

```powershell
$env:DSH_HUD_NO_LAUNCH_TASK=1; $env:DSH_HUD_NO_STARTMENU=1; $env:DSH_HUD_NO_AUTO_INSTALL=1
$env:DSH_HUD_AUTOSTART_WITH_DSH=0; $env:DSH_HUD_NO_PLUGIN_UPDATE=1
node --test --test-isolation=none tests/e2e/unit/*.test.cjs tests/e2e/unit/*.test.mjs
```

预期 **86/86 pass**（config 4 / core 5 / extensions 6 / hud-window 33 / main-boot 2 / shortcut 6 / updater 9 / plugin 20 / relocation 1）。

> 注意：`node --test tests/e2e/unit/` 传目录会报 `ERR_UNSUPPORTED_DIR_IMPORT`，必须显式给文件。

## 5. 验收后（发 0.5.6 才做）

1. 两个 `package.json` → `0.5.6`；`CHANGELOG` 把 `[0.5.5]` 之后的改动挪到 `[0.5.6]`。
2. `make-portable`（带 zip）→ 记 asar/zip 的 sha256 与大小。
3. `manifest.json` → 0.5.6 + 新 asar。
4. 推送（脚本必须带全量文件列表 + `base_tree`）→ Release v0.5.6（asar / zip / manifest / cmd / ps1 / pdf）。
5. `pnpm pack` → `node tools/publish-npm.mjs <npm-token>` → 去 npmjs.com Staged Packages 批准。

---

## QA 结果（2026-11-20 21:5x）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 应用侧：有新版 → 橙点 | ✅ | `artifacts/qa-panel-full.png`（⌘ 右上角橙点） |
| 应用侧：命令面板条目 | ✅ | `artifacts/pal-plugin-update.png`（「插件有新版本 v0.5.6（复制升级命令）」） |
| 应用侧：点条目 → 复制 + 关面板 | ✅ | `hud.log`：`palette: plugin update guide copied (pnpm add dsh-hud-capsule@0.5.6)`；`Get-Clipboard` 一致 |
| 应用侧：latest ≤ current 不提示 | ✅ | `hud.log`：`plugin update ignored: current=0.5.5 latest=0.5.5` |
| 回归 | ✅ | **87/87**（hud-window 34、plugin 20、updater 9，其余同前） |
| 插件侧真实检查 | ⏳ 待重启 DSH | npm 上 `latest=0.5.5` 与本地相同，重启后只会记录一次"无更新"通路 |

QA 中发现并修掉一个缺口：应用侧原来无条件相信插件上报的版本，现在 `setPluginUpdate()` 会用
`isNewerVersion(latest, current)` 再挡一次（降级/同版本直接忽略并清掉旧角标），新增单测
「an older or equal "latest" is ignored…」。

> 重新构建后 asar 为 **513,337 B**（上一版 512,508 B），`manifest.json` 已恢复为已发布 v0.5.5 值。
