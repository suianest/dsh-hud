'use strict';

// ---------------------------------------------------------------------------
// autostart — 开机自启开关。
//
// Windows 上用 Electron 的 app.setLoginItemSettings()（注册表
// HKCU\...\CurrentVersion\Run），并把用户的选择持久化到
// userData/autostart.json。开关通过悬浮胶囊/面板顶栏的右键菜单操作。
//
// 注意：
//   - process.execPath 在打包产物里是 dsh-hud.exe（正确）；在源码开发态是
//     electron.exe，此时注册的登录项无效——开机自启只对打包产物有意义。
//   - apply() 只在「存在显式选择」时执行，首次运行不触碰系统登录项。
// ---------------------------------------------------------------------------

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function configPath() {
  return path.join(app.getPath('userData'), 'autostart.json');
}

function readConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return { enabled: !!j.enabled };
  } catch {
    return { enabled: false };
  }
}

function writeConfig(cfg) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    console.error('[hud] autostart config write failed:', err && err.message);
  }
}

// --- where the login entry lives -------------------------------------------
// Packaged: HKCU\...\Run via app.setLoginItemSettings (points at DSH HUD.exe).
// Dev: a .cmd dropped into the user's Startup folder. registerring electron.exe
// directly is useless (it needs --user-data-dir + the app directory), so the
// script spells the whole command line out; Explorer starts it at logon with a
// normal token, which is exactly the context that can run Electron here.
const STARTUP_DIR = path.join(
  process.env.APPDATA || '',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup'
);
// Resolved per call (not at load) so tests can point DSH_HUD_STARTUP_CMD at a
// temp file and so a user-renamed entry is still detected by the same rule.
function startupCmdFile() {
  return process.env.DSH_HUD_STARTUP_CMD || path.join(STARTUP_DIR, 'dsh-hud.cmd');
}
// app.getAppPath() is missing in the unit-test electron stub; fall back to the
// on-disk layout (app/src -> app -> repo root).
function repoRoot() {
  try {
    if (typeof app.getAppPath === 'function') return path.resolve(app.getAppPath(), '..');
  } catch {
    /* fall through */
  }
  return path.resolve(__dirname, '..', '..');
}
const REPO_ROOT = repoRoot();

function devUserDataDir() {
  // Must match app/scripts/launch-hud.cjs and run-hud.cmd so every launch path
  // shares one single-instance lock (t13: two capsules otherwise).
  return path.join(REPO_ROOT, 'artifacts', 'udd-hud');
}

// The HUD itself runs at Low Mandatory Level and cannot write the Startup
// folder (probed: EPERM). The Cordis host is Medium, so ask it over the same
// request.json bridge the desktop-focus action uses.
function requestHostApply(enabled) {
  const ipcDir = path.join(REPO_ROOT, 'artifacts', 'ipc');
  const file = path.join(ipcDir, 'request.json');
  const tmp = path.join(ipcDir, `request.${process.pid}.${Date.now()}.tmp`);
  const payload = {
    id: 'autostart-' + Date.now(),
    action: 'autostart',
    enabled: !!enabled,
    at: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error('[hud] autostart request failed:', err && err.message);
    return false;
  }
}

// 打包/开发两种形态共用同一份登录脚本，只有命令行不同。打包产物必须带上
// --no-sandbox 与可写 --user-data-dir：登录时 Explorer 用普通令牌启动，
// 缺任何一个都会在 Chromium 初始化阶段失败（见 docs/environment.md）。
function startupScript() {
  const udd = app.isPackaged ? app.getPath('userData') : devUserDataDir();
  const start = `start "" "${process.execPath}" --no-sandbox --user-data-dir="${udd}"`;
  const lines = app.isPackaged
    ? [start]
    : ['set "ELECTRON_RUN_AS_NODE="', `${start} "${path.resolve(__dirname, '..')}"`];
  return ['@echo off', 'rem DSH HUD autostart (delete this file to disable).', ...lines, ''].join(
    '\r\n'
  );
}

// 直接写/删登录脚本。低完整性进程（被 DSH 宿主拉起时）会 EPERM，调用方回退
// 到宿主桥。
function writeStartup(enabled) {
  const file = startupCmdFile();
  try {
    if (!enabled) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return true;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, startupScript(), 'ascii');
    return true;
  } catch (err) {
    console.error('[hud] autostart script write failed:', err && err.message);
    return false;
  }
}

// 当前系统登录项状态：两种形态都看 Startup 目录里的脚本。
function isEnabled() {
  try {
    if (fs.existsSync(startupCmdFile())) return true;
  } catch {
    /* fall through to the persisted preference */
  }
  return readConfig().enabled;
}

// 持久化 + 应用。返回应用后的新状态。
function setEnabled(enabled) {
  writeConfig({ enabled: !!enabled });
  const written = writeStartup(!!enabled);
  if (!written) {
    // 低完整性：把选择交给 Medium 的宿主去落地。
    requestHostApply(enabled);
  }
  // 清理历史遗留的 HKCU Run 登录项（旧版本用 setLoginItemSettings(args:[]),
  // 那条命令缺少必要参数，永远起不来）。
  try {
    app.setLoginItemSettings({ openAtLogin: false });
  } catch {
    /* not fatal */
  }
  return isEnabled();
}

// 启动时应用持久化的选择（幂等）。只有用户显式设置过（存在配置文件）才
// 触碰系统登录项，避免首次运行写入无意义的注册表项。
function apply() {
  if (fs.existsSync(configPath())) {
    setEnabled(readConfig().enabled);
  }
}

module.exports = { isEnabled, setEnabled, apply };
