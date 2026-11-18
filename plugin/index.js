/**
 * DSH HUD — token bridge + optional floating-window integration (t2 + t7 + t10).
 *
 * On activation it:
 *   1. publishes the authenticated DSH Web URL (with a fresh `?token=`) to
 *      `%LOCALAPPDATA%\dsh-hud\discovery.json` (t2);
 *   2. brings the Electron HUD app up when needed. There are three paths:
 *        - `autoStartWithDsh` (DEFAULT ON): a Windows scheduled task
 *          (`dsh-hud-launch`) created via PowerShell, which runs outside this
 *          process tree with a normal token, so no UAC prompt appears;
 *        - login Startup entry (written by the first-run `autostart` install);
 *        - two opt-in low-level paths, both default OFF: `spawnApp` (node.exe
 *          launcher as a direct subprocess — crashes inside this host:
 *          crashpad_client_win.cc:867, exit 0xFFFF7003) and `shellLaunch`
 *          (ask Explorer to run a generated .cmd — needs a human click).
 *      `/dsh-hud on|off|status` start/stop/report the capsule; `toggle|show|
 *      hide|reload` drive an already-running one.
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
import { appendFileSync, createReadStream, createWriteStream, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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

// P-13: an unsigned exe that a background process launches can be frozen by
// Chinese AV suites (悟空/360/火绒/Defender) with no error at all — the user
// just sees "nothing happened". Whenever a launch fails or the child dies
// right away, say this instead of failing silently.
const LAUNCH_BLOCKED_HINT =
  'DSH HUD 没有起来时，多半是被安全软件（悟空/360/火绒/Windows Defender）拦截了：' +
  '把 DSH HUD.exe 加进信任/白名单，或手动双击安装目录里的 DSH HUD.lnk 启动一次；' +
  '详见 README 的「安全软件拦截」一节';

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
// P-06: the packaged exe now lives in <root>/app/DSH HUD.exe (new layout); the
// old layout had it flat at <root>/DSH HUD.exe. The portable root (where the
// launcher and the writable udd/ live) is the parent of the app/ subdir in the
// new layout, and the exe's own dir in the old one.
function portableRootOf(exePath) {
  const dir = path.dirname(exePath);
  if (path.basename(dir).toLowerCase() === 'app') return path.dirname(dir);
  return dir;
}

export function resolveHud(opts = {}) {
  const localAppData = opts.localAppData ?? process.env.LOCALAPPDATA ?? '';
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const exePath = opts.exePath; // already-resolved explicit exe path
  const hudDir = opts.hudDir; // already-resolved explicit dir holding DSH HUD.exe

  if (exePath) {
    return existsSync(exePath)
      ? { found: true, mode: 'exe', exe: exePath, dir: path.dirname(exePath), root: portableRootOf(exePath) }
      : { found: false, mode: 'exe', reason: '未找到 HUD：exePath 指向的 exe 不存在（' + exePath + '）' };
  }
  if (hudDir) {
    // P-06: new layout (<root>/app/DSH HUD.exe) first, then the old flat one.
    const newExe = path.join(hudDir, 'app', 'DSH HUD.exe');
    const oldExe = path.join(hudDir, 'DSH HUD.exe');
    if (existsSync(newExe)) return { found: true, mode: 'exe', exe: newExe, dir: path.dirname(newExe), root: hudDir };
    if (existsSync(oldExe)) return { found: true, mode: 'exe', exe: oldExe, dir: path.dirname(oldExe), root: hudDir };
    return { found: false, mode: 'dir', reason: '未找到 HUD：hudDir 目录下没有 DSH HUD.exe（' + hudDir + '）' };
  }

  const candidates = [
    // P-06: new layout (<root>/app/DSH HUD.exe) first, then the old flat one.
    localAppData ? path.join(localAppData, 'DSH HUD', 'app', 'DSH HUD.exe') : '',
    localAppData ? path.join(localAppData, 'Programs', 'DSH HUD', 'app', 'DSH HUD.exe') : '',
    path.join(repoRoot, 'dist', 'win-unpacked', 'app', 'DSH HUD.exe'),
    localAppData ? path.join(localAppData, 'DSH HUD', 'DSH HUD.exe') : '',
    localAppData ? path.join(localAppData, 'Programs', 'DSH HUD', 'DSH HUD.exe') : '',
    path.join(repoRoot, 'dist', 'win-unpacked', 'DSH HUD.exe'),
  ];
  for (const exe of candidates) {
    if (exe && existsSync(exe)) return { found: true, mode: 'exe', exe, dir: path.dirname(exe), root: portableRootOf(exe) };
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

// --- first-run app install (npm one-click) --------------------------------
// Installed from npm, the package only carries the plugin: the ~150 MB desktop
// app lives in a GitHub Release. On first activation — and only when no HUD is
// resolvable — download that zip, verify its sha256, and extract it into
// %LOCALAPPDATA%\\DSH HUD, so "install by package name" really is one click.
const RELEASE_API = 'https://api.github.com/repos/suianest/dsh-hud/releases/latest';
const AUTO_INSTALL_DIR = () => path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'DSH HUD');

// GitHub is unreliable behind the GFW, and a 150 MB body can stall forever, so
// every request gets a hard timeout and the download walks a mirror list
// (same proxies the standalone installer uses). Measured 2026-11-16: direct
// github.com ~15 KB/s with resets; ghproxy.net / gh-proxy.com ~110 KB/s; the
// ghfast.top proxy the installer used first was unreachable. — t40 P-04
const RELEASE_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 600_000;
const MIRROR_PREFIXES = ['https://ghproxy.net/', 'https://gh-proxy.com/', 'https://ghfast.top/'];

async function fetchWithTimeout(url, ms, init = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    ...init,
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok || !res.body) throw new Error('HTTP ' + res.status + ' for ' + url);
  return res;
}

async function downloadTo(url, dest) {
  const once = async (u) => {
    const res = await fetchWithTimeout(u, DOWNLOAD_TIMEOUT_MS, {
      headers: { 'user-agent': 'dsh-hud-plugin' },
    });
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  };
  const sources = [url, ...MIRROR_PREFIXES.map((p) => p + url)];
  let lastErr;
  for (const src of sources) {
    try {
      await once(src);
      return dest;
    } catch (err) {
      lastErr = err;
      await rm(dest, { force: true }).catch(() => {});
    }
  }
  throw lastErr;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

export async function installHudApp(opts = {}) {
  if (process.platform !== 'win32') return { ok: false, message: 'only supported on Windows' };
  const dir = opts.dir || AUTO_INSTALL_DIR();
  const relRes = await fetchWithTimeout(RELEASE_API, RELEASE_TIMEOUT_MS, {
    headers: { 'user-agent': 'dsh-hud-plugin' },
  });
  const rel = await relRes.json();
  const asset = (rel.assets || []).find((a) => /^DSH-HUD-.*-win-x64\.zip$/.test(a.name));
  if (!asset) return { ok: false, message: 'release has no win-x64 zip' };
  const zip = path.join(os.tmpdir(), 'dsh-hud-' + (asset.id || Date.now()) + '.zip');
  await downloadTo(asset.browser_download_url, zip);
  const size = statSync(zip).size;
  if (asset.size && size !== asset.size) {
    await rm(zip, { force: true });
    throw new Error('size mismatch: expected ' + asset.size + ' got ' + size);
  }
  const digest = (asset.digest || '').replace(/^sha256:/, '').toLowerCase();
  if (digest) {
    const got = await sha256File(zip);
    if (got !== digest) {
      await rm(zip, { force: true });
      throw new Error('sha256 mismatch: expected ' + digest + ' got ' + got);
    }
  } else {
    // Older assets may not carry a digest; size is still enforced above.
    console.error('[dsh-hud] release asset has no sha256 digest; size check only');
  }
  await mkdir(dir, { recursive: true });
  const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
  const ps = 'Expand-Archive -LiteralPath ' + q(zip) + ' -DestinationPath ' + q(dir) + ' -Force';
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Expand-Archive exit ' + code))));
  });
  await rm(zip, { force: true });
  const exe = path.join(dir, 'app', 'DSH HUD.exe');
  return existsSync(exe)
    ? { ok: true, dir, message: 'installed ' + exe }
    : { ok: false, message: 'extracted but app/DSH HUD.exe is missing in ' + dir };
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
    // "Follow DSH": bring the capsule up when the host starts. Uses the silent
    // scheduled-task path, so it needs no click and cannot crash the host.
    // `autostart.json` (the tray menu's on/off) still wins: opting out there
    // means "do not start it behind my back", so we skip.
    autoStartWithDsh:
      config.autoStartWithDsh ?? envBool('DSH_HUD_AUTOSTART_WITH_DSH') ?? localConfig.autoStartWithDsh ?? true,
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
  const hudOptions = () => ({
    exePath: config.exePath ?? envStr('DSH_HUD_EXE') ?? localConfig.exePath,
    hudDir: config.hudDir ?? envStr('DSH_HUD_DIR') ?? localConfig.hudDir,
    devElectron: cfg.electronPath,
    devAppDir: cfg.appDir,
    devLauncher: cfg.launcherPath,
  });
  // Resolved once at apply time, but re-resolved after a first-run auto-install:
  // otherwise the fresh HUD is invisible to autostart/shortcut/task/auto-start
  // until DSH is restarted (t40 P-01).
  let hud = resolveHud(hudOptions());
  const refreshHud = () => {
    hud = resolveHud(hudOptions());
    return hud;
  };
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
      JSON.stringify({ pid: d.pid, port: d.port, url: d.url, updatedAt: d.updatedAt, protocolVersion: PROTOCOL_VERSION }, null, 2),
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
      log(LAUNCH_BLOCKED_HINT);
      child = null;
      return;
    }

    const handle = child;
    const spawnedAt = Date.now();
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
        if (Date.now() - spawnedAt < 5_000 && outcome && outcome.code !== 0) {
          // Died within 5s: almost always a policy/AV block rather than a crash.
          log(LAUNCH_BLOCKED_HINT);
        }
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
      description: '开关 DSH 悬浮胶囊（DSH HUD）：on 启动 / off 退出 / status 查看',
      input: { hint: 'on | off | status | toggle | show | hide | reload（留空 = toggle）' },
      handler: async ({ rawInput = '' }) => {
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
          text:
            (hudRunning() ? okText : failText) +
            (hudRunning() && firstRunAutostart ? '（首次运行已自动添加开机启动与开始菜单快捷方式，可在右键菜单关闭）' : ''),
        });
        // 扩展点 2：非内置动作原样透传给 control.json，由 app 侧
        // extensions.registerControlAction 注册的 handler 处理。
        if (action === 'on') {
          if ((await hudProcessCount()) > 0) {
            sendControl('show');
            visible = true;
            return { kind: 'success', text: 'DSH 浮窗已打开（进程已在运行）' };
          }
          const ok = await ensureHudRunning();
          visible = ok;
          return ok
            ? { kind: 'success', text: 'DSH HUD 已启动' }
            : { kind: 'error', text: '启动失败：没有找到打包版 HUD（详见插件诊断日志）' };
        }
        if (action === 'off') {
          if ((await hudProcessCount()) <= 0) return { kind: 'success', text: 'DSH HUD 未在运行' };
          sendControl('quit');
          for (let i = 0; i < 8; i += 1) {
            await sleep(300);
            if ((await hudProcessCount()) <= 0) break;
          }
          if ((await hudProcessCount()) > 0) {
            return { kind: 'error', text: '已发送退出指令，但进程仍在（可手动结束 DSH HUD.exe）' };
          }
          visible = false;
          return { kind: 'success', text: 'DSH HUD 已关闭' };
        }
        if (action === 'status') {
          const n = await hudProcessCount();
          const where = hud.found ? hud.exe : '未找到安装目录';
          return {
            kind: n > 0 ? 'success' : 'info',
            text: (n > 0 ? `运行中（${n} 个进程）` : '未运行') + ' · ' + where,
          };
        }
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

    // Every step is isolated: one failure must not skip the rest (t40 P-03).
    try {
      const d = await writeDiscovery();
      log('discovery written port=' + d.port + ' origin=' + d.origin);
      notifyReloadIfChanged(d);
    } catch (err) {
      log('discovery write failed:', err?.message ?? err);
    }

    // npm installs carry the plugin only; fetch the app once when it is absent.
    if (process.platform === 'win32' && process.env.DSH_HUD_NO_AUTO_INSTALL !== '1' && !hud.found) {
      try {
        log('HUD not found; auto-installing from the latest release (first run)');
        const r = await installHudApp();
        log('auto-install:', r.ok ? r.message : 'failed: ' + r.message);
        if (r.ok) {
          refreshHud();
          log(
            hud.found
              ? 'HUD found after auto-install: ' + (hud.exe ?? hud.dir)
              : 'HUD still missing after auto-install (' + hud.reason + ')',
          );
        }
      } catch (err) {
        log('auto-install failed:', err?.message ?? err);
      }
    }

    try {
      const wantAutostart = autostartDesired();
      if (wantAutostart === true) {
        await applyAutostart(true);
      } else if (wantAutostart === false) {
        await applyAutostart(false);
      } else if (packagedLauncher() && process.env.DSH_HUD_NO_AUTOSTART !== '1') {
        // P-07: a fresh plugin-only install has no cookie and no shortcut, so
        // without this the capsule would never appear at logon. Install once,
        // then record the decision so a later "off" is never overridden.
        await installFirstRunAutostart();
      }
    } catch (err) {
      log('autostart step failed:', err?.message ?? err);
    }

    // Only the opt-in task path registers a scheduled task. Default installs
    // spawn the exe directly, so we never leave behind a task whose action is
    // an unsigned auto-start target (that is what AV tools flag).
    if (useTaskOnly()) {
      try {
        await ensureLaunchTask();
      } catch (err) {
        log('launch task setup failed:', err?.message ?? err);
      }
    } else {
      await removeLegacyLaunchTask();
    }

    // P-08: the HUD cannot write %APPDATA%\Roaming itself (Low IL), so the
    // Medium-IL host owns the Start-menu shortcut as well.
    try {
      await ensureStartMenuShortcut();
    } catch (err) {
      log('start-menu shortcut failed:', err?.message ?? err);
    }

    try {
      // Legacy opt-in path first: it starts the dev checkout synchronously.
      if (cfg.spawnApp) ensureRunning();
      // "Follow DSH" (packaged installs only): the scheduled task is the one
      // launcher that neither crashes the host nor needs a click.
      if (cfg.autoStartWithDsh && !cfg.spawnApp && packagedLauncher()) {
        if (autostartDesired() === false) {
          log('auto-start with DSH skipped (user turned autostart off)');
        } else if ((await hudProcessCount()) > 0) {
          log('capsule already running; skip auto-start');
        } else {
          const started = await ensureHudRunning();
          log(started ? 'auto-started with DSH' : 'auto-start with DSH failed (see log above)');
        }
      }
    } catch (err) {
      log('start-with-DSH step failed:', err?.message ?? err);
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
    // Packaged installs write next to their own resources directory
    // (<root>/artifacts/ipc, or <root>/resources/artifacts/ipc when the asar is
    // under resources/). Without this the desktop-focus request silently times
    // out on any machine that is not the build machine (t40 P-02).
    if (hud.found) {
      const root = hud.root ?? (hud.dir && path.basename(hud.dir) === 'app' ? path.dirname(hud.dir) : hud.dir);
      if (root) {
        dirs.push(path.join(root, 'artifacts', 'ipc'));
        dirs.push(path.join(root, 'resources', 'artifacts', 'ipc'));
      }
    }
    if (process.env.LOCALAPPDATA) {
      dirs.push(path.join(process.env.LOCALAPPDATA, 'dsh-hud', 'ipc'));
    }
    return dirs;
  };
  // A request that sat on disk while the host was down is history, not a
  // command; replaying it would e.g. steal focus minutes later.
  const IPC_REQUEST_TTL_MS = 120_000;

// Incremented whenever discovery/control payloads change shape. The HUD compares
// this against its own expectation and only warns on a mismatch (never blocks).
const PROTOCOL_VERSION = 1;

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
    if (hud.mode === 'exe') return { exe: hud.exe, udd: path.join(hud.root ?? hud.dir, 'udd') };
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
  // A temporary exe (test fixture, half-extracted zip) must never become the
  // logon entry: the file disappears and every login shows "Windows cannot
  // find ...". Same guard as the scheduled-task path.
  const isTempPath = (p) => {
    const t = os.tmpdir().toLowerCase();
    return String(p || '').toLowerCase().startsWith(t);
  };
  async function applyAutostart(enabled) {
    const file = startupCmdFile();
    if (enabled) {
      const target = packagedLauncher();
      const exe = target ? target.exe : cfg.electronPath;
      if (isTempPath(exe) && process.env.DSH_HUD_ALLOW_TEMP_AUTOSTART !== '1') {
        log('autostart skipped: launcher lives in a temp folder', exe);
        return file;
      }
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

  // P-07: install the logon entry exactly once for a packaged install, then
  // leave an explicit cookie next to its user-data so the tray menu wins later.
  let firstRunAutostart = null;
  async function installFirstRunAutostart() {
    const packaged = packagedLauncher();
    if (!packaged) return null;
    const file = await applyAutostart(true);
    const cookie = path.join(packaged.udd, 'autostart.json');
    await mkdir(packaged.udd, { recursive: true });
    await writeFile(
      cookie,
      JSON.stringify({ enabled: true, by: 'plugin-first-run', at: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    );
    firstRunAutostart = file;
    log('autostart first-run installed:', file, 'cookie:', cookie);
    return file;
  }

  // P-08: the HUD cannot create this itself. Started from the desktop it runs
  // at Low Mandatory Level, and saving a .lnk under %APPDATA%\Roaming fails
  // with E_ACCESSDENIED (0x80070005). This host is Medium, so it does the one
  // write; the HUD keeps its own attempt as a fallback for Medium launches.
  const startMenuLink = () =>
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DSH HUD.lnk');
  // Users look for the app on the desktop first, so install both links (P-08).
  const desktopLink = () => {
    const home = process.env.USERPROFILE || '';
    const oneDrive = path.join(home, 'OneDrive', 'Desktop');
    return {
      candidates: [path.join(home, 'Desktop', 'DSH HUD.lnk'), path.join(oneDrive, 'DSH HUD.lnk')],
    };
  };
  const psQuote = (s) => String(s).replace(/'/g, "''");
  const runPowerShell = (command, timeoutMs = 15_000) =>
    new Promise((resolve) => {
      let out = '';
      let done = false;
      const finish = (code) => {
        if (done) return;
        done = true;
        resolve({ code, out: out.trim() });
      };
      try {
        const child = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        child.stdout.on('data', (b) => { out += b.toString(); });
        child.stderr.on('data', (b) => { out += b.toString(); });
        child.on('error', (err) => { out += String(err?.message ?? err); finish(-1); });
        child.on('close', (code) => finish(code ?? -2));
        setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(-3); }, timeoutMs);
      } catch (err) {
        out += String(err?.message ?? err);
        finish(-4);
      }
    });
  let startMenuLinkInstalled = null;
  async function ensureStartMenuShortcut() {
    if (process.env.DSH_HUD_NO_STARTMENU === '1') return null;
    const packaged = packagedLauncher();
    if (!packaged) return null;
    const link = startMenuLink();
    const links = [link];
    // Desktop: prefer the folder that already exists (OneDrive-redirected
    // desktops are common on Windows 11).
    const desk = desktopLink().candidates.find((p) => existsSync(path.dirname(p)));
    if (desk) links.push(desk);
    if (links.every((p) => existsSync(p))) return link;
    await mkdir(path.dirname(link), { recursive: true });
    const args = '--no-sandbox --user-data-dir="' + packaged.udd + '"';
    const ps = [
      "$ErrorActionPreference = 'Stop';",
      '$ws = New-Object -ComObject WScript.Shell;',
      "foreach ($p in @('" + links.map(psQuote).join("','") + "')) {",
      '  $lnk = $ws.CreateShortcut($p);',
      "  $lnk.TargetPath = '" + psQuote(packaged.exe) + "';",
      "  $lnk.Arguments = '" + psQuote(args) + "';",
      "  $lnk.WorkingDirectory = '" + psQuote(path.dirname(packaged.exe)) + "';",
      "  $lnk.IconLocation = '" + psQuote(packaged.exe + ',0') + "';",
      "  $lnk.Description = 'DSH HUD';",
      '  $lnk.Save();',
      '}',
    ].join(' ');
    const { code, out } = await runPowerShell(ps);
    if (code === 0) {
      startMenuLinkInstalled = link;
      log('start-menu shortcut installed:', link);
      return link;
    }
    log('start-menu shortcut failed:', out || 'exit ' + code);
    return null;
  }

  // --- launch task (on/off from DSH) ---------------------------------------
  // 2026-11-13 the host's direct spawn died at 0x80000003 (Chromium setting up
  // crashpad/mojo). Re-tested 2026-11-18: the crash came from the child falling
  // back to the shared %APPDATA%\Electron profile -- with `--no-sandbox` plus a
  // writable `--user-data-dir` a direct spawn from this host stays up (verified
  // end-to-end, 5 processes, no 8s exit). Direct spawn is therefore the default
  // again; the per-user scheduled task is kept only as the opt-in fallback
  // (`DSH_HUD_USE_TASK=1`), because a task that starts an unsigned exe is what
  // AV like 悟空 flags. `off` uses the control channel's quit action.
  const LAUNCH_TASK = 'dsh-hud-launch';
  let launchTaskReady = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function removeLaunchTask() {
    const ps =
      "$ErrorActionPreference = 'SilentlyContinue';" +
      " if (Get-ScheduledTask -TaskName '" + LAUNCH_TASK + "' -ErrorAction SilentlyContinue)" +
      " { Unregister-ScheduledTask -TaskName '" + LAUNCH_TASK + "' -Confirm:$false }";
    await runPowerShell(ps, 15_000).catch(() => {});
    launchTaskReady = false;
    log('launch task removed (no valid HUD exe)');
  }

  async function ensureLaunchTask() {
    if (process.env.DSH_HUD_NO_LAUNCH_TASK === '1') return false;
    const packaged = packagedLauncher();
    if (!packaged) return false;
    // A task whose action points at a missing exe makes Windows pop
    // "找不到文件" on every logon. Tests used to resolve a throwaway exe under
    // %TEMP% and leave that task behind, so refuse anything that is not a real
    // installed binary (and never a temp path) and clean the stale task up.
    const tmp = path.resolve(os.tmpdir()).toLowerCase();
    if (!existsSync(packaged.exe) || path.resolve(packaged.exe).toLowerCase().startsWith(tmp)) {
      await removeLaunchTask();
      return false;
    }
    const ps = [
      "$ErrorActionPreference = 'Stop';",
      'try {',
      "$a = New-ScheduledTaskAction -Execute '" + psQuote(packaged.exe) + "'",
      "  -Argument '--no-sandbox --user-data-dir=\"" + psQuote(packaged.udd) + "\"'",
      "  -WorkingDirectory '" + psQuote(path.dirname(packaged.exe)) + "';",
      '$t = New-ScheduledTaskTrigger -Once -At (Get-Date).AddYears(1);',
      "Register-ScheduledTask -TaskName '" + LAUNCH_TASK + "' -Action $a -Trigger $t -Force | Out-Null;",
      "'ok'",
      "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
    ].join(' ');
    const { code, out } = await runPowerShell(ps, 20_000);
    launchTaskReady = code === 0;
    log(launchTaskReady ? 'launch task ready: ' + LAUNCH_TASK : 'launch task failed: ' + (out || 'exit ' + code));
    return launchTaskReady;
  }

  const useTaskOnly = () => process.env.DSH_HUD_USE_TASK === '1';

  /**
   * Start the packaged HUD as a detached child of this host process.
   *
   * The child must get `--no-sandbox` and a writable `--user-data-dir`: without
   * them Chromium picks the shared `%APPDATA%\Electron` profile and aborts with
   * 0x80000003 before any of our JS runs. `detached` + `unref` keeps it alive
   * when DSH exits; `stdio: 'ignore'` keeps the pipes out of our process tree.
   */
  async function startHudDirect() {
    const packaged = packagedLauncher();
    if (!packaged) {
      log('direct launch skipped: no packaged launcher resolved');
      return false;
    }
    // Never let the child inherit ELECTRON_RUN_AS_NODE: some DSH shells set it,
    // and an Electron binary started with it runs as plain Node (no window).
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    try {
      const child = spawn(packaged.exe, ['--no-sandbox', '--user-data-dir=' + packaged.udd], {
        cwd: path.dirname(packaged.exe),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: childEnv,
      });
      child.on('error', (err) => log('direct launch error:', err?.message ?? err));
      child.unref();
      log('direct launch requested: ' + path.basename(packaged.exe) + ' pid=' + child.pid);
    } catch (err) {
      log('direct launch failed:', err?.message ?? err);
      return false;
    }
    for (let i = 0; i < 10; i += 1) {
      await sleep(600);
      if ((await hudProcessCount()) > 0) {
        log('direct launch confirmed: DSH HUD is running');
        return true;
      }
    }
    log('direct launch: no DSH HUD process appeared within 6s');
    return false;
  }

  /** Default launcher: direct spawn first, scheduled task only as fallback. */
  async function ensureHudRunning() {
    if ((await hudProcessCount()) > 0) return true;
    if (!useTaskOnly()) {
      if (await startHudDirect()) return true;
      log('direct launch did not work; falling back to the scheduled task');
    }
    return startHudViaTask().catch(() => false);
  }

  /**
   * 0.5.4 and older always registered `dsh-hud-launch`. Now that the default is
   * a direct spawn, a leftover task is pure downside: a scheduled task pointing
   * at an unsigned exe is exactly what AV vendors flag. Drop it when we are not
   * in task mode (the fallback recreates it on demand).
   */
  async function removeLegacyLaunchTask() {
    if (useTaskOnly()) return;
    if (process.env.DSH_HUD_NO_LAUNCH_TASK === '1') return;
    try {
      const ps =
        "$ErrorActionPreference = 'SilentlyContinue';" +
        " if (Get-ScheduledTask -TaskName '" + LAUNCH_TASK + "' -ErrorAction SilentlyContinue)" +
        " { Unregister-ScheduledTask -TaskName '" + LAUNCH_TASK + "' -Confirm:$false; 'removed' } else { 'absent' }";
      const { out } = await runPowerShell(ps, 15_000);
      if (out.trim() === 'removed') log('legacy launch task removed (direct launch is the default now)');
    } catch (err) {
      log('legacy launch task cleanup failed:', err?.message ?? err);
    }
  }

  async function hudProcessCount() {
    const { code, out } = await runPowerShell(
      "(Get-Process -Name 'DSH HUD' -ErrorAction SilentlyContinue | Measure-Object).Count",
    );
    if (code !== 0) return -1;
    const n = Number.parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : -1;
  }

  async function startHudViaTask() {
    if (!launchTaskReady && !(await ensureLaunchTask())) return false;
    const { code } = await runPowerShell("Start-ScheduledTask -TaskName '" + LAUNCH_TASK + "'; 'ok'", 20_000);
    if (code !== 0) return false;
    for (let i = 0; i < 10; i += 1) {
      await sleep(600);
      if ((await hudProcessCount()) > 0) return true;
    }
    log('launch task ran but no DSH HUD process appeared');
    log(LAUNCH_BLOCKED_HINT);
    return false;
  }

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
