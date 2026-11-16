'use strict';
// t38 probe: palette state after HUD collapse / Esc. Read-only w.r.t. app code.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createMockElectron, installElectronMock, loadFresh, setEnv, writeDiscovery,
} = require('./unit/helpers/mock-electron.cjs');

installElectronMock();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hud-t38-palette-'));
const userData = path.join(dir, 'userdata');
fs.mkdirSync(userData, { recursive: true });
const discoveryFile = path.join(dir, 'discovery.json');
writeDiscovery(discoveryFile, {
  pid: 9999, port: '61352', url: 'http://127.0.0.1:61352/?token=test', updatedAt: new Date().toISOString(),
});
setEnv({ DSH_HUD_USER_DATA: userData, DSH_HUD_DISCOVERY: discoveryFile, DSH_HUD_NO_ANIM: '1' });
const mock = createMockElectron({ userData });
const HudWindow = loadFresh(mock, 'src/hud-window.js');
const hud = new HudWindow();
const win = hud.create();
hud.load();
hud.showPanel();
hud._openPalette();
const opened = { paletteOpen: hud._paletteOpen, attached: hud.web.attached, mode: hud.mode };
hud.collapse();
const collapsed = { paletteOpen: hud._paletteOpen, attached: hud.web.attached, mode: hud.mode };
hud.showPanel();
hud._openPalette();
const reopened = { paletteOpen: hud._paletteOpen, attached: hud.web.attached, mode: hud.mode };
console.log(JSON.stringify({ opened, collapsed, reopened }, null, 2));
hud.destroy();
if (opened.paletteOpen !== true || opened.attached !== false) process.exitCode = 2;
if (collapsed.paletteOpen !== false) process.exitCode = 3;
if (reopened.paletteOpen !== true) process.exitCode = 4;
