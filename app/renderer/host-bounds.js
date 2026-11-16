'use strict';

// ---------------------------------------------------------------------------
// readHostBounds — pure layout-rect measurement shared by the shell renderer
// (browser) and the headless unit tests (Node).
//
// Why not just getBoundingClientRect()? During the expand animation the
// panel-card carries a scale(0.97 -> 1) translateY(-6px -> 0) transform;
// getBoundingClientRect() returns the *transformed* rect mid-animation, so the
// WebContentsView would end up sized ~3% too small and offset by up to 6px if
// it were measured then (t21 #3 / t30). offsetWidth and offsetHeight are layout
// sizes and ignore CSS transforms, so the reported width/height stay exact even
// mid-animation.
//
// x/y still come from getBoundingClientRect(): the shell measures them before
// the animation starts and re-measures on animationend (see hud.js), when no
// transform is applied.
// ---------------------------------------------------------------------------

function readHostBounds(el) {
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  if (width <= 0 || height <= 0) return null; // not laid out yet (display:none)
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width,
    height,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { readHostBounds };
} else if (typeof window !== 'undefined') {
  window.__readHostBounds = readHostBounds;
}
