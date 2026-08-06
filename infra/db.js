'use strict';
/**
 * backend/db.js — SQLite connection + schema (Node built-in `node:sqlite`)
 *
 * Zero npm dependencies. The DB file is created automatically on first launch
 * and all tables use `CREATE TABLE IF NOT EXISTS`.
 *
 * Postgres-future note: all SQL lives in db.js + repo.js. To migrate to
 * PostgreSQL later, swap the driver here (and make repo calls async). The rest
 * of the app talks to the REST API, not the database directly.
 */
const { DatabaseSync } = require('node:sqlite');
const fs   = require('node:fs');
const path = require('node:path');
const pw   = require('./password');

const ROOT        = path.join(__dirname, '..');
// KD_DATA_DIR relocates the whole data directory. Used by the test suite so it
// runs against a throwaway DB instead of the live one — production leaves it
// unset and gets <repo>/data exactly as before.
const DATA_DIR    = process.env.KD_DATA_DIR || path.join(ROOT, 'data');
const DB_DIR      = path.join(DATA_DIR, 'db');
const DB_PATH     = path.join(DB_DIR, 'kd.db');
// Written on first run, removed as soon as the seeded password is changed.
const INITIAL_PW_PATH = path.join(DB_DIR, 'INITIAL-ADMIN-PASSWORD.txt');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const UPLOAD_SUBDIRS = ['employee-photos', 'passports', 'id-cards', 'documents'];

fs.mkdirSync(DB_DIR, { recursive: true });
UPLOAD_SUBDIRS.forEach(d => fs.mkdirSync(path.join(UPLOADS_DIR, d), { recursive: true }));

let db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  username  TEXT UNIQUE NOT NULL,
  password  TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'viewer',
  name      TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Server-issued login sessions. The browser only ever holds an opaque token
-- (HttpOnly cookie); username + role are read from here + users on every
-- request, so a client can never grant itself a role it didn't log in with.
--
-- token_hash, NOT the token (P1.1). The server stores only SHA-256 of the
-- token it issued. A leaked database — a stolen backup, a copied kd.db, an
-- SQL-injection read — therefore yields nothing that can be replayed as a
-- cookie. Lookup is by hash of the presented token, which is why this stays a
-- single indexed equality lookup and costs nothing.
--
-- SHA-256 with no salt/stretching is correct here (and NOT a contradiction of
-- how passwords are stored): the token is 256 bits of CSPRNG output, so it has
-- no guessable structure to brute-force and nothing to rainbow-table. Stretching
-- would only slow down every authenticated request for no gain.
--
-- The username column is retained alongside user_id because every existing
-- query in repo.js keys sessions by username; user_id is added for the P1 spec
-- and for referential integrity once the P2 role model lands.
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT UNIQUE NOT NULL,
  username    TEXT NOT NULL,
  user_id     INTEGER,
  ip          TEXT,
  user_agent  TEXT,
  device_name TEXT,
  created_at  TEXT NOT NULL,
  last_seen   TEXT,
  expires_at  TEXT NOT NULL,
  csrf_token  TEXT
);
-- NOTE: the sessions indexes are created in migrate(), NOT here. On an existing
-- database this CREATE TABLE is a no-op (the old table is still present), so an
-- index on token_hash would reference a column that does not exist yet and abort
-- the whole SCHEMA exec. migrate() creates them once the rebuild has run.

CREATE TABLE IF NOT EXISTS employers (
  code TEXT PRIMARY KEY,
  name TEXT
);

CREATE TABLE IF NOT EXISTS cities (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  country TEXT NOT NULL,            -- 'kr' | 'la'
  code    TEXT NOT NULL,
  name    TEXT NOT NULL,
  UNIQUE(country, code)
);

