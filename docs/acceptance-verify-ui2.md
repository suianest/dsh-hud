# t38 验收报告：UI 第二批 + P-02 分发改造

- 复核对象：t34 主题跟随、t35 命令面板 + 边缘吸附提示、t36 插件自动定位 HUD + 仓库根 `package.json`。
- 复核方式：代码逐行核对 + bundled Node 静态检查 + 逐文件单测 + 两个只读探针（拖边缩放后拖动、命令面板收起后重开）。未启动真实 GUI（本轮边界要求，真机截图由 captain 负责）。
- 复核快照：2026-11-10 19:50（Asia/Shanghai）左右；只读取 `app/`、`plugin/`，未修改源码，未碰 `dist/`。
- **结论：不通过（release-blocked）**。分发改造与主题跟随基本成立，命令面板主流程也成立；但必查项「拖边缩放尺寸不被改」存在一个确定的 blocker，命令面板在收起路径上还有一个 high 级状态残留。修复并重跑本报告第 5 节的两条探针前，不建议发布。

## 1. 逐项结论

| # | 检查项 | 结论 | 关键证据 |
|---|--------|------|----------|
| 1 | 静态检查 `app/src/*.js`、`app/renderer/*.js`、`plugin/index.js`、根 `package.json` | **通过** | 17/17 个 JS `node --check` 通过；根 JSON 解析为 `dsh-hud@0.3.0`，`files` 3 项 |
| 2 | 单测（hud-window / plugin / config，另跑 core/extensions/main-boot/relocation） | **基本通过，有测试不稳定性** | 最终 57/57；`plugin.test.mjs` 在 5 次复跑中有 2 次 14/15（ENOTEMPTY 清理失败，见 M1） |
| 3 | 主题跟随：`hud:theme=light`、默认深色、无闪变 | **通过（有首启保留）** | 主题单测通过；浅/深 token 与缓存路径代码核对；首启浅色无缓存时仍会短暂深色（见 L1） |
| 4 | 命令面板：打开 `web.detach()`、关闭恢复、Esc、三条内置动作 | **部分通过 / 有 high 缺陷** | 打开 detach、执行后 attach、三条 label 均有测试；Esc/收起不清理 `_paletteOpen`，重开后无法再打开（H1） |
| 5 | 分发：无 `hudDir`、`hudDir` 指向临时假 exe 两条路径 | **通过** | 探针输出 `found:false` + 可读原因、`found:true/mode:'exe'`；缺件不 throw |
| 6 | 拖边缩放（左右/上下）尺寸不被改 | **不通过（blocker）** | 右侧从 720×720 拖动后回到 520×720；下侧从 520×780 拖动后回到 520×720（B1） |

## 2. 环境与命令

- Node（bundled）：`C:\Users\35263\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`（Node 24）。
- 仓库：`D:\DeepSeekData\workspace\dsh-hud`。
- 静态检查：`node --check` 覆盖 `app/main.js`、`app/preload.js`、`app/src/*.js`（11 个）、`app/renderer/*.js`（3 个）、`plugin/index.js`，共 17 个；根 `package.json` 用 Node `JSON.parse` 校验。
- 单测逐个文件执行（避免 `node --test` 目录模式在本沙箱 spawn EPERM）：
  `node --test --test-isolation=none tests/e2e/unit/<file>`
- 证据目录：`tests/e2e/logs/`；探针：`tests/e2e/probe-t38-drag-resize.cjs`、`tests/e2e/probe-t38-palette-esc.cjs`。

## 3. 必查项细节

### 3.1 静态检查：通过

`t38-static.txt`：

```
TOTAL=17 PASS=17 FAIL=0
root package OK dsh-hud 0.3.0 files=3
```

根 `package.json` 含 `name=dsh-hud`、`version=0.3.0`、`private=false`、`files=["plugin/**","docs/**","README.md"]`、`dsh.bundle.patch=./plugin/cordis.patch.yml`、`engines.node>=20`。

### 3.2 单测：57/57（最终轮），插件测试有 teardown flake

逐文件结果（`t38-tests.txt` + `t38-*.txt`）：

| 文件 | 用例 | 结果 |
|------|------|------|
| `config.test.cjs` | 4 | 4 pass |
| `core.test.cjs` | 5 | 5 pass |
| `extensions.test.cjs` | 5 | 5 pass |
| `hud-window.test.cjs` | 25 | 25 pass |
| `main-boot.test.cjs` | 2 | 2 pass |
| `plugin-relocation.test.mjs` | 1 | 1 pass |
| `plugin.test.mjs` | 15 | 最终 15 pass；5 次复跑中 2 次 14/15 |

