'use strict';

// ---------------------------------------------------------------------------
// WebEmbed — embeds the DSH Web UI into the panel via a WebContentsView.
//
// t6 responsibilities:
//   - load the discovery token URL once (mints the auth cookie), then switch
//     to the clean URL for subsequent loads (cookie auth)
//   - persistent session partition (`persist:dsh-web`) so cookies / localStorage
//     survive across app restarts
//   - inject the compact/theme CSS (src/compact-css.js) per t3
//   - OPT-IN window.dshDesktop stub (renderer/web-preload.js, default OFF)
//   - self-drawn error page on unreachable / 401 (retry / start DSH)
//   - devtools only when DSH_HUD_DEV=1
//
// The WebContentsView is a native child of the BrowserWindow's contentView and
// is positioned over the shell's #web-host region. It is attached when the
// panel opens and detached (kept alive) when the panel collapses.
// ---------------------------------------------------------------------------

const { WebContentsView, session, shell, app } = require('electron');
const path = require('path');
const fs = require('fs');

const { WEB_PARTITION } = require('./constants');
const { readDiscovery, tokenUrl, cleanUrl, ageMs } = require('./discovery');
const { getCompactCss } = require('./compact-css');

const WEB_PRELOAD = path.join(__dirname, '..', 'renderer', 'web-preload.js');
const ERROR_PAGE = path.join(__dirname, '..', 'renderer', 'error.html');

class WebEmbed {
  constructor(win) {
    this.win = win;
    this.view = null;
    this.bounds = null;        // last reported {x,y,width,height} from the shell
    this.attached = false;
    this.bootstrapped = false; // true after the first token URL authenticated
    this.lastKind = null;      // 'token' | 'clean' | 'error'
    this._cssInjected = false;
    this._tokenRetried = false; // one token-URL retry per 401 episode
    this._wired = false;
    // Error-page auto-recovery: after a reboot the HUD can start before DSH is
    // up (stale/absent discovery.json). Poll the file and reconnect as soon as
    // the token bridge rewrites it, instead of waiting for a manual 「重试」.
    this._recoveryTimer = null;
    this._recoverySeen = null;
    this._recoveryTicks = 0;
    this._recovering = false;  // one recovery episode at a time (t21 #3)
    this.onEscape = null;      // invoked when Esc is pressed inside the view
    this.onLoaded = null;      // invoked after each non-error top-level load
    this.onTheme = null;       // invoked when the embedded page's theme changes (t31)
    this.theme = null;         // 'light' | 'dark' | null (unknown)
    this.onCommand = null;     // invoked when Ctrl+K opens the command palette (t35)
  }

  create() {
    if (this.view) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        preload: WEB_PRELOAD,
        partition: WEB_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        // Match the --no-sandbox launch flag (README-ENV.md §0); keeps the
        // preload's require('electron') surface identical to the shell's.
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    // Transparent background so the shell panel-card (gradient + rounded
    // corners + drop shadow) shows through wherever the Web UI is transparent.
    if (typeof view.setBackgroundColor === 'function') {
      view.setBackgroundColor('#00000000');
    }

    this.view = view;
    this._wireEvents();
    return view;
  }

