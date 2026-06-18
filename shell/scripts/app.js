/**
 * app.js — Main application logic
 * Depends on: db.js, i18n.js
 */

// ── State ─────────────────────────────────────────────────────────
let activeGroupId = '';
let _currentViewUid = null;  // uid of worker currently shown in detail overlay
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
// Auth lives on a separate page (login.html). If there is no active
// session, bounce straight there; otherwise boot the app.
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await DB.init();
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
function isAdmin() { return !!currentUser && currentUser.role === 'admin'; }

function startApp(user) {
  currentUser = user;
  document.body.classList.add('authed');
  document.body.dataset.role = user.role;

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
    initSaveStatusUI();
    appInited = true;
  }

  applyTranslations();
  renderSidebar();
  renderSidebarUser();
  updateLogoDisplay();

  // Show dashboard view on initial load
  const dw = document.getElementById('dashboard-welcome');
  const gv = document.getElementById('group-view');
  if (dw) dw.style.display = '';
  if (gv) gv.style.display = 'none';
  renderDashboard();
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

// Close sidebar pop-ups (More menu, profile menu) on outside click
document.addEventListener('click', e => {
  const more = document.getElementById('sb-more');
  if (more && more.classList.contains('open') && !more.contains(e.target)) more.classList.remove('open');
  const pm = document.getElementById('sb-profile-menu');
  const footer = document.getElementById('sidebar-footer');
  if (pm && pm.classList.contains('open') && !pm.contains(e.target) && !(footer && footer.contains(e.target)))
    pm.classList.remove('open');
});

function doLogout() {
  DB.logout();
  currentUser = null;
  window.location.replace('login.html');
}

