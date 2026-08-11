'use strict';
/**
 * infra/scripts/dev.js — the development server: restarts itself when a file changes.
 *
 *   npm run dev
 *
 * ══════════════════════════════════════════════════════════════════
 * The problem it removes
 * ══════════════════════════════════════════════════════════════════
 * Editing an asset has two ways of going unnoticed, and they compound:
 *
 *   1. The server holds the old code until it is restarted, and nobody
 *      restarts it because nothing says to.
 *   2. Even after a restart, `main.css?v=2.3.0` was already fetched and marked
 *      immutable, so the browser keeps last week's copy for a year — while
 *      index.html, which is never cached, arrives new. New markup on an old
 *      stylesheet renders as a layout bug three files away from its cause.
 *
 * This closes both: the server restarts on change, and it boots with KD_DEV=1,
 * under which every asset URL carries a per-boot suffix and nothing is served
 * as immutable. Each restart is a set of URLs no browser has seen.
 *
 * `npm start` is untouched — production still gets the year-long cache that
 * turned a 25-second page load into 0.34s. This is a separate command on
 * purpose: a live server behind the tunnel should not restart itself the
 * instant an editor writes half a file.
 *
 * Zero dependencies, like everything else here: node:child_process + fs.watch.
 */
const { spawn } = require('node:child_process');
const fs   = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

/* Directories whose contents the browser or the server actually loads. `data/`
   is absent on purpose — the database writes there constantly, and watching it
   would restart the server every time somebody saved a worker. */
const WATCH = [
  'shell', 'domains', 'infra',
];
/* …minus the parts of infra/ that are tooling rather than runtime. */
const IGNORE = /[\\/](scripts|node_modules|\.git)[\\/]|[\\/]scripts$/;

const WATCHABLE = /\.(js|css|html|json)$/i;

let child = null;
let restarting = false;
let timer = null;

function start() {
  child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'shell', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { KD_DEV: '1' }),
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    // A restart kills it on purpose; anything else is the server falling over.
    if (restarting) return;
    if (code !== 0) console.log('\n[dev] server exited (' + (signal || code) + ') — waiting for a change…');
    child = null;
  });
}

function restart(why) {
  if (restarting) return;
  restarting = true;
  console.log('\n[dev] ' + why + ' → restarting');
  const done = () => { restarting = false; start(); };
  if (child) { child.once('exit', done); child.kill(); }
  else done();
}

/** Collapse a burst of writes (editors save in several steps) into one restart. */
function schedule(file) {
  clearTimeout(timer);
  timer = setTimeout(() => restart(path.relative(ROOT, file) + ' changed'), 250);
}

function watch(dir) {
  let w;
  try {
    w = fs.watch(dir, { recursive: true }, (evt, name) => {
      if (!name) return;
      const full = path.join(dir, name);
      if (IGNORE.test(full) || !WATCHABLE.test(name)) return;
      schedule(full);
    });
  } catch (e) {
    console.log('[dev] cannot watch ' + dir + ': ' + (e && e.message));
    return;
  }
  w.on('error', () => {});
}

console.log('[dev] watching ' + WATCH.join(', ') + ' — assets are served unversioned and uncached');
WATCH.forEach(d => watch(path.join(ROOT, d)));
start();

const bye = () => { restarting = true; if (child) child.kill(); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
