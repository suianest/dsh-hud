/**
 * Headless tests for plugin/index.js (t2 token bridge + t7 HUD integration +
 * t10 repair: spawnApp opt-in, D1 respawn limit, D2 unique control tmp, D5 skip log).
 *
 * The real Cordis Host is not available inside the test process, so this test
 * supplies a mocked service directory (`ctx.get`) and a mocked
 * `subprocess.spawn` handle. It verifies the plugin's side of the contract:
 * discovery.json contents/refresh, spawn argv/env, control.json + stdin
 * notifications, the /dsh-hud command, linear respawn backoff, dispose cleanup,
 * the spawnApp default (auto-start) / opt-out and the documented "missing subprocess
 * service" degradation.
 *
 * Run: node --test --test-isolation=none tests/e2e/unit/plugin.test.mjs
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
const PLUGIN = path.resolve(ROOT, 'plugin', 'index.js');
const APP_DIR = path.resolve(ROOT, 'app');
const ELECTRON = path.resolve(ROOT, 'runtime', 'node_modules', 'electron', 'dist', 'electron.exe');
const NODE = process.execPath;
const LAUNCHER = path.resolve(ROOT, 'app', 'scripts', 'launch-hud.cjs');
const plugin = await import(pathToFileURL(PLUGIN).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 1500, step = 10, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(step);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHandle() {
  const done = deferred();
  const stdin = {
    destroyed: false,
    written: [],
    write(chunk) {
      this.written.push(chunk);
      return true;
    },
    destroy() {
      this.destroyed = true;
    },
  };
  return { done: done.promise, stdin, terminateCalls: 0, terminate() { this.terminateCalls += 1; }, _done: done };
}

function makeContext({
  advertised = 'http://127.0.0.1:51234/',
  token = 'T0K',
  spawnApp = false,
  withSubprocess = true,
} = {}) {
  const spawns = [];
  const commands = [];
  let base = advertised;
  let tok = token;
  const ctx = {
    get(name) {
      if (name === 'webApp') return { getAdvertisedUrl: () => base };
      if (name === 'connection') return { authenticatedUrl: (u) => `${u}?token=${tok}` };
      if (name === 'webServer') return { getOrigin: () => base };
      if (name === 'subprocess') {
        if (!withSubprocess) return undefined;
        return {
          spawn(spec) {
            const handle = makeHandle();
            spawns.push({ spec, handle });
            return handle;
          },
        };
      }
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
  return {
    ctx,
    spawns,
    commands,
    setOrigin(next, nextToken = tok) { base = next; tok = nextToken; },
    config(extra = {}) {
      return {
        electronPath: ELECTRON,
        appDir: APP_DIR,
        nodePath: NODE,
        launcherPath: LAUNCHER,
        spawnApp,
        shellLaunch: false, // keep the explorer path out of unit tests
        refreshMs: 10_000,
        respawnDelayMs: 20,
        maxRespawns: 3,
        ...extra,
      };
    },
  };
}

async function makeLocalAppData() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-hud-plugin-'));
  process.env.LOCALAPPDATA = dir;
  return {
    dir,
    discovery: path.join(dir, 'dsh-hud', 'discovery.json'),
    control: path.join(dir, 'dsh-hud', 'control.json'),
    async cleanup() {
      // The plugin's dispose() is synchronous by contract and fires its file
      // removals fire-and-forget; a plain rm can then race those deletes and
      // fail with ENOTEMPTY (M1, 2026-11-10). Retry briefly before giving up.
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        try {
          await fsp.rm(dir, { recursive: true, force: true });
          return;
        } catch (err) {
          const code = err && err.code;
          if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw err;
          await new Promise((r) => setTimeout(r, 25 * attempt));
        }
      }
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

test('apply: writes discovery with token URL and spawns HUD via node launcher with a clean env', async () => {
  const env = await makeLocalAppData();
  const h = makeContext();
  const dispose = plugin.apply(h.ctx, h.config({ spawnApp: true }));
  try {
    const d = await waitFor(async () => {
      try { return await readJson(env.discovery); } catch { return null; }
    }, { label: 'discovery.json' });

    assert.equal(d.port, '51234');
    assert.equal(d.url, 'http://127.0.0.1:51234/?token=T0K');
    assert.equal(d.pid, process.pid);
    assert.ok(!('origin' in d), 'origin is internal only and must not be persisted');
    assert.ok(Date.parse(d.updatedAt) > 0);

    const spawn = await waitFor(() => h.spawns[0], { label: 'spawn' });
    assert.deepEqual(spawn.spec.argv, [NODE, LAUNCHER]);
    assert.equal(spawn.spec.cwd, APP_DIR);
    assert.deepEqual(spawn.spec.stdio, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    assert.equal(spawn.spec.graceMs, 3000);
    assert.ok(spawn.spec.signal instanceof AbortSignal);
    assert.equal(spawn.spec.env.DSH_HUD_DISCOVERY, env.discovery);
    assert.equal(spawn.spec.env.DSH_HUD_ELECTRON, ELECTRON);
    assert.equal(spawn.spec.env.DSH_HUD_APP_DIR, APP_DIR);
    assert.equal('ELECTRON_RUN_AS_NODE' in spawn.spec.env, false, 'ELECTRON_RUN_AS_NODE must be removed');
    assert.equal(h.commands.length, 1);
    assert.equal(h.commands[0].name, 'dsh-hud');
  } finally {
    dispose();
    await env.cleanup();
  }
});

test('defaults: no start path runs (HUD comes from login Startup / double-click)', async () => {
  const env = await makeLocalAppData();
  const h = makeContext();
  // Both `spawnApp` and `shellLaunch` are opt-in. A default apply must publish
  // discovery + register the command and then stay out of the launch business:
  // a direct subprocess dies in this host, and Explorer delegation asks Windows
  // for a human approval click.
  const dispose = plugin.apply(h.ctx, { refreshMs: 10_000 });
  try {
    const d = await waitFor(async () => {
      try { return await readJson(env.discovery); } catch { return null; }
    }, { label: 'discovery.json' });
    assert.ok(d.url.includes('?token=T0K'));
    assert.equal(h.commands.length, 1);
    assert.equal(h.commands[0].name, 'dsh-hud');
    await sleep(80);
    assert.equal(h.spawns.length, 0, 'spawnApp defaults to false');
  } finally {
    dispose();
    await env.cleanup();
  }
});

test('spawnApp false opt-out: writes discovery + registers command but never spawns', async () => {
  const env = await makeLocalAppData();
  const h = makeContext();
  const dispose = plugin.apply(h.ctx, { spawnApp: false, refreshMs: 10_000 });
  try {
    const d = await waitFor(async () => {
      try { return await readJson(env.discovery); } catch { return null; }
    }, { label: 'discovery.json' });
    assert.ok(d.url.includes('?token=T0K'));
    assert.equal(h.commands.length, 1);
    assert.equal(h.commands[0].name, 'dsh-hud');
    await sleep(50);
    assert.equal(h.spawns.length, 0, 'spawnApp:false must not spawn');
  } finally {
    dispose();
    await env.cleanup();
  }
});

test('refresh: keeps the token fresh and emits reload + stdin only when the origin changes', async () => {
  const env = await makeLocalAppData();
  const h = makeContext();
  const dispose = plugin.apply(h.ctx, h.config({ spawnApp: false, refreshMs: 40 }));
  try {
    const first = await waitFor(async () => {
      try { return await readJson(env.discovery); } catch { return null; }
    }, { label: 'initial discovery' });
    assert.match(first.url, /token=T0K/);

    h.setOrigin('http://127.0.0.1:51235/', 'T1');
    await waitFor(async () => {
      try { return (await readJson(env.discovery)).url.includes('51235'); } catch { return false; }
    }, { label: 'refreshed discovery' });

    const d = await readJson(env.discovery);
    assert.match(d.url, /token=T1/);
    assert.equal(d.port, '51235');

    const control = await waitFor(async () => {
      try { return await readJson(env.control); } catch { return null; }
    }, { label: 'control.json' });
    assert.equal(control.action, 'reload');
    assert.ok(control.seq >= 1);
    assert.equal(h.spawns.length, 0, 'spawnApp=false must not spawn');
  } finally {
    dispose();
    await env.cleanup();
  }
});

test('command: /dsh-hud toggle|show|hide|reload reuses one child and notifies control+stdin', async () => {
  const env = await makeLocalAppData();
  const h = makeContext();
  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  const dispose = plugin.apply(h.ctx, h.config({ spawnApp: true, refreshMs: 10_000 }));
  try {
    await waitFor(() => h.commands[0], { label: 'command registration' });
    await waitFor(() => h.spawns[0], { label: 'spawn' });
    const handle = h.commands[0];

    const show = handle.handler({ rawInput: 'show' });
    assert.equal(show.kind, 'success');
    assert.match(show.text, /打开/);
    assert.equal(h.spawns.length, 1, 'a command must not spawn a second HUD');

    const hide = handle.handler({ rawInput: 'hide' });
    assert.match(hide.text, /隐藏/);

    const toggle1 = handle.handler({ rawInput: '' });
    assert.match(toggle1.text, /打开/);
    const toggle2 = handle.handler({ rawInput: 'toggle' });
    assert.match(toggle2.text, /隐藏/);

    const reload = handle.handler({ rawInput: 'reload' });
    assert.match(reload.text, /重载/);

    // 扩展点 2（t30）：未知动作不再回退成 toggle，而是原样透传给 control.json，
    // 由 app 侧 registerControlAction 注册的 handler 处理。
    const unknown = handle.handler({ rawInput: 'nonsense' });
    assert.equal(unknown.kind, 'success', 'unknown input is forwarded as a custom action');
    assert.match(unknown.text, /自定义动作/);

    const control = await waitFor(async () => {
      try { return await readJson(env.control); } catch { return null; }
    }, { label: 'control.json' });
    // Concurrent sendControl() calls now each use a unique tmp name (pid+seq),
    // so no write is lost and no rename throws ENOENT (t8 D2). The final file
    // holds the last completed action; exact ordering is covered by stdin below.
    assert.ok(['show', 'hide', 'toggle', 'reload', 'nonsense'].includes(control.action));
    assert.ok(control.seq >= 1);

    // Wait for all async writes to settle, then confirm none failed (D2).
    await sleep(40);
    assert.ok(
      !errors.some((l) => l.includes('control.json write failed')),
      `D2: concurrent control.json writes must not fail, got: ${errors.filter((l) => l.includes('write failed')).join(' | ')}`,
    );

    const lines = h.spawns[0].handle.stdin.written.map((s) => JSON.parse(s.trim()));
    // The HUD's ControlBridge reads `action` (app/src/control.js); `type` was the
    // old t8 field name and is no longer part of the contract.
    assert.deepEqual(lines.map((l) => l.action), ['show', 'hide', 'toggle', 'toggle', 'reload', 'nonsense']);
    assert.ok(lines.every((l) => Number.isInteger(l.seq)));
    void env;
  } finally {
    console.error = original;
    dispose();
    await env.cleanup();
  }
});

test('command: running HUD (fresh pre-existing discovery, no child) replies success', async () => {
  const env = await makeLocalAppData();
  const h = makeContext();
  // Simulate a self-started HUD: discovery.json already on disk, fresh, owned by
  // a live process. spawnApp stays false, so `child` is null, but the plugin
  // must still report the command as sent (t22 #4).
  await fsp.mkdir(path.dirname(env.discovery), { recursive: true });
  await fsp.writeFile(
    env.discovery,
    JSON.stringify({
      pid: process.pid,
      port: '51234',
      url: 'http://127.0.0.1:51234/?token=PREV',
      updatedAt: new Date().toISOString(),
    }),
    'utf8',
  );

  const dispose = plugin.apply(h.ctx, h.config({ spawnApp: false, refreshMs: 10_000 }));
  try {
    await waitFor(async () => {
      try { return (await readJson(env.discovery)).url.includes('T0K'); } catch { return false; }
    }, { label: 'discovery rewritten by apply' });
    const show = h.commands[0].handler({ rawInput: 'show' });
    assert.equal(show.kind, 'success');
    assert.match(show.text, /打开/);
    assert.ok(!show.text.includes('未在运行'), `expected success text, got: ${show.text}`);
    assert.equal(h.spawns.length, 0, 'spawnApp=false must not spawn');
    await sleep(60); // let the control.json write settle before dispose
  } finally {
    dispose();
    await env.cleanup();
  }
});

test('command: absent HUD (no discovery, no child) replies not-running', async () => {
  const env = await makeLocalAppData();
  const h = makeContext();
  const dispose = plugin.apply(h.ctx, h.config({ spawnApp: false, refreshMs: 10_000 }));
  try {
    await waitFor(async () => {
      try { return (await readJson(env.discovery)).url.includes('T0K'); } catch { return false; }
    }, { label: 'discovery written' });
    const show = h.commands[0].handler({ rawInput: 'show' });
    assert.equal(show.kind, 'success');
    assert.ok(show.text.includes('未在运行'), `expected not-running text, got: ${show.text}`);
    await sleep(60); // let the control.json write settle before dispose
  } finally {
    dispose();
    await env.cleanup();
  }
});

test('respawn: linear backoff, then stops at maxRespawns', async () => {
  const env = await makeLocalAppData();
  const h = makeContext();
  const dispose = plugin.apply(h.ctx, h.config({ spawnApp: true, respawnDelayMs: 20, maxRespawns: 2 }));
  try {
    const first = await waitFor(() => h.spawns[0], { label: 'first spawn' });
    first.handle._done.resolve({ code: 1 });
    const second = await waitFor(() => h.spawns[1], { label: 'second spawn' });
    second.handle._done.resolve({ code: 1 });
    const third = await waitFor(() => h.spawns[2], { label: 'third spawn' });
    third.handle._done.resolve({ code: 1 });
    await sleep(160);
    assert.equal(h.spawns.length, 3, 'after 2 respawns the plugin must give up');
  } finally {
    dispose();
    await env.cleanup();
  }
});

test('respawn: exit code 0 is intentional (no respawn)', async () => {
  const env = await makeLocalAppData();
  const h = makeContext();
  const dispose = plugin.apply(h.ctx, h.config({ spawnApp: true, respawnDelayMs: 20, maxRespawns: 3 }));
  try {
    const first = await waitFor(() => h.spawns[0], { label: 'first spawn' });
    first.handle._done.resolve({ code: 0 });
    await sleep(160);
    assert.equal(h.spawns.length, 1, 'exit 0 means single-instance handoff/user quit; do not respawn');
  } finally {
    dispose();
    await env.cleanup();
  }
});

test('dispose: terminates child, unregisters command, removes discovery/control and stops refresh', async () => {
  const env = await makeLocalAppData();
  const h = makeContext();
  const dispose = plugin.apply(h.ctx, h.config({ spawnApp: true, refreshMs: 30 }));
  const spawn = await waitFor(() => h.spawns[0], { label: 'spawn' });
  await waitFor(async () => {
    try { return Boolean(await readJson(env.discovery)); } catch { return false; }
  }, { label: 'discovery' });

  dispose();
  assert.equal(spawn.handle.terminateCalls, 1);
  assert.equal(h.commands[0]._unregistered, true);
  assert.equal(spawn.spec.signal.aborted, true);
  await sleep(80);
  assert.equal(fs.existsSync(env.discovery), false, 'discovery.json must be removed');
  assert.equal(fs.existsSync(env.control), false, 'control.json must be removed');

  // A refresh written after dispose would recreate the file; wait two intervals.
  await sleep(120);
  assert.equal(fs.existsSync(env.discovery), false, 'dispose must stop the refresh interval');
  await env.cleanup();
});

test('degradation: missing subprocess service logs a skip message but apply does not throw', async () => {
  const env = await makeLocalAppData();
  const h = makeContext({ withSubprocess: false });
  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  let dispose;
  try {
    dispose = plugin.apply(h.ctx, h.config({ spawnApp: true }));
    await waitFor(async () => {
      try { return Boolean(await readJson(env.discovery)); } catch { return false; }
    }, { label: 'discovery despite no subprocess' });
    await sleep(30);
    assert.equal(h.spawns.length, 0);
    assert.ok(
      errors.some((l) => l.includes('subprocess service unavailable')),
      `expected subprocess-unavailable skip log, got: ${errors.join(' | ')}`,
    );
    assert.ok(
      !errors.some((l) => l.includes('spawn failed')),
      'a missing subprocess service must not be reported as spawn failed (t8 D5)',
    );
    assert.equal(fs.existsSync(env.discovery), true, 'token bridge must still work');
  } finally {
    if (dispose) dispose();
    console.error = original;
    await env.cleanup();
  }
});

test('startup sweep: deletes stale *.tmp only, never a fresh one, and still writes discovery', async () => {
  const env = await makeLocalAppData();
  const h = makeContext();
  const dir = path.dirname(env.discovery);
  await fsp.mkdir(dir, { recursive: true });
  const freshTmp = path.join(dir, 'control.json.9999.1.tmp');
  const staleTmp = path.join(dir, 'discovery.json.crashed.tmp');
  await fsp.writeFile(freshTmp, '{"seq":1}', 'utf8');
  await fsp.writeFile(staleTmp, '{"seq":2}', 'utf8');
  const old = new Date(Date.now() - 120_000);
  await fsp.utimes(staleTmp, old, old);

  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };

  const dispose = plugin.apply(h.ctx, h.config({ spawnApp: false, refreshMs: 10_000 }));
  try {
    await waitFor(async () => {
      try { return (await readJson(env.discovery)).url.includes('T0K'); } catch { return false; }
    }, { label: 'discovery written after sweep' });
    assert.equal(
      errors.filter((l) => l.includes('discovery write failed')).length, 0,
      `cleanup must not race the first discovery write (t16 B1): ${errors.join(' | ')}`,
    );
    assert.ok(await fsp.stat(freshTmp).then(() => true, () => false), 'fresh tmp must survive the sweep (t16 B1)');
    assert.equal(await fsp.stat(staleTmp).then(() => true, () => false), false, 'stale tmp must be removed');
  } finally {
    console.error = original;
    dispose();
    await env.cleanup();
  }
});

test('re-apply: fresh pre-existing discovery (live pid) skips duplicate spawn', async () => {
  const env = await makeLocalAppData();
  const h = makeContext();
  // Simulate a previous apply: discovery.json already on disk, fresh, owned by
  // a live process (the test process itself). The plugin must treat the HUD as
  // already running and skip spawning a duplicate (t15 #21 spawn storm).
  await fsp.mkdir(path.dirname(env.discovery), { recursive: true });
  await fsp.writeFile(
    env.discovery,
    JSON.stringify({
      pid: process.pid,
      port: '51234',
      url: 'http://127.0.0.1:51234/?token=PREV',
      updatedAt: new Date().toISOString(),
    }),
    'utf8',
  );

  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };

  const dispose = plugin.apply(h.ctx, h.config({ spawnApp: true, refreshMs: 10_000 }));
  try {
    await waitFor(async () => {
      try { return (await readJson(env.discovery)).url.includes('T0K'); } catch { return false; }
    }, { label: 'discovery rewritten by apply' });
    await sleep(50);
    assert.equal(h.spawns.length, 0, 'fresh pre-existing discovery must suppress duplicate spawn (t15 #21)');
    assert.ok(
      errors.some((l) => l.includes('HUD likely already running')),
      `expected skip log, got: ${errors.join(' | ')}`,
    );
  } finally {
    console.error = original;
    dispose();
    await env.cleanup();
  }
});

test('t36: resolveHud finds a packaged exe via hudDir (apply logs "found HUD")', async () => {
  const env = await makeLocalAppData();
  const hudDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-hud-exe-'));
  const exe = path.join(hudDir, 'DSH HUD.exe');
  await fsp.writeFile(exe, 'fake-exe', 'utf8');

  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };

  let dispose;
  try {
    const res = plugin.resolveHud({ hudDir });
    assert.equal(res.found, true);
    assert.equal(res.mode, 'exe');
    assert.equal(res.exe, exe);

    // Through apply: an explicit hudDir is picked up and reported as found.
    const h = makeContext();
    dispose = plugin.apply(h.ctx, { hudDir, refreshMs: 10_000 });
    await waitFor(async () => {
      try { return (await readJson(env.discovery)).url.includes('T0K'); } catch { return false; }
    }, { label: 'discovery written' });
    assert.ok(
      errors.some((l) => l.includes('found HUD') && l.includes(exe)),
      `expected found-HUD log, got: ${errors.join(' | ')}`,
    );
  } finally {
    console.error = original;
    if (dispose) dispose();
    await fsp.rm(hudDir, { recursive: true, force: true });
    await env.cleanup();
  }
});

test('t36: missing HUD degrades to a readable hint; apply and command do not throw', async () => {
  const env = await makeLocalAppData();
  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-hud-empty-'));

  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };

  let dispose;
  try {
    // Pure resolver: every probe misses → found:false + a readable reason.
    const res = plugin.resolveHud({
      localAppData: empty,
      repoRoot: empty,
      devElectron: path.join(empty, 'no-electron.exe'),
      devAppDir: path.join(empty, 'no-app'),
    });
    assert.equal(res.found, false);
    assert.match(res.reason, /未找到 HUD/);

    // apply with an explicit-but-empty hudDir must not throw, logs the hint,
    // and /dsh-hud returns a readable reason.
    const h = makeContext();
    dispose = plugin.apply(h.ctx, { hudDir: empty, refreshMs: 10_000 });
    await waitFor(async () => {
      try { return (await readJson(env.discovery)).url.includes('T0K'); } catch { return false; }
    }, { label: 'discovery written' });
    assert.ok(
      errors.some((l) => l.includes('未找到 HUD')),
      `expected missing-HUD log, got: ${errors.join(' | ')}`,
    );
    const show = h.commands[0].handler({ rawInput: 'show' });
    assert.equal(show.kind, 'success');
    assert.ok(show.text.includes('未找到 HUD'), `expected not-found reason, got: ${show.text}`);
  } finally {
    console.error = original;
    if (dispose) dispose();
    await fsp.rm(empty, { recursive: true, force: true });
    await env.cleanup();
  }
});
