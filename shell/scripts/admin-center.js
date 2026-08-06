/**
 * admin-center.js — the P4 Enterprise Administration Centre.
 *
 * ══════════════════════════════════════════════════════════════════
 * What this file is
 * ══════════════════════════════════════════════════════════════════
 * The render layer for the Security, Administration, Monitoring and Data
 * sections of Settings. It holds no business logic: every decision — may this
 * account see this, is this password acceptable, is this role assignable — is
 * made by the server and merely displayed here.
 *
 * Kept out of app.js deliberately. app.js is already ~8 000 lines of worker-record
 * UI; mixing the administration screens into it would make both harder to reason
 * about, and this file has a genuinely different lifetime (it only runs while an
 * administrator has a Settings pane open).
 *
 * ── Conventions used throughout ────────────────────────────────────
 *  • Every pane renders from ONE server payload, fetched on first open and
 *    cached until explicitly refreshed. Panes are never populated on app start:
 *    an account that cannot reach a section never issues its request.
 *  • Every string goes through t()/bi() — nothing user-visible is hard-coded.
 *  • Every table is wrapped in .ac-scroll so wide content scrolls inside its own
 *    box rather than making the dialog scroll sideways.
 *  • Destructive actions go through showConfirm(), never window.confirm.
 */

/* ══════════════════════════════════════════════════════════════════
 * Shared helpers
 * ══════════════════════════════════════════════════════════════════ */

/**
 * Permission check, with a safe answer when the app has not booted yet.
 *
 * Tests `typeof DB`, NOT `window.DB`: db.js declares DB with `const`, which
 * creates a global BINDING but never a property on `window`. Reaching through
 * window returned undefined, so every guarded pane rendered "you do not hold
 * the permission" — to an administrator holding all 41 of them.
 */
function acCan(perm) {
  try { return typeof DB !== 'undefined' && !!(DB.can && DB.can(perm)); } catch (e) { return false; }
}

/** Bytes → "12.4 MB". Binary units, because that is what a disk reports. */
function acBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}

/** Seconds → "3d 4h 12m". */
function acDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(d + 'd');
  if (h) parts.push(h + 'h');
  if (m || !parts.length) parts.push(m + 'm');
  return parts.join(' ');
}

/**
 * An ISO timestamp in the viewer's chosen timezone.
 *
 * The stored value is always UTC (see the note in the Timezone pane); this is
 * the only place that decides how it is shown, so a preference change never has
 * to reach into the data.
 */
function acTime(iso, opts) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const o = Object.assign({
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }, opts || {});
  const tz = acTimezone();
  if (tz) o.timeZone = tz;
  try { return new Intl.DateTimeFormat(acLocale(), o).format(d); }
  catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
}

/** "3 minutes ago" — relative time in the active language. */
function acAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const abs = Math.abs(ms);
  const units = [['second', 1000], ['minute', 60000], ['hour', 3600000], ['day', 86400000], ['month', 2592000000], ['year', 31536000000]];
  let unit = 'second', div = 1000;
  for (const [u, d] of units) { if (abs >= d) { unit = u; div = d; } }
  try {
    return new Intl.RelativeTimeFormat(acLocale(), { numeric: 'auto' })
      .format(-Math.round(ms / div), unit);
  } catch (e) { return acTime(iso); }
}

function acLocale() {
  const map = { en: 'en-GB', th: 'th-TH', lo: 'lo-LA', ko: 'ko-KR' };
  return map[(typeof currentLang !== 'undefined' ? currentLang : 'en')] || 'en-GB';
}

/** The chosen timezone, or '' for "follow this device". */
function acTimezone() {
  try { return localStorage.getItem('kd_tz') || ''; } catch (e) { return ''; }
}

/** A role's display name, translated. Unknown/custom keys show their own name. */
function acRoleName(key, fallback) {
  const k = String(key || '').toLowerCase();
  const known = {
    admin:      bi('ຜູ້ດູແລລະບົບ', 'Admin', 'ผู้ดูแลระบบ', '관리자'),
    manager:    bi('ຜູ້ຈັດການ', 'Manager', 'ผู้จัดการ', '매니저'),
    employee:   bi('ພະນັກງານ', 'Employee', 'พนักงาน', '직원'),
    auditor:    bi('ຜູ້ກວດສອບ', 'Auditor', 'ผู้ตรวจสอบ', '감사자'),
    data_entry: bi('ປ້ອນຂໍ້ມູນ (ເກົ່າ)', 'Data Entry (legacy)', 'ป้อนข้อมูล (เดิม)', '데이터 입력 (구)'),
    viewer:     bi('ຜູ້ເບິ່ງ (ເກົ່າ)', 'Viewer (legacy)', 'ผู้ดู (เดิม)', '뷰어 (구)'),
  };
  return known[k] || fallback || key || '—';
}

/** Status pill. `level` is one of excellent | good | warning | critical | info. */
function acPill(level, label) {
  return '<span class="ac-pill ac-' + esc(level) + '">' + esc(label) + '</span>';
}

/** A summary card. `tone` colours the value; `hint` is the small line under it. */
function acCard(label, value, hint, tone) {
  return '<div class="ac-stat' + (tone ? ' ac-stat-' + tone : '') + '">' +
    '<div class="ac-stat-label">' + esc(label) + '</div>' +
    '<div class="ac-stat-value">' + esc(String(value)) + '</div>' +
    (hint ? '<div class="ac-stat-hint">' + esc(hint) + '</div>' : '') +
  '</div>';
}

/** Key/value row, the shape used by every diagnostic list. */
function acRow(label, value, mono) {
  return '<div class="ac-kv"><span class="ac-kv-k">' + esc(label) + '</span>' +
    '<span class="ac-kv-v' + (mono ? ' ac-mono' : '') + '">' + esc(String(value == null ? '—' : value)) + '</span></div>';
}

/** Placeholder shown while a pane's request is in flight. */
function acLoading() {
  return '<div class="ac-empty" role="status">' +
    esc(bi('ກຳລັງໂຫລດ…', 'Loading…', 'กำลังโหลด…', '불러오는 중…')) + '</div>';
}

function acEmpty(msg) {
  return '<div class="ac-empty">' + esc(msg) + '</div>';
}

/**
 * Render an error into a pane instead of leaving it blank.
 *
 * A 403 here is not a bug — it is the server refusing a permission the UI
 * offered — so it gets its own message rather than a generic failure. Silently
 * empty panes are the worst outcome: the operator cannot tell "nothing to show"
 * from "this broke".
 */
function acError(e) {
  const status = e && e.status;
  if (status === 403) {
    return '<div class="ac-empty ac-empty-warn">' +
      esc(bi('ບັນຊີນີ້ບໍ່ມີສິດເບິ່ງສ່ວນນີ້',
             'This account does not hold the permission for this section',
             'บัญชีนี้ไม่มีสิทธิ์ดูส่วนนี้',
             '이 계정에는 이 섹션에 대한 권한이 없습니다')) + '</div>';
  }
  const detail = (e && e.body && e.body.error) || (e && e.message) || String(e);
  return '<div class="ac-empty ac-empty-warn">' +
    esc(bi('ໂຫລດບໍ່ສຳເລັດ', 'Could not load', 'โหลดไม่สำเร็จ', '불러오지 못했습니다')) +
    ' — <span class="ac-mono">' + esc(detail) + '</span></div>';
}

/** Set a pane body's content and clear its busy state. */
function acFill(id, html) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = html;
  el.setAttribute('aria-busy', 'false');
}

/**
 * Wrap a pane render in the loading / error handling every one of them needs.
 * `fn` receives nothing and returns the HTML (may be async).
 */
async function acRender(bodyId, fn) {
  const el = document.getElementById(bodyId);
  if (!el) return;
  el.setAttribute('aria-busy', 'true');
  el.innerHTML = acLoading();
  try { acFill(bodyId, await fn()); }
  catch (e) { acFill(bodyId, acError(e)); }
}

/** A table with a horizontally scrollable wrapper and a caption for screen readers. */
function acTable(caption, headers, rowsHtml) {
  return '<div class="ac-scroll"><table class="ac-table">' +
    '<caption class="sr-only">' + esc(caption) + '</caption>' +
    '<thead><tr>' + headers.map(h =>
      '<th scope="col">' + esc(h) + '</th>').join('') + '</tr></thead>' +
    '<tbody>' + rowsHtml + '</tbody></table></div>';
}

/* Common labels, defined once so the same concept reads identically everywhere. */
const AC_L = {
  user:     () => bi('ຜູ້ໃຊ້', 'User', 'ผู้ใช้', '사용자'),
  role:     () => bi('ບົດບາດ', 'Role', 'บทบาท', '역할'),
  status:   () => bi('ສະຖານະ', 'Status', 'สถานะ', '상태'),
  actions:  () => bi('ຄຳສັ່ງ', 'Actions', 'การทำงาน', '작업'),
  created:  () => bi('ສ້າງເມື່ອ', 'Created', 'สร้างเมื่อ', '생성'),
  lastUsed: () => bi('ໃຊ້ຫຼ້າສຸດ', 'Last used', 'ใช้ล่าสุด', '최근 사용'),
  lastSeen: () => bi('ເຫັນຫຼ້າສຸດ', 'Last seen', 'เห็นล่าสุด', '최근 활동'),
  device:   () => bi('ອຸປະກອນ', 'Device', 'อุปกรณ์', '기기'),
  revoke:   () => bi('ຖອນສິດ', 'Revoke', 'ถอนสิทธิ์', '해지'),
  save:     () => bi('ບັນທຶກ', 'Save', 'บันทึก', '저장'),
  cancel:   () => bi('ຍົກເລີກ', 'Cancel', 'ยกเลิก', '취소'),
  none:     () => bi('ບໍ່ມີ', 'None', 'ไม่มี', '없음'),
  yes:      () => bi('ແມ່ນ', 'Yes', 'ใช่', '예'),
  no:       () => bi('ບໍ່', 'No', 'ไม่', '아니오'),
  saved:    () => bi('ບັນທຶກແລ້ວ', 'Saved', 'บันทึกแล้ว', '저장됨'),
  readOnly: () => bi('ອ່ານຢ່າງດຽວ — ບັນຊີນີ້ບໍ່ມີສິດແກ້ໄຂ',
                     'Read-only — this account cannot change these settings',
                     'อ่านอย่างเดียว — บัญชีนี้ไม่มีสิทธิ์แก้ไข',
                     '읽기 전용 — 이 계정은 변경할 수 없습니다'),
};

/* ══════════════════════════════════════════════════════════════════
 * TASK 1 — Security Overview
 * ══════════════════════════════════════════════════════════════════ */

let _acOverview = null;

/**
 * Human text for one risk finding.
 *
 * The server sends a KEY and a detail value, never a sentence — so the
 * assessment stays language-independent and the same finding reads correctly in
 * all four languages. An unrecognised key still renders (as its key), so adding
 * a finding server-side never produces a blank row here.
 */
function acFindingText(f) {
  const n = f.detail == null ? '' : f.detail;
  const map = {
    mfa_unenrolled_privileged: bi(
      n + ' ບັນຊີສິດສູງຍັງບໍ່ໄດ້ລົງທະບຽນປັດໄຈທີສອງ',
      n + ' privileged account(s) have not enrolled a second factor',
      n + ' บัญชีสิทธิ์สูงยังไม่ได้ลงทะเบียนปัจจัยที่สอง',
      n + '개의 권한 계정이 2단계 인증을 등록하지 않았습니다'),
    mfa_coverage_low: bi(
      'ມີພຽງ ' + n + ' ຂອງບັນຊີທີ່ໃຊ້ MFA',
      'Only ' + n + ' of accounts use MFA',
      'มีเพียง ' + n + ' ของบัญชีที่ใช้ MFA',
      '계정의 ' + n + '만 MFA를 사용합니다'),
    mfa_coverage_partial: bi(
      'ການໃຊ້ MFA ຢູ່ທີ່ ' + n + ' — ຍັງເພີ່ມໄດ້',
      'MFA coverage is ' + n + ' — room to improve',
      'การใช้ MFA อยู่ที่ ' + n + ' — ยังเพิ่มได้',
      'MFA 적용률 ' + n + ' — 개선 여지 있음'),
    single_admin: bi(
      'ມີຜູ້ດູແລລະບົບຄົນດຽວ — ຖ້າເສຍບັນຊີນີ້ຈະບໍ່ມີໃຜແກ້ໄຂໄດ້',
      'Only one administrator — losing this account leaves nobody able to manage the system',
      'มีผู้ดูแลระบบคนเดียว — หากเสียบัญชีนี้จะไม่มีใครแก้ไขได้',
      '관리자가 한 명뿐 — 이 계정을 잃으면 시스템을 관리할 사람이 없습니다'),
    many_admins: bi(
      'ມີຜູ້ດູແລລະບົບ ' + n + ' ຄົນ — ພິຈາລະນາຫຼຸດລົງ',
      n + ' administrators — consider reducing',
      'มีผู้ดูแลระบบ ' + n + ' คน — พิจารณาลดลง',
      '관리자 ' + n + '명 — 축소를 검토하세요'),
    failed_logins_high: bi(
      n + ' ຄັ້ງທີ່ເຂົ້າລະບົບບໍ່ສຳເລັດໃນ 24 ຊົ່ວໂມງ',
      n + ' failed sign-ins in the last 24 hours',
      n + ' ครั้งที่เข้าระบบไม่สำเร็จใน 24 ชั่วโมง',
      '지난 24시간 로그인 실패 ' + n + '회'),
    failed_logins_elevated: bi(
      n + ' ຄັ້ງທີ່ເຂົ້າລະບົບບໍ່ສຳເລັດໃນ 24 ຊົ່ວໂມງ',
      n + ' failed sign-ins in the last 24 hours',
      n + ' ครั้งที่เข้าระบบไม่สำเร็จใน 24 ชั่วโมง',
      '지난 24시간 로그인 실패 ' + n + '회'),
    accounts_locked: bi(
      n + ' ບັນຊີຖືກລັອກຢູ່ຕອນນີ້',
      n + ' account(s) are currently locked out',
      n + ' บัญชีถูกล็อกอยู่ตอนนี้',
      '현재 ' + n + '개 계정이 잠겨 있습니다'),
    pending_password_change: bi(
      n + ' ບັນຊີຍັງຕ້ອງປ່ຽນລະຫັດຜ່ານ',
      n + ' account(s) still owe a password change',
      n + ' บัญชียังต้องเปลี่ยนรหัสผ่าน',
      n + '개 계정이 비밀번호를 변경해야 합니다'),
    permission_denied_spike: bi(
      n + ' ຄັ້ງທີ່ຖືກປະຕິເສດສິດໃນ 24 ຊົ່ວໂມງ',
      n + ' permission denials in the last 24 hours',
      n + ' ครั้งที่ถูกปฏิเสธสิทธิ์ใน 24 ชั่วโมง',
      '지난 24시간 권한 거부 ' + n + '회'),
    no_backup: bi(
      'ຍັງບໍ່ມີໄຟລ໌ສຳຮອງເລີຍ',
      'No backup has ever been taken',
      'ยังไม่มีไฟล์สำรองเลย',
      '백업이 한 번도 없습니다'),
    backup_stale: bi(
      'ສຳຮອງຫຼ້າສຸດ ' + n + ' ວັນຜ່ານມາ',
      'Last backup was ' + n + ' days ago',
      'สำรองล่าสุด ' + n + ' วันที่แล้ว',
      '마지막 백업 ' + n + '일 전'),
    backup_ageing: bi(
      'ສຳຮອງຫຼ້າສຸດ ' + n + ' ວັນຜ່ານມາ',
      'Last backup was ' + n + ' days ago',
      'สำรองล่าสุด ' + n + ' วันที่แล้ว',
      '마지막 백업 ' + n + '일 전'),
    no_password_history: bi(
      'ບໍ່ໄດ້ເກັບປະຫວັດລະຫັດຜ່ານ — ຜູ້ໃຊ້ໃຊ້ລະຫັດເກົ່າຄືນໄດ້',
      'Password history is off — users may reuse an old password',
      'ไม่ได้เก็บประวัติรหัสผ่าน — ผู้ใช้ใช้รหัสเก่าซ้ำได้',
      '비밀번호 기록이 꺼져 있어 이전 비밀번호를 재사용할 수 있습니다'),
    password_min_length_low: bi(
      'ຄວາມຍາວລະຫັດຜ່ານຂັ້ນຕ່ຳຢູ່ທີ່ ' + n + ' ຕົວ',
      'Minimum password length is only ' + n + ' characters',
      'ความยาวรหัสผ่านขั้นต่ำอยู่ที่ ' + n + ' ตัว',
      '최소 비밀번호 길이가 ' + n + '자에 불과합니다'),
    // P4.6 — audit-trail integrity
    audit_chain_broken: bi(
      'ບັນທຶກກວດສອບຖືກແກ້ໄຂ — ຂາດຕອນທີ່ແຖວ ' + n + ' ແລະ ບໍ່ມີການອະທິບາຍ',
      'The audit trail has been altered — an unexplained break at row ' + n,
      'บันทึกตรวจสอบถูกแก้ไข — ขาดตอนที่แถว ' + n + ' และไม่มีคำอธิบาย',
      '감사 로그가 변경되었습니다 — ' + n + '행에서 설명되지 않은 불일치'),
    audit_chain_rebuilt: bi(
      'ຕ່ອງໂສ້ຖືກສ້າງໃໝ່ເມື່ອ ' + n + ' ວັນກ່ອນ — hash ທັງໝົດຖືກຂຽນຄືນ',
      'The chain was rebuilt ' + n + ' day(s) ago — every hash was rewritten',
      'เชนถูกสร้างใหม่เมื่อ ' + n + ' วันก่อน — hash ทั้งหมดถูกเขียนใหม่',
      '체인이 ' + n + '일 전 재구성됨 — 모든 해시가 다시 작성되었습니다'),
    audit_chain_unavailable: bi(
      'ບໍ່ສາມາດກວດສອບຄວາມຖືກຕ້ອງຂອງບັນທຶກໄດ້ — ຫາກຸນແຈບໍ່ພົບ',
      'Trail integrity cannot be checked — the chain key is unavailable',
      'ไม่สามารถตรวจสอบความถูกต้องของบันทึกได้ — ไม่พบกุญแจ',
      '감사 로그 무결성을 확인할 수 없습니다 — 체인 키를 사용할 수 없습니다'),
    audit_rows_unhashed: bi(
      n + ' ແຖວບໍ່ມີ hash (ບັນທຶກກ່ອນເປີດໃຊ້ຕ່ອງໂສ້)',
      n + ' row(s) carry no hash (written before chaining was enabled)',
      n + ' แถวไม่มี hash (บันทึกก่อนเปิดใช้เชน)',
      n + '개 행에 해시가 없습니다 (체인 활성화 이전 기록)'),
    backup_unverified: bi(
      'ໄຟລ໌ສຳຮອງຫຼ້າສຸດຍັງບໍ່ໄດ້ກວດສອບ',
      'The newest backup has not been verified',
      'ไฟล์สำรองล่าสุดยังไม่ได้ตรวจสอบ',
      '최신 백업이 검증되지 않았습니다'),
  };
  return map[f.key] || (f.key + (n ? ' (' + n + ')' : ''));
}

function acRiskLabel(level) {
  return {
    excellent: bi('ດີເລີດ', 'Excellent', 'ดีเยี่ยม', '매우 좋음'),
    good:      bi('ດີ', 'Good', 'ดี', '좋음'),
    warning:   bi('ຄວນລະວັງ', 'Warning', 'ควรระวัง', '주의'),
    critical:  bi('ວິກິດ', 'Critical', 'วิกฤต', '심각'),
    info:      bi('ຂໍ້ມູນ', 'Info', 'ข้อมูล', '정보'),
  }[level] || level;
}

async function renderSecurityOverview(force) {
  if (!acCan('audit.view')) { acFill('set-sec-overview-body', acError({ status: 403 })); return; }
  await acRender('set-sec-overview-body', async () => {
    if (force || !_acOverview) _acOverview = await DB.securityOverview();
    const o = _acOverview.overview, risk = _acOverview.risk;

    /* The headline. The score is a number an operator can watch move; the
     * findings under it say what would move it — a score with no explanation is
     * a number nobody can act on. */
    const head =
      '<div class="ac-risk ac-' + esc(risk.level) + '">' +
        '<div class="ac-risk-dial" role="img" aria-label="' +
          esc(bi('ຄະແນນ', 'Score', 'คะแนน', '점수') + ' ' + risk.score + '/100 · ' + acRiskLabel(risk.level)) + '">' +
          '<span class="ac-risk-score">' + risk.score + '</span><span class="ac-risk-max">/100</span>' +
        '</div>' +
        '<div class="ac-risk-text">' +
          '<div class="ac-risk-level">' + esc(acRiskLabel(risk.level)) + '</div>' +
          '<div class="ac-risk-sub">' + esc(bi(
            'ປະເມີນຈາກ MFA, ການເຂົ້າລະບົບລົ້ມເຫລວ, ສຳຮອງຂໍ້ມູນ ແລະ ນະໂຍບາຍລະຫັດຜ່ານ',
            'Assessed from MFA coverage, failed sign-ins, backups and password policy',
            'ประเมินจาก MFA การเข้าระบบล้มเหลว การสำรองข้อมูล และนโยบายรหัสผ่าน',
            'MFA 적용률, 로그인 실패, 백업, 비밀번호 정책 기준')) + '</div>' +
          '<div class="ac-risk-time">' + esc(bi('ຂໍ້ມູນເມື່ອ ', 'As of ', 'ข้อมูล ณ ', '기준 ') + acTime(_acOverview.generatedAt)) + '</div>' +
        '</div>' +
      '</div>';

    const cards = '<div class="ac-cards">' +
      acCard(bi('ຜູ້ໃຊ້ທີ່ເປີດ MFA', 'MFA enabled users', 'ผู้ใช้ที่เปิด MFA', 'MFA 사용 계정'),
             o.mfaUsers + ' / ' + o.users,
             o.mfaCoverage + '% ' + bi('ຂອງບັນຊີທັງໝົດ', 'of all accounts', 'ของบัญชีทั้งหมด', '전체 계정 중'),
             o.mfaCoverage >= 80 ? 'good' : o.mfaCoverage >= 50 ? 'warn' : 'bad') +
      acCard(bi('Passkey ທີ່ລົງທະບຽນ', 'Passkeys registered', 'Passkey ที่ลงทะเบียน', '등록된 패스키'),
             o.passkeys,
             o.passkeyUsers + ' ' + bi('ບັນຊີ', 'accounts', 'บัญชี', '계정')) +
      acCard(bi('ເຊດຊັນທີ່ໃຊ້ງານ', 'Active sessions', 'เซสชันที่ใช้งาน', '활성 세션'),
             o.sessions,
             o.sessionUsers + ' ' + bi('ບັນຊີກຳລັງເຂົ້າໃຊ້', 'accounts signed in', 'บัญชีกำลังเข้าใช้', '계정 로그인 중')) +
      acCard(bi('ເຂົ້າລະບົບລົ້ມເຫລວ (24 ຊມ)', 'Failed sign-ins (24h)', 'เข้าระบบล้มเหลว (24 ชม.)', '로그인 실패 (24시간)'),
             o.failedLogins24h,
             o.failedLogins7d + ' ' + bi('ໃນ 7 ວັນ', 'in 7 days', 'ใน 7 วัน', '7일간'),
             o.failedLogins24h > 50 ? 'bad' : o.failedLogins24h > 15 ? 'warn' : 'good') +
      acCard(bi('ບັນຊີທີ່ຖືກລັອກ', 'Locked accounts', 'บัญชีที่ถูกล็อก', '잠긴 계정'),
             o.lockedAccounts,
             bi('ຈາກການພະຍາຍາມຫຼາຍເກີນ', 'by the sign-in throttle', 'จากการพยายามมากเกินไป', '로그인 제한에 의해'),
             o.lockedAccounts > 0 ? 'warn' : 'good') +
      acCard(bi('ອຸປະກອນທີ່ເຊື່ອຖື', 'Trusted devices', 'อุปกรณ์ที่เชื่อถือ', '신뢰 기기'),
             o.trustedDevices,
             bi('ຂ້າມ MFA ໄດ້ 30 ວັນ', 'may skip MFA for 30 days', 'ข้าม MFA ได้ 30 วัน', '30일간 MFA 생략')) +
    '</div>';

    const findings = risk.findings.length
      ? '<div class="ac-findings">' + risk.findings.map(f =>
          '<div class="ac-finding ac-' + esc(f.level) + '">' +
            acPill(f.level, acRiskLabel(f.level)) +
            '<span class="ac-finding-text">' + esc(acFindingText(f)) + '</span>' +
          '</div>').join('') + '</div>'
      : '<div class="ac-findings"><div class="ac-finding ac-excellent">' +
        acPill('excellent', acRiskLabel('excellent')) +
        '<span class="ac-finding-text">' + esc(bi(
          'ບໍ່ພົບບັນຫາ', 'No issues found', 'ไม่พบปัญหา', '발견된 문제 없음')) + '</span></div></div>';

    /* The one list of names on this screen, and it earns its place: these are
     * accounts that must hold a second factor and do not. Everything else here
     * is a count. */
    const gap = (o.unenrolledPrivileged || []).length
      ? '<div class="set-card-label">' +
          esc(bi('ຕ້ອງລົງທະບຽນ MFA', 'Awaiting MFA enrolment', 'รอลงทะเบียน MFA', 'MFA 등록 대기')) + '</div>' +
        '<div class="set-card ac-card"><div class="ac-chiplist">' +
          o.unenrolledPrivileged.map(u => '<span class="ac-chip ac-chip-warn">' + esc(u) + '</span>').join('') +
        '</div></div>'
      : '';

    /* ── Trail integrity (P4.6) ──
     * Its own block, above the ordinary detail rows, because it is the only
     * thing on this page that says whether the page can be believed: if the
     * audit trail has been altered, every other figure here is suspect. */
    const ig = o.integrity || {};
    const igLevel = ig.available === false ? 'warning' : (ig.ok ? 'excellent' : 'critical');
    const igHeadline = ig.available === false
      ? bi('ບໍ່ສາມາດກວດສອບໄດ້', 'Cannot be verified', 'ไม่สามารถตรวจสอบได้', '확인 불가')
      : ig.ok
        ? bi('ບໍ່ຖືກແກ້ໄຂ', 'Unaltered', 'ไม่ถูกแก้ไข', '변경 없음')
        : bi('ຖືກແກ້ໄຂ', 'ALTERED', 'ถูกแก้ไข', '변경됨');

    const integrity = '<div class="set-card-label">' +
        esc(bi('ຄວາມຖືກຕ້ອງຂອງບັນທຶກກວດສອບ', 'Audit trail integrity',
               'ความถูกต้องของบันทึกตรวจสอบ', '감사 로그 무결성')) + '</div>' +
      '<div class="ac-cards">' +
        acCard(bi('ສະຖານະຕ່ອງໂສ້', 'Chain status', 'สถานะเชน', '체인 상태'),
               igHeadline,
               ig.available === false ? '' :
                 (ig.verified || 0) + ' / ' + (ig.rows || 0) + ' ' +
                 bi('ແຖວຢືນຢັນແລ້ວ', 'rows verified', 'แถวยืนยันแล้ว', '행 검증됨'),
               igLevel === 'excellent' ? 'good' : igLevel === 'critical' ? 'bad' : 'warn') +
        (ig.brokenAtId != null
          ? acCard(bi('ຂາດຕອນທີ່ແຖວ', 'Break at row', 'ขาดตอนที่แถว', '불일치 행'),
                   ig.brokenAtId,
                   bi('ບໍ່ມີການອະທິບາຍທີ່ຖືກຕ້ອງ', 'no legitimate cause', 'ไม่มีสาเหตุที่ถูกต้อง', '정당한 원인 없음'),
                   'bad')
          : '') +
        (ig.baselineThrough != null
          ? acCard(bi('ເສັ້ນຖານ', 'Baseline', 'เส้นฐาน', '기준선'),
                   '≤ ' + ig.baselineThrough,
                   bi('hash ຍ້ອນຫຼັງ — ບໍ່ຢືນຢັນເນື້ອຫາກ່ອນນັ້ນ',
                      'hashed retroactively — content before this is not attested',
                      'hash ย้อนหลัง — ไม่ยืนยันเนื้อหาก่อนนั้น',
                      '소급 해시 — 이전 내용은 보증되지 않음'), 'warn')
          : '') +
        (ig.keyFingerprint
          ? acCard(bi('ກຸນແຈ', 'Signing key', 'กุญแจ', '서명 키'), ig.keyFingerprint.slice(0, 8),
                   bi('ເກັບໄວ້ນອກຖານຂໍ້ມູນ', 'held outside the database', 'เก็บไว้นอกฐานข้อมูล', '데이터베이스 외부 보관'))
          : '') +
      '</div>';

    const more = '<div class="set-card-label">' +
        esc(bi('ລາຍລະອຽດເພີ່ມເຕີມ', 'Further detail', 'รายละเอียดเพิ่มเติม', '추가 정보')) + '</div>' +
      '<div class="set-card ac-card">' +
      acRow(bi('ລະຫັດຜ່ານທີ່ຕ້ອງປ່ຽນ', 'Password changes owed', 'รหัสผ่านที่ต้องเปลี่ยน', '변경 대기 비밀번호'), o.mustChangePassword) +
      acRow(bi('ຖືກປະຕິເສດສິດ (24 ຊມ)', 'Permission denials (24h)', 'ถูกปฏิเสธสิทธิ์ (24 ชม.)', '권한 거부 (24시간)'), o.permissionDenied24h) +
      acRow(bi('ຖືກຈຳກັດອັດຕາ (24 ຊມ)', 'Throttled attempts (24h)', 'ถูกจำกัดอัตรา (24 ชม.)', '제한된 시도 (24시간)'), o.throttled24h) +
      acRow(bi('ລະຫັດກູ້ຄືນທີ່ຍັງໃຊ້ໄດ້', 'Unused recovery codes', 'รหัสกู้คืนที่ยังใช้ได้', '미사용 복구 코드'), o.recoveryCodesRemaining) +
      acRow(bi('ສຳຮອງຫຼ້າສຸດ', 'Last backup', 'สำรองล่าสุด', '마지막 백업'),
            o.lastBackupAgeDays == null ? AC_L.none()
              : o.lastBackupAgeDays + ' ' + bi('ວັນຜ່ານມາ', 'day(s) ago', 'วันที่แล้ว', '일 전')) +
    '</div>';

    return head + cards + findings + gap + integrity + more;
  });
}

