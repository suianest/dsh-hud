'use strict';

// ---------------------------------------------------------------------------
// Preload — exposes a minimal, typed bridge to the renderer via contextBridge.
// Renderer (contextIsolation:true) has no Node access; it only sees `window.hud`.
// ---------------------------------------------------------------------------

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', {
  // Drag (screen-DIP coordinates, computed by the renderer).
  dragStart: (payload) => ipcRenderer.send('hud:drag-start', payload),
  dragMove: (payload) => ipcRenderer.send('hud:drag-move', payload),
  dragEnd: (payload) => ipcRenderer.send('hud:drag-end', payload),

  // Actions.
  collapse: () => ipcRenderer.send('hud:collapse'),
  quit: () => ipcRenderer.send('hud:quit'),

  // Collapse animation handshake: main asks the renderer to play the out
  // animation (hud:collapse-anim), renderer answers when it is done
  // (hud:collapse-done), and main then performs the resize.
  onCollapseAnim: (callback) => {
    ipcRenderer.on('hud:collapse-anim', () => callback());
  },
  collapseDone: () => ipcRenderer.send('hud:collapse-done'),

  // State push (main -> renderer): { mode: 'capsule' | 'panel', opaque: boolean }.
  onState: (callback) => {
    ipcRenderer.on('hud:state', (_event, state) => callback(state));
  },

  // Manual edge resize: the pointer-down starts a session in main, which then
  // tracks the cursor itself (the pointer may leave the window while dragging).
  resizeStart: (side) => ipcRenderer.send('hud:resize-start', side),
  resizeMove: (d) => ipcRenderer.send('hud:resize-move', d),
  resizeEnd: () => ipcRenderer.send('hud:resize-end'),

  // Report the panel's #web-host rect (DIP, relative to the window content) so
  // main can position the WebContentsView over that exact region.
  reportWebBounds: (rect) => ipcRenderer.send('hud:web-bounds', rect),

  // Theme-follow (t31): main pushes the embedded page's theme ('light' | 'dark')
  // so the renderer can switch body.theme-light / body.theme-dark.
  onTheme: (callback) => {
    ipcRenderer.on('hud:theme', (_event, theme) => callback(theme));
  },

  // Command palette (t35): main pushes the open-palette payload { items }, the
  // renderer answers with an execution id or a close request.
  onPaletteOpen: (callback) => {
    ipcRenderer.on('hud:palette-open', (_event, payload) => callback(payload));
  },
  paletteOpen: () => ipcRenderer.send('hud:palette-open-request'),
  paletteExec: (id) => ipcRenderer.send('hud:palette-exec', { id }),
  paletteClose: () => ipcRenderer.send('hud:palette-close'),
});
