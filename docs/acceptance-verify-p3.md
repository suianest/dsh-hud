# DSH HUD P3 修复复核（t23）

- 复核对象：t20 审计后的一批修复 —— overlay 的 t21（打包、内嵌视图尺寸、错误页重连生命周期）与 plugin 的 t22（`/dsh-hud` 命令文案）。
- 方式：只读代码核对 + bundled Node headless 回归 + 独立探针；未改 `app/`、`plugin/`，只新增 `tests/e2e/probe-t23-note.mjs` 与 `tests/e2e/logs/t23-*`。
- 代码快照：`dist/win-unpacked/resources/app.asar` 构建于 2026-11-06 22:44:00；`app/` 最后修改 22:38:34；`plugin/index.js` 22:33 左右。本文所有源码行号均按该快照。
- 环境：Windows 11 build 26200.9711；bundled Node `C:\Users\35263\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`；单屏 1707×1067 / workArea 1707×1019 / scale 1.5。
- 声明：本轮没有启动真实 Electron 窗口；真机证据与 headless/静态证据分开列出。

## 1. 结论

**有条件通过。**

- 实际分发产物通过：`dist/win-unpacked/version` = `44.7.0`，`DSH HUD.exe` FileVersion/ProductVersion 均为 `44.7.0`；`app.asar` 27 个条目，关键文件存在，7 个关键文件与当前源码 **SHA-256 前 16 位完全一致**。
- P1 内嵌视图尺寸、P1 错误页重连、t22 命令文案均能从代码与单测闭环。
- **条件（high）**：`make-portable.js` 的 afterPack 缺件断言只覆盖硬编码的 `scripts/focus-dsh.ps1` / `scripts/launch-hud.cjs`；`src/**` 与 `renderer/**` 的 required 列表是“从当前目录读到的文件”动态生成的，**源文件被删时它根本不会进入 required**。实测删掉 `src/hud-window.js` 后构建仍然 `exit 0`，asar 里也确实没有该文件。该 guard 目前不能防止 t20 同类“旧快照/缺文件”复发。
- **已知残留（medium）**：`/dsh-hud` 的 `note()` 使用 apply 时的 `preExistingDiscovery` 快照；HUD 在插件 apply 之后才启动时，命令仍回“未在运行”。这是 t20 审计 #8 已列出的 `hudLikelyRunning` 快照过期问题，t22 未覆盖该时序。
- 其余未闭环项见 §6：build-portable 需沙箱外跑一次、真机点“打开 DSH 桌面窗口”需重启后验、`detach()` 未停止 recovery（t20 #8 的另一个子项）。

## 2. 逐项状态表

| # | 验证点 | 结论 | 关键证据 |
|---|---|---|---|
| 1a | `dist/win-unpacked/version` = 44.7.0（非 45.2.2） | ✅ 通过 | `version` 内容 `44.7.0`；exe FileVersion/ProductVersion `44.7.0`；`tests/e2e/logs/t23-package.txt` |
| 1b | asar 含 `scripts/focus-dsh.ps1`、`scripts/launch-hud.cjs`、`src/hud-window.js`、`renderer/host-bounds.js`，且与源码一致 | ✅ 通过 | asar `entries=27`；7 个文件 size+hash 全 MATCH；`t23-package.txt` |
| 1c | `check-hud.cmd` 逻辑 ALL_PASS | ✅ 通过 | 14 个文件逐项 PASS，`RESULT=ALL_PASS`，exit 0；`t23-package.txt` |
| 1d | `make-portable.js` 缺件时非 0 退出 | ❌ **不通过（high）** | 删 `src/hud-window.js` 后仍 `exit 0`、`asar content assertion OK`；asar `[check] src/hud-window.js: MISSING`；`t23-make-portable-missing2.txt` |
| 2 | 内嵌视图尺寸不受 transform 影响，animationend 重测 | ✅ 通过 | `host-bounds.js:19-29` 用 offsetWidth/offsetHeight；`hud.js:59-68,152-162`；单测 2/2 |
| 3 | `_startRecovery` 单 episode，连续 `showError` 不重置 ticks | ✅ 通过（按声明） | `web-embed.js:328-370`；单测 `hud-window.test.cjs:483-512` 通过；未单独模拟 24 tick 上限后的定时器行为（low 测试缺口） |
| 4 | t22 `note()` = `child \|\| hudLikelyRunning()`；plugin 测试 12/12 | ✅ 通过（按声明） | `plugin/index.js:504-528`；`plugin.test.mjs` 12/12；但快照时序残留见 §5-M1 |
| 5 | 全量回归 | ✅ 通过 | 33 个 JS `--check` 0 fail；unit 25/25；plugin 12/12；control 9/9 |

