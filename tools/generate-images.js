'use strict';

/*
 * Generates the PNG assets required by the Homey app store:
 *
 *   assets/images/small.png                          250 x 250
 *   assets/images/large.png                          500 x 500
 *   assets/images/xlarge.png                        1000 x 1000
 *   drivers/venus_a/assets/images/small.png           75 x 75
 *   drivers/venus_a/assets/images/large.png          500 x 500
 *   drivers/venus_a/assets/images/xlarge.png        1000 x 1000
 *
 * Usage:  node tools/generate-images.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const APP_ROOT = path.resolve(__dirname, '..');

const TARGETS = [
  { file: 'assets/images/small.png', size: 250 },
  { file: 'assets/images/large.png', size: 500 },
  { file: 'assets/images/xlarge.png', size: 1000 },
  { file: 'drivers/venus_a/assets/images/small.png', size: 75 },
  { file: 'drivers/venus_a/assets/images/large.png', size: 500 },
  { file: 'drivers/venus_a/assets/images/xlarge.png', size: 1000 },
];

/* ------------------------------------------------------------------ *
 * Minimal PNG encoder (truecolour with alpha)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type: none
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * Drawing helpers (signed distance fields, unit coordinate space 0..1)
 * ------------------------------------------------------------------ */

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function sdRoundRect(px, py, cx, cy, halfWidth, halfHeight, radius) {
  const dx = Math.abs(px - cx) - (halfWidth - radius);
  const dy = Math.abs(py - cy) - (halfHeight - radius);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(dx, dy), 0) - radius;
}

function blend(state, red, green, blue, coverage) {
  if (coverage <= 0) return;
  const srcAlpha = coverage;
  const outAlpha = srcAlpha + state.a * (1 - srcAlpha);
  if (outAlpha <= 0) return;

  state.r = (red * srcAlpha + state.r * state.a * (1 - srcAlpha)) / outAlpha;
  state.g = (green * srcAlpha + state.g * state.a * (1 - srcAlpha)) / outAlpha;
  state.b = (blue * srcAlpha + state.b * state.a * (1 - srcAlpha)) / outAlpha;
  state.a = outAlpha;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size;
      const py = (y + 0.5) / size;

      const state = { r: 0, g: 0, b: 0, a: 0 };

      // Background: rounded square with a vertical brand gradient
      const backgroundCoverage = clamp01(0.5 - sdRoundRect(px, py, 0.5, 0.5, 0.5, 0.5, 0.24) * size);
      if (backgroundCoverage > 0) {
        const t = py;
        const red = Math.round(11 + (0 - 11) * t);
        const green = Math.round(40 + (163 - 40) * t);
        const blue = Math.round(72 + (224 - 72) * t);
        blend(state, red, green, blue, backgroundCoverage);
      }

      // Battery body (outline)
      const bodySd = sdRoundRect(px, py, 0.465, 0.5, 0.255, 0.17, 0.055);
      blend(state, 255, 255, 255, clamp01(0.5 - (Math.abs(bodySd) - 0.021) * size));

      // Battery terminal
      const terminalSd = sdRoundRect(px, py, 0.755, 0.5, 0.035, 0.075, 0.022);
      blend(state, 255, 255, 255, clamp01(0.5 - terminalSd * size));

      // Charge bars
      for (const centerX of [0.32, 0.465, 0.61]) {
        const barSd = sdRoundRect(px, py, centerX, 0.5, 0.042, 0.088, 0.02);
        blend(state, 53, 224, 138, clamp01(0.5 - barSd * size));
      }

      const offset = (y * size + x) * 4;
      rgba[offset] = Math.round(state.r);
      rgba[offset + 1] = Math.round(state.g);
      rgba[offset + 2] = Math.round(state.b);
      rgba[offset + 3] = Math.round(clamp01(state.a) * 255);
    }
  }

  return rgba;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const cache = new Map();

for (const target of TARGETS) {
  if (!cache.has(target.size)) {
    process.stdout.write(`Rendering ${target.size}x${target.size} ... `);
    cache.set(target.size, encodePng(target.size, target.size, render(target.size)));
    process.stdout.write('ok\n');
  }

  const destination = path.join(APP_ROOT, target.file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, cache.get(target.size));
  console.log(`Wrote ${target.file} (${target.size}x${target.size})`);
}

console.log('Klaar.');
