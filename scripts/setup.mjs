// setup.mjs — one-command bootstrap for a fresh clone of dsh-hud.
//
// - checks Node >= 20
// - installs electron@44.7.0 into <repo>/runtime (npm registry first, then
//   npmmirror registry as fallback; binary mirror is always npmmirror)
// - writes <repo>/config.local.json (only if absent)
// - verifies the electron binary (version file + best-effort `electron --version`)
// - prints the next steps
//
// Idempotent: re-running skips the download when the binary is already present.
//   --force    reinstall electron even if present
//   --offline  only check (no network, no download, no config write)
//   --dry-run  print what would happen without doing it
//   --help     show usage
//
// All paths derive from this file's location (import.meta.url) — no hardcoded
// drive letters. Run with `node scripts/setup.mjs`.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXPECTED_VERSION = '44.7.0';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const RUNTIME_DIR = path.join(REPO_ROOT, 'runtime');
const ELECTRON_DIST = path.join(RUNTIME_DIR, 'node_modules', 'electron', 'dist');
const ELECTRON_EXE = path.join(ELECTRON_DIST, 'electron.exe');
const VERSION_FILE = path.join(ELECTRON_DIST, 'version');
const CONFIG_PATH = path.join(REPO_ROOT, 'config.local.json');
const APP_DIR = path.join(REPO_ROOT, 'app');
const ELECTRON_CACHE = path.join(REPO_ROOT, '.electron-cache');

const ARGS = new Set(process.argv.slice(2));

function log(msg) {
  console.log(msg);
}

function usage() {
  console.log([
    'Usage: node scripts/setup.mjs [--force] [--offline] [--dry-run] [--help]',
    '',
    '  (no args)  install electron@' + EXPECTED_VERSION + ' into runtime/ and write config.local.json',
    '  --force    reinstall electron even if already present',
    '  --offline  only check prerequisites (no network, no download)',
    '  --dry-run  print what would happen without doing it',
    '  --help     show this message',
  ].join('\n'));
}

function nodeMajor() {
  return Number(process.versions.node.split('.')[0]);
}

function electronReady() {
  if (!fs.existsSync(ELECTRON_EXE)) return false;
  try {
    return fs.readFileSync(VERSION_FILE, 'utf8').trim() === EXPECTED_VERSION;
  } catch {
    return false;
  }
}

function npmAvailable() {
  const r = spawnSync('npm', ['--version'], {
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  return r.status === 0;
}

function installAttempt(registry, label) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const args = [
      'install', `electron@${EXPECTED_VERSION}`,
      '--prefix', RUNTIME_DIR,
      '--no-save', '--no-audit', '--no-fund',
      '--registry', registry,
    ];
    const env = { ...process.env };
    env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
    env.electron_config_cache = ELECTRON_CACHE;
    env.npm_config_registry = registry;

    const child = spawn('npm', args, { shell: true, env, stdio: 'inherit', windowsHide: true });
    child.on('error', (e) => {
      console.error(`[setup] npm spawn failed: ${e.message}`);
      resolve(null);
    });
    child.on('close', (code) => {
      const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
      const ok = code === 0 && electronReady();
      log(`[setup] npm install via ${label}: exit ${code}, ${elapsedSec}s, ${ok ? 'electron ready' : 'electron missing'}`);
      resolve(ok ? { source: label, elapsedSec } : null);
    });
  });
}

async function installElectron() {
  if (!npmAvailable()) {
    console.error('[setup] npm not found on PATH. Install Node.js >= 20 (it bundles npm):');
    console.error('[setup]   https://nodejs.org/en/download');
    return null;
  }
  const attempts = [
    { label: 'npm', registry: 'https://registry.npmjs.org' },
    { label: 'npmmirror', registry: 'https://registry.npmmirror.com' },
  ];
  for (const a of attempts) {
    const res = await installAttempt(a.registry, a.label);
    if (res) return res;
    console.error(`[setup] install via ${a.label} did not yield a working electron binary; trying next source...`);
  }
  return null;
}

