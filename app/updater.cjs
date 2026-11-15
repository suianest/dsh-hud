'use strict';

/**
 * Standalone swap helper for the in-app update (P-09).
 *
 * Started as `ELECTRON_RUN_AS_NODE=1 <DSH HUD.exe> updater.cjs <pending.json>`
 * right before the HUD quits. A running Electron maps app.asar, so the swap can
 * only happen after the process is gone: this waits for the lock to clear,
 * keeps a `.bak` for rollback, relaunches the app and exits.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(pendingPath, line) {
  try {
    fs.appendFileSync(path.join(path.dirname(pendingPath), 'updater.log'), new Date().toISOString() + ' ' + line + '\n');
  } catch { /* best effort */ }
}

async function waitUnlocked(target, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      fs.renameSync(target, target + '.probe');
      fs.renameSync(target + '.probe', target);
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

async function main() {
  const pendingPath = process.argv[2];
  if (!pendingPath || !fs.existsSync(pendingPath)) return 1;
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  const asar = pending.asar || pending.asarPath || path.join(path.dirname(pendingPath), '..', 'resources', 'app.asar');
  const staged = pending.staged;
  if (!staged || !fs.existsSync(staged)) {
    log(pendingPath, 'staged asar missing: ' + staged);
    return 2;
  }
  const target = asar;
  log(pendingPath, 'waiting for ' + target);

  if (!(await waitUnlocked(target))) {
    log(pendingPath, 'asar stayed locked; giving up');
    return 3;
  }

  const backup = target + '.bak';
  try {
    if (fs.existsSync(target)) fs.copyFileSync(target, backup);
    fs.copyFileSync(staged, target);
    fs.rmSync(staged, { force: true });
    fs.rmSync(pendingPath, { force: true });
    log(pendingPath, 'swapped to ' + (pending.version || '?') + ' (backup kept)');
  } catch (err) {
    log(pendingPath, 'swap failed: ' + (err && err.message));
    return 4;
  }

  if (pending.exe && fs.existsSync(pending.exe)) {
    try {
      spawn(pending.exe, pending.args || [], { detached: true, stdio: 'ignore', cwd: path.dirname(pending.exe) }).unref();
      log(pendingPath, 'relaunched ' + pending.exe);
    } catch (err) {
      log(pendingPath, 'relaunch failed: ' + (err && err.message));
    }
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(9);
});
