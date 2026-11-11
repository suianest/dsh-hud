'use strict';

/**
 * t16 probe for #22: diagnostics path override + 512 KB rotation, including a
 * second rotation when the `.1` file already exists (the Windows failure mode
 * that a one-shot rotation test would miss).
 *
 * Verification-only. Run: node tests/e2e/probe-t16-diag.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const pluginPath = path.join(ROOT, 'plugin', 'index.js');
const KB = 1024;
const LIMIT = 512 * KB;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 1500) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeout) return false;
    await sleep(20);
  }
}

const results = [];
function check(label, condition, detail) {
  const ok = Boolean(condition);
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

function ctx() {
  return {
    get(name) {
      if (name === 'webApp') return { getAdvertisedUrl: () => 'http://127.0.0.1:51234/' };
      if (name === 'connection') return { authenticatedUrl: (u) => `${u}?token=T0K` };
      if (name === 'webServer') return { getOrigin: () => 'http://127.0.0.1:51234/' };
      return undefined;
    },
  };
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-hud-t16-diag-'));
  process.env.LOCALAPPDATA = tmp;
  const diag = path.join(tmp, 'custom-diag.log');
  const rotated = `${diag}.1`;
  process.env.DSH_HUD_DIAG_FILE = diag;

  const plugin = await import(pathToFileURL(pluginPath).href);
  const config = { spawnApp: false, refreshMs: 10_000 };

  let dispose = null;
  try {
    fs.writeFileSync(diag, 'A'.repeat(600 * KB), 'utf8');
    fs.writeFileSync(rotated, 'OLD', 'utf8');

    dispose = plugin.apply(ctx(), config);
    const first = await waitFor(() => fs.existsSync(rotated) && fs.statSync(rotated).size >= 600 * KB);
    check('first overflow rotates a >512 KB log', first,
      `diag=${fs.statSync(diag).size}B rotated=${fs.existsSync(rotated) ? fs.statSync(rotated).size + 'B' : 'missing'}`);
    check('post-rotation log is small', fs.existsSync(diag) && fs.statSync(diag).size < 16 * KB,
      `${fs.existsSync(diag) ? fs.statSync(diag).size : 'missing'}B`);

    dispose();
    dispose = null;
    await sleep(50);

    // Second overflow with `.1` already present: a bare renameSync would fail
    // with EEXIST/EPERM on some Windows configurations and silently stop
    // rotating. Verify the existing `.1` is replaced.
    fs.writeFileSync(diag, 'B'.repeat(600 * KB), 'utf8');
    dispose = plugin.apply(ctx(), config);
    const second = await waitFor(() =>
      fs.existsSync(rotated) && fs.statSync(rotated).size >= 600 * KB &&
      fs.readFileSync(rotated, 'utf8').startsWith('B'));
    check('second overflow replaces the existing .1', second,
      `rotatedPrefix=${fs.existsSync(rotated) ? fs.readFileSync(rotated, 'utf8').slice(0, 1) : 'missing'} size=${fs.existsSync(rotated) ? fs.statSync(rotated).size : 'missing'}`);
  } finally {
    if (dispose) dispose();
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
