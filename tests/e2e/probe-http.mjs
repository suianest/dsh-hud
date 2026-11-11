// HTTP-level probe for the DSH Web UI auth chain (no Electron needed).
// Run: node tests/e2e/probe-http.mjs
// Writes artifacts/e2e/e2e-http.json + prints a human summary.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'artifacts', 'e2e');
fs.mkdirSync(OUT, { recursive: true });

const discoveryFile = process.env.DSH_HUD_DISCOVERY ||
  path.join(process.env.LOCALAPPDATA || '', 'dsh-hud', 'discovery.json');

function readDiscovery() {
  try {
    return JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));
  } catch {
    return null;
  }
}

async function probe(url, opts = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: 'manual', ...opts });
    const body = await res.text().catch(() => '');
    return {
      url,
      ok: true,
      status: res.status,
      location: res.headers.get('location'),
      setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [],
      contentType: res.headers.get('content-type'),
      bytes: body.length,
      ms: Date.now() - started,
      bodyStart: body.slice(0, 300),
      headers: Object.fromEntries(['content-security-policy', 'x-frame-options', 'cross-origin-opener-policy', 'cross-origin-embedder-policy']
        .map((h) => [h, res.headers.get(h)])),
    };
  } catch (err) {
    return { url, ok: false, error: String(err && err.cause ? err.cause.code || err.cause.message : err.message), ms: Date.now() - started };
  }
}

const d = readDiscovery();
const report = {
  at: new Date().toISOString(),
  discoveryFile,
  discovery: d,
  discoveryAgeMs: d && d.updatedAt ? Date.now() - Date.parse(d.updatedAt) : null,
  currentWebUrl: process.env.DSH_WEB_URL || null,
  probes: [],
  tokenFlow: null,
};

// 1) The live DSH Web server advertised to this session (no token).
if (report.currentWebUrl) {
  report.probes.push(await probe(report.currentWebUrl + '/'));
  report.probes.push(await probe(report.currentWebUrl + '/assets/'));
  report.probes.push(await probe(report.currentWebUrl + '/api/health'));
}

// 2) The discovery URL from the plugin (may be stale).
if (d && d.url) {
  const u = new URL(d.url);
  report.probes.push(await probe(u.origin + '/'));
  const token = await probe(d.url);
  report.probes.push(token);
  // 3) Token -> cookie -> clean URL replay (the exact WebEmbed bootstrap).
  const cookie = (token.setCookie || []).map((c) => c.split(';')[0]).join('; ');
  if (cookie) {
    const clean = new URL(d.url);
    clean.searchParams.delete('token');
    const replay = await probe(clean.toString(), { headers: { cookie } });
    report.tokenFlow = { tokenStatus: token.status, gotCookie: true, cookieNames: token.setCookie.map((c) => c.split('=')[0]), cleanUrl: clean.toString(), cleanStatus: replay.status, cleanBytes: replay.bytes };
    report.probes.push(replay);
  } else {
    report.tokenFlow = { tokenStatus: token.status, gotCookie: false, note: 'token 无效/过期或服务不可达，无法完成 cookie 回放' };
  }
}

const outFile = path.join(OUT, 'e2e-http.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ outFile, probes: report.probes.map((p) => ({ url: p.url, status: p.status, error: p.error, bytes: p.bytes, ms: p.ms })), tokenFlow: report.tokenFlow }, null, 2));
