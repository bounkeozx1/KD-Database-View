'use strict';
/**
 * infra/zip.js — ZIP writer and reader, zero dependencies (P5.1).
 *
 * ══════════════════════════════════════════════════════════════════
 * Why hand-rolled, and why ZIP
 * ══════════════════════════════════════════════════════════════════
 * The server has no npm dependencies and that property is worth keeping. Node
 * ships zlib and crypto, which is everything a ZIP needs.
 *
 * ZIP rather than tar for one decisive reason: the central directory sits at the
 * END of the file and indexes every entry by offset. That means verification can
 * read `manifest.json` out of a 700 MB backup, and check one file's checksum,
 * WITHOUT streaming the whole archive. With tar, every verification and every
 * preview would have to read 700 MB. Phases 3 and 4 of this work are only
 * practical because of that random access.
 *
 * ══════════════════════════════════════════════════════════════════
 * The rule this module follows above all others
 * ══════════════════════════════════════════════════════════════════
 * A backup that only THIS code can open is not a backup. If the server is gone,
 * an operator with a laptop and `unzip` must still be able to recover. So:
 *
 *   • no custom container, no proprietary framing — a plain, standard ZIP;
 *   • no data descriptors: sizes and CRCs are known before each local header is
 *     written, which keeps the archive readable by the strictest tools;
 *   • Zip64 only when genuinely required, because emitting it unconditionally
 *     breaks some older extractors.
 *
 * That is verified, not assumed: the test suite extracts archives written here
 * with the operating system's own unzip and compares bytes.
 *
 * ── Compression policy ────────────────────────────────────────────
 * DEFLATE for the database, JSON and text. STORE for everything else.
 *
 * The uploads are 3 212 JPEG/PNG/PDF files — already compressed. Deflating them
 * would burn minutes of CPU on 686 MB to save approximately nothing, and would
 * force either buffering or data descriptors. Stored entries stream straight from
 * disk with their size known up front.
 */
const fs     = require('node:fs');
const path   = require('node:path');
const zlib   = require('node:zlib');
const crypto = require('node:crypto');

/* ── CRC-32 (IEEE 802.3), the checksum ZIP mandates ────────────────
 * Table built once at load. This is not a security checksum — SHA-256 in the
 * manifest is — but a corrupt entry must be caught by any standard extractor,
 * and that means getting the CRC right.
 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf, seed) {
  let c = (seed === undefined ? 0 : seed) ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}

const METHOD_STORE   = 0;
const METHOD_DEFLATE = 8;

/* Extensions worth deflating. Everything else is stored — see the header note. */
const COMPRESSIBLE = new Set(['.db', '.json', '.key', '.txt', '.csv', '.sql', '.md', '.log']);

const U32_MAX = 0xFFFFFFFF;
const U16_MAX = 0xFFFF;

