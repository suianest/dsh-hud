'use strict';

// ---------------------------------------------------------------------------
// DSH HUD — main entry (悬浮胶囊 + 520px 紧凑面板)
//
// Boot order:
//   1. single-instance lock (second launch raises the existing panel)
//   2. userData override support (DSH_HUD_USER_DATA) for dev/sandbox
//   3. create the HudWindow, load the local shell, show the capsule
//   4. register the global hotkey (default Ctrl+Alt+Space)
//
// Run OUTSIDE the DSH agent sandbox, e.g.:
//   scripts\run-hud.cmd
// (The agent sandbox kills Chromium's renderer — see README-ENV.md §0.)
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, globalShortcut } = require('electron');

// ---------------------------------------------------------------------------
// Boot trace. Written before userData/session setup so that even a start that
// dies early leaves evidence, and never through the app's own logger (which
// needs userData to exist first). LocalAppData is always user-writable, so this
// works for a plain double-click and for a dev run alike.
// ---------------------------------------------------------------------------
const BOOT_LOG_DIRS = [
  path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'dsh-hud'),
  // Next to the executable: the one directory we know the user can open, and
  // writable even when %LOCALAPPDATA% is locked down (restricted token).
  process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath),
  path.join(os.tmpdir(), 'dsh-hud'),
];
const BOOT_LINE_PREFIX = () => `${new Date().toISOString()} pid=${process.pid} `;
function bootLog(line) {
  const text = BOOT_LINE_PREFIX() + line + '\n';
  for (const dir of BOOT_LOG_DIRS) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'boot.log'), text);
    } catch {}
  }
}
bootLog(`boot exe=${process.execPath} packaged=${app.isPackaged} argv=${process.argv.slice(1).join(' ')}`);

// NOTE: --no-sandbox cannot be applied from here. Chromium's sandbox is
// initialized before the main script runs, so app.commandLine.appendSwitch()
// is too late: on hardened installs the process dies with STATUS_BREAKPOINT
// (0x80000003) before this file executes. The switch must come from the
// launcher/command line (see 启动 DSH HUD.cmd and DSH HUD.lnk).
process.on('uncaughtException', (err) => {
  bootLog('uncaught ' + ((err && err.stack) || err));
});
process.on('unhandledRejection', (err) => {
  bootLog('unhandledRejection ' + ((err && err.stack) || err));
});

const HudWindow = require('./src/hud-window');
const autostart = require('./src/autostart');
const { ControlBridge } = require('./src/control');
const extensions = require('./src/extensions');

// Keep all profile/crashpad writes inside a known dir. Defaults to the OS
// standard (%APPDATA%\<app name>); override for sandboxed/dev runs. When the
// default location is not writable (redirected or locked-down profile), fall
// back to %LOCALAPPDATA% instead of dying inside Chromium's cache setup.
if (process.env.DSH_HUD_USER_DATA) {
  app.setPath('userData', process.env.DSH_HUD_USER_DATA);
} else {
  const preferred = app.getPath('userData');
  const writable = (dir) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (writable(preferred)) {
    bootLog(`userData ${preferred}`);
  } else {
    const fallback = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'DSH HUD');
    if (writable(fallback)) {
      app.setPath('userData', fallback);
      bootLog(`userData fallback ${fallback} (preferred ${preferred} not writable)`);
    } else {
      bootLog(`userData unavailable: ${preferred} and ${fallback}`);
    }
  }
}