// ── Helpers ───────────────────────────────────────────────────────
function parseDate(s) {
  if (!s) return null;
  const p = s.replace(/-/g, '/').split('/');
  if (p.length < 3) return null;
  return new Date(+p[2], +p[1] - 1, +p[0]);
}
function calcAge(dob) {
  const d = parseDate(dob);
  if (!d) return '';
  return Math.floor((Date.now() - d) / (365.25 * 864e5));
}
function expiryClass(s) {
  const d = parseDate(s);
  if (!d) return '';
  const ms = d - Date.now();
  if (ms < 0)               return 'expiry-expired';
  if (ms < 365 * 864e5)    return 'expiry-warn';
  if (ms < 2 * 365 * 864e5) return 'expiry-near';
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

// Employee photo: real photo if uploaded/scanned, else initials avatar placeholder
function personPhoto(w, sizeClass) {
  if (w && w.photo) {
    return '<div class="avatar ' + sizeClass + ' has-photo" title="' + esc(w.en_name || '') + '">' +
           '<img src="' + w.photo + '" alt="' + esc(w.en_name || '') + '"></div>';
  }
  return avatarHtml(w ? w.en_name : '', sizeClass);
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

// ── Date-picker helpers ────────────────────────────────────────────
// Worker form now uses native <input type="date"> (id = f-dob, f-issue, f-expiry).
// DB stores DD/MM/YYYY; browser stores YYYY-MM-DD — helpers convert between them.

function initDatePickers() {} // no-op: native date inputs need no initialisation

// Load: DD/MM/YYYY  →  YYYY-MM-DD  (for input[type=date])
function setDatePicker(dpId, value) {
  const el = document.getElementById(dpId.replace('dp-','f-'));
  if (!el) return;
  if (!value) { el.value = ''; return; }
  const p = value.replace(/-/g,'/').split('/');
  if (p.length === 3) {
    const d = String(p[0]).padStart(2,'0');
    const m = String(p[1]).padStart(2,'0');
    const y = String(p[2]).padStart(4,'0');
    el.value = y + '-' + m + '-' + d;
  }
}

// Save: YYYY-MM-DD  →  DD/MM/YYYY  (for DB)
function _dateInputVal(id) {
  const v = (document.getElementById(id)||{}).value || '';
  if (!v) return '';
  const p = v.split('-'); // YYYY-MM-DD
  return p.length === 3 ? p[2]+'/'+p[1]+'/'+p[0] : v;
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
  const alertDot = s.expiring ? '<span class="tree-alert" title="Passport expiring"></span>' : '';
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
  const groups = DB.getGroups();
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
  const I = {
    share:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>',
    rename: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
    move:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>',
    pin:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.5-4V5a2 2 0 0 0-2-2h-5a2 2 0 0 0-2 2v8z"/></svg>',
    archive:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
    del:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
  };
  const item = (act, icon, label, danger) =>
    '<button' + (danger ? ' class="danger"' : '') + ' onclick="groupMenuAct(\'' + act + '\')">' + icon + '<span>' + label + '</span></button>';

  menu.innerHTML =
    item('share',  I.share,  t('gm_share')) +
    item('pin',    I.pin,    pinned ? t('unpin') : t('gm_pin')) +
    (isAdmin() ?
      item('rename',  I.rename,  t('gm_rename')) +
      item('move',    I.move,    t('gm_move')) +
      item('archive', I.archive, t('gm_archive')) +
      item('del',     I.del,     t('gm_delete'), true)
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
  if (action === 'pin')    togglePin(id);
  else if (action === 'rename') openGroupForm(id);
  else if (action === 'del')    confirmDeleteGroup(id);
  else if (action === 'share')  showInfo(t('gm_share'),   t('gm_soon'));
  else if (action === 'move')   showInfo(t('gm_move'),    t('gm_soon'));
  else if (action === 'archive')showInfo(t('gm_archive'), t('gm_soon'));
}

// ── Sidebar nav (views) ───────────────────────────────────────────
function navTo(view, el) {
  document.querySelectorAll('.sb-nav-item').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');

  const dashWelcome = document.getElementById('dashboard-welcome');
  const groupView   = document.getElementById('group-view');

  if (view === 'dashboard') {
    quickFilter = '';
    const s = document.getElementById('search');
    const ts = document.getElementById('sidebar-search-input');
    if (s)  s.value  = '';
    if (ts) ts.value = '';
    document.getElementById('f-employer').value   = '';
    document.getElementById('f-supervisor').value = '';
    document.getElementById('f-blood').value      = '';
    if (dashWelcome) dashWelcome.style.display = '';
    if (groupView)   groupView.style.display   = 'none';
    renderDashboard();
  } else {
    if (dashWelcome) dashWelcome.style.display = 'none';
    if (groupView)   groupView.style.display   = '';
    if (view === 'alerts') {
      quickFilter = 'alerts';
    } else if (view === 'workers') {
      quickFilter = '';
      if (!activeGroupId) {
        const groups = DB.getGroups();
        if (groups.length) { activeGroupId = groups[0].id; renderSidebar(); renderStats(); }
      }
    } else if (view === 'projects') {
      document.getElementById('sb-groups-section')?.classList.remove('collapsed');
      document.getElementById('sidebar').classList.remove('open');
      return;
    }
    applyFilters();
    renderTable();
  }
  document.querySelector('.main-content')?.scrollTo({ top: 0, behavior: 'smooth' });
  document.getElementById('sidebar').classList.remove('open');
}

// ── Sidebar search (now always visible — just focus it) ───────────
function toggleSidebarSearch() {
  const i = document.getElementById('sidebar-search-input');
  if (i) { i.focus(); i.select(); }
}

// ── "More" submenu ────────────────────────────────────────────────
function toggleMoreMenu(event) {
  if (event) event.stopPropagation();
  document.getElementById('sb-more')?.classList.toggle('open');
}
function closeMoreMenu() { document.getElementById('sb-more')?.classList.remove('open'); }

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
  document.getElementById('sb-profile-menu')?.classList.toggle('open');
}
function closeProfileMenu() { document.getElementById('sb-profile-menu')?.classList.remove('open'); }

function profileAddAccount() {
  closeProfileMenu();
  showConfirm(t('pm_add_account'), t('info_addacct_msg'), () => doLogout());
}
function profileShow(kind) {
  closeProfileMenu();
  if (kind === 'profile')  showInfo(t('pm_profile'),  t('info_profile_msg', { name: currentUser?.name || '', role: t(isAdmin() ? 'role_admin' : 'role_viewer') }));
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

// ── Dashboard render (Donezo-style) ───────────────────────────────
function renderDashboard() {
  const groups     = DB.getGroups();
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

  // Notification badge in header
  const nb = el('th-notif-badge');
  if (nb) { nb.textContent = alertCount; nb.style.display = alertCount > 0 ? 'flex' : 'none'; }

  // Workers badge in sidebar
  const wb = el('sb-workers-badge');
  if (wb) { wb.textContent = workers; wb.style.display = workers > 0 ? '' : 'none'; }
  const ab = el('sb-alerts-badge');
  if (ab) { ab.textContent = alertCount; ab.style.display = alertCount > 0 ? '' : 'none'; }

  _dzBarChart(groups);
  _dzReminders(allWorkers);
  _dzProjects(groups);
  _dzTeam(allWorkers, groups);
  _dzProgress(allWorkers);
  _dzCompare(groups);
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
  const roleCls = currentUser.role === 'admin' ? 'role-admin' : 'role-viewer';
  const roleTxt = t(currentUser.role === 'admin' ? 'role_admin' : 'role_viewer');

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

  // Profile head — Claude.ai style: avatar + name + role
  const head = document.getElementById('pm-profile-head');
  if (head) {
    head.innerHTML =
      '<div class="pm-uhd">' +
        profileAvatarHtml(currentUser.username, name, 'avatar-lg', true) +
        '<div class="pm-uhd-info">' +
          '<div class="pm-uhd-name">' + esc(name) + '</div>' +
          '<span class="role-badge ' + roleCls + '">' + esc(roleTxt) + '</span>' +
        '</div>' +
      '</div>';
  }

  // Top header user chip
  renderTopHeader();
}

// Switch to another account without a full logout (demo convenience)
function profileSwitchAccount(username) {
  closeProfileMenu();
  if (!DB.switchAccount) return;
  const u = DB.switchAccount(username);
  if (u) startApp(u);
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
function initSidebarResize() {
  const toggle = document.getElementById('sidebar-toggle');
  if (toggle) toggle.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.toggle('collapsed');
  });
}

function initMobileMenu() {
  const sidebar = document.getElementById('sidebar');
  const backdrop= document.getElementById('sidebar-backdrop');
  // Note: #mobile-menu-btn already calls toggleMobileMenu() via inline onclick —
  // adding another listener here would double-toggle (cancel out), so we don't.
  if (backdrop) backdrop.addEventListener('click', () => sidebar?.classList.remove('open'));
}

// ── DETAIL TABS ───────────────────────────────────────────────────
function switchDetailTab(tab, el) {
  document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.detail-pane').forEach(p => p.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById('detail-pane-' + tab)?.classList.add('active');
  if (tab === 'activity' && _currentViewUid) loadActivityLog(_currentViewUid);
  if (tab === 'docs'     && _currentViewUid) _loadAndRenderDocs(_currentViewUid);
}

async function loadActivityLog(uid) {
  const container = document.getElementById('vm-activity-content');
  if (!container) return;
  container.innerHTML = '<div class="act-empty">Loading…</div>';
  let log = [];
  try { log = await DB.getActivity(uid); } catch (e) { log = []; }
  if (!log.length) {
    container.innerHTML = '<div class="act-empty">No activity yet</div>';
    return;
  }
  const actionIcons = { created: '✦', updated: '✎', deleted: '✕', photo_updated: '◉' };
  container.innerHTML = log.map(entry => {
    const icon = actionIcons[entry.action] || '•';
    const ts = entry.created_at ? new Date(entry.created_at).toLocaleString() : '';
    return '<div class="act-item">' +
      '<div class="act-dot">' + icon + '</div>' +
      '<div class="act-body">' +
        '<div class="act-action">' + esc(entry.action) +
          (entry.performed_by ? ' <span class="act-by">by ' + esc(entry.performed_by) + '</span>' : '') +
        '</div>' +
        (entry.detail ? '<div class="act-detail">' + esc(entry.detail) + '</div>' : '') +
        (ts ? '<div class="act-time">' + ts + '</div>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

// ── DASHBOARD CHARTS (SVG, pure, offline-first) ───────────────────
function renderDashCharts() {
  const ws = DB.getWorkers(activeGroupId);

  _renderPieChart('chart-grade', 'chart-grade-legend', _countBy(ws, 'grade'),
    { A:'#16a34a', B:'#2563eb', C:'#d97706', D:'#dc2626', '':'#9ca3af' });

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
  expandedGroups.add(id);
  highlightedWorkerUid = null;
  document.getElementById('search').value = '';
  const ts = document.getElementById('sidebar-search-input');
  if (ts) ts.value = '';
  document.getElementById('f-employer').value   = '';
  document.getElementById('f-supervisor').value = '';
  document.getElementById('f-blood').value      = '';
  // Show group view, hide dashboard
  const dw = document.getElementById('dashboard-welcome');
  const gv = document.getElementById('group-view');
  if (dw) dw.style.display = 'none';
  if (gv) gv.style.display = '';
  document.querySelectorAll('.sb-nav-item').forEach(b => b.classList.remove('active'));
  document.getElementById('nav-workers')?.classList.add('active');
  renderSidebar();
  renderStats();
  rebuildFilters();
  applyFilters();
  renderTable();
  document.getElementById('sidebar').classList.remove('open');
}

// ── Navigate to a specific group (from dashboard cards) ───────────
function openGroup(groupId) {
  switchGroup(groupId);
}

// ── Sidebar search → mirror into toolbar search + filter ──────────
function sidebarSearch(value) {
  const s = document.getElementById('search');
  // If we're on the dashboard, jump into the workers view so results show.
  const gv = document.getElementById('group-view');
  if (value && gv && gv.style.display === 'none') {
    navTo('workers', document.getElementById('nav-workers'));
  }
  const s2 = document.getElementById('search');
  if (s2) s2.value = value;
  applyFilters();
}
// Back-compat shim (old top-header handler name)
function syncSearch(input) { sidebarSearch(input.value); }

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

  // Page title = active group name; sub = departure / route
  const g = DB.getGroup(activeGroupId);
  const titleEl = document.getElementById('page-title-group');
  const subEl   = document.getElementById('page-sub');
  if (titleEl) titleEl.textContent = g ? g.name : 'Dashboard';
  if (subEl) {
    const bits = [];
    if (g && g.departure) bits.push('✈ ' + g.departure);
    if (g && g.route) bits.push(g.route);
    subEl.textContent = bits.length ? bits.join('  ·  ') : t('app_sub');
  }
}

// ── TABLE FILTERS ─────────────────────────────────────────────────
function rebuildFilters() {
  const ws = DB.getWorkers(activeGroupId);
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
  const ws = DB.getWorkers(activeGroupId);
  const q  = document.getElementById('search').value.toLowerCase();
  const fe = document.getElementById('f-employer').value;
  const fs = document.getElementById('f-supervisor').value;
  const fb = document.getElementById('f-blood').value;

  tableFiltered = ws.filter(w => {
    if (quickFilter === 'alerts' &&
        !['expiry-warn','expiry-near','expiry-expired'].includes(expiryClass(w.passport_expiry))) return false;
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
  const ws     = DB.getWorkers(activeGroupId);
  const g      = DB.getGroup(activeGroupId);

  // Count bar — just the result count (group name/route already in the page header)
  const alertTag = quickFilter === 'alerts'
    ? ' &nbsp;·&nbsp; <span style="color:var(--red);font-weight:700">⚠ ' + t('passport_alert') + '</span>'
    : '';
  document.getElementById('count-bar').innerHTML =
    t('showing', { n: tableFiltered.length, total: ws.length }) + alertTag;

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

  renderCards();
  applyViewMode();

  tbody.innerHTML = tableFiltered.map(w => {
    const age = calcAge(w.dob);
    const ec  = expiryClass(w.passport_expiry);
    const idHtml = w.worker_id
      ? '<span class="worker-id">' + esc(w.worker_id) + '</span>'
      : '<span class="worker-id no-id">No ID</span>';
    return '<tr id="row-' + w.uid + '" onclick="openView(\'' + w.uid + '\')">' +
      '<td>' + idHtml + '</td>' +
      '<td><div class="name-cell">' + personPhoto(w,'avatar-sm') + '<span style="font-weight:700">' + esc(w.en_name) + '</span></div></td>' +
      '<td style="color:var(--text-muted);font-size:0.8rem">' + esc(w.lo_name) + '</td>' +
      '<td>' + empBadge(w.employer_code) + '</td>' +
      '<td>' + esc(w.group_supervisor) + '</td>' +
      '<td>' + esc(w.dob) + '</td>' +
      '<td>' + (age || '--') + '</td>' +
      '<td><span class="blood-chip">' + esc(w.blood || '--') + '</span></td>' +
      '<td style="font-family:monospace;font-size:0.8rem">' + esc(w.passport_no) + '</td>' +
      '<td class="' + ec + '">' + esc(w.passport_expiry) + '</td>' +
      '<td>' + esc(w.size) + '</td>' +
      '<td>' +
        '<button class="kebab" onclick="openRowMenu(\'' + w.uid + '\',event)" title="' + esc(t('col_actions')) + '">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>' +
        '</button>' +
      '</td>' +
    '</tr>';
  }).join('');
}

// ── VIEW MODE (Table / Cards) ─────────────────────────────────────
const VIEW_MODES = ['table', 'kdcard'];
function _normViewMode(m) { return (m === 'cards' || m === 'idcard' || m === 'slide') ? 'kdcard' : (VIEW_MODES.includes(m) ? m : 'table'); }
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
  if (tableWrap) tableWrap.style.display = view === 'table'  ? '' : 'none';
  if (cardsWrap) cardsWrap.style.display = view === 'kdcard' ? 'block' : 'none';
  document.getElementById('view-table')?.classList.toggle('active',  view === 'table');
  document.getElementById('view-kdcard')?.classList.toggle('active', view === 'kdcard');
}

// ── KD FORM GRID ──────────────────────────────────────────────────
function renderCards() {
  const grid = document.getElementById('cards-grid');
  if (!grid) return;
  const g = DB.getGroup(activeGroupId);
  grid.className = 'cards-grid kd-grid';
  grid.innerHTML = tableFiltered.map(w =>
    '<div class="idc-cell" onclick="openView(\'' + esc(w.uid) + '\')">' +
      _renderKdCard(w, g) +
    '</div>'
  ).join('');
}

// ── KD original-form card (brown layout) ──────────────────────────
function _kdGenderCounts(g) {
  let f = 0, m = 0;
  ((g && g.workers) || []).forEach(w => { if (w.sex === 'F') f++; else if (w.sex === 'M') m++; });
  return { f, m };
}
function _renderKdCard(w, g, editable) {
  const seq    = w.worker_id ? w.worker_id.split('-').pop() : '';
  const bloods = ['A', 'B', 'O', 'AB'];
  const bloodRow = bloods.map(b => '<span class="kd-blood' + (w.blood === b ? ' on' : '') + '">' + b + '</span>').join('');
  const gc = _kdGenderCounts(g);
  const assigned = (g && g.assigned != null && g.assigned !== '') ? g.assigned : 0;
  const arrivals = (g && g.arrivals != null && g.arrivals !== '') ? g.arrivals : 0;
  const cell = (label, sub, val) =>
    '<div class="kd-l"><span>' + label + '</span>' + (sub ? '<i>' + sub + '</i>' : '') + '</div>' +
    '<div class="kd-v">' + val + '</div>';
  const photo = w.photo
    ? '<img src="' + esc(w.photo) + '" alt="">'
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
  return '<div class="kd-card">' +
    '<div class="kd-top">' +
      '<span class="kd-code">' + esc(w.worker_id || w.employer_code || '—') + '</span>' +
      '<div class="kd-top-mid">' + genderBadge + '<span class="kd-bloods">' + bloodRow + '</span></div>' +
    '</div>' +
    '<div class="kd-head"><span>' + esc(w.group_supervisor || '—') + '</span><span>' + esc(seq || '') + '</span></div>' +
    '<div class="kd-body">' +
      '<div class="kd-tbl">' +
        cell('Name', 'ຊື່', esc(w.en_name || '--')) +
        cell('ຊື່ ນາມສະກຸນ', '', esc(w.lo_name || '--')) +
        cell('Date of birth', 'ວັນເດືອນປີເກີດ', esc(w.dob || '--')) +
        cell('Village', 'ບ້ານ', esc(w.village || '--')) +
        cell('Weight ; Height', 'Kg ; Cm', (w.weight ? w.weight + 'Kg' : '--') + ' ; ' + (w.height ? w.height + 'Cm' : '--')) +
        cell('Size', 'ຂະໜາດ', esc(w.size || '--')) +
        cell('Blood', 'ກຸ່ມເລືອດ', esc(w.blood || '--')) +
        cell('Passport No', 'ເລກໜັງສື', '<span style="font-family:monospace">' + esc(w.passport_no || '--') + '</span>') +
        cell('Date of expiry', 'ໝົດອາຍຸ', '<span class="' + expiryClass(w.passport_expiry) + '">' + esc(w.passport_expiry || '--') + '</span>') +
        cell('Tel', 'ໂທ', esc(w.tel || '--')) +
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
  '</div>';
}

// ── Contextual 3-dot action menu (View / Edit / Delete) ───────────
let rowMenuUid = null;
function openRowMenu(uid, ev) {
  if (ev) ev.stopPropagation();
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
  return '<input class="vm-edit-in" data-ef="' + field + '" value="' + esc(cur) + '">';
}

// Builds the Info-pane HTML (two columns). Same fixed set of rows always renders
// so the popup never changes size with the amount of data.
function _renderDetailBody(w, g) {
  const ed  = detailEditMode;
  // Age: use manually stored value if present, else calculate from DOB
  const age = (w.age != null && w.age !== '') ? w.age : calcAge(w.dob);
  const visaLabels = { not_started:'ຍັງບໍ່ເລີ່ມ', applied:'ຍື່ນຂໍແລ້ວ', approved:'ອະນຸມັດ ✓', rejected:'ຖືກປະຕິເສດ ✗' };
  const warn = !ed && expiryClass(w.passport_expiry) !== 'expiry-ok';
  const row = (label, sub, val) => '<tr><td>' + label + (sub ? '<span class="sub">' + sub + '</span>' : '') + '</td><td>' + val + '</td></tr>';
  const sexOpts  = [{v:'',t:'--'},{v:'M',t:t('fm_sex_m')},{v:'F',t:t('fm_sex_f')}];
  const handOpts = [{v:'',t:'--'},{v:'R',t:'R (Right)'},{v:'L',t:'L (Left)'}];
  const bloodOpts= [{v:'',t:'--'},{v:'A',t:'A'},{v:'B',t:'B'},{v:'O',t:'O'},{v:'AB',t:'AB'},{v:'B+',t:'B+'},{v:'B-',t:'B-'}];
  const sizeOpts = [{v:'',t:'--'},{v:'S',t:'S'},{v:'M',t:'M'},{v:'L',t:'L'},{v:'XL',t:'XL'},{v:'XXL',t:'XXL'}];

  const tableHtml =
    '<div class="vm-detail-section">' +
      (warn ? '<div class="vm-warn">&#9888; ' + t('vc_passport_warn', { date: w.passport_expiry }) + '</div>' : '') +
      '<table class="vm-tbl">' +
        row('Worker ID', 'ລະຫັດ', _ev(w,'worker_id', esc(w.worker_id||'--'), 'text')) +
        row(t('vc_name'), '/ຊື່', _ev(w,'en_name', esc(w.en_name||'--'), 'text')) +
        row('ຊື່ ນາມສະກຸນ', '', _ev(w,'lo_name', esc(w.lo_name||'--'), 'text')) +
        row(t('vc_dob'), 'ວັນເດືອນປີເກີດ', _ev(w,'dob', esc(w.dob||'--'), 'text')) +
        row(t('vc_age'), 'ອາຍຸ', _ev(w,'age', age ? age + ' yrs' : '--', 'text')) +
        row(t('vc_nationality'), 'ສັນຊາດ', _ev(w,'nationality', esc(w.nationality||'--'), 'text')) +
        row(t('vc_sex'), 'ເພດ', ed ? _ev(w,'sex','','select',sexOpts) : (w.sex==='M'?'♂ '+t('fm_sex_m'):w.sex==='F'?'♀ '+t('fm_sex_f'):'--')) +
        row(t('vc_province'), 'ແຂວງ', _ev(w,'province', esc(w.province||'--'), 'text')) +
        row(t('vc_district'), 'ເມືອງ', _ev(w,'district', esc(w.district||'--'), 'text')) +
        row(t('vc_village'), 'ບ້ານ', _ev(w,'village', esc(w.village||'--'), 'text')) +
        row(t('vc_weight_height'), 'Kg ; Cm', ed
            ? '<div class="split">' + _ev(w,'weight','','text') + _ev(w,'height','','text') + '</div>'
            : '<div class="split"><span>'+(w.weight?w.weight+'Kg':'--')+'</span><span>'+(w.height?w.height+'Cm':'--')+'</span></div>') +
        row(t('vc_size'), 'ຂະໜາດເສື້ອ', ed ? _ev(w,'size','','select',sizeOpts) : esc(w.size||'--')) +
        row(t('vc_hand'), 'ຊ້າຍຫຼືຂວາ', ed ? _ev(w,'hand','','select',handOpts) : (w.hand==='R'?'R (Right)':w.hand==='L'?'L (Left)':'--')) +
        row(t('vc_blood'), 'ກຸ່ມເລືອດ', ed ? _ev(w,'blood','','select',bloodOpts) : esc(w.blood||'--')) +
        row(t('vc_passport'), 'ເລກທີ', _ev(w,'passport_no', '<span style="font-family:monospace">'+esc(w.passport_no||'--')+'</span>', 'text')) +
        row(t('vc_issue'), 'ວັນທີອອກ', _ev(w,'passport_issue', esc(w.passport_issue||'--'), 'text')) +
        row(t('vc_expiry'), 'ໝົດອາຍຸ', ed ? _ev(w,'passport_expiry','','text') : '<span class="'+expiryClass(w.passport_expiry)+'">'+esc(w.passport_expiry||'--')+'</span>') +
        row(t('vc_tel'), 'ໂທຫຼັກ', _ev(w,'tel', esc(w.tel||'--'), 'text')) +
        row('Emergency', 'ໂທສຸກເສີນ', _ev(w,'emg_tel', esc(w.emg_tel||'--'), 'text')) +
      '</table>' +
    '</div>';

  if (ed) {
    return '<div class="vm-info-layout editing"><div class="vm-info-main">' + tableHtml + '</div></div>';
  }

  // View mode → single column: photo header at top, full-width data table below
  const photoAttr = isAdmin() ? ' onclick="event.stopPropagation();openPhotoEditor(\'' + esc(w.uid) + '\')"' : '';
  const editCls   = isAdmin() ? ' vph-editable' : '';
  const editHint  = isAdmin()
    ? '<div class="vph-edit-hint">&#9998; ' + esc(t('photo_edit') || 'แก้ไขรูป') + '</div>' : '';
  const photoImg  = w.photo
    ? '<img src="' + esc(w.photo) + '" alt="">'
    : '<span class="vph-initials">' + esc(avatarInitials(w.en_name || '?')) + '</span>';

  const photoHeader =
    '<div class="vm-profile-header">' +
      '<div class="vph-photo' + editCls + '"' + photoAttr + '>' + photoImg + editHint + '</div>' +
      '<div class="vph-names">' +
        '<div class="vph-name-en">' + esc(w.en_name || '—') + '</div>' +
        '<div class="vph-name-lo">' + esc(w.lo_name || '') + '</div>' +
        (w.worker_id ? '<div class="vph-id">' + esc(w.worker_id) + '</div>' : '') +
      '</div>' +
    '</div>';

  return '<div class="vm-single-view">' + photoHeader + tableHtml + '</div>';
}

function _renderDetailTopbar(w, uid) {
  const el = document.getElementById('vm-topbar-actions'); if (!el) return;
  let h = '';
  h += '<button class="vm-action-btn" onclick="zoomCard(\''+esc(uid)+'\')" title="'+esc(t('vd_zoom'))+'">&#10530;</button>';
  h += '<button class="vm-action-btn" onclick="exportWorkerPDF()">&#11015; PDF</button>';
  if (isAdmin()) {
    if (detailEditMode) {
      h += '<button class="vm-action-btn" onclick="cancelDetailEdit(\''+esc(uid)+'\')">&#10005; '+esc(t('fm_cancel'))+'</button>';
      h += '<button class="vm-action-btn vm-action-save" onclick="saveDetailEdit(\''+esc(uid)+'\')">&#10003; '+esc(t('vd_save'))+'</button>';
    } else {
      h += '<button class="vm-action-btn" onclick="toggleDetailEdit(\''+esc(uid)+'\')">&#9998; '+esc(t('act_edit'))+'</button>';
    }
  }
  el.innerHTML = h;
}

function toggleDetailEdit(uid) {
  detailEditMode = !detailEditMode;
  const g = DB.getGroup(activeGroupId); const w = g && g.workers.find(x => x.uid === uid); if (!w) return;
  document.getElementById('vm-content').innerHTML = _renderDetailBody(w, g);
  _renderDetailTopbar(w, uid);
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

// Zoom the ID card to fill the screen
function zoomCard(uid) {
  const g = DB.getGroup(activeGroupId); const w = g && g.workers.find(x => x.uid === uid); if (!w) return;
  const body = document.getElementById('cardzoom-body');
  if (body) body.innerHTML = _renderKdCard(w, g);   // full KD form at 100%
  openOverlay('cardzoom-overlay');
}

// ── VIEW CARD ─────────────────────────────────────────────────────
function openView(uid) {
  const g = DB.getGroup(activeGroupId);
  const w = g && g.workers.find(x => x.uid === uid);
  if (!w) return;

  _currentViewUid = uid;
  detailEditMode = false;

  const age   = calcAge(w.dob);
  const idNum = w.worker_id ? w.worker_id.split('-').pop() : '--';

  const gradeColors = { A:'#16a34a', B:'#2563eb', C:'#d97706', D:'#dc2626' };
  const gradeColor  = gradeColors[w.grade] || '#6b7280';
  const gradeChip   = w.grade
    ? '<span class="vm-grade-chip" style="background:' + gradeColor + '">Grade ' + esc(w.grade) + '</span>'
    : '';

  // Topbar
  const enEl = document.getElementById('vm-topbar-en');
  const loEl = document.getElementById('vm-topbar-lo');
  if (enEl) enEl.textContent = w.en_name || '';
  if (loEl) loEl.innerHTML   = gradeChip + (w.lo_name ? '<span class="vm-topbar-lo-text">' + esc(w.lo_name) + '</span>' : '');

  _renderDetailTopbar(w, uid);

  // Reset tabs to Info
  document.querySelectorAll('.detail-tab').forEach(tb => tb.classList.remove('active'));
  document.querySelectorAll('.detail-pane').forEach(p  => p.classList.remove('active'));
  const infoTab  = document.querySelector('.detail-tab[data-tab="info"]');
  const infoPane = document.getElementById('detail-pane-info');
  if (infoTab)  infoTab.classList.add('active');
  if (infoPane) infoPane.classList.add('active');

  // Reset activity pane
  const actContent = document.getElementById('vm-activity-content');
  if (actContent) actContent.innerHTML = '<div class="act-empty">Loading…</div>';

  // Info pane = two columns (detail table left, locked ID card right)
  document.getElementById('vm-content').innerHTML = _renderDetailBody(w, g);

  // Load docs immediately (no tab, single scroll page)
  document.getElementById('vm-docs-content').innerHTML =
    '<div class="vm-docs-title">&#128193; ' + t('vc_documents') + '</div>' +
    '<div class="doc-loading">&#8203;</div>';
  _loadAndRenderDocs(uid);

  openOverlay('view-overlay');
}

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
      if (w) w.photo = dataUrl;
      // Refresh the badge card photo in-place
      const idcPhoto = document.querySelector('.idc-photo');
      if (idcPhoto && w) {
        idcPhoto.innerHTML =
          personPhoto(w, 'avatar-xl') +
          '<div class="idc-photo-edit">&#9998;</div>';
      }
      toast('Photo updated', 'ok');
    } catch (e) {
      toast('Photo upload failed', 'err');
    }
  });
}

// ── In-profile photo editor (upload + rotate, no Excel form needed) ──
// Opens from the KD card photo box in the worker detail view. Landscape photos
// can be rotated; the result is baked into the saved image and the card crops it
// to its fixed box (object-fit: cover), so layout never shifts.
let _pe = null;   // { uid, src (un-rotated dataURL), rot (0/90/180/270), out (baked) }

function openPhotoEditor(uid) {
  if (!isAdmin()) return;
  const g = DB.getGroup(activeGroupId);
  const w = g && g.workers.find(x => x.uid === uid);
  if (!w) return;
  _pe = { uid, src: w.photo || '', rot: 0, out: w.photo || '' };
  _renderPhotoEditor();
  openOverlay('photo-editor-overlay');
}

// Bake current src+rotation onto a canvas → JPEG data URL (also used for preview)
function _peCompose(cb) {
  if (!_pe || !_pe.src) { cb(''); return; }
  const img = new Image();
  img.onload = () => {
    const rot  = ((_pe.rot % 360) + 360) % 360;
    const swap = rot === 90 || rot === 270;
    const maxDim = 1000;
    let iw = img.width, ih = img.height;
    const scale = Math.min(1, maxDim / Math.max(iw, ih));
    iw = Math.round(iw * scale); ih = Math.round(ih * scale);
    const c = document.createElement('canvas');
    c.width  = swap ? ih : iw;
    c.height = swap ? iw : ih;
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(rot * Math.PI / 180);
    ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih);
    cb(c.toDataURL('image/jpeg', 0.85));
  };
  img.onerror = () => cb(_pe.src);
  img.src = _pe.src;
}

function _renderPhotoEditor() {
  const stage   = document.getElementById('pe-stage');
  const saveBtn = document.getElementById('pe-save');
  const rotL    = document.getElementById('pe-rot-l');
  const rotR    = document.getElementById('pe-rot-r');
  const has = !!(_pe && _pe.src);
  if (rotL) rotL.disabled = !has;
  if (rotR) rotR.disabled = !has;
  if (!has) {
    if (stage)   stage.innerHTML = '<div class="pe-empty">' + esc(t('photo_pick_hint') || 'เลือกรูปเพื่ออัปโหลด') + '</div>';
    if (saveBtn) saveBtn.disabled = true;
    return;
  }
  _peCompose(out => {
    _pe.out = out;
    if (stage)   stage.innerHTML = '<img src="' + out + '" alt="">';
    if (saveBtn) saveBtn.disabled = false;
  });
}

function pePickFile(input) {
  const file = input.files && input.files[0];
  if (!file || !_pe) return;
  input.value = '';
  _fileToDataURL(file, 1200, dataUrl => { _pe.src = dataUrl; _pe.rot = 0; _renderPhotoEditor(); });
}

function peRotate(dir) {
  if (!_pe || !_pe.src) return;
  _pe.rot = (((_pe.rot + dir * 90) % 360) + 360) % 360;
  _renderPhotoEditor();
}

function peSave() {
  if (!_pe) return closeOverlay('photo-editor-overlay');
  const uid = _pe.uid, out = _pe.out || '';
  try {
    DB.updateWorker(activeGroupId, uid, { photo: out });
    const g = DB.getGroup(activeGroupId);
    const w = g && g.workers.find(x => x.uid === uid);
    if (w) w.photo = out;
    closeOverlay('photo-editor-overlay');
    if (_currentViewUid === uid) openView(uid);   // refresh the KD card in place
    toast(t('photo_saved') || 'อัปเดตรูปแล้ว', 'ok');
  } catch (e) {
    toast(t('photo_save_err') || 'บันทึกรูปไม่สำเร็จ', 'err');
  }
}

// ── DOCUMENTS (inside the detail drawer, versioned) ───────────────
const DOC_CATS = [
  { key: 'passport', label: 'Passport' },
  { key: 'id_card',  label: 'ID Card' },
  { key: 'form_1',   label: 'Form 1' },
  { key: 'form_2',   label: 'Form 2' },
  { key: 'form_3',   label: 'Form 3' },
  { key: 'land_doc', label: 'Land Document' },
];

function renderDocuments(w) {
  setTimeout(() => _loadAndRenderDocs(w.uid), 0);
  return '';
}

async function _loadAndRenderDocs(uid) {
  const container = document.getElementById('vm-docs-content') || document.getElementById('vm-docs-' + uid);
  if (!container) return;
  let docs = {};
  try { docs = await DB.getDocuments(uid); } catch (e) { docs = {}; }
  const canEdit = isAdmin();
  const html = DOC_CATS.map(cat => {
    const versions = docs[cat.key] || [];
    const current = versions.find(v => v.isCurrent) || versions[0];
    const history = versions.filter(v => v !== current);
    const hasFile = !!current;
    const dateRaw = current && (current.uploadedAt || current.date || current.created || current.createdAt);
    const dateStr = dateRaw ? new Date(dateRaw).toLocaleDateString() : '';

    // Preview thumbnail (monochrome) or a neutral placeholder
    const preview = hasFile
      ? '<div class="docb-preview" onclick="openDocViewById(' + current.id + ',\'' + esc(current.path) + '\',\'' + current.type + '\',\'' + esc(current.name) + '\')">' +
          (current.type === 'pdf'
            ? '<div class="docb-pdf">PDF</div>'
            : '<img src="' + esc(current.path) + '" alt="">') +
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

    const histHtml = history.length
      ? '<div class="docb-history"><span class="docb-hist-label">' + t('doc_history') + ':</span>' +
          history.map(v =>
            '<span class="docb-hist-item" onclick="openDocViewById(' + v.id + ',\'' + esc(v.path) + '\',\'' + v.type + '\',\'' + esc(v.name) + '\')">v' + v.version +
              (canEdit ? '<button onclick="deleteDocById(event,' + v.id + ',\'' + uid + '\')">&#x2715;</button>' : '') +
            '</span>'
          ).join('') +
        '</div>'
      : '';

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

    return '<div class="docb ' + (hasFile ? 'docb-has' : 'docb-no') + '">' +
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

  container.innerHTML = '<div class="vm-docs-title">&#128193; ' + t('vc_documents') + '</div><div class="docb-grid">' + html + '</div>';
}

function handleDocUpload(input, uid, cat) {
  const file = input.files && input.files[0];
  if (!file) return;
  input.value = '';
  _fileToDataURL(file, 1600, async dataUrl => {
    const container = document.getElementById('vm-docs-content') || document.getElementById('vm-docs-' + uid);
    if (container) container.innerHTML = '<div class="vm-docs-title">&#128193; ' + t('vc_documents') + '</div><div class="doc-loading">&#8203;</div>';
    try {
      await DB.uploadDocument(uid, activeGroupId, cat, dataUrl, file.name);
      toast('Document uploaded', 'ok');
    } catch (e) {
      toast('Upload failed: ' + (e && e.message || e), 'err');
      return;
    }
    _loadAndRenderDocs(uid);
  });
}

async function deleteDocById(event, docId, uid) {
  if (event) event.stopPropagation();
  if (!isAdmin()) return;
  if (!window.confirm('Delete this document version?')) return;
  try { await DB.deleteDocument(docId); } catch (e) { toast('Delete failed', 'err'); return; }
  _loadAndRenderDocs(uid);
  toast('Document deleted', 'ok');
}

function openDocViewById(docId, path, type, name) {
  const body = document.getElementById('docview-body');
  if (!body) return;
  body.innerHTML = type === 'pdf'
    ? '<iframe class="docview-pdf" src="' + esc(path) + '"></iframe>'
    : '<img class="docview-img" src="' + esc(path) + '" alt="' + esc(name || '') + '">';
  openOverlay('docview-overlay');
}

// kept for backward compat (old in-memory doc references)
function openDocView(uid, cat, idx) {
  const g = DB.getGroup(activeGroupId);
  const w = g && g.workers.find(x => x.uid === uid);
  const f = w && w.documents && w.documents[cat] && w.documents[cat][idx];
  if (!f) return;
  openDocViewById(0, f.data, f.type, f.name);
}

function scanForDoc(cat) {
  if (cat === 'passport' && typeof openPassportScan === 'function') openPassportScan();
}

// ── WORKER FORM ───────────────────────────────────────────────────
function openWorkerForm(editUid) {
  if (!isAdmin()) return;
  populateCityDropdowns();
  const fids = ['worker-id','employer-code','supervisor','en-name','lo-name',
                'province','district','village','nationality','sex','blood','hand','weight','height','size','couple',
                'tel','emg-tel','passport-no','kr-city','la-city',
                'grade','visa-status','education','work-experience','languages'];
  fids.forEach(f => { const el = document.getElementById('f-' + f); if (el) el.value = ''; });
  setDatePicker('dp-dob', '');
  setDatePicker('dp-issue', '');
  setDatePicker('dp-expiry', '');
  document.getElementById('f-edit-uid').value = '';
  document.getElementById('f-photo').value = '';
  window._pendingScanDoc = null;
  renderFormPhoto();
  document.getElementById('fm-title').textContent = t('fm_add_worker');

  if (editUid) {
    const g = DB.getGroup(activeGroupId);
    const w = g && g.workers.find(x => x.uid === editUid);
    if (!w) return;
    document.getElementById('fm-title').textContent = t('fm_edit_worker');
    document.getElementById('f-edit-uid').value        = editUid;
    document.getElementById('f-photo').value           = w.photo || '';
    renderFormPhoto();
    document.getElementById('f-kr-city').value         = w.kr_city || '';
    document.getElementById('f-la-city').value         = w.la_city || '';
    document.getElementById('f-worker-id').value       = w.worker_id || '';
    document.getElementById('f-employer-code').value   = w.employer_code || '';
    document.getElementById('f-supervisor').value      = w.group_supervisor || '';
    document.getElementById('f-en-name').value         = w.en_name || '';
    document.getElementById('f-lo-name').value         = w.lo_name || '';
    setDatePicker('dp-dob', w.dob || '');
    document.getElementById('f-province').value        = w.province || '';
    document.getElementById('f-district').value        = w.district || '';
    document.getElementById('f-village').value         = w.village || '';
    document.getElementById('f-nationality').value     = w.nationality || '';
    document.getElementById('f-sex').value              = w.sex || '';
    document.getElementById('f-blood').value           = w.blood || '';
    document.getElementById('f-hand').value            = w.hand || '';
    document.getElementById('f-weight').value          = w.weight || '';
    document.getElementById('f-height').value          = w.height || '';
    document.getElementById('f-size').value            = w.size || '';
    document.getElementById('f-couple').value          = w.couple || '';
    document.getElementById('f-tel').value             = w.tel || '';
    document.getElementById('f-emg-tel').value         = w.emg_tel || '';
    document.getElementById('f-passport-no').value     = w.passport_no || '';
    setDatePicker('dp-issue',  w.passport_issue || '');
    setDatePicker('dp-expiry', w.passport_expiry || '');
    document.getElementById('f-grade').value           = w.grade || '';
    document.getElementById('f-visa-status').value     = w.visa_status || '';
    document.getElementById('f-education').value       = w.education || '';
    document.getElementById('f-work-experience').value = w.work_experience || '';
    document.getElementById('f-languages').value       = w.languages || '';
  }
  updateIdPreview();
  openOverlay('form-overlay');
}

// ── CONTACT ID GENERATION ─────────────────────────────────────────
// Populate the Korean / Lao city <select>s from the dictionary.
function populateCityDropdowns() {
  const cities = DB.getCities();
  const opt = c => '<option value="' + esc(c.code) + '">' + esc(c.name) + ' (' + esc(c.code) + ')</option>';
  const sel = '<option value="">' + t('fm_select') + '</option>';
  document.getElementById('f-kr-city').innerHTML = sel + (cities.kr || []).map(opt).join('');
  document.getElementById('f-la-city').innerHTML = sel + (cities.la || []).map(opt).join('');
}

// Live preview of the auto-generated ID for NEW workers.
// While editing an existing worker the ID is frozen (use Regenerate to change).
function updateIdPreview() {
  const editing = !!document.getElementById('f-edit-uid').value;
  const idEl = document.getElementById('f-worker-id');
  const hint = document.getElementById('f-id-hint');
  if (editing) { hint.textContent = t('fm_id_hint'); return; }
  const kr = document.getElementById('f-kr-city').value;
  const la = document.getElementById('f-la-city').value;
  if (kr && la) {
    idEl.value = DB.nextContactId(kr, la, DB.todayCode());
    hint.textContent = t('fm_id_hint');
  } else {
    idEl.value = '';
    hint.textContent = t('fm_id_need_cities');
  }
}

function regenerateId() {
  if (!isAdmin()) return;
  const kr = document.getElementById('f-kr-city').value;
  const la = document.getElementById('f-la-city').value;
  const hint = document.getElementById('f-id-hint');
  if (!(kr && la)) { hint.textContent = t('fm_id_need_cities'); return; }
  document.getElementById('f-worker-id').value = DB.nextContactId(kr, la, DB.todayCode());
  hint.textContent = t('fm_id_hint');
}

function saveWorker() {
  if (!isAdmin()) return;
  const enName = document.getElementById('f-en-name').value.trim();
  const passNo = document.getElementById('f-passport-no').value.trim();
  if (!enName) { alert('Name (EN) is required'); return; }
  if (!passNo) { alert('Passport No. is required'); return; }

  const editUid = document.getElementById('f-edit-uid').value;
  const krCity  = document.getElementById('f-kr-city').value;
  const laCity  = document.getElementById('f-la-city').value;
  let   workerId = document.getElementById('f-worker-id').value.trim();
  // New worker: auto-generate the Contact ID from the city pair + today's date.
  if (!editUid && !workerId && krCity && laCity) {
    workerId = DB.nextContactId(krCity, laCity, DB.todayCode());
  }

  const data = {
    worker_id:      workerId,
    kr_city:        krCity,
    la_city:        laCity,
    employer_code:  document.getElementById('f-employer-code').value,
    group_supervisor: document.getElementById('f-supervisor').value.trim(),
    en_name:        enName.toUpperCase(),
    lo_name:        document.getElementById('f-lo-name').value.trim(),
    dob:            _dateInputVal('f-dob'),
    province:       document.getElementById('f-province').value.trim(),
    district:       document.getElementById('f-district').value.trim(),
    village:        document.getElementById('f-village').value.trim(),
    nationality:    document.getElementById('f-nationality').value.trim().toUpperCase(),
    sex:            document.getElementById('f-sex').value,
    blood:          document.getElementById('f-blood').value,
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

  // Attach a passport image captured during scanning (auto document extraction)
  if (window._pendingScanDoc) {
    const prev = editUid
      ? ((DB.getGroup(activeGroupId).workers.find(x => x.uid === editUid) || {}).documents || {})
      : {};
    const docs = JSON.parse(JSON.stringify(prev));
    const c = window._pendingScanDoc.cat;
    docs[c] = (docs[c] || []).concat([{ name: window._pendingScanDoc.name, type: window._pendingScanDoc.type, data: window._pendingScanDoc.data }]);
    data.documents = docs;
    window._pendingScanDoc = null;
  }

  if (editUid) {
    DB.updateWorker(activeGroupId, editUid, data);
  } else {
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
  document.getElementById('gf-name').value     = '';
  document.getElementById('gf-date').value     = '';
  document.getElementById('gf-route').value    = '';
  document.getElementById('gf-assigned').value = '';
  document.getElementById('gf-arrivals').value = '';
  document.getElementById('gm-title').textContent = editGroupId ? t('gm_edit_group') : t('gm_new_group');
  document.getElementById('gm-btn').textContent   = editGroupId ? t('gm_save') : t('gm_create');

  if (editGroupId) {
    const g = DB.getGroup(editGroupId);
    if (g) {
      document.getElementById('gf-name').value      = g.name || '';
      document.getElementById('gf-date').value      = g.departure || '';
      document.getElementById('gf-route').value     = g.route || '';
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
    departure: document.getElementById('gf-date').value.trim(),
    route: document.getElementById('gf-route').value.trim(),
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

// ── EXPORT CSV ────────────────────────────────────────────────────
function exportCSV() {
  const g  = DB.getGroup(activeGroupId);
  const ws = DB.getWorkers(activeGroupId);
  const headers = ['Worker ID','EN Name','Lao Name','Employer','Supervisor','DOB','Age',
                   'Blood','Passport No','Issue','Expiry','Village','Weight(kg)','Height(cm)',
                   'Size','Hand','Tel','Emergency Tel','Couple','Group'];
  const rows = ws.map(w => [
    w.worker_id, w.en_name, w.lo_name, w.employer_code, w.group_supervisor,
    w.dob, calcAge(w.dob) || '', w.blood, w.passport_no,
    w.passport_issue, w.passport_expiry, w.village, w.weight, w.height,
    w.size, w.hand, w.tel, w.emg_tel, w.couple, g ? g.name : ''
  ].map(v => '"' + (v || '').toString().replace(/"/g, '""') + '"').join(','));

  const csv = '﻿' + [headers.join(','), ...rows].join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = (g ? g.name.replace(/[^a-z0-9]/gi, '_') : 'workers') + '.csv';
  a.click();
}

// ── OVERLAY HELPERS ───────────────────────────────────────────────
function openOverlay(id) {
  document.getElementById(id).classList.add('open');
  document.body.classList.add('no-scroll');
}
function closeOverlay(id) {
  document.getElementById(id).classList.remove('open');
  if (id === 'view-overlay') _currentViewUid = null;
  if (!document.querySelector('.overlay.open')) document.body.classList.remove('no-scroll');
}

// Click outside to close
['view-overlay','form-overlay','group-overlay','confirm-overlay','settings-overlay','import-overlay','scan-overlay','docview-overlay','photo-editor-overlay'].forEach(id => {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target.id === id) closeOverlay(id);
  });
});

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

// ── SETTINGS (all users — admin sees Cities+Users tabs, viewer sees Appearance only) ──
function openSettings() {
  renderSettings();
  switchSettingsTab('appearance');
  openOverlay('settings-overlay');
}

function switchSettingsTab(tab) {
  document.querySelectorAll('.set-nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('set-pane-appearance').style.display = tab === 'appearance' ? 'block' : 'none';
  document.getElementById('set-pane-cities').style.display     = tab === 'cities'     ? 'block' : 'none';
  document.getElementById('set-pane-users').style.display      = tab === 'users'      ? 'block' : 'none';
}

function renderAppearance() {
  const pref = localStorage.getItem('kd_theme') || 'system';
  document.querySelectorAll('.theme-opt').forEach(b => {
    b.classList.toggle('active', b.dataset.themeVal === pref);
  });
  // lang-btn active state is handled by applyTranslations() in i18n.js
  document.querySelectorAll('.lang-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === (typeof currentLang !== 'undefined' ? currentLang : 'en'));
  });
  updateLogoDisplay();
}

function updateLogoDisplay() {
  const logo = localStorage.getItem('kd_company_logo');
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

function handleLogoUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    localStorage.setItem('kd_company_logo', e.target.result);
    updateLogoDisplay();
  };
  reader.readAsDataURL(file);
}

function removeCompanyLogo() {
  localStorage.removeItem('kd_company_logo');
  const inp = document.getElementById('logo-file-input');
  if (inp) inp.value = '';
  updateLogoDisplay();
}

function renderSettings() {
  renderAppearance();
  if (isAdmin()) {
    renderCityList('kr');
    renderCityList('la');
    renderUserList();
  }
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
  if (!isAdmin()) return;
  const name = document.getElementById('set-' + country + '-name').value.trim();
  const code = document.getElementById('set-' + country + '-code').value.trim().toUpperCase();
  if (!name || !code) { alert(t('set_need_both')); return; }
  const res = DB.addCity(country, { name, code });
  if (res === 'dup')     { alert(t('set_dup_code'));  return; }
  if (res === 'invalid') { alert(t('set_need_both')); return; }
  document.getElementById('set-' + country + '-name').value = '';
  document.getElementById('set-' + country + '-code').value = '';
  renderCityList(country);
}

function delCity(country, code) {
  if (!isAdmin()) return;
  const c = (DB.getCities()[country] || []).find(x => x.code === code);
  showConfirm(
    t('confirm_delete'),
    t('confirm_del_city', { name: c ? c.name : code, code }),
    () => { DB.deleteCity(country, code); renderCityList(country); }
  );
}

function renderUserList() {
  const users = DB.getUsers();
  const el = document.getElementById('set-users-list');
  el.innerHTML = users.map(u => {
    const roleCls = u.role === 'admin' ? 'role-admin' : 'role-viewer';
    const self = currentUser && u.username === currentUser.username;
    return '<div class="set-item">' +
      '<span class="set-name" style="flex:1">' + esc(u.name || u.username) +
        ' <span style="color:#999;font-size:0.78em">@' + esc(u.username) + '</span></span>' +
      '<span class="role-badge ' + roleCls + '">' + t(u.role === 'admin' ? 'role_admin' : 'role_viewer') + '</span>' +
      (self ? '' : '<button class="set-del" onclick="delUser(\'' + esc(u.username) + '\')" title="Delete">&#x2715;</button>') +
    '</div>';
  }).join('');
}

function addUser() {
  if (!isAdmin()) return;
  const name = document.getElementById('set-u-name').value.trim();
  const username = document.getElementById('set-u-user').value.trim();
  const password = document.getElementById('set-u-pass').value;
  const role = document.getElementById('set-u-role').value;
  if (!username || !password) { alert(t('set_need_user')); return; }
  const res = DB.addUser({ username, password, role, name });
  if (res === 'dup')     { alert(t('set_dup_user')); return; }
  if (res === 'invalid') { alert(t('set_need_user')); return; }
  ['set-u-name','set-u-user','set-u-pass'].forEach(id => document.getElementById(id).value = '');
  renderUserList();
}

function delUser(username) {
  if (!isAdmin()) return;
  const u = DB.getUsers().find(x => x.username === username);
  showConfirm(
    t('confirm_delete'),
    t('confirm_del_user', { name: u ? (u.name || u.username) : username }),
    () => {
      const res = DB.deleteUser(username);
      if (res === 'last-admin') { alert(t('set_last_admin')); return; }
      renderUserList();
    }
  );
}

// ── FULL REFRESH ──────────────────────────────────────────────────
function refreshAll() {
  renderSidebar();
  renderStats();
  rebuildFilters();
  applyFilters();
  renderTable();
}