## 3. P0：打包产物与断言

### 3.1 版本

- `D:\DeepSeekData\workspace\dsh-hud\dist\win-unpacked\version` = `44.7.0`（6 字节）。
- `dist\win-unpacked\DSH HUD.exe`：`FileVersion=44.7.0`、`ProductVersion=44.7.0`。
- 构建脚本 `app/package.json` 的 `build.electronDist` 指向 `../runtime/node_modules/electron/dist`；`runtime\node_modules\electron\dist\version` 也是 `44.7.0`，不再混用 `spike` 的 45.2.2。

### 3.2 asar 内容

`artifacts/asar-list.cjs dist\win-unpacked\resources\app.asar`：

```
entries=27 jsonHeader=6904
[check] scripts/focus-dsh.ps1: PRESENT 3673B
[check] scripts/launch-hud.cjs: PRESENT 2899B
[check] renderer/index.html: PRESENT 1708B
[check] renderer/hud.css: PRESENT 4882B
[check] src/hud-window.js: PRESENT 31176B
```

`renderer/host-bounds.js` 也在列表中，`1405B`。为排除“大小相同但内容是旧快照”，用 `@electron/asar.extractFile` 逐文件比较 size + SHA-256（前 16 位）：

```
MATCH src/hud-window.js 31176 70e275405d587377
MATCH src/web-embed.js 16435 5bec0bb3cb92451e
MATCH renderer/host-bounds.js 1405 9a993658e3feb442
MATCH renderer/hud.js 6684 040a597ac6337d06
MATCH renderer/index.html 1708 dd680f125f14ae7c
MATCH scripts/focus-dsh.ps1 3673 445b20a549571c2e
MATCH scripts/launch-hud.cjs 2899 489426d3792b2304
```

`app.asar` 大小 136666 B；构建时间 22:44:00 晚于源码最后修改 22:38:34，hash 与当前源码一致。

### 3.3 `check-hud.cmd`

`cmd /c app\scripts\check-hud.cmd`：14 个文件（含 `renderer/host-bounds.js`）全部 `PASS`，最后 `RESULT=ALL_PASS`，exit 0。脚本逻辑是逐个 `node --check`，任一失败即 `RESULT=FAIL` 并 `exit /b 1`（`check-hud.cmd:14-30`）。

### 3.4 缺件断言 —— 不通过（high）

`app/scripts/make-portable.js` 的 `assertAsarContents()`：

```js
// :54 硬编码两个脚本
const required = ['scripts/focus-dsh.ps1', 'scripts/launch-hud.cjs'];
// :56-58 动态读取“当前源码目录”里的 src/*.js
for (const f of fs.readdirSync(path.join(APP_DIR, 'src'))) {
  if (f.endsWith('.js')) required.push(`src/${f}`);
}
// :59-62 renderer 同理
for (const f of fs.readdirSync(path.join(APP_DIR, 'renderer'))) { ... }
// :64-69 只检查 required 与 asar 的交集
const missing = required.filter((p) => !present.has(p));
if (missing.length) { ... process.exit(1); }
```

问题：`required` 由“当前源码目录”生成，源文件缺失时不会进入 required，因此“缺件”永远不会被断言捕获。`src/hud-window.js` 是分发版的关键文件，但删掉它后：

