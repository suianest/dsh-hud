# DSH HUD app 侧全流程审计（t41）

只读审计，未修改任何 app/ 代码。审计范围：`app/main.js`、`app/preload.js`、`app/src/*.js`、`app/updater.cjs`、`app/renderer/*`、`app/scripts/*`、`app/package.json`、`installer/*`、`tools/*`。

审计结论摘要：**无 blocker、无 high**；2 条 medium、7 条 low；其余核对项 verified OK。

---

## 1. main.js 启动链

| 项 | 位置 | 结论 |
| --- | --- | --- |
| 单实例锁 | `main.js:113-127` | ✓ `requestSingleInstanceLock()`，second-instance → `focusIfVisible()`（不强制弹面板） |
| userData 回退 | `main.js:69-93` | ✓ 优先 `DSH_HUD_USER_DATA`，回退 `%LOCALAPPDATA%\DSH HUD`，再回退 exe 同目录 |
| bootLog | `main.js:28-44` | ✓ 三处（LOCALAPPDATA、exe 同目录、tmp），便于真机取证 |
| captureFlow | `main.js:225-336` | ✓ `DSH_HUD_CAPTURE`/`_PALETTE`/`_COLLAPSE` 三种取证开关，`onLoaded` 先于 `showPanel()` 赋值（t14 #23 已修） |
| extensions 加载顺序 | `main.js:141` | ✓ whenReady 内 `extensions.loadExtensionFiles()` 在 `new HudWindow()` 之前 |
| will-quit 清理 | `main.js:205-211` | ✓ unregisterAll + control.stop + hud.destroy |
| uncaughtException | `main.js:52-57` | ⚠️ **low #3**：仅写 bootLog，不退出。主进程致命异常后进程继续，可能处于半死状态 |

**low #3**：`app/main.js:52-57` `uncaughtException`/`unhandledRejection` 只 `bootLog` 不 `app.exit`。后果：主进程抛未捕获异常后窗口仍在但功能半死，且无崩溃退出码可诊断。建议：`uncaughtException` 记日志后 `app.exit(1)`。

**low #4**：`app/main.js:199-201` `app.on('activate')` 无条件 `hud.showPanel()`，与 second-instance 的 `focusIfVisible()`（:123-127）策略不一致。后果：任务栏再次点击/系统 activate 会强行展开面板（即使用户已收起）。建议：改 `focusIfVisible()`。

## 2. hud-window.js 双态 / 缩放 / palette / destroy / 多屏

| 项 | 位置 | 结论 |
| --- | --- | --- |
| 双态切换 | `showCapsule:171-190` `showPanel:192-219` | ✓ showPanel 有重拉守卫（:195-205，可见则只 focus） |
| 边缘缩放 | `:226-307` | ✓ snapshot 记 startX/Y/Width/Height，交叉轴从 snapshot 不读 getBounds，minW=PANEL.width minH=420 maxW=min(work.width,1400)，`_panelUserSize` 即时记 |
| palette 生命周期 | `:1312-1364` | ✓ `_openPalette` 先 `web.detach()`，`_closePalette` 恢复 attach+focus，collapse 时先 `_closePalette`(:921) |
| destroy | `:1426-1466` | ✓ 移除 17 个 ipcMain handler + 3 个 screen 监听（display-added/removed/metrics-changed），覆盖 `hud:drag-*`/`hud:collapse`/`hud:collapse-done`/`hud:quit`/`hud:web-bounds`/`hud:web-retry`/`hud:web-start-dsh`/`hud:rightbar`/`hud:web-theme`/`hud:resize-*`/`hud:context-menu`/`hud:palette-*`，未漏 |
| 多屏 DPI | `:991-1063` | ✓ `_clamp`/`_snapCapsule`/`_clampToWorkArea` 全 DIP，拖动走主进程 `screen.getCursorScreenPoint()`（t14 #12） |
| 检查更新 helper | `:520-522` | ✓ 打包版 `process.resourcesPath/updater.cjs`（asar 外），dev 版 `__dirname/../updater.cjs`；make-portable 正确拷贝到 resources（见 §6） |

