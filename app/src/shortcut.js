'use strict';

// ---------------------------------------------------------------------------
// P-08: Start-menu shortcut for the packaged build.
//
// Form B (plugin-only install) has no desktop shortcut, and once the user turns
// "开机自启" off there is nothing left to click. On the first packaged run we
// therefore drop one shortcut into the per-user Start Menu, so typing "DSH HUD"
// in the Start menu / Search finds it.
//
// The shortcut must carry the same launch flags as DSH HUD.lnk, because a bare
// double-click of the exe dies before JS on machines where Chromium cannot
// create its sandbox pipes (0x80000003).
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SHORTCUT_NAME = 'DSH HUD.lnk';

function startMenuProgramsDir(appData) {
  return path.join(appData || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
}

// P-06 layout: <root>/app/DSH HUD.exe + <root>/udd; the old flat layout has the
// exe directly in <root>.
function launchPlan(exePath) {
  const appDir = path.dirname(exePath);
  const root = path.basename(appDir) === 'app' ? path.dirname(appDir) : appDir;
  return { appDir, root, udd: path.join(root, 'udd') };
}

function shortcutScript({ target, args, workdir, lnk, description, icon }) {
  const q = (value) => String(value).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop';",
    'try {',
    '$ws = New-Object -ComObject WScript.Shell;',
    `$lnk = $ws.CreateShortcut('${q(lnk)}');`,
    `$lnk.TargetPath = '${q(target)}';`,
    `$lnk.Arguments = '${q(args)}';`,
    `$lnk.WorkingDirectory = '${q(workdir)}';`,
    `$lnk.IconLocation = '${q(icon)}';`,
    `$lnk.Description = '${q(description)}';`,
    '$lnk.Save();',
    "} catch { $e = $_.Exception; [Console]::Error.WriteLine($e.Message + ' | HResult=' + $e.HResult + ' | ' + $e.GetType().FullName); exit 1 }",
  ].join(' ');
}

/**
 * Create the Start-menu shortcut once. Never throws: a failure is only logged,
 * because shortcut creation must not block the app from starting.
 */
function ensureStartMenuShortcut(opts = {}) {
  const {
    isPackaged = false,
    exePath = process.execPath,
    appData = process.env.APPDATA,
    platform = process.platform,
    exists = fs.existsSync,
    log = () => {},
    run = (ps) => {
      try {
        execFileSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
      } catch (err) {
        // execFileSync only reports "Command failed"; the real reason is on
        // stderr, which is exactly what we need in boot.log when PS 5.1 chokes
        // on something (COM, encoding, policy).
        // PowerShell 5.1 writes its diagnostics in the OEM code page (GBK on
        // zh-CN), not UTF-8; decode so boot.log stays readable.
        let text = '';
        const raw = err && err.stderr;
        if (raw) {
          try {
            text = new TextDecoder('gbk').decode(raw);
          } catch {
            text = String(raw);
          }
        }
        const reason = String(text).trim().split(/\r?\n/)[0];
        const wrapped = new Error(reason || (err && err.message) || 'powershell failed');
        wrapped.status = err && err.status;
        throw wrapped;
      }
    },
  } = opts;

  if (platform !== 'win32') return { created: false, reason: 'not-win32' };
  if (!isPackaged) return { created: false, reason: 'not-packaged' };
  if (!appData) return { created: false, reason: 'no-appdata' };

  const link = path.join(startMenuProgramsDir(appData), SHORTCUT_NAME);
  if (exists(link)) return { created: false, reason: 'exists', link };

  const plan = launchPlan(exePath);
  try {
    run(
      shortcutScript({
        target: exePath,
        args: `--no-sandbox --user-data-dir="${plan.udd}"`,
        workdir: plan.appDir,
        lnk: link,
        description: 'DSH HUD — DeepSeek Harness 浮窗',
        icon: `${exePath},0`,
      }),
    );
    log(`[hud] start-menu shortcut created: ${link}`);
    return { created: true, link };
  } catch (err) {
    const message = (err && err.message) || String(err);
    log(`[hud] start-menu shortcut failed: ${message}`);
    return { created: false, reason: 'error', error: message, link };
  }
}

module.exports = { ensureStartMenuShortcut, startMenuProgramsDir, launchPlan, SHORTCUT_NAME };
