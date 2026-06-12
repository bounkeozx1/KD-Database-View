'use strict';
// Restore the database from a backup file under backups/.
//   node backend/scripts/restore.js kd-2026-06-08_10-00-00.db
require('../db').init();
const admin = require('../admin');
const file = process.argv[2];
if (!file) {
  console.log('Usage: node backend/scripts/restore.js <backup-file>');
  console.log('Available backups:', admin.listBackups().join(', ') || '(none)');
  process.exit(1);
}
admin.restore(file);
console.log('✔ Restored from', file);