## 3. web-embed.js 鉴权 / 401 / recovery / 窗口打开

| 项 | 位置 | 结论 |
| --- | --- | --- |
| token→cookie→clean | `:323-332` | ✓ 首次带 `?token=` 加载，bootstrapped 后切 cleanUrl |
| 401 重试预算 | `:229-238` | ✓ `_tokenRetried` 单次回退（带 fresh token reload 一次） |
| recovery 定时器 | `:430-462` | ✓ 单 episode（`_recovering`）+ 360 tick cap（约 30 分钟），detach 停 recovery（:358-363） |
| setWindowOpenHandler | `:94-99` | ✓ deny + `openExternal` 交系统浏览器 |
| will-navigate | `:100-106` | ✓ 限制同源 |
| DOM dump | `_stopDump` 内 | ✓ detach 时停止 |
| web-preload 契约 | `web-preload.js` | ✓ `webBridge` + 可选 dshDesktop stub（`DSH_HUD_DESKTOP_STUB=1`） |

## 4. updater.js / updater.cjs

| 项 | 位置 | 结论 |
| --- | --- | --- |
| manifest 解析 | `updater.js:33-55` | ✓ 4 镜像源 + 数字版本比较 |
| 下载校验 | `updater.js:122-135` | ⚠️ **low #7**：只验 sha256，忽略 `manifest.size`（见下） |
| pending 文件 | `updater.js:138-143` | ✓ 写 update-pending.json |
| 锁文件替换 | `updater.cjs:24-35` | ✓ `waitUnlocked` rename-probe 60×500ms 等 HUD 完全退出 |
| .bak 回滚 | `updater.cjs:55-61` | ✓ copyFileSync(target→.bak) 后 copyFileSync(staged→target) |
| helper 路径（打包版） | `hud-window.js:520-522` | ✓ 与 make-portable.js:308-310 的 `resources/updater.cjs` 一致（asar 外） |
| relaunch | `updater.cjs:67-74` | ✓ `spawn(pending.exe, pending.args, detached)`，args=`process.argv.slice(1)`（保留 `--no-sandbox --user-data-dir`） |

**low #7**：`app/src/updater.js:122-135` `downloadUpdate` 只验 sha256，忽略 `manifest.size`。后果：功能上 sha256 已足够防篡改，但 size 可作为「下载不完整」的快速前置检查，报错信息更准确。建议：下载后先比 size 再算 hash。

## 5. installer（ps1 + cmd）

| 项 | 位置 | 结论 |
| --- | --- | --- |
| 编码/BOM/CRLF | `install-dsh-hud.ps1` | ✓ UTF-8（含中文注释正常） |
| `安装 DSH HUD.cmd` 编码 | 全文件 | ⚠️ **low #8**：GBK 编码（`title` 行字节 `d2bb bcfc b0b2 d7b0` = "一键安装"）+ `chcp 936` + CRLF |
| CheckOnly/ZipPath/InstallDir | `install-dsh-hud.ps1` | ✓ 三参数齐全 |
| 覆盖运行中文件 | `install-dsh-hud.ps1:128` | ⚠️ **medium #1**：Expand-Archive -Force 覆盖，不检查 HUD 是否运行 |
| 失败残留 | `install-dsh-hud.ps1:137-139` | 临时 zip 在 finally 清理，但已解压的残留不清理（见 medium #1） |
| checksum | `install-dsh-hud.ps1:112` | ⚠️ **low #6**：依赖 `$asset.digest`（GitHub API 通常 null）→ 只 size 校验不验 sha256 |

**medium #1**：`installer/install-dsh-hud.ps1:128` `Expand-Archive -LiteralPath $tmp -DestinationPath $InstallDir -Force` 直接覆盖已安装目录，安装前不检测 `DSH HUD.exe` 是否在运行。后果：运行中的 HUD 锁定 app.asar/exe/dll，解压失败 → catch 只 `exit 1`，已解压的文件残留成半更新态。建议：解压前 `Get-Process 'DSH HUD'` 检测并提示退出/自动结束；或解压到临时目录再原子切换。

