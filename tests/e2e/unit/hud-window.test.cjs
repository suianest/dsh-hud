'use strict';

// Headless acceptance tests for the window state machine / geometry / web
// embedding / persistence. Production modules are loaded unmodified; Electron
// is replaced by helpers/mock-electron.cjs.
//
// Run: node --test tests/e2e/unit/hud-window.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createMockElectron,
  installElectronMock,
  loadFresh,
  setEnv,
  delay,
  writeDiscovery,
} = require('./helpers/mock-electron.cjs');

installElectronMock();

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freshDiscovery(port = '61352', token = 'test-token') {
  return {
    pid: 9999,
    port,
    url: `http://127.0.0.1:${port}/?token=${token}`,
    updatedAt: new Date().toISOString(),
  };
}

function setup(opts = {}) {
  const dir = tempDir('dsh-hud-e2e-');
  const userData = path.join(dir, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  const discoveryFile = path.join(dir, 'discovery.json');

  if (opts.discovery) writeDiscovery(discoveryFile, opts.discovery);
  if (opts.state) {
    fs.writeFileSync(path.join(userData, 'window-state.json'), JSON.stringify(opts.state), 'utf8');
  }

  setEnv({
    DSH_HUD_USER_DATA: userData,
    DSH_HUD_DISCOVERY: discoveryFile,
    DSH_HUD_NO_ANIM: undefined,
    DSH_HUD_OPAQUE: undefined,
    DSH_HUD_DEV: undefined,
    DSH_HUD_DSH_EXE: undefined,
  });

  const mock = createMockElectron({ userData, ...opts.mock });
  const HudWindow = loadFresh(mock, 'src/hud-window.js');
  return { dir, userData, discoveryFile, mock, HudWindow };
}

function boot(ctx) {
  const hud = new ctx.HudWindow();
  const win = hud.create();
  hud.load();
  return { hud, win };
}

function escEvent() {
  return {
    type: 'keyDown',
    key: 'Escape',
    control: false,
    shift: false,
  };
}

test('create: frameless transparent 64x64 capsule icon window, screen-saver topmost, no taskbar', () => {
  const ctx = setup();
  const { hud, win } = boot(ctx);

  assert.equal(win.options.width, 64);
  assert.equal(win.options.height, 64);
  assert.equal(win.options.useContentSize, true);
  assert.equal(win.options.frame, false);
  assert.equal(win.options.transparent, true);
  assert.equal(win.options.skipTaskbar, true);
  assert.equal(win.options.resizable, false);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.sandbox, false);
  assert.deepEqual(win.alwaysOnTop, { flag: true, level: 'screen-saver' });
  assert.ok(win.loadedFile.endsWith(path.join('renderer', 'index.html')));
  assert.ok(hud.web && hud.web.view, 'WebContentsView created eagerly');

  hud.showCapsule();
  assert.equal(hud.mode, 'capsule');
  assert.deepEqual(win.getContentSize(), [64, 64]);
  assert.deepEqual(win.getPosition(), [1816, 936], 'default bottom-right of primary work area (-40 margin)');
  assert.equal(win.visible, true);
  assert.equal(win.showInactiveCalls, 1);
});

test('capsule click expands to the 520x720 panel; panel is positioned above capsule and clamped', () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud, win } = boot(ctx);
  hud.showCapsule();

  ctx.mock.ipcMain.emit('hud:drag-end', {}, { x: 1600, y: 936, moved: false });
  assert.equal(hud.mode, 'panel');
  assert.deepEqual(win.getContentSize(), [520, 720]);
  // capsule x=1600 -> panel clamped to 1920-520-8=1392; y=936-836=100.
  assert.deepEqual(win.getPosition(), [1392, 280]);
  assert.equal(win.showCalls, 1);
  assert.equal(win.focusCalls, 1, 'panel expand focuses the window');
  assert.equal(hud.web.attached, true, 'web view attached in panel mode');
  assert.deepEqual(hud.web.view.bounds, { x: 14, y: 60, width: 492, height: 646 }, 'initial web-host estimate');

  const shellSent = win.webContents.sent.filter((m) => m.channel === 'hud:state');
  assert.deepEqual(shellSent.at(-1).payload, { mode: 'panel', opaque: false });
});

