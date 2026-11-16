'use strict';

// P-08 unit tests: Start-menu shortcut creation for the packaged build.
// Run: node --test --test-force-exit tests/e2e/unit/shortcut.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const MODULE = path.resolve(__dirname, '..', '..', '..', 'app', 'src', 'shortcut.js');
const { ensureStartMenuShortcut, launchPlan, startMenuProgramsDir, SHORTCUT_NAME } = require(MODULE);

const APP_DATA = path.join(os.tmpdir(), 'dsh-hud-shortcut-test', 'Roaming');
const LNK = path.join(startMenuProgramsDir(APP_DATA), SHORTCUT_NAME);
const EXE = path.join('D:', 'Apps', 'DSH HUD', 'app', 'DSH HUD.exe');

test('launchPlan: P-06 layout puts udd next to app/, flat layout next to the exe', () => {
  const port = launchPlan(EXE);
  assert.equal(port.appDir, path.dirname(EXE));
  assert.equal(port.root, path.join('D:', 'Apps', 'DSH HUD'));
  assert.equal(port.udd, path.join('D:', 'Apps', 'DSH HUD', 'udd'));

  const flatExe = path.join('D:', 'Apps', 'old-flat', 'DSH HUD.exe');
  const flat = launchPlan(flatExe);
  assert.equal(flat.root, path.join('D:', 'Apps', 'old-flat'));
  assert.equal(flat.udd, path.join('D:', 'Apps', 'old-flat', 'udd'));
});

test('not packaged: never touches the Start menu', () => {
  const runs = [];
  const result = ensureStartMenuShortcut({
    isPackaged: false,
    appData: APP_DATA,
    platform: 'win32',
    run: (ps) => runs.push(ps),
  });
  assert.equal(result.created, false);
  assert.equal(result.reason, 'not-packaged');
  assert.equal(runs.length, 0);
});

test('first packaged run creates the link with the launch flags', () => {
  const runs = [];
  const logs = [];
  const result = ensureStartMenuShortcut({
    isPackaged: true,
    exePath: EXE,
    appData: APP_DATA,
    platform: 'win32',
    exists: () => false,
    run: (ps) => runs.push(ps),
    log: (line) => logs.push(line),
  });
  assert.equal(result.created, true);
  assert.equal(result.link, LNK);
  assert.equal(runs.length, 1);

  const ps = runs[0];
  assert.match(ps, /DSH HUD\.lnk/);
  assert.match(ps, /TargetPath/);
  assert.ok(ps.includes(EXE.replace(/'/g, "''")), ps);
  assert.match(ps, /--no-sandbox/);
  assert.ok(ps.includes(path.join('D:', 'Apps', 'DSH HUD', 'udd')), ps);
  assert.ok(logs.some((l) => l.includes('start-menu shortcut created')), logs.join('\n'));
});

test('an existing link is left alone', () => {
  const runs = [];
  const result = ensureStartMenuShortcut({
    isPackaged: true,
    exePath: EXE,
    appData: APP_DATA,
    platform: 'win32',
    exists: () => true,
    run: (ps) => runs.push(ps),
  });
  assert.equal(result.created, false);
  assert.equal(result.reason, 'exists');
  assert.equal(runs.length, 0);
});

test('a failing PowerShell run is reported, not thrown', () => {
  const logs = [];
  const result = ensureStartMenuShortcut({
    isPackaged: true,
    exePath: EXE,
    appData: APP_DATA,
    platform: 'win32',
    exists: () => false,
    run: () => {
      throw new Error('powershell exploded');
    },
    log: (line) => logs.push(line),
  });
  assert.equal(result.created, false);
  assert.equal(result.reason, 'error');
  assert.match(result.error, /powershell exploded/);
  assert.ok(logs.some((l) => l.includes('start-menu shortcut failed')));
});

test('non-Windows platforms are a no-op', () => {
  const result = ensureStartMenuShortcut({
    isPackaged: true,
    exePath: EXE,
    appData: APP_DATA,
    platform: 'darwin',
    exists: () => false,
    run: () => assert.fail('must not run on darwin'),
  });
  assert.equal(result.reason, 'not-win32');
});

// Keep the fixture directory unused-but-clean if a future test writes into it.
test.teardown?.(() => {
  fs.rmSync(path.join(os.tmpdir(), 'dsh-hud-shortcut-test'), { recursive: true, force: true });
});
