'use strict';

// Extensions are the supported way to add features without touching the
// window/control internals. These tests pin the three seams (menu, control
// action, css) plus the "no dynamic code" rule (names are validated).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ext = require('../../../app/src/extensions');

test('menu: registered items are appended with their context', () => {
  ext._reset();
  const calls = [];
  ext.registerMenuItem({ label: 'A', click: (ctx) => calls.push(['A', ctx.tag]) });
  ext.registerMenu([
    { label: 'B', click: (ctx) => calls.push(['B', ctx.tag]) },
    { label: 'Hidden', when: () => false },
  ]);

  const items = ext.menuItems({ tag: 'ctx' });
  assert.deepStrictEqual(items.map((i) => i.label), ['A', 'B']);
  items[0].click({ tag: 'ctx' });
  assert.deepStrictEqual(calls, [['A', 'ctx']]);
});

test('menu: unregister removes only that entry', () => {
  ext._reset();
  const off = ext.registerMenuItem({ label: 'X' });
  ext.registerMenuItem({ label: 'Y' });
  off();
  assert.deepStrictEqual(ext.menuItems({}).map((i) => i.label), ['Y']);
});

test('control: actions are exposed as a plain handler map', () => {
  ext._reset();
  const seen = [];
  ext.registerControlAction('market', (ctx) => seen.push(ctx.hud));
  const handlers = ext.controlHandlers();
  assert.deepStrictEqual(Object.keys(handlers), ['market']);
  handlers.market({ hud: 'H' });
  assert.deepStrictEqual(seen, ['H']);
});

test('control: invalid action names are rejected', () => {
  ext._reset();
  for (const bad of ['', 'Bad Name', 'UPPER', '1abc', 'has space']) {
    assert.throws(() => ext.registerControlAction(bad, () => {}), /action name/);
  }
  assert.throws(() => ext.registerControlAction('ok', 'not-a-fn'), /handler must be a function/);
});

test('css: extension blocks come after the compact rules', () => {
  ext._reset();
  ext.registerCss('a', '.a { color: red; }');
  ext.registerCss('a', '.a { color: blue; }'); // same id replaces
  ext.registerCss('b', '.b { color: green; }');

  const css = ext.extraCss();
  assert.match(css, /extension: a/);
  assert.match(css, /\.a \{ color: blue; \}/);
  assert.doesNotMatch(css, /color: red/);
  assert.match(css, /extension: b/);

  ext._reset();
  assert.strictEqual(ext.extraCss(), '');
});

test('external files: loadExtensionFiles picks up *.js, isolates failures', () => {
  ext._reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hud-ext-'));
  fs.writeFileSync(
    path.join(dir, 'good.js'),
    `module.exports = (api) => {
       api.registerMenuItem({ label: 'From file' });
       api.registerControlAction('from-file', () => {});
       api.registerCss('from-file', '.x { color: red; }');
     };`,
    'utf8'
  );
  fs.writeFileSync(path.join(dir, 'broken.js'), 'throw new Error("boom");', 'utf8');
  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'not js', 'utf8');

  const logs = [];
  const loaded = ext.loadExtensionFiles([dir, path.join(dir, 'missing')], { log: (l) => logs.push(l) });

  assert.equal(loaded.length, 1);
  assert.match(loaded[0], /good\.js$/);
  assert.deepEqual(ext.menuItems({}).map((i) => i.label), ['From file']);
  assert.equal(typeof ext.controlHandlers()['from-file'], 'function');
  assert.match(ext.extraCss(), /color: red/);
  assert.ok(logs.some((l) => /extension failed: .*broken\.js: boom/.test(l)), 'failure must be logged');

  const prev = process.env.DSH_HUD_NO_EXTENSIONS;
  process.env.DSH_HUD_NO_EXTENSIONS = '1';
  ext._reset();
  assert.deepEqual(ext.loadExtensionFiles([dir], { log: () => {} }), []);
  if (prev === undefined) delete process.env.DSH_HUD_NO_EXTENSIONS;
  else process.env.DSH_HUD_NO_EXTENSIONS = prev;

  fs.rmSync(dir, { recursive: true, force: true });
  ext._reset();
});