test('drag moves capsule, snaps to edge, persists after debounce, and restores on restart', async () => {
  const ctx = setup();
  const { hud, win } = boot(ctx);
  hud.showCapsule();

  ctx.mock.ipcMain.emit('hud:drag-start', {}, { offsetX: 10, offsetY: 10 });
  ctx.mock.screen.setCursorScreenPoint({ x: 16, y: 510 });
  ctx.mock.ipcMain.emit('hud:drag-move', {}, {});
  ctx.mock.screen.setCursorScreenPoint({ x: 14, y: 510 });
  ctx.mock.ipcMain.emit('hud:drag-end', {}, { moved: true });

  assert.deepEqual(win.getPosition(), [8, 500], 'left edge snapped to CLAMP_MARGIN=8');
  await delay(550);

  const stateFile = path.join(ctx.userData, 'window-state.json');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(saved.capsule, { x: 8, y: 500 });

  // Simulated restart: fresh mock + fresh module cache, same userData.
  const mock2 = createMockElectron({ userData: ctx.userData });
  const HudWindow2 = loadFresh(mock2, 'src/hud-window.js');
  const hud2 = new HudWindow2();
  const win2 = hud2.create();
  hud2.showCapsule();
  assert.deepEqual(win2.getPosition(), [8, 500], 'position restored from window-state.json');
  assert.equal(hud2.mode, 'capsule');
});

test('panel drag remembers panel position separately (no edge snapping)', async () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud, win } = boot(ctx);
  hud.showPanel();

  ctx.mock.ipcMain.emit('hud:drag-start', {}, { offsetX: 12, offsetY: 12 });
  ctx.mock.screen.setCursorScreenPoint({ x: 312, y: 212 });
  ctx.mock.ipcMain.emit('hud:drag-end', {}, { moved: true });
  assert.deepEqual(win.getPosition(), [300, 200]);
  await delay(550);

  const saved = JSON.parse(fs.readFileSync(path.join(ctx.userData, 'window-state.json'), 'utf8'));
  assert.deepEqual(saved.panel, { x: 300, y: 200 });
  assert.equal(saved.capsule, null, 'capsule position untouched by panel drag');
});

test('Esc, blur and renderer collapse handshake return to capsule; 280ms timer is the fallback', async () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud, win } = boot(ctx);

  // renderer handshake
  hud.showPanel();
  hud.collapse();
  assert.equal(win.webContents.sent.some((m) => m.channel === 'hud:collapse-anim'), true);
  assert.deepEqual(win.getContentSize(), [520, 720], 'resize waits for the animation');
  ctx.mock.ipcMain.emit('hud:collapse-done');
  assert.equal(hud.mode, 'capsule');
  assert.deepEqual(win.getContentSize(), [64, 64]);
  assert.ok(win.hideCalls >= 1, 'hide() before showInactive() releases focus');

  // fallback timer when renderer never answers
  hud.showPanel();
  hud.collapse();
  await delay(360);
  assert.equal(hud.mode, 'capsule');
  assert.deepEqual(win.getContentSize(), [64, 64]);

  // Esc in the shell webContents
  hud.showPanel();
  let prevented = 0;
  win.webContents.emit('before-input-event', { preventDefault: () => { prevented += 1; } }, escEvent());
  assert.equal(prevented, 1);
  ctx.mock.ipcMain.emit('hud:collapse-done');
  assert.equal(hud.mode, 'capsule');

  // Esc inside the embedded Web UI is opt-in (t13 #13): DSH uses Esc to close
  // its own dialogs, so by default the view must not hijack it.
  hud.showPanel();
  let prevented2 = 0;
  hud.web.view.webContents.emit('before-input-event', { preventDefault: () => { prevented2 += 1; } }, escEvent());
  assert.equal(prevented2, 0, 'Esc in the view must not be hijacked by default');
  assert.equal(hud.mode, 'panel');
  hud.collapse();
  ctx.mock.ipcMain.emit('hud:collapse-done');
  assert.equal(hud.mode, 'capsule');

  // blur: default is "stay open" (opt-in collapse via DSH_HUD_BLUR_COLLAPSE=1)
  hud.showPanel();
  win.emit('blur');
  assert.equal(hud.mode, 'panel', 'blur must not collapse the panel by default');

  setEnv({ DSH_HUD_BLUR_COLLAPSE: '1' });
  win.emit('blur');
  ctx.mock.ipcMain.emit('hud:collapse-done');
  assert.equal(hud.mode, 'capsule');
  setEnv({ DSH_HUD_BLUR_COLLAPSE: undefined });
});