**low #6**：`installer/install-dsh-hud.ps1:112` `if ($asset.digest -and $asset.digest -match '^sha256:(.+)$')`。GitHub Releases API 的 `asset.digest` 字段通常为 null（需单独请求 asset 详情才返回），因此 SHA-256 校验基本从不执行，只有 size 校验。建议：在 Release 资产里附带 manifest.json（make-portable 已生成），或用本地 zip 计算 sha256 打印给用户核对。

**low #8**：`installer/安装 DSH HUD.cmd` 是全仓库唯一非 ASCII 的 .cmd（GBK + `chcp 936` + CRLF），违反 t26/t28 确立的「.cmd 一律 ASCII+CRLF」约定。功能自洽（zh-CN 系统），但非 zh-CN 系统或用户改过代码页时 title 会乱码。建议：title 改英文或删除。

## 6. make-portable.js

| 项 | 位置 | 结论 |
| --- | --- | --- |
| CANONICAL_FILES 一致性 | `:45-70` | ⚠️ **medium #2**：缺 `src/config.js` |
| updater.cjs 打包 | `:308-310` | ✓ 拷到 `APP_OUT_DIR/resources/updater.cjs`（asar 外），与 hud-window.js 的 helper 路径一致 |
| zip 生成 | `writeZip` | ✓ 用 `Compress-Archive` 或归档逻辑 |
| junction | `:122` | ✓ `ensureIpcJunction` 落 `APP_OUT_DIR/resources/artifacts` |
| launcher/shortcut | `:155`/`:166-173` | ✓ 指向 `app/DSH HUD.exe`，WorkingDirectory=app |
| 版本读取来源 | `:283` 附近 | ✓ 读 `package.json` version |

**medium #2**：`app/scripts/make-portable.js:45-70` `CANONICAL_FILES` 缺 `src/config.js`（`hud-window.js:45` `require('./config')`）。后果：`config.js` 被误删/改名时，`assertSourceFiles`/`assertAsarContents` 都不报，asar 照常构建，运行时启动即崩 `Cannot find module './config'`。建议：把 `src/config.js` 加入清单。

**low #9**：`app/scripts/make-portable.js:306-307` 注释称 updater.cjs "also packed inside for dev parity"，但 `APP_FILES`（:40，含 `main.js`/`preload.js`/`src`/`renderer`/`scripts`/`package.json`）不含顶层的 `updater.cjs`，它并未进 asar，只在 :308-310 `copyFileSync` 到 `resources/updater.cjs`。注释与实现不符（无功能影响）。建议：修正注释。

**low #5**：`app/scripts/check-hud.cmd:19` 与 `app/package.json:14` 的 `node --check` 列表只含 15 个 JS，缺 `src/updater.js`、`src/shortcut.js`、`updater.cjs`、`scripts/make-portable.js`、`scripts/launch-hud.cjs`、`scripts/make-icon.js`。后果：这些新文件的语法错误不会被 check 脚本捕获。建议：补齐列表。

## 7. tools/verify-release.mjs / gh-push.mjs

| 项 | 位置 | 结论 |
| --- | --- | --- |
| 重试 | `verify-release.mjs:30-44` | ✓ 4 次重试 + 退避 |
| 校验 | `verify-release.mjs:53-55` | ✓ sha256 + size 双校验，exit 0/1 |
| gh-push.mjs | — | ⚠️ 文件**不存在**（任务 item#7 提及，但仓库无此文件），Release 上传环节无脚本 |

---

## 修复优先级建议

1. **medium #1（installer 覆盖运行中文件）** — 安装器最可能真机踩坑，建议优先。
2. **medium #2（CANONICAL_FILES 缺 config.js）** — 一行改动，防构建产物缺文件。
3. low #3/#4/#5 属稳健性收尾；low #6/#7 属校验增强；low #8/#9 属一致性/注释修正。

---

*审计完成时间：t41。验证命令：`node --check` 对 13 个审计目标文件（main/updater/shortcut/updater.cjs/make-portable/hud-window/web-embed/config/control/extensions/hud.js/web-preload）全部 PASS。*
