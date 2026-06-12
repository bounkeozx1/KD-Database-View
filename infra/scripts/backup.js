'use strict';
// Create a timestamped backup copy under backups/.
//   node backend/scripts/backup.js
require('../db').init();
const admin = require('../admin');
console.log('✔ Backup created →', admin.backup());