test('DSH_HUD_NO_ANIM=1 collapses immediately without the renderer handshake', () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud, win } = boot(ctx);
  hud.showPanel();
  const before = win.webContents.sent.filter((m) => m.channel === 'hud:collapse-anim').length;

  setEnv({ DSH_HUD_NO_ANIM: '1' });
  hud.collapse();
  assert.equal(hud.mode, 'capsule');
  assert.deepEqual(win.getContentSize(), [64, 64]);
  assert.equal(win.webContents.sent.filter((m) => m.channel === 'hud:collapse-anim').length, before);
  setEnv({ DSH_HUD_NO_ANIM: undefined });
});

test('global hotkey toggles both ways; registration failure degrades without crashing', () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud, win } = boot(ctx);

  assert.equal(hud.setupHotkey(), true);
  assert.equal(hud.hotkey.accelerator, 'Control+Alt+Space');
  assert.equal(hud.hotkey.isRegistered(), true);

  ctx.mock.globalShortcut._trigger('Control+Alt+Space');
  assert.equal(hud.mode, 'panel');
  ctx.mock.globalShortcut._trigger('Control+Alt+Space');
  ctx.mock.ipcMain.emit('hud:collapse-done');
  assert.equal(hud.mode, 'capsule');
  ctx.mock.globalShortcut._trigger('Control+Alt+Space');
  assert.equal(hud.mode, 'panel');
  ctx.mock.ipcMain.emit('hud:collapse-done');

  // A second HUD instance whose accelerator is taken must still boot.
  const mock2 = createMockElectron({ userData: ctx.userData, failAccelerators: ['Control+Alt+Space'] });
  const HudWindow2 = loadFresh(mock2, 'src/hud-window.js');
  const hud2 = new HudWindow2();
  hud2.create();
  const warnings = [];
  const oldWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    assert.equal(hud2.setupHotkey(), false);
  } finally {
    console.warn = oldWarn;
  }
  assert.equal(hud2.hotkey.isRegistered(), false);
  assert.equal(warnings.length, 1);
});

test('multi-display: restored capsule stays on secondary display; panel clamps into its work area', () => {
  const secondary = { x: 2000, y: 600 };
  const ctx = setup({
    state: { version: 1, capsule: secondary, panel: null },
    discovery: freshDiscovery(),
  });
  const { hud, win } = boot(ctx);

  hud.showCapsule();
  assert.deepEqual(win.getPosition(), [2000, 600], 'capsule on display 2 (DIP coords preserved)');

  hud.showPanel();
  // Display 2 work area is 1280x680 DIP: a 900-DIP panel cannot fit, so it is
  // top-left aligned with the 8-DIP margin (documented behavior, not a crash).
  assert.deepEqual(win.getContentSize(), [520, 720]);
  assert.deepEqual(win.getPosition(), [2000, 8]);
  assert.equal(ctx.mock.screen.getDisplayNearestPoint({ x: 2140, y: 632 }).id, 2);

  // DPI change / display topology change re-clamps both modes.
  ctx.mock.screen.emit('display-metrics-changed');
  assert.equal(hud.mode, 'panel');
  assert.deepEqual(win.getContentSize(), [520, 720]);

  hud.collapse();
  ctx.mock.ipcMain.emit('hud:collapse-done');
  ctx.mock.screen.emit('display-metrics-changed');
  assert.equal(hud.mode, 'capsule');
  assert.deepEqual(win.getContentSize(), [64, 64]);
  assert.deepEqual(win.getPosition(), [2000, 600]);

  // Secondary display is 150% DPI: all Electron geometry remains DIP, so the
  // logical size stays 660x900 regardless of the physical pixel ratio.
  assert.equal(ctx.mock.screen.getAllDisplays()[1].scaleFactor, 1.5);
});

test('no discovery + DSH not running: panel shows the self-drawn unreachable error page', () => {
  const ctx = setup();
  const { hud } = boot(ctx);
  hud.showPanel();

  const wc = hud.web.view.webContents;
  assert.equal(hud.web.attached, true);
  assert.equal(wc.loaded.length, 1);
  assert.equal(wc.loaded[0].type, 'file');
  assert.ok(wc.loaded[0].file.endsWith('error.html'));
  assert.deepEqual(wc.loaded[0].opts.query, {
    kind: 'unreachable',
    detail: '未找到 discovery.json（DSH 服务可能未启动）',
  });
  assert.equal(hud.web.lastKind, 'error');

  // The local error page must not receive the DSH compact CSS.
  wc.emit('did-finish-load');
  assert.equal(wc.css.length, 0);
});

