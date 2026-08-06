'use strict';
/**
 * infra/rbac.js — role-based access control: catalogue, policy and engine.
 *
 * ══════════════════════════════════════════════════════════════════
 * Architecture
 * ══════════════════════════════════════════════════════════════════
 * Authorisation is PERMISSION-based, never role-based. Nothing outside this
 * file asks "is this user an admin?" — callers ask "may this user do X to Y?"
 * and the answer is resolved from data:
 *
 *     users.role_id → roles → role_permissions → permissions
 *
 * That indirection is what makes new roles a data change rather than a code
 * change (requirement 11). Adding a "Auditor" role means one INSERT into roles
 * and a handful into role_permissions; no route, guard or handler is touched.
 *
 * ── Scopes ────────────────────────────────────────────────────────
 * A grant is not just "may update employees" — it carries HOW MUCH:
 *
 *     all   every record in the system
 *     team  records belonging to a group this user supervises
 *     own   records this user created
 *
 * This is what lets "Manager: Edit Team Records" and "Data Entry: Edit Own
 * Records" be expressed as data rather than as special cases in code. Scope is
 * stored per grant in role_permissions.scope, so the same permission can be
 * held at different breadth by different roles.
 *
 * ── Rank ──────────────────────────────────────────────────────────
 * roles.rank orders privilege (lower = more powerful). It exists for ONE
 * security invariant, enforced in canAssignRole(): nobody may create or promote
 * an account to a role at or above their own rank. Without it, any role holding
 * user.create could mint an Admin and escalate — the single most common RBAC
 * failure. Admin is rank 0 and is exempt only in the sense that no rank is above
 * it.
 *
 * ── Least privilege ───────────────────────────────────────────────
 * The grants below are exactly the capability keywords in the specification and
 * nothing more. Where a capability was ambiguous the narrower reading was taken
 * and the reasoning noted inline.
 */

/* ══════════════════════════════════════════════════════════════════
 * Permission catalogue
 * ══════════════════════════════════════════════════════════════════
 * key = "<resource>.<action>". Adding a permission here and granting it is all
 * that is required for it to become enforceable.
 *
 * `sensitive: true` marks a permission whose USE is written to auth_log even on
 * success (requirement 13) — the authorisation-relevant actions an auditor
 * would want to reconstruct: anything touching accounts, roles, security
 * settings, the database itself, or bulk extraction of personal data.
 */