1. 复制 app 到临时目录，删 `app/src/hud-window.js`；
2. 运行 `make-portable.js`；
3. 输出 `asar content assertion OK (17 required entries present)`，exit **0**；
4. 对生成的 asar 跑 `asar-list.cjs`，`[check] src/hud-window.js: MISSING`。

证据：`tests/e2e/logs/t23-make-portable-missing2.txt`。作为对照，删 `scripts/focus-dsh.ps1` 会被硬编码列表捕获并 exit 1（`t23-make-portable-missing-script.txt`）。

**最小复现**：

```powershell
# 仅复制 app 与 runtime 的 shell；真实测试见日志
copy app -> tmp\app; copy app\runtime... -> tmp\runtime
remove tmp\app\src\hud-window.js
node tmp\app\scripts\make-portable.js   # 期望 exit 1；实际 exit 0
node artifacts\asar-list.cjs tmp\dist\win-unpacked\resources\app.asar
# -> [check] src/hud-window.js: MISSING
```

**requiredFix**：把关键文件改为静态 canonical 列表（至少 `src/hud-window.js`、`src/web-embed.js`、`renderer/host-bounds.js`、`renderer/hud.js`，以及两个 scripts），在打包前先断言源文件存在；或在 `readdirSync` 之外显式 `required.push('src/hud-window.js')`。否则 t20 的“旧构建缺文件”仍可能在源目录不完整时静默发布。

## 4. P1：内嵌视图尺寸

- `app/renderer/host-bounds.js:19-29`：`width/height` 取 `el.offsetWidth/offsetHeight`，这两个值忽略 CSS transform；`x/y` 取 `getBoundingClientRect()`，并 `Math.round`。元素未布局（offset 为 0）返回 `null`。
- `app/renderer/hud.js:32-40`：`reportWebBounds()` 调用 `window.__readHostBounds(webHost)`；`index.html:38-39` 先加载 `host-bounds.js` 再加载 `hud.js`，全局函数存在。
- `app/renderer/hud.js:59-68`：进入 panel 时在 `requestAnimationFrame` 中**先测量再 `playExpand()`**，避免动画中途量到缩放后的 rect。
- `app/renderer/hud.js:152-162`：`animationend` 的 `expand-in` 分支移除 `anim-expand` 后再次 `reportWebBounds()`；另有 `ResizeObserver` + `window.resize` 调度重测（`:42-57`）。
- 单测：`core.test.cjs:140-161` 用 `offsetWidth=492/offsetHeight=646`、`getBoundingClientRect` 返回 472.32×620.16 的模拟元素，断言 `readHostBounds` 返回 `{x:14,y:60,width:492,height:646}`；`display:none`（offset 0）返回 `null`。聚焦运行 2/2 通过（`t23-focused.txt`）；完整 unit 25/25。

结论：**通过（静态 + 单测）**。未在真实 Electron 中验证 520×720/1.5 缩放下的最终像素，但 t21 的根因（动画中途量 rect）已从代码路径消除。

## 5. P1：错误页重连生命周期

`app/src/web-embed.js`：

- `:49` `this._recovering = false;`。
- `:309-318` `showError()` 载入本地错误页后调 `_startRecovery()`。
- `:328-337` `const fresh = !this._recovering; this._recovering = true; this._stopRecoveryTimer(); if (fresh) { this._recoveryTicks = 0; ... }`。
- `:338-356` 每 5s tick；`_recoveryTicks > 24` 时 `_stopRecovery()` 并停止（约 2 分钟上限）；发现 discovery 变化或每 6 tick 时清 timer 并 `reload({forceToken:true})`，但**保留 `_recovering`**，因此 `did-fail-load → showError → _startRecovery` 不会重置 ticks。
- `:168-175` `did-finish-load` 且非 error 页时 `_stopRecovery()`，结束 episode。
- `:360-370` `_stopRecoveryTimer` / `_stopRecovery`。

单测 `tests/e2e/unit/hud-window.test.cjs:483-512`：第一次失败后 `_recovering=true, ticks=0`；手动置 `ticks=7` 再 `showError`，断言 ticks 仍 7；成功 `did-finish-load` 后 `_recovering=false`；下一次失败重新给 ticks=0。聚焦运行 2/2 通过（`t23-focused.txt`），完整 unit 25/25。