/* ══════════════════════════════════════════════════════════════════
 * TASK 3 — MFA Policy
 * ══════════════════════════════════════════════════════════════════ */

let _acMfa = null, _acPolicies = null;

/** Fetch the policy bundle once per Settings session. */
async function acPolicies(force) {
  if (force || !_acPolicies) _acPolicies = await DB.getPolicies();
  return _acPolicies;
}

async function renderMfaPolicy(force) {
  if (!acCan('mfa.enforce')) { acFill('set-sec-mfa-body', acError({ status: 403 })); return; }
  await acRender('set-sec-mfa-body', async () => {
    if (force || !_acMfa) _acMfa = await DB.mfaOverview();
    const pol = await acPolicies(force);
    const canEdit = acCan('security.manage');

    /* Per-role switches. A role the catalogue marks 'required' renders LOCKED
     * rather than as a switch that silently refuses — the server will not relax
     * it, so offering the control would be a lie. */
    const locked = new Set(pol.mfaLocked || []);
    const roleRows = Object.keys(pol.mfa).filter(k => k !== 'data_entry' && k !== 'viewer').map(key => {
      const required = pol.mfa[key] === 'required';
      const isLocked = locked.has(key);
      const id = 'mfa-sw-' + key;
      return '<div class="set-row">' +
        '<div class="set-row-main">' +
          '<div class="set-row-label">' + esc(acRoleName(key)) + '</div>' +
          '<div class="set-row-desc">' + esc(isLocked
            ? bi('ບັງຄັບຕາມນະໂຍບາຍລະບົບ — ປິດບໍ່ໄດ້',
                 'Required by system policy — cannot be switched off',
                 'บังคับตามนโยบายระบบ — ปิดไม่ได้',
                 '시스템 정책상 필수 — 해제할 수 없습니다')
            : bi('ເລືອກໄດ້ວ່າຈະບັງຄັບ ຫຼື ບໍ່',
                 'Optional — you may require it',
                 'เลือกได้ว่าจะบังคับหรือไม่',
                 '선택 사항 — 필수로 설정 가능')) + '</div>' +
        '</div>' +
        '<div class="set-row-control">' +
          '<label class="ac-switch' + (isLocked || !canEdit ? ' ac-switch-locked' : '') + '" for="' + id + '">' +
            '<input type="checkbox" id="' + id + '"' +
              (required ? ' checked' : '') +
              (isLocked || !canEdit ? ' disabled' : '') +
              ' onchange="acSetRoleMfa(\'' + esc(key) + '\', this.checked)"' +
              ' aria-label="' + esc(acRoleName(key) + ' — ' + bi('ບັງຄັບ MFA', 'Require MFA', 'บังคับ MFA', 'MFA 필수')) + '">' +
            '<span class="ac-switch-track" aria-hidden="true"><span class="ac-switch-thumb"></span></span>' +
            '<span class="ac-switch-text">' + esc(required
              ? bi('ບັງຄັບ', 'Required', 'บังคับ', '필수')
              : bi('ບໍ່ບັງຄັບ', 'Optional', 'ไม่บังคับ', '선택')) + '</span>' +
          '</label>' +
        '</div>' +
      '</div>';
    }).join('');

    const enrolled = _acMfa.enrolled || [], unenrolled = _acMfa.unenrolled || [];
    const total = enrolled.length + unenrolled.length;

    const cards = '<div class="ac-cards">' +
      acCard(bi('ລົງທະບຽນແລ້ວ', 'Enrolled', 'ลงทะเบียนแล้ว', '등록 완료'), enrolled.length,
             total ? Math.round((enrolled.length / total) * 100) + '%' : '—', 'good') +
      acCard(bi('ຍັງບໍ່ລົງທະບຽນ', 'Not enrolled', 'ยังไม่ลงทะเบียน', '미등록'), unenrolled.length,
             bi('ໃຊ້ລະຫັດຜ່ານຢ່າງດຽວ', 'password only', 'ใช้รหัสผ่านอย่างเดียว', '비밀번호만 사용'),
             unenrolled.length ? 'warn' : 'good') +
      acCard(bi('ຖືກບັງຄັບແບບລາຍບຸກຄົນ', 'Forced individually', 'บังคับรายบุคคล', '개별 강제'),
             enrolled.concat(unenrolled).filter(u => u.mfaForced).length,
             bi('ນອກເໜືອຈາກນະໂຍບາຍບົດບາດ', 'beyond their role policy', 'นอกเหนือจากนโยบายบทบาท', '역할 정책 외')) +
    '</div>';

    const userRow = (u) => '<tr>' +
      '<td><div class="ac-user"><span class="ac-user-name">' + esc(u.name) + '</span>' +
        '<span class="ac-user-at">@' + esc(u.username) + '</span></div></td>' +
      '<td>' + esc(acRoleName(u.role, u.roleName)) + '</td>' +
      '<td>' + (u.totpEnabled ? acPill('good', 'TOTP') : '') +
               (u.passkeyCount ? ' ' + acPill('good', bi('Passkey ×', 'Passkey ×', 'Passkey ×', '패스키 ×') + u.passkeyCount) : '') +
               (!u.hasFactor ? acPill('warning', bi('ບໍ່ມີ', 'None', 'ไม่มี', '없음')) : '') + '</td>' +
      '<td>' + (u.mfaRequired
                  ? acPill(u.mfaForced ? 'info' : 'good', u.mfaForced
                      ? bi('ບັງຄັບ (ບັນຊີ)', 'Forced (account)', 'บังคับ (บัญชี)', '강제 (계정)')
                      : bi('ບັງຄັບ (ບົດບາດ)', 'Required (role)', 'บังคับ (บทบาท)', '필수 (역할)'))
                  : acPill('info', bi('ບໍ່ບັງຄັບ', 'Optional', 'ไม่บังคับ', '선택'))) + '</td>' +
      '<td class="ac-num">' + (u.trustedDevices || 0) + '</td>' +
      '<td class="ac-actions">' +
        (!u.mfaRequired
          ? '<button class="btn btn-sm" onclick="acForceMfa(\'' + esc(u.username) + '\', true)">' +
              esc(bi('ບັງຄັບລົງທະບຽນ', 'Force enrolment', 'บังคับลงทะเบียน', '등록 강제')) + '</button>'
          : (u.mfaForced
              ? '<button class="btn btn-sm btn-ghost" onclick="acForceMfa(\'' + esc(u.username) + '\', false)">' +
                  esc(bi('ຍົກເລີກການບັງຄັບ', 'Release', 'ยกเลิกการบังคับ', '해제')) + '</button>'
              : '')) +
        (u.hasFactor
          ? ' <button class="btn btn-sm btn-danger" onclick="acResetMfa(\'' + esc(u.username) + '\')">' +
              esc(bi('ຣີເຊັດ MFA', 'Reset MFA', 'รีเซ็ต MFA', 'MFA 초기화')) + '</button>'
          : '') +
        (u.trustedDevices
          ? ' <button class="btn btn-sm btn-ghost" onclick="acRevokeTrustedFor(\'' + esc(u.username) + '\')">' +
              esc(bi('ລ້າງອຸປະກອນ', 'Clear devices', 'ล้างอุปกรณ์', '기기 해제')) + '</button>'
          : '') +
      '</td>' +
    '</tr>';

    const headers = [AC_L.user(), AC_L.role(),
      bi('ປັດໄຈ', 'Factors', 'ปัจจัย', '인증 수단'),
      bi('ນະໂຍບາຍ', 'Policy', 'นโยบาย', '정책'),
      bi('ອຸປະກອນ', 'Devices', 'อุปกรณ์', '기기'), AC_L.actions()];

    const table = (title, list) => '<div class="set-card-label">' + esc(title) + ' (' + list.length + ')</div>' +
      (list.length
        ? '<div class="set-card ac-card">' + acTable(title, headers, list.map(userRow).join('')) + '</div>'
        : '<div class="set-card ac-card">' + acEmpty(AC_L.none()) + '</div>');

    return '<div class="set-card-label">' +
        esc(bi('ບັງຄັບຕາມບົດບາດ', 'Requirement by role', 'บังคับตามบทบาท', '역할별 요구 사항')) + '</div>' +
      (canEdit ? '' : '<div class="ac-note">' + esc(AC_L.readOnly()) + '</div>') +
      '<div class="set-card">' + roleRows + '</div>' +
      cards +
      table(bi('ຍັງບໍ່ລົງທະບຽນ', 'Not enrolled', 'ยังไม่ลงทะเบียน', '미등록'), unenrolled) +
      table(bi('ລົງທະບຽນແລ້ວ', 'Enrolled', 'ลงทะเบียนแล้ว', '등록 완료'), enrolled);
  });
}

/** Flip a role's MFA requirement. Reverts the switch if the server refuses. */
async function acSetRoleMfa(roleKey, required) {
  try {
    _acPolicies = await DB.setMfaPolicy({ [roleKey]: required ? 'required' : 'optional' });
    toast(AC_L.saved(), 'ok');
  } catch (e) {
    toast(bi('ບັນທຶກບໍ່ສຳເລັດ', 'Could not save', 'บันทึกไม่สำเร็จ', '저장하지 못했습니다'), 'warn');
    _acPolicies = null;
  }
  renderMfaPolicy(true);
}

/**
 * Force enrolment on one account.
 *
 * Confirmed rather than immediate, because the server revokes that account's
 * sessions to make the requirement take effect now — the person is signed out
 * mid-task, and the operator should know that before clicking.
 */
function acForceMfa(username, required) {
  const title = required
    ? bi('ບັງຄັບລົງທະບຽນ MFA', 'Force MFA enrolment', 'บังคับลงทะเบียน MFA', 'MFA 등록 강제')
    : bi('ຍົກເລີກການບັງຄັບ', 'Release enforcement', 'ยกเลิกการบังคับ', '강제 해제');
  const msg = required
    ? bi('@' + username + ' ຈະຖືກອອກຈາກລະບົບ ແລະ ຕ້ອງລົງທະບຽນປັດໄຈທີສອງກ່ອນເຂົ້າໃຊ້ຄືນ',
         '@' + username + ' will be signed out and must enrol a second factor before using the app again.',
         '@' + username + ' จะถูกออกจากระบบ และต้องลงทะเบียนปัจจัยที่สองก่อนเข้าใช้อีกครั้ง',
         '@' + username + ' 계정은 로그아웃되며 다시 사용하려면 2단계 인증을 등록해야 합니다.')
    : bi('ຍົກເລີກການບັງຄັບລະດັບບັນຊີສຳລັບ @' + username + ' — ນະໂຍບາຍຂອງບົດບາດຍັງມີຜົນຢູ່',
         'Clear the account-level requirement for @' + username + '. Their role policy still applies.',
         'ยกเลิกการบังคับระดับบัญชีสำหรับ @' + username + ' — นโยบายของบทบาทยังมีผลอยู่',
         '@' + username + ' 계정 수준 요구를 해제합니다. 역할 정책은 그대로 적용됩니다.');
  showConfirm(title, msg, async () => {
    try {
      await DB.forceMfa(username, required);
      toast(AC_L.saved(), 'ok');
      renderMfaPolicy(true);
      _acOverview = null;
    } catch (e) {
      toast(bi('ບໍ່ສຳເລັດ', 'Failed', 'ไม่สำเร็จ', '실패'), 'warn');
    }
  });
}

/** Clear every factor an account holds — the "lost phone" recovery path. */
function acResetMfa(username) {
  showConfirm(
    bi('ຣີເຊັດ MFA', 'Reset MFA', 'รีเซ็ต MFA', 'MFA 초기화'),
    bi('ລຶບ TOTP, passkey, ລະຫັດກູ້ຄືນ ແລະ ອຸປະກອນທີ່ເຊື່ອຖືທັງໝົດຂອງ @' + username + ' ແລ້ວອອກຈາກລະບົບທຸກເຄື່ອງ. ຜູ້ໃຊ້ຕ້ອງລົງທະບຽນໃໝ່.',
       'Removes TOTP, passkeys, recovery codes and trusted devices for @' + username + ', and signs them out everywhere. They must enrol again.',
       'ลบ TOTP, passkey, รหัสกู้คืน และอุปกรณ์ที่เชื่อถือทั้งหมดของ @' + username + ' แล้วออกจากระบบทุกเครื่อง ผู้ใช้ต้องลงทะเบียนใหม่',
       '@' + username + ' 계정의 TOTP·패스키·복구 코드·신뢰 기기를 모두 삭제하고 전체 로그아웃합니다. 다시 등록해야 합니다.'),
    async () => {
      try {
        await DB.resetUserMfa(username);
        toast(bi('ຣີເຊັດແລ້ວ', 'Reset', 'รีเซ็ตแล้ว', '초기화됨'), 'ok');
        renderMfaPolicy(true);
        _acOverview = null;
      } catch (e) {
        const err = e && e.body && e.body.error;
        toast(err === 'cannot-reset-self'
          ? bi('ຣີເຊັດບັນຊີຕົນເອງຈາກໜ້ານີ້ບໍ່ໄດ້', 'You cannot reset your own account here', 'รีเซ็ตบัญชีตัวเองจากหน้านี้ไม่ได้', '여기서 본인 계정은 초기화할 수 없습니다')
          : bi('ບໍ່ສຳເລັດ', 'Failed', 'ไม่สำเร็จ', '실패'), 'warn');
      }
    });
}

function acRevokeTrustedFor(username) {
  showConfirm(
    bi('ລ້າງອຸປະກອນທີ່ເຊື່ອຖື', 'Clear trusted devices', 'ล้างอุปกรณ์ที่เชื่อถือ', '신뢰 기기 해제'),
    bi('@' + username + ' ຈະຕ້ອງໃສ່ລະຫັດ MFA ຄືນໃນທຸກອຸປະກອນ',
       '@' + username + ' will have to complete MFA again on every device.',
       '@' + username + ' จะต้องใส่รหัส MFA ใหม่ในทุกอุปกรณ์',
       '@' + username + ' 계정은 모든 기기에서 MFA를 다시 완료해야 합니다.'),
    async () => {
      try {
        const r = await DB.revokeUserTrusted(username);
        toast(bi('ຖອນແລ້ວ ', 'Revoked ', 'ถอนแล้ว ', '해지됨 ') + (r.revoked || 0), 'ok');
        renderMfaPolicy(true);
      } catch (e) { toast(bi('ບໍ່ສຳເລັດ', 'Failed', 'ไม่สำเร็จ', '실패'), 'warn'); }
    });
}

/* ══════════════════════════════════════════════════════════════════
 * TASK 2 — Password Policy
 * ══════════════════════════════════════════════════════════════════ */

/** A number field with its allowed range shown and enforced by the input. */
function acNumField(id, label, desc, value, bound, suffix, disabled) {
  return '<div class="set-row" data-kw="' + esc(label) + '">' +
    '<div class="set-row-main">' +
      '<label class="set-row-label" for="' + id + '">' + esc(label) + '</label>' +
      '<div class="set-row-desc">' + esc(desc) + '</div>' +
    '</div>' +
    '<div class="set-row-control ac-num-control">' +
      '<input class="set-num-input" type="number" id="' + id + '" value="' + esc(String(value)) + '"' +
        ' min="' + bound.min + '" max="' + bound.max + '"' + (disabled ? ' disabled' : '') +
        ' aria-describedby="' + id + '-range">' +
      (suffix ? '<span class="set-row-desc">' + esc(suffix) + '</span>' : '') +
      '<span class="ac-range" id="' + id + '-range">' + bound.min + '–' + bound.max + '</span>' +
    '</div>' +
  '</div>';
}

/** An on/off rule. */
function acToggleField(id, label, desc, checked, disabled) {
  return '<div class="set-row" data-kw="' + esc(label) + '">' +
    '<div class="set-row-main">' +
      '<div class="set-row-label">' + esc(label) + '</div>' +
      '<div class="set-row-desc">' + esc(desc) + '</div>' +
    '</div>' +
    '<div class="set-row-control">' +
      '<label class="ac-switch' + (disabled ? ' ac-switch-locked' : '') + '" for="' + id + '">' +
        '<input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + (disabled ? ' disabled' : '') +
          ' aria-label="' + esc(label) + '">' +
        '<span class="ac-switch-track" aria-hidden="true"><span class="ac-switch-thumb"></span></span>' +
      '</label>' +
    '</div>' +
  '</div>';
}

async function renderPasswordPolicy(force) {
  await acRender('set-sec-password-body', async () => {
    const pol = await acPolicies(force);
    const p = pol.password, b = pol.bounds, canEdit = acCan('security.manage');

    const rules = '<div class="set-card">' +
      acNumField('pp-min', bi('ຄວາມຍາວຂັ້ນຕ່ຳ', 'Minimum length', 'ความยาวขั้นต่ำ', '최소 길이'),
        bi('ຈຳນວນຕົວອັກສອນທີ່ໜ້ອຍທີ່ສຸດ', 'Fewest characters accepted', 'จำนวนตัวอักษรน้อยที่สุด', '허용되는 최소 문자 수'),
        p.minLength, b.minLength, bi('ຕົວ', 'chars', 'ตัว', '자'), !canEdit) +
      acToggleField('pp-upper', bi('ຕ້ອງມີໂຕພິມໃຫຍ່', 'Uppercase required', 'ต้องมีตัวพิมพ์ใหญ่', '대문자 필수'),
        'A–Z', p.requireUpper, !canEdit) +
      acToggleField('pp-lower', bi('ຕ້ອງມີໂຕພິມນ້ອຍ', 'Lowercase required', 'ต้องมีตัวพิมพ์เล็ก', '소문자 필수'),
        'a–z', p.requireLower, !canEdit) +
      acToggleField('pp-digit', bi('ຕ້ອງມີຕົວເລກ', 'Numbers required', 'ต้องมีตัวเลข', '숫자 필수'),
        '0–9', p.requireDigit, !canEdit) +
      acToggleField('pp-special', bi('ຕ້ອງມີອັກຂະລະພິເສດ', 'Special characters required', 'ต้องมีอักขระพิเศษ', '특수문자 필수'),
        '! @ # $ % ^ & *', p.requireSpecial, !canEdit) +
      acNumField('pp-age', bi('ອາຍຸລະຫັດຜ່ານ', 'Password expiration', 'อายุรหัสผ่าน', '비밀번호 만료'),
        bi('0 = ບໍ່ໝົດອາຍຸ. ກວດຕອນເຂົ້າສູ່ລະບົບ', '0 = never expires. Checked at sign-in.', '0 = ไม่หมดอายุ ตรวจตอนเข้าสู่ระบบ', '0 = 만료 없음. 로그인 시 확인.'),
        p.maxAgeDays, b.maxAgeDays, bi('ວັນ', 'days', 'วัน', '일'), !canEdit) +
      acNumField('pp-history', bi('ປະຫວັດລະຫັດຜ່ານ', 'Password history', 'ประวัติรหัสผ่าน', '비밀번호 기록'),
        bi('ຫ້າມໃຊ້ຊ້ຳ N ລະຫັດຫຼ້າສຸດ. 0 = ອະນຸຍາດໃຫ້ໃຊ້ຊ້ຳ', 'Blocks reuse of the last N passwords. 0 = reuse allowed.', 'ห้ามใช้ซ้ำ N รหัสล่าสุด 0 = อนุญาตให้ใช้ซ้ำ', '최근 N개 재사용 차단. 0 = 재사용 허용.'),
        p.historyDepth, b.historyDepth, bi('ລະຫັດ', 'passwords', 'รหัส', '개'), !canEdit) +
      acToggleField('pp-repeats', bi('ຫ້າມຕົວອັກສອນຊ້ຳ 4 ຕົວຂຶ້ນໄປ', 'Block 4+ repeated characters', 'ห้ามตัวอักษรซ้ำ 4 ตัวขึ้นไป', '동일 문자 4회 이상 금지'),
        'aaaa', p.blockRepeats, !canEdit) +
      acToggleField('pp-username', bi('ຫ້າມມີຊື່ຜູ້ໃຊ້ຢູ່ໃນລະຫັດ', 'Block passwords containing the username', 'ห้ามมีชื่อผู้ใช้อยู่ในรหัส', '사용자 이름 포함 금지'),
        bi('ເດົາໄດ້ງ່າຍຈາກລາຍຊື່ບັນຊີ', 'Trivially guessable from an account list', 'เดาได้ง่ายจากรายชื่อบัญชี', '계정 목록에서 쉽게 추측 가능'),
        p.blockUsername, !canEdit) +
    '</div>';

    /* blockCommon is shown but never switchable — policy.js forces it on. A
     * control that cannot be turned off is displayed as a fact, not a switch. */
    const fixed = '<div class="set-card-label">' +
        esc(bi('ບັງຄັບສະເໝີ', 'Always enforced', 'บังคับเสมอ', '항상 적용')) + '</div>' +
      '<div class="set-card ac-card">' +
      acRow(bi('ບັນຊີດຳລະຫັດຜ່ານທົ່ວໄປ', 'Common-password blocklist', 'บัญชีดำรหัสผ่านทั่วไป', '흔한 비밀번호 차단'),
            bi('ເປີດ', 'On', 'เปิด', '켜짐')) +
      acRow(bi('ຫ້າມມີຊື່ແອັບໃນລະຫັດ', 'Application name blocked', 'ห้ามมีชื่อแอปในรหัส', '앱 이름 포함 금지'),
            bi('ເປີດ', 'On', 'เปิด', '켜짐')) +
      acRow(bi('ການເຂົ້າລະຫັດ', 'Hashing', 'การเข้ารหัส', '해싱'), 'scrypt N=32768 r=8 p=1', true) +
      acRow(bi('ຄວາມຍາວສູງສຸດ', 'Maximum length', 'ความยาวสูงสุด', '최대 길이'), p.maxLength) +
    '</div>';

    const actions = canEdit
      ? '<div class="ac-actions-bar">' +
          '<button class="btn btn-primary" onclick="acSavePasswordPolicy(this)">' + esc(AC_L.save()) + '</button>' +
          '<button class="btn btn-ghost" onclick="renderPasswordPolicy(true)">' + esc(AC_L.cancel()) + '</button>' +
          '<span class="ac-note-inline">' + esc(bi(
            'ມີຜົນກັບການປ່ຽນລະຫັດຄັ້ງຕໍ່ໄປ ບໍ່ແມ່ນລະຫັດທີ່ມີຢູ່ແລ້ວ',
            'Applies to the next password change — existing passwords are not invalidated',
            'มีผลกับการเปลี่ยนรหัสครั้งถัดไป ไม่ใช่รหัสที่มีอยู่แล้ว',
            '다음 비밀번호 변경부터 적용 — 기존 비밀번호는 무효화되지 않습니다')) + '</span>' +
        '</div>'
      : '<div class="ac-note">' + esc(AC_L.readOnly()) + '</div>';

    return (canEdit ? '' : '<div class="ac-note">' + esc(AC_L.readOnly()) + '</div>') +
      '<div class="set-card-label">' + esc(bi('ກົດລະບຽບ', 'Rules', 'กฎเกณฑ์', '규칙')) + '</div>' +
      rules + actions + fixed;
  });
}

