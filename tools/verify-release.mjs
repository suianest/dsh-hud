#!/usr/bin/env node
/**
 * Checks that manifest.json still describes the file actually attached to the
 * GitHub Release. Run this after uploading app.asar (or after any local rebuild
 * that regenerated manifest.json), otherwise `checkForUpdate()` will download a
 * file whose sha256 does not match and refuse to install it.
 *
 *   node tools/verify-release.mjs            # uses ../manifest.json
 *   node tools/verify-release.mjs path/to/manifest.json
 *
 * Exit code 0 = release asset matches the manifest, 1 = mismatch/failure.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const manifestPath = process.argv[2] || fileURLToPath(new URL('../manifest.json', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const asset = manifest.appAsar || {};

if (!asset.url || !asset.sha256) {
  console.error('manifest is missing appAsar.url / appAsar.sha256');
  process.exit(1);
}

console.log(`manifest: ${manifestPath}`);
console.log(`version:  ${manifest.version}`);
console.log(`url:      ${asset.url}`);

async function download(url, attempts = 4) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'dsh-hud-verify' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      console.warn(`download attempt ${i}/${attempts} failed: ${err.message || err.cause?.code || err}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  throw lastErr;
}

let buf;
try {
  buf = await download(asset.url);
} catch (err) {
  console.error(`download failed: ${err.message || err.cause?.code || err}`);
  process.exit(1);
}
const sha = createHash('sha256').update(buf).digest('hex');
const sizeOk = buf.length === asset.size;
const shaOk = sha === String(asset.sha256).toLowerCase();

console.log(`bytes:    ${buf.length} (manifest: ${asset.size}) ${sizeOk ? 'OK' : 'MISMATCH'}`);
console.log(`sha256:   ${sha}`);
console.log(`expected: ${asset.sha256} ${shaOk ? 'OK' : 'MISMATCH'}`);

if (sizeOk && shaOk) {
  console.log('\nrelease asset matches manifest');
  process.exit(0);
}
console.error('\nrelease asset does NOT match manifest — re-upload the asset or regenerate manifest.json from it');
process.exit(1);
