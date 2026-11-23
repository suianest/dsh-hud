/**
 * Regression tests for the host-side IPC poller (plugin/index.js).
 *
 * Bug fixed in 0.5.10: the poller kept a single `lastRequestId` and compared it
 * across every candidate directory. Two request files with different ids (one
 * stale `desktop`, one `autostart` carrying an ISO-string `at`) overwrote each
 * other's slot on every tick, so the loop alternated forever:
 *
 *   tick 1 → desktop expired  → lastRequestId = desktop
 *   tick 2 → autostart replay → applyAutostart() runs, lastRequestId = autostart
 *   tick 3 → desktop expired again …
 *
 * In the wild that rewrote the Startup entry twice a second and spammed the
 * diagnostic log. `requestVerdict()` now decides per id and accepts both epoch
 * numbers and ISO strings, so a request can never come back once handled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// No env guards here on purpose: this file only imports the module and tests
// pure helpers. Process-wide guards would leak into plugin.test.mjs (the suite
// runs with --test-isolation=none) and disable its autostart assertions.

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..', '..', '..');
const PLUGIN = path.resolve(ROOT, 'plugin', 'index.js');

const { requestVerdict } = await import(pathToFileURL(PLUGIN).href);

const NOW = Date.parse('2026-11-23T13:30:00.000Z');
const TTL = 120_000;

test('ipc verdict: missing request or id is skipped', () => {
  const handled = new Set();
  assert.equal(requestVerdict(null, handled, NOW, TTL), 'skip');
  assert.equal(requestVerdict(undefined, handled, NOW, TTL), 'skip');
  assert.equal(requestVerdict({}, handled, NOW, TTL), 'skip');
  assert.equal(requestVerdict({ id: '' }, handled, NOW, TTL), 'skip');
  assert.equal(requestVerdict('nope', handled, NOW, TTL), 'skip');
});

test('ipc verdict: an already handled id is skipped', () => {
  const handled = new Set(['desktop-1']);
  assert.equal(requestVerdict({ id: 'desktop-1', at: NOW }, handled, NOW, TTL), 'skip');
});

test('ipc verdict: numeric timestamps older than the TTL expire', () => {
  const handled = new Set();
  assert.equal(requestVerdict({ id: 'a', at: NOW - TTL - 1 }, handled, NOW, TTL), 'expired');
});

test('ipc verdict: ISO string timestamps older than the TTL also expire (regression)', () => {
  const handled = new Set();
  const old = new Date(NOW - TTL - 1).toISOString();
  // The old loop only checked `typeof req.at === 'number'`, so this request
  // stayed "fresh" forever and replayed its action on every tick.
  assert.equal(requestVerdict({ id: 'b', at: old }, handled, NOW, TTL), 'expired');
});

test('ipc verdict: fresh requests are handled regardless of timestamp type', () => {
  const handled = new Set();
  assert.equal(requestVerdict({ id: 'n', at: NOW - 1_000 }, handled, NOW, TTL), 'handle');
  assert.equal(
    requestVerdict({ id: 's', at: new Date(NOW - 1_000).toISOString() }, handled, NOW, TTL),
    'handle',
  );
  // No timestamp at all: treat as fresh (HUD writes it right before posting).
  assert.equal(requestVerdict({ id: 'x' }, handled, NOW, TTL), 'handle');
});

test('ipc verdict: the TTL boundary is inclusive (exactly TTL old is still handled)', () => {
  const handled = new Set();
  assert.equal(requestVerdict({ id: 'edge', at: NOW - TTL }, handled, NOW, TTL), 'handle');
});

test('ipc verdict: two directories with different ids settle after one pass each', () => {
  // Reproduce the real-world pair: a stale numeric desktop request and an
  // autostart request whose `at` is an ISO string from 30 minutes ago.
  const files = [
    { id: 'desktop-25228', at: NOW - 30 * 60_000 },
    { id: 'autostart-1795438315661', at: new Date(NOW - 30 * 60_000).toISOString() },
  ];
  const handled = new Set();
  const executed = [];

  // 8 ticks ≈ 4 seconds of the 500 ms poller.
  for (let tick = 0; tick < 8; tick += 1) {
    for (const req of files) {
      const verdict = requestVerdict(req, handled, NOW, TTL);
      if (verdict === 'handle') executed.push(req.id);
      if (verdict !== 'skip') handled.add(req.id); // handler marks + deletes file
    }
  }

  assert.deepEqual(executed, [], 'both requests are older than the TTL, so neither may run');
  assert.equal(handled.size, 2, 'both ids are retired in the first pass');
});

test('ipc verdict: a fresh pair runs exactly once (no ping-pong)', () => {
  const files = [
    { id: 'desktop-fresh', at: NOW - 500 },
    { id: 'autostart-fresh', at: new Date(NOW - 500).toISOString() },
  ];
  const handled = new Set();
  const executed = [];

  for (let tick = 0; tick < 8; tick += 1) {
    for (const req of files) {
      const verdict = requestVerdict(req, handled, NOW, TTL);
      if (verdict === 'handle') executed.push(req.id);
      if (verdict !== 'skip') handled.add(req.id);
    }
  }

  // Before the fix this list grew by one entry per tick (8 autostart replays).
  assert.deepEqual(executed, ['desktop-fresh', 'autostart-fresh']);
});