async function acSavePasswordPolicy(btn) {
  const v = (id) => document.getElementById(id);
  const patch = {
    minLength:      parseInt(v('pp-min').value, 10),
    maxAgeDays:     parseInt(v('pp-age').value, 10),
    historyDepth:   parseInt(v('pp-history').value, 10),
    requireUpper:   v('pp-upper').checked,
    requireLower:   v('pp-lower').checked,
    requireDigit:   v('pp-digit').checked,
    requireSpecial: v('pp-special').checked,
    blockRepeats:   v('pp-repeats').checked,
    blockUsername:  v('pp-username').checked,
  };
  if (btn) btn.disabled = true;
  try {
    _acPolicies = await DB.setPasswordPolicy(patch);
    /* Re-render from the SERVER's answer, not from what was typed. The clamps
     * live server-side, so a value that was adjusted on the way in has to be
     * visible — otherwise the screen shows a setting that is not in force. */
    const applied = _acPolicies.password;
    const changed = Object.keys(patch).some(k => applied[k] !== patch[k]);
    toast(changed
      ? bi('ບັນທຶກແລ້ວ — ບາງຄ່າຖືກປັບໃຫ້ຢູ່ໃນຂອບເຂດ',
           'Saved — some values were clamped to the allowed range',
           'บันทึกแล้ว — บางค่าถูกปรับให้อยู่ในช่วงที่อนุญาต',
           '저장됨 — 일부 값이 허용 범위로 조정되었습니다')
      : AC_L.saved(), 'ok');
    _acOverview = null;
  } catch (e) {
    toast(bi('ບັນທຶກບໍ່ສຳເລັດ', 'Could not save', 'บันทึกไม่สำเร็จ', '저장하지 못했습니다'), 'warn');
  }
  if (btn) btn.disabled = false;
  renderPasswordPolicy(false);
}

/* ══════════════════════════════════════════════════════════════════
 * Session Policy
 * ══════════════════════════════════════════════════════════════════ */

async function renderSessionPolicy(force) {
  await acRender('set-sec-session-body', async () => {
    const pol = await acPolicies(force);
    const s = pol.session, b = pol.bounds, canEdit = acCan('security.manage');
    const roles = Object.keys(s.idleMinutes).filter(k => k !== 'data_entry' && k !== 'viewer');

    const perRole = acTable(
      bi('ນະໂຍບາຍຕໍ່ບົດບາດ', 'Policy per role', 'นโยบายต่อบทบาท', '역할별 정책'),
      [AC_L.role(),
       bi('ໝົດເວລາເມື່ອບໍ່ໄດ້ໃຊ້', 'Idle timeout', 'หมดเวลาเมื่อไม่ได้ใช้', '유휴 시간 초과'),
       bi('ອຸປະກອນພ້ອມກັນ', 'Concurrent devices', 'อุปกรณ์พร้อมกัน', '동시 기기')],
      roles.map(r =>
        '<tr><th scope="row">' + esc(acRoleName(r)) + '</th>' +
        '<td><input class="set-num-input" type="number" id="sp-idle-' + esc(r) + '"' +
          ' value="' + s.idleMinutes[r] + '" min="' + b.idleMinutes.min + '" max="' + b.idleMinutes.max + '"' +
          (canEdit ? '' : ' disabled') +
          ' aria-label="' + esc(acRoleName(r) + ' ' + bi('ນາທີ', 'minutes', 'นาที', '분')) + '">' +
          '<span class="ac-unit">' + esc(bi('ນາທີ', 'min', 'นาที', '분')) + '</span></td>' +
        '<td><input class="set-num-input" type="number" id="sp-dev-' + esc(r) + '"' +
          ' value="' + s.maxDevices[r] + '" min="' + b.maxDevices.min + '" max="' + b.maxDevices.max + '"' +
          (canEdit ? '' : ' disabled') +
          ' aria-label="' + esc(acRoleName(r) + ' ' + bi('ອຸປະກອນ', 'devices', 'อุปกรณ์', '기기')) + '">' +
        '</td></tr>').join(''));

    const global = '<div class="set-card">' +
      acNumField('sp-session', bi('ອາຍຸເຊດຊັນປົກກະຕິ', 'Standard session', 'อายุเซสชันปกติ', '기본 세션'),
        bi('ຫຼັງເຂົ້າສູ່ລະບົບແບບປົກກະຕິ', 'After an ordinary sign-in', 'หลังเข้าสู่ระบบแบบปกติ', '일반 로그인 후'),
        s.sessionHours, b.sessionHours, bi('ຊົ່ວໂມງ', 'hours', 'ชั่วโมง', '시간'), !canEdit) +
      acNumField('sp-remember', bi('“ຈື່ຂ້ອຍໄວ້”', '"Keep me logged in"', '“จดจำฉันไว้”', '"로그인 유지"'),
        bi('ເມື່ອຕິກກ່ອງນີ້ຕອນເຂົ້າສູ່ລະບົບ', 'When the box is ticked at sign-in', 'เมื่อติ๊กกล่องนี้ตอนเข้าสู่ระบบ', '로그인 시 체크한 경우'),
        s.rememberDays, b.rememberDays, bi('ວັນ', 'days', 'วัน', '일'), !canEdit) +
      acNumField('sp-absolute', bi('ເພດານສູງສຸດ', 'Absolute ceiling', 'เพดานสูงสุด', '절대 상한'),
        bi('ເຊດຊັນຈົບແນ່ນອນເມື່ອຮອດອາຍຸນີ້ ບໍ່ວ່າຈະໃຊ້ງານຢູ່ຫຼືບໍ່', 'A session ends at this age no matter how active it is', 'เซสชันจบแน่นอนเมื่อถึงอายุนี้ ไม่ว่าจะใช้งานอยู่หรือไม่', '활동 여부와 무관하게 이 기간이 지나면 세션 종료'),
        s.absoluteDays, b.absoluteDays, bi('ວັນ', 'days', 'วัน', '일'), !canEdit) +
    '</div>';

    return (canEdit ? '' : '<div class="ac-note">' + esc(AC_L.readOnly()) + '</div>') +
      '<div class="set-card-label">' + esc(bi('ຕໍ່ບົດບາດ', 'Per role', 'ต่อบทบาท', '역할별')) + '</div>' +
      '<div class="set-card ac-card">' + perRole + '</div>' +
      '<div class="set-card-label">' + esc(bi('ທົ່ວທັງລະບົບ', 'System-wide', 'ทั้งระบบ', '시스템 전체')) + '</div>' +
      global +
      (canEdit
        ? '<div class="ac-actions-bar">' +
            '<button class="btn btn-primary" onclick="acSaveSessionPolicy(this)">' + esc(AC_L.save()) + '</button>' +
            '<button class="btn btn-ghost" onclick="renderSessionPolicy(true)">' + esc(AC_L.cancel()) + '</button>' +
            '<span class="ac-note-inline">' + esc(bi(
              'ມີຜົນກັບເຊດຊັນທີ່ສ້າງໃໝ່ ແລະ ກັບການກວດອາຍຸຄັ້ງຕໍ່ໄປຂອງເຊດຊັນທີ່ມີຢູ່',
              'Applies to new sessions, and to the next check of existing ones',
              'มีผลกับเซสชันที่สร้างใหม่ และกับการตรวจอายุครั้งถัดไปของเซสชันที่มีอยู่',
              '새 세션 및 기존 세션의 다음 검사부터 적용')) + '</span>' +
          '</div>'
        : '');
  });
}

async function acSaveSessionPolicy(btn) {
  const idleMinutes = {}, maxDevices = {};
  document.querySelectorAll('[id^="sp-idle-"]').forEach(el => {
    idleMinutes[el.id.replace('sp-idle-', '')] = parseInt(el.value, 10);
  });
  document.querySelectorAll('[id^="sp-dev-"]').forEach(el => {
    maxDevices[el.id.replace('sp-dev-', '')] = parseInt(el.value, 10);
  });
  if (btn) btn.disabled = true;
  try {
    _acPolicies = await DB.setSessionPolicy({
      idleMinutes, maxDevices,
      sessionHours: parseInt(document.getElementById('sp-session').value, 10),
      rememberDays: parseInt(document.getElementById('sp-remember').value, 10),
      absoluteDays: parseInt(document.getElementById('sp-absolute').value, 10),
    });
    toast(AC_L.saved(), 'ok');
  } catch (e) {
    toast(bi('ບັນທຶກບໍ່ສຳເລັດ', 'Could not save', 'บันทึกไม่สำเร็จ', '저장하지 못했습니다'), 'warn');
  }
  if (btn) btn.disabled = false;
  renderSessionPolicy(false);
}

/* ══════════════════════════════════════════════════════════════════
 * TASK 4 — Trusted Devices (own account)
 * ══════════════════════════════════════════════════════════════════
 * Scoped to the signed-in account by the API itself. An administrator does not
 * get to enumerate a colleague's devices from here — the enforcement action
 * they DO get ("clear this account's devices") lives in MFA Policy and reports
 * only a count.
 */
async function renderTrustedDevices(force) {
  await acRender('set-sec-devices-body', async () => {
    const devices = await DB.listTrustedDevices();
    if (!devices.length) {
      return '<div class="set-card ac-card">' + acEmpty(bi(
        'ບໍ່ມີອຸປະກອນທີ່ເຊື່ອຖື — ຕ້ອງຢືນຢັນ MFA ທຸກຄັ້ງທີ່ເຂົ້າສູ່ລະບົບ',
        'No trusted devices — MFA is required at every sign-in',
        'ไม่มีอุปกรณ์ที่เชื่อถือ — ต้องยืนยัน MFA ทุกครั้งที่เข้าสู่ระบบ',
        '신뢰 기기 없음 — 로그인할 때마다 MFA가 필요합니다')) + '</div>';
    }

    const rows = devices.map(d =>
      '<tr' + (d.current ? ' class="ac-row-current"' : '') + '>' +
        '<td><span class="ac-device">' + esc(d.device_name || bi('ອຸປະກອນບໍ່ຮູ້ຈັກ', 'Unknown device', 'อุปกรณ์ไม่รู้จัก', '알 수 없는 기기')) + '</span>' +
          (d.current ? ' ' + acPill('good', bi('ເຄື່ອງນີ້', 'This device', 'เครื่องนี้', '이 기기')) : '') + '</td>' +
        '<td>' + esc(acPlatform(d.user_agent || d.device_name)) + '</td>' +
        '<td>' + esc(acTime(d.created_at)) + '</td>' +
        '<td>' + esc(d.last_used_at ? acAgo(d.last_used_at) : '—') + '</td>' +
        '<td class="ac-actions">' +
          '<button class="btn btn-sm btn-danger" onclick="acRevokeDevice(' + Number(d.id) + ')">' +
            esc(AC_L.revoke()) + '</button></td>' +
      '</tr>').join('');

    return '<div class="set-card ac-card">' +
        acTable(bi('ອຸປະກອນທີ່ເຊື່ອຖື', 'Trusted devices', 'อุปกรณ์ที่เชื่อถือ', '신뢰 기기'),
          [AC_L.device(),
           bi('ແພລດຟອມ', 'Platform', 'แพลตฟอร์ม', '플랫폼'),
           AC_L.created(), AC_L.lastUsed(), AC_L.actions()], rows) +
      '</div>' +
      '<div class="ac-actions-bar">' +
        '<button class="btn btn-danger" onclick="acRevokeAllDevices()">' +
          esc(bi('ຖອນສິດທຸກອຸປະກອນ', 'Revoke all devices', 'ถอนสิทธิ์ทุกอุปกรณ์', '모든 기기 해지')) + '</button>' +
        '<span class="ac-note-inline">' + esc(bi(
          'ຫຼັງຈາກນັ້ນຈະຕ້ອງຢືນຢັນ MFA ໃໝ່ທຸກເຄື່ອງ ລວມທັງເຄື່ອງນີ້',
          'You will then have to complete MFA again on every device, including this one',
          'หลังจากนั้นจะต้องยืนยัน MFA ใหม่ทุกเครื่อง รวมถึงเครื่องนี้',
          '이후 이 기기를 포함한 모든 기기에서 MFA를 다시 완료해야 합니다')) + '</span>' +
      '</div>';
  });
}

/** Best-effort platform label from a user-agent string. Display only. */
function acPlatform(ua) {
  const s = String(ua || '');
  if (/Windows/i.test(s)) return 'Windows';
  if (/iPhone|iPad|iOS/i.test(s)) return 'iOS';
  if (/Macintosh|Mac OS/i.test(s)) return 'macOS';
  if (/Android/i.test(s)) return 'Android';
  if (/Linux/i.test(s)) return 'Linux';
  return s ? s.split(' ')[0] : '—';
}

function acRevokeDevice(id) {
  showConfirm(AC_L.revoke(),
    bi('ອຸປະກອນນີ້ຈະຕ້ອງຢືນຢັນ MFA ໃນຄັ້ງຕໍ່ໄປ',
       'This device will have to complete MFA next time.',
       'อุปกรณ์นี้จะต้องยืนยัน MFA ในครั้งถัดไป',
       '이 기기는 다음 로그인 시 MFA를 완료해야 합니다.'),
    async () => {
      await DB.revokeTrustedDevice(id);
      toast(bi('ຖອນສິດແລ້ວ', 'Revoked', 'ถอนสิทธิ์แล้ว', '해지됨'), 'ok');
      renderTrustedDevices(true);
    });
}

function acRevokeAllDevices() {
  showConfirm(bi('ຖອນສິດທຸກອຸປະກອນ', 'Revoke all devices', 'ถอนสิทธิ์ทุกอุปกรณ์', '모든 기기 해지'),
    bi('ທຸກເຄື່ອງ ລວມທັງເຄື່ອງນີ້ ຈະຕ້ອງຢືນຢັນ MFA ໃໝ່',
       'Every device, including this one, will have to complete MFA again.',
       'ทุกเครื่อง รวมถึงเครื่องนี้ จะต้องยืนยัน MFA ใหม่',
       '이 기기를 포함한 모든 기기에서 MFA를 다시 완료해야 합니다.'),
    async () => {
      const n = await DB.revokeAllTrustedDevices();
      toast(bi('ຖອນສິດແລ້ວ ', 'Revoked ', 'ถอนสิทธิ์แล้ว ', '해지됨 ') + n, 'ok');
      renderTrustedDevices(true);
    });
}

/* ══════════════════════════════════════════════════════════════════
 * Administration — Users
 * ══════════════════════════════════════════════════════════════════ */

let _acUsers = null;

/** Translate the server's status codes into something an operator can act on. */
function acUserError(status) {
  if (String(status).startsWith('weak-password:')) {
    const code = String(status).split(':')[1];
    const reasons = {
      'too-short':         bi('ສັ້ນເກີນໄປ', 'Too short', 'สั้นเกินไป', '너무 짧습니다'),
      'too-long':          bi('ຍາວເກີນໄປ', 'Too long', 'ยาวเกินไป', '너무 깁니다'),
      'need-upper':        bi('ຕ້ອງມີໂຕພິມໃຫຍ່', 'Needs an uppercase letter', 'ต้องมีตัวพิมพ์ใหญ่', '대문자가 필요합니다'),
      'need-lower':        bi('ຕ້ອງມີໂຕພິມນ້ອຍ', 'Needs a lowercase letter', 'ต้องมีตัวพิมพ์เล็ก', '소문자가 필요합니다'),
      'need-digit':        bi('ຕ້ອງມີຕົວເລກ', 'Needs a number', 'ต้องมีตัวเลข', '숫자가 필요합니다'),
      'need-special':      bi('ຕ້ອງມີອັກຂະລະພິເສດ', 'Needs a special character', 'ต้องมีอักขระพิเศษ', '특수문자가 필요합니다'),
      'repeated':          bi('ມີຕົວອັກສອນຊ້ຳຫຼາຍເກີນ', 'Too many repeated characters', 'มีตัวอักษรซ้ำมากเกินไป', '반복 문자가 너무 많습니다'),
      'common':            bi('ເປັນລະຫັດທີ່ພົບທົ່ວໄປ', 'That password is too common', 'เป็นรหัสที่พบทั่วไป', '너무 흔한 비밀번호입니다'),
      'contains-username': bi('ມີຊື່ຜູ້ໃຊ້ຢູ່ໃນລະຫັດ', 'Contains the username', 'มีชื่อผู้ใช้อยู่ในรหัส', '사용자 이름이 포함되어 있습니다'),
      'contains-app-name': bi('ມີຊື່ແອັບຢູ່ໃນລະຫັດ', 'Contains the application name', 'มีชื่อแอปอยู่ในรหัส', '앱 이름이 포함되어 있습니다'),
    };
    return (reasons[code] || code);
  }
  return {
    'dup':             bi('ຊື່ຜູ້ໃຊ້ນີ້ມີແລ້ວ', 'That username already exists', 'ชื่อผู้ใช้นี้มีอยู่แล้ว', '이미 존재하는 사용자 이름입니다'),
    'invalid':         bi('ຂໍ້ມູນບໍ່ຄົບ', 'Missing details', 'ข้อมูลไม่ครบ', '필수 항목이 없습니다'),
    'last-admin':      bi('ຕ້ອງມີຜູ້ດູແລລະບົບຢ່າງໜ້ອຍ 1 ຄົນ', 'At least one administrator is required', 'ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน', '관리자가 최소 한 명 필요합니다'),
    'rank-violation':  bi('ບໍ່ສາມາດມອບບົດບາດທີ່ສູງກວ່າ ຫຼື ເທົ່າກັບຕົນເອງ', 'You cannot assign a role at or above your own', 'ไม่สามารถมอบบทบาทที่สูงกว่าหรือเท่ากับตนเอง', '본인 이상의 역할은 부여할 수 없습니다'),
    'unknown-role':    bi('ບົດບາດບໍ່ຖືກຕ້ອງ', 'Unknown role', 'บทบาทไม่ถูกต้อง', '알 수 없는 역할'),
    'password-reused': bi('ລະຫັດນີ້ເຄີຍໃຊ້ມາແລ້ວ', 'That password was used recently', 'รหัสนี้เคยใช้มาแล้ว', '최근에 사용한 비밀번호입니다'),
    'cannot-delete-self': bi('ລຶບບັນຊີຕົນເອງບໍ່ໄດ້', 'You cannot delete your own account', 'ลบบัญชีตัวเองไม่ได้', '본인 계정은 삭제할 수 없습니다'),
    'missing':         bi('ບໍ່ພົບບັນຊີ', 'Account not found', 'ไม่พบบัญชี', '계정을 찾을 수 없습니다'),
  }[status] || String(status);
}

async function renderUsersPane(force) {
  if (!acCan('user.view')) { acFill('set-users-body', acError({ status: 403 })); return; }
  await acRender('set-users-body', async () => {
    if (force || !_acUsers) _acUsers = await DB.listUsers();
    const { users, roles, actorRank } = _acUsers;
    const canCreate = acCan('user.create'), canEdit = acCan('user.update');
    const canDelete = acCan('user.delete'), canAssign = acCan('role.assign');
    const me = (DB.getCurrentUser() || {}).username;

    /* Roles this account may actually hand out. The rank rule is enforced by the
     * server; mirroring it here means the operator is never offered a choice
     * that will come back as a 403. */
    const assignable = roles.filter(r => !r.is_legacy &&
      (actorRank == null || r.rank >= actorRank));

    const rows = users.map(u => {
      const isSelf = u.username === me;
      const roleSelect = canAssign && !isSelf
        ? '<select class="ac-role-select" aria-label="' + esc(AC_L.role() + ' — ' + u.username) + '"' +
            ' onchange="acChangeRole(\'' + esc(u.username) + '\', this.value, this)">' +
            assignable.map(r => '<option value="' + esc(r.key) + '"' +
              (r.key === u.role ? ' selected' : '') + '>' + esc(acRoleName(r.key, r.name)) + '</option>').join('') +
            /* A legacy role the account still holds is shown so the select is
             * never silently wrong — but it cannot be re-selected once left. */
            (u.roleLegacy ? '<option value="' + esc(u.role) + '" selected>' +
              esc(acRoleName(u.role, u.roleName)) + '</option>' : '') +
          '</select>'
        : '<span class="ac-role-static">' + esc(acRoleName(u.role, u.roleName)) +
          (u.roleLegacy ? ' ' + acPill('info', bi('ເກົ່າ', 'legacy', 'เดิม', '구')) : '') + '</span>';

      const state = [];
      if (u.mustChangePassword) state.push(acPill('warning', bi('ຕ້ອງປ່ຽນລະຫັດ', 'Must change password', 'ต้องเปลี่ยนรหัส', '비밀번호 변경 필요')));
      if (!u.hasFactor && u.mfaRequired) state.push(acPill('critical', bi('ຄ້າງ MFA', 'MFA owed', 'ค้าง MFA', 'MFA 미등록')));
      if (u.hasFactor) state.push(acPill('good', 'MFA'));
      if (u.activeSessions) state.push(acPill('info', u.activeSessions + ' ' + bi('ເຊດຊັນ', 'sessions', 'เซสชัน', '세션')));

      return '<tr>' +
        '<td><div class="ac-user"><span class="ac-user-name">' + esc(u.name) +
          (isSelf ? ' ' + acPill('info', bi('ທ່ານ', 'you', 'คุณ', '나')) : '') + '</span>' +
          '<span class="ac-user-at">@' + esc(u.username) + '</span></div></td>' +
        '<td>' + roleSelect + '</td>' +
        '<td>' + state.join(' ') + '</td>' +
        '<td>' + esc(u.lastLogin ? acAgo(u.lastLogin) : bi('ຍັງບໍ່ເຄີຍ', 'never', 'ยังไม่เคย', '없음')) + '</td>' +
        '<td>' + esc(u.passwordAgeDays == null ? '—'
          : u.passwordAgeDays + ' ' + bi('ວັນ', 'd', 'วัน', '일')) + '</td>' +
        '<td class="ac-actions">' +
          (canEdit ? '<button class="btn btn-sm" onclick="acResetPassword(\'' + esc(u.username) + '\')">' +
            esc(bi('ຕັ້ງລະຫັດໃໝ່', 'Reset password', 'ตั้งรหัสใหม่', '비밀번호 재설정')) + '</button>' : '') +
          (canEdit ? ' <button class="btn btn-sm btn-ghost" onclick="acRenameUser(\'' + esc(u.username) + '\', \'' + esc(u.name) + '\')">' +
            esc(bi('ປ່ຽນຊື່', 'Rename', 'เปลี่ยนชื่อ', '이름 변경')) + '</button>' : '') +
          (canDelete && !isSelf ? ' <button class="btn btn-sm btn-danger" onclick="acDeleteUser(\'' + esc(u.username) + '\')">' +
            esc(bi('ລຶບ', 'Delete', 'ลบ', '삭제')) + '</button>' : '') +
        '</td>' +
      '</tr>';
    }).join('');

    const table = acTable(bi('ບັນຊີຜູ້ໃຊ້', 'User accounts', 'บัญชีผู้ใช้', '사용자 계정'),
      [AC_L.user(), AC_L.role(), AC_L.status(),
       bi('ເຂົ້າໃຊ້ຫຼ້າສຸດ', 'Last sign-in', 'เข้าใช้ล่าสุด', '최근 로그인'),
       bi('ອາຍຸລະຫັດ', 'Password age', 'อายุรหัส', '비밀번호 사용 기간'),
       AC_L.actions()], rows);

    const addForm = canCreate
      ? '<div class="set-card-label">' + esc(bi('ເພີ່ມຜູ້ໃຊ້', 'Add user', 'เพิ่มผู้ใช้', '사용자 추가')) + '</div>' +
        '<div class="set-card" style="padding:13px 15px">' +
          '<div class="set-add-row users-add">' +
            '<label class="sr-only" for="set-u-name">' + esc(bi('ຊື່ສະແດງ', 'Display name', 'ชื่อที่แสดง', '표시 이름')) + '</label>' +
            '<input id="set-u-name" placeholder="' + esc(bi('ຊື່ສະແດງ', 'Display name', 'ชื่อที่แสดง', '표시 이름')) + '">' +
            '<label class="sr-only" for="set-u-user">Username</label>' +
            '<input id="set-u-user" placeholder="Username" autocomplete="off">' +
            '<label class="sr-only" for="set-u-pass">' + esc(bi('ລະຫັດຜ່ານຊົ່ວຄາວ', 'Temporary password', 'รหัสผ่านชั่วคราว', '임시 비밀번호')) + '</label>' +
            '<input id="set-u-pass" type="text" autocomplete="new-password" placeholder="' +
              esc(bi('ລະຫັດຜ່ານຊົ່ວຄາວ', 'Temporary password', 'รหัสผ่านชั่วคราว', '임시 비밀번호')) + '">' +
            '<label class="sr-only" for="set-u-role">' + esc(AC_L.role()) + '</label>' +
            '<select id="set-u-role">' +
              assignable.map(r => '<option value="' + esc(r.key) + '"' +
                (r.key === 'employee' ? ' selected' : '') + '>' + esc(acRoleName(r.key, r.name)) + '</option>').join('') +
            '</select>' +
            '<button class="btn btn-add btn-sm" onclick="acAddUser(this)">' + esc(bi('ເພີ່ມ', 'Add', 'เพิ่ม', '추가')) + '</button>' +
          '</div>' +
          '<p class="ac-note-inline">' + esc(bi(
            'ລະຫັດຜ່ານທີ່ທ່ານຕັ້ງເປັນແບບຊົ່ວຄາວ — ເຈົ້າຂອງບັນຊີຕ້ອງປ່ຽນເອງໃນການເຂົ້າສູ່ລະບົບຄັ້ງທຳອິດ',
            'The password you set is temporary — the account owner must replace it at first sign-in.',
            'รหัสผ่านที่คุณตั้งเป็นแบบชั่วคราว — เจ้าของบัญชีต้องเปลี่ยนเองตอนเข้าสู่ระบบครั้งแรก',
            '설정한 비밀번호는 임시입니다 — 계정 소유자가 첫 로그인 시 변경해야 합니다')) + '</p>' +
        '</div>'
      : '';

    return '<div class="set-card ac-card">' + table + '</div>' + addForm;
  });
}