test('stale discovery (dead port) turns did-fail-load into the error page with detail', () => {
  const stale = {
    pid: 22896,
    port: '50265',
    url: 'http://127.0.0.1:50265/?token=d29TluTNVp38c9LQs16TDFnXCLXgCXk8CCxPxC6ToLw',
    updatedAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
  };
  const ctx = setup({ discovery: stale });
  const { hud } = boot(ctx);
  hud.showPanel();

  const wc = hud.web.view.webContents;
  assert.equal(wc.loaded[0].type, 'url');
  assert.match(wc.loaded[0].url, /\?token=/);

  wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', wc.loaded[0].url, true);
  assert.equal(hud.web.lastKind, 'error');
  assert.equal(wc.loaded.at(-1).type, 'file');
  assert.equal(wc.loaded.at(-1).opts.query.kind, 'unreachable');
  assert.match(wc.loaded.at(-1).opts.query.detail, /ERR_CONNECTION_REFUSED/);
});

test('token bootstrap -> clean URL -> 401 refresh -> auth error page', () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud } = boot(ctx);
  hud.showPanel();
  const wc = hud.web.view.webContents;

  // Cold start always uses the token URL first.
  assert.equal(wc.loaded[0].url, 'http://127.0.0.1:61352/?token=test-token');
  assert.equal(hud.web.lastKind, 'token');

  wc.emit('did-finish-load');
  assert.equal(hud.web.bootstrapped, true);
  assert.equal(wc.css.length, 1, 'compact CSS injected once after the first successful load');

  // Subsequent loads use the clean URL (cookie auth).
  hud.web.reload();
  assert.equal(wc.loaded.at(-1).url, 'http://127.0.0.1:61352/', 'token stripped after bootstrap');
  assert.equal(hud.web.lastKind, 'clean');

  // Cookie went stale but discovery is fresh: transparent retry via token URL.
  ctx.mock._sessionHandlers.at(-1)({ resourceType: 'mainFrame', statusCode: 401, url: wc.loaded.at(-1).url });
  assert.equal(hud.web.lastKind, 'token');
  assert.equal(wc.loaded.at(-1).url, 'http://127.0.0.1:61352/?token=test-token');

  // Discovery is stale AND the clean load returns 401: the retry no longer
  // depends on the file's age (t13 #8) — exactly one token retry, then error.
  writeDiscovery(ctx.discoveryFile, {
    ...freshDiscovery(),
    updatedAt: new Date(Date.now() - 120_000).toISOString(),
  });
  wc.emit('did-finish-load'); // a fresh document resets the retry budget
  hud.web.reload();
  assert.equal(hud.web.lastKind, 'clean');
  ctx.mock._sessionHandlers.at(-1)({ resourceType: 'mainFrame', statusCode: 401, url: wc.loaded.at(-1).url });
  assert.equal(hud.web.lastKind, 'token', 'stale discovery still retries once with its token');
  ctx.mock._sessionHandlers.at(-1)({ resourceType: 'mainFrame', statusCode: 401, url: wc.loaded.at(-1).url });
  assert.equal(hud.web.lastKind, 'error');
  assert.equal(wc.loaded.at(-1).opts.query.kind, 'auth');
});

test('HTTP 500 maps to the http error page; subframe responses are ignored', () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud } = boot(ctx);
  hud.showPanel();
  const wc = hud.web.view.webContents;

  const handler = ctx.mock._sessionHandlers.at(-1);
  handler({ resourceType: 'subFrame', statusCode: 500, url: 'http://x/frame' });
  assert.equal(hud.web.lastKind, 'token', 'subframe errors do not replace the page');

  handler({ resourceType: 'mainFrame', statusCode: 500, url: 'http://127.0.0.1:61352/' });
  assert.equal(hud.web.lastKind, 'error');
  assert.equal(wc.loaded.at(-1).opts.query.kind, 'http');
});

