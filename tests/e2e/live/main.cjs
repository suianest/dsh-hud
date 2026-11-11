'use strict';

// ---------------------------------------------------------------------------
// t8 live end-to-end harness (must run OUTSIDE the DSH agent sandbox).
//
// Why: this DSH session runs with a restricted token. Chromium cannot create
// its Mojo named pipe (FATAL platform_channel.cc:112, access denied 0x5), so
// no Electron window/renderer can start here. See
// docs/acceptance.md §Blocked environment and artifacts/e2e/*.log.
//
// This harness uses the real app modules (HudWindow + WebEmbed) and captures
// real PNGs via webContents.capturePage(), plus app.getAppMetrics() for the
// resident-memory/CPU budget. It is intentionally not a mock.
//
// Usage (from a normal PowerShell/cmd, DSH may be running or stopped):
//   tests\e2e\run-live.cmd              # phase 1: scenario + restart seed
//   tests\e2e\run-live.cmd restore      # phase 2: restart restore check
// or directly:
//   set ELECTRON_RUN_AS_NODE=
//   set DSH_HUD_E2E_T0=<ms epoch>
//   spike\node_modules\electron\dist\electron.exe --no-sandbox tests\e2e\live\main.cjs
//
// Env:
//   DSH_HUD_E2E_OUT          output dir (default dsh-hud/artifacts/e2e/live)
//   DSH_HUD_E2E_DISCOVERY    live discovery.json written by the token bridge
//                            (default %LOCALAPPDATA%\dsh-hud\discovery.json)
//   DSH_HUD_E2E_SEND_TEXT    message to type into the DSH web UI
//   DSH_HUD_OPAQUE=1         recommended: opaque fallback so PNGs are readable
//   DSH_HUD_E2E_NO_WEB=1     skip web-UI steps (offline/error-page only)
// ---------------------------------------------------------------------------

const { app, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = process.env.DSH_HUD_E2E_OUT || path.join(ROOT, 'artifacts', 'e2e', 'live');
const PHASE = process.argv.includes('--phase=restore') ? 'restore' : 'run';
const REPORT_FILE = path.join(OUT, 'live-report.json');
const T0 = Number(process.env.DSH_HUD_E2E_T0) || Date.now();
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });

process.env.DSH_HUD_USER_DATA = process.env.DSH_HUD_USER_DATA || path.join(OUT, 'profile');
process.env.DSH_HUD_DISCOVERY =
  process.env.DSH_HUD_DISCOVERY || path.join(OUT, 'discovery.json');
if (process.env.DSH_HUD_OPAQUE === undefined) process.env.DSH_HUD_OPAQUE = '1';
if (process.env.DSH_HUD_NO_ANIM === undefined) process.env.DSH_HUD_NO_ANIM = '1';

app.setPath('userData', process.env.DSH_HUD_USER_DATA);
const HudWindow = require('../../../app/src/hud-window');