async function acAddUser(btn) {
  const g = (id) => document.getElementById(id);
  const username = (g('set-u-user').value || '').trim();
  const password = g('set-u-pass').value || '';
  if (!username || !password) {
    toast(bi('ຕ້ອງມີຊື່ຜູ້ໃຊ້ ແລະ ລະຫັດຜ່ານ', 'Username and password are required', 'ต้องมีชื่อผู้ใช้และรหัสผ่าน', '사용자 이름과 비밀번호가 필요합니다'), 'warn');
    return;
  }
  btn.disabled = true;
  const status = await DB.addUser({
    username, password, role: g('set-u-role').value, name: (g('set-u-name').value || '').trim(),
  });
  btn.disabled = false;
  if (status !== 'ok') { toast(acUserError(status), 'warn'); return; }
  g('set-u-name').value = ''; g('set-u-user').value = ''; g('set-u-pass').value = '';
  toast(bi('ສ້າງບັນຊີແລ້ວ', 'Account created', 'สร้างบัญชีแล้ว', '계정이 생성되었습니다'), 'ok');
  _acOverview = null;
  renderUsersPane(true);
}

async function acChangeRole(username, role, select) {
  const status = await DB.updateUser(username, { role });
  if (status !== 'ok') {
    toast(acUserError(status), 'warn');
    renderUsersPane(true);      // put the select back to the truth
    return;
  }
  toast(bi('ປ່ຽນບົດບາດແລ້ວ', 'Role changed', 'เปลี่ยนบทบาทแล้ว', '역할이 변경되었습니다'), 'ok');
  _acOverview = null;
  renderUsersPane(true);
}

/**
 * Reset somebody's password.
 *
 * Uses the app's own prompt dialog rather than window.prompt: the value is a
 * credential, and a native prompt is unstyled, unlocalised and impossible to
 * mark as a password field.
 */
function acResetPassword(username) {
  acPrompt(
    bi('ຕັ້ງລະຫັດຜ່ານໃໝ່', 'Set a new password', 'ตั้งรหัสผ่านใหม่', '새 비밀번호 설정'),
    bi('ລະຫັດຊົ່ວຄາວສຳລັບ @' + username + '. ທຸກເຊດຊັນຂອງບັນຊີນີ້ຈະຖືກຍົກເລີກ ແລະ ເຈົ້າຂອງຕ້ອງປ່ຽນເອງເມື່ອເຂົ້າສູ່ລະບົບ.',
       'A temporary password for @' + username + '. Every session for this account is revoked, and the owner must replace it at next sign-in.',
       'รหัสชั่วคราวสำหรับ @' + username + ' ทุกเซสชันของบัญชีนี้จะถูกยกเลิก และเจ้าของต้องเปลี่ยนเองตอนเข้าสู่ระบบ',
       '@' + username + ' 계정의 임시 비밀번호입니다. 모든 세션이 해지되며 소유자가 다음 로그인 시 변경해야 합니다.'),
    async (value) => {
      if (!value) return;
      const status = await DB.updateUser(username, { password: value });
      if (status !== 'ok') { toast(acUserError(status), 'warn'); return; }
      toast(bi('ຕັ້ງລະຫັດໃໝ່ແລ້ວ', 'Password reset', 'ตั้งรหัสใหม่แล้ว', '비밀번호가 재설정되었습니다'), 'ok');
      renderUsersPane(true);
    });
}

function acRenameUser(username, current) {
  acPrompt(bi('ປ່ຽນຊື່ສະແດງ', 'Change display name', 'เปลี่ยนชื่อที่แสดง', '표시 이름 변경'),
    '@' + username,
    async (value) => {
      if (!value) return;
      const status = await DB.updateUser(username, { name: value });
      if (status !== 'ok') { toast(acUserError(status), 'warn'); return; }
      toast(AC_L.saved(), 'ok');
      renderUsersPane(true);
    }, current, 'text');
}

function acDeleteUser(username) {
  showConfirm(bi('ລຶບບັນຊີ', 'Delete account', 'ลบบัญชี', '계정 삭제'),
    bi('ລຶບ @' + username + ' ຖາວອນ ແລະ ອອກຈາກລະບົບທຸກເຄື່ອງ. ບັນທຶກກວດສອບຍັງເກັບໄວ້.',
       'Permanently delete @' + username + ' and sign them out everywhere. The audit trail is kept.',
       'ลบ @' + username + ' ถาวรและออกจากระบบทุกเครื่อง บันทึกตรวจสอบยังเก็บไว้',
       '@' + username + ' 계정을 영구 삭제하고 전체 로그아웃합니다. 감사 기록은 보존됩니다.'),
    async () => {
      const status = await DB.deleteUser(username);
      if (status !== 'ok') { toast(acUserError(status), 'warn'); return; }
      toast(bi('ລຶບແລ້ວ', 'Deleted', 'ลบแล้ว', '삭제됨'), 'ok');
      _acOverview = null;
      renderUsersPane(true);
    });
}

/* ══════════════════════════════════════════════════════════════════
 * acPrompt — the app's own single-field dialog
 * ══════════════════════════════════════════════════════════════════
 * Replaces window.prompt(), which cannot be styled, cannot be localised, cannot
 * mark a field as a password, and is blocked outright in some embedded
 * browsers. Focus moves into the field on open and returns to the element that
 * opened it on close; Escape cancels and Enter submits.
 */
let _acPromptPrev = null;

function acPrompt(title, message, onOk, initial, type) {
  const existing = document.getElementById('ac-prompt');
  if (existing) existing.remove();
  _acPromptPrev = document.activeElement;

  const wrap = document.createElement('div');
  wrap.className = 'overlay open ac-prompt-overlay';
  wrap.id = 'ac-prompt';
  wrap.innerHTML =
    '<div class="form-modal ac-prompt" role="dialog" aria-modal="true" aria-labelledby="ac-prompt-title">' +
      '<div class="form-header"><h2 id="ac-prompt-title">' + esc(title) + '</h2>' +
        '<button class="fm-close" id="ac-prompt-x" aria-label="' + esc(AC_L.cancel()) + '">&#x2715;</button></div>' +
      '<div class="ac-prompt-body">' +
        '<p class="ac-prompt-msg" id="ac-prompt-msg">' + esc(message || '') + '</p>' +
        '<input class="ac-prompt-input" id="ac-prompt-input" type="' + (type === 'text' ? 'text' : 'text') + '"' +
          ' value="' + esc(initial || '') + '" autocomplete="off" spellcheck="false"' +
          ' aria-describedby="ac-prompt-msg">' +
      '</div>' +
      '<div class="form-footer">' +
        '<button class="btn btn-ghost" id="ac-prompt-cancel">' + esc(AC_L.cancel()) + '</button>' +
        '<button class="btn btn-primary" id="ac-prompt-ok">' + esc(bi('ຢືນຢັນ', 'Confirm', 'ยืนยัน', '확인')) + '</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(wrap);

  const input = wrap.querySelector('#ac-prompt-input');
  const close = () => {
    wrap.remove();
    if (_acPromptPrev && _acPromptPrev.focus) _acPromptPrev.focus();
    _acPromptPrev = null;
  };
  const ok = () => { const v = input.value; close(); onOk(v); };

  wrap.querySelector('#ac-prompt-ok').onclick = ok;
  wrap.querySelector('#ac-prompt-cancel').onclick = close;
  wrap.querySelector('#ac-prompt-x').onclick = close;
  // Clicking the backdrop cancels; clicking inside the card must not.
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  wrap.querySelector('.ac-prompt').onclick = (e) => e.stopPropagation();
  wrap.onkeydown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter')  { e.preventDefault(); ok(); }
  };
  setTimeout(() => { input.focus(); input.select(); }, 30);
}

/* ══════════════════════════════════════════════════════════════════
 * TASK 5 — Active Sessions
 * ══════════════════════════════════════════════════════════════════
 * Two halves, and the split is the security boundary:
 *   • YOUR sessions — full device detail, because they are yours.
 *   • Everyone else — counts and a revoke button, nothing identifying.
 */
async function renderSessionsPane(force) {
  await acRender('set-sessions-body', async () => {
    const mine = await DB.listSessions();
    const canManage = acCan('security.manage');
    const summary = canManage ? await DB.sessionsSummary() : [];

    const mineRows = mine.map(s =>
      '<tr' + (s.current ? ' class="ac-row-current"' : '') + '>' +
        '<td><span class="ac-device">' + esc(s.device_name) + '</span>' +
          (s.current ? ' ' + acPill('good', bi('ເຄື່ອງນີ້', 'This device', 'เครื่องนี้', '이 기기')) : '') + '</td>' +
        '<td class="ac-mono">' + esc(s.ip || '—') + '</td>' +
        '<td>' + esc(acTime(s.created_at)) + '</td>' +
        '<td>' + esc(acAgo(s.last_seen)) + '</td>' +
        '<td>' + (s.current
          ? acPill('good', bi('ປັດຈຸບັນ', 'Current', 'ปัจจุบัน', '현재'))
          : acPill('info', bi('ໃຊ້ງານຢູ່', 'Active', 'ใช้งานอยู่', '활성'))) + '</td>' +
        '<td class="ac-actions">' + (s.current ? ''
          : '<button class="btn btn-sm btn-danger" onclick="acRevokeSession(' + Number(s.id) + ')">' +
              esc(bi('ຈົບເຊດຊັນ', 'Terminate', 'จบเซสชัน', '종료')) + '</button>') + '</td>' +
      '</tr>').join('');

    const mineCard = '<div class="set-card-label">' +
        esc(bi('ອຸປະກອນຂອງທ່ານ', 'Your devices', 'อุปกรณ์ของคุณ', '내 기기')) + '</div>' +
      '<div class="set-card ac-card">' +
        (mine.length
          ? acTable(bi('ເຊດຊັນຂອງທ່ານ', 'Your sessions', 'เซสชันของคุณ', '내 세션'),
              [AC_L.device(), 'IP', AC_L.created(), AC_L.lastSeen(), AC_L.status(), AC_L.actions()], mineRows)
          : acEmpty(AC_L.none())) +
      '</div>' +
      '<div class="ac-actions-bar">' +
        '<button class="btn btn-danger" onclick="acLogoutEverywhere()">' +
          esc(bi('ອອກຈາກລະບົບທຸກເຄື່ອງ', 'Logout all devices', 'ออกจากระบบทุกเครื่อง', '모든 기기 로그아웃')) + '</button>' +
        '<span class="ac-note-inline">' + esc(bi(
          'ເຄື່ອງນີ້ຈະຍັງເຂົ້າໃຊ້ຢູ່', 'This device stays signed in', 'เครื่องนี้จะยังเข้าใช้อยู่', '이 기기는 로그인 상태로 유지됩니다')) + '</span>' +
      '</div>';

    if (!canManage) return mineCard;

    const others = summary.map(s =>
      '<tr>' +
        '<td><div class="ac-user"><span class="ac-user-name">' + esc(s.name) + '</span>' +
          '<span class="ac-user-at">@' + esc(s.username) + '</span></div></td>' +
        '<td>' + esc(acRoleName(s.role, s.roleName)) + '</td>' +
        '<td class="ac-num">' + s.sessions + '</td>' +
        '<td>' + esc(acAgo(s.lastSeen)) + '</td>' +
        '<td class="ac-actions">' +
          '<button class="btn btn-sm btn-danger" onclick="acRevokeUserSessions(\'' + esc(s.username) + '\')">' +
            esc(bi('ອອກຈາກລະບົບທັງໝົດ', 'Sign out everywhere', 'ออกจากระบบทั้งหมด', '전체 로그아웃')) + '</button></td>' +
      '</tr>').join('');

    return mineCard +
      '<div class="set-card-label">' +
        esc(bi('ບັນຊີອື່ນທີ່ກຳລັງເຂົ້າໃຊ້', 'Other accounts signed in', 'บัญชีอื่นที่กำลังเข้าใช้', '로그인 중인 다른 계정')) + '</div>' +
      '<div class="set-card ac-card">' +
        (summary.length
          ? acTable(bi('ເຊດຊັນຕໍ່ບັນຊີ', 'Sessions per account', 'เซสชันต่อบัญชี', '계정별 세션'),
              [AC_L.user(), AC_L.role(),
               bi('ຈຳນວນເຊດຊັນ', 'Sessions', 'จำนวนเซสชัน', '세션 수'),
               AC_L.lastSeen(), AC_L.actions()], others)
          : acEmpty(AC_L.none())) +
      '</div>' +
      '<p class="ac-note">' + esc(bi(
        'ສະແດງພຽງຈຳນວນ — ລາຍລະອຽດອຸປະກອນ ແລະ IP ຂອງບັນຊີອື່ນບໍ່ຖືກເປີດເຜີຍ ເຖິງແມ່ນຕໍ່ຜູ້ດູແລລະບົບ',
        'Counts only — another account’s device names and IP addresses are never exposed, not even to an administrator.',
        'แสดงเพียงจำนวน — รายละเอียดอุปกรณ์และ IP ของบัญชีอื่นไม่ถูกเปิดเผย แม้แต่กับผู้ดูแลระบบ',
        '개수만 표시 — 다른 계정의 기기 정보와 IP는 관리자에게도 공개되지 않습니다')) + '</p>';
  });
}

function acRevokeSession(id) {
  showConfirm(bi('ຈົບເຊດຊັນ', 'Terminate session', 'จบเซสชัน', '세션 종료'),
    bi('ອຸປະກອນນັ້ນຈະຖືກອອກຈາກລະບົບທັນທີ',
       'That device will be signed out immediately.',
       'อุปกรณ์นั้นจะถูกออกจากระบบทันที',
       '해당 기기가 즉시 로그아웃됩니다.'),
    async () => {
      await DB.revokeSession(id);
      toast(bi('ຈົບແລ້ວ', 'Terminated', 'จบแล้ว', '종료됨'), 'ok');
      renderSessionsPane(true);
    });
}

function acLogoutEverywhere() {
  showConfirm(bi('ອອກຈາກລະບົບທຸກເຄື່ອງ', 'Logout all devices', 'ออกจากระบบทุกเครื่อง', '모든 기기 로그아웃'),
    bi('ທຸກເຄື່ອງອື່ນຈະຖືກອອກຈາກລະບົບ. ເຄື່ອງນີ້ຍັງເຂົ້າໃຊ້ຢູ່.',
       'Every other device will be signed out. This one stays signed in.',
       'ทุกเครื่องอื่นจะถูกออกจากระบบ เครื่องนี้ยังเข้าใช้อยู่',
       '다른 모든 기기가 로그아웃됩니다. 이 기기는 유지됩니다.'),
    async () => {
      const n = await DB.logoutAll(true);
      toast(bi('ອອກແລ້ວ ', 'Signed out ', 'ออกแล้ว ', '로그아웃 ') + n, 'ok');
      renderSessionsPane(true);
    });
}

function acRevokeUserSessions(username) {
  showConfirm(bi('ອອກຈາກລະບົບທັງໝົດ', 'Sign out everywhere', 'ออกจากระบบทั้งหมด', '전체 로그아웃'),
    bi('@' + username + ' ຈະຖືກອອກຈາກລະບົບໃນທຸກອຸປະກອນທັນທີ',
       '@' + username + ' will be signed out on every device immediately.',
       '@' + username + ' จะถูกออกจากระบบในทุกอุปกรณ์ทันที',
       '@' + username + ' 계정이 모든 기기에서 즉시 로그아웃됩니다.'),
    async () => {
      try {
        const r = await DB.revokeUserSessions(username);
        toast(bi('ອອກແລ້ວ ', 'Signed out ', 'ออกแล้ว ', '로그아웃 ') + (r.revoked || 0), 'ok');
        renderSessionsPane(true);
        _acOverview = null;
      } catch (e) { toast(bi('ບໍ່ສຳເລັດ', 'Failed', 'ไม่สำเร็จ', '실패'), 'warn'); }
    });
}

/* ══════════════════════════════════════════════════════════════════
 * TASK 6 — Audit Log viewer
 * ══════════════════════════════════════════════════════════════════ */

const AC_PAGE = 50;
let _acAudit = { offset: 0, filters: {}, actions: [], total: 0, rows: [] };

/** Human label for an audit action. Unknown actions fall back to their code. */
function acActionLabel(a) {
  const map = {
    LOGIN:                   bi('ເຂົ້າສູ່ລະບົບ', 'Login', 'เข้าสู่ระบบ', '로그인'),
    LOGOUT:                  bi('ອອກຈາກລະບົບ', 'Logout', 'ออกจากระบบ', '로그아웃'),
    LOGOUT_ALL:              bi('ອອກທຸກເຄື່ອງ', 'Logout all', 'ออกทุกเครื่อง', '전체 로그아웃'),
    SESSION_CREATE:          bi('ສ້າງເຊດຊັນ', 'Session created', 'สร้างเซสชัน', '세션 생성'),
    SESSION_EXPIRE:          bi('ເຊດຊັນໝົດອາຍຸ', 'Session ended', 'เซสชันหมดอายุ', '세션 종료'),
    PASSWORD_CHANGE:         bi('ປ່ຽນລະຫັດຜ່ານ', 'Password change', 'เปลี่ยนรหัสผ่าน', '비밀번호 변경'),
    USER_CREATE:             bi('ສ້າງບັນຊີ', 'User created', 'สร้างบัญชี', '사용자 생성'),
    USER_DELETE:             bi('ລຶບບັນຊີ', 'User deleted', 'ลบบัญชี', '사용자 삭제'),
    ROLE_CHANGE:             bi('ປ່ຽນບົດບາດ', 'Role changed', 'เปลี่ยนบทบาท', '역할 변경'),
    MFA_ENABLED:             bi('ເປີດ MFA', 'MFA enabled', 'เปิด MFA', 'MFA 활성화'),
    MFA_DISABLED:            bi('ປິດ MFA', 'MFA disabled', 'ปิด MFA', 'MFA 비활성화'),
    MFA_SUCCESS:             bi('ຢືນຢັນ MFA ສຳເລັດ', 'MFA success', 'ยืนยัน MFA สำเร็จ', 'MFA 성공'),
    MFA_FAILURE:             bi('ຢືນຢັນ MFA ລົ້ມເຫລວ', 'MFA failure', 'ยืนยัน MFA ล้มเหลว', 'MFA 실패'),
    PASSKEY_REGISTER:        bi('ລົງທະບຽນ Passkey', 'Passkey registered', 'ลงทะเบียน Passkey', '패스키 등록'),
    PASSKEY_DELETE:          bi('ລຶບ Passkey', 'Passkey deleted', 'ลบ Passkey', '패스키 삭제'),
    PASSKEY_LOGIN:           bi('ເຂົ້າດ້ວຍ Passkey', 'Passkey login', 'เข้าด้วย Passkey', '패스키 로그인'),
    RECOVERY_CODE_USED:      bi('ໃຊ້ລະຫັດກູ້ຄືນ', 'Recovery code used', 'ใช้รหัสกู้คืน', '복구 코드 사용'),
    DEVICE_TRUSTED:          bi('ເຊື່ອຖືອຸປະກອນ', 'Device trusted', 'เชื่อถืออุปกรณ์', '기기 신뢰'),
    DEVICE_REVOKED:          bi('ຖອນອຸປະກອນ', 'Device revoked', 'ถอนอุปกรณ์', '기기 해지'),
    PERMISSION_DENIED:       bi('ປະຕິເສດສິດ', 'Permission denied', 'ปฏิเสธสิทธิ์', '권한 거부'),
    PERMISSION_USED:         bi('ໃຊ້ສິດສຳຄັນ', 'Sensitive permission used', 'ใช้สิทธิ์สำคัญ', '민감 권한 사용'),
    ROLE_PERMISSION_CHANGE:  bi('ປ່ຽນສິດ/ນະໂຍບາຍ', 'Permission/policy change', 'เปลี่ยนสิทธิ์/นโยบาย', '권한/정책 변경'),
  };
  return map[a] || a;
}

function acResultPill(result) {
  if (result === 'SUCCESS') return acPill('good', bi('ສຳເລັດ', 'Success', 'สำเร็จ', '성공'));
  if (result === 'LOCKED')  return acPill('warning', bi('ຖືກລັອກ', 'Locked', 'ถูกล็อก', '잠김'));
  return acPill('critical', bi('ລົ້ມເຫລວ', 'Failure', 'ล้มเหลว', '실패'));
}

async function renderAuditPane(force) {
  if (!acCan('audit.view')) { acFill('set-audit-body', acError({ status: 403 })); return; }
  if (force) { _acAudit.offset = 0; _acAudit.filters = {}; }
  await acRender('set-audit-body', async () => {
    const page = await DB.auditLog(Object.assign({ limit: AC_PAGE, offset: _acAudit.offset }, _acAudit.filters));
    _acAudit.total = page.total;
    _acAudit.rows = page.rows;
    if (page.actions && page.actions.length) _acAudit.actions = page.actions;
    return acAuditHtml();
  });
}

/** Re-run the query with the current filters, from page 1. */
async function acAuditApply() {
  const g = (id) => (document.getElementById(id) || {}).value || '';
  _acAudit.filters = {
    q:        g('al-q').trim(),
    username: g('al-user').trim(),
    action:   g('al-action'),
    result:   g('al-result'),
    // <input type="date"> gives a local calendar day; the server compares ISO
    // strings, so the range is widened to cover the whole day either end.
    since:    g('al-from') ? g('al-from') + 'T00:00:00.000Z' : '',
    until:    g('al-to')   ? g('al-to')   + 'T23:59:59.999Z' : '',
  };
  _acAudit.offset = 0;
  await acAuditReload();
}

async function acAuditPage(delta) {
  const next = _acAudit.offset + delta * AC_PAGE;
  if (next < 0 || next >= _acAudit.total) return;
  _acAudit.offset = next;
  await acAuditReload();
}

