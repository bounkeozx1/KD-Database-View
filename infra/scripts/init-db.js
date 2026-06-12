'use strict';
// Create the SQLite database + tables + default master data (idempotent).
//   node backend/scripts/init-db.js
const dbmod = require('../db');
dbmod.init();
console.log('✔ Database ready at', dbmod.DB_PATH);
