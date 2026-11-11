'use strict';

// Headless acceptance tests for app/src/config.js (t26 portable config).
// Run: node --test tests/e2e/unit/config.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig, detectDesktopExe } = require('../../../app/src/config.js');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('config: env wins over config.local.json (env priority)', () => {
  const repo = tempDir('dsh-cfg-env-');
  const appPath = path.join(repo, 'app');
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'config.local.json'),
    JSON.stringify({
      dshExe: 'C:\\from-file\\DeepSeek Harness.exe',
      discoveryPath: 'C:\\from-file\\discovery.json',
    }),
    'utf8',
  );

  const env = {
    LOCALAPPDATA: repo,
    DSH_HUD_DSH_EXE: 'C:\\from-env\\DeepSeek Harness.exe',
  };
  const { config, sources } = loadConfig({ appPath, env, detectExe: () => '' });

  assert.equal(config.dshExe, 'C:\\from-env\\DeepSeek Harness.exe', 'env DSH_HUD_DSH_EXE wins');
  assert.equal(config.desktopExe, config.dshExe, 'desktopExe alias mirrors dshExe');
  assert.equal(sources.dshExe, 'env');
  // env only overrode dshExe; the file still fills the other keys.
  assert.equal(config.discoveryPath, 'C:\\from-file\\discovery.json');
  assert.equal(sources.discoveryPath, 'file');
});

test('config: config.local.json fills keys env leaves unset (file fallback + desktopExe alias)', () => {
  const repo = tempDir('dsh-cfg-file-');
  const appPath = path.join(repo, 'app');
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'config.local.json'),
    JSON.stringify({ desktopExe: 'C:\\Programs\\DSH\\DeepSeek Harness.exe', dshWindowTitle: 'My DSH' }),
    'utf8',
  );

  const env = { LOCALAPPDATA: repo };
  const { config, sources } = loadConfig({ appPath, env, detectExe: () => '' });

  // "desktopExe" in the file maps onto the canonical dshExe key.
  assert.equal(config.dshExe, 'C:\\Programs\\DSH\\DeepSeek Harness.exe');
  assert.equal(config.desktopExe, config.dshExe);
  assert.equal(sources.dshExe, 'file');
  assert.equal(config.dshWindowTitle, 'My DSH');
  assert.equal(sources.dshWindowTitle, 'file');
});

test('config: missing env + missing file -> defaults, exe degrades to empty', () => {
  const repo = tempDir('dsh-cfg-default-');
  const appPath = path.join(repo, 'app');
  fs.mkdirSync(appPath, { recursive: true });

  const env = { LOCALAPPDATA: repo };
  const { config, sources } = loadConfig({ appPath, env, detectExe: () => '' });

  assert.equal(config.dshExe, '', 'no exe detected -> empty string (graceful degrade)');
  assert.equal(config.desktopExe, '');
  assert.equal(sources.dshExe, 'empty');
  assert.equal(config.dshWindowTitle, 'DeepSeek Harness');
  assert.equal(config.hotkey, 'Control+Alt+Space');
  assert.equal(config.discoveryPath, path.join(repo, 'dsh-hud', 'discovery.json'));
  assert.equal(config.discoveryDir, path.join(repo, 'dsh-hud'));
  assert.equal(config.appDir, appPath, 'appDir derives from appPath parent, no drive letter');
  assert.equal(
    config.electronPath,
    path.join(repo, 'runtime', 'node_modules', 'electron', 'dist', 'electron.exe'),
  );
  assert.equal(sources.electronPath, 'default');
});

test('config: detectDesktopExe finds an exe in a common install location', () => {
  const la = tempDir('dsh-cfg-detect-');
  const exePath = path.join(la, 'Programs', 'DeepSeek', 'DeepSeek Harness.exe');
  fs.mkdirSync(path.dirname(exePath), { recursive: true });
  fs.writeFileSync(exePath, 'MZ');

  // Returns as soon as a candidate exists, before any powershell fallback.
  assert.equal(detectDesktopExe({ LOCALAPPDATA: la }), exePath);
});
