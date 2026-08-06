'use strict';
/**
 * infra/qr.js — minimal QR Code generator (ISO/IEC 18004), byte mode.
 *
 * Exists because enrolling an authenticator app means scanning an otpauth://
 * URI, and this project carries zero npm dependencies. Scope is deliberately
 * narrow — exactly what that one job needs and nothing more:
 *
 *   • byte mode only (an otpauth URI is ASCII)
 *   • versions 1–10, chosen automatically by payload length
 *   • error-correction level M (~15%), the level authenticator apps expect
 *   • SVG output — crisp at any size, no canvas, no base64 image
 *
 * A typical otpauth URI for this app is ~110 bytes → version 5–6. The version
 * ceiling of 10 leaves a wide margin; encode() throws rather than silently
 * emitting an unscannable code if a payload ever exceeds it.
 */

/* ── Galois field GF(256) tables for Reed–Solomon ── */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;          // primitive polynomial x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

/** Reed–Solomon generator polynomial of the given degree. */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

/* Per-version parameters for EC level M:
 *   [ totalCodewords, ecCodewordsPerBlock, group1Blocks, group2Blocks ]
 * Table values are from ISO/IEC 18004 Table 9. */
const VERSIONS = {
  1:  [26,   10, 1, 0],
  2:  [44,   16, 1, 0],
  3:  [70,   26, 1, 0],
  4:  [100,  18, 2, 0],
  5:  [134,  24, 2, 0],
  6:  [172,  16, 4, 0],
  7:  [196,  18, 4, 0],
  8:  [242,  22, 2, 2],
  9:  [292,  22, 3, 2],
  10: [346,  26, 4, 1],
};
const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const size = (v) => v * 4 + 17;
function dataCapacity(v) {
  const [total, ecPerBlock, g1, g2] = VERSIONS[v];
  return total - ecPerBlock * (g1 + g2);
}

function chooseVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    // 4-bit mode indicator + length field (8 bits < v10, else 16) + payload
    const lenBits = v < 10 ? 8 : 16;
    const needed = Math.ceil((4 + lenBits + byteLen * 8) / 8);
    if (needed <= dataCapacity(v)) return v;
  }
  throw new Error('qr: payload too large (' + byteLen + ' bytes exceeds version 10)');
}

/* ── Bit stream ── */
function buildData(bytes, version) {
  const capacity = dataCapacity(version) * 8;
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };

  push(0b0100, 4);                                  // byte mode
  push(bytes.length, version < 10 ? 8 : 16);        // character count
  for (const b of bytes) push(b, 8);

  push(0, Math.min(4, capacity - bits.length));     // terminator
  while (bits.length % 8) bits.push(0);             // pad to byte boundary
  // Alternating pad codewords, per spec
  const PAD = [0xec, 0x11];
  for (let i = 0; bits.length < capacity; i++) push(PAD[i % 2], 8);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  return codewords;
}

/** Split into blocks, RS-encode each, then interleave data then EC. */
function interleave(codewords, version) {
  const [total, ecPerBlock, g1, g2] = VERSIONS[version];
  const numBlocks = g1 + g2;
  const dataTotal = total - ecPerBlock * numBlocks;
  const g1Len = Math.floor(dataTotal / numBlocks);
  const g2Len = g1Len + 1;

  const blocks = [];
  let pos = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = i < g1 ? g1Len : g2Len;
    const data = codewords.slice(pos, pos + len);
    pos += len;
    blocks.push({ data, ec: rsEncode(data, ecPerBlock) });
  }

  const out = [];
  for (let i = 0; i < g2Len; i++)
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecPerBlock; i++)
    for (const b of blocks) out.push(b.ec[i]);
  return out;
}

/* ── Matrix construction ── */
function makeMatrix(version, codewords) {
  const n = size(version);
  const m = Array.from({ length: n }, () => new Array(n).fill(null));   // null = free
  const reserve = (r, c, v) => { if (r >= 0 && r < n && c >= 0 && c < n) m[r][c] = v; };

  // Finder patterns + separators
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                       (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                       (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        reserve(row + r, col + c, inRing ? 1 : 0);
      }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);

  // Timing patterns
  for (let i = 8; i < n - 8; i++) { m[6][i] = i % 2 === 0 ? 1 : 0; m[i][6] = i % 2 === 0 ? 1 : 0; }

  // Alignment patterns (skip where they'd collide with a finder)
  const centres = ALIGNMENT[version];
  for (const r of centres) for (const c of centres) {
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= n - 9) || (r >= n - 9 && c <= 8)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
      m[r + dr][c + dc] = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0;
  }

  m[n - 8][8] = 1;                       // dark module

  // Reserve format-info areas so data placement skips them
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = 0;
    if (m[i][8] === null) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][n - 1 - i] === null) m[8][n - 1 - i] = 0;
    if (m[n - 1 - i][8] === null) m[n - 1 - i][8] = 0;
  }

  // Place data: two-module-wide columns, right to left, alternating direction
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);

  let bitIdx = 0, upward = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;                                  // skip the timing column
    const rows = upward ? [...Array(n).keys()].reverse() : [...Array(n).keys()];
    for (const row of rows) {
      for (const c of [col, col - 1]) {
        if (m[row][c] !== null) continue;
        m[row][c] = bitIdx < bits.length ? bits[bitIdx++] : 0;
      }
    }
    upward = !upward;
  }
  return m;
}

