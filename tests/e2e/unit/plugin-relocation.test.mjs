/**
 * t29: prove plugin/index.js derives its default app/launcher/electron paths
 * from its own location (<repo>/plugin/index.js), so moving the repository
 * does not leave it pointing at the build machine.
 *
 * The test copies the real plugin + launcher into a fresh temp repo, imports
 * that copy (so import.meta.url is the moved location), and inspects the
 * subprocess spawn spec produced after apply(). No app/plugin source changes.
 *
 * Run: node --test --test-isolation=none tests/e2e/unit/plugin-relocation.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..', '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 2500, step = 20 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('timeout waiting for spawn');
    await sleep(step);
  }
}

function makeHandle() {
  const stdin = {
    destroyed: false,
    written: [],
    write(chunk) { this.written.push(chunk); return true; },
    destroy() { this.destroyed = true; },
  };
  return {
    done: new Promise(() => {}),
    stdin,
    terminate() {},
  };
}

test('relocation: defaults resolve to <moved-repo>/app, not the original checkout', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hud-reloc-'));
  const moved = path.join(tmp, 'moved-repo');
  const pluginDir = path.join(moved, 'plugin');
  const appDir = path.join(moved, 'app');
  const scriptsDir = path.join(appDir, 'scripts');
  const electronDir = path.join(moved, 'runtime', 'node_modules', 'electron', 'dist');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(electronDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'plugin', 'index.js'), path.join(pluginDir, 'index.js'));
  fs.copyFileSync(path.join(ROOT, 'app', 'scripts', 'launch-hud.cjs'), path.join(scriptsDir, 'launch-hud.cjs'));
  fs.writeFileSync(path.join(electronDir, 'electron.exe'), '');

  const localAppData = path.join(tmp, 'localappdata');
  process.env.LOCALAPPDATA = localAppData;
  process.env.DSH_HUD_DIAG_FILE = path.join(tmp, 'diag.log');
  delete process.env.DSH_HUD_ELECTRON;
  delete process.env.DSH_HUD_APP_DIR;
  delete process.env.DSH_HUD_NODE;

  const mod = await import(pathToFileURL(path.join(pluginDir, 'index.js')).href + '?reloc=' + Date.now());
  const spawns = [];
  const ctx = {
    get(name) {
      if (name === 'webApp') return { getAdvertisedUrl: () => 'http://127.0.0.1:51234/' };
      if (name === 'connection') return { authenticatedUrl: (u) => `${u}?token=RELOC` };
      if (name === 'webServer') return { getOrigin: () => 'http://127.0.0.1:51234' };
      if (name === 'subprocess') {
        return { spawn(spec) { spawns.push(spec); return makeHandle(); } };
      }
      return undefined;
    },
  };
  let dispose;
  try {
    dispose = mod.apply(ctx, {
      spawnApp: true,
      shellLaunch: false,
      nodePath: process.execPath,
      refreshMs: 60_000,
      respawnDelayMs: 50,
      maxRespawns: 1,
    });
    const spec = await waitFor(() => spawns[0]);
    assert.equal(spec.cwd, appDir, 'cwd must be the moved repo app dir');
    assert.deepEqual(spec.argv, [process.execPath, path.join(scriptsDir, 'launch-hud.cjs')]);
    assert.equal(spec.env.DSH_HUD_APP_DIR, appDir);
    assert.equal(spec.env.DSH_HUD_ELECTRON, path.join(electronDir, 'electron.exe'));
    assert.ok(!spec.env.DSH_HUD_APP_DIR.startsWith(ROOT), 'must not point at the original checkout');
  } finally {
    try { dispose?.(); } catch {}
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});