const PERMISSIONS = [
  // ── Employees ──
  { key: 'employee.view',     resource: 'employee', action: 'view',     desc: 'View and search employee records' },
  { key: 'employee.create',   resource: 'employee', action: 'create',   desc: 'Create employee records' },
  { key: 'employee.update',   resource: 'employee', action: 'update',   desc: 'Edit employee records' },
  { key: 'employee.delete',   resource: 'employee', action: 'delete',   desc: 'Move employee records to trash', sensitive: true },
  { key: 'employee.approve',  resource: 'employee', action: 'approve',  desc: 'Approve submitted records', sensitive: true },
  { key: 'employee.draft',    resource: 'employee', action: 'draft',    desc: 'Save records as drafts and submit for approval' },

  // ── Passports ──
  { key: 'passport.view',     resource: 'passport', action: 'view',     desc: 'View passport details' },
  { key: 'passport.create',   resource: 'passport', action: 'create',   desc: 'Record passport details' },
  { key: 'passport.update',   resource: 'passport', action: 'update',   desc: 'Amend passport details' },
  { key: 'passport.delete',   resource: 'passport', action: 'delete',   desc: 'Remove passport details', sensitive: true },

  // ── Documents ──
  { key: 'document.view',     resource: 'document', action: 'view',     desc: 'View and download documents' },
  { key: 'document.upload',   resource: 'document', action: 'upload',   desc: 'Upload documents' },
  { key: 'document.delete',   resource: 'document', action: 'delete',   desc: 'Delete documents', sensitive: true },

  // ── OCR ──
  { key: 'ocr.process',       resource: 'ocr',      action: 'process',  desc: 'Run passport OCR extraction' },

  // ── Groups ──
  { key: 'group.view',        resource: 'group',    action: 'view',     desc: 'View groups' },
  { key: 'group.create',      resource: 'group',    action: 'create',   desc: 'Create groups' },
  { key: 'group.update',      resource: 'group',    action: 'update',   desc: 'Edit groups' },
  { key: 'group.delete',      resource: 'group',    action: 'delete',   desc: 'Move groups to trash', sensitive: true },

  // ── Reports / analytics ──
  { key: 'report.view',       resource: 'report',   action: 'view',     desc: 'View reports' },
  { key: 'dashboard.view',    resource: 'dashboard',action: 'view',     desc: 'View dashboard analytics' },

  // ── Export ──
  { key: 'export.excel',      resource: 'export',   action: 'excel',    desc: 'Export to Excel', sensitive: true },
  { key: 'export.pdf',        resource: 'export',   action: 'pdf',      desc: 'Export to PDF', sensitive: true },
  { key: 'export.bundle',     resource: 'export',   action: 'bundle',   desc: 'Export a full .kdb bundle with images', sensitive: true },
  /* The per-worker package: a folder per person holding their photograph and
   * every version of every document. Separate from export.bundle, and narrower
   * than it looks: the bundle is a restorable archive of the app's own making,
   * whereas this produces loose, readable passport scans in named folders —
   * the form in which a leak is most immediately usable. Admin only. */
  { key: 'export.package',    resource: 'export',   action: 'package',  desc: 'Export a package of worker photos and documents', sensitive: true },

  // ── Trash ──
  { key: 'trash.view',        resource: 'trash',    action: 'view',     desc: 'View the trash bin' },
  { key: 'trash.restore',     resource: 'trash',    action: 'restore',  desc: 'Restore from trash' },
  { key: 'trash.purge',       resource: 'trash',    action: 'purge',    desc: 'Permanently delete from trash', sensitive: true },

  // ── User management ──
  { key: 'user.view',         resource: 'user',     action: 'view',     desc: 'View user accounts', sensitive: true },
  { key: 'user.create',       resource: 'user',     action: 'create',   desc: 'Create user accounts', sensitive: true },
  { key: 'user.update',       resource: 'user',     action: 'update',   desc: 'Edit user accounts / reset passwords', sensitive: true },
  { key: 'user.delete',       resource: 'user',     action: 'delete',   desc: 'Delete user accounts', sensitive: true },
  { key: 'role.assign',       resource: 'role',     action: 'assign',   desc: 'Assign roles to users', sensitive: true },
  { key: 'role.manage',       resource: 'role',     action: 'manage',   desc: 'Create and edit roles and their permissions', sensitive: true },

  // ── Security ──
  { key: 'audit.view',        resource: 'audit',    action: 'view',     desc: 'Read the authentication audit trail', sensitive: true },
  { key: 'security.manage',   resource: 'security', action: 'manage',   desc: 'Manage security settings', sensitive: true },
  { key: 'mfa.enforce',       resource: 'mfa',      action: 'enforce',  desc: 'Reset or enforce MFA on other accounts', sensitive: true },

  // ── System ──
  { key: 'settings.view',     resource: 'settings', action: 'view',     desc: 'View system settings' },
  { key: 'settings.update',   resource: 'settings', action: 'update',   desc: 'Change system settings', sensitive: true },
  { key: 'backup.create',     resource: 'backup',   action: 'create',   desc: 'Create a database backup', sensitive: true },
  { key: 'backup.restore',    resource: 'backup',   action: 'restore',  desc: 'Restore the database from a backup', sensitive: true },
  { key: 'database.manage',   resource: 'database', action: 'manage',   desc: 'Direct database maintenance (storage, cleanup, offload)', sensitive: true },
  { key: 'import.execute',    resource: 'import',   action: 'execute',  desc: 'Bulk-import records', sensitive: true },
];

const SCOPE = { ALL: 'all', TEAM: 'team', OWN: 'own' };

/* ══════════════════════════════════════════════════════════════════
 * Roles
 * ══════════════════════════════════════════════════════════════════
 * rank: lower is more privileged. See canAssignRole().
 * mfa:  'required' | 'optional'  (requirement 12)
 */
/* Grant lists are named constants because two role keys share each of them: the
 * P4 key and the pre-P4 key it replaces. Referencing one array from both roles
 * is what makes "employee is a rename of data_entry" true by construction rather
 * than by two lists that drift apart. */
