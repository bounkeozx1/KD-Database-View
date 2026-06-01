/**
 * app.js — Main application logic
 * Depends on: db.js, i18n.js
 */

// ── State ─────────────────────────────────────────────────────────
let activeGroupId = '';
let sidebarSearchQ = '';
let tableFiltered  = [];
let sortCol  = 'worker_id';
let sortAsc  = true;
let editGroupId = null;
let highlightedWorkerUid = null;
let confirmCallback = null;
const expandedGroups = new Set(); // tracks which groups have workers list open

// ── Init ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const groups = DB.getGroups();
  activeGroupId = groups[0]?.id || '';
  if (activeGroupId) expandedGroups.add(activeGroupId);

  initSidebarResize();
  initMobileMenu();
  initDatePickers();
  applyTranslations();
  renderSidebar();
  renderStats();
  rebuildFilters();
  applyFilters();
  renderTable();
});

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
function renderSidebar() {
  const groups = DB.getGroups();
  const stats  = DB.getAllStats();
  const q = sidebarSearchQ.toLowerCase();

  const filtered = groups.filter(g =>
    !q || g.name.toLowerCase().includes(q)
  );

  const statsMap = {};
  stats.forEach(s => { statsMap[s.id] = s; });

  const tree = document.getElementById('sidebar-tree');
  if (!filtered.length) {
    tree.innerHTML = '<div style="padding:20px 14px;font-size:0.8rem;color:#4a5880;text-align:center">' + t('no_groups') + '</div>';
  } else {
    tree.innerHTML = filtered.map(g => {
      const s      = statsMap[g.id] || {};
      const active = g.id === activeGroupId;
      const isOpen = expandedGroups.has(g.id);
      const alertDot = s.expiring ? '<span class="tree-alert" title="Passport expiring"></span>' : '';
      const meta   = [g.departure ? '&#9992; ' + g.departure : '', g.route || ''].filter(Boolean).join('  ');
      return (
        '<div class="tree-group" id="tg-' + g.id + '">' +
          '<div class="tree-group-row' + (active ? ' active' : '') + '" onclick="switchGroup(\'' + g.id + '\')">' +
            '<span class="tree-folder-icon' + (active ? ' open' : '') + '">&#128193;</span>' +
            '<span class="tree-group-name">' + esc(g.name) + '</span>' +
            alertDot +
            '<span class="tree-count">' + (s.count || 0) + '</span>' +
            '<span class="tree-row-actions">' +
              '<button class="tree-act" onclick="openGroupForm(\'' + g.id + '\',event)" title="Edit">&#9998;</button>' +
              (groups.length > 1 ? '<button class="tree-act del" onclick="confirmDeleteGroup(\'' + g.id + '\',event)" title="Delete">&#x2715;</button>' : '') +
            '</span>' +
            '<span class="tree-chevron' + (isOpen ? ' expanded' : '') + '" ' +
                  'onclick="toggleGroupExpand(\'' + g.id + '\',event)" title="Expand/Collapse">&#9658;</span>' +
          '</div>' +
          (meta ? '<div class="tree-group-meta">' + meta + '</div>' : '') +
          '<div class="tree-workers' + (isOpen ? ' open' : '') + '" id="tw-' + g.id + '">' +
            renderTreeWorkers(g) +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  // Footer stats
  const totalWorkers = stats.reduce((a, s) => a + (s.count || 0), 0);
  const totalGroups  = groups.length;
  document.getElementById('sidebar-footer').innerHTML =
    totalGroups + ' groups &nbsp;·&nbsp; ' + totalWorkers + ' workers';
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

// sidebar search
document.getElementById('sidebar-search-input').addEventListener('input', e => {
  sidebarSearchQ = e.target.value;
  renderSidebar();
});

// ── SIDEBAR RESIZE ────────────────────────────────────────────────
function initSidebarResize() {
  const sidebar  = document.getElementById('sidebar');
  const resizer  = document.getElementById('sidebar-resizer');
  const toggle   = document.getElementById('sidebar-toggle');

  let startX, startW;

  resizer.addEventListener('mousedown', e => {
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(e) {
      const w = Math.max(180, Math.min(480, startW + e.clientX - startX));
      sidebar.style.width = w + 'px';
      document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    }
    function onUp() {
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  toggle.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
  });
}

function initMobileMenu() {
  const btn     = document.getElementById('mobile-menu-btn');
  const sidebar = document.getElementById('sidebar');
  const backdrop= document.getElementById('sidebar-backdrop');

  btn.addEventListener('click', () => sidebar.classList.toggle('open'));
  backdrop.addEventListener('click', () => sidebar.classList.remove('open'));
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

  // Count bar
  const gname  = g ? g.name : '';
  const dep    = g && g.departure ? ' · ' + t('departure_label') + ' ' + g.departure : '';
  const route  = g && g.route ? ' · ' + g.route : '';
  document.getElementById('count-bar').innerHTML =
    '<strong>' + esc(gname) + '</strong>' + esc(dep + route) +
    ' &nbsp;·&nbsp; ' + t('showing', { n: tableFiltered.length, total: ws.length });

  if (!tableFiltered.length) {
    tbody.innerHTML = '';
    noData.style.display = 'block';
    noData.querySelector('.no-data-title').textContent = ws.length ? t('no_results') : t('no_data_title');
    noData.querySelector('.no-data-msg').textContent   = ws.length ? '' : t('no_data_msg');
    return;
  }
  noData.style.display = 'none';

  tbody.innerHTML = tableFiltered.map(w => {
    const age = calcAge(w.dob);
    const ec  = expiryClass(w.passport_expiry);
    const idHtml = w.worker_id
      ? '<span class="worker-id">' + esc(w.worker_id) + '</span>'
      : '<span class="worker-id no-id">No ID</span>';
    return '<tr id="row-' + w.uid + '">' +
      '<td>' + idHtml + '</td>' +
      '<td><div class="name-cell">' + avatarHtml(w.en_name,'avatar-sm') + '<span style="font-weight:700">' + esc(w.en_name) + '</span></div></td>' +
      '<td style="color:#555;font-size:0.8rem">' + esc(w.lo_name) + '</td>' +
      '<td>' + empBadge(w.employer_code) + '</td>' +
      '<td>' + esc(w.group_supervisor) + '</td>' +
      '<td>' + esc(w.dob) + '</td>' +
      '<td>' + (age || '--') + '</td>' +
      '<td><span class="blood-chip">' + esc(w.blood || '--') + '</span></td>' +
      '<td style="font-family:monospace;font-size:0.8rem">' + esc(w.passport_no) + '</td>' +
      '<td class="' + ec + '">' + esc(w.passport_expiry) + '</td>' +
      '<td>' + esc(w.size) + '</td>' +
      '<td><div class="row-actions">' +
        '<button class="act-btn act-view" onclick="openView(\'' + w.uid + '\')">' + t('act_view') + '</button>' +
        '<button class="act-btn act-edit" onclick="openWorkerForm(\'' + w.uid + '\')">' + t('act_edit') + '</button>' +
        '<button class="act-btn act-del"  onclick="confirmDeleteWorker(\'' + w.uid + '\')">' + t('act_del') + '</button>' +
      '</div></td>' +
    '</tr>';
  }).join('');
}

// ── VIEW CARD ─────────────────────────────────────────────────────
function openView(uid) {
  const g = DB.getGroup(activeGroupId);
  const w = g && g.workers.find(x => x.uid === uid);
  if (!w) return;

  const age  = calcAge(w.dob);
  const warn = expiryClass(w.passport_expiry) !== 'expiry-ok';
  const idNum = w.worker_id ? w.worker_id.split('-').pop() : '--';

  function bc(type) {
    const on = w.blood === type;
    return '<div class="vm-bc"><div class="vm-box' + (on ? ' on' : '') + '">' + (on ? '✓' : '') + '</div>' + type + '</div>';
  }

  const idDisplay = w.worker_id
    ? w.worker_id.replace(/(\d+)$/, '<span class="id-num">$1</span>')
    : '<span style="color:#aaa">No ID</span>';

  const plane = avatarHtml(w.en_name, 'avatar-lg');

  function row(label, sub, val) {
    return '<tr><td>' + label + (sub ? '<span class="sub">' + sub + '</span>' : '') + '</td><td>' + val + '</td></tr>';
  }

  document.getElementById('vm-content').innerHTML =
    '<div class="vm-header">' +
      '<span class="vm-id">' + idDisplay + '</span>' +
      '<div class="vm-bloods">' + bc('A') + bc('B+') + bc('B-') + bc('O') + bc('AB') + '</div>' +
      (g ? '<span class="vm-group-tag">' + esc(g.name) + '</span>' : '') +
    '</div>' +
    '<div class="vm-body">' +
      '<div class="vm-left">' +
        '<div class="vm-sup-bar">' +
          '<span class="vm-sup-name">' + esc(w.group_supervisor || '--') + '</span>' +
          '<span class="vm-sup-seq">' + idNum + '</span>' +
        '</div>' +
        '<table class="vm-tbl">' +
          row(t('vc_name'), '/ຊື່', esc(w.en_name)) +
          row('ຊື່ ແລະ ນາມສະກຸນ', '', esc(w.lo_name)) +
          row(t('vc_dob'), 'ວັນເດືອນປີເກີດ', esc(w.dob)) +
          row(t('vc_age'), 'ອາຍຸ', age || '--') +
          row(t('vc_village'), 'ບ້ານ', esc(w.village || '--')) +
          row(t('vc_weight_height'), 'Kg ; Cm',
            '<div class="split"><span>' + (w.weight ? w.weight + 'Kg' : '--') + '</span><span>' + (w.height ? w.height + 'Cm' : '--') + '</span></div>') +
          row(t('vc_size'), 'ຂະໜາດເສື້ອ', esc(w.size || '--')) +
          row(t('vc_hand'), 'ຊ້າຍຫຼືຂວາ', w.hand === 'R' ? 'R (Right)' : w.hand === 'L' ? 'L (Left)' : '--') +
          row(t('vc_blood'), 'ກຸ່ມເລືອດ', esc(w.blood || '--')) +
          row(t('vc_issue'), 'ວັນທີອອກ', esc(w.passport_issue || '--')) +
          row(t('vc_passport'), 'ເລກທີ', '<span style="font-family:monospace">' + esc(w.passport_no) + '</span>') +
          row(t('vc_expiry'), 'ໝົດອາຍຸ', '<span class="' + expiryClass(w.passport_expiry) + '">' + esc(w.passport_expiry) + '</span>') +
          row(t('vc_tel'), 'ໂທ / Emergency', esc(w.tel || '--') + (w.emg_tel ? ' &nbsp; ' + esc(w.emg_tel) : '')) +
        '</table>' +
      '</div>' +
      '<div class="vm-right">' +
        '<div class="vm-photo">' + plane + '</div>' +
        (w.couple === 'yes' ? '<div class="vm-couple">부부</div>' : '') +
        '<table class="vm-rtbl">' +
          '<tr><td class="rl" colspan="2">ຈໍານວນເພດ / ຄູ່ຜົວເມຍ</td><td class="rl" colspan="2">--</td></tr>' +
          '<tr><td class="rl">여성</td><td class="rl"></td><td class="rl">배정인원</td><td>0 명</td></tr>' +
          '<tr><td class="rl">남성</td><td class="rl"></td><td class="rl">입국자 수</td><td>0 명</td></tr>' +
          '<tr><td class="rl">부부</td><td class="rl"></td><td class="rl" style="font-size:0.68rem">TEL</td><td style="font-size:0.7rem">' + esc(w.tel || '--') + '</td></tr>' +
        '</table>' +
      '</div>' +
    '</div>' +
    (warn ? '<div class="vm-warn">&#9888; ' + t('vc_passport_warn', { date: w.passport_expiry }) + '</div>' : '');

  openOverlay('view-overlay');
}

// ── WORKER FORM ───────────────────────────────────────────────────
function openWorkerForm(editUid) {
  const fids = ['worker-id','employer-code','supervisor','en-name','lo-name',
                'village','blood','hand','weight','height','size','couple',
                'tel','emg-tel','passport-no'];
  fids.forEach(f => { const el = document.getElementById('f-' + f); if (el) el.value = ''; });
  setDatePicker('dp-dob', '');
  setDatePicker('dp-issue', '');
  setDatePicker('dp-expiry', '');
  document.getElementById('f-edit-uid').value = '';
  document.getElementById('fm-title').textContent = t('fm_add_worker');

  if (editUid) {
    const g = DB.getGroup(activeGroupId);
    const w = g && g.workers.find(x => x.uid === editUid);
    if (!w) return;
    document.getElementById('fm-title').textContent = t('fm_edit_worker');
    document.getElementById('f-edit-uid').value        = editUid;
    document.getElementById('f-worker-id').value       = w.worker_id || '';
    document.getElementById('f-employer-code').value   = w.employer_code || '';
    document.getElementById('f-supervisor').value      = w.group_supervisor || '';
    document.getElementById('f-en-name').value         = w.en_name || '';
    document.getElementById('f-lo-name').value         = w.lo_name || '';
    setDatePicker('dp-dob', w.dob || '');
    document.getElementById('f-village').value         = w.village || '';
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
  }
  openOverlay('form-overlay');
}

function saveWorker() {
  const enName = document.getElementById('f-en-name').value.trim();
  const passNo = document.getElementById('f-passport-no').value.trim();
  if (!enName) { alert('Name (EN) is required'); return; }
  if (!passNo) { alert('Passport No. is required'); return; }

  const editUid = document.getElementById('f-edit-uid').value;
  const data = {
    worker_id:      document.getElementById('f-worker-id').value.trim(),
    employer_code:  document.getElementById('f-employer-code').value,
    group_supervisor: document.getElementById('f-supervisor').value.trim(),
    en_name:        enName.toUpperCase(),
    lo_name:        document.getElementById('f-lo-name').value.trim(),
    dob:            document.getElementById('f-dob').value.trim(),
    village:        document.getElementById('f-village').value.trim(),
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
  };

  if (editUid) {
    DB.updateWorker(activeGroupId, editUid, data);
  } else {
    DB.addWorker(activeGroupId, data);
  }

  closeOverlay('form-overlay');
  refreshAll();
}

// ── GROUP FORM ────────────────────────────────────────────────────
function openGroupForm(gid, event) {
  if (event) event.stopPropagation();
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
  document.getElementById('cm-confirm-btn').textContent = t('confirm_delete');
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
function openOverlay(id)  { document.getElementById(id).classList.add('open'); }
function closeOverlay(id) { document.getElementById(id).classList.remove('open'); }

// Click outside to close
['view-overlay','form-overlay','group-overlay','confirm-overlay'].forEach(id => {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target.id === id) closeOverlay(id);
  });
});

// ── LANGUAGE ──────────────────────────────────────────────────────
document.querySelectorAll('.lang-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    setLang(btn.dataset.lang);
    rebuildFilters();
    renderTable();
    renderSidebar();
  });
});

// ── FULL REFRESH ──────────────────────────────────────────────────
function refreshAll() {
  renderSidebar();
  renderStats();
  rebuildFilters();
  applyFilters();
  renderTable();
}
