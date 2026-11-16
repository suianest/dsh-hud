'use strict';

/**
 * In-app update, MVP scope: only `app.asar` (≈0.5 MB) and no database.
 *
 * Flow (P-09):
 *   1. fetch a static manifest.json (GitHub raw/release asset),
 *   2. compare its `version` with the running app's,
 *   3. download the new asar into `<resources>/app.asar.new`, verify sha256,
 *   4. write `update-pending.json` next to the user data and spawn
 *      `updater.cjs` (a plain Node script run through ELECTRON_RUN_AS_NODE),
 *   5. quit; the helper waits for the lock to clear, swaps the asar
 *      (keeping `app.asar.bak` for rollback) and relaunches the app.
 *
 * The runtime never touches `DSH HUD.exe` itself: replacing a running
 * executable is not possible on Windows, and shipping a new Electron build is
 * a Release-level event, not an in-app update.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = 'https://github.com/suianest/dsh-hud';

/**
 * Manifest mirrors, tried in order. raw.githubusercontent.com is often reset
 * by carrier-grade NAT / DNS pollution on some networks, jsDelivr sometimes
 * 403s at the edge, and github.com itself can be slow — so we keep four
 * independent routes, including the GitHub REST API (which stays reachable in
 * most of the cases where the CDN hosts are not).
 */
const DEFAULT_MANIFEST_SOURCES = [
  'https://raw.githubusercontent.com/suianest/dsh-hud/main/manifest.json',
  'https://cdn.jsdelivr.net/gh/suianest/dsh-hud@main/manifest.json',
  `${REPO}/releases/latest/download/manifest.json`,
  'https://api.github.com/repos/suianest/dsh-hud/contents/manifest.json?ref=main',
];

/** Numeric compare of `1.2.3` style versions (suffixes ignored). */
function compareVersions(a, b) {
  const pa = String(a || '')
    .split('-')[0]
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '')
    .split('-')[0]
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function readJsonFrom(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { 'cache-control': 'no-cache' } });
  if (!res || !res.ok) throw new Error('manifest HTTP ' + (res && res.status));
  const text = typeof res.text === 'function' ? await res.text() : '';
  const body = text ? JSON.parse(text) : await res.json();
  // GitHub contents API wraps the file in { content: base64, encoding: 'base64' }.
  if (body && typeof body.content === 'string' && body.encoding === 'base64') {
    return JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
  }
  return body;
}

/**
 * @returns {Promise<{status:'up-to-date'|'update'|'error', current:string,
 *   latest?:string, asarUrl?:string, sha256?:string, size?:number, notes?:string, error?:string}>}
 */
async function checkForUpdate({ current, manifestUrl, sources, fetchImpl = globalThis.fetch } = {}) {
  const envUrl = process.env.DSH_HUD_MANIFEST_URL;
  const list = manifestUrl
    ? [manifestUrl]
    : envUrl
      ? [envUrl]
      : Array.isArray(sources) && sources.length
        ? sources
        : DEFAULT_MANIFEST_SOURCES;

  const failures = [];
  for (const url of list) {
    try {
      return await checkOne(url);
    } catch (err) {
      let host = url;
      try { host = new URL(url).host; } catch { /* keep raw */ }
      failures.push(`${host}: ${(err && err.message) || err}`);
    }
  }
  return {
    status: 'error',
    current: String(current || ''),
    error: 'no manifest reachable (' + failures.join('; ') + ')',
  };

  async function checkOne(url) {
    const manifest = await readJsonFrom(url, fetchImpl);
    const latest = String(manifest.version || '0.0.0');
    if (compareVersions(latest, current) <= 0) {
      return { status: 'up-to-date', current, latest };
    }
    const asar = manifest.appAsar || {};
    if (!asar.url || !asar.sha256) throw new Error('manifest.appAsar.url / sha256 missing');
    return {
      status: 'update',
      current,
      latest,
      asarUrl: asar.url,
      sha256: String(asar.sha256).toLowerCase(),
      size: Number(asar.size) || 0,
      notes: manifest.notes ? String(manifest.notes) : '',
    };
  }
}

/** Download + verify, then stage the file for the helper. */
async function downloadUpdate({ asarUrl, sha256: expected, size: expectedSize, version, latest }, { destDir, fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(asarUrl);
  if (!res || !res.ok) throw new Error('download HTTP ' + (res && res.status));
  const buf = Buffer.from(await res.arrayBuffer());
  // A truncated response would otherwise only fail at sha256 time with a
  // confusing mismatch; the manifest already says how big the file is (t41).
  if (expectedSize && buf.length !== expectedSize) {
    throw new Error('size mismatch: expected ' + expectedSize + ' got ' + buf.length);
  }
  const actual = sha256(buf);
  if (actual !== String(expected).toLowerCase()) {
    throw new Error('sha256 mismatch: expected ' + expected + ' got ' + actual);
  }
  if (!destDir) throw new Error('destDir required');
  fs.mkdirSync(destDir, { recursive: true });
  const staged = path.join(destDir, 'app.asar.new');
  fs.writeFileSync(staged, buf);
  // `checkForUpdate()` reports the manifest version as `latest`; accept both so
  // the returned record always carries a version (t43).
  return { staged, sha256: actual, version: version || latest || undefined, size: buf.length };
}

/** Persist what the helper needs; called right before quitting. */
function writePending({ pendingFile, staged, version, exe, args, asar }) {
  const payload = { version, staged, asar, exe, args: args || [], at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  fs.writeFileSync(pendingFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

module.exports = {
  DEFAULT_MANIFEST_URL: DEFAULT_MANIFEST_SOURCES[0],
  DEFAULT_MANIFEST_SOURCES,
  compareVersions,
  sha256,
  checkForUpdate,
  downloadUpdate,
  writePending,
};
