'use strict';
// t38 probe: after an edge resize, a move-drag must not reset the panel size.
// Read-only w.r.t. app code: uses the same mock Electron harness as the unit tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createMockElectron, installElectronMock, loadFresh, setEnv, writeDiscovery,
} = require('./unit/helpers/mock-electron.cjs');

installElectronMock();

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hud-t38-'));
  const userData = path.join(dir, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  const discoveryFile = path.join(dir, 'discovery.json');
  writeDiscovery(discoveryFile, {
    pid: 9999,
    port: '61352',
    url: 'http://127.0.0.1:61352/?token=test',
    updatedAt: new Date().toISOString(),
  });
  setEnv({
    DSH_HUD_USER_DATA: userData,
    DSH_HUD_DISCOVERY: discoveryFile,
    DSH_HUD_NO_ANIM: undefined,
    DSH_HUD_OPAQUE: undefined,
  });
  const mock = createMockElectron({ userData });
  const HudWindow = loadFresh(mock, 'src/hud-window.js');
  return { mock, HudWindow };
}

function run(side, dx, dy, expected) {
  const ctx = setup();
  const hud = new ctx.HudWindow();
  const win = hud.create();
  hud.load();
  hud.showPanel();
  ctx.mock.ipcMain.emit('hud:resize-start', {}, side);
  ctx.mock.ipcMain.emit('hud:resize-move', {}, { dx, dy });
  const resized = win.getContentSize();
  ctx.mock.screen.setCursorScreenPoint({ x: 400, y: 300 });
  ctx.mock.ipcMain.emit('hud:drag-start', {}, { offsetX: 30, offsetY: 20 });
  ctx.mock.ipcMain.emit('hud:drag-move', {});
  const during = win.getContentSize();
  ctx.mock.ipcMain.emit('hud:drag-end', {}, { moved: true });
  const after = win.getContentSize();
  hud.destroy();
  const keeps = during[0] === resized[0] && during[1] === resized[1]
    && after[0] === resized[0] && after[1] === resized[1];
  console.log(JSON.stringify({ side, expected, resized, during, after, keepsResizedSize: keeps }, null, 2));
  return keeps;
}

const right = run('right', 200, 0, [720, 720]);
const bottom = run('bottom', 0, 60, [520, 780]);
const ok = right && bottom;
console.log(JSON.stringify({ rightKeepsSize: right, bottomKeepsSize: bottom, allKeep: ok }, null, 2));
process.exitCode = ok ? 0 : 2;
