'use strict';

// ---------------------------------------------------------------------------
// web-preload — preload for the EMBEDDED DSH Web UI (WebContentsView).
//
// Runs before the page scripts of whatever URL that view loads (token URL,
// clean URL, or the local error page). Exposes:
//   - window.webBridge : error-page actions (retry / start DSH)
//   - window.dshDesktop : OPT-IN minimal stub (DSH_HUD_DESKTOP_STUB=1)
// ---------------------------------------------------------------------------

const { contextBridge, ipcRenderer } = require('electron');

// Opt-in (DSH_HUD_DESKTOP_LAYOUT=1): force the UI's "Windows desktop" branch.
// The layout plugin computes `drawer = viewport < 768 && !windowsTitlebar`, so
// at our ~472px viewport the sidebar always becomes an overlay drawer. Faking
// the titlebar attribute keeps the sidebar docked instead; compact-css.js pins
// the titlebar height to 0 so no reserved strip is added.
//
// Preloads run before the document exists, so `document.documentElement` is
// often null on the first tick — mark it again as soon as the parser creates
// the root element, otherwise the SPA renders before the flag lands.
const DESKTOP_LAYOUT = process.env.DSH_HUD_DESKTOP_LAYOUT !== '0';
function markDesktopLayout() {
  try {
    // The local error page (file:) has no layout plugin to convince and would
    // only inherit a bogus titlebar flag (t13 #20).
    if (String(location.href || '').startsWith('file:')) return true;
    if (document.documentElement) {
      document.documentElement.setAttribute('data-windows-titlebar', '');
      return true;
    }
  } catch (_) { /* keep retrying below */ }
  return false;
}
if (DESKTOP_LAYOUT) {
  if (!markDesktopLayout()) {
    const retry = () => { if (markDesktopLayout()) document.removeEventListener('readystatechange', retry); };
    document.addEventListener('readystatechange', retry);
    document.addEventListener('DOMContentLoaded', retry);
  }
}

contextBridge.exposeInMainWorld('webBridge', {
  retry: () => ipcRenderer.send('hud:web-retry'),
  startDsh: () => ipcRenderer.send('hud:web-start-dsh'),
});

// Report whether the DSH right column is on screen, so the main process can
// widen the panel outward (user 2026-11-08: the right sidebar must expand to
// the right like the left one, never as an overlay drawer that swallows the
// hotkeys). The layout plugin renders that column inline; when it is closed its
// box collapses to zero width, so a width probe is enough and does not depend
// on class names that the bundle may rename.
let lastSent = null;
let pending = null;
let pendingCount = 0;

// Read the layout's own state first: the frame element carries data-*
// attributes for the columns (the bundle writes `rightbarCollapsed` /
// `rightbarFullscreen` into its dataset), which is stable. Falling back to box
// width is what caused an open/close/open flicker loop: widening the window
// changes which layout branch the page renders, which in turn changes the
// measured width, which resizes the window again (user 2026-11-08).
function rightbarState() {
  try {
    const frame = document.querySelector('[data-rightbar-collapsed], [data-rightbar-fullscreen]');
    if (frame) {
      const collapsed = frame.getAttribute('data-rightbar-collapsed');
      if (collapsed !== null) return collapsed === 'false';
      const full = frame.getAttribute('data-rightbar-fullscreen');
      if (full !== null) return full === 'true';
    }
  } catch (_) { /* pre-DOM */ }
  try {
    const cols = document.querySelectorAll(
      '[class*="rightbar"], [class*="rightBar"], [data-slot="rightbar"]'
    );
    for (const el of cols) {
      const r = el.getBoundingClientRect();
      if (r.width > 120 && r.height > 120) return true;
    }
  } catch (_) { /* pre-DOM */ }
  return false;
}

// Require two consecutive identical readings before telling the main process:
// a single frame in between a resize is normal animation, not a state change.
function reportRightbar() {
  const open = rightbarState();
  if (open === lastSent) { pending = null; pendingCount = 0; return; }
  if (open !== pending) { pending = open; pendingCount = 1; return; }
  pendingCount += 1;
  if (pendingCount < 2) return;
  lastSent = open;
  pending = null;
  pendingCount = 0;
  try { ipcRenderer.send('hud:rightbar', open); } catch (_) { /* view gone */ }
}
setInterval(reportRightbar, 700);
document.addEventListener('DOMContentLoaded', reportRightbar);

