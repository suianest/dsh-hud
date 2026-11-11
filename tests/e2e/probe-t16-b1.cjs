'use strict';

/**
 * t16 attempt 2 probe for P2-B1: a fresh apply with a >512 KB diagnostics log
 * (rotation path) must still write discovery.json and spawn the HUD exactly once.
 *
 * Verification-only. Run: node tests/e2e/probe-t16-b1.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const electronExe = path.join(ROOT, 'runtime', 'node_modules', 'electron', 'dist', 'electron.exe');
const launcher = path.join(ROOT, 'app', 'scripts', 'launch-hud.cjs');
const pluginPath = path.join(ROOT, 'plugin', 'index.js');

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, label, timeout = 2500) => {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(15);
  }
};

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-hud-t16-b1-'));
  process.env.LOCALAPPDATA = tmp;
  const diag = path.join(tmp, 'custom-diag.log');
  process.env.DSH_HUD_DIAG_FILE = diag;
  const hudDir = path.join(tmp, 'dsh-hud');
  const discovery = path.join(hudDir, 'discovery.json');
  await fsp.mkdir(hudDir, { recursive: true });

  // 600 KB forces rotateDiag() on the very first log line; the stale tmp
  // exercises the startup sweep. Both used to race with writeDiscovery().
  fs.writeFileSync(diag, 'A'.repeat(600 * 1024), 'utf8');
  const stale = path.join(hudDir, 'control.json.999.1.tmp');
  fs.writeFileSync(stale, 'stale', 'utf8');
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(stale, old, old);

  const spawns = [];
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };

  const ctx = {
    get(name) {
      if (name === 'webApp') return { getAdvertisedUrl: () => 'http://127.0.0.1:51234/' };
      if (name === 'connection') return { authenticatedUrl: (u) => `${u}?token=T0K` };
      if (name === 'webServer') return { getOrigin: () => 'http://127.0.0.1:51234/' };
      if (name === 'subprocess') {
        return {
          spawn() {
            const handle = {
              done: new Promise(() => {}),
              stdin: { destroyed: false, write() { return true; } },
              terminate() {},
            };
            spawns.push(handle);
            return handle;
          },
        };
      }
      return undefined;
    },
  };

  const plugin = await import(pathToFileURL(pluginPath).href);
  let dispose = null;
  try {
    dispose = plugin.apply(ctx, {
      spawnApp: true,
      refreshMs: 10_000,
      electronPath: electronExe,
      launcherPath: launcher,
      appDir: path.join(ROOT, 'app'),
    });

    await waitFor(() => fs.existsSync(discovery), 'discovery.json');
    await waitFor(() => spawns.length === 1, 'first spawn');
    const d = JSON.parse(fs.readFileSync(discovery, 'utf8'));
    check('discovery exists after first apply', Boolean(d.url && d.port), `port=${d.port}`);
    check('HUD spawned exactly once', spawns.length === 1, `spawns=${spawns.length}`);
    check('startup sweep removed the stale tmp', !fs.existsSync(stale), 'stale tmp gone');
    check('no discovery write failure logged',
      !errors.some((l) => l.includes('discovery write failed')),
      errors.filter((l) => l.includes('discovery write failed')).join(' | ') || 'none');
    void sleep(30);
  } finally {
    if (dispose) dispose();
    console.error = originalError;
    await sleep(50);
    await fsp.rm(tmp, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nSUMMARY ${results.length - failed}/${results.length} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('PROBE ERROR', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