CREATE TABLE IF NOT EXISTS groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  departure  TEXT,
  route      TEXT,
  pinned     INTEGER DEFAULT 0,
  archived   INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employees (
  uid              TEXT PRIMARY KEY,
  group_id         TEXT REFERENCES groups(id) ON DELETE CASCADE,
  worker_id        TEXT,
  employer_code    TEXT,
  group_supervisor TEXT,
  en_name          TEXT,
  lo_name          TEXT,
  dob              TEXT,
  village          TEXT,
  nationality      TEXT,
  sex              TEXT,
  blood            TEXT,
  hand             TEXT,
  weight           TEXT,
  height           TEXT,
  size             TEXT,
  couple           TEXT,
  tel              TEXT,
  emg_tel          TEXT,
  kr_city          TEXT,
  la_city          TEXT,
  photo_path       TEXT,
  sort_order       INTEGER DEFAULT 0,
  created_at       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_emp_group ON employees(group_id);

CREATE TABLE IF NOT EXISTS passports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_uid  TEXT UNIQUE REFERENCES employees(uid) ON DELETE CASCADE,
  passport_no   TEXT,
  issue_date    TEXT,
  expiry_date   TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_uid TEXT REFERENCES employees(uid) ON DELETE CASCADE,
  category     TEXT NOT NULL,        -- passport|id_card|land|work_permit|other
  file_path    TEXT NOT NULL,
  type         TEXT,                 -- image|pdf
  name         TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_doc_emp ON documents(employee_uid);

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Authentication & account-lifecycle audit trail.
--
-- Separate from activity_log on purpose: activity_log records what happened to
-- an EMPLOYEE RECORD, this records what happened to an ACCOUNT. Mixing them
-- would let a retention policy on worker data quietly delete security evidence,
-- and PDPA / ISO 27001 A.12.4 both want the access trail kept independently.
--
-- Append-only by convention: nothing in the codebase updates or deletes a row.
CREATE TABLE IF NOT EXISTS auth_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp          TEXT NOT NULL DEFAULT (datetime('now')),
  username_attempted TEXT,          -- what was typed; kept even when no such account exists
  user_id            INTEGER,       -- users.id once resolved, else NULL
  ip_address         TEXT,
  user_agent         TEXT,
  action             TEXT NOT NULL, -- LOGIN | LOGOUT | SESSION_CREATE | SESSION_EXPIRE | PASSWORD_CHANGE | USER_CREATE | USER_DELETE | ROLE_CHANGE
  result             TEXT NOT NULL, -- SUCCESS | FAILURE | LOCKED
  reason             TEXT           -- machine-readable detail: bad-password, no-such-user, rate-limited, …
);
CREATE INDEX IF NOT EXISTS idx_auth_ts     ON auth_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_auth_user   ON auth_log(username_attempted);
CREATE INDEX IF NOT EXISTS idx_auth_action ON auth_log(action, result);

-- ── P3: multi-factor authentication ──────────────────────────────
-- One-time recovery codes. Only SHA-256(code) is stored: the plaintext is shown
-- once at generation and is unrecoverable afterwards, exactly like a password.
-- A used code is retained with used_at set rather than deleted, so the audit
-- trail can still show which code was spent and when.
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  user_id    INTEGER,
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recov_user ON mfa_recovery_codes(username);
CREATE INDEX IF NOT EXISTS idx_recov_hash ON mfa_recovery_codes(code_hash);

-- Registered WebAuthn credentials (passkeys, Windows Hello, Touch ID, security
-- keys). public_key is the COSE key exactly as the authenticator produced it,
-- base64url-encoded; the counter column is the signature counter used to detect
-- a cloned authenticator.
CREATE TABLE IF NOT EXISTS passkeys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER,
  username      TEXT NOT NULL,
  credential_id TEXT UNIQUE NOT NULL,
  public_key    TEXT NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  alg           INTEGER,
  aaguid        TEXT,
  name          TEXT,
  transports    TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_pk_user ON passkeys(username);
CREATE INDEX IF NOT EXISTS idx_pk_cred ON passkeys(credential_id);

-- "Remember this device for 30 days". Like sessions, only the SHA-256 of the
-- token is stored, so a database leak cannot be replayed to skip MFA.
CREATE TABLE IF NOT EXISTS trusted_devices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL,
  user_id     INTEGER,
  token_hash  TEXT UNIQUE NOT NULL,
  device_name TEXT,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL,
  last_used_at TEXT,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_td_user ON trusted_devices(username);
CREATE INDEX IF NOT EXISTS idx_td_hash ON trusted_devices(token_hash);

-- ── RBAC ─────────────────────────────────────────────────────────
-- Authorisation is resolved through data, not code:
--     users.role_id → roles → role_permissions → permissions
-- Adding a role is an INSERT, not a deployment.

-- rank orders privilege, lower = more powerful. It backs one invariant: nobody
-- may assign a role at or above their own rank (see rbac.canAssignRole), which
-- is what prevents privilege escalation via user management.
CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  rank        INTEGER NOT NULL DEFAULT 100,
  mfa         TEXT NOT NULL DEFAULT 'optional',   -- required | optional
  is_system   INTEGER NOT NULL DEFAULT 0,         -- system roles cannot be deleted
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS permissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT UNIQUE NOT NULL,               -- "<resource>.<action>"
  resource    TEXT NOT NULL,
  action      TEXT NOT NULL,
  description TEXT,
  is_sensitive INTEGER NOT NULL DEFAULT 0,        -- use of it is audited on success
  created_at  TEXT DEFAULT (datetime('now'))
);

