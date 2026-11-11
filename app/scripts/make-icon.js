'use strict';

// ---------------------------------------------------------------------------
// make-icon.js — 生成 DSH HUD 的应用图标。
//
// 输出（相对 app/build/）：
//   icon.png   256×256 RGBA（electron-builder 可直接用）
//   icon.ico   PNG-in-ICO 单帧 256×256（Windows exe 图标）
//
// 视觉：沿用 plugin/icon.svg 的品牌图形——蓝色圆角方块 + 两个白色节点 +
// 连接条（“DSH 双节点连接”标记），加一层垂直渐变增加质感。
//
// 用法（bundled node）：
//   node app\scripts\make-icon.js
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const OUT_DIR = path.join(__dirname, '..', 'build');

// ---- CRC32 (标准 PNG/ICO 校验) ----
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // ihdr[10..12] = 0 (compression / filter / interlace)
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter type None
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// 单帧 PNG-in-ICO（Windows Vista+ 支持 PNG 压缩条目）。
function encodeIco(pngBuf) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256 -> 0
  entry[1] = 0; // height 256 -> 0
  entry[2] = 0; // palette count
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuf.length, 8); // bytes in resource
  entry.writeUInt32LE(22, 12); // offset (6 + 16)
  return Buffer.concat([dir, entry, pngBuf]);
}

// ---- 形状 SDF（返回带符号距离，内部为负、边界为 0） ----
function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// 1px 平滑边缘覆盖（0..1）。
function cov(dist) {
  return Math.max(0, Math.min(1, 0.5 - dist));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// 渐变背景色（顶部 -> 底部）。
function bgColor(ty) {
  const top = [0x3d, 0x8b, 0xfd];
  const bottom = [0x1a, 0x5b, 0xb8];
  return [
    Math.round(lerp(top[0], bottom[0], ty)),
    Math.round(lerp(top[1], bottom[1], ty)),
    Math.round(lerp(top[2], bottom[2], ty)),
  ];
}

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);

  // 品牌几何（plugin/icon.svg 的 4× 放大）。
  const roundRect = { cx: 128, cy: 128, hw: 112, hh: 112, r: 56 };
  const circles = [
    { cx: 88, cy: 128, r: 28 },
    { cx: 168, cy: 128, r: 28 },
  ];
  const pill = { cx: 128, cy: 128, hw: 24, hh: 12, r: 12 };

  for (let y = 0; y < SIZE; y++) {
    const ty = y / (SIZE - 1);
    const [br, bg, bb] = bgColor(ty);
    for (let x = 0; x < SIZE; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      const bgA = cov(sdRoundRect(px, py, roundRect.cx, roundRect.cy, roundRect.hw, roundRect.hh, roundRect.r));

      let whiteA = cov(sdCircle(px, py, circles[0].cx, circles[0].cy, circles[0].r));
      whiteA = Math.max(whiteA, cov(sdCircle(px, py, circles[1].cx, circles[1].cy, circles[1].r)));
      whiteA = Math.max(whiteA, cov(sdRoundRect(px, py, pill.cx, pill.cy, pill.hw, pill.hh, pill.r)));

      // 白 over 背景（标准非预乘合成）。
      const a = whiteA + bgA * (1 - whiteA);
      let r = 0;
      let g = 0;
      let b = 0;
      let outA = 0;
      if (a > 0) {
        r = Math.round((255 * whiteA + br * bgA * (1 - whiteA)) / a);
        g = Math.round((255 * whiteA + bg * bgA * (1 - whiteA)) / a);
        b = Math.round((255 * whiteA + bb * bgA * (1 - whiteA)) / a);
        outA = Math.round(a * 255);
      }

      const o = (y * SIZE + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = outA;
    }
  }
  return rgba;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const png = encodePng(SIZE, SIZE, render());
  const pngPath = path.join(OUT_DIR, 'icon.png');
  const icoPath = path.join(OUT_DIR, 'icon.ico');
  fs.writeFileSync(pngPath, png);
  fs.writeFileSync(icoPath, encodeIco(png));
  console.log('[icon] wrote', pngPath, `(${png.length} bytes)`);
  console.log('[icon] wrote', icoPath, `(${icoPath && fs.statSync(icoPath).size} bytes)`);
}

main();
