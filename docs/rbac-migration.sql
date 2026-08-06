-- ══════════════════════════════════════════════════════════════
-- KD Database — RBAC migration + seed (SQLite)
-- Generated from infra/rbac.js; applied automatically by dbmod.init().
-- Reproduced here as the auditable artefact.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE permissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT UNIQUE NOT NULL,               -- "<resource>.<action>"
  resource    TEXT NOT NULL,
  action      TEXT NOT NULL,
  description TEXT,
  is_sensitive INTEGER NOT NULL DEFAULT 0,        -- use of it is audited on success
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE TABLE role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL DEFAULT 'all',
  granted_at    TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (role_id, permission_id)
);
CREATE TABLE roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  rank        INTEGER NOT NULL DEFAULT 100,
  mfa         TEXT NOT NULL DEFAULT 'optional',   -- required | optional
  is_system   INTEGER NOT NULL DEFAULT 0,         -- system roles cannot be deleted
  created_at  TEXT DEFAULT (datetime('now'))
);

ALTER TABLE users     ADD COLUMN role_id     INTEGER REFERENCES roles(id);
ALTER TABLE employees ADD COLUMN created_by  TEXT;
ALTER TABLE employees ADD COLUMN status      TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE employees ADD COLUMN approved_by TEXT;
ALTER TABLE employees ADD COLUMN approved_at TEXT;
ALTER TABLE groups    ADD COLUMN created_by  TEXT;
ALTER TABLE groups    ADD COLUMN supervisor  TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_rp_role ON role_permissions(role_id);

-- ── Seed: roles ──
INSERT INTO roles (key,name,description,rank,mfa,is_system) VALUES ('admin','Admin','Full system access, including user management, security and database operations.',0,'required',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO roles (key,name,description,rank,mfa,is_system) VALUES ('manager','Manager','Department management: sees all records, approves submissions, edits their team, and reports.',10,'required',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO roles (key,name,description,rank,mfa,is_system) VALUES ('data_entry','Data Entry','Operational staff who enter employee and passport information.',20,'optional',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO roles (key,name,description,rank,mfa,is_system) VALUES ('viewer','Viewer','Read-only access to records, reports and the dashboard.',30,'optional',1) ON CONFLICT(key) DO NOTHING;

-- ── Seed: permissions (41) ──
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('audit.view','audit','view','Read the authentication audit trail',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('backup.create','backup','create','Create a database backup',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('backup.restore','backup','restore','Restore the database from a backup',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('dashboard.view','dashboard','view','View dashboard analytics',0) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('database.manage','database','manage','Direct database maintenance (storage, cleanup, offload)',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('document.delete','document','delete','Delete documents',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('document.upload','document','upload','Upload documents',0) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('document.view','document','view','View and download documents',0) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('employee.approve','employee','approve','Approve submitted records',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('employee.create','employee','create','Create employee records',0) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('employee.delete','employee','delete','Move employee records to trash',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('employee.draft','employee','draft','Save records as drafts and submit for approval',0) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('employee.update','employee','update','Edit employee records',0) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('employee.view','employee','view','View and search employee records',0) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('export.bundle','export','bundle','Export a full .kdb bundle with images',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('export.excel','export','excel','Export to Excel',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('export.pdf','export','pdf','Export to PDF',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('group.create','group','create','Create groups',0) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('group.delete','group','delete','Move groups to trash',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('group.update','group','update','Edit groups',0) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('group.view','group','view','View groups',0) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('import.execute','import','execute','Bulk-import records',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('mfa.enforce','mfa','enforce','Reset or enforce MFA on other accounts',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('ocr.process','ocr','process','Run passport OCR extraction',0) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('passport.create','passport','create','Record passport details',0) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('passport.delete','passport','delete','Remove passport details',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('passport.update','passport','update','Amend passport details',0) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('passport.view','passport','view','View passport details',0) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('report.view','report','view','View reports',0) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('role.assign','role','assign','Assign roles to users',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('role.manage','role','manage','Create and edit roles and their permissions',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('security.manage','security','manage','Manage security settings',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('settings.update','settings','update','Change system settings',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('settings.view','settings','view','View system settings',0) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('trash.purge','trash','purge','Permanently delete from trash',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('trash.restore','trash','restore','Restore from trash',0) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('trash.view','trash','view','View the trash bin',0) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('user.create','user','create','Create user accounts',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('user.delete','user','delete','Delete user accounts',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('user.update','user','update','Edit user accounts / reset passwords',1) ON CONFLICT(key) DO NOTHING;
INSERT INTO permissions (key,resource,action,description,is_sensitive) VALUES ('user.view','user','view','View user accounts',1) ON CONFLICT(key) DO NOTHING;

-- ── Seed: role_permissions ──
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='audit.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='backup.create' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='backup.restore' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='dashboard.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='database.manage' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='document.delete' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='document.upload' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='document.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='employee.approve' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='employee.create' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='employee.delete' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='employee.draft' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='employee.update' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='employee.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='export.bundle' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='export.excel' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='export.pdf' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='group.create' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='group.delete' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='group.update' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='group.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='import.execute' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='mfa.enforce' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='ocr.process' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='passport.create' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='passport.delete' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='passport.update' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='passport.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='report.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='role.assign' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='role.manage' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='security.manage' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='settings.update' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='settings.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='trash.purge' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='trash.restore' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='trash.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='user.create' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='user.delete' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='user.update' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='admin' AND p.key='user.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='manager' AND p.key='dashboard.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'team' FROM roles r,permissions p WHERE r.key='manager' AND p.key='document.upload' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='manager' AND p.key='document.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='manager' AND p.key='employee.approve' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'team' FROM roles r,permissions p WHERE r.key='manager' AND p.key='employee.update' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='manager' AND p.key='employee.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='manager' AND p.key='export.excel' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='manager' AND p.key='export.pdf' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'team' FROM roles r,permissions p WHERE r.key='manager' AND p.key='group.update' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='manager' AND p.key='group.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'team' FROM roles r,permissions p WHERE r.key='manager' AND p.key='passport.update' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='manager' AND p.key='passport.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='manager' AND p.key='report.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='manager' AND p.key='settings.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='manager' AND p.key='trash.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='data_entry' AND p.key='dashboard.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'own' FROM roles r,permissions p WHERE r.key='data_entry' AND p.key='document.upload' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='data_entry' AND p.key='document.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='data_entry' AND p.key='employee.create' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'own' FROM roles r,permissions p WHERE r.key='data_entry' AND p.key='employee.draft' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'own' FROM roles r,permissions p WHERE r.key='data_entry' AND p.key='employee.update' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='data_entry' AND p.key='employee.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='data_entry' AND p.key='group.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='data_entry' AND p.key='ocr.process' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='data_entry' AND p.key='passport.create' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'own' FROM roles r,permissions p WHERE r.key='data_entry' AND p.key='passport.update' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='data_entry' AND p.key='passport.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='viewer' AND p.key='dashboard.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='viewer' AND p.key='document.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='viewer' AND p.key='employee.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='viewer' AND p.key='group.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='viewer' AND p.key='passport.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id,scope) SELECT r.id,p.id,'all' FROM roles r,permissions p WHERE r.key='viewer' AND p.key='report.view' ON CONFLICT DO NOTHING;

-- ── Back-fill: legacy text roles → role_id (unknown ⇒ viewer, never admin) ──
UPDATE users SET role_id=(SELECT id FROM roles WHERE key='admin')  WHERE role_id IS NULL AND lower(role)='admin';
UPDATE users SET role_id=(SELECT id FROM roles WHERE key='viewer') WHERE role_id IS NULL;
