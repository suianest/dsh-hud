'use strict';

// Headless acceptance tests for the pure/isolated app modules:
//   src/discovery.js, src/window-state.js, src/hotkeys.js
// Run: node --test tests/e2e/unit/core.test.cjs

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

test('discovery: missing / corrupt / valid file, token + clean URL, age', () => {
  const dir = tempDir('dsh-disc-');
  const file = path.join(dir, 'discovery.json');
  setEnv({ DSH_HUD_DISCOVERY: file });

  const disc = loadFresh(createMockElectron(), 'src/discovery.js');

  assert.equal(disc.discoveryPath(), file);
  assert.equal(disc.readDiscovery(), null, 'missing file -> null');

  fs.writeFileSync(file, '{ not json', 'utf8');
  assert.equal(disc.readDiscovery(), null, 'corrupt JSON -> null');

  const now = new Date();
  writeDiscovery(file, {
    pid: 4242,
    port: '61352',
    url: 'http://127.0.0.1:61352/?token=abc123&x=1',
    updatedAt: now.toISOString(),
  });
  const d = disc.readDiscovery();
  assert.equal(d.pid, 4242);
  assert.equal(disc.tokenUrl(d), 'http://127.0.0.1:61352/?token=abc123&x=1');

  const clean = new URL(disc.cleanUrl(d));
  assert.equal(clean.searchParams.get('token'), null, 'token stripped');
  assert.equal(clean.searchParams.get('x'), '1', 'other query params preserved');
  assert.ok(disc.ageMs(d) >= 0 && disc.ageMs(d) < 5000, 'fresh age');
  assert.equal(disc.ageMs({ updatedAt: 'not-a-date' }), Infinity);
  assert.equal(disc.ageMs({}), Infinity);
  assert.equal(disc.tokenUrl({ url: '' }), null);
  assert.equal(disc.cleanUrl({ url: 'not a url' }), 'not a url', 'unparseable url falls back');
});

test('window-state: defaults, immediate atomic write, debounce, corrupt tolerance', async () => {
  const dir = tempDir('dsh-state-');
  const mock = createMockElectron({ userData: dir });
  const ws = loadFresh(mock, 'src/window-state.js');

  assert.deepEqual(ws.load(), { version: 1, capsule: null, panel: null });
  assert.equal(ws.statePath(), path.join(dir, 'window-state.json'));

  ws.save({ version: 1, capsule: { x: 12, y: 34 }, panel: { x: 56, y: 78 } }, { immediate: true });
  const parsed = JSON.parse(fs.readFileSync(ws.statePath(), 'utf8'));
  assert.deepEqual(parsed, { version: 1, capsule: { x: 12, y: 34 }, panel: { x: 56, y: 78 } });
  assert.equal(fs.existsSync(`${ws.statePath()}.tmp`), false, 'tmp file renamed away');

  const debounced = path.join(dir, 'window-state.json');
  ws.save({ version: 1, capsule: { x: 100, y: 200 }, panel: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(debounced, 'utf8')).capsule, { x: 12, y: 34 }, 'not yet written');
  await delay(550);
  assert.deepEqual(JSON.parse(fs.readFileSync(debounced, 'utf8')).capsule, { x: 100, y: 200 }, 'written after debounce');

  fs.writeFileSync(debounced, '{broken', 'utf8');
  assert.deepEqual(ws.load(), { version: 1, capsule: null, panel: null }, 'corrupt -> defaults');

  fs.writeFileSync(
    debounced,
    JSON.stringify({ version: 1, capsule: { x: 1.6, y: 2.4 }, panel: { x: 'bad', y: 9 } }),
    'utf8'
  );
  assert.deepEqual(ws.load().capsule, { x: 2, y: 2 }, 'rounded');
  assert.equal(ws.load().panel, null, 'invalid panel ignored');
});

test('hotkeys: default accelerator registers, trigger fires, update persists, dispose unregisters', () => {
  const dir = tempDir('dsh-hotkey-');
  const mock = createMockElectron({ userData: dir, failAccelerators: [] });
  const hk = loadFresh(mock, 'src/hotkeys.js');

  assert.equal(hk.hotkeyPath(), path.join(dir, 'hotkey.json'));
  assert.equal(hk.loadAccelerator(), 'Control+Alt+Space');

  let fired = 0;
  const c = hk.createHotkeyController();
  assert.equal(c.register(() => { fired += 1; }), true);
  assert.equal(c.isRegistered(), true);
  assert.equal(c.accelerator, 'Control+Alt+Space');
  assert.equal(mock.globalShortcut._trigger('Control+Alt+Space'), true);
  assert.equal(fired, 1);

  assert.equal(c.update('Alt+Shift+H'), true);
  assert.equal(c.accelerator, 'Alt+Shift+H');
  assert.equal(mock.globalShortcut.isRegistered('Control+Alt+Space'), false, 'old accel unregistered');
  assert.equal(mock.globalShortcut.isRegistered('Alt+Shift+H'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(hk.hotkeyPath(), 'utf8')), { accelerator: 'Alt+Shift+H' });
  assert.equal(hk.loadAccelerator(), 'Alt+Shift+H', 'persisted across controller instances');

  c.dispose();
  assert.equal(c.isRegistered(), false);
  assert.equal(mock.globalShortcut.isRegistered('Alt+Shift+H'), false);
});

test('hotkeys: registration failure is non-fatal and warned', () => {
  const mock = createMockElectron({ failAccelerators: ['Control+Alt+Space'] });
  const hk = loadFresh(mock, 'src/hotkeys.js');
  const c = hk.createHotkeyController();

  const warnings = [];
  const oldWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    assert.equal(c.register(() => {}), false);
  } finally {
    console.warn = oldWarn;
  }
  assert.equal(c.isRegistered(), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /全局热键注册失败/);
  assert.equal(c.update(''), false, 'empty accelerator rejected');
});

test('host-bounds: readHostBounds uses layout size, immune to scale transforms (t21)', () => {
  const { readHostBounds } = require('../../../app/renderer/host-bounds.js');

  // A mid-expand-animation element: getBoundingClientRect() returns the scaled
  // rect (492*0.96 x 646*0.96), while offsetWidth/offsetHeight stay at layout
  // size. readHostBounds must report the layout size so the WebContentsView is
  // not sized ~4% too small (t21 #3).
  const scaled = {
    offsetWidth: 492,
    offsetHeight: 646,
    getBoundingClientRect: () => ({ x: 14, y: 60, width: 472.32, height: 620.16 }),
  };
  assert.deepEqual(readHostBounds(scaled), { x: 14, y: 60, width: 492, height: 646 });

  // Not laid out yet (display:none) => null, so callers skip the report.
  const hidden = {
    offsetWidth: 0,
    offsetHeight: 0,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  };
  assert.equal(readHostBounds(hidden), null);
});
