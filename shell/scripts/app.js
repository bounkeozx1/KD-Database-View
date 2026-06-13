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
let viewMode = localStorage.getItem('kd_view') || 'table'; // 'table' | 'cards'
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
  activeGroupId = groups[0]?.id || '';
  if (activeGroupId) expandedGroups.add(activeGroupId);

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
  renderStats();
  rebuildFilters();
  applyFilters();
  renderTable();
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

    // Auto-advance: DD→MM→YYYY, clamp values
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
    // Block non-numeric keystrokes (allow: 0-9, backspace, tab, arrows)
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
  const dashCharts  = document.getElementById('dash-charts');

  if (view === 'dashboard') {
    quickFilter = '';
    document.getElementById('search').value = '';
    document.getElementById('f-employer').value = '';
    document.getElementById('f-supervisor').value = '';
    document.getElementById('f-blood').value = '';
    if (dashWelcome) dashWelcome.style.display = '';
    if (dashCharts)  { dashCharts.style.display = ''; renderDashCharts(); }
  } else {
    if (dashWelcome) dashWelcome.style.display = 'none';
    if (dashCharts)  dashCharts.style.display = 'none';
    if (view === 'alerts') quickFilter = 'alerts';
    else if (view === 'projects') {
      document.getElementById('sb-groups-section')?.classList.remove('collapsed');
      document.getElementById('sb-groups-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.getElementById('sidebar').classList.remove('open');
      return;
    }
  }
  applyFilters();
  document.querySelector('.main-content')?.scrollTo({ top: 0, behavior: 'smooth' });
  document.getElementById('sidebar').classList.remove('open');
}