  _wireEvents() {
    if (this._wired) return;
    this._wired = true;

    const wc = this.view.webContents;

    // External links must never navigate the panel: the page runs with our
    // preload (window.webBridge), so handing that surface to an arbitrary web
    // origin would be a privilege leak. Popups are always denied and handed to
    // the OS browser instead (t13 #3).
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) {
        shell.openExternal(url).catch(() => { /* best effort */ });
      }
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event, url) => {
      if (this._isAllowedNav(url)) return;
      event.preventDefault();
      if (/^https?:/i.test(url)) {
        shell.openExternal(url).catch(() => { /* best effort */ });
      }
    });

    // Esc inside the embedded UI must still collapse the panel. The shell
    // window's own before-input-event only fires for the shell's webContents,
    // so the view needs its own handler.
    //
    // Opt-in on purpose: DSH itself uses Esc to close its own dialogs, and the
    // view cannot tell whether the page already consumed the key, so hijacking
    // it unconditionally made every Esc close the panel too (t13 #13).
    if (process.env.DSH_HUD_WEB_ESC === '1') {
      wc.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape' && this.onEscape) {
          event.preventDefault();
          this.onEscape();
        }
      });
    }

    // Ctrl+K is a HUD command (open the command palette), not a DSH page key,
    // so it is captured unconditionally. Unlike Esc it never conflicts with a
    // page-level action the view cannot detect (t35).
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.key === 'k' || input.key === 'K')
          && (input.control || input.meta) && this.onCommand) {
        event.preventDefault();
        this.onCommand();
      }
    });

    // Opt-in click diagnostics (DSH_HUD_DEBUG_CLICKS=1). The embedded page
    // reports every mousedown target it receives; that distinguishes a really
    // dead region from one merely covered by shell chrome. Lines are printed to
    // stdout AND appended to DSH_HUD_CLICK_LOG when that env var is set.
    if (process.env.DSH_HUD_DEBUG_CLICKS === '1') {
      const clickLog = process.env.DSH_HUD_CLICK_LOG || '';
      wc.on('console-message', (_e, a, b) => {
        // Electron >= 32 passes (event, details); older releases pass
        // (event, level, message, line, sourceId).
        const message = a && typeof a === 'object' ? a.message : (typeof a === 'number' ? b : a);
        if (!message || message.indexOf('[hud-click]') === -1) return;
        console.log(message);
        if (clickLog) {
          try { fs.appendFileSync(clickLog, message + '\n'); } catch (_) { /* best effort */ }
        }
      });
      wc.on('did-finish-load', () => {
        const script = [
          '(function () {',
          '  if (window.__hudClickDebug) return; window.__hudClickDebug = true;',
          '  function rect(el) {',
          '    if (!el) return "none";',
          '    var r = el.getBoundingClientRect();',
          '    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(",");',
          '  }',
          '  document.addEventListener("mousedown", function (e) {',
          '    var el = e.target;',
          '    var cls = el && typeof el.className === "string" ? el.className.slice(0, 70) : "";',
          '    var at = document.elementFromPoint(e.clientX, e.clientY);',
          '    var hitCls = at && typeof at.className === "string" ? at.className.slice(0, 50) : "";',
          '    var frame = document.querySelector("[class*=\\"_frame\\"]");',
          '    var sidebar = document.querySelector("[class*=\\"sidebarCol\\"]");',
          '    var mask = document.querySelector("[class*=\\"drawerMask\\"]");',
          '    var maskPe = mask ? getComputedStyle(mask).pointerEvents : "none";',
          '    console.log("[hud-click] " + e.clientX + "," + e.clientY +',
          '      " tag=" + (el && el.tagName) + " cls=" + cls +',
          '      " | hit=" + (at && at.tagName) + "." + hitCls +',
          '      " | frame=" + (frame ? JSON.stringify(frame.dataset) : "none") +',
          '      " | sidebar=" + rect(sidebar) +',
          '      " | mask=" + (mask ? maskPe + " " + rect(mask) : "none"));',
          '  }, true);',
          '})();',
        ].join('\n');
        wc.executeJavaScript(script).catch(() => { /* page may forbid eval */ });
      });
    }

    wc.on('did-finish-load', () => {
      if (this.lastKind === 'error') return; // local error page: no CSS injection
      this._injectCss();
      // A completed top-level load that was not an error page means the token
      // URL (or the clean URL with the cookie) authenticated successfully.
      this.bootstrapped = true;
      this._tokenRetried = false; // a fresh authenticated document resets the budget
      this._stopRecovery();
      if (process.env.DSH_HUD_DEV === '1') {
        wc.openDevTools({ mode: 'detach' });
      }
      // Keep sampling the top strip: the SPA shows the workspace picker first
      // and only renders the conversation header after the user enters a
      // session, which can happen minutes later. Dev-only, cheap, and it stops
      // on its own (30 samples x 10s).
      let samples = 0;
      const timer = setInterval(() => {
        samples += 1;
        try { this._maybeDumpTopRight(wc); } catch { /* detached */ }
        if (samples >= 30) clearInterval(timer);
      }, 10_000);
      // Dev-only instrumentation must never keep the process alive (unit tests
      // load this module and would otherwise wait the full 5-minute window).
      if (typeof timer.unref === 'function') timer.unref();
      this._dumpTimer = timer;
      if (this.onLoaded) this.onLoaded();
    });

    // Network-level failures (unreachable port / DNS) — NOT HTTP status codes.
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      // -3 == ERR_ABORTED (navigation superseded) — ignore.
      if (!isMainFrame || code === -3) return;
      console.error('[hud] web did-fail-load', code, desc, url);
      this.showError('unreachable', `${desc} (${code})`);
    });

    // HTTP errors (401 etc.) are valid responses, so did-fail-load never fires
    // for them; catch them on the main frame via webRequest.
    const ses = session.fromPartition(WEB_PARTITION);
    ses.webRequest.onCompleted((details) => {
      if (details.resourceType !== 'mainFrame') return;
      const status = details.statusCode;
      if (status < 400) return;

      if (status === 401 && this.lastKind === 'clean' && !this._tokenRetried && this._hasDiscovery()) {
        // The cookie went stale/invalid while we were on the clean URL. The
        // plugin refreshes discovery every 15s, so retry once with whatever
        // token is on disk REGARDLESS of its age: an expired token simply 401s
        // again and lands on the error page, while the old 60s age gate turned
        // perfectly good tokens into a hard error (t13 #8).
        this._tokenRetried = true;
        this.reload({ forceToken: true });
        return;
      }
      this.showError(status === 401 ? 'auth' : 'http', `HTTP ${status}`);
    });
  }

  _hasDiscovery() {
    const d = readDiscovery();
    return !!(d && d.url);
  }

  // One-shot DOM dump of the page's top-right corner (DSH_HUD_DUMP_DOM=1).
  // Written for UI work: it tells us exactly which elements render that faint
  // cluster of window-control glyphs, so the hide rule can be a real selector
  // instead of a guess.
  _maybeDumpTopRight(wc) {
    // Dev builds dump on their own (no env needed); packaged builds never do.
    if (process.env.DSH_HUD_DUMP_DOM === '0') return;
    // Packaged builds stay silent unless the dump is asked for explicitly
    // (DSH_HUD_DUMP_DOM=1), which is how UI selectors get captured from the
    // real build instead of the dev checkout.
    if (app && app.isPackaged && process.env.DSH_HUD_DUMP_DOM !== '1') return;
    if (typeof wc.executeJavaScript !== 'function') return; // test doubles
    const script = `(() => {
      const W = window.innerWidth;
      const hits = [];
      const seen = new Set();
      const region = { x: 0, y: 0, w: W, h: 96 };
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.right < region.x || r.left > W || r.bottom < 0 || r.top > region.h) continue;
        const key = el.tagName + '|' + el.className + '|' + Math.round(r.x) + ',' + Math.round(r.y);
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({
          tag: el.tagName.toLowerCase(),
          cls: typeof el.className === 'string' ? el.className : '',
          id: el.id || '',
          role: el.getAttribute('role') || '',
          title: el.getAttribute('title') || '',
          aria: el.getAttribute('aria-label') || '',
          text: (el.textContent || '').trim().slice(0, 40),
          rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          // data-* carries the layout's own column state (e.g.
          // data-rightbar-collapsed) — needed to stop guessing from widths.
          data: Array.from(el.attributes)
            .filter((a) => a.name.indexOf('data-') === 0)
            .slice(0, 8)
            .map((a) => a.name + '=' + a.value),
        });
        if (hits.length >= 120) break;
      }
      return { url: location.href, width: W, dpr: window.devicePixelRatio, hits };
    })()`;
    wc.executeJavaScript(script)
      .then((data) => {
        const repoRoot = process.env.DSH_HUD_APP_DIR
          ? path.dirname(process.env.DSH_HUD_APP_DIR)
          : path.resolve(__dirname, '..', '..');
        const out = path.join(process.env.DSH_HUD_ARTIFACTS || path.join(repoRoot, 'artifacts'), 'embed-dom.json');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(data, null, 2));
        console.log('[hud] top-right DOM dump written:', out);
      })
      .catch((err) => console.error('[hud] DOM dump failed:', err && err.message));
  }

  _injectCss() {
    if (this._cssInjected) return;
    this._cssInjected = true;
    // DSH_HUD_COMPACT_CSS=0 renders the Web UI exactly as its theme/plugins
    // design it: no transparent background, no hidden rightbar, no clipping.
    // Use it when a UI theme plugin should own the whole look, or when the
    // compact rules fight a theme's own !important declarations.
    if (process.env.DSH_HUD_COMPACT_CSS === '0') {
      console.log('[hud] compact CSS disabled (DSH_HUD_COMPACT_CSS=0)');
      return;
    }
    this.view.webContents.insertCSS(getCompactCss()).catch((err) => {
      console.error('[hud] insertCSS failed:', err && err.message);
    });
  }

  // Resolve the next URL. Cold start / forced => token URL; after bootstrap =>
  // clean URL (cookie auth). Returns null when there is nothing to load.
  _resolveTarget(forceToken) {
    const d = readDiscovery();
    if (d && d.url) {
      if (forceToken || !this.bootstrapped) {
        return { url: tokenUrl(d), kind: 'token' };
      }
      return { url: cleanUrl(d) || tokenUrl(d), kind: 'clean' };
    }
    return null;
  }

  // ---- lifecycle (driven by HudWindow) ----

  // In-page navigation is only allowed within the DSH server's own origin.
  // Anything else is blocked and (for http/https) handed to the OS browser.
  _isAllowedNav(url) {
    try {
      const target = new URL(url);
      const d = readDiscovery();
      const base = d && (cleanUrl(d) || d.url);
      if (!base) return false;
      return target.origin === new URL(base).origin;
    } catch {
      return false;
    }
  }

  attach() {
    if (!this.view) this.create();
    if (this.attached) return;
    this.win.contentView.addChildView(this.view);
    this.attached = true;
    if (this.bounds) this.view.setBounds(this.bounds);
  }

  detach() {
    this._stopDump();
    // Stop the recovery poll while the view is hidden: reloading makes no sense
    // when the panel is collapsed. Idempotent; a fresh episode restarts on the
    // next showPanel() -> load() if the error page persists (t20 #8).
    this._stopRecovery();
    if (!this.view || !this.attached) return;
    // Mark detached first: if the native call throws we must not retry it.
    this.attached = false;
    // On quit the BrowserWindow is destroyed before this runs, and its
    // contentView is then an invalid native object: removeChildView() throws
    // "Object has been destroyed" (regression caught by the user on 2026-11-06).
    if (!this.win || (typeof this.win.isDestroyed === 'function' && this.win.isDestroyed())) return;
    try {
      this.win.contentView.removeChildView(this.view);
    } catch (err) {
      console.error('[hud] detach failed:', err && err.message);
    }
  }

  setBounds(b) {
    this.bounds = b;
    if (this.view && this.attached && b) this.view.setBounds(b);
  }

  load({ forceToken = false } = {}) {
    if (!this.view) this.create();
    const target = this._resolveTarget(forceToken);
    if (!target) {
      this.showError('unreachable', '未找到 discovery.json（DSH 服务可能未启动）');
      return;
    }
    this.lastKind = target.kind;
    this._cssInjected = false; // re-inject on the fresh document
    this.view.webContents.loadURL(target.url).catch((err) => {
      console.error('[hud] loadURL failed:', err && err.message);
      this.showError('unreachable', err && err.message);
    });
  }

  reload({ forceToken = false } = {}) {
    this.load({ forceToken });
  }

  showError(kind, detail) {
    if (!this.view) this.create();
    this.lastKind = 'error';
    this.view.webContents
      .loadFile(ERROR_PAGE, { query: { kind, detail: detail || '' } })
      .catch((err) => {
        console.error('[hud] error page load failed:', err && err.message);
      });
    this._startRecovery();
  }

  // Poll discovery.json while the error page is up. Reconnect when the file
  // changes (new port after a reboot / plugin re-apply) or, failing that, every
  // ~30s for a while so a restarted DSH on the same port is picked up too.
  //
  // Only ONE episode runs at a time. showError() re-enters this method on every
  // failed reload (did-fail-load -> showError -> _startRecovery); a re-entrant
  // call must NOT reset the tick counter, otherwise the cap below never fires
  // and the error page keeps reloading forever (t21 #3).
  _startRecovery() {
    const fresh = !this._recovering;
    this._recovering = true;
    this._stopRecoveryTimer();
    if (fresh) {
      this._recoveryTicks = 0;
      this._recoverySeen = null;
      const d0 = readDiscovery();
      if (d0 && d0.url) this._recoverySeen = `${d0.url}|${d0.updatedAt || ''}`;
    }
    this._recoveryTimer = setInterval(() => {
      this._recoveryTicks += 1;
      // 360 ticks * 5s = 30 min: the HUD may start at logon, long before
      // DSH finishes booting its web server.
      if (this._recoveryTicks > 360) {
        this._stopRecovery();
        return;
      }
      const d = readDiscovery();
      const key = d && d.url ? `${d.url}|${d.updatedAt || ''}` : '';
      if (!key) return;
      const changed = this._recoverySeen === null || key !== this._recoverySeen;
      if (changed || this._recoveryTicks % 6 === 0) {
        this._recoverySeen = key;
        console.log('[hud] discovery changed; reconnecting');
        // Clear the interval for the reload but KEEP the episode flag, so the
        // tick counter survives the round-trip through showError().
        this._stopRecoveryTimer();
        this.reload({ forceToken: true });
      }
    }, 5000);
    if (this._recoveryTimer.unref) this._recoveryTimer.unref();
  }

  _stopRecoveryTimer() {
    if (this._recoveryTimer) {
      clearInterval(this._recoveryTimer);
      this._recoveryTimer = null;
    }
  }

  _stopDump() {
    if (this._dumpTimer) {
      clearInterval(this._dumpTimer);
      this._dumpTimer = null;
    }
  }

  _stopRecovery() {
    this._recovering = false;
    this._stopRecoveryTimer();
  }

  // Best-effort "start DSH": the running DSH host's token-bridge plugin owns
  // discovery, so first re-check the file; if DSH_HUD_DSH_EXE is configured,
  // spawn that launcher detached, then retry once after a short delay.
  startDsh() {
    const d = readDiscovery();
    if (d && d.url) {
      this.reload({ forceToken: true });
      return;
    }
    const exe = process.env.DSH_HUD_DSH_EXE;
    if (exe) {
      try {
        const { spawn } = require('child_process');
        spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
      } catch (err) {
        console.error('[hud] startDsh spawn failed:', err && err.message);
      }
    }
    // Give the host a moment to write discovery.json, then retry once.
    setTimeout(() => this.reload({ forceToken: true }), 2000);
  }

  focus() {
    if (this.view) this.view.webContents.focus();
  }

  // Theme-follow (t31): normalise the embedded page's theme signal and forward
  // it to HudWindow (via this.onTheme). Anything that is not 'light' is treated
  // as 'dark', so a bogus/missing value can never flash the shell to a broken
  // state — it always lands on one of the two known themes.
  setEmbeddedTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    if (t === this.theme) return;
    this.theme = t;
    if (this.onTheme) this.onTheme(t);
  }

  // Drop the reference; the OS reclaims the native view when the window closes.
  destroy() {
    this._stopDump();
    this._stopRecovery();
    this.detach();
    try {
      // Test doubles and already-destroyed views may not expose isDestroyed();
      // a missing method must not turn teardown into a thrown error.
      const wc = this.view && this.view.webContents;
      const alive = wc && (typeof wc.isDestroyed !== 'function' || !wc.isDestroyed());
      if (alive && typeof wc.close === 'function') wc.close();
    } catch (err) {
      console.error('[hud] webContents close failed:', err && err.message);
    }
    this.view = null;
  }
}

module.exports = WebEmbed;