async function acAuditReload() {
  const body = document.getElementById('set-audit-body');
  if (!body) return;
  body.setAttribute('aria-busy', 'true');
  try {
    const page = await DB.auditLog(Object.assign({ limit: AC_PAGE, offset: _acAudit.offset }, _acAudit.filters));
    _acAudit.total = page.total;
    _acAudit.rows = page.rows;
    acFill('set-audit-body', acAuditHtml());
    // Keep the caret where the operator was working rather than resetting focus
    // to the top of the pane on every filter change.
    const q = document.getElementById('al-q');
    if (q && _acAudit.filters.q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  } catch (e) { acFill('set-audit-body', acError(e)); }
}

function acAuditHtml() {
  const f = _acAudit.filters;
  const from = _acAudit.total ? _acAudit.offset + 1 : 0;
  const to   = Math.min(_acAudit.offset + AC_PAGE, _acAudit.total);

  const filters = '<div class="ac-filters" role="search">' +
    '<div class="ac-field"><label for="al-q">' + esc(bi('ຄົ້ນຫາ', 'Search', 'ค้นหา', '검색')) + '</label>' +
      '<input id="al-q" type="search" value="' + esc(f.q || '') + '"' +
        ' placeholder="' + esc(bi('ຊື່ຜູ້ໃຊ້, IP, ເຫດການ', 'Username, IP, action', 'ชื่อผู้ใช้, IP, การกระทำ', '사용자, IP, 작업')) + '"' +
        ' onkeydown="if(event.key===\'Enter\')acAuditApply()"></div>' +
    '<div class="ac-field"><label for="al-user">' + esc(AC_L.user()) + '</label>' +
      '<input id="al-user" type="text" value="' + esc(f.username || '') + '"' +
        ' onkeydown="if(event.key===\'Enter\')acAuditApply()"></div>' +
    '<div class="ac-field"><label for="al-action">' + esc(bi('ເຫດການ', 'Event type', 'ประเภทเหตุการณ์', '이벤트 유형')) + '</label>' +
      '<select id="al-action" onchange="acAuditApply()">' +
        '<option value="">' + esc(bi('ທັງໝົດ', 'All', 'ทั้งหมด', '전체')) + '</option>' +
        _acAudit.actions.map(a => '<option value="' + esc(a) + '"' + (f.action === a ? ' selected' : '') + '>' +
          esc(acActionLabel(a)) + '</option>').join('') +
      '</select></div>' +
    '<div class="ac-field"><label for="al-result">' + esc(bi('ຜົນ', 'Result', 'ผลลัพธ์', '결과')) + '</label>' +
      '<select id="al-result" onchange="acAuditApply()">' +
        '<option value="">' + esc(bi('ທັງໝົດ', 'All', 'ทั้งหมด', '전체')) + '</option>' +
        ['SUCCESS', 'FAILURE', 'LOCKED'].map(r => '<option value="' + r + '"' +
          (f.result === r ? ' selected' : '') + '>' + esc(acResultLabel(r)) + '</option>').join('') +
      '</select></div>' +
    '<div class="ac-field"><label for="al-from">' + esc(bi('ຈາກວັນທີ', 'From', 'จากวันที่', '시작일')) + '</label>' +
      '<input id="al-from" type="date" value="' + esc((f.since || '').slice(0, 10)) + '" onchange="acAuditApply()"></div>' +
    '<div class="ac-field"><label for="al-to">' + esc(bi('ຮອດວັນທີ', 'To', 'ถึงวันที่', '종료일')) + '</label>' +
      '<input id="al-to" type="date" value="' + esc((f.until || '').slice(0, 10)) + '" onchange="acAuditApply()"></div>' +
    '<div class="ac-field ac-field-actions">' +
      '<button class="btn btn-sm btn-primary" onclick="acAuditApply()">' + esc(bi('ຄົ້ນຫາ', 'Search', 'ค้นหา', '검색')) + '</button>' +
      '<button class="btn btn-sm btn-ghost" onclick="renderAuditPane(true)">' + esc(bi('ລ້າງ', 'Clear', 'ล้าง', '초기화')) + '</button>' +
      '<button class="btn btn-sm" onclick="acAuditCsv(this)">' + esc(bi('ສົ່ງອອກ CSV', 'Export CSV', 'ส่งออก CSV', 'CSV 내보내기')) + '</button>' +
    '</div>' +
  '</div>';

  const rows = _acAudit.rows.map(r =>
    '<tr>' +
      '<td class="ac-nowrap">' + esc(acTime(r.timestamp, { second: '2-digit' })) + '</td>' +
      '<td>' + esc(r.username_attempted || '—') + '</td>' +
      '<td>' + esc(acActionLabel(r.action)) + '</td>' +
      '<td>' + acResultPill(r.result) + '</td>' +
      '<td class="ac-mono">' + esc(r.ip_address || '—') + '</td>' +
      '<td class="ac-reason" title="' + esc(r.reason || '') + '">' + esc(r.reason || '—') + '</td>' +
    '</tr>').join('');

  const table = _acAudit.rows.length
    ? acTable(bi('ບັນທຶກກວດສອບ', 'Audit log', 'บันทึกตรวจสอบ', '감사 로그'),
        [bi('ເວລາ', 'Time', 'เวลา', '시각'), AC_L.user(),
         bi('ເຫດການ', 'Event', 'เหตุการณ์', '이벤트'),
         bi('ຜົນ', 'Result', 'ผลลัพธ์', '결과'), 'IP',
         bi('ລາຍລະອຽດ', 'Detail', 'รายละเอียด', '상세')], rows)
    : acEmpty(bi('ບໍ່ພົບບັນທຶກທີ່ກົງກັບເງື່ອນໄຂ', 'No entries match those filters', 'ไม่พบบันทึกที่ตรงกับเงื่อนไข', '조건에 맞는 항목이 없습니다'));

  const pager = '<div class="ac-pager">' +
    '<span class="ac-pager-info" role="status">' + esc(
      _acAudit.total
        ? from + '–' + to + ' ' + bi('ຈາກ', 'of', 'จาก', '/ 총') + ' ' + _acAudit.total
        : bi('0 ລາຍການ', '0 entries', '0 รายการ', '0개')) + '</span>' +
    '<button class="btn btn-sm btn-ghost" onclick="acAuditPage(-1)"' +
      (_acAudit.offset <= 0 ? ' disabled' : '') + ' aria-label="' +
      esc(bi('ໜ້າກ່ອນ', 'Previous page', 'หน้าก่อน', '이전 페이지')) + '">&#8592;</button>' +
    '<button class="btn btn-sm btn-ghost" onclick="acAuditPage(1)"' +
      (to >= _acAudit.total ? ' disabled' : '') + ' aria-label="' +
      esc(bi('ໜ້າຕໍ່ໄປ', 'Next page', 'หน้าต่อไป', '다음 페이지')) + '">&#8594;</button>' +
  '</div>';

  /* ── Integrity checker (P4.6) ──
   * Placed in the Audit pane, not only in the overview: this is where an auditor
   * already is when the question "can I trust these rows?" comes up. */
  const integrityBar = '<div class="ac-actions-bar">' +
    '<button class="btn btn-sm" onclick="acCheckAuditIntegrity(this)">' +
      esc(bi('ກວດສອບຄວາມຖືກຕ້ອງ', 'Check integrity', 'ตรวจสอบความถูกต้อง', '무결성 확인')) + '</button>' +
    '<span class="ac-note-inline" id="ac-integrity-result">' + esc(bi(
      'ຢືນຢັນວ່າບໍ່ມີແຖວໃດຖືກແກ້ ຫຼື ລຶບ',
      'Confirms no row has been edited or removed',
      'ยืนยันว่าไม่มีแถวใดถูกแก้หรือลบ',
      '어떤 행도 수정·삭제되지 않았음을 확인')) + '</span>' +
  '</div>';

  return filters + '<div class="set-card ac-card">' + table + pager + '</div>' +
    integrityBar +
    '<p class="ac-note">' + esc(bi(
      'ບັນທຶກນີ້ເພີ່ມຢ່າງດຽວ ແລະ ແຕ່ລະແຖວມີ HMAC ຕໍ່ກັບແຖວກ່ອນ — ການແກ້ ຫຼື ລຶບຈະຖືກຈັບໄດ້',
      'This log is append-only, and each row carries an HMAC over the one before it — an edit or a deletion is detectable.',
      'บันทึกนี้เพิ่มอย่างเดียว และแต่ละแถวมี HMAC ต่อกับแถวก่อนหน้า — การแก้หรือลบจะถูกตรวจจับได้',
      '이 로그는 추가 전용이며 각 행이 이전 행에 대한 HMAC을 포함합니다 — 수정·삭제가 감지됩니다')) + '</p>';
}

/**
 * Run the chain verification and report it in place.
 *
 * The result is deliberately blunt. An integrity check that says "some issues
 * were found" teaches people to ignore it; this one names the row and says
 * whether anything accounts for it.
 */
async function acCheckAuditIntegrity(btn) {
  const out = document.getElementById('ac-integrity-result');
  if (btn) btn.disabled = true;
  if (out) out.textContent = bi('ກຳລັງກວດສອບ…', 'Checking…', 'กำลังตรวจสอบ…', '확인 중…');
  try {
    const r = await DB.auditIntegrity();
    if (!out) return;
    if (r.available === false) {
      out.innerHTML = acPill('warning', bi('ກວດບໍ່ໄດ້', 'Unavailable', 'ตรวจไม่ได้', '확인 불가')) +
        ' ' + esc(r.error || '');
    } else if (r.ok) {
      out.innerHTML = acPill('good', bi('ບໍ່ຖືກແກ້ໄຂ', 'Unaltered', 'ไม่ถูกแก้ไข', '변경 없음')) + ' ' +
        esc(r.verified + ' / ' + r.rows + ' ' +
            bi('ແຖວຢືນຢັນ', 'rows verified', 'แถวยืนยัน', '행 검증') + ' · ' + r.durationMs + ' ms' +
            (r.baselineThrough != null
              ? ' · ' + bi('ເສັ້ນຖານ ≤ ', 'baseline ≤ ', 'เส้นฐาน ≤ ', '기준선 ≤ ') + r.baselineThrough
              : ''));
    } else {
      out.innerHTML = acPill('critical', bi('ຖືກແກ້ໄຂ', 'ALTERED', 'ถูกแก้ไข', '변경됨')) +
        ' ' + esc(bi('ແຖວ ', 'row ', 'แถว ', '행 ') + r.brokenAtId + ' — ' + (r.brokenReason || ''));
    }
  } catch (e) {
    if (out) out.textContent = bi('ກວດສອບບໍ່ສຳເລັດ', 'Check failed', 'ตรวจสอบไม่สำเร็จ', '확인 실패');
  }
  if (btn) btn.disabled = false;
  _acOverview = null;    // the overview's integrity card is now stale
}

function acResultLabel(r) {
  return { SUCCESS: bi('ສຳເລັດ', 'Success', 'สำเร็จ', '성공'),
           FAILURE: bi('ລົ້ມເຫລວ', 'Failure', 'ล้มเหลว', '실패'),
           LOCKED:  bi('ຖືກລັອກ', 'Locked', 'ถูกล็อก', '잠김') }[r] || r;
}

/**
 * Export the CURRENT FILTER as CSV — every matching row, not just the page on
 * screen. An auditor asked for "the failed logins in March" wants all of them;
 * exporting 50 of 4 000 without saying so would be quietly wrong.
 *
 * Capped at 5 000 rows per request and fetched in pages, so a large export
 * cannot hold the server in one query.
 */
async function acAuditCsv(btn) {
  if (btn) btn.disabled = true;
  try {
    /* Recorded like any other export (P4.5). Exporting the audit trail is itself
     * an auditable act — an investigator taking a copy of the evidence is
     * exactly the kind of thing the trail should show. */
    const receipt = await DB.recordExport('audit', 'audit-log', _acAudit.total);
    if (!receipt) {
      toast(bi('ຖືກປະຕິເສດ', 'Refused', 'ถูกปฏิเสธ', '거부됨'), 'warn');
      if (btn) btn.disabled = false;
      return;
    }
    const MAX = 5000, PAGE = 500;
    const all = [];
    for (let off = 0; off < Math.min(_acAudit.total, MAX); off += PAGE) {
      const p = await DB.auditLog(Object.assign({ limit: PAGE, offset: off }, _acAudit.filters));
      all.push(...p.rows);
      if (!p.rows.length) break;
    }
    const head = ['timestamp', 'username', 'action', 'result', 'ip', 'user_agent', 'reason'];
    /* Quoting AND formula-neutralising now live in the shared writer, so the
     * worker exports get the same protection this one always had — see
     * infra/csv.js. */
    const cell = KDCsv.cell;
    /* Watermarked (P4.6). An audit-log export is evidence — it may end up in a
     * compliance pack or an incident report — so the file states which export
     * produced it, for whom and when. The same id is in the DATA_EXPORT row, so
     * a copy can be matched back to the trail. */
    const stamp = (receipt && receipt.exportId)
      ? ['# ' + receipt.watermark, '# rows=' + all.length + ' of ' + _acAudit.total]
          .map(cell).join('\r\n') + '\r\n'
      : '';
    const csv = stamp + [head.join(',')].concat(all.map(r => [
      r.timestamp, r.username_attempted, r.action, r.result, r.ip_address, r.user_agent, r.reason,
    ].map(cell).join(','))).join('\r\n');

    // BOM so Excel opens UTF-8 correctly — Lao/Thai/Korean reasons otherwise
    // arrive as mojibake. Out through app.js's single export exit, like every
    // other generated file.
    _emitExport(KDCsv.BOM + csv,
                'kd-audit-log-' + new Date().toISOString().slice(0, 10) + '.csv',
                'text/csv;charset=utf-8');
    toast(bi('ສົ່ງອອກ ', 'Exported ', 'ส่งออก ', '내보냄 ') + all.length +
      (_acAudit.total > MAX ? ' / ' + _acAudit.total + ' (max ' + MAX + ')' : ''), 'ok');
  } catch (e) {
    toast(bi('ສົ່ງອອກບໍ່ສຳເລັດ', 'Export failed', 'ส่งออกไม่สำเร็จ', '내보내기 실패'), 'warn');
  }
  if (btn) btn.disabled = false;
}

/* ══════════════════════════════════════════════════════════════════
 * TASK 7 — Roles & Permissions matrix
 * ══════════════════════════════════════════════════════════════════ */

let _acMatrix = null, _acEditRole = null, _acDraftGrants = null;

function acResourceGroupLabel(key) {
  return {
    records:   bi('ຂໍ້ມູນແຮງງານ', 'Worker records', 'ข้อมูลแรงงาน', '근로자 기록'),
    documents: bi('ເອກະສານ', 'Documents', 'เอกสาร', '문서'),
    insights:  bi('ລາຍງານ & ສົ່ງອອກ', 'Reports & export', 'รายงาน & ส่งออก', '보고서 & 내보내기'),
    data:      bi('ຂໍ້ມູນ & ສຳຮອງ', 'Data & backups', 'ข้อมูล & สำรอง', '데이터 & 백업'),
    access:    bi('ຜູ້ໃຊ້ & ບົດບາດ', 'Users & roles', 'ผู้ใช้ & บทบาท', '사용자 & 역할'),
    security:  bi('ຄວາມປອດໄພ', 'Security', 'ความปลอดภัย', '보안'),
    system:    bi('ລະບົບ', 'System', 'ระบบ', '시스템'),
    other:     bi('ອື່ນໆ', 'Other', 'อื่นๆ', '기타'),
  }[key] || key;
}

function acScopeLabel(scope) {
  return {
    all:  bi('ທັງໝົດ', 'All', 'ทั้งหมด', '전체'),
    team: bi('ທີມ', 'Team', 'ทีม', '팀'),
    own:  bi('ຂອງຕົນ', 'Own', 'ของตนเอง', '본인'),
  }[scope] || scope;
}

async function renderRolesPane(force) {
  if (!acCan('user.view')) { acFill('set-roles-body', acError({ status: 403 })); return; }
  await acRender('set-roles-body', async () => {
    if (force || !_acMatrix) _acMatrix = await DB.roleMatrix();
    return acMatrixHtml();
  });
}

function acMatrixHtml() {
  const { roles, permissions, matrix } = _acMatrix;
  const canManage = acCan('role.manage');
  const editing = _acEditRole;

  /* Legacy roles are shown only when somebody still holds one. Once the last
   * account has moved off, the column disappears on its own. */
  const shown = roles.filter(r => !r.is_legacy || r.user_count > 0);

  const summary = '<div class="ac-cards">' + shown.map(r =>
    '<div class="ac-stat ac-role-card' + (r.is_legacy ? ' ac-role-legacy' : '') + '">' +
      '<div class="ac-stat-label">' + esc(acRoleName(r.key, r.name)) +
        (r.is_legacy ? ' ' + acPill('info', bi('ເກົ່າ', 'legacy', 'เดิม', '구')) : '') +
        (r.is_system ? '' : ' ' + acPill('good', bi('ກຳນົດເອງ', 'custom', 'กำหนดเอง', '사용자 정의'))) + '</div>' +
      '<div class="ac-stat-value">' + r.permission_count + '</div>' +
      '<div class="ac-stat-hint">' + esc(
        bi('ສິດ', 'permissions', 'สิทธิ์', '권한') + ' · ' +
        r.user_count + ' ' + bi('ບັນຊີ', 'accounts', 'บัญชี', '계정') + ' · ' +
        (r.mfa === 'required' ? bi('ບັງຄັບ MFA', 'MFA required', 'บังคับ MFA', 'MFA 필수')
                              : bi('MFA ບໍ່ບັງຄັບ', 'MFA optional', 'MFA ไม่บังคับ', 'MFA 선택'))) + '</div>' +
      (canManage && !r.is_system
        ? '<div class="ac-role-actions">' +
            '<button class="btn btn-sm" onclick="acEditRoleGrants(\'' + esc(r.key) + '\')">' +
              esc(bi('ແກ້ໄຂສິດ', 'Edit permissions', 'แก้ไขสิทธิ์', '권한 편집')) + '</button>' +
            (r.user_count ? '' : '<button class="btn btn-sm btn-danger" onclick="acDeleteRole(\'' + esc(r.key) + '\')">' +
              esc(bi('ລຶບ', 'Delete', 'ลบ', '삭제')) + '</button>') +
          '</div>'
        : '') +
    '</div>').join('') + '</div>';

  // Group the catalogue so the matrix reads as a document, not a wall of keys.
  const groups = {};
  permissions.forEach(p => {
    const g = acGroupOf(p.resource);
    (groups[g] = groups[g] || []).push(p);
  });
  const order = ['records', 'documents', 'insights', 'data', 'access', 'security', 'system', 'other'];

  const header = '<tr><th scope="col">' + esc(bi('ສິດ', 'Permission', 'สิทธิ์', '권한')) + '</th>' +
    shown.map(r => '<th scope="col" class="ac-th-role' + (editing === r.key ? ' ac-th-editing' : '') + '">' +
      esc(acRoleName(r.key, r.name)) + '</th>').join('') + '</tr>';

  const body = order.filter(g => groups[g]).map(g =>
    '<tr class="ac-group-row"><th scope="rowgroup" colspan="' + (shown.length + 1) + '">' +
      esc(acResourceGroupLabel(g)) + '</th></tr>' +
    groups[g].map(p =>
      '<tr>' +
        '<th scope="row" class="ac-perm">' +
          '<span class="ac-perm-desc">' + esc(p.description || p.key) + '</span>' +
          '<span class="ac-perm-key ac-mono">' + esc(p.key) + '</span>' +
          (p.is_sensitive ? ' ' + acPill('warning', bi('ອ່ອນໄຫວ', 'sensitive', 'อ่อนไหว', '민감')) : '') +
        '</th>' +
        shown.map(r => acMatrixCell(r, p, editing === r.key)).join('') +
      '</tr>').join('')).join('');

  const editBar = editing
    ? '<div class="ac-actions-bar ac-sticky">' +
        '<strong>' + esc(bi('ກຳລັງແກ້ໄຂ', 'Editing', 'กำลังแก้ไข', '편집 중') + ': ' +
          acRoleName(editing, editing)) + '</strong>' +
        '<button class="btn btn-primary" onclick="acSaveRoleGrants(this)">' + esc(AC_L.save()) + '</button>' +
        '<button class="btn btn-ghost" onclick="acCancelRoleEdit()">' + esc(AC_L.cancel()) + '</button>' +
      '</div>'
    : '';

  const newRole = canManage && !editing
    ? '<div class="ac-actions-bar">' +
        '<button class="btn btn-add btn-sm" onclick="acNewRole()">' +
          esc(bi('ສ້າງບົດບາດໃໝ່', 'Create role', 'สร้างบทบาทใหม่', '역할 만들기')) + '</button>' +
      '</div>'
    : '';

  const note = '<p class="ac-note">' + esc(bi(
    'ບົດບາດຂອງລະບົບຖືກຕັ້ງຄ່າຈາກລະຫັດ ແລະ ຖືກຊິງຄ໌ຄືນທຸກຄັ້ງທີ່ເປີດເຊີບເວີ — ຈຶ່ງແກ້ບໍ່ໄດ້ຢູ່ນີ້. ສ້າງບົດບາດຂອງທ່ານເອງເພື່ອກຳນົດສິດຕາມຕ້ອງການ.',
    'System roles are defined in code and re-synchronised on every server start, so they cannot be edited here — that edit would be silently reverted. Create your own role to define a custom set.',
    'บทบาทของระบบถูกกำหนดจากโค้ดและซิงค์ใหม่ทุกครั้งที่เปิดเซิร์ฟเวอร์ จึงแก้ไม่ได้ที่นี่ สร้างบทบาทของคุณเองเพื่อกำหนดสิทธิ์ตามต้องการ',
    '시스템 역할은 코드에 정의되어 서버 시작 시마다 재동기화되므로 여기서 편집할 수 없습니다. 사용자 정의 역할을 만드세요.')) + '</p>';

  return summary + editBar + newRole +
    '<div class="set-card ac-card">' +
      '<div class="ac-scroll ac-matrix-scroll"><table class="ac-table ac-matrix">' +
        '<caption class="sr-only">' + esc(bi('ຕາຕະລາງບົດບາດ × ສິດ', 'Role by permission matrix', 'ตารางบทบาท × สิทธิ์', '역할 × 권한 매트릭스')) + '</caption>' +
        '<thead>' + header + '</thead><tbody>' + body + '</tbody>' +
      '</table></div>' +
    '</div>' + note;
}

/** Mirror of rbac.RESOURCE_GROUPS, used only for display grouping. */
function acGroupOf(resource) {
  const groups = {
    records:   ['employee', 'passport', 'group', 'ocr'],
    documents: ['document'],
    insights:  ['report', 'dashboard', 'export'],
    data:      ['trash', 'backup', 'database', 'import'],
    access:    ['user', 'role'],
    security:  ['audit', 'security', 'mfa'],
    system:    ['settings'],
  };
  for (const k of Object.keys(groups)) if (groups[k].includes(resource)) return k;
  return 'other';
}

function acMatrixCell(role, perm, editable) {
  const scope = editable
    ? (_acDraftGrants[perm.key] || '')
    : ((_acMatrix.matrix[role.key] || {})[perm.key] || '');

  if (!editable) {
    return '<td class="ac-cell">' + (scope
      ? '<span class="ac-grant ac-grant-' + esc(scope) + '" title="' + esc(acScopeLabel(scope)) + '">' +
          '<span aria-hidden="true">&#10003;</span>' +
          '<span class="sr-only">' + esc(acScopeLabel(scope)) + '</span>' +
          (scope !== 'all' ? '<em>' + esc(acScopeLabel(scope)) + '</em>' : '') +
        '</span>'
      : '<span class="ac-nogrant" aria-label="' + esc(bi('ບໍ່ໄດ້ໃຫ້', 'not granted', 'ไม่ได้ให้', '미부여')) + '">–</span>') + '</td>';
  }

  return '<td class="ac-cell">' +
    '<select class="ac-scope-select" aria-label="' + esc(perm.key + ' — ' + acRoleName(role.key, role.name)) + '"' +
      ' onchange="acSetDraftGrant(\'' + esc(perm.key) + '\', this.value)">' +
      '<option value=""' + (scope ? '' : ' selected') + '>–</option>' +
      ['all', 'team', 'own'].map(s => '<option value="' + s + '"' +
        (scope === s ? ' selected' : '') + '>' + esc(acScopeLabel(s)) + '</option>').join('') +
    '</select></td>';
}

function acSetDraftGrant(permKey, scope) {
  if (scope) _acDraftGrants[permKey] = scope;
  else delete _acDraftGrants[permKey];
}

function acEditRoleGrants(key) {
  _acEditRole = key;
  _acDraftGrants = Object.assign({}, _acMatrix.matrix[key] || {});
  acFill('set-roles-body', acMatrixHtml());
}

function acCancelRoleEdit() {
  _acEditRole = null; _acDraftGrants = null;
  acFill('set-roles-body', acMatrixHtml());
}

async function acSaveRoleGrants(btn) {
  if (!_acEditRole) return;
  const grants = Object.keys(_acDraftGrants).map(k => [k, _acDraftGrants[k]]);
  if (btn) btn.disabled = true;
  try {
    await DB.setRoleGrants(_acEditRole, grants);
    toast(AC_L.saved(), 'ok');
    _acEditRole = null; _acDraftGrants = null; _acMatrix = null;
    renderRolesPane(true);
  } catch (e) {
    const err = e && e.body && e.body.error;
    toast(err === 'system-role'
      ? bi('ບົດບາດຂອງລະບົບແກ້ບໍ່ໄດ້', 'System roles cannot be edited', 'บทบาทของระบบแก้ไม่ได้', '시스템 역할은 편집할 수 없습니다')
      : bi('ບັນທຶກບໍ່ສຳເລັດ', 'Could not save', 'บันทึกไม่สำเร็จ', '저장하지 못했습니다'), 'warn');
    if (btn) btn.disabled = false;
  }
}

/**
 * Create a custom role.
 *
 * Starts with NO permissions. A new role that inherited a template would be a
 * privilege guess; starting empty forces the operator to say what it may do.
 */
function acNewRole() {
  acPrompt(bi('ສ້າງບົດບາດໃໝ່', 'Create role', 'สร้างบทบาทใหม่', '역할 만들기'),
    bi('ຊື່ບົດບາດ ເຊັ່ນ “ຜູ້ກວດພາຍນອກ”. ບົດບາດໃໝ່ເລີ່ມຕົ້ນໂດຍບໍ່ມີສິດໃດເລີຍ — ເລືອກສິດຫຼັງຈາກສ້າງ.',
       'A name, e.g. "External reviewer". A new role starts with no permissions at all — grant them after creating it.',
       'ชื่อบทบาท เช่น “ผู้ตรวจภายนอก” บทบาทใหม่เริ่มต้นโดยไม่มีสิทธิ์ใดเลย — เลือกสิทธิ์หลังจากสร้าง',
       '역할 이름 (예: "외부 검토자"). 새 역할은 권한이 전혀 없는 상태로 시작합니다.'),
    async (name) => {
      if (!name) return;
      const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
      if (key.length < 2) {
        toast(bi('ຊື່ສັ້ນເກີນໄປ', 'Name too short', 'ชื่อสั้นเกินไป', '이름이 너무 짧습니다'), 'warn');
        return;
      }
      try {
        /* rank 100 puts a custom role below every system role, so it can never
         * be used to sidestep the rank invariant on user creation. mfa
         * 'required' because a role nobody has thought about yet should be the
         * safe one, not the convenient one. */
        await DB.createRole({ key, name, rank: 100, mfa: 'required', permissions: [] });
        toast(bi('ສ້າງແລ້ວ', 'Created', 'สร้างแล้ว', '생성됨'), 'ok');
        _acMatrix = null;
        await renderRolesPane(true);
        acEditRoleGrants(key);
      } catch (e) {
        const err = e && e.body && e.body.error;
        toast(err === 'dup'
          ? bi('ມີບົດບາດຊື່ນີ້ແລ້ວ', 'That role already exists', 'มีบทบาทชื่อนี้แล้ว', '이미 존재하는 역할입니다')
          : err === 'rank-violation'
            ? acUserError('rank-violation')
            : bi('ສ້າງບໍ່ສຳເລັດ', 'Could not create', 'สร้างไม่สำเร็จ', '만들지 못했습니다'), 'warn');
      }
    });
}

function acDeleteRole(key) {
  showConfirm(bi('ລຶບບົດບາດ', 'Delete role', 'ลบบทบาท', '역할 삭제'),
    bi('ລຶບບົດບາດ “' + acRoleName(key, key) + '” ຖາວອນ',
       'Permanently delete the role "' + acRoleName(key, key) + '".',
       'ลบบทบาท “' + acRoleName(key, key) + '” ถาวร',
       '역할 "' + acRoleName(key, key) + '"을(를) 영구 삭제합니다.'),
    async () => {
      try {
        await DB.deleteRole(key);
        toast(bi('ລຶບແລ້ວ', 'Deleted', 'ลบแล้ว', '삭제됨'), 'ok');
        _acMatrix = null;
        renderRolesPane(true);
      } catch (e) {
        const err = e && e.body && e.body.error;
        toast(err === 'role-in-use'
          ? bi('ຍັງມີບັນຊີໃຊ້ບົດບາດນີ້ຢູ່', 'Accounts still hold this role', 'ยังมีบัญชีใช้บทบาทนี้อยู่', '이 역할을 사용하는 계정이 있습니다')
          : err === 'system-role'
            ? bi('ບົດບາດຂອງລະບົບລຶບບໍ່ໄດ້', 'System roles cannot be deleted', 'บทบาทของระบบลบไม่ได้', '시스템 역할은 삭제할 수 없습니다')
            : bi('ລຶບບໍ່ສຳເລັດ', 'Could not delete', 'ลบไม่สำเร็จ', '삭제하지 못했습니다'), 'warn');
      }
    });
}

/* ══════════════════════════════════════════════════════════════════
 * TASK 8 — Backup centre
 * ══════════════════════════════════════════════════════════════════ */

async function renderBackupPane(force) {
  const cards = document.getElementById('set-backup-cards');
  const hist  = document.getElementById('set-backup-history');
  if (!cards || !hist) return;
  /* Every other pane renders the refusal; this one used to `return` and leave the
   * section blank, which reads as a broken screen rather than a withheld one. */
  if (!acCan('backup.create')) {
    cards.innerHTML = '';
    hist.innerHTML = acError({ status: 403 });
    return;
  }
  hist.innerHTML = acLoading();

  try {
    const inv = await DB.backupInventory();
    const health = inv.health || await DB.backupHealth();
    const entries = inv.inventory;

    /* ── Recoverability, stated first and stated plainly (Phase 7) ──
     * This banner exists because of the finding that opened P5.1: the old pane
     * showed a healthy-looking "Last backup" for a snapshot that could not
     * recover a single passport scan. The score answers the only question that
     * matters — if this machine died now, how much comes back? */
    cards.innerHTML = acBackupHealthHtml(health);

    const canRestore = acCan('backup.restore');
    const canOffsite = health.offsiteConfigured;

    const rows = entries.map(e => {
      const isFull = e.kind === 'full';
      const vs = e.verification;
      const off = e.offsite;
      const rowId = 'ac-verify-' + e.file.replace(/[^a-zA-Z0-9]/g, '_');
      return '<tr>' +
        '<td>' +
          (isFull
            ? acPill('good', bi('ລະບົບເຕັມ', 'Full system', 'ระบบเต็ม', '전체 시스템'))
            : acPill('warning', bi('ຖານຂໍ້ມູນເທົ່ານັ້ນ', 'Database only', 'ฐานข้อมูลเท่านั้น', '데이터베이스만'))) +
          '<div class="ac-mono ac-file">' + esc(e.file) + '</div>' +
          (isFull && e.manifestSummary
            ? '<div class="ac-muted ac-small">' + esc(
                (e.manifestSummary.upload_files || 0) + ' ' + bi('ໄຟລ໌', 'files', 'ไฟล์', '파일') +
                ' · ' + acBytes(e.manifestSummary.uploads_size || 0) +
                (e.manifestSummary.key_present ? ' · ' + bi('ມີກຸນແຈ', 'key', 'มีกุญแจ', '키 포함') : '')) + '</div>'
            : '') +
        '</td>' +
        '<td>' + esc(acTime(e.createdAt)) +
          '<div class="ac-muted ac-small">' + esc(e.createdBy || bi('ບໍ່ຮູ້', 'unknown', 'ไม่ทราบ', '알 수 없음')) +
          (e.reason && e.reason !== 'manual' ? ' · ' + esc(e.reason) : '') + '</div></td>' +
        '<td class="ac-num">' + esc(acBytes(e.size)) + '</td>' +
        '<td>' + (vs
            ? acPill(vs.status === 'fully-recoverable' ? 'good'
                   : vs.status === 'partially-recoverable' ? 'warning' : 'critical',
                     vs.status === 'fully-recoverable' ? bi('ກູ້ຄືນໄດ້ເຕັມ', 'Full', 'กู้คืนได้เต็ม', '완전')
                   : vs.status === 'partially-recoverable' ? bi('ບາງສ່ວນ', 'Partial', 'บางส่วน', '부분')
                   : bi('ເສຍຫາຍ', 'Corrupt', 'เสียหาย', '손상')) +
              '<div class="ac-muted ac-small">' + esc(acAgo(vs.at)) + '</div>'
            : acPill('info', bi('ຍັງບໍ່ກວດ', 'Not verified', 'ยังไม่ตรวจ', '미검증'))) + '</td>' +
        '<td>' + (off
            ? acPill(off.status === 'verified' ? 'good' : 'critical',
                     off.status === 'verified' ? bi('ຢູ່ນອກເຄື່ອງ', 'Offsite', 'อยู่นอกเครื่อง', '오프사이트')
                                              : bi('ລົ້ມເຫລວ', 'Failed', 'ล้มเหลว', '실패')) +
              '<div class="ac-muted ac-small">' + esc(acAgo(off.at)) + '</div>'
            : acPill('info', bi('ໃນເຄື່ອງເທົ່ານັ້ນ', 'Local only', 'ในเครื่องเท่านั้น', '로컬만'))) + '</td>' +
        '<td class="ac-actions">' +
          '<button class="btn btn-sm" onclick="acVerifyBackup(\'' + esc(e.file) + '\', this)">' +
            esc(bi('ກວດສອບ', 'Verify', 'ตรวจสอบ', '검증')) + '</button>' +
          (isFull
            ? ' <button class="btn btn-sm btn-ghost" onclick="acVerifyBackup(\'' + esc(e.file) + '\', this, true)" title="' +
                esc(bi('ກວດທຸກໄຟລ໌ (ຊ້າ)', 'Check every file (slow)', 'ตรวจทุกไฟล์ (ช้า)', '모든 파일 검사 (느림)')) + '">' +
                esc(bi('ກວດເລິກ', 'Deep', 'ตรวจลึก', '정밀')) + '</button>'
            : '') +
          ' <a class="btn btn-sm" href="' + esc(DB.backupUrl(e.file)) + '" download>' +
            esc(bi('ດາວໂຫລດ', 'Download', 'ดาวน์โหลด', '다운로드')) + '</a>' +
          (canOffsite
            ? ' <button class="btn btn-sm" onclick="acUploadOffsite(\'' + esc(e.file) + '\', this)">' +
                esc(bi('ສົ່ງອອກນອກເຄື່ອງ', 'Send offsite', 'ส่งออกนอกเครื่อง', '오프사이트 전송')) + '</button>'
            : '') +
          (canRestore
            ? ' <button class="btn btn-sm btn-danger" onclick="' +
                (isFull ? 'acPreviewPackageRestore' : 'acPreviewRestore') +
                '(\'' + esc(e.file) + '\')">' +
                esc(bi('ກູ້ຄືນ', 'Restore', 'กู้คืน', '복원')) + '</button>'
            : '') +
        '</td>' +
      '</tr>' +
      '<tr class="ac-verify-row" id="' + rowId + '" hidden><td colspan="6"></td></tr>';
    }).join('');

    hist.innerHTML = (entries.length
      ? acTable(bi('ປະຫວັດການສຳຮອງ', 'Backup history', 'ประวัติการสำรอง', '백업 기록'),
          [bi('ຊະນິດ / ໄຟລ໌', 'Kind / file', 'ชนิด / ไฟล์', '종류 / 파일'),
           bi('ວັນທີ', 'Date', 'วันที่', '날짜'),
           bi('ຂະໜາດ', 'Size', 'ขนาด', '크기'),
           bi('ການກວດສອບ', 'Verified', 'การตรวจสอบ', '검증'),
           bi('ນອກເຄື່ອງ', 'Offsite', 'นอกเครื่อง', '오프사이트'),
           AC_L.actions()], rows)
      : acEmpty(bi('ຍັງບໍ່ມີໄຟລ໌ສຳຮອງ', 'No backups yet', 'ยังไม่มีไฟล์สำรอง', '백업이 없습니다')))
      + acRetentionHtml(health);
  } catch (e) {
    hist.innerHTML = acError(e);
    cards.innerHTML = '';
  }
}

/* ══════════════════════════════════════════════════════════════════
 * P5.1 — backup health, offsite, retention, package restore
 * ══════════════════════════════════════════════════════════════════ */

/** Human text for a backup-health finding. Key + value, never a server sentence. */
function acBackupFinding(f) {
  const n = f.detail == null ? '' : f.detail;
  return {
    no_backup_at_all: bi(
      'ບໍ່ມີໄຟລ໌ສຳຮອງເລີຍ',
      'There is no backup of any kind',
      'ไม่มีไฟล์สำรองเลย',
      '어떤 종류의 백업도 없습니다'),
    no_full_backup: bi(
      'ມີແຕ່ snapshot ຖານຂໍ້ມູນ (' + n + ') — ຮູບເອກະສານບໍ່ໄດ້ຮັບການປົກປ້ອງ',
      'Only database snapshots exist (' + n + ') — no document image is protected',
      'มีแต่ snapshot ฐานข้อมูล (' + n + ') — รูปเอกสารไม่ได้รับการป้องกัน',
      '데이터베이스 스냅샷만 존재 (' + n + '개) — 문서 이미지는 보호되지 않음'),
    full_backup_stale: bi(
      'ສຳຮອງລະບົບເຕັມຫຼ້າສຸດ ' + n + ' ວັນກ່ອນ',
      'The last full-system backup was ' + n + ' days ago',
      'สำรองระบบเต็มล่าสุด ' + n + ' วันก่อน',
      '마지막 전체 백업이 ' + n + '일 전'),
    full_backup_ageing: bi(
      'ສຳຮອງລະບົບເຕັມຫຼ້າສຸດ ' + n + ' ວັນກ່ອນ',
      'Last full-system backup was ' + n + ' days ago',
      'สำรองระบบเต็มล่าสุด ' + n + ' วันก่อน',
      '마지막 전체 백업 ' + n + '일 전'),
    never_verified: bi(
      'ບໍ່ເຄີຍກວດສອບໄຟລ໌ສຳຮອງໃດເລີຍ',
      'No backup has ever been verified',
      'ไม่เคยตรวจสอบไฟล์สำรองใดเลย',
      '검증된 백업이 없습니다'),
    verification_ageing: bi(
      'ກວດສອບຫຼ້າສຸດ ' + n + ' ວັນກ່ອນ',
      'Last verification was ' + n + ' days ago',
      'ตรวจสอบล่าสุด ' + n + ' วันก่อน',
      '마지막 검증 ' + n + '일 전'),
    no_offsite_copy: bi(
      'ບໍ່ມີສຳເນານອກເຄື່ອງ — ດິສກ໌ເສຍຄັ້ງດຽວເສຍທັງໝົດ',
      'No offsite copy — one disk failure loses everything, backups included',
      'ไม่มีสำเนานอกเครื่อง — ดิสก์เสียครั้งเดียวเสียทั้งหมด',
      '오프사이트 사본 없음 — 디스크 하나가 고장나면 백업까지 모두 손실'),
    offsite_stale: bi(
      'ສຳເນານອກເຄື່ອງຫຼ້າສຸດ ' + n + ' ວັນກ່ອນ',
      'Last offsite copy was ' + n + ' days ago',
      'สำเนานอกเครื่องล่าสุด ' + n + ' วันก่อน',
      '마지막 오프사이트 사본 ' + n + '일 전'),
  }[f.key] || (f.key + (n ? ' (' + n + ')' : ''));
}

function acBackupHealthHtml(h) {
  const levelText = {
    healthy:  bi('ພ້ອມກູ້ຄືນ', 'Recoverable', 'พร้อมกู้คืน', '복구 가능'),
    warning:  bi('ຄວນລະວັງ', 'Needs attention', 'ควรระวัง', '주의 필요'),
    critical: bi('ກູ້ຄືນບໍ່ໄດ້ເຕັມ', 'Not fully recoverable', 'กู้คืนไม่ได้เต็ม', '완전 복구 불가'),
  }[h.level] || h.level;

  const banner =
    '<div class="ac-risk ac-' + (h.level === 'healthy' ? 'excellent' : h.level) + '">' +
      '<div class="ac-risk-dial" role="img" aria-label="' +
        esc(bi('ຄະແນນການກູ້ຄືນ', 'Recoverability score', 'คะแนนการกู้คืน', '복구 점수') +
            ' ' + h.score + '/100') + '">' +
        '<span class="ac-risk-score">' + h.score + '</span><span class="ac-risk-max">/100</span>' +
      '</div>' +
      '<div class="ac-risk-text">' +
        '<div class="ac-risk-level">' + esc(levelText) + '</div>' +
        '<div class="ac-risk-sub">' + esc(bi(
          'ຖ້າເຄື່ອງນີ້ເສຍຫາຍຕອນນີ້ — ຈະກູ້ຄືນໄດ້ເທົ່າໃດ',
          'If this machine were lost right now, how much would come back',
          'ถ้าเครื่องนี้เสียหายตอนนี้ — จะกู้คืนได้เท่าใด',
          '지금 이 컴퓨터를 잃는다면 얼마나 복구되는가')) + '</div>' +
      '</div>' +
    '</div>';

  const cards = '<div class="ac-cards">' +
    acCard(bi('ສຳຮອງລະບົບເຕັມ', 'Full-system backup', 'สำรองระบบเต็ม', '전체 시스템 백업'),
           h.lastFullBackup ? acAgo(h.lastFullBackup.at) : bi('ບໍ່ມີ', 'None', 'ไม่มี', '없음'),
           h.lastFullBackup ? acBytes(h.lastFullBackup.size) : bi('ຮູບບໍ່ຖືກປົກປ້ອງ', 'images unprotected', 'รูปไม่ถูกป้องกัน', '이미지 미보호'),
           h.lastFullBackup ? (h.lastFullBackup.ageDays > 7 ? 'warn' : 'good') : 'bad') +
    acCard(bi('ກວດສອບຫຼ້າສຸດ', 'Last verified', 'ตรวจสอบล่าสุด', '최근 검증'),
           h.lastVerification ? acAgo(h.lastVerification.at) : bi('ບໍ່ເຄີຍ', 'Never', 'ไม่เคย', '없음'),
           h.lastVerification
             ? (h.lastVerification.deep ? bi('ກວດເລິກ', 'deep check', 'ตรวจลึก', '정밀 검사')
                                        : bi('ກວດປົກກະຕິ', 'standard check', 'ตรวจปกติ', '표준 검사'))
             : '',
           h.lastVerification ? 'good' : 'warn') +
    acCard(bi('ສຳເນານອກເຄື່ອງ', 'Offsite copy', 'สำเนานอกเครื่อง', '오프사이트 사본'),
           h.lastOffsite ? acAgo(h.lastOffsite.at) : bi('ບໍ່ມີ', 'None', 'ไม่มี', '없음'),
           h.offsiteConfigured
             ? (h.lastOffsite ? acBytes(h.lastOffsite.bytes) : bi('R2 ພ້ອມໃຊ້', 'R2 is configured', 'R2 พร้อมใช้', 'R2 구성됨'))
             : bi('R2 ຍັງບໍ່ຕັ້ງຄ່າ', 'R2 not configured', 'R2 ยังไม่ตั้งค่า', 'R2 미구성'),
           h.lastOffsite ? 'good' : 'bad') +
    acCard(bi('ຈຳນວນໄຟລ໌ສຳຮອງ', 'Backup count', 'จำนวนไฟล์สำรอง', '백업 개수'),
           h.counts.total,
           h.counts.full + ' ' + bi('ເຕັມ', 'full', 'เต็ม', '전체') + ' · ' +
           h.counts.db + ' ' + bi('ຖານຂໍ້ມູນ', 'db-only', 'ฐานข้อมูล', 'DB만')) +
    acCard(bi('ພື້ນທີ່ໄຟລ໌ສຳຮອງ', 'Backup storage', 'พื้นที่ไฟล์สำรอง', '백업 저장 공간'),
           acBytes(h.storage.backupsBytes),
           acBytes(h.storage.uploadsBytes) + ' ' + bi('ຮູບຕ້ອງປົກປ້ອງ', 'images to protect', 'รูปต้องป้องกัน', '보호할 이미지')) +
  '</div>';

  const findings = h.findings.length
    ? '<div class="ac-findings">' + h.findings.map(f =>
        '<div class="ac-finding ac-' + esc(f.level) + '">' +
          acPill(f.level, f.level === 'critical' ? bi('ວິກິດ', 'Critical', 'วิกฤต', '심각')
                        : f.level === 'warning' ? bi('ຄວນລະວັງ', 'Warning', 'ควรระวัง', '주의')
                        : bi('ຂໍ້ມູນ', 'Info', 'ข้อมูล', '정보')) +
          '<span class="ac-finding-text">' + esc(acBackupFinding(f)) + '</span>' +
        '</div>').join('') + '</div>'
    : '';

  const actions = '<div class="ac-actions-bar">' +
    '<button class="btn btn-primary" onclick="acCreateFullBackup(this)">' +
      esc(bi('ສຳຮອງລະບົບເຕັມ', 'Create full-system backup', 'สำรองระบบเต็ม', '전체 시스템 백업 생성')) + '</button>' +
    '<button class="btn btn-ghost" onclick="doBackupNow()">' +
      esc(bi('snapshot ຖານຂໍ້ມູນ', 'Database snapshot only', 'snapshot ฐานข้อมูล', '데이터베이스 스냅샷만')) + '</button>' +
    '<span class="ac-note-inline">' + esc(bi(
      'ສຳຮອງເຕັມ = ຖານຂໍ້ມູນ + ຮູບເອກະສານທັງໝົດ + ກຸນແຈບັນທຶກ. snapshot = ຖານຂໍ້ມູນເທົ່ານັ້ນ.',
      'Full = database + every document image + the audit key. Snapshot = database only.',
      'สำรองเต็ม = ฐานข้อมูล + รูปเอกสารทั้งหมด + กุญแจบันทึก · snapshot = ฐานข้อมูลเท่านั้น',
      '전체 = 데이터베이스 + 모든 문서 이미지 + 감사 키 · 스냅샷 = 데이터베이스만')) + '</span>' +
  '</div>';

  return banner + cards + findings + actions;
}

function acRetentionHtml(h) {
  if (!acCan('database.manage')) return '';
  return '<div class="set-card-label">' +
      esc(bi('ນະໂຍບາຍການເກັບຮັກສາ', 'Retention policy', 'นโยบายการเก็บรักษา', '보존 정책')) + '</div>' +
    '<div class="set-card">' +
      '<div class="set-row">' +
        '<div class="set-row-main">' +
          '<label class="set-row-label" for="ret-full">' +
            esc(bi('ເກັບສຳຮອງເຕັມ', 'Keep full-system backups', 'เก็บสำรองเต็ม', '전체 백업 보관')) + '</label>' +
          '<div class="set-row-desc">' + esc(bi(
            'ໄຟລ໌ໃໝ່ສຸດ, ໄຟລ໌ທີ່ກວດແລ້ວ ແລະ ໄຟລ໌ທີ່ມີສຳເນານອກເຄື່ອງ ຈະບໍ່ຖືກລຶບ',
            'The newest, the last verified, and the last with an offsite copy are never deleted',
            'ไฟล์ใหม่สุด ไฟล์ที่ตรวจแล้ว และไฟล์ที่มีสำเนานอกเครื่อง จะไม่ถูกลบ',
            '최신본, 마지막 검증본, 오프사이트 사본이 있는 것은 삭제되지 않습니다')) + '</div>' +
        '</div>' +
        '<div class="set-row-control ac-num-control">' +
          '<input class="set-num-input" type="number" id="ret-full" value="5" min="1" max="50">' +
          '<span class="ac-range">1–50</span>' +
        '</div>' +
      '</div>' +
      '<div class="set-row">' +
        '<div class="set-row-main">' +
          '<label class="set-row-label" for="ret-db">' +
            esc(bi('ເກັບ snapshot ຖານຂໍ້ມູນ', 'Keep database snapshots', 'เก็บ snapshot ฐานข้อมูล', 'DB 스냅샷 보관')) + '</label>' +
        '</div>' +
        '<div class="set-row-control ac-num-control">' +
          '<input class="set-num-input" type="number" id="ret-db" value="10" min="1" max="100">' +
          '<span class="ac-range">1–100</span>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="ac-actions-bar">' +
      '<button class="btn btn-ghost" onclick="acRetention(true, this)">' +
        esc(bi('ເບິ່ງກ່ອນ', 'Preview', 'ดูก่อน', '미리 보기')) + '</button>' +
      '<button class="btn btn-danger" onclick="acRetention(false, this)">' +
        esc(bi('ນຳໃຊ້', 'Apply', 'นำไปใช้', '적용')) + '</button>' +
      '<span class="ac-note-inline" id="ac-retention-result"></span>' +
    '</div>';
}

/** Create a complete system package. Slow by nature — 686 MB of images. */
async function acCreateFullBackup(btn) {
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = bi('ກຳລັງສຳຮອງ…', 'Backing up…', 'กำลังสำรอง…', '백업 중…'); }
  try {
    const r = await DB.createFullBackup('manual');
    toast(bi('ສຳຮອງເຕັມສຳເລັດ ', 'Full backup created ', 'สำรองเต็มสำเร็จ ', '전체 백업 완료 ') +
          acBytes(r.bytes) + ' · ' + (r.manifest.uploads.file_count) + ' ' +
          bi('ໄຟລ໌', 'files', 'ไฟล์', '파일'), 'ok');
    renderBackupPane(true);
  } catch (e) {
    toast(bi('ສຳຮອງບໍ່ສຳເລັດ', 'Backup failed', 'สำรองไม่สำเร็จ', '백업 실패'), 'warn');
  }
  if (btn) { btn.disabled = false; btn.textContent = label; }
}

