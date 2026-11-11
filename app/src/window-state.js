'use strict';

// ---------------------------------------------------------------------------
// Position persistence: userData/window-state.json
//
// Remembers the last capsule position and last panel position (both in DIP,
// top-left). Written with a debounce during drag and via an atomic
// tmp-file + rename so a crash never leaves a half-written JSON file.
// Any read/parse error is swallowed -> defaults (first run / corrupt file).
// ---------------------------------------------------------------------------

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const { STATE_FILE, STATE_VERSION, SAVE_DEBOUNCE_MS } = require('./constants');

function statePath() {
  return path.join(app.getPath('userData'), STATE_FILE);
}

function defaults() {
  return {
    version: STATE_VERSION,
    capsule: null, // { x, y } — resident capsule top-left
    panel: null,   // { x, y } — expanded panel top-left (remembered for next expand)
  };
}

function isPoint(v) {
  return v && Number.isFinite(v.x) && Number.isFinite(v.y);
}

function load() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const parsed = JSON.parse(raw);
    const s = defaults();
    if (parsed && typeof parsed === 'object') {
      if (isPoint(parsed.capsule)) {
        s.capsule = { x: Math.round(parsed.capsule.x), y: Math.round(parsed.capsule.y) };
      }
      if (isPoint(parsed.panel)) {
        s.panel = { x: Math.round(parsed.panel.x), y: Math.round(parsed.panel.y) };
      }
    }
    return s;
  } catch (e) {
    return defaults();
  }
}

let timer = null;

function write(state) {
  const p = statePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, capsule: state.capsule, panel: state.panel }, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch (e) {
    // Never crash the HUD over a state-file write, but surface the failure so a
    // lost position (e.g. the launcher fell back to a temp dir and every launch
    // resets the position) is diagnosable instead of silent (t14 #16). The
    // in-memory state keeps the last good value for the next debounced write.
    console.error('[hud] window-state save failed:', e && e.message);
  }
}

function save(state, { immediate = false } = {}) {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (immediate) {
    write(state);
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    write(state);
  }, SAVE_DEBOUNCE_MS);
}

module.exports = { load, save, statePath };
