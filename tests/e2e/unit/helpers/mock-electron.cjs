'use strict';

// ---------------------------------------------------------------------------
// Minimal Electron mock used by the headless acceptance tests.
//
// The DSH agent sandbox cannot start Chromium (named-pipe EACCES, see
// README-ENV.md 搂0), so the production modules under app/src are exercised in
// plain Node against this mock. It records the calls that matter for the
// window state machine (sizes, positions, show/hide order, IPC payloads, web
// loads) so tests can assert on the exact production behavior.
// ---------------------------------------------------------------------------

const { EventEmitter } = require('events');
const path = require('path');
const os = require('os');
const fs = require('fs');

function rectContains(r, x, y) {
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

function distanceToRect(r, x, y) {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.width));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.height));
  return dx * dx + dy * dy;
}

function makeDisplay({ id, x, y, width, height, workArea, scaleFactor }) {
  return {
    id,
    bounds: { x, y, width, height },
    workArea: workArea || { x, y, width, height },
    scaleFactor,
  };
}

// Two displays: primary 1920x1080 @100%, secondary 1280x720 @150% (DIP).
// Work areas leave room for taskbars (40 DIP primary, 40 DIP secondary).
function defaultDisplays() {
  return [
    makeDisplay({ id: 1, x: 0, y: 0, width: 1920, height: 1080, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }),
    makeDisplay({ id: 2, x: 1920, y: 0, width: 1280, height: 720, workArea: { x: 1920, y: 0, width: 1280, height: 680 }, scaleFactor: 1.5 }),
  ];
}

class MockWebContents extends EventEmitter {
  constructor(kind) {
    super();
    this.kind = kind;
    this.sent = [];
    this.loaded = [];
    this.css = [];
    this.focused = 0;
    this.devtools = 0;
  }

  send(channel, payload) {
    this.sent.push({ channel, payload });
  }

  loadURL(url) {
    this.loaded.push({ type: 'url', url });
    return Promise.resolve();
  }

  loadFile(file, opts) {
    this.loaded.push({ type: 'file', file, opts });
    return Promise.resolve();
  }

  insertCSS(css) {
    this.css.push(css);
    return Promise.resolve('css-key');
  }

  focus() {
    this.focused += 1;
  }

  openDevTools() {
    this.devtools += 1;
  }

  setWindowOpenHandler() {}
}

class MockBrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.contentSize = { width: options.width, height: options.height };
    this.position = { x: 100, y: 100 };
    this.visible = false;
    this.destroyed = false;
    this.focusCalls = 0;
    this.hideCalls = 0;
    this.showCalls = 0;
    this.showInactiveCalls = 0;
    this.alwaysOnTop = null;
    this.skipTaskbar = null;
    this.loadedFile = null;
    this.contentView = {
      children: [],
      addChildView: (view) => {
        if (!this.contentView.children.includes(view)) this.contentView.children.push(view);
      },
      removeChildView: (view) => {
        this.contentView.children = this.contentView.children.filter((v) => v !== view);
      },
    };
    this.webContents = new MockWebContents('shell');
  }

  loadFile(file) {
    this.loadedFile = file;
    return this.webContents.loadFile(file);
  }

  setContentSize(width, height) {
    this.contentSize = { width: Math.round(width), height: Math.round(height) };
  }

  getContentSize() {
    return [this.contentSize.width, this.contentSize.height];
  }

  setPosition(x, y) {
    this.position = { x: Math.round(x), y: Math.round(y) };
  }

  // Added for t11/t12: the product now moves+resizes atomically to stop the
  // frameless window from creeping +2 px per drag frame.
  setBounds(b) {
    if (typeof b.x === 'number') this.position = { x: Math.round(b.x), y: Math.round(b.y) };
    if (typeof b.width === 'number') {
      this.contentSize = { width: Math.round(b.width), height: Math.round(b.height) };
    }
  }

  getPosition() {
    return [this.position.x, this.position.y];
  }

  getBounds() {
    return { x: this.position.x, y: this.position.y, width: this.contentSize.width, height: this.contentSize.height };
  }

  show() {
    this.visible = true;
    this.showCalls += 1;
  }

  hide() {
    this.visible = false;
    this.hideCalls += 1;
  }

  showInactive() {
    this.visible = true;
    this.showInactiveCalls += 1;
  }

  focus() {
    this.focusCalls += 1;
  }

  isVisible() {
    return this.visible;
  }

  isDestroyed() {
    return this.destroyed;
  }

  setAlwaysOnTop(flag, level) {
    this.alwaysOnTop = { flag, level };
  }

  setSkipTaskbar(v) {
    this.skipTaskbar = v;
  }

  setResizable(v) {
    this.resizable = v;
  }

  setBackgroundColor(c) {
    this.backgroundColor = c;
  }

  capturePage() {
    return Promise.resolve({ toPNG: () => Buffer.alloc(0) });
  }
}

class MockWebContentsView {
  constructor(opts) {
    this.options = opts;
    this.bounds = null;
    this.webContents = new MockWebContents('web');
  }

  setBackgroundColor(c) {
    this.backgroundColor = c;
  }

  setBounds(b) {
    this.bounds = { ...b };
  }
}

