// t12 review probe — NOT a product test.
//
// 1) D2 claim check: does the plugin clean leftover *.tmp files at STARTUP, or
//    only on dispose?
// 2) D3 contract check: ControlBridge validates `action` BEFORE advancing its
//    persisted seq, so an old/malformed {type} payload cannot burn the seq and
//    swallow the valid control.json copy. It also proves a plugin restart can
//    continue with a Date.now()-based seq without being dropped by lastSeq.
//
// Run:
//   node tests/e2e/probe-contract.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..', '..');
const plugin = await import(pathToFileURL(path.join(root, 'plugin', 'index.js')).href);
const { ControlBridge } = await import(pathToFileURL(path.join(root, 'app', 'src', 'control.js')).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-t12-probe-'));
process.env.LOCALAPPDATA = tmp;
const dir = path.join(tmp, 'dsh-hud');
fs.mkdirSync(dir, { recursive: true });
const leftovers = ['control.json.999.1.tmp', 'orphan.tmp', 'discovery.json.tmp'];
for (const name of leftovers) fs.writeFileSync(path.join(dir, name), '{"stale":true}');

const ctx = {
  get(name) {
    if (name === 'webApp') return { getAdvertisedUrl: () => 'http://127.0.0.1:51234/' };
    if (name === 'connection') return { authenticatedUrl: (u) => `${u}?token=T0K` };
    if (name === 'webServer') return { getOrigin: () => 'http://127.0.0.1:51234/' };
    if (name === 'commands') return { register: () => () => {} };
    return undefined;
  },
};
const dispose = plugin.apply(ctx, { spawnApp: false, refreshMs: 60_000 });
await new Promise((r) => setTimeout(r, 150));
const afterStartup = fs.readdirSync(dir).sort();
console.log(JSON.stringify({ phase: 'startup', files: afterStartup }));

const calls = [];
const bridge = new ControlBridge(
  { show: () => calls.push('show'), hide: () => calls.push('hide') },
  { statePath: path.join(tmp, 'control-state.json') },
);
// Old t8 shape: must be rejected WITHOUT advancing _lastSeq (t13 #2).
bridge._dispatchLine('{"type":"show","seq":1}');
const afterType = { calls: [...calls], lastSeq: bridge._lastSeq };
bridge._dispatchLine('{"action":"show","seq":2}');
const afterAction = { calls: [...calls], lastSeq: bridge._lastSeq };
bridge.stop();

// Plugin restart: lastSeq is persisted as a huge Date.now() value; a fresh
// Date.now() seq from the restarted plugin must still be accepted.
const restartedCalls = [];
const persisted = path.join(tmp, 'control-state-restart.json');
fs.writeFileSync(persisted, JSON.stringify({ lastSeq: 10 }));
const restarted = new ControlBridge({ show: () => restartedCalls.push('show') }, { statePath: persisted });
const freshSeq = Date.now();
restarted._dispatchLine(JSON.stringify({ action: 'show', seq: freshSeq }));
restarted._dispatchLine('{"action":"show","seq":1}');
const afterRestart = { calls: [...restartedCalls], lastSeq: restarted._lastSeq, freshSeq };
restarted.stop();

console.log(JSON.stringify({ phase: 'control', afterType, afterAction, afterRestart }));

dispose();
await new Promise((r) => setTimeout(r, 200));
const afterDispose = fs.readdirSync(dir).sort();
console.log(JSON.stringify({ phase: 'dispose', files: afterDispose }));
fs.rmSync(tmp, { recursive: true, force: true });