/** Copy one backup to R2 and report the verified result. */
async function acUploadOffsite(file, btn) {
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = bi('ກຳລັງສົ່ງ…', 'Sending…', 'กำลังส่ง…', '전송 중…'); }
  try {
    const r = await DB.uploadOffsite(file);
    if (r.ok) {
      toast(bi('ສົ່ງອອກນອກເຄື່ອງແລ້ວ ', 'Copied offsite ', 'ส่งออกนอกเครื่องแล้ว ', '오프사이트 복사 완료 ') +
            acBytes(r.offsite.bytes), 'ok');
    } else {
      toast(bi('ສົ່ງບໍ່ສຳເລັດ: ', 'Offsite copy failed: ', 'ส่งไม่สำเร็จ: ', '오프사이트 복사 실패: ') +
            (r.error || (r.offsite && r.offsite.status) || ''), 'warn');
    }
    renderBackupPane(true);
  } catch (e) {
    toast(bi('ສົ່ງບໍ່ສຳເລັດ', 'Offsite copy failed', 'ส่งไม่สำเร็จ', '오프사이트 복사 실패'), 'warn');
  }
  if (btn) { btn.disabled = false; btn.textContent = label; }
}

/** Retention: preview first, then apply. */
async function acRetention(dryRun, btn) {
  const out = document.getElementById('ac-retention-result');
  const keepFull = parseInt((document.getElementById('ret-full') || {}).value, 10) || 5;
  const keepDb   = parseInt((document.getElementById('ret-db') || {}).value, 10) || 10;
  if (btn) btn.disabled = true;
  try {
    if (dryRun) {
      const r = await DB.applyRetention({ keepFull, keepDb, dryRun: true });
      if (out) out.textContent = r.candidates.length
        ? bi('ຈະລຶບ ', 'Would delete ', 'จะลบ ', '삭제 예정 ') + r.candidates.length +
          ' · ' + bi('ປົກປ້ອງໄວ້ ', 'protected ', 'ป้องกันไว้ ', '보호됨 ') + r.protected.length
        : bi('ບໍ່ມີໄຟລ໌ໃດຈະຖືກລຶບ', 'Nothing would be deleted', 'ไม่มีไฟล์ใดจะถูกลบ', '삭제할 항목 없음');
    } else {
      const r = await DB.applyRetention({ keepFull, keepDb });
      toast(bi('ລຶບແລ້ວ ', 'Deleted ', 'ลบแล้ว ', '삭제됨 ') + r.deleted.length + ' · ' +
            acBytes(r.freedBytes), 'ok');
      renderBackupPane(true);
    }
  } catch (e) {
    if (out) out.textContent = bi('ບໍ່ສຳເລັດ', 'Failed', 'ไม่สำเร็จ', '실패');
  }
  if (btn) btn.disabled = false;
}

/**
 * Preview then restore a FULL package.
 *
 * Separate from acPreviewRestore (database-only) because the decision is
 * different: this one can lose document images, and the operator has to be told
 * that in the same breath as the record counts.
 */