-- scope carries HOW MUCH of the resource the grant covers: all | team | own.
-- Storing it per grant is what lets "Manager: edit team records" and
-- "Data Entry: edit own records" be data rather than special cases in code.
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL DEFAULT 'all',
  granted_at    TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (role_id, permission_id)
);
CREATE INDEX IF NOT EXISTS idx_rp_role ON role_permissions(role_id);
`;

// Default master data (so dropdowns work on a fresh install).
//
// NOTE: there is deliberately no default USER here any more. The first
// administrator is created in seedDefaults() with a cryptographically random
// password that is printed once and must be changed at first sign-in. The old
// hard-coded 'admin' / 'admin1234' pair shipped in every copy of this repo and
// was, in practice, a published credential for the passport database.
const DEFAULT_EMPLOYERS = ['VK','TK','VV','HSF','NXT','XTN','PH','PL','TMX'];
const DEFAULT_CITIES = {
  kr: [['SEO','Seoul'],['BUS','Busan'],['ICN','Incheon'],['DY','Damyang']],
  la: [['VTE','Vientiane'],['CHM','Champasak'],['SVK','Savannakhet'],['LPB','Luang Prabang']],
};

function migrate() {
  const docCols = db.prepare('PRAGMA table_info(documents)').all().map(c => c.name);
  if (!docCols.includes('version'))     db.exec('ALTER TABLE documents ADD COLUMN version INTEGER DEFAULT 1');
  if (!docCols.includes('is_current'))  db.exec('ALTER TABLE documents ADD COLUMN is_current INTEGER DEFAULT 1');
  if (!docCols.includes('group_id'))    db.exec('ALTER TABLE documents ADD COLUMN group_id TEXT');
  if (!docCols.includes('uploaded_by')) db.exec('ALTER TABLE documents ADD COLUMN uploaded_by TEXT');

  const groupCols = db.prepare('PRAGMA table_info(groups)').all().map(c => c.name);
  if (!groupCols.includes('site_code'))    db.exec("ALTER TABLE groups ADD COLUMN site_code TEXT DEFAULT ''");
  if (!groupCols.includes('province_code')) db.exec("ALTER TABLE groups ADD COLUMN province_code TEXT DEFAULT ''");
  if (!groupCols.includes('assigned'))     db.exec('ALTER TABLE groups ADD COLUMN assigned INTEGER DEFAULT 0');
  if (!groupCols.includes('arrivals'))     db.exec('ALTER TABLE groups ADD COLUMN arrivals INTEGER DEFAULT 0');
  // Soft-delete ("Trash"): deleted rows keep their data and only set deleted_at,
  // so they can be restored. NULL = live (the normal, untouched state).
  if (!groupCols.includes('deleted_at'))   db.exec('ALTER TABLE groups ADD COLUMN deleted_at TEXT');

  const empCols = db.prepare('PRAGMA table_info(employees)').all().map(c => c.name);
  if (!empCols.includes('grade'))           db.exec("ALTER TABLE employees ADD COLUMN grade TEXT DEFAULT ''");
  if (!empCols.includes('visa_status'))     db.exec("ALTER TABLE employees ADD COLUMN visa_status TEXT DEFAULT ''");
  if (!empCols.includes('education'))       db.exec("ALTER TABLE employees ADD COLUMN education TEXT DEFAULT ''");
  if (!empCols.includes('work_experience')) db.exec("ALTER TABLE employees ADD COLUMN work_experience TEXT DEFAULT ''");
  if (!empCols.includes('languages'))       db.exec("ALTER TABLE employees ADD COLUMN languages TEXT DEFAULT ''");
  if (!empCols.includes('province'))         db.exec("ALTER TABLE employees ADD COLUMN province TEXT DEFAULT ''");
  if (!empCols.includes('district'))         db.exec("ALTER TABLE employees ADD COLUMN district TEXT DEFAULT ''");
  // Keep the un-cropped original photo so a bad crop can always be reverted.
  if (!empCols.includes('photo_orig'))       db.exec("ALTER TABLE employees ADD COLUMN photo_orig TEXT DEFAULT ''");
  // Small (~200px) thumbnail served in list/grid/card views so those screens
  // load in a fraction of the bandwidth (full photo stays for detail + export).
  if (!empCols.includes('photo_thumb'))      db.exec("ALTER TABLE employees ADD COLUMN photo_thumb TEXT DEFAULT ''");
  // Soft-delete ("Trash") — NULL = live. Set when a worker is moved to trash.
  if (!empCols.includes('deleted_at'))       db.exec('ALTER TABLE employees ADD COLUMN deleted_at TEXT');

  db.exec(`CREATE TABLE IF NOT EXISTS activity_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_uid TEXT,
    action       TEXT NOT NULL,
    detail       TEXT,
    performed_by TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  ); CREATE INDEX IF NOT EXISTS idx_act_emp ON activity_log(employee_uid);`);

  // The log started out employee-only. entity_type/entity_id generalise it so
  // groups (and anything later) get a history too. employee_uid is still written
  // for employee rows so older code and any existing query keep working.
  const actCols = db.prepare('PRAGMA table_info(activity_log)').all().map(c => c.name);
  if (!actCols.includes('entity_type')) db.exec("ALTER TABLE activity_log ADD COLUMN entity_type TEXT DEFAULT 'employee'");
  if (!actCols.includes('entity_id')) {
    db.exec('ALTER TABLE activity_log ADD COLUMN entity_id TEXT');
    // Backfill: every row written before this migration was an employee event.
    db.exec("UPDATE activity_log SET entity_id = employee_uid, entity_type = 'employee' WHERE entity_id IS NULL");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_act_entity ON activity_log(entity_type, entity_id)');

  /* ── P0.1: forced password change ──
   * must_change_password gates the whole API (see server.js): a session opened
   * by an account carrying this flag can call only /me, /logout and /password.
   * It is set on the seeded administrator and on every admin-performed password
   * reset, so a temporary password handed to a colleague cannot become their
   * permanent one. */
  const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!userCols.includes('must_change_password'))
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  if (!userCols.includes('password_changed_at'))
    db.exec('ALTER TABLE users ADD COLUMN password_changed_at TEXT');

  /* Existing installs: any account still holding a plaintext password predates
   * hashing. Flag it so the owner is forced onto a compliant password on their
   * next sign-in instead of the row silently living on. */
  try {
    db.exec("UPDATE users SET must_change_password = 1 " +
            "WHERE must_change_password = 0 AND password NOT LIKE 'scrypt$%'");
  } catch (e) {}

  migrateSessionsToHashed();

  // Created here rather than in SCHEMA: on an existing DB the sessions table is
  // only the right shape AFTER the rebuild above.
  db.exec('CREATE INDEX IF NOT EXISTS idx_sess_user ON sessions(username);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sess_hash ON sessions(token_hash);');

  /* P2.1 — per-session CSRF secret. Stored server-side, never derivable from
   * anything the browser sends on its own. Sessions that predate this column
   * get one lazily on next use (see repo.ensureCsrfToken) rather than being
   * revoked, so the upgrade signs nobody out. */
  const sessCols = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
  if (!sessCols.includes('csrf_token'))
    db.exec('ALTER TABLE sessions ADD COLUMN csrf_token TEXT');

  /* ── P3: MFA columns on users ──
   * mfa_secret holds a base32 TOTP secret. It is written at the START of
   * enrolment (so the QR can be shown) but mfa_enabled stays 0 until the user
   * proves possession by entering a valid code — otherwise a half-finished
   * enrolment would lock the account behind a secret nobody has.
   *
   * mfa_last_counter is the replay guard: the last TOTP time-step that was
   * accepted. Without it, a code shoulder-surfed or captured in transit stays
   * usable for the remainder of its 30-second window. */
  const uCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!uCols.includes('mfa_enabled'))      db.exec('ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0');
  if (!uCols.includes('mfa_secret'))       db.exec('ALTER TABLE users ADD COLUMN mfa_secret TEXT');
  if (!uCols.includes('mfa_enrolled_at'))  db.exec('ALTER TABLE users ADD COLUMN mfa_enrolled_at TEXT');
  if (!uCols.includes('mfa_last_counter')) db.exec('ALTER TABLE users ADD COLUMN mfa_last_counter INTEGER');

  /* ── RBAC ──
   * users.role gets a role_id companion rather than a replacement. The text
   * column stays authoritative for display and for the (many) existing call
   * sites that read me.role; role_id is what authorisation resolves through.
   * Keeping both means this migration cannot break a running deployment, and
   * the two are kept in step by repo.setUserRole(). */
  if (!uCols.includes('role_id')) db.exec('ALTER TABLE users ADD COLUMN role_id INTEGER REFERENCES roles(id)');

  /* Ownership + approval workflow.
   * created_by is what makes the 'own' scope meaningful — without a recorded
   * creator, "edit own records" cannot be evaluated and would have to fail
   * closed on every row.
   *
   * status defaults to 'approved' so every EXISTING record stays visible and
   * editable exactly as before: the approval workflow is available to roles
   * that have the permission, but nothing that already worked changes. */
  const eCols = db.prepare('PRAGMA table_info(employees)').all().map(c => c.name);
  if (!eCols.includes('created_by'))  db.exec('ALTER TABLE employees ADD COLUMN created_by TEXT');
  if (!eCols.includes('status'))      db.exec("ALTER TABLE employees ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'");
  if (!eCols.includes('approved_by')) db.exec('ALTER TABLE employees ADD COLUMN approved_by TEXT');
  if (!eCols.includes('approved_at')) db.exec('ALTER TABLE employees ADD COLUMN approved_at TEXT');

  const gCols = db.prepare('PRAGMA table_info(groups)').all().map(c => c.name);
  if (!gCols.includes('created_by')) db.exec('ALTER TABLE groups ADD COLUMN created_by TEXT');
  /* supervisor is the explicit owner of a group, and the primary input to
   * 'team' scope. The app already records a supervisor per WORKER
   * (employees.group_supervisor); this makes it assignable at group level so a
   * Manager's remit does not have to be inferred. See repo.getTeamGroupIds. */
  if (!gCols.includes('supervisor')) db.exec("ALTER TABLE groups ADD COLUMN supervisor TEXT DEFAULT ''");

  /* ── P4: administration centre ──────────────────────────────────
   *
   * users.mfa_required is a per-account OVERRIDE of the role's MFA policy, not a
   * replacement for it. NULL (the default, and therefore every existing row)
   * means "follow the role", so this migration changes nobody's requirements.
   * 1 forces enrolment on an account whose role would not otherwise demand it —
   * the "Force Enrollment" action in Security → MFA Policy. It is deliberately
   * one-directional: it can only ADD a requirement, never waive one the role
   * imposes (see repo.getMfaStatus). */
  const uCols2 = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!uCols2.includes('mfa_required')) db.exec('ALTER TABLE users ADD COLUMN mfa_required INTEGER');

  /* Password history. Stores only hashes of RETIRED passwords, so a reuse check
   * is possible without the plaintext ever existing at rest. Rows are pruned to
   * the configured depth on write (repo._recordPasswordHistory), so this table
   * cannot grow without bound. */
  db.exec(`CREATE TABLE IF NOT EXISTS password_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL,
    password   TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_pwhist_user ON password_history(username, id DESC)');

  /* roles.is_legacy / replaced_by let the administration UI keep superseded role
   * keys out of the picker while still naming them for accounts that hold one.
   * Kept in the table (rather than read from rbac.js) so a report generated
   * straight from the database is self-describing. */
  const rCols = db.prepare('PRAGMA table_info(roles)').all().map(c => c.name);
  if (!rCols.includes('is_legacy'))  db.exec('ALTER TABLE roles ADD COLUMN is_legacy INTEGER NOT NULL DEFAULT 0');
  if (!rCols.includes('replaced_by')) db.exec('ALTER TABLE roles ADD COLUMN replaced_by TEXT');

  /* ── P4.6: tamper-evident audit trail ───────────────────────────
   *
   * Each auth_log row gets an HMAC over its own content plus the previous row's
   * hash, so editing or deleting one breaks the chain from that point on. See
   * infra/audit-chain.js for why the key lives outside the database.
   *
   * audit_anchors records every legitimate rebuild of the chain. A rebuild is
   * unavoidable after a restore — P4.5 re-inserts preserved rows, which changes
   * their ids and therefore their hashes — and an unexplained break is a very
   * different thing from one the trail itself accounts for. Without this table
   * the two would be indistinguishable, which would make the whole mechanism
   * cry wolf on the first restore. */
  const alCols = db.prepare('PRAGMA table_info(auth_log)').all().map(c => c.name);
  if (!alCols.includes('prev_hash')) db.exec('ALTER TABLE auth_log ADD COLUMN prev_hash TEXT');
  if (!alCols.includes('row_hash'))  db.exec('ALTER TABLE auth_log ADD COLUMN row_hash TEXT');

  db.exec(`CREATE TABLE IF NOT EXISTS audit_anchors (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    reason        TEXT NOT NULL,
    actor         TEXT,
    through_id    INTEGER,          -- highest auth_log id the rebuild covered
    prev_head     TEXT,             -- chain head before the rebuild
    new_head      TEXT,             -- chain head after it
    rows_affected INTEGER,
    key_fpr       TEXT              -- which key signed it, for key-rotation forensics
  )`);

  seedRbac();
  migrateLegacyRoles();
  backfillAuditChain();
}

