'use strict';
/**
 * infra/scripts/_testzip.js — read a .pptx (or any zip) from Node, no deps.
 *
 * The browser uses JSZip, which is not available here, and the suites that
 * check the PPTX importer need to open real decks. Shared rather than copied
 * because there are now two of them and a second hand-rolled zip reader is a
 * second set of off-by-one bugs.
 *
 * Only what a .pptx contains: stored (0) and deflated (8) entries.
 */
const zlib = require('node:zlib');

function openZip(buf) {
  const files = {};
  // End of central directory, scanned back from the tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method  = buf.readUInt16LE(p + 10);
    const csize   = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen= buf.readUInt16LE(p + 30);
    const cmtLen  = buf.readUInt16LE(p + 32);
    const lho     = buf.readUInt32LE(p + 42);
    files[buf.toString('utf8', p + 46, p + 46 + nameLen)] = { method, csize, lho };
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return {
    names: Object.keys(files),
    has: n => !!files[n],
    read(n) {
      const f = files[n];
      if (!f) return null;
      const ln = buf.readUInt16LE(f.lho + 26), le = buf.readUInt16LE(f.lho + 28);
      const start = f.lho + 30 + ln + le;
      const raw = buf.slice(start, start + f.csize);
      return f.method === 0 ? raw : zlib.inflateRawSync(raw);
    },
    text(n) { const b = this.read(n); return b ? b.toString('utf8') : ''; },
  };
}

/** Slides in order, shaped the way detectUsages wants them. */
function readSlides(zip) {
  return zip.names
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (+a.match(/\d+/)[0]) - (+b.match(/\d+/)[0]))
    .map((n, i) => ({
      index: i + 1,
      xml: zip.text(n),
      rels: zip.has(n.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels')
        ? zip.text(n.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels') : '',
    }));
}

/** Everything under ppt/media/ — the denominator for the orphan count. */
function mediaFiles(zip) {
  return zip.names.filter(n => /^ppt\/media\/./.test(n));
}

module.exports = { openZip, readSlides, mediaFiles };