const GRANTS_EMPLOYEE = [
  // "Search Records" — reading across the dataset is needed to avoid
  // creating duplicates, so view is ALL while every write is OWN.
  ['employee.view',   SCOPE.ALL],
  ['passport.view',   SCOPE.ALL],
  ['document.view',   SCOPE.ALL],
  ['group.view',      SCOPE.ALL],
  // "Create Employee", "Create Passport"
  ['employee.create', SCOPE.ALL],
  ['passport.create', SCOPE.ALL],
  // "Edit Own Records" — strictly the records this account created.
  ['employee.update', SCOPE.OWN],
  ['passport.update', SCOPE.OWN],
  // "Upload Documents", "OCR Processing", "Draft Records"
  ['document.upload', SCOPE.OWN],
  ['ocr.process',     SCOPE.ALL],
  ['employee.draft',  SCOPE.OWN],
  ['dashboard.view',  SCOPE.ALL],
  /* Deliberately NOT granted, per the stated restrictions:
   *   *.delete, trash.*   — "No Delete Permission"
   *   user.*, role.*      — "No User Management"
   *   settings.update     — "No System Settings"
   *   backup.*, database.*, import.execute — "No Database Access" */
];

const GRANTS_VIEWER = [
  ['employee.view',  SCOPE.ALL],
  ['passport.view',  SCOPE.ALL],
  ['document.view',  SCOPE.ALL],
  ['group.view',     SCOPE.ALL],
  ['report.view',    SCOPE.ALL],
  ['dashboard.view', SCOPE.ALL],
  /* No create, update, delete, export or user management — every one of
   * those is an explicit restriction. Note in particular that export.* is
   * withheld: a Viewer may read the data on screen but may not extract it
   * in bulk. */
];

const ROLES = [
  {
    key: 'admin', name: 'Admin', rank: 0, mfa: 'required', isSystem: true,
    desc: 'Full system access, including user management, security and database operations.',
    // '*' is expanded to the whole catalogue at seed time. Stored expanded, not
    // as a wildcard, so an audit of role_permissions shows exactly what Admin
    // holds rather than an opaque star.
    grants: '*',
  },
  {
    key: 'manager', name: 'Manager', rank: 10, mfa: 'required', isSystem: true,
    desc: 'Department management: sees all records, approves submissions, edits their team, and reports.',
    grants: [
      // "View All Records"
      ['employee.view',    SCOPE.ALL],
      ['passport.view',    SCOPE.ALL],
      ['document.view',    SCOPE.ALL],
      ['group.view',       SCOPE.ALL],
      ['trash.view',       SCOPE.ALL],
      // "Approve Records"
      ['employee.approve', SCOPE.ALL],
      // "Edit Team Records" — scoped, not global. A manager may not rewrite a
      // record belonging to another supervisor's group.
      ['employee.update',  SCOPE.TEAM],
      ['passport.update',  SCOPE.TEAM],
      ['document.upload',  SCOPE.TEAM],
      ['group.update',     SCOPE.TEAM],
      // "Reports", "Dashboard Analytics"
      ['report.view',      SCOPE.ALL],
      ['dashboard.view',   SCOPE.ALL],
      // "Export Excel", "Export PDF"
      ['export.excel',     SCOPE.ALL],
      ['export.pdf',       SCOPE.ALL],
      ['settings.view',    SCOPE.ALL],
      /* Deliberately NOT granted, per the stated restrictions:
       *   settings.update  — "Cannot change system settings"
       *   backup.restore   — "Cannot restore database"
       *   user.*           — user management is not among the Manager
       *                      capabilities. The restriction "cannot create Admin
       *                      accounts" is therefore satisfied outright; the rank
       *                      invariant in canAssignRole() enforces it a second
       *                      time should user.create ever be granted here.
       *   *.delete         — deletion is not a stated Manager capability. */
    ],
  },
  {
    /* P4 renamed "Data Entry" to "Employee" to match the administration
     * vocabulary the business actually uses. The grants are IDENTICAL to the old
     * data_entry role — this is a rename, not a privilege change. The old key
     * survives below as a legacy role so no existing account changes meaning
     * mid-upgrade; db.migrate() moves those accounts across on first boot. */
    key: 'employee', name: 'Employee', rank: 20, mfa: 'optional', isSystem: true,
    desc: 'Operational staff who enter employee and passport information.',
    grants: GRANTS_EMPLOYEE,
  },
  {
    /* P4 — Auditor.
     *
     * The compliance reader: everything a Viewer sees, PLUS the authentication
     * audit trail and the account list, and nothing that writes. It exists
     * because "who may read the audit log" was previously answerable only with
     * "an Admin", which forced auditors to hold full write access to do a
     * read-only job — the exact opposite of least privilege.
     *
     * user.view is granted deliberately: reconstructing an access-control review
     * from auth_log alone is impossible without knowing which account holds
     * which role. It is a sensitive permission, so its use is itself audited.
     *
     * export.* is still withheld. An auditor reads the trail in the app and can
     * export the LOG (a client-side CSV of data they already hold); they cannot
     * bulk-extract the personal data of every worker. */
    key: 'auditor', name: 'Auditor', rank: 25, mfa: 'required', isSystem: true,
    desc: 'Read-only compliance access: records, reports, the audit trail and the account list.',
    grants: [
      ['employee.view',  SCOPE.ALL],
      ['passport.view',  SCOPE.ALL],
      ['document.view',  SCOPE.ALL],
      ['group.view',     SCOPE.ALL],
      ['trash.view',     SCOPE.ALL],
      ['report.view',    SCOPE.ALL],
      ['dashboard.view', SCOPE.ALL],
      ['settings.view',  SCOPE.ALL],
      ['audit.view',     SCOPE.ALL],
      ['user.view',      SCOPE.ALL],
    ],
  },

  /* ── Legacy keys ──────────────────────────────────────────────────
   * Retained, not deleted. An account is pinned to a role by role_id, so
   * removing a row here would strip every holder of every permission at the
   * next boot (seedRbac clears grants by role). They are marked `legacy` so the
   * administration UI keeps them out of the role picker while still displaying
   * them for accounts that hold one. */
  {
    key: 'data_entry', name: 'Data Entry (legacy)', rank: 20, mfa: 'optional',
    isSystem: true, legacy: true, replacedBy: 'employee',
    desc: 'Pre-P4 name for Employee. Identical grants; retained for existing accounts.',
    grants: GRANTS_EMPLOYEE,
  },
  {
    key: 'viewer', name: 'Viewer (legacy)', rank: 30, mfa: 'optional',
    isSystem: true, legacy: true, replacedBy: 'auditor',
    desc: 'Read-only access to records, reports and the dashboard.',
    grants: GRANTS_VIEWER,
  },
];