async function acPreviewPackageRestore(file) {
  let p;
  try { p = await DB.previewPackage(file); }
  catch (e) {
    toast(bi('ອ່ານໄຟລ໌ບໍ່ໄດ້', 'Could not read that package', 'อ่านไฟล์ไม่ได้', '패키지를 읽을 수 없습니다'), 'warn');
    return;
  }

  const label = {
    employees: bi('ແຮງງານ', 'workers', 'แรงงาน', '근로자'),
    groups: bi('ກຸ່ມ', 'groups', 'กลุ่ม', '그룹'),
    documents: bi('ເອກະສານ', 'documents', 'เอกสาร', '문서'),
    passports: bi('ພາສປອດ', 'passports', 'พาสปอร์ต', '여권'),
    users: bi('ບັນຊີ', 'accounts', 'บัญชี', '계정'),
    upload_files: bi('ໄຟລ໌ຮູບ', 'image files', 'ไฟล์รูป', '이미지 파일'),
  };
  const fmt = (obj) => Object.keys(obj).map(k => obj[k] + ' ' + (label[k] || k)).join(', ');

  const lines = [];
  lines.push(bi('ໄຟລ໌: ', 'Package: ', 'ไฟล์: ', '패키지: ') + p.file);
  if (p.createdAt) lines.push(bi('ສ້າງເມື່ອ: ', 'Taken: ', 'สร้างเมื่อ: ', '생성: ') +
    acTime(p.createdAt) + (p.createdBy ? ' · ' + p.createdBy : ''));
  lines.push(bi('ຂະໜາດ: ', 'Contents: ', 'ขนาด: ', '내용: ') +
    acBytes(p.databaseSize || 0) + ' ' + bi('ຖານຂໍ້ມູນ', 'database', 'ฐานข้อมูล', 'DB') + ' + ' +
    acBytes(p.uploadsSize || 0) + ' ' + bi('ຮູບ', 'images', 'รูป', '이미지') +
    ' (' + (p.backup.upload_files || 0) + ' ' + bi('ໄຟລ໌', 'files', 'ไฟล์', '파일') + ')');

  lines.push(p.status === 'fully-recoverable'
    ? bi('✓ ກວດສອບແລ້ວ: ກູ້ຄືນໄດ້ເຕັມ', '✓ Verified: fully recoverable', '✓ ตรวจสอบแล้ว: กู้คืนได้เต็ม', '✓ 검증됨: 완전 복구 가능')
    : p.status === 'partially-recoverable'
      ? bi('⚠ ກູ້ຄືນໄດ້ບາງສ່ວນ — ບາງໄຟລ໌ ຫຼື ຕ່ອງໂສ້ບັນທຶກບໍ່ຄົບ',
           '⚠ PARTIALLY recoverable — some files or the audit chain are incomplete',
           '⚠ กู้คืนได้บางส่วน — บางไฟล์หรือเชนบันทึกไม่ครบ',
           '⚠ 부분 복구만 가능 — 일부 파일 또는 감사 체인 불완전')
      : bi('✗ ໄຟລ໌ນີ້ເສຍຫາຍ — ກູ້ຄືນບໍ່ໄດ້', '✗ This package is CORRUPT — it cannot be restored', '✗ ไฟล์นี้เสียหาย — กู้คืนไม่ได้', '✗ 이 패키지는 손상되어 복원할 수 없습니다'));

  if (p.versionMismatch)
    lines.push(bi('ⓘ ສ້າງດ້ວຍເວີຊັນ ', 'ⓘ Written by version ', 'ⓘ สร้างด้วยเวอร์ชัน ', 'ⓘ 생성 버전 ') +
      p.appVersion + ' · ' + bi('ປັດຈຸບັນ ', 'now running ', 'ปัจจุบัน ', '현재 ') + p.currentAppVersion);
  if (Object.keys(p.willLose).length)
    lines.push(bi('ຈະສູນເສຍ: ', 'WILL LOSE: ', 'จะสูญเสีย: ', '손실됨: ') + fmt(p.willLose));
  if (Object.keys(p.willGain).length)
    lines.push(bi('ຈະໄດ້ຄືນ: ', 'WILL GAIN: ', 'จะได้คืน: ', '복원됨: ') + fmt(p.willGain));
  if (!Object.keys(p.willLose).length && !Object.keys(p.willGain).length)
    lines.push(bi('ຈຳນວນຂໍ້ມູນຄືກັນ', 'Record counts are identical', 'จำนวนข้อมูลเหมือนกัน', '레코드 수 동일'));
  if (p.auditRowsNewerThanBackup)
    lines.push(bi('ບັນທຶກກວດສອບ ' + p.auditRowsNewerThanBackup + ' ແຖວໃໝ່ກວ່າ — ຈະຖືກເກັບໄວ້',
                  p.auditRowsNewerThanBackup + ' audit events are newer than this package — they are kept',
                  'บันทึกตรวจสอบ ' + p.auditRowsNewerThanBackup + ' แถวใหม่กว่า — จะถูกเก็บไว้',
                  '감사 이벤트 ' + p.auditRowsNewerThanBackup + '건이 더 최신 — 보존됩니다'));
  lines.push(bi('ສະຖານະປັດຈຸບັນຈະຖືກສຳຮອງເຕັມກ່ອນ',
                'A full backup of the current state is taken first',
                'สถานะปัจจุบันจะถูกสำรองเต็มก่อน',
                '현재 상태의 전체 백업을 먼저 생성합니다'));
  /* Restoring replaces the `sessions` table too, so every signed-in user —
   * including the person clicking this button — is signed out unless their
   * session happens to predate the package. Observed the first time a restore was
   * driven through the UI: the operator was bounced to the sign-in page with no
   * warning, which looks exactly like a failure and is not. */
  lines.push(bi('ທຸກຄົນຈະຖືກອອກຈາກລະບົບ ລວມທັງທ່ານ — ໃຫ້ເຂົ້າສູ່ລະບົບຄືນຫຼັງຈາກນັ້ນ',
                'Everyone is signed out, including you — sign in again afterwards',
                'ทุกคนจะถูกออกจากระบบ รวมถึงคุณ — ให้เข้าสู่ระบบใหม่หลังจากนั้น',
                '본인을 포함한 모든 사용자가 로그아웃됩니다 — 이후 다시 로그인하세요'));

  if (p.status === 'corrupted') {
    showInfo(bi('ກູ້ຄືນບໍ່ໄດ້', 'Cannot restore', 'กู้คืนไม่ได้', '복원 불가'), lines.join('\n'));
    return;
  }

  showConfirm(
    bi('ກູ້ຄືນທັງລະບົບ?', 'Restore the whole system?', 'กู้คืนทั้งระบบ?', '전체 시스템을 복원할까요?'),
    lines.join('\n'),
    async () => {
      const partial = p.status === 'partially-recoverable';
      toast(bi('ກຳລັງກູ້ຄືນ…', 'Restoring…', 'กำลังกู้คืน…', '복원 중…'), 'ok');
      try {
        const r = await DB.restorePackage(file, { allowPartial: partial });
        const res = r.result;
        toast(bi('ກູ້ຄືນສຳເລັດ · ', 'Restored · ', 'กู้คืนสำเร็จ · ', '복원 완료 · ') +
              res.restored.uploadFiles + ' ' + bi('ໄຟລ໌', 'files', 'ไฟล์', '파일'), 'ok');
        closeOverlay('settings-overlay');
        /* Reload rather than refreshAll(): the restore replaced the sessions
         * table, so this browser is very probably signed out now. A reload lands
         * on the sign-in page cleanly instead of every subsequent request failing
         * with a 401 behind a UI that still looks signed in. */
        setTimeout(() => location.reload(), 1200);
      } catch (e) {
        const b = e && e.body;
        toast(bi('ກູ້ຄືນບໍ່ສຳເລັດ: ', 'Restore failed: ', 'กู้คืนไม่สำเร็จ: ', '복원 실패: ') +
              ((b && (b.reason || b.error)) || ''), 'warn');
      }
    });
}

/* ── Backup verification (P4.6) ────────────────────────────────────
 * Answers "is this file actually restorable?" before the day somebody needs it
 * to be. The check runs server-side against a read-only handle, so it cannot
 * damage the artefact it is examining.
 */
async function acVerifyBackup(file, btn, deep) {
  const row = document.getElementById('ac-verify-' + file.replace(/[^a-zA-Z0-9]/g, '_'));
  const isPackage = /\.zip$/i.test(file);
  if (btn) btn.disabled = true;
  if (row) {
    row.hidden = false;
    row.querySelector('td').innerHTML = esc(deep
      ? bi('ກຳລັງກວດທຸກໄຟລ໌…', 'Checking every file…', 'กำลังตรวจทุกไฟล์…', '모든 파일 검사 중…')
      : bi('ກຳລັງກວດສອບ…', 'Verifying…', 'กำลังตรวจสอบ…', '검증 중…'));
  }
  try {
    /* Packages get the four-part report (database, audit chain, uploads,
     * manifest); database snapshots keep the P4.6 report they already had. */
    const r = isPackage ? await DB.verifyPackage(file, deep) : await DB.verifyBackup(file);
    if (row) row.querySelector('td').innerHTML = isPackage ? acPackageVerifyHtml(r) : acVerifyHtml(r);
    const good = isPackage ? r.status === 'fully-recoverable' : r.ok;
    const partial = isPackage && r.status === 'partially-recoverable';
    toast(good
      ? bi('ກູ້ຄືນໄດ້ເຕັມ', 'Fully recoverable', 'กู้คืนได้เต็ม', '완전 복구 가능')
      : partial
        ? bi('ກູ້ຄືນໄດ້ບາງສ່ວນ', 'Partially recoverable', 'กู้คืนได้บางส่วน', '부분 복구 가능')
        : bi('ໄຟລ໌ສຳຮອງມີບັນຫາ', 'Backup has problems', 'ไฟล์สำรองมีปัญหา', '백업에 문제 있음'),
      good ? 'ok' : 'warn');

    /* The health banner's "last verified" is now stale — but re-rendering the
     * whole pane would destroy the report just written into the row above, which
     * is the entire point of having clicked Verify. Only the summary cards are
     * refreshed; the result stays on screen until the operator moves on. */
    if (isPackage) {
      try {
        const cards = document.getElementById('set-backup-cards');
        if (cards) cards.innerHTML = acBackupHealthHtml(await DB.backupHealth());
      } catch (e) { /* the report is what matters; a stale banner is survivable */ }
    }
  } catch (e) {
    if (row) row.querySelector('td').innerHTML = acError(e);
  }
  if (btn) btn.disabled = false;
}

/** The four-part verification report for a full package (Phase 3). */
function acPackageVerifyHtml(r) {
  const line = (label, ok, detail) =>
    '<div class="ac-kv"><span class="ac-kv-k">' + esc(label) + '</span><span class="ac-kv-v">' +
      (ok === null ? acPill('info', bi('ບໍ່ຮູ້', 'unknown', 'ไม่ทราบ', '알 수 없음'))
                   : acPill(ok ? 'good' : 'critical', ok ? bi('ຜ່ານ', 'pass', 'ผ่าน', '통과')
                                                         : bi('ລົ້ມເຫລວ', 'fail', 'ล้มเหลว', '실패'))) +
      (detail ? ' <span class="ac-muted">' + esc(detail) + '</span>' : '') +
    '</span></div>';

  const statusPill = r.status === 'fully-recoverable'
    ? acPill('good', bi('ກູ້ຄືນໄດ້ເຕັມ', 'Fully recoverable', 'กู้คืนได้เต็ม', '완전 복구 가능'))
    : r.status === 'partially-recoverable'
      ? acPill('warning', bi('ກູ້ຄືນໄດ້ບາງສ່ວນ', 'Partially recoverable', 'กู้คืนได้บางส่วน', '부분 복구'))
      : acPill('critical', bi('ເສຍຫາຍ', 'Corrupted', 'เสียหาย', '손상됨'));

  const chain = r.audit.chain || {};
  const rows = (r.database.rows) || {};

  return '<div class="ac-verify">' +
    '<div class="ac-verify-head">' + statusPill +
      ' <span class="ac-muted">' + esc(r.durationMs + ' ms · ' + acBytes(r.bytes)) + '</span></div>' +
    line(bi('ຖານຂໍ້ມູນ', 'Database', 'ฐานข้อมูล', '데이터베이스'), r.databaseValid,
         (r.database.integrity || '') +
         (rows.employees != null ? ' · ' + rows.employees + ' ' + bi('ແຮງງານ', 'workers', 'แรงงาน', '근로자') : '')) +
    line(bi('ບັນທຶກກວດສອບ', 'Audit chain', 'บันทึกตรวจสอบ', '감사 체인'), r.auditValid,
         chain.available === false ? (chain.reason || '')
           : (chain.verified + '/' + chain.rows + ' ' + bi('ແຖວ', 'rows', 'แถว', '행') +
              (r.audit.keyPresent ? ' · ' + bi('ມີກຸນແຈໃນໄຟລ໌', 'key included', 'มีกุญแจในไฟล์', '키 포함')
                                  : ' · ' + bi('ບໍ່ມີກຸນແຈ', 'NO KEY', 'ไม่มีกุญแจ', '키 없음'))) ) +
    line(bi('ຮູບເອກະສານ', 'Document images', 'รูปเอกสาร', '문서 이미지'), r.uploadsValid,
         r.uploads.present + '/' + r.uploads.expected + ' ' + bi('ມີຄົບ', 'present', 'มีครบ', '존재') +
         ' · ' + r.uploads.checked + ' ' + bi('ກວດແລ້ວ', 'checked', 'ตรวจแล้ว', '검사됨') +
         (r.uploads.deep ? ' (' + bi('ເລິກ', 'deep', 'ลึก', '정밀') + ')' : '') +
         (r.uploads.missing.length ? ' · ' + r.uploads.missing.length + ' ' + bi('ຫາຍ', 'missing', 'หาย', '누락') : '') +
         (r.uploads.corrupt.length ? ' · ' + r.uploads.corrupt.length + ' ' + bi('ເສຍ', 'corrupt', 'เสีย', '손상') : '')) +
    line(bi('Manifest', 'Manifest', 'Manifest', '매니페스트'), r.manifestValid,
         (r.manifest.appVersion ? 'v' + r.manifest.appVersion : '') +
         (r.manifest.createdBy ? ' · ' + r.manifest.createdBy : '')) +
    line(bi('Checksum ຂອງແພັກເກັດ', 'Package checksum', 'Checksum ของแพ็กเกจ', '패키지 체크섬'),
         r.packageChecksumOk,
         r.packageChecksumOk === null
           ? bi('ບໍ່ໄດ້ບັນທຶກໄວ້', 'not recorded', 'ไม่ได้บันทึกไว้', '기록 없음')
           : (r.packageSha256 || '').slice(0, 16)) +
    /* Referenced-but-absent files at BACKUP time. Not a fault in the package —
     * the database already pointed at images that were gone — but an operator
     * restoring this package should know those rows will still be broken. */
    ((r.uploads.missingReferencedAtBackupTime || []).length
      ? '<div class="ac-note">' + esc(bi(
          'ຂໍ້ມູນ ' + r.uploads.missingReferencedAtBackupTime.length + ' ແຖວ ອ້າງອີງຮູບທີ່ຫາຍໄປແລ້ວກ່ອນສຳຮອງ',
          r.uploads.missingReferencedAtBackupTime.length + ' database row(s) referenced images that were already missing when this backup was taken',
          'ข้อมูล ' + r.uploads.missingReferencedAtBackupTime.length + ' แถว อ้างอิงรูปที่หายไปแล้วก่อนสำรอง',
          r.uploads.missingReferencedAtBackupTime.length + '개 행이 백업 시점에 이미 없던 이미지를 참조합니다')) + '</div>'
      : '') +
    (r.manifest.errors.concat(r.database.errors, r.audit.errors, r.uploads.errors).length
      ? '<div class="ac-note ac-empty-warn">' + esc(
          r.manifest.errors.concat(r.database.errors, r.audit.errors, r.uploads.errors).join('; ')) + '</div>'
      : '') +
  '</div>';
}

function acVerifyHtml(r) {
  const line = (label, ok, detail) =>
    '<div class="ac-kv"><span class="ac-kv-k">' + esc(label) + '</span><span class="ac-kv-v">' +
      (ok === null ? acPill('info', bi('ບໍ່ຮູ້', 'unknown', 'ไม่ทราบ', '알 수 없음'))
                   : acPill(ok ? 'good' : 'critical', ok ? bi('ຜ່ານ', 'pass', 'ผ่าน', '통과')
                                                         : bi('ລົ້ມເຫລວ', 'fail', 'ล้มเหลว', '실패'))) +
      (detail ? ' <span class="ac-muted">' + esc(detail) + '</span>' : '') +
    '</span></div>';

  const c = r.counts || {};
  const chain = r.auditChain || {};
  return '<div class="ac-verify">' +
    '<div class="ac-verify-head">' +
      acPill(r.ok ? 'good' : 'critical',
        r.ok ? bi('ກູ້ຄືນໄດ້', 'Restorable', 'กู้คืนได้', '복원 가능')
             : bi('ໃຊ້ບໍ່ໄດ້', 'Not usable', 'ใช้ไม่ได้', '사용 불가')) +
      ' <span class="ac-muted">' + esc(r.durationMs + ' ms') + '</span>' +
    '</div>' +
    line(bi('ອ່ານໄດ້', 'Opens as a database', 'อ่านได้', '데이터베이스로 열림'), r.readable) +
    line(bi('ຄວາມສົມບູນ SQLite', 'SQLite integrity', 'ความสมบูรณ์ SQLite', 'SQLite 무결성'),
         r.integrityOk, r.integrity) +
    line(bi('Checksum ຕົງກັບຕອນສ້າງ', 'Checksum matches creation', 'Checksum ตรงกับตอนสร้าง', '생성 시 체크섬 일치'),
         r.checksumOk, r.checksumOk === null
           ? bi('ບໍ່ໄດ້ບັນທຶກໄວ້ (ໄຟລ໌ເກົ່າ)', 'not recorded (older file)', 'ไม่ได้บันทึกไว้ (ไฟล์เก่า)', '기록 없음 (이전 파일)')
           : (r.checksum || '').slice(0, 16)) +
    line(bi('ຕາຕະລາງຄົບ', 'Schema complete', 'ตารางครบ', '스키마 완전'),
         r.missingTables.length === 0,
         r.missingTables.length ? r.missingTables.join(', ') : '') +
    line(bi('ບັນທຶກກວດສອບໃນໄຟລ໌', 'Audit chain inside the file', 'บันทึกตรวจสอบในไฟล์', '파일 내 감사 체인'),
         chain.available === false ? null : !!chain.ok,
         chain.available === false ? chain.reason
           : (chain.verified + ' / ' + chain.rows + ' ' + bi('ແຖວ', 'rows', 'แถว', '행') +
              (chain.ok ? '' : ' · ' + bi('ຂາດຕອນທີ່ ', 'break at ', 'ขาดตอนที่ ', '불일치 ') + chain.brokenAtId))) +
    '<div class="ac-kv"><span class="ac-kv-k">' +
      esc(bi('ເນື້ອຫາ', 'Contents', 'เนื้อหา', '내용')) + '</span><span class="ac-kv-v">' +
      esc([['employees', c.employees], ['groups', c.groups], ['documents', c.documents],
           ['users', c.users], ['auth_log', c.auth_log]]
          .filter(([, v]) => v != null).map(([k, v]) => v + ' ' + k).join(' · ')) +
    '</span></div>' +
    (r.errors.length ? '<div class="ac-note ac-empty-warn">' + esc(r.errors.join('; ')) + '</div>' : '') +
  '</div>';
}

/**
 * Show what a restore would change, then ask.
 *
 * Restore is the most destructive action in the product, and it used to be a
 * yes/no confirmation naming only a filename. An operator could not tell whether
 * a snapshot was from before or after a week of data entry until it was already
 * applied.
 */
async function acPreviewRestore(file) {
  let p;
  try { p = await DB.previewRestore(file); }
  catch (e) {
    toast(bi('ອ່ານໄຟລ໌ບໍ່ໄດ້', 'Could not read that backup', 'อ่านไฟล์ไม่ได้', '백업을 읽을 수 없습니다'), 'warn');
    return;
  }

  const d = p.delta || {};
  const label = { employees: bi('ແຮງງານ', 'workers', 'แรงงาน', '근로자'),
                  groups: bi('ກຸ່ມ', 'groups', 'กลุ่ม', '그룹'),
                  documents: bi('ເອກະສານ', 'documents', 'เอกสาร', '문서'),
                  users: bi('ບັນຊີ', 'accounts', 'บัญชี', '계정') };
  const losses = Object.keys(label).filter(k => d[k] != null && d[k] < 0)
    .map(k => (-d[k]) + ' ' + label[k]);
  const gains = Object.keys(label).filter(k => d[k] != null && d[k] > 0)
    .map(k => d[k] + ' ' + label[k]);

  const lines = [];
  lines.push(bi('ໄຟລ໌: ', 'File: ', 'ไฟล์: ', '파일: ') + p.file);
  if (p.createdAt) lines.push(bi('ສ້າງເມື່ອ: ', 'Taken: ', 'สร้างเมื่อ: ', '생성: ') +
    acTime(p.createdAt) + (p.createdBy ? ' · ' + p.createdBy : ''));
  lines.push(p.verification.ok
    ? bi('✓ ກວດສອບແລ້ວ: ໄຟລ໌ສົມບູນ', '✓ Verified: the file is sound', '✓ ตรวจสอบแล้ว: ไฟล์สมบูรณ์', '✓ 검증됨: 파일 정상')
    : bi('⚠ ໄຟລ໌ນີ້ກວດສອບບໍ່ຜ່ານ', '⚠ This file FAILS verification', '⚠ ไฟล์นี้ตรวจสอบไม่ผ่าน', '⚠ 이 파일은 검증에 실패했습니다'));
  if (losses.length) lines.push(bi('ຈະສູນເສຍ: ', 'WILL LOSE: ', 'จะสูญเสีย: ', '손실됨: ') + losses.join(', '));
  if (gains.length)  lines.push(bi('ຈະໄດ້ຄືນ: ', 'Will restore: ', 'จะได้คืน: ', '복원됨: ') + gains.join(', '));
  if (!losses.length && !gains.length)
    lines.push(bi('ຈຳນວນຂໍ້ມູນຄືກັນ', 'Record counts are identical', 'จำนวนข้อมูลเหมือนกัน', '레코드 수 동일'));
  if (p.auditRowsNewerThanBackup)
    lines.push(bi('ບັນທຶກກວດສອບ ' + p.auditRowsNewerThanBackup + ' ແຖວໃໝ່ກວ່າໄຟລ໌ — ຈະຖືກເກັບໄວ້, ບໍ່ຫາຍ',
                  p.auditRowsNewerThanBackup + ' audit events are newer than this backup — they are kept, not lost',
                  'บันทึกตรวจสอบ ' + p.auditRowsNewerThanBackup + ' แถวใหม่กว่าไฟล์ — จะถูกเก็บไว้ ไม่หาย',
                  '감사 이벤트 ' + p.auditRowsNewerThanBackup + '건이 이 백업보다 최신 — 보존되며 손실되지 않습니다'));
  lines.push(bi('ສະຖານະປັດຈຸບັນຈະຖືກສຳຮອງໄວ້ກ່ອນ',
                'The current state is backed up first',
                'สถานะปัจจุบันจะถูกสำรองไว้ก่อน',
                '현재 상태가 먼저 백업됩니다'));

  showConfirm(
    bi('ກູ້ຄືນຂໍ້ມູນ?', 'Restore this backup?', 'กู้คืนข้อมูล?', '이 백업을 복원할까요?'),
    lines.join('\n'),
    () => doRestore(file));
}

/* ══════════════════════════════════════════════════════════════════
 * TASK 9 — Monitoring: health, database, storage
 * ══════════════════════════════════════════════════════════════════ */

let _acHealth = null;

async function acHealth(force) {
  if (force || !_acHealth) _acHealth = await DB.systemHealth();
  return _acHealth;
}

/** Overall status from the facts, so the badge is derived rather than asserted. */
function acHealthLevel(h) {
  if (!h.database.ok) return 'critical';
  const heapRatio = h.memory.heapTotal ? h.memory.heapUsed / h.memory.heapTotal : 0;
  const stale = !h.backups.newest;
  if (heapRatio > 0.92 || stale) return 'warning';
  return 'excellent';
}

async function renderHealthPane(force) {
  if (!acCan('database.manage')) { acFill('set-health-body', acError({ status: 403 })); return; }
  await acRender('set-health-body', async () => {
    const h = await acHealth(force);
    const level = acHealthLevel(h);
    const s = h.stats;

    const banner = '<div class="ac-risk ac-' + esc(level) + ' ac-risk-slim">' +
      '<div class="ac-risk-text">' +
        '<div class="ac-risk-level">' + esc(
          level === 'excellent' ? bi('ລະບົບປົກກະຕິ', 'Healthy', 'ระบบปกติ', '정상')
          : level === 'warning' ? bi('ຄວນກວດເບິ່ງ', 'Needs attention', 'ควรตรวจสอบ', '주의 필요')
          : bi('ວິກິດ', 'Critical', 'วิกฤต', '심각')) + '</div>' +
        '<div class="ac-risk-sub">' + esc(
          bi('ເປີດໃຊ້ມາ ', 'Up for ', 'เปิดใช้มา ', '가동 시간 ') + acDuration(h.app.uptimeSeconds)) + '</div>' +
      '</div></div>';

    const cards = '<div class="ac-cards">' +
      acCard(bi('ຖານຂໍ້ມູນ', 'Database', 'ฐานข้อมูล', '데이터베이스'),
             h.database.ok ? bi('ປົກກະຕິ', 'OK', 'ปกติ', '정상') : bi('ຜິດພາດ', 'Error', 'ผิดพลาด', '오류'),
             h.database.journalMode ? String(h.database.journalMode).toUpperCase() : '',
             h.database.ok ? 'good' : 'bad') +
      acCard(bi('ພື້ນທີ່ໃຊ້ໄປ', 'Storage used', 'พื้นที่ใช้ไป', '사용 공간'),
             h.storage ? acBytes(h.storage.total) : '—',
             h.storage ? acBytes(h.storage.db.bytes) + ' DB · ' + acBytes(h.storage.uploads.bytes) + ' ' +
               bi('ໄຟລ໌', 'files', 'ไฟล์', '파일') : '') +
      acCard(bi('ໜ່ວຍຄວາມຈຳ', 'Memory', 'หน่วยความจำ', '메모리'),
             acBytes(h.memory.heapUsed),
             acBytes(h.memory.rss) + ' RSS',
             h.memory.heapTotal && h.memory.heapUsed / h.memory.heapTotal > 0.92 ? 'warn' : 'good') +
      acCard(bi('ເວລາເຊີບເວີ', 'Server time', 'เวลาเซิร์ฟเวอร์', '서버 시간'),
             acTime(h.app.serverTime, { second: '2-digit' }),
             h.app.timezone || '') +
      acCard(bi('ເວີຊັນ', 'Version', 'เวอร์ชัน', '버전'), 'v' + h.app.version, 'Node ' + h.app.node) +
      acCard(bi('ໄຟລ໌ສຳຮອງ', 'Backups', 'ไฟล์สำรอง', '백업'),
             h.backups.count, acBytes(h.backups.totalBytes),
             h.backups.count ? 'good' : 'warn') +
    '</div>';

    const stats = '<div class="set-card-label">' +
        esc(bi('ຈຳນວນຂໍ້ມູນ', 'Record counts', 'จำนวนข้อมูล', '레코드 수')) + '</div>' +
      '<div class="ac-cards ac-cards-tight">' +
        acCard(bi('ຜູ້ໃຊ້', 'Users', 'ผู้ใช้', '사용자'), s.users) +
        acCard(bi('ແຮງງານ', 'Employees', 'แรงงาน', '근로자'), s.employees) +
        acCard(bi('ກຸ່ມ', 'Groups', 'กลุ่ม', '그룹'), s.groups) +
        acCard(bi('ເອກະສານ', 'Documents', 'เอกสาร', '문서'), s.documents) +
        acCard(bi('ພາສປອດ', 'Passports', 'พาสปอร์ต', '여권'), s.passports) +
        acCard(bi('ເຊດຊັນ', 'Sessions', 'เซสชัน', '세션'), s.sessions) +
      '</div>';

    const detail = '<div class="set-card-label">' +
        esc(bi('ລາຍລະອຽດເຊີບເວີ', 'Server detail', 'รายละเอียดเซิร์ฟเวอร์', '서버 상세')) + '</div>' +
      '<div class="set-card ac-card">' +
      acRow(bi('ແອັບພລິເຄຊັນ', 'Application', 'แอปพลิเคชัน', '애플리케이션'), h.app.name + ' v' + h.app.version) +
      acRow('Node.js', h.app.node, true) +
      acRow(bi('ແພລດຟອມ', 'Platform', 'แพลตฟอร์ม', '플랫폼'), h.app.platform, true) +
      acRow(bi('ເລີ່ມເມື່ອ', 'Started', 'เริ่มเมื่อ', '시작'), acTime(h.app.startedAt)) +
      acRow(bi('ເຂດເວລາເຊີບເວີ', 'Server timezone', 'เขตเวลาเซิร์ฟเวอร์', '서버 시간대'),
            (h.app.timezone || '—') + ' (UTC' + (h.app.timezoneOffsetMinutes >= 0 ? '+' : '') +
            (h.app.timezoneOffsetMinutes / 60) + ')') +
      acRow(bi('ບັນທຶກກວດສອບ', 'Audit rows', 'บันทึกตรวจสอบ', '감사 로그 행'), s.auditRows) +
      acRow(bi('ບົດບາດ / ສິດ', 'Roles / permissions', 'บทบาท / สิทธิ์', '역할 / 권한'), s.roles + ' / ' + s.permissions) +
      (h.r2 ? acRow('Cloudflare R2', h.r2.enabled
        ? bi('ເປີດ', 'Enabled', 'เปิด', '사용') + (h.r2.pending != null ? ' · ' + h.r2.pending + ' ' +
            bi('ລໍຖ້າ', 'pending', 'รอ', '대기') : '')
        : bi('ປິດ', 'Disabled', 'ปิด', '사용 안 함')) : '') +
      '</div>';

    return banner + cards + stats + detail;
  });
}