// Theme-follow (t34): read the embedded page's light/dark theme and push it to
// the shell, which recolours the panel card, buttons and line art. Unknown or
// unreadable -> send nothing (the shell keeps its dark default); the main side
// additionally normalises any non-'light' value to 'dark' as a safety net.
// Payload is an object { theme: 'light'|'dark' } (the shell main handler also
// tolerates a bare string for backward compatibility).
let lastTheme = null;
function detectTheme() {
  try {
    const root = document.documentElement;
    const body = document.body;
    const attr = (el, name) => (el ? el.getAttribute(name) : null);

    // Priority 1: the explicit dataset.theme switch (documentElement.dataset.theme).
    const dataTheme =
      (root && root.dataset && root.dataset.theme) ||
      attr(root, 'data-theme') ||
      attr(root, 'data-ds-theme');
    if (dataTheme) return /dark/i.test(dataTheme) ? 'dark' : 'light';

    // DSH's boot script mounts data-ds-dark-theme on the body/root in dark mode (t3).
    if (attr(root, 'data-ds-dark-theme') !== null || attr(body, 'data-ds-dark-theme') !== null) {
      return 'dark';
    }

    const cls = ((root && root.className) || '') + ' ' + ((body && body.className) || '');
    if (/\bdark\b/i.test(cls) && !/\blight\b/i.test(cls)) return 'dark';
    if (/\blight\b/i.test(cls) && !/\bdark\b/i.test(cls)) return 'light';

    // Fallback: body background luminance (dark < 140). Uses the computed value
    // so it also works for pages that only style a wrapper element.
    if (body && typeof getComputedStyle === 'function') {
      const m = String(getComputedStyle(body).backgroundColor || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const lum = 0.299 * (+m[1]) + 0.587 * (+m[2]) + 0.114 * (+m[3]);
        return lum < 140 ? 'dark' : 'light';
      }
    }
  } catch (_) { /* pre-DOM */ }
  return null;
}
function reportTheme() {
  const theme = detectTheme();
  if (!theme || theme === lastTheme) return;
  lastTheme = theme;
  try { ipcRenderer.send('hud:web-theme', { theme }); } catch (_) { /* view gone */ }
}
setInterval(reportTheme, 700);
document.addEventListener('DOMContentLoaded', reportTheme);
// Re-report promptly when the theme attribute/class flips (instead of waiting up
// to the next 700ms poll tick). DSH toggles data-theme / data-ds-dark-theme /
// class on <html> and <body>, so watch both. Side-channel only: never blocks
// the WebContentsView from loading.
if (typeof MutationObserver === 'function') {
  try {
    const observer = new MutationObserver(reportTheme);
    const opts = { attributes: true, attributeFilter: ['data-theme', 'data-ds-theme', 'data-ds-dark-theme', 'class'] };
    observer.observe(document.documentElement, opts);
    if (document.body) observer.observe(document.body, opts);
  } catch (_) { /* observer unsupported */ }
}

// The DSH Web UI references `dshDesktop` ONLY through guarded checks —
// `"dshDesktop" in globalThis` and `window.dshDesktop?.fileActions` — and falls
// back to web mode when it is absent. That absent case is exactly how the UI
// runs in a normal browser, so the stub is OFF by default.
//
// DSH_HUD_DESKTOP_STUB=1 exposes a minimal placeholder (experimental) for
// future desktop integrations. Property names below are the four actually
// referenced in the client bundles (combo-1.js): fileActions, deviceInfo,
// shortcuts, keyboard.
if (process.env.DSH_HUD_DESKTOP_STUB === '1') {
  const noop = () => {};
  contextBridge.exposeInMainWorld('dshDesktop', {
    platform: 'win32',
    fileActions: {},
    deviceInfo: null,
    shortcuts: {},
    keyboard: {},
    openExternal: noop,
    showItemInFolder: noop,
  });
}
