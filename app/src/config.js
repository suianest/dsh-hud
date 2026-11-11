'use strict';

// ---------------------------------------------------------------------------
// config — portable configuration resolver (t26).
//
// Resolution order (highest first):
//   1. environment variables  DSH_HUD_*  (CI / power users / one-off overrides)
//   2. <repo>/config.local.json          (machine-local, gitignored)
//   3. automatic detection               (installed exe / running process)
//   4. defaults / empty                  (feature degrades gracefully + one log)
//
// The repo root is derived from app.getAppPath()'s parent (dev: <repo>/app),
// falling back to this file's location (app/src -> ../..). Never a hardcoded
// drive letter.
//
// This module must NOT require('electron'): it is loaded both by the app and
// by the plain-Node unit tests (mock-electron).
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');

// env var -> config key. Empty/unset values are skipped.
const ENV_KEYS = {
  electronPath: 'DSH_HUD_ELECTRON',
  appDir: 'DSH_HUD_APP_DIR',
  dshExe: 'DSH_HUD_DSH_EXE',
  dshWindowTitle: 'DSH_HUD_DSH_TITLE',
  discoveryPath: 'DSH_HUD_DISCOVERY',
  ipcDir: 'DSH_HUD_IPC_DIR',
  userDataDir: 'DSH_HUD_USER_DATA',
  diagFile: 'DSH_HUD_DIAG_FILE',
  nodePath: 'DSH_HUD_NODE',
  launcherPath: 'DSH_HUD_LAUNCHER',
  hotkey: 'DSH_HUD_HOTKEY',
};

// config.local.json may use friendlier aliases; map them onto canonical keys.
// (t26 task wording says "desktopExe"; portability.md schema says "dshExe".)
const FILE_KEY_ALIASES = {
  desktopExe: 'dshExe',
};

function localAppData(env) {
  return env.LOCALAPPDATA || env.USERPROFILE || env.HOME || '';
}

function resolveRepoRoot(appPath) {
  if (appPath) return path.dirname(path.resolve(appPath));
  // This file is <repo>/app/src/config.js; ../../ is the repo root.
  return path.resolve(__dirname, '..', '..');
}

function defaults(repoRoot, env) {
  const la = localAppData(env);
  return {
    electronPath: path.join(repoRoot, 'runtime', 'node_modules', 'electron', 'dist', 'electron.exe'),
    appDir: path.join(repoRoot, 'app'),
    dshExe: '', // detection result; '' = not found
    dshWindowTitle: 'DeepSeek Harness',
    discoveryPath: la ? path.join(la, 'dsh-hud', 'discovery.json') : '',
    ipcDir: path.join(repoRoot, 'artifacts', 'ipc'),
    userDataDir: la ? path.join(la, 'dsh-hud', 'userdata') : '',
    diagFile: path.join(os.tmpdir(), 'dsh-hud-plugin-diag.log'),
    nodePath: process.execPath || '',
    launcherPath: path.join(repoRoot, 'app', 'scripts', 'launch-hud.cjs'),
    hotkey: 'Control+Alt+Space',
  };
}

// Detect the standalone DSH desktop exe without a hardcoded path:
//   1. common install locations under %LOCALAPPDATA%
//   2. the image path of a running process named "DeepSeek Harness"
// Returns '' when nothing is found (caller then degrades to title-based focus).
function detectDesktopExe(env) {
  const e = env || process.env;
  const la = localAppData(e);
  const candidates = [];
  if (la) {
    candidates.push(
      path.join(la, 'Programs', 'DeepSeek', 'DeepSeek Harness.exe'),
      path.join(la, 'Programs', 'deepseek', 'DeepSeek Harness.exe'),
      path.join(la, 'DeepSeek', 'DeepSeek Harness.exe'),
    );
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      const ps = "Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path";
      const out = execSync(
        `powershell.exe -NoProfile -NonInteractive -Command "${ps}"`,
        { encoding: 'utf8', windowsHide: true, timeout: 3000 },
      ).trim();
      if (out && fs.existsSync(out)) return out;
    } catch { /* best effort (incl. sandbox EPERM) */ }
  }
  return '';
}

function loadConfig({ appPath = null, env = process.env, detectExe = detectDesktopExe } = {}) {
  const repoRoot = resolveRepoRoot(appPath);
  const cfg = {};
  const sources = {};

  // 1) env
  for (const [key, varName] of Object.entries(ENV_KEYS)) {
    const v = env[varName];
    if (v !== undefined && v !== null && v !== '') {
      cfg[key] = v;
      sources[key] = 'env';
    }
  }

  // 2) config.local.json (fills only keys env did not set)
  const file = path.join(repoRoot, 'config.local.json');
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (obj && typeof obj === 'object') {
      for (const [rawKey, v] of Object.entries(obj)) {
        const key = FILE_KEY_ALIASES[rawKey] || rawKey;
        if (cfg[key] === undefined && v !== null && v !== undefined) {
          cfg[key] = v;
          sources[key] = 'file';
        }
      }
    }
  } catch { /* missing / invalid json -> skip */ }

  // 3) defaults + detection
  const base = defaults(repoRoot, env);
  for (const [key, v] of Object.entries(base)) {
    if (cfg[key] === undefined) {
      if (key === 'dshExe') {
        const det = detectExe(env);
        cfg[key] = det;
        sources[key] = det ? 'detect' : 'empty';
      } else {
        cfg[key] = v;
        sources[key] = 'default';
      }
    }
  }

  // Convenience aliases (t26 task wording uses desktopExe; portability.md uses
  // dshExe — expose both; discoveryDir is the dirname of discoveryPath).
  cfg.desktopExe = cfg.dshExe;
  cfg.discoveryDir = cfg.discoveryPath ? path.dirname(cfg.discoveryPath) : '';

  return { config: cfg, sources, repoRoot };
}

module.exports = { loadConfig, detectDesktopExe, ENV_KEYS };
