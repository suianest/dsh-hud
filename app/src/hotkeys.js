'use strict';

// ---------------------------------------------------------------------------
// Global hotkey controller (胶囊 <-> 面板切换).
//
// Default accelerator: Ctrl+Alt+Space (Electron string 'Control+Alt+Space').
// Configurable — a future settings UI can call update(); the value persists in
// userData/hotkey.json as { "accelerator": "..." }.
//
// globalShortcut must only be used after app 'ready'; HudWindow calls
// setupHotkey() from inside app.whenReady().
// ---------------------------------------------------------------------------

const { app, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');

const { DEFAULT_ACCELERATOR, HOTKEY_FILE } = require('./constants');

function hotkeyPath() {
  return path.join(app.getPath('userData'), HOTKEY_FILE);
}

// Read the persisted accelerator; fall back to the default when the file is
// missing or malformed (never crash the HUD over a bad config).
function loadAccelerator() {
  try {
    const cfg = JSON.parse(fs.readFileSync(hotkeyPath(), 'utf8'));
    const accel = cfg && typeof cfg.accelerator === 'string' && cfg.accelerator.trim();
    return accel || DEFAULT_ACCELERATOR;
  } catch (e) {
    return DEFAULT_ACCELERATOR;
  }
}

function createHotkeyController() {
  let current = loadAccelerator();
  let registered = false;
  let onTrigger = null;

  // Register `accel`; on success remember it as current. Always unregisters the
  // previous accelerator first so update() is idempotent.
  function apply(accel) {
    if (registered) {
      globalShortcut.unregister(current);
      registered = false;
    }
    try {
      registered = globalShortcut.register(accel, () => {
        if (onTrigger) onTrigger();
      });
    } catch (e) {
      registered = false;
    }
    if (registered) current = accel;
    return registered;
  }

  return {
    // Start listening. Returns false if the accelerator is already taken by
    // another app — the HUD still works (capsule click remains available).
    register(trigger) {
      onTrigger = trigger;
      const ok = apply(current);
      if (!ok) console.warn(`[hud] 全局热键注册失败（可能被其他程序占用）: ${current}`);
      return ok;
    },

    get accelerator() {
      return current;
    },

    isRegistered() {
      return registered;
    },

    // Change the accelerator at runtime and persist it (for a future settings
    // UI). Returns false on an invalid string or registration failure.
    update(next) {
      if (typeof next !== 'string' || !next.trim()) return false;
      const ok = apply(next.trim());
      if (ok) {
        try {
          fs.mkdirSync(path.dirname(hotkeyPath()), { recursive: true });
          fs.writeFileSync(
            hotkeyPath(),
            JSON.stringify({ accelerator: current }, null, 2) + '\n'
          );
        } catch (e) {
          // Non-fatal: the hotkey is still active, just not persisted.
        }
      }
      return ok;
    },

    dispose() {
      if (registered) globalShortcut.unregister(current);
      registered = false;
    },
  };
}

module.exports = { createHotkeyController, loadAccelerator, hotkeyPath };
