/**
 * HUD launcher (referenced by the Cordis token-bridge plugin).
 *
 * Why a launcher exists: the DSH host process runs with
 * ELECTRON_RUN_AS_NODE set in its environment. A child `electron.exe`
 * spawned from that environment starts in *Node mode* and dies on
 * `bad option: --no-sandbox` (exit code 9). Node's child_process honors an
 * explicit env object, so this tiny launcher (run by node.exe) removes the
 * variable and only then starts Electron.
 *
 * Env contract (set by the plugin):
 *   DSH_HUD_ELECTRON  absolute path to electron.exe
 *   DSH_HUD_APP_DIR   absolute path to the HUD app directory
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Log next to the app when possible (readable from the HUD user), never a
// machine-specific absolute path: DSH_HUD_DIAG_FILE (set by the plugin) wins,
// then <repo>/artifacts/launcher.log, and os.tmpdir() as the writable fallback.
function resolveLog() {
  const explicit = process.env.DSH_HUD_DIAG_FILE;
  if (explicit) return explicit;
  const appDir = process.env.DSH_HUD_APP_DIR;
  if (appDir) return path.join(path.dirname(appDir), 'artifacts', 'launcher.log');
  return path.join(os.tmpdir(), 'dsh-hud-launch.log');
}

const LOG = resolveLog();

const log = (message) => {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()} [launcher] ${message}\n`);
  } catch {
    /* best effort */
  }
};

const electron = process.env.DSH_HUD_ELECTRON;
const appDir = process.env.DSH_HUD_APP_DIR;

if (!electron || !appDir) {
  log('missing DSH_HUD_ELECTRON / DSH_HUD_APP_DIR');
  process.exit(2);
}

log(`node=${process.version} ELECTRON_RUN_AS_NODE=${JSON.stringify(process.env.ELECTRON_RUN_AS_NODE)} electron=${electron}`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// Chromium MUST get its own user-data-dir: the shared %APPDATA%\Electron
// profile on this machine crashes the browser process at startup
// (0xC0000005 @ electron.exe+0x7d0f25b, before app code runs). A dedicated
// directory makes the same binary start normally (probe L3).
//
// The directory must also be WRITABLE by the launching process: when this
// plugin spawns from the DSH sandbox the child runs at low integrity and
// %LOCALAPPDATA% is denied (Chromium then fails to create its singleton lock
// and the app exits 0 with no window). Fall back to the temp dir.
// Order matters: the *first writable* one wins, and both launch paths (this
// launcher, spawned by the plugin at Medium, and run-hud.cmd, run by the user
// at Low) must land on the SAME directory, otherwise each gets its own
// single-instance lock and a second capsule appears. The repo-local
// artifacts dir is the one run-hud.cmd falls back to, so prefer it.
const candidates = [
  process.env.DSH_HUD_USER_DATA,
  path.join(path.dirname(appDir), 'artifacts', 'udd-hud'),
  path.join(process.env.LOCALAPPDATA || os.homedir(), 'dsh-hud', 'userdata'),
  path.join(os.tmpdir(), 'dsh-hud-userdata'),
].filter(Boolean);

let userDataDir = candidates[candidates.length - 1];
for (const candidate of candidates) {
  try {
    fs.mkdirSync(candidate, { recursive: true });
    fs.accessSync(candidate, fs.constants.W_OK);
    userDataDir = candidate;
    break;
  } catch {
    /* try the next candidate */
  }
}
env.DSH_HUD_USER_DATA = userDataDir;

log(`userDataDir=${userDataDir}`);

const child = spawn(electron, ['--no-sandbox', `--user-data-dir=${userDataDir}`, appDir], {
  cwd: appDir,
  stdio: 'inherit',
  env,
});

child.on('error', (err) => {
  log(`spawn error: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  log(`electron exit code=${code} signal=${signal}`);
  process.exit(code === null ? 1 : code);
});