/* Legacy role names that must keep working during and after migration.
 * The old model had only 'admin' and 'viewer'; both survive by name, so no
 * existing account changes meaning.
 *
 * NB: viewer is deliberately NOT mapped onto auditor. They differ by audit.view
 * and user.view, so remapping would silently GRANT two sensitive permissions to
 * every existing read-only account. A migration may rename; it may never
 * promote. */
const LEGACY_ROLE_MAP = { admin: 'admin', viewer: 'viewer', data_entry: 'employee' };

/* Roles offered in the administration UI, most privileged first. Legacy keys are
 * excluded here and surfaced only when an account still holds one. */
const ASSIGNABLE_ROLE_KEYS = ROLES.filter(r => !r.legacy).map(r => r.key);

/* ══════════════════════════════════════════════════════════════════
 * Engine
 * ══════════════════════════════════════════════════════════════════ */

const PERMISSION_KEYS = PERMISSIONS.map(p => p.key);
const PERMISSION_BY_KEY = new Map(PERMISSIONS.map(p => [p.key, p]));
const SENSITIVE = new Set(PERMISSIONS.filter(p => p.sensitive).map(p => p.key));

/** Expand a role definition's grants into [permissionKey, scope] pairs. */
function grantsFor(role) {
  if (role.grants === '*') return PERMISSION_KEYS.map(k => [k, SCOPE.ALL]);
  return role.grants;
}

/**
 * Decide a permission question.
 *
 * @param {object} grants  { permissionKey: scope } for the acting user's role
 * @param {string} key     permission being requested
 * @param {object} ctx     optional { ownerId, teamIds, recordTeamId }
 * @returns {{allowed:boolean, scope?:string, reason?:string}}
 *
 * Default deny: an unknown permission key, or one the role does not hold, is
 * refused. There is no fall-through that grants anything.
 */
function check(grants, key, ctx) {
  const c = ctx || {};
  if (!PERMISSION_BY_KEY.has(key)) return { allowed: false, reason: 'unknown-permission' };
  const scope = grants ? grants[key] : undefined;
  if (!scope) return { allowed: false, reason: 'not-granted' };

  // Holding a permission at ALL scope settles it without touching the record.
  if (scope === SCOPE.ALL) return { allowed: true, scope };

  // Narrower scopes need the record to compare against. A caller that asks a
  // scoped question without supplying the record is answered "no" rather than
  // being allowed through — failing open here would silently turn `own` into
  // `all` for every route that forgot to pass context.
  if (scope === SCOPE.OWN) {
    if (c.actor == null || c.ownerId == null) return { allowed: false, reason: 'scope-own-no-context' };
    return String(c.ownerId) === String(c.actor)
      ? { allowed: true, scope }
      : { allowed: false, reason: 'scope-own-mismatch' };
  }
  if (scope === SCOPE.TEAM) {
    if (!Array.isArray(c.teamIds) || c.recordTeamId == null) return { allowed: false, reason: 'scope-team-no-context' };
    return c.teamIds.map(String).includes(String(c.recordTeamId))
      ? { allowed: true, scope }
      : { allowed: false, reason: 'scope-team-mismatch' };
  }
  return { allowed: false, reason: 'unknown-scope' };
}