async function renderDatabasePane(force) {
  if (!acCan('database.manage')) { acFill('set-database-body', acError({ status: 403 })); return; }
  await acRender('set-database-body', async () => {
    const h = await acHealth(force);
    const d = h.database;
    const sizeBytes = (d.pageCount || 0) * (d.pageSize || 0);
    const freeBytes = (d.freelistCount || 0) * (d.pageSize || 0);

    const banner = '<div class="ac-risk ac-' + (d.ok ? 'excellent' : 'critical') + ' ac-risk-slim">' +
      '<div class="ac-risk-text">' +
        '<div class="ac-risk-level">' + esc(d.ok
          ? bi('ຄວາມສົມບູນ: ຜ່ານ', 'Integrity check: passed', 'ความสมบูรณ์: ผ่าน', '무결성 검사: 통과')
          : bi('ຄວາມສົມບູນ: ລົ້ມເຫລວ', 'Integrity check: FAILED', 'ความสมบูรณ์: ล้มเหลว', '무결성 검사: 실패')) + '</div>' +
        '<div class="ac-risk-sub ac-mono">' + esc(d.integrity) + '</div>' +
      '</div></div>';

    const info = '<div class="set-card ac-card">' +
      acRow(bi('ໄຟລ໌', 'File', 'ไฟล์', '파일'), d.path, true) +
      acRow(bi('ໂໝດ journal', 'Journal mode', 'โหมด journal', '저널 모드'), String(d.journalMode || '—').toUpperCase()) +
      acRow(bi('ຂະໜາດໜ້າ', 'Page size', 'ขนาดเพจ', '페이지 크기'), acBytes(d.pageSize)) +
      acRow(bi('ຈຳນວນໜ້າ', 'Page count', 'จำนวนเพจ', '페이지 수'), d.pageCount) +
      acRow(bi('ຂະໜາດລວມ', 'Total size', 'ขนาดรวม', '전체 크기'), acBytes(sizeBytes)) +
      acRow(bi('ພື້ນທີ່ວ່າງພາຍໃນ', 'Reclaimable (VACUUM)', 'พื้นที่ว่างภายใน', '회수 가능 (VACUUM)'), acBytes(freeBytes)) +
      acRow(bi('Foreign keys', 'Foreign keys', 'Foreign keys', '외래 키'), d.foreignKeys ? bi('ເປີດ', 'On', 'เปิด', '켜짐') : bi('ປິດ', 'Off', 'ปิด', '꺼짐')) +
      acRow('WAL autocheckpoint', d.walAutocheckpoint) +
    '</div>';

    const counts = '<div class="set-card-label">' +
        esc(bi('ຕາຕະລາງ', 'Tables', 'ตาราง', '테이블')) + '</div>' +
      '<div class="set-card ac-card">' +
      Object.keys(h.stats).map(k => acRow(k, h.stats[k])).join('') +
      '</div>';

    return banner + info + counts;
  });
}

async function renderStoragePane(force) {
  if (!acCan('database.manage')) { acFill('set-storage-body', acError({ status: 403 })); return; }
  await acRender('set-storage-body', async () => {
    const h = await acHealth(force);
    if (!h.storage) return acEmpty(bi('ບໍ່ມີຂໍ້ມູນພື້ນທີ່', 'No storage data', 'ไม่มีข้อมูลพื้นที่', '저장 공간 데이터 없음'));
    const st = h.storage;
    const total = st.total || 1;
    const seg = (label, bytes, cls) =>
      '<div class="ac-bar-seg ' + cls + '" style="width:' + ((bytes / total) * 100).toFixed(2) + '%"' +
        ' title="' + esc(label + ' — ' + acBytes(bytes)) + '"></div>';

    const bar = '<div class="set-card ac-card">' +
      '<div class="ac-bar" role="img" aria-label="' + esc(
        bi('ການແບ່ງພື້ນທີ່', 'Storage breakdown', 'การแบ่งพื้นที่', '저장 공간 구성') + ': ' +
        acBytes(st.db.bytes) + ' database, ' + acBytes(st.uploads.bytes) + ' uploads, ' +
        acBytes(st.backups.bytes) + ' backups') + '">' +
        seg(bi('ຖານຂໍ້ມູນ', 'Database', 'ฐานข้อมูล', '데이터베이스'), st.db.bytes, 'ac-bar-db') +
        seg(bi('ໄຟລ໌ອັບໂຫລດ', 'Uploads', 'ไฟล์อัปโหลด', '업로드'), st.uploads.bytes, 'ac-bar-up') +
        seg(bi('ໄຟລ໌ສຳຮອງ', 'Backups', 'ไฟล์สำรอง', '백업'), st.backups.bytes, 'ac-bar-bk') +
      '</div>' +
      '<div class="ac-legend">' +
        '<span><i class="ac-bar-db"></i>' + esc(bi('ຖານຂໍ້ມູນ', 'Database', 'ฐานข้อมูล', '데이터베이스')) + ' ' + acBytes(st.db.bytes) + '</span>' +
        '<span><i class="ac-bar-up"></i>' + esc(bi('ໄຟລ໌ອັບໂຫລດ', 'Uploads', 'ไฟล์อัปโหลด', '업로드')) + ' ' + acBytes(st.uploads.bytes) + '</span>' +
        '<span><i class="ac-bar-bk"></i>' + esc(bi('ໄຟລ໌ສຳຮອງ', 'Backups', 'ไฟล์สำรอง', '백업')) + ' ' + acBytes(st.backups.bytes) + '</span>' +
      '</div>' +
    '</div>';

    const cards = '<div class="ac-cards">' +
      acCard(bi('ລວມທັງໝົດ', 'Total used', 'รวมทั้งหมด', '전체 사용'), acBytes(st.total), '') +
      acCard(bi('ໄຟລ໌ອັບໂຫລດ', 'Upload files', 'ไฟล์อัปโหลด', '업로드 파일'), st.uploads.files, acBytes(st.uploads.bytes)) +
      acCard(bi('ໄຟລ໌ກຳພ້າ', 'Orphaned files', 'ไฟล์กำพร้า', '고아 파일'), st.uploads.orphanCount,
             acBytes(st.uploads.orphanBytes) + ' ' + bi('ກູ້ຄືນໄດ້', 'reclaimable', 'กู้คืนได้', '회수 가능'),
             st.uploads.orphanCount ? 'warn' : 'good') +
      acCard(bi('ກູ້ຄືນດ້ວຍ VACUUM', 'VACUUM would free', 'กู้คืนด้วย VACUUM', 'VACUUM 회수량'),
             acBytes(st.db.reclaimableByVacuum), '') +
    '</div>';

    const cleanup = '<div class="set-card-label">' +
        esc(bi('ກູ້ຄືນພື້ນທີ່', 'Reclaim space', 'กู้คืนพื้นที่', '공간 회수')) + '</div>' +
      '<div class="set-card">' +
        '<div class="set-action-list">' +
          '<button class="set-action" onclick="acCleanup()">' +
            '<span class="sa-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></span>' +
            '<span class="set-action-body">' +
              '<span class="set-action-title">' + esc(bi('ລ້າງໄຟລ໌ກຳພ້າ + VACUUM', 'Clean orphans + VACUUM', 'ล้างไฟล์กำพร้า + VACUUM', '고아 파일 정리 + VACUUM')) + '</span>' +
              '<span class="set-action-sub">' + esc(bi(
                'ລຶບສະເພາະໄຟລ໌ທີ່ບໍ່ມີແຖວໃດອ້າງອີງ ແລ້ວບີບອັດຖານຂໍ້ມູນ — ຂໍ້ມູນທີ່ໃຊ້ຢູ່ບໍ່ຖືກແຕະຕ້ອງ',
                'Deletes only files no database row references, then compacts the database. Live data is never touched.',
                'ลบเฉพาะไฟล์ที่ไม่มีแถวใดอ้างอิง แล้วบีบอัดฐานข้อมูล — ข้อมูลที่ใช้อยู่ไม่ถูกแตะต้อง',
                '어떤 행도 참조하지 않는 파일만 삭제한 뒤 데이터베이스를 압축합니다. 사용 중인 데이터는 건드리지 않습니다')) + '</span>' +
            '</span>' +
          '</button>' +
        '</div>' +
      '</div>';

    const r2 = h.r2 && h.r2.enabled
      ? '<div class="set-card ac-card">' +
          acRow('Cloudflare R2', bi('ເປີດໃຊ້', 'Enabled', 'เปิดใช้', '사용 중')) +
          acRow(bi('ລໍຖ້າອັບໂຫລດ', 'Pending offload', 'รออัปโหลด', '대기 중 오프로드'), h.r2.pending) +
        '</div>'
      : '';

    return bar + cards + cleanup + r2;
  });
}

function acCleanup() {
  showConfirm(bi('ກູ້ຄືນພື້ນທີ່', 'Reclaim space', 'กู้คืนพื้นที่', '공간 회수'),
    bi('ລຶບໄຟລ໌ທີ່ບໍ່ມີການອ້າງອີງ ແລະ ບີບອັດຖານຂໍ້ມູນ. ຂໍ້ມູນທີ່ໃຊ້ຢູ່ຈະບໍ່ຖືກລຶບ.',
       'Deletes unreferenced files and compacts the database. Nothing in use is removed.',
       'ลบไฟล์ที่ไม่มีการอ้างอิงและบีบอัดฐานข้อมูล ข้อมูลที่ใช้อยู่จะไม่ถูกลบ',
       '참조되지 않은 파일을 삭제하고 데이터베이스를 압축합니다. 사용 중인 데이터는 삭제되지 않습니다.'),
    async () => {
      try {
        const r = await DB.cleanupStorage({ orphans: true, vacuum: true });
        const freed = (r.result.orphans ? r.result.orphans.freedBytes : 0) +
                      (r.result.db ? r.result.db.freedBytes : 0);
        toast(bi('ກູ້ຄືນໄດ້ ', 'Reclaimed ', 'กู้คืนได้ ', '회수됨 ') + acBytes(freed), 'ok');
        _acHealth = null;
        renderStoragePane(true);
      } catch (e) { toast(bi('ບໍ່ສຳເລັດ', 'Failed', 'ไม่สำเร็จ', '실패'), 'warn'); }
    });
}

/* ══════════════════════════════════════════════════════════════════
 * General — Timezone
 * ══════════════════════════════════════════════════════════════════
 * A display preference, stored per browser. Deliberately NOT sent to the
 * server: timestamps are UTC everywhere, and giving the server a per-user
 * timezone would create a second source of truth for what "today" means.
 */
const AC_TZ_COMMON = [
  'Asia/Vientiane', 'Asia/Bangkok', 'Asia/Seoul', 'Asia/Ho_Chi_Minh',
  'Asia/Singapore', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata',
  'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'UTC',
];

function renderTimezonePane() {
  const card = document.getElementById('set-tz-card');
  if (!card) return;
  const current = acTimezone();
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  // Any zone already chosen but missing from the shortlist still appears.
  const list = AC_TZ_COMMON.slice();
  if (current && !list.includes(current)) list.unshift(current);

  card.innerHTML =
    '<div class="set-row stack" data-kw="timezone เขตเวลา ເຂດເວລາ">' +
      '<div class="set-row-main">' +
        '<label class="set-row-label" for="set-tz">' + esc(bi('ເຂດເວລາ', 'Timezone', 'เขตเวลา', '시간대')) + '</label>' +
        '<div class="set-row-desc">' + esc(bi('ໃຊ້ກັບທຸກວັນທີ ແລະ ເວລາທີ່ສະແດງ', 'Applied to every date and time shown', 'ใช้กับทุกวันที่และเวลาที่แสดง', '표시되는 모든 날짜·시각에 적용')) + '</div>' +
      '</div>' +
      '<div class="set-row-control">' +
        '<select id="set-tz" class="ac-tz-select" onchange="acSetTimezone(this.value)">' +
          '<option value=""' + (current ? '' : ' selected') + '>' +
            esc(bi('ຕາມເຄື່ອງ', 'Follow this device', 'ตามอุปกรณ์', '기기 설정 따르기')) + ' (' + esc(device) + ')</option>' +
          list.map(z => '<option value="' + esc(z) + '"' + (z === current ? ' selected' : '') + '>' +
            esc(z.replace(/_/g, ' ')) + '</option>').join('') +
        '</select>' +
      '</div>' +
    '</div>' +
    '<div class="set-row" data-kw="preview ตัวอย่าง">' +
      '<div class="set-row-main">' +
        '<div class="set-row-label">' + esc(bi('ຕົວຢ່າງ', 'Preview', 'ตัวอย่าง', '미리 보기')) + '</div>' +
        '<div class="set-row-desc">' + esc(bi('ເວລາປັດຈຸບັນໃນເຂດທີ່ເລືອກ', 'The current time in the chosen zone', 'เวลาปัจจุบันในเขตที่เลือก', '선택한 시간대의 현재 시각')) + '</div>' +
      '</div>' +
      '<div class="set-row-control"><span class="ac-mono" id="set-tz-preview">' +
        esc(acTime(new Date().toISOString(), { second: '2-digit' })) + '</span></div>' +
    '</div>';
}

function acSetTimezone(tz) {
  try { if (tz) localStorage.setItem('kd_tz', tz); else localStorage.removeItem('kd_tz'); } catch (e) {}
  const p = document.getElementById('set-tz-preview');
  if (p) p.textContent = acTime(new Date().toISOString(), { second: '2-digit' });
  toast(AC_L.saved(), 'ok');
}

/* ══════════════════════════════════════════════════════════════════
 * About — License and Changelog
 * ══════════════════════════════════════════════════════════════════ */

function renderLicensePane() {
  const el = document.getElementById('set-license-body');
  if (!el) return;
  el.innerHTML =
    '<h3>' + esc(bi('ການນຳໃຊ້ພາຍໃນ', 'Internal use', 'การใช้งานภายใน', '내부 사용')) + '</h3>' +
    '<p>' + esc(bi(
      'ຊອບແວນີ້ເປັນຂອງ KD Employment Co., Ltd ແລະ ອະນຸຍາດໃຫ້ໃຊ້ພາຍໃນອົງກອນເທົ່ານັ້ນ. ບໍ່ອະນຸຍາດໃຫ້ແຈກຢາຍ ຫຼື ນຳໄປໃຊ້ນອກອົງກອນ.',
      'This software belongs to KD Employment Co., Ltd and is licensed for internal use only. Redistribution or use outside the organisation is not permitted.',
      'ซอฟต์แวร์นี้เป็นของ KD Employment Co., Ltd และอนุญาตให้ใช้ภายในองค์กรเท่านั้น ไม่อนุญาตให้แจกจ่ายหรือนำไปใช้นอกองค์กร',
      '이 소프트웨어는 KD Employment Co., Ltd 소유이며 조직 내부 사용으로만 허가됩니다.')) + '</p>' +
    '<h3>' + esc(bi('ຂໍ້ມູນສ່ວນບຸກຄົນ', 'Personal data', 'ข้อมูลส่วนบุคคล', '개인정보')) + '</h3>' +
    '<p>' + esc(bi(
      'ລະບົບນີ້ເກັບຂໍ້ມູນສ່ວນບຸກຄົນຂອງແຮງງານ ລວມທັງເລກພາສປອດ ແລະ ຮູບຖ່າຍ. ຫ້າມແບ່ງປັນນອກບໍລິສັດ. ການເຂົ້າເຖິງທັງໝົດຖືກບັນທຶກໄວ້ໃນ ບັນທຶກກວດສອບ ແລະ ເກັບຮັກສາແຍກຕ່າງຫາກຈາກຂໍ້ມູນແຮງງານ.',
      'This system holds personal data about workers, including passport numbers and photographs. It must not be shared outside the company. All access is recorded in the audit log, which is retained separately from the worker data.',
      'ระบบนี้เก็บข้อมูลส่วนบุคคลของแรงงาน รวมถึงเลขพาสปอร์ตและรูปถ่าย ห้ามแบ่งปันนอกบริษัท การเข้าถึงทั้งหมดถูกบันทึกไว้ในบันทึกตรวจสอบ และเก็บแยกจากข้อมูลแรงงาน',
      '이 시스템은 여권 번호와 사진을 포함한 근로자 개인정보를 보관합니다. 회사 외부와 공유해서는 안 되며, 모든 접근은 감사 로그에 기록되어 근로자 데이터와 별도로 보존됩니다.')) + '</p>' +
    '<h3>' + esc(bi('ສ່ວນປະກອບພາຍນອກ', 'Third-party components', 'ส่วนประกอบภายนอก', '외부 구성 요소')) + '</h3>' +
    '<p>' + esc(bi(
      'ເຊີບເວີບໍ່ໃຊ້ dependency ພາຍນອກເລີຍ. ໄລບຣາຣີຝັ່ງບຣາວເຊີຖືກເກັບໄວ້ໃນເຄື່ອງ (vendor/) ເພື່ອໃຫ້ໃຊ້ງານໄດ້ແບບອອບໄລນ໌: JSZip (MIT), html2canvas (MIT), Tesseract.js (Apache-2.0).',
      'The server has zero external dependencies. Browser libraries are vendored locally so the app works offline: JSZip (MIT), html2canvas (MIT), Tesseract.js (Apache-2.0).',
      'เซิร์ฟเวอร์ไม่ใช้ dependency ภายนอกเลย ไลบรารีฝั่งเบราว์เซอร์ถูกเก็บไว้ในเครื่อง (vendor/) เพื่อให้ใช้งานแบบออฟไลน์ได้: JSZip (MIT), html2canvas (MIT), Tesseract.js (Apache-2.0)',
      '서버는 외부 의존성이 없습니다. 브라우저 라이브러리는 오프라인 사용을 위해 로컬에 포함됩니다: JSZip (MIT), html2canvas (MIT), Tesseract.js (Apache-2.0).')) + '</p>';
}

/* The release history. Kept here rather than fetched: it is three paragraphs
 * that change once per release, and a request for it would be one more thing
 * that can fail on a screen whose whole job is to be readable. */
const AC_CHANGELOG = [
  { v: 'P4', title: () => bi('ສູນບໍລິຫານ', 'Administration Centre', 'ศูนย์บริหาร', '관리 센터'),
    items: () => [
      bi('ພາບລວມຄວາມປອດໄພ ພ້ອມຄະແນນຄວາມສ່ຽງ', 'Security overview with a risk score', 'ภาพรวมความปลอดภัยพร้อมคะแนนความเสี่ยง', '위험 점수가 포함된 보안 개요'),
      bi('ນະໂຍບາຍລະຫັດຜ່ານ, MFA ແລະ ເຊດຊັນ ປັບໄດ້ຈາກໜ້າຈໍ', 'Password, MFA and session policy became configurable', 'นโยบายรหัสผ่าน MFA และเซสชันปรับได้จากหน้าจอ', '비밀번호·MFA·세션 정책 설정 가능'),
      bi('ຕົວອ່ານບັນທຶກກວດສອບ ພ້ອມຕົວກັ່ນຕອງ ແລະ ສົ່ງອອກ CSV', 'Audit log viewer with filters and CSV export', 'ตัวอ่านบันทึกตรวจสอบพร้อมตัวกรองและส่งออก CSV', '필터 및 CSV 내보내기가 있는 감사 로그 뷰어'),
      bi('ບົດບາດ Employee ແລະ Auditor ພ້ອມຕາຕະລາງສິດ', 'Employee and Auditor roles, plus the permission matrix', 'บทบาท Employee และ Auditor พร้อมตารางสิทธิ์', 'Employee·Auditor 역할 및 권한 매트릭스'),
      bi('ສູນສຳຮອງຂໍ້ມູນ ແລະ ໜ້າຕິດຕາມສະຖານະລະບົບ', 'Backup centre and system monitoring', 'ศูนย์สำรองข้อมูลและหน้าติดตามสถานะระบบ', '백업 센터 및 시스템 모니터링'),
    ] },
  { v: 'P3', title: () => bi('ການຢືນຢັນຫຼາຍປັດໄຈ', 'Multi-factor authentication', 'การยืนยันหลายปัจจัย', '다중 인증'),
    items: () => [
      bi('TOTP, passkey (WebAuthn) ແລະ ລະຫັດກູ້ຄືນ', 'TOTP, passkeys (WebAuthn) and recovery codes', 'TOTP, passkey (WebAuthn) และรหัสกู้คืน', 'TOTP·패스키(WebAuthn)·복구 코드'),
      bi('ອຸປະກອນທີ່ເຊື່ອຖືໄດ້ 30 ວັນ', 'Trusted devices for 30 days', 'อุปกรณ์ที่เชื่อถือได้ 30 วัน', '30일 신뢰 기기'),
      bi('ບັງຄັບ MFA ສຳລັບ Admin ແລະ Manager', 'MFA enforced for Admin and Manager', 'บังคับ MFA สำหรับ Admin และ Manager', 'Admin·Manager MFA 필수'),
    ] },
  { v: 'P2', title: () => bi('ສິດຕາມບົດບາດ', 'Role-based permissions', 'สิทธิ์ตามบทบาท', '역할 기반 권한'),
    items: () => [
      bi('ການອະນຸຍາດອີງຕາມສິດ ບໍ່ແມ່ນບົດບາດ', 'Authorisation resolved from permissions, not role names', 'การอนุญาตอิงตามสิทธิ์ ไม่ใช่ชื่อบทบาท', '역할 이름이 아닌 권한 기반 인가'),
      bi('ຂອບເຂດ all / team / own', 'all / team / own scopes', 'ขอบเขต all / team / own', 'all / team / own 범위'),
      bi('ປ້ອງກັນການຍົກລະດັບສິດດ້ວຍກົດ rank', 'Rank invariant blocks privilege escalation', 'ป้องกันการยกระดับสิทธิ์ด้วยกฎ rank', 'rank 규칙으로 권한 상승 차단'),
    ] },
  { v: 'P1', title: () => bi('ເຊດຊັນ ແລະ CSRF', 'Sessions and CSRF', 'เซสชันและ CSRF', '세션 및 CSRF'),
    items: () => [
      bi('ເຊດຊັນຈາກເຊີບເວີ ພ້ອມ cookie ແບບ HttpOnly', 'Server-issued sessions with HttpOnly cookies', 'เซสชันจากเซิร์ฟเวอร์พร้อม cookie แบบ HttpOnly', 'HttpOnly 쿠키 기반 서버 세션'),
      bi('ໝົດເວລາເມື່ອບໍ່ໄດ້ໃຊ້, ເພດານອາຍຸ ແລະ ຈຳກັດອຸປະກອນ', 'Idle timeout, absolute lifetime and device limits', 'หมดเวลาเมื่อไม่ได้ใช้ เพดานอายุ และจำกัดอุปกรณ์', '유휴 시간 초과·절대 수명·기기 제한'),
      bi('ປ້ອງກັນ CSRF ແລະ ຫົວຂໍ້ຄວາມປອດໄພ', 'CSRF protection and security headers', 'ป้องกัน CSRF และ security headers', 'CSRF 보호 및 보안 헤더'),
    ] },
  { v: 'P0', title: () => bi('ພື້ນຖານການເຂົ້າສູ່ລະບົບ', 'Authentication foundation', 'พื้นฐานการเข้าสู่ระบบ', '인증 기반'),
    items: () => [
      bi('ລະຫັດຜ່ານຖືກ hash ດ້ວຍ scrypt', 'Passwords hashed with scrypt', 'รหัสผ่านถูก hash ด้วย scrypt', 'scrypt로 비밀번호 해싱'),
      bi('ຈຳກັດອັດຕາການເຂົ້າສູ່ລະບົບ', 'Sign-in rate limiting', 'จำกัดอัตราการเข้าสู่ระบบ', '로그인 속도 제한'),
      bi('ບັນທຶກກວດສອບແບບເພີ່ມຢ່າງດຽວ', 'Append-only audit log', 'บันทึกตรวจสอบแบบเพิ่มอย่างเดียว', '추가 전용 감사 로그'),
    ] },
];

function renderChangelogPane() {
  const el = document.getElementById('set-changelog-body');
  if (!el) return;
  el.innerHTML = AC_CHANGELOG.map((rel, i) =>
    '<div class="set-card-label">' + esc(rel.v + ' — ' + rel.title()) +
      (i === 0 ? ' ' + acPill('good', bi('ປັດຈຸບັນ', 'current', 'ปัจจุบัน', '현재')) : '') + '</div>' +
    '<div class="set-card ac-card"><ul class="ac-list">' +
      rel.items().map(x => '<li>' + esc(x) + '</li>').join('') +
    '</ul></div>').join('');
}

/* ══════════════════════════════════════════════════════════════════
 * Dispatcher
 * ══════════════════════════════════════════════════════════════════
 * app.js calls this whenever a Settings tab becomes visible. Panes render on
 * demand and cache their payload, so re-opening a tab is instant and no request
 * is made for a section the operator never looks at.
 */
const AC_RENDERERS = {
  'timezone':     renderTimezonePane,
  'sec-overview': renderSecurityOverview,
  'sec-mfa':      renderMfaPolicy,
  'sec-password': renderPasswordPolicy,
  'sec-devices':  renderTrustedDevices,
  'sec-session':  renderSessionPolicy,
  'users':        renderUsersPane,
  'roles':        renderRolesPane,
  'audit':        renderAuditPane,
  'sessions':     renderSessionsPane,
  'data':         renderBackupPane,
  'health':       renderHealthPane,
  'database':     renderDatabasePane,
  'storage':      renderStoragePane,
  'license':      renderLicensePane,
  'changelog':    renderChangelogPane,
};

/** True when the pane is one this file owns. */
function acOwnsTab(tab) { return Object.prototype.hasOwnProperty.call(AC_RENDERERS, tab); }

function acRenderTab(tab) {
  const fn = AC_RENDERERS[tab];
  if (!fn) return;
  try { fn(false); }
  catch (e) { console.error('[admin-center] render ' + tab + ' failed:', e); }
}

/** Drop every cached payload — called when Settings closes or the language changes. */
function acResetCaches() {
  _acOverview = null; _acMfa = null; _acPolicies = null;
  _acUsers = null; _acMatrix = null; _acHealth = null;
  _acEditRole = null; _acDraftGrants = null;
  _acAudit = { offset: 0, filters: {}, actions: _acAudit.actions, total: 0, rows: [] };
}

