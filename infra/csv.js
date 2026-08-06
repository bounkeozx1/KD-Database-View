'use strict';
/**
 * infra/csv.js — writing CSV the same way on both sides.
 *
 * Three places built CSV by hand: the export dialog, the audit-log export, and
 * the package's summary. Each re-derived the same two rules, and each was one
 * edit away from getting them subtly wrong:
 *
 *   1. QUOTE EVERYTHING, and double the quotes inside. A worker's name can hold
 *      a comma, an address a newline, a "reason" column a quotation mark. A
 *      builder that only quotes "when it looks necessary" is a builder that
 *      corrupts a row the first time it guesses wrong — and a corrupted CSV of
 *      passport numbers is not obviously corrupted when you open it.
 *
 *   2. LEAD WITH A BOM. Without it Excel reads a UTF-8 file as the system code
 *      page, and every Lao, Thai and Korean name arrives as mojibake. This is
 *      not a preference: the office opens these files in Excel.
 *
 *   3. NEUTRALISE FORMULAS. A cell beginning `=`, `+`, `-` or `@` is a formula
 *      to Excel, LibreOffice and Sheets alike — so a value that arrived from a
 *      passport scan or a typed field can execute when somebody opens the
 *      export. Only the audit-log export defended against this; the worker
 *      exports, whose fields are far more attacker-influenced, did not. It
 *      belongs here so no future export can forget it.
 *
 * CRLF, not LF, for the same reason — it is what Excel expects from a .csv.
 *
 * Loaded as a plain script in the browser (`window.KDCsv`) and required in
 * Node, like infra/age.js. No build step, one definition.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KDCsv = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /** U+FEFF. Excel needs it to read the file as UTF-8. */
  const BOM = '﻿';

  /** Excel's line ending for .csv files. */
  const EOL = '\r\n';

  /**
   * One cell: formula-neutralised, always quoted, inner quotes doubled,
   * null/undefined → empty.
   *
   * The leading apostrophe is the conventional escape — spreadsheets treat the
   * rest as literal text and do not display it. Tab and CR are included because
   * they also start a formula context in some readers.
   */
  function cell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  /** One row from an array of values. */
  function row(values) {
    return values.map(cell).join(',');
  }

  /**
   * A complete file: BOM, header row, data rows, trailing newline.
   *
   * @param {Array} header  column labels
   * @param {Array<Array>} rows
   * @param {string} [trailer]  appended verbatim (the export watermark line)
   */
  function build(header, rows, trailer) {
    const lines = [row(header)].concat(rows.map(row));
    return BOM + lines.join(EOL) + EOL + (trailer || '');
  }

  return { BOM, EOL, cell, row, build };
});
