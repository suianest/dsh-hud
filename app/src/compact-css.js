'use strict';

// ---------------------------------------------------------------------------
// compact-css — CSS injected into the embedded DSH Web UI via
// webContents.insertCSS(). Source: docs/embed-feasibility.md §4 (t3).
//
// Selector policy: bundle class names are hashed and version-unstable, so we
// anchor on stable attributes ([data-phase], [data-slot]) or substring
// matches ([class*="widthHandle"]). CSS variables are preferred where the
// upstream exposes one.
//
// The `.hud-drag` app-region band from t3 §C6 is intentionally OMITTED: the
// HUD shell's panel header is the drag handle, so no in-page drag band is
// needed. C3 step 2 (header height reduction) and C7 (skin override) are also
// deferred until a gate screenshot confirms they are necessary.
// ---------------------------------------------------------------------------

const COMPACT_CSS = `
/* C2 — hide the conversation width-drag handle (negative width at 520) */
[class*="widthHandle"] { display: none !important; }

/* C4 — thin scrollbars; the app owns its own scroll container (no second scroll) */
* { scrollbar-width: thin; }
html, body { overflow: hidden !important; height: 100%; }
::-webkit-scrollbar { width: 6px; height: 6px; }

/* C5 — the right column is NOT hidden any more (user 2026-11-08): the panel
   widens to PANEL_WIDE (900 DIP) when this column opens, so its entries can be
   used instead of being dead UI at 520 DIP. Keeping it in the DOM is also what
   lets web-preload.js detect the open/closed state from its box width. */

/* C6 — transparent body + rounded content background (transparent window).
   t19: 'overflow: hidden' was removed from #root/[class*=frame] because it
   clipped the DSH page's top-left sidebar toggle against the 14px radius.
   'border-radius' alone still rounds the page's own background (so it blends
   into the shell card) WITHOUT clipping its child controls. The outer rounded
   panel edge is the shell .panel-card's job. */
html, body { background: transparent !important; }
#root, [class*="frame"] { border-radius: 14px; }

/* C1 — tighten chat content width via the upstream override variable.
   (--dsh-chat-content-width is declared ON the body element itself, so writing
   it on ancestors is a no-op; --dsh-chat-user-width is the real hook.) */
:root { --dsh-chat-user-width: min(calc(100vw - 80px), 680px); }

/* C3 step 1 — tighten header horizontal padding (safe; do not reduce height
   until a gate screenshot confirms a single-line header) */
[data-phase] :where([class*="header"]) { padding-right: 12px !important; padding-left: 12px !important; }

/* C8 - only with DSH_HUD_DESKTOP_LAYOUT=1 (preload sets data-windows-titlebar
   so the narrow-width sidebar stays docked instead of becoming a drawer).
   Zero the reserved titlebar strip so the layout branch is the only effect. */
html[data-windows-titlebar] { --dsh-windows-titlebar-height: 0px !important; }

/* C9 - the narrow-width drawer backdrop sits above the sidebar rail and swallows
   every click (elementFromPoint -> .drawerMask), so the sidebar looks dead.
   Make it non-hit-testable; the sidebar column itself stays interactive. */
[class*="drawerMask"] { pointer-events: none !important; opacity: 0 !important; background: transparent !important; }
[class*="sidebarCol"] { pointer-events: auto !important; }
`;

const { extraCss } = require('./extensions');

// 扩展点 3：其它模块 registerCss(id, css) 追加的样式合并到基础样式之后，
// 这样后注册的规则天然覆盖基础规则（同优先级时后者胜出）。
function getCompactCss() {
  const extra = extraCss();
  return extra ? `${COMPACT_CSS}\n\n${extra}` : COMPACT_CSS;
}

module.exports = { COMPACT_CSS, getCompactCss };