/** MS-DOS date/time, which is what ZIP stores. Second resolution, 1980 epoch. */
function dosDateTime(d) {
  const year = d.getFullYear();
  if (year < 1980) return { date: 0x21, time: 0 };      // 1980-01-01
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
  const date = (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { date, time };
}

/* ══════════════════════════════════════════════════════════════════
 * Writer
 * ══════════════════════════════════════════════════════════════════ */

/**
 * Build a ZIP file entry by entry.
 *
 * Synchronous on purpose. It runs inside an administrative request that is
 * already exclusive (a backup is not concurrent with another backup), and async
 * streaming here would buy nothing while making failure handling — where a
 * half-written archive must never be presentable as a backup — considerably
 * harder to get right.
 */
class ZipWriter {
  constructor(destPath) {
    this.destPath = destPath;
    this.tmpPath = destPath + '.partial';
    /* Written to `.partial` and renamed only after the central directory lands.
     * A crash mid-write therefore leaves a file that is obviously incomplete
     * rather than a truncated archive sitting in the backup list looking valid. */
    this.fd = fs.openSync(this.tmpPath, 'w');
    this.offset = 0;
    this.entries = [];
    this.closed = false;
  }

  _write(buf) {
    let written = 0;
    while (written < buf.length) written += fs.writeSync(this.fd, buf, written, buf.length - written);
    this.offset += buf.length;
  }

  /** Add a file from disk. Returns the entry record (name, sizes, crc, sha256). */
  addFile(name, absPath, opts) {
    const o = opts || {};
    const st = fs.statSync(absPath);
    const ext = path.extname(name).toLowerCase();
    const compress = o.compress !== undefined ? o.compress : COMPRESSIBLE.has(ext);
    return compress
      ? this._addBuffered(name, fs.readFileSync(absPath), st.mtime, true)
      : this._addStored(name, absPath, st);
  }

  /** Add in-memory content (the manifest, the key). */
  addBuffer(name, buffer, opts) {
    const o = opts || {};
    const ext = path.extname(name).toLowerCase();
    const compress = o.compress !== undefined ? o.compress : COMPRESSIBLE.has(ext);
    return this._addBuffered(name, Buffer.from(buffer), o.mtime || new Date(), compress);
  }

  _addBuffered(name, raw, mtime, compress) {
    const crc = crc32(raw);
    const sha = crypto.createHash('sha256').update(raw).digest('hex');
    let payload = raw, method = METHOD_STORE;
    if (compress) {
      const deflated = zlib.deflateRawSync(raw, { level: 6 });
      // Only accept compression that actually helped. A "compressed" entry
      // larger than the original is a real ZIP pathology on tiny files.
      if (deflated.length < raw.length) { payload = deflated; method = METHOD_DEFLATE; }
    }
    const entry = this._writeLocal(name, mtime, crc, payload.length, raw.length, method, sha);
    this._write(payload);
    return entry;
  }

  _addStored(name, absPath, st) {
    /* Streamed in 1 MB chunks: 686 MB of uploads must never be resident. CRC and
     * SHA-256 are accumulated in the same pass, so the file is read exactly once
     * even though three things need to know its bytes. */
    const CHUNK = 1 << 20;
    const fd = fs.openSync(absPath, 'r');
    const hash = crypto.createHash('sha256');
    let crc = 0, total = 0;
    try {
      // First pass computes crc/sha, because the local header must carry the CRC
      // and we are deliberately not using data descriptors.
      const buf = Buffer.allocUnsafe(CHUNK);
      for (;;) {
        const n = fs.readSync(fd, buf, 0, CHUNK, null);
        if (n <= 0) break;
        const slice = buf.subarray(0, n);
        crc = crc32(slice, crc);
        hash.update(slice);
        total += n;
      }
      const sha = hash.digest('hex');
      const entry = this._writeLocal(name, st.mtime, crc, total, total, METHOD_STORE, sha);

      // Second pass copies the bytes.
      fs.closeSync(fd);
      const fd2 = fs.openSync(absPath, 'r');
      try {
        for (;;) {
          const n = fs.readSync(fd2, buf, 0, CHUNK, null);
          if (n <= 0) break;
          this._write(buf.subarray(0, n));
        }
      } finally { fs.closeSync(fd2); }
      return entry;
    } catch (e) {
      try { fs.closeSync(fd); } catch (e2) {}
      throw e;
    }
  }

  _writeLocal(name, mtime, crc, compSize, rawSize, method, sha) {
    const nameBuf = Buffer.from(name, 'utf8');
    const { date, time } = dosDateTime(mtime instanceof Date ? mtime : new Date());
    const needZip64 = rawSize > U32_MAX || compSize > U32_MAX;

    const extra = needZip64 ? (() => {
      const b = Buffer.alloc(20);
      b.writeUInt16LE(0x0001, 0); b.writeUInt16LE(16, 2);
      b.writeBigUInt64LE(BigInt(rawSize), 4);
      b.writeBigUInt64LE(BigInt(compSize), 12);
      return b;
    })() : Buffer.alloc(0);

    const localOffset = this.offset;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034B50, 0);                    // local file header
    h.writeUInt16LE(needZip64 ? 45 : 20, 4);           // version needed
    // bit 11 = filename is UTF-8. Lao and Thai filenames are possible here, and
    // without this flag extractors guess a legacy code page and mangle them.
    h.writeUInt16LE(0x0800, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(needZip64 ? U32_MAX : compSize, 18);
    h.writeUInt32LE(needZip64 ? U32_MAX : rawSize, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(extra.length, 28);
    this._write(h);
    this._write(nameBuf);
    if (extra.length) this._write(extra);

    const entry = { name, method, crc32: crc, compressedSize: compSize, size: rawSize,
                    localOffset, date, time, sha256: sha, zip64: needZip64 };
    this.entries.push(entry);
    return entry;
  }

  /** Write the central directory and rename into place. Returns a summary. */
  close() {
    if (this.closed) throw new Error('ZipWriter already closed');
    const cdStart = this.offset;

    for (const e of this.entries) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      const needZip64 = e.zip64 || e.localOffset > U32_MAX;
      const extra = needZip64 ? (() => {
        const b = Buffer.alloc(4 + 24);
        b.writeUInt16LE(0x0001, 0); b.writeUInt16LE(24, 2);
        b.writeBigUInt64LE(BigInt(e.size), 4);
        b.writeBigUInt64LE(BigInt(e.compressedSize), 12);
        b.writeBigUInt64LE(BigInt(e.localOffset), 20);
        return b;
      })() : Buffer.alloc(0);

      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014B50, 0);                  // central directory header
      c.writeUInt16LE(needZip64 ? 45 : 20, 4);         // version made by
      c.writeUInt16LE(needZip64 ? 45 : 20, 6);         // version needed
      c.writeUInt16LE(0x0800, 8);                      // UTF-8 names
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc32, 16);
      c.writeUInt32LE(needZip64 ? U32_MAX : e.compressedSize, 20);
      c.writeUInt32LE(needZip64 ? U32_MAX : e.size, 24);
      c.writeUInt16LE(nameBuf.length, 28);
      c.writeUInt16LE(extra.length, 30);
      c.writeUInt16LE(0, 32);                          // comment length
      c.writeUInt16LE(0, 34);                          // disk number
      c.writeUInt16LE(0, 36);                          // internal attrs
      c.writeUInt32LE(0, 38);                          // external attrs
      c.writeUInt32LE(needZip64 ? U32_MAX : e.localOffset, 42);
      this._write(c);
      this._write(nameBuf);
      if (extra.length) this._write(extra);
    }

    const cdSize = this.offset - cdStart;
    const count = this.entries.length;
    /* Zip64 only when the classic fields cannot hold the truth. Writing it
     * unconditionally is legal but breaks some older extractors, and an archive
     * nobody can open is the failure mode this module exists to avoid. */
    const needZip64Eocd = count > U16_MAX || cdStart > U32_MAX || cdSize > U32_MAX;

    if (needZip64Eocd) {
      const z = Buffer.alloc(56);
      z.writeUInt32LE(0x06064B50, 0);                  // Zip64 EOCD
      z.writeBigUInt64LE(BigInt(44), 4);               // size of this record - 12
      z.writeUInt16LE(45, 12); z.writeUInt16LE(45, 14);
      z.writeUInt32LE(0, 16); z.writeUInt32LE(0, 20);
      z.writeBigUInt64LE(BigInt(count), 24);
      z.writeBigUInt64LE(BigInt(count), 32);
      z.writeBigUInt64LE(BigInt(cdSize), 40);
      z.writeBigUInt64LE(BigInt(cdStart), 48);
      this._write(z);

      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064B50, 0);                // Zip64 EOCD locator
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(cdStart + cdSize), 8);
      loc.writeUInt32LE(1, 16);
      this._write(loc);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054B50, 0);
    eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(Math.min(count, U16_MAX), 8);
    eocd.writeUInt16LE(Math.min(count, U16_MAX), 10);
    eocd.writeUInt32LE(Math.min(cdSize, U32_MAX), 12);
    eocd.writeUInt32LE(Math.min(cdStart, U32_MAX), 16);
    eocd.writeUInt16LE(0, 20);
    this._write(eocd);

    // fsync before rename: on a power loss the rename must not land ahead of the
    // data it points at.
    try { fs.fsyncSync(this.fd); } catch (e) {}
    fs.closeSync(this.fd);
    fs.renameSync(this.tmpPath, this.destPath);
    this.closed = true;

    return { path: this.destPath, entries: this.entries, bytes: this.offset, zip64: needZip64Eocd };
  }

  /** Abandon a partial archive. Never leaves a `.partial` behind to be mistaken
   *  for a backup. */
  abort() {
    if (this.closed) return;
    try { fs.closeSync(this.fd); } catch (e) {}
    try { fs.unlinkSync(this.tmpPath); } catch (e) {}
    this.closed = true;
  }
}