/* ── P4.6: give existing audit rows a chain ────────────────────────
 * Runs once. Rows written before P4.6 have no hash, so the chain is computed
 * over them retroactively and the highest id reached is recorded as the
 * BASELINE.
 *
 * What that baseline means is stated plainly, because it would be easy to imply
 * more: hashing an old row proves it has not changed SINCE the migration. It
 * proves nothing about whether it was already altered BEFORE. Verification
 * reports `baselineThrough` and `attestedFrom` separately so a reader can tell
 * genuinely-attested rows from grandfathered ones.
 */
function backfillAuditChain() {
  const chain = require('./audit-chain');
  let key;
  try { key = chain.loadKey(DB_DIR); }
  catch (e) {
    // No key, no chain. The application must still start — an audit-integrity
    // feature that prevents sign-in is worse than the risk it mitigates.
    console.error('[audit] chain disabled — could not load the key:', e && e.message || e);
    return;
  }

  const pending = db.prepare(
    'SELECT ' + chain.CHAINED_FIELDS.join(',') + ' FROM auth_log WHERE row_hash IS NULL ORDER BY id'
  ).all();
  if (!pending.length) return;

  // Continue from the existing head rather than restarting, so a partially
  // chained table (an interrupted migration) completes instead of forking.
  const head = db.prepare(
    'SELECT row_hash FROM auth_log WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1'
  ).get();
  const links = chain.computeChain(key, pending, head ? head.row_hash : null);

  const upd = db.prepare('UPDATE auth_log SET prev_hash=?, row_hash=? WHERE id=?');
  db.exec('BEGIN');
  try {
    links.forEach(l => upd.run(l.prev_hash, l.row_hash, l.id));
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
    console.error('[audit] chain backfill failed:', e && e.message || e);
    return;
  }

  const through = pending[pending.length - 1].id;
  const isFirstRun = !head;
  db.prepare(
    'INSERT INTO audit_anchors (reason,actor,through_id,prev_head,new_head,rows_affected,key_fpr) ' +
    'VALUES (?,?,?,?,?,?,?)'
  ).run(
    isFirstRun
      ? 'baseline: chain introduced (P4.6) — rows at or below through_id are hashed retroactively'
      : 'backfill: rows found without a hash were chained',
    'system', through, head ? head.row_hash : chain.GENESIS,
    links[links.length - 1].row_hash, links.length, chain.keyFingerprint(key)
  );
  console.log('[audit] chained ' + links.length + ' existing row(s) through id ' + through);
}