function createMockElectron(overrides = {}) {
  const userData = overrides.userData || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hud-mock-'));
  const displays = overrides.displays || defaultDisplays();

  const app = new EventEmitter();
  app.getPath = (name) => (name === 'userData' ? userData : path.join(userData, name));
  app.setPath = (name, p) => {
    if (name === 'userData') state.userData = p;
  };
  app.getAppMetrics = () => overrides.appMetrics || [];
  app.getLoginItemSettings = () => ({ openAtLogin: !!state.loginItem });
  app.setLoginItemSettings = (opts) => {
    state.loginItem = !!opts.openAtLogin;
    state.lastLoginItem = opts;
  };
  app.requestSingleInstanceLock = () => (overrides.singleInstance === false ? false : true);
  app.quit = () => {
    state.quitCalls += 1;
    app.emit('will-quit');
  };
  app.whenReady = () => Promise.resolve();
  app.getVersion = () => '0.0.0-test';
  // t26: HudWindow derives its repo root from app.getAppPath(); the real app
  // has it, the mock did not. A temp dir keeps the portable-config probe stable.
  app.getAppPath = () => path.join(os.tmpdir(), 'dsh-hud-mock-app');
  // main.js applies --no-sandbox on hardened Windows installs before any window
  // exists; the mock needs the same surface so boot tests can run.
  app.commandLine = {
    hasSwitch: () => false,
    appendSwitch: () => {},
    removeSwitch: () => {},
  };

  const screen = new EventEmitter();
  screen.getPrimaryDisplay = () => displays[0];
  screen.getAllDisplays = () => displays;
  screen.getDisplayNearestPoint = ({ x, y }) => {
    for (const d of displays) if (rectContains(d.workArea, x, y)) return d;
    let best = displays[0];
    let bestD = Infinity;
    for (const d of displays) {
      const dist = distanceToRect(d.workArea, x, y);
      if (dist < bestD) {
        bestD = dist;
        best = d;
      }
    }
    return best;
  };

  // Cursor position in virtual-desktop DIP. HudWindow derives the drag target
  // from it (t14 #12); tests set it before emitting hud:drag-move / drag-end.
  let cursorPoint = { x: 0, y: 0 };
  screen.getCursorScreenPoint = () => ({ ...cursorPoint });
  screen.setCursorScreenPoint = (p) => { cursorPoint = p; };

  const shortcuts = new Map();
  const globalShortcut = {
    register(accel, cb) {
      if (overrides.failAccelerators && overrides.failAccelerators.includes(accel)) return false;
      shortcuts.set(accel, cb);
      return true;
    },
    unregister(accel) {
      shortcuts.delete(accel);
    },
    unregisterAll() {
      shortcuts.clear();
    },
    isRegistered(accel) {
      return shortcuts.has(accel);
    },
    _trigger(accel) {
      const cb = shortcuts.get(accel);
      if (cb) cb();
      return !!cb;
    },
  };

  const sessionHandlers = [];
  const ses = {
    webRequest: {
      onCompleted(cb) {
        sessionHandlers.push(cb);
      },
    },
  };
  const session = { fromPartition: () => ses };

  const ipcMain = new EventEmitter();
  const menu = { buildFromTemplate: (tpl) => ({ template: tpl, popup() {} }) };
  const openedExternally = [];
  const clipboardText = [];
  const shellMock = {
    openExternal: (url) => {
      openedExternally.push(url);
      return Promise.resolve();
    },
  };
  const clipboardMock = { writeText: (t) => { clipboardText.push(t); } };

  const state = {
    userData,
    displays,
    loginItem: false,
    lastLoginItem: null,
    quitCalls: 0,
    windows: [],
  };

  class BrowserWindow extends MockBrowserWindow {
    constructor(options) {
      super(options);
      state.windows.push(this);
    }
  }

  class WebContentsView extends MockWebContentsView {}

  const mock = {
    app,
    BrowserWindow,
    WebContentsView,
    ipcMain,
    screen,
    globalShortcut,
    session,
    Menu: menu,
    shell: shellMock,
    clipboard: clipboardMock,
    _openedExternally: openedExternally,
    _clipboardText: clipboardText,
    nativeImage: {
      createFromBitmap: () => ({ toPNG: () => Buffer.alloc(0) }),
    },
    _state: state,
    _shortcuts: shortcuts,
    _sessionHandlers: sessionHandlers,
  };
  return mock;
}

// Install a mutable electron mock resolver. Call once per test process; swap
// the active mock with loadFresh(mock).
let activeMock = null;
let originalLoad = null;

function installElectronMock() {
  if (originalLoad) return;
  const Module = require('module');
  originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return activeMock;
    return originalLoad.apply(this, arguments);
  };
}

function purgeAppModules() {
  const appRoot = path.resolve(__dirname, '..', '..', '..', '..', 'app');
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(appRoot)) delete require.cache[key];
  }
}

function loadFresh(mock, relPath) {
  activeMock = mock;
  purgeAppModules();
  return require(path.resolve(__dirname, '..', '..', '..', '..', 'app', relPath));
}

function setEnv(env) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeDiscovery(file, d) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(d, null, 2), 'utf8');
}

module.exports = {
  createMockElectron,
  installElectronMock,
  loadFresh,
  setEnv,
  delay,
  writeDiscovery,
  defaultDisplays,
  makeDisplay,
};