结论：**通过（按“连续两次 showError 不重置 ticks”的验收声明）**。测试未模拟 24 tick 上限后的真实 timer 收尾；这是 low 测试缺口，不是已证缺陷。

## 6. t22：`/dsh-hud` 命令文案

`plugin/index.js:504-528`：

```js
const hudRunning = () => Boolean(child) || hudLikelyRunning();
const note = (okText, failText) => ({ kind: 'success', text: hudRunning() ? okText : failText });
```

- 有 child（spawnApp=true）或 apply 时已有 fresh、活 pid discovery → 成功文案；否则“未在运行（指令被忽略）”。
- 命令测试 `tests/e2e/unit/plugin.test.mjs:288-339`：pre-existing fresh discovery + `spawnApp=false` → 成功；无 discovery → 未运行。全量 plugin 12/12 通过。
- 这一条与 t22 声明一致，**通过（按声明）**。

### 6.1 残留 M1（medium）：快照过期导致 HUD 后启动时仍误报

`hudLikelyRunning()` 读的是 `preExistingDiscovery`，该常量在 `plugin/index.js:197` apply 时只读一次：

```js
const preExistingDiscovery = readJsonFileSync(dFile); // :197
const hudLikelyRunning = () => { const d = preExistingDiscovery; ... }; // :199-206
```

如果 HUD 在插件 apply **之后**才启动，快照为 null，即使此时磁盘上已有 fresh discovery，命令仍回“未在运行”。独立探针 `tests/e2e/probe-t23-note.mjs` 复现：

```
{"bugReproduced":true,
 "commandText":"已发送显示指令，但 HUD 未在运行（指令被忽略）",
 "commandKind":"success",
 "explanation":"HUD started after apply; hudLikelyRunning() still sees the null apply-time snapshot"}
```

证据：`tests/e2e/logs/t23-note.txt`（exit 0，表示缺陷被稳定复现）。这与 t20 审计 #8 的“`hudLikelyRunning` 快照过期”一致，t22 只修了“有 pre-existing discovery 时”的分支。

**requiredFix（建议）**：命令成功文案以 `sendControl()` 的写入结果为主，或读取**当前** discovery 并配合 HUD 心跳/子进程信号；不能只用 apply 时快照。仅动态读 `discovery.pid` 会误判，因为该 pid 是宿主 DSH 进程而非 HUD（见 `docs/plugin-app-bridge.md` 的边界说明）。

## 7. 全量回归

命令均使用 bundled Node：

| 检查 | 命令 | 结果 |
|---|---|---|
| 语法 | 对 `app/`、`plugin/`、`tests/` 下 33 个 `.js/.cjs/.mjs`（排除 node_modules）逐个 `node --check` | `TOTAL=33 FAIL=0`，exit 0；`tests/e2e/logs/t23-static.txt` |
| 主套件 | `node --test --test-isolation=none tests/e2e/unit/core.test.cjs tests/e2e/unit/hud-window.test.cjs tests/e2e/unit/main-boot.test.cjs` | 25 tests / 25 pass / 0 fail，exit 0；`t23-unit.txt` |
| 插件 | `node --test --test-isolation=none tests/e2e/unit/plugin.test.mjs` | 12 tests / 12 pass / 0 fail，exit 0；`t23-plugin.txt` |
| 控制桥 | `node artifacts/control-bridge-test.cjs` | `SUMMARY 9/9 passed`，exit 0；`t23-control.txt` |
| 聚焦 | `--test-name-pattern='host-bounds\|error recovery'` | 2 tests / 2 pass，exit 0；`t23-focused.txt` |
| 打包 | `node artifacts/asar-list.cjs ...` + extractFile hash | entries=27；7 个关键文件 MATCH；`t23-package.txt` |
| 自检 | `cmd /c app\scripts\check-hud.cmd` | 14 PASS / `RESULT=ALL_PASS`，exit 0 |
| 缺件 guard | 临时复制 + 删 `src/hud-window.js` + `make-portable.js` | **exit 0（应为非 0）**；asar 缺该文件；`t23-make-portable-missing2.txt` |
| 缺脚本 guard | 临时复制 + 删 `scripts/focus-dsh.ps1` | exit 1，提示 missing；`t23-make-portable-missing-script.txt` |