test('web bounds IPC repositions the view; collapse detaches but keeps the view alive', () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud } = boot(ctx);
  hud.showPanel();

  const rect = { x: 20, y: 66, width: 480, height: 634 };
  ctx.mock.ipcMain.emit('hud:web-bounds', {}, rect);
  assert.deepEqual(hud.web.view.bounds, rect);
  assert.equal(ctx.mock._state.windows[0].contentView.children.includes(hud.web.view), true);

  hud.collapse();
  ctx.mock.ipcMain.emit('hud:collapse-done');
  assert.equal(hud.web.attached, false);
  assert.equal(ctx.mock._state.windows[0].contentView.children.includes(hud.web.view), false);
  assert.equal(hud.web.view.bounds === null, false, 'bounds retained for the next expand');

  hud.showPanel();
  assert.equal(hud.web.attached, true);
  assert.equal(ctx.mock.ipcMain.listenerCount('hud:web-retry'), 1);
  assert.equal(ctx.mock.ipcMain.listenerCount('hud:web-start-dsh'), 1);
});

test('error page retry IPC forces a token reload; startDsh reuses discovery when present', () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud } = boot(ctx);
  hud.showPanel();
  const wc = hud.web.view.webContents;
  const before = wc.loaded.length;

  ctx.mock.ipcMain.emit('hud:web-retry');
  assert.equal(wc.loaded.length, before + 1);
  assert.match(wc.loaded.at(-1).url, /\?token=test-token/, 'retry uses the fresh token URL');

  ctx.mock.ipcMain.emit('hud:web-start-dsh');
  assert.equal(wc.loaded.length, before + 2);
  assert.match(wc.loaded.at(-1).url, /\?token=test-token/);
});

test('context menu template exposes the 2 primary actions plus the autostart group (t18, t20)', () => {
  // Isolate from this machine's real login entry: a dsh-hud.cmd exists in the
  // user's Startup folder after enabling autostart, which would make the
  // checkbox legitimately checked. Point the check at a path that cannot exist.
  const savedStartup = process.env.DSH_HUD_STARTUP_CMD;
  process.env.DSH_HUD_STARTUP_CMD = path.join(os.tmpdir(), 'dsh-hud-test-no-such-startup.cmd');
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud } = boot(ctx);

  const tpl = hud.buildContextMenu();
  const labels = tpl.filter((i) => i.type !== 'separator').map((i) => i.label);
  // 「关闭 DSH 浮窗」在 t20 移除：胶囊与面板是点击联动的，面板右上角已有 ×。
  assert.deepEqual(labels, ['打开 DSH 桌面窗口', '打开 DSH 浮窗', 'Token 补充', '退出 DSH 浮窗', '开机自启']);

  const autostart = tpl.find((i) => i.label === '开机自启');
  assert.equal(autostart.type, 'checkbox');
  if (savedStartup === undefined) delete process.env.DSH_HUD_STARTUP_CMD;
  else process.env.DSH_HUD_STARTUP_CMD = savedStartup;
  assert.equal(autostart.checked, false, 'autostart off by default (no login item)');
});

test('right sidebar opens outward: panel widens to 1040 DIP and keeps the left edge (2026-11-08)', () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud, win } = boot(ctx);
  hud.showPanel();
  assert.deepEqual(win.getContentSize(), [520, 720]);

  // Park the panel away from the screen edge so widening cannot hit the clamp.
  win.setPosition(200, 200);
  ctx.mock.ipcMain.emit('hud:rightbar', {}, true);
  assert.deepEqual(win.getContentSize(), [900, 720], 'right column gets 380 DIP more width');
  assert.equal(win.getPosition()[0], 200, 'left edge stays put: growth is outward to the right');

  // Reports that arrive right after our own resize are ignored: they are the
  // layout reacting to the new width, not a user action (flicker fix).
  ctx.mock.ipcMain.emit('hud:rightbar', {}, false);
  assert.deepEqual(win.getContentSize(), [900, 720], 'cooldown swallows self-induced reports');

  hud._rightbarCooldownUntil = 0; // cooldown over
  ctx.mock.ipcMain.emit('hud:rightbar', {}, false);
  assert.deepEqual(win.getContentSize(), [520, 720]);
  assert.equal(win.getPosition()[0], 200);
});

