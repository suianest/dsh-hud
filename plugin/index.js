/**
 * DSH HUD — token bridge + optional floating-window integration (t2 + t7 + t10).
 *
 * On activation it:
 *   1. publishes the authenticated DSH Web URL (with a fresh `?token=`) to
 *      `%LOCALAPPDATA%\dsh-hud\discovery.json` (t2);
 *   2. can OPTIONALLY start the Electron HUD app, through one of two opt-in
 *      paths (both default OFF — see `cfg` for the reasoning):
 *        - `spawnApp`: node.exe launcher as a direct subprocess (crashes inside
 *          this host: crashpad_client_win.cc:867, exit 0xFFFF7003);
 *        - `shellLaunch`: ask Explorer to run a generated .cmd (works only after
 *          a human clicks the Windows approval prompt).
 *      Default behaviour: the HUD comes up from the login Startup entry (written
 *      by the `autostart` IPC action) or a manual double-click / tray menu,
 *      and this plugin just keeps discovery.json fresh + serves /dsh-hud.
 *      NOTE: this host process is Medium integrity (it can write
 *      %LOCALAPPDATA%), unlike the Low-IL shells the agent tools run in. That
 *      is what makes the `ipc/request.json` desktop-focus bridge work.
 *   3. watches for a Web-UI origin change (DSH web server rebinding to another
 *      port inside the same host process) and notifies the HUD to reload;
 *   4. registers the `/dsh-hud` command to open/hide the floating panel;
 *   5. on dispose, terminates the child, removes all files, and unregisters
 *      the command (no leftover process after DSH exits / uninstall).
 *
 * Service access is defensive (`ctx.get(...)` + undefined checks) so the
 * plugin degrades to the t2 token-bridge behavior when a service is absent.
 *
 * Verified against the live Host Service directory (cordis_inspect_query):
 *   - webApp.getAdvertisedUrl(): string
 *   - connection.authenticatedUrl(baseUrl): string   (fresh one-shot login token)
 *   - webServer.getOrigin(): string
 *   - subprocess.spawn(spec: SubprocessSpawnSpec): SubprocessHandle
 *   - commands.register(definition: CommandDefinition): () => void
 *
 * Notification contract (see docs/plugin-app-bridge.md):
 *   - `%LOCALAPPDATA%\dsh-hud\control.json` = { seq, action, at } — bumped on
 *     reload / show / hide / toggle; written via a unique tmp name + atomic
 *     rename (seq + pid), safe for concurrent writers and fs.watch.
 *   - newline-delimited JSON on the child's stdin (stdio.stdin: 'pipe'):
 *     { "type": "reload" | "show" | "hide" | "toggle", "seq": N }
 */
