# 扩展点（加新功能从这里开始）

这份文档说明「以后想加个小功能」时**不需要**改窗口核心代码的三个位置。
三处都在 `app/src/extensions.js` 里，模块加载时注册即可生效。

> 安全边界：扩展点只加载**仓库内的代码**，不做远程下载、不 `eval` 字符串。
> 它解决的是"改一处、加一点"的便利性，不是给外部留的任意代码执行通道。

| 扩展点 | 作用 | 注册函数 |
|---|---|---|
| 菜单 | 胶囊/面板右键菜单加一项 | `registerMenuItem` / `registerMenu` |
| 控制动作 | `/dsh-hud <name>`、`control.json`、stdin 新增一个动作 | `registerControlAction` |
| 样式 | 给内嵌 DSH Web UI 追加 CSS | `registerCss` |

---

## 1. 右键菜单加一项

```js
// app/src/features/my-feature.js
const ext = require('../extensions');

ext.registerMenuItem({
  label: '打开插件市场',
  // hud 是 HudWindow 实例，可以直接调用它的方法
  click: ({ hud }) => hud._openExternalUrl('https://example.com'),
});
```

- `label` 必填；其余字段与 Electron `MenuItem` 构造参数一致
  （`type: 'checkbox'`、`enabled`、`submenu` 等）。
- `when(ctx)` 返回 `false` 时该项本次不出现（用于按状态显隐）。
- `click(ctx, ...args)` 抛错会被捕获并写进 `hud.log`，不会拖垮整个菜单。
- 返回值是一个注销函数。

然后在 `app/main.js` 顶部 `require('./src/features/my-feature');` 即接入。

## 2. 加一个控制动作

```js
const ext = require('../extensions');

ext.registerControlAction('snapshot', ({ hud }) => {
  hud._captureTo(path.join(hud._artifactsDir(), 'snapshot.png'));
});
```

三种触发方式，走同一张 handler 表：

```text
/dsh-hud snapshot                         # 在 DSH 里输入命令
{"seq":12,"action":"snapshot"}            # control.json
{"seq":12,"action":"snapshot"} + \n       # 子进程 stdin
```

- 动作名必须是 `^[a-z][a-z0-9-]*$`。
- 内置的 `show / hide / toggle / reload` 优先级更高，同名注册会被内置覆盖。
- 插件侧的 `/dsh-hud` 会把**不认识的输入原样转发**，所以新动作不需要改插件。
- 返回值同样是注销函数。

## 3. 给内嵌页面追加样式

```js
ext.registerCss('hide-usage-bar', '[class*="usageBar"] { display: none !important; }');
```

- 追加在 `compact-css.js` 的基础规则**之后**，同优先级时后者胜出。
- 同一个 `id` 重复注册会覆盖旧内容（改样式不用清缓存）。
- 想整体关掉紧凑样式（包括这些扩展）：`DSH_HUD_COMPACT_CSS=0`。

---

## 常见组合示例

**加一个"关于"菜单 + 一个 `about` 动作：**

```js
const ext = require('../extensions');
const { dialog } = require('electron');

ext.registerControlAction('about', ({ hud }) => {
  dialog.showMessageBox({ message: `DSH HUD ${require('../../package.json').version}` });
});

ext.registerMenuItem({
  label: '关于 DSH HUD',
  click: ({ hud }) => hud._extensionRunAction
    ? hud._extensionRunAction('about')
    : null,
});
```

（菜单项直接调动作时，用 `controlHandlers()` 取表即可，避免依赖内部方法。）

## 加功能时的检查清单

1. 新文件放 `app/src/features/`，在 `main.js` 里 `require` 一次。
2. 需要打包进 asar 的，确认在 `make-portable.js` 的 `APP_FILES`（`src` 整目录已包含）。
3. 加一条单测（参考 `tests/e2e/unit/extensions.test.cjs`）。
4. `node --test` 全绿后再 `node app/scripts/make-portable.js` 出包。

---

## 外部扩展目录（已实现 · P-03）

> 状态：**已实现**（2026-11-10）。除了上文「仓库内 `require`」，现在还可以不改源码、
> 不重新打包，把 `*.js` 丢进下面任意一个目录即可生效。

### 加载位置与顺序

1. `<exe 所在目录>\extensions\*.js` —— 便携版：把文件丢在 exe 旁边；
2. `%LOCALAPPDATA%\DSH HUD\extensions\*.js` —— 用户级目录，应用目录整体升级时不丢。

两个目录都会加载，按上面的顺序、每个目录内按文件名排序，保证启动顺序一致。
`DSH_HUD_NO_EXTENSIONS=1` 可整体关闭（排查问题用）。目录不存在是正常情况，静默跳过。

### 模块协议

```js
// extensions/my-thing.js —— 两种写法等价，任选一种
module.exports = (api) => {
  api.registerMenuItem({ label: '我的动作', click: () => {} });
  api.registerControlAction('my-thing', ({ hud }) => hud.showPanel());
  api.registerCss('my-thing', '.my-badge { outline: 1px solid red; }');
};
```

```js
// 或者对象形式（支持 id / protocolVersion）
module.exports = {
  id: 'my-thing',        // ^[a-z][a-z0-9-]*$，用于日志
  protocolVersion: 1,    // 不等于宿主 EXT_PROTOCOL 时跳过并记日志
  activate(api) { /* 同上的注册调用 */ },
};
```

- `api` 提供 `registerMenuItem` / `registerMenu` / `registerControlAction` / `registerCss`
  和 `log(...)`（写进 `hud.log`）。
- 目前**没有** `deactivate()` 回调：删除文件后重启应用即可卸载；`registerX` 返回的
  注销函数只在同一进程内有效。

### 安全边界

- **只加载本地磁盘上的 JS**：不下载、不 `eval` 字符串、不解析远程清单。
- 扩展与主进程同权限运行——加载一个扩展等于信任这个文件；发布说明与本文都写清楚。
- 不提供沙箱。将来若要支持第三方分发，先做签名/哈希校验，再谈自动加载。

### 失败隔离

- 每个文件独立 `try/catch`：`require` 抛错、没导出可调用函数、`protocolVersion` 不匹配，
  都只写日志（`[hud] extension failed/skipped: <file>: <err>`）并跳过该文件。
- 加载发生在建窗之前，任一扩展抛错都不阻断窗口创建。
- 扩展注册的菜单项 / 控制动作回调抛错，沿用现有隔离（捕获后写日志，不中断菜单或消息循环）。
- 单测：`tests/e2e/unit/extensions.test.cjs` 的「external files」用例覆盖了成功、抛错、
  非 js 文件、缺目录与 `DSH_HUD_NO_EXTENSIONS=1` 五种情况。

### 与内置扩展点的关系

内置扩展点（`app/src/features/`）优先：`show / hide / toggle / reload` 等内置动作不可被外部覆盖，
外部扩展只能新增动作名或新增样式，不能替换已有实现。

### 落地时的验收标准

1. 往 `extensions\` 放一个 `.js`，重启后右键菜单出现新项、`/dsh-hud <action>` 可触发，无需重新打包；
2. 放一个 `throw` 的文件，应用照常启动，`hud.log` 有对应记录；
3. `protocolVersion` 不匹配时只提示、不加载；
4. 删除文件并重启后，对应菜单项与动作消失，无残留。