合计 **57** 个用例。插件测试失败不在断言，而在 `t36: missing HUD ...` 的 teardown：

```
[Error: ENOTEMPTY: directory not empty, rmdir 'C:\Users\35263\AppData\Local\Temp\dsh-...\dsh-hud']
```

失败发生在 `tests/e2e/unit/plugin.test.mjs:597-601` 的 `finally` 清理，`dispose()` 内部的 `void cleanupTmpFiles()` / `void rm(...)` 与测试的 `env.cleanup()` 竞争。属测试/收尾确定性不足，不改变产品断言；但“全部要绿”的确定性未完全满足，列为 M1。

### 3.3 主题跟随：通过（有首启保留）

- 内嵌页探测：`app/renderer/web-preload.js:110-148` 优先 `dataset.theme` / `data-theme` / `data-ds-theme`，再识别 `data-ds-dark-theme`、`dark`/`light` class，最后按 body 背景亮度兜底；`setInterval(reportTheme, 700)` 与 `MutationObserver`（:156-162）负责及时上报。
- 主进程接收：`app/src/hud-window.js:1158-1162` 接受 `{theme}` 或裸字符串；`app/src/web-embed.js:501-506` 规范化；`_pushTheme` :1253-1259 发送 `hud:theme` 并持久化 `userData/theme.json`；`_saveTheme`/`_loadTheme` :1270-1292。
- 默认深色：`app/renderer/hud.css:15-27` 的 `:root` 为深色 token，`html[data-hud-theme="light"]` 才覆盖（:32-44）；`hud.js:330-334` 无上报时保持默认。
- 单测：`tests/e2e/unit/hud-window.test.cjs:655-684`，断言 `hud:theme=light`、bogus→dark、裸字符串兼容、`theme.json` 持久化。
- 无闪变：`hud-window.js:141` 启动时 `_loadTheme()`，`:151-153` 在 shell `did-finish-load` 先推送缓存，故**已知浅色的二次启动**不会先闪深色。
- 保留（L1）：首次启动没有缓存，浅色用户会先看到深色壳，直到内嵌页上报；这不是“未知主题闪成浅色”，但也不是首次启动的零闪变。未真机验证，无法给出视觉结论。

### 3.4 命令面板：打开/关闭主路径通过，Esc/收起路径有 high 缺陷

- 打开：`app/src/hud-window.js:1211-1235`；`this._paletteOpen=true`（:1228）后 `this.web.detach()`（:1229），再发 `hud:palette-open`（:1231-1233）。
- 关闭/执行：`:1237-1245` `_closePalette()` 置 false、`web.attach()`、`web.focus()`；`:1166-1176` 执行选中项；单测 `hud-window.test.cjs:687-709` 覆盖 detach 与执行后 re-attach。
- 三条内置：`:1213-1217` 的 `打开 DSH 桌面窗口` / `打开 DSH 浮窗` / `Token 补充`；对应 handler 分别在 `hud-window.js:565` 与 `:453`。单测只实际执行了 `open-dsh-panel`；另外两条只做了“存在/在最前”断言（会打开真实窗口或联网，不适合 headless 执行）。
- Ctrl+K：shell `:1043-1047` 和内嵌 view `app/src/web-embed.js:127-133` 双路径；Esc 由 shell `:1038-1042` 拦截并 `collapse()`。
- **H1**：`collapse()`（`:832-841`）与 `showCapsule()` 都没有清理 `_paletteOpen`，也没有调用 `_closePalette()`；`_closePalette()` 也不向 renderer 发送 `hud:palette-close`。因此：

  ```
  opened:    { paletteOpen: true,  attached: false, mode: 'panel' }
  collapsed: { paletteOpen: true,  attached: false, mode: 'capsule' }
  reopened:  { paletteOpen: true,  attached: true,  mode: 'panel' }
  ```

  重开后 `_openPalette()` 在 `:1212` 因 `_paletteOpen` 为 true 直接 return，Ctrl+K/⌘按钮均不能再打开面板；同时 native view 已 attach，可能盖住残留的 DOM palette。证据 `t38-palette-esc.txt`，探针退出码 3。

### 3.5 分发解析：通过

`plugin/index.js:144-181` 的 `resolveHud()` 与 `:184-204` 的 `resolveDesktopExe()`：

1. 无 `hudDir`、无可探测 exe、无开发态回退：
   `{"found":false,"mode":"missing","reason":"未找到 HUD，请下载 Release 包解压后设置 hudDir 或 DSH_HUD_DIR"}`
2. `hudDir` 指向临时目录中的假 `DSH HUD.exe`：
   `{"found":true,"mode":"exe","exe":"...\\DSH HUD.exe"}`
