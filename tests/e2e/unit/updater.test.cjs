'use strict';

/**
 * P-09 updater unit tests: version compare, manifest decision, download + hash.
 * No network: every fetch is a small in-memory double.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const updater = require('../../../app/src/updater.js');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('compareVersions orders dotted versions numerically', () => {
  assert.equal(updater.compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(updater.compareVersions('1.2.4', '1.2.3'), 1);
  assert.equal(updater.compareVersions('1.2.3', '1.2.4'), -1);
  // 1.10 must beat 1.9 (string compare would get this wrong).
  assert.equal(updater.compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(updater.compareVersions('0.3.0', '0.3'), 0);
});

test('checkForUpdate reports up-to-date when the manifest matches', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ version: '0.3.0', appAsar: { url: 'x', sha256: 'a' } }),
  });
  const r = await updater.checkForUpdate({ current: '0.3.0', fetchImpl });
  assert.equal(r.status, 'up-to-date');
  assert.equal(r.latest, '0.3.0');
});

test('checkForUpdate returns the download descriptor for a newer build', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      version: '0.4.0',
      notes: 'what is new',
      appAsar: { url: 'https://example.invalid/app.asar', sha256: 'DEADBEEF', size: 10 },
    }),
  });
  const r = await updater.checkForUpdate({ current: '0.3.0', fetchImpl });
  assert.equal(r.status, 'update');
  assert.equal(r.latest, '0.4.0');
  assert.equal(r.sha256, 'deadbeef', 'hash is normalised to lower case');
  assert.equal(r.notes, 'what is new');
});

test('checkForUpdate degrades to status:error when the manifest is broken', async () => {
  const r1 = await updater.checkForUpdate({ current: '0.3.0', fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.equal(r1.status, 'error');
  const r2 = await updater.checkForUpdate({
    current: '0.3.0',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: '0.4.0' }) }),
  });
  assert.equal(r2.status, 'error');
  assert.match(r2.error, /appAsar/);
});

test('downloadUpdate verifies the hash and stages app.asar.new', async () => {
  const payload = Buffer.from('fake-asar-bytes');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-updater-'));
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => payload });
  const out = await updater.downloadUpdate(
    { asarUrl: 'https://example.invalid/app.asar', sha256: sha(payload), version: '0.4.0' },
    { destDir: dir, fetchImpl },
  );
  assert.equal(out.size, payload.length);
  assert.equal(fs.readFileSync(out.staged, 'utf8'), 'fake-asar-bytes');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('downloadUpdate rejects a mismatched hash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-updater-'));
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('tampered') });
  await assert.rejects(
    updater.downloadUpdate(
      { asarUrl: 'https://example.invalid/app.asar', sha256: sha(Buffer.from('expected')), version: '0.4.0' },
      { destDir: dir, fetchImpl },
    ),
    /sha256 mismatch/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writePending records everything the helper needs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-updater-'));
  const file = path.join(dir, 'update-pending.json');
  updater.writePending({
    pendingFile: file,
    staged: path.join(dir, 'app.asar.new'),
    version: '0.4.0',
    exe: 'C:\\x\\DSH HUD.exe',
    args: ['--no-sandbox'],
    asar: 'C:\\x\\resources\\app.asar',
  });
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(j.version, '0.4.0');
  assert.equal(j.asar, 'C:\\x\\resources\\app.asar');
  assert.deepEqual(j.args, ['--no-sandbox']);
  assert.ok(Date.parse(j.at) > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkForUpdate falls back to the next source when the first one is reset', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (String(url).includes('raw.githubusercontent')) throw new Error('read ECONNRESET');
    if (String(url).includes('api.github.com')) {
      const inner = JSON.stringify({ version: '0.5.0', appAsar: { url: 'https://example.invalid/app.asar', sha256: 'AB', size: 1 } });
      const wrapped = JSON.stringify({ encoding: 'base64', content: Buffer.from(inner).toString('base64') });
      return { ok: true, status: 200, text: async () => wrapped };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
  const r = await updater.checkForUpdate({ current: '0.4.0', fetchImpl });
  assert.equal(r.status, 'update');
  assert.equal(r.latest, '0.5.0');
  assert.equal(r.sha256, 'ab');
  assert.ok(calls.length >= 2);
});
