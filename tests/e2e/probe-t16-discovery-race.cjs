'use strict';

/**
 * t16 defect reproduction: the new startup `cleanupTmpFiles()` races with the
 * first `writeDiscovery()` in the same apply. Both remove/rename files in the
 * same directory without ordering, so the cleanup can delete
 * `discovery.json.tmp` between writeFile() and rename(), producing
 * "discovery write failed: ENOENT ... discovery.json.tmp -> discovery.json".
 *
 * This is an audit probe, not a regression test: a non-zero exit means the
 * defect reproduced. Run: node tests/e2e/probe-t16-discovery-race.cjs
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const pluginPath = path.join(ROOT, 'plugin', 'index.js');
const RUNS = 8;
// A >512 KB pre-existing diagnostics file makes the startup log rotate before
// the async cleanup/discovery writes are scheduled; this is the timing window
// that reproduces the race reliably. Without it the race remains intermittent.
const PREFILL = process.argv.includes('--prefill');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const plugin = await import(pathToFileURL(pluginPath).href);
  let failures = 0;
  let missing = 0;
  const rows = [];

  for (let i = 1; i <= RUNS; i += 1) {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-hud-t16-race-'));
    process.env.LOCALAPPDATA = tmp;
    const diag = path.join(tmp, 'diag.log');
    process.env.DSH_HUD_DIAG_FILE = diag;
    const discovery = path.join(tmp, 'dsh-hud', 'discovery.json');

    let dispose = null;
    try {
      if (PREFILL) {
        fs.writeFileSync(diag, 'P'.repeat(600 * 1024), 'utf8');
        fs.writeFileSync(`${diag}.1`, 'OLD', 'utf8');
      }
      dispose = plugin.apply(ctx(), { spawnApp: false, refreshMs: 10_000 });
      await sleep(120);
      const log = fs.existsSync(diag) ? fs.readFileSync(diag, 'utf8') : '';
      const failed = log.includes('discovery write failed');
      const exists = fs.existsSync(discovery);
      if (failed) failures += 1;
      if (!exists) missing += 1;
      rows.push(`run ${i}: discovery=${exists ? 'present' : 'MISSING'} writeFail=${failed}`);
    } finally {
      if (dispose) dispose();
      await sleep(20);
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }

  for (const row of rows) console.log(row);
  console.log(`\nSUMMARY runs=${RUNS} writeFailures=${failures} missingDiscovery=${missing}`);
  // Non-zero when reproduced: this probe documents a real defect, not a pass.
  process.exitCode = failures === 0 && missing === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('PROBE ERROR', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