// ── Sidebar search row (ChatGPT "Search") ─────────────────────────
function toggleSidebarSearch(forceOpen) {
  const box = document.getElementById('sb-search');
  if (!box) return;
  const open = forceOpen || box.style.display === 'none';
  box.style.display = open ? 'flex' : 'none';
  if (open) { const i = document.getElementById('sidebar-search-input'); i.focus(); i.select(); }
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

  // Profile head (big avatar + name + role badge)
  const head = document.getElementById('pm-profile-head');
  if (head) {
    head.innerHTML =
      profileAvatarHtml(currentUser.username, name, 'avatar-lg', true) +
      '<div class="pm-profile-name">' + esc(name) + '</div>' +
      '<span class="role-badge ' + roleCls + '">' + esc(roleTxt) + '</span>';
  }

  // Accounts list: current user first (no click), then others (clickable to switch)
  const accEl = document.getElementById('pm-accounts');
  if (!accEl) return;
  const allUsers = (DB.getUsers ? DB.getUsers() : []);
  accEl.innerHTML = allUsers.map(u => {
    const isCurrent = u.username === currentUser.username;
    const uName = u.name || u.username;
    const uRoleTxt = t(u.role === 'admin' ? 'role_admin' : 'role_viewer');
    const uRoleCls = u.role === 'admin' ? 'role-admin' : 'role-viewer';
    const checkmark = isCurrent
      ? '<svg class="pm-check" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
      : '';
    const clickAttr = isCurrent ? '' : ' clickable" onclick="profileSwitchAccount(\'' + esc(u.username) + '\')';
    return '<div class="pm-user-card' + (isCurrent ? '' : ' clickable') + '"' +
      (isCurrent ? '' : ' onclick="profileSwitchAccount(\'' + esc(u.username) + '\')"') + '>' +
      profileAvatarHtml(u.username, uName, 'avatar-xs', false) +
      '<div class="pm-user-info">' +
        '<span class="pm-user-name">' + esc(uName) + '</span>' +
        '<span class="pm-user-sub"><span class="role-badge ' + uRoleCls + '">' + esc(uRoleTxt) + '</span> @' + esc(u.username) + '</span>' +
      '</div>' +
      checkmark +
    '</div>';
  }).join('');
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
  const btn     = document.getElementById('mobile-menu-btn');
  const sidebar = document.getElementById('sidebar');
  const backdrop= document.getElementById('sidebar-backdrop');

  if (btn) btn.addEventListener('click', () => sidebar?.classList.toggle('open'));
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
  expandedGroups.add(id); // auto-expand selected group
  highlightedWorkerUid = null;
  document.getElementById('search').value = '';
  document.getElementById('f-employer').value = '';
  document.getElementById('f-supervisor').value = '';
  document.getElementById('f-blood').value = '';
  renderSidebar();
  renderStats();
  rebuildFilters();
  applyFilters();
  renderTable();
  // On mobile, close sidebar after selection
  document.getElementById('sidebar').classList.remove('open');
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

  // Render BOTH views; applyViewMode() shows the active one
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
// Mobile-first: phones always use the card view (a wide table is unusable
// on a phone). On larger screens the user's saved preference is respected.
function isMobileView() { return window.innerWidth <= 640; }
function currentView()  { return isMobileView() ? 'cards' : viewMode; }

function setViewMode(mode) {
  viewMode = (mode === 'cards') ? 'cards' : 'table';
  localStorage.setItem('kd_view', viewMode);
  renderTable();
}

function applyViewMode() {
  const cardsWrap = document.getElementById('cards-wrap');
  const tableWrap = document.querySelector('.table-wrap');
  const isCards = currentView() === 'cards';
  if (tableWrap) tableWrap.style.display = isCards ? 'none' : '';
  if (cardsWrap) cardsWrap.style.display = isCards ? 'block' : 'none';
  document.getElementById('view-table')?.classList.toggle('active', !isCards);
  document.getElementById('view-cards')?.classList.toggle('active', isCards);
}

// ── CARD / ID-CARD RENDER ─────────────────────────────────────────
function renderCards() {
  const grid = document.getElementById('cards-grid');
  if (!grid) return;
  grid.innerHTML = tableFiltered.map(w => {
    const idTxt = w.worker_id || w.passport_no || 'No ID';
    const tel   = w.tel || '--';
    return '<div class="wcard" id="card-' + w.uid + '" onclick="openView(\'' + w.uid + '\')">' +
      '<div class="wcard-photo">' + personPhoto(w, 'avatar-lg') + '</div>' +
      '<div class="wcard-main">' +
        '<div class="wcard-name">' + esc(w.en_name || '--') + '</div>' +
        '<div class="wcard-id"><span class="wcard-idchip">' + esc(idTxt) + '</span>' + empBadge(w.employer_code) + '</div>' +
        '<div class="wcard-meta">' +
          '<span class="wcard-tel">&#128222; ' + esc(tel) + '</span>' +
          statusBadge(w) +
        '</div>' +
      '</div>' +
      '<button class="kebab wcard-kebab" onclick="openRowMenu(\'' + w.uid + '\',event)" title="' + esc(t('col_actions')) + '">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>' +
      '</button>' +
    '</div>';
  }).join('');
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

// Re-apply the view when crossing the mobile/desktop breakpoint
let _wasMobile = isMobileView();
window.addEventListener('resize', () => {
  const m = isMobileView();
  if (m !== _wasMobile) { _wasMobile = m; if (document.body.classList.contains('authed')) renderTable(); }
});

// ── ID BADGE CARD builder ─────────────────────────────────────────
function _renderBadgeCard(w, g) {
  const gradeColors = { A:'#16a34a', B:'#2563eb', C:'#d97706', D:'#dc2626' };
  const idSeq = w.worker_id ? '#' + w.worker_id.split('-').pop() : '';

  const photoHtml = isAdmin()
    ? '<div class="idc-photo editable" onclick="_triggerPhotoEdit(\'' + esc(w.uid) + '\')" title="Tap to change photo">' +
        personPhoto(w, 'avatar-xl') +
        '<div class="idc-photo-edit">&#9998;</div>' +
      '</div>' +
      '<input type="file" id="photo-edit-input" accept="image/*" style="display:none" onchange="_handlePhotoEdit(this,\'' + esc(w.uid) + '\')">'
    : '<div class="idc-photo">' + personPhoto(w, 'avatar-xl') + '</div>';

  const tags = [];
  if (w.employer_code) tags.push('<span class="idc-tag">' + esc(w.employer_code) + '</span>');
  if (g && g.name)     tags.push('<span class="idc-tag">' + esc(g.name) + '</span>');
  if (w.group_supervisor) tags.push('<span class="idc-tag">' + esc(w.group_supervisor) + '</span>');
  if (w.couple === 'yes') tags.push('<span class="idc-tag idc-tag-couple">부부</span>');

  return '<div class="id-badge-card">' +
    '<div class="idc-visual">' +
      '<svg class="idc-swoosh" viewBox="0 0 300 168" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M300,0 C258,0 218,24 184,70 C140,130 128,160 68,168 L300,168 Z" fill="#1a2235"/>' +
        '<path d="M300,0 C282,8 272,38 278,82 C283,118 294,148 300,168 L300,0 Z" fill="rgba(26,34,53,0.35)"/>' +
      '</svg>' +
      (w.grade ? '<div class="idc-grade-flag">GRADE ' + esc(w.grade) + '</div>' : '') +
      (idSeq   ? '<div class="idc-seq">' + esc(idSeq) + '</div>' : '') +
      photoHtml +
    '</div>' +
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

// ── VIEW CARD ─────────────────────────────────────────────────────
function openView(uid) {
  const g = DB.getGroup(activeGroupId);
  const w = g && g.workers.find(x => x.uid === uid);
  if (!w) return;

  _currentViewUid = uid;

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

  const actionsEl = document.getElementById('vm-topbar-actions');
  if (actionsEl) {
    actionsEl.innerHTML = isAdmin()
      ? '<button class="vm-action-btn" onclick="openWorkerForm(\'' + esc(uid) + '\')">&#9998; Edit</button>'
      : '';
  }

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

  const visaLabels = { not_started:'ຍັງບໍ່ເລີ່ມ', applied:'ຍື່ນຂໍແລ້ວ', approved:'ອະນຸມັດ ✓', rejected:'ຖືກປະຕິເສດ ✗' };
  const visaColors = { not_started:'#888', applied:'#2563eb', approved:'#16a34a', rejected:'#dc2626' };
  const warn = expiryClass(w.passport_expiry) !== 'expiry-ok';

  function row(label, sub, val) {
    return '<tr><td>' + label + (sub ? '<span class="sub">' + sub + '</span>' : '') + '</td><td>' + val + '</td></tr>';
  }

  document.getElementById('vm-content').innerHTML =
    _renderBadgeCard(w, g) +
    '<div class="vm-detail-section">' +
      (warn ? '<div class="vm-warn">&#9888; ' + t('vc_passport_warn', { date: w.passport_expiry }) + '</div>' : '') +
      '<table class="vm-tbl">' +
        row(t('vc_name'), '/ຊື່', esc(w.en_name)) +
        row('ຊື່ ນາມສະກຸນ', '', esc(w.lo_name)) +
        row(t('vc_dob'), 'ວັນເດືອນປີເກີດ', esc(w.dob)) +
        row(t('vc_age'), 'ອາຍຸ', age ? age + ' yrs' : '--') +
        (w.nationality ? row(t('vc_nationality'), 'ສັນຊາດ', esc(w.nationality)) : '') +
        (w.sex ? row(t('vc_sex'), 'ເພດ', w.sex === 'M' ? '♂ ' + t('fm_sex_m') : '♀ ' + t('fm_sex_f')) : '') +
        row(t('vc_village'), 'ບ້ານ', esc(w.village || '--')) +
        row(t('vc_weight_height'), 'Kg ; Cm',
          '<div class="split"><span>' + (w.weight ? w.weight + 'Kg' : '--') + '</span><span>' + (w.height ? w.height + 'Cm' : '--') + '</span></div>') +
        row(t('vc_size'), 'ຂະໜາດເສື້ອ', esc(w.size || '--')) +
        row(t('vc_hand'), 'ຊ້າຍຫຼືຂວາ', w.hand === 'R' ? 'R (Right)' : w.hand === 'L' ? 'L (Left)' : '--') +
        row(t('vc_blood'), 'ກຸ່ມເລືອດ', esc(w.blood || '--')) +
        row(t('vc_passport'), 'ເລກທີ', '<span style="font-family:monospace">' + esc(w.passport_no) + '</span>') +
        row(t('vc_issue_expiry'), 'ວັນທີອອກ / ໝົດອາຍຸ',
          '<div class="split"><span>' + esc(w.passport_issue || '--') + '</span>' +
          '<span class="' + expiryClass(w.passport_expiry) + '">' + esc(w.passport_expiry || '--') + '</span></div>') +
        row(t('vc_tel'), 'ໂທ / Emergency', esc(w.tel || '--') + (w.emg_tel ? ' &nbsp; ' + esc(w.emg_tel) : '')) +
        (w.visa_status ? row('Visa Status', 'ວີຊາ', '<span style="color:' + (visaColors[w.visa_status]||'#888') + ';font-weight:700">' + esc(visaLabels[w.visa_status]||w.visa_status) + '</span>') : '') +
        (w.education    ? row('Education', 'ການສຶກສາ', esc(w.education)) : '') +
        (w.work_experience ? row('Experience', 'ປະສົບການ', esc(w.work_experience)) : '') +
        (w.languages    ? row('Languages', 'ພາສາ', esc(w.languages)) : '') +
      '</table>' +
    '</div>';

  // Docs tab - render placeholder for on-demand load
  document.getElementById('vm-docs-content').innerHTML =
    '<div class="vm-docs-title">&#128193; ' + t('vc_documents') + '</div>' +
    '<div class="doc-loading">&#8203;</div>';

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
  _fileToDataURL(file, 800, async dataUrl => {
    try {
      await DB.updateEmployee(uid, { photo: dataUrl, _by: currentUser?.username });
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
    const history = versions.filter(v => !v.isCurrent);

    const preview = current
      ? '<div class="doc-thumb" onclick="openDocViewById(' + current.id + ',\'' + esc(current.path) + '\',\'' + current.type + '\',\'' + esc(current.name) + '\')">' +
          (current.type === 'pdf'
            ? '<div class="doc-pdf">PDF</div>'
            : '<img src="' + esc(current.path) + '" alt="">') +
          '<span class="doc-ver">v' + current.version + '</span>' +
          (canEdit ? '<button class="doc-del" onclick="deleteDocById(event,' + current.id + ',\'' + uid + '\')">&#x2715;</button>' : '') +
        '</div>'
      : '';

    const histHtml = history.length
      ? '<div class="doc-history">' +
          history.map(v =>
            '<span class="doc-hist-item" onclick="openDocViewById(' + v.id + ',\'' + esc(v.path) + '\',\'' + v.type + '\',\'' + esc(v.name) + '\')">' +
              'v' + v.version +
              (canEdit ? '<button onclick="deleteDocById(event,' + v.id + ',\'' + uid + '\')">&#x2715;</button>' : '') +
            '</span>'
          ).join('') +
        '</div>'
      : '';

    const addBtn = canEdit
      ? '<label class="doc-add" title="' + esc(t('doc_add')) + '">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
          '<input type="file" accept="image/*,application/pdf" style="display:none" onchange="handleDocUpload(this,\'' + uid + '\',\'' + cat.key + '\')">' +
        '</label>'
      : '';

    return '<div class="doc-cat">' +
      '<div class="doc-cat-head"><span>' + esc(cat.label) + '</span>' +
        '<span class="doc-count">' + (versions.length || '') + '</span>' +
      '</div>' +
      '<div class="doc-files">' +
        preview + addBtn +
        (!current && !canEdit ? '<span class="doc-empty">' + t('doc_empty') + '</span>' : '') +
      '</div>' +
      histHtml +
    '</div>';
  }).join('');

  container.innerHTML = '<div class="vm-docs-title">&#128193; ' + t('vc_documents') + '</div>' + (html || '<div class="doc-loading">No documents</div>');
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
                'village','nationality','sex','blood','hand','weight','height','size','couple',
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
    dob:            document.getElementById('f-dob').value.trim(),
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
    passport_issue: document.getElementById('f-issue').value.trim(),
    passport_expiry:document.getElementById('f-expiry').value.trim(),
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
  document.getElementById('gf-name').value  = '';
  document.getElementById('gf-date').value  = '';
  document.getElementById('gf-route').value = '';
  document.getElementById('gm-title').textContent = editGroupId ? t('gm_edit_group') : t('gm_new_group');
  document.getElementById('gm-btn').textContent   = editGroupId ? t('gm_save') : t('gm_create');

  if (editGroupId) {
    const g = DB.getGroup(editGroupId);
    if (g) {
      document.getElementById('gf-name').value      = g.name || '';
      document.getElementById('gf-date').value      = g.departure || '';
      document.getElementById('gf-route').value     = g.route || '';
    }
  }
  openOverlay('group-overlay');
}

function saveGroup() {
  if (!isAdmin()) return;
  const name = document.getElementById('gf-name').value.trim();
  if (!name) { alert(t('gm_group_name') + ' is required'); return; }

  if (editGroupId) {
    DB.updateGroup(editGroupId, {
      name: name,
      departure: document.getElementById('gf-date').value.trim(),
      route: document.getElementById('gf-route').value.trim()
    });
  } else {
    const id = DB.createGroup({
      name: name,
      departure: document.getElementById('gf-date').value.trim(),
      route: document.getElementById('gf-route').value.trim()
    });
    activeGroupId = id;
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
['view-overlay','form-overlay','group-overlay','confirm-overlay','settings-overlay','import-overlay','scan-overlay','docview-overlay'].forEach(id => {
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
  document.querySelectorAll('.set-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
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