/* ── P4: pre-P4 role keys → their P4 replacements ──────────────────
 * Runs on every boot; a no-op once there is nothing left to move.
 *
 * ONLY pure renames are migrated — a mapping is applied when the old and new
 * roles hold exactly the same grants. data_entry → employee qualifies.
 * viewer → auditor does NOT (auditor adds audit.view and user.view), so viewer
 * accounts are left where they are and an administrator moves them by hand if
 * that is what they actually want. Silently widening somebody's access during a
 * version upgrade is how privilege creep happens.
 */
function migrateLegacyRoles() {
  const rbac = require('./rbac');
  const grantKey = (roleKey) => {
    const row = db.prepare('SELECT id FROM roles WHERE key=?').get(roleKey);
    if (!row) return null;
    return db.prepare(
      'SELECT p.key AS k, rp.scope AS s FROM role_permissions rp ' +
      'JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=? ORDER BY p.key'
    ).all(row.id).map(r => r.k + ':' + r.s).join('|');
  };

  rbac.ROLES.filter(r => r.legacy && r.replacedBy).forEach(old => {
    const target = db.prepare('SELECT id, key FROM roles WHERE key=?').get(old.replacedBy);
    const source = db.prepare('SELECT id, key FROM roles WHERE key=?').get(old.key);
    if (!target || !source) return;
    // Identical grants, or no move. This is the guard that keeps a rename from
    // turning into a promotion if the catalogue is edited later.
    if (grantKey(old.key) !== grantKey(old.replacedBy)) return;

    const holders = db.prepare('SELECT id, username FROM users WHERE role_id=?').all(source.id);
    if (!holders.length) return;
    const upd = db.prepare('UPDATE users SET role_id=?, role=? WHERE id=?');
    holders.forEach(u => upd.run(target.id, target.key, u.id));
    console.log('[rbac] migrated ' + holders.length + ' account(s) ' + old.key + ' → ' + target.key);
  });
}

