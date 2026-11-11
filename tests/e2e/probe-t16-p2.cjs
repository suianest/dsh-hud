'use strict';

/**
 * t16 independent verification probes for the P2 fixes that are easy to
 * "fake" with a one-shot unit test:
 *
 *   1. double apply() on one mock context must spawn only once (#21)
 *   2. HudWindow.destroy() must remove all 9 ipcMain + 3 screen listeners (#19)
 *
 * This file is verification-only. It does not modify app/ or plugin/.
 * Run: node tests/e2e/probe-t16-p2.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const appDir = path.join(ROOT, 'app');
const electronExe = path.join(ROOT, 'runtime', 'node_modules', 'electron', 'dist', 'electron.exe');
const launcher = path.join(appDir, 'scripts', 'launch-hud.cjs');
const pluginPath = path.join(ROOT, 'plugin', 'index.js');

const results = [];
function check(label, condition, detail) {
  const ok = Boolean(condition);
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 2000, step = 10, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(step);
  }
}

function makeChild() {
  const done = new Promise(() => {}); // never resolves: the HUD stays "alive"
  return {
    done,
    stdin: {
      destroyed: false,
      written: [],
      write(chunk) { this.written.push(String(chunk)); return true; },
      destroy() { this.destroyed = true; },
    },
    terminateCalls: 0,
    terminate() { this.terminateCalls += 1; },
  };
}

async function probeDoubleApply(tmpRoot) {
  process.env.LOCALAPPDATA = tmpRoot;
  process.env.DSH_HUD_DIAG_FILE = path.join(tmpRoot, 'diag.log');

  const spawns = [];
  const commands = [];
  const ctx = {
    get(name) {
      if (name === 'webApp') return { getAdvertisedUrl: () => 'http://127.0.0.1:51234/' };
      if (name === 'connection') return { authenticatedUrl: (u) => `${u}?token=T0K` };
      if (name === 'webServer') return { getOrigin: () => 'http://127.0.0.1:51234/' };
      if (name === 'subprocess') {
        return {
          spawn(spec) {
            const child = makeChild();
            spawns.push({ spec, child });
            return child;
          },
        };
      }
      if (name === 'commands') {
        return { register(def) { commands.push(def); return () => { def._unregistered = true; }; } };
      }
      return undefined;
    },
  };

  const config = {
    electronPath: electronExe,
    appDir,
    nodePath: process.execPath,
    launcherPath: launcher,
    spawnApp: true,
    refreshMs: 10_000,
    respawnDelayMs: 10,
    maxRespawns: 2,
  };

  const plugin = await import(pathToFileURL(pluginPath).href);
  const discovery = path.join(tmpRoot, 'dsh-hud', 'discovery.json');

  let dispose1 = null;
  let dispose2 = null;
  try {
    dispose1 = plugin.apply(ctx, config);
    await waitFor(() => spawns.length === 1, { label: 'first apply spawn' });
    await waitFor(() => fs.existsSync(discovery), { label: 'first discovery write' });

    // This is the exact scenario from t16: apply the same plugin twice, with the
    // first application still owning a live child. The second apply must see the
    // fresh pre-existing discovery and NOT spawn a duplicate.
    dispose2 = plugin.apply(ctx, config);
    await sleep(250);

    check('double apply spawns only once', spawns.length === 1, `spawns=${spawns.length}`);
    const diag = fs.readFileSync(process.env.DSH_HUD_DIAG_FILE, 'utf8');
    check(
      'second apply logs the HUD-likely-running skip',
      diag.includes('HUD likely already running'),
      diag.trim().split(/\r?\n/).filter((l) => l.includes('HUD likely already running')).pop() || 'missing',
    );
  } finally {
    if (dispose2) dispose2();
    if (dispose1) dispose1();
    await sleep(50);
  }
}

function probeDestroyListeners() {
  const {
    createMockElectron,
    installElectronMock,
    loadFresh,
  } = require('./unit/helpers/mock-electron.cjs');

  const mock = createMockElectron();
  installElectronMock();
  const HudWindow = loadFresh(mock, 'src/hud-window.js');
  const hud = new HudWindow();
  hud.create();

  const ipcChannels = [
    'hud:drag-start', 'hud:drag-move', 'hud:drag-end', 'hud:collapse',
    'hud:collapse-done', 'hud:quit', 'hud:web-bounds', 'hud:web-retry',
    'hud:web-start-dsh',
  ];
  const screenEvents = ['display-added', 'display-removed', 'display-metrics-changed'];

  const beforeIpc = ipcChannels.map((ch) => mock.ipcMain.listenerCount(ch));
  const beforeScreen = screenEvents.map((ev) => mock.screen.listenerCount(ev));
  check('all 9 ipcMain listeners registered once', beforeIpc.every((n) => n === 1), JSON.stringify(beforeIpc));
  check('all 3 screen listeners registered once', beforeScreen.every((n) => n === 1), JSON.stringify(beforeScreen));

  hud.destroy();

  const afterIpc = ipcChannels.map((ch) => mock.ipcMain.listenerCount(ch));
  const afterScreen = screenEvents.map((ev) => mock.screen.listenerCount(ev));
  check('destroy removes all 9 ipcMain listeners', afterIpc.every((n) => n === 0), JSON.stringify(afterIpc));
  check('destroy removes all 3 screen listeners', afterScreen.every((n) => n === 0), JSON.stringify(afterScreen));
  check('destroy releases the WebContentsView', hud.web === null);

  // Idempotence: a second destroy must not throw or resurrect listeners.
  hud.destroy();
  check(
    'second destroy is idempotent',
    ipcChannels.every((ch) => mock.ipcMain.listenerCount(ch) === 0) &&
      screenEvents.every((ev) => mock.screen.listenerCount(ev) === 0),
  );
}

async function main() {
  check('electron.exe exists for the plugin probe', fs.existsSync(electronExe), electronExe);
  check('launcher exists for the plugin probe', fs.existsSync(launcher), launcher);

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-hud-t16-'));
  try {
    await probeDoubleApply(tmpRoot);
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
  probeDestroyListeners();

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nSUMMARY ${results.length - failed}/${results.length} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('PROBE ERROR', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