test('panel only widens while the mouse button is held on an edge grip (2026-11-08)', async () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud, win } = boot(ctx);
  hud.showPanel();
  win.setPosition(200, 200);
  assert.deepEqual(win.getContentSize(), [520, 720]);

  ctx.mock.screen.setCursorScreenPoint({ x: 600, y: 400 });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(win.getContentSize(), [520, 720], 'hover alone must not resize');

  ctx.mock.ipcMain.emit('hud:resize-start', {}, 'right');
  ctx.mock.ipcMain.emit('hud:resize-move', {}, { dx: 200, dy: 0 });
  assert.deepEqual(win.getContentSize(), [720, 720], 'width follows the drag');
  assert.equal(win.getPosition()[0], 200, 'right grip grows outward');

  // Holding the button without moving must never resize (regression: a cursor
  // poll loop used to grow the panel without bound, 2026-11-10).
  for (let i = 0; i < 25; i++) {
    ctx.mock.ipcMain.emit('hud:resize-move', {}, { dx: 200, dy: 0 });
  }
  assert.deepEqual(win.getContentSize(), [720, 720], 'a held button does not grow the window');

  ctx.mock.ipcMain.emit('hud:resize-end', {});
  const w = win.getContentSize()[0];
  ctx.mock.ipcMain.emit('hud:resize-move', {}, { dx: 400, dy: 0 });
  assert.equal(win.getContentSize()[0], w, 'release freezes the width');

  const b = win.getBounds();
  ctx.mock.ipcMain.emit('hud:resize-start', {}, 'left');
  ctx.mock.ipcMain.emit('hud:resize-move', {}, { dx: -120, dy: 0 });
  const nb = win.getBounds();
  assert.equal(nb.width, w + 120, 'left grip grows outward too');
  assert.equal(nb.x + nb.width, b.x + b.width, 'right edge is pinned');
  hud.destroy();
});

test('top and bottom edges resize the panel height (2026-11-08)', async () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud, win } = boot(ctx);
  hud.showPanel();
  // Start at y=60: a 720-DIP panel + 60-DIP bottom drag + 60-DIP top drag all
  // stay inside the 1080-DIP work area, so the clamp never kicks in.
  win.setPosition(200, 60);
  assert.deepEqual(win.getContentSize(), [520, 720]);

  // Bottom grip: top edge stays, height follows the drag.
  ctx.mock.ipcMain.emit('hud:resize-start', {}, 'bottom');
  ctx.mock.ipcMain.emit('hud:resize-move', {}, { dx: 0, dy: 60 });
  assert.deepEqual(win.getContentSize(), [520, 780], 'height follows the bottom drag');
  assert.equal(win.getPosition()[1], 60, 'top edge pinned');
  ctx.mock.ipcMain.emit('hud:resize-end', {});

  // Top grip: bottom edge stays, window moves up with the drag.
  const b = win.getBounds();
  ctx.mock.ipcMain.emit('hud:resize-start', {}, 'top');
  ctx.mock.ipcMain.emit('hud:resize-move', {}, { dx: 0, dy: -60 });
  const nb = win.getBounds();
  assert.equal(nb.height, b.height + 60, 'top grip grows upward');
  assert.equal(nb.y + nb.height, b.y + b.height, 'bottom edge pinned');
  hud.destroy();
});

test('menu "Token 补充" opens the top-up page in its own window, not the system browser', () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud } = boot(ctx);
  const before = ctx.mock._state.windows.length;

  const item = hud.buildContextMenu().find((i) => i.label === 'Token 补充');
  item.click();

  assert.equal(ctx.mock._state.windows.length, before + 1, 'one dedicated window is created');
  const win = ctx.mock._state.windows.at(-1);
  const loaded = win.webContents.loaded.at(-1);
  assert.equal(loaded.url, 'https://platform.deepseek.com/usage');
  assert.equal(loaded.type, 'url');
  assert.equal(ctx.mock._openedExternally.length, 0, 'must not depend on the system browser');

  // Second click raises the same window instead of stacking copies.
  item.click();
  assert.equal(ctx.mock._state.windows.length, before + 1, 'window is reused');
  assert.ok(win.showCalls >= 1);
});

test('destroy() after the BrowserWindow is already gone must not throw (user crash on quit)', () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud, win } = boot(ctx);

  // Reproduce the real quit order: app windows are destroyed first, then
  // will-quit calls HudWindow.destroy(). Removing the WebContentsView from a
  // destroyed window used to raise "Object has been destroyed" in the main
  // process (electron dialog on close, 2026-11-06).
  win.destroyed = true;
  win.contentView.removeChildView = () => {
    throw new Error('Object has been destroyed');
  };
  assert.doesNotThrow(() => hud.destroy());
  assert.equal(hud.web, null, 'web embed reference released');
});

