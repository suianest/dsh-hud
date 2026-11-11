'use strict';

// ---------------------------------------------------------------------------
// make-portable.js — 手动打包 fallback（纯 JS，不 spawn 子进程）
//
// 产出 dist/win-unpacked/（可运行便携目录）+ dist/*.zip。
// 在 DSH agent 沙箱内可用（electron-builder 收集 node_modules 时 spawn pnpm
// 会撞 EPERM 边界，本脚本绕开它）。
//
// 注意：本脚本不嵌入图标、不写 exe 版本资源；完整构建请用
// build-portable.cmd（electron-builder，会做图标 + zip + 版本资源）。
//
// 用法：
//   node app\scripts\make-portable.js
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

// APP_DIR 可被 DSH_HUD_APP_DIR 覆盖，供 t24 自测「缺件必须非 0 退出」：
// 把 app 复制到临时目录删掉某文件，再 DSH_HUD_APP_DIR=<temp> node make-portable.js。
// 只覆盖 APP_DIR；负测在 assertSourceFiles 阶段即退出，不会触及后续拷贝。
const APP_DIR = process.env.DSH_HUD_APP_DIR
  ? path.resolve(process.env.DSH_HUD_APP_DIR)
  : path.resolve(__dirname, '..');
const ROOT = path.resolve(APP_DIR, '..');
const ELECTRON_DIST = path.join(ROOT, 'runtime', 'node_modules', 'electron', 'dist');
const OUT_DIR = path.join(ROOT, 'dist', 'win-unpacked');
const STAGE_DIR = path.join(ROOT, 'dist', '.staging');
const EXE_NAME = 'DSH HUD.exe';

// 与 package.json build.files 保持一致（打包进 app.asar 的内容）。
const APP_FILES = ['main.js', 'preload.js', 'src', 'renderer', 'scripts', 'package.json'];

// 静态 canonical 清单（t24 #1）：逐条写死关键文件，供「打包前源文件存在性」
// 与「打包后 asar 条目」两处断言共用。必须静态，不能用 readdirSync 动态生成
// —— 否则删掉 src/hud-window.js 后清单里也没了它，断言永远查不出缺件。
const CANONICAL_FILES = [
  'main.js',
  'preload.js',
  'package.json',
  'src/autostart.js',
  'src/compact-css.js',
  'src/constants.js',
  'src/control.js',
  'src/discovery.js',
  'src/extensions.js',
  'src/hotkeys.js',
  'src/hud-window.js',
  'src/web-embed.js',
  'src/window-state.js',
  'renderer/error.html',
  'renderer/host-bounds.js',
  'renderer/hud.css',
  'renderer/hud.js',
  'renderer/index.html',
  'renderer/web-preload.js',
  'renderer/whale.svg',
  'scripts/focus-dsh.ps1',
  'scripts/launch-hud.cjs',
];

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

// 打包开始前断言源文件齐全（t24 #1）：任何关键文件缺失立刻非 0 退出并打印。
function assertSourceFiles() {
  const missing = CANONICAL_FILES.filter((p) => !fs.existsSync(path.join(APP_DIR, p)));
  if (missing.length) {
    console.error('[make-portable] SOURCE FILE ASSERTION FAILED — missing:');
    for (const m of missing) console.error('  - ' + m);
    process.exit(1);
  }
  console.log(`[make-portable] source files assertion OK (${CANONICAL_FILES.length} canonical files present)`);
}

// afterPack 断言（t24 #1）：app.asar 必须包含 canonical 清单里的关键文件。任何
// 缺失都 console.error 并 process.exit(1)，让 CI/用户侧脚本能靠退出码判定构建失效。
async function assertAsarContents(asarPath) {
  const list = await asar.listPackage(asarPath);
  // @electron/asar listPackage returns entries like "\\main.js" and
  // "\\renderer\\error.html" (leading backslash + backslash separators).
  // Normalize to bare forward-slash paths before the membership check.
  const present = new Set(list.map((p) => p.replace(/\\/g, '/').replace(/^\/+/, '')));

  const missing = CANONICAL_FILES.filter((p) => !present.has(p));
  if (missing.length) {
    console.error('[make-portable] ASAR CONTENT ASSERTION FAILED — missing:');
    for (const m of missing) console.error('  - ' + m);
    process.exit(1);
  }
  console.log(`[make-portable] asar content assertion OK (${CANONICAL_FILES.length} canonical entries present)`);
}

// ---------------------------------------------------------------------------
// 打包后处理（每次重建 dist 都会丢，必须在构建末尾自动补回来）：
//   1. resources/artifacts -> 仓库 artifacts 的目录联接：HUD 侧 _ipcDir() 在
//      打包后落到 resources\artifacts\ipc，插件轮询的是 仓库\artifacts\ipc，
//      两者必须指到同一份文件，否则「打开 DSH 桌面窗口」永远 host timeout。
//   2. 启动 DSH HUD.cmd（ASCII+CRLF，带 --no-sandbox 与可写 --user-data-dir）。
//   3. DSH HUD.lnk（无黑框的日常入口，参数同 cmd）。
// ---------------------------------------------------------------------------

function ensureIpcJunction() {
  const linkPath = path.join(OUT_DIR, 'resources', 'artifacts');
  const target = path.join(ROOT, 'artifacts');
  if (!fs.existsSync(target)) {
    console.log('[make-portable] skip ipc junction: repo artifacts dir missing');
    return false;
  }
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink()) {
      const current = fs.readlinkSync(linkPath);
      if (path.resolve(current) === path.resolve(target)) return true;
      fs.unlinkSync(linkPath);
    } else {
      rmrf(linkPath);
    }
  } catch {
    /* missing: create below */
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, 'junction');
  console.log('[make-portable] ipc junction created:', linkPath, '->', target);
  return true;
}