function verifyElectron() {
  let v = '';
  try {
    v = fs.readFileSync(VERSION_FILE, 'utf8').trim();
  } catch {
    /* fall through */
  }
  if (v !== EXPECTED_VERSION) {
    console.error(`[setup] electron version file mismatch: expected ${EXPECTED_VERSION}, got "${v}"`);
    return false;
  }
  log(`[setup] electron version file: ${v} (ok)`);

  // Best-effort binary check. In restricted sandboxes electron.exe may refuse
  // to start; the version file above is the authoritative check.
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const out = spawnSync(ELECTRON_EXE, ['--version'], {
      env,
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    const printed = (out.stdout || out.stderr || '').trim();
    log(`[setup] electron --version: ${printed || '(no output)'}`);
  } catch (e) {
    console.warn(`[setup] electron --version could not run (${e.message}); version file already confirms ${v}`);
  }
  return true;
}

function writeConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    log('[setup] config.local.json already exists; leaving it unchanged (delete it to regenerate).');
    return;
  }
  // desktopExe is optional: the app auto-detects it at runtime (config.js
  // detectDesktopExe -> common install dirs + running-process image path). We
  // omit it here so detection stays enabled (an empty string would disable it).
  const cfg = {
    electronPath: ELECTRON_EXE,
    appDir: APP_DIR,
    nodePath: process.execPath,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  log('[setup] wrote config.local.json:');
  log(JSON.stringify(cfg, null, 2));
}

function manualFallback() {
  console.error('');
  console.error(`[setup] ERROR: could not download electron@${EXPECTED_VERSION}. The network may be unavailable.`);
  console.error('[setup] Manual fallback — prepare electron yourself:');
  console.error(`[setup]   1. In a networked terminal run:  npm install electron@${EXPECTED_VERSION}`);
  console.error('[setup]   2. Copy the result so the binary lands at:');
  console.error(`[setup]      ${ELECTRON_EXE}`);
  console.error('[setup]   3. Re-run:  node scripts/setup.mjs --offline');
  console.error('[setup]   4. Then re-run:  node scripts/setup.mjs   (to write config.local.json)');
}

function printNextSteps() {
  console.log('');
  console.log('[setup] Done. Next steps:');
  console.log('[setup]   1. Install & enable the Cordis plugin (see plugin/) so the HUD can find DSH.');
  console.log('[setup]   2. Launch the HUD:  app\\scripts\\run-hud.cmd   (or the packaged DSH HUD.exe).');
  console.log('[setup]   3. Optional autostart: right-click the capsule -> enable 开机自启.');
}

async function main() {
  if (ARGS.has('--help') || ARGS.has('-h')) {
    usage();
    return;
  }
  const offline = ARGS.has('--offline');
  const force = ARGS.has('--force');
  const dryRun = ARGS.has('--dry-run');

  log('[setup] dsh-hud environment setup');
  log(`[setup] repo: ${REPO_ROOT}`);

  const major = nodeMajor();
  if (major < 20) {
    console.error(`[setup] Node >= 20 required, found ${process.version}. Install from https://nodejs.org`);
    process.exit(1);
  }
  log(`[setup] node: ${process.version} (ok)`);

  const ready = electronReady();
  log(`[setup] electron@${EXPECTED_VERSION}: ${ready ? 'present' : 'missing'}`);

  if (offline) {
    if (ready) {
      log('[setup] offline check OK (electron already present).');
      return;
    }
    console.error('[setup] offline check FAILED: electron not present. See manual fallback below.');
    manualFallback();
    process.exit(1);
  }

  if (dryRun) {
    if (ready && !force) {
      log('[setup] dry-run: electron present; would skip download, verify, write config (if absent).');
    } else {
      log(`[setup] dry-run: would ${force ? 'reinstall' : 'install'} electron@${EXPECTED_VERSION} into runtime/ via npm (fallback npmmirror).`);
    }
    return;
  }

  if (ready && !force) {
    log('[setup] electron already present; skipping download (use --force to reinstall).');
  } else {
    if (force) {
      log('[setup] --force: removing existing electron install...');
      fs.rmSync(path.join(RUNTIME_DIR, 'node_modules', 'electron'), { recursive: true, force: true });
    }
    log(`[setup] downloading electron@${EXPECTED_VERSION} (npm -> npmmirror fallback)...`);
    const res = await installElectron();
    if (!res || !electronReady()) {
      manualFallback();
      process.exit(1);
    }
    log(`[setup] electron installed via ${res.source} in ${res.elapsedSec}s.`);
  }

  if (!verifyElectron()) {
    console.error('[setup] electron verification failed.');
    process.exit(1);
  }
  writeConfig();
  printNextSteps();
}

main().catch((e) => {
  console.error('[setup] unexpected error:', e);
  process.exit(1);
});
