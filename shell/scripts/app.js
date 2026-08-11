/**
 * app.js — Main application logic
 * Depends on: db.js, i18n.js
 */

// ── State ─────────────────────────────────────────────────────────
let activeGroupId = '';
let _currentViewUid = null;  // uid of worker currently shown in detail overlay
let _presentDirty   = false; // Present flipped workers → detail drawer needs a catch-up refresh on close
let _navUids = [];           // ordered uids for ←/→ navigation in the detail view
let sidebarSearchQ = '';
let tableFiltered  = [];
let sortCol  = 'worker_id';
let sortAsc  = true;
let editGroupId = null;
let highlightedWorkerUid = null;
let confirmCallback = null;
let currentUser = null;             // {username, role, name} or null
let appInited   = false;            // one-time listeners guard
let quickFilter = '';               // '' | 'alerts' (sidebar nav view)
let viewMode = localStorage.getItem('kd_view') || 'table'; // 'table' | 'kdcard'
let dzSegment  = 'group';           // dashboard chart segment: group|krcity|lacity|status
let dzTimeline = 'all';             // dashboard chart timeline: all|3|6|12 (months to passport expiry)
let _dzGroupsCache = [];            // last groups passed to renderDashboard (for re-render on filter change)
const expandedGroups = new Set(); // tracks which groups have workers list open
const pinnedGroups = new Set(     // pinned group ids (ChatGPT-style "Pinned")
  (() => { try { return JSON.parse(localStorage.getItem('kd_pinned') || '[]'); } catch (e) { return []; } })()
);

// ── TOAST NOTIFICATIONS ──────────────────────────────────────────
function toast(msg, type) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = 'toast toast-' + (type || 'ok');
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 320);
  }, 2800);
}

// ── MOBILE MENU ───────────────────────────────────────────────────
function toggleMobileMenu() {
  document.getElementById('sidebar')?.classList.toggle('open');
}

// ── THEME (light / dark / system) ────────────────────────────────
// Apply saved theme as early as possible to avoid a flash.
const _themeMq = window.matchMedia('(prefers-color-scheme: dark)');
function _applyThemePref(pref) {
  const dark = pref === 'dark' || (pref === 'system' && _themeMq.matches);
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
}
_applyThemePref(localStorage.getItem('kd_theme') || 'system');
_themeMq.addEventListener('change', () => {
  if ((localStorage.getItem('kd_theme') || 'system') === 'system') _applyThemePref('system');
});
function setThemePref(pref) {
  localStorage.setItem('kd_theme', pref);
  _applyThemePref(pref);
  renderAppearance();
}
function applyThemeIcon() {} // no-op (header button removed)
function toggleTheme() { setThemePref(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); }

// ── Init ──────────────────────────────────────────────────────────
// Auth lives on a separate page (login.html). Permissions come from the
// server-issued session created by that username+password sign-in — DB.init()
// returns no user unless the session cookie is valid, so there is nothing to
// boot without one.
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await DB.init();
    // The session is valid but the account owes a step (set a real password, or
    // enrol a second factor). Those screens live on login.html — go there
    // rather than showing a "server down" error the user cannot act on.
    if (DB.pendingStep && DB.pendingStep()) { window.location.replace('login.html'); return; }
    if (!DB.getCurrentUser()) { window.location.replace('login.html'); return; }
    await _migrateDocCatsToServer();
  } catch (e) {
    document.body.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;' +
      'font-family:system-ui,sans-serif;background:#f4f6f4;color:#14181a;">' +
      '<div style="text-align:center;max-width:420px;padding:32px;">' +
      '<div style="font-size:2.5rem;margin-bottom:16px;">⚠</div>' +
      '<h2 style="margin:0 0 12px;font-size:1.3rem;">Server ไม่ตอบสนอง</h2>' +
      '<p style="color:#6b7280;margin:0 0 20px;">ไม่สามารถเชื่อมต่อ SQLite backend ได้<br>' +
      'กรุณาเริ่ม server ก่อนเปิดแอป</p>' +
      '<code style="display:block;background:#e8f3ec;color:#2d6a4f;padding:10px 16px;' +
      'border-radius:8px;font-size:0.9rem;margin-bottom:20px;">npm start</code>' +
      '<button onclick="location.reload()" style="padding:10px 24px;background:#2d6a4f;color:#fff;' +
      'border:none;border-radius:8px;font-size:0.95rem;cursor:pointer;">ลองใหม่</button>' +
      '</div></div>';
    return;
  }
  const sess = DB.getCurrentUser();
  if (!sess) { window.location.replace('login.html'); return; }
  startApp(sess);
});

// ── SAVE STATUS (data-persistence feedback — prevents silent data loss) ──
// Writes are no longer fire-and-forget: db.js queues + retries every write and
// reports progress here. We show a small status pill and block accidental
// page-exit while writes are still in flight or failing.
function initSaveStatusUI() {
  if (typeof DB === 'undefined' || !DB.onSaveStatus) return;
  const bar = document.getElementById('save-bar');
  let hideTimer = null;
  const setClass = (cls) => {
    if (!bar) return;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    bar.className = 'save-bar' + (cls ? ' ' + cls : '');
  };
  DB.onSaveStatus(s => {
    if (s.failed > 0)       { setClass('error'); }
    else if (s.pending > 0) { setClass('saving'); }
    else {
      if (s.event === 'idle') return;
      setClass('saved');
      hideTimer = setTimeout(() => setClass(''), 1600);
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (DB.hasUnsaved && DB.hasUnsaved()) { e.preventDefault(); e.returnValue = t('save_unsaved_warn'); return e.returnValue; }
  });
}

// ── AUTH ──────────────────────────────────────────────────────────
/**
 * "Does this account hold the Admin role?"
 *
 * P4 note — prefer DB.can('resource.action'). This answers a question about
 * IDENTITY, and almost every call site was really asking about CAPABILITY. The
 * distinction stopped being academic when Manager, Employee and Auditor arrived:
 * a Manager is not an admin, yet may approve records and export; an Auditor may
 * read the audit trail that no isAdmin() check would ever have let them near.
 *
 * Kept because a handful of call sites genuinely mean "the admin role", and
 * because the write paths behind them are all re-checked by the server anyway.
 */
function isAdmin() { return !!currentUser && currentUser.role === 'admin'; }

/**
 * The capability test the UI should use: mirrors the server's own decision.
 * A thin wrapper so app.js never has to reach into DB internals, and so a single
 * place can be instrumented if a control ever hides when it should not.
 */
function can(permission) { return DB.can(permission); }

/**
 * The translated name of a role.
 *
 * Before P4 the badge was `role === 'admin' ? 'Admin' : 'Viewer'`, so a Manager,
 * an Employee and an Auditor were all labelled "Viewer" — the UI told four
 * different people the same wrong thing about their own account.
 */
function roleLabel(role) {
  const key = 'role_' + String(role || '').toLowerCase();
  const label = t(key);
  return label === key ? (role || t('role_unknown')) : label;
}

/** Badge colour family. Privileged roles read as accented, readers as neutral. */
function roleBadgeTone(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'admin') return 'admin';
  if (r === 'manager') return 'manager';
  if (r === 'auditor') return 'auditor';
  return 'viewer';
}

function startApp(user) {
  currentUser = user;
  document.body.classList.add('authed');
  document.body.dataset.role = user.role;
  /* Drives the CSS that hides write controls. `data-role` alone could not:
   * `body[data-role="viewer"] .admin-only` hid controls from viewers and showed
   * every one of them to Manager, Employee and Auditor accounts, which then
   * collected a 403 on click. `data-can-write` is set from the permission the
   * controls actually need. */
  document.body.dataset.canWrite = DB.can('employee.update') || DB.can('employee.create') ? 'yes' : 'no';
  loadAppVersion();     // sidebar version label — from the server, never literal

  // Reflect current language in the globe button
  const lc = document.getElementById('lang-current');
  if (lc) lc.textContent = (typeof currentLang !== 'undefined' ? currentLang : 'en').toUpperCase();
  applyThemeIcon();

  // Mobile-first: default to compact card view on small screens
  if (window.matchMedia('(max-width: 768px)').matches) viewMode = 'cards';

  const groups = DB.getGroups();
  activeGroupId = '';  // Start on dashboard, not a group
  if (groups.length) expandedGroups.add(groups[0].id);

  // One-time listeners
  if (!appInited) {
    initSidebarResize();
    initMobileMenu();
    initDatePickers();
    initProvinceCombobox();
    initSaveStatusUI();
    _fillNatDatalist();
    bcUpgradeSelects();     // short, fixed <select>s become bento tile groups
    appInited = true;
  }

  applyTranslations();
  renderSidebar();
  renderSidebarUser();
  updateLogoDisplay();

  // Show dashboard view on initial load
  renderDashboard();
  showMainView('dashboard');
  rebuildFilters();
}

// ⌘K / Ctrl+K → open & focus the sidebar search
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    document.getElementById('sidebar')?.classList.remove('collapsed');
    if (typeof toggleSidebarSearch === 'function') toggleSidebarSearch(true);
  }
});

// ── Press feedback ────────────────────────────────────────────────
// CSS :active is not enough on touch: iOS Safari only applies it to <button>
// and <a>, so every card, row and div-with-onclick stayed completely still
// when tapped — the user could not tell whether the tap had landed. We mark
// the pressed control ourselves; main.css styles [data-pressed] exactly like
// :active. Capture phase, so a handler that stops propagation still gets it.
(() => {
  const PRESSABLE = 'button, a, summary, label.btn, [role="button"], [onclick], .btn,' +
    '.bn-item, .pm-item, .sb-nav-item, .set-nav-item, .set-action, .vm-tab, .view-btn,' +
    '.dz-seg-btn, .kebab, .theme-opt, .export-opt, .exp-btn, .worker-card,' +
    '.tree-group-row, .tree-worker-item, .dz-team-item, .dz-project-item, .hist-item';
  let held = null;
  const release = () => { if (held) { held.removeAttribute('data-pressed'); held = null; } };
  document.addEventListener('pointerdown', e => {
    const el = e.target.closest && e.target.closest(PRESSABLE);
    release();
    if (!el || el.disabled || el.classList.contains('disabled')) return;
    held = el;
    el.setAttribute('data-pressed', '');
  }, true);
  // Lift, cancel, or a scroll that turns the tap into a swipe — all release it.
  ['pointerup', 'pointercancel', 'dragstart'].forEach(ev =>
    document.addEventListener(ev, release, true));
  window.addEventListener('scroll', release, { capture: true, passive: true });
  window.addEventListener('blur', release);
})();

// Close sidebar pop-ups (More menu, profile menu) on outside click
document.addEventListener('click', e => {
  const more = document.getElementById('sb-more');
  if (more && more.classList.contains('open') && !more.contains(e.target)) more.classList.remove('open');
  const langDd = document.getElementById('set-lang-dd');
  if (langDd && langDd.classList.contains('open') && !langDd.contains(e.target)) closeSetLangDD();
  const pm = document.getElementById('sb-profile-menu');
  const footer = document.getElementById('sidebar-footer');
  const langList = document.getElementById('pm-lang-list');   // lives in <body> once opened
  const insideLang = langList && langList.contains(e.target);
  if (pm && pm.classList.contains('open') && !pm.contains(e.target) && !insideLang && !(footer && footer.contains(e.target))) {
    pm.classList.remove('open');
    if (langList) langList.classList.remove('open');
  }
});

async function doLogout() {
  currentUser = null;
  try { await DB.logout(); } catch (e) {}   // ends the session server-side too
  window.location.replace('login.html');
}

// Session expired (or was revoked — e.g. an admin reset this account's
// password). Say so, then send them back to sign in with their credentials.
if (typeof DB !== 'undefined' && DB.onAuthLost) {
  DB.onAuthLost(() => {
    currentUser = null;
    try { toast(bi('ໝົດອາຍຸການເຂົ້າສູ່ລະບົບ — ກະລຸນາເຂົ້າສູ່ລະບົບໃໝ່',
                   'Session expired — please sign in again',
                   'เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่',
                   '세션이 만료되었습니다 — 다시 로그인하세요'), 'warn'); } catch (e) {}
    setTimeout(() => window.location.replace('login.html'), 1200);
  });
}

// ── Helpers ───────────────────────────────────────────────────────
function parseDate(s) {
  if (!s) return null;
  const p = s.replace(/-/g, '/').split('/');
  if (p.length < 3) return null;
  return new Date(+p[2], +p[1] - 1, +p[0]);
}
/* One implementation, shared with the server — see infra/age.js for why. The
 * old body here divided by an average year and read a year low on birthdays,
 * which meant the spreadsheet in an export package could disagree with the
 * summary next to it about whether somebody was 17 or 18. */
function calcAge(dob) { return KDAge.age(dob); }
// Passport-expiry alert thresholds (configurable in Settings → Notifications).
// Stored in months; default 12 (urgent/red) and 24 (upcoming/yellow).
function expiryWarnMonths() { return Math.max(1, parseInt(DB.getSetting('warn_months', 12), 10) || 12); }
function expiryNearMonths() { return Math.max(expiryWarnMonths(), parseInt(DB.getSetting('near_months', 24), 10) || 24); }
function expiryClass(s) {
  const d = parseDate(s);
  if (!d) return '';
  const ms = d - Date.now();
  const month = 30.4375 * 864e5;
  if (ms < 0)                          return 'expiry-expired';
  if (ms < expiryWarnMonths() * month) return 'expiry-warn';
  if (ms < expiryNearMonths() * month) return 'expiry-near';
  return 'expiry-ok';
}
function empBadge(code) {
  if (!code) return '<span class="emp-badge emp-other">--</span>';
  const known = ['VK','TK','VV','HSF','NXT','XTN','PH'];
  const cls = known.includes(code) ? 'emp-' + code : 'emp-other';
  return '<span class="emp-badge ' + cls + '">' + code + '</span>';
}
function esc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// For OOXML exports (xlsx/pptx): also strip characters that are illegal in
// XML 1.0 — a single stray control char makes Office show a "repair" dialog.
function _xmlSafe(s) {
  return esc((s == null ? '' : String(s)).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''));
}

// ── Avatar ────────────────────────────────────────────────────────
const AVATAR_PALETTE = [
  '#1a6fa8','#c0392b','#1a8a50','#7b2fa8','#a04010',
  '#0f6e6e','#8b4513','#2c5f8a','#7a3b6e','#3a6b3a'
];
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < (name||'').length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xFFFFFF;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}
function avatarInitials(name) {
  const parts = (name || '?').trim().split(/\s+/);
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
function avatarHtml(name, sizeClass) {
  const bg  = avatarColor(name);
  const ini = avatarInitials(name);
  return '<div class="avatar ' + sizeClass + '" style="background:' + bg + '" title="' + esc(name) + '">' + ini + '</div>';
}

// Employee photo: real photo if uploaded/scanned, else initials avatar placeholder.
// List/grid/table use the tiny thumbnail when available (falls back to the full
// photo), so these dense views load a fraction of the bytes.
function personPhoto(w, sizeClass) {
  if (w && w.photo) {
    const src = w.photo_thumb || w.photo;
    return '<div class="avatar ' + sizeClass + ' has-photo" title="' + esc(w.en_name || '') + '">' +
           '<img src="' + src + '" alt="' + esc(w.en_name || '') + '" loading="lazy" decoding="async"></div>';
  }
  return avatarHtml(w ? w.en_name : '', sizeClass);
}

// Build a small (~max px) JPEG thumbnail data-URL from any same-origin image
// source (a data: URL fresh from upload, or an existing /uploads/… path used by
// the one-time backfill). Resolves '' on any failure so callers can no-op.
function _genThumb(src, max) {
  return new Promise(resolve => {
    if (!src || typeof src !== 'string') return resolve('');
    const img = new Image();
    img.onload = () => {
      try {
        const m = max || 240;
        const iw = img.width || m, ih = img.height || m;
        const scale = Math.min(1, m / Math.max(iw, ih));
        const cw = Math.max(1, Math.round(iw * scale));
        const ch = Math.max(1, Math.round(ih * scale));
        const c = document.createElement('canvas'); c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(img, 0, 0, cw, ch);
        resolve(c.toDataURL('image/jpeg', 0.72));
      } catch (e) { resolve(''); }
    };
    img.onerror = () => resolve('');
    img.src = src;
  });
}

// Fire-and-forget: generate a thumbnail for a just-saved photo and persist it as
// a follow-up patch. Kept separate from the main save so the photo write is never
// delayed or blocked by thumbnail work.
function _queueThumb(uid, src) {
  if (!/^data:image\//.test(src || '')) return;
  const gid = activeGroupId;
  _genThumb(src, 240).then(thumb => {
    if (!thumb) return;
    DB.updateWorker(gid, uid, { photo_thumb: thumb });
    const g = DB.getGroup(gid);
    const w = g && g.workers.find(x => x.uid === uid);
    if (w) w.photo_thumb = thumb;   // keep the in-memory copy in sync
    _refreshPhotoViews();           // swap the temporary full photo for the light thumb
  });
}

// The list / dashboard cards show `photo_thumb || photo`, so after a photo
// changes they keep showing the OLD thumbnail until a re-render. Call this after
// any photo write to repaint whichever view is on screen (the detail drawer
// refreshes itself separately). Callers also clear the stale in-memory
// photo_thumb first, so the immediate repaint falls back to the fresh full photo
// while _queueThumb regenerates the light one.
function _refreshPhotoViews() {
  if (document.getElementById('dashboard-welcome')?.style.display !== 'none') renderDashboard();
  if (document.getElementById('group-view')?.style.display !== 'none') renderTable();
}

// One-time migration: build a thumbnail for every existing photo that lacks one.
// Runs fully in the browser (canvas), a few images at a time, and reports progress
// on the triggering button. Safe to re-run — it only touches rows still missing a
// thumbnail, so an interrupted run just resumes.
async function backfillThumbnails(btn) {
  const todo = [];
  DB.getGroups().forEach(g => (g.workers || []).forEach(w => {
    if (w.photo && !w.photo_thumb) todo.push({ gid: g.id, uid: w.uid, src: w.photo });
  }));
  if (!todo.length) {
    toast(bi('ມີ thumbnail ຄົບແລ້ວ', 'All thumbnails already generated', 'มี thumbnail ครบแล้ว', '썸네일이 이미 모두 생성됨'));
    return;
  }
  const sub  = btn ? btn.querySelector('.set-action-sub') : null;
  const orig = sub ? sub.textContent : '';
  if (btn) btn.disabled = true;
  let done = 0, failed = 0, i = 0;
  const setLbl = () => { if (sub) sub.textContent = (done + failed) + ' / ' + todo.length + ' …'; };
  setLbl();
  const worker = async () => {
    while (i < todo.length) {
      const item = todo[i++];
      const thumb = await _genThumb(item.src, 240);
      if (thumb) { DB.updateWorker(item.gid, item.uid, { photo_thumb: thumb }); done++; }
      else failed++;
      if ((done + failed) % 5 === 0) setLbl();
    }
  };
  await Promise.all([worker(), worker(), worker()]);   // 3 in parallel
  if (btn) btn.disabled = false;
  if (sub) sub.textContent = orig;
  toast(bi('ສ້າງ thumbnail ' + done + ' ຮູບ', 'Generated ' + done + ' thumbnails' + (failed ? ' (' + failed + ' failed)' : ''),
           'สร้าง thumbnail แล้ว ' + done + ' รูป' + (failed ? ' (พลาด ' + failed + ')' : ''), '썸네일 ' + done + '개 생성'));
}

// Passport status → {label, cls} for the "Status" column/badge
function passportStatus(w) {
  const ec = expiryClass(w.passport_expiry);
  if (!w.passport_expiry || ec === '') return { label: t('status_none'),     cls: 'st-none' };
  if (ec === 'expiry-expired')         return { label: t('status_expired'),  cls: 'st-expired' };
  if (ec === 'expiry-warn' || ec === 'expiry-near') return { label: t('status_expiring'), cls: 'st-expiring' };
  return { label: t('status_valid'), cls: 'st-valid' };
}
function statusBadge(w) {
  const s = passportStatus(w);
  return '<span class="status-badge ' + s.cls + '">' + esc(s.label) + '</span>';
}

// ── Province combobox ─────────────────────────────────────────────
const LA_PROVINCES = [
  { lo: 'ນະຄອນຫຼວງວຽງຈັນ', en: 'Vientiane Pref.' },
  { lo: 'ຜົ້ງສາລີ',         en: 'Phongsaly' },
  { lo: 'ຫຼວງນ້ຳທາ',        en: 'Luangnamtha' },
  { lo: 'ອຸດົມໄຊ',          en: 'Oudomxay' },
  { lo: 'ບໍ່ແກ້ວ',           en: 'Bokeo' },
  { lo: 'ຫຼວງພະບາງ',        en: 'Luangprabang' },
  { lo: 'ຫົວພັນ',            en: 'Houaphanh' },
  { lo: 'ໄຊຍະບູລີ',         en: 'Xayaboury' },
  { lo: 'ຊຽງຂວາງ',          en: 'Xiengkhuang' },
  { lo: 'ວຽງຈັນ',            en: 'Vientiane Province' },
  { lo: 'ບໍລິຄຳໄຊ',         en: 'Bolikhamxay' },
  { lo: 'ຄຳມ່ວນ',            en: 'Khammouane' },
  { lo: 'ສະຫວັນນະເຂດ',      en: 'Savannakhet' },
  { lo: 'ສາລະວັນ',           en: 'Salavan' },
  { lo: 'ເຊກອງ',             en: 'Sekong' },
  { lo: 'ຈຳປາສັກ',           en: 'Champasak' },
  { lo: 'ອັດຕະປື',           en: 'Attapeu' },
  { lo: 'ໄຊສົມບູນ',          en: 'Xaisomboun' },
];

const LA_DISTRICTS = {
  'ນະຄອນຫຼວງວຽງຈັນ': ['Chanthabuly','Sikhottabong','Xaysetha','Sisattanak','Naxaithong','Xaythany','Hadxayfong','Sangthong','Pakngum'],
  'ຜົ້ງສາລີ':        ['Phongsaly','Mai','Khoua','Samphanh','Bounneua','Yotou','Bountai'],
  'ຫຼວງນ້ຳທາ':       ['Namtha','Sing','Long','Viengphoukha','Nale'],
  'ອຸດົມໄຊ':         ['Xai','La','Namo','Nga','Beng','Houn','Pakbeng'],
  'ບໍ່ແກ້ວ':          ['Houayxay','Tonpheng','Meung','Phaoudom','Paktha'],
  'ຫຼວງພະບາງ':       ['Luangprabang','Xiengngeun','Nane','Pakou','Nambak','Ngoi','Pakxeng','Phonxai','Chomphet','Viengkham','Phoukhoune','Phonthong'],
  'ຫົວພັນ':           ['Xamneua','Xiengkhor','Hiam','Viengxai','Houameuang','Xamtai','Sopbao','Et','Kuan','Xon'],
  'ໄຊຍະບູລີ':        ['Xayaboury','Khop','Hongsa','Ngeun','Xienghone','Phiang','Paklay','Kenthao','Botene','Thongmyxay','Xaisathan'],
  'ຊຽງຂວາງ':         ['Pek','Kham','Nonghed','Khoune','Morkmay','Phookood','Phaxay'],
  'ວຽງຈັນ':           ['Phonhong','Thoulakhom','Keoudom','Kasi','Vangvieng','Feuang','Xanakham','Mad','Hinhurp','Viengkham','Meun'],
  'ບໍລິຄຳໄຊ':        ['Paksan','Thaphabat','Pakkading','Borikhan','Khamkeut','Viengthong','Xaychamphone'],
  'ຄຳມ່ວນ':           ['Thakhek','Mahaxay','Nongbok','Hineboune','Yommalath','Boualapha','Nakai','Xebangfai','Xaibouathong','Khounkham'],
  'ສະຫວັນນະເຂດ':     ['Kayson Phomvihan','Outhoumphone','Atsaphangthong','Phine','Sepone','Nong','Thapangthong','Songkhone','Champhone','Xonbouly','Xaybouly','Vilabouly','Atsaphone','Xayphouthong','Phalanhxay'],
  'ສາລະວັນ':          ['Salavan','Taouay','Tumlan','Lakhonepheng','Vapi','Khongxedone','Laongam','Samouay'],
  'ເຊກອງ':            ['Lamam','Kaleum','Dakcheung','Thateng'],
  'ຈຳປາສັກ':          ['Pakse','Sanasomboon','Bachiangchaleunsook','Paksong','Pathoomphone','Phonthong','Champasak','Soukhouma','Mounlapamok','Khong'],
  'ອັດຕະປື':          ['Xaysetha','Samakkhixay','Sanamxay','Sanxay','Phouvong'],
  'ໄຊສົມບູນ':         ['Anouvong','Longchaan','Thathom','Longcheng','Hom'],
};

function _collectAddrField(field) {
  const seen = new Set();
  DB.getGroups().forEach(g => (g.workers || []).forEach(w => {
    const v = (w[field] || '').trim();
    if (v) seen.add(v);
  }));
  return [...seen].sort((a, b) => a.localeCompare(b, 'lo'));
}

function initAddrCombobox(inputId, listId, getItems) {
  const input = document.getElementById(inputId);
  const list  = document.getElementById(listId);
  if (!input || !list) return;

  let focusIdx = -1;

  // item can be a string  OR  { value, label } — label shown, value stored
  function _val(item)   { return typeof item === 'string' ? item : (item.value || ''); }
  function _label(item) { return typeof item === 'string' ? item : (item.label || item.value || ''); }
  function _matches(item, q) {
    if (!q) return true;
    const ql = q.toLowerCase();
    const v  = _val(item).toLowerCase();
    const l  = _label(item).toLowerCase();
    return v.includes(ql) || l.includes(ql);
  }

  function renderList(q) {
    const all   = getItems();
    const items = q ? all.filter(p => _matches(p, q)) : all;
    if (!items.length) { list.style.display = 'none'; return; }
    focusIdx = -1;
    list.innerHTML = items.map((p, i) =>
      '<div class="addr-combo-item" data-val="' + esc(_val(p)) + '" data-i="' + i + '">' + esc(_label(p)) + '</div>'
    ).join('');
    list.style.display = 'block';
  }

  function closeList() { list.style.display = 'none'; focusIdx = -1; }
  function pick(val) {
    input.value = val;
    // Setting .value fires nothing, so any oninput mirror (the Location
    // Dictionary's free-text level writes through to its address column) would
    // miss the pick. Dispatch before closeList — the echo re-opens the list and
    // closeList then shuts it again.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    closeList();
    input.focus();
  }

  list.addEventListener('mousedown', e => {
    const item = e.target.closest('.addr-combo-item');
    if (item) { e.preventDefault(); pick(item.dataset.val); }
  });

  input.addEventListener('focus', () => renderList(input.value.trim()));
  input.addEventListener('input', () => renderList(input.value.trim()));
  input.addEventListener('blur',  () => setTimeout(closeList, 160));

  input.addEventListener('keydown', e => {
    if (list.style.display === 'none') return;
    const items = list.querySelectorAll('.addr-combo-item');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (!items.length) return;
      if (focusIdx >= 0) items[focusIdx].classList.remove('focused');
      if (e.key === 'ArrowDown') {
        focusIdx = focusIdx < items.length - 1 ? focusIdx + 1 : items.length - 1;
      } else {
        focusIdx = focusIdx > 0 ? focusIdx - 1 : 0;
      }
      items[focusIdx].classList.add('focused');
      items[focusIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (focusIdx >= 0 && items.length) {
        e.preventDefault();
        e.stopPropagation();
        pick(items[focusIdx].dataset.val);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeList();
    }
  });
}

function initProvinceCombobox() {
  // Province: store Lao name, show "ລາວ — English"
  initAddrCombobox('f-province', 'addr-combo-list-province',
    () => LA_PROVINCES.map(p => ({ value: p.lo, label: p.lo + ' — ' + p.en }))
  );

  // District: cascade from selected province; fallback = all districts; merge with DB entries
  initAddrCombobox('f-district', 'addr-combo-list-district', () => {
    const prov  = (document.getElementById('f-province') || {}).value || '';
    const predefined = (prov && LA_DISTRICTS[prov]) ? LA_DISTRICTS[prov]
                     : Object.values(LA_DISTRICTS).flat();
    const dynamic = _collectAddrField('district');
    return [...new Set([...predefined, ...dynamic])].sort((a, b) => a.localeCompare(b));
  });

  // Village: dynamic from DB only
  initAddrCombobox('f-village', 'addr-combo-list-village',
    () => _collectAddrField('village')
  );
}

// ── Date-picker helpers ────────────────────────────────────────────
// Each picker: dp-{id} contains .dp-d / .dp-m / .dp-y; hidden input #f-{id}
function initDatePickers() {
  ['dp-dob','dp-issue','dp-expiry'].forEach(dpId => {
    const wrap = document.getElementById(dpId);
    if (!wrap) return;
    const [dEl, , mEl, , yEl] = wrap.children; // d / sep / m / sep / y
    const hidden = document.getElementById(dpId.replace('dp-','f-'));

    function sync() {
      const d = String(dEl.value).padStart(2,'0');
      const m = String(mEl.value).padStart(2,'0');
      const y = yEl.value;
      hidden.value = (dEl.value && mEl.value && yEl.value) ? d+'/'+m+'/'+y : '';
    }

    dEl.addEventListener('input', () => {
      if (dEl.value > 31) dEl.value = 31;
      if (dEl.value < 0) dEl.value = '';
      if (String(dEl.value).length >= 2) mEl.focus();
      sync();
    });
    mEl.addEventListener('input', () => {
      if (mEl.value > 12) mEl.value = 12;
      if (mEl.value < 0) mEl.value = '';
      if (String(mEl.value).length >= 2) yEl.focus();
      sync();
    });
    yEl.addEventListener('input', () => {
      if (yEl.value > 2099) yEl.value = 2099;
      if (yEl.value < 0) yEl.value = '';
      sync();
    });
    [dEl, mEl, yEl].forEach(el => {
      el.addEventListener('keydown', e => {
        if (!['0','1','2','3','4','5','6','7','8','9',
              'Backspace','Delete','Tab','ArrowLeft','ArrowRight',
              'ArrowUp','ArrowDown'].includes(e.key)) {
          e.preventDefault();
        }
      });
    });
  });
}

function setDatePicker(dpId, value) {
  const wrap = document.getElementById(dpId);
  if (!wrap) return;
  const [dEl, , mEl, , yEl] = wrap.children;
  const hidden = document.getElementById(dpId.replace('dp-','f-'));
  if (!value) { dEl.value = ''; mEl.value = ''; yEl.value = ''; hidden.value = ''; return; }
  const p = value.replace(/-/g,'/').split('/');
  if (p.length === 3) {
    dEl.value = parseInt(p[0],10) || '';
    mEl.value = parseInt(p[1],10) || '';
    yEl.value = p[2] || '';
    hidden.value = value;
  }
}

function _dateInputVal(id) {
  return (document.getElementById(id)||{}).value || '';
}

// ── Block Date Picker (for Group departure date) ──────────────────
const BDP = {
  day: null, month: null, year: null,
  MONTHS: ['January','February','March','April','May','June',
           'July','August','September','October','November','December'],
  SHORT:  ['Jan','Feb','Mar','Apr','May','Jun',
           'Jul','Aug','Sep','Oct','Nov','Dec'],
};

function bdpInit() {
  const now = new Date();
  BDP.year  = now.getFullYear();
  BDP.month = null;
  BDP.day   = null;
  bdpRender();
}

function bdpToggle() {
  const panel   = document.getElementById('bdp-panel');
  const trigger = document.getElementById('bdp-trigger');
  if (panel.classList.contains('open')) {
    panel.classList.remove('open');
    return;
  }
  // Position panel below trigger using fixed coordinates
  const rect = trigger.getBoundingClientRect();
  panel.style.top   = (rect.bottom + 6) + 'px';
  panel.style.left  = rect.left + 'px';
  panel.style.width = rect.width + 'px';
  // Flip upward if panel would go off-screen bottom
  bdpRender();
  panel.classList.add('open');
  requestAnimationFrame(() => {
    const ph = panel.offsetHeight;
    if (rect.bottom + 6 + ph > window.innerHeight) {
      panel.style.top = (rect.top - ph - 6) + 'px';
    }
  });
}

function bdpRender() {
  _bdpRenderYears();
  _bdpRenderMonths();
  _bdpRenderDays();
}

function _bdpRenderYears() {
  const now = new Date().getFullYear();
  const years = [now - 1, now, now + 1, now + 2, now + 3];
  document.getElementById('bdp-years').innerHTML = years.map(y =>
    '<div class="bdp-block' + (BDP.year === y ? ' selected' : '') + '" onclick="bdpSetYear(' + y + ')">' + y + '</div>'
  ).join('');
}

function _bdpRenderMonths() {
  document.getElementById('bdp-months').innerHTML = BDP.MONTHS.map((m, i) =>
    '<div class="bdp-block' + (BDP.month === i + 1 ? ' selected' : '') + '" onclick="bdpSetMonth(' + (i + 1) + ')">' + BDP.SHORT[i] + '</div>'
  ).join('');
}

function _bdpRenderDays() {
  // Determine max days for selected month/year
  const maxDay = (BDP.month && BDP.year)
    ? new Date(BDP.year, BDP.month, 0).getDate()
    : 31;
  let html = '';
  for (let d = 1; d <= maxDay; d++) {
    html += '<div class="bdp-block' + (BDP.day === d ? ' selected' : '') + '" onclick="bdpSetDay(' + d + ')">' + d + '</div>';
  }
  document.getElementById('bdp-days').innerHTML = html;
}

function bdpSetYear(y) {
  BDP.year = y;
  // Re-clamp day if month has fewer days now
  if (BDP.month && BDP.day) {
    const max = new Date(y, BDP.month, 0).getDate();
    if (BDP.day > max) BDP.day = max;
  }
  bdpRender();
  bdpCommit();
}

function bdpSetMonth(m) {
  BDP.month = m;
  // Re-clamp day for new month
  if (BDP.day) {
    const max = new Date(BDP.year || new Date().getFullYear(), m, 0).getDate();
    if (BDP.day > max) BDP.day = max;
  }
  _bdpRenderMonths();
  _bdpRenderDays();
  bdpCommit();
}

function bdpSetDay(d) {
  BDP.day = d;
  _bdpRenderDays();
  bdpCommit();
  // Close panel after full date selected
  if (BDP.day && BDP.month && BDP.year) {
    setTimeout(() => document.getElementById('bdp-panel').classList.remove('open'), 180);
  }
}

function bdpCommit() {
  const parts = [];
  if (BDP.day)   parts.push(BDP.day);
  if (BDP.month) parts.push(BDP.MONTHS[BDP.month - 1]);
  if (BDP.year)  parts.push(BDP.year);

  const display = parts.join(' ') || '-- Select date --';
  const hidden  = parts.length === 3
    ? String(BDP.day).padStart(2,'0') + '/' + String(BDP.month).padStart(2,'0') + '/' + BDP.year
    : '';

  const trigger = document.getElementById('bdp-trigger');
  document.getElementById('bdp-display').textContent = display;
  trigger.classList.toggle('has-value', parts.length > 0);
  document.getElementById('gf-date').value = hidden;
}

function bdpLoadValue(val) {
  // val is "DD/MM/YYYY" or empty
  if (!val) { BDP.day = null; BDP.month = null; BDP.year = null; }
  else {
    const p = val.split('/');
    BDP.day   = parseInt(p[0]) || null;
    BDP.month = parseInt(p[1]) || null;
    BDP.year  = parseInt(p[2]) || new Date().getFullYear();
  }
  bdpCommit();
}

// Close picker on outside click
document.addEventListener('click', e => {
  const panel   = document.getElementById('bdp-panel');
  const trigger = document.getElementById('bdp-trigger');
  if (panel && !panel.contains(e.target) && !trigger.contains(e.target)) {
    panel.classList.remove('open');
  }
});

// ── SIDEBAR ───────────────────────────────────────────────────────
// One clean, clickable project row — no expand control, no metadata clutter.
// All per-project actions live behind a single 3-dot menu.
function _groupRowHtml(g, s, totalGroups) {
  const active = g.id === activeGroupId;
  const pinned = pinnedGroups.has(g.id);
  const alertDot = s.expiring ? '<span class="tree-alert" data-i18n-title="tip_passport_expiring" title="' + esc(bi('ພາສປອດໃກ້ໝົດອາຍຸ', 'Passport expiring', 'พาสปอร์ตใกล้หมดอายุ', '여권 만료 임박')) + '"></span>' : '';
  return (
    '<div class="tree-group" id="tg-' + g.id + '">' +
      '<div class="tree-group-row' + (active ? ' active' : '') + '" onclick="switchGroup(\'' + g.id + '\')">' +
        '<span class="tree-folder-icon' + (active ? ' open' : '') + (pinned ? ' pinned' : '') + '">' + (pinned ? '&#128204;' : '&#128193;') + '</span>' +
        '<span class="tree-group-name">' + esc(g.name) + '</span>' +
        alertDot +
        '<span class="tree-count">' + (s.count || 0) + '</span>' +
        '<button class="kebab tree-kebab" onclick="openGroupMenu(\'' + g.id + '\',event)" title="' + esc(t('col_actions')) + '">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>' +
        '</button>' +
      '</div>' +
    '</div>'
  );
}

function renderSidebar() {
  applySidebarPrefs();   // honour Customize-sidebar visibility choices
  updateSelectedBadge();
  const allGroups = DB.getGroups();
  const groups = _orderGroups(allGroups.filter(g => !g.archived));   // active list, manual order
  const stats  = DB.getAllStats();
  const q = sidebarSearchQ.toLowerCase();
  const statsMap = {};
  stats.forEach(s => { statsMap[s.id] = s; });

  const filtered = groups.filter(g => !q || g.name.toLowerCase().includes(q));
  const pinned   = filtered.filter(g => pinnedGroups.has(g.id));
  const rest     = filtered.filter(g => !pinnedGroups.has(g.id));

  // Pinned section
  const pinnedSec  = document.getElementById('sb-pinned-section');
  const pinnedTree = document.getElementById('pinned-tree');
  if (pinned.length) {
    pinnedSec.style.display = '';
    pinnedTree.innerHTML = pinned.map(g => _groupRowHtml(g, statsMap[g.id] || {}, groups.length)).join('');
  } else {
    pinnedSec.style.display = 'none';
    pinnedTree.innerHTML = '';
  }

  // All groups
  const tree = document.getElementById('sidebar-tree');
  tree.innerHTML = rest.length
    ? rest.map(g => _groupRowHtml(g, statsMap[g.id] || {}, groups.length)).join('')
    : '<div style="padding:14px;font-size:0.78rem;color:var(--text-faint);text-align:center">' + t('no_groups') + '</div>';

  const gc = document.getElementById('groups-count');
  if (gc) gc.textContent = groups.length;

  // Archived section — only visible when there is something archived
  const archived  = _orderGroups(allGroups.filter(g => g.archived))
                      .filter(g => !q || g.name.toLowerCase().includes(q));
  const archSec   = document.getElementById('sb-archived-section');
  const archTree  = document.getElementById('archived-tree');
  const archCount = document.getElementById('archived-count');
  if (archSec && archTree) {
    if (archived.length) {
      archSec.style.display = '';
      archTree.innerHTML = archived.map(g => _groupRowHtml(g, statsMap[g.id] || {}, allGroups.length)).join('');
      if (archCount) archCount.textContent = archived.length;
    } else {
      archSec.style.display = 'none';
      archTree.innerHTML = '';
    }
  }
}

// ── Pin / unpin a group ───────────────────────────────────────────
function togglePin(id, event) {
  if (event) event.stopPropagation();
  if (pinnedGroups.has(id)) pinnedGroups.delete(id);
  else pinnedGroups.add(id);
  try { localStorage.setItem('kd_pinned', JSON.stringify([...pinnedGroups])); } catch (e) {}
  renderSidebar();
}

// ── Project (group) 3-dot context menu ────────────────────────────
let groupMenuId = null;
function openGroupMenu(id, ev) {
  if (ev) ev.stopPropagation();
  groupMenuId = id;
  const menu = document.getElementById('row-menu');
  if (!menu) return;
  const pinned = pinnedGroups.has(id);
  const g = DB.getGroup(id);
  const isArch = !!(g && g.archived);
  const I = {
    share:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>',
    rename: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
    moveup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
    movedn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
    pin:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.5-4V5a2 2 0 0 0-2-2h-5a2 2 0 0 0-2 2v8z"/></svg>',
    history:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
    archive:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
    unarchive:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><polyline points="9 13 12 10 15 13"/><line x1="12" y1="10" x2="12" y2="17"/></svg>',
    del:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
  };
  const item = (act, icon, label, danger) =>
    '<button' + (danger ? ' class="danger"' : '') + ' onclick="groupMenuAct(\'' + act + '\')">' + icon + '<span>' + label + '</span></button>';

  menu.innerHTML =
    item('share',  I.share,  t('gm_share')) +
    item('pin',    I.pin,    pinned ? t('unpin') : t('gm_pin')) +
    item('history', I.history, bi('ປະຫວັດ', 'History', 'ประวัติ', '기록')) +
    (isAdmin() ?
      item('rename',    I.rename,  t('gm_rename')) +
      item('move_up',   I.moveup,  t('gm_move_up')) +
      item('move_down', I.movedn,  t('gm_move_down')) +
      (isArch ? item('unarchive', I.unarchive, t('gm_unarchive'))
              : item('archive',   I.archive,   t('gm_archive'))) +
      item('del',       I.del,     t('gm_delete'), true)
      : '');

  const btn = ev ? ev.currentTarget : null;
  menu.classList.add('open');
  if (btn) {
    const r = btn.getBoundingClientRect();
    const mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 200;
    let left = r.right - mw; if (left < 8) left = 8;
    let top = r.bottom + 6; if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;
    menu.style.left = left + 'px';
    menu.style.top = Math.max(8, top) + 'px';
  }
}
function groupMenuAct(action) {
  const id = groupMenuId;
  closeRowMenu();
  if (action === 'pin')            togglePin(id);
  else if (action === 'history')   openGroupHistory(id);
  else if (action === 'rename')    openGroupForm(id);
  else if (action === 'del')       confirmDeleteGroup(id);
  else if (action === 'share')     shareGroup(id);
  else if (action === 'move_up')   moveGroup(id, -1);
  else if (action === 'move_down') moveGroup(id, +1);
  else if (action === 'archive')   setGroupArchived(id, true);
  else if (action === 'unarchive') setGroupArchived(id, false);
}

// "Share" a group = open it and bring up the Export dialog, where the user
// picks a file format (.kdb / CSV / PDF) to send on.
function shareGroup(id) {
  switchGroup(id);
  openExportDialog('group');
}

// Archive / unarchive a group (server-persisted `archived` flag). Archived
// groups drop out of the main lists into the sidebar's "Archived" section.
function setGroupArchived(id, on) {
  if (!isAdmin()) return;
  DB.updateGroup(id, { archived: on });
  if (on && activeGroupId === id) {
    const next = DB.getGroups().find(x => !x.archived && x.id !== id);
    if (next) { switchGroup(next.id); }
    else { activeGroupId = ''; navTo('workers'); }
  } else {
    refreshAll();
  }
  toast(t(on ? 'gm_archived_done' : 'gm_unarchived_done'), 'ok');
}

// ── Manual group ordering (Move up / Move down, per-device) ───────
function _loadGroupOrder() {
  try { return JSON.parse(localStorage.getItem('kd_group_order')) || []; } catch (e) { return []; }
}
function _saveGroupOrder(ids) {
  try { localStorage.setItem('kd_group_order', JSON.stringify(ids)); } catch (e) {}
}
// Sort groups by the saved order; ids not in the list keep their original
// relative position at the end (stable).
function _orderGroups(groups) {
  const order = _loadGroupOrder();
  const pos = {};
  order.forEach((gid, i) => { pos[gid] = i; });
  return groups.slice().sort((a, b) => {
    const pa = (a.id in pos) ? pos[a.id] : Infinity;
    const pb = (b.id in pos) ? pos[b.id] : Infinity;
    return pa - pb;
  });
}
// Move a group up/down among its own section siblings (pinned vs unpinned).
function moveGroup(id, dir) {
  const ordered = _orderGroups(DB.getGroups().filter(g => !g.archived));
  const ids = ordered.map(g => g.id);
  const isPin = pinnedGroups.has(id);
  const secPos = [];                       // indices of same-section groups
  ordered.forEach((g, i) => { if (pinnedGroups.has(g.id) === isPin) secPos.push(i); });
  const at = secPos.findIndex(i => ids[i] === id);
  const to = at + dir;
  if (at < 0 || to < 0 || to >= secPos.length) return;   // already at section edge
  const a = secPos[at], b = secPos[to];
  const tmp = ids[a]; ids[a] = ids[b]; ids[b] = tmp;
  _saveGroupOrder(ids);
  renderSidebar();
  if (document.getElementById('groups-overview')?.style.display !== 'none') renderGroupsOverview();
}

// ── Sidebar nav (views) ───────────────────────────────────────────
/**
 * Point the phone tab bar at the view actually on screen.
 *
 * navTo only ever cleared `.active` from `.sb-nav-item`, so the tab that was
 * tapped kept its highlight forever and a second tab lit up beside it — two
 * "current" tabs at once. It went unnoticed while the only difference was a
 * tinted label; with a filled icon marking the selection it would be the first
 * thing anyone saw.
 *
 * Driven by the view name rather than the element, so the bar follows along
 * even when the navigation came from the sidebar drawer. A view with no tab of
 * its own (Selected, a global search) leaves the bar with nothing selected —
 * which is honest, where showing some other tab as current would not be.
 */
function _syncTabBar(view) {
  document.querySelectorAll('.bn-item').forEach(b => b.classList.remove('active'));
  document.getElementById('bn-' + view)?.classList.add('active');
  _tabDockExpand();          // choosing a section always brings the bar back
}

/* ── Minimise the tab dock while reading (iOS TabBarMinimizeBehavior) ──
 * Scroll down and the capsule shrinks out of the way; scroll back to the top,
 * or tap a tab, and it returns. Both exits are the ones the platform defines.
 *
 * The listener is passive and does its work in a frame callback: this fires on
 * every scroll event over a list of 369 real rows, and anything that reads
 * layout synchronously here would be felt.  */
const _TAB_MIN_AT = 56;      // px scrolled before the bar gets out of the way
let _tabDockY = 0, _tabDockTick = false;

function _tabDockExpand() { document.getElementById('tab-dock')?.classList.remove('minimized'); }

function _tabDockOnScroll() {
  if (_tabDockTick) return;
  _tabDockTick = true;
  requestAnimationFrame(() => {
    _tabDockTick = false;
    const dock = document.getElementById('tab-dock');
    if (!dock) return;
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    const down = y > _tabDockY;
    _tabDockY = y;
    // Back at the top always expands, whichever way the last few pixels went.
    if (y <= 8) dock.classList.remove('minimized');
    else if (down && y > _TAB_MIN_AT) dock.classList.add('minimized');
    else if (!down) dock.classList.remove('minimized');
  });
}
window.addEventListener('scroll', _tabDockOnScroll, { passive: true });

/* The flag above is cleared inside the frame callback and nowhere else, which
 * is fine right up until the frame never arrives. Scroll once, switch apps
 * before the browser paints, and the callback is dropped with `_tabDockTick`
 * still true — every later scroll then returns on its first line and the dock
 * is dead until the page is reloaded.
 *
 * Reproduced by holding a frame and discarding it: after one lost frame, three
 * further scrolls booked no frames at all and the bar never moved again.
 *
 * A backgrounded tab is exactly when frames stop, so coming back to the
 * foreground is where the flag gets its second way out. */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) _tabDockTick = false;
});

// Tapping the bar itself counts as "I want it back", including the search button.
document.addEventListener('click', e => {
  if (e.target.closest && e.target.closest('#tab-dock')) _tabDockExpand();
}, true);

/**
 * The search button beside the tab capsule.
 *
 * Search is not a section, so it does not get a tab — HIG seats it at the
 * trailing end for exactly that reason. What it opens is the search this app
 * already has: the drawer's field, which looks across every group rather than
 * filtering whichever list happens to be on screen. Opening the drawer to get
 * at it is the honest version of "we have one search"; a second search box
 * that covered only part of the data would be worse than a drawer slide.
 */
function openTabSearch() {
  const sb = document.getElementById('sidebar');
  if (sb && !sb.classList.contains('open')) toggleMobileMenu();
  const input = document.getElementById('sidebar-search-input');
  if (input) setTimeout(() => { input.focus(); input.select(); }, 220);
}

function navTo(view, el) {
  // Projects: just expand the sidebar's group list, no main-view change
  if (view === 'projects') {
    document.getElementById('sb-groups-section')?.classList.remove('collapsed');
    document.getElementById('sidebar').classList.remove('open');
    return;
  }

  document.querySelectorAll('.sb-nav-item').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  _syncTabBar(view);
  _overviewMode = '';

  const clearSearch = () => {
    const s = document.getElementById('search'); if (s) s.value = '';
    const ts = document.getElementById('sidebar-search-input'); if (ts) ts.value = '';
    ['f-employer','f-supervisor','f-blood'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
  };

  if (view === 'dashboard') {
    quickFilter = '';
    clearSearch();
    renderDashboard();
    showMainView('dashboard');
  } else if (view === 'workers') {
    // Landing = group overview. Pick a group to see its members.
    quickFilter = '';
    activeGroupId = '';
    clearSearch();
    renderGroupsOverview();
    showMainView('groups');
  } else if (view === 'alerts') {
    // Alerts = groups first (only those with expiring passports), then drill in
    _overviewMode = 'alerts';
    quickFilter = 'alerts';
    activeGroupId = '';
    renderGroupsOverview();
    showMainView('groups');
  } else if (view === 'selected') {
    // Selection = groups first, then drill into a group's selected members
    _overviewMode = 'selected';
    quickFilter = 'selected';
    activeGroupId = '';
    renderGroupsOverview();
    showMainView('groups');
  }
  updateSelectedBadge();
  document.querySelector('.main-content')?.scrollTo({ top: 0, behavior: 'smooth' });
  document.getElementById('sidebar').classList.remove('open');
}

// ── MAIN VIEW SWITCHING ───────────────────────────────────────────
// Every switch goes through here, so the entrance animation is identical
// wherever it was triggered from (nav, a card, search, the back link) and
// there is exactly one place that knows which views exist.
const MAIN_VIEWS = {
  dashboard: 'dashboard-welcome',
  groups:    'groups-overview',
  group:     'group-view',
};

function showMainView(name) {
  Object.keys(MAIN_VIEWS).forEach(key => {
    const el = document.getElementById(MAIN_VIEWS[key]);
    if (!el) return;
    if (key !== name) { el.style.display = 'none'; return; }
    el.style.display = '';
    _playEnter(el);
    el.querySelectorAll('.bento').forEach(replayTiles);
  });
}

// Restart a CSS animation: drop the class, force the style engine to notice the
// element is un-animated, then re-add. Without the reflow the browser coalesces
// remove+add into no change at all and nothing replays.
function _restart(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}
function _playEnter(el)   { _restart(el, 'view-enter'); }
function replayTiles(grid) { if (grid) _restart(grid, 'reveal'); }

// Cascade a freshly rendered list of rows/cards. Called after innerHTML swaps.
function playRowsIn(el) { if (el) _restart(el, 'rows-in'); }

// ── Sidebar search (now always visible — just focus it) ───────────
function toggleSidebarSearch() {
  const i = document.getElementById('sidebar-search-input');
  if (i) { i.focus(); i.select(); }
}

// ── "More" submenu ────────────────────────────────────────────────
function toggleMoreMenu(event) {
  if (event) event.stopPropagation();
  const more = document.getElementById('sb-more');
  const menu = document.getElementById('more-menu');
  if (!more || !menu) return;
  const willOpen = !more.classList.contains('open');
  more.classList.toggle('open');
  if (willOpen) {
    // Position the fixed popup just below the More button (avoids overflow clipping)
    const btn = more.querySelector('button');
    const r = btn.getBoundingClientRect();
    const mw = menu.offsetWidth || 200;
    let left = r.left;
    if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
    menu.style.left = left + 'px';
    menu.style.top  = (r.bottom + 4) + 'px';
  }
}
function closeMoreMenu() { document.getElementById('sb-more')?.classList.remove('open'); }

// ── GRADE (applicant grade A / B+ / B- / C) ───────────────────────
// The grade set is A / B+ / B- / C (matches the KD form). The bare legacy "B"
// is promoted to "B+" on read (_normGrade) so old records display correctly;
// it is also kept in GRADE_COLORS as an alias so any raw colour lookup still
// resolves instead of greying out. New saves always store the normalised value.
const GRADE_ORDER = ['A', 'B+', 'B-', 'C'];
/* Darkened so the WHITE label on the badge clears 4.5:1. The old values were
 * chosen as brand colours, not as backgrounds for text, and measured 3.30 (A),
 * 3.68 (B+) and 3.19 (C) — the letter was the least readable thing in the row.
 * B- already passed at 5.17 and is unchanged. Each new value is the lightest
 * one that reaches AA, so the palette shifts as little as possible. */
const GRADE_COLORS = { A:'#12873d', 'B+':'#07819e', 'B-':'#2563eb', C:'#b26205', B:'#07819e' };
function _normGrade(g) { return g === 'B' ? 'B+' : (g || ''); }
function gradeBadge(grade) {
  const g = _normGrade(grade);
  if (!g) return '';
  return '<span class="grade-badge" style="background:' + (GRADE_COLORS[g] || '#6b7280') + '">' + esc(g) + '</span>';
}

// ── SELECTION (shortlist of workers chosen "to go") ───────────────
// Stored as a list of uids in app_settings (no schema change; travels w/ backup).
function getSelectedUids() { const v = DB.getSetting('selected_uids', []); return Array.isArray(v) ? v : []; }
function isSelected(uid)   { return getSelectedUids().indexOf(uid) >= 0; }
function _selStar(uid) {
  if (!isAdmin()) return '';
  return '<button class="sel-star' + (isSelected(uid) ? ' on' : '') + '" onclick="toggleSelected(\'' + esc(uid) + '\',event)" ' +
         'title="' + esc(bi('ຄັດເລືອກ','Select','คัดเลือก','선택')) + '">&#9733;</button>';
}
function toggleSelected(uid, ev) {
  if (ev) ev.stopPropagation();
  if (!isAdmin()) return;
  let s = getSelectedUids();
  s = isSelected(uid) ? s.filter(x => x !== uid) : s.concat([uid]);
  DB.setSetting('selected_uids', s);
  updateSelectedBadge();
  if (quickFilter === 'selected') applyFilters();   // selected board: drop the deselected
  else renderTable();                               // reflect star state in the list
  const btn = document.getElementById('vm-select-btn');
  if (btn) btn.classList.toggle('on', isSelected(uid));
}
function updateSelectedBadge() {
  const n = getSelectedUids().length;
  const b = document.getElementById('sb-selected-badge');
  if (b) { b.textContent = n; b.style.display = n ? '' : 'none'; }
}

/* ── PICK — a working set for bulk actions ─────────────────────────
 * Deliberately NOT the star above. The star is a lasting business decision
 * ("this worker is going") that lives in app_settings and travels with a
 * backup; this is a scratch set the user builds to act on right now — export
 * these twelve, move those three. Conflating them would mean every export
 * selection silently rewrote the shortlist.
 *
 * Held in sessionStorage so a refresh mid-task does not lose it, and tied to
 * the group it was built in: a uid list carried into another group would act
 * on records the user can no longer see. The tie is checked on every paint
 * rather than only in switchGroup(), so no future navigation path can leak a
 * stale set into a different list.
 */
const PICK_KEY = 'kd_pick';
let _pick = new Set();
let _pickGroup = null;         // the group the set was last reconciled against

(function _pickRestore() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(PICK_KEY) || 'null');
    if (raw && Array.isArray(raw.uids)) _pick = new Set(raw.uids);
  } catch (e) { /* unreadable scratch state is not worth reporting */ }
})();

function _pickSave() {
  try { sessionStorage.setItem(PICK_KEY, JSON.stringify({ group: activeGroupId, uids: [..._pick] })); } catch (e) {}
}

/** Drop picks that the list now being shown does not contain. */
function _pickPrune() {
  if (!_pick.size) return;
  const pool = new Set((activeGroupId ? DB.getWorkers(activeGroupId) : _allWorkersFlat()).map(w => w.uid));
  let dropped = 0;
  [..._pick].forEach(uid => { if (!pool.has(uid)) { _pick.delete(uid); dropped++; } });
  if (dropped) _pickSave();
}

/* Who gets checkboxes. A Viewer holds no export grant and no write grant, so
 * offering them a selection would only lead to a refusal further along. */
function _canPick() {
  return isAdmin() || can('export.excel') || can('export.pdf') || can('export.bundle');
}

function isPicked(uid) { return _pick.has(uid); }
function pickedCount()  { return _pick.size; }

/** The picked workers, in the order the list is currently showing them. */
function pickedWorkers() {
  const pool = tableFiltered.length ? tableFiltered : (activeGroupId ? DB.getWorkers(activeGroupId) : _allWorkersFlat());
  const inView = pool.filter(w => _pick.has(w.uid));
  if (inView.length === _pick.size) return inView;
  /* Some picks are filtered out of the current view. They were still chosen
   * deliberately, so they are included — resolved from the full set rather
   * than dropped because a search box happens to be non-empty. */
  const seen = new Set(inView.map(w => w.uid));
  const rest = (activeGroupId ? DB.getWorkers(activeGroupId) : _allWorkersFlat())
    .filter(w => _pick.has(w.uid) && !seen.has(w.uid));
  return inView.concat(rest);
}

/**
 * The checkbox itself. `n` is the row's 1-based position in the current view —
 * shown while unpicked so the "1,2,7-10" box has something to refer to, and
 * replaced by a tick once picked. The card views pass no number.
 */
function _pickBox(uid, n) {
  if (!_canPick()) return '';
  const on = _pick.has(uid);
  return '<button class="pick-box' + (on ? ' on' : '') + '" data-pick-uid="' + esc(uid) + '" ' +
    'role="checkbox" aria-checked="' + (on ? 'true' : 'false') + '" ' +
    'onclick="togglePick(\'' + esc(uid) + '\',event)" title="' + esc(t('pick_one')) + '">' +
    (n ? '<span class="pick-n">' + n + '</span>' : '<span class="pick-n"></span>') +
    '<svg class="pick-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
  '</button>';
}

function togglePick(uid, ev) {
  if (ev) ev.stopPropagation();
  if (!_canPick()) return;
  if (_pick.has(uid)) _pick.delete(uid); else _pick.add(uid);
  _pickSave();
  _pickPaint();
}

/* Repaint only what the pick state affects. A full renderTable() here would
 * rebuild every card (and re-decode every photo) on each tick, and would throw
 * away the caret in the range box. */
function _pickPaint() {
  document.querySelectorAll('.pick-box[data-pick-uid]').forEach(el => {
    const on = _pick.has(el.dataset.pickUid);
    el.classList.toggle('on', on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  document.querySelectorAll('[data-pick-row]').forEach(el => {
    el.classList.toggle('picked', _pick.has(el.dataset.pickRow));
  });
  renderPickBar();
}

function _pickAdd(list) {
  list.forEach(w => _pick.add(w.uid));
  _pickSave();
  _pickPaint();
}

function pickAllInGroup() {
  _pickAdd(activeGroupId ? DB.getWorkers(activeGroupId) : _allWorkersFlat());
}
function pickFiltered() { _pickAdd(tableFiltered); }

/** Everything currently starred, limited to what this list can show. */
function pickStarred() {
  const starred = new Set(getSelectedUids());
  const pool = activeGroupId ? DB.getWorkers(activeGroupId) : _allWorkersFlat();
  const hits = pool.filter(w => starred.has(w.uid));
  if (!hits.length) { toast(t('pick_no_starred'), 'warn'); return; }
  _pickAdd(hits);
}

function clearPick() {
  _pick.clear();
  _pickSave();
  _pickPaint();
}

/* The header checkbox. All-of-the-current-results on, or all of them off —
 * it never touches picks that the filter is hiding. */
function pickToggleAllFiltered() {
  if (!tableFiltered.length) return;
  const allOn = tableFiltered.every(w => _pick.has(w.uid));
  tableFiltered.forEach(w => { if (allOn) _pick.delete(w.uid); else _pick.add(w.uid); });
  _pickSave();
  _pickPaint();
}

/**
 * "1,2,7-10" — positions in the list as it is currently shown and sorted,
 * which is what the row numbers on the left say. Out-of-range positions are
 * reported rather than silently ignored, because a range that quietly picked
 * fewer people than asked for is exactly the kind of thing nobody notices
 * until the export is already sent.
 */
function pickApplyRange() {
  const el = document.getElementById('pick-range');
  const spec = (el ? el.value : '').replace(/\s+/g, '');
  if (!spec) return;
  const list = tableFiltered;
  const bad = [], missing = [];
  let added = 0;
  spec.split(',').filter(Boolean).forEach(part => {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) { bad.push(part); return; }
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      const w = list[i - 1];
      if (!w) { missing.push(i); continue; }
      if (!_pick.has(w.uid)) added++;
      _pick.add(w.uid);
    }
  });
  _pickSave();
  _pickPaint();
  if (el) el.value = '';
  if (bad.length)     toast(t('pick_range_bad') + ' ' + bad.join(', '), 'warn');
  else if (missing.length) toast(t('pick_range_missing', { list: missing.slice(0, 8).join(', ') }), 'warn');
  else toast(t('pick_range_added', { n: added }), 'ok');
}

/** The bar itself: shown only when something is picked. */
function renderPickBar() {
  const bar = document.getElementById('pick-bar');
  if (!bar) return;

  /* A pick may only ever contain workers the current list could show — a uid
   * carried over from another group would act on a record the user can no
   * longer see. Pruned when the context changes rather than on every paint:
   * the pool query deep-clones the group, which is far too heavy to run on
   * each tick of a checkbox. */
  if (_pickGroup !== activeGroupId) {
    _pickPrune();
    _pickGroup = activeGroupId;
  }

  const n = _pick.size;

  // The header checkbox is outside the bar, so it is kept in step even when the
  // bar itself is hidden — otherwise it would stay ticked after a Clear.
  const head = document.getElementById('pick-all-box');
  if (head) {
    const allOn = tableFiltered.length > 0 && tableFiltered.every(w => _pick.has(w.uid));
    head.classList.toggle('on', allOn);
    head.setAttribute('aria-checked', allOn ? 'true' : 'false');
  }

  bar.hidden = !(n && _canPick());
  if (bar.hidden) return;

  const cnt = document.getElementById('pick-count');
  if (cnt) cnt.textContent = n;
  const lbl = document.getElementById('pick-label');
  if (lbl) lbl.textContent = t('pick_selected');

  // Move and Trash rewrite records; Export only reads them.
  bar.querySelectorAll('.pick-act-admin').forEach(b => { b.hidden = !isAdmin(); });
}

// ── BULK ACTIONS on the picked set ────────────────────────────────

function pickExport() {
  if (!_pick.size) return;
  openExportDialog('picked');
}

/** Move every picked worker into another group. Admin-only, and confirmed. */
function pickMove() {
  if (!isAdmin() || !_pick.size) return;
  const list = document.getElementById('pickmove-list');
  if (!list) return;
  const groups = DB.getGroups().filter(g => g.id !== activeGroupId && !g.archived);
  const sub = document.getElementById('pickmove-sub');
  if (sub) sub.textContent = t('pick_move_sub', { n: _pick.size });
  list.innerHTML = groups.length
    ? groups.map(g =>
        '<button class="pm-group" onclick="doPickMove(\'' + esc(g.id) + '\')">' +
          '<span class="pm-group-name">' + esc(g.name || g.id) + '</span>' +
          '<span class="pm-group-n">' + ((g.workers || []).length) + '</span>' +
        '</button>').join('')
    : '<p class="pm-empty">' + esc(t('pick_move_nogroups')) + '</p>';
  openOverlay('pickmove-overlay');
}

function doPickMove(gid) {
  const dest = DB.getGroup(gid);
  if (!dest) return;
  const ws = pickedWorkers();
  closeOverlay('pickmove-overlay');
  showConfirm(
    t('pick_move_title'),
    t('pick_move_msg', { n: ws.length, name: dest.name || gid }),
    () => {
      ws.forEach(w => DB.moveWorker(w.uid, gid));
      clearPick();
      refreshAll();
      toast(t('pick_moved', { n: ws.length, name: dest.name || gid }), 'ok');
    }
  );
  // Moving is not a deletion — keep the confirm button neutral.
  const ok = document.getElementById('cm-confirm-btn');
  if (ok) { ok.className = 'btn btn-primary'; ok.textContent = t('pick_move_go'); }
}

/** Soft-delete: the rows go to the trash bin and can be restored from there. */
function pickTrash() {
  if (!isAdmin() || !_pick.size) return;
  const ws = pickedWorkers();
  showConfirm(
    t('pick_trash_title'),
    t('pick_trash_msg', { n: ws.length }),
    () => {
      ws.forEach(w => DB.deleteWorker(activeGroupId, w.uid));
      clearPick();
      refreshAll();
      toast(t('pick_trashed', { n: ws.length }), 'ok');
    }
  );
}

// ── CUSTOMIZE SIDEBAR (choose which items show) ───────────────────
const SIDEBAR_ITEMS = [
  { key:'create',    sel:'.sb-create',         lo:'ສ້າງ', en:'Create', th:'สร้าง', ko:'만들기',
    icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' },
  { key:'dashboard', sel:'#nav-dashboard',     lo:'ໜ້າຫຼັກ', en:'Dashboard', th:'หน้าหลัก', ko:'대시보드',
    icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>' },
  { key:'workers',   sel:'#nav-workers',       lo:'ກຸ່ມ', en:'Groups', th:'กลุ่ม', ko:'그룹',
    icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></svg>' },
  { key:'alerts',    sel:'#nav-alerts',        lo:'ພາສປອດໃກ້ໝົດ', en:'Alerts', th:'พาสปอร์ตใกล้หมด', ko:'여권 만료 임박',
    icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' },
  { key:'selected',  sel:'#nav-selected',      lo:'ຄັດເລືອກ', en:'Selected', th:'คัดเลือก', ko:'선택됨',
    icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' },
  { key:'projects',  sel:'#sb-groups-section', lo:'ໂປຣເຈັກ', en:'Projects', th:'โปรเจกต์', ko:'프로젝트',
    icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' },
];
function _hiddenSidebar() {
  try { return new Set(JSON.parse(localStorage.getItem('kd_sidebar_hidden') || '[]')); } catch (e) { return new Set(); }
}
function applySidebarPrefs() {
  const hidden = _hiddenSidebar();
  SIDEBAR_ITEMS.forEach(it => {
    const el = document.querySelector(it.sel);
    if (!el) return;
    if (hidden.has(it.key)) el.style.display = 'none';
    else el.style.removeProperty('display');  // let CSS (e.g. .admin-only) decide visibility
  });
}
function openCustomizeSidebar() {
  const hidden = _hiddenSidebar();
  const list = document.getElementById('cz-list');
  if (list) list.innerHTML = SIDEBAR_ITEMS.map(it => {
    const on = !hidden.has(it.key);
    return '<button class="cz-item ' + (on ? 'on' : '') + '" onclick="toggleSidebarItem(\'' + it.key + '\', this)">' +
      '<span class="cz-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>' +
      '<span class="cz-item-ic">' + it.icon + '</span>' +
      '<span class="cz-item-label">' + esc(bi(it.lo, it.en, it.th, it.ko)) + '</span>' +
    '</button>';
  }).join('');
  openOverlay('customize-overlay');
}
function toggleSidebarItem(key, btn) {
  const hidden = _hiddenSidebar();
  if (hidden.has(key)) hidden.delete(key); else hidden.add(key);
  localStorage.setItem('kd_sidebar_hidden', JSON.stringify([...hidden]));
  if (btn) btn.classList.toggle('on', !hidden.has(key));
  applySidebarPrefs();
}

// ── Language globe dropdown ───────────────────────────────────────
function toggleLangMenu(event) {
  if (event) event.stopPropagation();
  document.getElementById('lang-dd')?.classList.toggle('open');
}

// ── Collapsible "Groups" section ──────────────────────────────────
function toggleGroupsSection() {
  document.getElementById('sb-groups-section')?.classList.toggle('collapsed');
}

// ── Profile menu (bottom user chip) ───────────────────────────────
function toggleProfileMenu(event) {
  if (event) event.stopPropagation();
  const sb = document.getElementById('sidebar');
  if (sb && sb.classList.contains('collapsed')) sb.classList.remove('collapsed');
  document.getElementById('pm-lang-list')?.classList.remove('open');   // reset language flyout
  document.getElementById('sb-profile-menu')?.classList.toggle('open');
}
function closeProfileMenu() {
  document.getElementById('sb-profile-menu')?.classList.remove('open');
  document.getElementById('pm-lang-list')?.classList.remove('open');
}

// Language flyout inside the profile menu (only the 4 supported languages)
/* ── BENTO CHOICE — one picker for the whole app ───────────────────
 * Language, theme, view mode, form fields: all of them are now the same
 * object, a bento tile (see "BENTO CHOICE" in main.css). Two entry points:
 *
 *   bcGroup(el, items, current, onPick)  — build tiles from a list
 *   bentoizeSelect(id, opts)             — upgrade an existing <select>
 *
 * bentoizeSelect keeps the original <select> in the DOM, hidden, as the value
 * holder. Everything that already reads or writes `getElementById('f-sex').value`
 * — form fill, save, filters, exports — keeps working with no changes; the tiles
 * are just a nicer way to move that value. bcSyncAll() redraws them after code
 * (or a language switch) changes the underlying options or value.            */
const BC_CHECK = '<svg class="bc-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

// The four UI languages, each shown by a letter of its own script (the option
// the brand review picked over flags).
const BC_LANGS = [
  { v: 'en', glyph: 'A',  name: 'English', code: 'EN' },
  { v: 'th', glyph: 'ก',  name: 'ไทย',     code: 'TH' },
  { v: 'lo', glyph: 'ກ',  name: 'ລາວ',     code: 'LO' },
  { v: 'ko', glyph: '한', name: '한국어',   code: 'KO' },
];

// One tile. `glyph` may be raw SVG (icons), so it is NOT escaped — callers pass
// their own markup; every text field is escaped.
function bcTileHtml(o) {
  return '<button type="button" class="bc-tile' + (o.center ? ' bc-center' : '') +
      (o.selected ? ' selected' : '') + '" role="radio" aria-checked="' + (o.selected ? 'true' : 'false') +
      '" data-val="' + esc(o.v == null ? '' : String(o.v)) + '"' +
      (o.title ? ' title="' + esc(o.title) + '"' : '') + '>' +
    (o.glyph ? '<span class="bc-glyph">' + o.glyph + '</span>' : '') +
    (o.name  ? '<span class="bc-name">' + esc(o.name) + '</span>' : '') +
    (o.code  ? '<span class="bc-code">' + esc(o.code) + '</span>' : '') +
    BC_CHECK + '</button>';
}

// Fill a container with tiles and call back with the picked value.
function bcGroup(el, items, current, onPick) {
  if (!el) return;
  el.setAttribute('role', 'radiogroup');
  el.innerHTML = items.map(it => bcTileHtml({ ...it, selected: String(it.v) === String(current) })).join('');
  if (el.dataset.bcWired !== '1') {
    el.dataset.bcWired = '1';
    el.addEventListener('click', e => {
      const tile = e.target.closest('.bc-tile');
      if (!tile || !el.contains(tile)) return;
      onPick(tile.dataset.val);
    });
  }
}

// Mark the selected tile without rebuilding the group (keeps focus + avoids a
// flash when only the selection changed).
function bcMark(el, current) {
  if (!el) return;
  el.querySelectorAll('.bc-tile').forEach(t => {
    const on = String(t.dataset.val) === String(current);
    t.classList.toggle('selected', on);
    t.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

// A placeholder option ("-- Select --") becomes a dash tile: still selectable,
// because clearing a field has to stay possible.
function _bcOptLabel(text) { return /^\s*-{2,}/.test(text) ? '—' : text.trim(); }

function bentoizeSelect(id, opts) {
  const sel = document.getElementById(id);
  if (!sel || sel.dataset.bento === 'on') return;
  opts = opts || {};
  sel.dataset.bento = 'on';
  sel.classList.add('bc-source');
  const grid = document.createElement('div');
  grid.id = 'bc-for-' + id;
  grid.className = 'bento-choice' + (opts.chip ? ' bc-chip' : '') + (opts.cls ? ' ' + opts.cls : '');
  if (opts.cols) grid.dataset.cols = opts.cols;
  sel.insertAdjacentElement('afterend', grid);
  grid.addEventListener('click', e => {
    const tile = e.target.closest('.bc-tile');
    if (!tile || !grid.contains(tile)) return;
    sel.value = tile.dataset.val;
    bcMark(grid, sel.value);
    // Fire the select's own change so existing onchange="applyFilters()" etc. run.
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  bcSync(id);
}

// Redraw one upgraded select's tiles from its current options + value.
function bcSync(id) {
  const sel  = document.getElementById(id);
  const grid = document.getElementById('bc-for-' + id);
  if (!sel || !grid) return;
  grid.innerHTML = Array.from(sel.options).map(o => bcTileHtml({
    v: o.value,
    name: _bcOptLabel(o.textContent),
    title: o.textContent.trim(),
    selected: o.value === sel.value,
  })).join('');
}

// Every upgraded select at once — after a form fill, a filter rebuild, or a
// language switch (which rewrites the option labels under us).
function bcSyncAll() {
  document.querySelectorAll('select[data-bento="on"]').forEach(s => bcSync(s.id));
  if (typeof _pmMarkLang === 'function') _pmMarkLang();
  if (typeof _syncSetLangDD === 'function') _syncSetLangDD();
}

// Which selects become tiles: short, fixed lists only. Long or runtime-filled
// ones (cities, groups, employers, doc categories) keep a real <select> — it
// just wears the same bento shell, see select.bento-field in main.css.
const BC_SELECTS = [
  { id: 'f-sex',          cols: 3 },
  { id: 'f-couple',       cols: 3 },
  { id: 'f-hand',         cols: 3 },
  { id: 'f-grade'                 },
  { id: 'f-visa-status'           },
  { id: 'f-size',         chip: 1 },
  { id: 'fm-blood',       chip: 1 },
  { id: 'set-u-role',     cols: 2 },
];
function bcUpgradeSelects() { BC_SELECTS.forEach(s => bentoizeSelect(s.id, s)); }

function togglePmLang(e) {
  if (e) e.stopPropagation();
  const list = document.getElementById('pm-lang-list');
  const btn  = (e && e.currentTarget) || document.querySelector('.pm-lang-wrap > .pm-item');
  if (!list || !btn) return;
  const willOpen = !list.classList.contains('open');
  if (!willOpen) { list.classList.remove('open'); return; }
  // Re-parent to <body>: the profile menu's transform would otherwise capture
  // this position:fixed flyout, and .sidebar's overflow:hidden would clip it.
  if (list.parentElement !== document.body) document.body.appendChild(list);
  list.classList.add('open');
  _pmMarkLang();
  const r  = btn.getBoundingClientRect();
  const mw = list.offsetWidth  || 200;
  const mh = list.offsetHeight || 180;
  let left = r.right + 6;                                     // flyout to the right (like the reference)
  if (left + mw > window.innerWidth - 8) left = Math.max(8, r.left - mw - 6);  // flip left if no room
  let top = r.top - 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - mh - 8);
  list.style.left = left + 'px';
  list.style.top  = top + 'px';
}
function _pmMarkLang() {
  const cur  = (typeof currentLang !== 'undefined' ? currentLang : 'en');
  const grid = document.getElementById('pm-lang-grid');
  if (!grid) return;
  // Build once, then only move the selection — rebuilding on every language
  // switch would flash the whole flyout.
  if (!grid.children.length) bcGroup(grid, BC_LANGS, cur, pmSetLang);
  else bcMark(grid, cur);
}
function pmSetLang(lang) {
  changeLangFromSettings(lang);   // switch language + live re-render
  _pmMarkLang();
}

function profileAddAccount() {
  closeProfileMenu();
  showConfirm(t('pm_add_account'), t('info_addacct_msg'), () => doLogout());
}
function profileShow(kind) {
  closeProfileMenu();
  if (kind === 'profile')  showInfo(t('pm_profile'),  t('info_profile_msg', { name: currentUser?.name || '', role: roleLabel(currentUser?.role) }));
  if (kind === 'help')     showInfo(t('pm_help'),     t('info_help_msg'));
  if (kind === 'policies') showInfo(t('pm_policies'), t('info_policies_msg'));
}

// ── Simple info popup (reuses the confirm overlay, single OK) ──────
function showInfo(title, msg) {
  document.getElementById('cm-title').textContent = title;
  document.getElementById('cm-msg').textContent   = msg;
  const cancel = document.getElementById('cm-cancel-btn');
  const ok     = document.getElementById('cm-confirm-btn');
  if (cancel) cancel.style.display = 'none';
  ok.textContent = t('info_ok');
  ok.className = 'btn btn-primary';
  confirmCallback = null;
  openOverlay('confirm-overlay');
}

// ── Profile photo helpers ─────────────────────────────────────────
function getUserAvatar(username) {
  try { return localStorage.getItem('kd_avatar_' + username) || null; } catch { return null; }
}

function profileAvatarHtml(username, name, sizeClass, uploadable) {
  const photo = getUserAvatar(username);
  const imgInner = photo
    ? '<img src="' + esc(photo) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">'
    : '';
  const baseEl = photo
    ? '<div class="avatar ' + sizeClass + ' has-photo" style="overflow:hidden;border-radius:50%">' + imgInner + '</div>'
    : avatarHtml(name, sizeClass);
  if (!uploadable) return baseEl;
  const camSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
  return '<div class="pm-photo-wrap" onclick="document.getElementById(\'pm-photo-input\').click();event.stopPropagation()">' +
    baseEl +
    '<div class="pm-photo-overlay">' + camSvg + '<span>' + t('pm_upload_photo') + '</span></div>' +
  '</div>';
}

function handleProfilePhotoUpload(e) {
  const file = e.target.files && e.target.files[0];
  if (!file || !currentUser) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try { localStorage.setItem('kd_avatar_' + currentUser.username, ev.target.result); } catch {}
    renderSidebarUser();
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

// ── Top header user chip ──────────────────────────────────────────
function renderTopHeader() {
  const el = document.getElementById('th-user-chip');
  if (!el || !currentUser) return;
  const name = currentUser.name || currentUser.username;
  el.innerHTML =
    profileAvatarHtml(currentUser.username, name, 'avatar-sm', false) +
    '<div class="th-user-info">' +
      '<span class="th-user-name">' + esc(name) + '</span>' +
      '<span class="th-user-email">' + esc(currentUser.username) + '</span>' +
    '</div>';
}

// ── BENTO DASHBOARD ───────────────────────────────────────────────
// Every tile lives in the markup once (#dz-bento). A "view" is just an ordered
// pick of tiles plus the span each one gets, so adding a dashboard costs one
// entry here and no new HTML. The user's own tweaks (hide / resize / reorder)
// are stored per view and layered on top of the preset.
//
// Sizes: s = ¼ · m = ⅓ · l = ½ · full = whole row (of a 12-column grid).
const BENTO_SIZES = ['s', 'm', 'l', 'full'];
const BENTO_SIZE_LABEL = { s: '¼', m: '⅓', l: '½', full: '1' };

const DZ_VIEWS = [
  {
    key: 'overview', lo: 'ພາບລວມ', en: 'Overview', th: 'ภาพรวม', ko: '개요',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    tiles: [
      ['stat-groups', 's'], ['stat-active', 's'], ['stat-workers', 's'], ['stat-alerts', 's'],
      ['stat-cmp', 's'], ['analytics', 'l'], ['reminders', 's'],
      ['projects', 'm'], ['team', 'm'], ['passport', 'm'],
      ['compare', 'full'],
    ],
  },
  {
    key: 'passport', lo: 'ພາສປອດ', en: 'Passport', th: 'พาสปอร์ต', ko: '여권',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="10" r="3"/><path d="M9 17h6"/></svg>',
    tiles: [
      ['stat-alerts', 's'], ['stat-workers', 's'], ['stat-active', 's'], ['stat-groups', 's'],
      ['passport', 'l'], ['reminders', 'l'],
      ['analytics', 'full'], ['compare', 'full'],
    ],
  },
  {
    key: 'documents', lo: 'ເອກະສານ', en: 'Documents', th: 'เอกสาร', ko: '문서',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    tiles: [
      ['stat-workers', 's'], ['stat-cmp', 's'], ['stat-docs', 's'], ['stat-alerts', 's'],
      ['docs-by-type', 'l'], ['missing-docs', 'l'],
      ['team', 'full'],
    ],
  },
  {
    key: 'destinations', lo: 'ປາຍທາງ', en: 'Destinations', th: 'ปลายทาง', ko: '목적지',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    tiles: [
      ['stat-groups', 's'], ['stat-active', 's'], ['stat-workers', 's'], ['stat-cmp', 's'],
      ['top-kr', 'l'], ['top-la', 'l'],
      ['analytics', 'l'], ['compare', 'l'],
    ],
  },
];

const DZ_TILE_META = {
  'stat-groups':  { lo: 'ຈຳນວນກຸ່ມ',            en: 'Total groups',         th: 'จำนวนกลุ่ม',           ko: '전체 그룹' },
  'stat-active':  { lo: 'ກຸ່ມທີ່ມີຄົນ',            en: 'Active groups',        th: 'กลุ่มที่มีคน',          ko: '활성 그룹' },
  'stat-workers': { lo: 'ຈຳນວນຄົນງານ',         en: 'Total workers',        th: 'จำนวนแรงงาน',        ko: '전체 근로자' },
  'stat-alerts':  { lo: 'ການແຈ້ງເຕືອນ',         en: 'Pending alerts',       th: 'การแจ้งเตือน',        ko: '알림' },
  'stat-cmp':     { lo: 'ຄວາມຄົບຖ້ວນຂໍ້ມູນ',      en: 'Data completeness',    th: 'ความครบถ้วนข้อมูล',   ko: '데이터 완성도' },
  'stat-docs':    { lo: 'ຄວາມຄົບຖ້ວນເອກະສານ',  en: 'Document completeness',th: 'ความครบถ้วนเอกสาร',  ko: '문서 완성도' },
  'analytics':    { lo: 'ສະຖິຕິກຸ່ມ',             en: 'Group analytics',      th: 'สถิติกลุ่ม',            ko: '그룹 분석' },
  'reminders':    { lo: 'ເຕືອນຄວາມຈຳ',          en: 'Reminders',            th: 'เตือนความจำ',         ko: '알림 목록' },
  'projects':     { lo: 'ໂປຣເຈັກ',              en: 'Projects',             th: 'โปรเจกต์',            ko: '프로젝트' },
  'team':         { lo: 'ທີມງານ',               en: 'Team',                 th: 'ทีมงาน',              ko: '팀' },
  'passport':     { lo: 'ສະຖານະພາສປອດ',        en: 'Passport status',      th: 'สถานะพาสปอร์ต',      ko: '여권 상태' },
  'compare':      { lo: 'ປຽບທຽບກຸ່ມ',           en: 'Group comparison',     th: 'เปรียบเทียบกลุ่ม',      ko: '그룹 비교' },
  'docs-by-type': { lo: 'ເອກະສານຕາມປະເພດ',     en: 'Documents by type',    th: 'เอกสารตามประเภท',    ko: '유형별 문서' },
  'missing-docs': { lo: 'ຂາດເອກະສານຫຼາຍທີ່ສຸດ',  en: 'Most missing documents', th: 'ขาดเอกสารมากที่สุด', ko: '문서 누락 상위' },
  'top-kr':       { lo: 'ປາຍທາງ ເກົາຫຼີ',        en: 'Korean destinations',  th: 'ปลายทางเกาหลี',       ko: '한국 목적지' },
  'top-la':       { lo: 'ພູມລຳເນົາ ລາວ',         en: 'Lao home towns',       th: 'ภูมิลำเนาลาว',         ko: '라오스 출신지' },
};

let dzView = localStorage.getItem('kd_dz_view') || 'overview';

function _dzViewDef(key) { return DZ_VIEWS.find(v => v.key === key) || DZ_VIEWS[0]; }

function _dzPrefs() {
  try { return JSON.parse(localStorage.getItem('kd_bento') || '{}') || {}; } catch (e) { return {}; }
}
function _dzSavePrefs(p) {
  try { localStorage.setItem('kd_bento', JSON.stringify(p)); } catch (e) {}
}

// Preset + the user's overrides → the tile list to actually paint.
// The preset stays the source of truth for *which* tiles a view may contain, so
// a saved layout from an older build can never resurrect a tile we dropped.
function _dzLayout(viewKey) {
  const def    = _dzViewDef(viewKey);
  const saved  = _dzPrefs()[viewKey] || {};
  const hidden = new Set(saved.hidden || []);
  const sizes  = saved.size || {};
  const preset = new Map(def.tiles);

  let keys = def.tiles.map(t => t[0]);
  if (Array.isArray(saved.order) && saved.order.length) {
    const ordered = [...new Set(saved.order.filter(k => preset.has(k)))];
    const rest    = keys.filter(k => !ordered.includes(k));   // tiles added since the layout was saved
    keys = ordered.concat(rest);
  }
  return keys.map(key => ({
    key,
    size: BENTO_SIZES.includes(sizes[key]) ? sizes[key] : preset.get(key),
    on:   !hidden.has(key),
  }));
}

function _dzMutatePrefs(viewKey, fn) {
  const all = _dzPrefs();
  all[viewKey] = all[viewKey] || {};
  fn(all[viewKey]);
  _dzSavePrefs(all);
  applyBentoLayout();
}

function renderDashViews() {
  const el = document.getElementById('dz-views');
  if (!el) return;
  el.innerHTML = DZ_VIEWS.map(v =>
    '<button class="dz-view-btn' + (v.key === dzView ? ' active' : '') + '" role="tab" ' +
      'aria-selected="' + (v.key === dzView) + '" onclick="setDzView(\'' + v.key + '\')">' +
      v.icon + '<span>' + esc(bi(v.lo, v.en, v.th, v.ko)) + '</span>' +
    '</button>').join('');
}

function setDzView(key) {
  const next = _dzViewDef(key).key;
  const changed = next !== dzView;
  dzView = next;
  try { localStorage.setItem('kd_dz_view', dzView); } catch (e) {}
  renderDashViews();
  applyBentoLayout();
  // Switching dashboards is a view change of its own — let the new set of tiles
  // arrive rather than snap. Re-clicking the current tab replays nothing.
  if (changed) replayTiles(document.getElementById('dz-bento'));
}

// Show/size/order the tiles for the active view. Tiles are positioned with
// `order`, which nth-child does not follow, so --i (the stagger index) is set
// here to match what the eye actually sees top-to-bottom.
function applyBentoLayout() {
  const bento = document.getElementById('dz-bento');
  if (!bento) return;
  const layout = _dzLayout(dzView);
  const shown  = new Map(layout.filter(x => x.on).map((x, i) => [x.key, { size: x.size, i }]));

  bento.querySelectorAll('.bento-tile').forEach(el => {
    const item = shown.get(el.dataset.tile);
    if (!item) { el.style.display = 'none'; return; }
    // Clear the inline display so `.admin-only` and role CSS still decide.
    el.style.removeProperty('display');
    el.style.order = item.i;
    el.style.setProperty('--i', Math.min(item.i, 11));
    el.dataset.size = item.size;
  });
}

// ── Customize dashboard dialog ────────────────────────────────────
function openCustomizeBento() {
  renderBentoCustomize();
  openOverlay('bento-overlay');
}

function renderBentoCustomize() {
  const list = document.getElementById('bento-cz-list');
  if (!list) return;
  const def = _dzViewDef(dzView);
  const sub = document.getElementById('bento-cz-sub');
  if (sub) sub.textContent = bi(
    'ເລືອກ ຫຼື ລາກກ່ອງໃນໜ້າ “' + bi(def.lo, def.en, def.th, def.ko) + '” ແລະ ປັບຂະໜາດ',
    'Choose, resize and drag the tiles on the “' + bi(def.lo, def.en, def.th, def.ko) + '” dashboard.',
    'เลือก ปรับขนาด และลากจัดลำดับกล่องในหน้า “' + bi(def.lo, def.en, def.th, def.ko) + '”',
    '“' + bi(def.lo, def.en, def.th, def.ko) + '” 대시보드의 타일을 선택·크기 조절·드래그하세요.'
  );

  list.innerHTML = _dzLayout(dzView).map(item => {
    const m = DZ_TILE_META[item.key] || {};
    return '<div class="bz-row' + (item.on ? '' : ' off') + '" data-drag="' + esc(item.key) + '">' +
      _dragHandle() +
      '<button class="bz-toggle" onclick="toggleBentoTile(\'' + esc(item.key) + '\')">' +
        '<span class="cz-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>' +
        '<span class="bz-label">' + esc(bi(m.lo, m.en, m.th, m.ko) || item.key) + '</span>' +
      '</button>' +
      '<span class="bz-sizes">' +
        BENTO_SIZES.map(s =>
          '<button class="bz-size-btn' + (s === item.size ? ' active' : '') + '" ' +
            'onclick="setBentoSize(\'' + esc(item.key) + '\',\'' + s + '\')">' + BENTO_SIZE_LABEL[s] + '</button>').join('') +
      '</span>' +
    '</div>';
  }).join('');

  _initDragReorder(list, order => {
    _dzMutatePrefs(dzView, p => { p.order = order; });
  }, { anyRole: true });
}

function toggleBentoTile(key) {
  _dzMutatePrefs(dzView, p => {
    const hidden = new Set(p.hidden || []);
    if (hidden.has(key)) hidden.delete(key); else hidden.add(key);
    p.hidden = [...hidden];
  });
  renderBentoCustomize();
}

function setBentoSize(key, size) {
  if (!BENTO_SIZES.includes(size)) return;
  _dzMutatePrefs(dzView, p => {
    p.size = p.size || {};
    p.size[key] = size;
  });
  renderBentoCustomize();
}

function resetBentoView() {
  const all = _dzPrefs();
  delete all[dzView];
  _dzSavePrefs(all);
  applyBentoLayout();
  renderBentoCustomize();
}

// ── Dashboard render (Donezo-style) ───────────────────────────────
function renderDashboard() {
  const groups     = DB.getGroups().filter(g => !g.archived);
  const allWorkers = groups.flatMap(g => g.workers || []);
  const total      = groups.length;
  const active     = groups.filter(g => (g.workers || []).length > 0).length;
  const workers    = allWorkers.length;

  let alertCount = 0;
  allWorkers.forEach(w => {
    const c = expiryClass(w.passport_expiry);
    if (c === 'expiry-expired' || c === 'expiry-warn') alertCount++;
  });

  // Stats
  const el = id => document.getElementById(id);
  if (el('dz-total-groups'))  el('dz-total-groups').textContent  = total;
  if (el('dz-active-groups')) el('dz-active-groups').textContent = active;
  if (el('dz-total-workers')) el('dz-total-workers').textContent = workers;
  if (el('dz-alerts-num'))    el('dz-alerts-num').textContent    = alertCount;
  if (el('dz-groups-foot'))   el('dz-groups-foot').innerHTML     =
    '<span style="color:var(--sb-green,#3dba7a)">▲ ' + total + '</span>&nbsp;' + t('dz_total_projects');
  if (el('dz-alerts-foot'))   el('dz-alerts-foot').textContent   =
    alertCount > 0 ? t('dz_needs_attention') : t('dz_all_clear');

  // Completeness summary: average data-field % + how many records are fully done
  let dataSum = 0, fullDone = 0;
  allWorkers.forEach(w => {
    const dc = dataCompleteness(w), kc = docsCompleteness(w);
    dataSum += dc.pct;
    if (dc.pct >= 100 && kc.pct >= 100) fullDone++;
  });
  const avgData = workers ? Math.round(dataSum / workers) : 0;
  if (el('dz-cmp-num'))  el('dz-cmp-num').textContent  = avgData + '%';
  if (el('dz-cmp-foot')) el('dz-cmp-foot').textContent = bi('ຄົບສົມບູນ ', 'Complete ', 'ครบสมบูรณ์ ', '완료 ') + fullDone + '/' + workers + bi(' ຄົນ', ' people', ' คน', '명');

  // Documents completeness (average across workers + how many have every type)
  let docsSum = 0, docsDone = 0;
  allWorkers.forEach(w => {
    const kc = docsCompleteness(w);
    docsSum += kc.pct;
    if (kc.pct >= 100) docsDone++;
  });
  const avgDocs = workers ? Math.round(docsSum / workers) : 0;
  if (el('dz-docs-num'))  el('dz-docs-num').textContent  = avgDocs + '%';
  if (el('dz-docs-foot')) el('dz-docs-foot').textContent =
    bi('ຄົບທຸກປະເພດ ', 'All types ', 'ครบทุกประเภท ', '전체 유형 ') + docsDone + '/' + workers + bi(' ຄົນ', ' people', ' คน', '명');

  // Notification badge in header
  const nb = el('th-notif-badge');
  if (nb) { nb.textContent = alertCount; nb.style.display = alertCount > 0 ? 'flex' : 'none'; }

  // Workers badge in sidebar
  const wb = el('sb-workers-badge');
  if (wb) { wb.textContent = workers; wb.style.display = workers > 0 ? '' : 'none'; }
  const ab = el('sb-alerts-badge');
  if (ab) { ab.textContent = alertCount; ab.style.display = alertCount > 0 ? '' : 'none'; }
  // Same count on the phone tab bar — it used to warn on desktop only, which is
  // backwards: the phone is where this app is actually read.
  const bnb = el('bn-alerts-badge');
  if (bnb) { bnb.textContent = alertCount; bnb.style.display = alertCount > 0 ? '' : 'none'; }

  _dzBarChart(groups);
  _dzReminders(allWorkers);
  _dzProjects(groups);
  _dzTeam(allWorkers, groups);
  _dzProgress(allWorkers);
  _dzCompare(groups);
  _dzDocsByType(allWorkers);
  _dzMissingDocs(allWorkers, groups);
  _dzTopCity('dz-top-kr', allWorkers, 'kr_city', '#2563eb');
  _dzTopCity('dz-top-la', allWorkers, 'la_city', '#2d6a4f');

  renderDashViews();
  applyBentoLayout();
}

// A ranked horizontal-bar list — the shape shared by the document and
// destination tiles. `rows` is [{ label, value, note }], already sorted.
function _dzRankList(elId, rows, color, emptyMsg) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<div class="dz-empty">' + esc(emptyMsg) + '</div>'; return; }
  const max = Math.max(...rows.map(r => r.value), 1);
  el.innerHTML = '<div class="dz-rank">' + rows.map((r, i) =>
    '<div class="dz-rank-row">' +
      '<span class="dz-rank-name" title="' + esc(r.label) + '">' + esc(r.label) + '</span>' +
      '<span class="dz-rank-val">' + esc(r.note) + '</span>' +
      '<span class="dz-rank-track">' +
        '<span class="dz-rank-fill" style="width:' + Math.round((r.value / max) * 100) + '%;background:' +
          (typeof color === 'function' ? color(r) : color) + ';animation-delay:' + (i * 0.05).toFixed(2) + 's"></span>' +
      '</span>' +
    '</div>').join('') + '</div>';
}

// How many workers actually have each document type on file.
function _dzDocsByType(allWorkers) {
  const cats = getDocCats();
  const rows = cats.map(c => {
    const have = allWorkers.filter(w => {
      const docs = (_docCache && _docCache[w.uid]) || w.documents || {};
      const a = docs[c.key];
      return a && a.length;
    }).length;
    const pct = allWorkers.length ? Math.round(have / allWorkers.length * 100) : 0;
    return { label: c.label, value: pct, note: have + '/' + allWorkers.length + ' · ' + pct + '%' };
  }).sort((a, b) => b.value - a.value);
  _dzRankList('dz-docs-by-type', rows, r => _pctColor(r.value),
    bi('ຍັງບໍ່ມີຂໍ້ມູນ', 'No data yet', 'ยังไม่มีข้อมูล', '데이터 없음'));
}

// The workers to chase first: most document types still missing.
function _dzMissingDocs(allWorkers, groups) {
  const el = document.getElementById('dz-missing-docs');
  if (!el) return;
  const gMap = {};
  groups.forEach(g => (g.workers || []).forEach(w => { gMap[w.uid] = g.name || g.destination || '—'; }));

  const worst = allWorkers
    .map(w => ({ w, k: docsCompleteness(w) }))
    .filter(x => x.k.have < x.k.total)
    .sort((a, b) => (a.k.have - a.k.total) - (b.k.have - b.k.total))
    .slice(0, 5);

  if (!worst.length) {
    el.innerHTML = '<div class="dz-empty">' +
      esc(bi('ເອກະສານຄົບທຸກຄົນ 🎉', 'Every worker has a full set 🎉', 'เอกสารครบทุกคน 🎉', '모든 근로자 서류 완비 🎉')) + '</div>';
    return;
  }
  el.innerHTML = worst.map(({ w, k }) => {
    const missing = k.total - k.have;
    return '<div class="dz-team-item" onclick="openView(\'' + esc(w.uid) + '\')">' +
      personPhoto(w, 'avatar-sm') +
      '<div class="dz-team-info">' +
        '<div class="dz-team-name">' + esc(w.en_name || w.lo_name || '—') + '</div>' +
        '<div class="dz-team-sub">' + esc(gMap[w.uid] || '—') + '</div>' +
      '</div>' +
      '<span class="dz-status-pill ' + (k.have === 0 ? 'dz-pill-bad' : 'dz-pill-warn') + '">' +
        bi('ຂາດ ', 'missing ', 'ขาด ', '누락 ') + missing +
      '</span>' +
    '</div>';
  }).join('');
}

// Top destinations / home towns by headcount.
function _dzTopCity(elId, allWorkers, field, color) {
  const counts = new Map();
  allWorkers.forEach(w => {
    const v = (w[field] || '').trim();
    if (!v) return;
    counts.set(v, (counts.get(v) || 0) + 1);
  });
  const total = allWorkers.length || 1;
  const rows = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([label, n]) => ({ label, value: n, note: n + ' · ' + Math.round(n / total * 100) + '%' }));
  _dzRankList(elId, rows, color, bi('ຍັງບໍ່ໄດ້ລະບຸເມືອງ', 'No city recorded yet', 'ยังไม่ได้ระบุเมือง', '도시 정보 없음'));
}

// Grouped-bar comparison between two groups (passport status + headcount)
function _dzCompare(groups) {
  const selA = document.getElementById('dz-cmp-a');
  const selB = document.getElementById('dz-cmp-b');
  const el   = document.getElementById('dz-compare-chart');
  if (!selA || !selB || !el) return;
  if (groups.length < 2) {
    el.innerHTML = '<div class="dz-bar-empty">' + t('dz_compare_need2') + '</div>';
    selA.innerHTML = ''; selB.innerHTML = '';
    return;
  }
  const optHtml = groups.map((g, i) => '<option value="' + i + '">' + esc(g.name || g.destination || ('Group ' + (i + 1))) + '</option>').join('');
  const aPrev = selA.value, bPrev = selB.value;
  selA.innerHTML = optHtml; selB.innerHTML = optHtml;
  selA.value = (aPrev !== '' && groups[aPrev]) ? aPrev : '0';
  selB.value = (bPrev !== '' && groups[bPrev]) ? bPrev : '1';
  if (selA.value === selB.value) selB.value = (selA.value === '0') ? '1' : '0';

  const gA = groups[+selA.value], gB = groups[+selB.value];
  const tally = g => {
    const c = { total: (g.workers || []).length, ok: 0, near: 0, warn: 0, expired: 0 };
    (g.workers || []).forEach(w => {
      const cl = expiryClass(w.passport_expiry);
      if (cl === 'expiry-expired') c.expired++; else if (cl === 'expiry-warn') c.warn++; else if (cl === 'expiry-near') c.near++; else c.ok++;
    });
    return c;
  };
  const cA = tally(gA), cB = tally(gB);
  const cats = [
    { key: 'total',   label: t('dz_total_workers') },
    { key: 'ok',      label: t('dz_valid') },
    { key: 'near',    label: t('dz_near') },
    { key: 'warn',    label: t('dz_warn') },
    { key: 'expired', label: t('dz_expired') },
  ];
  const maxV = Math.max(1, ...cats.map(c => Math.max(cA[c.key], cB[c.key])));
  const colA = '#2d6a4f', colB = '#2563eb';
  el.innerHTML =
    '<div class="dz-cmp-legend">' +
      '<span class="dz-cmp-leg"><i style="background:' + colA + '"></i>' + esc(gA.name || 'A') + '</span>' +
      '<span class="dz-cmp-leg"><i style="background:' + colB + '"></i>' + esc(gB.name || 'B') + '</span>' +
    '</div>' +
    '<div class="dz-cmp-bars">' +
      cats.map((c, i) => {
        const ha = Math.round((cA[c.key] / maxV) * 100), hb = Math.round((cB[c.key] / maxV) * 100);
        return '<div class="dz-cmp-group">' +
          '<div class="dz-cmp-pair">' +
            '<div class="dz-cmp-bar" style="height:' + Math.max(ha, 3) + '%;background:' + colA + ';animation-delay:' + (i * 0.05).toFixed(2) + 's" title="' + esc(gA.name || 'A') + ': ' + cA[c.key] + '"><span>' + cA[c.key] + '</span></div>' +
            '<div class="dz-cmp-bar" style="height:' + Math.max(hb, 3) + '%;background:' + colB + ';animation-delay:' + (i * 0.05 + 0.03).toFixed(2) + 's" title="' + esc(gB.name || 'B') + ': ' + cB[c.key] + '"><span>' + cB[c.key] + '</span></div>' +
          '</div>' +
          '<div class="dz-cmp-label">' + esc(c.label) + '</div>' +
        '</div>';
      }).join('') +
    '</div>';
}

// Is this worker's passport expiring within `months` months from now?
function _withinMonths(expiry, months) {
  if (months === 'all') return true;
  const d = parseDate(expiry);
  if (!d) return false;            // unknown expiry → excluded from time-boxed views
  const now = new Date();
  const limit = new Date(now.getFullYear(), now.getMonth() + Number(months), now.getDate());
  return d <= limit;              // expires on/before the horizon (includes already-expired)
}

function setDzSegment(v) { dzSegment = v; _dzBarChart(_dzGroupsCache); }
function setDzTimeline(v, el) {
  dzTimeline = v;
  document.querySelectorAll('#dz-timeline .dz-seg-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  _dzBarChart(_dzGroupsCache);
}

function _dzBarChart(groups) {
  const el = document.getElementById('dz-bar-chart');
  if (!el) return;
  _dzGroupsCache = groups;

  // 1) Flatten workers (tag each with its group name) and apply the timeline filter.
  let workers = [];
  groups.forEach(g => (g.workers || []).forEach(w => {
    if (_withinMonths(w.passport_expiry, dzTimeline)) workers.push({ w, gname: g.name || g.destination || '—' });
  }));

  // 2) Bucket by the chosen segment.
  const statusLabel = {
    'expiry-expired': t('dz_expired'),
    'expiry-warn':    t('dz_pill_expiring'),
    'expiry-near':    t('dz_near'),
    'expiry-ok':      t('dz_valid'),
    '':               t('dz_valid'),
  };
  const buckets = new Map();   // label → count
  const pickLabel = ({ w, gname }) => {
    if (dzSegment === 'krcity') return w.kr_city || '—';
    if (dzSegment === 'lacity') return w.la_city || '—';
    if (dzSegment === 'status') return statusLabel[expiryClass(w.passport_expiry)] || t('dz_valid');
    return gname; // 'group'
  };
  // Seed group buckets so empty groups still show (only in group mode, timeline=all)
  if (dzSegment === 'group' && dzTimeline === 'all') {
    groups.forEach(g => buckets.set(g.name || g.destination || '—', 0));
  }
  workers.forEach(item => {
    const label = pickLabel(item);
    buckets.set(label, (buckets.get(label) || 0) + 1);
  });

  const entries = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (!entries.length) {
    el.innerHTML = '<div class="dz-bar-empty">' + (t('dz_no_data') || 'No matching workers') + '</div>';
    return;
  }

  const maxC = Math.max(...entries.map(e => e[1]), 1);
  const statusColors = {};
  statusColors[t('dz_valid')] = '#16a34a';
  statusColors[t('dz_near')] = '#fbbf24';
  statusColors[t('dz_pill_expiring')] = '#f59e0b';
  statusColors[t('dz_expired')] = '#dc2626';
  const palette = ['#2d6a4f','#2563eb','#d97706','#7c3aed','#0891b2','#db2777','#16a34a','#dc2626','#0d9488','#9333ea'];
  el.innerHTML = entries.map(([label, cnt], i) => {
    const pct  = Math.round((cnt / maxC) * 100);
    const col  = dzSegment === 'status' ? (statusColors[label] || palette[i % palette.length]) : palette[i % palette.length];
    const isMax = cnt === maxC;
    const short = String(label).length > 10 ? String(label).slice(0, 9) + '…' : label;
    return '<div class="dz-bar-item">' +
      '<span class="dz-bar-val">' + cnt + '</span>' +
      '<div class="dz-bar-track">' +
        '<div class="dz-bar-col' + (isMax ? '' : ' dz-inactive') + '" title="' + esc(label) + ': ' + cnt + '" ' +
          'style="height:' + pct + '%;background:' + col + ';animation-delay:' + (i * 0.04).toFixed(2) + 's"></div>' +
      '</div>' +
      '<span class="dz-bar-label" title="' + esc(label) + '">' + esc(short) + '</span>' +
    '</div>';
  }).join('');
}

function _dzReminders(allWorkers) {
  const el = document.getElementById('dz-reminders');
  if (!el) return;
  const expiring = allWorkers.filter(w => {
    const c = expiryClass(w.passport_expiry);
    return c === 'expiry-expired' || c === 'expiry-warn' || c === 'expiry-near';
  }).slice(0, 2);
  if (!expiring.length) {
    el.innerHTML = '<div class="dz-reminder-item"><div class="dz-reminder-name">' + t('dz_all_clear_title') + '</div><div class="dz-reminder-sub">' + t('dz_no_expirations') + '</div></div>';
    return;
  }
  el.innerHTML =
    expiring.map(w => {
      const n = w.en_name || w.lo_name || '—';
      const d = w.passport_expiry ? new Date(w.passport_expiry).toLocaleDateString() : '—';
      return '<div class="dz-reminder-item">' +
        '<div class="dz-reminder-name">' + esc(n) + '</div>' +
        '<div class="dz-reminder-sub">' + t('dz_passport_expires') + ' ' + d + '</div>' +
      '</div>';
    }).join('') +
    '<button class="dz-reminder-btn" onclick="navTo(\'alerts\', document.getElementById(\'nav-alerts\'))">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/></svg>' +
      ' ' + t('dz_view_alerts') +
    '</button>';
}

function _dzProjects(groups) {
  const el = document.getElementById('dz-projects-list');
  if (!el) return;
  if (!groups.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:0.82rem">' + t('dz_no_projects') + '</p>'; return; }
  const colors = ['#16a34a','#2563eb','#d97706','#dc2626','#7c3aed','#0891b2'];
  el.innerHTML = groups.slice(0, 6).map((g, i) => {
    const cnt   = (g.workers || []).length;
    const short = (g.name || g.destination || '?').substring(0, 2).toUpperCase();
    const col   = colors[i % colors.length];
    return '<div class="dz-project-item" onclick="openGroup(\'' + esc(g.id) + '\')">' +
      '<div class="dz-project-ic" style="background:' + col + '22;color:' + col + '">' + esc(short) + '</div>' +
      '<div class="dz-project-info">' +
        '<div class="dz-project-name">' + esc(g.name || g.destination || '—') + '</div>' +
        '<div class="dz-project-meta">' + cnt + ' ' + t('dz_workers_suffix') + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function _dzTeam(allWorkers, groups) {
  const el = document.getElementById('dz-team-list');
  if (!el) return;
  if (!allWorkers.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:0.82rem">' + t('dz_no_workers') + '</p>'; return; }
  const gMap = {};
  groups.forEach(g => (g.workers || []).forEach(w => { gMap[w.uid] = g.name || g.destination || '—'; }));
  el.innerHTML = allWorkers.slice(0, 5).map(w => {
    const name  = w.en_name || w.lo_name || '—';
    const grp   = gMap[w.uid] || '—';
    const c     = expiryClass(w.passport_expiry);
    const pill  = c === 'expiry-expired' ? '<span class="dz-status-pill dz-pill-bad">' + t('dz_pill_expired') + '</span>'
                : c === 'expiry-warn'    ? '<span class="dz-status-pill dz-pill-warn">' + t('dz_pill_expiring') + '</span>'
                :                          '<span class="dz-status-pill dz-pill-ok">' + t('dz_pill_active') + '</span>';
    return '<div class="dz-team-item" onclick="openView(\'' + esc(w.uid) + '\')">' +
      personPhoto(w, 'avatar-sm') +
      '<div class="dz-team-info">' +
        '<div class="dz-team-name">' + esc(name) + '</div>' +
        '<div class="dz-team-sub">' + t('dz_working_on') + ' <b>' + esc(grp) + '</b></div>' +
      '</div>' +
      pill +
    '</div>';
  }).join('');
}

function _dzProgress(allWorkers) {
  const el = document.getElementById('dz-progress-wrap');
  if (!el) return;
  if (!allWorkers.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:0.82rem;text-align:center">' + t('dz_status_nodata') + '</p>'; return; }
  let expired = 0, warn = 0, near = 0, ok = 0;
  allWorkers.forEach(w => {
    const c = expiryClass(w.passport_expiry);
    if      (c === 'expiry-expired') expired++;
    else if (c === 'expiry-warn')    warn++;
    else if (c === 'expiry-near')    near++;
    else                             ok++;
  });
  const total   = allWorkers.length;
  const okPct   = Math.round((ok / total) * 100);
  const r = 52, cx = 65, cy = 65, stroke = 18;
  const segs = [
    { v: ok,      color: '#16a34a', label: t('dz_valid') },
    { v: near,    color: '#fbbf24', label: t('dz_near') },
    { v: warn,    color: '#f59e0b', label: t('dz_warn') },
    { v: expired, color: '#dc2626', label: t('dz_expired') },
  ].filter(s => s.v > 0);
  let startA = -Math.PI / 2;
  let paths  = '';
  segs.forEach(s => {
    const angle = (s.v / total) * 2 * Math.PI;
    const x1 = cx + r * Math.cos(startA), y1 = cy + r * Math.sin(startA);
    const x2 = cx + r * Math.cos(startA + angle), y2 = cy + r * Math.sin(startA + angle);
    const lg = angle > Math.PI ? 1 : 0;
    paths += '<path d="M' + cx + ',' + cy + ' L' + x1.toFixed(1) + ',' + y1.toFixed(1) + ' A' + r + ',' + r + ' 0 ' + lg + ',1 ' + x2.toFixed(1) + ',' + y2.toFixed(1) + ' Z" fill="' + s.color + '" opacity="0.9"/>';
    startA += angle;
  });
  el.innerHTML =
    '<div class="dz-donut-area">' +
      '<div class="dz-donut-wrap">' +
        '<svg width="130" height="130" viewBox="0 0 130 130">' + paths +
          '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r - stroke) + '" fill="var(--bg-card)"/>' +
        '</svg>' +
        '<div class="dz-donut-inner">' +
          '<span class="dz-donut-pct">' + okPct + '%</span>' +
          '<span class="dz-donut-lbl">' + t('dz_valid') + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="dz-legend-row">' +
        segs.map(s => '<div class="dz-legend-item"><div class="dz-legend-dot" style="background:' + s.color + '"></div>' + esc(s.label) + '</div>').join('') +
      '</div>' +
    '</div>';
}

// ── Sidebar footer user chip (opens profile menu) ─────────────────
function renderSidebarUser() {
  const el = document.getElementById('sidebar-footer');
  if (!el || !currentUser) return;
  const name = currentUser.name || currentUser.username;
  const roleCls = 'role-' + roleBadgeTone(currentUser.role);
  const roleTxt = roleLabel(currentUser.role);

  // Footer chip (collapsed: shows only avatar; expanded: avatar + name + chevron)
  el.innerHTML =
    '<button class="sb-user" onclick="toggleProfileMenu(event)">' +
      profileAvatarHtml(currentUser.username, name, 'avatar-sm', false) +
      '<div class="sb-user-text">' +
        '<span class="sb-user-name">' + esc(name) + '</span>' +
        '<span class="sb-user-mail"><span class="role-badge ' + roleCls + '">' + esc(roleTxt) + '</span></span>' +
      '</div>' +
      '<svg class="sb-user-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>' +
    '</button>';

  // Profile menu identity line (name + @username · role)
  const head = document.getElementById('pm-profile-head');
  if (head) {
    head.innerHTML =
      '<div class="pm-id-name">' + esc(name) + '</div>' +
      '<div class="pm-id-sub">@' + esc(currentUser.username) + ' · ' + esc(roleTxt) + '</div>';
  }

  // Top header user chip
  renderTopHeader();
}

// Changing account = signing out and signing in with that account's own
// username + password. There is deliberately no "switch account" shortcut:
// permissions must come from a real login, not from picking a name.
function profileSwitchAccount() {
  closeProfileMenu();
  doLogout();
}

function renderTreeWorkers(g) {
  if (!g.workers || !g.workers.length) return '<div style="font-size:0.75rem;color:#3a4a68;padding:4px 6px">Empty</div>';
  return g.workers.map(w =>
    '<div class="tree-worker-item' + (w.uid === highlightedWorkerUid ? ' highlighted' : '') + '" ' +
         'onclick="highlightWorker(\'' + w.uid + '\')" id="twi-' + w.uid + '">' +
      '<span class="tree-worker-dot"></span>' +
      (w.worker_id ? '<span class="tree-worker-id">' + esc(w.worker_id) + '</span>' : '') +
      '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(w.en_name) + '</span>' +
    '</div>'
  ).join('');
}

function highlightWorker(uid) {
  highlightedWorkerUid = uid;
  // Scroll to row in table
  const row = document.getElementById('row-' + uid);
  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('row-highlight');
    setTimeout(() => row.classList.remove('row-highlight'), 1800);
  }
  renderSidebar();
}

function toggleGroupExpand(id, event) {
  event.stopPropagation();
  if (expandedGroups.has(id)) expandedGroups.delete(id);
  else expandedGroups.add(id);
  renderSidebar();
}

// sidebar search (removed from UI — guard in case the element is absent)
(() => {
  const si = document.getElementById('sidebar-search-input');
  if (si) si.addEventListener('input', e => { sidebarSearchQ = e.target.value; renderSidebar(); });
})();

// ── SIDEBAR RESIZE ────────────────────────────────────────────────
/* Below 769px the sidebar is not a column that can narrow — it is an off-canvas
 * DRAWER. sidebar.css gates every `.collapsed` rule behind `min-width: 769px`
 * and then explicitly gives `.sidebar.collapsed` the same width as `.sidebar`,
 * so at tablet width the class changes the DOM and nothing on the screen. */
const _sidebarIsDrawer = () => window.matchMedia('(max-width: 768px)').matches;

function initSidebarResize() {
  const toggle = document.getElementById('sidebar-toggle');
  if (toggle) toggle.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    /* Same button, the action the mode actually supports: collapse the column on
     * a desktop, close the drawer on a tablet. Toggling `collapsed` here was a
     * dead click on every screen ≤768px — the button responded to nothing. */
    if (_sidebarIsDrawer()) sidebar.classList.remove('open');
    else sidebar.classList.toggle('collapsed');
  });
}

function initMobileMenu() {
  const sidebar = document.getElementById('sidebar');
  const backdrop= document.getElementById('sidebar-backdrop');
  // Note: #mobile-menu-btn already calls toggleMobileMenu() via inline onclick —
  // adding another listener here would double-toggle (cancel out), so we don't.
  if (backdrop) backdrop.addEventListener('click', () => sidebar?.classList.remove('open'));
}

// Fetch the worker's history the first time the section is expanded, not on
// every drawer open — most views never look at it.
function onWorkerHistoryToggle(el) {
  if (el.open && _currentViewUid) loadActivityLog(_currentViewUid);
}

// Detail overlay tabs: Details / Documents / Activity. The activity log costs a
// request, so it loads the first time its tab is opened for the current worker.
let _histTabLoaded = false;
function switchDetailTab(tab) {
  document.querySelectorAll('#vm-tabs .vm-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('#view-overlay .vm-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
  const body = document.querySelector('#view-overlay .detail-body');
  if (body) body.scrollTop = 0;
  if (tab === 'history' && !_histTabLoaded && _currentViewUid) {
    _histTabLoaded = true;
    loadActivityLog(_currentViewUid);
  }
}

// ── HISTORY MODULE ────────────────────────────────────────────────
// One timeline, three callers: a worker's activity log, a group's history and a
// document's version list. Everything funnels through renderHistory(), which
// takes plain entries — so a caller only has to map its own data onto the entry
// shape { action, detail, by, at, onClick, badge } and never touches markup.

const HIST_ACTIONS = {
  created:        { icon: '✦', tone: 'ok',    lo: 'ສ້າງ',            en: 'Created',        th: 'สร้าง',            ko: '생성' },
  updated:        { icon: '✎', tone: '',      lo: 'ແກ້ໄຂ',           en: 'Updated',        th: 'แก้ไข',            ko: '수정' },
  renamed:        { icon: '✎', tone: '',      lo: 'ປ່ຽນຊື່',          en: 'Renamed',        th: 'เปลี่ยนชื่อ',        ko: '이름 변경' },
  photo_updated:  { icon: '◉', tone: '',      lo: 'ປ່ຽນຮູບ',          en: 'Photo changed',  th: 'เปลี่ยนรูป',        ko: '사진 변경' },
  archived:       { icon: '▤', tone: 'warn',  lo: 'ເກັບເຂົ້າ',         en: 'Archived',       th: 'เก็บเข้าคลัง',      ko: '보관' },
  unarchived:     { icon: '▢', tone: 'ok',    lo: 'ເອົາອອກຈາກຄັງ',   en: 'Unarchived',     th: 'เอาออกจากคลัง',    ko: '보관 해제' },
  trashed:        { icon: '✕', tone: 'bad',   lo: 'ຍ້າຍໄປຖັງຂີ້ເຫຍື້ອ', en: 'Moved to trash', th: 'ย้ายไปถังขยะ',     ko: '휴지통으로' },
  deleted:        { icon: '✕', tone: 'bad',   lo: 'ລຶບ',             en: 'Deleted',        th: 'ลบ',               ko: '삭제' },
  restored:       { icon: '↺', tone: 'ok',    lo: 'ກູ້ຄືນ',            en: 'Restored',       th: 'กู้คืน',            ko: '복원' },
  worker_added:   { icon: '＋', tone: 'ok',   lo: 'ເພີ່ມຄົນງານ',       en: 'Worker added',   th: 'เพิ่มแรงงาน',       ko: '근로자 추가' },
  worker_removed: { icon: '－', tone: 'bad',  lo: 'ເອົາຄົນງານອອກ',    en: 'Worker removed', th: 'นำแรงงานออก',     ko: '근로자 제외' },
  uploaded:       { icon: '⇪', tone: 'ok',    lo: 'ອັບໂຫລດ',          en: 'Uploaded',       th: 'อัปโหลด',          ko: '업로드' },
};

function _histLabel(action) {
  const a = HIST_ACTIONS[action];
  return a ? bi(a.lo, a.en, a.th, a.ko) : action;
}

// Absolute date is what matters for records, but "3 days ago" is what the eye
// reads — so show relative up to a month, then fall back to the real date.
function _histWhen(at) {
  if (!at) return '';
  // SQLite datetime('now') is UTC but has no zone marker; tell Date so the
  // relative maths is not off by the local offset.
  const iso = /Z|[+-]\d{2}:?\d{2}$/.test(at) ? at : at.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (isNaN(d)) return at;
  const secs = Math.round((Date.now() - d) / 1000);
  const abs  = d.toLocaleString();
  if (secs < 60)     return { rel: bi('ຕອນນີ້', 'just now', 'เมื่อครู่', '방금'), abs };
  const mins = Math.floor(secs / 60);
  if (mins < 60)     return { rel: mins + bi(' ນາທີກ່ອນ', 'm ago', ' นาทีที่แล้ว', '분 전'), abs };
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)      return { rel: hrs + bi(' ຊົ່ວໂມງກ່ອນ', 'h ago', ' ชั่วโมงที่แล้ว', '시간 전'), abs };
  const days = Math.floor(hrs / 24);
  if (days <= 30)    return { rel: days + bi(' ມື້ກ່ອນ', 'd ago', ' วันที่แล้ว', '일 전'), abs };
  return { rel: d.toLocaleDateString(), abs };
}

// entries: [{ action, detail, by, at, onClick, badge, extra }]
// `onClick` and `extra` are raw handler/markup strings supplied by the caller —
// items stay divs (not buttons) so `extra` can hold its own button without
// nesting one inside another.
function renderHistory(container, entries, opts) {
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  if (!el) return;
  const o = opts || {};
  if (!entries || !entries.length) {
    el.innerHTML = '<div class="hist-empty">' +
      esc(o.empty || bi('ຍັງບໍ່ມີປະຫວັດ', 'No history yet', 'ยังไม่มีประวัติ', '기록 없음')) + '</div>';
    return;
  }
  el.innerHTML = '<div class="hist-list">' + entries.map(e => {
    const meta = HIST_ACTIONS[e.action] || {};
    const when = _histWhen(e.at);
    return '<div class="hist-item' + (e.onClick ? ' hist-clickable' : '') + '"' +
        (e.onClick ? ' role="button" tabindex="0" onclick="' + e.onClick + '"' : '') + '>' +
      '<span class="hist-dot' + (meta.tone ? ' hist-' + meta.tone : '') + '">' + (meta.icon || '•') + '</span>' +
      '<span class="hist-body">' +
        '<span class="hist-line">' +
          '<span class="hist-action">' + esc(_histLabel(e.action)) + '</span>' +
          (e.badge ? '<span class="hist-badge">' + esc(e.badge) + '</span>' : '') +
        '</span>' +
        (e.detail ? '<span class="hist-detail">' + esc(e.detail) + '</span>' : '') +
        '<span class="hist-meta">' +
          (when ? '<span class="hist-time" title="' + esc(when.abs || '') + '">' + esc(when.rel || when) + '</span>' : '') +
          (e.by ? '<span class="hist-by">' + esc(bi('ໂດຍ ', 'by ', 'โดย ', '') + e.by) + '</span>' : '') +
        '</span>' +
      '</span>' +
      (e.extra || '') +
    '</div>';
  }).join('') + '</div>';
}

// Map a raw activity_log row onto a history entry.
const _histFromLog = r => ({ action: r.action, detail: r.detail, by: r.performed_by, at: r.created_at });

async function loadActivityLog(uid) {
  const container = document.getElementById('vm-activity-content');
  if (!container) return;
  container.innerHTML = '<div class="hist-empty">' + esc(bi('ກຳລັງໂຫລດ…', 'Loading…', 'กำลังโหลด…', '불러오는 중…')) + '</div>';
  let log = [];
  try { log = await DB.getActivity(uid); } catch (e) { log = []; }
  renderHistory(container, log.map(_histFromLog), {
    empty: bi('ຍັງບໍ່ມີການເຄື່ອນໄຫວ', 'No activity yet', 'ยังไม่มีความเคลื่อนไหว', '활동 없음'),
  });
}

async function loadGroupActivity(groupId) {
  const container = document.getElementById('gh-content');
  if (!container) return;
  container.innerHTML = '<div class="hist-empty">' + esc(bi('ກຳລັງໂຫລດ…', 'Loading…', 'กำลังโหลด…', '불러오는 중…')) + '</div>';
  let log = [];
  try { log = await DB.getGroupActivity(groupId); } catch (e) { log = []; }
  renderHistory(container, log.map(_histFromLog), {
    empty: bi('ຍັງບໍ່ມີປະຫວັດຂອງກຸ່ມນີ້', 'No history for this group yet', 'ยังไม่มีประวัติของกลุ่มนี้', '이 그룹의 기록 없음'),
  });
}

function openGroupHistory(id) {
  const g = DB.getGroup(id || activeGroupId);
  if (!g) return;
  const ttl = document.getElementById('gh-title');
  if (ttl) ttl.textContent = g.name || g.destination || '—';
  openOverlay('grouphist-overlay');
  loadGroupActivity(g.id);
}

// ── DASHBOARD CHARTS (SVG, pure, offline-first) ───────────────────
function renderDashCharts() {
  const ws = DB.getWorkers(activeGroupId);

  _renderPieChart('chart-grade', 'chart-grade-legend', _countBy(ws, 'grade'),
    Object.assign({ '':'#9ca3af' }, GRADE_COLORS));

  _renderPieChart('chart-visa', 'chart-visa-legend', _countBy(ws, 'visa_status'),
    { approved:'#16a34a', applied:'#2563eb', not_started:'#9ca3af', rejected:'#dc2626', '':'#d1d5db' });

  const expiryBuckets = { expired:0, warn:0, near:0, ok:0 };
  ws.forEach(w => {
    const c = expiryClass(w.passport_expiry);
    if      (c === 'expiry-expired') expiryBuckets.expired++;
    else if (c === 'expiry-warn')    expiryBuckets.warn++;
    else if (c === 'expiry-near')    expiryBuckets.near++;
    else                             expiryBuckets.ok++;
  });
  _renderPieChart('chart-expiry', 'chart-expiry-legend', expiryBuckets,
    { expired:'#dc2626', warn:'#f59e0b', near:'#fbbf24', ok:'#16a34a' });
}

function _countBy(arr, key) {
  const out = {};
  arr.forEach(item => { const v = item[key] || ''; out[v] = (out[v] || 0) + 1; });
  return out;
}

function _renderPieChart(svgId, legendId, counts, colors) {
  const svgEl    = document.getElementById(svgId);
  const legendEl = document.getElementById(legendId);
  if (!svgEl) return;

  const entries = Object.entries(counts).filter(([,v]) => v > 0);
  const total   = entries.reduce((s, [,v]) => s + v, 0);

  if (!total) {
    svgEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.8rem;text-align:center">No data</p>';
    if (legendEl) legendEl.innerHTML = '';
    return;
  }

  let svgPaths   = '';
  let legendHtml = '';
  let startAngle = -Math.PI / 2;
  const cx = 60, cy = 60, r = 52;

  entries.forEach(([key, val]) => {
    const angle = (val / total) * 2 * Math.PI;
    const x1    = cx + r * Math.cos(startAngle);
    const y1    = cy + r * Math.sin(startAngle);
    const x2    = cx + r * Math.cos(startAngle + angle);
    const y2    = cy + r * Math.sin(startAngle + angle);
    const large = angle > Math.PI ? 1 : 0;
    const color = colors[key] || '#9ca3af';
    svgPaths   += `<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large},1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${color}" stroke="var(--bg-card,#fff)" stroke-width="1.5"/>`;
    legendHtml += `<div class="chart-legend-item"><span style="background:${color}"></span>${esc(key || '—')} (${val})</div>`;
    startAngle += angle;
  });

  svgEl.innerHTML = `<svg viewBox="0 0 120 120" width="110" height="110">${svgPaths}` +
    `<text x="60" y="64" text-anchor="middle" font-size="13" font-weight="700" fill="var(--text,#1f2937)">${total}</text></svg>`;
  if (legendEl) legendEl.innerHTML = legendHtml;
}

// ── GROUP SWITCH ──────────────────────────────────────────────────
function switchGroup(id) {
  activeGroupId = id;
  quickFilter = '';            // a normal group open shows ALL members (no leaked alerts/selected filter)
  _overviewMode = '';
  expandedGroups.add(id);
  highlightedWorkerUid = null;
  document.getElementById('search').value = '';
  const ts = document.getElementById('sidebar-search-input');
  if (ts) ts.value = '';
  document.getElementById('f-employer').value   = '';
  document.getElementById('f-supervisor').value = '';
  document.getElementById('f-blood').value      = '';
  showMainView('group');
  document.querySelectorAll('.sb-nav-item').forEach(b => b.classList.remove('active'));
  document.getElementById('nav-workers')?.classList.add('active');
  renderSidebar();
  renderStats();
  rebuildFilters();
  applyFilters();
  renderTable();
  document.getElementById('sidebar').classList.remove('open');
}

// ── Navigate to a specific group (from dashboard cards / overview) ─
function openGroup(groupId) {
  switchGroup(groupId);
}

// All workers across every group (used when no single group is active)
function _allWorkersFlat() { return DB.getGroups().flatMap(g => g.workers || []); }

// ── COUPLES ───────────────────────────────────────────────────────
// `couple` is a printed yes/no — it puts 부부 on the KD card and says nothing
// about who. `spouse_uid` says who, and the two are kept in step by the server
// (repo.setSpouse writes both halves of the pair in one go).

/** The partner's worker object, or null — including when they are in the trash,
 *  since the bootstrap only carries live records and the link outlives them. */
function spouseOf(w) {
  if (!w || !w.spouse_uid) return null;
  return _allWorkersFlat().find(x => x.uid === w.spouse_uid) || null;
}

/** Which group holds this worker (needed because DB.updateWorker keys by group). */
function _groupIdOf(uid) {
  const g = DB.getGroups().find(x => (x.workers || []).some(w => w.uid === uid));
  return g ? g.id : activeGroupId;
}

/**
 * Pair `uid` with `spouseUid`, or unpair with ''. Admin-only.
 *
 * The server rewrites up to three records for one pairing — the two being
 * married and anybody either of them is leaving — so the same set is patched
 * here, in the same order, to keep the local cache honest. The extra PATCHes
 * are deliberate rather than wasteful: repo.setSpouse is idempotent, and
 * re-fetching the whole bootstrap instead would race the durable write queue
 * that has not necessarily flushed the first patch yet.
 */
function setCouple(uid, spouseUid) {
  if (!isAdmin()) return;
  const all  = _allWorkersFlat();
  const me   = all.find(x => x.uid === uid);
  if (!me) return;
  const want = String(spouseUid || '');
  if (want === uid) return;
  const other = want ? all.find(x => x.uid === want) : null;
  if (want && !other) return;

  const release = u => { if (u) DB.updateWorker(_groupIdOf(u), u, { spouse_uid: '', couple: 'no' }); };
  if (me.spouse_uid && me.spouse_uid !== want) release(me.spouse_uid);
  if (other && other.spouse_uid && other.spouse_uid !== uid) release(other.spouse_uid);

  if (want) {
    DB.updateWorker(_groupIdOf(uid),  uid,  { spouse_uid: want, couple: 'yes' });
    DB.updateWorker(_groupIdOf(want), want, { spouse_uid: uid,  couple: 'yes' });
  } else {
    DB.updateWorker(_groupIdOf(uid), uid, { spouse_uid: '', couple: 'no' });
  }
}

let _spousePickFor = '';

/* showConfirm always dresses itself as a destructive "Delete", which every
 * couple action would misdescribe: pairing, unpairing and sharing a photo all
 * change a link, and none of them destroys a record. Call right after
 * showConfirm — it is what pickMove does for the same reason. */
function _confirmNeutral(label) {
  const ok = document.getElementById('cm-confirm-btn');
  if (ok) { ok.className = 'btn btn-primary'; ok.textContent = label; }
}

/** Choose who this worker is married to. Everyone live is a candidate. */
function openSpousePicker(uid) {
  if (!isAdmin()) return;
  _spousePickFor = uid;
  const w = _allWorkersFlat().find(x => x.uid === uid);
  const sub = document.getElementById('spouse-sub');
  if (sub) sub.textContent = w ? (w.en_name || w.worker_id || '') : '';
  const q = document.getElementById('spouse-search');
  if (q) q.value = '';
  renderSpouseList();
  openOverlay('spouse-overlay');
  if (q) setTimeout(() => q.focus(), 60);
}

function renderSpouseList() {
  const list = document.getElementById('spouse-list');
  if (!list) return;
  const me = _allWorkersFlat().find(x => x.uid === _spousePickFor);
  const q  = (document.getElementById('spouse-search') || {}).value || '';
  const needle = q.trim().toLowerCase();
  const myGroup = _groupIdOf(_spousePickFor);

  const cands = _allWorkersFlat()
    .filter(x => x.uid !== _spousePickFor)
    .filter(x => !needle || [x.en_name, x.lo_name, x.worker_id, x.passport_no]
      .join(' ').toLowerCase().includes(needle))
    // Same group first: a couple almost always travels together, so the people
    // being looked for are nearly always a few rows away.
    .sort((a, b) => (_groupIdOf(b.uid) === myGroup) - (_groupIdOf(a.uid) === myGroup))
    .slice(0, 60);

  list.innerHTML = cands.length ? cands.map(x => {
    const gid  = _groupIdOf(x.uid);
    const grp  = gid === myGroup ? '' : ((DB.getGroup(gid) || {}).name || '');
    const cur  = me && me.spouse_uid === x.uid;
    // Naming somebody who is already married ends THEIR pairing — say so before
    // the click, not after.
    const taken = x.spouse_uid && x.spouse_uid !== _spousePickFor;
    return '<button class="pm-group' + (cur ? ' pm-group-cur' : '') + '" onclick="doSetSpouse(\'' + esc(x.uid) + '\')">' +
      '<span class="pm-group-name">' + esc(x.en_name || x.uid) +
        (x.worker_id ? ' <span class="sp-id">' + esc(x.worker_id) + '</span>' : '') +
        (grp ? '<span class="sp-grp">' + esc(grp) + '</span>' : '') +
      '</span>' +
      (cur   ? '<span class="sp-tag sp-tag-cur">&#10003;</span>'
             : taken ? '<span class="sp-tag">' + esc(bi('ມີຄູ່ແລ້ວ', 'already paired', 'มีคู่แล้ว', '이미 연결됨')) + '</span>' : '') +
    '</button>';
  }).join('')
    : '<p class="pm-empty">' + esc(bi('ບໍ່ພົບ', 'No one found', 'ไม่พบ', '찾을 수 없음')) + '</p>';
}

function doSetSpouse(spouseUid) {
  const uid = _spousePickFor;
  const all = _allWorkersFlat();
  const me  = all.find(x => x.uid === uid);
  const sp  = all.find(x => x.uid === spouseUid);
  if (!me || !sp) return;
  closeOverlay('spouse-overlay');

  const apply = () => {
    setCouple(uid, spouseUid);
    refreshAll();
    if (_currentViewUid === uid) openView(uid);
    toast(bi('ຈັບຄູ່ແລ້ວ', 'Paired', 'จับคู่แล้ว', '연결됨') + ': ' +
          (me.en_name || uid) + ' + ' + (sp.en_name || spouseUid), 'ok');
  };

  // Pairing somebody who already has a partner silently divorces that partner.
  // That is a third record changing, so it is confirmed rather than assumed.
  const taken = sp.spouse_uid && sp.spouse_uid !== uid;
  const other = taken ? all.find(x => x.uid === sp.spouse_uid) : null;
  if (taken) {
    showConfirm(
      bi('ຄົນນີ້ມີຄູ່ແລ້ວ', 'Already paired', 'คนนี้มีคู่แล้ว', '이미 연결된 사람'),
      bi('ຈະຍົກເລີກຄູ່ເກົ່າ', 'This will unpair them from', 'จะยกเลิกคู่เดิมกับ', '기존 연결이 해제됩니다') +
        ' ' + ((other && other.en_name) || sp.spouse_uid) + '.',
      apply);
    _confirmNeutral(bi('ຈັບຄູ່', 'Pair', 'จับคู่', '연결'));
  } else apply();
}

function unpairSpouse(uid) {
  if (!isAdmin()) return;
  const me = _allWorkersFlat().find(x => x.uid === uid);
  if (!me || !me.spouse_uid) return;
  const sp = spouseOf(me);
  showConfirm(
    bi('ຍົກເລີກຄູ່', 'Unpair', 'ยกเลิกคู่', '연결 해제'),
    (me.en_name || uid) + ' + ' + ((sp && sp.en_name) || me.spouse_uid),
    () => {
      setCouple(uid, '');
      refreshAll();
      if (_currentViewUid === uid) openView(uid);
      toast(bi('ຍົກເລີກແລ້ວ', 'Unpaired', 'ยกเลิกแล้ว', '해제됨'), 'ok');
    });
  _confirmNeutral(bi('ຍົກເລີກ', 'Unpair', 'ยกเลิก', '해제'));
}

/**
 * Take the partner's photograph for this record too — one file, both records.
 *
 * It copies the PATH, not the bytes: the two records end up pointing at the
 * same stored file, which is the whole point (answer 4) and is only safe
 * because the server counts references before unlinking a photo. Deleting
 * either record afterwards leaves the file with whoever is left.
 */
function useSpousePhoto(uid) {
  if (!isAdmin()) return;
  const me = _allWorkersFlat().find(x => x.uid === uid);
  const sp = spouseOf(me);
  if (!sp || !sp.photo) return;
  showConfirm(
    bi('ໃຊ້ຮູບຂອງຄູ່', "Use partner's photo", 'ใช้รูปของคู่', '배우자 사진 사용'),
    bi('ຮູບເກົ່າຈະຖືກແທນທີ່', "This record's current photo is replaced.", 'รูปเดิมจะถูกแทนที่', '현재 사진이 교체됩니다'),
    () => {
      DB.updateWorker(_groupIdOf(uid), uid, {
        photo: sp.photo, photo_orig: sp.photo_orig || '', photo_thumb: sp.photo_thumb || '',
      });
      refreshAll();
      if (_currentViewUid === uid) openView(uid);
      toast(bi('ໃຊ້ຮູບດຽວກັນແລ້ວ', 'Photo shared', 'ใช้รูปเดียวกันแล้ว', '사진 공유됨'), 'ok');
    });
  _confirmNeutral(bi('ໃຊ້ຮູບນີ້', 'Use it', 'ใช้รูปนี้', '사용'));
}

// Make sure activeGroupId points at the group that owns `uid` (for global
// search / overview where no single group is selected yet).
function _ensureGroupFor(uid) {
  const cur = DB.getGroup(activeGroupId);
  if (cur && (cur.workers || []).some(w => w.uid === uid)) return;
  for (const g of DB.getGroups()) {
    if ((g.workers || []).some(w => w.uid === uid)) { activeGroupId = g.id; break; }
  }
}

// ── GROUPS OVERVIEW (the "ກຸ່ມ" landing — pick a group, then see members) ──
// _overviewMode = '' (normal) | 'selected' | 'alerts'. The Selected and Alerts
// views show groups FIRST (only those that match), then drill into one group.
let _overviewMode = '';
const _isExpiring = w => ['expiry-warn','expiry-near','expiry-expired'].includes(expiryClass(w.passport_expiry));

// How many workers in a group match the given overview mode.
function _groupMetric(g, mode) {
  const ws = g.workers || [];
  if (mode === 'selected') { const s = new Set(getSelectedUids()); return ws.filter(w => s.has(w.uid)).length; }
  if (mode === 'alerts')   return ws.filter(_isExpiring).length;
  return ws.length;
}

function _goCard(g, count, mode) {
  const ws    = g.workers || [];
  const short = ((g.name || '?').replace(/[^A-Za-z0-9]/g, '').substring(0, 2).toUpperCase()) || 'KD';
  const route = g.route || g.departure || '';
  const onclick = mode
    ? 'openOverviewGroup(\'' + mode + '\',\'' + esc(g.id) + '\')'
    : 'openGroup(\'' + esc(g.id) + '\')';
  let stats;
  if (mode === 'selected') {
    stats = '<div class="go-stat go-sel"><span class="n">' + count + '</span><span class="l">' + esc(bi('ຄັດເລືອກ','Selected','คัดเลือก','선택')) + '</span></div>' +
            '<div class="go-stat"><span class="n">' + ws.length + '</span><span class="l">' + (t('dz_workers_suffix') || 'ຄົນ') + '</span></div>';
  } else if (mode === 'alerts') {
    stats = '<div class="go-stat go-alert"><span class="n">' + count + '</span><span class="l">' + (t('dz_near') || 'ໃກ້ໝົດ') + '</span></div>' +
            '<div class="go-stat"><span class="n">' + ws.length + '</span><span class="l">' + (t('dz_workers_suffix') || 'ຄົນ') + '</span></div>';
  } else {
    const expiring = ws.filter(_isExpiring).length;
    stats = '<div class="go-stat"><span class="n">' + ws.length + '</span><span class="l">' + (t('dz_workers_suffix') || 'ຄົນ') + '</span></div>' +
            '<div class="go-stat' + (expiring ? ' go-alert' : '') + '"><span class="n">' + expiring + '</span><span class="l">' + (t('dz_near') || 'ໃກ້ໝົດ') + '</span></div>';
  }
  return '<div class="go-card bento-tile" data-size="m" onclick="' + onclick + '">' +
    '<div class="go-card-top">' +
      '<div class="go-ic">' + esc(short) + '</div>' +
      '<div style="min-width:0">' +
        '<div class="go-name">' + esc(g.name || '—') + '</div>' +
        (route ? '<div class="go-route">' + esc(route) + '</div>' : '') +
      '</div>' +
      '<svg class="go-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>' +
    '</div>' +
    '<div class="go-stats">' + stats + '</div>' +
  '</div>';
}

function renderGroupsOverview() {
  const el = document.getElementById('go-grid');
  if (!el) return;
  const titleEl = document.getElementById('go-title');
  const subEl   = document.getElementById('go-sub');
  if (_overviewMode === 'selected') {
    if (titleEl) titleEl.textContent = '★ ' + bi('ຄັດເລືອກ','Selected','คัดเลือก','선택됨');
    if (subEl)   subEl.textContent   = bi('ກຸ່ມທີ່ມີຄົນຖືກຄັດເລືອກ — ກົດເພື່ອເບິ່ງ','Groups with selected workers — tap to view','กลุ่มที่มีคนถูกคัดเลือก — แตะเพื่อดู','선택된 근로자가 있는 그룹 — 탭하여 보기');
  } else if (_overviewMode === 'alerts') {
    if (titleEl) titleEl.textContent = '⚠ ' + t('passport_alert');
    if (subEl)   subEl.textContent   = bi('ກຸ່ມທີ່ມີພາສປອດໃກ້ໝົດ — ກົດເພື່ອເບິ່ງ','Groups with expiring passports — tap to view','กลุ่มที่มีพาสปอร์ตใกล้หมด — แตะเพื่อดู','여권 만료 임박 그룹 — 탭하여 보기');
  } else {
    if (titleEl) titleEl.textContent = bi(titleEl.dataset.lo, titleEl.dataset.en, titleEl.dataset.th, titleEl.dataset.ko);
    if (subEl)   subEl.textContent   = bi(subEl.dataset.lo, subEl.dataset.en, subEl.dataset.th, subEl.dataset.ko);
  }

  const groups = _orderGroups(DB.getGroups().filter(g => !g.archived));
  if (_overviewMode) {
    const withMetric = groups.map(g => ({ g, n: _groupMetric(g, _overviewMode) })).filter(x => x.n > 0);
    const empty = _overviewMode === 'alerts'
      ? bi('ບໍ່ມີພາສປອດໃກ້ໝົດ','No expiring passports','ไม่มีพาสปอร์ตใกล้หมด','만료 임박 여권 없음')
      : bi('ຍັງບໍ່ມີຄົນຖືກຄັດເລືອກ','No one selected yet','ยังไม่มีคนถูกคัดเลือก','아직 선택된 사람이 없습니다');
    el.innerHTML = withMetric.length
      ? withMetric.map(x => _goCard(x.g, x.n, _overviewMode)).join('')
      : '<div class="go-empty">' + esc(empty) + '</div>';
    return;
  }
  el.innerHTML = groups.length
    ? groups.map(g => _goCard(g, null, '')).join('')
    : '<div class="go-empty">' + (t('dz_no_projects') || 'ຍັງບໍ່ມີກຸ່ມ') + '</div>';
}

// Open a group from the Selected/Alerts overview → show only its matching members.
function openOverviewGroup(mode, id) {
  switchGroup(id);            // resets quickFilter and shows the group
  quickFilter = mode;        // 'selected' | 'alerts'
  applyFilters();             // narrow to the matching members
  document.querySelectorAll('.sb-nav-item').forEach(b => b.classList.remove('active'));
  document.getElementById(mode === 'alerts' ? 'nav-alerts' : 'nav-selected')?.classList.add('active');
  _syncTabBar(mode === 'alerts' ? 'alerts' : 'selected');
  const g    = DB.getGroup(id);
  const icon = mode === 'alerts' ? '⚠ ' : '★ ';
  const t1   = document.getElementById('page-title-group'); if (t1) t1.textContent = icon + (g ? (g.name || '') : '');
  const t2   = document.getElementById('page-sub');         if (t2) t2.textContent = mode === 'alerts' ? t('passport_alert') : bi('ຄັດເລືອກ','Selected','คัดเลือก','선택됨');
}

// ── Sidebar search → mirror into toolbar search + filter ──────────
function sidebarSearch(value) {
  const s = document.getElementById('search');
  if (s) s.value = value;

  // Searching inside an already-open group → just filter it
  if (activeGroupId) { applyFilters(); return; }

  if (value) {
    // Global worker search across ALL groups → show the member table
    ['f-employer','f-supervisor','f-blood'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
    quickFilter = '';
    // Typing re-enters this on every keystroke; only animate the first time, or
    // the results would restart their entrance under the user's fingers.
    if (document.getElementById('group-view')?.style.display === 'none') showMainView('group');
    const t1 = document.getElementById('page-title-group'); if (t1) t1.textContent = '🔍 ' + value;
    const t2 = document.getElementById('page-sub');         if (t2) t2.textContent = (t('all_groups') || 'All groups');
    rebuildFilters();
    applyFilters();
  } else {
    // Cleared while in global search → back to the group overview
    navTo('workers', document.getElementById('nav-workers'));
  }
}
// Back-compat shim (old top-header handler name)
function syncSearch(input) { sidebarSearch(input.value); }

// ── ROUTE HEADER ──────────────────────────────────────────────────
// The page header of an open group answers "which flight is this?" —
// `VTE → ICN · departure date`, taken from the GROUP, never from a worker.
// Two workers in one group can carry different kr_city values; the group's
// route is the one answer that is true for the whole list.
//
// The route is one free-text field and stays one: it has been typed as
// "VTE → ICN", "VTE -> ICN", "VTE to ICN" and "VTE/ICN" in the live data, and
// splitting it at read time keeps every one of those readable without a
// migration. Anything that does not split into exactly two halves is shown
// verbatim rather than guessed at.
//
// The block between the markers below is lifted verbatim by
// infra/scripts/test-header.js and exercised there — it is the shipped code
// that is tested, not a copy of it. Keep the markers.
/* ── route-parse:start ── */
const _ROUTE_SPLIT = /\s*(?:→|➔|➜|⇒|-->|->|—|–|\/|\s-\s|\bto\b)\s*/i;

/** "VTE → ICN" → { from:'VTE', to:'ICN' }. Anything else → null. */
function routeParts(route) {
  const s = String(route == null ? '' : route).trim();
  if (!s) return null;
  const bits = s.split(_ROUTE_SPLIT).map(x => x.trim()).filter(Boolean);
  return bits.length === 2 ? { from: bits[0], to: bits[1] } : null;
}
/* ── route-parse:end ── */

/** The group's destination, for a worker who has no kr_city of their own. */
function _routeDest(g) {
  const p = routeParts(g && g.route);
  return p ? p.to : '';
}

/** `VTE → ICN · date` as HTML, or '' when the group carries neither. */
function _routeHeadHtml(g) {
  const arrow = '<svg class="ph-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<line x1="4" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/></svg>';
  const parts = routeParts(g && g.route);
  const date  = String((g && g.departure) || '').trim();
  const bits  = [];
  if (parts) {
    bits.push('<span class="ph-route">' +
      '<span class="ph-city">' + esc(parts.from) + '</span>' + arrow +
      '<span class="ph-city">' + esc(parts.to) + '</span>' +
    '</span>');
  } else if (g && g.route) {
    bits.push('<span class="ph-route"><span class="ph-city">' + esc(g.route) + '</span></span>');
  }
  if (date) bits.push('<span class="ph-date">' + esc(date) + '</span>');
  return bits.join('<span class="ph-dot" aria-hidden="true">&middot;</span>');
}

// ── STATS ─────────────────────────────────────────────────────────
function renderStats() {
  const ws = DB.getWorkers(activeGroupId);
  const expiring  = ws.filter(w => ['expiry-warn','expiry-near','expiry-expired'].includes(expiryClass(w.passport_expiry))).length;
  const sups = new Set(ws.map(w => w.group_supervisor).filter(Boolean)).size;
  const emps = new Set(ws.map(w => w.employer_code).filter(Boolean)).size;
  document.getElementById('stat-total').textContent    = ws.length;
  document.getElementById('stat-sups').textContent     = sups;
  document.getElementById('stat-emps').textContent     = emps;
  document.getElementById('stat-expiring').textContent = expiring;

  // Dynamic badges
  const empsBadge = document.getElementById('stat-emps-badge');
  if (empsBadge) empsBadge.textContent = emps + ' ' + (emps === 1 ? 'sector' : 'sectors');

  // Sidebar "Passport Alerts" nav badge
  const navAlerts = document.getElementById('nav-alerts-count');
  if (navAlerts) { navAlerts.textContent = expiring || ''; navAlerts.style.display = expiring ? '' : 'none'; }

  const alertCard  = document.querySelector('.stat-card.stat-alert');
  const alertBadge = document.getElementById('stat-expiring-badge');
  if (alertBadge) {
    if (expiring > 0) {
      alertBadge.textContent = 'Critical';
      alertBadge.className = 'stat-badge badge-red';
      if (alertCard) alertCard.style.borderLeftColor = 'var(--red)';
    } else {
      alertBadge.textContent = 'All clear';
      alertBadge.className = 'stat-badge badge-green';
      if (alertCard) alertCard.style.borderLeftColor = 'var(--green)';
    }
  }

  // Page title = active group name; sub = the route header (VTE → ICN · date)
  const g = DB.getGroup(activeGroupId);
  const titleEl = document.getElementById('page-title-group');
  const subEl   = document.getElementById('page-sub');
  if (titleEl) titleEl.textContent = g ? g.name : 'Dashboard';
  if (subEl) {
    const head = g ? _routeHeadHtml(g) : '';
    if (head) {
      // data-i18n has to go while markup is in there: applyTranslations()
      // assigns textContent to every [data-i18n], which would flatten the route
      // to the generic subtitle on the next language switch.
      subEl.removeAttribute('data-i18n');
      subEl.innerHTML = head;
    } else {
      subEl.setAttribute('data-i18n', 'app_sub');
      subEl.textContent = t('app_sub');
    }
  }
}

// ── TABLE FILTERS ─────────────────────────────────────────────────
function rebuildFilters() {
  const ws = activeGroupId ? DB.getWorkers(activeGroupId) : _allWorkersFlat();
  const emps = [...new Set(ws.map(w => w.employer_code).filter(Boolean))].sort();
  const sups = [...new Set(ws.map(w => w.group_supervisor).filter(Boolean))].sort();

  const se = document.getElementById('f-employer');
  const ss = document.getElementById('f-supervisor');
  const ce = se.value; const cs = ss.value;

  se.innerHTML = '<option value="">' + t('all_employers') + '</option>' +
    emps.map(e => '<option' + (e === ce ? ' selected' : '') + '>' + esc(e) + '</option>').join('');
  ss.innerHTML = '<option value="">' + t('all_supervisors') + '</option>' +
    sups.map(s => '<option' + (s === cs ? ' selected' : '') + '>' + esc(s) + '</option>').join('');
}

function applyFilters() {
  const ws = activeGroupId ? DB.getWorkers(activeGroupId) : _allWorkersFlat();
  const q  = document.getElementById('search').value.toLowerCase();
  const fe = document.getElementById('f-employer').value;
  const fs = document.getElementById('f-supervisor').value;
  const fb = document.getElementById('f-blood').value;

  tableFiltered = ws.filter(w => {
    if (quickFilter === 'alerts' &&
        !['expiry-warn','expiry-near','expiry-expired'].includes(expiryClass(w.passport_expiry))) return false;
    if (quickFilter === 'selected' && !isSelected(w.uid)) return false;
    if (fe && w.employer_code !== fe) return false;
    if (fs && w.group_supervisor !== fs) return false;
    if (fb && w.blood !== fb) return false;
    if (q) {
      const hay = [w.worker_id, w.en_name, w.lo_name, w.passport_no, w.village, w.tel, w.group_supervisor].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  doSort();
  renderTable();
}

function sortBy(col) {
  // update header classes
  document.querySelectorAll('th[data-col]').forEach(th => {
    th.classList.remove('asc','desc');
    if (th.dataset.col === col) th.classList.add(sortCol === col && sortAsc ? 'asc' : 'desc');
  });
  if (sortCol === col) sortAsc = !sortAsc; else { sortCol = col; sortAsc = true; }
  doSort(); renderTable();
}

function doSort() {
  tableFiltered.sort((a, b) => {
    if (sortCol === 'age') {
      const va = calcAge(a.dob) || 0, vb = calcAge(b.dob) || 0;
      return sortAsc ? va - vb : vb - va;
    }
    const va = (a[sortCol] || '').toLowerCase();
    const vb = (b[sortCol] || '').toLowerCase();
    return sortAsc ? (va < vb ? -1 : va > vb ? 1 : 0) : (va > vb ? -1 : va < vb ? 1 : 0);
  });
}

// ── TABLE RENDER ──────────────────────────────────────────────────
function renderTable() {
  const tbody  = document.getElementById('tbl-body');
  const noData = document.getElementById('no-data');
  // One clone of the group covers both the count and the cards — getGroup already
  // returns its workers, so there's no need for a second full deep-clone via
  // getWorkers (each clone is the whole group, documents and all).
  const g      = DB.getGroup(activeGroupId);
  const ws     = activeGroupId ? (g ? g.workers : []) : _allWorkersFlat();

  // Count bar — just the result count (group name/route already in the page header)
  const alertTag = quickFilter === 'alerts'
    ? ' &nbsp;·&nbsp; <span style="color:var(--red);font-weight:700">⚠ ' + t('passport_alert') + '</span>'
    : '';
  document.getElementById('count-bar').innerHTML =
    t('showing', { n: tableFiltered.length, total: ws.length }) + alertTag;

  // Before the early returns below, so the bar is right in every view and when
  // the list comes back empty.
  const pickCol = _canPick();
  const pickTh  = document.getElementById('pick-th');
  if (pickTh) pickTh.hidden = !pickCol;
  renderPickBar();

  const cardsWrap = document.getElementById('cards-wrap');
  const tableWrap = document.querySelector('.table-wrap');

  if (!tableFiltered.length) {
    tbody.innerHTML = '';
    document.getElementById('cards-grid').innerHTML = '';
    noData.style.display = 'block';
    if (cardsWrap) cardsWrap.style.display = 'none';
    if (tableWrap) tableWrap.style.display = '';   // no-data lives inside table-wrap
    noData.querySelector('.no-data-title').textContent = ws.length ? t('no_results') : t('no_data_title');
    noData.querySelector('.no-data-msg').textContent   = ws.length ? '' : t('no_data_msg');
    return;
  }
  noData.style.display = 'none';

  applyViewMode();

  // Only build the view the user is actually looking at. Rendering BOTH the
  // table rows AND every card on each pass (then hiding one) doubled the DOM
  // and image-decode work — the main cause of the jank on larger groups.
  const view = currentView();
  if (view === 'kdcard' || view === 'photo') {
    if (view === 'photo') renderPhotoCards(g);
    else                  renderCards(g);
    if (tbody) tbody.innerHTML = '';
    return;
  }
  const cg = document.getElementById('cards-grid');
  if (cg) cg.innerHTML = '';

  tbody.innerHTML = tableFiltered.map((w, i) => {
    const age = calcAge(w.dob);
    const ec  = expiryClass(w.passport_expiry);
    const idHtml = w.worker_id
      ? '<span class="worker-id">' + esc(w.worker_id) + '</span>'
      : '<span class="worker-id no-id">No ID</span>';
    return '<tr id="row-' + w.uid + '" data-pick-row="' + esc(w.uid) + '"' +
      (isPicked(w.uid) ? ' class="picked"' : '') +
      ' onclick="openView(\'' + w.uid + '\')">' +
      (pickCol ? '<td class="pick-cell" onclick="event.stopPropagation()">' + _pickBox(w.uid, i + 1) + '</td>' : '') +
      /* data-col mirrors the <th> of the same name. It is what lets a column be
         hidden at a narrow width with one CSS rule covering both the header and
         every cell — without it, hiding a column means counting :nth-child and
         recounting the moment the pick column appears. */
      '<td data-col="worker_id">' + idHtml + '</td>' +
      '<td data-col="en_name"><div class="name-cell">' + personPhoto(w,'avatar-sm') + '<span style="font-weight:700">' + esc(w.en_name) + '</span>' + gradeBadge(w.grade) + '</div></td>' +
      '<td data-col="lo_name" class="col-lo">' + esc(w.lo_name) + '</td>' +
      '<td data-col="employer_code">' + empBadge(w.employer_code) + '</td>' +
      '<td data-col="group_supervisor">' + esc(w.group_supervisor) + '</td>' +
      '<td data-col="dob">' + esc(w.dob) + '</td>' +
      '<td data-col="age">' + (age || '--') + '</td>' +
      '<td data-col="blood"><span class="blood-chip">' + esc(w.blood || '--') + '</span></td>' +
      '<td data-col="passport_no" style="font-family:monospace;font-size:0.8rem">' + esc(w.passport_no) + '</td>' +
      '<td data-col="passport_expiry" class="' + ec + '">' + esc(w.passport_expiry) + '</td>' +
      '<td data-col="size">' + esc(w.size) + '</td>' +
      '<td data-col="actions">' +
        _selStar(w.uid) +
        '<button class="kebab" onclick="openRowMenu(\'' + w.uid + '\',event)" title="' + esc(t('col_actions')) + '">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>' +
        '</button>' +
      '</td>' +
    '</tr>';
  }).join('');
  playRowsIn(tbody);
}

// ── VIEW MODE (Table / KD Form / Photo cards) ─────────────────────
const VIEW_MODES = ['table', 'kdcard', 'photo'];
function _normViewMode(m) {
  if (m === 'cards' || m === 'idcard' || m === 'slide') return 'kdcard';   // legacy aliases
  return VIEW_MODES.includes(m) ? m : 'table';
}
function currentView()  { return _normViewMode(viewMode); }

function setViewMode(mode) {
  viewMode = _normViewMode(mode);
  localStorage.setItem('kd_view', viewMode);
  renderTable();
}

function applyViewMode() {
  const view      = currentView();
  const tableWrap = document.querySelector('.table-wrap');
  const cardsWrap = document.getElementById('cards-wrap');
  // Both card modes (KD form + photo) live in the same #cards-wrap container.
  if (tableWrap) tableWrap.style.display = view === 'table' ? '' : 'none';
  if (cardsWrap) cardsWrap.style.display = view === 'table' ? 'none' : 'block';
  // Bento tiles use `selected` (shared with every other picker in the app).
  [['view-table', 'table'], ['view-kdcard', 'kdcard'], ['view-photo', 'photo']].forEach(([id, mode]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('selected', view === mode);
    el.setAttribute('aria-checked', view === mode ? 'true' : 'false');
  });
}

// ── KD FORM GRID ──────────────────────────────────────────────────
function renderCards(g) {
  const grid = document.getElementById('cards-grid');
  if (!grid) return;
  g = g || DB.getGroup(activeGroupId);
  // The group summary (gender tally, assigned/arrivals) is identical on every
  // card — compute it ONCE and pass it in, instead of re-scanning all workers
  // inside _renderKdCard for each card (that was an O(n²) hot spot).
  const gc = _kdGenderCounts(g);
  grid.className = 'cards-grid kd-grid';
  grid.innerHTML = tableFiltered.map(w =>
    '<div class="idc-cell' + (isPicked(w.uid) ? ' picked' : '') + '" data-pick-row="' + esc(w.uid) + '"' +
      ' onclick="openView(\'' + esc(w.uid) + '\')">' +
      _pickBox(w.uid) +
      _selStar(w.uid) +
      _completenessChip(w) +
      _renderKdCard(w, g, false, gc, true) +
    '</div>'
  ).join('');
  _kdFitAll(grid);
  playRowsIn(grid);
}

// ── PHOTO CARD GRID (Apple bento, portrait) ───────────────────────
// A minimal browse card the user designed: full uploaded photo (not cropped),
// bold EN name, muted Lao name, a worker-ID pill, and a small status badge
// (grade + passport-expiry). Third view mode; the KD 16:10 form and every
// export path are untouched.
function renderPhotoCards(g) {
  const grid = document.getElementById('cards-grid');
  if (!grid) return;
  grid.className = 'cards-grid photo-grid';
  grid.innerHTML = tableFiltered.map(w =>
    '<div class="pcard' + (isPicked(w.uid) ? ' picked' : '') + '" data-pick-row="' + esc(w.uid) + '"' +
      ' onclick="openView(\'' + esc(w.uid) + '\')">' +
      _pickBox(w.uid) +
      _selStar(w.uid) +
      _renderPhotoCard(w) +
    '</div>'
  ).join('');
  playRowsIn(grid);
}

function _renderPhotoCard(w) {
  // Full photo, uncropped (object-fit: contain in CSS) so the whole scan shows.
  const photo = w.photo
    ? '<img src="' + esc(w.photo_thumb || w.photo) + '" alt="" loading="lazy" decoding="async">'
    : '<span class="pcard-noimg">' + esc(avatarInitials(w.en_name || '?')) + '</span>';

  const grade = _normGrade(w.grade);
  const gradeChip = grade
    ? '<span class="pcard-grade" style="background:' + (GRADE_COLORS[grade] || '#6b7280') + '">' + esc(grade) + '</span>'
    : '';

  // Passport-expiry status badge — only shown when it needs attention.
  const ec = expiryClass(w.passport_expiry);
  const expLabel = ec === 'expiry-expired' ? bi('ໝົດອາຍຸ','Expired','หมดอายุ','만료')
                 : ec === 'expiry-warn'    ? bi('ໃກ້ໝົດ','Expiring','ใกล้หมด','임박')
                 : '';
  const expChip = expLabel
    ? '<span class="pcard-exp ' + ec + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
        esc(expLabel) + '</span>'
    : '';

  const idPill = w.worker_id || w.employer_code || '';
  return '<div class="pcard-photo">' + photo + gradeChip + '</div>' +
    '<div class="pcard-name">' + esc(w.en_name || '—') + '</div>' +
    '<div class="pcard-lo">' + esc(w.lo_name || '') + '</div>' +
    '<div class="pcard-foot">' +
      (idPill ? '<span class="pcard-id">' + esc(idPill) + '</span>' : '') +
      expChip +
    '</div>';
}

// ── KD card: PowerPoint slide model ───────────────────────────────
// The card is a single immutable design surface, laid out at a fixed
// 1920×1200 (16:10) everywhere, and fitted to its container the way a slide
// show fits a slide to the projector: ONE transform: scale() on the whole
// surface, never a re-layout of anything inside it. `.kd-fit` is the box that
// takes part in page layout; `--kd-scale` on it drives the surface's transform
// (see the .kd-fit / .kd-card rules in main.css).
const KD_SURFACE_W = 1920, KD_SURFACE_H = 1200;

function _kdFit(fit) {
  // Used width, untransformed and WITH its fraction: getBoundingClientRect()
  // would be multiplied by any ancestor scale (e.g. a modal's pop-in) and
  // clientWidth rounds the fraction away — either one would leave the surface a
  // hair off its box, i.e. a visible seam or a clipped edge.
  const w = parseFloat(getComputedStyle(fit).width) || 0;
  if (!w) return;                       // not laid out yet (hidden / off-screen)
  const s = w / KD_SURFACE_W;
  if (fit._kdScale === s) return;
  fit._kdScale = s;
  fit.style.setProperty('--kd-scale', s);
}

let _kdRO = null;
// Measure (and keep measuring) every card under `root`. Safe to call repeatedly:
// re-observing an element is a no-op.
function _kdFitAll(root) {
  root = root || document;
  if (!root.querySelectorAll) return;
  if (!_kdRO && window.ResizeObserver)
    _kdRO = new ResizeObserver(es => es.forEach(e => _kdFit(e.target)));
  const fits = root.querySelectorAll('.kd-fit');
  fits.forEach(f => { _kdFit(f); if (_kdRO) _kdRO.observe(f); });
  // Grid cells use content-visibility, so the off-screen ones cannot be measured
  // yet. --kd-scale inherits, so publishing the first measured scale on the
  // container gives every not-yet-laid-out card the right value up front (all
  // cards in a grid share one column width) instead of a wrong default of 1.
  if (root.nodeType === 1 && fits.length) {
    for (const f of fits) if (f._kdScale) { root.style.setProperty('--kd-scale', f._kdScale); break; }
  }
}
// Backstop for size changes the observer can miss (entering/leaving fullscreen,
// browser zoom, a window resized while the tab sat in the background — where the
// whole rendering loop, ResizeObserver included, is frozen). Debounced with a
// timer rather than rAF for exactly that reason: rAF does not run in a hidden
// tab, so a rAF-based refit would be asleep precisely when it is needed.
// Two passes: one right after the change settles, one a beat later, because a
// resize can land mid-flight (grid columns re-flowing, a drawer still opening),
// and a scale measured against a half-settled box would stick until the next
// event. The second pass is a no-op when nothing moved — _kdFit() bails on an
// unchanged scale.
let _kdFitT = null, _kdFitT2 = null;
function _kdFitSoon() {
  clearTimeout(_kdFitT);  _kdFitT  = setTimeout(() => _kdFitAll(document), 60);
  clearTimeout(_kdFitT2); _kdFitT2 = setTimeout(() => _kdFitAll(document), 320);
}
window.addEventListener('resize', _kdFitSoon, { passive: true });
document.addEventListener('fullscreenchange', _kdFitSoon);
document.addEventListener('visibilitychange', () => { if (!document.hidden) _kdFitSoon(); });

// ── KD original-form card (brown layout) ──────────────────────────
function _kdGenderCounts(g) {
  let f = 0, m = 0;
  ((g && g.workers) || []).forEach(w => { if (w.sex === 'F') f++; else if (w.sex === 'M') m++; });
  return { f, m };
}
// `lazy` = defer off-screen photos (grid of many cards). Left OFF for the
// print/PNG/PDF/PPTX paths, which must have every image loaded up front.
function _renderKdCard(w, g, editable, gc, lazy, present) {
  const seq    = w.worker_id ? w.worker_id.split('-').pop() : '';
  const bloods = ['A', 'B', 'O', 'AB'];
  const bloodRow = bloods.map(b => '<span class="kd-blood' + (w.blood === b ? ' on' : '') + '">' + b + '</span>').join('');
  gc = gc || _kdGenderCounts(g);   // callers rendering a single card can omit it
  const assigned = (g && g.assigned != null && g.assigned !== '') ? g.assigned : 0;
  const arrivals = (g && g.arrivals != null && g.arrivals !== '') ? g.arrivals : 0;
  const cell = (label, sub, val) =>
    '<div class="kd-l"><span>' + label + '</span>' + (sub ? '<i>' + sub + '</i>' : '') + '</div>' +
    '<div class="kd-v">' + val + '</div>';
  // Grid of cards (lazy) uses the light thumbnail; the single detail/export card
  // keeps the full-resolution photo for a crisp print.
  const photoSrc = (lazy && w.photo_thumb) ? w.photo_thumb : w.photo;
  const photo = w.photo
    ? '<img src="' + esc(photoSrc) + '" alt=""' + (lazy ? ' loading="lazy" decoding="async"' : '') + '>'
    : '<span class="kd-noimg">' + esc(avatarInitials(w.en_name || '?')) + '</span>';
  // In the worker detail view (admin) the photo box is tap-to-edit: opens an
  // inline editor with upload + rotate, no need to switch to the Excel form.
  const photoCls  = 'kd-photo' + (editable ? ' editable' : '');
  const photoEdit = editable
    ? '<div class="kd-photo-edit">&#9998; ' + esc(t('photo_edit') || 'แก้ไขรูป') + '</div>'
    : '';
  const photoClick = editable
    ? ' onclick="event.stopPropagation(); openPhotoEditor(\'' + esc(w.uid) + '\')" title="' + esc(t('photo_edit') || 'แก้ไขรูป') + '"'
    : '';
  const genderBadge = w.sex === 'M'
    ? '<span class="kd-gender kd-gender-m">&#9794;</span>'
    : w.sex === 'F'
      ? '<span class="kd-gender kd-gender-f">&#9792;</span>'
      : '';
  // .kd-fit = layout box (scaled footprint) · .kd-card = the 1920×1200 surface.
  return '<div class="kd-fit"><div class="kd-card' + (present ? ' kd-present' : '') + '">' +
    '<div class="kd-top">' +
      '<span class="kd-code">' + esc(w.worker_id || w.employer_code || '—') + '</span>' +
      '<div class="kd-top-mid">' + genderBadge + '<span class="kd-bloods">' + bloodRow + '</span></div>' +
    '</div>' +
    // Present mode puts the worker's ID code in the green band (the now-duplicate
    // code in the top strip is blanked — space kept — via .kd-present CSS).
    '<div class="kd-head"><span>' + esc(present ? (w.worker_id || w.employer_code || '—') : (w.group_supervisor || '—')) + '</span><span>' + esc(seq || '') + '</span></div>' +
    '<div class="kd-body">' +
      '<div class="kd-tbl">' +
        // Field labels follow the SELECTED app language (bi → en/th/lo/ko), so
        // Present / list / detail all read in the user's language instead of the
        // old fixed English+Lao. The Korean summary block below stays fixed (it's
        // part of the official KD sheet). `Kg ; Cm` stays as a unit hint sub.
        cell(esc(bi('ຊື່','Name','ชื่อ','이름')), '', esc(w.en_name || '--')) +
        cell(esc(bi('ຊື່ ນາມສະກຸນ','Full name','ชื่อ-นามสกุล','성명')), '', esc(w.lo_name || '--')) +
        cell(esc(bi('ວັນເດືອນປີເກີດ','Date of birth','วันเกิด','생년월일')), '', esc(w.dob || '--')) +
        cell(esc(bi('ບ້ານ','Village','หมู่บ้าน','마을')), '', esc(w.village || '--')) +
        cell(esc(bi('ນ້ຳໜັກ ; ສ່ວນສູງ','Weight ; Height','น้ำหนัก ; ส่วนสูง','체중 ; 신장')), 'Kg ; Cm', (w.weight ? w.weight + 'Kg' : '--') + ' ; ' + (w.height ? w.height + 'Cm' : '--')) +
        cell(esc(bi('ຂະໜາດ','Size','ขนาด','사이즈')), '', esc(w.size || '--')) +
        cell(esc(bi('ກຸ່ມເລືອດ','Blood','กรุ๊ปเลือด','혈액형')), '', esc(w.blood || '--')) +
        cell(esc(bi('ເລກໜັງສືຜ່ານແດນ','Passport No','เลขพาสปอร์ต','여권번호')), '', '<span style="font-family:monospace">' + esc(w.passport_no || '--') + '</span>') +
        cell(esc(bi('ວັນໝົດອາຍຸ','Date of expiry','วันหมดอายุ','만료일')), '', '<span class="' + expiryClass(w.passport_expiry) + '">' + esc(w.passport_expiry || '--') + '</span>') +
        cell(esc(bi('ໂທລະສັບ','Tel','โทร','전화')), '', esc(w.tel || '--')) +
      '</div>' +
      '<div class="kd-right">' +
        '<div class="' + photoCls + '"' + photoClick + '>' + photo + (w.couple === 'yes' ? '<span class="kd-couple">부부</span>' : '') + photoEdit + '</div>' +
        '<div class="kd-sum">' +
          '<div class="kd-sum-h">' + esc(t('kd_summary')) + '</div>' +
          '<div class="kd-sum-r"><span>여성 (ຍ)</span><b>' + gc.f + '</b></div>' +
          '<div class="kd-sum-r"><span>남성 (ຊ)</span><b>' + gc.m + '</b></div>' +
          '<div class="kd-sum-r"><span>배정 · ' + esc(t('kd_assigned')) + '</span><b>' + assigned + '</b></div>' +
          '<div class="kd-sum-r"><span>입국 · ' + esc(t('kd_arrivals')) + '</span><b>' + arrivals + '</b></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div></div>';
}

// ── Contextual 3-dot action menu (View / Edit / Delete) ───────────
let rowMenuUid = null;
function openRowMenu(uid, ev) {
  if (ev) ev.stopPropagation();
  _ensureGroupFor(uid);   // resolve owning group (global search / overview)
  rowMenuUid = uid;
  const menu = document.getElementById('row-menu');
  if (!menu) return;
  const ic = {
    view: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
    del:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
  };
  menu.innerHTML =
    '<button onclick="rowMenuAct(\'view\')">' + ic.view + '<span>' + t('act_view_full') + '</span></button>' +
    (isAdmin() ?
      '<button onclick="rowMenuAct(\'edit\')">' + ic.edit + '<span>' + t('act_edit_full') + '</span></button>' +
      '<button class="danger" onclick="rowMenuAct(\'del\')">' + ic.del + '<span>' + t('act_del_full') + '</span></button>'
      : '');

  // Position near the button (flip if near screen edges)
  const btn = ev ? ev.currentTarget : null;
  menu.classList.add('open');
  if (btn) {
    const r = btn.getBoundingClientRect();
    const mw = menu.offsetWidth || 190, mh = menu.offsetHeight || 130;
    let left = r.right - mw;
    let top  = r.bottom + 6;
    if (left < 8) left = 8;
    if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;
    menu.style.left = left + 'px';
    menu.style.top  = Math.max(8, top) + 'px';
  }
}
function rowMenuAct(action) {
  const uid = rowMenuUid;
  closeRowMenu();
  if (action === 'view') openView(uid);
  else if (action === 'edit') openWorkerForm(uid);
  else if (action === 'del') confirmDeleteWorker(uid);
}
function closeRowMenu() { document.getElementById('row-menu')?.classList.remove('open'); }
document.addEventListener('click', e => {
  const m = document.getElementById('row-menu');
  if (m && m.classList.contains('open') && !m.contains(e.target) && !e.target.closest('.kebab')) closeRowMenu();
});
window.addEventListener('resize', closeRowMenu);


// ── ID BADGE CARD builder ─────────────────────────────────────────
// `editable` (default = admin in the detail drawer) renders the tap-to-change
// photo overlay + hidden file input. Pass false for grid/slide views so we
// don't create duplicate `photo-edit-input` ids across many cards.
function _renderBadgeCard(w, g, editable, locked) {
  if (editable === undefined) editable = isAdmin();
  const idSeq = w.worker_id ? '#' + w.worker_id.split('-').pop() : '';

  const photoHtml = editable
    ? '<div class="idc-photo editable" onclick="_triggerPhotoEdit(\'' + esc(w.uid) + '\')" title="Tap to change photo">' +
        personPhoto(w, 'avatar-xl') +
        '<div class="idc-photo-edit">&#9998;</div>' +
      '</div>' +
      '<input type="file" id="photo-edit-input" accept="image/*" style="display:none" onchange="_handlePhotoEdit(this,\'' + esc(w.uid) + '\')">'
    : '<div class="idc-photo">' + personPhoto(w, 'avatar-xl') + '</div>';

  // Employer & supervisor intentionally omitted from the card (per spec).
  const tags = [];
  if (g && g.name)     tags.push('<span class="idc-tag">' + esc(g.name) + '</span>');
  if (w.couple === 'yes') tags.push('<span class="idc-tag idc-tag-couple">부부</span>');

  const visual =
    '<div class="idc-visual">' +
      '<svg class="idc-swoosh" viewBox="0 0 300 168" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M300,0 C258,0 218,24 184,70 C140,130 128,160 68,168 L300,168 Z" fill="#1a2235"/>' +
        '<path d="M300,0 C282,8 272,38 278,82 C283,118 294,148 300,168 L300,0 Z" fill="rgba(26,34,53,0.35)"/>' +
      '</svg>' +
      (w.grade ? '<div class="idc-grade-flag">GRADE ' + esc(w.grade) + '</div>' : '') +
      (idSeq   ? '<div class="idc-seq">' + esc(idSeq) + '</div>' : '') +
      photoHtml +
    '</div>';

  // ── Locked "paper" format (ID Card + Slide modes) ──
  // Every slot is always rendered so the card keeps the SAME fixed dimensions
  // whether or not the field has data. Empty fields show a placeholder dash.
  if (locked) {
    const dash = '<span class="idc-f-empty">—</span>';
    const fv   = v => (v || v === 0) && String(v).trim() !== '' ? esc(v) : dash;
    const age  = calcAge(w.dob);
    const ec   = expiryClass(w.passport_expiry);
    const field = (label, val) =>
      '<div class="idc-field"><span class="idc-f-label">' + esc(label) + '</span>' +
      '<span class="idc-f-val">' + val + '</span></div>';
    const fields =
      field(t('col_passport'), fv(w.passport_no)) +
      field(t('col_expiry'),   w.passport_expiry ? '<span class="' + ec + '">' + esc(w.passport_expiry) + '</span>' : dash) +
      field(t('col_dob'),      fv(w.dob)) +
      field(t('col_age'),      age ? age : dash) +
      field(t('col_blood'),    fv(w.blood)) +
      field(t('col_size'),     fv(w.size)) +
      field(t('fm_sex'),       fv(w.sex)) +
      field(t('fm_tel'),       fv(w.tel));
    return '<div class="id-badge-card locked">' +
      visual +
      '<div class="idc-body">' +
        '<div class="idc-name">' + esc(w.en_name || '--') + '</div>' +
        '<div class="idc-lo">' + (w.lo_name ? esc(w.lo_name) : '&nbsp;') + '</div>' +
        '<div class="idc-tags">' + tags.join('') + '</div>' +
      '</div>' +
      '<div class="idc-divider"></div>' +
      '<div class="idc-fields">' + fields + '</div>' +
      '<div class="idc-foot">' +
        '<span class="idc-foot-id">' + esc(w.worker_id || '--') + '</span>' +
        '<div class="idc-foot-logo">KD</div>' +
      '</div>' +
    '</div>';
  }

  // ── Compact badge (detail-drawer header) ──
  return '<div class="id-badge-card">' +
    visual +
    '<div class="idc-body">' +
      '<div class="idc-name">' + esc(w.en_name || '--') + '</div>' +
      (w.lo_name ? '<div class="idc-lo">' + esc(w.lo_name) + '</div>' : '') +
      (tags.length ? '<div class="idc-tags">' + tags.join('') + '</div>' : '') +
    '</div>' +
    '<div class="idc-divider"></div>' +
    '<div class="idc-foot">' +
      '<span class="idc-foot-id">' + esc(w.worker_id || '--') + '</span>' +
      '<div class="idc-foot-logo">KD</div>' +
    '</div>' +
  '</div>';
}

// ── Shared option lists ───────────────────────────────────────────
// One source of truth for the blood / size / nationality pickers so the worker
// form, the table filter and the detail-view editor never drift apart.
const _BLOOD_TYPES = ['A','A+','A-','B','B+','B-','AB','AB+','AB-','O','O+','O-'];  // bare ABO kept for legacy records
const _SHIRT_SIZES = ['XS','S','M','L','XL','XXL','XXXL'];
// [code, English name] — 3-letter codes match the passport-MRZ output the scanner writes.
const _NATIONALITIES = [
  ['LAO','Laos'],['THA','Thailand'],['VNM','Vietnam'],['KHM','Cambodia'],
  ['MMR','Myanmar'],['CHN','China'],['KOR','South Korea'],['IDN','Indonesia'],
  ['PHL','Philippines'],['IND','India'],['MYS','Malaysia'],['NPL','Nepal'],
  ['BGD','Bangladesh'],['LKA','Sri Lanka'],['PAK','Pakistan'],['MNG','Mongolia'],
  ['JPN','Japan'],['SGP','Singapore'],['USA','United States'],['GBR','United Kingdom'],
];
// Build a [{v,t}] list, guaranteeing the current stored value stays selectable
// even if it isn't one of the standard options (never blank out old data).
function _optsWithCurrent(values, cur) {
  const opts = [{ v:'', t:'--' }].concat(values.map(v => ({ v, t: v })));
  if (cur && !values.includes(String(cur))) opts.push({ v: String(cur), t: String(cur) });
  return opts;
}
function _natOpts() { return _NATIONALITIES.map(([v, t]) => ({ v, t })); }
// la_city / kr_city hold a CODE ('VTE'), not a name — the dictionary turns it
// back into something readable. A code that has since been removed from the
// dictionary still shows (and, in edit mode, still saves) as itself: a record
// must never lose a value because a list was edited around it.
function _cityLabel(cities, country, code) {
  if (!code) return '';
  const hit = ((cities && cities[country]) || []).find(c => c.code === code);
  return hit ? hit.name + ' (' + hit.code + ')' : String(code);
}
function _cityOpts(cities, country, cur) {
  const list = (cities && cities[country]) || [];
  const opts = [{ v: '', t: '--' }].concat(list.map(c => ({ v: c.code, t: c.name + ' (' + c.code + ')' })));
  if (cur && !list.some(c => c.code === cur)) opts.push({ v: String(cur), t: String(cur) });
  return opts;
}
// Fill the worker-form nationality <datalist> (suggestions; still free-typeable).
function _fillNatDatalist() {
  const dl = document.getElementById('nat-list');
  if (dl) dl.innerHTML = _NATIONALITIES.map(([v, t]) => '<option value="' + esc(v) + '">' + esc(t) + '</option>').join('');
}
// Set a <select> to a value, appending a one-off <option> first if that value
// isn't already listed — so editing a record with a legacy value never drops it.
function _ensureSelectValue(id, val) {
  const sel = document.getElementById(id);
  if (!sel) return;
  sel.querySelectorAll('option[data-oneoff]').forEach(o => o.remove());   // drop a previous injection
  val = (val == null) ? '' : String(val);
  if (val && ![...sel.options].some(o => o.value === val)) {
    sel.insertAdjacentHTML('beforeend', '<option data-oneoff value="' + esc(val) + '">' + esc(val) + '</option>');
  }
  sel.value = val;
}

// ── Detail drawer: inline edit + export + zoom ────────────────────
let detailEditMode = false;

// Editable value cell: in edit mode → input/select bound to data-ef; else view HTML.
function _ev(w, field, viewHtml, type, opts) {
  if (!detailEditMode) return viewHtml;
  const cur = (w[field] == null) ? '' : w[field];
  if (type === 'select') {
    return '<select class="vm-edit-in" data-ef="' + field + '">' +
      opts.map(o => '<option value="' + esc(o.v) + '"' + (String(cur) === String(o.v) ? ' selected' : '') + '>' + esc(o.t) + '</option>').join('') +
      '</select>';
  }
  if (type === 'datalist') {
    // Dropdown suggestions + free text — any value (incl. scanned codes) is kept.
    const listId = 'ev-list-' + field;
    return '<input class="vm-edit-in" data-ef="' + field + '" list="' + listId + '" value="' + esc(cur) + '" autocomplete="off">' +
      '<datalist id="' + listId + '">' +
      (opts || []).map(o => '<option value="' + esc(o.v) + '">' + esc(o.t || o.v) + '</option>').join('') +
      '</datalist>';
  }
  return '<input class="vm-edit-in" data-ef="' + field + '" value="' + esc(cur) + '">';
}

// Address value cell (province/district/village): view text, or in edit mode a
// cascading combobox (dictionary list + free text). The custom .addr-combo popup
// is used (same as the worker form) rather than a native datalist, so the list
// can filter live by the parent level. _initDetailEdit() wires it up post-render.
function _evAddr(w, col) {
  const cur = (w[col] == null) ? '' : w[col];
  if (!detailEditMode) return esc(cur || '--');
  return '<div class="addr-combo">' +
    '<input class="addr-input vm-edit-in" id="evloc-' + col + '" data-ef="' + col + '" autocomplete="off" value="' + esc(cur) + '">' +
    '<div class="addr-combo-list" id="evloc-list-' + col + '" style="display:none"></div>' +
  '</div>';
}

/**
 * The couple tile. Rendered from `spouse_uid`, never from the `couple` flag —
 * the flag only says that somebody is married, which is all the KD card needs
 * and all it ever knew.
 *
 * Nothing here is a `data-ef` field: the pair has two sides and is written by
 * the server through repo.setSpouse, so it must not ride along in the generic
 * "collect every data-ef and PATCH it" save. The buttons act immediately.
 */
function _coupleSection(w, sec, row) {
  const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.2l7.8-7.7 1-1.1a5.5 5.5 0 0 0 0-7.8z"/></svg>';
  const sp   = spouseOf(w);
  const may  = isAdmin() && !detailEditMode;

  let partner;
  if (sp) {
    partner = '<a class="vd-link" onclick="event.stopPropagation();openView(\'' + esc(sp.uid) + '\')">' +
                esc(sp.en_name || sp.worker_id || sp.uid) + '</a>';
  } else if (w.spouse_uid) {
    // Linked to somebody the bootstrap did not carry — they are in the trash.
    // Saying so beats an empty cell that looks like the link was lost.
    partner = '<span class="vd-inherited">' + esc(bi('ຢູ່ໃນຖັງຂີ້ເຫຍື້ອ', 'in the trash', 'อยู่ในถังขยะ', '휴지통에 있음')) + '</span>';
  } else {
    partner = '--';
  }

  const btn = (fn, label, cls) =>
    '<button class="vd-mini' + (cls ? ' ' + cls : '') + '" onclick="event.stopPropagation();' + fn + '">' + esc(label) + '</button>';
  const acts = [];
  if (may) {
    acts.push(btn('openSpousePicker(\'' + esc(w.uid) + '\')',
      sp ? bi('ປ່ຽນ', 'Change', 'เปลี่ยน', '변경') : bi('ຈັບຄູ່', 'Pair', 'จับคู่', '연결')));
    if (w.spouse_uid) acts.push(btn('unpairSpouse(\'' + esc(w.uid) + '\')',
      bi('ຍົກເລີກ', 'Unpair', 'ยกเลิก', '해제'), 'vd-mini-ghost'));
  }

  let rows = row(bi('ຄູ່', 'Partner', 'คู่', '배우자'), 'Spouse', partner);
  if (acts.length) rows += row(bi('ຈັດການ', 'Manage', 'จัดการ', '관리'), '&nbsp;',
    '<span class="vd-acts">' + acts.join('') + '</span>');

  /* Answer 4: a couple MAY share one photograph — they are photographed
   * together — but it is never forced, so this is an action, not a rule. The
   * shared file is safe to delete either record afterwards: repo._releasePhoto
   * only unlinks a photo once nobody is left pointing at it. */
  if (sp) {
    const shared = !!w.photo && w.photo === sp.photo;
    rows += row(bi('ຮູບຮ່ວມກັນ', 'Shared photo', 'ใช้รูปร่วมกัน', '사진 공유'), 'Photo',
      shared
        ? '<span class="vd-ok">&#10003; ' + esc(bi('ໃຊ້ຮູບດຽວກັນ', 'same photo', 'รูปเดียวกัน', '같은 사진')) + '</span>'
        : (may && sp.photo
            ? '<span class="vd-acts">' + btn('useSpousePhoto(\'' + esc(w.uid) + '\')',
                bi('ໃຊ້ຮູບຂອງຄູ່', "Use partner's", 'ใช้รูปของคู่', '배우자 사진 사용')) + '</span>'
            : '--'));
  }

  return sec(icon, bi('ຄູ່ຜົວເມຍ', 'Couple', 'คู่สามีภรรยา', '부부'), 'Pair', rows);
}

// Builds the Info-pane HTML (two columns). Same fixed set of rows always renders
// so the popup never changes size with the amount of data.
function _renderDetailBody(w, g) {
  const ed  = detailEditMode;
  // One clone for both city blocks — getCities() deep-copies the dictionary.
  const cities = DB.getCities() || {};
  // Age: use manually stored value if present, else calculate from DOB
  const age = (w.age != null && w.age !== '') ? w.age : calcAge(w.dob);
  const visaLabels = { not_started:'ຍັງບໍ່ເລີ່ມ', applied:'ຍື່ນຂໍແລ້ວ', approved:'ອະນຸມັດ ✓', rejected:'ຖືກປະຕິເສດ ✗' };
  const warn = !ed && expiryClass(w.passport_expiry) !== 'expiry-ok';
  const row = (label, sub, val) => {
    // A very long value (e.g. a long surname) is clamped to one line in the
    // bento view so the row height — and the whole page — stays locked and never
    // shifts between workers. The full text is exposed on hover via title. `val`
    // is already escaped HTML, so the tag-stripped text is attribute-safe as-is.
    const ttl = String(val).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return '<div class="vd-row">' +
      '<span class="vd-lbl">' + label + (sub ? '<span class="vd-sub">' + sub + '</span>' : '') + '</span>' +
      '<span class="vd-val"' + (ttl && ttl !== '--' ? ' title="' + ttl + '"' : '') + '>' + val + '</span>' +
    '</div>';
  };
  const sec = (icon, lo, en, rows, cls) =>
    '<div class="vd-section' + (cls ? ' ' + cls : '') + '">' +
      '<div class="vd-section-head">' +
        '<span class="vd-sec-icon">' + icon + '</span>' +
        '<span class="vd-sec-title">' + lo + '</span>' +
        '<span class="vd-sec-sub">/ ' + en + '</span>' +
      '</div>' +
      '<div class="vd-rows">' + rows + '</div>' +
    '</div>';

  const sexOpts  = [{v:'',t:'--'},{v:'M',t:t('fm_sex_m')},{v:'F',t:t('fm_sex_f')}];
  const handOpts = [{v:'',t:'--'},{v:'R',t:'R (Right)'},{v:'L',t:'L (Left)'}];
  const bloodOpts= _optsWithCurrent(_BLOOD_TYPES, w.blood);
  const sizeOpts = _optsWithCurrent(_SHIRT_SIZES, w.size);

  const tableHtml =
    '<div class="vd-sections">' +
      (warn ? '<div class="vd-warn">&#9888; ' + t('vc_passport_warn', { date: w.passport_expiry }) + '</div>' : '') +

      sec('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>', 'ຂໍ້ມູນລະບຸຕົວຕົນ', 'Identity',
        row('Worker ID', 'ລະຫັດ', _ev(w,'worker_id', esc(w.worker_id||'--'), 'text')) +
        row(t('vc_name'), 'EN Name', _ev(w,'en_name', esc(w.en_name||'--'), 'text')) +
        row('ຊື່ ນາມສະກຸນ', 'LO Name', _ev(w,'lo_name', esc(w.lo_name||'--'), 'text')) +
        row(t('vc_dob'), 'ວັນເດືອນປີ', _ev(w,'dob', esc(w.dob||'--'), 'text')) +
        row(t('vc_age'), 'ອາຍຸ', _ev(w,'age', age ? age + ' yrs' : '--', 'text')) +
        row(t('vc_nationality'), 'ສັນຊາດ', _ev(w,'nationality', esc(w.nationality||'--'), 'datalist', _natOpts())) +
        row(t('vc_sex'), 'ເພດ', ed ? _ev(w,'sex','','select',sexOpts) : (w.sex==='M'?'♂ '+t('fm_sex_m'):w.sex==='F'?'♀ '+t('fm_sex_f'):'--')),
        'vd-wide'
      ) +

      // Home and destination were one "Address" block, which read as one place.
      // They are two countries and two purposes — where somebody is from, and
      // where they are going — so they are two blocks, side by side.
      sec('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
        bi('ທີ່ຢູ່ ລາວ', 'Laos', 'ที่อยู่ลาว', '라오스'), 'Home',
        row('ແຂວງ', 'Province', _evAddr(w,'province')) +
        row('ເມືອງ', 'District', _evAddr(w,'district')) +
        row('ບ້ານ',  'Village',  _evAddr(w,'village')) +
        row(bi('ເມືອງຕົ້ນທາງ', 'Origin city', 'เมืองต้นทาง', '출발 도시'), 'ຕົ້ນທາງ',
          ed ? _ev(w,'la_city','','select', _cityOpts(cities,'la',w.la_city))
             : esc(_cityLabel(cities,'la',w.la_city) || '--'))
      ) +

      sec('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3.5S19 3 17.5 4.5L14 8 5.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 4.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>',
        bi('ເກົາຫຼີ', 'Korea', 'เกาหลี', '한국'), 'Assignment',
        row(bi('ເມືອງປາຍທາງ', 'Destination', 'เมืองปลายทาง', '도착 도시'), 'ປາຍທາງ',
          ed ? _ev(w,'kr_city','','select', _cityOpts(cities,'kr',w.kr_city))
             : (_cityLabel(cities,'kr',w.kr_city)
                 ? esc(_cityLabel(cities,'kr',w.kr_city))
                 // No city of their own → the group's route, marked as borrowed
                 // rather than printed as if the worker carried it.
                 : (_routeDest(g) ? '<span class="vd-inherited">' + esc(_routeDest(g)) + '</span>' : '--'))) +
        row(t('fm_employer_code'), 'Employer',   _ev(w,'employer_code',    esc(w.employer_code||'--'),    'text')) +
        row(t('fm_supervisor'),    'Supervisor', _ev(w,'group_supervisor', esc(w.group_supervisor||'--'), 'text'))
      ) +

      sec('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>', 'ຂໍ້ມູນຮ່າງກາຍ', 'Physical',
        row(t('vc_weight_height'), 'Kg / Cm', ed
          ? '<div class="vd-split">' + _ev(w,'weight','','text') + _ev(w,'height','','text') + '</div>'
          : '<div class="vd-split"><span>'+(w.weight?w.weight+' Kg':'--')+'</span><span>'+(w.height?w.height+' Cm':'--')+'</span></div>') +
        row(t('vc_size'),  'ຂະໜາດ',   ed ? _ev(w,'size','','select',sizeOpts)  : esc(w.size||'--')) +
        row(t('vc_hand'),  'ຊ້າຍ/ຂວາ', ed ? _ev(w,'hand','','select',handOpts)  : (w.hand==='R'?'R (Right)':w.hand==='L'?'L (Left)':'--')) +
        row(t('vc_blood'), 'ກຸ່ມເລືອດ', ed ? _ev(w,'blood','','select',bloodOpts) : esc(w.blood||'--'))
      ) +

      sec('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>', 'ເອກະສານເດີນທາງ', 'Passport',
        row(t('vc_passport'), 'ເລກທີ',   _ev(w,'passport_no', '<span style="font-family:monospace;letter-spacing:1px">'+esc(w.passport_no||'--')+'</span>', 'text')) +
        row(t('vc_issue'),   'ວັນທີອອກ', _ev(w,'passport_issue', esc(w.passport_issue||'--'), 'text')) +
        row(t('vc_expiry'),  'ໝົດອາຍຸ',  ed ? _ev(w,'passport_expiry','','text') : '<span class="'+expiryClass(w.passport_expiry)+'">'+esc(w.passport_expiry||'--')+'</span>')
      ) +

      sec('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>', 'ຕິດຕໍ່', 'Contact',
        row(t('vc_tel'),  'ໂທຫຼັກ',   _ev(w,'tel',     esc(w.tel||'--'),     'text')) +
        row('Emergency', 'ໂທສຸກເສີນ', _ev(w,'emg_tel', esc(w.emg_tel||'--'), 'text'))
      ) +

      _coupleSection(w, sec, row) +

    '</div>';

  // BOTH view and edit use the SAME full-page BENTO (redesign v6): a hero photo +
  // progress card on the left, the data as rounded tiles on the right. Edit mode
  // just swaps each tile value for an input (handled inside `tableHtml` via _ev),
  // so the layout never changes between viewing and editing — same page, less
  // confusing. In edit mode the hero name/ID mirror what you type (wired by
  // _initDetailEdit); the photo stays tap-to-edit.
  const photoAttr = isAdmin() ? ' onclick="event.stopPropagation();openPhotoEditor(\'' + esc(w.uid) + '\')"' : '';
  const editCls   = isAdmin() ? ' vbp-editable' : '';
  const editHint  = isAdmin()
    ? '<div class="vbp-edit-hint">&#9998; ' + esc(t('photo_edit') || 'แก้ไขรูป') + '</div>' : '';
  const photoImg  = w.photo
    ? '<img src="' + esc(w.photo) + '" alt="">'
    : '<span class="vbp-initials">' + esc(avatarInitials(w.en_name || '?')) + '</span>';

  const leftCol =
    '<div class="bento-card vbp-card' + editCls + '"' + photoAttr + '>' +
      '<div class="vbp-photo">' + photoImg + editHint + '</div>' +
      '<div class="vbp-name-en" id="vbp-live-en">' + esc(w.en_name || '—') + '</div>' +
      // Always render the Lao-name line (reserved even when empty) and keep the
      // ID in its own fixed slot, so a worker with no Lao name doesn't shift the
      // block up — every card lines up identically.
      '<div class="vbp-name-lo" id="vbp-live-lo">' + esc(w.lo_name || '') + '</div>' +
      '<div class="vbp-id-slot" id="vbp-live-id">' + (w.worker_id ? '<span class="vbp-id">' + esc(w.worker_id) + '</span>' : '') + '</div>' +
    '</div>' +
    '<div class="bento-card vbp-progress">' +
      '<div class="vbp-prog-head">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>' +
        '<span>' + bi('ຄວາມຄືບໜ້າ', 'Progress', 'ความคืบหน้า', '진행률') + '</span>' +
      '</div>' +
      _completenessBox(w) +
    '</div>';

  return '<div class="vm-bento-page' + (ed ? ' editing' : '') + '">' +
    '<aside class="vm-bento-left">' + leftCol + '</aside>' +
    '<div class="vm-bento-right">' + tableHtml + '</div>' +
  '</div>';
}

// After the edit body is painted: turn province/district/village into cascading
// comboboxes (dictionary + free text), and mirror the name/ID fields into the
// left hero card as the user types. No-op unless we're in edit mode.
function _initDetailEdit() {
  if (!detailEditMode) return;
  ['province', 'district', 'village'].forEach(col => {
    if (document.getElementById('evloc-' + col))
      initAddrCombobox('evloc-' + col, 'evloc-list-' + col, () => _evAddrItems(col));
  });
  const mirror = {
    en_name:   el => { const t = document.getElementById('vbp-live-en'); if (t) t.textContent = el.value.trim() || '—'; },
    lo_name:   el => { const t = document.getElementById('vbp-live-lo'); if (t) t.textContent = el.value.trim(); },
    worker_id: el => { const t = document.getElementById('vbp-live-id'); if (t) t.innerHTML = el.value.trim() ? '<span class="vbp-id">' + esc(el.value.trim()) + '</span>' : ''; },
  };
  Object.keys(mirror).forEach(ef => {
    const inp = document.querySelector('#vm-content [data-ef="' + ef + '"]');
    if (inp) inp.addEventListener('input', () => mirror[ef](inp));
  });
}

// Options for a detail-edit address combobox — cascades from the sibling value.
// Prefers the seeded Location Dictionary (English canonical value, label in the
// current language); merges in any spelling already used by other workers; and
// falls back to the province list / used values when the dictionary is off.
function _evAddrItems(col) {
  const ld  = DB.getLocDict();
  const dyn = _collectAddrField(col);
  const dedupePush = (opts, seen, v, label) => {
    const k = String(v || '').trim().toLowerCase();
    if (v && !seen.has(k)) { seen.add(k); opts.push({ value: v, label: label || v }); }
  };
  if (ld && ld.levels && ld.levels.length) {
    const i = ld.levels.findIndex(lv => lv.col === col);
    if (i >= 0 && _locLevelHasItems(ld, ld.levels[i].id)) {
      const lv = ld.levels[i];
      let items = ld.items.filter(it => it.levelId === lv.id);
      if (i > 0) {                                    // cascade: filter by the parent's value
        const pcol = ld.levels[i - 1].col;
        const pval = (document.getElementById('evloc-' + pcol) || {}).value || '';
        const pid  = _locIdForName(ld, ld.levels[i - 1].id, pval);
        if (pid) items = items.filter(it => it.parentId === pid);
        else if (pval.trim()) items = [];             // parent typed but unknown → child is free text
      }
      items = items.slice().sort((a, b) => a.order - b.order);
      const opts = [], seen = new Set();
      items.forEach(it => dedupePush(opts, seen, _locEnName(it), _locName(it) + (it.code ? ' (' + it.code + ')' : '')));
      dyn.forEach(v => dedupePush(opts, seen, v));
      return opts;
    }
  }
  // Dictionary off / level empty → predefined province list, else used values.
  if (col === 'province') {
    const opts = [], seen = new Set();
    LA_PROVINCES.forEach(p => dedupePush(opts, seen, p.en, p.lo + ' — ' + p.en));
    dyn.forEach(v => dedupePush(opts, seen, v));
    return opts;
  }
  return dyn.map(v => ({ value: v, label: v }));
}

// Resolve a dictionary item id from a stored place name (English canonical, but
// tolerate any-language / case / spacing variants that exist in old records).
function _locIdForName(ld, levelId, name) {
  if (!name || !name.trim()) return null;
  const items = ld.items.filter(it => it.levelId === levelId);
  const norm  = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const target = norm(name);
  const m = items.find(it => _locEnName(it) === name)
         || items.find(it => [it.names.en, it.names.lo, it.names.th, it.names.ko].some(n => n && norm(n) === target));
  return m ? m.id : null;
}

function _renderDetailTopbar(w, uid) {
  const el = document.getElementById('vm-topbar-actions'); if (!el) return;
  // Real shape icons (inline SVG) instead of text glyphs, per redesign. Nav
  // arrows + zoom stay icon-only (with tooltips); labelled actions pair the icon
  // with its text.
  const svg = inner => '<svg class="vm-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  const ICON = {
    prev:   '<polyline points="15 18 9 12 15 6"/>',
    next:   '<polyline points="9 18 15 12 9 6"/>',
    star:   '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    zoom:   '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
    export: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    edit:   '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    save:   '<polyline points="20 6 9 17 4 12"/>',
    cancel: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  };
  ICON.more = '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>';
  const admin = isAdmin();
  let h = '';

  // ── Main bar: Export + Edit / Save·Cancel ──
  h += '<button class="mb-btn" onclick="openExportDialog(\'worker\',\''+esc(uid)+'\')" title="'+esc(bi('ສົ່ງອອກ','Export','ส่งออก','내보내기'))+'">'+svg(ICON.export)+'<span>'+esc(bi('ສົ່ງອອກ','Export','ส่งออก','내보내기'))+'</span></button>';
  if (admin) {
    if (detailEditMode) {
      h += '<button class="mb-btn" onclick="cancelDetailEdit(\''+esc(uid)+'\')">'+svg(ICON.cancel)+'<span>'+esc(t('fm_cancel'))+'</span></button>';
      h += '<button class="mb-btn mb-btn-primary" onclick="saveDetailEdit(\''+esc(uid)+'\')">'+svg(ICON.save)+'<span>'+esc(t('vd_save'))+'</span></button>';
    } else {
      h += '<button class="mb-btn mb-btn-primary" onclick="toggleDetailEdit(\''+esc(uid)+'\')">'+svg(ICON.edit)+'<span>'+esc(t('act_edit'))+'</span></button>';
    }
  }

  // ── More (⋯) menu: prev/next + counter, select, present ──
  const ni = _navUids.indexOf(uid);
  const hasNav = _navUids.length > 1 && ni >= 0;
  const on = admin && isSelected(uid);
  let menu = '';
  if (hasNav) {
    const prevDis = ni <= 0 ? ' disabled' : '';
    const nextDis = ni >= _navUids.length - 1 ? ' disabled' : '';
    menu += '<button class="mb-menu-item" onclick="_navWorker(-1)"'+prevDis+'>'+svg(ICON.prev)+'<span>'+esc(bi('ກ່ອນໜ້າ','Previous','ก่อนหน้า','이전'))+'</span></button>';
    menu += '<button class="mb-menu-item" onclick="_navWorker(1)"'+nextDis+'>'+svg(ICON.next)+'<span>'+esc(bi('ຕໍ່ໄປ','Next','ถัดไป','다음'))+'</span><span class="mb-menu-count">'+(ni+1)+' / '+_navUids.length+'</span></button>';
    menu += '<div class="mb-menu-sep"></div>';
  }
  if (admin) {
    menu += '<button class="mb-menu-item'+(on?' on':'')+'" onclick="_detailToggleSelect(\''+esc(uid)+'\')">'+svg(ICON.star)+'<span>'+esc(on?bi('ເລືອກແລ້ວ','Selected','เลือกแล้ว','선택됨'):bi('ຄັດເລືອກ','Select','คัดเลือก','선택'))+'</span></button>';
  }
  menu += '<button class="mb-menu-item" onclick="_closeMoreMenu();zoomCard(\''+esc(uid)+'\')">'+svg(ICON.zoom)+'<span>'+esc(bi('ເຕັມຈໍ','Present','เต็มจอ','전체화면'))+'</span></button>';
  h += '<div class="mb-more">' +
         '<button class="mb-btn mb-icon" onclick="_toggleMoreMenu(event)" title="'+esc(bi('ເພີ່ມເຕີມ','More','เพิ่มเติม','더보기'))+'">'+svg(ICON.more)+'</button>' +
         '<div class="mb-menu" id="mb-menu">'+menu+'</div>' +
       '</div>';

  el.innerHTML = h;
}

// ── Detail menu-bar "More" dropdown ──────────────────────────────
function _toggleMoreMenu(e) {
  if (e) e.stopPropagation();
  const m = document.getElementById('mb-menu'); if (!m) return;
  const open = m.classList.toggle('open');
  // Close on the next outside click (deferred so THIS click doesn't close it).
  if (open) setTimeout(() => document.addEventListener('click', _closeMoreMenuOutside), 0);
  else document.removeEventListener('click', _closeMoreMenuOutside);
}
function _closeMoreMenuOutside(e) {
  if (e && e.target.closest && e.target.closest('.mb-more')) return;   // click inside → let it act
  _closeMoreMenu();
}
function _closeMoreMenu() {
  const m = document.getElementById('mb-menu'); if (m) m.classList.remove('open');
  document.removeEventListener('click', _closeMoreMenuOutside);
}
// Toggle shortlist selection from the detail bar, then refresh the bar so the
// star's on-state updates in place.
function _detailToggleSelect(uid) {
  _closeMoreMenu();
  toggleSelected(uid);
  const g = DB.getGroup(activeGroupId); const w = g && g.workers.find(x => x.uid === uid);
  if (w) _renderDetailTopbar(w, uid);
}

function toggleDetailEdit(uid) {
  detailEditMode = !detailEditMode;
  const g = DB.getGroup(activeGroupId); const w = g && g.workers.find(x => x.uid === uid); if (!w) return;
  document.getElementById('vm-content').innerHTML = _renderDetailBody(w, g);
  _renderDetailTopbar(w, uid);
  _initDetailEdit();
}
function cancelDetailEdit(uid) { detailEditMode = false; openView(uid); }
function saveDetailEdit(uid) {
  const g = DB.getGroup(activeGroupId); const w = g && g.workers.find(x => x.uid === uid); if (!w) return;
  const patch = {};
  document.querySelectorAll('#vm-content [data-ef]').forEach(el => { patch[el.dataset.ef] = (el.value || '').trim(); });
  DB.updateWorker(activeGroupId, uid, patch);
  toast(t('vd_saved'), 'ok');
  detailEditMode = false;
  openView(uid);
  rebuildFilters(); applyFilters(); renderSidebar();
}

// Export the detail window as a PDF via the browser's print dialog (offline-safe)
function exportWorkerPDF() {
  if (detailEditMode && _currentViewUid) { detailEditMode = false; openView(_currentViewUid); }
  document.body.classList.add('printing-worker');
  const cleanup = () => { document.body.classList.remove('printing-worker'); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  setTimeout(() => window.print(), 60);
}

function exportGroupPDF() {
  const g  = DB.getGroup(activeGroupId);
  const ws = tableFiltered.length ? tableFiltered : DB.getWorkers(activeGroupId);
  if (!ws.length) { toast(t('no_data_title') || 'No workers', 'warn'); return; }
  const container = document.getElementById('print-group-container');
  if (!container) return;
  container.innerHTML = ws.map(w =>
    '<div class="print-group-page">' + _renderKdCard(w, g) + '</div>'
  ).join('');
  document.body.classList.add('printing-group');
  const cleanup = () => {
    document.body.classList.remove('printing-group');
    container.innerHTML = '';
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  setTimeout(() => window.print(), 80);
}

// Zoom the ID card to fill the screen — real browser fullscreen ("Present" mode)
function zoomCard(uid) {
  if (!_presentRenderCard(uid)) return;
  openOverlay('cardzoom-overlay');
  // The card was painted while the overlay was still hidden (nothing to measure);
  // now that it has a size, fit the slide. Going fullscreen changes the box again
  // — the fullscreenchange handler re-fits.
  _kdFitAll(document.getElementById('cardzoom-body'));
  _enterFullscreen(document.getElementById('cardzoom-overlay'));
  _previewUpdateHud();
  _czWake();
}

// Paint ONLY the card for `uid` into the Present stage. Split out of zoomCard so
// flipping between workers while presenting swaps just the card — no overlay
// re-open, no repeated fullscreen request, no detail-drawer rebuild. That
// combination was what made every flip stutter.
function _presentRenderCard(uid) {
  const g = DB.getGroup(activeGroupId);
  const w = g && g.workers.find(x => x.uid === uid);
  if (!w) return false;
  const body = document.getElementById('cardzoom-body');
  if (body) { body.innerHTML = _renderKdCard(w, g, false, null, false, true); _kdFitAll(body); }   // full KD form, Present variant
  _presentPreloadNeighbours(uid, g);
  return true;
}

// Warm the browser cache with the previous/next worker's photo so flipping never
// shows an empty photo box while the image downloads.
function _presentPreloadNeighbours(uid, g) {
  const i = _navUids.indexOf(uid);
  if (i < 0 || !g) return;
  [i - 1, i + 1].forEach(k => {
    if (k < 0 || k >= _navUids.length) return;
    const nw = g.workers.find(x => x.uid === _navUids[k]);
    const src = nw && nw.photo;
    if (!src) return;
    const im = new Image();
    im.decoding = 'async';
    im.src = src;
  });
}

// Present mode: fade the close button (and the cursor) out once the mouse rests,
// so nothing sits over the card mid-presentation. Any movement brings them back.
let _czIdleT = null;
function _czWake() {
  const cz = document.getElementById('cardzoom-overlay');
  if (!cz) return;
  cz.classList.remove('cz-idle');
  clearTimeout(_czIdleT);
  _czIdleT = setTimeout(() => { if (cz.classList.contains('open')) cz.classList.add('cz-idle'); }, 2200);
}
document.addEventListener('mousemove', () => {
  const cz = document.getElementById('cardzoom-overlay');
  if (cz && cz.classList.contains('open')) _czWake();
}, { passive: true });

// ── Preview Mode (card zoom) selection & grading shortcuts ────────────
// The corner HUD (select chip / grade chip / shortcut hint) is intentionally
// EMPTY: nothing may overlay the card while presenting — the view has to stay
// completely unobstructed. The keyboard shortcuts still work (Space select,
// A/B/C grade, X deselect) and the brief centre flash still confirms them.
function _previewUpdateHud() {
  const hud = document.getElementById('cardzoom-hud');
  if (hud) hud.innerHTML = '';
}

// Center burst animation confirming an action inside the preview.
let _czFlashT = null;
function _previewFlash(html, cls) {
  const el = document.getElementById('cardzoom-flash');
  if (!el) return;
  // Fullscreen (Present) only paints the fullscreen element's own subtree, so the
  // burst must live INSIDE whatever container is on screen: the fullscreen/zoom
  // overlay in Present, otherwise the page body (over the detail drawer).
  const cz = document.getElementById('cardzoom-overlay');
  const host = document.fullscreenElement
    || (cz && cz.classList.contains('open') ? cz : document.body);
  if (el.parentNode !== host) host.appendChild(el);
  el.innerHTML = '<div class="cz-burst ' + (cls || '') + '">' + html + '</div>';
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(_czFlashT);
  _czFlashT = setTimeout(() => { el.classList.remove('show'); el.innerHTML = ''; }, 760);
}

function _previewToggleSelect() {
  if (!isAdmin() || !_currentViewUid) return;
  toggleSelected(_currentViewUid);
  const on = isSelected(_currentViewUid);
  _previewUpdateHud();
  _previewFlash(
    (on ? '★ ' : '☆ ') + esc(on ? bi('ເລືອກແລ້ວ', 'Selected', 'เลือกแล้ว', '선택됨')
                                : bi('ຍົກເລີກແລ້ວ', 'Removed', 'ยกเลิกแล้ว', '해제됨')),
    on ? 'cz-on' : 'cz-off');
}

// Explicit deselect (X / Delete) — only acts when the worker is currently selected.
function _previewDeselect() {
  if (!isAdmin() || !_currentViewUid || !isSelected(_currentViewUid)) return;
  toggleSelected(_currentViewUid);   // removes from the shortlist
  _previewUpdateHud();
  _previewFlash('☆ ' + esc(bi('ຍົກເລີກແລ້ວ', 'Removed', 'ยกเลิกแล้ว', '해제됨')), 'cz-off');
}

// Keep the detail drawer's topbar grade chip in sync after a keyboard grade change.
function _updateDetailTopbarGrade() {
  if (!document.getElementById('view-overlay')?.classList.contains('open')) return;
  const g = DB.getGroup(activeGroupId);
  const w = g && g.workers.find(x => x.uid === _currentViewUid);
  const loEl = document.getElementById('vm-topbar-lo');
  if (!w || !loEl) return;
  const gradeChip = w.grade
    ? '<span class="vm-grade-chip" style="background:' + (GRADE_COLORS[w.grade] || '#6b7280') + '">Grade ' + esc(w.grade) + '</span>'
    : '';
  loEl.innerHTML = gradeChip + (w.lo_name ? '<span class="vm-topbar-lo-text">' + esc(w.lo_name) + '</span>' : '');
}

function _previewSetGrade(key) {
  if (!isAdmin() || !_currentViewUid) return;
  const g = DB.getGroup(activeGroupId);
  const w = g && g.workers.find(x => x.uid === _currentViewUid);
  const cur = w ? _normGrade(w.grade) : '';   // legacy "B" reads as "B+"
  // Each key toggles its grade off when pressed again, so a grade can be removed.
  // B cycles through both B grades then clears: none → B+ → B- → none.
  let next;
  if (key === 'B') next = cur === 'B+' ? 'B-' : (cur === 'B-' ? '' : 'B+');
  else             next = cur === key ? '' : key;   // A / C toggle on ⇄ off
  DB.updateWorker(activeGroupId, _currentViewUid, { grade: next });   // change is auto-logged server-side
  renderTable();            // reflect the new grade badge in the list behind
  _updateDetailTopbarGrade();
  _previewUpdateHud();
  _previewFlash(next ? 'GRADE ' + esc(next)
                     : esc(bi('ລຶບເກຣດ', 'Grade cleared', 'ลบเกรดแล้ว', '등급 삭제')), 'cz-grade-flash');
}

// Request true fullscreen on an element. Must run inside a user gesture (a click),
// which zoomCard always is. Silently no-ops where the API is unavailable/blocked.
function _enterFullscreen(el) {
  if (!el || document.fullscreenElement) return;
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (!req) return;
  try { const p = req.call(el); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}
function _exitFullscreen() {
  if (!document.fullscreenElement) return;
  const ex = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  if (!ex) return;
  try { const p = ex.call(document); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}

// ── VIEW CARD ─────────────────────────────────────────────────────
function openView(uid, keepTab) {
  _ensureGroupFor(uid);   // resolve owning group (global search / overview)
  const g = DB.getGroup(activeGroupId);
  const w = g && g.workers.find(x => x.uid === uid);
  if (!w) return;

  _currentViewUid = uid;
  detailEditMode = false;
  _docPasteTarget = null;   // clear paste target when switching workers

  // Build the ←/→ navigation order: follow the table the user is looking at
  // (filtered + sorted) when it contains this worker, otherwise the group order.
  const navSrc = (tableFiltered && tableFiltered.some(x => x.uid === uid))
    ? tableFiltered : (g ? g.workers : []);
  _navUids = navSrc.map(x => x.uid);

  const age   = calcAge(w.dob);
  const idNum = w.worker_id ? w.worker_id.split('-').pop() : '--';

  const gradeColor  = GRADE_COLORS[w.grade] || '#6b7280';
  const gradeChip   = w.grade
    ? '<span class="vm-grade-chip" style="background:' + gradeColor + '">Grade ' + esc(w.grade) + '</span>'
    : '';

  // Topbar
  const enEl = document.getElementById('vm-topbar-en');
  const loEl = document.getElementById('vm-topbar-lo');
  if (enEl) enEl.textContent = w.en_name || '';
  if (loEl) loEl.innerHTML   = gradeChip + (w.lo_name ? '<span class="vm-topbar-lo-text">' + esc(w.lo_name) + '</span>' : '');

  _renderDetailTopbar(w, uid);

  // Fresh open → start on Details. Arrow-navigation (keepTab) stays on whatever
  // tab is open, so flipping through people keeps you on Documents / Activity.
  // Either way drop the previous worker's activity so their log never shows here.
  const targetTab = keepTab
    ? (document.querySelector('#vm-tabs .vm-tab.active')?.dataset.tab || 'info')
    : 'info';
  _histTabLoaded = false;
  const actContent = document.getElementById('vm-activity-content');
  if (actContent) actContent.innerHTML = '';
  switchDetailTab(targetTab);

  // Info pane = two columns (detail table left, locked ID card right)
  document.getElementById('vm-content').innerHTML = _renderDetailBody(w, g);

  // Load docs immediately (no tab, single scroll page)
  document.getElementById('vm-docs-content').innerHTML =
    '<div class="vm-docs-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> ' + t('vc_documents') + '</div>' +
    '<div class="doc-loading">&#8203;</div>';
  _loadAndRenderDocs(uid);

  openOverlay('view-overlay');
}

// Jump to the previous / next worker in the current detail-view order (←/→).
// Works in the detail drawer AND while zooming a card — in zoom mode we refresh
// both the underlying detail and the zoomed card so flipping through to print is
// seamless.
function _navWorker(dir) {
  if (!_currentViewUid || !_navUids.length) return;
  const i = _navUids.indexOf(_currentViewUid);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= _navUids.length) return;   // clamp at the ends
  const next = _navUids[j];
  const zoomOpen = document.getElementById('cardzoom-overlay')?.classList.contains('open');
  if (zoomOpen) {
    // Presenting: swap only the card. Rebuilding the whole detail drawer behind
    // the fullscreen card (then re-opening the overlay + re-requesting
    // fullscreen) was invisible work that made every flip stutter — defer the
    // drawer refresh until Present closes.
    if (!_presentRenderCard(next)) return;
    _currentViewUid = next;
    _presentDirty = true;
    _czWake();
    return;
  }
  openView(next, true);           // keep the detail + state in sync (and the active tab)
}

// Arrow keys flip through workers while the detail drawer or the card-zoom view is
// open — but not while editing a field or when another modal (doc viewer / editor /
// export) is focused on top.
document.addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (detailEditMode) return;
  const voOpen   = document.getElementById('view-overlay')?.classList.contains('open');
  const zoomOpen = document.getElementById('cardzoom-overlay')?.classList.contains('open');
  if (!voOpen && !zoomOpen) return;
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable)) return;
  // Block only when a DIFFERENT overlay (not the detail/zoom pair) is on top.
  const blocking = [...document.querySelectorAll('.overlay.open')]
    .some(el => el.id !== 'view-overlay' && el.id !== 'cardzoom-overlay');
  if (blocking) return;
  e.preventDefault();
  _navWorker(e.key === 'ArrowRight' ? 1 : -1);
});

// Preview Mode (card zoom) shortcuts: P/O = select · A/B/C = set grade.
// Scoped to the zoom overlay so plain letters never hijack typing elsewhere.
document.addEventListener('keydown', e => {
  // Works in the zoom Preview AND the detail drawer (both track _currentViewUid).
  const czOpen = document.getElementById('cardzoom-overlay')?.classList.contains('open');
  const voOpen = document.getElementById('view-overlay')?.classList.contains('open');
  if ((!czOpen && !voOpen) || !_currentViewUid || !isAdmin() || detailEditMode) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable)) return;
  // Ignore if a different modal (export/photo editor/…) sits on top.
  const blocking = [...document.querySelectorAll('.overlay.open')]
    .some(el => el.id !== 'view-overlay' && el.id !== 'cardzoom-overlay');
  if (blocking) return;
  const k = e.key.toLowerCase();
  if (k === ' ')                                 { e.preventDefault(); _previewToggleSelect(); }
  else if (k === 'x' || k === 'delete')          { e.preventDefault(); _previewDeselect(); }
  else if (k === 'a' || k === 'b' || k === 'c')  { e.preventDefault(); _previewSetGrade(k.toUpperCase()); }
});

// ── GLOBAL KEYBOARD SHORTCUTS ─────────────────────────────────────
function _overlayOpen(id) { return !!document.getElementById(id)?.classList.contains('open'); }
function _topOpenOverlay() {
  // Prefer the most-recently-opened overlay still open → true layer order, so
  // opening Form then Photo and pressing Esc closes the Photo first.
  for (let i = _overlayStack.length - 1; i >= 0; i--) {
    const el = document.getElementById(_overlayStack[i]);
    if (el && el.classList.contains('open')) return el;
  }
  // Fallback (overlay opened without openOverlay): highest z-index, ties → later DOM.
  const open = [...document.querySelectorAll('.overlay.open')];
  if (!open.length) return null;
  return open.reduce((top, el) =>
    (parseInt(getComputedStyle(el).zIndex, 10) || 0) >= (parseInt(getComputedStyle(top).zIndex, 10) || 0) ? el : top);
}
function copyWorkerInfo(uid) {
  _ensureGroupFor(uid);
  const g = DB.getGroup(activeGroupId); const w = g && g.workers.find(x => x.uid === uid);
  if (!w) return;
  const text = [w.worker_id, w.en_name, w.lo_name].filter(Boolean).join('  •  ');
  if (!text) return;
  const done = () => toast(bi('ຄັດລອກແລ້ວ','Copied','คัดลอกแล้ว','복사됨') + ': ' + text, 'ok');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => {});
  else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) {} ta.remove(); }
}
document.addEventListener('keydown', e => {
  const tag    = (e.target && e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable);

  // ?  → keyboard shortcuts cheatsheet (when not typing)
  if (!typing && e.key === '?') { e.preventDefault(); toggleShortcuts(); return; }

  // Ctrl/Cmd + Enter → save the open form
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (_overlayOpen('form-overlay'))  { e.preventDefault(); saveWorker(); return; }
    if (_overlayOpen('group-overlay')) { e.preventDefault(); saveGroup();  return; }
  }

  // Enter → confirm the small confirm/info dialog (never auto-submits big forms)
  if (e.key === 'Enter' && !e.shiftKey && tag !== 'textarea' && _overlayOpen('confirm-overlay')) {
    const ok = document.getElementById('cm-confirm-btn');
    if (ok && ok.offsetParent !== null) { e.preventDefault(); ok.click(); return; }
  }

  // Ctrl/Cmd + C → copy the open worker's ID + name (unless typing or selecting text)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !typing && _currentViewUid) {
    const hasSel = window.getSelection && String(window.getSelection()).trim();
    if (!hasSel) { e.preventDefault(); copyWorkerInfo(_currentViewUid); return; }
  }

  // Esc → close menus, then the top-most overlay (the worker form auto-saves)
  if (e.key === 'Escape') {
    if (_overlayOpen('shortcuts-overlay')) { closeOverlay('shortcuts-overlay'); return; }
    const rm = document.getElementById('row-menu');
    if (rm && rm.classList.contains('open')) { closeRowMenu(); return; }
    if (document.getElementById('sb-more')?.classList.contains('open')) { closeMoreMenu(); return; }
    const top = _topOpenOverlay();
    if (top) {
      e.preventDefault();
      if (top.id === 'form-overlay') autoSaveWorkerForm();
      else closeOverlay(top.id);
    }
  }
});

// ── Keyboard shortcuts cheatsheet ─────────────────────────────────
function _shortcutRows() {
  const mod = (navigator.platform || '').toLowerCase().indexOf('mac') >= 0 ? '⌘' : 'Ctrl';
  return [
    ['Esc',          bi('ປິດໜ້າຕ່າງ (ຟອມບັນທຶກອັດຕະໂນມັດ)','Close dialog (form auto-saves)','ปิดหน้าต่าง (ฟอร์มบันทึกอัตโนมัติ)','창 닫기 (양식 자동 저장)')],
    ['Enter',        bi('ຢືນຢັນ (ກ່ອງເລັກ)','Confirm (small dialog)','ยืนยัน (กล่องเล็ก)','확인 (작은 대화상자)')],
    [mod + ' + Enter', bi('ບັນທຶກຟອມ','Save form','บันทึกฟอร์ม','양식 저장')],
    [mod + ' + C',   bi('ຄັດລອກ Worker ID / ຊື່','Copy Worker ID / name','คัดลอก Worker ID / ชื่อ','근로자 ID·이름 복사')],
    [mod + ' + V',   bi('ວາງຮູບ (ຊ່ອງເອກະສານ)','Paste image (doc slot)','วางรูป (ช่องเอกสาร)','이미지 붙여넣기 (문서)')],
    [mod + ' + K',   bi('ຄົ້ນຫາ','Search','ค้นหา','검색')],
    [mod + ' + ,',   bi('ຕັ້ງຄ່າ','Settings','ตั้งค่า','설정')],
    ['← / →',        bi('ຄົນກ່ອນໜ້າ / ຖັດໄປ','Prev / next worker','คนก่อนหน้า / ถัดไป','이전 / 다음 근로자')],
    ['?',            bi('ສະແດງລາຍການນີ້','Show this list','แสดงรายการนี้','이 목록 표시')],
  ];
}
function renderShortcuts() {
  const el = document.getElementById('shortcuts-body');
  if (!el) return;
  el.innerHTML = _shortcutRows().map(([k, d]) =>
    '<div class="kbd-row"><span class="kbd-keys">' +
      k.split(' + ').map(p => '<kbd>' + esc(p) + '</kbd>').join('<i>+</i>') +
    '</span><span class="kbd-desc">' + esc(d) + '</span></div>'
  ).join('');
}
function openShortcuts()   { renderShortcuts(); openOverlay('shortcuts-overlay'); }
function toggleShortcuts() { _overlayOpen('shortcuts-overlay') ? closeOverlay('shortcuts-overlay') : openShortcuts(); }

function _triggerPhotoEdit(uid) {
  const inp = document.getElementById('photo-edit-input');
  if (inp) { inp.dataset.uid = uid; inp.click(); }
}

async function _handlePhotoEdit(input, uid) {
  const file = input.files && input.files[0];
  if (!file) return;
  input.value = '';
  _fileToDataURL(file, 800, dataUrl => {
    try {
      DB.updateWorker(activeGroupId, uid, { photo: dataUrl });
      const g = DB.getGroup(activeGroupId);
      const w = g && g.workers.find(x => x.uid === uid);
      if (w) { w.photo = dataUrl; w.photo_thumb = ''; }   // stale thumb → fall back to full photo
      _queueThumb(uid, dataUrl);
      // Refresh the badge card photo in-place
      const idcPhoto = document.querySelector('.idc-photo');
      if (idcPhoto && w) {
        idcPhoto.innerHTML =
          personPhoto(w, 'avatar-xl') +
          '<div class="idc-photo-edit">&#9998;</div>';
      }
      _refreshPhotoViews();   // repaint list + dashboard now
      toast('Photo updated', 'ok');
    } catch (e) {
      toast('Photo upload failed', 'err');
    }
  });
}

// ── Pan / zoom / rotate / crop image editor (profile photos + documents) ──
// Shows the WHOLE image (so a face or a document edge is never silently cut),
// then lets the user drag to pan, wheel/slider to zoom, and rotate in 90° steps.
// The green frame is exactly what gets saved — the output is rendered from that
// frame to a fresh canvas. Used for both the KD-card photo (1:1 frame, which is
// why faces used to get cropped) and for re-cropping an uploaded document.
let _ce = null;          // editor state
let _ceWired = false;    // pointer/wheel listeners attached once

function _ceOpen(opts) {
  _ce = { src: opts.src || '', orig: opts.src || '', img: null, rot: 0, scale: 1, tx: 0, ty: 0,
          aspect: opts.aspect || null, mode: opts.mode || 'photo', allowPick: !!opts.allowPick,
          onSave: opts.onSave || function () {}, drag: null };
  const titleEl = document.getElementById('ce-title'); if (titleEl) titleEl.textContent = opts.title || '';
  const pick = document.getElementById('ce-pick'); if (pick) pick.style.display = _ce.allowPick ? '' : 'none';
  const prev = document.getElementById('ce-prev');
  if (prev) prev.className = 'ce-prev ' + (_ce.mode === 'doc' ? 'ce-prev-doc' : 'ce-prev-photo');
  openOverlay('photo-editor-overlay');
  _ceWire();
  _ceLoad(_ce.src);
}

function _ceLoad(src) {
  const z = document.getElementById('ce-zoom'); if (z) z.value = 1;
  if (!src) { _ce.img = null; _ceDraw(); return; }
  const img = new Image();
  img.onload  = () => { _ce.img = img; _ce.rot = 0; _ce.scale = 1; _ce.tx = 0; _ce.ty = 0; if (z) z.value = 1; _ceDraw(); };
  img.onerror = () => { _ce.img = null; _ceDraw(); };
  img.src = src;
}

// Crop frame: centred in the stage, sized to `aspect` (or the image's own aspect
// when free), leaving a small margin so the whole image is visible at zoom 1.
// In free mode the frame follows the image's CURRENT (post-rotation) aspect, so
// after a 90° rotation it still fills the frame exactly — no white bars get baked
// into the saved file.
function _ceGeom() {
  const canvas = document.getElementById('ce-canvas');
  const SW = canvas.width, SH = canvas.height;
  const M = Math.round(Math.min(SW, SH) * 0.06);
  const avW = SW - 2 * M, avH = SH - 2 * M;
  let a = _ce.aspect;
  if (!a && _ce.img) {
    const rot = ((_ce.rot % 360) + 360) % 360;
    const swap = rot === 90 || rot === 270;
    a = swap ? _ce.img.naturalHeight / _ce.img.naturalWidth
             : _ce.img.naturalWidth  / _ce.img.naturalHeight;
  }
  let CW, CH;
  if (a) { if (avW / avH > a) { CH = avH; CW = a * CH; } else { CW = avW; CH = CW / a; } }
  else   { CW = avW; CH = avH; }
  return { SW, SH, CW, CH, cropX: (SW - CW) / 2, cropY: (SH - CH) / 2, cx0: SW / 2, cy0: SH / 2 };
}
// Scale that makes the whole (rotated) image fit inside the crop frame at zoom 1.
function _ceBaseScale(g) {
  if (!_ce.img) return 1;
  const rot = ((_ce.rot % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const rw = swap ? _ce.img.naturalHeight : _ce.img.naturalWidth;
  const rh = swap ? _ce.img.naturalWidth  : _ce.img.naturalHeight;
  return Math.min(g.CW / rw, g.CH / rh);
}

function _ceDraw() {
  const canvas = document.getElementById('ce-canvas'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const g = _ceGeom();
  ctx.fillStyle = '#15181b'; ctx.fillRect(0, 0, g.SW, g.SH);
  if (_ce.img) {
    const eff = _ceBaseScale(g) * _ce.scale;
    ctx.save();
    ctx.translate(g.cx0 + _ce.tx, g.cy0 + _ce.ty);
    ctx.rotate(_ce.rot * Math.PI / 180);
    ctx.scale(eff, eff);
    ctx.drawImage(_ce.img, -_ce.img.naturalWidth / 2, -_ce.img.naturalHeight / 2);
    ctx.restore();
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '14px system-ui,sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(t('photo_pick_hint') || 'ເລືອກຮູບ', g.SW / 2, g.SH / 2);
  }
  // dim everything outside the crop frame, then stroke the frame
  ctx.save();
  ctx.fillStyle = 'rgba(18,20,24,0.58)';
  ctx.beginPath();
  ctx.rect(0, 0, g.SW, g.SH);
  ctx.rect(g.cropX, g.cropY, g.CW, g.CH);
  ctx.fill('evenodd');
  ctx.restore();
  ctx.strokeStyle = '#c9f040'; ctx.lineWidth = 2;
  ctx.strokeRect(g.cropX + 1, g.cropY + 1, g.CW - 2, g.CH - 2);
  _ceUpdatePreview();
}

// Render exactly the crop frame to a fresh, up-scaled canvas (shared by the live
// preview and the final save — so what you see is what you get).
function _ceComposeCanvas(maxDim) {
  if (!_ce || !_ce.img) return null;
  const g = _ceGeom();
  const eff = _ceBaseScale(g) * _ce.scale;
  const K = Math.min(4, maxDim / Math.max(g.CW, g.CH));
  const oc = document.createElement('canvas');
  oc.width  = Math.max(1, Math.round(g.CW * K));
  oc.height = Math.max(1, Math.round(g.CH * K));
  const octx = oc.getContext('2d');
  octx.fillStyle = '#ffffff'; octx.fillRect(0, 0, oc.width, oc.height);
  octx.translate((g.cx0 + _ce.tx - g.cropX) * K, (g.cy0 + _ce.ty - g.cropY) * K);
  octx.rotate(_ce.rot * Math.PI / 180);
  octx.scale(eff * K, eff * K);
  octx.drawImage(_ce.img, -_ce.img.naturalWidth / 2, -_ce.img.naturalHeight / 2);
  return oc;
}

// Live "as it appears on the data page" preview — updates on every adjustment.
function _ceUpdatePreview() {
  const img = document.getElementById('ce-prev-img');
  if (!img) return;
  if (!_ce || !_ce.img) { img.removeAttribute('src'); return; }
  const oc = _ceComposeCanvas(360);
  if (oc) img.src = oc.toDataURL('image/jpeg', 0.82);
}

function _ceXY(e) {
  const canvas = document.getElementById('ce-canvas');
  const r = canvas.getBoundingClientRect();
  const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
  const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
  return { x: cx * (canvas.width / r.width), y: cy * (canvas.height / r.height) };
}
function _ceDown(e) { if (!_ce || !_ce.img) return; e.preventDefault(); const p = _ceXY(e); _ce.drag = { x: p.x, y: p.y, tx: _ce.tx, ty: _ce.ty }; }
function _ceMove(e) { if (!_ce || !_ce.drag) return; e.preventDefault(); const p = _ceXY(e); _ce.tx = _ce.drag.tx + (p.x - _ce.drag.x); _ce.ty = _ce.drag.ty + (p.y - _ce.drag.y); _ceDraw(); }
function _ceUp()    { if (_ce) _ce.drag = null; }
function _ceWheel(e){ if (!_ce || !_ce.img) return; e.preventDefault(); _ceZoomTo(_ce.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); }
function _ceZoom(v) { _ceZoomTo(parseFloat(v)); }
function _ceZoomBy(f){ _ceZoomTo(_ce.scale * f); }
function _ceZoomTo(s){ if (!_ce) return; _ce.scale = Math.max(1, Math.min(8, s)); const z = document.getElementById('ce-zoom'); if (z) z.value = _ce.scale; _ceDraw(); }
function _ceRotate(dir){ if (!_ce || !_ce.img) return; _ce.rot = (((_ce.rot + dir * 90) % 360) + 360) % 360; _ceDraw(); }
// Reset = revert to the FULL original image (undo any crop/zoom/rotate mistake).
// We reload the untouched original so even a previously-saved bad crop comes back.
function _ceReset() {
  if (!_ce) return;
  _ce.src = _ce.orig;
  _ceLoad(_ce.orig);          // reloads original + resets transform → whole image
}
function _cePick(input) {
  const file = input.files && input.files[0]; if (!file || !_ce) return;
  input.value = '';
  _fileToDataURL(file, 1600, dataUrl => { _ce.src = _ce.orig = dataUrl; _ceLoad(dataUrl); });
}
function _ceWire() {
  if (_ceWired) return; _ceWired = true;
  const c = document.getElementById('ce-canvas'); if (!c) return;
  c.addEventListener('mousedown', _ceDown);
  window.addEventListener('mousemove', _ceMove);
  window.addEventListener('mouseup', _ceUp);
  c.addEventListener('touchstart', _ceDown, { passive: false });
  c.addEventListener('touchmove',  _ceMove, { passive: false });
  window.addEventListener('touchend', _ceUp);
  c.addEventListener('wheel', _ceWheel, { passive: false });
}

// Save = the crop frame at full quality. Also hands back the untouched original
// (_ce.orig) so callers that support revert can keep it.
function _ceSave() {
  if (!_ce) return closeOverlay('photo-editor-overlay');
  const oc = _ceComposeCanvas(1400);
  if (!oc) { closeOverlay('photo-editor-overlay'); return; }
  const out = oc.toDataURL('image/jpeg', 0.9);
  const cb = _ce.onSave, orig = _ce.orig;
  closeOverlay('photo-editor-overlay');
  cb(out, orig);
}

// Entry point from the KD-card photo box. 1:1 frame matches the card's 80×80 box.
// The editor opens on the ORIGINAL (un-cropped) photo when we have one, so the
// user can always re-crop from scratch or Reset back to the full image.
function openPhotoEditor(uid) {
  if (!isAdmin()) return;
  const g = DB.getGroup(activeGroupId);
  const w = g && g.workers.find(x => x.uid === uid);
  if (!w) return;
  _ceOpen({
    src: w.photo_orig || w.photo || '', aspect: 1, allowPick: true, mode: 'photo',
    title: t('photo_editor_title') || 'ແກ້ໄຂຮູບໂປຣໄຟລ໌',
    onSave: (dataUrl, orig) => {
      try {
        // Save the cropped result for display AND keep the original for future reverts.
        DB.updateWorker(activeGroupId, uid, { photo: dataUrl, photo_orig: orig || dataUrl });
        const gg = DB.getGroup(activeGroupId);
        const ww = gg && gg.workers.find(x => x.uid === uid);
        // Clear the stale thumbnail BEFORE the repaint so cards fall back to the
        // fresh full photo now; _queueThumb regenerates the light one + repaints.
        if (ww) { ww.photo = dataUrl; ww.photo_orig = orig || dataUrl; ww.photo_thumb = ''; }
        _queueThumb(uid, dataUrl);
        if (_currentViewUid === uid) openView(uid);   // refresh the KD card in place
        _refreshPhotoViews();                          // repaint list + dashboard now
        toast(t('photo_saved') || 'ອັບເດດຮູບແລ້ວ', 'ok');
      } catch (e) {
        toast(t('photo_save_err') || 'ບັນທຶກຮູບບໍ່ສຳເລັດ', 'err');
      }
    },
  });
}

// ── DOCUMENTS (inside the detail drawer, versioned) ───────────────
// Document categories — admin-configurable in Settings → Documents. The live
// list is server-side and self-healing; the defaults below are only reached
// when there is no server list at all, and they are the SAME defaults the
// server seeds from (infra/doc-cats.js) so the two can never name a category
// differently.
function getDocCats() {
  try { const c = DB.getSetting('doc_cats', null); if (Array.isArray(c) && c.length) return c; } catch (e) {}
  // legacy fallback (older versions stored this per-browser)
  try { const l = JSON.parse(localStorage.getItem('kd_doc_cats')); if (Array.isArray(l) && l.length) return l; } catch (e) {}
  return KDDocCats.defaults();
}

// One-time migration: older builds kept document categories ONLY in this
// browser's localStorage, so they disappeared the moment the app was opened from
// a different origin (e.g. each new Cloudflare quick-tunnel URL gets its own
// localStorage), making every document under them look lost. The server now owns
// categories — lift any local copy onto it (preserving the human labels) so they
// persist across devices, restarts and changing URLs. Safe to run every boot:
// it never overwrites a server-side rename and never resurrects a deleted type.
async function _migrateDocCatsToServer() {
  try {
    let local = null;
    try { local = JSON.parse(localStorage.getItem('kd_doc_cats')); } catch (e) {}
    if (!Array.isArray(local) || !local.length) return;
    const server = DB.getSetting('doc_cats', null);
    const merged = (Array.isArray(server) ? server : []).slice();
    const byKey  = new Map(merged.map((c, i) => [c.key, i]));
    let changed  = !Array.isArray(server);   // server had nothing → seed it
    local.forEach(lc => {
      if (!lc || !lc.key) return;
      if (byKey.has(lc.key)) {
        // Replace a derived placeholder ("Document xxxxx") with the real label.
        const idx = byKey.get(lc.key);
        if (lc.label && merged[idx].label !== lc.label && /^Document /.test(merged[idx].label || '')) {
          merged[idx] = { ...merged[idx], label: lc.label };
          changed = true;
        }
      } else {
        merged.push({ key: lc.key, label: lc.label || lc.key });
        byKey.set(lc.key, merged.length - 1);
        changed = true;
      }
    });
    if (changed && merged.length) {
      DB.setSetting('doc_cats', merged);
      try { await DB.flush(); } catch (e) {}
    }
    // Migrated onto the server → stop relying on the per-browser copy.
    try { localStorage.removeItem('kd_doc_cats'); } catch (e) {}
  } catch (e) { /* migration must never block boot */ }
}

// ── Completeness (text-data fields + documents) ───────────────────
// Two independent scores per worker:
//   • data  — how many of the "required" fields are filled (admin-configurable,
//             defaults to a core set)
//   • docs  — how many document categories have at least one uploaded file
// Shown as a small box in the detail view, a chip on list cards, and a dashboard
// stat, so it's obvious at a glance whose record is incomplete.
const _DEFAULT_REQ_FIELDS = ['worker_id','en_name','lo_name','dob','sex','nationality',
  'passport_no','passport_expiry','tel','province','village','employer_code'];
// Every field that can be marked "required" (key → bilingual label).
function _reqFieldCatalog() { return [
  ['worker_id', bi('ລະຫັດ','Worker ID','รหัสแรงงาน','근로자 ID')],
  ['en_name', bi('ຊື່ EN','EN Name','ชื่อ EN','영문 이름')],
  ['lo_name', bi('ຊື່ ລາວ','Lao Name','ชื่อลาว','라오어 이름')],
  ['dob', bi('ວັນເກີດ','Date of birth','วันเกิด','생년월일')],
  ['sex', bi('ເພດ','Sex','เพศ','성별')],
  ['nationality', bi('ສັນຊາດ','Nationality','สัญชาติ','국적')],
  ['blood', bi('ກຸ່ມເລືອດ','Blood type','กรุ๊ปเลือด','혈액형')],
  ['grade', bi('ເກຣດ','Grade','เกรด','등급')],
  ['passport_no', bi('ເລກພາສປອດ','Passport No','เลขพาสปอร์ต','여권번호')],
  ['passport_issue', bi('ວັນອອກ','Issue date','วันออก','발급일')],
  ['passport_expiry', bi('ວັນໝົດອາຍຸ','Expiry date','วันหมดอายุ','만료일')],
  ['visa_status', bi('ວີຊ່າ','Visa','วีซ่า','비자')],
  ['tel', bi('ໂທ','Tel','โทร','전화')],
  ['emg_tel', bi('ໂທສຸກເສີນ','Emergency tel','โทรฉุกเฉิน','비상 전화')],
  ['province', bi('ແຂວງ','Province','แขวง','주')],
  ['district', bi('ເມືອງ','District','เมือง','군')],
  ['village', bi('ບ້ານ','Village','หมู่บ้าน','마을')],
  ['employer_code', bi('ນາຍຈ້າງ','Employer','นายจ้าง','고용주')],
  ['group_supervisor', bi('ຫົວໜ້າ','Supervisor','หัวหน้า','관리자')],
  ['weight', bi('ນ້ຳໜັກ','Weight','น้ำหนัก','체중')],
  ['height', bi('ສ່ວນສູງ','Height','ส่วนสูง','신장')],
  ['size', bi('ຂະໜາດ','Size','ขนาด','사이즈')],
  ['couple', bi('ຄູ່','Couple','คู่','부부')],
]; }
function getReqFields() {
  try { const c = DB.getSetting('req_fields', null); if (Array.isArray(c) && c.length) return c; } catch (e) {}
  return _DEFAULT_REQ_FIELDS;
}
function dataCompleteness(w) {
  const fields = getReqFields();
  let filled = 0;
  fields.forEach(f => {
    let v = w[f];
    if (f === 'age' && (v == null || v === '')) v = calcAge(w.dob);
    if (String(v == null ? '' : v).trim()) filled++;
  });
  const total = fields.length || 1;
  return { filled, total, pct: Math.round(filled / total * 100) };
}
// Prefer the freshest docs we have for this worker (the versioned cache updates
// the instant something is uploaded), falling back to the bootstrap snapshot.
function docsCompleteness(w) {
  const cats = getDocCats();
  const docs = (_docCache && _docCache[w.uid]) || w.documents || {};
  let have = 0;
  cats.forEach(c => { const a = docs[c.key]; if (a && a.length) have++; });
  const total = cats.length || 1;
  return { have, total, pct: Math.round(have / total * 100) };
}
function _pctColor(p) { return p >= 100 ? '#16a34a' : p >= 60 ? '#f59e0b' : '#dc2626'; }

// Small completeness box for the detail view corner.
function _completenessBox(w) {
  const d = dataCompleteness(w), k = docsCompleteness(w);
  const allDone = d.pct >= 100 && k.pct >= 100;
  const bar = (label, pct, right, col) =>
    '<div class="cmp-row">' +
      '<span class="cmp-lbl">' + label + '</span>' +
      '<span class="cmp-bar"><span style="width:' + pct + '%;background:' + col + '"></span></span>' +
      '<span class="cmp-pct" style="color:' + col + '">' + right + '</span>' +
    '</div>';
  return '<div class="cmp-box" id="cmp-box-' + esc(w.uid) + '"' + (allDone ? ' data-done="1"' : '') + '>' +
    '<div class="cmp-head">' + bi('ຄວາມຄົບຖ້ວນ', 'Completeness', 'ความครบถ้วน', '완성도') + (allDone ? ' <span class="cmp-check">✓</span>' : '') + '</div>' +
    bar(bi('ຂໍ້ມູນ', 'Data', 'ข้อมูล', '데이터'), d.pct, d.pct + '%', _pctColor(d.pct)) +
    bar(bi('ເອກະສານ', 'Documents', 'เอกสาร', '문서'), k.pct, k.have + '/' + k.total, _pctColor(k.pct)) +
  '</div>';
}
// Replace the detail box in place (after docs finish loading, so docs% is fresh).
function _refreshCmpBox(uid) {
  const el = document.getElementById('cmp-box-' + uid);
  if (!el) return;
  const w = _findWorker(uid);
  if (w) el.outerHTML = _completenessBox(w);
}
function _findWorker(uid) {
  const groups = DB.getGroups();
  for (const g of groups) { const w = (g.workers || []).find(x => x.uid === uid); if (w) return w; }
  return null;
}

// Compact corner chip for list / KD-card cells.
function _completenessChip(w) {
  const d = dataCompleteness(w), k = docsCompleteness(w);
  const title = bi('ຂໍ້ມູນ ', 'Data ', 'ข้อมูล ', '데이터 ') + d.pct + '% · ' + bi('ເອກະສານ ', 'Documents ', 'เอกสาร ', '문서 ') + k.have + '/' + k.total;
  return '<div class="cmp-chip" title="' + esc(title) + '">' +
    '<span class="cmp-chip-dot" style="background:' + _pctColor(d.pct) + '"></span>' + d.pct + '%' +
    '<span class="cmp-chip-sep">·</span>' +
    '<span class="cmp-chip-dot" style="background:' + _pctColor(k.pct) + '"></span>' + k.have + '/' + k.total +
  '</div>';
}

function renderDocuments(w) {
  setTimeout(() => _loadAndRenderDocs(w.uid), 0);
  return '';
}

const _docCache = {};   // uid → docs map (instant render + optimistic upload)

// Normalize the bootstrap snapshot's documents map ({cat:[{name,type,data}]})
// into the richer shape _renderDocs expects ({cat:[{path,type,name,isCurrent…}]}).
// The list outside already trusts this snapshot to decide "has documents", so we
// reuse it as an instant + offline fallback: the drawer should never look empty
// for a worker the list says has files just because the live fetch is slow/fails.
function _docsFromSnapshot(documents) {
  const out = {};
  Object.keys(documents || {}).forEach(cat => {
    (documents[cat] || []).forEach(d => {
      const path = d.path || d.data || '';
      if (!path) return;
      (out[cat] = out[cat] || []).push({
        id: d.id || null, path, type: d.type || 'image',
        name: d.name || '', version: d.version || 1, isCurrent: true,
      });
    });
  });
  return out;
}

async function _loadAndRenderDocs(uid) {
  if (!document.getElementById('vm-docs-content') && !document.getElementById('vm-docs-' + uid)) return;
  // Paint immediately from whatever we already know (prior cache, or the
  // bootstrap snapshot) so documents show at once and survive a slow or failed
  // live request — previously a thrown/timed-out fetch left the section blank
  // even though the list outside still showed the worker as having files.
  if (!_docCache[uid]) {
    const w = _findWorker(uid);
    if (w && w.documents && Object.keys(w.documents).length) _docCache[uid] = _docsFromSnapshot(w.documents);
  }
  if (_docCache[uid]) _renderDocs(uid);
  // The server's versioned list is authoritative whenever it's reachable; only
  // overwrite the snapshot when the fetch actually succeeds.
  let live = null;
  try { live = await DB.getDocuments(uid); } catch (e) { live = null; }
  if (live) _docCache[uid] = live;
  _renderDocs(uid);
  _refreshCmpBox(uid);   // docs% is now accurate → update the completeness box
}

// Find a document version by id across every category of every cached worker,
// so a click handler only ever has to carry the id.
function openDocVersion(docId) {
  for (const uid of Object.keys(_docCache)) {
    for (const catKey of Object.keys(_docCache[uid] || {})) {
      const v = (_docCache[uid][catKey] || []).find(x => x.id === docId);
      if (v) return openDocViewById(v.id, v.path, v.type, v.name, uid, catKey);
    }
  }
}

function _renderDocs(uid) {
  const container = document.getElementById('vm-docs-content') || document.getElementById('vm-docs-' + uid);
  if (!container) return;
  const docs = _docCache[uid] || {};
  const canEdit = isAdmin();
  // Timelines are painted after the container's innerHTML lands — their host
  // divs do not exist until then.
  const _docHistPending = [];
  const html = getDocCats().map(cat => {
    const versions = docs[cat.key] || [];
    const current = versions.find(v => v.isCurrent) || versions[0];
    const history = versions.filter(v => v !== current);
    const hasFile = !!current;
    const dateRaw = current && (current.uploadedAt || current.date || current.created || current.createdAt);
    const dateStr = dateRaw ? new Date(dateRaw).toLocaleDateString() : '';

    // Preview thumbnail (monochrome) or a neutral placeholder
    const preview = hasFile
      ? '<div class="docb-preview" onclick="event.stopPropagation();openDocVersion(' + current.id + ')">' +
          (current.type === 'pdf'
            ? '<div class="docb-pdf">PDF</div>'
            : '<img src="' + esc(current.path) + '" alt="" loading="lazy" decoding="async">') +
        '</div>'
      : '<div class="docb-preview docb-preview-empty">' +
          '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
        '</div>';

    // Complete details (monochrome rows)
    const detail = hasFile
      ? '<div class="docb-row"><span class="docb-k">' + t('doc_file')    + '</span><span class="docb-v" title="' + esc(current.name || '') + '">' + esc(current.name || '—') + '</span></div>' +
        '<div class="docb-row"><span class="docb-k">' + t('doc_type')    + '</span><span class="docb-v">' + esc((current.type || '').toUpperCase() || '—') + '</span></div>' +
        '<div class="docb-row"><span class="docb-k">' + t('doc_version') + '</span><span class="docb-v">v' + current.version + (versions.length > 1 ? ' · ' + versions.length + ' ' + t('doc_versions') : '') + '</span></div>' +
        (dateStr ? '<div class="docb-row"><span class="docb-k">' + t('doc_date') + '</span><span class="docb-v">' + esc(dateStr) + '</span></div>' : '')
      : '<div class="docb-none">' + t('doc_empty') + '</div>';

    // Older versions, as the same timeline used for worker and group history —
    // so "who uploaded this, and when" is finally visible instead of a bare "v2".
    // The handlers carry only the numeric doc id and look the rest up in
    // _docCache: inlining a file name would break on the first apostrophe.
    const histId = 'dochist-' + uid + '-' + cat.key;
    const histHtml = history.length
      ? '<details class="docb-history">' +
          '<summary class="docb-hist-summary">' + t('doc_history') +
            ' <span class="docb-hist-count">' + history.length + '</span>' +
          '</summary>' +
          '<div id="' + esc(histId) + '"></div>' +
        '</details>'
      : '';
    if (history.length) {
      _docHistPending.push({ id: histId, entries: history.map(v => ({
        action: 'uploaded',
        detail: v.name || '',
        by: v.uploadedBy,
        at: v.uploadedAt,
        badge: 'v' + v.version,
        onClick: 'openDocVersion(' + v.id + ')',
        extra: canEdit
          ? '<button class="hist-del" title="' + esc(t('doc_delete')) + '" onclick="event.stopPropagation();deleteDocById(event,' + v.id + ',\'' + esc(uid) + '\')">&#x2715;</button>'
          : '',
      })) });
    }

    const actions = canEdit
      ? '<div class="docb-actions">' +
          '<label class="docb-btn">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
            '<span>' + (hasFile ? t('doc_replace') : t('doc_add')) + '</span>' +
            '<input type="file" accept="image/*,application/pdf" style="display:none" onchange="handleDocUpload(this,\'' + uid + '\',\'' + cat.key + '\')">' +
          '</label>' +
          (hasFile ? '<button class="docb-btn docb-btn-del" onclick="deleteDocById(event,' + current.id + ',\'' + uid + '\')">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
            '<span>' + t('doc_delete') + '</span></button>' : '') +
        '</div>'
      : '';

    // Admins can click a box to make it the paste target (Ctrl+V) and drop files onto it.
    const dropAttrs = canEdit
      ? ' data-cat="' + esc(cat.key) + '"' +
        ' onclick="_setPasteTarget(\'' + esc(uid) + '\',\'' + esc(cat.key) + '\',this)"' +
        ' ondragover="event.preventDefault();this.classList.add(\'dragover\')"' +
        ' ondragleave="this.classList.remove(\'dragover\')"' +
        ' ondrop="_docDrop(event,\'' + esc(uid) + '\',\'' + esc(cat.key) + '\')"'
      : '';
    return '<div class="docb ' + (hasFile ? 'docb-has' : 'docb-no') + '"' + dropAttrs + '>' +
      preview +
      '<div class="docb-body">' +
        '<div class="docb-title">' + esc(cat.label) +
          '<span class="docb-badge ' + (hasFile ? 'on' : '') + '">' + (hasFile ? t('doc_uploaded') : t('doc_missing')) + '</span>' +
        '</div>' +
        '<div class="docb-detail">' + detail + '</div>' +
        histHtml +
        actions +
      '</div>' +
    '</div>';
  }).join('');

  const hint = canEdit
    ? '<div class="docb-paste-hint">' + bi('ຄລິກຊ່ອງ → Ctrl+V ວາງຮູບ · ຫຼື ລາກໄຟລ໌ມາວາງ', 'Click a box → Ctrl+V to paste · or drag a file in', 'คลิกช่อง → Ctrl+V วางรูป · หรือลากไฟล์มาวาง', '칸 클릭 → Ctrl+V로 붙여넣기 · 또는 파일 끌어다 놓기') + '</div>'
    : '';
  container.innerHTML = '<div class="vm-docs-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> ' + t('vc_documents') + '</div>' + hint + '<div class="docb-grid">' + html + '</div>';

  _docHistPending.forEach(h => renderHistory(h.id, h.entries));

  // Re-apply the paste-target highlight after a re-render (e.g. post-upload).
  if (_docPasteTarget && _docPasteTarget.uid === uid) {
    const el = container.querySelector('.docb[data-cat="' + (window.CSS && CSS.escape ? CSS.escape(_docPasteTarget.cat) : _docPasteTarget.cat) + '"]');
    if (el) el.classList.add('paste-target');
  }
}

function handleDocUpload(input, uid, cat) {
  const file = input.files && input.files[0];
  if (!file) return;
  input.value = '';
  _docUploadFile(file, uid, cat);
}

// Shared upload entry for a File/Blob — used by the file picker, paste (Ctrl+V)
// and drag-and-drop. Images go through the crop editor first (consistent format);
// PDFs upload directly.
function _docUploadFile(file, uid, cat) {
  if (!file || !uid || !cat) return;
  const type = file.type || '';
  const isPdf = type === 'application/pdf';
  const isImg = type.startsWith('image/');
  if (!isPdf && !isImg) { toast(bi('ຮັບສະເພາະຮູບ ຫຼື PDF', 'Images or PDF only', 'รองรับเฉพาะรูปหรือ PDF', '이미지 또는 PDF만 지원'), 'warn'); return; }
  _fileToDataURL(file, 1600, dataUrl => {
    if (isPdf) { _uploadDocData(uid, cat, dataUrl, 'pdf', file.name || 'document.pdf'); return; }
    // Photos: let the user zoom / crop / rotate to frame the document the SAME
    // way every time before it's stored — so documents from any device end up in
    // a consistent format (no fixed white frame needed at view time).
    _ceOpen({
      src: dataUrl, aspect: null, allowPick: false, mode: 'doc',
      title: bi('ປັບຮູບເອກະສານກ່ອນອັບໂຫລດ', 'Adjust the document image before uploading', 'ปรับรูปเอกสารก่อนอัปโหลด', '업로드 전 문서 이미지 조정'),
      onSave: (out) => _uploadDocData(uid, cat, out, 'image', file.name || ''),
    });
  });
}

// ── Paste (Ctrl+V) + drag-and-drop into a document box ──
// Click a document box to make it the active target, then Ctrl+V to paste a
// copied image. Dropping a file onto any box uploads straight to it.
let _docPasteTarget = null;   // { uid, cat }
function _setPasteTarget(uid, cat, el) {
  if (!isAdmin()) return;
  _docPasteTarget = { uid, cat };
  document.querySelectorAll('.docb.paste-target').forEach(d => d.classList.remove('paste-target'));
  if (el) el.classList.add('paste-target');
}
function _docDrop(e, uid, cat) {
  e.preventDefault(); e.stopPropagation();
  const box = e.currentTarget; if (box) box.classList.remove('dragover');
  if (!isAdmin()) return;
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) { _setPasteTarget(uid, cat, box); _docUploadFile(file, uid, cat); }
}
// While the detail drawer is open, swallow stray drag/drops so the browser never
// navigates away to a dropped file (the box handlers still process real drops).
['dragover', 'drop'].forEach(ev => document.addEventListener(ev, (e) => {
  const vo = document.getElementById('view-overlay');
  if (vo && vo.classList.contains('open')) e.preventDefault();
}));
document.addEventListener('paste', (e) => {
  if (!_docPasteTarget || !isAdmin()) return;
  const vo = document.getElementById('view-overlay');
  if (!vo || !vo.classList.contains('open')) return;
  // Skip if a stacked overlay (crop editor / doc viewer / export) is on top.
  if (document.querySelector('.overlay.open:not(#view-overlay)')) return;
  // Don't hijack a normal text paste into an input/textarea.
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.type && it.type.indexOf('image') === 0) {
      const blob = it.getAsFile();
      if (blob) { e.preventDefault(); _docUploadFile(blob, _docPasteTarget.uid, _docPasteTarget.cat); return; }
    }
  }
});

// Optimistic insert into the doc cache + background upload (shared by image and
// PDF paths).
function _uploadDocData(uid, cat, dataUrl, type, name) {
  _docCache[uid] = _docCache[uid] || {};
  const list = _docCache[uid][cat] = _docCache[uid][cat] || [];
  const ver  = list.reduce((m, v) => Math.max(m, v.version || 0), 0) + 1;
  list.forEach(v => { v.isCurrent = false; });
  list.unshift({ id: 'tmp-' + Date.now(), path: dataUrl, type, name: name || '',
                 version: ver, isCurrent: true, uploadedAt: new Date().toISOString() });
  _renderDocs(uid);
  if (_currentViewUid === uid) _refreshCmpBox(uid);
  toast(bi('ກຳລັງບັນທຶກ...', 'Saving…', 'กำลังบันทึก...', '저장 중…'), 'ok');
  DB.uploadDocument(uid, activeGroupId, cat, dataUrl, name || '')
    .then(() => _loadAndRenderDocs(uid))   // silent reconcile (real id/path)
    .catch(e => toast('Upload failed: ' + (e && e.message || e), 'err'));
}

async function deleteDocById(event, docId, uid) {
  if (event) event.stopPropagation();
  if (!isAdmin()) return;
  if (!window.confirm('Delete this document version?')) return;
  try { await DB.deleteDocument(docId); } catch (e) { toast('Delete failed', 'err'); return; }
  _loadAndRenderDocs(uid);
  toast('Document deleted', 'ok');
}

let _docView = null;   // { docId, path, type, name, uid, cat } for the in-place editor

function openDocViewById(docId, path, type, name, uid, cat) {
  _docView = { docId, path, type, name: name || '', uid: uid || '', cat: cat || '' };
  const body = document.getElementById('docview-body');
  if (!body) return;
  _docZoom = 0;   // reset zoom cycle for the new document

  // Pull the full version metadata from the cache when we can, so the details
  // tile beside the image shows file / type / version / date — not just a bare
  // picture. Falls back gracefully to whatever the caller handed us.
  let ver = null, catLabel = '';
  if (uid && cat && _docCache[uid] && _docCache[uid][cat]) {
    ver = _docCache[uid][cat].find(v => v.id === docId)
       || _docCache[uid][cat].find(v => v.isCurrent) || null;
  }
  if (cat) { const cd = getDocCats().find(c => c.key === cat); catLabel = cd ? cd.label : ''; }
  const dateRaw = ver && (ver.uploadedAt || ver.date || ver.created || ver.createdAt);
  const dateStr = dateRaw ? new Date(dateRaw).toLocaleDateString() : '';

  // Stage: the image always sits centred on a neutral background and scales to
  // fit whole (object-fit:contain), so a portrait ID and a wide passport line up
  // identically instead of one being cropped or skewed to a side.
  const stage = type === 'pdf'
    ? '<iframe class="docview-pdf" src="' + esc(path) + '"></iframe>'
    : '<img class="docview-img" src="' + esc(path) + '" alt="' + esc(name || '') + '" onclick="_docZoomCycle(event)" title="' + esc(bi('ຄລິກເພື່ອຊູມ', 'Click to zoom', 'คลิกเพื่อซูม', '클릭하여 확대')) + '">';

  const row = (k, v) => '<div class="docview-row"><span class="docview-k">' + esc(k) + '</span><span class="docview-v" title="' + esc(v) + '">' + esc(v) + '</span></div>';
  const rows =
    (catLabel ? row(bi('ໝວດ', 'Category', 'หมวด', '분류'), catLabel) : '') +
    row(t('doc_file'), name || '—') +
    row(t('doc_type'), (type || '').toUpperCase() || '—') +
    (ver ? row(t('doc_version'), 'v' + ver.version) : '') +
    (dateStr ? row(t('doc_date'), dateStr) : '');

  // The Edit/crop action only makes sense for an admin editing a real image
  // attached to a known worker + category (so we can upload the result back).
  const canEditDoc = (type === 'image' && uid && cat && isAdmin());
  const editAction = canEditDoc
    ? '<button class="docview-meta-btn" onclick="editCurrentDoc()">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>' +
        '<span>' + bi('ແກ້ໄຂ', 'Edit / Crop', 'แก้ไข/ครอป', '편집 / 자르기') + '</span></button>'
    : '';
  const zoomHint = type === 'image'
    ? '<div class="docview-meta-hint">' + bi('ຄລິກຮູບເພື່ອຊູມ', 'Click the image to zoom', 'คลิกรูปเพื่อซูม', '이미지를 클릭하면 확대') + '</div>'
    : '';

  body.innerHTML =
    '<div class="docview-stage">' + stage + '</div>' +
    '<aside class="docview-meta">' +
      '<div class="docview-meta-head">' + esc(catLabel || name || t('vc_documents')) + '</div>' +
      '<div class="docview-meta-rows">' + rows + '</div>' +
      editAction +
      zoomHint +
    '</aside>';

  // The details tile owns the edit action now; hide the legacy floating button.
  const editBtn = document.getElementById('docview-edit');
  if (editBtn) editBtn.style.display = 'none';
  openOverlay('docview-overlay');
}

// Click-to-zoom cycle on the document image: fit -> 2x -> 3.5x -> fit. The first
// zoom centres on the clicked point (zooms toward what they want to read); the
// next click zooms further on the same spot; the third resets to fit.
let _docZoom = 0;
const _DOC_ZOOM = [1, 2, 3.5];
function _docZoomCycle(e) {
  e.stopPropagation();
  const img = e.currentTarget;
  _docZoom = (_docZoom + 1) % _DOC_ZOOM.length;
  const scale = _DOC_ZOOM[_docZoom];
  if (_docZoom === 1) {   // entering zoom from fit -> aim at the clicked point
    const r = img.getBoundingClientRect();
    const ox = Math.max(0, Math.min(100, (e.clientX - r.left) / r.width  * 100));
    const oy = Math.max(0, Math.min(100, (e.clientY - r.top)  / r.height * 100));
    img.style.transformOrigin = ox + '% ' + oy + '%';
  }
  if (scale === 1) {
    img.style.transform = '';
    img.style.transformOrigin = '';
    img.classList.remove('zoomed');
  } else {
    img.style.transform = 'scale(' + scale + ')';
    img.classList.add('zoomed');
  }
}

// Re-crop / fix the currently-previewed document, then save it as a new version.
function editCurrentDoc() {
  if (!_docView || _docView.type !== 'image' || !_docView.uid || !_docView.cat) return;
  const { path, uid, cat, name } = _docView;
  _ceOpen({
    src: path, aspect: null, allowPick: false, mode: 'doc',   // free crop; whole doc visible by default
    title: bi('ແກ້ໄຂເອກະສານ', 'Edit document', 'แก้ไขเอกสาร', '문서 편집'),
    onSave: (dataUrl) => {
      closeOverlay('docview-overlay');
      toast(bi('ກຳລັງບັນທຶກ...', 'Saving…', 'กำลังบันทึก...', '저장 중…'), 'ok');
      DB.uploadDocument(uid, activeGroupId, cat, dataUrl, name || (cat + '.jpg'))
        .then(() => { _loadAndRenderDocs(uid); toast(bi('ບັນທຶກແລ້ວ', 'Saved', 'บันทึกแล้ว', '저장됨'), 'ok'); })
        .catch(e => toast('Save failed: ' + (e && e.message || e), 'err'));
    },
  });
}

// kept for backward compat (old in-memory doc references)
function openDocView(uid, cat, idx) {
  const g = DB.getGroup(activeGroupId);
  const w = g && g.workers.find(x => x.uid === uid);
  const f = w && w.documents && w.documents[cat] && w.documents[cat][idx];
  if (!f) return;
  openDocViewById(0, f.data, f.type, f.name);
}

// ── DOCUMENT SCAN (icon menu in the worker form) ──────────────────
function _scanLabel(cat) {
  const M = {
    form_1:   bi('ແບບຟອມສະໝັກ','Application form','แบบฟอร์มสมัคร','신청서'),
    id_card:  bi('ບັດປະຈຳຕົວ','ID card','บัตรประชาชน','신분증'),
    passport: bi('ພາສປອດ','Passport','พาสปอร์ต','여권'),
    land_doc: bi('ໃບຕາດິນ','Land deed','โฉนดที่ดิน','토지 증서'),
  };
  return M[cat];
}

function toggleScanMenu(e) { if (e) e.stopPropagation(); document.getElementById('scan-type-menu')?.classList.toggle('open'); }
function closeScanMenu()   { document.getElementById('scan-type-menu')?.classList.remove('open'); }

function startScan(cat) {
  closeScanMenu();
  // Passport → the real camera + MRZ scanner (offline OCR)
  if (cat === 'passport' && typeof openPassportScan === 'function') { openPassportScan(); return; }
  // Other docs → generic capture (AI/Google extraction is mocked for now)
  _genericDocScan(cat);
}

// Capture or pick an image/PDF: attach it as the chosen document AND try AI
// extraction (Google Gemini) to auto-fill the form. Falls back to attach-only
// when no GEMINI_API_KEY is configured on the server (mockup).
function _genericDocScan(cat) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*,application/pdf';
  inp.setAttribute('capture', 'environment');   // prefer the rear camera on mobile
  inp.onchange = () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    _fileToDataURL(file, 1400, async dataUrl => {
      const type = file.type === 'application/pdf' ? 'pdf' : 'image';
      window._pendingScanDocs = window._pendingScanDocs || [];
      window._pendingScanDocs.push({ cat, name: cat + '-scan.' + (type === 'pdf' ? 'pdf' : 'jpg'), type, data: dataUrl });
      if (typeof renderFormDocList === 'function') renderFormDocList();
      toast((_scanLabel(cat) || cat) + bi(' — ແນບແລ້ວ',' — attached',' — แนบแล้ว',' — 첨부됨'), 'ok');

      // Try AI extraction (server holds the API key)
      try {
        const r = await DB.aiExtract(dataUrl, cat);
        if (r && r.mock) {
          toast(bi('🤖 AI extraction: mockup — ໃສ່ GEMINI_API_KEY ເພື່ອໃຊ້ງານ','🤖 AI extraction: mockup — set GEMINI_API_KEY to enable','🤖 AI extraction: ตัวอย่าง — ใส่ GEMINI_API_KEY เพื่อเปิดใช้','🤖 AI 추출: 목업 — GEMINI_API_KEY를 설정하면 활성화'), 'info');
        } else if (r && r.ok && r.data) {
          _applyAiToForm(cat, r.data);
          toast(bi('🤖 AI ຕື່ມຂໍ້ມູນໃຫ້ແລ້ວ','🤖 AI auto-filled','🤖 AI กรอกข้อมูลให้แล้ว','🤖 AI가 자동 입력함'), 'ok');
        } else if (r && r.error) {
          toast('AI: ' + r.error, 'warn');
        }
      } catch (e) { /* ignore — file is still attached */ }
    });
  };
  inp.click();
}

// Map an AI extraction result onto the open worker form (only fills blanks → never overwrites)
function _applyAiToForm(cat, d) {
  if (!d) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el && v && !el.value) el.value = v; };
  const toDMY = s => { const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec((s || '').trim()); return m ? (m[3].padStart(2,'0') + '/' + m[2].padStart(2,'0') + '/' + m[1]) : ''; };
  const setSex = v => { const s = document.getElementById('f-sex'); if (s && !s.value && v) s.value = /^f/i.test(v) ? 'F' : /^m/i.test(v) ? 'M' : ''; };
  const setDate = (dp, v) => { const dmy = toDMY(v); if (dmy && !_dateInputVal(dp.replace('dp-','f-'))) setDatePicker(dp, dmy); };

  if (cat === 'passport') {
    set('f-passport-no', (d.passport_number || '').toUpperCase());
    set('f-en-name', ([d.given_names, d.surname].filter(Boolean).join(' ') || d.full_name || '').toUpperCase());
    set('f-nationality', (d.nationality || d.country_code || '').toUpperCase());
    setSex(d.sex);
    setDate('dp-dob', d.date_of_birth);
    setDate('dp-issue', d.date_of_issue);
    setDate('dp-expiry', d.expiry_date);
  } else if (cat === 'id_card') {
    set('f-en-name', (d.full_name || '').toUpperCase());
    set('f-lo-name', d.full_name_local);
    set('f-nationality', (d.nationality || '').toUpperCase());
    set('f-village', d.address);
    setSex(d.sex);
    setDate('dp-dob', d.date_of_birth);
  } else if (cat === 'form_1') {
    set('f-en-name', (d.full_name_en || '').toUpperCase());
    set('f-lo-name', d.full_name_local);
    set('f-passport-no', (d.passport_number || '').toUpperCase());
    set('f-nationality', (d.nationality || '').toUpperCase());
    set('f-village', d.village || d.address);
    set('f-district', d.district);
    set('f-province', d.province);
    set('f-tel', d.tel);
    set('f-emg-tel', d.emergency_tel);
    set('f-education', d.education);
    setSex(d.sex);
    setDate('dp-dob', d.date_of_birth);
  }
}

// back-compat
function scanForDoc(cat) { startScan(cat); }

// ── Worker form: attach documents during creation/edit ────────────
function populateFormDocCats() {
  const sel = document.getElementById('f-doc-cat'); if (!sel) return;
  sel.innerHTML = getDocCats().map(c => '<option value="' + esc(c.key) + '">' + esc(c.label) + '</option>').join('');
}
function addFormDoc(input) {
  const file = input.files && input.files[0]; if (!file) return;
  input.value = '';
  const cat = (document.getElementById('f-doc-cat') || {}).value || 'form_1';
  _fileToDataURL(file, 1600, dataUrl => {
    const type = file.type === 'application/pdf' ? 'pdf' : 'image';
    window._pendingScanDocs = window._pendingScanDocs || [];
    window._pendingScanDocs.push({ cat, name: file.name || (cat + '.' + (type === 'pdf' ? 'pdf' : 'jpg')), type, data: dataUrl });
    renderFormDocList();
    toast((file.name || 'document'), 'ok');
  });
}
function renderFormDocList() {
  const el = document.getElementById('f-doc-list'); if (!el) return;
  const docs = window._pendingScanDocs || [];
  const catLabel = k => (getDocCats().find(c => c.key === k) || {}).label || k;
  el.innerHTML = docs.map((d, i) =>
    '<div class="form-doc-item">' +
      '<span class="fdoc-cat">' + esc(catLabel(d.cat)) + '</span>' +
      '<span class="fdoc-name">' + esc(d.name || '') + '</span>' +
      '<button type="button" class="fdoc-del" onclick="removeFormDoc(' + i + ')" title="Remove">&#x2715;</button>' +
    '</div>').join('');
}
function removeFormDoc(i) {
  if (!window._pendingScanDocs) return;
  window._pendingScanDocs.splice(i, 1);
  renderFormDocList();
}

// ── WORKER FORM ───────────────────────────────────────────────────
function openWorkerForm(editUid) {
  if (!isAdmin()) return;
  if (editUid) _ensureGroupFor(editUid);   // point activeGroupId at the worker's group (cross-group views)
  populateCityDropdowns();
  /* NB: 'blood' and 'supervisor' are deliberately absent from this list — their
   * form fields are #fm-blood and #w-supervisor. `f-blood` and `f-supervisor`
   * are the toolbar FILTERS, and clearing them here wiped the user's filter
   * every time the form opened. Same collision, found twice: anything named
   * `f-…` here reaches the filter bar, not the form. */
  const fids = ['worker-id','employer-code','en-name','lo-name',
                'province','district','village','nationality','sex','hand','weight','height','size','couple',
                'tel','emg-tel','passport-no','kr-city','la-city',
                'grade','visa-status','education','work-experience','languages'];
  fids.forEach(f => { const el = document.getElementById('f-' + f); if (el) el.value = ''; });
  { const sup = document.getElementById('w-supervisor'); if (sup) sup.value = ''; }
  _ensureSelectValue('fm-blood', '');
  setDatePicker('dp-dob', '');
  setDatePicker('dp-issue', '');
  setDatePicker('dp-expiry', '');
  document.getElementById('f-edit-uid').value = '';
  document.getElementById('f-photo').value = '';
  window._pendingScanDoc = null;
  window._pendingScanDocs = [];
  populateFormDocCats();
  renderFormDocList();
  renderFormPhoto();
  document.getElementById('fm-title').textContent = t('fm_add_worker');
  _widManual    = false;
  _editLocNames = null;

  if (!editUid) {
    document.getElementById('f-worker-id').value = _genWorkerId();
  }

  if (editUid) {
    const g = DB.getGroup(activeGroupId);
    const w = g && g.workers.find(x => x.uid === editUid);
    if (!w) return;
    document.getElementById('fm-title').textContent = t('fm_edit_worker');
    document.getElementById('f-edit-uid').value        = editUid;
    document.getElementById('f-photo').value           = w.photo || '';
    renderFormPhoto();
    const krCityLoad = document.getElementById('f-kr-city');
    if (krCityLoad) krCityLoad.value = w.kr_city || '';
    document.getElementById('f-la-city').value         = w.la_city || '';
    document.getElementById('f-worker-id').value       = w.worker_id || '';
    document.getElementById('f-employer-code').value   = w.employer_code || '';
    document.getElementById('w-supervisor').value      = w.group_supervisor || '';
    { const ac = document.getElementById('f-assign-code'); if (ac) ac.value = w.assign_code || ''; }
    document.getElementById('f-en-name').value         = w.en_name || '';
    document.getElementById('f-lo-name').value         = w.lo_name || '';
    setDatePicker('dp-dob', w.dob || '');
    document.getElementById('f-province').value        = w.province || '';
    document.getElementById('f-district').value        = w.district || '';
    document.getElementById('f-village').value         = w.village || '';
    _editLocNames = { 0: w.province || '', 1: w.district || '', 2: w.village || '' };
    document.getElementById('f-nationality').value     = w.nationality || '';
    document.getElementById('f-sex').value              = w.sex || '';
    _ensureSelectValue('fm-blood', w.blood);   // keep an out-of-list legacy value selectable
    document.getElementById('f-hand').value            = w.hand || '';
    document.getElementById('f-weight').value          = w.weight || '';
    document.getElementById('f-height').value          = w.height || '';
    _ensureSelectValue('f-size', w.size);
    document.getElementById('f-couple').value          = w.couple || '';
    document.getElementById('f-tel').value             = w.tel || '';
    document.getElementById('f-emg-tel').value         = w.emg_tel || '';
    document.getElementById('f-passport-no').value     = w.passport_no || '';
    setDatePicker('dp-issue',  w.passport_issue || '');
    setDatePicker('dp-expiry', w.passport_expiry || '');
    document.getElementById('f-grade').value           = _normGrade(w.grade);   // legacy "B" → "B+"
    document.getElementById('f-visa-status').value     = w.visa_status || '';
    document.getElementById('f-education').value       = w.education || '';
    document.getElementById('f-work-experience').value = w.work_experience || '';
    document.getElementById('f-languages').value       = w.languages || '';
  }
  renderFormLocation();
  if (!editUid) regenWorkerId();
  updateIdPreview();
  // The fills above set <select>.value directly (no change event), so the tile
  // groups that shadow those selects have to be redrawn from the new values.
  bcSyncAll();
  openOverlay('form-overlay');
}

// ── CONTACT ID GENERATION ─────────────────────────────────────────
// Populate the Korean / Lao city <select>s from the dictionary.
function populateCityDropdowns() {
  const cities = DB.getCities();
  const opt = c => '<option value="' + esc(c.code) + '">' + esc(c.name) + ' (' + esc(c.code) + ')</option>';
  const sel = '<option value="">' + t('fm_select') + '</option>';
  const krEl = document.getElementById('f-kr-city');
  if (krEl) krEl.innerHTML = sel + (cities.kr || []).map(opt).join('');
  document.getElementById('f-la-city').innerHTML = sel + (cities.la || []).map(opt).join('');
}

function updateIdPreview() {}
function regenerateId() { regenWorkerId(true); }

// Which short code feeds the auto worker_id, read from the form's selection.
function _idSourceCode(ld) {
  const src = (ld && ld.idConfig && ld.idConfig.source) || 'la';
  if (src === 'la' || src === 'kr') {
    const el = document.getElementById('f-' + src + '-city');
    return el ? (el.value || '').trim().toUpperCase() : '';
  }
  const sel = document.getElementById('locsel-' + src);   // a level id
  if (sel && sel.value) {
    const it = ld.items.find(x => x.id === sel.value);
    return it ? it.code : '';
  }
  return '';
}

// Build the next worker_id. Prefers the configurable CODE-YY-NNN format
// (Location Dictionary); otherwise the legacy group-based format.
function _genWorkerId() {
  const ld = DB.getLocDict();
  const code = _idSourceCode(ld);
  if (code) {
    const yy = String(new Date().getFullYear()).slice(-2);
    const prefix = code + '-' + yy + '-';
    const seq = DB.workerSeqForPrefix(prefix, ld.idConfig.seqStart);
    return prefix + String(seq).padStart(ld.idConfig.seqPad, '0');
  }
  // ── Legacy fallback: SITE-PROV-DDMMYY-NNN scoped to the group ──
  const g = DB.getGroup(activeGroupId);
  const dist = ((g && g.site_code)     || '').trim().toUpperCase();
  const prov = ((g && g.province_code) || '').trim().toUpperCase();
  if (!dist && !prov) return '';
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(-2);
  const prefix = [dist, prov, dd + mm + yy].filter(Boolean).join('-') + '-';
  let max = 0;
  DB.getWorkers(activeGroupId).forEach(w => {
    if (w.worker_id && w.worker_id.startsWith(prefix)) {
      const n = parseInt(w.worker_id.slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  });
  return prefix + String(max + 1).padStart(3, '0');
}

// Re-fill the Worker ID unless the user has typed their own (force overrides).
let _widManual = false;
function regenWorkerId(force) {
  const idEl = document.getElementById('f-worker-id');
  if (!idEl) return;
  if (document.getElementById('f-edit-uid').value) return;   // never overwrite when editing
  if (_widManual && !force) return;
  const v = _genWorkerId();
  if (v) idEl.value = v;
  if (force) _widManual = false;
  checkWorkerIdDup(idEl.value);
}
function onWorkerIdInput(el) {
  if (typeof el === 'string') { _widManual = true; checkWorkerIdDup(el); return; }   // legacy callers
  _applyLiveFormat(el, liveFormatWorkerId);
  _widManual = true;
  checkWorkerIdDup(el.value);
}
function onPhoneInput(el) { if (el) _applyLiveFormat(el, liveFormatPhone); }

// ── FORMAT NORMALISERS (Worker ID + phone) ────────────────────────
// Canonical Worker ID = CODE-YY-NNN (dashes, 3-digit sequence). Accepts any
// separator the user types (":", spaces, none) and reformats. Leaves anything
// that doesn't fit the pattern untouched so odd IDs aren't mangled.
function normalizeWorkerId(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return '';
  const m = s.match(/^([A-Z]+)[\s:_.\-]*(\d{2})[\s:_.\-]*(\d{1,})$/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3].padStart(3, '0');
  return s;
}
function normalizeWorkerIdField() {
  const el = document.getElementById('f-worker-id');
  if (!el) return;
  const norm = normalizeWorkerId(el.value);
  if (norm !== el.value) el.value = norm;
  checkWorkerIdDup(el.value);
}

// Canonical phone = 020-XXX-XXX-XX (3-3-3-2) for 11-digit Lao numbers.
// Other lengths are left as the user typed them (no wrong grouping).
function normalizePhone(raw) {
  const s = String(raw || '').trim();
  const digits = s.replace(/\D/g, '');
  if (digits.length === 11) return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1-$2-$3-$4');
  return s;
}
function normalizePhoneField(id) {
  const el = document.getElementById(id);
  if (el) el.value = normalizePhone(el.value);
}

// ── LIVE (as-you-type) formatting — inserts dashes while typing and keeps the
// caret in the right spot by counting alphanumerics before it. ─────────────
function _applyLiveFormat(el, fmt) {
  if (!el) return;
  const sig = el.value.slice(0, el.selectionStart || 0).replace(/[^0-9A-Za-z]/g, '').length;
  const formatted = fmt(el.value);
  if (formatted === el.value) return;
  el.value = formatted;
  let pos = 0, count = 0;
  while (pos < formatted.length && count < sig) {
    if (/[0-9A-Za-z]/.test(formatted[pos])) count++;
    pos++;
  }
  try { el.setSelectionRange(pos, pos); } catch (e) {}
}
// Worker ID while typing: CODE-YY-SEQ (no zero-padding yet — blur pads to 3).
function liveFormatWorkerId(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = s.match(/^([A-Z]*)(\d{0,2})(\d*)$/);
  if (!m || !m[1]) return s;                 // no letter prefix yet → leave digits
  let out = m[1];
  if (m[2]) out += '-' + m[2];
  if (m[3]) out += '-' + m[3];
  return out;
}
// Phone while typing: 020-XXX-XXX-XX (3-3-3-2); extra digits append raw.
function liveFormatPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  let out = d.slice(0, 3);
  if (d.length > 3) out += '-' + d.slice(3, 6);
  if (d.length > 6) out += '-' + d.slice(6, 9);
  if (d.length > 9) out += '-' + d.slice(9, 11);
  if (d.length > 11) out += d.slice(11);
  return out;
}

// ── Karaoke-style romanization (Lao + Thai → Latin), offline & approximate ──
// Drops tone marks, re-orders pre-posed vowels (เ/แ/ເ/ແ…) after their
// consonant, then maps phonetically. Not linguistically exact — readable and
// editable. Latin/other input is returned unchanged.
const romanizePlace = (() => {
  const cons = {
    // Thai consonants
    'ก':'k','ข':'kh','ฃ':'kh','ค':'kh','ฅ':'kh','ฆ':'kh','ง':'ng','จ':'ch','ฉ':'ch','ช':'ch','ซ':'s','ฌ':'ch',
    'ญ':'y','ฎ':'d','ฏ':'t','ฐ':'th','ฑ':'th','ฒ':'th','ณ':'n','ด':'d','ต':'t','ถ':'th','ท':'th','ธ':'th','น':'n',
    'บ':'b','ป':'p','ผ':'ph','ฝ':'f','พ':'ph','ฟ':'f','ภ':'ph','ม':'m','ย':'y','ร':'r','ล':'l','ว':'w','ศ':'s',
    'ษ':'s','ส':'s','ห':'h','ฬ':'l','ฮ':'h',
    // Lao consonants. ຊ is 'x', not 's' — that is the standard Lao convention and
    // the one the app's own place names already follow (ໄຊຍະບູລີ → Xayaboury).
    'ກ':'k','ຂ':'kh','ຄ':'kh','ງ':'ng','ຈ':'ch','ສ':'s','ຊ':'x','ຍ':'ny','ດ':'d','ຕ':'t','ຖ':'th','ທ':'th',
    'ນ':'n','ບ':'b','ປ':'p','ຜ':'ph','ຝ':'f','ພ':'ph','ຟ':'f','ມ':'m','ຢ':'y','ຣ':'r','ລ':'l','ວ':'v','ຫ':'h',
    'ຮ':'h','ໜ':'n','ໝ':'m',
  };
  const vow = {
    // Thai vowels (อ acts as the 'o' vowel between consonants)
    'ะ':'a','ั':'a','า':'a','ๅ':'a','ิ':'i','ี':'i','ึ':'ue','ื':'ue','ุ':'u','ู':'u','ฤ':'rue','ฦ':'lue','ำ':'am',
    'อ':'o','เ':'e','แ':'ae','โ':'o','ใ':'ai','ไ':'ai','ๆ':'',
    // Lao vowels (ອ acts as 'o'). ຸ/ູ romanise to 'ou', not 'u' — again the Lao
    // convention, and what the existing records use (ສຸກສາລາ → Souksala).
    'ະ':'a','ັ':'a','າ':'a','ິ':'i','ີ':'i','ຶ':'ue','ື':'ue','ຸ':'ou','ູ':'ou','ໍ':'o','ົ':'o','ຳ':'am','ຽ':'ia',
    'ອ':'o','ເ':'e','ແ':'ae','ໂ':'o','ໃ':'ai','ໄ':'ai',
  };
  const drop = /[็่้๊๋์ํ๎່້໊໋໌຺ຼ]/g;  // tone/silent/ligature marks
  const consClass = '[' + Object.keys(cons).join('') + ']';
  const reorder  = new RegExp('([เแโใไເແໂໃໄ])(' + consClass + ')', 'g');
  const silentH  = new RegExp('[หຫ](?=' + consClass + ')', 'g');   // leading ห/ຫ before a consonant is silent
  // Clusters the char-by-char mapper cannot get right, because they hinge on a
  // tone mark that gets stripped, or on ວ/ຍ acting as a vowel rather than a
  // consonant. Matched BEFORE tone-drop (the mark is what disambiguates, e.g.
  // ຫ້ວຍ "houay" = stream vs ຫວານ "van" = sweet) and emitted as Latin, which the
  // char loop passes through untouched. Longest first.
  const clusters = [
    [/ຫ້ວຍ/g, 'houay'], [/ຫວ້ຍ/g, 'houay'],      // stream — the most common village prefix
    [/ສະຫງວນ/g, 'sanguan'], [/ຫງວນ/g, 'nguan'],
    [/ຄວາຍ/g, 'khouay'], [/ຄວາ/g, 'khoua'], [/ຂວາ/g, 'khoua'],
    [/ຫຼວງ/g, 'louang'], [/ຫລວງ/g, 'louang'],
    [/ເຂົາ/g, 'khao'], [/ເລົາ/g, 'lao'],
    [/ແກ້ວ/g, 'keo'],
    [/ບວມ/g, 'bouam'], [/ນວມ/g, 'nouam'],
    // ຫ before ວ is a silent tone marker, so the pair is just 'v' (ຫວານ → van).
    // Emitted here rather than left to silentH, which would strip the ຫ and let
    // the ວ rule below mistake the ວ for a syllable-final 'o'.
    [/ຫວ/g, 'v'],
  ];
  function one(tok) {
    let s = tok;
    for (const [re, to] of clusters) s = s.replace(re, to);
    s = s.replace(/ຫຼ/g, 'ລ')               // Lao lo-ligature → l
         .replace(drop, '')                 // strip tones
         .replace(reorder, '$2$1')          // move pre-posed vowels after their consonant
         .replace(silentH, '');             // drop silent leading h
    const chars = [...s];
    let out = '';
    chars.forEach((ch, i) => {
      const prev = chars[i - 1], next = chars[i + 1];
      // ວ is only the consonant 'v' when it opens a syllable. After a consonant
      // it is the "oua" medial (ຄວາຍ → khouay); after a vowel it either opens a
      // new syllable when a vowel follows (ສຸວັນ → souvan) or closes this one
      // as 'o' (ຂາວ → khao, ກິ່ວ → kio).
      if (ch === 'ວ') {
        if (!prev)                           out += 'v';
        else if (cons[prev] !== undefined)   out += 'ou';
        else if (next && vow[next] !== undefined) out += 'v';
        else                                 out += 'o';
      }
      // ຍ is 'ny' as an initial but a plain 'y' once a vowel precedes it (ຊາຍ → say).
      else if (ch === 'ຍ')                   out += (prev && vow[prev] !== undefined) ? 'y' : 'ny';
      // Lao stops de-voice when they close a syllable: ດ → 't', ບ → 'p'
      // (ສະຫວັນນະເຂດ → Savannakhet, ຫາດ → Hat).
      else if ((ch === 'ດ' || ch === 'ບ') && prev && (!next || cons[next] !== undefined))
        out += (ch === 'ດ') ? 't' : 'p';
      else if (cons[ch] !== undefined)       out += cons[ch];
      else if (vow[ch] !== undefined)        out += vow[ch];
      else if (/[A-Za-z0-9]/.test(ch))       out += ch;        // keep existing Latin/digits
    });
    return out ? out.charAt(0).toUpperCase() + out.slice(1) : out;
  }
  return function (text) {
    if (!text) return '';
    if (!/[฀-໿]/.test(text)) return text;            // no Thai/Lao → leave as-is
    return text.split(/(\s+)/).map(t => /^\s+$/.test(t) ? ' ' : one(t)).join('').trim();
  };
})();

// Romanize a place field on blur (only if it contains Thai/Lao script).
function romanizeAddrField(id) {
  const el = document.getElementById(id);
  if (el) el.value = romanizePlace(el.value);
}
// Dictionary item: auto-fill the English name from the Lao name if EN is empty.
function locAutofillEn(loEl) {
  const en = document.getElementById('locdict-item-en');
  if (en && !en.value.trim() && loEl && loEl.value.trim()) en.value = romanizePlace(loEl.value);
}

// Admin: reformat EVERY existing record's Worker ID + phone numbers to the
// canonical format. Backs up the database first so the change is reversible.
function formatAllRecords() {
  if (!isAdmin()) return;
  showConfirm(
    bi('ຈັດຮູບແບບຂໍ້ມູນທັງໝົດ?','Reformat all records?','จัดรูปแบบข้อมูลทั้งหมด?','모든 레코드를 정리할까요?'),
    bi('ຈະສຳຮອງຖານຂໍ້ມູນກ່ອນ ແລ້ວຈັດ Worker ID + ເບີໂທ ຂອງທຸກຄົນໃຫ້ເປັນຮູບແບບມາດຕະຖານ (CODE-YY-NNN, 020-XXX-XXX-XX).',
       'Backs up the database first, then normalizes everyone\'s Worker ID + phone numbers to the standard format (CODE-YY-NNN, 020-XXX-XXX-XX).',
       'จะสำรองฐานข้อมูลก่อน แล้วจัด Worker ID + เบอร์โทรของทุกคนให้เป็นรูปแบบมาตรฐาน (CODE-YY-NNN, 020-XXX-XXX-XX)',
       '먼저 데이터베이스를 백업한 뒤 모든 근로자 ID·전화번호를 표준 형식으로 정리합니다 (CODE-YY-NNN, 020-XXX-XXX-XX).'),
    async () => {
      try { await DB.backup(); } catch (e) { /* backup is best-effort; continue */ }
      let n = 0;
      DB.getGroups().forEach(g => {
        (g.workers || []).forEach(w => {
          const patch = {};
          if (w.worker_id) { const v = normalizeWorkerId(w.worker_id); if (v !== w.worker_id) patch.worker_id = v; }
          if (w.tel)       { const v = normalizePhone(w.tel);          if (v !== w.tel)       patch.tel = v; }
          if (w.emg_tel)   { const v = normalizePhone(w.emg_tel);      if (v !== w.emg_tel)   patch.emg_tel = v; }
          if (Object.keys(patch).length) { DB.updateWorker(g.id, w.uid, patch); n++; }
        });
      });
      toast(bi('ຈັດຮູບແບບແລ້ວ ' + n + ' ລາຍການ', 'Reformatted ' + n + ' records', 'จัดรูปแบบแล้ว ' + n + ' รายการ', n + '개 정리됨'), 'ok');
      refreshAll();
    }
  );
}

// ── WORKER FORM: cascading Location Dictionary selects ────────────
let _editLocNames = null;
// A level writes to the column named by its own `col` — never to whatever its
// position implies. Position used to decide this, so reordering or deleting a
// level silently re-pointed it: with Village dragged to the top, a village name
// was saved as the province. `col` is normalised/pinned in db.js.
function _locInputFor(lv) {
  const el = lv && lv.col ? document.getElementById('f-' + lv.col) : null;
  return el || null;
}

// Item label in the user's current language (falls back to English / any).
function _locName(it, lang) {
  if (!it) return '';
  const n = it.names || {};
  lang = lang || (typeof currentLang !== 'undefined' ? currentLang : 'en');
  return n[lang] || n.en || n.lo || n.th || n.ko || '';
}
// English is the canonical value stored on the worker + shown on records.
function _locEnName(it) { return it ? ((it.names && it.names.en) || _locName(it, 'en')) : ''; }

function renderFormLocation() {
  const ld        = DB.getLocDict();
  const selBlock  = document.getElementById('loc-select-block');
  const comboBlock= document.getElementById('loc-combo-block');
  if (!selBlock || !comboBlock) return;
  if (!ld.enabled || !ld.levels.length) {            // feature off → free-text address
    selBlock.style.display = 'none'; selBlock.innerHTML = '';
    comboBlock.style.display = '';
    return;
  }
  comboBlock.style.display = 'none';
  selBlock.style.display = '';
  // A level with no items anywhere (e.g. the empty Village level in the seeded
  // dictionary) renders as a free-text input, so a Province+District-only
  // hierarchy stays fully usable and villages can still be typed.
  selBlock.innerHTML = ld.levels.map((lv, i) => {
    // Free-text levels keep the same combobox the plain address form has, so the
    // typist sees what everyone else already entered and reuses that spelling
    // instead of inventing a new one.
    const control = _locLevelHasItems(ld, lv.id)
      ? '<select class="addr-input loc-select" id="locsel-' + esc(lv.id) + '" onchange="onLocSelect(' + i + ')"></select>'
      : '<div class="addr-combo">' +
          '<input class="addr-input loc-free" id="locfree-' + i + '" autocomplete="off"' +
            ' oninput="_writeLocFree(' + i + ')" onblur="_locFreeBlur(' + i + ')">' +
          '<div class="addr-combo-list" id="locfree-list-' + i + '" style="display:none"></div>' +
        '</div>';
    return '<div class="addr-field"><label class="addr-lbl">' + esc(lv.name) + '</label>' + control + '</div>';
  }).join('');
  for (let i = 0; i < ld.levels.length; i++) {
    const lv  = ld.levels[i];
    const pre = _editLocNames ? (_editLocNames[i] || '') : '';
    if (_locLevelHasItems(ld, lv.id)) {
      _fillLocSelect(i, pre);
    } else {
      const inp = document.getElementById('locfree-' + i);
      const col = _locInputFor(lv);
      if (inp) { inp.value = pre || (col ? col.value : '') || ''; _writeLocFree(i); }
      // Re-bind every render: innerHTML above replaced the element and its listeners.
      initAddrCombobox('locfree-' + i, 'locfree-list-' + i, () => _collectAddrField(lv.col));
    }
  }
}

// Free-text level lost focus → romanise Lao to English (places are stored in
// English canonically) and mirror into the address column.
function _locFreeBlur(i) {
  const inp = document.getElementById('locfree-' + i);
  if (inp) inp.value = romanizePlace(inp.value);
  _writeLocFree(i);
}

function _locLevelHasItems(ld, levelId) { return ld.items.some(it => it.levelId === levelId); }

// Free-text level (e.g. Village) → mirror the typed value into its address column.
function _writeLocFree(i) {
  const inp = document.getElementById('locfree-' + i);
  const col = _locInputFor(DB.getLocDict().levels[i]);
  if (inp && col) col.value = inp.value.trim();
}

function _fillLocSelect(i, preselectName) {
  const ld = DB.getLocDict();
  const lv = ld.levels[i];
  if (!lv) return;
  const sel = document.getElementById('locsel-' + lv.id);
  if (!sel) return;                       // free-text level → handled by _writeLocFree
  let parentId = null;
  if (i > 0) {
    const pl = ld.levels[i - 1];
    const ps = pl && document.getElementById('locsel-' + pl.id);
    parentId = ps ? ps.value : '';
  }
  const items = ld.items
    .filter(it => it.levelId === lv.id && (i === 0 || it.parentId === parentId))
    .sort((a, b) => a.order - b.order);
  sel.innerHTML = '<option value="">' + t('fm_select') + '</option>' +
    items.map(it => '<option value="' + esc(it.id) + '">' +
      esc(_locName(it)) + (it.code ? ' (' + esc(it.code) + ')' : '') + '</option>').join('');
  if (preselectName) {
    // Stored value is the English name; also tolerate any-language match for old
    // data, then a case/spacing-insensitive pass (existing records are a mix of
    // Lao script, UPPERCASE and Title Case — e.g. "THOULAKHOM" vs "Thoulakhom").
    const norm   = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const target = norm(preselectName);
    const match = items.find(it => _locEnName(it) === preselectName)
               || items.find(it => [it.names.en, it.names.lo, it.names.th, it.names.ko].includes(preselectName))
               || items.find(it => [it.names.en, it.names.lo, it.names.th, it.names.ko].some(n => n && norm(n) === target));
    if (match) sel.value = match.id;
    else {
      // Value not in the dictionary → keep it as a one-off option so opening +
      // saving an old record never blanks the address out.
      sel.insertAdjacentHTML('beforeend',
        '<option value="__raw__' + esc(preselectName) + '" selected>' + esc(preselectName) + '</option>');
    }
  }
  _writeLocInput(i);
}

function _writeLocInput(i) {
  const ld  = DB.getLocDict();
  const lv  = ld.levels[i];
  const inp = _locInputFor(lv);
  if (!lv || !inp) return;
  const sel = document.getElementById('locsel-' + lv.id);
  if (!sel) return;                                    // free-text level writes its own column
  if (sel.value.indexOf('__raw__') === 0) { inp.value = sel.value.slice(7); return; }   // preserved old value
  const it = ld.items.find(x => x.id === sel.value);
  inp.value = it ? _locEnName(it) : '';                // always store English (canonical)
}

function onLocSelect(i) {
  const ld = DB.getLocDict();
  _writeLocInput(i);
  for (let j = i + 1; j < ld.levels.length; j++) _fillLocSelect(j, '');   // reset children
  regenWorkerId();
}

function checkWorkerIdDup(val) {
  const warn = document.getElementById('worker-id-warn');
  if (!warn) return;
  const v = (val || '').trim();
  const editUid = (document.getElementById('f-edit-uid') || {}).value || '';
  if (!v) { warn.style.display = 'none'; return; }
  const ws = DB.getWorkers(activeGroupId);
  const dup = ws.some(w => w.worker_id === v && w.uid !== editUid);
  warn.style.display = dup ? 'block' : 'none';
}

function saveWorker() {
  if (!isAdmin()) return;
  const enName = document.getElementById('f-en-name').value.trim();
  const passNo = document.getElementById('f-passport-no').value.trim();

  const editUid  = document.getElementById('f-edit-uid').value;
  const krCityEl = document.getElementById('f-kr-city');
  const krCity   = krCityEl ? krCityEl.value : '';
  const laCity   = document.getElementById('f-la-city').value;
  const workerId = document.getElementById('f-worker-id').value.trim();

  const data = {
    worker_id:      workerId,
    kr_city:        krCity,
    la_city:        laCity,
    employer_code:  document.getElementById('f-employer-code').value,
    group_supervisor: document.getElementById('w-supervisor').value.trim(),
    assign_code:    (document.getElementById('f-assign-code') || {}).value ? document.getElementById('f-assign-code').value.trim() : '',
    en_name:        enName.toUpperCase(),
    lo_name:        document.getElementById('f-lo-name').value.trim(),
    dob:            _dateInputVal('f-dob'),
    province:       document.getElementById('f-province').value.trim(),
    district:       document.getElementById('f-district').value.trim(),
    village:        document.getElementById('f-village').value.trim(),
    nationality:    document.getElementById('f-nationality').value.trim().toUpperCase(),
    sex:            document.getElementById('f-sex').value,
    blood:          document.getElementById('fm-blood').value,
    hand:           document.getElementById('f-hand').value,
    weight:         document.getElementById('f-weight').value,
    height:         document.getElementById('f-height').value,
    size:           document.getElementById('f-size').value,
    couple:         document.getElementById('f-couple').value,
    tel:            document.getElementById('f-tel').value.trim(),
    emg_tel:        document.getElementById('f-emg-tel').value.trim(),
    passport_no:    passNo.toUpperCase(),
    passport_issue: _dateInputVal('f-issue'),
    passport_expiry:_dateInputVal('f-expiry'),
    photo:          document.getElementById('f-photo').value || '',
    grade:          document.getElementById('f-grade').value,
    visa_status:    document.getElementById('f-visa-status').value,
    education:      document.getElementById('f-education').value.trim(),
    work_experience:document.getElementById('f-work-experience').value.trim(),
    languages:      document.getElementById('f-languages').value.trim(),
  };

  // Attach any scanned documents (passport MRZ scan + generic doc scans)
  const _pending = [];
  if (window._pendingScanDoc) { _pending.push(window._pendingScanDoc); window._pendingScanDoc = null; }
  if (Array.isArray(window._pendingScanDocs)) { _pending.push(...window._pendingScanDocs); window._pendingScanDocs = []; }
  if (_pending.length) {
    const prev = editUid
      ? ((DB.getGroup(activeGroupId).workers.find(x => x.uid === editUid) || {}).documents || {})
      : {};
    const docs = JSON.parse(JSON.stringify(prev));
    _pending.forEach(p => {
      docs[p.cat] = (docs[p.cat] || []).concat([{ name: p.name, type: p.type, data: p.data }]);
    });
    data.documents = docs;
  }

  if (editUid) {
    _ensureGroupFor(editUid);                 // make sure we target the worker's real group
    DB.updateWorker(activeGroupId, editUid, data);
    // Photo may have changed → its old thumbnail is stale. Clear it so the
    // refreshAll() below paints the new photo instead of the cached thumb.
    const _ew = DB.getGroup(activeGroupId)?.workers.find(x => x.uid === editUid);
    if (_ew) _ew.photo_thumb = '';
    _queueThumb(editUid, data.photo);
  } else {
    // A new worker MUST belong to a group; if none is active, don't lose the data silently.
    if (!activeGroupId || !DB.getGroup(activeGroupId)) {
      toast(bi('ເລືອກກຸ່ມກ່ອນເພີ່ມພະນັກງານ','Pick a group before adding a worker','เลือกกลุ่มก่อนเพิ่มพนักงาน','근로자 추가 전 그룹을 선택하세요'), 'warn');
      return;
    }
    DB.addWorker(activeGroupId, data);
  }

  closeOverlay('form-overlay');
  refreshAll();
}

// ── Employee photo upload (form) ──────────────────────────────────
function renderFormPhoto() {
  const url = document.getElementById('f-photo').value;
  const prev = document.getElementById('form-photo-preview');
  const rm   = document.getElementById('f-photo-remove');
  if (url) {
    prev.innerHTML = '<img src="' + url + '" alt="photo">';
    prev.classList.add('has-photo');
    if (rm) rm.style.display = '';
  } else {
    prev.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    prev.classList.remove('has-photo');
    if (rm) rm.style.display = 'none';
  }
}
function handlePhotoUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  _fileToDataURL(file, 900, dataUrl => {
    document.getElementById('f-photo').value = dataUrl;
    renderFormPhoto();
  });
  input.value = '';
}
function removePhoto() {
  document.getElementById('f-photo').value = '';
  renderFormPhoto();
}

// Resize/compress an image file → JPEG data URL (keeps localStorage small)
function _fileToDataURL(file, maxDim, cb) {
  if (file.type === 'application/pdf') { // PDFs stored as-is (no resize)
    const r = new FileReader();
    r.onload = () => cb(r.result);
    r.readAsDataURL(file);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, maxDim / Math.max(width, height));
      width = Math.round(width * scale); height = Math.round(height * scale);
      const c = document.createElement('canvas');
      c.width = width; c.height = height;
      c.getContext('2d').drawImage(img, 0, 0, width, height);
      cb(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => cb(reader.result);
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// ── GROUP FORM ────────────────────────────────────────────────────
function openGroupForm(gid, event) {
  if (event) event.stopPropagation();
  if (!isAdmin()) return;
  editGroupId = gid || null;
  document.getElementById('gf-name').value          = '';
  document.getElementById('gf-site-code').value     = '';
  document.getElementById('gf-province-code').value = '';
  document.getElementById('gf-date').value          = '';
  document.getElementById('gf-route').value         = '';
  { const kn = document.getElementById('gf-korean-name'); if (kn) kn.value = ''; }
  document.getElementById('gf-assigned').value      = '';
  document.getElementById('gf-arrivals').value      = '';
  document.getElementById('gm-title').textContent = editGroupId ? t('gm_edit_group') : t('gm_new_group');
  document.getElementById('gm-btn').textContent   = editGroupId ? t('gm_save') : t('gm_create');

  if (editGroupId) {
    const g = DB.getGroup(editGroupId);
    if (g) {
      document.getElementById('gf-name').value          = g.name || '';
      document.getElementById('gf-site-code').value     = g.site_code || '';
      document.getElementById('gf-province-code').value = g.province_code || '';
      document.getElementById('gf-date').value          = g.departure || '';
      document.getElementById('gf-route').value     = g.route || '';
      { const kn = document.getElementById('gf-korean-name'); if (kn) kn.value = g.korean_name || ''; }
      document.getElementById('gf-assigned').value  = (g.assigned != null ? g.assigned : '');
      document.getElementById('gf-arrivals').value  = (g.arrivals != null ? g.arrivals : '');
    }
  }
  openOverlay('group-overlay');
}

function saveGroup() {
  if (!isAdmin()) return;
  const name = document.getElementById('gf-name').value.trim();
  if (!name) { alert(t('gm_group_name') + ' is required'); return; }
  const num = id => { const v = document.getElementById(id).value.trim(); return v === '' ? '' : Math.max(0, parseInt(v, 10) || 0); };
  const data = {
    name: name,
    site_code:     document.getElementById('gf-site-code').value.trim().toUpperCase(),
    province_code: document.getElementById('gf-province-code').value.trim().toUpperCase(),
    departure: document.getElementById('gf-date').value.trim(),
    route: document.getElementById('gf-route').value.trim(),
    korean_name: (document.getElementById('gf-korean-name') || {}).value ? document.getElementById('gf-korean-name').value.trim() : '',
    assigned: num('gf-assigned'),
    arrivals: num('gf-arrivals')
  };
  if (editGroupId) {
    DB.updateGroup(editGroupId, data);
  } else {
    activeGroupId = DB.createGroup(data);
  }
  closeOverlay('group-overlay');
  refreshAll();
}

// ── CONFIRM / DELETE ──────────────────────────────────────────────
function confirmDeleteWorker(uid) {
  if (!isAdmin()) return;
  const g = DB.getGroup(activeGroupId);
  const w = g && g.workers.find(x => x.uid === uid);
  if (!w) return;
  showConfirm(
    t('confirm_del_worker'),
    t('confirm_del_worker_msg', { name: w.en_name }),
    () => { DB.deleteWorker(activeGroupId, uid); refreshAll(); }
  );
}

function confirmDeleteGroup(gid, event) {
  if (event) event.stopPropagation();
  if (!isAdmin()) return;
  const g = DB.getGroup(gid);
  if (!g) return;
  showConfirm(
    t('confirm_del_group'),
    t('confirm_del_group_msg', { name: g.name, count: g.workers.length }),
    () => {
      DB.deleteGroup(gid);
      const groups = DB.getGroups();
      if (activeGroupId === gid) activeGroupId = groups[0]?.id || '';
      refreshAll();
    }
  );
}

function showConfirm(title, msg, cb) {
  document.getElementById('cm-title').textContent = title;
  document.getElementById('cm-msg').textContent   = msg;
  confirmCallback = cb;
  // Restore the destructive-confirm look (showInfo may have altered it)
  const cancel = document.getElementById('cm-cancel-btn');
  if (cancel) cancel.style.display = '';
  const ok = document.getElementById('cm-confirm-btn');
  ok.className = 'btn btn-danger';
  ok.textContent = t('confirm_delete');
  openOverlay('confirm-overlay');
}

document.getElementById('cm-confirm-btn').addEventListener('click', () => {
  if (confirmCallback) { confirmCallback(); confirmCallback = null; }
  closeOverlay('confirm-overlay');
});

// ── UNIFIED CREATE MENU (groups / workers / import in one place) ──
function openCreate() {
  const sub = document.getElementById('create-worker-sub');
  if (sub) {
    const g = activeGroupId ? DB.getGroup(activeGroupId) : null;
    sub.textContent = g ? (bi('ເພີ່ມເຂົ້າ: ','Add to: ','เพิ่มเข้า: ','추가 대상: ') + (g.name || bi('ກຸ່ມປັດຈຸບັນ','current group','กลุ่มปัจจุบัน','현재 그룹'))) : bi('ເປີດກຸ່ມກ່ອນ','Open a group first','เปิดกลุ่มก่อน','먼저 그룹을 여세요');
  }
  openOverlay('create-overlay');
}
function createNewGroup()  { closeOverlay('create-overlay'); openGroupForm(null); }
function createAddWorker() {
  closeOverlay('create-overlay');
  if (!activeGroupId) { toast(bi('ເປີດກຸ່ມກ່ອນເພີ່ມແຮງງານ','Open a group first','เปิดกลุ่มก่อนเพิ่มแรงงาน','먼저 그룹을 여세요'), 'warn'); return; }
  openWorkerForm(null);
}
function createImport()    { closeOverlay('create-overlay'); openImport(); }
function createExport()    { closeOverlay('create-overlay'); openExportDialog('group'); }

// ── IMPORT (PPTX stub — feature not yet implemented) ──────────────
function openImport() { openOverlay('import-overlay'); }
function doImport()   { toast(bi('ຍັງບໍ່ທັນ implement Import PPTX','PPTX import not implemented yet','ยังไม่ได้ทำฟีเจอร์นำเข้า PPTX','PPTX 가져오기는 아직 구현되지 않았습니다'), 'warn'); }

/* ── One exit for every generated file ─────────────────────────────
 * Each export builder used to end with its own four lines of
 * createObjectURL / anchor / click / revoke. They are all routed through here
 * instead, for one reason beyond tidiness: when the Package format is also
 * selected, these files belong INSIDE the archive rather than in the downloads
 * folder next to it. Capture mode diverts them, and because it is a single
 * choke point no builder can quietly bypass it.
 */
let _exportCapture = null;      // an array while capturing, null while downloading

function _emitExport(data, filename, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
  if (_exportCapture) { _exportCapture.push({ name: filename, blob }); return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ── One entry for every DOM → image capture ───────────────────────
 * html2canvas does not implement `backdrop-filter`. It does not fail on it
 * either — it simply ignores it, so a glass surface rasterises as a flat tint
 * and the exported PNG or PPTX slide quietly differs from what the operator
 * approved on screen. That is the worst shape a bug can take here: the file is
 * wrong, nothing warns anybody, and it has already been sent.
 *
 * So every capture goes through this, which puts the document into
 * `body.exporting` for the duration. The CSS switches the whole material layer
 * off under that class, which means the rule cannot be forgotten when a future
 * surface becomes glass — it is off by construction rather than by memory. */
/* html2canvas is 46 KB gzipped and is used by exactly two features — the KD
 * card PNG and the rasterised PPTX fallback. It used to load on every page
 * view, for everyone, including the people who never export anything. Fetched
 * on first use instead, the same way JSZip already was. */
function _loadHtml2Canvas() {
  return new Promise((resolve, reject) => {
    if (typeof html2canvas !== 'undefined') return resolve();
    const s = document.createElement('script');
    s.src = new URL('../../vendor/html2canvas/html2canvas.min.js', location.href).href;
    s.onload = resolve;
    s.onerror = () => reject(new Error('html2canvas failed to load — vendor/html2canvas/ is missing'));
    document.head.appendChild(s);
  });
}

async function _rasterise(el, opts) {
  await _loadHtml2Canvas();
  document.body.classList.add('exporting');
  try {
    return await html2canvas(el, Object.assign(
      { scale: 1, useCORS: true, backgroundColor: '#ffffff' }, opts || {}));
  } finally {
    document.body.classList.remove('exporting');
  }
}

// ── EXPORT CSV ────────────────────────────────────────────────────
/* Download filename: keeps Unicode letters (Lao/Thai/…), replaces only what a
 * filesystem rejects. The rules are shared with the server's archive-path
 * sanitiser so the same worker is filed under the same spelling whichever
 * button produced the file — see infra/safe-name.js. */
function _safeFile(name, fallback) { return KDSafeName.download(name, fallback); }

/* exportCSV() lived here: a second CSV builder with its own hard-coded list of
 * twenty columns, left over from the toolbar button that the unified Export
 * dialog replaced. Nothing in the markup or the code called it any more, so the
 * only thing it could still do was drift away from _doExportCsv() — the one the
 * user actually reaches — and mislead the next person reading the file. Deleted
 * rather than kept "just in case": the dialog's CSV is a superset of it, with
 * the columns chosen rather than fixed. */

// ── EXPORT DIALOG ─────────────────────────────────────────────────────────
const _EXPORT_FIELDS = [
  { group: 'ຂໍ້ມູນ / Identity', fields: [
    { key:'worker_id',   label:'Worker ID',   def:true  },
    { key:'en_name',     label:'EN Name',     def:true  },
    { key:'lo_name',     label:'Lao Name',    def:true  },
    { key:'sex',         label:'Sex',         def:true  },
    { key:'dob',         label:'DOB',         def:true  },
    { key:'age',         label:'Age',         def:true  },
    { key:'blood',       label:'Blood',       def:false },
    { key:'nationality', label:'Nationality', def:false },
  ]},
  { group: 'ພາສປອດ / Passport', fields: [
    { key:'passport_no',     label:'Passport No', def:true  },
    { key:'passport_issue',  label:'Issue Date',  def:false },
    { key:'passport_expiry', label:'Expiry',      def:true  },
    { key:'visa_status',     label:'Visa',        def:false },
  ]},
  { group: 'ທີ່ຢູ່ / Address', fields: [
    { key:'village',  label:'Village',  def:false },
    { key:'district', label:'District', def:false },
    { key:'province', label:'Province', def:false },
  ]},
  { group: 'ການຈ້າງ / Employment', fields: [
    { key:'employer_code',    label:'Employer',   def:true  },
    { key:'group_supervisor', label:'Supervisor', def:true  },
    { key:'grade',            label:'Grade',      def:false },
    { key:'couple',           label:'Couple',     def:false },
    { key:'group_name',       label:'Group',      def:true  },
  ]},
  { group: 'ຮ່າງກາຍ / Physical', fields: [
    { key:'weight', label:'Weight(kg)', def:false },
    { key:'height', label:'Height(cm)', def:false },
    { key:'size',   label:'Size',       def:false },
    { key:'hand',   label:'Hand',       def:false },
  ]},
  { group: 'ຕິດຕໍ່ / Contact', fields: [
    { key:'tel',     label:'Tel',           def:true  },
    { key:'emg_tel', label:'Emergency Tel', def:false },
  ]},
];

let _exportCtx = null;

/* Which records an export covers. One definition, used by both the dialog (to
 * show the count and decide which formats make sense) and doExport (to produce
 * the files) — they drifting apart is how an export ends up describing itself
 * as one thing and containing another. */
function _exportWorkers(scope, uid) {
  const g = DB.getGroup(activeGroupId);
  if (scope === 'worker') {
    const target = uid || _currentViewUid;
    return g ? g.workers.filter(x => x.uid === target) : [];
  }
  if (scope === 'picked') return pickedWorkers();
  return tableFiltered.length ? tableFiltered : DB.getWorkers(activeGroupId);
}

/**
 * @param scope 'worker' — one record | 'picked' — the checkbox selection |
 *              anything else — the current group / filtered view
 */
function openExportDialog(scope, uid) {
  _exportCtx = { scope, uid: uid || null };
  const g  = DB.getGroup(activeGroupId);
  const ws = _exportWorkers(scope, uid);

  // Only English inflects; Lao, Thai and Korean use one form for any count.
  const people = n => bi('ຄົນ', n === 1 ? 'person' : 'people', 'คน', '명');
  const subjEl = document.getElementById('export-subject');
  if (scope === 'worker') {
    const w = ws[0];
    subjEl.textContent = w ? (w.en_name || w.lo_name || 'Worker') : 'Worker';
  } else if (scope === 'picked') {
    subjEl.textContent = t('pick_selected') + ' · ' + ws.length + ' ' + people(ws.length);
  } else {
    subjEl.textContent = (g ? g.name : '') + (ws.length ? ' · ' + ws.length + ' ' + people(ws.length) : '');
  }

  /* detail-pdf is a one-record layout, so it is offered whenever the export
   * resolves to exactly one worker — including a selection of one. */
  const single = ws.length === 1;
  const detBtn = document.querySelector('.export-opt[data-fmt="detail-pdf"]');
  if (detBtn) detBtn.style.display = (scope === 'worker' || single) ? '' : 'none';
  /* The .kdb bundle is defined as the COMPLETE group and ignores any narrowing,
   * so offering it next to a selection would promise something it does not do. */
  const kdbBtn = document.querySelector('.export-opt[data-fmt="kdb"]');
  if (kdbBtn) kdbBtn.style.display = (scope === 'worker' || scope === 'picked') ? 'none' : '';

  // reset + default selection (honours Settings → Data & Backup default)
  document.querySelectorAll('.export-opt').forEach(el => el.classList.remove('sel'));
  let defFmt = DB.getSetting('export_default', 'kd-pdf');
  if (!(scope === 'worker' || single) && defFmt === 'detail-pdf') defFmt = 'kd-pdf';
  let defEl = document.querySelector('.export-opt[data-fmt="' + defFmt + '"]');
  if (!defEl) defEl = document.querySelector('.export-opt[data-fmt="kd-pdf"]');
  if (defEl) defEl.classList.add('sel');

  /* The package is the one format this account may simply not have — every
   * other tile is available to anyone who reached this dialog. Hidden rather
   * than left to be refused on click. */
  const pkgBtn = document.querySelector('.export-opt[data-fmt="package"]');
  if (pkgBtn) pkgBtn.style.display = canExport('package') ? '' : 'none';

  _updateCsvFieldsVis();
  _updateExportCount();
  _renderExportFields();
  _renderExportCats();
  openOverlay('export-overlay');
}

function toggleExportFmt(el) {
  el.classList.toggle('sel');
  _updateCsvFieldsVis();
  _updateExportCount();
}

// Header chip next to "FORMAT". Formats are MULTI-select here (doExport loops
// over every .sel tile), which a single highlighted tile doesn't communicate —
// the chip says how many are armed.
function _updateExportCount() {
  const el = document.getElementById('export-count');
  if (!el) return;
  const n = document.querySelectorAll('.export-opt.sel').length;
  el.textContent = n
    ? bi('ເລືອກ ' + n + ' ຮູບແບບ', n + ' selected', 'เลือก ' + n + ' รูปแบบ', n + '개 선택')
    : bi('ຍັງບໍ່ໄດ້ເລືອກ', 'Nothing selected', 'ยังไม่ได้เลือก', '선택 없음');
  el.classList.toggle('on', n > 0);
}

function _updateCsvFieldsVis() {
  const pkg = !!document.querySelector('.export-opt[data-fmt="package"].sel');
  /* The package carries a summary.csv built from the same ticks, so the field
   * picker belongs to it too — otherwise the columns of the spreadsheet inside
   * the archive could only be changed by also ticking CSV. */
  const on = pkg || !!document.querySelector('.export-opt[data-fmt="csv"].sel, .export-opt[data-fmt="xlsx"].sel');
  document.getElementById('export-csv-fields').style.display = on ? '' : 'none';
  // The package's own options travel with its tile.
  const box = document.getElementById('export-pkg-opts');
  if (box) box.style.display = pkg ? '' : 'none';
}

/* Which document categories go into the package. Rendered from the SAME list
 * the drawer files documents under (server-persisted, self-healing), so a
 * category an admin added is exportable without touching this code. */
function _renderExportCats() {
  const wrap = document.getElementById('export-cat-list');
  if (!wrap) return;
  wrap.innerHTML = getDocCats().map(c =>
    '<label class="ef-field"><input type="checkbox" name="ec-' + esc(c.key) + '" checked>' +
    '<span>' + esc(c.label || c.key) + '</span></label>'
  ).join('');
}
function exportCatsAll(on) {
  document.querySelectorAll('#export-cat-list input[type="checkbox"]').forEach(el => el.checked = on);
}
/** null = every category (the server then applies no filter at all). */
function _selectedExportCats() {
  const boxes = [...document.querySelectorAll('#export-cat-list input[type="checkbox"]')];
  if (!boxes.length) return null;
  const on = boxes.filter(b => b.checked).map(b => b.name.replace(/^ec-/, ''));
  return on.length === boxes.length ? null : on;
}

function _renderExportFields() {
  const wrap = document.getElementById('export-field-list');
  if (!wrap) return;
  wrap.innerHTML = _EXPORT_FIELDS.map(grp =>
    '<div class="ef-group">' +
    '<div class="ef-group-label">' + esc(grp.group) + '</div>' +
    '<div class="ef-group-fields">' +
    grp.fields.map(f =>
      '<label class="ef-field"><input type="checkbox" name="ef-' + f.key + '"' +
      (f.def ? ' checked' : '') + '><span>' + esc(f.label) + '</span></label>'
    ).join('') +
    '</div></div>'
  ).join('');
}

function exportFieldsAll(on) {
  document.querySelectorAll('#export-field-list input[type="checkbox"]').forEach(el => el.checked = on);
}

/* ── Export authorisation (P4.5) ───────────────────────────────────
 * Which permission each format needs. This file used to hold its own copy of
 * rbac.EXPORT_FORMAT_PERMISSION, which had to be edited in step with the
 * server's and silently would not be: a stale copy either offers a format that
 * comes back as a 403, or hides one the account is entitled to. The table now
 * arrives with /api/bootstrap and the UI simply reads it.
 *
 * This remains presentation only. The server re-decides on every request. */
function canExport(fmt) { return DB.canExportFormat(fmt); }

/* ── Export watermarking (P4.6) ────────────────────────────────────
 * The server issues a receipt for every authorised export; these helpers stamp
 * it into the file so a leaked document can be traced back to the export that
 * produced it.
 *
 * Only the text formats are stamped, and that is a deliberate limit rather than
 * an oversight: CSV and JSON can carry a line without becoming invalid, whereas
 * XLSX/PPTX/PDF would each need their own metadata plumbing inside three
 * different generators. Every format is recorded in the audit trail either way —
 * the watermark adds traceability to the artefact, not to the record.
 */
let _lastExportReceipt = null;
function _rememberReceipt(r) {
  _lastExportReceipt = (r && typeof r === 'object' && r.exportId) ? r : null;
  return _lastExportReceipt;
}

/** A CSV comment row. Leading `#` keeps spreadsheets from reading it as data. */
function _csvWatermark() {
  return _lastExportReceipt ? KDCsv.EOL + KDCsv.cell('# ' + _lastExportReceipt.watermark) : '';
}

async function doExport() {
  const fmts = [...document.querySelectorAll('.export-opt.sel')].map(el => el.dataset.fmt);
  if (!fmts.length) { toast(bi('ກະລຸນາເລືອກຢ່າງໜ້ອຍ 1 ຮູບແບບ','Please select at least 1 format','โปรดเลือกอย่างน้อย 1 รูปแบบ','형식을 1개 이상 선택하세요'), 'warn'); return; }

  /* Refused formats are dropped before anything is generated. The server decides
   * — DB.recordExport() returns false on a 403 — so this is not a UI-only
   * restriction; the check below is what stops a half-written file. */
  const denied = fmts.filter(f => !canExport(f));
  if (denied.length === fmts.length) {
    toast(bi('ບັນຊີນີ້ບໍ່ມີສິດສົ່ງອອກຮູບແບບນີ້',
             'This account does not have permission to export in that format',
             'บัญชีนี้ไม่มีสิทธิ์ส่งออกรูปแบบนี้',
             '이 계정에는 해당 형식으로 내보낼 권한이 없습니다'), 'warn');
    return;
  }
  if (denied.length) {
    toast(bi('ຂ້າມ ' + denied.length + ' ຮູບແບບທີ່ບໍ່ມີສິດ',
             'Skipped ' + denied.length + ' format(s) you cannot export',
             'ข้าม ' + denied.length + ' รูปแบบที่ไม่มีสิทธิ์',
             '권한이 없는 ' + denied.length + '개 형식을 건너뜀'), 'warn');
  }

  closeOverlay('export-overlay');
  await new Promise(r => setTimeout(r, 150));

  const scope = _exportCtx.scope;
  const g = DB.getGroup(activeGroupId);
  const workers = _exportWorkers(scope, _exportCtx.uid);
  // The .kdb bundle always exports the COMPLETE group (never the filtered view),
  // so it can run even when the current search/filter shows nothing.
  if (!workers.length && !fmts.includes('kdb')) { toast(bi('ບໍ່ມີຂໍ້ມູນ','No data','ไม่มีข้อมูล','데이터 없음'), 'warn'); return; }

  /* ── The package collects, rather than sits alongside ──
   * With Package ticked, the other formats are generated into the archive
   * instead of into the downloads folder — one deliverable, which is the whole
   * point of asking for a package. Two are left out on purpose:
   *   docs — the package already contains every document, by category and
   *          version, so a second flat ZIP of the same files inside it would be
   *          pure duplication;
   *   kdb  — a restorable bundle of the entire group, which is a different
   *          artefact with a different audience, and would dwarf the package.
   */
  const wantsPackage = fmts.includes('package') && !denied.includes('package');
  const inPackage = f => wantsPackage && f !== 'docs' && f !== 'kdb';
  const others = fmts.filter(f => f !== 'package' && !denied.includes(f));

  /* One bucket for the whole run, switched on and off per format. Pointing
   * _exportCapture at a fresh array (or at null) each time would throw away
   * everything collected so far the moment an excluded format came up — with
   * the tiles in DOM order, ticking CSV + Documents + Package did exactly that
   * and lost the CSV. */
  const captured = [];
  try {
    for (const fmt of others) {
      _exportCapture = inPackage(fmt) ? captured : null;
      /* Server-side authorisation + audit, per format, BEFORE the file is
       * produced. A false here means the server refused: skip that format rather
       * than writing a file the account is not entitled to. */
      const receipt = await DB.recordExport(fmt, _exportCtx.scope || 'group', workers.length);
      if (!receipt) {
        toast(bi('ຖືກປະຕິເສດ: ', 'Refused: ', 'ถูกปฏิเสธ: ', '거부됨: ') + fmt, 'warn');
        continue;
      }
      _rememberReceipt(receipt);
      if (fmt === 'detail-pdf') {
        // real PDF file; browser print dialog only if pdf-lib can't load
        try { await _doWorkerDetailPdf(workers[0], g); }
        catch (e) { console.warn('pdf-lib failed → print fallback:', e); exportWorkerPDF(); await new Promise(r => setTimeout(r, 200)); }
      }
      else if (fmt === 'kd-pdf') {
        try { await _doKdCardPdfFile(workers, g); }
        catch (e) { console.warn('pdf-lib failed → print fallback:', e); _doKdCardPdf(workers, g); }
      }
      else if (fmt === 'kd-png')     await _doKdCardPng(workers, g);
      else if (fmt === 'pptx')       await _doKdCardPptx(workers, g);
      else if (fmt === 'csv')        _doExportCsv(workers, g);
      else if (fmt === 'xlsx')       await _doExportXlsx(workers, g);
      else if (fmt === 'docs')       await _doExportDocs(workers);
      else if (fmt === 'kdb')        await _doDatabaseBundle(g);
    }
  } finally {
    /* Capture mode MUST NOT survive this function. Left on, every later export
     * in the session would silently produce no file at all. */
    _exportCapture = null;
  }

  if (wantsPackage) {
    /* The package is built BY the server, which authorises and records it as
     * part of starting the job. Asking for a receipt here as well would put two
     * DATA_EXPORT rows in the trail for one export. */
    await _doExportPackage(workers, captured);
  }
}

function _doKdCardPdf(workers, g) {
  const container = document.getElementById('print-group-container');
  if (!container) return;
  container.innerHTML = workers.map(w =>
    '<div class="print-group-page">' + _renderKdCard(w, g) + '</div>'
  ).join('');
  document.body.classList.add('printing-group');
  const cleanup = () => {
    document.body.classList.remove('printing-group');
    container.innerHTML = '';
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  setTimeout(() => window.print(), 80);
}

async function _doKdCardPng(workers, g) {
  /* The library is fetched on first use now, so this waits for it rather than
     testing whether it happened to be there. Without the await, lazy loading
     would make every card export bail out on the old presence check. */
  try { await _loadHtml2Canvas(); }
  catch (e) { toast(bi('html2canvas ບໍ່ໄດ້ໂຫລດ','html2canvas not loaded','html2canvas ยังไม่โหลด','html2canvas가 로드되지 않음'), 'warn'); return; }
  const showProg = workers.length > 3;
  if (showProg) _progressShow(bi('ກຳລັງສ້າງຮູບ KD Card', 'Creating KD Card image', 'กำลังสร้างรูป KD Card', 'KD 카드 이미지 생성 중'));
  try {
  for (let i = 0; i < workers.length; i++) {
    const w = workers[i];
    const wrap = document.createElement('div');
    // 1920 + 2×8px padding: the fit box lands on exactly the surface width, so
    // the slide is captured at its native 1:1 scale (scale 1 here now beats the
    // old 340px box at scale 2 — 1920 real pixels instead of 680).
    wrap.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-999;background:#fff;padding:8px;width:1936px;';
    wrap.innerHTML = _renderKdCard(w, g);
    document.body.appendChild(wrap);
    _kdFitAll(wrap);
    try {
      const canvas = await _rasterise(wrap);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      _emitExport(blob, _safeFile(w.en_name || w.lo_name, 'worker') + '_kd_card.png');
      if (showProg) _progressSet((i + 1) / workers.length * 100, (i + 1) + '/' + workers.length);
      // The pause spaces out repeated download prompts; capturing needs none.
      if (workers.length > 1 && !_exportCapture) await new Promise(r => setTimeout(r, 400));
    } finally {
      document.body.removeChild(wrap);
    }
  }
  } finally { if (showProg) _progressDone(); }
}

// Selected-field helpers shared by the CSV and XLSX exports.
function _exportSelectedFields() {
  const sel = [];
  _EXPORT_FIELDS.forEach(grp => {
    grp.fields.forEach(f => {
      const el = document.querySelector('#export-field-list input[name="ef-' + f.key + '"]');
      if (el && el.checked) sel.push(f);
    });
  });
  return sel;
}
function _exportFieldValue(w, f, gName) {
  if (f.key === 'age')        return calcAge(w.dob) || '';
  if (f.key === 'group_name') return gName;
  return w[f.key] || '';
}

function _doExportCsv(workers, g) {
  const selFields = _exportSelectedFields();
  if (!selFields.length) { toast(bi('ກະລຸນາເລືອກ field ຢ່າງໜ້ອຍ 1 ອັນ','Please select at least 1 field','โปรดเลือกฟิลด์อย่างน้อย 1 ช่อง','항목을 1개 이상 선택하세요'), 'warn'); return; }
  const gName = g ? g.name : '';
  // Quoting, BOM and line endings come from the shared writer — see infra/csv.js.
  const csv = KDCsv.build(selFields.map(f => f.label),
                          workers.map(w => selFields.map(f => _exportFieldValue(w, f, gName))),
                          _csvWatermark());
  _emitExport(csv, _safeFile(gName, 'workers') + '.csv', 'text/csv;charset=utf-8');
}

// ── Excel (.xlsx) export ──────────────────────────────────────────
// A real SpreadsheetML package (styled bold header on the brand brown, frozen
// header row, sized columns) hand-rolled with JSZip — same zero-dependency
// approach as the .pptx builder. Strings are written inline (no sharedStrings
// part needed); UTF-8 throughout so Lao/Thai/Korean never mangle.
function _colRef(i) {           // 0 → A, 25 → Z, 26 → AA …
  let s = '', n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; }
  return s;
}
async function _doExportXlsx(workers, g) {
  const selFields = _exportSelectedFields();
  if (!selFields.length) { toast(bi('ກະລຸນາເລືອກ field ຢ່າງໜ້ອຍ 1 ອັນ','Please select at least 1 field','โปรดเลือกฟิลด์อย่างน้อย 1 ช่อง','항목을 1개 이상 선택하세요'), 'warn'); return; }
  if (typeof _loadJSZip === 'function') { try { await _loadJSZip(); } catch (e) {} }
  if (!window.JSZip) { toast(bi('JSZip ບໍ່ໄດ້ໂຫລດ','JSZip not loaded','JSZip ยังไม่โหลด','JSZip가 로드되지 않음'), 'warn'); return; }

  const gName = g ? g.name : '';
  const NUMERIC = { age: 1, weight: 1, height: 1 };
  const rows = workers.map(w => selFields.map(f => String(_exportFieldValue(w, f, gName))));

  // Column widths: fit the longest cell (header included), clamped 10–40 chars.
  const widths = selFields.map((f, c) => {
    let max = f.label.length;
    rows.forEach(r => { if (r[c].length > max) max = r[c].length; });
    return Math.min(40, Math.max(10, max + 3));
  });

  const C = _KD_COLORS;
  const cellXml = (r, c, v, style, numericOk) => {
    const ref = _colRef(c) + r;
    if (numericOk && v !== '' && /^-?\d+(\.\d+)?$/.test(v))
      return '<c r="' + ref + '" s="' + style + '"><v>' + v + '</v></c>';
    if (v === '') return '<c r="' + ref + '" s="' + style + '"/>';
    return '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' + _xmlSafe(v) + '</t></is></c>';
  };

  let sheet = _XH +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="16"/>' +
    '<cols>' + widths.map((w, i) =>
      '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>' +
    '<sheetData>' +
    '<row r="1" ht="22" customHeight="1">' +
      selFields.map((f, c) => cellXml(1, c, f.label, 1, false)).join('') + '</row>' +
    rows.map((r, ri) =>
      '<row r="' + (ri + 2) + '">' +
      r.map((v, c) => cellXml(ri + 2, c, v, 2, NUMERIC[selFields[c].key])).join('') +
      '</row>').join('') +
    '</sheetData></worksheet>';

  // Font/fill/border/xf indices are positional — fills 0 (none) and 1 (gray125)
  // are reserved by Excel and must exist even though nothing references them.
  const styles = _XH +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2">' +
      '<font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF' + C.brown + '"/><bgColor rgb="FF' + C.brown + '"/></patternFill></fill></fills>' +
    '<borders count="2">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border>' +
        '<left style="thin"><color rgb="FFD9D9D9"/></left><right style="thin"><color rgb="FFD9D9D9"/></right>' +
        '<top style="thin"><color rgb="FFD9D9D9"/></top><bottom style="thin"><color rgb="FFD9D9D9"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
        '<alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  // Excel sheet names: ≤31 chars, none of []\/*?: — fall back to "Workers".
  const sheetName = _xmlSafe((gName || 'Workers').replace(/[\[\]\\\/*?:]+/g, ' ').trim().slice(0, 31)) || 'Workers';

  const zip = new JSZip();
  zip.file('[Content_Types].xml', _XH +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>');
  zip.file('_rels/.rels', _pptxRels([   // package-level rels, format-agnostic
    { id: 'rId1', type: _RT.off, target: 'xl/workbook.xml' },
  ]));
  zip.file('xl/workbook.xml', _XH +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="' + sheetName + '" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', _pptxRels([
    { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet', target: 'worksheets/sheet1.xml' },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',    target: 'styles.xml' },
  ]));
  zip.file('xl/styles.xml', styles);
  zip.file('xl/worksheets/sheet1.xml', sheet);

  const blob = await zip.generateAsync({ type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  _emitExport(blob, _safeFile(gName, 'workers') + '.xlsx');
  toast('Excel ✓', 'ok');
}

async function _doExportDocs(workers) {
  _progressShow(bi('ກຳລັງລວບລວມເອກະສານ', 'Collecting documents', 'กำลังรวบรวมเอกสาร', '문서 수집 중'));
  try {
  const allDocs = [];
  for (let i = 0; i < workers.length; i++) {
    const w = workers[i];
    try {
      const docs = await DB.getDocuments(w.uid);
      getDocCats().forEach(cat => {
        const versions = docs[cat.key] || [];
        const cur = versions.find(v => v.isCurrent) || versions[0];
        if (cur) allDocs.push({ w, cat, doc: cur });
      });
    } catch(e) { /* skip */ }
    _progressSet(i / workers.length * 40, bi('ກວດເອກະສານ ', 'Checking documents ', 'ตรวจเอกสาร ', '문서 확인 중 ') + (i + 1) + '/' + workers.length);
    await _paint();
  }
  if (!allDocs.length) { toast(bi('ບໍ່ມີເອກະສານທີ່ອັບໂຫລດ','No uploaded documents','ไม่มีเอกสารที่อัปโหลด','업로드된 문서가 없음'), 'warn'); return; }

  if (!window.JSZip || allDocs.length <= 3) {
    for (const { doc } of allDocs) {
      const a = document.createElement('a');
      a.href = doc.path;
      a.download = doc.name || (doc.category + '.' + (doc.type || 'file'));
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      await new Promise(r => setTimeout(r, 350));
    }
    return;
  }

  const zip = new JSZip();
  for (let i = 0; i < allDocs.length; i++) {
    const { w, cat, doc } = allDocs[i];
    try {
      const resp = await fetch(doc.path);
      const blob = await resp.blob();
      const wName = _safeFile(w.en_name || w.lo_name || w.uid, 'worker');
      const ext   = doc.type || (doc.name || '').split('.').pop() || 'bin';
      zip.file(wName + '/' + cat.key + '_v' + (doc.version || 1) + '.' + ext, blob);
    } catch(e) { /* skip unavailable file */ }
    _progressSet(40 + (i + 1) / allDocs.length * 50, bi('ດຶງເອກະສານ ', 'Fetching documents ', 'ดึงเอกสาร ', '문서 가져오는 중 ') + (i + 1) + '/' + allDocs.length);
    await _paint();
  }
  const content = await zip.generateAsync({ type: 'blob' },
    m => _progressSet(90 + (m.percent || 0) * 0.1, bi('ບີບອັດໄຟລ໌...', 'Compressing files…', 'บีบอัดไฟล์...', '파일 압축 중…')));
  _emitExport(content, _safeFile((DB.getGroup(activeGroupId) || {}).name, 'workers') + '_docs.zip');
  } catch (e) {
    toast('Export failed: ' + (e && e.message || e), 'warn');
  } finally {
    _progressDone();
  }
}

/* ── EXPORT PACKAGE (server-built: photos + documents in named folders) ──
 *
 * Unlike every other format here, the browser does not build this one. It asks
 * the server to start a job, follows the progress, and then downloads the
 * finished archive. The reason is size: fifty workers is several hundred
 * megabytes of scans, which the browser would have to fetch through the page
 * and hold in memory to zip — and would lose entirely if the tab closed.
 *
 * The poll interval is deliberately unhurried. Progress on a job measured in
 * minutes does not become more useful by being asked for ten times a second,
 * and each poll is a round trip through the tunnel.
 */
const _PKG_POLL_MS = 1200;
/* A build that has stopped reporting progress. Long enough to cover a slow
 * fetch of one large document from R2, short enough that a wedged job does not
 * leave the user staring at a frozen bar forever. */
const _PKG_STALL_MS = 180000;

async function _doExportPackage(workers, reports) {
  const uids = workers.map(w => w.uid).filter(Boolean);
  if (!uids.length) { toast(bi('ບໍ່ມີຂໍ້ມູນ','No data','ไม่มีข้อมูล','데이터 없음'), 'warn'); return; }

  const options = {
    categories:  _selectedExportCats(),
    allVersions: (document.getElementById('export-pkg-allver') || {}).checked !== false,
    photos:      (document.getElementById('export-pkg-photos') || {}).checked !== false,
    fields:      _selectedExportFields(),
  };

  _progressShow(t('exp_pkg_building'));
  try {
    /* Upload the files the browser just made, before starting the build. One
     * that fails to upload is reported and the export continues without it —
     * losing a spreadsheet must not cost the operator the passport scans, which
     * are the part they cannot reproduce by hand. */
    const attachments = [];
    const files = Array.isArray(reports) ? reports : [];
    for (let i = 0; i < files.length; i++) {
      _progressSet(i / Math.max(1, files.length) * 5,
        t('exp_pkg_uploading', { name: files[i].name }));
      try { attachments.push(await DB.attachExportFile(files[i].name, files[i].blob)); }
      catch (e) {
        console.warn('[export] attachment failed:', files[i].name, e && e.message || e);
        toast(t('exp_pkg_attach_failed', { name: files[i].name }), 'warn');
      }
    }

    const started = await DB.startExportPackage(uids, options, _exportCtx.scope || 'group', attachments);
    if (!started || !started.ok) {
      const why = (started && started.error) || 'failed';
      toast(t('exp_pkg_err_' + why) !== 'exp_pkg_err_' + why ? t('exp_pkg_err_' + why)
                                                             : t('exp_pkg_failed') + ' ' + why, 'warn');
      return;
    }

    const jobId = started.job.id;
    let job = started.job, lastDone = -1, lastChange = Date.now();
    while (job.state === 'running') {
      await new Promise(r => setTimeout(r, _PKG_POLL_MS));
      let r;
      try { r = await DB.exportPackageStatus(jobId); }
      catch (e) {
        /* One failed poll is a hiccup, not a failed export — the build is on
         * the server and carries on regardless. Keep waiting; the stall timer
         * below is what ends a job that really has stopped. */
        if (Date.now() - lastChange > _PKG_STALL_MS) throw e;
        continue;
      }
      job = (r && r.job) || job;
      if (job.done !== lastDone) { lastDone = job.done; lastChange = Date.now(); }
      else if (Date.now() - lastChange > _PKG_STALL_MS) {
        throw new Error(t('exp_pkg_stalled'));
      }
      // Cap the bar at 95% until the file actually exists: the summary and the
      // manifest are still to be written after the last worker.
      _progressSet(Math.min(95, job.percent || 0),
        t('exp_pkg_progress', { done: job.done, total: job.total }));
    }

    if (job.state !== 'done') throw new Error(job.error || t('exp_pkg_failed'));

    /* A plain navigation, not fetch(): the session cookie goes with it, the
     * browser streams straight to disk, and a 300 MB archive never has to exist
     * as a Blob in the page. */
    const a = document.createElement('a');
    a.href = DB.exportPackageUrl(jobId);
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    const mb = (job.bytes / 1048576).toFixed(1);
    toast(t('exp_pkg_done', { n: job.total, docs: job.documents, mb }) +
          (job.reports ? ' + ' + t('exp_pkg_reports', { n: job.reports }) : ''), 'ok');
    /* Missing files are named, not swallowed. The operator asked for them to be
     * skipped silently DURING the build — not for the export to end up quietly
     * incomplete with nobody told. */
    if (job.skipped) {
      toast(t('exp_pkg_skipped', { n: job.skipped }) +
            (job.skippedSample && job.skippedSample.length ? ' — ' + job.skippedSample[0] : ''), 'warn');
    }
  } catch (e) {
    toast(t('exp_pkg_failed') + ' ' + ((e && e.message) || e), 'warn');
  } finally {
    _progressDone();
  }
}

/** The ticked summary columns, or null when they are all ticked. */
function _selectedExportFields() {
  const boxes = [...document.querySelectorAll('#export-field-list input[type="checkbox"]')];
  if (!boxes.length) return null;
  const on = boxes.filter(b => b.checked).map(b => b.name.replace(/^ef-/, ''));
  return on.length === boxes.length ? null : on;
}

// ── PROGRESS overlay ──────────────────────────────────────────────
// A determinate bar + percentage for long jobs (the .kdb bundle, the documents
// ZIP, multi-card rasterising) so the user can see it IS working — these can run
// 20s+ and otherwise look frozen. Not click-outside dismissable.
function _progressShow(title) {
  const ov = document.getElementById('progress-overlay'); if (!ov) return;
  const te = document.getElementById('progress-title');
  if (te) te.textContent = title || bi('ກຳລັງດຳເນີນການ...', 'Working…', 'กำลังดำเนินการ...', '처리 중…');
  _progressSet(0, '');
  ov.classList.add('open');
  document.body.classList.add('no-scroll');
}
function _progressSet(pct, sub) {
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  const fill = document.getElementById('progress-fill');
  const pe   = document.getElementById('progress-pct');
  const se   = document.getElementById('progress-sub');
  if (fill) fill.style.width = pct + '%';
  if (pe)   pe.textContent = pct + '%';
  if (se && sub != null) se.textContent = sub;
}
function _progressHide() {
  const ov = document.getElementById('progress-overlay'); if (!ov) return;
  ov.classList.remove('open');
  if (!document.querySelector('.overlay.open')) document.body.classList.remove('no-scroll');
}
// Snap to 100% briefly so the bar visibly completes, then close.
function _progressDone() { _progressSet(100, ''); setTimeout(_progressHide, 280); }
// Let the browser paint the latest bar state between awaited steps.
// rAF never fires in a hidden/background tab (Chrome throttles it to zero), which
// would freeze a long export the moment the user switches tabs — so always
// race it against a short timeout.
function _paint() {
  return new Promise(r => {
    let done = false;
    const fin = () => { if (!done) { done = true; setTimeout(r, 0); } };
    requestAnimationFrame(fin);
    setTimeout(fin, 60);
  });
}

// ── Shared media/loader helpers for exports ───────────────────────
// Pick a file extension from a path or, failing that, its MIME type.
function _fileExtFor(p, mime) {
  const m = (p || '').match(/\.([a-z0-9]+)(?:[?#].*)?$/i);
  if (m) return m[1].toLowerCase();
  if (/png/.test(mime))  return 'png';
  if (/webp/.test(mime)) return 'webp';
  if (/pdf/.test(mime))  return 'pdf';
  return 'jpg';
}
// Fetch a /uploads path (or data: URL) → raw bytes, or null if unavailable.
async function _fetchImageBytes(src) {
  if (!src) return null;
  try {
    const resp = await fetch(src);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || '' };
  } catch (e) { return null; }
}
// Lazy <script> loader for heavy vendor libs (pdf-lib) — same pattern as
// _loadJSZip in pptx-import.js. Cached per path so repeat exports are free.
const _loadedScripts = {};
function _loadScript(relPath) {
  if (!_loadedScripts[relPath]) {
    _loadedScripts[relPath] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL(relPath, location.href).href;
      s.onload = resolve;
      s.onerror = () => { delete _loadedScripts[relPath]; reject(new Error('failed to load ' + relPath)); };
      document.head.appendChild(s);
    });
  }
  return _loadedScripts[relPath];
}

// ── FULL DATABASE BUNDLE (.kdb) export ────────────────────────────
// A portable, self-contained ZIP of an ENTIRE group — every worker (no field
// is required, nobody is dropped) plus the real binary of every photo and
// document. Another KD Database instance (different machine / server) can
// receive it via Import and rebuild the group with images intact.
//
//   <group>.kdb (zip)
//   ├── manifest.json          { kind:'kd-database', version, group, workers[] }
//   └── media/<uid>/…          photo / photo_orig / <category> binaries
//
// Photos & documents are stored on the server as /uploads/… paths, which are
// meaningless on another box — so we fetch each one and pack the bytes.
async function _doDatabaseBundle(g) {
  if (!g) { toast(bi('ບໍ່ມີກຸ່ມ','No group','ไม่มีกลุ่ม','그룹 없음'), 'warn'); return; }
  if (typeof _loadJSZip === 'function') { try { await _loadJSZip(); } catch (e) {} }
  if (!window.JSZip) { toast(bi('JSZip ບໍ່ໄດ້ໂຫລດ','JSZip not loaded','JSZip ยังไม่โหลด','JSZip가 로드되지 않음'), 'warn'); return; }

  // ALWAYS the full group — the active table filter must never shrink a backup.
  const workers = DB.getWorkers(g.id);
  if (!workers.length) { toast(bi('ບໍ່ມີຂໍ້ມູນ','No data','ไม่มีข้อมูล','데이터 없음'), 'warn'); return; }

  _progressShow(bi('ກຳລັງສ້າງໄຟລ໌ຖານຂໍ້ມູນ', 'Building database file', 'กำลังสร้างไฟล์ฐานข้อมูล', '데이터베이스 파일 생성 중'));
  try {

  const _extFor = _fileExtFor;
  const _grab   = _fetchImageBytes;

  const zip = new JSZip();
  const media = zip.folder('media');
  const out = [];
  let nPhotos = 0, nDocs = 0;

  for (let wi = 0; wi < workers.length; wi++) {
    const w = workers[wi];
    const rec = { ...w };
    delete rec.photo; delete rec.photo_orig; delete rec.photo_thumb; delete rec.documents;

    if (w.photo) {
      const got = await _grab(w.photo);
      if (got) {
        const fp = w.uid + '/photo.' + _extFor(w.photo, got.mime);
        media.file(fp, got.bytes); rec.photo_file = 'media/' + fp; nPhotos++;
      }
    }
    if (w.photo_orig && w.photo_orig !== w.photo) {
      const got = await _grab(w.photo_orig);
      if (got) {
        const fp = w.uid + '/photo_orig.' + _extFor(w.photo_orig, got.mime);
        media.file(fp, got.bytes); rec.photo_orig_file = 'media/' + fp;
      }
    }

    rec.documents_manifest = [];
    let docs = {};
    try { docs = await DB.getDocuments(w.uid); } catch (e) {}
    for (const cat of Object.keys(docs)) {
      const versions = docs[cat] || [];
      const cur = versions.find(v => v.isCurrent) || versions[0];
      if (!cur || !cur.path) continue;
      const got = await _grab(cur.path);
      if (!got) continue;
      const idx = rec.documents_manifest.length;
      const fp = w.uid + '/' + _safeFile(cat, 'doc') + '_' + idx + '.' + _extFor(cur.path, got.mime);
      media.file(fp, got.bytes); nDocs++;
      rec.documents_manifest.push({
        category: cat, name: cur.name || '', type: cur.type || 'image',
        version: cur.version || 1, file: 'media/' + fp,
      });
    }
    out.push(rec);
    // Gathering media is the slow phase → map it to 0–90% of the bar.
    _progressSet((wi + 1) / workers.length * 90,
      bi('ລວບລວມຂໍ້ມູນ ', 'Gathering data ', 'รวบรวมข้อมูล ', '데이터 수집 중 ') + (wi + 1) + '/' + workers.length);
    await _paint();
  }

  const manifest = {
    kind: 'kd-database', version: 1,
    exported_at: new Date().toISOString(),
    app: 'KD Database',
    group: { id: g.id, name: g.name || '', departure: g.departure || '', route: g.route || '' },
    // Custom document-category definitions (labels + order, incl. types beyond
    // the default six and ones with no uploaded files). Without these, a restore
    // on another box can only self-heal placeholder labels from document keys and
    // would drop any empty custom category — so the .kdb is the full DB or nothing.
    doc_cats: getDocCats(),
    counts: { workers: out.length, photos: nPhotos, documents: nDocs },
    workers: out,
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  // Zipping/compression is the final 90–100%.
  const content = await zip.generateAsync({ type: 'blob' },
    m => _progressSet(90 + (m.percent || 0) * 0.1, bi('ບີບອັດໄຟລ໌...', 'Compressing files…', 'บีบอัดไฟล์...', '파일 압축 중…')));
  _emitExport(content, _safeFile(g.name, 'database') + '.kdb');
  toast(bi('ສ້າງໄຟລ໌ຖານຂໍ້ມູນສຳເລັດ · ' + out.length + ' ຄົນ, ' + (nPhotos + nDocs) + ' ຮູບ',
           'Database file created · ' + out.length + ' people, ' + (nPhotos + nDocs) + ' images',
           'สร้างไฟล์ฐานข้อมูลสำเร็จ · ' + out.length + ' คน, ' + (nPhotos + nDocs) + ' รูป',
           '데이터베이스 파일 생성 완료 · ' + out.length + '명, ' + (nPhotos + nDocs) + '개 이미지'), 'ok');
  } catch (e) {
    toast('Export failed: ' + (e && e.message || e), 'warn');
  } finally {
    _progressDone();
  }
}

// ── PowerPoint (.pptx) export ─────────────────────────────────────
// One KD card per slide, rebuilt from NATIVE OOXML elements (text boxes, a real
// a:tbl for the field grid, the photo as the only picture) so every value is
// editable in PowerPoint / Google Slides / Keynote. Hand-rolled XML via JSZip —
// no pptx library. The old html2canvas one-picture-per-slide path is kept as
// _doKdCardPptxRaster and used only as a fallback if native building throws.
// Fixed LIGHT palette for generated files (xlsx/pptx/pdf) — exports must look
// identical regardless of the on-screen theme, so never read CSS variables here.
const _KD_COLORS = {
  brown: '6B6A2F', line: 'E7EAE7', thBg: 'FAFBFA', fieldBg: 'F7F8F7',
  text: '14181A', muted: '6B7280', faint: '9AA3A0', green: '2D6A4F',
  card: 'FFFFFF', white: 'FFFFFF',
  genderMBg: 'DBEAFE', genderMTx: '1D4ED8', genderFBg: 'FCE7F3', genderFTx: 'BE185D',
  expired: 'B91C1C',
};

const _PPTX_W = 12192000, _PPTX_H = 7620000;            // 16:10 slide (EMU) — same aspect as the locked KD card
const _XH = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const _NS_P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const _EMPTY_TREE = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';

const _PPTX_THEME = _XH +
'<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">' +
'<a:themeElements>' +
'<a:clrScheme name="Office">' +
'<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
'<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
'<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
'<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
'<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
'<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
'<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
'<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
'<a:fmtScheme name="Office">' +
'<a:fillStyleLst>' +
'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
'<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>' +
'<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:satMod val="110000"/><a:lumMod val="100000"/><a:shade val="100000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst>' +
'<a:lnStyleLst>' +
'<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>' +
'<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>' +
'<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln></a:lnStyleLst>' +
'<a:effectStyleLst>' +
'<a:effectStyle><a:effectLst/></a:effectStyle>' +
'<a:effectStyle><a:effectLst/></a:effectStyle>' +
'<a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst>' +
'<a:bgFillStyleLst>' +
'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
'<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill>' +
'<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:bgFillStyleLst>' +
'</a:fmtScheme></a:themeElements></a:theme>';

function _pptxRels(list) {   // list: [{id,type,target}]
  return _XH + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    list.map(r => '<Relationship Id="' + r.id + '" Type="' + r.type + '" Target="' + r.target + '"/>').join('') +
    '</Relationships>';
}
const _RT = {
  off:   'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  master:'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  layout:'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
};

// ── Native KD-card slide geometry ─────────────────────────────────
// The KD card is a locked 16:10 sheet whose internal sizes are all in cqw
// (1cqw = 1% of card width). These constants are the card measured ONCE at a
// virtual 1000×625 px (so 1cqw = 10px) and frozen — never computed at runtime,
// so the exported layout is identical on every machine (kd-card-locked).
// The card fills the whole 16:10 slide: 12192000 EMU / 1000 px = 12192 exactly.
const _KD_EMU = 12192;
function _E(px)  { return Math.round(px * _KD_EMU); }
// Card px → OOXML font size (1/100 pt). Slide is 960pt wide → 1px = 0.96pt.
function _SZ(px) { return Math.max(100, Math.round(px * 96)); }
const _KD_GEO = {
  top:   { h: 33.2, codeX: 13, codeSize: 13.5,
           pillX: 878, pillY: 5.5, pillW: 24.7, pillH: 21.2, pillSize: 13,
           bloodsX: 700, bloodsEndX: 987, bloodsY: 7.6, bloodsH: 17, bloodSize: 12.5 },
  head:  { y: 33.2, h: 42.2, padX: 15, lSize: 18.5, rSize: 16 },
  tbl:   { y: 75.4, w: 523.8, labelW: 219.6, rowH: 54.96, labelSize: 12, subSize: 10,
           valSize: 13, padL: 9 },
  photo: { x: 523.8, y: 75.4, w: 476.2, h: 411.7, initialsSize: 28 },
  couple:{ x: 936, y: 85.4, w: 54, h: 23.6, size: 13 },
  sum:   { x: 523.8, y: 487, headH: 27.6, rowH: 27.6, padX: 14, size: 13 },
};

// Run properties: Calibri for Latin, Leelawadee UI for complex scripts (covers
// both Thai and Lao on Windows), Malgun Gothic for the card's fixed Korean
// strings. PowerPoint substitutes per-character when a glyph is missing.
function _pptxRun(text, o) {
  o = o || {};
  return '<a:r><a:rPr lang="lo-LA" sz="' + (o.sz || 1200) + '"' +
    (o.b ? ' b="1"' : '') + (o.u ? ' u="sng"' : '') + ' dirty="0">' +
    '<a:solidFill><a:srgbClr val="' + (o.color || _KD_COLORS.text) + '"/></a:solidFill>' +
    '<a:latin typeface="' + (o.mono ? 'Consolas' : 'Calibri') + '"/>' +
    '<a:ea typeface="Malgun Gothic"/><a:cs typeface="Leelawadee UI"/>' +
    '</a:rPr><a:t>' + _xmlSafe(text) + '</a:t></a:r>';
}
function _pptxPara(runs, algn) {
  return '<a:p><a:pPr algn="' + (algn || 'l') + '"/>' + runs + '<a:endParaRPr lang="lo-LA" dirty="0"/></a:p>';
}
// Generic shape: rect / roundRect with optional fill, outline and text.
function _pptxSp(id, x, y, w, h, o, paras) {
  o = o || {};
  return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + (o.name || 'Shape ' + id) + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' + _E(x) + '" y="' + _E(y) + '"/><a:ext cx="' + Math.max(1, _E(w)) + '" cy="' + Math.max(1, _E(h)) + '"/></a:xfrm>' +
    '<a:prstGeom prst="' + (o.round ? 'roundRect' : 'rect') + '">' +
    (o.adj != null ? '<a:avLst><a:gd name="adj" fmla="val ' + o.adj + '"/></a:avLst>' : '<a:avLst/>') +
    '</a:prstGeom>' +
    (o.fill ? '<a:solidFill><a:srgbClr val="' + o.fill + '"/></a:solidFill>' : '<a:noFill/>') +
    (o.line ? '<a:ln w="' + (o.lineW || _KD_EMU) + '"><a:solidFill><a:srgbClr val="' + o.line + '"/></a:solidFill></a:ln>' : '<a:ln><a:noFill/></a:ln>') +
    '</p:spPr>' +
    '<p:txBody><a:bodyPr wrap="' + (o.wrap || 'none') + '" lIns="0" tIns="0" rIns="0" bIns="0" anchor="' + (o.anchor || 'ctr') + '"/><a:lstStyle/>' +
    (paras || '<a:p/>') + '</p:txBody></p:sp>';
}
function _pptxPic(id, relId, x, y, w, h, crop) {
  return '<p:pic><p:nvPicPr><p:cNvPr id="' + id + '" name="Photo"/>' +
    '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="' + relId + '"/>' +
    (crop ? '<a:srcRect l="' + crop.l + '" t="' + crop.t + '" r="' + crop.r + '" b="' + crop.b + '"/>' : '') +
    '<a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    '<p:spPr><a:xfrm><a:off x="' + _E(x) + '" y="' + _E(y) + '"/><a:ext cx="' + _E(w) + '" cy="' + _E(h) + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
}
// srcRect percentages (1/1000 %) emulating CSS object-fit:cover with
// object-position:center top — crop sides when too wide, bottom when too tall.
function _coverCrop(imgW, imgH, boxW, boxH) {
  if (!imgW || !imgH) return null;
  const ia = imgW / imgH, ba = boxW / boxH;
  if (ia > ba * 1.001) { const c = Math.round((1 - ba / ia) * 50000); return { l: c, r: c, t: 0, b: 0 }; }
  if (ia < ba * 0.999) return { l: 0, r: 0, t: 0, b: Math.round((1 - ia / ba) * 100000) };
  return null;
}

// The left field grid as a REAL PowerPoint table (a:tbl) — rows stay editable
// and our own pptx importer can read the values back.
function _kdFieldTable(id, fields) {
  const G = _KD_GEO.tbl, C = _KD_COLORS;
  const line = (tag) => '<a:' + tag + ' w="' + _KD_EMU + '" cap="flat">' +
    '<a:solidFill><a:srgbClr val="' + C.line + '"/></a:solidFill><a:prstDash val="solid"/></a:' + tag + '>';
  const rows = fields.map(f => {
    const label =
      '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>' +
      _pptxPara(_pptxRun(f.label, { sz: _SZ(G.labelSize), color: C.muted })) +
      (f.sub ? _pptxPara(_pptxRun(f.sub, { sz: _SZ(G.subSize), color: C.faint })) : '') +
      '</a:txBody><a:tcPr marL="' + _E(G.padL) + '" marR="' + _E(4) + '" marT="0" marB="0" anchor="ctr">' +
      line('lnB') + '<a:solidFill><a:srgbClr val="' + C.thBg + '"/></a:solidFill></a:tcPr></a:tc>';
    const val =
      '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>' +
      _pptxPara(_pptxRun(f.val, { sz: _SZ(G.valSize), b: 1, color: f.color || C.text, mono: f.mono }), 'ctr') +
      '</a:txBody><a:tcPr marL="' + _E(4) + '" marR="' + _E(4) + '" marT="0" marB="0" anchor="ctr">' +
      line('lnR') + line('lnB') + '<a:solidFill><a:srgbClr val="' + C.white + '"/></a:solidFill></a:tcPr></a:tc>';
    return '<a:tr h="' + _E(G.rowH) + '">' + label + val + '</a:tr>';
  }).join('');
  return '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="' + id + '" name="Fields"/>' +
    '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
    '<p:xfrm><a:off x="0" y="' + _E(G.y) + '"/><a:ext cx="' + _E(G.w) + '" cy="' + _E(G.rowH * fields.length) + '"/></p:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
    '<a:tbl><a:tblPr/><a:tblGrid>' +
    '<a:gridCol w="' + _E(G.labelW) + '"/><a:gridCol w="' + _E(G.w - G.labelW) + '"/>' +
    '</a:tblGrid>' + rows + '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
}

// Build the full spTree for one worker's KD card (same fields/layout as
// _renderKdCard — keep the two in sync if the card design ever changes).
function _kdCardSlideXml(w, g, gc, photo) {
  const C = _KD_COLORS, G = _KD_GEO;
  const CARD_W = 1000, CARD_H = 625;
  let id = 2;
  const parts = [];

  // card background + outer hairline
  parts.push(_pptxSp(id++, 0, 0, CARD_W, CARD_H, { name: 'Card', fill: C.card, line: C.line }));

  // top strip: worker code · gender pill · blood letters, hairline below
  parts.push(_pptxSp(id++, G.top.codeX, 0, 400, G.top.h, { name: 'Code' },
    _pptxPara(_pptxRun(w.worker_id || w.employer_code || '—', { sz: _SZ(G.top.codeSize), b: 1 }))));
  if (w.sex === 'M' || w.sex === 'F') {
    const m = w.sex === 'M';
    parts.push(_pptxSp(id++, G.top.pillX, G.top.pillY, G.top.pillW, G.top.pillH,
      { name: 'Gender', round: 1, adj: 50000, fill: m ? C.genderMBg : C.genderFBg },
      _pptxPara(_pptxRun(m ? '♂' : '♀', { sz: _SZ(G.top.pillSize), b: 1, color: m ? C.genderMTx : C.genderFTx }), 'ctr')));
  }
  const bloodRuns = ['A', 'B', 'O', 'AB'].map(b => {
    const on = w.blood === b;
    return _pptxRun(b, { sz: _SZ(G.top.bloodSize), b: on ? 1 : 0, u: on ? 1 : 0, color: on ? C.green : C.faint });
  }).join(_pptxRun('  ', { sz: _SZ(G.top.bloodSize), color: C.faint }));
  parts.push(_pptxSp(id++, G.top.bloodsX, G.top.bloodsY, G.top.bloodsEndX - G.top.bloodsX, G.top.bloodsH,
    { name: 'Bloods' }, _pptxPara(bloodRuns, 'r')));
  parts.push(_pptxSp(id++, 0, G.top.h - 1, CARD_W, 1, { name: 'TopLine', fill: C.line }));

  // brown header bar: supervisor + sequence
  parts.push(_pptxSp(id++, 0, G.head.y, CARD_W, G.head.h, { name: 'HeadBar', fill: C.brown }));
  const seq = w.worker_id ? w.worker_id.split('-').pop() : '';
  parts.push(_pptxSp(id++, G.head.padX, G.head.y, 700, G.head.h, { name: 'Supervisor' },
    _pptxPara(_pptxRun(w.group_supervisor || '—', { sz: _SZ(G.head.lSize), b: 1, color: C.white }))));
  parts.push(_pptxSp(id++, CARD_W - G.head.padX - 300, G.head.y, 300, G.head.h, { name: 'Seq' },
    _pptxPara(_pptxRun(seq || '', { sz: _SZ(G.head.rSize), color: C.white }), 'r')));

  // left column: the 10-row field table (native, editable)
  const wh = (w.weight ? w.weight + 'Kg' : '--') + ' ; ' + (w.height ? w.height + 'Cm' : '--');
  const expCls = expiryClass(w.passport_expiry);
  const expColor = expCls === 'expiry-expired' ? C.expired
                 : (expCls === 'expiry-warn' || expCls === 'expiry-near') ? 'B45309' : C.text;
  parts.push(_kdFieldTable(id++, [
    { label: 'Name',            sub: 'ຊື່',             val: w.en_name || '--' },
    { label: 'ຊື່ ນາມສະກຸນ',      sub: '',               val: w.lo_name || '--' },
    { label: 'Date of birth',   sub: 'ວັນເດືອນປີເກີດ',   val: w.dob || '--' },
    { label: 'Village',         sub: 'ບ້ານ',            val: w.village || '--' },
    { label: 'Weight ; Height', sub: 'Kg ; Cm',        val: wh },
    { label: 'Size',            sub: 'ຂະໜາດ',           val: w.size || '--' },
    { label: 'Blood',           sub: 'ກຸ່ມເລືອດ',        val: w.blood || '--' },
    { label: 'Passport No',     sub: 'ເລກໜັງສື',        val: w.passport_no || '--', mono: 1 },
    { label: 'Date of expiry',  sub: 'ໝົດອາຍຸ',         val: w.passport_expiry || '--', color: expColor },
    { label: 'Tel',             sub: 'ໂທ',              val: w.tel || '--' },
  ]));

  // right column: photo box (image with cover-crop, or initials), couple chip
  parts.push(_pptxSp(id++, G.photo.x, G.photo.y, G.photo.w, G.photo.h, { name: 'PhotoBox', fill: C.fieldBg }));
  if (photo) {
    parts.push(_pptxPic(id++, photo.relId, G.photo.x, G.photo.y, G.photo.w, G.photo.h,
      _coverCrop(photo.w, photo.h, G.photo.w, G.photo.h)));
  } else {
    parts.push(_pptxSp(id++, G.photo.x, G.photo.y, G.photo.w, G.photo.h, { name: 'Initials' },
      _pptxPara(_pptxRun(avatarInitials(w.en_name || '?'), { sz: _SZ(G.photo.initialsSize), b: 1, color: C.faint }), 'ctr')));
  }
  if (w.couple === 'yes') {
    parts.push(_pptxSp(id++, G.couple.x, G.couple.y, G.couple.w, G.couple.h,
      { name: 'Couple', round: 1, adj: 20000, fill: C.brown },
      _pptxPara(_pptxRun('부부', { sz: _SZ(G.couple.size), color: C.white }), 'ctr')));
  }

  // summary block under the photo
  const assigned = (g && g.assigned != null && g.assigned !== '') ? g.assigned : 0;
  const arrivals = (g && g.arrivals != null && g.arrivals !== '') ? g.arrivals : 0;
  const S = G.sum, sumW = CARD_W - S.x;
  parts.push(_pptxSp(id++, S.x, S.y, sumW, S.headH, { name: 'SumHead', fill: C.brown },
    _pptxPara(_pptxRun(t('kd_summary') || 'Summary', { sz: _SZ(S.size), b: 1, color: C.white }), 'ctr')));
  const sumRows = [
    ['여성 (ຍ)', String(gc.f)], ['남성 (ຊ)', String(gc.m)],
    ['배정 · ' + (t('kd_assigned') || ''), String(assigned)],
    ['입국 · ' + (t('kd_arrivals') || ''), String(arrivals)],
  ];
  sumRows.forEach((r, i) => {
    const y = S.y + S.headH + i * S.rowH;
    parts.push(_pptxSp(id++, S.x + S.padX, y, sumW - 2 * S.padX, S.rowH, { name: 'SumL' + i },
      _pptxPara(_pptxRun(r[0], { sz: _SZ(S.size), color: C.muted }))));
    parts.push(_pptxSp(id++, S.x + S.padX, y, sumW - 2 * S.padX, S.rowH, { name: 'SumV' + i },
      _pptxPara(_pptxRun(r[1], { sz: _SZ(S.size), b: 1 }), 'r')));
    if (i < sumRows.length - 1)
      parts.push(_pptxSp(id++, S.x, y + S.rowH - 1, sumW, 1, { name: 'SumLine' + i, fill: C.line }));
  });
  parts.push(_pptxSp(id++, S.x, S.y, sumW, 1, { name: 'SumTop', fill: C.line }));
  // vertical divider between field table and photo column
  parts.push(_pptxSp(id++, G.tbl.w - 1, G.tbl.y, 1, CARD_H - G.tbl.y, { name: 'MidLine', fill: C.line }));

  return parts.join('');
}

// Fetch + normalise a worker photo for embedding: keep png/jpg bytes as-is,
// re-encode anything else (webp…) to PNG via canvas so PowerPoint accepts it.
async function _preparePptxPhoto(src) {
  const got = await _fetchImageBytes(src);
  if (!got) return null;
  try {
    const blob = new Blob([got.bytes], { type: got.mime || 'image/jpeg' });
    const bmp = await createImageBitmap(blob);
    const out = { w: bmp.width, h: bmp.height };
    if (/png/.test(got.mime))        { out.ext = 'png'; out.bytes = got.bytes; }
    else if (/jpe?g/.test(got.mime)) { out.ext = 'jpg'; out.bytes = got.bytes; }
    else {
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      const b = await new Promise(r => c.toBlob(r, 'image/png'));
      out.ext = 'png'; out.bytes = new Uint8Array(await b.arrayBuffer());
    }
    if (bmp.close) bmp.close();
    return out;
  } catch (e) { return null; }
}

async function _buildPptx(slides) {
  // slides: [{ spTree, images: [{relId, ext, bytes}] }] — native shapes per slide.
  const n = slides.length;
  const zip = new JSZip();

  let ct = _XH + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpg" ContentType="image/jpeg"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>';
  for (let i = 1; i <= n; i++) ct += '<Override PartName="/ppt/slides/slide' + i + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>';
  ct += '</Types>';
  zip.file('[Content_Types].xml', ct);

  // root rels
  zip.file('_rels/.rels', _pptxRels([{ id: 'rId1', type: _RT.off, target: 'ppt/presentation.xml' }]));

  // presentation.xml + rels
  let sldIds = '', presRels = [{ id: 'rId1', type: _RT.master, target: 'slideMasters/slideMaster1.xml' }];
  for (let i = 1; i <= n; i++) {
    sldIds += '<p:sldId id="' + (255 + i) + '" r:id="rId' + (i + 1) + '"/>';
    presRels.push({ id: 'rId' + (i + 1), type: _RT.slide, target: 'slides/slide' + i + '.xml' });
  }
  presRels.push({ id: 'rId' + (n + 2), type: _RT.theme, target: 'theme/theme1.xml' });
  zip.file('ppt/presentation.xml', _XH +
    '<p:presentation ' + _NS_P + '>' +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:sldIdLst>' + sldIds + '</p:sldIdLst>' +
    '<p:sldSz cx="' + _PPTX_W + '" cy="' + _PPTX_H + '"/>' +
    '<p:notesSz cx="6858000" cy="9144000"/></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', _pptxRels(presRels));

  // theme
  zip.file('ppt/theme/theme1.xml', _PPTX_THEME);

  // slide master + rels
  zip.file('ppt/slideMasters/slideMaster1.xml', _XH +
    '<p:sldMaster ' + _NS_P + '><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>' +
    '<p:spTree>' + _EMPTY_TREE + '</p:spTree></p:cSld>' +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>');
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', _pptxRels([
    { id: 'rId1', type: _RT.layout, target: '../slideLayouts/slideLayout1.xml' },
    { id: 'rId2', type: _RT.theme,  target: '../theme/theme1.xml' },
  ]));

  // slide layout + rels
  zip.file('ppt/slideLayouts/slideLayout1.xml', _XH +
    '<p:sldLayout ' + _NS_P + ' type="blank" preserve="1"><p:cSld name="Blank">' +
    '<p:spTree>' + _EMPTY_TREE + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>');
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', _pptxRels([
    { id: 'rId1', type: _RT.master, target: '../slideMasters/slideMaster1.xml' },
  ]));

  // slides + media (photo images per slide)
  for (let i = 0; i < n; i++) {
    const s = slides[i], idx = i + 1;
    const rels = [{ id: 'rId1', type: _RT.layout, target: '../slideLayouts/slideLayout1.xml' }];
    (s.images || []).forEach((im, j) => {
      const fname = 'image' + idx + '_' + j + '.' + im.ext;
      zip.file('ppt/media/' + fname, im.bytes);
      rels.push({ id: im.relId, type: _RT.image, target: '../media/' + fname });
    });
    zip.file('ppt/slides/slide' + idx + '.xml', _XH +
      '<p:sld ' + _NS_P + '><p:cSld><p:spTree>' + _EMPTY_TREE + s.spTree +
      '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>');
    zip.file('ppt/slides/_rels/slide' + idx + '.xml.rels', _pptxRels(rels));
  }

  return zip.generateAsync({ type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

async function _doKdCardPptx(workers, g) {
  if (typeof _loadJSZip === 'function') { try { await _loadJSZip(); } catch (e) {} }
  if (!window.JSZip) { toast(bi('JSZip ບໍ່ໄດ້ໂຫລດ','JSZip not loaded','JSZip ยังไม่โหลด','JSZip가 로드되지 않음'), 'warn'); return; }
  _progressShow(bi('ກຳລັງສ້າງ PowerPoint', 'Creating PowerPoint', 'กำลังสร้าง PowerPoint', 'PowerPoint 생성 중'));
  try {
    const gc = _kdGenderCounts(g);   // identical on every card — compute once
    const slides = [];
    for (let i = 0; i < workers.length; i++) {
      const w = workers[i];
      let photo = null;
      if (w.photo) {
        photo = await _preparePptxPhoto(w.photo);
        if (photo) photo.relId = 'rId2';
      }
      slides.push({ spTree: _kdCardSlideXml(w, g, gc, photo), images: photo ? [photo] : [] });
      _progressSet((i + 1) / workers.length * 90, bi('ສ້າງສະໄລ້ ', 'Creating slide ', 'สร้างสไลด์ ', '슬라이드 생성 중 ') + (i + 1) + '/' + workers.length);
      await _paint();
    }
    if (!slides.length) { toast(bi('ບໍ່ມີຂໍ້ມູນ','No data','ไม่มีข้อมูล','데이터 없음'), 'warn'); return; }
    _progressSet(95, bi('ປະກອບໄຟລ໌...', 'Assembling file…', 'ประกอบไฟล์...', '파일 조합 중…'));
    const blob = await _buildPptx(slides);
    _emitExport(blob, _safeFile(g && g.name, 'workers') + '.pptx');
    toast('PowerPoint ✓', 'ok');
  } catch (e) {
    // native building failed → fall back to the old rasterised (image) slides
    console.warn('native pptx failed, falling back to raster:', e);
    try { await _doKdCardPptxRaster(workers, g); }
    catch (e2) { toast('Export failed: ' + (e2 && e2.message || e2), 'warn'); }
  } finally {
    _progressDone();
  }
}

// Legacy raster path (html2canvas screenshot, one picture per slide) — kept
// only as the fallback when native slide construction throws.
async function _buildPptxRaster(slides) {
  const zip = new JSZip();
  const n = slides.length;
  let ct = _XH + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>';
  for (let i = 1; i <= n; i++) ct += '<Override PartName="/ppt/slides/slide' + i + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>';
  ct += '</Types>';
  zip.file('[Content_Types].xml', ct);
  zip.file('_rels/.rels', _pptxRels([{ id: 'rId1', type: _RT.off, target: 'ppt/presentation.xml' }]));
  let sldIds = '', presRels = [{ id: 'rId1', type: _RT.master, target: 'slideMasters/slideMaster1.xml' }];
  for (let i = 1; i <= n; i++) {
    sldIds += '<p:sldId id="' + (255 + i) + '" r:id="rId' + (i + 1) + '"/>';
    presRels.push({ id: 'rId' + (i + 1), type: _RT.slide, target: 'slides/slide' + i + '.xml' });
  }
  presRels.push({ id: 'rId' + (n + 2), type: _RT.theme, target: 'theme/theme1.xml' });
  zip.file('ppt/presentation.xml', _XH +
    '<p:presentation ' + _NS_P + '>' +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:sldIdLst>' + sldIds + '</p:sldIdLst>' +
    '<p:sldSz cx="' + _PPTX_W + '" cy="' + _PPTX_H + '"/>' +
    '<p:notesSz cx="6858000" cy="9144000"/></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', _pptxRels(presRels));
  zip.file('ppt/theme/theme1.xml', _PPTX_THEME);
  zip.file('ppt/slideMasters/slideMaster1.xml', _XH +
    '<p:sldMaster ' + _NS_P + '><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>' +
    '<p:spTree>' + _EMPTY_TREE + '</p:spTree></p:cSld>' +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>');
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', _pptxRels([
    { id: 'rId1', type: _RT.layout, target: '../slideLayouts/slideLayout1.xml' },
    { id: 'rId2', type: _RT.theme,  target: '../theme/theme1.xml' },
  ]));
  zip.file('ppt/slideLayouts/slideLayout1.xml', _XH +
    '<p:sldLayout ' + _NS_P + ' type="blank" preserve="1"><p:cSld name="Blank">' +
    '<p:spTree>' + _EMPTY_TREE + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>');
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', _pptxRels([
    { id: 'rId1', type: _RT.master, target: '../slideMasters/slideMaster1.xml' },
  ]));
  for (let i = 0; i < n; i++) {
    const s = slides[i], idx = i + 1;
    // Fit the card image inside the slide, centred, preserving aspect.
    const padY = Math.round(_PPTX_H * 0.05);
    let drawH = _PPTX_H - 2 * padY;
    let drawW = Math.round(s.w * (drawH / s.h));
    const maxW = Math.round(_PPTX_W * 0.94);
    if (drawW > maxW) { drawW = maxW; drawH = Math.round(s.h * (drawW / s.w)); }
    const offX = Math.round((_PPTX_W - drawW) / 2);
    const offY = Math.round((_PPTX_H - drawH) / 2);
    zip.file('ppt/media/image' + idx + '.png', s.b64, { base64: true });
    zip.file('ppt/slides/slide' + idx + '.xml', _XH +
      '<p:sld ' + _NS_P + '><p:cSld><p:spTree>' + _EMPTY_TREE +
      '<p:pic><p:nvPicPr><p:cNvPr id="2" name="Card ' + idx + '"/>' +
      '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
      '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
      '<p:spPr><a:xfrm><a:off x="' + offX + '" y="' + offY + '"/><a:ext cx="' + drawW + '" cy="' + drawH + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>' +
      '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>');
    zip.file('ppt/slides/_rels/slide' + idx + '.xml.rels', _pptxRels([
      { id: 'rId1', type: _RT.layout, target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: _RT.image,  target: '../media/image' + idx + '.png' },
    ]));
  }
  return zip.generateAsync({ type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

async function _doKdCardPptxRaster(workers, g) {
  /* The library is fetched on first use now, so this waits for it rather than
     testing whether it happened to be there. Without the await, lazy loading
     would make every card export bail out on the old presence check. */
  try { await _loadHtml2Canvas(); }
  catch (e) { toast(bi('html2canvas ບໍ່ໄດ້ໂຫລດ','html2canvas not loaded','html2canvas ยังไม่โหลด','html2canvas가 로드되지 않음'), 'warn'); return; }
  if (!window.JSZip)       { toast(bi('JSZip ບໍ່ໄດ້ໂຫລດ','JSZip not loaded','JSZip ยังไม่โหลด','JSZip가 로드되지 않음'), 'warn'); return; }
  const slides = [];
  for (let i = 0; i < workers.length; i++) {
    const wrap = document.createElement('div');
    // Native 1:1 capture of the 1920-wide slide surface (see _doKdCardPng).
    wrap.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-999;background:#fff;padding:8px;width:1936px;';
    wrap.innerHTML = _renderKdCard(workers[i], g);
    document.body.appendChild(wrap);
    _kdFitAll(wrap);
    try {
      const canvas = await _rasterise(wrap);
      slides.push({ b64: canvas.toDataURL('image/png').split(',')[1], w: canvas.width, h: canvas.height });
    } finally {
      document.body.removeChild(wrap);
    }
    _progressSet((i + 1) / workers.length * 90, bi('ສ້າງສະໄລ້ ', 'Creating slide ', 'สร้างสไลด์ ', '슬라이드 생성 중 ') + (i + 1) + '/' + workers.length);
    await _paint();
  }
  if (!slides.length) { toast(bi('ບໍ່ມີຂໍ້ມູນ','No data','ไม่มีข้อมูล','데이터 없음'), 'warn'); return; }
  _progressSet(95, bi('ປະກອບໄຟລ໌...', 'Assembling file…', 'ประกอบไฟล์...', '파일 조합 중…'));
  const blob = await _buildPptxRaster(slides);
  _emitExport(blob, _safeFile(g && g.name, 'workers') + '.pptx');
  toast('PowerPoint ✓', 'ok');
}

// ── PDF export (pdf-lib + fontkit, fully client-side) ─────────────
// Real .pdf files with selectable/searchable text — no print dialog, identical
// output on every machine. Noto Sans / Thai / Lao TTFs are embedded (subset);
// Hangul runs are rasterised via canvas (full shaping, no 5 MB Korean font).
// pdf-lib + fontkit do not apply GPOS mark positioning; Lao carries anchored
// forms that survive this, Thai stacked marks may sit slightly off — if that
// proves unacceptable, route Thai runs through the same canvas path as Hangul.
let _pdfLibPromise = null;
function _loadPdfLib() {
  if (!_pdfLibPromise) {
    _pdfLibPromise = Promise.all([
      _loadScript('../../vendor/pdf-lib/pdf-lib.min.js'),
      _loadScript('../../vendor/pdf-lib/fontkit.umd.min.js'),
    ]).then(() => {
      if (!window.PDFLib || !window.fontkit) throw new Error('pdf-lib unavailable');
    }).catch(e => { _pdfLibPromise = null; throw e; });
  }
  return _pdfLibPromise;
}
const _PDF_FONT_FILES = {
  latin: ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf'],
  thai:  ['NotoSansThai-Regular.ttf', 'NotoSansThai-Bold.ttf'],
  lao:   ['NotoSansLao-Regular.ttf', 'NotoSansLao-Bold.ttf'],
};
const _pdfFontBytes = {};
async function _pdfFetchFont(file) {
  if (!_pdfFontBytes[file]) {
    _pdfFontBytes[file] = fetch(new URL('../../vendor/fonts/ttf/' + file, location.href))
      .then(r => { if (!r.ok) throw new Error('font ' + file); return r.arrayBuffer(); });
  }
  return _pdfFontBytes[file];
}
async function _pdfNewDoc() {
  await _loadPdfLib();
  const doc = await PDFLib.PDFDocument.create();
  doc.registerFontkit(window.fontkit);
  const fonts = {};
  for (const key of Object.keys(_PDF_FONT_FILES)) {
    const [rf, bf] = _PDF_FONT_FILES[key];
    // subset:false — fontkit's subsetter drops random glyphs from these Noto
    // statics (letters vanish in Acrobat/MuPDF). Full embed is ~430 KB per
    // Latin face, a fair price for text that always renders.
    fonts[key] = {
      reg:  await doc.embedFont(await _pdfFetchFont(rf), { subset: false }),
      bold: await doc.embedFont(await _pdfFetchFont(bf), { subset: false }),
    };
  }
  return { doc, fonts };
}
function _pdfRgb(hex) {
  return PDFLib.rgb(parseInt(hex.slice(0, 2), 16) / 255,
                    parseInt(hex.slice(2, 4), 16) / 255,
                    parseInt(hex.slice(4, 6), 16) / 255);
}
function _pdfScriptOf(ch) {
  const c = ch.codePointAt(0);
  if (c < 0x0370)                 return 'latin';    // ASCII/Latin-1 — Noto Sans covers all of it
  if (c >= 0x0E00 && c <= 0x0E7F) return 'thai';
  if (c >= 0x0E80 && c <= 0x0EFF) return 'lao';
  if ((c >= 0x1100 && c <= 0x11FF) || (c >= 0x3130 && c <= 0x318F) ||
      (c >= 0xA960 && c <= 0xA97F) || (c >= 0xAC00 && c <= 0xD7FF)) return 'hangul';
  if (c >= 0x2000 && c <= 0x206F) return 'latin';    // general punctuation (— · …)
  if (c >= 0x2600 && c <= 0x27BF) return 'raster';   // ♂ ♀ etc — not in the embedded fonts
  return 'latin';
}
// Split text into same-script runs. Spaces/digits/ASCII punctuation always go
// to the Latin font — the Thai/Lao subsets don't carry full ASCII glyphs.
function _pdfRuns(text) {
  const runs = [];
  let cur = null;
  for (const ch of String(text)) {
    const s = _pdfScriptOf(ch);
    if (cur && cur.script === s) cur.text += ch;
    else { cur = { script: s, text: ch }; runs.push(cur); }
  }
  return runs;
}
// A drawing "pen" bound to one document: measures and draws mixed-script text.
// Hangul is rendered by the browser onto a canvas and embedded as a small PNG.
function _pdfPen(doc, fonts) {
  const hangulCache = {};
  const isRasterRun = s => s === 'hangul' || s === 'raster';
  async function hangulImg(text, size, colorHex, bold) {
    const key = text + '|' + size + '|' + colorHex + '|' + (bold ? 1 : 0);
    if (hangulCache[key]) return hangulCache[key];
    const scale = 4, px = size * scale;
    const font = (bold ? '700 ' : '400 ') + px + 'px "Malgun Gothic","Noto Sans KR",sans-serif';
    const c = document.createElement('canvas');
    let ctx = c.getContext('2d');
    ctx.font = font;
    const m = ctx.measureText(text);
    const asc  = m.actualBoundingBoxAscent  || px * 0.8;
    const desc = m.actualBoundingBoxDescent || px * 0.25;
    c.width = Math.ceil(m.width) + 4; c.height = Math.ceil(asc + desc) + 4;
    ctx = c.getContext('2d');
    ctx.font = font; ctx.fillStyle = '#' + colorHex; ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, 2, Math.ceil(asc) + 2);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const img = await doc.embedPng(await blob.arrayBuffer());
    const out = { img, w: c.width / scale, h: c.height / scale, asc: (Math.ceil(asc) + 2) / scale };
    hangulCache[key] = out;
    return out;
  }
  function measureRun(run, size, bold) {
    if (isRasterRun(run.script)) {
      const c = document.createElement('canvas').getContext('2d');
      c.font = (bold ? '700 ' : '400 ') + (size * 4) + 'px "Malgun Gothic","Noto Sans KR",sans-serif';
      return (c.measureText(run.text).width + 4) / 4;
    }
    const f = fonts[run.script] || fonts.latin;
    return (bold ? f.bold : f.reg).widthOfTextAtSize(run.text, size);
  }
  return {
    measure(text, size, bold) {
      return _pdfRuns(text).reduce((sum, r) => sum + measureRun(r, size, bold), 0);
    },
    // Draw text centred vertically inside a box given in PDF points (top-based).
    // o: { size, bold, color (hex), align 'l'|'c'|'r' }
    async box(page, text, x, yTop, w, h, o) {
      text = String(text == null ? '' : text);
      if (!text) return;
      const size = o.size, bold = !!o.bold, colorHex = o.color || _KD_COLORS.text;
      const runs = _pdfRuns(text);
      const total = runs.reduce((s, r) => s + measureRun(r, size, bold), 0);
      let cx = o.align === 'c' ? x + (w - total) / 2 : o.align === 'r' ? x + w - total : x;
      const pageH = page.getHeight();
      const baseline = pageH - (yTop + h / 2 + size * 0.36);
      for (const r of runs) {
        const rw = measureRun(r, size, bold);
        if (isRasterRun(r.script)) {
          const hi = await hangulImg(r.text, size, colorHex, bold);
          page.drawImage(hi.img, { x: cx, y: baseline - (hi.h - hi.asc), width: hi.w, height: hi.h });
        } else {
          const f = fonts[r.script] || fonts.latin;
          page.drawText(r.text, { x: cx, y: baseline, size,
            font: bold ? f.bold : f.reg, color: _pdfRgb(colorHex) });
        }
        cx += rw;
      }
    },
  };
}
// Photo → cover-cropped JPEG bytes (top-anchored like the on-screen card),
// normalising webp/EXIF through the browser decoder in the process. JPEG keeps
// multi-page card PDFs small — these are photographic images, not line art.
async function _photoToJpgBytes(src, boxW, boxH) {
  const got = await _fetchImageBytes(src);
  if (!got) return null;
  try {
    const bmp = await createImageBitmap(new Blob([got.bytes], { type: got.mime || 'image/jpeg' }));
    const scale = 1.5, W = Math.round(boxW * scale), H = Math.round(boxH * scale);
    const ba = W / H, ia = bmp.width / bmp.height;
    let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
    if (ia > ba)      { sh = bmp.height; sw = sh * ba; sx = (bmp.width - sw) / 2; }
    else if (ia < ba) { sw = bmp.width;  sh = sw / ba; sy = 0; }   // keep the top (forehead)
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);   // JPEG has no alpha
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, W, H);
    if (bmp.close) bmp.close();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
    return new Uint8Array(await blob.arrayBuffer());
  } catch (e) { return null; }
}
function _pdfDownload(bytes, filename) {
  _emitExport(new Blob([bytes], { type: 'application/pdf' }), filename);
}

// KD cards → one card per A4-landscape page, same _KD_GEO as the pptx export
// so the locked layout stays pixel-identical across formats.
async function _doKdCardPdfFile(workers, g) {
  await _loadPdfLib();   // throws early → caller falls back to the print path
  _progressShow(bi('ກຳລັງສ້າງ PDF', 'Creating PDF', 'กำลังสร้าง PDF', 'PDF 생성 중'));
  try {
    const { doc, fonts } = await _pdfNewDoc();
    const pen = _pdfPen(doc, fonts);
    const gc = _kdGenderCounts(g);
    const PW = 841.89, PH = 595.28, MARGIN = 23;
    const S = (PW - 2 * MARGIN) / 1000;                 // card-px → pt
    const ox = MARGIN, oy = (PH - 625 * S) / 2;
    const C = _KD_COLORS, G = _KD_GEO;
    const X = px => ox + px * S, Y = px => oy + px * S; // top-based
    const rect = (page, x, y, w, h, fill, line) => page.drawRectangle({
      x: X(x), y: PH - Y(y) - h * S, width: w * S, height: h * S,
      color: fill ? _pdfRgb(fill) : undefined,
      borderColor: line ? _pdfRgb(line) : undefined,
      borderWidth: line ? 0.7 : undefined,
    });
    const box = (page, text, x, y, w, h, o) =>
      pen.box(page, text, X(x), Y(y), w * S, h * S, { ...o, size: o.size * S });

    for (let i = 0; i < workers.length; i++) {
      const w = workers[i];
      const page = doc.addPage([PW, PH]);
      rect(page, 0, 0, 1000, 625, C.card, C.line);
      // top strip
      await box(page, w.worker_id || w.employer_code || '—', G.top.codeX, 0, 400, G.top.h, { size: G.top.codeSize, bold: 1 });
      if (w.sex === 'M' || w.sex === 'F') {
        const m = w.sex === 'M';
        rect(page, G.top.pillX, G.top.pillY, G.top.pillW, G.top.pillH, m ? C.genderMBg : C.genderFBg);
        await box(page, m ? '♂' : '♀', G.top.pillX, G.top.pillY, G.top.pillW, G.top.pillH,
          { size: G.top.pillSize, bold: 1, color: m ? C.genderMTx : C.genderFTx, align: 'c' });
      }
      let bx = G.top.bloodsEndX;
      for (const b of ['AB', 'O', 'B', 'A']) {           // draw right → left
        const on = w.blood === b;
        const bw = pen.measure(b, G.top.bloodSize * S, on) / S;
        bx -= bw;
        await box(page, b, bx, G.top.bloodsY, bw, G.top.bloodsH,
          { size: G.top.bloodSize, bold: on, color: on ? C.green : C.faint });
        if (on) rect(page, bx, G.top.bloodsY + G.top.bloodsH - 1, bw, 2, C.green);
        bx -= 10;
      }
      rect(page, 0, G.top.h - 1, 1000, 1, C.line);
      // brown header
      rect(page, 0, G.head.y, 1000, G.head.h, C.brown);
      const seq = w.worker_id ? w.worker_id.split('-').pop() : '';
      await box(page, w.group_supervisor || '—', G.head.padX, G.head.y, 700, G.head.h, { size: G.head.lSize, bold: 1, color: C.white });
      await box(page, seq || '', 1000 - G.head.padX - 300, G.head.y, 300, G.head.h, { size: G.head.rSize, color: C.white, align: 'r' });
      // field grid
      const wh = (w.weight ? w.weight + 'Kg' : '--') + ' ; ' + (w.height ? w.height + 'Cm' : '--');
      const expCls = expiryClass(w.passport_expiry);
      const expColor = expCls === 'expiry-expired' ? C.expired
                     : (expCls === 'expiry-warn' || expCls === 'expiry-near') ? 'B45309' : C.text;
      const fields = [
        ['Name', 'ຊື່', w.en_name || '--'],
        ['ຊື່ ນາມສະກຸນ', '', w.lo_name || '--'],
        ['Date of birth', 'ວັນເດືອນປີເກີດ', w.dob || '--'],
        ['Village', 'ບ້ານ', w.village || '--'],
        ['Weight ; Height', 'Kg ; Cm', wh],
        ['Size', 'ຂະໜາດ', w.size || '--'],
        ['Blood', 'ກຸ່ມເລືອດ', w.blood || '--'],
        ['Passport No', 'ເລກໜັງສື', w.passport_no || '--'],
        ['Date of expiry', 'ໝົດອາຍຸ', w.passport_expiry || '--', expColor],
        ['Tel', 'ໂທ', w.tel || '--'],
      ];
      const T = G.tbl, valW = T.w - T.labelW;
      for (let r = 0; r < fields.length; r++) {
        const y = T.y + r * T.rowH;
        rect(page, 0, y, T.labelW, T.rowH, C.thBg);
        rect(page, 0, y + T.rowH - 1, T.w, 1, C.line);
        const [lab, sub, val, vColor] = fields[r];
        if (sub) {
          await box(page, lab, T.padL, y + T.rowH * 0.14, T.labelW - 2 * T.padL, T.rowH * 0.45, { size: T.labelSize, color: C.muted });
          await box(page, sub, T.padL, y + T.rowH * 0.52, T.labelW - 2 * T.padL, T.rowH * 0.36, { size: T.subSize, color: C.faint });
        } else {
          await box(page, lab, T.padL, y, T.labelW - 2 * T.padL, T.rowH, { size: T.labelSize, color: C.muted });
        }
        await box(page, val, T.labelW, y, valW, T.rowH, { size: T.valSize, bold: 1, align: 'c', color: vColor || C.text });
      }
      rect(page, T.w - 1, T.y, 1, 625 - T.y, C.line);
      // photo
      const P = G.photo;
      rect(page, P.x, P.y, P.w, P.h, C.fieldBg);
      const jpg = w.photo ? await _photoToJpgBytes(w.photo, P.w, P.h) : null;
      if (jpg) {
        const img = await doc.embedJpg(jpg);
        page.drawImage(img, { x: X(P.x), y: PH - Y(P.y) - P.h * S, width: P.w * S, height: P.h * S });
      } else {
        await box(page, avatarInitials(w.en_name || '?'), P.x, P.y, P.w, P.h, { size: P.initialsSize, bold: 1, color: C.faint, align: 'c' });
      }
      if (w.couple === 'yes') {
        rect(page, G.couple.x, G.couple.y, G.couple.w, G.couple.h, C.brown);
        await box(page, '부부', G.couple.x, G.couple.y, G.couple.w, G.couple.h, { size: G.couple.size, color: C.white, align: 'c' });
      }
      // summary
      const Su = G.sum, sumW = 1000 - Su.x;
      const assigned = (g && g.assigned != null && g.assigned !== '') ? g.assigned : 0;
      const arrivals = (g && g.arrivals != null && g.arrivals !== '') ? g.arrivals : 0;
      rect(page, Su.x, Su.y, sumW, Su.headH, C.brown);
      await box(page, t('kd_summary') || 'Summary', Su.x, Su.y, sumW, Su.headH, { size: Su.size, bold: 1, color: C.white, align: 'c' });
      const sumRows = [
        ['여성 (ຍ)', String(gc.f)], ['남성 (ຊ)', String(gc.m)],
        ['배정 · ' + (t('kd_assigned') || ''), String(assigned)],
        ['입국 · ' + (t('kd_arrivals') || ''), String(arrivals)],
      ];
      for (let r = 0; r < sumRows.length; r++) {
        const y = Su.y + Su.headH + r * Su.rowH;
        await box(page, sumRows[r][0], Su.x + Su.padX, y, sumW - 2 * Su.padX, Su.rowH, { size: Su.size, color: C.muted });
        await box(page, sumRows[r][1], Su.x + Su.padX, y, sumW - 2 * Su.padX, Su.rowH, { size: Su.size, bold: 1, align: 'r' });
        if (r < sumRows.length - 1) rect(page, Su.x, y + Su.rowH - 1, sumW, 1, C.line);
      }
      _progressSet((i + 1) / workers.length * 95, (i + 1) + '/' + workers.length);
      await _paint();
    }
    _pdfDownload(await doc.save(), _safeFile(g && g.name, 'workers') + '_kd_cards.pdf');
    toast('PDF ✓', 'ok');
  } finally { _progressDone(); }
}

// Worker detail sheet → A4 portrait, header (photo + names) + the same five
// sections as the on-screen detail view (_renderDetailBody). Reads the worker
// record directly — never scrapes the DOM.
async function _doWorkerDetailPdf(w, g) {
  await _loadPdfLib();
  _progressShow(bi('ກຳລັງສ້າງ PDF', 'Creating PDF', 'กำลังสร้าง PDF', 'PDF 생성 중'));
  try {
    const { doc, fonts } = await _pdfNewDoc();
    const pen = _pdfPen(doc, fonts);
    const C = _KD_COLORS;
    const PW = 595.28, PH = 841.89, M = 42;
    let page = doc.addPage([PW, PH]);
    let y = M;                                     // top-based cursor (pt)
    const ensure = (need) => {
      if (y + need > PH - M) { page = doc.addPage([PW, PH]); y = M; }
    };
    // header: photo + names
    const PHOTO = 84;
    page.drawRectangle({ x: M, y: PH - M - PHOTO, width: PHOTO, height: PHOTO, color: _pdfRgb(C.fieldBg) });
    const jpg = w.photo ? await _photoToJpgBytes(w.photo, PHOTO, PHOTO) : null;
    if (jpg) {
      const img = await doc.embedJpg(jpg);
      page.drawImage(img, { x: M, y: PH - M - PHOTO, width: PHOTO, height: PHOTO });
    } else {
      await pen.box(page, avatarInitials(w.en_name || '?'), M, y, PHOTO, PHOTO, { size: 26, bold: 1, color: C.faint, align: 'c' });
    }
    const tx = M + PHOTO + 16;
    await pen.box(page, w.en_name || '—', tx, y + 4, PW - tx - M, 24, { size: 19, bold: 1 });
    await pen.box(page, w.lo_name || '', tx, y + 30, PW - tx - M, 18, { size: 13, color: C.muted });
    if (w.worker_id) await pen.box(page, w.worker_id, tx, y + 52, PW - tx - M, 16, { size: 11, color: C.green, bold: 1 });
    if (g && g.name) await pen.box(page, g.name, tx, y + 68, PW - tx - M, 14, { size: 9.5, color: C.faint });
    y += PHOTO + 18;
    page.drawRectangle({ x: M, y: PH - y, width: PW - 2 * M, height: 1, color: _pdfRgb(C.line) });
    y += 14;

    const age = (w.age != null && w.age !== '') ? w.age : calcAge(w.dob);
    const expCls = expiryClass(w.passport_expiry);
    const expColor = expCls === 'expiry-expired' ? C.expired
                   : (expCls === 'expiry-warn' || expCls === 'expiry-near') ? 'B45309' : C.text;
    const sections = [
      ['ຂໍ້ມູນລະບຸຕົວຕົນ', 'Identity', [
        ['Worker ID', 'ລະຫັດ', w.worker_id || '--'],
        [t('vc_name') || 'Name', 'EN Name', w.en_name || '--'],
        ['ຊື່ ນາມສະກຸນ', 'LO Name', w.lo_name || '--'],
        [t('vc_dob') || 'Date of birth', 'ວັນເດືອນປີ', w.dob || '--'],
        [t('vc_age') || 'Age', 'ອາຍຸ', age ? age + ' yrs' : '--'],
        [t('vc_nationality') || 'Nationality', 'ສັນຊາດ', w.nationality || '--'],
        [t('vc_sex') || 'Sex', 'ເພດ', w.sex === 'M' ? '♂ M' : w.sex === 'F' ? '♀ F' : '--'],
      ]],
      ['ທີ່ຢູ່', 'Address', [
        ['Province', 'ແຂວງ', w.province || '--'],
        ['District', 'ເມືອງ', w.district || '--'],
        ['Village', 'ບ້ານ', w.village || '--'],
      ]],
      ['ຂໍ້ມູນຮ່າງກາຍ', 'Physical', [
        [t('vc_weight_height') || 'Weight / Height', 'Kg / Cm',
          (w.weight ? w.weight + ' Kg' : '--') + '   ·   ' + (w.height ? w.height + ' Cm' : '--')],
        [t('vc_size') || 'Size', 'ຂະໜາດ', w.size || '--'],
        [t('vc_hand') || 'Hand', 'ຊ້າຍ/ຂວາ', w.hand === 'R' ? 'R (Right)' : w.hand === 'L' ? 'L (Left)' : '--'],
        [t('vc_blood') || 'Blood', 'ກຸ່ມເລືອດ', w.blood || '--'],
      ]],
      ['ເອກະສານເດີນທາງ', 'Passport', [
        [t('vc_passport') || 'Passport No', 'ເລກທີ', w.passport_no || '--'],
        [t('vc_issue') || 'Issue date', 'ວັນທີອອກ', w.passport_issue || '--'],
        [t('vc_expiry') || 'Expiry', 'ໝົດອາຍຸ', w.passport_expiry || '--', expColor],
      ]],
      ['ຕິດຕໍ່', 'Contact', [
        [t('vc_tel') || 'Tel', 'ໂທຫຼັກ', w.tel || '--'],
        ['Emergency', 'ໂທສຸກເສີນ', w.emg_tel || '--'],
      ]],
    ];
    const ROW = 24, LABW = 180;
    for (const [lo, en, rows] of sections) {
      ensure(30 + ROW);
      await pen.box(page, lo, M, y, 300, 16, { size: 12, bold: 1, color: C.brown });
      const loW = pen.measure(lo, 12, 1);
      await pen.box(page, '/ ' + en, M + loW + 12, y, 200, 16, { size: 10, color: C.faint });
      y += 22;
      for (const r of rows) {
        ensure(ROW);
        page.drawRectangle({ x: M, y: PH - y - ROW, width: PW - 2 * M, height: ROW, color: _pdfRgb(C.thBg), opacity: rows.indexOf(r) % 2 ? 0 : 0.55 });
        await pen.box(page, r[0], M + 8, y, LABW, ROW, { size: 9.5, color: C.muted });
        if (r[1]) {
          const lw = pen.measure(r[0], 9.5, 0);
          await pen.box(page, '· ' + r[1], M + 8 + lw + 6, y, LABW - lw - 14, ROW, { size: 8.5, color: C.faint });
        }
        await pen.box(page, r[2], M + LABW + 12, y, PW - 2 * M - LABW - 20, ROW, { size: 10.5, bold: 1, color: r[3] || C.text });
        page.drawRectangle({ x: M, y: PH - y - ROW, width: PW - 2 * M, height: 0.5, color: _pdfRgb(C.line) });
        y += ROW;
      }
      y += 14;
    }
    _pdfDownload(await doc.save(), _safeFile(w.en_name || w.lo_name, 'worker') + '_detail.pdf');
    toast('PDF ✓', 'ok');
  } finally { _progressDone(); }
}

// ── OVERLAY HELPERS ───────────────────────────────────────────────
// Open-order stack: the last entry is the visually top-most overlay, so Esc
// (and any "close the current dialog" action) always targets the right layer.
let _overlayStack = [];
function openOverlay(id) {
  document.getElementById(id).classList.add('open');
  document.body.classList.add('no-scroll');
  _overlayStack = _overlayStack.filter(x => x !== id);
  _overlayStack.push(id);
}
function closeOverlay(id) {
  document.getElementById(id).classList.remove('open');
  _overlayStack = _overlayStack.filter(x => x !== id);
  if (id === 'view-overlay') _currentViewUid = null;
  /* Drop the administration panes' cached payloads on close. Reopening Settings
   * then shows current numbers rather than a snapshot from an hour ago — and
   * the caches include account lists and session counts, which should not sit
   * in memory longer than the screen that displays them. */
  if (id === 'settings-overlay' && typeof acResetCaches === 'function') acResetCaches();
  if (id === 'cardzoom-overlay') {
    _exitFullscreen();
    clearTimeout(_czIdleT);
    document.getElementById('cardzoom-overlay')?.classList.remove('cz-idle');
    // Catch the detail drawer up with whoever Present ended on (the refresh was
    // skipped per-flip to keep presenting smooth).
    if (_presentDirty) {
      _presentDirty = false;
      const voOpen = document.getElementById('view-overlay')?.classList.contains('open');
      if (voOpen && _currentViewUid) openView(_currentViewUid, true);
    }
  }
  if (!document.querySelector('.overlay.open')) document.body.classList.remove('no-scroll');
}

// Esc / F11 out of fullscreen while the card preview is open → close the overlay
// too, so the app state and the browser's fullscreen state never drift apart.
function _onFullscreenChange() {
  if (document.fullscreenElement) return;
  const cz = document.getElementById('cardzoom-overlay');
  if (cz && cz.classList.contains('open')) closeOverlay('cardzoom-overlay');
}
document.addEventListener('fullscreenchange', _onFullscreenChange);
document.addEventListener('webkitfullscreenchange', _onFullscreenChange);

// Close transient popups when clicking outside them
document.addEventListener('click', e => {
  const w = document.querySelector('.scan-wrap');
  if (w && !w.contains(e.target)) closeScanMenu();
  const more = document.getElementById('sb-more');
  if (more && more.classList.contains('open') && !more.contains(e.target)) closeMoreMenu();
});

// Keyboard shortcut: Ctrl/⌘ + ,  → open Settings (matches the profile-menu hint)
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === ',' && document.body.classList.contains('authed')) {
    e.preventDefault();
    if (!document.getElementById('settings-overlay').classList.contains('open')) openSettings();
  }
});

// ── TRASH (soft-delete bin) ───────────────────────────────────────
let _trashCache = { groups: [], employees: [] };
async function openTrash() {
  if (!isAdmin()) return;
  openOverlay('trash-overlay');
  const body = document.getElementById('trash-body');
  body.innerHTML = '<div class="trash-empty">' + bi('ກຳລັງໂຫລດ...', 'Loading…', 'กำลังโหลด...', '불러오는 중…') + '</div>';
  try { _trashCache = await DB.getTrash(); }
  catch (e) { body.innerHTML = '<div class="trash-empty">' + esc(bi('ໂຫລດບໍ່ສຳເລັດ', 'Failed to load', 'โหลดไม่สำเร็จ', '불러오기 실패') + ': ' + (e.message || e)) + '</div>'; return; }
  renderTrash();
}
function _trashFmtDate(s) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T') + 'Z');   // server time is UTC
  if (isNaN(d)) return s;
  const p = n => String(n).padStart(2, '0');
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function renderTrash() {
  const body = document.getElementById('trash-body');
  const groups = _trashCache.groups || [], employees = _trashCache.employees || [];
  const total = groups.length + employees.length;
  const emptyBtn = document.getElementById('trash-empty-btn');
  if (emptyBtn) emptyBtn.style.display = total ? '' : 'none';
  if (!total) {
    body.innerHTML = '<div class="trash-empty">'
      + '<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" style="opacity:.35;margin-bottom:10px"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
      + '<div>' + bi('ຖັງຂີ້ເຫຍື້ອວ່າງ', 'Trash is empty', 'ถังขยะว่างเปล่า', '휴지통이 비어 있음') + '</div></div>';
    return;
  }
  const restoreLbl = bi('ກູ້ຄືນ', 'Restore', 'กู้คืน', '복원'), delTitle = bi('ລຶບຖາວອນ', 'Delete permanently', 'ลบถาวร', '영구 삭제');
  let h = '';
  if (groups.length) {
    h += '<div class="trash-sec-label">' + bi('ກຸ່ມ', 'Groups', 'กลุ่ม', '그룹') + ' (' + groups.length + ')</div>';
    h += groups.map(g =>
      '<div class="trash-item">'
      + '<div class="trash-item-main"><div class="trash-item-name">📁 ' + esc(g.name || '—') + '</div>'
      + '<div class="trash-item-sub">' + g.count + ' ' + bi('ຄົນ', 'people', 'คน', '명') + ' · ' + bi('ລຶບເມື່ອ ', 'Deleted ', 'ลบเมื่อ ', '삭제일 ') + esc(_trashFmtDate(g.deletedAt)) + '</div></div>'
      + '<button class="trash-btn trash-btn-restore" onclick="restoreTrashItem(\'group\',\'' + esc(g.id) + '\')">↩ ' + restoreLbl + '</button>'
      + '<button class="trash-btn trash-btn-del" title="' + delTitle + '" onclick="purgeTrashItem(\'group\',\'' + esc(g.id) + '\',\'' + esc(g.name || '') + '\')">&#128465;</button>'
      + '</div>').join('');
  }
  if (employees.length) {
    h += '<div class="trash-sec-label">' + bi('ແຮງງານ', 'Workers', 'แรงงาน', '근로자') + ' (' + employees.length + ')</div>';
    h += employees.map(e => {
      const nm = e.en_name || e.lo_name || e.worker_id || e.uid;
      return '<div class="trash-item">'
      + '<div class="trash-item-main"><div class="trash-item-name">👤 ' + esc(nm) + '</div>'
      + '<div class="trash-item-sub">' + (e.groupName ? esc(e.groupName) + ' · ' : '') + bi('ລຶບເມື່ອ ', 'Deleted ', 'ลบเมื่อ ', '삭제일 ') + esc(_trashFmtDate(e.deletedAt)) + '</div></div>'
      + '<button class="trash-btn trash-btn-restore" onclick="restoreTrashItem(\'employee\',\'' + esc(e.uid) + '\')">↩ ' + restoreLbl + '</button>'
      + '<button class="trash-btn trash-btn-del" title="' + delTitle + '" onclick="purgeTrashItem(\'employee\',\'' + esc(e.uid) + '\',\'' + esc(nm) + '\')">&#128465;</button>'
      + '</div>';
    }).join('');
  }
  body.innerHTML = h;
}
async function restoreTrashItem(type, id) {
  try { await DB.restoreTrash(type, id); }
  catch (e) { toast('Restore failed', 'warn'); return; }
  toast(bi('ກູ້ຄືນສຳເລັດ', 'Restored', 'กู้คืนสำเร็จ', '복원됨'), 'ok');
  try { _trashCache = await DB.getTrash(); } catch (e) {}
  renderTrash();
  refreshAll();
}
function purgeTrashItem(type, id, name) {
  showConfirm(bi('ລຶບຖາວອນ', 'Delete permanently', 'ลบถาวร', '영구 삭제'),
    bi('ລຶບ "' + name + '" ຖາວອນ? ກູ້ຄືນບໍ່ໄດ້ອີກ.', 'Delete "' + name + '" permanently? This cannot be undone.', 'ลบ "' + name + '" ถาวร? กู้คืนไม่ได้อีก', '"' + name + '"을(를) 영구 삭제할까요? 되돌릴 수 없습니다.'),
    async () => {
      try { await DB.purgeTrash(type, id); } catch (e) { toast('Delete failed', 'warn'); return; }
      try { _trashCache = await DB.getTrash(); } catch (e) {}
      renderTrash();
      toast(bi('ລຶບຖາວອນແລ້ວ', 'Permanently deleted', 'ลบถาวรแล้ว', '영구 삭제됨'), 'ok');
    });
}
function confirmEmptyTrash() {
  const total = (_trashCache.groups || []).length + (_trashCache.employees || []).length;
  if (!total) return;
  showConfirm(bi('ລ້າງຖັງຂີ້ເຫຍື້ອ', 'Empty trash', 'ล้างถังขยะ', '휴지통 비우기'),
    bi('ລຶບທຸກລາຍການໃນຖັງຖາວອນ? ກູ້ຄືນບໍ່ໄດ້ອີກ.', 'Permanently delete everything in the trash? This cannot be undone.', 'ลบทุกรายการในถังถาวร? กู้คืนไม่ได้อีก', '휴지통의 모든 항목을 영구 삭제할까요? 되돌릴 수 없습니다.'),
    async () => {
      try { await DB.emptyTrash(); } catch (e) { toast('Empty failed', 'warn'); return; }
      _trashCache = { groups: [], employees: [] };
      renderTrash();
      toast(bi('ລ້າງຖັງແລ້ວ', 'Trash emptied', 'ล้างถังแล้ว', '휴지통을 비웠습니다'), 'ok');
    });
}

// Click outside to close
['view-overlay','form-overlay','group-overlay','confirm-overlay','settings-overlay','import-overlay','scan-overlay','docview-overlay','photo-editor-overlay','export-overlay','create-overlay','customize-overlay','trash-overlay'].forEach(id => {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target.id !== id) return;
    // Worker form: clicking outside / accidental close → auto-save so data isn't lost
    if (id === 'form-overlay') { autoSaveWorkerForm(); return; }
    closeOverlay(id);
  });
});

// Auto-save the worker form if it holds any meaningful data; otherwise just close.
function autoSaveWorkerForm() {
  const hasData =
    (document.getElementById('f-en-name')?.value || '').trim() ||
    (document.getElementById('f-lo-name')?.value || '').trim() ||
    (document.getElementById('f-passport-no')?.value || '').trim() ||
    (document.getElementById('f-photo')?.value || '') ||
    (window._pendingScanDocs && window._pendingScanDocs.length);
  if (hasData && typeof saveWorker === 'function') {
    saveWorker();   // saves + closes + refreshes
    toast(bi('💾 ບັນທຶກອັດຕະໂນມັດ','💾 Auto-saved','💾 บันทึกอัตโนมัติ','💾 자동 저장됨'), 'ok');
  } else {
    closeOverlay('form-overlay');
  }
}

// ── LANGUAGE ──────────────────────────────────────────────────────
document.querySelectorAll('.lang-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    setLang(btn.dataset.lang);
    if (!document.body.classList.contains('authed')) return;
    rebuildFilters();
    renderTable();
    renderSidebar();
    renderSidebarUser();
    renderStats();
    // Re-render the dashboard's dynamic content (chart labels, pills, reminders)
    if (document.getElementById('dashboard-welcome')?.style.display !== 'none') renderDashboard();
    if (document.getElementById('settings-overlay').classList.contains('open')) renderSettings();
  });
});

/* ══════════════════════════════════════════════════════════════════
 * SETTINGS — the administration centre shell (P4)
 * ══════════════════════════════════════════════════════════════════
 * The tab list is derived from the DOM rather than hard-coded: adding a pane in
 * index.html is all it takes for it to work here, which is what stopped the old
 * eight-entry array from silently going stale.
 *
 * Visibility is decided by PERMISSION, not by role. A nav item carries
 * data-perm="x.y" (or "a|b" for either), and applySettingsPermissions() hides
 * what the account cannot use. This replaced `.admin-only`, which tested for
 * "not a viewer" and therefore showed every administrative control to Manager
 * and Employee accounts that the server would then refuse.
 */
function _setTabs() {
  return Array.from(document.querySelectorAll('#set-tabs .set-nav-item')).map(b => b.dataset.tab);
}
let _currentSetTab = 'appearance';

function openSettings() {
  applySettingsPermissions();
  renderSettings();
  const search = document.getElementById('settings-search-input');
  if (search) search.value = '';
  filterSettings('');
  // Land on the first section this account can actually open — for an Auditor
  // that is not the same tab as for an Admin. Locked tabs are skipped, otherwise
  // opening Settings would greet the user with a refusal toast.
  const first = document.querySelector('#set-tabs .set-nav-item:not([hidden]):not(.set-nav-locked)');
  _setSuppressMobileNav = true;
  try { switchSettingsTab(first ? first.dataset.tab : 'appearance'); }
  finally { _setSuppressMobileNav = false; }
  _setMobileRefresh();
  /* A phone opens on the LIST. switchSettingsTab above chose a section so the
   * desktop pane is never blank, but presenting that section first on a phone
   * would hide the fact that there are twenty-three others. */
  if (_setIsMobile()) _setMobileShowList();
  openOverlay('settings-overlay');
}

/* ══════════════════════════════════════════════════════════════════
 * Settings on a phone: two screens instead of two panes
 * ══════════════════════════════════════════════════════════════════
 * The markup is the same at every width. What changes is that the nav becomes a
 * full-screen LIST and the open pane becomes a full-screen SECTION, with only
 * one of them mounted at a time.
 *
 * Nothing here names a section. The list is the nav that already exists, and
 * the section is whichever pane switchSettingsTab already chose — so a section
 * added later appears by itself. (The comment in main.css explains why that
 * property is load-bearing: the previous phone layout hard-coded eight section
 * names and silently lost the other sixteen.)
 */
const SET_MOBILE_MQ = '(max-width: 768px)';
function _setIsMobile() {
  try { return window.matchMedia(SET_MOBILE_MQ).matches; } catch (e) { return false; }
}
function _setModal() { return document.querySelector('#settings-overlay .settings-modal'); }

function _setMobileShowList() {
  const m = _setModal();
  if (!m) return;
  m.classList.add('set-m-list');
  m.classList.remove('set-m-detail');
  const t = document.getElementById('set-mtitle');
  if (t) t.textContent = bi('ຕັ້ງຄ່າ', 'Settings', 'ตั้งค่า', '설정');
  const nav = document.getElementById('set-tabs');
  if (nav) nav.scrollTop = _setListScroll;
}

let _setListScroll = 0;

function _setMobileShowDetail(tab) {
  const m = _setModal();
  if (!m) return;
  const nav = document.getElementById('set-tabs');
  if (nav && m.classList.contains('set-m-list')) _setListScroll = nav.scrollTop;
  m.classList.remove('set-m-list');
  m.classList.add('set-m-detail');
  // The title comes from the pane's own heading, so it is already translated and
  // already correct for any section, including ones that do not exist yet.
  const pane = document.getElementById('set-pane-' + tab);
  const t = document.getElementById('set-mtitle');
  if (t) t.textContent = (pane && pane.querySelector('.ssh-title')?.textContent) || '';
  const body = document.querySelector('#settings-overlay .settings-content');
  if (body) body.scrollTop = 0;
}

/** The back button, the swipe, and the hardware back key all land here. */
function setMobileBack() {
  const m = _setModal();
  if (!m || !m.classList.contains('set-m-detail')) return false;
  _setMobileShowList();
  return true;
}

/** Re-apply the layout after a resize, an orientation change, or a re-open. */
function _setMobileRefresh() {
  const m = _setModal();
  if (!m) return;
  if (!_setIsMobile()) {
    // Back to two panes: neither state class means anything here, and leaving
    // one behind would hide a pane on the desktop.
    m.classList.remove('set-m-list', 'set-m-detail');
    return;
  }
  if (!m.classList.contains('set-m-detail')) _setMobileShowList();
  _setRenderAccountCard();
  _setRenderSummaries();
}

window.addEventListener('resize', () => {
  if (document.getElementById('settings-overlay')?.classList.contains('open')) _setMobileRefresh();
});

/* ── The account card ── */
function _setRenderAccountCard() {
  const u = currentUser || {};
  const name = u.name || u.username || '';
  const av = document.getElementById('set-acct-av');
  if (av) av.textContent = avatarInitials(name || '?');
  const nm = document.getElementById('set-acct-name');
  if (nm) nm.textContent = name;
  const sub = document.getElementById('set-acct-sub');
  if (sub) sub.textContent = u.username && u.username !== name ? u.username : '';
  const role = document.getElementById('set-acct-role');
  if (role) role.textContent = roleLabel(u.role);
}

/* ── The value under each row ──
 * "Theme — System", "Language — ไทย". Only values already in memory: opening
 * Settings must not fire a request per row, and a row whose value needs the
 * server simply shows nothing rather than a spinner or a stale number.
 *
 * An unknown tab returns '' — so this can never be the reason a section fails
 * to appear in the list.
 */
function _setSummary(tab) {
  try {
    switch (tab) {
      case 'appearance': {
        const p = localStorage.getItem('kd_theme') || 'system';
        return bi(
          p === 'dark' ? 'ມືດ' : p === 'light' ? 'ແຈ້ງ' : 'ຕາມລະບົບ',
          p === 'dark' ? 'Dark' : p === 'light' ? 'Light' : 'System',
          p === 'dark' ? 'มืด' : p === 'light' ? 'สว่าง' : 'ตามระบบ',
          p === 'dark' ? '다크' : p === 'light' ? '라이트' : '시스템');
      }
      case 'language': {
        const L = { en: 'English', th: 'ไทย', lo: 'ລາວ', ko: '한국어' };
        return L[currentLang] || currentLang || '';
      }
      case 'timezone':
        return DB.getSetting('timezone', '') ||
               (Intl.DateTimeFormat().resolvedOptions().timeZone || '');
      case 'company':
        return DB.getSetting('company_name', '') || '';
      case 'documents': {
        const n = getDocCats().length;
        return n ? n + ' ' + bi('ໝວດ', n === 1 ? 'category' : 'categories', 'หมวด', '개 분류') : '';
      }
      case 'about':
        // Already fetched at sign-in and cached; never fetched from here.
        return _appVersion ? 'v' + _appVersion : '';
      default:
        return '';
    }
  } catch (e) { return ''; }
}

/** Write every row's value line. Driven by the nav, not by a list of tabs. */
function _setRenderSummaries() {
  document.querySelectorAll('#set-tabs .set-nav-item').forEach(nav => {
    let sub = nav.querySelector('.set-nav-sub');
    const text = _setSummary(nav.dataset.tab);
    if (!text) { if (sub) sub.remove(); return; }
    if (!sub) {
      sub = document.createElement('span');
      sub.className = 'set-nav-sub';
      nav.appendChild(sub);
    }
    sub.textContent = text;
  });
}

/* ── Swipe back ──
 * A drag that starts near the left edge and travels right. Deliberately narrow:
 * the section screens contain horizontally scrollable things (tables, the audit
 * log), and a swipe starting on one of those must scroll it, not leave it. */
(function _setSwipeBack() {
  const modal = () => document.querySelector('#settings-overlay .settings-modal.set-m-detail');
  let x0 = null, y0 = null, live = false;
  document.addEventListener('touchstart', (e) => {
    const m = modal();
    if (!m || e.touches.length !== 1) { live = false; return; }
    const t = e.touches[0];
    live = t.clientX - m.getBoundingClientRect().left < 28;
    x0 = t.clientX; y0 = t.clientY;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!live) return;
    live = false;
    const t = e.changedTouches && e.changedTouches[0];
    if (!t || x0 == null) return;
    const dx = t.clientX - x0, dy = Math.abs(t.clientY - y0);
    if (dx > 70 && dy < 60) setMobileBack();
  }, { passive: true });
})();

/* ── The hardware back key ──
 * Scoped as narrowly as it can be: one history entry, pushed only when a phone
 * opens a section, and consumed only while that section is on screen. Nothing
 * else in the app uses history, and this must not become the reason a browser
 * Back somewhere else behaves oddly. */
let _setPushedState = false;
function _setPushBackTrap() {
  if (_setPushedState) return;
  try { history.pushState({ kdSettings: 1 }, ''); _setPushedState = true; } catch (e) {}
}
window.addEventListener('popstate', () => {
  if (!_setPushedState) return;
  _setPushedState = false;
  const open = document.getElementById('settings-overlay')?.classList.contains('open');
  if (open && _setIsMobile()) { if (!setMobileBack()) closeOverlay('settings-overlay'); }
});

/**
 * Mark the nav items whose permission the account does not hold.
 *
 * LOCKED, NOT HIDDEN (P4.8.1). This used to set `el.hidden`, which failed twice
 * over: `.set-nav-item { display: flex }` outranks the UA `[hidden]` rule, so the
 * item stayed on screen, and switchSettingsTab() then refused it with a bare
 * `return`. A non-admin account saw 17 normal-looking tabs that did nothing at
 * all when clicked, with no explanation.
 *
 * Now the section stays visible — knowing a capability exists is useful, and the
 * server refuses the data regardless — but it is visibly locked and says why when
 * clicked. `hidden` is deliberately never set here: it means "not in the document
 * for anyone", which is not what a permission check means.
 */
function applySettingsPermissions() {
  const can = (spec) => !spec || spec.split('|').some(p => DB.can(p.trim()));
  document.querySelectorAll('#set-tabs .set-nav-item').forEach(nav => {
    const allowed = can(nav.dataset.perm);
    nav.hidden = false;
    nav.classList.toggle('set-nav-locked', !allowed);
    nav.setAttribute('aria-disabled', allowed ? 'false' : 'true');
    const pane = document.getElementById('set-pane-' + nav.dataset.tab);
    if (pane && !allowed) pane.style.display = 'none';
  });
  // Group headings follow their items; with nothing hidden they all stay.
  document.querySelectorAll('#set-tabs .set-nav-group').forEach(g => { g.hidden = false; });
}

/** True when this account may not open `tab`. */
function _setTabLocked(tab) {
  const nav = document.querySelector('#set-tabs .set-nav-item[data-tab="' + tab + '"]');
  return !!(nav && nav.classList.contains('set-nav-locked'));
}

/** The permission(s) a locked tab is waiting on, for the refusal message. */
function _setTabPerm(tab) {
  const nav = document.querySelector('#set-tabs .set-nav-item[data-tab="' + tab + '"]');
  return (nav && nav.dataset.perm) ? nav.dataset.perm.split('|').join(' / ') : '';
}

function switchSettingsTab(tab) {
  if (!tab) return;
  const nav = document.querySelector('#set-tabs .set-nav-item[data-tab="' + tab + '"]');
  /* Refuse out loud. The old silent `return` is what made these read as broken
   * buttons rather than restricted ones. */
  if (nav && nav.classList.contains('set-nav-locked')) {
    const perm = _setTabPerm(tab);
    toast(bi('ບັນຊີນີ້ບໍ່ມີສິດເຂົ້າເບິ່ງສ່ວນນີ້' + (perm ? ' (ຕ້ອງການ: ' + perm + ')' : ''),
             'This account does not have permission to open this section' + (perm ? ' (needs: ' + perm + ')' : ''),
             'บัญชีนี้ไม่มีสิทธิ์เข้าดูส่วนนี้' + (perm ? ' (ต้องการ: ' + perm + ')' : ''),
             '이 계정에는 이 섹션을 열 권한이 없습니다' + (perm ? ' (필요: ' + perm + ')' : '')), 'warn');
    return;
  }
  _currentSetTab = tab;

  document.querySelectorAll('#set-tabs .set-nav-item').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    // Roving tabindex: one stop for the whole tablist, arrows move within it.
    b.tabIndex = on ? 0 : -1;
  });
  _setTabs().forEach(t2 => {
    const p = document.getElementById('set-pane-' + t2);
    if (p) p.style.display = (t2 === tab) ? 'block' : 'none';
  });

  // Panes owned by admin-center.js fetch on first open.
  if (typeof acOwnsTab === 'function' && acOwnsTab(tab)) acRenderTab(tab);

  /* On a phone, choosing a section IS navigating into it. Suppressed for the
   * two internal calls — opening Settings, and clearing the search box — which
   * pick a section without the user having tapped one. */
  if (_setIsMobile() && !_setSuppressMobileNav) {
    _setMobileShowDetail(tab);
    _setPushBackTrap();
  }
}

/* Set while switchSettingsTab is called by the app rather than by a tap. */
let _setSuppressMobileNav = false;

/* ── Settings search (Task 10) ─────────────────────────────────────
 * Matches a section on its keywords, its heading, or any row inside it, and
 * narrows the nav to the hits. Typing "mfa" reaches MFA Policy, "backup"
 * reaches the backup centre, "session" reaches both session screens.
 *
 * Nothing is fetched to search: keywords live on the nav items (data-kw, in all
 * four languages), so a section is findable before its pane has ever loaded.
 */
function filterSettings(q) {
  q = (q || '').trim().toLowerCase();
  const navs = Array.from(document.querySelectorAll('#set-tabs .set-nav-item'))
    .filter(n => !n.hidden);
  const status = document.getElementById('set-search-status');

  if (!q) {
    navs.forEach(n => n.classList.remove('set-nav-hit', 'set-nav-miss'));
    document.querySelectorAll('#settings-overlay .set-row').forEach(r => { r.style.display = ''; });
    document.querySelectorAll('#set-tabs .set-nav-group').forEach(g => { g.hidden = false; });
    if (status) status.textContent = '';
    /* Only re-open the current tab if it is still openable — clearing the search
     * box must never fire a refusal toast the user did not ask for, and on a
     * phone it must not throw the user into a section they were not opening. */
    if (!_setTabLocked(_currentSetTab || 'appearance')) {
      _setSuppressMobileNav = true;
      try { switchSettingsTab(_currentSetTab || 'appearance'); }
      finally { _setSuppressMobileNav = false; }
    }
    return;
  }

  let firstHit = null, hits = 0;
  navs.forEach(nav => {
    const tab = nav.dataset.tab;
    const pane = document.getElementById('set-pane-' + tab);
    const navKw = ((nav.dataset.kw || '') + ' ' + (nav.textContent || '')).toLowerCase();
    const headTxt = pane ? (pane.querySelector('.ssh-title')?.textContent || '').toLowerCase() : '';
    const sectionMatch = navKw.includes(q) || headTxt.includes(q);

    let anyRow = false;
    if (pane) {
      pane.querySelectorAll('.set-row').forEach(r => {
        const kw = ((r.dataset.kw || '') + ' ' + (r.textContent || '')).toLowerCase();
        const m = sectionMatch || kw.includes(q);
        r.style.display = m ? '' : 'none';
        if (m) anyRow = true;
      });
    }
    const show = sectionMatch || anyRow;
    nav.classList.toggle('set-nav-miss', !show);
    nav.classList.toggle('set-nav-hit', show);
    if (show) { hits++; if (!firstHit) firstHit = nav; }
  });

  document.querySelectorAll('#set-tabs .set-nav-group').forEach(g => {
    const items = Array.from(g.querySelectorAll('.set-nav-item')).filter(i => !i.hidden);
    g.hidden = !items.length || items.every(i => i.classList.contains('set-nav-miss'));
  });

  if (status) {
    status.textContent = hits
      ? hits + ' ' + bi('ໝວດທີ່ກົງກັນ', 'matching sections', 'หมวดที่ตรงกัน', '개 일치 섹션')
      : bi('ບໍ່ພົບ', 'No matches', 'ไม่พบ', '일치 항목 없음');
  }
  /* Preview the first hit without stealing focus from the search box. A locked
   * section still counts as a match (the user should find it), but previewing it
   * would toast on every keystroke — so preview the first OPENABLE hit instead. */
  const firstOpenable = navs.find(n => n.classList.contains('set-nav-hit') && !n.classList.contains('set-nav-locked'));
  if (firstOpenable) {
    /* Suppressed on a phone: previewing is a two-pane idea. Here the list IS
     * the result, and jumping into a section on every keystroke would take the
     * search box off screen mid-word. */
    _setSuppressMobileNav = true;
    try { switchSettingsTab(firstOpenable.dataset.tab); }
    finally { _setSuppressMobileNav = false; }
  }
}

/**
 * Keyboard navigation for the settings search and nav (Task 11).
 *
 * ↓/↑ from the search box walk the visible sections, Enter opens the focused
 * one, Escape clears the query. Within the nav the same arrows move between
 * tabs, which is what a screen-reader user expects from role="tablist".
 */
function _setNavVisible() {
  return Array.from(document.querySelectorAll('#set-tabs .set-nav-item'))
    .filter(n => !n.hidden && !n.classList.contains('set-nav-miss') && n.offsetParent !== null);
}

function _setNavKeydown(e) {
  const search = document.getElementById('settings-search-input');
  const fromSearch = e.target === search;

  /* Escape is handled BEFORE the empty-list check below.
   *
   * A query that matches nothing leaves zero visible sections — and that is
   * precisely the moment a user reaches for Escape. Returning early on an empty
   * list let the key fall through to the overlay handler, so "clear what I
   * typed" closed the whole dialog instead. */
  if (e.key === 'Escape' && fromSearch && search.value) {
    /* stopImmediatePropagation, not stopPropagation: the overlay's own Escape
     * handler is bound to `document` as well, and stopPropagation does not stop
     * other listeners on the SAME node. */
    e.preventDefault();
    e.stopImmediatePropagation();
    search.value = '';
    filterSettings('');
    return;
  }

  const items = _setNavVisible();
  if (!items.length) return;
  const idx = fromSearch ? -1 : items.indexOf(e.target);

  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
    e.preventDefault();
    const next = items[Math.min(idx + 1, items.length - 1)] || items[0];
    next.focus(); switchSettingsTab(next.dataset.tab);
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
    e.preventDefault();
    if (idx <= 0) { if (search) search.focus(); return; }
    const prev = items[idx - 1];
    prev.focus(); switchSettingsTab(prev.dataset.tab);
  } else if (e.key === 'Home' && !fromSearch) {
    e.preventDefault(); items[0].focus(); switchSettingsTab(items[0].dataset.tab);
  } else if (e.key === 'End' && !fromSearch) {
    e.preventDefault();
    const last = items[items.length - 1];
    last.focus(); switchSettingsTab(last.dataset.tab);
  } else if (e.key === 'Enter' && fromSearch && items.length) {
    e.preventDefault();
    items[0].focus(); switchSettingsTab(items[0].dataset.tab);
  }
}

/* Capture phase, so this runs before the overlay-level Escape handler and can
 * decide whether the key belongs to the search box. */
document.addEventListener('keydown', (e) => {
  const nav = document.getElementById('set-tabs');
  if (!nav || !nav.contains(e.target)) return;
  _setNavKeydown(e);
}, true);

function renderAppearance() {
  const pref = localStorage.getItem('kd_theme') || 'system';
  // Theme is a bento tile group now — `selected` is the shared state class.
  document.querySelectorAll('.theme-opt').forEach(b => {
    const on = b.dataset.themeVal === pref;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  _syncSetLangDD();
  updateLogoDisplay();
}

// ── Language tiles (Settings → Appearance) ────────────────────────
// This used to be a custom dropdown. It is the same tile group as the profile
// flyout and the sign-in page, all three fed from BC_LANGS.
const _LANG_NAMES = { en: 'English', th: 'ไทย', lo: 'ລາວ', ko: '한국어' };
function _syncSetLangDD() {
  const cur  = (typeof currentLang !== 'undefined' ? currentLang : 'en');
  const grid = document.getElementById('set-lang-grid');
  if (!grid) return;
  if (!grid.children.length) bcGroup(grid, BC_LANGS, cur, changeLangFromSettings);
  else bcMark(grid, cur);
}
// Kept: the document-level outside-click handler still calls this, and older
// bookmarks/keyboard paths may too. There is no dropdown left to close.
function closeSetLangDD() {}

// Language dropdown in Settings → Appearance
function changeLangFromSettings(lang) {
  setLang(lang);
  if (!document.body.classList.contains('authed')) return;
  rebuildFilters(); renderTable(); renderSidebar(); renderSidebarUser(); renderStats();
  if (document.getElementById('dashboard-welcome')?.style.display !== 'none') renderDashboard();
  renderSettings();
  /* The administration panes hold rendered HTML, not data — their strings were
   * baked in the previous language. Drop the caches and re-render the open one
   * so a language switch does not leave half the screen in the old language. */
  if (typeof acResetCaches === 'function') {
    acResetCaches();
    if (typeof acOwnsTab === 'function' && acOwnsTab(_currentSetTab)) acRenderTab(_currentSetTab);
  }
}

// ── Company ───────────────────────────────────────────────────────
function renderCompany() {
  updateLogoDisplay();
  const inp = document.getElementById('set-company-name');
  if (inp) inp.value = DB.getSetting('company_name', '') || '';
}
function saveCompanyName(v) {
  v = (v || '').trim();
  DB.setSetting('company_name', v);
  toast(t('vd_saved') || 'Saved', 'ok');
}

// ── Notifications (passport-expiry thresholds) ────────────────────
function renderNotifPrefs() {
  const w = document.getElementById('set-warn-months');
  const n = document.getElementById('set-near-months');
  if (w) w.value = expiryWarnMonths();
  if (n) n.value = expiryNearMonths();
}
function saveNotifPrefs() {
  const w = parseInt(document.getElementById('set-warn-months').value, 10);
  const n = parseInt(document.getElementById('set-near-months').value, 10);
  if (w > 0) DB.setSetting('warn_months', w);
  if (n > 0) DB.setSetting('near_months', Math.max(w || 1, n));
  renderNotifPrefs();
  // re-render anything that paints expiry state
  renderStats(); renderSidebar();
  if (document.getElementById('dashboard-welcome')?.style.display !== 'none') renderDashboard();
  if (document.getElementById('group-view')?.style.display !== 'none') renderTable();
  toast(t('vd_saved') || 'Saved', 'ok');
}

// ── Data & Backup ─────────────────────────────────────────────────
function renderExportDefault() {
  const cur = DB.getSetting('export_default', 'kd-pdf');
  document.querySelectorAll('#set-export-default button').forEach(b =>
    b.classList.toggle('active', b.dataset.exp === cur));
}
function saveExportDefault(fmt) {
  DB.setSetting('export_default', fmt);
  renderExportDefault();
}
async function doBackupNow() {
  try { const f = await DB.backup(); toast((t('vd_saved') || 'Backup') + ' · ' + f, 'ok'); }
  catch (e) { toast('Backup failed: ' + (e.message || e), 'warn'); }
}
/* toggleRestoreList() was removed in P4. It rendered a bare list of filenames
 * with a Restore button and nothing else — no size, no date, no author, no way
 * to take a copy before overwriting the live database. renderBackupPane() in
 * admin-center.js shows the same files as a history table with all of that,
 * and doRestore() below is still the action it calls. */
function doRestore(file) {
  showConfirm(bi('ກູ້ຄືນຂໍ້ມູນ','Restore data','กู้คืนข้อมูล','데이터 복원'), bi('ກູ້ຄືນຈາກ ','Restore from ','กู้คืนจาก ','복원: ') + file + bi('? ຂໍ້ມູນປັດຈຸບັນຈະຖືກແທນທີ່.','? Current data will be replaced.','? ข้อมูลปัจจุบันจะถูกแทนที่','? 현재 데이터가 대체됩니다.'), async () => {
    try { await DB.restore(file); toast(bi('ກູ້ຄືນສຳເລັດ','Restored','กู้คืนสำเร็จ','복원됨'), 'ok'); closeOverlay('settings-overlay'); refreshAll(); }
    catch (e) { toast('Restore failed: ' + (e.message || e), 'warn'); }
  });
}
async function exportAllData() {
  /* The whole dataset in one file, so it needs the narrowest export grant
   * (export.bundle) and is recorded as such. Before P4.5 this button produced a
   * complete database dump with no permission check and no audit entry. */
  const groups = DB.getGroups();
  const workers = groups.reduce((n, g) => n + ((g.workers || []).length), 0);
  const jrcpt = canExport('json') ? await DB.recordExport('json', 'all-data', workers) : false;
  if (!jrcpt) {
    toast(bi('ບັນຊີນີ້ບໍ່ມີສິດສົ່ງອອກຂໍ້ມູນທັງໝົດ',
             'This account cannot export the full dataset',
             'บัญชีนี้ไม่มีสิทธิ์ส่งออกข้อมูลทั้งหมด',
             '이 계정은 전체 데이터를 내보낼 수 없습니다'), 'warn');
    return;
  }
  /* users comes from the bootstrap cache, which the server already filters to
   * what this account may see (user.view) — so an account without it exports
   * only its own row, not the directory. */
  _rememberReceipt(jrcpt);
  /* The receipt is a first-class field here, not a comment: JSON has nowhere to
   * put one, and a machine-readable provenance block is more useful anyway. */
  const data = {
    exported_at: new Date().toISOString(),
    export_receipt: (jrcpt && jrcpt.exportId) ? {
      id: jrcpt.exportId, issued_to: jrcpt.issuedTo, issued_at: jrcpt.issuedAt,
      tag: jrcpt.tag, notice: jrcpt.watermark,
    } : null,
    groups, cities: DB.getCities(), users: DB.getUsers(),
  };
  _emitExport(JSON.stringify(data, null, 2),
              'kd-database-' + new Date().toISOString().slice(0, 10) + '.json',
              'application/json');
}
function confirmHardReset() {
  showConfirm(t('confirm_delete') || 'Reset', bi('ລ້າງຂໍ້ມູນທັງໝົດຖາວອນ? ບໍ່ສາມາດກູ້ຄືນໄດ້ (ນອກຈາກມີສຳຮອງ).','Permanently erase ALL data? Cannot be undone (unless you have a backup).','ล้างข้อมูลทั้งหมดถาวร? ไม่สามารถกู้คืนได้ (นอกจากมีสำรอง)','모든 데이터를 영구 삭제할까요? 되돌릴 수 없습니다 (백업이 없으면).'), () => {
    DB.hardReset();
    setTimeout(() => location.reload(), 400);
  });
}

/* ── Version, from the server (P4.5) ───────────────────────────────
 * Fetched once from /api/health (unauthenticated, so it also works on the
 * sign-in page) and cached. Replaced three hard-coded "v2.1" strings that had
 * gone stale against a 2.2.0 build — including one sitting in the same dialog as
 * System Health, which read the real version and therefore contradicted it.
 */
let _appVersion = '';
async function loadAppVersion() {
  if (_appVersion) return _appVersion;
  try {
    const r = await fetch('/api/health', { credentials: 'same-origin' });
    const j = await r.json();
    _appVersion = (j && j.version) || '';
  } catch (e) { _appVersion = ''; }
  applyVersionLabels();
  return _appVersion;
}

function applyVersionLabels() {
  const v = _appVersion ? 'v' + _appVersion : '';
  const sb = document.getElementById('sb-version');
  if (sb) sb.textContent = 'Management' + (v ? ' ' + v : '');
  const ab = document.getElementById('set-about-ver');
  if (ab) ab.textContent = 'KD Employment Co., Ltd · Management' + (v ? ' ' + v : '');
}

// ── About ─────────────────────────────────────────────────────────
function renderAbout() {
  const el = document.getElementById('set-about-stats');
  if (!el) return;
  const groups = DB.getGroups();
  const workers = groups.reduce((n, g) => n + (g.workers || []).length, 0);
  const cities = DB.getCities();
  const cityCount = (cities.kr || []).length + (cities.la || []).length;
  const rows = [
    [bi('ກຸ່ມ', 'Groups', 'กลุ่ม', '그룹'), groups.length],
    [bi('ແຮງງານ', 'Workers', 'แรงงาน', '근로자'), workers],
    [bi('ເມືອງ', 'Cities', 'เมือง', '도시'), cityCount],
  ];
  // The account directory is filtered server-side to what the caller may see,
  // so this count is only meaningful — and only shown — with user.view.
  if (DB.can('user.view')) rows.push([bi('ຜູ້ໃຊ້', 'Users', 'ผู้ใช้', '사용자'), DB.getUsers().length]);
  el.innerHTML = rows.map(([k, v]) =>
    '<div class="set-item"><span class="set-name" style="flex:1">' + k + '</span>' +
    '<span class="set-code">' + v + '</span></div>').join('');
}

/**
 * Populate the panes that are cheap and local.
 *
 * Everything expensive — anything that needs a server round trip — is rendered
 * by admin-center.js when its tab is opened, not here. Rendering all of it up
 * front would fire a dozen requests every time Settings opens, most of them for
 * screens the operator never looks at.
 */
function renderSettings() {
  renderAppearance();
  renderAbout();
  loadAppVersion();          // fills the About + sidebar version labels
  // Workspace panes are gated on settings.update, the same permission their
  // controls need to save anything.
  if (DB.can('settings.update')) {
    renderCompany();
    renderCityList('kr');
    renderCityList('la');
    renderLocDictSettings();
    renderDocCatsSettings();
    renderReqFields();
    renderNotifPrefs();
  }
  if (DB.can('export.excel') || DB.can('import.execute')) renderExportDefault();
}

// ── Document categories (Settings → Documents) — admin-configurable ──
// Document types. Deliberately the same card/row/handle vocabulary as the
// Location Dictionary below — both are "a reorderable list of named things",
// so they should not look like two different products.
function renderDocCatsSettings(editIdx) {
  const el = document.getElementById('set-doccats-list'); if (!el) return;
  const cats = getDocCats();
  const rows = cats.map((c, i) => {
    if (i === editIdx) {
      return '<div class="locdict-row set-item-editing">' +
        '<input id="set-doccat-edit-' + i + '" class="locdict-name-in" value="' + esc(c.label) + '" ' +
        'onkeydown="if(event.key===\'Enter\')saveDocCat(' + i + ');if(event.key===\'Escape\')renderDocCatsSettings();">' +
        '<button class="locdict-ic" onclick="saveDocCat(' + i + ')" title="Save">&#x2713;</button>' +
        '<button class="locdict-ic danger" onclick="renderDocCatsSettings()" title="Cancel">&#10005;</button>' +
        '</div>';
    }
    return '<div class="locdict-row" data-drag="' + esc(c.key) + '">' +
      _dragHandle() +
      '<span class="set-name" style="flex:1">' + esc(c.label) + '</span>' +
      '<button class="locdict-ic" onclick="renderDocCatsSettings(' + i + ')" title="Edit">&#x270E;</button>' +
      (cats.length > 1 ? '<button class="locdict-ic danger" onclick="delDocCat(' + i + ')" title="Delete">&#10005;</button>' : '') +
      '</div>';
  }).join('');
  el.innerHTML = '<div class="locdict-rows" id="doccat-rows">' + (rows || '<div class="set-empty">—</div>') + '</div>';
  _initDragReorder(document.getElementById('doccat-rows'), _reorderDocCats);
  if (editIdx !== undefined) {
    const inp = document.getElementById('set-doccat-edit-' + editIdx);
    if (inp) { inp.focus(); inp.select(); }
  }
}
// The array order IS the display order everywhere (detail drawer, export), and
// it is persisted server-side via doc_cats.
function _reorderDocCats(keys) {
  if (!DB.can('settings.update')) return;   // server enforces the same permission
  const cats = getDocCats();
  const by = new Map(cats.map(c => [c.key, c]));
  const next = keys.map(k => by.get(k)).filter(Boolean);
  cats.forEach(c => { if (!next.includes(c)) next.push(c); });   // never drop one the DOM didn't list
  _saveDocCats(next);
  renderDocCatsSettings();
}
// Required-field picker (Settings → Documents): which fields the data-% counts.
function renderReqFields() {
  const el = document.getElementById('set-reqfields-list'); if (!el) return;
  const sel = new Set(getReqFields());
  el.innerHTML = _reqFieldCatalog().map(([key, label]) =>
    '<label class="reqf-item">' +
      '<input type="checkbox"' + (sel.has(key) ? ' checked' : '') + (DB.can('settings.update') ? '' : ' disabled') +
        ' onchange="toggleReqField(\'' + key + '\',this.checked)">' +
      '<span>' + esc(label) + '</span>' +
    '</label>'
  ).join('');
}
function toggleReqField(key, on) {
  if (!DB.can('settings.update')) return;   // server enforces the same permission
  let cur = getReqFields().slice();
  if (on) { if (!cur.includes(key)) cur.push(key); }
  else    { cur = cur.filter(k => k !== key); }
  if (!cur.length) { cur = ['en_name']; renderReqFields(); }   // never empty
  DB.setSetting('req_fields', cur);
}
/* ── Settings: why a control did nothing (P4.8) ────────────────────
 * Every "Add"/"Save" in Settings used to `return` silently when its field was
 * empty or the account lacked settings.update, so the click was indistinguishable
 * from a broken button. These two say what happened and put the caret where the
 * fix is. Both return false so a guard can be written as `if (!x) return _setNeedInput(...)`.
 */
function _setNeedInput(inputId, msg) {
  toast(msg || bi('ກະລຸນາໃສ່ຊື່ກ່ອນ', 'Enter a name first', 'กรุณากรอกชื่อก่อน', '먼저 이름을 입력하세요'), 'warn');
  const el = inputId && document.getElementById(inputId);
  if (el) {
    el.focus();
    el.classList.add('set-input-error');
    setTimeout(() => el.classList.remove('set-input-error'), 1200);
  }
  return false;
}
function _setNoPermission() {
  toast(bi('ບັນຊີນີ້ບໍ່ມີສິດແກ້ໄຂການຕັ້ງຄ່າ',
           'This account cannot change settings',
           'บัญชีนี้ไม่มีสิทธิ์แก้ไขการตั้งค่า',
           '이 계정은 설정을 변경할 수 없습니다'), 'warn');
  return false;
}

function _saveDocCats(cats) { DB.setSetting('doc_cats', cats); }
function addDocCat() {
  if (!DB.can('settings.update')) return _setNoPermission();   // server enforces the same permission
  const inp = document.getElementById('set-doccat-name');
  const label = (inp.value || '').trim();
  if (!label) return _setNeedInput('set-doccat-name',
    bi('ໃສ່ຊື່ປະເພດເອກະສານກ່ອນ', 'Enter a document type name first',
       'กรุณากรอกชื่อประเภทเอกสารก่อน', '문서 유형 이름을 먼저 입력하세요'));
  const cats = getDocCats().slice();
  cats.push({ key: 'doc_' + Date.now().toString(36), label });
  _saveDocCats(cats); inp.value = ''; renderDocCatsSettings();
  toast(t('vd_saved') || 'Saved', 'ok');
}
function saveDocCat(i) {
  if (!DB.can('settings.update')) return _setNoPermission();   // server enforces the same permission
  const inp = document.getElementById('set-doccat-edit-' + i);
  const label = inp ? inp.value.trim() : '';
  if (!label) return _setNeedInput('set-doccat-edit-' + i,
    bi('ຊື່ຫວ່າງບໍ່ໄດ້', 'The name cannot be empty', 'ชื่อว่างไม่ได้', '이름은 비워 둘 수 없습니다'));
  const cats = getDocCats().slice();
  if (!cats[i]) return;
  cats[i] = { ...cats[i], label };
  _saveDocCats(cats); renderDocCatsSettings();
  toast(t('vd_saved') || 'Saved', 'ok');
}
function delDocCat(i) {
  if (!DB.can('settings.update')) return _setNoPermission();   // server enforces the same permission
  const cats = getDocCats().slice();
  const c = cats[i]; if (!c) return;
  showConfirm(t('confirm_delete') || 'Delete',
    bi('ລຶບປະເພດເອກະສານ ', 'Remove document type ', 'ลบประเภทเอกสาร ', '문서 유형 제거 ') + '"' + c.label + '"?',
    () => { cats.splice(i, 1); _saveDocCats(cats); renderDocCatsSettings(); });
}

/* ── Company logo (P4.5: moved server-side) ────────────────────────
 * The logo used to live only in this browser's localStorage, which made the
 * setting's own description ("used in sidebar and exports") untrue: nobody but
 * the person who uploaded it, on that one machine, ever saw it — and it vanished
 * whenever the app was opened from a different origin.
 *
 * It is an app_settings value now, like the company name beside it. The
 * localStorage key is still READ as a fallback so an existing upload keeps
 * showing until the next save migrates it.
 */
function companyLogo() {
  try {
    const s = DB.getSetting('company_logo', '');
    if (s) return s;
  } catch (e) {}
  try { return localStorage.getItem('kd_company_logo') || ''; } catch (e) { return ''; }
}

function updateLogoDisplay() {
  const logo = companyLogo();
  const logoImg = logo ? '<img src="' + logo + '" alt="KD">' : 'KD';
  const thLogo = document.getElementById('th-logo-icon');
  if (thLogo) thLogo.innerHTML = logoImg;
  const sbLogo = document.querySelector('.sb-logo');
  if (sbLogo) sbLogo.innerHTML = logoImg;
  const preview = document.getElementById('logo-preview-wrap');
  if (preview) preview.innerHTML = logo
    ? '<img src="' + logo + '" class="logo-preview-img" alt="Logo">'
    : '<span class="logo-preview-text">KD</span>';
  const removeBtn = document.getElementById('logo-remove-btn');
  if (removeBtn) removeBtn.style.display = logo ? 'inline-flex' : 'none';
}

// A logo is inlined as a data URL into every settings payload and export, so it
// is capped. 512 KB is generous for a logo and small enough that it cannot bloat
// the settings row into a performance problem.
const LOGO_MAX_BYTES = 512 * 1024;

function handleLogoUpload(input) {
  const file = input.files[0];
  if (!file) return;
  if (!DB.can('settings.update')) {
    toast(bi('ບໍ່ມີສິດແກ້ໄຂການຕັ້ງຄ່າ', 'You cannot change settings', 'ไม่มีสิทธิ์แก้ไขการตั้งค่า', '설정을 변경할 수 없습니다'), 'warn');
    return;
  }
  if (file.size > LOGO_MAX_BYTES) {
    toast(bi('ໄຟລ໌ໃຫຍ່ເກີນ (ສູງສຸດ 512 KB)', 'File too large (max 512 KB)', 'ไฟล์ใหญ่เกิน (สูงสุด 512 KB)', '파일이 너무 큽니다 (최대 512 KB)'), 'warn');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = function(e) {
    // Server-persisted, so every account on every device sees the same logo.
    DB.setSetting('company_logo', e.target.result);
    try { localStorage.removeItem('kd_company_logo'); } catch (err) {}
    updateLogoDisplay();
    toast(t('vd_saved') || 'Saved', 'ok');
  };
  reader.readAsDataURL(file);
}

function removeCompanyLogo() {
  if (!DB.can('settings.update')) return;
  DB.setSetting('company_logo', '');
  try { localStorage.removeItem('kd_company_logo'); } catch (e) {}
  const inp = document.getElementById('logo-file-input');
  if (inp) inp.value = '';
  updateLogoDisplay();
  toast(t('vd_saved') || 'Saved', 'ok');
}

function renderCityList(country) {
  const cities = DB.getCities()[country] || [];
  const el = document.getElementById('set-' + country + '-list');
  el.innerHTML = cities.length
    ? cities.map(c =>
        '<div class="set-item">' +
          '<span class="set-code">' + esc(c.code) + '</span>' +
          '<span class="set-name">' + esc(c.name) + '</span>' +
          '<button class="set-del" onclick="delCity(\'' + country + '\',\'' + esc(c.code) + '\')" title="Delete">&#x2715;</button>' +
        '</div>'
      ).join('')
    : '<div class="set-empty">—</div>';
}

function addCity(country) {
  if (!DB.can('settings.update')) return _setNoPermission();   // server enforces the same permission
  const name = document.getElementById('set-' + country + '-name').value.trim();
  const code = document.getElementById('set-' + country + '-code').value.trim().toUpperCase();
  /* Native alert() was the odd one out here: every other refusal in Settings is
   * a toast, and alert() cannot be styled, localised or dismissed by keyboard
   * the way the rest of the app is. Same messages, same i18n keys — delivered
   * the way the product delivers everything else. */
  if (!name || !code) return _setNeedInput('set-' + country + (name ? '-code' : '-name'), t('set_need_both'));
  const res = DB.addCity(country, { name, code });
  if (res === 'dup')     return _setNeedInput('set-' + country + '-code', t('set_dup_code'));
  if (res === 'invalid') return _setNeedInput('set-' + country + '-name', t('set_need_both'));
  document.getElementById('set-' + country + '-name').value = '';
  document.getElementById('set-' + country + '-code').value = '';
  renderCityList(country);
  toast(t('vd_saved') || 'Saved', 'ok');
}

function delCity(country, code) {
  if (!DB.can('settings.update')) return _setNoPermission();   // server enforces the same permission
  const c = (DB.getCities()[country] || []).find(x => x.code === code);
  showConfirm(
    t('confirm_delete'),
    t('confirm_del_city', { name: c ? c.name : code, code }),
    () => { DB.deleteCity(country, code); renderCityList(country); }
  );
}

// ── LOCATION DICTIONARY — Settings manager ────────────────────────
let _locEditLevel  = 0;
let _locEditParent = '';

function renderLocDictSettings() {
  const host = document.getElementById('set-locdict');
  if (!host) return;
  const ld = DB.getLocDict();

  let html = '<div class="set-col-title" style="margin-top:24px">' +
    esc(bi('ວັດຈະນານຸກົມສະຖານທີ່ (ກຳນົດເອງ)','Location dictionary (custom)','พจนานุกรมสถานที่ (กำหนดเอง)','위치 사전 (사용자 지정)')) + '</div>' +
    '<div class="set-row-desc" style="margin:-4px 0 12px">' +
    esc(bi('ສ້າງໝວດສະຖານທີ່ເປັນຊັ້ນ (ແຂວງ → ເມືອງ → ບ້ານ) ພ້ອມລະຫັດສັ້ນ. ບໍ່ມັກ? ລຶບໄດ້.','Build hierarchical place categories (Province → District → Village) with short codes. Don\'t like it? Delete it.','สร้างหมวดสถานที่เป็นชั้น (จังหวัด → เมือง → บ้าน) พร้อมรหัสสั้น ไม่ชอบ? ลบได้','계층형 위치 범주 (도 → 시·군 → 마을) 단축 코드 포함. 마음에 안 들면 삭제하세요.')) + '</div>';

  // ── Levels (categories) ──
  // Levels are NOT drag-reorderable, unlike the items below. The order is the
  // geographic hierarchy (Province contains District contains Village), not a
  // preference: reordering only breaks the cascade, since a district's parent is
  // a province no matter where the rows sit. Each level shows the employee
  // column it fills, so that binding stops being invisible.
  html += '<div class="locdict-card"><div class="locdict-sub">' +
    esc(bi('ໝວດ (ຊັ້ນ) — ສູງສຸດ 3','Categories (levels) — max 3','หมวด (ชั้น) — สูงสุด 3','범주 (단계) — 최대 3')) + '</div>';
  html += '<div class="locdict-rows">' + (ld.levels.length
    ? ld.levels.map((lv, i) =>
        '<div class="locdict-row">' +
          '<span class="locdict-lvl-no">' + (i + 1) + '</span>' +
          '<input class="locdict-name-in" value="' + esc(lv.name) + '" onchange="locRenameLevel(\'' + lv.id + '\', this.value)">' +
          '<span class="set-code" title="' + esc(bi('ບັນທຶກລົງຊ່ອງນີ້','Saved into this field','บันทึกลงช่องนี้','이 항목에 저장됨')) + '">' + esc(lv.col || '—') + '</span>' +
          '<button class="locdict-ic danger" onclick="locDelLevel(\'' + lv.id + '\')">&#10005;</button>' +
        '</div>')
      .join('')
    : '<div class="set-empty">—</div>') + '</div>';
  if (ld.levels.length < 3) {
    html += '<div class="set-add-row" style="margin-top:8px">' +
      '<input id="locdict-newlevel" placeholder="' + esc(bi('ຊື່ໝວດ ເຊັ່ນ ແຂວງ','Category e.g. Province','ชื่อหมวด เช่น จังหวัด','범주 예: 도')) + '">' +
      '<button class="btn btn-add btn-sm" onclick="locAddLevel()">' + esc(bi('ເພີ່ມ','Add','เพิ่ม','추가')) + '</button></div>';
  }
  html += '</div>';

  // ── Items (per level, hierarchical) ──
  if (ld.levels.length) {
    if (_locEditLevel >= ld.levels.length) _locEditLevel = 0;
    const lv = ld.levels[_locEditLevel];
    html += '<div class="locdict-card"><div class="locdict-sub">' +
      esc(bi('ລາຍການ · ລາກເພື່ອຈັດລຳດັບ','Items · drag to reorder','รายการ · ลากเพื่อจัดลำดับ','항목 · 끌어서 순서 변경')) + '</div>';
    html += '<div class="locdict-tabs">' + ld.levels.map((l, i) =>
      '<button class="locdict-tab' + (i === _locEditLevel ? ' active' : '') + '" onclick="locSelectEditLevel(' + i + ')">' + esc(l.name) + '</button>').join('') + '</div>';

    let parentOk = true;
    if (_locEditLevel > 0) {
      const pl = ld.levels[_locEditLevel - 1];
      const parents = ld.items.filter(it => it.levelId === pl.id).sort((a, b) => a.order - b.order);
      if (!parents.some(p => p.id === _locEditParent)) _locEditParent = parents[0] ? parents[0].id : '';
      parentOk = !!_locEditParent;
      html += '<div class="locdict-parent"><span class="locdict-parent-lbl">' + esc(pl.name) + '</span>' +
        '<select class="addr-input" onchange="locSelectEditParent(this.value)">' +
        (parents.length ? '' : '<option value="">—</option>') +
        parents.map(p => '<option value="' + esc(p.id) + '"' + (p.id === _locEditParent ? ' selected' : '') + '>' +
          esc(_locName(p)) + (p.code ? ' (' + esc(p.code) + ')' : '') + '</option>').join('') + '</select></div>';
    }

    if (!parentOk) {
      html += '<div class="set-empty">' + esc(bi('ເພີ່ມລາຍການຊັ້ນເທິງກ່ອນ','Add a parent item first','เพิ่มรายการชั้นบนก่อน','상위 항목을 먼저 추가하세요')) + '</div>';
    } else {
      const items = ld.items.filter(it => it.levelId === lv.id && (_locEditLevel === 0 || it.parentId === _locEditParent)).sort((a, b) => a.order - b.order);
      html += '<div class="locdict-rows" id="locdict-items-rows">' + (items.length ? items.map(it => {
        const en = _locEnName(it);
        const sub = it.names.lo && it.names.lo !== en ? ' <span style="color:var(--text-faint);font-weight:400">· ' + esc(it.names.lo) + '</span>' : '';
        return '<div class="locdict-row" data-drag="' + esc(it.id) + '">' +
          _dragHandle() +
          '<span class="set-code">' + esc(it.code || '—') + '</span>' +
          '<span class="set-name" style="flex:1">' + esc(en) + sub + '</span>' +
          '<button class="locdict-ic danger" onclick="locDelItem(\'' + it.id + '\')">&#10005;</button>' +
        '</div>';
      }).join('') : '<div class="set-empty">—</div>') + '</div>';
      html += '<div class="set-add-row" style="margin-top:8px;flex-wrap:wrap">' +
        '<input id="locdict-item-en" style="flex:1 1 120px" placeholder="' + esc(bi('ຊື່ (EN)','Name (EN)','ชื่อ (EN)','이름 (EN)')) + '">' +
        '<input id="locdict-item-lo" style="flex:1 1 120px" placeholder="' + esc(bi('ຊື່ (ລາວ)','Name (Lao)','ชื่อ (ลาว)','이름 (Lao)')) + '" onblur="locAutofillEn(this)">' +
        '<input id="locdict-item-code" class="code-in" maxlength="6" placeholder="Code">' +
        '<button class="btn btn-add btn-sm" onclick="locAddItem()">' + esc(bi('ເພີ່ມ','Add','เพิ่ม','추가')) + '</button></div>';
    }
    html += '</div>';

    // ── Worker ID format ──
    const yy = String(new Date().getFullYear()).slice(-2);
    const srcOpts = [['la', bi('ເມືອງລາວ (ຕົ້ນທາງ)','Lao city (origin)','เมืองลาว (ต้นทาง)','라오스 도시')]]
      .concat(ld.levels.map(l => [l.id, l.name]));
    const sampleCode = (ld.idConfig.source === 'la')
      ? 'PHI'
      : ((ld.items.find(it => it.levelId === ld.idConfig.source) || {}).code || 'XXX');
    const preview = sampleCode + '-' + yy + '-' + String(ld.idConfig.seqStart).padStart(ld.idConfig.seqPad, '0');
    html += '<div class="locdict-card"><div class="locdict-sub">' + esc(bi('ຮູບແບບລະຫັດ Worker ID','Worker ID format','รูปแบบรหัส Worker ID','근로자 ID 형식')) + '</div>';
    html += '<div class="locdict-cfg"><label>' + esc(bi('ດຶງລະຫັດຈາກ','Code from','ดึงรหัสจาก','코드 출처')) + '</label>' +
      '<select class="addr-input" onchange="locSetIdSource(this.value)">' +
      srcOpts.map(([v, lab]) => '<option value="' + esc(v) + '"' + (v === ld.idConfig.source ? ' selected' : '') + '>' + esc(lab) + '</option>').join('') + '</select></div>';
    html += '<div class="locdict-cfg"><label>' + esc(bi('ເລີ່ມລຳດັບ','Start no.','เริ่มลำดับ','시작 번호')) + '</label>' +
      '<input class="set-num-input" type="number" min="1" value="' + ld.idConfig.seqStart + '" onchange="locSetSeqStart(this.value)">' +
      '<label style="margin-left:12px">' + esc(bi('ຫຼັກ','Digits','หลัก','자릿수')) + '</label>' +
      '<input class="set-num-input" type="number" min="1" max="6" value="' + ld.idConfig.seqPad + '" onchange="locSetSeqPad(this.value)"></div>';
    html += '<div class="locdict-preview">' + esc(bi('ຕົວຢ່າງ','Example','ตัวอย่าง','예시')) + ': <b>' + esc(preview) + '</b></div></div>';

    html += '<button class="btn btn-ghost btn-sm locdict-clear" onclick="locClearAll()">' +
      esc(bi('ລຶບວັດຈະນານຸກົມສະຖານທີ່ທັງໝົດ','Delete entire location dictionary','ลบพจนานุกรมสถานที่ทั้งหมด','위치 사전 전체 삭제')) + '</button>';
  }

  host.innerHTML = html;
  // Rebuilt by the line above, so bind fresh every render. Items only — see the
  // note on the levels card for why those are not drag-reorderable.
  _initDragReorder(document.getElementById('locdict-items-rows'), _reorderLocItems);
}

// ── Drag-to-reorder (Settings lists) ──────────────────────────────
// Pointer events, not HTML5 drag-and-drop: the latter is inert on touch and this
// app is used on phones. Rows carry data-drag="<id>" and a .drag-handle; the row
// is moved in the DOM live, and onReorder gets the final id order on drop.
// Listeners live on the rows container, which every render recreates — so there
// is nothing to tear down and no risk of double-binding.
const _DRAG_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">' +
  '<circle cx="6" cy="3" r="1.3"/><circle cx="10" cy="3" r="1.3"/><circle cx="6" cy="8" r="1.3"/>' +
  '<circle cx="10" cy="8" r="1.3"/><circle cx="6" cy="13" r="1.3"/><circle cx="10" cy="13" r="1.3"/></svg>';

function _dragHandle() {
  return '<span class="drag-handle" title="' +
    esc(bi('ລາກເພື່ອຈັດລຳດັບ', 'Drag to reorder', 'ลากเพื่อจัดลำดับ', '끌어서 순서 변경')) + '">' + _DRAG_SVG + '</span>';
}

// opts.anyRole: the list orders a personal preference (e.g. the user's own
// dashboard tiles) rather than shared data, so a viewer may reorder it too.
function _initDragReorder(listEl, onReorder, opts) {
  if (!listEl) return;
  if (!(opts && opts.anyRole) && !isAdmin()) return;
  let row = null, moved = false;
  const rows = () => [...listEl.querySelectorAll('[data-drag]')];

  function onMove(e) {
    if (!row) return;
    e.preventDefault();
    moved = true;
    // Insert before the first other row whose midpoint is below the pointer.
    const after = rows().filter(r => r !== row).find(r => {
      const b = r.getBoundingClientRect();
      return e.clientY < b.top + b.height / 2;
    });
    if (after) listEl.insertBefore(row, after);
    else       listEl.appendChild(row);
  }
  function onUp() {
    if (!row) return;
    row.classList.remove('dragging');
    listEl.classList.remove('drag-active');
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    row = null;
    if (moved) onReorder(rows().map(r => r.dataset.drag));   // a click that never moved must not re-save
  }

  listEl.addEventListener('pointerdown', e => {
    const h = e.target.closest('.drag-handle');
    if (!h) return;
    const r = h.closest('[data-drag]');
    if (!r) return;
    e.preventDefault();
    row = r; moved = false;
    r.classList.add('dragging');
    listEl.classList.add('drag-active');
    // Bind on document, not the handle: the row gets re-inserted mid-drag and
    // pointer capture does not reliably survive that in every browser.
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  });
}

function _locMutate(fn) {
  const ld = DB.getLocDict();
  fn(ld);
  DB.saveLocDict(ld);
  renderLocDictSettings();
}
function locAddLevel() {
  const inp = document.getElementById('locdict-newlevel');
  const name = inp ? inp.value.trim() : '';
  if (!name) return _setNeedInput('locdict-newlevel',
    bi('ໃສ່ຊື່ໝວດກ່ອນ ເຊັ່ນ “ແຂວງ”', 'Enter a category name first, e.g. "Province"',
       'กรุณากรอกชื่อหมวดก่อน เช่น “จังหวัด”', '범주 이름을 먼저 입력하세요 (예: "도")'));
  /* The 3-level ceiling is a real limit (there are only three address columns),
   * so it gets a real message rather than a silent no-op inside _locMutate. */
  const cur = DB.getLocDict();
  if (cur.levels.length >= 3) {
    toast(bi('ມີໄດ້ສູງສຸດ 3 ໝວດ', 'A maximum of 3 categories is supported',
             'มีได้สูงสุด 3 หมวด', '범주는 최대 3개까지 지원됩니다'), 'warn');
    return false;
  }
  _locMutate(ld => {
    ld.enabled = true;
    // Claim the first address column nobody holds yet — a level must own its
    // column outright, never inherit one from where it happens to sit.
    const taken = new Set(ld.levels.map(l => l.col));
    const col = ['province', 'district', 'village'].find(c => !taken.has(c));
    if (!col) return;
    ld.levels.push({ id: DB._newLocId(), name, order: ld.levels.length, col });
  });
  if (inp) inp.value = '';
  toast(t('vd_saved') || 'Saved', 'ok');
}
function locRenameLevel(id, val) {
  _locMutate(ld => { const l = ld.levels.find(x => x.id === id); if (l) l.name = String(val || '').trim() || l.name; });
}
function locDelLevel(id) {
  showConfirm(t('confirm_delete'),
    bi('ລຶບໝວດນີ້ ແລະ ລາຍການທັງໝົດໃນນັ້ນ?','Delete this category and all its items?','ลบหมวดนี้และรายการทั้งหมดในนั้น?','이 범주와 모든 항목을 삭제할까요?'),
    () => _locMutate(ld => {
      ld.levels = ld.levels.filter(l => l.id !== id);
      const ids = new Set(ld.levels.map(l => l.id));
      ld.items = ld.items.filter(it => ids.has(it.levelId));
      if (!ld.levels.length) ld.enabled = false;
    }));
}
function locSelectEditLevel(i) { _locEditLevel = i; _locEditParent = ''; renderLocDictSettings(); }
function locSelectEditParent(v) { _locEditParent = v; renderLocDictSettings(); }
function locAddItem() {
  const enEl   = document.getElementById('locdict-item-en');
  const loEl   = document.getElementById('locdict-item-lo');
  const codeEl = document.getElementById('locdict-item-code');
  const en   = enEl ? enEl.value.trim() : '';
  const lo   = loEl ? loEl.value.trim() : '';
  const code = codeEl ? codeEl.value.trim().toUpperCase() : '';
  if (!en && !lo) return _setNeedInput('locdict-item-en',
    bi('ໃສ່ຊື່ (ອັງກິດ ຫຼື ລາວ) ກ່ອນ', 'Enter a name (English or Lao) first',
       'กรุณากรอกชื่อ (อังกฤษหรือลาว) ก่อน', '이름을 먼저 입력하세요 (영어 또는 라오어)'));
  /* A child item needs a level to hang off. Without one the old code fell into
   * _locMutate and returned from inside the callback — a save that wrote nothing
   * and said nothing. */
  const cur = DB.getLocDict();
  if (!cur.levels[_locEditLevel]) {
    toast(bi('ສ້າງໝວດກ່ອນ', 'Create a category first', 'สร้างหมวดก่อน', '먼저 범주를 만드세요'), 'warn');
    return false;
  }
  _locMutate(ld => {
    const lv = ld.levels[_locEditLevel]; if (!lv) return;
    const parentId = _locEditLevel > 0 ? (_locEditParent || null) : null;
    const sibs = ld.items.filter(it => it.levelId === lv.id && it.parentId === parentId).length;
    ld.items.push({ id: DB._newLocId(), levelId: lv.id, parentId, names: { en: en || lo, lo }, code, order: sibs });
  });
  [enEl, loEl, codeEl].forEach(el => { if (el) el.value = ''; });
  toast(t('vd_saved') || 'Saved', 'ok');
}
function locDelItem(id) {
  _locMutate(ld => {
    ld.items = ld.items.filter(it => it.id !== id);
    let changed = true;
    while (changed) {
      changed = false;
      const ids = new Set(ld.items.map(it => it.id));
      const before = ld.items.length;
      ld.items = ld.items.filter(it => !it.parentId || ids.has(it.parentId));
      if (ld.items.length !== before) changed = true;
    }
  });
}
// Items re-ordered by drag. `ids` is only the currently shown level+parent
// slice, so stamping order by position is enough — siblings elsewhere keep theirs.
function _reorderLocItems(ids) {
  _locMutate(ld => {
    ids.forEach((id, k) => { const it = ld.items.find(x => x.id === id); if (it) it.order = k; });
  });
}
function locSetIdSource(v) { _locMutate(ld => { ld.idConfig.source = v; }); }
function locSetSeqStart(v) { _locMutate(ld => { ld.idConfig.seqStart = Math.max(1, parseInt(v, 10) || 1); }); }
function locSetSeqPad(v)   { _locMutate(ld => { ld.idConfig.seqPad = Math.min(6, Math.max(1, parseInt(v, 10) || 3)); }); }
function locClearAll() {
  showConfirm(t('confirm_delete'),
    bi('ລຶບວັດຈະນານຸກົມສະຖານທີ່ທັງໝົດ? ກັບໄປໃຊ້ການພິມທີ່ຢູ່ແບບເດີມ.','Delete the whole location dictionary? Reverts to free-text address.','ลบพจนานุกรมสถานที่ทั้งหมด? กลับไปใช้การพิมพ์ที่อยู่แบบเดิม','위치 사전 전체를 삭제할까요? 자유 입력 주소로 되돌립니다.'),
    () => { DB.clearLocDict(); _locEditLevel = 0; _locEditParent = ''; renderLocDictSettings(); });
}

/* ── Users & roles ─────────────────────────────────────────────────
 * Moved to shell/scripts/admin-center.js in P4.
 *
 * The versions that lived here could only toggle admin ⇄ viewer, coerced every
 * other role to viewer on the way to the server, and used window.prompt() for
 * password resets. They also wrote through the optimistic queue, so a refusal
 * (weak password, rank violation, last administrator) never reached the
 * operator — the row simply reverted on the next reload.
 *
 * renderUsersPane() / acAddUser() / acResetPassword() / acChangeRole() /
 * acDeleteUser() replace them: server-authoritative, permission-aware, and they
 * surface the reason when the server says no.
 */


// ── FULL REFRESH ──────────────────────────────────────────────────
function refreshAll() {
  renderSidebar();
  renderStats();
  rebuildFilters();
  applyFilters();
  renderTable();
}
