'use strict';

// ---------------------------------------------------------------------------
// extensions — 三个正式预留的扩展点（给后续加功能用）。
//
// 设计原则：
//   - **只加载仓库内的代码**，不做远程下载、不 eval 字符串。所谓"后门"是指
//     留好的插槽，不是任意代码执行入口。
//   - 三种扩展点覆盖了绝大多数"加个小功能"的场景：
//       1. menu    — 右键菜单加一项（打开某个窗口、触发某个动作）
//       2. control — 给 /dsh-hud 命令与 control.json 加一个动作
//       3. css     — 给内嵌 DSH Web UI 追加一小段样式
//   - 注册在模块 require 时完成即可（main.js 之后才创建窗口/控制桥）。
//
// 用法示例（新建 app/src/features/my-feature.js，并在 main.js 里 require）：
//
//   const ext = require('../extensions');
//   ext.registerMenuItem({
//     label: '打开插件市场',
//     click: ({ hud }) => hud._openExternalUrl('https://example.com'),
//   });
//   ext.registerControlAction('market', ({ hud }) => hud.showPanel());
//   ext.registerCss('market-badge', '.my-badge { outline: 1px solid red; }');
//
// 然后用 `/dsh-hud market` 触发该动作。
// ---------------------------------------------------------------------------

const MENU = [];
const CONTROL = Object.create(null);
const CSS = new Map();

const fs = require('fs');
const path = require('path');

// Bump when the extension API changes incompatibly; extension files that
// declare a different `protocolVersion` are skipped instead of half-working.
const EXT_PROTOCOL = 1;

const ACTION_RE = /^[a-z][a-z0-9-]*$/;

function assertAction(name) {
  if (typeof name !== 'string' || !ACTION_RE.test(name)) {
    throw new Error(`extension action name must match ${ACTION_RE}, got: ${String(name)}`);
  }
}

// ---- menu -----------------------------------------------------------------

// 单项注册。item 与 Electron MenuItem 的构造参数同形，额外支持
// when(ctx) 返回 false 时跳过（用于按状态显隐）。
function registerMenuItem(item) {
  if (!item || typeof item.label !== 'string') {
    throw new Error('registerMenuItem: item.label is required');
  }
  MENU.push(item);
  return () => {
    const i = MENU.indexOf(item);
    if (i >= 0) MENU.splice(i, 1);
  };
}

// 批量注册（数组），常用于一个功能模块内。
function registerMenu(items) {
  if (!Array.isArray(items)) throw new Error('registerMenu: expected an array');
  return items.map(registerMenuItem);
}

// hud-window 构建右键菜单时调用，返回已展开的片段（顺序 = 注册顺序）。
function menuItems(ctx) {
  const out = [];
  for (const item of MENU) {
    try {
      if (typeof item.when === 'function' && !item.when(ctx)) continue;
    } catch (err) {
      console.error('[hud] extension menu when() failed:', err && err.message);
      continue;
    }
    const { when, ...rest } = item;
    out.push(rest);
  }
  return out;
}

// ---- control actions ------------------------------------------------------

// 给 control.json / stdin / `/dsh-hud <name>` 增加一个动作。ctx 里会有
// { hud }（HudWindow 实例），可以直接操作窗口。
function registerControlAction(name, handler) {
  assertAction(name);
  if (typeof handler !== 'function') {
    throw new Error('registerControlAction: handler must be a function');
  }
  CONTROL[name] = handler;
  return () => {
    delete CONTROL[name];
  };
}

// ControlBridge 构造时合并进 handlers；已注册的动作可被 main.js 传入的
// 内置 handler 覆盖（内置优先）。
function controlHandlers() {
  return { ...CONTROL };
}

// ---- css ------------------------------------------------------------------

// 给内嵌 Web UI 追加一段 CSS。同一个 id 重复注册会替换（改样式不用清缓存）。
function registerCss(id, text) {
  if (typeof id !== 'string' || !id) throw new Error('registerCss: id is required');
  if (typeof text !== 'string' || !text.trim()) throw new Error('registerCss: css text is required');
  CSS.set(id, text);
  return () => CSS.delete(id);
}

function extraCss() {
  if (!CSS.size) return '';
  return [...CSS.entries()]
    .map(([id, text]) => `/* extension: ${id} */\n${text.trim()}`)
    .join('\n\n');
}


// ---- external extension files (P-03) --------------------------------------
//
// Drop-in directory loader: every `*.js` file in the given folders is
// `require`d once at startup and called with the extension API. This is how a
// user adds a feature without touching (or rebuilding) the app source.
//
// Security posture (deliberate):
//   - local files only — nothing is downloaded, nothing is eval'd;
//   - the file gets the registration API below, not `require` of arbitrary
//     modules, though since it runs in the main process it is still trusted
//     code. Treat an extension file like a plugin you chose to install.
//
// A file may either `module.exports = (ext) => { ... }` or export
// `{ setup(ext) }`. Errors are reported and never abort startup.

function _extensionDirs(dirs) {
  if (Array.isArray(dirs)) return dirs.filter((d) => typeof d === 'string' && d);
  return dirs ? [dirs] : [];
}

function loadExtensionFiles(dirs, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const loaded = [];
  if (process.env.DSH_HUD_NO_EXTENSIONS === '1') {
    log('[hud] extensions disabled by DSH_HUD_NO_EXTENSIONS=1');
    return loaded;
  }
  const api = {
    registerMenuItem,
    registerMenu,
    registerControlAction,
    registerCss,
    log,
  };
  for (const dir of _extensionDirs(dirs)) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue; // missing directory is the normal case
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.js')) continue;
      const full = path.join(dir, entry.name);
      try {
        const mod = require(full);
        if (mod && mod.protocolVersion != null && mod.protocolVersion !== EXT_PROTOCOL) {
          log(`[hud] extension skipped (protocol ${mod.protocolVersion} != ${EXT_PROTOCOL}): ${full}`);
          continue;
        }
        let setup = null;
        if (typeof mod === 'function') setup = mod;
        else if (mod && typeof mod.activate === 'function') setup = mod.activate.bind(mod);
        else if (mod && typeof mod.setup === 'function') setup = mod.setup.bind(mod);
        if (!setup) {
          log(`[hud] extension skipped (export a function, activate() or setup()): ${full}`);
          continue;
        }
        setup(api);
        loaded.push(full);
        log(`[hud] extension loaded${mod && mod.id ? ` (${mod.id})` : ''}: ${full}`);
      } catch (err) {
        log(`[hud] extension failed: ${full}: ${(err && err.message) || err}`);
      }
    }
  }
  return loaded;
}

// ---- test helpers ---------------------------------------------------------

function _reset() {
  MENU.length = 0;
  for (const k of Object.keys(CONTROL)) delete CONTROL[k];
  CSS.clear();
}

module.exports = {
  registerMenuItem,
  registerMenu,
  menuItems,
  registerControlAction,
  controlHandlers,
  registerCss,
  extraCss,
  loadExtensionFiles,
  EXT_PROTOCOL,
  _reset,
};
