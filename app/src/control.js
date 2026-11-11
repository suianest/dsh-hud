'use strict';

// ---------------------------------------------------------------------------
// ControlBridge — app-side control channel for the Cordis plugin (t8/t11).
//
// Two equivalent channels drive the HUD from outside:
//   1. control.json — the plugin atomically writes {seq, action, at} into the
//      SAME directory as discovery.json. We fs.watch that directory (rename
//      events) plus a polling fallback (Windows fs.watch is lossy).
//   2. stdin — newline-delimited JSON lines with the same {seq, action, at}
//      shape (used when the plugin spawns the app with a piped stdin).
//
// Both channels share one monotonic `seq` space. The highest seen seq is
// persisted to userData/control-state.json so a restart never re-executes a
// stale action. Only actions with a strictly higher seq than the last seen are
// dispatched (dedup across duplicate fs.watch fires + the poll timer + stdin).
//
//   action ∈ { toggle, show, hide, reload }
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { controlPath } = require('./discovery');
const { controlHandlers } = require('./extensions');

// Poll fallback interval (ms) — covers fs.watch event loss on Windows.
const POLL_MS = 2000;

class ControlBridge {
  constructor(handlers, { statePath } = {}) {
    // 内置动作（toggle/show/hide/reload）优先，其余来自 extensions 注册表；
    // 后续加功能只要 registerControlAction('xxx', fn) + `/dsh-hud xxx`。
    this.handlers = { ...controlHandlers(), ...(handlers || {}) };
    this.statePath = statePath || null;
    this._lastSeq = this._loadSeq();
    this._watcher = null;
    this._pollTimer = null;
    this._stdinBuf = '';
  }

  start() {
    this._watchControlFile();
    this._watchStdin();
  }

  stop() {
    if (this._watcher) {
      try { this._watcher.close(); } catch { /* ignore */ }
      this._watcher = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // ---- control.json ----

  _watchControlFile() {
    const p = controlPath();
    if (!p) return;

    // Initial read: dispatch only if the file's seq is NEWER than the persisted
    // one, so a restart does not re-run the last (already handled) action.
    this._poll(p);

    const dir = path.dirname(p);
    const base = path.basename(p);
    try {
      this._watcher = fs.watch(dir, (_event, filename) => {
        if (filename === base) this._poll(p);
      });
    } catch (err) {
      console.error('[hud] control fs.watch failed:', err && err.message);
    }

    this._pollTimer = setInterval(() => this._poll(p), POLL_MS);
  }

  _poll(p) {
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return; // missing / bad JSON / partially-written — ignore this round
    }
    this._dispatch(obj);
  }

  // ---- stdin (newline-delimited JSON) ----

  _watchStdin() {
    const input = process.stdin;
    if (!input || typeof input.on !== 'function') return;
    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      this._stdinBuf += chunk;
      let idx;
      while ((idx = this._stdinBuf.indexOf('\n')) >= 0) {
        const line = this._stdinBuf.slice(0, idx).trim();
        this._stdinBuf = this._stdinBuf.slice(idx + 1);
        if (line) this._dispatchLine(line);
      }
    });
    input.on('error', () => { /* stdin closed/disconnected — ignore */ });
    if (typeof input.resume === 'function') input.resume();
  }

  _dispatchLine(line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    this._dispatch(obj);
  }

  // ---- shared dispatch + seq dedup ----

  _dispatch(obj) {
    if (!obj || typeof obj !== 'object') return;
    const seq = Number(obj.seq);
    if (!Number.isFinite(seq)) return;
    if (seq <= this._lastSeq) return; // stale / duplicate

    const action = obj.action;
    const fn = typeof action === 'string' ? this.handlers[action] : null;
    if (typeof fn !== 'function') {
      // Validate BEFORE advancing _lastSeq: a malformed copy from one channel
      // (e.g. the old {type} payload) must not burn the seq and make the other
      // channel's valid copy of the same action look like a duplicate (t13 #2).
      console.error('[hud] unknown control action:', action);
      return;
    }
    this._lastSeq = seq;
    this._saveSeq(seq);
    fn();
  }

  _loadSeq() {
    if (!this.statePath) return -1;
    try {
      const obj = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      const n = Number(obj && obj.lastSeq);
      return Number.isFinite(n) ? n : -1;
    } catch {
      return -1;
    }
  }

  _saveSeq(seq) {
    if (!this.statePath) return;
    try {
      // Atomic write (t14 #18): tmp + rename so a crash mid-write never leaves
      // a corrupt control-state.json, which would make _loadSeq() fall back to
      // -1 and replay the last action (e.g. pop the panel on its own).
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ lastSeq: seq }), 'utf8');
      fs.renameSync(tmp, this.statePath);
    } catch (err) {
      console.error('[hud] control state save failed:', err && err.message);
    }
  }
}

module.exports = { ControlBridge };
