'use strict';
/**
 * infra/cbor.js — minimal CBOR decoder (RFC 8949).
 *
 * WebAuthn hands the server two CBOR structures and there is no way around
 * parsing them: the attestationObject returned by navigator.credentials.create(),
 * and the COSE_Key holding the credential's public key inside it.
 *
 * Decode only — nothing here ever needs to produce CBOR. Scope is the subset
 * WebAuthn actually uses: unsigned/negative integers, byte strings, text
 * strings, arrays, maps, tags and simple values.
 *
 * Hardening: every input is attacker-supplied (it arrives from the browser), so
 * the decoder is bounded — it refuses indefinite-length items, caps nesting
 * depth, and never allocates based on a declared length without checking that
 * many bytes are actually present. A malformed blob throws; it must not be able
 * to hang the server or exhaust memory.
 */

const MAX_DEPTH = 16;

function decodeFirst(buf) {
  const state = { buf: Buffer.isBuffer(buf) ? buf : Buffer.from(buf), pos: 0 };
  const value = decodeItem(state, 0);
  return { value, bytesRead: state.pos };
}

function decode(buf) {
  const { value } = decodeFirst(buf);
  return value;
}

function need(s, n) {
  if (s.pos + n > s.buf.length) throw new Error('cbor: truncated input');
}

function readLength(s, info) {
  if (info < 24) return info;
  if (info === 24) { need(s, 1); return s.buf[s.pos++]; }
  if (info === 25) { need(s, 2); const v = s.buf.readUInt16BE(s.pos); s.pos += 2; return v; }
  if (info === 26) { need(s, 4); const v = s.buf.readUInt32BE(s.pos); s.pos += 4; return v; }
  if (info === 27) {
    need(s, 8);
    const v = s.buf.readBigUInt64BE(s.pos); s.pos += 8;
    // Beyond 2^53 a JS number silently loses precision; nothing in WebAuthn is
    // this large, so refuse rather than return a wrong value.
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cbor: integer too large');
    return Number(v);
  }
  if (info === 31) throw new Error('cbor: indefinite length not supported');
  throw new Error('cbor: reserved additional-information value ' + info);
}

function decodeItem(s, depth) {
  if (depth > MAX_DEPTH) throw new Error('cbor: nesting too deep');
  need(s, 1);
  const initial = s.buf[s.pos++];
  const major = initial >> 5;
  const info  = initial & 0x1f;

  switch (major) {
    case 0:   // unsigned integer
      return readLength(s, info);
    case 1:   // negative integer: encoded as -1 - n
      return -1 - readLength(s, info);
    case 2: { // byte string
      const len = readLength(s, info);
      need(s, len);
      const out = s.buf.subarray(s.pos, s.pos + len);
      s.pos += len;
      return Buffer.from(out);
    }
    case 3: { // text string
      const len = readLength(s, info);
      need(s, len);
      const out = s.buf.toString('utf8', s.pos, s.pos + len);
      s.pos += len;
      return out;
    }
    case 4: { // array
      const len = readLength(s, info);
      // Guard before allocating: a 4-byte length header can claim 4 billion items.
      if (len > s.buf.length) throw new Error('cbor: array length exceeds input');
      const arr = new Array(len);
      for (let i = 0; i < len; i++) arr[i] = decodeItem(s, depth + 1);
      return arr;
    }
    case 5: { // map
      const len = readLength(s, info);
      if (len > s.buf.length) throw new Error('cbor: map length exceeds input');
      // A Map, not an object: COSE keys are integers, and object keys would be
      // coerced to strings — losing the distinction between 1 and "1".
      const map = new Map();
      for (let i = 0; i < len; i++) {
        const k = decodeItem(s, depth + 1);
        const v = decodeItem(s, depth + 1);
        map.set(k, v);
      }
      return map;
    }
    case 6:   // tag — WebAuthn carries none that change semantics; decode the value
      readLength(s, info);
      return decodeItem(s, depth + 1);
    case 7:   // simple values / floats
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return undefined;
      if (info === 25) { need(s, 2); s.pos += 2; return null; }   // half float — unused
      if (info === 26) { need(s, 4); const v = s.buf.readFloatBE(s.pos); s.pos += 4; return v; }
      if (info === 27) { need(s, 8); const v = s.buf.readDoubleBE(s.pos); s.pos += 8; return v; }
      throw new Error('cbor: unsupported simple value ' + info);
    default:
      throw new Error('cbor: unknown major type ' + major);
  }
}

module.exports = { decode, decodeFirst };
