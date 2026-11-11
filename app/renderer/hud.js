'use strict';

// ---------------------------------------------------------------------------
// Renderer logic: manual drag (screen-coordinate based) + state sync +
// expand/collapse animation + web-host bounds reporting.
//
// The capsule icon and panel header are drag handles. Manual drag (rather than
// CSS -webkit-app-region) lets us distinguish a click (expand) from a drag
// (move) on the capsule, and avoids the "no click events on drag regions"
// limitation of app-region.
//
// On entering panel mode the renderer measures #web-host (the region the
// WebContentsView will overlay) and reports it to main via hud.reportWebBounds.
// The DSH Web UI owns its own composer, so the shell has no input bar.
// ---------------------------------------------------------------------------

(function () {
  const CLICK_THRESHOLD = 4; // DIP, must match constants.CLICK_THRESHOLD
  const hud = window.hud;

  if (!hud) return; // preload failed — nothing we can do

  const body = document.body;
  const capsuleDrag = document.getElementById('capsule-drag');
  const panelDrag = document.getElementById('panel-drag');
  const panelCollapse = document.getElementById('panel-collapse');
  const panelClose = document.getElementById('panel-close');
  const panelCommand = document.getElementById('panel-command');
  const panelCard = document.getElementById('panel-card');
  const webHost = document.getElementById('web-host');
  const palette = document.getElementById('palette');
  const paletteInput = document.getElementById('palette-input');
  const paletteList = document.getElementById('palette-list');
  const capsuleIcon = document.getElementById('capsule-drag');

  function reportWebBounds() {
    if (!webHost) return;
    // readHostBounds (host-bounds.js) uses offsetWidth/offsetHeight for size so
    // the report stays exact even while the expand animation's scale transform
    // is in flight (t21 #3). Returns null while the panel is not laid out.
    const b = window.__readHostBounds(webHost);
    if (!b) return;
    hud.reportWebBounds(b);
  }

  // Keep the embedded WebContentsView aligned whenever #web-host changes size,
  // not only when the panel opens: a DPI change, an OS-driven resize, or a font
  // reflow would otherwise leave the native view stuck at its old rect.
  let resizeScheduled = false;
  function scheduleReport() {
    if (resizeScheduled) return;
    resizeScheduled = true;
    requestAnimationFrame(() => {
      resizeScheduled = false;
      reportWebBounds();
    });
  }
  if (webHost && typeof ResizeObserver === 'function') {
    new ResizeObserver(scheduleReport).observe(webHost);
  }
  window.addEventListener('resize', scheduleReport);

  function setMode(mode) {    body.classList.toggle('state-capsule', mode === 'capsule');
    body.classList.toggle('state-panel', mode === 'panel');
    if (mode === 'panel') {
      // Measure BEFORE the expand animation applies its scale transform (t21 #3):
      // at this point #panel is displayed and laid out, but .anim-expand has not
      // been added yet, so getBoundingClientRect() returns the true layout rect.
      requestAnimationFrame(() => {
        reportWebBounds();
        playExpand();
      });
    } else {
      panelCard.classList.remove('anim-expand', 'anim-collapse');
    }
  }

  // 展开动画：先移除旧类 + 强制 reflow，保证连续展开时动画能重放。
  function playExpand() {
    panelCard.classList.remove('anim-expand', 'anim-collapse');
    void panelCard.offsetWidth;
    panelCard.classList.add('anim-expand');
  }

  // 收起动画：由主进程 hud:collapse-anim 触发，播完通知主进程缩窗。
  function playCollapse() {
    panelCard.classList.remove('anim-expand');
    void panelCard.offsetWidth;
    panelCard.classList.add('anim-collapse');
  }

  // 胶囊边缘吸附提示（t35）：拖拽期间在最近的工作区边显示 2px 高亮，吸附后
  // 淡出。只在 renderer 用 CSS class 切换；主进程仍负责最终 setPosition。
  // 用 window.screen 的 avail* 作近似（当前显示器的可用区，DIP）。
  const SNAP_DISTANCE = 24; // DIP，须与 constants.EDGE_SNAP_DISTANCE 一致
  let snapFadeTimer = null;
  function updateSnapHint() {
    if (!capsuleIcon) return;
    const s = window.screen || {};
    const left = typeof s.availLeft === 'number' ? s.availLeft : 0;
    const top = typeof s.availTop === 'number' ? s.availTop : 0;
    const right = left + (typeof s.availWidth === 'number' ? s.availWidth : window.outerWidth);
    const bottom = top + (typeof s.availHeight === 'number' ? s.availHeight : window.outerHeight);
    const w = window.outerWidth || window.innerWidth;
    const h = window.outerHeight || window.innerHeight;
    const dist = {
      left: window.screenX - left,
      top: window.screenY - top,
      right: right - (window.screenX + w),
      bottom: bottom - (window.screenY + h),
    };
    let edge = null;
    let best = Infinity;
    for (const [k, d] of Object.entries(dist)) {
      if (d <= SNAP_DISTANCE && d < best) { best = d; edge = k; }
    }
    capsuleIcon.classList.toggle('capsule-snap-left', edge === 'left');
    capsuleIcon.classList.toggle('capsule-snap-right', edge === 'right');
    capsuleIcon.classList.toggle('capsule-snap-top', edge === 'top');
    capsuleIcon.classList.toggle('capsule-snap-bottom', edge === 'bottom');
  }
  function scheduleSnapFade() {
    if (snapFadeTimer) clearTimeout(snapFadeTimer);
    snapFadeTimer = setTimeout(() => {
      snapFadeTimer = null;
      if (capsuleIcon) {
        capsuleIcon.classList.remove('capsule-snap-left', 'capsule-snap-right',
          'capsule-snap-top', 'capsule-snap-bottom');
      }
    }, 180);
  }

  function attachDrag(handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let offsetX = 0;
    let offsetY = 0;
    let moved = false;

    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      // Never start a drag on an interactive child (close / collapse buttons):
      // their mousedown bubbles up here and would otherwise turn a click into
      // a drag (t13 #5/#6).
      if (e.target.closest('button, [role="button"], .panel-btn')) return;
      dragging = true;
      moved = false;
      startX = e.screenX;
      startY = e.screenY;
      // Cursor offset within the window content (clientX/clientY are CSS px ==
      // DIP, stable across displays). Main derives the absolute position from
      // screen.getCursorScreenPoint() - offset, so the window no longer jumps
      // when crossing displays with different scale factors (t14 #12).
      offsetX = e.clientX;
      offsetY = e.clientY;
      hud.dragStart({ offsetX, offsetY });
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      // The button may be released outside the window, where no mouseup is
      // delivered; without this the window keeps following the cursor forever
      // (t13 #4).
      if ((e.buttons & 1) === 0) {
        dragging = false;
        hud.dragEnd({ moved });
        scheduleSnapFade();
        return;
      }
      const dx = e.screenX - startX;
      const dy = e.screenY - startY;
      if (!moved && Math.hypot(dx, dy) > CLICK_THRESHOLD) moved = true;
      // Main positions the window from the cursor; the renderer only signals
      // "still dragging" (t14 #12).
      if (moved) {
        hud.dragMove({});
        updateSnapHint();
      }
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      hud.dragEnd({ moved });
      scheduleSnapFade();
    });
  }

  // The panel header moves the window natively via -webkit-app-region: drag
  // (see hud.css), so only the capsule needs the manual drag implementation —
  // binding both to the same header produced double drags and phantom
  // dragStart on button clicks (t13 #5/#6).
  attachDrag(capsuleDrag);

  panelClose.addEventListener('click', () => hud.quit());
  panelCollapse.addEventListener('click', () => hud.collapse());

  // 收起动画握手：播完 collapse-out 后告诉主进程执行真正的缩窗。
  panelCard.addEventListener('animationend', (e) => {
    if (e.animationName === 'collapse-out') {
      panelCard.classList.remove('anim-collapse');
      hud.collapseDone();
    } else if (e.animationName === 'expand-in') {
      panelCard.classList.remove('anim-expand');
      // t21 #3: re-measure after the transform is removed so the final rect is
      // exact (belt-and-suspenders for any frame where the measurement raced
      // the animation).
      reportWebBounds();
    }
  });

  hud.onCollapseAnim(() => playCollapse());

  // --- manual edge resize ---------------------------------------------------
  // Two invisible 8 DIP strips on the panel's left/right edges. Pressing on one
  // starts a resize session in main (which follows the cursor itself, since the
  // pointer may leave the window); releasing ends it. No hover behaviour: the
  // window must never grow on its own (user 2026-11-08).
  for (const side of ['left', 'right', 'top', 'bottom']) {
    const grip = document.createElement('div');
    grip.className = `edge-grip edge-grip-${side}`;
    grip.setAttribute('aria-hidden', 'true');
    let origin = null;
    grip.addEventListener('pointerdown', (e) => {
      if (!body.classList.contains('state-panel')) return;
      e.preventDefault();
      e.stopPropagation();
      try { grip.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      origin = { x: e.screenX, y: e.screenY };
      window.hud.resizeStart(side);
    });
    // Report pointer deltas (DIP) instead of letting main poll the cursor:
    // polling made the window grow without bound on real Windows (2026-11-10).
    grip.addEventListener('pointermove', (e) => {
      if (!origin) return;
      window.hud.resizeMove({ dx: e.screenX - origin.x, dy: e.screenY - origin.y });
    });
    const stop = (e) => {
      origin = null;
      try { grip.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      window.hud.resizeEnd();
    };
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);
    document.body.appendChild(grip);
  }

  // --- 命令面板（t35） -----------------------------------------------------
  // 主进程打开前会 web.detach() 让出 DOM 层；renderer 只渲染 {id,label}，
  // 真正的动作 handler 都在主进程（hud.paletteExec 发 id 回去）。
  panelCommand.addEventListener('click', () => hud.paletteOpen());

  let paletteAll = [];       // 全部条目 [{id,label}]
  let paletteRendered = [];  // 当前过滤后 [{id,label}]
  let paletteSelected = 0;

  function renderPalette() {
    const q = (paletteInput.value || '').trim().toLowerCase();
    paletteRendered = paletteAll.filter((it) => (it.label || '').toLowerCase().includes(q));
    if (paletteList) paletteList.textContent = '';
    if (!paletteList) return;
    if (paletteRendered.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'palette-empty';
      empty.textContent = '无匹配命令';
      paletteList.appendChild(empty);
      return;
    }
    paletteSelected = Math.max(0, Math.min(paletteSelected, paletteRendered.length - 1));
    paletteRendered.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = 'palette-item' + (i === paletteSelected ? ' selected' : '');
      li.textContent = it.label;
      li.addEventListener('click', () => {
        closePalette();
        hud.paletteExec(it.id);
      });
      paletteList.appendChild(li);
    });
  }

  function openPalette(payload) {
    paletteAll = (payload && Array.isArray(payload.items)) ? payload.items : [];
    paletteSelected = 0;
    if (palette) palette.hidden = false;
    if (paletteInput) paletteInput.value = '';
    renderPalette();
    if (paletteInput) paletteInput.focus();
  }

  function closePalette() {
    if (palette) palette.hidden = true;
    if (paletteInput) paletteInput.value = '';
    if (paletteList) paletteList.textContent = '';
    paletteAll = [];
    paletteRendered = [];
    paletteSelected = 0;
  }

  if (paletteInput) {
    paletteInput.addEventListener('input', renderPalette);
    paletteInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (paletteRendered.length) paletteSelected = (paletteSelected + 1) % paletteRendered.length;
        renderPalette();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (paletteRendered.length) paletteSelected = (paletteSelected - 1 + paletteRendered.length) % paletteRendered.length;
        renderPalette();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const sel = paletteRendered[paletteSelected];
        if (sel) {
          closePalette();
          hud.paletteExec(sel.id);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closePalette();
        hud.paletteClose();
      }
    });
  }

  hud.onPaletteOpen((payload) => openPalette(payload));

  hud.onTheme((theme) => {
    // Drive CSS variables via html[data-hud-theme="light"|"dark"] (t34). Absence
    // of the attribute = the dark default declared in :root, so an unreported
    // theme never flashes light.
    document.documentElement.dataset.hudTheme = theme === 'light' ? 'light' : 'dark';
  });

  hud.onState((state) => {
    setMode(state.mode);
    body.classList.toggle('opaque', !!state.opaque);
  });
})();