`node --check` 覆盖 33 个文件，其中包含本轮新增的 `tests/e2e/probe-t23-note.mjs`；没有修改 `app/` 或 `plugin/`。

## 8. 真机证据与未闭环项

- **本轮未启动真实 Electron**，所以以下均不是本轮真机回归：
  - 既有真机截图 `artifacts/hud-capture*.png`（18:04 批次，720/420 尺寸）能证明渲染过，但拍摄时间早于/独立于 t23，不能替代本轮检查。
  - 既有 `capture-out.log` 曾记录热键注册失败（可能被其他实例占用）；与打包/尺寸断言无关，但说明“真机全链路”仍需单独跑。
- **未闭环 1**：`build-portable.cmd`（electron-builder，图标/版本资源）必须在沙箱外跑一次；本轮只验证了 `make-portable.js` 的 JS 打包路径和 asar 内容，不验证 exe 图标/资源。
- **未闭环 2**：真机点「打开 DSH 桌面窗口」需用户重启 DSH 后看 `<userData>\hud.log`；会话内无法验。
- **已知未闭环 3（medium，t20 #8 另一子项）**：`web-embed.js:270-283` 的 `detach()` 只 `removeChildView`，没有 `_stopRecovery()`；错误页存在时收起胶囊，recovery timer 仍可能继续 `loadURL`（2 分钟 cap 内）。本轮未修改，也不在 t21 声明内；建议在 `detach()` 调 `_stopRecovery()`、`attach()` 时按 `lastKind==='error'` 重启。
- **已知未闭环 4（low）**：asar 仍包含 `scripts/make-icon.js`、`scripts/make-portable.js`（27 条目里可见），t20 审计 #14 的低危项未处理；不影响运行。

## 9. 证据文件

| 文件 | 说明 |
|---|---|
| `tests/e2e/logs/t23-package.txt` | version、asar 列表、hash 对比、check-hud 输出 |
| `tests/e2e/logs/t23-static.txt` | 33 个 JS `node --check`，`TOTAL=33 FAIL=0` |
| `tests/e2e/logs/t23-unit.txt` | 25/25 unit |
| `tests/e2e/logs/t23-plugin.txt` | 12/12 plugin |
| `tests/e2e/logs/t23-control.txt` | control-bridge 9/9 |
| `tests/e2e/logs/t23-focused.txt` | host-bounds + recovery 2/2 |
| `tests/e2e/logs/t23-make-portable-missing2.txt` | 删 `src/hud-window.js` 后 exit 0 且 asar MISSING（缺陷证据） |
| `tests/e2e/logs/t23-make-portable-missing-script.txt` | 删 `scripts/focus-dsh.ps1` 后 exit 1（对照） |
| `tests/e2e/logs/t23-note.txt` | HUD apply 后启动仍误报“未在运行” |
| `tests/e2e/probe-t23-note.mjs` | 上述 medium 的最小复现探针 |

## 10. 复核判定

- 分发产物本身**可接受**：44.7.0、asar 内容与源码一致、check-hud 全绿。
- 但 **make-portable 的缺件 guard 不完整（high）**：它无法发现源目录缺关键文件，实际构造缺件仍 exit 0。这是本轮唯一阻止“打包门禁可信”的问题，必须在下次构建前修。
- t22 的 note 修复只覆盖“apply 时已存在 fresh discovery”的场景；HUD 后启动时仍误报（medium，已知 t20 #8）。
- 因此结论为 **有条件通过**，不建议把“打包门禁已闭环”写成无条件通过。

- 复核人：qa（t23 attempt 1，attempt_id `6f5ef877-94cd-4827-a13d-f7a391722676`）
- 复核完成时间：2026-11-06 22:45+08:00