/* ── RBAC seed ─────────────────────────────────────────────────────
 * Idempotent and self-healing: run on every boot, it inserts anything missing
 * and refreshes the system roles' grants to match the catalogue in rbac.js.
 *
 * Why re-sync rather than seed-once: the catalogue is the specification of what
 * the four system roles may do. If a permission is added in code, a boot picks
 * it up. Custom roles (is_system = 0) are never touched — an operator's own
 * roles are their business, and silently rewriting them would be worse than
 * useless.
 */
function seedRbac() {
  const rbac = require('./rbac');

  const upPerm = db.prepare(
    'INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES (?,?,?,?,?) ' +
    'ON CONFLICT(key) DO UPDATE SET resource=excluded.resource, action=excluded.action, ' +
    'description=excluded.description, is_sensitive=excluded.is_sensitive'
  );
  rbac.PERMISSIONS.forEach(p =>
    upPerm.run(p.key, p.resource, p.action, p.desc || '', p.sensitive ? 1 : 0));

  const upRole = db.prepare(
    'INSERT INTO roles (key,name,description,rank,mfa,is_system,is_legacy,replaced_by) VALUES (?,?,?,?,?,?,?,?) ' +
    'ON CONFLICT(key) DO UPDATE SET name=excluded.name, description=excluded.description, ' +
    'rank=excluded.rank, mfa=excluded.mfa, is_system=excluded.is_system, ' +
    'is_legacy=excluded.is_legacy, replaced_by=excluded.replaced_by'
  );
  rbac.ROLES.forEach(r => upRole.run(
    r.key, r.name, r.desc || '', r.rank, r.mfa, r.isSystem ? 1 : 0,
    r.legacy ? 1 : 0, r.replacedBy || null));

  const roleId = db.prepare('SELECT id FROM roles WHERE key=?');
  const permId = db.prepare('SELECT id FROM permissions WHERE key=?');
  const clearGrants = db.prepare('DELETE FROM role_permissions WHERE role_id=?');
  const addGrant = db.prepare(
    'INSERT INTO role_permissions (role_id,permission_id,scope) VALUES (?,?,?) ' +
    'ON CONFLICT(role_id,permission_id) DO UPDATE SET scope=excluded.scope'
  );

  rbac.ROLES.forEach(r => {
    const rid = roleId.get(r.key);
    if (!rid) return;
    // Replace wholesale so a permission REMOVED from the catalogue is actually
    // revoked. An upsert-only sync would leave stale grants behind forever,
    // which is the opposite of least privilege.
    clearGrants.run(rid.id);
    rbac.grantsFor(r).forEach(([key, scope]) => {
      const pid = permId.get(key);
      if (pid) addGrant.run(rid.id, pid.id, scope);
    });
  });

  applyMfaPolicyOverride();
  backfillRoleIds();
}