function writeLauncherCmd() {
  const udd = path.join(OUT_DIR, 'udd');
  fs.mkdirSync(udd, { recursive: true });
  const body = [
    '@echo off',
    'rem DSH HUD launcher (packaged build).',
    'rem --no-sandbox and a writable --user-data-dir are both required here:',
    'rem Chromium fails before JS runs without them (see docs/environment.md).',
    'set "DSH_HUD_USER_DATA=%~dp0udd"',
    `start "" "%~dp0${EXE_NAME}" --no-sandbox --user-data-dir="%~dp0udd"`,
    '',
  ].join('\r\n');
  const file = path.join(OUT_DIR, '启动 DSH HUD.cmd');
  fs.writeFileSync(file, body, 'ascii');
  console.log('[make-portable] launcher written:', file);
  return file;
}

function writeShortcut() {
  const lnk = path.join(OUT_DIR, 'DSH HUD.lnk');
  const exe = path.join(OUT_DIR, EXE_NAME);
  const udd = path.join(OUT_DIR, 'udd');
  const ps = [
    "$s = New-Object -ComObject WScript.Shell;",
    `$l = $s.CreateShortcut('${lnk.replace(/'/g, "''")}');`,
    `$l.TargetPath = '${exe.replace(/'/g, "''")}';`,
    `$l.Arguments = '--no-sandbox --user-data-dir="${udd.replace(/'/g, "''")}"';`,
    `$l.WorkingDirectory = '${OUT_DIR.replace(/'/g, "''")}';`,
    "$l.Save();",
  ].join(' ');
  try {
    require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: 'ignore',
    });
    console.log('[make-portable] shortcut written:', lnk);
    return true;
  } catch (err) {
    console.error('[make-portable] shortcut failed (launcher cmd still works):', err && err.message);
    return false;
  }
}

function writeZip() {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
  const zipPath = path.join(ROOT, 'dist', `DSH-HUD-${pkg.version}-win-x64.zip`);
  // Compress-Archive does not follow junctions (verified: total=77, no
  // artifacts\** entries), so the IPC junction can stay attached.
  try {
    fs.rmSync(zipPath, { force: true });
    const ps = [
      `Compress-Archive -Path '${path.join(OUT_DIR, '*').replace(/'/g, "''")}'`,
      `-DestinationPath '${zipPath.replace(/'/g, "''")}' -CompressionLevel Optimal -Force`,
    ].join(' ');
    require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: 'ignore',
    });
    console.log('[make-portable] zip:', zipPath, `${fs.statSync(zipPath).size} bytes`);
    return zipPath;
  } catch (err) {
    console.error('[make-portable] zip failed (win-unpacked is still usable):', err && err.message);
    return null;
  }
}

function postBuild() {
  if (!fs.existsSync(OUT_DIR)) {
    console.error('[make-portable] post-build skipped: output dir missing:', OUT_DIR);
    process.exit(1);
  }
  ensureIpcJunction();
  writeLauncherCmd();
  writeShortcut();
  if (!process.argv.includes('--no-zip')) writeZip();
}

async function main() {
  const postOnly = process.argv.includes('--post-only');

  if (!postOnly) {
  // 0. 打包开始前先断言源文件齐全（t24 #1），缺件立刻非 0 退出。
  assertSourceFiles();

  // 1. 暂存 app 文件
  rmrf(STAGE_DIR);
  fs.mkdirSync(STAGE_DIR, { recursive: true });
  for (const f of APP_FILES) {
    const s = path.join(APP_DIR, f);
    const d = path.join(STAGE_DIR, f);
    const st = fs.statSync(s);
    if (st.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
    }
  }

  // 2. 拷贝 Electron dist（runtime 44.7.0，与开发运行一致）。
  //    每次全量重建，避免旧 45.2.2 的 dll/locales 残留造成版本混杂（t21 #1）。
  rmrf(OUT_DIR);
  console.log('[make-portable] copying Electron dist (runtime 44.7.0) ...');
  copyDir(ELECTRON_DIST, OUT_DIR);

  // 3. 打包 app.asar
  const asarPath = path.join(OUT_DIR, 'resources', 'app.asar');
  fs.mkdirSync(path.dirname(asarPath), { recursive: true });
  console.log('[make-portable] packing app.asar ...');
  await asar.createPackage(STAGE_DIR, asarPath);

  // 3b. afterPack 断言（t21 #1）：asar 必须包含关键脚本与源码，任何缺失非 0 退出。
  await assertAsarContents(asarPath);

  // 4. 重命名 exe
  const exeFrom = path.join(OUT_DIR, 'electron.exe');
  const exeTo = path.join(OUT_DIR, EXE_NAME);
  if (fs.existsSync(exeFrom)) {
    if (fs.existsSync(exeTo)) fs.rmSync(exeTo, { force: true });
    fs.renameSync(exeFrom, exeTo);
  }

  // 5. 清理暂存目录
  rmrf(STAGE_DIR);

  const list = await asar.listPackage(asarPath);
  console.log('[make-portable] app.asar entries:', list.length);
  console.log('[make-portable] exe:', exeTo, fs.existsSync(exeTo) ? 'OK' : 'MISSING');
  console.log('[make-portable] app.asar:', asarPath, `${fs.statSync(asarPath).size} bytes`);
  }

  postBuild();
  console.log('[make-portable] done:', OUT_DIR);
}

main().catch((err) => {
  console.error('[make-portable] failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
