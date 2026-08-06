'use strict';
/**
 * infra/age.js — how old somebody is. One implementation, both sides.
 *
 * ══════════════════════════════════════════════════════════════════
 * Why this is its own file
 * ══════════════════════════════════════════════════════════════════
 * There were two. The browser divided elapsed milliseconds by 365.25 days; the
 * server counted calendar years. They agree almost always — and disagree on the
 * one day that matters most, somebody's birthday:
 *
 *     2008-08-03   browser said 17   server said 18
 *     2004-08-03   browser said 21   server said 22
 *
 * The average-year trick loses because leap days do not arrive evenly: after 4,
 * 8, 12 … years the accumulated remainder is just short of a whole year, so the
 * floor lands one below on the anniversary itself. 14 of 371 birthday dates
 * tested came out a year apart.
 *
 * Two ages for one person is a problem for any product. For this one it is a
 * legal one: the same export package carries a spreadsheet built in the browser
 * and a summary built on the server, and 17 versus 18 is the line a labour
 * recruiter is not allowed to be on the wrong side of.
 *
 * ── Loaded by both, deliberately ──
 * The browser pulls it in as a plain script before app.js (`window.KDAge`), and
 * Node requires it. It answers to both without a build step, which is the only
 * way this codebase can share code at all — there is no bundler, and adding one
 * to deduplicate eight lines would be the wrong trade.
 *
 * It lives in infra/ beside the other dependency-free utilities (zip, cbor, qr,
 * totp) rather than in shell/: it holds no UI and no I/O, just arithmetic.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KDAge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /**
   * Whole years lived, by the calendar.
   *
   * @param {string|Date} dob  a date of birth; anything unparseable → ''
   * @param {Date} [on]        the day to count to; defaults to today
   * @returns {number|''}      '' rather than 0 or NaN when there is no usable
   *                           date — a missing birthday must never print as an
   *                           age of zero on a document.
   */
  function age(dob, on) {
    if (dob == null || dob === '') return '';
    const d = dob instanceof Date ? dob : new Date(String(dob));
    if (isNaN(d.getTime())) return '';
    const now = on instanceof Date ? on : new Date();

    let years = now.getFullYear() - d.getFullYear();
    const months = now.getMonth() - d.getMonth();
    // Not yet reached this year's anniversary → one fewer year lived.
    if (months < 0 || (months === 0 && now.getDate() < d.getDate())) years--;

    // A date in the future, or a typo'd century, is not an age.
    return (years >= 0 && years < 150) ? years : '';
  }

  return { age };
});
