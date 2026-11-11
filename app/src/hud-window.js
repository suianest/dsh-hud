'use strict';

// ---------------------------------------------------------------------------
// HudWindow — owns the single frameless transparent window and its two-mode
// state machine (capsule <-> panel).
//
// Modes:
//   capsule  resident small pill, always-on-top, skipTaskbar, persists forever
//   panel    expanded 520x720 panel, transient; collapses on Esc / blur / hotkey
//
// The window is a single BrowserWindow that is programmatically resized with
// setContentSize() between the two sizes. Transparent windows cannot be
// user-resized (resizable:false) but CAN be resized programmatically.
//
// t5 additions over the skeleton:
//   - global hotkey toggle (src/hotkeys.js)
//   - focus policy: expand focuses the panel input; collapse returns focus to
//     the previously-focused OS window (hide() + showInactive())
//   - capsule edge snapping on drag release
//   - expand/collapse CSS animation (renderer-driven, with a main-side fallback)
//
// t6 additions:
//   - embeds the DSH Web UI via a WebContentsView (src/web-embed.js) over the
//     shell's #web-host region; detached in capsule mode, re-attached in panel
// ---------------------------------------------------------------------------

const { app, BrowserWindow, ipcMain, nativeTheme, screen, Menu, shell, clipboard } = require('electron');
const { execFileSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const {
  PANEL,
  PANEL_WIDE,
  CAPSULE,
  SHELL_INSET,
  CLAMP_MARGIN,
  EDGE_SNAP_DISTANCE,
  COLLAPSE_FORCE_TIMEOUT_MS,
} = require('./constants');
const { load: loadState, save: saveState } = require('./window-state');
const { createHotkeyController } = require('./hotkeys');
const WebEmbed = require('./web-embed');
const autostart = require('./autostart');
const { loadConfig } = require('./config');
const { menuItems: extensionMenuItems } = require('./extensions');

// Where the capsule's「Token 补充」sends the user (DeepSeek usage/top-up page).
const TOKEN_TOPUP_URL = 'https://platform.deepseek.com/usage';

// Opt-in geometry/focus diagnostics (DSH_HUD_DIAG_LOG=<file>). Every relevant
// window event appends one line, which is how we chase "the window grew by
// itself" / "the panel collapsed on blur" without attaching a debugger.
const DIAG_LOG = process.env.DSH_HUD_DIAG_LOG || '';
function diag(msg) {
  if (!DIAG_LOG) return;
  try {
    fs.appendFileSync(DIAG_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch (_) { /* best effort */ }
}

class HudWindow {
  constructor() {
    // Portable config (t26): env DSH_HUD_* -> config.local.json -> detect ->
    // defaults. app.getAppPath() may be absent in the unit-test stub, so guard.
    let appPath = null;
    try { if (typeof app.getAppPath === 'function') appPath = app.getAppPath(); } catch { /* keep null */ }
    this.config = loadConfig({ appPath }).config;

    this.win = null;
    this.mode = 'capsule';
    this.state = loadState();
    this.dragSession = null; // { offsetX, offsetY } while a drag is in flight
    this.hotkey = null; // hotkey controller (src/hotkeys.js)
    this._animatingOut = false; // true while the panel plays its collapse animation
    this._collapseTimer = null; // fallback timer for the collapse animation
    this.web = null; // WebEmbed (embedded DSH Web UI, t6)
    this._webBounds = null; // last #web-host rect from the shell renderer
    this._rightbarOpen = false; // DSH page's right column is expanded
    this._rightbarCooldownUntil = 0; // ignore self-induced reports right after a resize
    this._resizeSession = null;       // press-and-drag edge resize
    this._webLoaded = false; // true once the web view has been asked to load
    this._paletteOpen = false; // command palette overlay is visible (t35)
    this._panelUserSize = null; // last panel size the user dragged to (t38 B1)
    this._paletteItems = null; // Map<id, run()> for the open palette (t35)
  }

  // True when transparent mode is active. DSH_HUD_OPAQUE=1 forces the opaque
  // fallback for GPUs/RDP where transparent windows render as a black box.
  isTransparent() {
    return process.env.DSH_HUD_OPAQUE !== '1';
  }

  // DSH_HUD_NO_ANIM=1 disables the expand/collapse animation (snap switch).
  animationsEnabled() {
    return process.env.DSH_HUD_NO_ANIM !== '1';
  }

  create() {
    const transparent = this.isTransparent();
    const win = new BrowserWindow({
      width: CAPSULE.width,
      height: CAPSULE.height,
      useContentSize: true, // width/height refer to the web page (exact 520 content area)
      frame: false,
      transparent,
      backgroundColor: transparent ? '#00000000' : '#161a2b',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false, // transparent windows get no native shadow; CSS shadow instead
      // Drop WS_THICKFRAME: with a frameless window Windows still reserved a
      // 2px resize border, so every setBounds/setPosition round-tripped through
      // the frame and the content area drifted to 522x722 (t13 #7).
      thickFrame: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // The renderer runs with the OS sandbox disabled (electron is launched
        // with --no-sandbox) — see README-ENV.md. Keep webPreferences.sandbox in
        // sync with that launch flag.
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    // 'screen-saver' level keeps the HUD above fullscreen apps too.
    win.setAlwaysOnTop(true, 'screen-saver');

    this.win = win;
    this.web = new WebEmbed(win);
    this.web.create(); // create the view + wire its load/error events (no attach yet)
    this.web.onEscape = () => this.collapse(); // Esc inside the embedded UI collapses
    this.web.onTheme = (theme) => this._pushTheme(theme); // page theme -> shell colors (t34)
    this.web.onCommand = () => this._togglePalette(); // Ctrl+K inside the embedded UI (t35)
    this._theme = this._loadTheme(); // cached theme from a previous launch
    this._wireEvents();
    return win;
  }

  load() {
    // Load the local shell (capsule + panel chrome + #web-host placeholder).
    // The DSH Web UI itself is embedded via the WebContentsView (src/web-embed.js).
    // Paint the cached theme as soon as the shell DOM is ready (before the web
    // view reports), so a light-theme user never sees a dark flash on relaunch.
    this.win.webContents.once('did-finish-load', () => {
      if (this._theme) this._pushTheme(this._theme);
    });
    return this.win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  // Register the global hotkey (must be after app 'ready'). Returns true when
  // the accelerator registered successfully.
  setupHotkey() {
    this.hotkey = createHotkeyController();
    const ok = this.hotkey.register(() => this.toggle());
    if (ok) {
      console.log(`[hud] 全局热键已注册: ${this.hotkey.accelerator}（切换胶囊/面板）`);
    }
    return ok;
  }

  // ---- state machine ----

  showCapsule({ releaseFocus = true } = {}) {
    const wasPanel = this.mode === 'panel';
    this.mode = 'capsule'; // set FIRST so the blur handler won't re-enter
    const pos = this._capsulePosition();

    if (wasPanel && releaseFocus) {
      // 焦点策略(收起)：hide() 让 Windows 把前台焦点还给 Z 序里的上一个
      // 窗口，再 showInactive() 显示胶囊且不抢焦点。
      this.win.hide();
      this._applyBounds(pos, CAPSULE);
      this.win.showInactive();
    } else {
      this._applyBounds(pos, CAPSULE);
      // showInactive(): make it visible without stealing focus (resident pill).
      if (!this.win.isVisible()) this.win.showInactive();
    }

    this._hideWeb();
    this._emitState();
  }

  showPanel() {
    // 重拉守卫（D4）：面板已展开且可见时，重复 showPanel 只做聚焦，不重排/
    // 不重挂载 WebContentsView，避免插件反复 re-launch 时反复抢焦点。
    if (
      this.mode === 'panel' &&
      this.win &&
      !this.win.isDestroyed() &&
      this.win.isVisible()
    ) {
      this.win.focus();
      if (this.web) this.web.focus();
      this._emitState();
      return;
    }
    this.mode = 'panel';
    const pos = this._panelPosition(this._panelSize());
    this._applyBounds(pos, this._panelSize());
    this.win.show();
    // 焦点策略(展开)：聚焦窗口；renderer 收到 state=panel 后上报 #web-host
    // 边界，主进程据此定位 WebContentsView。
    this.win.focus();
    this._showWeb();
    // The view owns the composer: without this the window has OS focus but the
    // WebContentsView does not, so the first keystroke after a hotkey expand
    // went nowhere (t13 #9).
    if (this.web) this.web.focus();
    this._emitState();
  }

  // --- press-and-drag edge resize -------------------------------------------
  // The panel is narrower than the DSH toolbar, so some header actions are
  // clipped. Hovering must NOT widen anything (it felt uncontrollable), so the
  // width only changes while the user holds the mouse button on the panel edge
  // and drags outward (user 2026-11-08).
  _beginEdgeResize(side) {
    if (!this.win || this.win.isDestroyed() || this.mode !== 'panel') return;
    this._endEdgeResize(true);
    const b = this.win.getBounds();
    const cursor = screen.getCursorScreenPoint();
    const work = screen.getDisplayNearestPoint({ x: cursor.x, y: cursor.y }).workArea;
    const normalised = ['left', 'right', 'top', 'bottom'].includes(side) ? side : 'right';
    this._resizeSession = {
      side: normalised,
      vertical: normalised === 'top' || normalised === 'bottom',
      startX: b.x,
      startY: b.y,
      startWidth: b.width,
      startHeight: b.height,
      work,
    };
    diag(`edge resize start ${normalised} ${b.width}x${b.height}`);
  }

  // Applied from renderer-reported pointer deltas (DIP) rather than by polling
  // the global cursor: polling grew the window without bound on real Windows
  // (user 2026-11-10), because every tick re-applied a delta computed against
  // a moving window. Deltas only change when the mouse actually moves.
  _applyEdgeResize(dx, dy) {
    const s = this._resizeSession;
    if (!s || !this.win || this.win.isDestroyed() || this.mode !== 'panel') {
      this._endEdgeResize(true);
      return;
    }
    const work = s.work;
    const minW = PANEL.width;
    const minH = 420;
    const maxW = Math.min(work.width, 1400);
    const maxH = work.height;

    let x = s.startX;
    let y = s.startY;
    let width = s.startWidth;
    let height = s.startHeight;

    if (s.vertical) {
      const delta = Math.round(s.side === 'bottom' ? dy : -dy);
      height = Math.max(minH, Math.min(maxH, s.startHeight + delta));
      y = s.side === 'bottom' ? s.startY : s.startY + s.startHeight - height;
      // Cross axis comes from the session snapshot, never from getBounds():
      // reading back let Windows' invisible frame add a pixel on every
      // setBounds, so holding still crept 1px per event (user 2026-11-10).
      width = s.startWidth;
      x = s.startX;
    } else {
      const delta = Math.round(s.side === 'right' ? dx : -dx);
      width = Math.max(minW, Math.min(maxW, s.startWidth + delta));
      x = s.side === 'right' ? s.startX : s.startX + s.startWidth - width;
      height = s.startHeight;
      y = s.startY;
    }

    x = Math.max(work.x, Math.min(x, work.x + work.width - width));
    y = Math.max(work.y, Math.min(y, work.y + work.height - height));
    const cur = this.win.getBounds();
    if (cur.x === x && cur.y === y && cur.width === width && cur.height === height) return;
    if (process.env.DSH_HUD_DEBUG) {
      diag(`edge resize move ${s.side} dx=${dx} dy=${dy} ${cur.width}x${cur.height} -> ${width}x${height}`);
    }
    this.win.setBounds({ x, y, width, height });
    // Remember it immediately too: a drag can start before the pointer is
    // released, and that path must already know the resized size (t38 B1).
    this._panelUserSize = { width, height };
  }

  _endEdgeResize(silent) {
    if (this._resizeTimer) {
      clearInterval(this._resizeTimer);
      this._resizeTimer = null;
    }
    if (this._resizeSession && !silent && this.win && !this.win.isDestroyed()) {
      const b = this.win.getBounds();
      this._panelUserSize = { width: b.width, height: b.height };
      diag(`edge resize end ${b.width}x${b.height} (remembered)`);
    }
    this._resizeSession = null;
  }

  // Size the expanded panel for the embedded page's current layout: the DSH
  // right sidebar is an inline column, so opening it wants ~380 DIP more width
  // instead of an overlay drawer (user 2026-11-08).
  _panelSize() {
    // A size the user dragged to wins over the presets: otherwise collapsing
    // and re-expanding silently reverted the window to 520x720 (t38 B1).
    if (this._panelUserSize) return this._panelUserSize;
    return this._rightbarOpen ? PANEL_WIDE : PANEL;
  }

  // Called from the WebContentsView preload when the page's right column opens
  // or closes. Growing keeps the LEFT edge fixed (expands outward to the
  // right); if the display edge is in the way the rectangle is clamped back
  // on-screen instead of being pushed off.
  setRightbar(open) {
    const next = !!open;
    if (this._rightbarOpen === next) return;
    this._rightbarOpen = next;
    diag(`rightbar=${next}`);
    if (this.mode !== 'panel' || !this.win || this.win.isDestroyed()) return;
    const size = this._panelSize();
    this._rightbarCooldownUntil = Date.now() + 1500;
    const [cw, ch] = this.win.getContentSize();
    const b = this.win.getBounds();
    const wa = this._workAreaForPoint(b.x + 24, b.y + 24);
    const clamped = this._clamp({ x: b.x, y: b.y, width: size.width, height: size.height }, wa);
    this._applyBounds({ x: clamped.x, y: clamped.y }, size);
    void cw;
    void ch;
  }

  // Focus the HUD only if it is already visible (D4: second-instance must NOT
  // force the panel open). Visible -> raise/focus; not visible -> no-op.
  focusIfVisible() {
    if (!this.win || this.win.isDestroyed()) return;
    if (!this.win.isVisible()) return; // 不可见则不弹面板
    this.win.focus();
    if (this.mode === 'panel' && this.web) this.web.focus();
  }

  // 重新读取 discovery.json，用新鲜 tokenUrl 重铸 auth cookie（服务端 303 会
  // 跳回 clean URL，此后按 cookie 鉴权）；失败路径由 WebEmbed 的 did-fail-load /
  // 401 webRequest 兜底，停在自绘错误页（D3）。
  reloadWeb() {
    if (this.web) this.web.reload({ forceToken: true });
  }

  // Persist the current position then exit. The context-menu 关闭项 and the
  // panel × button both route here so a quit never loses the last position.
  quit() {
    if (this.win && !this.win.isDestroyed()) {
      const [x, y] = this.win.getPosition();
      if (this.mode === 'capsule') this.state.capsule = { x, y };
      else this.state.panel = { x, y };
      saveState(this.state, { immediate: true });
    }
    app.quit();
  }

  // 右键菜单模板（可扩展）。数组 + separator 分组；后续加项时往数组里追加
  // 条目即可，无需改动 popup 逻辑。
  //
  // 「关闭 DSH 浮窗」已移除：胶囊和面板是点击联动的（点图标展开、图标随
  // 之隐藏），面板右上角自带 — 收起 / × 退出，右键里再放一个关闭项既重复
  // 又容易误触。
  buildContextMenu() {
    return [
      {
        label: '打开 DSH 桌面窗口',
        click: () => {
          this._log('menu: "打开 DSH 桌面窗口" clicked');
          try {
            this._openDshDesktop();
          } catch (err) {
            this._log('menu handler threw: ' + (err && err.message));
            console.error('[hud] open DSH desktop threw:', err);
          }
        },
      },
      {
        label: '打开 DSH 浮窗',
        click: () => {
          this._log('menu: "打开 DSH 浮窗" clicked');
          this.showPanel();
        },
      },
      {
        // 用户 2026-11-08：余额用尽时一键去充值页（系统浏览器打开）。
        label: 'Token 补充',
        click: () => {
          this._log('menu: "Token 补充" clicked');
          // Opened in-app: handing the URL to the system browser fails when an
          // elevated browser instance already exists (Windows refuses the
          // cross-integrity hand-off), and that is not something a floating
          // widget can fix. A dedicated window always works and keeps the user
          // in the capsule's context.
          this._openTokenWindow();
        },
      },
      { type: 'separator' },
      {
        // 用户 2026-11-08：胶囊不再有 hover 关闭按钮，退出统一收进右键菜单。
        label: '退出 DSH 浮窗',
        click: () => {
          this._log('menu: "退出 DSH 浮窗" clicked');
          try {
            this.quit();
          } catch (err) {
            this._log('quit threw: ' + (err && err.message));
            console.error('[hud] quit threw:', err);
          }
        },
      },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: autostart.isEnabled(),
        click: (item) => autostart.setEnabled(item.checked),
      },
      ...this._extensionMenuEntries(),
    ];
  }

  // 扩展点 1：其它模块 registerMenuItem 注册的条目追加在内置菜单之后。
  // 每个 click 都包一层 try/catch，避免第三方条目抛错把整个菜单搞挂。
  _extensionMenuEntries() {
    const ctx = { hud: this };
    return extensionMenuItems(ctx).map((item) => {
      if (!item.click) return item;
      const original = item.click;
      return {
        ...item,
        click: (...args) => {
          try {
            this._log('extension menu: ' + item.label);
            return original(ctx, ...args);
          } catch (err) {
            this._log('extension menu threw: ' + (err && err.message));
            console.error('[hud] extension menu item failed:', err);
            return undefined;
          }
        },
      };
    });
  }

  // Append a line to <userData>/hud.log. The menu lives in the main process, so
  // its failures are invisible in the renderer console; this file is the only
  // way to see whether a click reached us when the app was started by the user.
  // A plain window (native frame, so it can be moved/closed normally) that
  // shows the DeepSeek usage/top-up page. Reuses one window: a second click
  // raises the existing one instead of stacking new copies.
  _openTokenWindow() {
    try {
      if (this._tokenWin && !this._tokenWin.isDestroyed()) {
        this._tokenWin.show();
        this._tokenWin.focus();
        return;
      }
      this._tokenWin = new BrowserWindow({
        width: 960,
        height: 780,
        minWidth: 640,
        minHeight: 480,
        title: 'Token 补充 — DeepSeek',
        autoHideMenuBar: true,
        webPreferences: {
          partition: 'persist:dsh-hud-site',
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      this._tokenWin.on('closed', () => { this._tokenWin = null; });
      const load = () => {
        const wc = this._tokenWin && this._tokenWin.webContents;
        if (wc && typeof wc.loadURL === 'function') wc.loadURL(TOKEN_TOPUP_URL);
        else if (this._tokenWin && typeof this._tokenWin.loadURL === 'function') this._tokenWin.loadURL(TOKEN_TOPUP_URL);
      };
      load();
      this._log('token window opened: ' + TOKEN_TOPUP_URL);
    } catch (err) {
      this._log('token window failed: ' + (err && err.message));
      // Last resort: ask the shell. It may be refused, so leave the URL on the
      // clipboard for a manual paste.
      this._openExternalUrl(TOKEN_TOPUP_URL, 'token top-up');
    }
  }

  // Our process may run elevated (e.g. the HUD was started from an admin
  // console). shell.openExternal() then talks to an elevated browser instance,
  // and a later request from a normal-integrity process gets Edge's
  // "existing instance is running elevated — restart it?" dialog (user
  // 2026-11-08). Ask Explorer (always the logged-on user) to open the URL
  // instead, which keeps the browser at the user's own integrity level.
  _isElevated() {
    if (process.env.DSH_HUD_FORCE_ELEVATED === '1') return true;
    if (process.env.DSH_HUD_FORCE_ELEVATED === '0') return false;
    try {
      const out = execFileSync('whoami.exe', ['/groups'], { windowsHide: true, encoding: 'utf8' });
      // S-1-16-12288 = High integrity, S-1-16-16384 = System.
      return /S-1-16-(12288|16384)/.test(out);
    } catch (_) {
      return false;
    }
  }

  // Open an external URL without inheriting our integrity level when possible,
  // and keep the link on the clipboard so the user still has a way through if
  // the shell refuses to cooperate.
  _openExternalUrl(url, label) {
    const elevated = this._isElevated();
    this._log(`open url (${label}) elevated=${elevated}`);
    if (elevated) {
      try {
        const child = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' });
        child.unref();
        this._log(`explorer delegation started for ${label}`);
        return;
      } catch (err) {
        this._log('explorer delegation failed: ' + (err && err.message));
      }
    }
    try {
      const p = shell.openExternal(url);
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          this._log('openExternal failed: ' + (err && err.message));
          try { clipboard.writeText(url); } catch { /* no clipboard */ }
        });
      }
    } catch (err) {
      this._log('openExternal threw: ' + (err && err.message));
      try { clipboard.writeText(url); } catch { /* no clipboard */ }
    }
  }

  _log(message) {
    try {
      const dir = app.getPath('userData');
      const file = path.join(dir, 'hud.log');
      let stat = null;
      try { stat = fs.statSync(file); } catch { stat = null; }
      if (stat && stat.size > 512 * 1024) {
        try { fs.renameSync(file, file + '.1'); } catch { /* best effort */ }
      }
      const line = `${new Date().toISOString()} [hud] ${message}\n`;
      fs.appendFileSync(file, line);
    } catch (err) {
      console.error('[hud] log write failed:', err && err.message);
    }
  }

  // 打开（或前置）独立的 DSH 桌面应用。
  //
  // 走「直接 spawn 本体」而不是 explorer.exe：explorer 会静默丢弃来自本沙箱
  // 的启动请求（实测 `explorer.exe notepad.exe` 一个进程都不会出现，而同一条
  // 命令直接 Start-Process 立刻就能起）。直接 spawn 出的子进程虽然继承低完整
  // 性令牌，但它只需要完成单实例交接（requestSingleInstanceLock 失败 → 把启动
  // 请求转给主实例 → 自己退出），实测 4s 内正常退出且无崩溃事件。
  //
  // 置前交给 focus-dsh.ps1（EnumWindows + 校验 GetForegroundWindow），脚本
  // 会先给已经在前台的窗口一次 minimize→restore 的「弹一下」，否则用户看不
  // 出任何变化。激活期间临时让出置顶，避免胶囊/面板挡住刚调上来的窗口。
  _openDshDesktop() {
    const exe = this.config.dshExe;

    // Fold the panel down first: the panel renders the same DSH conversation
    // over most of the screen, so a desktop window opening *behind* it looks
    // like nothing happened at all (that was the "还是无法弹出" report).
    if (this.mode === 'panel') {
      this._log('collapsing panel before desktop activation');
      this.collapse();
    }
    // The capsule is 64x64, so it no longer hides the desktop app the way the
    // 520x720 panel did; keep it visible so the user always has the entry point
    // back (hiding it made the click look like "screen went blank").

    // The HUD runs at Low IL: UIPI silently drops ShowWindow/SetForegroundWindow
    // against the Medium-IL DSH window, so every local attempt looked successful
    // while doing nothing. The Cordis host is Medium, hence the request file.
    if (!exe) {
      this._log('desktop exe not detected; focusing by window title only');
      this._focusDshDesktop({ quiet: false });
      return;
    }

    this._requestDesktopFocus(exe).then((res) => {
      if (res) {
        this._log(`host request result: ok=${res.ok} out=${res.out}`);
        this._confirmDesktopFocus(res.out, !res.ok);
        return;
      }
      this._log('host bridge unavailable, falling back to local launch');
      this._launchDshDesktop(exe);
      setTimeout(() => this._focusDshDesktop({ quiet: true }), 900);
    });
  }

  // Ask the host plugin to launch + foreground the desktop app. Returns null
  // when no host answers (plugin disabled / not installed), so the caller can
  // fall back to the old best-effort path.
  _requestDesktopFocus(exe) {
    return new Promise((resolve) => {
      const dir = this._ipcDir();
      const id = `${process.pid}-${Date.now()}`;
      try {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = path.join(dir, `request.${process.pid}.tmp`);
        fs.writeFileSync(tmp, JSON.stringify({ id, action: 'desktop', exe, at: Date.now() }));
        fs.renameSync(tmp, path.join(dir, 'request.json'));
        this._log('host request posted: ' + id);
      } catch (err) {
        this._log('host request failed: ' + (err && err.message));
        resolve(null);
        return;
      }
      const started = Date.now();
      const poll = () => {
        if (Date.now() - started > 6000) {
          this._log('host request timeout');
          resolve(null);
          return;
        }
        try {
          const res = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
          if (res && res.id === id) {
            resolve({ ok: !!res.ok, out: String(res.out || '') });
            return;
          }
        } catch {
          /* not written yet */
        }
        setTimeout(poll, 250);
      };
      setTimeout(poll, 400);
    });
  }

  _ipcDir() {
    if (this.config && this.config.ipcDir) return this.config.ipcDir;
    if (process.env.DSH_HUD_IPC_DIR) return process.env.DSH_HUD_IPC_DIR;
    // Both sides default to the same per-user directory: inside an asar the
    // repo-relative path resolves under resources/ and would never meet the
    // plugin's request file (packaged build, 2026-11-08).
    if (process.env.LOCALAPPDATA) {
      return path.join(process.env.LOCALAPPDATA, 'dsh-hud', 'ipc');
    }
    try {
      return path.resolve(app.getAppPath(), '..', 'artifacts', 'ipc');
    } catch {
      return path.join(app.getPath('userData'), 'ipc');
    }
  }

  // Get out of the way for a moment. Even a collapsed capsule is topmost, and
  // users judge "did it open?" by what they can see, so hide the HUD entirely
  // while the desktop window is raised, then come back as the capsule.
  _hideDuringActivation() {
    if (!this.win || this.win.isDestroyed()) return;
    if (this._hideTimer) {
      clearTimeout(this._hideTimer);
      this._hideTimer = null;
    }
    try {
      this.win.hide();
      this._log('hud hidden for activation');
    } catch (err) {
      this._log('hide for activation failed: ' + (err && err.message));
    }
    this._hideTimer = setTimeout(() => {
      this._hideTimer = null;
      if (!this.win || this.win.isDestroyed()) return;
      try {
        this.win.showInactive();
        this.win.setAlwaysOnTop(true, 'screen-saver');
        this._log('hud shown again after activation');
      } catch (err) {
        this._log('show after activation failed: ' + (err && err.message));
      }
    }, 2800);
  }

  // A tray-style notification so the click has visible feedback even when the
  // desktop window was already in front (then nothing else on screen changes).
  _confirmDesktopFocus(line, failed) {
    try {
      const { Notification } = require('electron');
      if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) {
        this._log('desktop notification unsupported');
        return;
      }
      const m = /^(?:focused|nofocus)\s+\d+\s+\d+\s*(.*)$/.exec(line || '');
      const target = (m && m[1]) || 'DSH 桌面窗口';
      const body = failed ? `没能切到前台：${target}` : `已切到桌面窗口：${target}`;
      new Notification({ title: 'DSH HUD', body, silent: true }).show();
      this._log('desktop notification: ' + body);
    } catch (err) {
      this._log('desktop notification failed: ' + (err && err.message));
    }
  }

  _launchDshDesktop(exe) {
    if (!exe || !fs.existsSync(exe)) {
      console.error('[hud] DSH desktop exe not found:', exe);
      this._log('launch aborted, exe not found: ' + exe);
      return;
    }
    try {
      const { spawn } = require('child_process');
      // Direct spawn, not `explorer.exe <path>`: the shell drops launch
      // requests coming from this low-integrity sandbox (verified with
      // notepad — explorer returned but no process appeared). A direct child
      // inherits our token but only has to reach its single-instance hand-off:
      // the running primary receives "second-instance" and focuses its window.
      spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
      console.log('[hud] DSH desktop launch requested:', exe);
      this._log('launch requested: ' + exe);
    } catch (err) {
      console.error('[hud] launch DSH desktop failed:', err && err.message);
      this._log('launch failed: ' + (err && err.message));
    }
  }

  // Bring an already-running DSH window to the foreground. The helper only
  // enumerates windows and calls SetForegroundWindow, which a low-integrity
  // process is allowed to do; `quiet` skips the console noise used for
  // diagnostics.
  _focusDshDesktop({ quiet = false } = {}) {
    // PowerShell is an external process: it cannot read a path inside app.asar,
    // so the helper is copied to userData first and the copy is executed. The
    // copy is refreshed whenever the packaged script changes size.
    const script = this._materializeHelperScript();

    const log = (...args) => {
      if (!quiet) console.log(...args);
    };

    if (process.platform !== 'win32' || !script || !fs.existsSync(script)) {
      if (!quiet) console.log('[hud] focus helper unavailable');
      return;
    }

    try {
      const { spawn } = require('child_process');
      // PowerShell's Add-Type shells out to csc, which needs a writable TEMP.
      // In this sandbox %LOCALAPPDATA%\Temp is not writable ("access denied"),
      // so point the helper at a directory we know we can write.
      const tmpDir = path.join(app.getPath('userData'), 'tmp');
      try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* best effort */ }
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ExePath', this._dshExe()],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, TEMP: tmpDir, TMP: tmpDir },
        },
      );
      let out = '';
      child.stdout.on('data', (b) => { out += b.toString(); });
      child.stderr.on('data', (b) => { out += b.toString(); });
      // 8s 兜底：脚本正常 0.5s 内结束，卡住时也要给出结果。
      const timer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        log('[hud] focus helper timeout');
      }, 8000);
      child.on('close', (code) => {
        clearTimeout(timer);
        const line = out.trim().split(/\r?\n/)[0] || '';
        this._log(`focus helper exit=${code} out=${line}`);
        if (code === 0) log('[hud] DSH desktop focus:', line);
        else log('[hud] DSH desktop focus skipped:', line || `exit ${code}`);
        this._confirmDesktopFocus(line, code !== 0);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        log('[hud] focus helper error:', err && err.message);
      });
    } catch (err) {
      log('[hud] focus helper failed:', err && err.message);
    }
  }

  // The exe the helper should look for. Passed to the script so it can match
  // the window by its owning *process image* — a handle dies with the process,
  // and the title carries the session name, so neither is stable long-term.
  _dshExe() {
    return this.config.dshExe || '';
  }

  // Copy focus-dsh.ps1 out of the (possibly asar-packed) app directory into
  // userData and return the real filesystem path, or null when unavailable.
  _materializeHelperScript() {
    try {
      const src = path.join(__dirname, '..', 'scripts', 'focus-dsh.ps1');
      if (!fs.existsSync(src)) return null;
      const dir = path.join(app.getPath('userData'), 'helpers');
      fs.mkdirSync(dir, { recursive: true });
      const dst = path.join(dir, 'focus-dsh.ps1');
      const srcSize = fs.statSync(src).size;
      let needCopy = true;
      try {
        needCopy = fs.statSync(dst).size !== srcSize;
      } catch {
        needCopy = true;
      }
      if (needCopy) fs.copyFileSync(src, dst);
      return dst;
    } catch (err) {
      console.error('[hud] helper script materialize failed:', err && err.message);
      return null;
    }
  }

  // Hotkey: toggle both ways (panel collapses with animation, capsule expands).
  toggle() {
    if (this.mode === 'panel') {
      // A second press during the collapse animation used to be swallowed by
      // collapse()'s _animatingOut guard; finish collapsing first so the
      // hotkey always does something (t13 #10).
      if (this._animatingOut) this._finishCollapse();
      else this.collapse();
      return;
    }
    this.showPanel();
  }

  // Collapse the panel. When animation is enabled, the renderer plays a short
  // fade/scale-out and then reports hud:collapse-done; a main-side fallback
  // timer guarantees the resize even if the renderer never answers.
  collapse() {
    if (this.mode !== 'panel' || this._animatingOut) return;
    // The palette detaches the embedded view; collapsing first would leave it
    // detached and _paletteOpen stuck, killing Ctrl+K (t38 H1).
    if (this._paletteOpen) this._closePalette();
    if (!this.animationsEnabled()) {
      this.showCapsule();
      return;
    }
    this._animatingOut = true;
    this.win.webContents.send('hud:collapse-anim');
    this._collapseTimer = setTimeout(() => this._finishCollapse(), COLLAPSE_FORCE_TIMEOUT_MS);
  }

  _finishCollapse() {
    if (this._collapseTimer) {
      clearTimeout(this._collapseTimer);
      this._collapseTimer = null;
    }
    this._animatingOut = false;
    this.showCapsule();
  }

  // ---- embedded Web UI (t6) ----

  // Attach the WebContentsView over #web-host and trigger the first load.
  _showWeb() {
    if (!this.web) return;
    if (!this._webBounds) {
      // Initial estimate so the view has a non-zero size before the renderer's
      // first report lands: card origin (transparent margin) + card inset.
      // The renderer corrects it a frame later.
      this._webBounds = {
        x: 14,
        y: 60,
        width: PANEL.width - 28,
        height: PANEL.height - 74,
      };
      this.web.setBounds(this._webBounds);
    }
    this.web.attach();
    if (!this._webLoaded) {
      this._webLoaded = true;
      this.web.load();
    }
  }

  // Detach (but keep alive) the WebContentsView while in capsule mode so it
  // does not float over the pill; re-attaching on the next panel reuses it.
  _hideWeb() {
    if (this.web) this.web.detach();
  }

  // ---- geometry helpers ----

  _applyBounds(pos, size) {
    if (!this.win || this.win.isDestroyed()) return;
    const w = Math.round(size.width);
    const h = Math.round(size.height);
    // Always move + size in ONE call when the content size is off by even 1 px.
    // Setposition-only lets Windows re-apply its (former) frame border and the
    // window creeps +2 px per move; the old ±2 px tolerance then *hid* the
    // drift instead of correcting it, which is why 522x722 survived (t13 #7).
    // With thickFrame:false the content size round-trips exactly, so a strict
    // comparison no longer oscillates.
    const [cw, ch] = this.win.getContentSize();
    if (cw !== w || ch !== h) {
      this.win.setBounds({ x: Math.round(pos.x), y: Math.round(pos.y), width: w, height: h });
    } else {
      this.win.setPosition(Math.round(pos.x), Math.round(pos.y), false);
    }
    diag(`applyBounds mode=${this.mode} size=${w}x${h} pos=${Math.round(pos.x)},${Math.round(pos.y)} -> content=${JSON.stringify(this.win.getContentSize())}`);
  }

  _workAreaForPoint(x, y) {
    return screen.getDisplayNearestPoint({ x, y }).workArea;
  }

  // Clamp a bounds rectangle into a display work area, keeping it fully
  // on-screen (with a small margin). Oversized windows top-left align.
  _clamp(bounds, wa) {
    const m = CLAMP_MARGIN;
    let { x, y } = bounds;
    const maxX = wa.x + wa.width - bounds.width - m;
    const maxY = wa.y + wa.height - bounds.height - m;
    x = Math.max(wa.x + m, Math.min(x, maxX));
    y = Math.max(wa.y + m, Math.min(y, maxY));
    if (bounds.width + m * 2 > wa.width) x = wa.x + m;
    if (bounds.height + m * 2 > wa.height) y = wa.y + m;
    return { x, y, width: bounds.width, height: bounds.height };
  }

  // 吸附屏幕边缘: if the capsule's left/top edge lands within
  // EDGE_SNAP_DISTANCE of a work-area edge, snap it flush to that edge
  // (keeping CLAMP_MARGIN). Snap only applies on the capsule (not the panel).
  _snapCapsule(x, y) {
    const wa = this._workAreaForPoint(
      x + CAPSULE.width / 2,
      y + CAPSULE.height / 2
    );
    const left = x - wa.x;
    const right = wa.x + wa.width - (x + CAPSULE.width);
    const top = y - wa.y;
    const bottom = wa.y + wa.height - (y + CAPSULE.height);
    const d = Math.min(left, right, top, bottom);
    if (d > EDGE_SNAP_DISTANCE) return { x, y };
    if (d === left) return { x: wa.x + CLAMP_MARGIN, y };
    if (d === right) return { x: wa.x + wa.width - CAPSULE.width - CLAMP_MARGIN, y };
    if (d === top) return { x, y: wa.y + CLAMP_MARGIN };
    return { x, y: wa.y + wa.height - CAPSULE.height - CLAMP_MARGIN };
  }

  // Keep part of the window inside a display's work area so a fast drag can
  // never park the HUD entirely off-screen (t13 #11). KEEP is the minimum
  // visible strip on the left/top; the top edge stays inside fully so the
  // capsule is always reachable.
  _clampToWorkArea(x, y, size) {
    const KEEP = 48;
    const wa = this._workAreaForPoint(x + size.width / 2, y + size.height / 2);
    return {
      x: Math.min(Math.max(x, wa.x - size.width + KEEP), wa.x + wa.width - KEEP),
      y: Math.min(Math.max(y, wa.y), wa.y + wa.height - KEEP),
    };
  }

  _capsulePosition() {
    const primary = screen.getPrimaryDisplay().workArea;
    const saved = this.state.capsule;
    // Default: bottom-right corner of the primary work area.
    const x = saved ? saved.x : primary.x + primary.width - CAPSULE.width - 40;
    const y = saved ? saved.y : primary.y + primary.height - CAPSULE.height - 40;
    const wa = this._workAreaForPoint(x, y);
    return this._clamp({ x, y, width: CAPSULE.width, height: CAPSULE.height }, wa);
  }

  _panelPosition(size = PANEL) {
    const cap = this._capsulePosition();
    const cx = cap.x + CAPSULE.width / 2;
    const cy = cap.y + CAPSULE.height / 2;
    const saved = this.state.panel;
    // Default: panel bottom sits just above the capsule (grows upward),
    // anchored to the display that holds the capsule.
    const x = saved ? saved.x : cap.x;
    const y = saved ? saved.y : cap.y - (size.height - CAPSULE.height);
    const wa = this._workAreaForPoint(cx, cy);
    return this._clamp({ x, y, width: size.width, height: size.height }, wa);
  }

  _emitState() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('hud:state', {
        mode: this.mode,
        opaque: !this.isTransparent(),
      });
    }
  }

  _wireEvents() {
    const win = this.win;

    win.on('closed', () => {
      this.win = null;
      this.dragSession = null;
      if (this._collapseTimer) {
        clearTimeout(this._collapseTimer);
        this._collapseTimer = null;
      }
    });

    // 失焦收起 is OPT-IN only (DSH_HUD_BLUR_COLLAPSE=1). Default behaviour:
    // the expanded panel STAYS open when the user clicks another window —
    // collapsing on blur made the panel feel like a transient popup.
    win.on('blur', () => {
      diag(`blur mode=${this.mode} collapseEnabled=${process.env.DSH_HUD_BLUR_COLLAPSE === '1'}`);
      if (process.env.DSH_HUD_BLUR_COLLAPSE !== '1') return;
      if (this.mode === 'panel') this.collapse();
    });
    win.on('focus', () => diag(`focus mode=${this.mode}`));

    // The HUD is a fixed-size floating widget: never let the OS resize it
    // (edge drags on a frameless window can bypass resizable:false and grow
    // both states without bound).
    win.on('will-resize', (event) => {
      event.preventDefault();
      diag('will-resize prevented');
    });
    win.on('resize', () => {
      if (!win || win.isDestroyed()) return;
      const [w, h] = win.getContentSize();
      diag(`resize content=${w}x${h} mode=${this.mode}`);
    });

    // The panel header is now an app-region drag handle, so the OS moves the
    // window directly and hud:panel-save never runs. Persist from the window's
    // own move event instead (debounced: one write per drag, not per frame).
    let moveTimer = null;
    win.on('move', () => {
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        if (!this.win || this.win.isDestroyed()) return;
        const [x, y] = this.win.getPosition();
        if (this.mode === 'capsule') this.state.capsule = { x, y };
        else this.state.panel = { x, y };
        saveState(this.state);
        diag(`move saved mode=${this.mode} pos=${x},${y}`);
      }, 400);
    });

    // Esc 收起 (authoritative; fires even if renderer focus is odd).
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        this.collapse();
      }
      // Ctrl+K opens the command palette when the panel is expanded (t35).
      if (input.type === 'keyDown' && (input.key === 'k' || input.key === 'K')
          && (input.control || input.meta) && this.mode === 'panel') {
        event.preventDefault();
        this._togglePalette();
      }
    });

    // 右键菜单（胶囊 / 面板顶栏，二者都在 shell 的 webContents 上；内嵌
    // DSH UI 的右键不受影响，因为它属于 WebContentsView 自己的 webContents）。
    win.webContents.on('context-menu', () => {
      Menu.buildFromTemplate(this.buildContextMenu()).popup({ window: win });
    });

    win.webContents.on('did-finish-load', () => this._emitState());

    // 多显示器/DPI 适配: re-clamp when the display topology or scale changes.
    this._reclamp = () => {
      if (this.win && !this.win.isDestroyed()) {
        if (this.mode === 'capsule') this.showCapsule();
        else this.showPanel();
      }
    };
    screen.on('display-added', this._reclamp);
    screen.on('display-removed', this._reclamp);
    screen.on('display-metrics-changed', this._reclamp);

    // ---- IPC (see preload.js + renderer/hud.js) ----
    // Drag protocol (t14 #12): the renderer sends the cursor offset within the
    // window at mousedown and then only signals "still dragging". Main derives
    // the absolute position from screen.getCursorScreenPoint() (virtual-desktop
    // DIP) minus the offset, which stays correct across displays with different
    // scale factors — the old renderer-side `e.screenX - window.screenX` mixed
    // two coordinate systems and jumped when the window changed displays.
    this._onDragStart = (_e, { offsetX, offsetY } = {}) => {
      // A resize gesture and a move gesture never overlap; drop the resize
      // session so the two cannot fight over setBounds (t38 B1).
      if (this._resizeSession) this._endEdgeResize(true);
      this.dragSession = {
        offsetX: Number(offsetX) || 0,
        offsetY: Number(offsetY) || 0,
      };
      diag(`drag-start mode=${this.mode} offset=${this.dragSession.offsetX},${this.dragSession.offsetY}`);
    };
    this._onDragMove = () => {
      if (!this.dragSession) return;
      // Re-assert the size on every move, atomically with the position (a bare
      // setPosition let Windows re-apply the content size + invisible border).
      const size = this.mode === 'panel' ? this._panelSize() : CAPSULE;
      const c = screen.getCursorScreenPoint();
      const p = this._clampToWorkArea(c.x - this.dragSession.offsetX, c.y - this.dragSession.offsetY, size);
      this.win.setBounds({ x: Math.round(p.x), y: Math.round(p.y), width: Math.round(size.width), height: Math.round(size.height) });
    };
    this._onDragEnd = (_e, { moved } = {}) => {
      if (this.dragSession) {
        const size = this.mode === 'panel' ? this._panelSize() : CAPSULE;
        const c = screen.getCursorScreenPoint();
        const p = this._clampToWorkArea(c.x - this.dragSession.offsetX, c.y - this.dragSession.offsetY, size);
        this._applyBounds(p, size);
      }
      this.dragSession = null;
      diag(`drag-end moved=${moved} content=${JSON.stringify(this.win.getContentSize())}`);
      if (moved) {
        let [px, py] = this.win.getPosition();
        if (this.mode === 'capsule') {
          // 吸附屏幕边缘 + 记忆位置。
          const snapped = this._snapCapsule(px, py);
          this.win.setPosition(snapped.x, snapped.y, false);
          this.state.capsule = { x: snapped.x, y: snapped.y };
        } else {
          this.state.panel = { x: px, y: py };
        }
        saveState(this.state);
      } else if (this.mode === 'capsule') {
        // A click (no movement) on the capsule expands it.
        this.showPanel();
      }
      // 拖动结束：若期间 web-bounds 上报被抑制（t14 #24），补一次最终尺寸。
      this._syncWebBounds();
    };
    this._onCollapse = () => this.collapse();
    // Renderer finished the collapse animation -> perform the actual resize.
    this._onCollapseDone = () => {
      if (this._animatingOut) this._finishCollapse();
    };
    this._onQuit = () => this.quit();

    // ---- embedded Web UI (t6) ----
    // Shell renderer reports #web-host rect -> position the WebContentsView.
    this._onWebBounds = (_e, b) => {
      if (!b || typeof b !== 'object') return;
      this._webBounds = b;
      // 拖动期间 renderer 的 ResizeObserver 每帧都因 setBounds→resize 回报
      // 中间态，再 setBounds 形成抖动（t14 #24）：拖动中只记录，drag-end 后补。
      if (!this.dragSession && this.web) this.web.setBounds(b);
    };
    // Error-page actions (renderer/web-preload.js).
    this._onWebRetry = () => {
      if (this.web) this.web.reload({ forceToken: true });
    };
    this._onWebStartDsh = () => {
      if (this.web) this.web.startDsh();
    };
    // The embedded page reports its right column opening/closing; the panel
    // grows outward instead of turning it into an overlay drawer.
    this._onResizeStart = (_e, side) => this._beginEdgeResize(side);
    this._onResizeMove = (_e, d) => this._applyEdgeResize(Number(d && d.dx) || 0, Number(d && d.dy) || 0);
    this._onRightbar = (_e, open) => {
      // Ignore what our own resize just triggered: widening/closing changes the
      // layout branch, which looks like a state change and would ping-pong.
      if (this._rightbarCooldownUntil && Date.now() < this._rightbarCooldownUntil) {
        diag(`rightbar report ignored (cooldown) open=${!!open}`);
        return;
      }
      this.setRightbar(!!open);
    };
    // The embedded page reports its light/dark theme; the WebEmbed forwards it
    // back here (web.onTheme -> _pushTheme) and we relay it to the shell.
    this._onWebTheme = (_e, payload) => {
      // Accept { theme: 'light'|'dark' } (t34) or a bare 'light'/'dark' string
      // (t31 backward compatibility).
      const theme = payload && typeof payload === 'object' && payload.theme ? payload.theme : payload;
      if (this.web) this.web.setEmbeddedTheme(theme);
    };
    // Command palette: execute a selected action by id, then close + re-attach
    // the embedded view (t35). Failures are logged to hud.log, never crash.
    this._onPaletteExec = (_e, payload) => {
      const id = payload && payload.id;
      const run = this._paletteItems && this._paletteItems.get(id);
      this._closePalette();
      if (!run) return;
      try {
        run();
      } catch (err) {
        this._log('palette action threw: ' + (err && err.message));
        console.error('[hud] palette action failed:', err);
      }
    };
    this._onPaletteOpenRequest = () => this._togglePalette();
    this._onPaletteClose = () => this._closePalette();

    ipcMain.on('hud:drag-start', this._onDragStart);
    ipcMain.on('hud:drag-move', this._onDragMove);
    ipcMain.on('hud:drag-end', this._onDragEnd);
    ipcMain.on('hud:collapse', this._onCollapse);
    ipcMain.on('hud:collapse-done', this._onCollapseDone);
    ipcMain.on('hud:quit', this._onQuit);
    ipcMain.on('hud:web-bounds', this._onWebBounds);
    ipcMain.on('hud:web-retry', this._onWebRetry);
    ipcMain.on('hud:web-start-dsh', this._onWebStartDsh);
    ipcMain.on('hud:rightbar', this._onRightbar);
    ipcMain.on('hud:web-theme', this._onWebTheme);
    ipcMain.on('hud:resize-start', this._onResizeStart);
    ipcMain.on('hud:resize-move', this._onResizeMove);
    ipcMain.on('hud:resize-end', () => this._endEdgeResize(false));
    ipcMain.on('hud:palette-exec', this._onPaletteExec);
    ipcMain.on('hud:palette-close', this._onPaletteClose);
    ipcMain.on('hud:palette-open-request', this._onPaletteOpenRequest);
  }

  // Re-apply the last reported #web-host rect (called after a drag so any
  // web-bounds updates suppressed while dragging settle to the final size).
  _syncWebBounds() {
    if (this.web && this._webBounds) this.web.setBounds(this._webBounds);
  }

  // Command palette (t35). The embedded DSH UI is a native WebContentsView that
  // sits on top of the shell DOM, so opening the palette detaches it first and
  // closing re-attaches it (restoring focus to the input). Actions are the
  // right-click menu items plus three built-ins; the renderer only ever sees
  // { id, label } — handlers stay here in the main process.
  // Ctrl+K and the toolbar button both toggle: pressing again must close the
  // palette (user 2026-11-10).
  _togglePalette() {
    if (this._paletteOpen) {
      this._closePalette();
      return;
    }
    this._openPalette();
  }

  _openPalette() {
    if (this.mode !== 'panel' || this._paletteOpen) return;
    const builtin = [
      { id: 'open-dsh-desktop', label: '打开 DSH 桌面窗口', run: () => this._openDshDesktop() },
      { id: 'open-dsh-panel', label: '打开 DSH 浮窗', run: () => this.showPanel() },
      { id: 'token-topup', label: 'Token 补充', run: () => this._openTokenWindow() },
    ];
    const items = builtin.slice();
    try {
      extensionMenuItems({ hud: this }).forEach((item, i) => {
        if (!item || !item.label) return;
        items.push({ id: `ext-${i}`, label: item.label, run: () => item.click({ hud: this }) });
      });
    } catch (err) {
      console.error('[hud] palette: extension items failed:', err && err.message);
    }
    this._paletteItems = new Map(items.map((it) => [it.id, it.run]));
    this._paletteOpen = true;
    this.web.detach(); // hide the native view so the DOM palette is clickable
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('hud:palette-open', {
        items: items.map(({ id, label }) => ({ id, label })),
      });
    }
  }

  _closePalette() {
    if (!this._paletteOpen) return;
    this._paletteOpen = false;
    this._paletteItems = null;
    // Re-attach the embedded view and give focus back to its input.
    if (this.web) {
      this.web.attach();
      this.web.focus();
    }
  }

  // Push the embedded page's theme to the shell renderer (t34). The panel and
  // the capsule live in the same BrowserWindow, so one 'hud:theme' message
  // switches the body class for both states; the shell defaults to dark. The
  // value is also persisted so the next launch paints the cached theme instead
  // of flashing the dark default while the embedded page boots.
  _pushTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    this._saveTheme(t);
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('hud:theme', t);
    }
  }

  _themeFile() {
    try {
      return path.join(app.getPath('userData'), 'theme.json');
    } catch (_) {
      return null;
    }
  }

  // Best-effort persistence (atomic tmp+rename, same pattern as window-state.js).
  _saveTheme(theme) {
    const p = this._themeFile();
    if (!p) return;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ theme }, null, 2), 'utf8');
      fs.renameSync(tmp, p);
    } catch (e) {
      console.error('[hud] theme save failed:', e && e.message);
    }
  }

  _loadTheme() {
    const p = this._themeFile();
    if (p) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (parsed && parsed.theme === 'light') return 'light';
        if (parsed && parsed.theme === 'dark') return 'dark';
      } catch (_) {
        /* fall through to the OS hint */
      }
    }
    // L1: no cached theme yet (very first launch). Starting from the OS
    // preference avoids painting the dark shell and then flipping to light.
    try {
      return nativeTheme && nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    } catch (_) {
      return null;
    }
  }

  // Release every global listener this window registered (t14 #19). The
  // BrowserWindow's own events (blur/focus/resize/move/…) die with the window,
  // but ipcMain and screen are process-global, so they must be removed by name
  // to keep a future "close then reopen" (or a second window) from registering
  // duplicate handlers — one click moving the window twice.
  destroy() {
    this._endEdgeResize(true);
    if (this.web) {
      this.web.destroy();
      this.web = null;
    }

    const ipcPairs = [
      ['hud:drag-start', this._onDragStart],
      ['hud:drag-move', this._onDragMove],
      ['hud:drag-end', this._onDragEnd],
      ['hud:collapse', this._onCollapse],
      ['hud:collapse-done', this._onCollapseDone],
      ['hud:quit', this._onQuit],
      ['hud:web-bounds', this._onWebBounds],
      ['hud:web-retry', this._onWebRetry],
      ['hud:web-start-dsh', this._onWebStartDsh],
      ['hud:rightbar', this._onRightbar],
      ['hud:web-theme', this._onWebTheme],
      ['hud:resize-start', this._onResizeStart],
      ['hud:resize-move', this._onResizeMove],
      ['hud:palette-exec', this._onPaletteExec],
      ['hud:palette-close', this._onPaletteClose],
      ['hud:palette-open-request', this._onPaletteOpenRequest],
    ];
    for (const [channel, fn] of ipcPairs) {
      if (fn) ipcMain.removeListener(channel, fn);
    }

    if (this._reclamp) {
      screen.removeListener('display-added', this._reclamp);
      screen.removeListener('display-removed', this._reclamp);
      screen.removeListener('display-metrics-changed', this._reclamp);
    }

    if (this._collapseTimer) {
      clearTimeout(this._collapseTimer);
      this._collapseTimer = null;
    }
  }
}

module.exports = HudWindow;
