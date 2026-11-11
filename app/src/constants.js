'use strict';

// ---------------------------------------------------------------------------
// Window geometry & tuning constants.
//
// All dimensions/coordinates are in DIP (device-independent pixels).
// Electron is per-monitor-DPI aware: a 520x720 DIP window on a 150% display is
// 780x1080 physical pixels. BrowserWindow/screen/setPosition all speak DIP, so
// we never convert manually — that is what makes multi-monitor mixed-DPI work.
// ---------------------------------------------------------------------------

// Expanded panel: the floating card that hosts the embedded DSH Web UI.
const PANEL = Object.freeze({ width: 520, height: 720 });

// Wide panel used when the embedded DSH page opens its RIGHT sidebar (user
// 2026-11-08: expand outward to the right like the left sidebar, never a
// drawer, so the panel keeps its hotkeys). Extra 380 DIP gives the right
// column room without pushing the layout back into its narrow branch.
const PANEL_WIDE = Object.freeze({ width: PANEL.width + 380, height: PANEL.height });

// Collapsed resident capsule (悬浮胶囊). A small circular whale icon (t18):
// the square window keeps the light CSS shadow inside its transparent bounds.
const CAPSULE = Object.freeze({ width: 64, height: 64 });

// Transparent padding (DIP) around the rounded shell. It used to be 6 so the
// CSS drop-shadow had room; we no longer draw any shadow (it showed up as a
// grey square edge on the transparent window), so the shell fills the window
// exactly. Keep this in sync with `.panel-shell { padding }` in hud.css.
const SHELL_INSET = 0;

// How far a window may be dragged off-screen before we clamp it back onto a
// display work area (DIP). A little grace keeps the CSS shadow from clipping.
const CLAMP_MARGIN = 8;

// mousedown -> mouseup movement (DIP) below this is treated as a click, not a
// drag. Distinguishes "click capsule = expand" from "drag capsule = move".
const CLICK_THRESHOLD = 4;

// A capsule released this close to a work-area edge (DIP) snaps to that edge.
const EDGE_SNAP_DISTANCE = 24;

// Debounce (ms) before a drag position is flushed to window-state.json.
const SAVE_DEBOUNCE_MS = 400;

// window-state.json schema version.
const STATE_VERSION = 1;

// File name inside app.getPath('userData').
const STATE_FILE = 'window-state.json';

// ---------------------------------------------------------------------------
// Global hotkey (capsule <-> panel toggle). Configurable; persisted in
// userData/hotkey.json as { "accelerator": "..." }. Electron accelerator
// syntax — Control+Alt+Space maps to Ctrl+Alt+Space on Windows.
// ---------------------------------------------------------------------------
const DEFAULT_ACCELERATOR = 'Control+Alt+Space';
const HOTKEY_FILE = 'hotkey.json';

// Expand/collapse CSS animation timing (ms). These must match the CSS
// `animation` durations in renderer/hud.css.
const ANIM_EXPAND_MS = 180;
const ANIM_COLLAPSE_MS = 140;

// Main-side fallback (ms): if the renderer never answers `hud:collapse-done`
// (crashed / hung), force the collapse anyway so the window can't get stuck.
const COLLAPSE_FORCE_TIMEOUT_MS = 280;

// ---------------------------------------------------------------------------
// Embedded Web UI (t6). Persistent session partition so the auth cookie and
// localStorage survive across app restarts (Chromium persists cookies that
// carry an explicit expiry; the DSH dsh-auth cookie is a session cookie, so on
// cold start we re-bootstrap via a fresh token URL from discovery.json).
// ---------------------------------------------------------------------------
const WEB_PARTITION = 'persist:dsh-web';

module.exports = {
  PANEL,
  PANEL_WIDE,
  CAPSULE,
  SHELL_INSET,
  CLAMP_MARGIN,
  CLICK_THRESHOLD,
  EDGE_SNAP_DISTANCE,
  SAVE_DEBOUNCE_MS,
  STATE_VERSION,
  STATE_FILE,
  DEFAULT_ACCELERATOR,
  HOTKEY_FILE,
  ANIM_EXPAND_MS,
  ANIM_COLLAPSE_MS,
  COLLAPSE_FORCE_TIMEOUT_MS,
  WEB_PARTITION,
};