/* ── P4: operator MFA policy beats the catalogue default ───────────
 * seedRbac() rewrites roles.mfa from rbac.js on every boot, which would silently
 * undo an administrator's choice in Security → MFA Policy after the next
 * restart. The chosen policy therefore lives in app_settings (durable, and
 * outside the seed's reach) and is re-applied here, immediately after the seed
 * that would otherwise have clobbered it.
 *
 * A role the catalogue marks 'required' can never be relaxed to 'optional' by
 * this path — see infra/policy.js. The override may only tighten.
 */
function applyMfaPolicyOverride() {
  let byRole;
  try { byRole = require('./policy').mfaPolicyOverrides(db); } catch (e) { return; }
  if (!byRole) return;
  const upd = db.prepare('UPDATE roles SET mfa=? WHERE key=?');
  Object.keys(byRole).forEach(k => {
    if (byRole[k] === 'required' || byRole[k] === 'optional') upd.run(byRole[k], k);
  });
}

/**
 * Give every account a role_id.
 *
 * Runs both inside migrate() (for accounts that predate RBAC) and again after
 * seedDefaults() in init() — the first administrator is created by seedDefaults,
 * i.e. AFTER the roles exist but after the first back-fill has already run, so
 * without the second pass it would be left with a null role_id and no
 * permissions at all.
 *
 * An unrecognised legacy role maps to the LEAST privileged role, never to
 * admin: an unreadable role must never be interpreted as full access.
 */
function backfillRoleIds() {
  const rbac = require('./rbac');
  const roleId = db.prepare('SELECT id FROM roles WHERE key=?');
  const viewer = roleId.get('viewer');
  if (!viewer) return;                       // roles not seeded yet — nothing to do
  const upd = db.prepare('UPDATE users SET role_id=? WHERE id=?');
  db.prepare('SELECT id, username, role FROM users WHERE role_id IS NULL').all().forEach(u => {
    const mapped = rbac.LEGACY_ROLE_MAP[String(u.role || '').toLowerCase()] || null;
    const target = (mapped && roleId.get(mapped)) || viewer;
    upd.run(target.id, u.id);
  });
}

/** roles.id for a role key, or null. */
function roleIdForKey(key) {
  const r = db.prepare('SELECT id FROM roles WHERE key=?').get(String(key || '').toLowerCase());
  return r ? r.id : null;
}

/* ── P1.1 migration: sessions.token → sessions.token_hash ──────────
 * SQLite cannot ALTER a PRIMARY KEY, so the table is rebuilt. Done inside a
 * transaction: either the whole swap lands or the original table is untouched.
 *
 * Backward compatibility — the point of doing it this way:
 * the raw token is still present in the old table at migration time, so each
 * row's hash can be COMPUTED from it. Every browser currently holding a cookie
 * keeps working, because the token in that cookie hashes to the row we just
 * wrote. Nobody is signed out by this upgrade. (Discarding the old rows would
 * have been far simpler, and would have logged out every active user.)
 *
 * Timestamps are normalised to ISO-8601 with an explicit Z. SQLite's
 * datetime('now') yields "YYYY-MM-DD HH:MM:SS" — a UTC instant with no timezone
 * marker, which Date.parse() interprets as LOCAL time. On this machine (UTC+7)
 * that made every stored timestamp read 7 hours in the past, which would have
 * expired sessions the moment idle checking was switched on.
 */