// The eight standard data-mask patterns.
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Which modules are function patterns (must not be masked). */
function functionMask(version) {
  const n = size(version);
  const f = Array.from({ length: n }, () => new Array(n).fill(false));
  const mark = (r, c) => { if (r >= 0 && r < n && c >= 0 && c < n) f[r][c] = true; };
  const block = (row, col, h, w) => {
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) mark(row + r, col + c);
  };
  block(0, 0, 9, 9); block(0, n - 8, 9, 8); block(n - 8, 0, 8, 9);
  for (let i = 0; i < n; i++) { mark(6, i); mark(i, 6); }
  const centres = ALIGNMENT[version];
  for (const r of centres) for (const c of centres) {
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= n - 9) || (r >= n - 9 && c <= 8)) continue;
    block(r - 2, c - 2, 5, 5);
  }
  return f;
}

const FORMAT_M = [   // pre-computed 15-bit format strings, EC level M, masks 0–7
  0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0,
];

function applyFormat(m, maskIdx) {
  const n = m.length;
  const fmt = FORMAT_M[maskIdx];
  const bit = (i) => (fmt >>> i) & 1;
  for (let i = 0; i <= 5; i++) m[8][i] = bit(14 - i);
  m[8][7] = bit(8); m[8][8] = bit(7); m[7][8] = bit(6);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = bit(14 - i);
  for (let i = 0; i <= 7; i++) m[n - 1 - i][8] = bit(i);
  for (let i = 8; i <= 14; i++) m[8][n - 15 + i] = bit(i);
  m[n - 8][8] = 1;
}

/** Penalty score (ISO 18004 §8.8.2) — lower is better. */
function penalty(m) {
  const n = m.length;
  let score = 0;
  // Rule 1: runs of 5+ same-colour modules
  for (let i = 0; i < n; i++) {
    for (const line of [m[i], m.map(r => r[i])]) {
      let run = 1;
      for (let j = 1; j < n; j++) {
        if (line[j] === line[j - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
  }
  // Rule 2: 2x2 blocks of one colour
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++)
    if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
  // Rule 3: finder-like 1:1:3:1:1 patterns
  const PAT = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const hasPat = (line, start) => PAT.every((v, k) => line[start + k] === v);
  for (let i = 0; i < n; i++) {
    const row = m[i], col = m.map(r => r[i]);
    for (let j = 0; j + 11 <= n; j++) {
      if (hasPat(row, j)) score += 40;
      if (hasPat(col, j)) score += 40;
    }
  }
  // Rule 4: deviation from 50% dark
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

/** @returns {number[][]} matrix of 0/1 modules (no quiet zone). */
function encodeMatrix(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  const version = chooseVersion(bytes.length);
  const codewords = interleave(buildData(bytes, version), version);
  const base = makeMatrix(version, codewords);
  const fn = functionMask(version);

  // Try all eight masks, keep the lowest-penalty one — required by the spec and
  // the difference between a code that scans instantly and one that doesn't.
  let best = null, bestScore = Infinity;
  for (let k = 0; k < 8; k++) {
    const m = base.map(r => r.slice());
    for (let r = 0; r < m.length; r++)
      for (let c = 0; c < m.length; c++)
        if (!fn[r][c] && MASKS[k](r, c)) m[r][c] ^= 1;
    applyFormat(m, k);
    const s = penalty(m);
    if (s < bestScore) { bestScore = s; best = m; }
  }
  return best;
}

/**
 * Render as a self-contained SVG string.
 * `quiet` is the mandatory 4-module light border — omitting it is the single
 * most common reason a generated QR will not scan.
 */
function svg(text, opts) {
  const o = opts || {};
  const scale = o.scale || 4;
  const quiet = o.quiet == null ? 4 : o.quiet;
  const m = encodeMatrix(text);
  const n = m.length;
  const dim = (n + quiet * 2) * scale;

  // One <path> for every dark module beats one <rect> each: ~4x smaller output.
  let d = '';
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (m[r][c]) d += 'M' + ((c + quiet) * scale) + ' ' + ((r + quiet) * scale) +
                        'h' + scale + 'v' + scale + 'h-' + scale + 'z';

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim +
         '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges" role="img" ' +
         'aria-label="QR code for authenticator enrolment">' +
         '<rect width="' + dim + '" height="' + dim + '" fill="#ffffff"/>' +
         '<path d="' + d + '" fill="#000000"/></svg>';
}

module.exports = { svg, encodeMatrix, chooseVersion };