3. `hudDir` 指向空目录：
   `{"found":false,"mode":"dir","reason":"未找到 HUD：hudDir 目录下没有 DSH HUD.exe（...）"}`
4. 显式缺失 `desktopExe`：返回 `""`，不 throw。

原始输出：`tests/e2e/logs/t38-distribution.txt`。插件侧 `apply` 缺件提示与 `/dsh-hud` 文案由 `tests/e2e/unit/plugin.test.mjs:563-603` 覆盖（该测试的 teardown flake 见 M1）。

### 3.6 拖边缩放回归：不通过（B1）

单测 `hud-window.test.cjs:484-518` 覆盖“按住不动不涨”“松手冻结”“左右边增长”，`:520` 起覆盖上下边增长，均 25/25 通过。但它**没有覆盖“先缩放、再拖动移动窗口”**，而这正是本轮要求。

`app/src/hud-window.js:1084-1098` 在拖动时重新用常量：

```js
const size = this.mode === 'panel' ? PANEL : CAPSULE;   // :1088
...
const size = this.mode === 'panel' ? PANEL : CAPSULE;   // :1095
```

`PANEL` 固定 520×720。实测探针（`tests/e2e/probe-t38-drag-resize.cjs`，`t38-drag-resize.txt`）：

```json
{"side":"right","resized":[720,720],"during":[520,720],"after":[520,720],"keepsResizedSize":false}
{"side":"bottom","resized":[520,780],"during":[520,720],"after":[520,720],"keepsResizedSize":false}
{"rightKeepsSize":false,"bottomKeepsSize":false,"allKeep":false}
```

即：右侧拉宽到 720 后一拖动立即回到 520；下侧拉高到 780 后一拖动立即回到 720。这是用户可见的尺寸丢失，且直接违反必查项 6。**requiredFix**：拖动移动时读取当前 `getContentSize()`（或保存本次 resize 尺寸），不要用 `PANEL` 常量；同时补一条“缩放→拖动”的回归断言。

## 4. 证据文件

| 文件 | 内容 |
|------|------|
| `tests/e2e/logs/t38-static.txt` | 17 个 JS + 根 package 校验 |
| `tests/e2e/logs/t38-tests.txt` | 首轮逐文件汇总 |
| `tests/e2e/logs/t38-config.txt` / `t38-core.txt` / `t38-extensions.txt` / `t38-hud-window.txt` / `t38-main-boot.txt` / `t38-plugin-relocation.txt` | 各文件单测输出 |
| `tests/e2e/logs/t38-plugin-r1..r5.txt` | 插件测试 5 次复跑（r2/r3 为 ENOTEMPTY） |
| `tests/e2e/logs/t38-plugin-final.txt` | 最终 15/15 |
| `tests/e2e/logs/t38-distribution.txt` | 无 hudDir / 假 exe / 空目录 / 缺失 desktopExe |
| `tests/e2e/logs/t38-drag-resize.txt` | 右侧 + 下侧缩放后拖动（两者均失败） |
| `tests/e2e/logs/t38-palette-esc.txt` | 面板打开→collapse→重开后的 `_paletteOpen` 状态 |

真机证据：本轮未启动 GUI；仓库既有 `artifacts/hud-capture*.png`（2026-11-10 16:53，780×1080 / 420×96 / web 1138538B）可作为此前版本的真机截图，但**不能作为本轮 t34/t35/t36 代码的回归证据**（时间早于本轮改动，且本轮未重新截图）。

## 5. 未闭环 / 修复后复验

1. **B1（blocker）**：修 `hud-window.js:1088/1095` 的拖动尺寸来源；补“resize→drag”测试；跑 `probe-t38-drag-resize.cjs` 应 `allKeep:true`、退出码 0。
2. **H1（high）**：在 `collapse()`/`showCapsule()` 清理 palette，发送 `hud:palette-close`；Esc 在 palette 打开时优先只关 palette；重跑 `probe-t38-palette-esc.cjs` 应 `collapsed.paletteOpen=false`、`reopened.paletteOpen=true` 且退出码 0。
3. **M1（medium，测试确定性）**：`plugin.test.mjs` 的 `dispose()` 后仍异步 `cleanupTmpFiles()`，与 `env.cleanup()` 竞争；让 dispose 返回/等待清理，或测试侧等待 settling 后再删临时目录。
4. **L1（low，首启主题）**：首启浅色无缓存会短暂深色；若要求首启零闪变，需要在启动前从 DSH 配置/环境读取主题，或接受该短暂过渡并在文档说明。
5. 真机：主题跟随的实际视觉、Esc 焦点行为、真实拖边手感仍需 GUI 复验；本轮边界不启动 GUI。