test('quit persists the current capsule position before exiting (t18)', () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud, win } = boot(ctx);

  // Move to a known non-default position, then quit: the position must be
  // flushed synchronously to window-state.json before app.quit().
  win.setPosition(100, 200);
  hud.quit();

  assert.equal(ctx.mock._state.quitCalls, 1, 'quit calls app.quit exactly once');
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.userData, 'window-state.json'), 'utf8'));
  assert.deepEqual(saved.capsule, { x: 100, y: 200 }, 'capsule position persisted before quit');
});

test('error recovery is a single episode: repeated showError must not reset the tick budget (t21)', () => {
  const ctx = setup(); // no discovery -> error page + recovery
  const { hud } = boot(ctx);
  hud.showPanel();
  const web = hud.web;
  const wc = web.view.webContents;

  // First failure starts the recovery episode with a fresh tick budget.
  assert.equal(web.lastKind, 'error');
  assert.equal(web._recovering, true);
  assert.equal(web._recoveryTicks, 0);

  // Several minutes of failed reconnects: the error page's own reload ->
  // showError round-trip must NOT reset the budget, otherwise the ~2-minute
  // cap (24 ticks * 5s) never fires and the page reconnects forever (t21 #3).
  web._recoveryTicks = 7;
  web.showError('unreachable', 'still down');
  assert.equal(web._recoveryTicks, 7, 're-entrant showError must not reset ticks');
  assert.equal(web._recovering, true);

  // A successful (non-error) load ends the episode and clears the flag.
  web.lastKind = 'token';
  wc.emit('did-finish-load');
  assert.equal(web._recovering, false, 'successful load ends the recovery episode');

  // The NEXT failure starts a brand-new episode with a fresh budget.
  web.showError('unreachable', 'down again');
  assert.equal(web._recoveryTicks, 0, 'fresh episode resets the tick budget');
  assert.equal(web._recovering, true);
});

test('detach() and destroy() stop the recovery timer (t24 #2)', () => {
  const ctx = setup(); // no discovery -> error page + recovery
  const { hud } = boot(ctx);
  hud.showPanel();
  const web = hud.web;

  // Recovery is polling while the error page is up.
  assert.equal(web._recovering, true);
  assert.ok(web._recoveryTimer, 'recovery timer active on the error page');

  // Collapsing the panel detaches the view, which must stop the recovery poll:
  // reloads make no sense while the view is hidden (t20 #8).
  hud.showCapsule();
  assert.equal(web._recovering, false, 'detach stops the recovery episode');
  assert.equal(web._recoveryTimer, null, 'recovery timer cleared on detach');

  // A later failure starts a fresh episode (the view is still alive, only detached).
  web.showError('unreachable', 'still down');
  assert.equal(web._recovering, true, 'fresh episode after re-show');
  assert.ok(web._recoveryTimer, 'recovery timer restarted');

  // destroy() also stops the recovery poll (idempotent; t20 #8).
  hud.destroy();
  assert.equal(web._recovering, false, 'destroy stops the recovery episode');
  assert.equal(web._recoveryTimer, null, 'recovery timer cleared on destroy');
});

test('theme from embedded page is pushed to the shell renderer and persisted (t34)', () => {
  const ctx = setup(); // theme flow needs no discovery
  const { hud, win } = boot(ctx);

  // { theme: 'light' } object payload -> shell gets hud:theme 'light'.
  ctx.mock.ipcMain.emit('hud:web-theme', {}, { theme: 'light' });
  assert.ok(
    win.webContents.sent.some((s) => s.channel === 'hud:theme' && s.payload === 'light'),
    'light theme relayed to the shell renderer'
  );

  // Unknown value normalises to dark (setEmbeddedTheme guard).
  ctx.mock.ipcMain.emit('hud:web-theme', {}, { theme: 'bogus' });
  assert.ok(
    win.webContents.sent.some((s) => s.channel === 'hud:theme' && s.payload === 'dark'),
    'unknown theme normalises to dark'
  );

  // Bare-string payload (t31 backward compat) still relays light.
  ctx.mock.ipcMain.emit('hud:web-theme', {}, 'light');
  assert.equal(
    win.webContents.sent.filter((s) => s.channel === 'hud:theme' && s.payload === 'light').length,
    2,
    'bare-string payload also relays light'
  );

  // Persisted to userData/theme.json for the next launch (dark default avoided).
  const themeFile = path.join(ctx.userData, 'theme.json');
  assert.ok(fs.existsSync(themeFile), 'theme persisted to userData');
  assert.deepEqual(JSON.parse(fs.readFileSync(themeFile, 'utf8')), { theme: 'light' });
});

