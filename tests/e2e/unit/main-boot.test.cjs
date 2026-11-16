'use strict';

// Headless boot test for the real app entry (app/main.js): single-instance
// behavior, window creation, hotkey registration, ready-to-show -> capsule,
// second-instance -> panel, will-quit -> shortcut cleanup.
//
// Run: node --test tests/e2e/unit/main-boot.test.cjs

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
} = require('./helpers/mock-electron.cjs');

installElectronMock();

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function prepEnv() {
  const dir = tempDir('dsh-main-');
  setEnv({
    DSH_HUD_USER_DATA: path.join(dir, 'userdata'),
    DSH_HUD_DISCOVERY: path.join(dir, 'discovery.json'),
    DSH_HUD_DEV: undefined,
  });
  fs.mkdirSync(path.join(dir, 'userdata'), { recursive: true });
  return dir;
}

test('main.js: boots one window, registers hotkey, loads shell, shows capsule on ready-to-show', async () => {
  prepEnv();
  const mock = createMockElectron();
  const mainPath = path.resolve(__dirname, '..', '..', '..', 'app', 'main.js');

  // loadFresh expects a relative module path under app/; main.js is directly
  // under app/, so require it explicitly after pointing the mock.
  const Module = require('module');
  const hudAppRoot = path.resolve(__dirname, '..', '..', '..', 'app');
  for (const key of Object.keys(require.cache)) if (key.startsWith(hudAppRoot)) delete require.cache[key];
  // eslint-disable-next-line no-underscore-dangle
  const activeMockSetter = require('./helpers/mock-electron.cjs');
  activeMockSetter.loadFresh(mock, 'src/constants.js'); // activates the mock
  require(mainPath);

  await delay(20);

  assert.equal(mock._state.windows.length, 1, 'exactly one HUD window');
  const win = mock._state.windows[0];
  assert.equal(win.options.width, 64);
  assert.equal(win.options.height, 64);
  assert.equal(win.options.frame, false);
  assert.equal(win.options.transparent, true);
  assert.ok(win.loadedFile.endsWith(path.join('renderer', 'index.html')));
  assert.equal(mock.globalShortcut.isRegistered('Control+Alt+Space'), true, 'default hotkey registered');

  win.emit('ready-to-show');
  assert.equal(win.visible, true, 'capsule visible after ready-to-show');
  assert.deepEqual(win.getContentSize(), [64, 64]);
  const states = win.webContents.sent.filter((m) => m.channel === 'hud:state');
  assert.deepEqual(states.at(-1).payload, { mode: 'capsule', opaque: false });

  const focusesBefore = win.focusCalls;
  mock.app.emit('second-instance');
  // D4: a second launch must NOT force the panel open; it only focuses an
  // already-visible HUD (here: the capsule is visible).
  assert.deepEqual(win.getContentSize(), [64, 64], 'second launch must not expand the panel');
  assert.equal(win.focusCalls, focusesBefore + 1, 'second launch focuses the visible capsule');

  mock.app.emit('will-quit');
  assert.equal(mock.globalShortcut.isRegistered('Control+Alt+Space'), false, 'will-quit unregisters all shortcuts');
  assert.equal(mock._shortcuts.size, 0);
});

test('main.js: second instance without the lock quits immediately and creates no window', async () => {
  prepEnv();
  const mock = createMockElectron({ singleInstance: false });
  const mainPath = path.resolve(__dirname, '..', '..', '..', 'app', 'main.js');

  const helpers = require('./helpers/mock-electron.cjs');
  helpers.loadFresh(mock, 'src/constants.js');
  require(mainPath);
  await delay(20);

  assert.equal(mock._state.quitCalls, 1);
  assert.equal(mock._state.windows.length, 0);
});
