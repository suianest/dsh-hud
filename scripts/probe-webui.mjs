// Probe the live DSH Web UI: fetch the shell HTML with a fresh token, then
// report which stylesheets it links and where the sidebar-drawer CSS lives.
// Read-only. Usage: node probe-webui.mjs [outDir]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OUT = process.argv[2] || path.join(os.tmpdir(), 'dsh-webui-probe');
fs.mkdirSync(OUT, { recursive: true });

const HOME = os.homedir();
const DISC = path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'dsh-hud', 'discovery.json');
if (!fs.existsSync(DISC)) {
  console.error('discovery.json missing:', DISC);
  process.exit(2);
}
const disc = JSON.parse(fs.readFileSync(DISC, 'utf8'));
console.log('discovery:', JSON.stringify(disc));

const tokenRes = await fetch(disc.url, { redirect: 'manual' });
const cookie = tokenRes.headers.getSetCookie?.() ?? [];
console.log('token fetch:', tokenRes.status, [...tokenRes.headers.keys()].join(','));
console.log('set-cookie:', cookie.map((c) => c.split(';')[0]).join(' | '));
const jar = cookie.map((c) => c.split(';')[0]).join('; ');

const clean = new URL(disc.url);
clean.searchParams.delete('token');
const htmlRes = await fetch(clean, { headers: { cookie: jar } });
const html = await htmlRes.text();
fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log('index:', htmlRes.status, html.length, 'bytes');

const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
console.log('assets:', refs.length);
for (const ref of refs.slice(0, 40)) {
  const u = new URL(ref, clean);
  const r = await fetch(u, { headers: { cookie: jar } });
  const body = await r.text();
  const name = path.basename(new URL(u).pathname);
  fs.writeFileSync(path.join(OUT, name), body);
  const hits = [];
  if (/drawerMask/.test(body)) hits.push('drawerMask');
  if (/sidebar/i.test(body)) hits.push('sidebar');
  if (/@media/.test(body)) hits.push('@media');
  console.log(`  ${name}: ${r.status} ${body.length}B ${hits.join(',') || ''}`);
}
console.log('saved to', OUT);
