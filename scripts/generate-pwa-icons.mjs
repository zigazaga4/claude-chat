/**
 * Generates the PWA icon set from a single vector definition — no image
 * dependencies, just Node's zlib for PNG encoding. Re-run whenever the mark
 * changes:  node scripts/generate-pwa-icons.mjs
 *
 * Output:
 *   public/icon-192.png            maskable=false, rounded tile (browser menus)
 *   public/icon-512.png            maskable=false, rounded tile
 *   public/icon-maskable-512.png   maskable=true, full-bleed (OS applies mask)
 *   src/app/apple-icon.png         180px full-bleed (iOS rounds it itself)
 *
 * The mark is a white speech bubble with three accent dots on a violet→indigo
 * diagonal gradient — a chat glyph that reads at every size.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- palette -------------------------------------------------------------
const GRAD_A = [168, 85, 247]; // violet-500  (top-left)
const GRAD_B = [79, 70, 229]; //  indigo-600  (bottom-right)
const BUBBLE = [255, 255, 255];
const DOT = [99, 60, 214]; //     violet-700-ish accent inside the bubble

// ---- tiny vector helpers (all in normalized [0,1] space) -----------------
const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
const lerp = (a, b, t) => a + (b - a) * t;

function insideRoundRect(u, v, x0, y0, x1, y1, r) {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const cx = clamp(u, x0 + r, x1 - r);
  const cy = clamp(v, y0 + r, y1 - r);
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= r * r;
}

function insideCircle(u, v, cx, cy, rad) {
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= rad * rad;
}

function insideTriangle(u, v, ax, ay, bx, by, cx, cy) {
  const d1 = (u - bx) * (ay - by) - (ax - bx) * (v - by);
  const d2 = (u - cx) * (by - cy) - (bx - cx) * (v - cy);
  const d3 = (u - ax) * (cy - ay) - (cx - ax) * (v - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** RGBA (0..255) of one sub-sample, or null for transparent. */
function shade(u, v, maskable) {
  // Tile: full-bleed for maskable, rounded with transparent corners for "any".
  if (!maskable && !insideRoundRect(u, v, 0, 0, 1, 1, 0.18)) return null;

  // Speech bubble body + downward tail (kept inside the maskable safe zone).
  const inBubble =
    insideRoundRect(u, v, 0.22, 0.26, 0.78, 0.64, 0.1) ||
    insideTriangle(u, v, 0.33, 0.6, 0.3, 0.75, 0.47, 0.6);

  if (inBubble) {
    // Accent dots punched into the white bubble.
    for (const cx of [0.36, 0.5, 0.64]) {
      if (insideCircle(u, v, cx, 0.45, 0.045)) return [...DOT, 255];
    }
    return [...BUBBLE, 255];
  }

  // Background diagonal gradient.
  const t = clamp((u + v) / 2, 0, 1);
  return [
    Math.round(lerp(GRAD_A[0], GRAD_B[0], t)),
    Math.round(lerp(GRAD_A[1], GRAD_B[1], t)),
    Math.round(lerp(GRAD_A[2], GRAD_B[2], t)),
    255,
  ];
}

/** Render an antialiased RGBA buffer via SxS supersampling. */
function render(size, maskable, S = 4) {
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (px + (sx + 0.5) / S) / size;
          const v = (py + (sy + 0.5) / S) / size;
          const c = shade(u, v, maskable);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 255;
          }
        }
      }
      const n = S * S;
      const i = (py * size + px) * 4;
      // Straight (non-premultiplied) alpha: average the color over only the
      // COVERED sub-samples; alpha is the covered fraction. `cov` is the count
      // of covered sub-samples (each contributed 255 to `a`).
      const cov = a / 255;
      buf[i] = cov ? Math.round(r / cov) : 0;
      buf[i + 1] = cov ? Math.round(g / cov) : 0;
      buf[i + 2] = cov ? Math.round(b / cov) : 0;
      buf[i + 3] = Math.round(a / n);
    }
  }
  return buf;
}

// ---- minimal PNG encoder (RGBA, 8-bit, no filtering) ---------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0

  // Prefix each scanline with filter byte 0.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function write(relPath, size, maskable) {
  const abs = join(ROOT, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, encodePng(size, render(size, maskable)));
  console.log(`  ${relPath}  (${size}px, ${maskable ? 'maskable' : 'any'})`);
}

console.log('Generating PWA icons…');
write('public/icon-192.png', 192, false);
write('public/icon-512.png', 512, false);
write('public/icon-maskable-512.png', 512, true);
write('src/app/apple-icon.png', 180, true);
console.log('Done.');
