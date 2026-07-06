'use strict';
/**
 * migrate-uploads-to-r2.js — push the existing local upload backlog to R2.
 *
 * Safe & resumable: each file is uploaded, the remote size is verified, and only
 * then is the local copy removed. Re-running skips files already in R2. Nothing
 * the DB references is deleted locally until it is provably safe in R2.
 *
 * Usage (env vars must be set — see docs/R2-SETUP.md):
 *   node --experimental-sqlite infra/scripts/migrate-uploads-to-r2.js
 */
require('../db').init();
const r2      = require('../r2');
const offload = require('../offload');

(async () => {
  if (!r2.isEnabled()) {
    console.error('✖ R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.');
    process.exit(1);
  }
  const t = r2.selfTestSigner();
  if (!t.ok) { console.error('✖ SigV4 signer self-test failed — aborting.'); process.exit(1); }

  const pend = offload.pendingCount();
  console.log(`Pending local files: ${pend.count}  (${(pend.bytes / 1048576).toFixed(1)} MB)`);
  if (!pend.count) { console.log('Nothing to migrate. ✔'); process.exit(0); }

  let n = 0;
  const summary = await offload.sweepReferenced({
    onProgress: (abs, r, s) => {
      n++;
      const tag = r.status === 'uploaded' ? '↑' : r.status === 'already' ? '=' : r.status === 'error' ? '✖' : '·';
      if (r.status === 'error') console.log(`${tag} ${r.key || abs}  (${r.error})`);
      else if (n % 25 === 0 || r.status === 'uploaded') {
        process.stdout.write(`\r${tag} ${s.uploaded} uploaded, ${s.already} verified, ${s.errors} errors, freed ${(s.freedBytes / 1048576).toFixed(1)} MB   `);
      }
    },
  });
  console.log('\n──────────────────────────────');
  console.log(`Uploaded : ${summary.uploaded}`);
  console.log(`Verified : ${summary.already} (already in R2)`);
  console.log(`Errors   : ${summary.errors}`);
  console.log(`Freed    : ${(summary.freedBytes / 1048576).toFixed(1)} MB from the local volume`);
  const left = offload.pendingCount();
  console.log(`Remaining local: ${left.count} files (${(left.bytes / 1048576).toFixed(1)} MB)` + (left.count ? ' — re-run to retry errors.' : ' ✔'));
  process.exit(summary.errors ? 2 : 0);
})();
