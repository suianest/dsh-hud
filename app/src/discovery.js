'use strict';

// ---------------------------------------------------------------------------
// discovery — reads the DSH Web UI discovery file written by the token-bridge
// Host plugin (t2).
//
//   %LOCALAPPDATA%\dsh-hud\discovery.json
//   { "pid": 12345, "port": "50265", "url": "http://127.0.0.1:50265/?token=...",
//     "updatedAt": "2026-11-05T00:36:55.000Z" }
//
// `url` carries a one-shot login token. The token is consumed on the first
// index load (authorizeIndex mints an auth cookie), so the plugin rewrites the
// file every 15s. DSH_HUD_DISCOVERY overrides the path (dev/sandbox).
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

function _defaultDir() {
  const base =
    process.env.LOCALAPPDATA || process.env.USERPROFILE || process.env.HOME || '';
  return base ? path.join(base, 'dsh-hud') : '';
}

function discoveryPath() {
  if (process.env.DSH_HUD_DISCOVERY) return process.env.DSH_HUD_DISCOVERY;
  const dir = _defaultDir();
  return dir ? path.join(dir, 'discovery.json') : null;
}

// Read + parse the discovery file. Returns null on any failure (missing file,
// bad JSON, wrong shape) so callers can degrade to the error page.
function readDiscovery() {
  const p = discoveryPath();
  if (!p) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch {
    return null;
  }
}

// Token URL (authoritative for the first load on cold start).
function tokenUrl(d) {
  if (!d || typeof d.url !== 'string' || !d.url) return null;
  return d.url;
}

// Clean URL: the same URL minus the one-shot `token` query. After the first
// token load has minted the auth cookie (persisted in the session partition),
// subsequent loads use the clean URL and authenticate via that cookie.
function cleanUrl(d) {
  const t = tokenUrl(d);
  if (!t) return null;
  try {
    const u = new URL(t);
    u.searchParams.delete('token');
    return u.toString();
  } catch {
    return t; // unparseable URL — fall back to the raw string
  }
}

// Age of the discovery entry in ms (Infinity when unknown/unparseable).
function ageMs(d) {
  if (!d || typeof d.updatedAt !== 'string') return Infinity;
  const t = Date.parse(d.updatedAt);
  return Number.isNaN(t) ? Infinity : Date.now() - t;
}

// control.json (t11) lives in the SAME directory as discovery.json, so a
// DSH_HUD_DISCOVERY override redirects both files together. DSH_HUD_CONTROL
// overrides the control path outright (dev/test).
function controlPath() {
  if (process.env.DSH_HUD_CONTROL) return process.env.DSH_HUD_CONTROL;
  const p = discoveryPath();
  if (!p) return null;
  return path.join(path.dirname(p), 'control.json');
}

module.exports = { discoveryPath, readDiscovery, tokenUrl, cleanUrl, ageMs, controlPath };