/* ══════════════════════════════════════════════════════════════════
 * Reader
 * ══════════════════════════════════════════════════════════════════ */

/**
 * Read a ZIP's central directory, then extract entries on demand.
 *
 * Opens read-only. Verification must never be able to damage the artefact it is
 * checking — the same rule P4.6 applied to database backups.
 */
class ZipReader {
  constructor(zipPath) {
    this.zipPath = zipPath;
    this.fd = fs.openSync(zipPath, 'r');
    this.size = fs.fstatSync(this.fd).size;
    this.entries = [];
    this.byName = new Map();
    try { this._readDirectory(); }
    catch (e) { this.close(); throw e; }
  }

  _read(length, position) {
    const b = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const n = fs.readSync(this.fd, b, got, length - got, position + got);
      if (n <= 0) break;
      got += n;
    }
    if (got < length) throw new Error('unexpected end of archive at ' + position);
    return b;
  }

  _readDirectory() {
    // EOCD lives in the last 64 KB (22 bytes + up to a 64 KB comment).
    const tailLen = Math.min(this.size, 65557);
    if (tailLen < 22) throw new Error('file is too small to be a ZIP archive');
    const tail = this._read(tailLen, this.size - tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054B50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a ZIP archive: no end-of-central-directory record');

    let count    = tail.readUInt16LE(eocd + 10);
    let cdSize   = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    // Zip64 locator sits immediately before the EOCD when present.
    if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
      const locPos = eocd - 20;
      if (locPos >= 0 && tail.readUInt32LE(locPos) === 0x07064B50) {
        const z64Off = Number(tail.readBigUInt64LE(locPos + 8));
        const z64 = this._read(56, z64Off);
        if (z64.readUInt32LE(0) !== 0x06064B50) throw new Error('corrupt Zip64 end-of-central-directory');
        count    = Number(z64.readBigUInt64LE(32));
        cdSize   = Number(z64.readBigUInt64LE(40));
        cdOffset = Number(z64.readBigUInt64LE(48));
      }
    }

    const cd = this._read(cdSize, cdOffset);
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length) throw new Error('central directory ended early at entry ' + i);
      if (cd.readUInt32LE(p) !== 0x02014B50) throw new Error('corrupt central directory at entry ' + i);
      const method   = cd.readUInt16LE(p + 10);
      const crc      = cd.readUInt32LE(p + 16);
      let compSize   = cd.readUInt32LE(p + 20);
      let size       = cd.readUInt32LE(p + 24);
      const nameLen  = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const cmtLen   = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');

      if (size === U32_MAX || compSize === U32_MAX || localOffset === U32_MAX) {
        const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
        let q = 0;
        while (q + 4 <= extra.length) {
          const id = extra.readUInt16LE(q), len = extra.readUInt16LE(q + 2);
          if (id === 0x0001) {
            let r = q + 4;
            if (size === U32_MAX)        { size = Number(extra.readBigUInt64LE(r)); r += 8; }
            if (compSize === U32_MAX)    { compSize = Number(extra.readBigUInt64LE(r)); r += 8; }
            if (localOffset === U32_MAX) { localOffset = Number(extra.readBigUInt64LE(r)); }
            break;
          }
          q += 4 + len;
        }
      }

      const entry = { name, method, crc32: crc, compressedSize: compSize, size, localOffset };
      this.entries.push(entry);
      this.byName.set(name, entry);
      p += 46 + nameLen + extraLen + cmtLen;
    }
  }

  has(name) { return this.byName.has(name); }
  entry(name) { return this.byName.get(name) || null; }

  /** Where an entry's payload starts, skipping its local header. */
  _dataOffset(e) {
    const h = this._read(30, e.localOffset);
    if (h.readUInt32LE(0) !== 0x04034B50)
      throw new Error('corrupt local header for ' + e.name);
    return e.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  }

  /** Read one entry fully into memory. For the manifest and the key, not images. */
  readFile(name) {
    const e = this.entry(name);
    if (!e) throw new Error('entry not found: ' + name);
    const raw = this._read(e.compressedSize, this._dataOffset(e));
    const out = e.method === METHOD_DEFLATE ? zlib.inflateRawSync(raw) : raw;
    if (crc32(out) !== e.crc32) throw new Error('CRC mismatch for ' + name);
    return out;
  }

  /**
   * Stream one entry to a destination path, verifying CRC as it goes.
   * Returns { bytes, sha256 } — the digest is computed here so extraction and
   * verification are a single pass over the data.
   */
  extractTo(name, destPath) {
    const e = this.entry(name);
    if (!e) throw new Error('entry not found: ' + name);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const start = this._dataOffset(e);
    const hash = crypto.createHash('sha256');
    const outFd = fs.openSync(destPath, 'w');
    let crc = 0, written = 0;

    try {
      if (e.method === METHOD_STORE) {
        const CHUNK = 1 << 20;
        const buf = Buffer.allocUnsafe(CHUNK);
        let left = e.size;
        let pos = start;
        while (left > 0) {
          const want = Math.min(CHUNK, left);
          const n = fs.readSync(this.fd, buf, 0, want, pos);
          if (n <= 0) throw new Error('unexpected end of data for ' + name);
          const slice = buf.subarray(0, n);
          crc = crc32(slice, crc);
          hash.update(slice);
          fs.writeSync(outFd, slice, 0, n);
          left -= n; pos += n; written += n;
        }
      } else {
        // Deflated entries in a backup are small (database, manifest, key), so a
        // one-shot inflate is simpler than a stream and costs nothing here.
        const raw = this._read(e.compressedSize, start);
        const out = zlib.inflateRawSync(raw);
        crc = crc32(out);
        hash.update(out);
        fs.writeSync(outFd, out, 0, out.length);
        written = out.length;
      }
    } finally { fs.closeSync(outFd); }

    if (crc !== e.crc32) {
      // A failed extraction must not leave a plausible-looking file behind.
      try { fs.unlinkSync(destPath); } catch (e2) {}
      throw new Error('CRC mismatch extracting ' + name + ' — the archive is corrupt');
    }
    return { bytes: written, sha256: hash.digest('hex') };
  }

  /** CRC-check one entry without writing anything. */
  verifyEntry(name) {
    const e = this.entry(name);
    if (!e) return { ok: false, error: 'not-found' };
    try {
      const start = this._dataOffset(e);
      if (e.method === METHOD_DEFLATE) {
        const out = zlib.inflateRawSync(this._read(e.compressedSize, start));
        return { ok: crc32(out) === e.crc32, size: out.length };
      }
      const CHUNK = 1 << 20;
      const buf = Buffer.allocUnsafe(CHUNK);
      let crc = 0, left = e.size, pos = start;
      while (left > 0) {
        const n = fs.readSync(this.fd, buf, 0, Math.min(CHUNK, left), pos);
        if (n <= 0) return { ok: false, error: 'truncated' };
        crc = crc32(buf.subarray(0, n), crc);
        left -= n; pos += n;
      }
      return { ok: crc === e.crc32, size: e.size };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  }

  close() { try { fs.closeSync(this.fd); } catch (e) {} }
}

module.exports = {
  ZipWriter, ZipReader, crc32,
  METHOD_STORE, METHOD_DEFLATE, COMPRESSIBLE,
};