/**
 * The rank invariant: an actor may never grant MORE privilege than they hold.
 *
 *     allowed  ⇔  targetRank >= actorRank        (higher rank = less privileged)
 *
 * This is what stops privilege escalation through user management. Without it,
 * any role that can create users can create an Admin and take over — the most
 * common way RBAC implementations are defeated in practice.
 *
 * Equal rank is permitted, and that is deliberate: a strict `>` would mean an
 * Admin could never appoint another Admin, leaving the system with exactly one
 * person able to manage it and no way to add a second without database access.
 * Escalation requires moving to a LOWER rank number, and that is what is
 * refused.
 *
 * Lateral creation (a Manager creating another Manager) is therefore allowed by
 * this rule — but it is unreachable in the shipped configuration, because
 * Manager holds no user.create permission at all. Defence in depth: if that
 * grant is ever added, the holder still cannot escalate above themselves.
 */
function canAssignRole(actorRank, targetRank) {
  if (actorRank == null || targetRank == null) return false;
  return Number(targetRank) >= Number(actorRank);
}

/** Is using this permission itself worth an audit entry? (requirement 13) */
function isSensitive(key) { return SENSITIVE.has(key); }

/** The MFA requirement attached to a role (requirement 12). */
function mfaFor(roleKey) {
  const r = ROLES.find(x => x.key === String(roleKey || '').toLowerCase());
  return r ? r.mfa : 'required';      // unknown role ⇒ strictest
}

/* ══════════════════════════════════════════════════════════════════
 * Export formats → the permission each one needs (P4.5)
 * ══════════════════════════════════════════════════════════════════
 * export.excel / export.pdf / export.bundle existed from P2 and were granted to
 * Manager, but NOTHING mapped a request onto them: every export ran entirely in
 * the browser from already-loaded data, so a Viewer — explicitly denied all
 * three — could export anyway, and no export ever reached the audit trail.
 *
 * This table is what makes the three grants mean something. An unrecognised
 * format resolves to export.bundle, the narrowest grant, so a new format added
 * to the UI fails closed rather than being exportable by everyone.
 */
const EXPORT_FORMAT_PERMISSION = {
  csv:          'export.excel',
  xlsx:         'export.excel',
  'kd-pdf':     'export.pdf',
  'detail-pdf': 'export.pdf',
  'kd-png':     'export.pdf',
  pptx:         'export.pdf',
  docs:         'export.pdf',
  // Whole-dataset extractions. Deliberately the most restricted grant: a .kdb
  // bundle carries every record AND every image, and the JSON dump is the entire
  // database in one file.
  kdb:          'export.bundle',
  json:         'export.bundle',
  package:      'export.package',
  audit:        'audit.view',      // the audit-log CSV — data the reader already holds
};
function exportPermissionFor(format) {
  return EXPORT_FORMAT_PERMISSION[String(format || '').toLowerCase()] || 'export.bundle';
}

/* Resource → human grouping, for the permission matrix in the administration
 * UI. A resource missing from here still renders — it falls into 'Other' — so
 * adding a permission never requires touching this table. */
const RESOURCE_GROUPS = [
  { key: 'records',  resources: ['employee', 'passport', 'group', 'ocr'] },
  { key: 'documents',resources: ['document'] },
  { key: 'insights', resources: ['report', 'dashboard', 'export'] },
  { key: 'data',     resources: ['trash', 'backup', 'database', 'import'] },
  { key: 'access',   resources: ['user', 'role'] },
  { key: 'security', resources: ['audit', 'security', 'mfa'] },
  { key: 'system',   resources: ['settings'] },
];
function groupForResource(resource) {
  const g = RESOURCE_GROUPS.find(x => x.resources.includes(resource));
  return g ? g.key : 'other';
}

module.exports = {
  PERMISSIONS, PERMISSION_KEYS, PERMISSION_BY_KEY, ROLES, SCOPE,
  LEGACY_ROLE_MAP, ASSIGNABLE_ROLE_KEYS, RESOURCE_GROUPS, groupForResource,
  EXPORT_FORMAT_PERMISSION, exportPermissionFor,
  grantsFor, check, canAssignRole, isSensitive, mfaFor,
};