function migrateSessionsToHashed() {
  const cols = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
  if (cols.includes('token_hash')) return;      // already migrated
  if (!cols.includes('token')) return;          // unrecognised shape — leave alone

  const crypto = require('node:crypto');
  const device = require('./device');
  const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

  const old = db.prepare('SELECT * FROM sessions').all();

  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE sessions_new (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash  TEXT UNIQUE NOT NULL,
      username    TEXT NOT NULL,
      user_id     INTEGER,
      ip          TEXT,
      user_agent  TEXT,
      device_name TEXT,
      created_at  TEXT NOT NULL,
      last_seen   TEXT,
      expires_at  TEXT NOT NULL
    );`);

    const ins = db.prepare(
      'INSERT OR IGNORE INTO sessions_new ' +
      '(token_hash,username,user_id,ip,user_agent,device_name,created_at,last_seen,expires_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const uid = db.prepare('SELECT id FROM users WHERE username=?');
    let moved = 0;
    for (const r of old) {
      if (!r.token || !r.username) continue;
      const u = uid.get(r.username);
      ins.run(
        sha256(r.token), r.username, u ? u.id : null,
        null, null, null,                       // no IP/UA was recorded before P1
        toIsoUtc(r.created_at) || new Date().toISOString(),
        toIsoUtc(r.last_seen),
        toIsoUtc(r.expires_at) || new Date().toISOString()
      );
      moved++;
    }

    db.exec('DROP TABLE sessions;');
    db.exec('ALTER TABLE sessions_new RENAME TO sessions;');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sess_user ON sessions(username);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sess_hash ON sessions(token_hash);');
    db.exec('COMMIT');
    console.log('[migrate] sessions → token_hash: ' + moved + ' session(s) preserved, raw tokens discarded');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[migrate] sessions rebuild FAILED, table left unchanged:', e && e.message || e);
    throw e;
  }
}

/** "2026-07-27 09:40:59" (SQLite UTC) or ISO → ISO-8601 with Z. */
function toIsoUtc(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (!str) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(str)) {          // already carries a zone
    const d = new Date(str);
    return isNaN(d) ? null : d.toISOString();
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
}

function init() {
  db.exec(SCHEMA);
  migrate();
  seedDefaults();
  // seedDefaults may have created the first administrator; give it its role_id.
  backfillRoleIds();
  return db;
}

/**
 * First-run administrator.
 *
 * Root cause of the old behaviour: the seed was a literal in source control, so
 * every deployment of this repo shared one known password, and nothing ever
 * forced it to change. Anyone with the repo (or the README, or the login page's
 * own placeholder) held admin on any instance reachable at kdb.kdemployment.com.
 *
 * Now: 20 random characters from a CSPRNG, hashed before it touches the DB,
 * flagged must_change_password, shown exactly once. The same pattern Jenkins
 * uses for initialAdminPassword — the operator who installs it is the only
 * person who ever sees it, and only until they set their own.
 */
function seedFirstAdmin() {
  const plain = pw.generate(20);
  db.prepare(
    'INSERT INTO users (username,password,role,name,must_change_password,password_changed_at) ' +
    "VALUES (?,?,?,?,1,datetime('now'))"
  ).run('admin', pw.hash(plain), 'admin', 'Administrator');

  // The console scrolls away and start-hosting.bat may run detached, so also
  // drop it in a file next to the DB. Deleted automatically the moment the
  // password is changed (see repo.changeOwnPassword).
  let fileNote = '';
  try {
    fs.writeFileSync(INITIAL_PW_PATH,
      'KD Database — initial administrator password\r\n' +
      '============================================\r\n\r\n' +
      '  username: admin\r\n' +
      '  password: ' + plain + '\r\n\r\n' +
      'You must change this at first sign-in. This file is deleted automatically\r\n' +
      'once you do. If you are reading it after that, delete it yourself.\r\n',
      { mode: 0o600 });
    fileNote = '\n  (also saved to ' + INITIAL_PW_PATH + ')';
  } catch (e) { /* console output is enough */ }

  const line = '='.repeat(64);
  console.log('\n' + line);
  console.log('  KD DATABASE — FIRST RUN: administrator account created');
  console.log(line);
  console.log('    username:  admin');
  console.log('    password:  ' + plain);
  console.log(line);
  console.log('  Shown ONCE. You will be required to change it at first sign-in.' + fileNote);
  console.log(line + '\n');
}

function seedDefaults() {
  const tx = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (tx.c === 0) seedFirstAdmin();
  if (db.prepare('SELECT COUNT(*) AS c FROM employers').get().c === 0) {
    const ins = db.prepare('INSERT INTO employers (code,name) VALUES (?,?)');
    DEFAULT_EMPLOYERS.forEach(c => ins.run(c, c));
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM cities').get().c === 0) {
    const ins = db.prepare('INSERT INTO cities (country,code,name) VALUES (?,?,?)');
    Object.entries(DEFAULT_CITIES).forEach(([country, list]) =>
      list.forEach(([code, name]) => ins.run(country, code, name)));
  }
}

// Re-open the DB (used after a restore replaces the file)
function reopen() {
  try { db.close(); } catch (e) {}
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

// Fold the write-ahead log back into kd.db. Without this the WAL keeps growing
// and the main file lags behind — so a hard kill (or copying the data/ folder)
// could appear to "lose" recent writes. TRUNCATE also resets the WAL file size.
function checkpoint(mode) {
  try { db.exec('PRAGMA wal_checkpoint(' + (mode || 'PASSIVE') + ');'); } catch (e) {}
}

// Clean shutdown: checkpoint everything into kd.db, then close the handle.
function close() {
  checkpoint('TRUNCATE');
  try { db.close(); } catch (e) {}
}

module.exports = {
  get db() { return db; },
  init, reopen, seedDefaults, seedFirstAdmin, checkpoint, close, toIsoUtc,
  seedRbac, backfillRoleIds, roleIdForKey,
  DB_PATH, DB_DIR, DATA_DIR, UPLOADS_DIR, ROOT, INITIAL_PW_PATH,
  DEFAULT_CITIES,
};