test('Ctrl+K command palette detaches the web view and re-attaches on close (t35)', () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud, win } = boot(ctx);

  hud.showPanel();
  assert.equal(hud.web.attached, true, 'web view attached when the panel opens');

  hud._openPalette();
  assert.equal(hud.web.attached, false, 'palette detaches the web view');
  const openMsg = win.webContents.sent.find((s) => s.channel === 'hud:palette-open');
  assert.ok(openMsg, 'palette-open pushed to the shell renderer');
  const labels = (openMsg.payload && openMsg.payload.items || []).map((it) => it.label);
  assert.deepEqual(
    labels.slice(0, 3),
    ['打开 DSH 桌面窗口', '打开 DSH 浮窗', 'Token 补充'],
    'three built-in actions lead the palette'
  );

  ctx.mock.ipcMain.emit('hud:palette-exec', {}, { id: 'open-dsh-panel' });
  assert.equal(hud.web.attached, true, 'executing a palette item re-attaches the web view');
});

test('a resized panel keeps its size when collapsed, re-expanded and dragged (t38 B1)', () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud, win } = boot(ctx);
  hud.showPanel();
  win.setPosition(200, 200);

  ctx.mock.ipcMain.emit('hud:resize-start', {}, 'right');
  ctx.mock.ipcMain.emit('hud:resize-move', {}, { dx: 200, dy: 0 });
  ctx.mock.ipcMain.emit('hud:resize-end', {});
  assert.deepEqual(win.getContentSize(), [720, 720], 'user resize applied');

  hud.collapse();
  hud._finishCollapse();
  hud.showPanel();
  assert.deepEqual(win.getContentSize(), [720, 720], 'collapse + re-expand keeps the user size');

  ctx.mock.screen.setCursorScreenPoint({ x: 500, y: 400 });
  ctx.mock.ipcMain.emit('hud:drag-start', {}, { offsetX: 10, offsetY: 10 });
  ctx.mock.ipcMain.emit('hud:drag-move', {});
  ctx.mock.ipcMain.emit('hud:drag-end', {}, { moved: true });
  assert.deepEqual(win.getContentSize(), [720, 720], 'dragging keeps the user size');
  hud.destroy();
});

test('collapsing with the palette open closes it and re-attaches the view (t38 H1)', () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud } = boot(ctx);
  hud.showPanel();

  hud._openPalette();
  assert.equal(hud._paletteOpen, true);
  assert.equal(hud.web.attached, false, 'palette detaches the view');

  hud.collapse();
  hud._finishCollapse();
  assert.equal(hud._paletteOpen, false, 'collapse resets the palette flag');

  hud.showPanel();
  assert.equal(hud.web.attached, true, 'expanding re-attaches the view');
  hud._openPalette();
  assert.equal(hud._paletteOpen, true, 'palette can be opened again after a collapse');
  hud.destroy();
});

test('the palette shortcut toggles: pressing it again closes the palette (2026-11-10)', () => {
  const ctx = setup({ discovery: freshDiscovery() });
  const { hud } = boot(ctx);
  hud.showPanel();

  hud._togglePalette();
  assert.equal(hud._paletteOpen, true, 'first press opens');
  assert.equal(hud.web.attached, false);

  hud._togglePalette();
  assert.equal(hud._paletteOpen, false, 'second press closes');
  assert.equal(hud.web.attached, true, 'closing re-attaches the embedded view');

  ctx.mock.ipcMain.emit('hud:palette-open-request', {});
  assert.equal(hud._paletteOpen, true, 'toolbar button opens too');
  ctx.mock.ipcMain.emit('hud:palette-open-request', {});
  assert.equal(hud._paletteOpen, false, 'toolbar button toggles closed');
  hud.destroy();
});