import { mkdir, writeFile, rename, rm, readdir, stat } from 'node:fs/promises';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Diagnostics log. Overridable via DSH_HUD_DIAG_FILE (t15 #22: the path used
// to be hard-coded and unroutable on other machines). Rotated at 512 KB.
// Default lives under the OS temp dir: the host runtime runs at Low Mandatory
// Level and cannot write %LOCALAPPDATA% (t16 B4), but temp is always writable.
const DEFAULT_DIAG_FILE = path.join(os.tmpdir(), 'dsh-hud-plugin-diag.log');
const DIAG_MAX_BYTES = 512 * 1024;
// A discovery entry this fresh, owned by a live process, means the HUD is
// probably already up; a re-apply must not spawn a duplicate (t15 #21).
const FRESH_DISCOVERY_MS = 30_000;
// A *.tmp younger than this may belong to a write that is still in flight (this
// apply, a refresh tick, or another plugin instance). Only older leftovers from
// a crashed process are deleted (t16 B1: an unguarded sweep raced with our own
// discovery.json.tmp and made its rename fail with ENOENT).
const STALE_TMP_MS = 60_000;

// Repo root derived from this bundle's own location: <repo>/plugin/index.js →
// <repo>/. A fresh clone works without editing any path (t27 portability).
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_ELECTRON = path.join(REPO_ROOT, 'runtime', 'node_modules', 'electron', 'dist', 'electron.exe');
const DEFAULT_APP_DIR = path.join(REPO_ROOT, 'app');
const DEFAULT_LAUNCHER = path.join(REPO_ROOT, 'app', 'scripts', 'launch-hud.cjs');
// nodePath has no static default: env DSH_HUD_NODE → config.local.json.nodePath →
// process.execPath (the host is Node). See apply().
const LOCAL_CONFIG_FILE = path.join(REPO_ROOT, 'config.local.json');
// The DSH desktop app is a separate installed program, not part of this repo, so
// it cannot be derived from REPO_ROOT. Override via DSH_HUD_DSH_EXE or
// config.local.json.dshExe (t27).
// No machine-specific default: the HUD resolves the desktop exe (config /
// auto-detect) and sends it with the request; when nothing is known this stays
// empty and the request degrades to "focus the window by title only".
const DEFAULT_DSH_EXE = '';
const DEFAULT_REFRESH_MS = 15_000;
const DEFAULT_RESPAWN_DELAY_MS = 3_000;
const DEFAULT_MAX_RESPAWNS = 5;
// Reset the respawn counter only after a child has survived this long, so a
// persistent crash loop still trips maxRespawns (t8 D1) but a rare crash does
// not permanently disable auto-restart.
const STABLE_MS = 30_000;

function hudDir() {
  const base = process.env.LOCALAPPDATA;
  if (!base) throw new Error('LOCALAPPDATA is not set on this platform');
  return path.join(base, 'dsh-hud');
}

function discoveryFile() {
  return path.join(hudDir(), 'discovery.json');
}

function controlFile() {
  return path.join(hudDir(), 'control.json');
}

function portOf(urlString) {
  if (!urlString) return null;
  try {
    const url = new URL(urlString);
    return url.port || (url.protocol === 'https:' ? '443' : '80');
  } catch {
    return null;
  }
}

function originOf(urlString) {
  if (!urlString) return null;
  try {
    const url = new URL(urlString);
    return `${url.protocol}//${url.host}`;
  } catch {
    return urlString;
  }
}

function readJsonFileSync(file) {
  try {
    const obj = JSON.parse(readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

// <repo>/config.local.json is the shared, git-ignored local override (same field
// names as the app side). Env vars (DSH_HUD_*) win over it; derived defaults
// apply when neither is set. Missing / unparseable → {} (t27).
function readLocalConfig() {
  const obj = readJsonFileSync(LOCAL_CONFIG_FILE);
  return obj || {};
}

// --- HUD / DSH desktop location (t36 P-02) -------------------------------
// The plugin must find the user's installed HUD (a portable Release folder) and
// the separate DSH desktop app, instead of assuming this repo is present. Both
// resolvers are pure (every path injectable) so they can be unit-tested and
// printed with `node -e` without mounting a full Cordis host.
export function resolveHud(opts = {}) {
  const localAppData = opts.localAppData ?? process.env.LOCALAPPDATA ?? '';
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const exePath = opts.exePath; // already-resolved explicit exe path
  const hudDir = opts.hudDir; // already-resolved explicit dir holding DSH HUD.exe

  if (exePath) {
    return existsSync(exePath)
      ? { found: true, mode: 'exe', exe: exePath, dir: path.dirname(exePath) }
      : { found: false, mode: 'exe', reason: '未找到 HUD：exePath 指向的 exe 不存在（' + exePath + '）' };
  }
  if (hudDir) {
    const exe = path.join(hudDir, 'DSH HUD.exe');
    return existsSync(exe)
      ? { found: true, mode: 'exe', exe, dir: hudDir }
      : { found: false, mode: 'dir', reason: '未找到 HUD：hudDir 目录下没有 DSH HUD.exe（' + hudDir + '）' };
  }

  const candidates = [
    localAppData ? path.join(localAppData, 'DSH HUD', 'DSH HUD.exe') : '',
    localAppData ? path.join(localAppData, 'Programs', 'DSH HUD', 'DSH HUD.exe') : '',
    path.join(repoRoot, 'dist', 'win-unpacked', 'DSH HUD.exe'),
  ];
  for (const exe of candidates) {
    if (exe && existsSync(exe)) return { found: true, mode: 'exe', exe, dir: path.dirname(exe) };
  }

  const devElectron = opts.devElectron ?? DEFAULT_ELECTRON;
  const devAppDir = opts.devAppDir ?? DEFAULT_APP_DIR;
  const devLauncher = opts.devLauncher ?? DEFAULT_LAUNCHER;
  if (existsSync(devElectron) && existsSync(devAppDir)) {
    return { found: true, mode: 'dev', electron: devElectron, appDir: devAppDir, launcher: devLauncher };
  }

  return {
    found: false,
    mode: 'missing',
    reason: '未找到 HUD，请下载 Release 包解压后设置 hudDir 或 DSH_HUD_DIR',
  };
}

export function resolveDesktopExe(opts = {}) {
  const localAppData = opts.localAppData ?? process.env.LOCALAPPDATA ?? '';
  const explicit = opts.desktopExe;
  if (explicit) {
    // Explicit but missing → empty ("focus by title only"), never throw.
    return existsSync(explicit) ? explicit : '';
  }
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    localAppData ? path.join(localAppData, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe') : '',
    localAppData ? path.join(localAppData, 'DeepSeek Harness', 'DeepSeek Harness.exe') : '',
    path.join(pf, 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    path.join(pf86, 'DeepSeek Harness', 'DeepSeek Harness.exe'),
  ];
  for (const exe of candidates) {
    if (exe && existsSync(exe)) return exe;
  }
  return '';
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission to signal it.
    return Boolean(err) && err.code === 'EPERM';
  }
}

function ageMsOf(updatedAt) {
  if (typeof updatedAt !== 'string') return Infinity;
  const t = Date.parse(updatedAt);
  return Number.isNaN(t) ? Infinity : Date.now() - t;
}

export function apply(ctx, config = {}) {
  const webApp = ctx.get('webApp');
  const connection = ctx.get('connection');
  const webServer = ctx.get('webServer');
  const subprocess = ctx.get('subprocess');
  const commands = ctx.get('commands');

  // Config resolution (high → low): Cordis row `config` → DSH_HUD_* env →
  // config.local.json → derived default. "env 优先" means env beats the repo file.
  const localConfig = readLocalConfig();
  const envStr = (name) => {
    const v = process.env[name];
    return v && v.trim() ? v : undefined;
  };
  const envBool = (name) => {
    const v = process.env[name];
    if (v === undefined || v === null || String(v).trim() === '') return undefined;
    const s = String(v).trim().toLowerCase();
    return s !== '0' && s !== 'false' && s !== 'no' && s !== 'off';
  };

  const cfg = {
    electronPath: config.electronPath ?? envStr('DSH_HUD_ELECTRON') ?? localConfig.electronPath ?? DEFAULT_ELECTRON,
    appDir: config.appDir ?? envStr('DSH_HUD_APP_DIR') ?? localConfig.appDir ?? DEFAULT_APP_DIR,
    launcherPath: config.launcherPath ?? envStr('DSH_HUD_LAUNCHER') ?? localConfig.launcherPath ?? DEFAULT_LAUNCHER,
    nodePath: config.nodePath ?? envStr('DSH_HUD_NODE') ?? localConfig.nodePath ?? process.execPath ?? '',
    dshExe: config.dshExe ?? envStr('DSH_HUD_DSH_EXE') ?? localConfig.dshExe ?? DEFAULT_DSH_EXE,
    // Both start paths are opt-in. Direct spawn crashes inside this host, and the
    // Explorer delegation surfaces a Windows approval prompt that needs a human
    // click every time, so neither is allowed to run by default. The capsule is
    // expected to come up from the login Startup entry (or a manual double-click
    // / the tray menu), while this plugin keeps discovery.json fresh.
    spawnApp: config.spawnApp ?? envBool('DSH_HUD_SPAWN_APP') ?? localConfig.spawnApp ?? false,
    shellLaunch: config.shellLaunch ?? envBool('DSH_HUD_SHELL_LAUNCH') ?? localConfig.shellLaunch ?? false,
    refreshMs: config.refreshMs ?? DEFAULT_REFRESH_MS,
    respawnDelayMs: config.respawnDelayMs ?? DEFAULT_RESPAWN_DELAY_MS,
    maxRespawns: config.maxRespawns ?? DEFAULT_MAX_RESPAWNS,
  };

  const dFile = discoveryFile();
  const cFile = controlFile();
  const dTmp = `${dFile}.tmp`;

  let disposed = false;
  const abort = new AbortController();
  let child = null; // SubprocessHandle | null
  let lastOrigin = null;
  let controlSeq = 0;
  let respawnCount = 0;
  let respawnTimer = null;
  let stableTimer = null;
  let visible = false; // best-effort local state for command replies
  // Serializes control.json file writes. A unique tmp name per action prevents
  // ENOENT (t8 D2), but Windows MoveFileEx(REPLACE_EXISTING) still returns
  // EPERM when two renames target the same destination at the same instant;
  // chaining the writes makes the rename-to-control.json strictly sequential.
  let controlChain = Promise.resolve();

  const diagFile = process.env.DSH_HUD_DIAG_FILE || DEFAULT_DIAG_FILE;

  const rotateDiag = () => {
    try {
      if (statSync(diagFile).size > DIAG_MAX_BYTES) {
        try {
          renameSync(diagFile, `${diagFile}.1`);
        } catch {
          /* keep appending to the same file if rotation fails */
        }
      }
    } catch {
      /* file may not exist yet */
    }
  };

  const log = (...args) => {
    console.error('[dsh-hud]', ...args);
    try {
      rotateDiag();
      appendFileSync(diagFile, `${new Date().toISOString()} ${args.map((a) => String(a)).join(' ')}\n`);
    } catch {
      /* diagnostics are best-effort */
    }
  };

  // --- HUD / DSH desktop location (t36 P-02) ------------------------------
  // Explicit config → env → config.local.json → auto-detect. A miss degrades
  // to a skip + one clear log line (never a throw).
  const hud = resolveHud({
    exePath: config.exePath ?? envStr('DSH_HUD_EXE') ?? localConfig.exePath,
    hudDir: config.hudDir ?? envStr('DSH_HUD_DIR') ?? localConfig.hudDir,
    devElectron: cfg.electronPath,
    devAppDir: cfg.appDir,
    devLauncher: cfg.launcherPath,
  });
  const desktopExe = resolveDesktopExe({
    desktopExe: config.desktopExe ?? config.dshExe ?? envStr('DSH_HUD_DSH_EXE') ?? localConfig.desktopExe ?? localConfig.dshExe,
  });
  log(
    hud.found
      ? 'found HUD: ' + (hud.mode === 'exe' ? hud.exe : hud.electron + ' + ' + hud.appDir)
      : hud.reason,
  );

  // Snapshot of discovery.json as it existed BEFORE this apply rewrote it. On a
  // plugin re-apply (config refresh) the previous apply already spawned the HUD;
  // spawning again just hands off to the single-instance lock and exits 0
  // (t15 #21 spawn storm). A fresh, live discovery means "HUD likely already
  // running" → skip.
  const preExistingDiscovery = readJsonFileSync(dFile);

  const hudLikelyRunning = () => {
    const d = preExistingDiscovery;
    if (!d) return false;
    if (ageMsOf(d.updatedAt) > FRESH_DISCOVERY_MS) return false;
    const pid = Number(d.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    return pidAlive(pid);
  };

  // --- discovery (t2) ------------------------------------------------------
  // Resolve services on every tick instead of once at apply time: after a
  // reboot the profile bundle can mount before `webApp`/`connection` are up,
  // and a captured `undefined` then keeps the refresh failing forever
  // ("no advertised URL or web server origin available", 2026-11-06).
  const resolveDiscovery = () => {
    const appSvc = ctx.get('webApp') ?? webApp;
    const serverSvc = ctx.get('webServer') ?? webServer;
    const connSvc = ctx.get('connection') ?? connection;
    const baseUrl =
      appSvc && typeof appSvc.getAdvertisedUrl === 'function'
        ? appSvc.getAdvertisedUrl()
        : serverSvc && typeof serverSvc.getOrigin === 'function'
          ? serverSvc.getOrigin()
          : '';
    if (!baseUrl) throw new Error('no advertised URL or web server origin available');

    const url =
      connSvc && typeof connSvc.authenticatedUrl === 'function'
        ? connSvc.authenticatedUrl(baseUrl)
        : baseUrl;

    const port =
      portOf(url) ??
      portOf(baseUrl) ??
      (serverSvc && typeof serverSvc.getOrigin === 'function' ? portOf(serverSvc.getOrigin()) : null);

    return {
      pid: process.pid,
      port,
      url,
      origin: originOf(url) ?? originOf(baseUrl),
      updatedAt: new Date().toISOString(),
    };
  };

  // Unique temp name per write: the refresh timer, a reload notification and a
  // re-apply can overlap, and a shared `discovery.json.tmp` makes the loser's
  // rename fail with ENOENT (seen every 15s on 2026-11-06 before the fix).
  let tmpSeq = 0;
  const discoveryTmpName = () =>
    path.join(path.dirname(dFile), `discovery.json.${process.pid}.${++tmpSeq}.tmp`);

  const writeDiscovery = async () => {
    const d = resolveDiscovery();
    await mkdir(path.dirname(dFile), { recursive: true });
    const tmp = discoveryTmpName();
    await writeFile(
      tmp,
      JSON.stringify({ pid: d.pid, port: d.port, url: d.url, updatedAt: d.updatedAt }, null, 2),
      'utf8',
    );
    await renameWithRetry(tmp, dFile);
    return d;
  };

  // Remove leftover *.tmp files (from a previous crashed write) in the HUD dir.
  // Stale-only: a fresh tmp may be owned by a write that is still running, and
  // deleting it turns that write's rename into ENOENT (t16 B1).
  const cleanupTmpFiles = async () => {
    try {
      const dir = path.dirname(cFile);
      const entries = await readdir(dir);
      const now = Date.now();
      await Promise.all(
        entries
          .filter((name) => name.endsWith('.tmp'))
          .map(async (name) => {
            const full = path.join(dir, name);
            try {
              const st = await stat(full);
              if (now - st.mtimeMs < STALE_TMP_MS) return;
              await rm(full, { force: true });
            } catch {
              /* already gone */
            }
          }),
      );
    } catch {
      /* best effort */
    }
  };

  // Windows can refuse MoveFileEx with EPERM while another reader (fs.watch or
  // the HUD's 2s poll) still has the destination open; retry briefly instead of
  // dropping the notification (t16 B6: one flaky EPERM across 10 test runs).
  const renameWithRetry = async (from, to, attempts = 4) => {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        await rename(from, to);
        return;
      } catch (err) {
        lastErr = err;
        if (err?.code !== 'EPERM' && err?.code !== 'EBUSY') throw err;
        await new Promise((resolve) => setTimeout(resolve, 25 * (i + 1)));
      }
    }
    throw lastErr;
  };

  // --- control notifications ----------------------------------------------
  const sendControl = (action) => {
    // The seq must be monotonic ACROSS plugin reloads: the HUD persists its
    // lastSeq and drops anything <= it, so restarting at 1 after a DSH restart
    // would silently swallow the first n commands (t13 #1). Date.now() jumps
    // the counter forward while keeping per-call uniqueness.
    controlSeq = Math.max(controlSeq + 1, Date.now());
    const seq = controlSeq;
    const payload = { seq, action, at: new Date().toISOString() };
    // Unique tmp name (pid + seq) so concurrent writes never collide on the
    // same temp file and never rename a path another writer already renamed
    // (t8 D2: was a shared control.json.tmp → ENOENT under concurrency).
    const tmp = `${cFile}.${process.pid}.${seq}.tmp`;

    controlChain = controlChain.then(async () => {
      try {
        await mkdir(path.dirname(cFile), { recursive: true });
        await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
        await renameWithRetry(tmp, cFile);
      } catch (err) {
        log('control.json write failed:', err?.message ?? err);
      }
    });

    if (child && child.stdin && !child.stdin.destroyed) {
      try {
        child.stdin.write(`${JSON.stringify({ action, seq })}\n`);
      } catch (err) {
        log('control stdin write failed:', err?.message ?? err);
      }
    }
    return payload;
  };

  const notifyReloadIfChanged = (d) => {
    if (d.origin && lastOrigin && d.origin !== lastOrigin) {
      sendControl('reload');
    }
    lastOrigin = d.origin;
  };

  // --- child process management (t7) --------------------------------------
  // A missing or unset path degrades to a single skip + log line, never a throw
  // (t27). Returns the first missing item, or null when all are present.
  const missingFile = (label, p) => (p && existsSync(p) ? null : `${label} (${p || 'unset'})`);
  const missingSpawnFile = () =>
    missingFile('electronPath', cfg.electronPath) ??
    missingFile('nodePath', cfg.nodePath) ??
    missingFile('launcherPath', cfg.launcherPath) ??
    missingFile('appDir', cfg.appDir);
  const missingShellFile = () =>
    missingFile('electronPath', cfg.electronPath) ??
    missingFile('appDir', cfg.appDir);

  const scheduleRespawn = () => {
    if (disposed) return;
    if (respawnCount >= cfg.maxRespawns) {
      log('respawn limit reached; giving up auto-restart');
      return;
    }
    respawnCount += 1;
    const delay = cfg.respawnDelayMs * respawnCount; // linear backoff
    if (respawnTimer) clearTimeout(respawnTimer);
    respawnTimer = setTimeout(() => {
      respawnTimer = null;
      ensureRunning();
    }, delay);
  };

  const clearStable = () => {
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
  };

  // --- shell launch (bypasses the host's child-process sandbox) ------------
  // A subprocess child of this host cannot boot Chromium here (crashpad
  // "not connected", exit 0x80000003): the pet plugin proves plain native GUI
  // children work, so it is Chromium's broker/crashpad pipes that are denied.
  // Explorer, however, starts programs in its own (unconfined) context: we hand
  // it a .cmd and let it do the spawn. This is what makes "capsule appears when
  // DSH starts" possible again.
  const hudUserData = () =>
    process.env.DSH_HUD_USER_DATA || path.join(path.dirname(cfg.appDir), 'artifacts', 'udd-hud');
  const shellLaunchCmdFile = () => path.join(hudUserData(), 'launch-hud.cmd');
  const shellLaunchScript = () =>
    [
      '@echo off',
      'rem Generated by the DSH HUD plugin; Explorer runs this at DSH startup.',
      'set "ELECTRON_RUN_AS_NODE="',
      'set "DSH_HUD_USER_DATA=' + hudUserData() + '"',
      'start "" "' + cfg.electronPath + '" --no-sandbox --user-data-dir="' +
        hudUserData() + '" "' + cfg.appDir + '"',
      '',
    ].join('\r\n');
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const countElectron = () =>
    new Promise((resolve) => {
      let out = '';
      try {
        const p = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command',
            "(Get-Process electron -ErrorAction SilentlyContinue | Measure-Object).Count"],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
        );
        p.stdout.on('data', (b) => { out += b.toString(); });
        p.on('error', () => resolve(0));
        p.on('close', () => resolve(Number(String(out).trim()) || 0));
        setTimeout(() => resolve(0), 4000);
      } catch {
        resolve(0);
      }
    });
  const launchViaShell = async () => {
    const file = shellLaunchCmdFile();
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, shellLaunchScript(), 'ascii');
    } catch (err) {
      log('shell launch script write failed:', err?.message ?? err);
      return false;
    }
    log('shell launch: asking explorer to run', file);
    try {
      const p = spawn('explorer.exe', [file], { windowsHide: true, stdio: 'ignore' });
      p.on('error', (err) => log('explorer spawn error:', err?.message ?? err));
      p.unref();
    } catch (err) {
      log('explorer spawn failed:', err?.message ?? err);
      return false;
    }
    for (let i = 0; i < 6; i += 1) {
      await sleepMs(2000);
      if (disposed) return false;
      const n = await countElectron();
      if (n > 0) {
        log('shell launch succeeded: electron processes=' + n);
        return true;
      }
    }
    log('shell launch produced no electron process');
    return false;
  };

  const spawnChild = () => {
    if (disposed) return;
    if (!cfg.spawnApp) {
      log('skip spawn: spawnApp is disabled (HUD self-starts via login item / double-click)');
      return;
    }
    if (cfg.shellLaunch) {
      const missing = missingShellFile();
      if (missing) {
        log('skipping shell launch: missing or unset ' + missing);
        return;
      }
      void launchViaShell().then((ok) => {
        if (disposed) return;
        if (ok) return;
        log('shell launch unavailable; falling back to a direct subprocess (expected to crash here)');
        startChild();
      });
      return;
    }
    startChild();
  };

  const startChild = () => {
    if (disposed) return;
    if (!cfg.spawnApp) return;
    if (!subprocess || typeof subprocess.spawn !== 'function') {
      // t8 D5: a missing subprocess service is a deliberate skip, not a spawn failure.
      log('subprocess service unavailable; skipping spawn');
      return;
    }
    const missing = missingSpawnFile();
    if (missing) {
      log('skipping spawn: missing or unset ' + missing);
      return;
    }

    const env = {
      ...process.env,
      DSH_HUD_ELECTRON: cfg.electronPath,
      DSH_HUD_APP_DIR: cfg.appDir,
      DSH_HUD_DISCOVERY: dFile,
    };
    // The host process itself runs with ELECTRON_RUN_AS_NODE set; a direct
    // electron.exe child would boot in Node mode ("bad option: --no-sandbox").
    // We start node.exe with launch-hud.cjs, which re-spawns Electron from a
    // cleaned environment (node.exe itself ignores the variable).
    delete env.ELECTRON_RUN_AS_NODE;

    try {
      child = subprocess.spawn({
        argv: [cfg.nodePath, cfg.launcherPath],
        cwd: cfg.appDir,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 3_000,
        signal: abort.signal,
        env,
      });
    } catch (err) {
      log('spawn failed:', err?.message ?? err);
      child = null;
      return;
    }

    const handle = child;
    const pipe = (name) => {
      const stream = handle && handle[name];
      if (!stream || typeof stream.on !== 'function') {
        log(`child.${name} not available`);
        return;
      }
      stream.setEncoding?.('utf8');
      stream.on('data', (chunk) => log(`child.${name}:`, String(chunk).trimEnd()));
    };
    pipe('stdout');
    pipe('stderr');

    // t8 D1: do NOT reset the counter on every spawn; only reset it after the
    // child has been stable for a while, so repeated crashes still trip
    // maxRespawns (diag shows "respawn limit reached" and then no new spawn).
    clearStable();
    stableTimer = setTimeout(() => {
      stableTimer = null;
      if (!disposed && child === handle) respawnCount = 0;
    }, STABLE_MS);

    log('spawned HUD', cfg.appDir, 'via', cfg.launcherPath);

    void child.done.then(
      (outcome) => {
        clearStable();
        child = null;
        if (disposed) return;
        log('HUD exited:', JSON.stringify(outcome));
        // Exit 0 means the app quit on purpose: either the user closed it, or we
        // handed off to an already-running instance (single-instance lock). In
        // both cases respawning would fight the user / thrash the lock, so stop.
        if (outcome && outcome.code === 0) {
          log('HUD exited cleanly; not respawning');
          return;
        }
        scheduleRespawn();
      },
      (err) => {
        clearStable();
        child = null;
        if (disposed) return;
        log('HUD spawn/exit error:', err?.message ?? err);
        scheduleRespawn();
      },
    );
  };

  const ensureRunning = () => {
    if (disposed) return false;
    if (child) return true; // a live child we spawned; do not duplicate (t15 #21)
    if (hudLikelyRunning()) {
      const d = preExistingDiscovery;
      log(
        'skip spawn: HUD likely already running (fresh discovery pid=' + d.pid +
          ' updatedAt=' + d.updatedAt + ' ageMs=' + ageMsOf(d.updatedAt) + ')',
      );
      return false;
    }
    spawnChild();
    return true;
  };

  // --- command (t7) --------------------------------------------------------
  let unregisterCommand = null;
  if (commands && typeof commands.register === 'function') {
    unregisterCommand = commands.register({
      name: 'dsh-hud',
      description: '打开或隐藏 DSH 悬浮胶囊（DSH HUD）',
      input: { hint: 'toggle | show | hide | reload（留空 = toggle）' },
      handler: ({ rawInput = '' }) => {
        if (disposed) return { kind: 'error', text: 'DSH HUD 插件已卸载' };
        // Only manage the child when spawnApp is enabled; under the default the
        // HUD self-starts and this command just writes control.json for it.
        if (cfg.spawnApp) ensureRunning();
        const action = (rawInput || '').trim().toLowerCase();
        // "Running" = we spawned a live child (spawnApp) OR the HUD self-started
        // and left a fresh discovery entry owned by a live process. Under the
        // default spawnApp=false the child is always null, so the old `child`
        // check falsely reported "not running" even while the HUD was up (t22 #4).
        const hudRunning = () => Boolean(child) || hudLikelyRunning();
        // When the HUD is not running, distinguish "not up yet" from "can't find
        // the program at all" (t36 P-02): the latter must tell the user what to do.
        const notRunning = () =>
          hud.found
            ? '但 HUD 未在运行（指令被忽略）'
            : '且未找到 HUD（请设置 hudDir 或 DSH_HUD_DIR）';
        const note = (okText, failText) => ({
          kind: 'success',
          text: hudRunning() ? okText : failText,
        });
        // 扩展点 2：非内置动作原样透传给 control.json，由 app 侧
        // extensions.registerControlAction 注册的 handler 处理。
        const builtins = ['show', 'hide', 'reload', 'toggle'];
        if (action && !builtins.includes(action)) {
          sendControl(action);
          return {
            kind: 'success',
            text: hudRunning()
              ? `已发送自定义动作：${action}`
              : `已发送动作 ${action}，${notRunning()}`,
          };
        }
        switch (action) {
          case 'show':
            sendControl('show');
            visible = true;
            return note('DSH 浮窗已打开', '已发送显示指令，' + notRunning());
          case 'hide':
            sendControl('hide');
            visible = false;
            return note('DSH 浮窗已隐藏', '已发送隐藏指令，' + notRunning());
          case 'reload':
            sendControl('reload');
            return note('已通知 DSH 浮窗重载 Web UI', '已发送重载指令，' + notRunning());
          case 'toggle':
          default:
            visible = !visible;
            sendControl('toggle');
            return note(
              visible ? 'DSH 浮窗已打开' : 'DSH 浮窗已隐藏',
              '已发送切换指令，' + notRunning(),
            );
        }
      },
    });
  }

  // --- startup + refresh ---------------------------------------------------
  log(
    'apply pid=' + process.pid,
    'LOCALAPPDATA=' + process.env.LOCALAPPDATA,
    'services=' +
      [webApp ? 'webApp' : '-', connection ? 'connection' : '-', webServer ? 'webServer' : '-', subprocess ? 'subprocess' : '-', commands ? 'commands' : '-'].join(','),
    'spawnApp=' + cfg.spawnApp,
    'electronExists=' + existsSync(cfg.electronPath),
  );
  // Start clean: a crashed/short-lived instance may leave *.tmp files behind,
  // and "one unique tmp per write" only holds if no stale ones survive (t12 D2).
  // Strictly sequential: the sweep must finish before the first discovery write
  // starts, otherwise it can delete the tmp of that very write (t16 B1).
  void (async () => {
    await cleanupTmpFiles();
    try {
      const d = await writeDiscovery();
      log('discovery written port=' + d.port + ' origin=' + d.origin);
      notifyReloadIfChanged(d);
      const wantAutostart = autostartDesired();
      if (wantAutostart === true) {
        await applyAutostart(true).catch((err) => log('autostart reconcile failed:', err?.message ?? err));
      } else if (wantAutostart === false) {
        await applyAutostart(false).catch(() => {});
      }
      if (cfg.spawnApp) ensureRunning();
    } catch (err) {
      log('discovery write failed:', err?.message ?? err);
    }
  })();

  // --- host-side privileged actions ---------------------------------------
  // The HUD runs at Low Mandatory Level (it is started from a user shell); UIPI
  // silently drops ShowWindow/SetForegroundWindow aimed at a Medium-IL window,
  // which is why every "focused ..." log line was a no-op. This host process is
  // Medium, so the HUD posts a request file and the launch + focus happen here.
  const IPC_POLL_MS = 500;
  const DSH_DESKTOP_EXE = desktopExe;
  let lastRequestId = '';
  let ipcBusy = false;
  // Two writers exist: a dev checkout (Low IL, can only write inside the repo)
  // and a packaged build (profile may live elsewhere). Poll every candidate so
  // either layout reaches the bridge; DSH_HUD_IPC_DIR still wins outright.
  const ipcDirectories = () => {
    if (process.env.DSH_HUD_IPC_DIR) return [process.env.DSH_HUD_IPC_DIR];
    const dirs = [path.join(path.dirname(cfg.appDir), 'artifacts', 'ipc')];
    if (process.env.LOCALAPPDATA) {
      dirs.push(path.join(process.env.LOCALAPPDATA, 'dsh-hud', 'ipc'));
    }
    return dirs;
  };
  // A request that sat on disk while the host was down is history, not a
  // command; replaying it would e.g. steal focus minutes later.
  const IPC_REQUEST_TTL_MS = 120_000;

  // --- autostart (dev builds) ---------------------------------------------
  // The HUD runs at Low IL and cannot write the user's Startup folder, but this
  // host is Medium. The HUD therefore drops autostart.json next to its
  // user-data dir and asks us (via ipc/request.json {action:"autostart"}) to
  // install or remove the logon script.
  const hudUserDataDir = () =>
    process.env.DSH_HUD_USER_DATA || path.join(path.dirname(cfg.appDir), 'artifacts', 'udd-hud');
  const startupCmdFile = () =>
    path.join(
      process.env.APPDATA || '',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      'dsh-hud.cmd',
    );
  // The packaged build cannot start from a plain double-click on this machine
  // (Chromium's sandbox pipe creation is denied), so the logon entry has to
  // carry the same flags the desktop shortcut uses. Prefer the packaged exe;
  // fall back to the dev checkout when it has not been built.
  const packagedLauncher = () => {
    // A packaged Release folder can now come from hudDir/exePath or any of the
    // standard install locations, not just <repo>/dist/win-unpacked (t36 P-02).
    if (hud.mode === 'exe') return { exe: hud.exe, udd: path.join(hud.dir, 'udd') };
    return null;
  };
  const autostartScript = () => {
    const packaged = packagedLauncher();
    if (packaged) {
      return [
        '@echo off',
        'rem DSH HUD autostart (packaged build; delete this file to disable).',
        'start "" "' + packaged.exe + '" --no-sandbox --user-data-dir="' + packaged.udd + '"',
        '',
      ].join('\r\n');
    }
    return [
      '@echo off',
      'rem DSH HUD autostart (dev build; delete this file to disable).',
      'set "ELECTRON_RUN_AS_NODE="',
      'start "" "' + cfg.electronPath + '" --no-sandbox --user-data-dir="' +
        hudUserDataDir() + '" "' + cfg.appDir + '"',
      '',
    ].join('\r\n');
  };
  async function applyAutostart(enabled) {
    const file = startupCmdFile();
    if (enabled) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, autostartScript(), 'ascii');
    } else {
      await rm(file, { force: true });
    }
    log('autostart ' + (enabled ? 'installed' : 'removed') + ':', file);
    return file;
  }
  const readAutostartCookie = (file) => {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      return Boolean(j && j.enabled);
    } catch {
      return null;
    }
  };
  // 打包版把选择写在 <dist>/udd，开发版写在仓库 artifacts/udd-hud；谁最新
  // 就代表用户当前的心意，两者都缺省时返回 null（不擅自改系统登录项）。
  const autostartDesired = () => {
    const packaged = packagedLauncher();
    if (packaged) {
      const fromPackaged = readAutostartCookie(path.join(packaged.udd, 'autostart.json'));
      if (fromPackaged !== null) return fromPackaged;
    }
    return readAutostartCookie(path.join(hudUserDataDir(), 'autostart.json'));
  };

  async function runFocusHelper() {
    const script = path.join(cfg.appDir, 'scripts', 'focus-dsh.ps1');
    if (!existsSync(script)) return { code: -1, out: 'helper missing' };
    return await new Promise((resolve) => {
      let out = '';
      let done = false;
      const finish = (code) => {
        if (done) return;
        done = true;
        resolve({ code, out: out.trim().split(/\r?\n/)[0] || '' });
      };
      try {
        const child = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ExePath', DSH_DESKTOP_EXE],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        child.stdout.on('data', (b) => { out += b.toString(); });
        child.stderr.on('data', (b) => { out += b.toString(); });
        child.on('error', (err) => { out += String(err?.message ?? err); finish(-2); });
        child.on('close', (code) => finish(code ?? -3));
        setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(-4); }, 8000);
      } catch (err) {
        out += String(err?.message ?? err);
        finish(-5);
      }
    });
  }

  async function handleDesktopRequest(req) {
    const exe = req.exe || DSH_DESKTOP_EXE;
    log('ipc request:', req.action, exe);
    if (exe && existsSync(exe)) {
      try {
        spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
        log('ipc launch requested');
      } catch (err) {
        log('ipc launch failed:', err?.message ?? err);
      }
    }
    await new Promise((r) => setTimeout(r, 900));
    const { code, out } = await runFocusHelper();
    log('ipc focus helper exit=' + code + ' out=' + out);
    return { ok: code === 0, out: out || 'exit ' + code };
  }

  const ipcTimer = setInterval(() => {
    if (disposed || ipcBusy) return;
    for (const dir of ipcDirectories()) {
      let raw;
      try { raw = readFileSync(path.join(dir, 'request.json'), 'utf8'); } catch { continue; }
      let req;
      try { req = JSON.parse(raw); } catch { continue; }
      if (!req || !req.id || req.id === lastRequestId) continue;
      if (typeof req.at === 'number' && Date.now() - req.at > IPC_REQUEST_TTL_MS) {
        lastRequestId = req.id;
        log('ipc request expired, ignored:', req.action, req.id);
        continue;
      }
      lastRequestId = req.id;
      ipcBusy = true;
      const task = req.action === 'autostart'
        ? applyAutostart(Boolean(req.enabled)).then((file) => ({ ok: true, out: 'autostart ' + (req.enabled ? 'on' : 'off') + ' ' + file }))
        : handleDesktopRequest(req);
      void task
        .then(async (res) => {
          const file = path.join(dir, 'result.json');
          const tmp = `${file}.${process.pid}.tmp`;
          await mkdir(dir, { recursive: true });
          await writeFile(tmp, JSON.stringify({ id: req.id, ok: res.ok, out: res.out, at: Date.now() }, null, 2));
          await rename(tmp, file);
        })
        .catch((err) => log('ipc handle failed:', err?.message ?? err))
        .finally(() => { ipcBusy = false; });
      return; // one request per tick
    }
  }, IPC_POLL_MS);

  const timer = setInterval(() => {
    if (disposed) return;
    void writeDiscovery()
      .then((d) => notifyReloadIfChanged(d))
      .catch((err) => log('discovery refresh failed:', err?.message ?? err));
  }, cfg.refreshMs);

  // --- dispose -------------------------------------------------------------
  return () => {
    disposed = true;
    clearInterval(timer);
    clearInterval(ipcTimer);
    if (respawnTimer) clearTimeout(respawnTimer);
    clearStable();
    abort.abort();
    if (child) {
      try {
        child.terminate();
      } catch {
        /* already gone */
      }
    }
    child = null;
    if (unregisterCommand) {
      try {
        unregisterCommand();
      } catch {
        /* ignore */
      }
    }
    void rm(dFile, { force: true }).catch(() => {});
    void rm(dTmp, { force: true }).catch(() => {});
    void rm(cFile, { force: true }).catch(() => {});
    void cleanupTmpFiles().catch(() => {});
  };
}
