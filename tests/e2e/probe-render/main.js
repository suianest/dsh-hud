'use strict';

// ---------------------------------------------------------------------------
// probe-render — minimal Electron capability probe for the acceptance harness.
//
// Purpose: determine whether an Electron renderer can run inside the current
// DSH agent session. It creates a 520x720 frameless transparent window, loads
// a trivial local HTML file, captures a PNG and reads app.getAppMetrics().
//
// It writes machine-readable evidence into --out (default: ../../artifacts/e2e):
//   probe-render.trace.log   phase-by-phase trace
//   probe-render.png         screenshot when capture succeeded
//   probe-render.json        window size / metrics / result
//
// Run from a normal terminal (outside the DSH sandbox):
//   ELECTRON_RUN_AS_NODE= (clear) ; electron.exe --no-sandbox tests/e2e/probe-render
// or use tests/e2e/run-e2e.cmd.
// ---------------------------------------------------------------------------

const { app, BrowserWindow, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : path.join(__dirname, '..', '..', 'artifacts', 'e2e');
fs.mkdirSync(OUT, { recursive: true });
const tracePath = path.join(OUT, 'probe-render.trace.log');
const resultPath = path.join(OUT, 'probe-render.json');

const report = {
  startedAt: new Date().toISOString(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  argv: process.argv.slice(1),
  runAsNode: process.env.ELECTRON_RUN_AS_NODE || '',
  phases: {},
  displays: [],
  metrics: [],
  screenshots: [],
  exitCode: null,
};

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  fs.appendFileSync(tracePath, line);
  process.stdout.write(line);
}

function saveReport() {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(resultPath, JSON.stringify(report, null, 2), 'utf8');
}

process.on('uncaughtException', (err) => {
  report.phases.fatal = { error: String(err && err.stack || err) };
  log(`FATAL uncaughtException ${err && err.stack}`);
  saveReport();
  app.exit(91);
});

app.whenReady().then(async () => {
  try {
    report.phases.ready = true;
    log(`app:ready electron=${process.versions.electron} chrome=${process.versions.chrome}`);
    report.displays = screen.getAllDisplays().map((d) => ({
      id: d.id,
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
      primary: d.id === screen.getPrimaryDisplay().id,
    }));
    log(`displays=${JSON.stringify(report.displays)}`);

    const win = new BrowserWindow({
      width: 520,
      height: 720,
      useContentSize: true,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
      },
    });
    report.phases.windowCreated = true;
    log(`window:created size=${JSON.stringify(win.getSize())} content=${JSON.stringify(win.getContentSize())}`);

    try {
      await win.loadFile(path.join(__dirname, 'index.html'));
      report.phases.loadFile = 'done';
      log('loadFile:done');
    } catch (err) {
      report.phases.loadFile = `error: ${err && err.message}`;
      log(`loadFile:error ${err && err.message}`);
    }

    try {
      const img = await win.webContents.capturePage();
      const png = img.toPNG();
      fs.writeFileSync(path.join(OUT, 'probe-render.png'), png);
      const size = img.getSize();
      report.screenshots.push({ file: 'probe-render.png', bytes: png.length, size });
      report.phases.capture = 'done';
      log(`capture:done size=${JSON.stringify(size)} bytes=${png.length}`);
    } catch (err) {
      report.phases.capture = `error: ${err && err.message}`;
      log(`capture:error ${err && err.message}`);
    }

    report.metrics = app.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      name: m.name,
      workingSetSizeKB: m.memory ? m.memory.workingSetSize : null,
      peakWorkingSetSizeKB: m.memory ? m.memory.peakWorkingSetSize : null,
      cpuPercent: m.cpu ? m.cpu.percentCPUUsage : null,
    }));
    log(`metrics=${JSON.stringify(report.metrics)}`);

    report.exitCode = report.phases.capture === 'done' ? 0 : 4;
    saveReport();
    log(`done exit=${report.exitCode}`);
    app.exit(report.exitCode);
  } catch (err) {
    report.phases.fatal = { error: String(err && err.stack || err) };
    log(`FATAL ${err && err.stack}`);
    saveReport();
    app.exit(91);
  }
});

setTimeout(() => {
  report.phases.watchdogTimeout = true;
  log('watchdog:timeout (15s)');
  saveReport();
  app.exit(5);
}, 15000);
