'use strict';
/**
 * infra/device.js — turn a User-Agent string into a short, human device label.
 *
 * Purpose: the session dashboard has to let a non-technical HR administrator
 * recognise their own devices well enough to answer "is this me?". A raw UA
 * string cannot do that. "Chrome · Windows" can.
 *
 * Deliberately NOT a general-purpose UA parser. It is a bounded ordered match
 * over the handful of browsers and platforms this system is actually used from,
 * with a safe fallback. Zero dependencies, no network, no regex backtracking on
 * attacker-controlled input (every pattern is a simple literal/anchored scan).
 *
 * Security notes
 * ──────────────
 *  • The UA is attacker-controlled. The output is stored and later rendered, so
 *    it is whitelisted down to a fixed vocabulary — a device_name can only ever
 *    be built from the constant strings in this file, never from raw UA text.
 *    That makes it impossible to smuggle markup or control characters through
 *    this column into the dashboard.
 *  • Never treat device_name as an identity or security control. It is a label
 *    for humans; it is trivially spoofable and is used for display only.
 */

// Order matters: the first match wins, and several of these impersonate each
// other in the UA string (Edge claims Chrome, Chrome claims Safari, …).
const BROWSERS = [
  { name: 'Edge',      tests: ['edg/', 'edga/', 'edgios/'] },
  { name: 'Opera',     tests: ['opr/', 'opera'] },
  { name: 'Samsung Internet', tests: ['samsungbrowser/'] },
  { name: 'Firefox',   tests: ['firefox/', 'fxios/'] },
  { name: 'Chrome',    tests: ['chrome/', 'crios/', 'chromium/'] },
  { name: 'Safari',    tests: ['safari/'] },
  { name: 'curl',      tests: ['curl/'] },
  { name: 'PowerShell',tests: ['powershell'] },
];

// iPadOS reports itself as Macintosh, so iPad must be detected before Mac; and
// Android must precede Linux because every Android UA also contains "linux".
const PLATFORMS = [
  { name: 'iPhone',  tests: ['iphone'] },
  { name: 'iPad',    tests: ['ipad'] },
  { name: 'Android', tests: ['android'] },
  { name: 'Windows', tests: ['windows nt', 'win64', 'windows'] },
  { name: 'macOS',   tests: ['macintosh', 'mac os x'] },
  { name: 'Linux',   tests: ['linux', 'x11'] },
];

/**
 * @param {string} ua raw User-Agent header
 * @returns {string} e.g. "Chrome · Windows", "Safari · iPhone", "Unknown device"
 */
function deviceName(ua) {
  const s = String(ua == null ? '' : ua).toLowerCase();
  if (!s.trim()) return 'Unknown device';

  let browser = null, platform = null;
  for (const b of BROWSERS) { if (b.tests.some(t => s.includes(t))) { browser = b.name; break; } }
  for (const p of PLATFORMS) { if (p.tests.some(t => s.includes(t))) { platform = p.name; break; } }

  // iPadOS 13+ presents a desktop Safari UA; the touch hint is the only tell.
  if (platform === 'macOS' && s.includes('mobile')) platform = 'iPad';

  if (browser && platform) return browser + ' · ' + platform;
  if (browser)  return browser;
  if (platform) return platform;
  return 'Unknown device';
}

module.exports = { deviceName };