// 生产模式禁 devtools：只有 DSH_HUD_DEV=1 才允许。拦截默认快捷键
// (F12 / Ctrl+Shift+I / Ctrl+Shift+J)。此处理器对 shell 与内嵌 WebContentsView
// 的 webContents 都生效（web-contents-created 会为两者触发）。
app.on('web-contents-created', (_event, contents) => {
  if (process.env.DSH_HUD_DEV === '1') return;
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const k = (input.key || '').toLowerCase();
    if (
      input.key === 'F12' ||
      (input.control && input.shift && (k === 'i' || k === 'j'))
    ) {
      event.preventDefault();
    }
  });
});

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  // Another HUD instance is already running; hand off and exit. Say why on
  // stderr so a capture/debug script is not left with a silent exit 0.
  console.error('[hud] another instance is already running (single-instance lock) - exiting');
  app.quit();
} else {
  let hud = null;
  let control = null;

  app.on('second-instance', () => {
    // 重拉去抖（D4）：不再无条件 showPanel。仅当窗口可见时聚焦；不可见
    // （例如启动早期）不弹面板。实际的 show/toggle 由 control.json 通道驱动。
    if (hud) hud.focusIfVisible();
  });

  app.whenReady().then(() => {
    // 开机自启：应用用户持久化的选择（首次运行/无配置文件时不触碰）。
    autostart.apply();

    // 外部扩展（P-03）：exe 同级 extensions/ 与 userData/extensions/ 下的
    // *.js 会在建窗前加载，注册进 menu / control / css 三个扩展点。
    // 只读本地文件；出错只记日志，绝不影响启动。DSH_HUD_NO_EXTENSIONS=1 可关。
    try {
      extensions.loadExtensionFiles(
        [
          path.join(path.dirname(process.execPath), 'extensions'),
          path.join(app.getPath('userData'), 'extensions'),
        ],
        { log: (line) => bootLog(line) }
      );
    } catch (err) {
      bootLog(`[hud] extension loader crashed: ${(err && err.message) || err}`);
    }

    hud = new HudWindow();
    const win = hud.create();

    // Global hotkey (must be after 'ready'); capsule click remains available
    // even if the accelerator is taken by another app.
    hud.setupHotkey();

    // control.json + stdin 控制桥（D3）：让 /dsh-hud 命令与 origin 变化能
    // 真正驱动 HUD。seq 去重状态持久化到 userData/control-state.json。
    control = new ControlBridge(
      {
        toggle: () => { if (hud) hud.toggle(); },
        show: () => { if (hud) hud.showPanel(); },
        hide: () => { if (hud) hud.showCapsule(); },
        reload: () => { if (hud) hud.reloadWeb(); },
      },
      { statePath: path.join(app.getPath('userData'), 'control-state.json') }
    );
    control.start();

    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error('[hud] did-fail-load', code, desc, url);
    });

    hud.load().catch((err) => {
      console.error('[hud] load failed:', err && err.message);
    });

    win.once('ready-to-show', () => {
      if (process.env.DSH_HUD_CAPTURE) {
        // 真机取证开关：抓面板/胶囊截图后退出（默认不激活）。
        runCaptureFlow(hud);
      } else {
        hud.showCapsule();
      }
    });
  });

  app.on('activate', () => {
    if (hud) hud.showPanel();
  });

  // Always release global shortcuts on quit; the OS drops them with the process
  // anyway, but this keeps re-registration during dev/test clean.
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (control) control.stop();
    // 释放 ipcMain/screen 监听并销毁内嵌 Web UI（t14 #19），避免未来
    // 「关闭后再开」或第二个窗口时重复注册 handler。
    if (hud) hud.destroy();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

// ---------------------------------------------------------------------------
// 真机取证开关（DSH_HUD_CAPTURE=<png 路径>，默认关闭，不影响正常行为）：
//   1. 展开面板，等内嵌 Web UI 加载完成后抓 shell + Web UI 两张图
//   2. 切回胶囊态，再抓一张
//   3. 退出进程
// 仅在显式设置该环境变量时激活。
// ---------------------------------------------------------------------------
function capturePaths(base) {
  const stem = base.replace(/\.png$/i, '');
  return {
    panelShell: `${stem}.png`,
    panelWeb: `${stem}.web.png`,
    capsule: `${stem}.capsule.png`,
  };
}

function writeCapture(filePath, buf) {
  try {
    fs.writeFileSync(filePath, buf);
    console.log('[hud] capture written:', filePath);
  } catch (err) {
    console.error('[hud] capture write failed:', filePath, err && err.message);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCaptureFlow(hud) {
  const paths = capturePaths(process.env.DSH_HUD_CAPTURE);
  let done = false;

  const capturePanel = async () => {
    if (done) return;
    done = true;
    try {
      const shellImg = await hud.win.webContents.capturePage();
      writeCapture(paths.panelShell, shellImg.toPNG());
      if (hud.web && hud.web.view) {
        const webImg = await hud.web.view.webContents.capturePage();
        writeCapture(paths.panelWeb, webImg.toPNG());
      }
    } catch (err) {
      console.error('[hud] panel capture failed:', err && err.message);
    }
    await captureCapsule();
  };

  const captureCapsule = async () => {
    hud.showCapsule();
    // 静态截图里没有真实鼠标，悬停荧光环不会自己出现：临时加 demo-hover
    // 让环出现，并等 700ms 让它转到一个明显可见的角度（2.4s 一圈 ≈ 105°）。
    try {
      await hud.win.webContents.executeJavaScript(
        "document.body.classList.add('demo-hover')", true);
    } catch (err) {
      console.error('[hud] capsule demo-hover failed:', err && err.message);
    }
    await delay(700); // 让胶囊态渲染一帧 + 荧光环转到位
    try {
      const img = await hud.win.webContents.capturePage();
      writeCapture(paths.capsule, img.toPNG());
    } catch (err) {
      console.error('[hud] capsule capture failed:', err && err.message);
    }
    app.quit();
  };

  // onLoaded 必须在 showPanel() 之前赋值：showPanel 会触发首次 load，若
  // did-finish-load 已经发生再赋值，就永远错过回调只能等 8s 兜底（t14 #23）。
  if (hud.web) {
    hud.web.onLoaded = () => setTimeout(capturePanel, 1500);
  }
  hud.showPanel();

  // 兜底：即使 discovery 缺失 / Web UI 停在错误页，也按时抓取。
  setTimeout(capturePanel, 8000);
}