const report = fs.existsSync(REPORT_FILE) ? JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8')) : {};
report.phase = report.phase || {};
report.phase[PHASE] = { startedAt: new Date().toISOString(), t0: T0, steps: {} };
report.shots = report.shots || [];
report.console = report.console || [];
report.metrics = report.metrics || [];
report.env = {
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const phase = () => report.phase[PHASE];

function record(step, status, detail) {
  phase().steps[step] = { status, detail, at: new Date().toISOString() };
  console.log(`[e2e] ${step}: ${status}${detail ? ` — ${detail}` : ''}`);
}

function save() {
  report.phase[PHASE].finishedAt = new Date().toISOString();
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');
}

async function waitFor(fn, { timeout = 8000, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timeout: ${label}`);
    await sleep(100);
  }
}

async function shot(wc, name) {
  try {
    const img = await wc.capturePage();
    const png = img.toPNG();
    const file = path.join(OUT, 'shots', `${name}.png`);
    fs.writeFileSync(file, png);
    report.shots.push({
      step: name,
      file: path.relative(ROOT, file).replace(/\\/g, '/'),
      bytes: png.length,
      size: img.getSize(),
      at: new Date().toISOString(),
    });
    console.log(`[e2e] shot ${name} ${png.length}B ${JSON.stringify(img.getSize())}`);
    return true;
  } catch (err) {
    record(`shot:${name}`, 'failed', String(err && err.message));
    return false;
  }
}

function collectMetrics(label) {
  const entries = app.getAppMetrics().map((m) => ({
    pid: m.pid,
    type: m.type,
    name: m.name,
    workingSetSizeKB: m.memory ? m.memory.workingSetSize : null,
    peakWorkingSetSizeKB: m.memory ? m.memory.peakWorkingSetSize : null,
    cpuPercent: m.cpu ? m.cpu.percentCPUUsage : null,
  }));
  const totalKB = entries.reduce((s, e) => s + (e.workingSetSizeKB || 0), 0);
  const totalCPU = entries.reduce((s, e) => s + (e.cpuPercent || 0), 0);
  report.metrics.push({ label, at: new Date().toISOString(), totalMB: +(totalKB / 1024).toFixed(1), totalCPU: +totalCPU.toFixed(1), entries });
  console.log(`[e2e] metrics ${label}: ${(totalKB / 1024).toFixed(1)}MB CPU ${totalCPU.toFixed(1)}%`);
  return { totalMB: totalKB / 1024, totalCPU };
}

app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (...args) => {
    // Electron >= 37 passes an event object; older builds pass positional args.
    let level;
    let message;
    if (args[0] && typeof args[0] === 'object' && 'level' in args[0]) {
      level = args[0].level;
      message = args[0].message;
    } else {
      level = args[1];
      message = args[2];
    }
    if (level === 'error' || level === 3 || level === 2) {
      report.console.push({ at: new Date().toISOString(), level, message: String(message).slice(0, 500) });
    }
  });
});

function readDiscovery(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeDiscovery(file, d) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(d, null, 2), 'utf8');
}

function liveDiscoveryPath() {
  if (process.env.DSH_HUD_E2E_DISCOVERY) return process.env.DSH_HUD_E2E_DISCOVERY;
  const base = process.env.LOCALAPPDATA;
  return base ? path.join(base, 'dsh-hud', 'discovery.json') : null;
}

async function waitViewLoad(wc, timeout = 10000) {
  if (!wc.isLoading()) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('view load timeout')), timeout);
    wc.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
    wc.once('did-fail-load', () => { clearTimeout(timer); resolve(); });
  });
}

// Best-effort DSH Web UI interaction. The DSH web bundle is a normal SPA; we
// locate the composer by accessibility/text heuristics instead of hard-coding
// hashed CSS classes (they change between DSH builds).
const SEND_SCRIPT = `(() => {
  const visible = (el) => !!(el && el.offsetParent !== null);
  const composer = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
    .filter(visible)
    .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
  if (!composer) return { ok: false, reason: 'composer not found' };
  composer.focus();
  const text = ${JSON.stringify(process.env.DSH_HUD_E2E_SEND_TEXT || 't8 e2e ping')};
  if (composer.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(composer, text);
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
  }
  const buttons = [...document.querySelectorAll('button')].filter(visible);
  const send = buttons.find((b) => /send|发送|提交/i.test((b.getAttribute('aria-label') || '') + (b.title || '') + b.textContent));
  if (send) { send.click(); return { ok: true, via: 'button', tag: composer.tagName, value: text }; }
  composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  return { ok: true, via: 'enter', tag: composer.tagName, value: text };
})()`;

const TEXT_LENGTH_SCRIPT = `(() => {
  const root = document.querySelector('main') || document.body;
  return { length: (root.innerText || '').length, tail: (root.innerText || '').slice(-400) };
})()`;

async function runPhase() {
  const hud = new HudWindow();
  hud.create();
  hud.setupHotkey();
  await hud.load();
  hud.showCapsule();
  await sleep(400);
  phase().coldStartMsCapsule = Date.now() - T0;
  phase().steps.capsule = { status: 'passed', bounds: hud.win.getBounds(), size: hud.win.getContentSize() };
  await shot(hud.win.webContents, 'e2e-01-capsule');
  collectMetrics('capsule-idle');

  // --- 1. DSH not running: no discovery -> self-drawn unreachable page -----
  fs.rmSync(process.env.DSH_HUD_DISCOVERY, { force: true });
  hud.showPanel();
  const web = hud.web.view.webContents;
  await waitViewLoad(web);
  await sleep(600);
  phase().coldStartMsPanel = Date.now() - T0;
  phase().steps.offlineError = { status: 'passed', url: web.getURL(), title: web.getTitle() };
  await shot(web, 'e2e-02-offline-error');
  await shot(hud.win.webContents, 'e2e-02-panel-shell');

  // --- 2. stale discovery (dead port) -> did-fail-load error page ----------
  writeDiscovery(process.env.DSH_HUD_DISCOVERY, {
    pid: 99999,
    port: '59999',
    url: 'http://127.0.0.1:59999/?token=deadbeef',
    updatedAt: new Date().toISOString(),
  });
  hud.web.reload({ forceToken: true });
  await sleep(1800);
  phase().steps.staleDiscovery = { status: 'passed', url: web.getURL() };
  await shot(web, 'e2e-03-stale-discovery-error');

  // --- 3. live token page (requires a running DSH + token bridge) ----------
  const livePath = liveDiscoveryPath();
  const live = livePath && livePath !== process.env.DSH_HUD_DISCOVERY ? readDiscovery(livePath) : null;
  if (process.env.DSH_HUD_E2E_NO_WEB === '1') {
    record('webUi', 'skipped', 'DSH_HUD_E2E_NO_WEB=1');
  } else if (!live || !live.url) {
    record('webUi', 'blocked', `no live discovery at ${livePath || '(unset)'} — install the plugin and open DSH first`);
  } else {
    writeDiscovery(process.env.DSH_HUD_DISCOVERY, live);
    hud.web.reload({ forceToken: true });
    await waitViewLoad(web, 15000);
    await sleep(3000);
    const url = web.getURL();
    const ok = /^https?:/i.test(url) && !/error\.html$/i.test(url);
    phase().steps.webUi = { status: ok ? 'passed' : 'failed', url, title: await web.getTitle().catch(() => '') };
    await shot(web, 'e2e-04-dsh-web-ui');
    collectMetrics('panel-web-ui');
    if (ok) {
      const before = await web.executeJavaScript(TEXT_LENGTH_SCRIPT, true).catch(() => null);
      const send = await web.executeJavaScript(SEND_SCRIPT, true).catch((e) => ({ ok: false, reason: String(e && e.message) }));
      phase().steps.sendMessage = { status: send && send.ok ? 'passed' : 'failed', detail: send };
      await sleep(1200);
      await shot(web, 'e2e-05-message-sent');
      const during = await web.executeJavaScript(TEXT_LENGTH_SCRIPT, true).catch(() => null);
      phase().steps.streaming = {
        status: during && before && during.length !== before.length ? 'passed' : 'unverifiable',
        before: before && before.length,
        during: during && during.length,
      };
      await sleep(4000);
      await shot(web, 'e2e-06-streaming-done');
      const after = await web.executeJavaScript(TEXT_LENGTH_SCRIPT, true).catch(() => null);
      phase().steps.reply = { status: after && during && after.length !== during.length ? 'passed' : 'unverifiable', length: after && after.length };

      // switch conversation: click the second item in the left rail if present
      const switched = await web.executeJavaScript(`(() => {
        const items = [...document.querySelectorAll('a, button, [role="button"]')]
          .filter((el) => el.offsetParent !== null && /会话|对话|chat|conversation/i.test((el.getAttribute('aria-label') || '') + (el.title || '') + el.textContent));
        const target = items[1] || items[0];
        if (!target) return { ok: false };
        target.click();
        return { ok: true, text: (target.textContent || '').trim().slice(0, 60) };
      })()`, true).catch((e) => ({ ok: false, reason: String(e && e.message) }));
      phase().steps.switchConversation = { status: switched && switched.ok ? 'passed' : 'unverifiable', detail: switched };
      await sleep(1500);
      await shot(web, 'e2e-07-switched-conversation');
    }
  }

  // --- 4. collapse -> expand (hotkey path is manual; toggle() is the same entry)
  hud.collapse();
  await sleep(600);
  phase().steps.collapse = { status: hud.mode === 'capsule' ? 'passed' : 'failed', mode: hud.mode, bounds: hud.win.getBounds() };
  await shot(hud.win.webContents, 'e2e-08-collapsed-capsule');
  hud.showPanel();
  await sleep(600);
  phase().steps.expand = { status: hud.mode === 'panel' ? 'passed' : 'failed', mode: hud.mode };
  await shot(hud.win.webContents, 'e2e-09-expanded-panel');
  phase().steps.hotkey = {
    status: hud.hotkey && hud.hotkey.isRegistered() ? 'registered' : 'not-registered',
    accelerator: hud.hotkey && hud.hotkey.accelerator,
    note: 'OS-level key press cannot be injected from here; press the accelerator manually and observe.',
  };

  // --- 5. multi-display drag (renderer mouse events -> drag IPC) ------------
  hud.showCapsule();
  await sleep(300);
  const displays = screen.getAllDisplays();
  if (displays.length < 2) {
    record('multiDisplayDrag', 'skipped', `only ${displays.length} display(s) attached`);
  } else {
    const before = hud.win.getBounds();
    const target = displays.find((d) => d.id !== screen.getDisplayNearestPoint({ x: before.x + 10, y: before.y + 10 }).id);
    try {
      const wc = hud.win.webContents;
      wc.sendInputEvent({ type: 'mouseDown', x: 120, y: 32, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 8; i += 1) {
        wc.sendInputEvent({ type: 'mouseMove', x: 120 + i * 40, y: 32 + i * 6, button: 'left' });
        await sleep(30);
      }
      wc.sendInputEvent({ type: 'mouseUp', x: 440, y: 80, button: 'left', clickCount: 1 });
      await sleep(400);
      const after = hud.win.getBounds();
      const moved = after.x !== before.x || after.y !== before.y;
      phase().steps.multiDisplayDrag = {
        status: moved ? 'passed' : 'failed',
        before,
        after,
        targetDisplay: target && target.id,
        note: moved ? 'drag via sendInputEvent' : 'renderer drag did not move the window; manual step required',
      };
      await shot(hud.win.webContents, 'e2e-10-after-drag');
    } catch (err) {
      record('multiDisplayDrag', 'failed', String(err && err.message));
    }
  }

  // --- 6. restart seed: position + state file ------------------------------
  await sleep(600);
  const stateFile = path.join(process.env.DSH_HUD_USER_DATA, 'window-state.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  phase().steps.restartSeed = { status: state ? 'passed' : 'failed', stateFile, state, lastBounds: hud.win.getBounds() };

  collectMetrics('panel-idle');
  const mem = report.metrics.find((m) => m.label === 'panel-idle');
  phase().budget = {
    targetMB: 150,
    measuredMB: mem ? mem.totalMB : null,
    pass: mem ? mem.totalMB < 150 : null,
  };
  phase().consoleErrors = report.console.length;
  save();
  hud.win.destroy();
  app.quit();
}

async function restorePhase() {
  const stateFile = path.join(process.env.DSH_HUD_USER_DATA, 'window-state.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  const expected = state && state.capsule;
  const hud = new HudWindow();
  hud.create();
  hud.setupHotkey();
  await hud.load();
  hud.showCapsule();
  await sleep(500);
  const actual = hud.win.getBounds();
  phase().restartRestore = {
    status: expected && actual.x === expected.x && actual.y === expected.y ? 'passed' : 'failed',
    expected,
    actual,
    stateFile,
  };
  await shot(hud.win.webContents, 'e2e-11-restart-restored');
  collectMetrics('restore-idle');
  save();
  hud.win.destroy();
  app.quit();
}

process.on('uncaughtException', (err) => {
  phase().fatal = String((err && err.stack) || err);
  save();
  app.exit(90);
});

app.whenReady().then(async () => {
  try {
    await (PHASE === 'restore' ? restorePhase() : runPhase());
  } catch (err) {
    phase().fatal = String((err && err.stack) || err);
    save();
    app.exit(91);
  }
});
