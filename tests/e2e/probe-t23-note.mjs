/**
 * t23 probe: /dsh-hud command success text when the HUD starts AFTER the
 * plugin's apply() call.
 *
 * The t22 fix uses `child || hudLikelyRunning()`, but hudLikelyRunning() is
 * evaluated against `preExistingDiscovery`, a snapshot taken at apply time.
 * A HUD that self-starts later is therefore reported as "not running".
 *
 * This probe is intentionally minimal: spawnApp=false, no child, apply with an
 * empty LOCALAPPDATA, then write a fresh discovery entry (as if the HUD just
 * started) and invoke the registered command.
 *
 * Run: <bundled node> tests/e2e/probe-t23-note.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..', '..');
const PLUGIN = path.resolve(ROOT, 'plugin', 'index.js');
const plugin = await import(pathToFileURL(PLUGIN).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-hud-t23-note-'));
process.env.LOCALAPPDATA = tmp;
const discovery = path.join(tmp, 'dsh-hud', 'discovery.json');
const commands = [];
let base = 'http://127.0.0.1:51234/';

const ctx = {
  get(name) {
    if (name === 'webApp') return { getAdvertisedUrl: () => base };
    if (name === 'connection') return { authenticatedUrl: (u) => `${u}?token=T0K` };
    if (name === 'webServer') return { getOrigin: () => base };
    if (name === 'subprocess') return { spawn: () => { throw new Error('must not spawn'); } };
    if (name === 'commands') {
      return {
        register(def) {
          commands.push(def);
          return () => { def._unregistered = true; };
        },
      };
    }
    return undefined;
  },
};

const dispose = plugin.apply(ctx, {
  electronPath: path.resolve(ROOT, 'runtime', 'node_modules', 'electron', 'dist', 'electron.exe'),
  appDir: path.resolve(ROOT, 'app'),
  spawnApp: false,
  refreshMs: 60_000,
  respawnDelayMs: 50,
  maxRespawns: 1,
});

try {
  // apply() writes its own discovery entry; wait for that write.
  for (let i = 0; i < 100; i += 1) {
    try {
      await fs.access(discovery);
      break;
    } catch { await sleep(10); }
  }
  // A HUD self-starts after apply: overwrite with a fresh, live-pid entry.
  await fs.mkdir(path.dirname(discovery), { recursive: true });
  await fs.writeFile(discovery, JSON.stringify({
    pid: process.pid,
    port: '51234',
    url: 'http://127.0.0.1:51234/?token=SELFSTART',
    updatedAt: new Date().toISOString(),
  }), 'utf8');
  await sleep(30);

  const show = commands[0].handler({ rawInput: 'show' });
  const reportedNotRunning = String(show.text).includes('未在运行');
  console.log(JSON.stringify({
    bugReproduced: reportedNotRunning,
    commandText: show.text,
    commandKind: show.kind,
    explanation: reportedNotRunning
      ? 'HUD started after apply; hudLikelyRunning() still sees the null apply-time snapshot'
      : 'unexpected: command reported success',
  }, null, 2));
  process.exitCode = reportedNotRunning ? 0 : 1;
} finally {
  dispose();
  // The plugin's async discovery/control writes can race the temp cleanup.
  await sleep(150);
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
}
