'use strict';
/**
 * infra/safe-name.js — turning a person's name into something a filesystem
 * will accept, without turning it into something nobody recognises.
 *
 * ══════════════════════════════════════════════════════════════════
 * The rule that matters most
 * ══════════════════════════════════════════════════════════════════
 * UNICODE LETTERS ARE KEPT. Almost every worker in this database has a Lao
 * name, and a sanitiser that strips "non-ASCII" would file all of them as
 * `worker`, `worker-2`, `worker-3`. Only the characters Windows genuinely
 * refuses are replaced — `\ / : * ? " < > |` and the control range — plus the
 * reserved DOS device names, which still cannot be filenames on Win32 no matter
 * what else is in the path.
 *
 * ── Two shapes, one core ──
 * `download()` names a file the browser saves: spaces are fine there, and the
 * original spacing is worth keeping.
 * `segment()` names a folder inside a ZIP: spaces become hyphens, because these
 * paths get typed, pasted into shells and read in listings, and it is capped so
 * a long name plus a long path cannot exceed what an extractor will create.
 *
 * Three copies of this logic existed before — one per caller — with three
 * slightly different character sets. Filenames are the part of an export a
 * person actually navigates, so "slightly different" meant the same worker was
 * filed under two spellings depending on which button was pressed.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KDSafeName = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /* Characters Win32 rejects in a path component, plus the control range. NTFS
   * and every extractor enforce this; POSIX only objects to `/`, so this is the
   * stricter of the two and therefore the safe one to apply everywhere. */
  const ILLEGAL = /[\\/:*?"<>|\x00-\x1f]+/g;

  /* CON, PRN, AUX, NUL, COM1-9, LPT1-9 — still special in Win32 paths. */
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  /**
   * A download filename. Keeps spaces; collapses runs of separators.
   * @returns {string} `fallback` (or 'export') when nothing usable is left.
   */
  function download(name, fallback) {
    let s = String(name == null ? '' : name).trim()
      .replace(ILLEGAL, '_')
      .replace(/\s+/g, ' ')
      .replace(/_{2,}/g, '_')
      .replace(/^[_\s]+|[_\s]+$/g, '');
    if (RESERVED.test(s)) s = '_' + s;
    return s || fallback || 'export';
  }

  /**
   * One path component inside an archive. Spaces become hyphens and the result
   * is capped at 80 characters.
   * @returns {string} `fallback` (or 'item') when nothing usable is left.
   */
  function segment(name, fallback) {
    let s = String(name == null ? '' : name).trim()
      .replace(ILLEGAL, '_')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/_{2,}/g, '_')
      .replace(/^[-_.]+|[-_.]+$/g, '');
    if (RESERVED.test(s)) s = '_' + s;
    return s.slice(0, 80) || fallback || 'item';
  }

  /**
   * A filename supplied by a client: never a path, extension preserved.
   * `../../etc/passwd` becomes `passwd`, not a way out of the folder.
   */
  function upload(name, fallback) {
    const base = String(name == null ? '' : name).split(/[\\/]/).pop();
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 8) : '';
    const stem = dot > 0 ? base.slice(0, dot) : base;
    return segment(stem, fallback || 'report') + ext;
  }

  return { download, segment, upload, ILLEGAL, RESERVED };
});
