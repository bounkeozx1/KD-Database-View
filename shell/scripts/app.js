/**
 * app.js — Main application logic
 * Depends on: db.js, i18n.js
 */

// ── State ─────────────────────────────────────────────────────────
let activeGroupId = '';
let _currentViewUid = null;  // uid of worker currently shown in detail overlay
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
// Auth lives on a separate page (login.html). If there is no active
// session, bounce straight there; otherwise boot the app.
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await DB.init();
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
    initProvinceCombobox();
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
           '<img src="' + w.photo + '" alt="' + esc(w.en_name || '') + '" loading="lazy" decoding="async"></div>';
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
  function pick(val) { input.value = val; closeList(); input.focus(); }

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
  applySidebarPrefs();   // honour Customize-sidebar visibility choices
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
    archive:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
    unarchive:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><polyline points="9 13 12 10 15 13"/><line x1="12" y1="10" x2="12" y2="17"/></svg>',
    del:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
  };
  const item = (act, icon, label, danger) =>
    '<button' + (danger ? ' class="danger"' : '') + ' onclick="groupMenuAct(\'' + act + '\')">' + icon + '<span>' + label + '</span></button>';

  menu.innerHTML =
    item('share',  I.share,  t('gm_share')) +
    item('pin',    I.pin,    pinned ? t('unpin') : t('gm_pin')) +
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
function navTo(view, el) {
  // Projects: just expand the sidebar's group list, no main-view change
  if (view === 'projects') {
    document.getElementById('sb-groups-section')?.classList.remove('collapsed');
    document.getElementById('sidebar').classList.remove('open');
    return;
  }

  document.querySelectorAll('.sb-nav-item').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');

  const dashWelcome = document.getElementById('dashboard-welcome');
  const groupView   = document.getElementById('group-view');
  const groupsOv    = document.getElementById('groups-overview');

  // Hide every main view first, then show the one we want
  if (dashWelcome) dashWelcome.style.display = 'none';
  if (groupView)   groupView.style.display   = 'none';
  if (groupsOv)    groupsOv.style.display    = 'none';

  const clearSearch = () => {
    const s = document.getElementById('search'); if (s) s.value = '';
    const ts = document.getElementById('sidebar-search-input'); if (ts) ts.value = '';
    ['f-employer','f-supervisor','f-blood'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
  };

  if (view === 'dashboard') {
    quickFilter = '';
    clearSearch();
    if (dashWelcome) dashWelcome.style.display = '';
    renderDashboard();
  } else if (view === 'workers') {
    // Landing = group overview. Pick a group to see its members.
    quickFilter = '';
    activeGroupId = '';
    clearSearch();
    if (groupsOv) groupsOv.style.display = '';
    renderGroupsOverview();
  } else if (view === 'alerts') {
    // Expiring passports across ALL groups
    quickFilter = 'alerts';
    activeGroupId = '';
    if (groupView) groupView.style.display = '';
    const t1 = document.getElementById('page-title-group'); if (t1) t1.textContent = '⚠ ' + t('passport_alert');
    const t2 = document.getElementById('page-sub');         if (t2) t2.textContent = (t('all_groups') || 'All groups');
    rebuildFilters(); applyFilters();
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
  const cur = (typeof currentLang !== 'undefined' ? currentLang : 'en');
  document.querySelectorAll('#pm-lang-list button').forEach(b => b.classList.toggle('on', b.dataset.lang === cur));
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
  // Show group view, hide dashboard + groups overview
  const dw = document.getElementById('dashboard-welcome');
  const gv = document.getElementById('group-view');
  const go = document.getElementById('groups-overview');
  if (dw) dw.style.display = 'none';
  if (go) go.style.display = 'none';
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

// ── Navigate to a specific group (from dashboard cards / overview) ─
function openGroup(groupId) {
  switchGroup(groupId);
}

// All workers across every group (used when no single group is active)
function _allWorkersFlat() { return DB.getGroups().flatMap(g => g.workers || []); }

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
function renderGroupsOverview() {
  const el = document.getElementById('go-grid');
  if (!el) return;
  const groups = _orderGroups(DB.getGroups().filter(g => !g.archived));
  if (!groups.length) {
    el.innerHTML = '<div class="go-empty">' + (t('dz_no_projects') || 'ຍັງບໍ່ມີກຸ່ມ') + '</div>';
    return;
  }
  el.innerHTML = groups.map(g => {
    const ws    = g.workers || [];
    const cnt   = ws.length;
    let expiring = 0;
    ws.forEach(w => { const c = expiryClass(w.passport_expiry); if (c === 'expiry-expired' || c === 'expiry-warn' || c === 'expiry-near') expiring++; });
    const short = ((g.name || '?').replace(/[^A-Za-z0-9]/g, '').substring(0, 2).toUpperCase()) || 'KD';
    const route = g.route || g.departure || '';
    return '<div class="go-card" onclick="openGroup(\'' + esc(g.id) + '\')">' +
      '<div class="go-card-top">' +
        '<div class="go-ic">' + esc(short) + '</div>' +
        '<div style="min-width:0">' +
          '<div class="go-name">' + esc(g.name || '—') + '</div>' +
          (route ? '<div class="go-route">' + esc(route) + '</div>' : '') +
        '</div>' +
        '<svg class="go-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>' +
      '</div>' +
      '<div class="go-stats">' +
        '<div class="go-stat"><span class="n">' + cnt + '</span><span class="l">' + (t('dz_workers_suffix') || 'ຄົນ') + '</span></div>' +
        '<div class="go-stat' + (expiring ? ' go-alert' : '') + '"><span class="n">' + expiring + '</span><span class="l">' + (t('dz_near') || 'ໃກ້ໝົດ') + '</span></div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ── Sidebar search → mirror into toolbar search + filter ──────────
function sidebarSearch(value) {
  const s = document.getElementById('search');
  if (s) s.value = value;

  // Searching inside an already-open group → just filter it
  if (activeGroupId) { applyFilters(); return; }

  const gv = document.getElementById('group-view');
  const go = document.getElementById('groups-overview');
  const dw = document.getElementById('dashboard-welcome');

  if (value) {
    // Global worker search across ALL groups → show the member table
    ['f-employer','f-supervisor','f-blood'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
    quickFilter = '';
    if (dw) dw.style.display = 'none';
    if (go) go.style.display = 'none';
    if (gv) gv.style.display = '';
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
  // table rows AND every KD card on each pass (then hiding one) doubled the DOM
  // and image-decode work — the main cause of the jank on larger groups.
  if (currentView() === 'kdcard') {
    renderCards(g);
    if (tbody) tbody.innerHTML = '';
    return;
  }
  const cg = document.getElementById('cards-grid');
  if (cg) cg.innerHTML = '';

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
    '<div class="idc-cell" onclick="openView(\'' + esc(w.uid) + '\')">' +
      _completenessChip(w) +
      _renderKdCard(w, g, false, gc) +
    '</div>'
  ).join('');
}

// ── KD original-form card (brown layout) ──────────────────────────
function _kdGenderCounts(g) {
  let f = 0, m = 0;
  ((g && g.workers) || []).forEach(w => { if (w.sex === 'F') f++; else if (w.sex === 'M') m++; });
  return { f, m };
}
function _renderKdCard(w, g, editable, gc) {
  const seq    = w.worker_id ? w.worker_id.split('-').pop() : '';
  const bloods = ['A', 'B', 'O', 'AB'];
  const bloodRow = bloods.map(b => '<span class="kd-blood' + (w.blood === b ? ' on' : '') + '">' + b + '</span>').join('');
  gc = gc || _kdGenderCounts(g);   // callers rendering a single card can omit it
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
  const row = (label, sub, val) =>
    '<div class="vd-row">' +
      '<span class="vd-lbl">' + label + (sub ? '<span class="vd-sub">' + sub + '</span>' : '') + '</span>' +
      '<span class="vd-val">' + val + '</span>' +
    '</div>';
  const sec = (icon, lo, en, rows) =>
    '<div class="vd-section">' +
      '<div class="vd-section-head">' +
        '<span class="vd-sec-icon">' + icon + '</span>' +
        '<span class="vd-sec-title">' + lo + '</span>' +
        '<span class="vd-sec-sub">/ ' + en + '</span>' +
      '</div>' +
      '<div class="vd-rows">' + rows + '</div>' +
    '</div>';

  const sexOpts  = [{v:'',t:'--'},{v:'M',t:t('fm_sex_m')},{v:'F',t:t('fm_sex_f')}];
  const handOpts = [{v:'',t:'--'},{v:'R',t:'R (Right)'},{v:'L',t:'L (Left)'}];
  const bloodOpts= [{v:'',t:'--'},{v:'A',t:'A'},{v:'B',t:'B'},{v:'O',t:'O'},{v:'AB',t:'AB'},{v:'B+',t:'B+'},{v:'B-',t:'B-'}];
  const sizeOpts = [{v:'',t:'--'},{v:'S',t:'S'},{v:'M',t:'M'},{v:'L',t:'L'},{v:'XL',t:'XL'},{v:'XXL',t:'XXL'}];

  const tableHtml =
    '<div class="vd-sections">' +
      (warn ? '<div class="vd-warn">&#9888; ' + t('vc_passport_warn', { date: w.passport_expiry }) + '</div>' : '') +

      sec('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>', 'ຂໍ້ມູນລະບຸຕົວຕົນ', 'Identity',
        row('Worker ID', 'ລະຫັດ', _ev(w,'worker_id', esc(w.worker_id||'--'), 'text')) +
        row(t('vc_name'), 'EN Name', _ev(w,'en_name', esc(w.en_name||'--'), 'text')) +
        row('ຊື່ ນາມສະກຸນ', 'LO Name', _ev(w,'lo_name', esc(w.lo_name||'--'), 'text')) +
        row(t('vc_dob'), 'ວັນເດືອນປີ', _ev(w,'dob', esc(w.dob||'--'), 'text')) +
        row(t('vc_age'), 'ອາຍຸ', _ev(w,'age', age ? age + ' yrs' : '--', 'text')) +
        row(t('vc_nationality'), 'ສັນຊາດ', _ev(w,'nationality', esc(w.nationality||'--'), 'text')) +
        row(t('vc_sex'), 'ເພດ', ed ? _ev(w,'sex','','select',sexOpts) : (w.sex==='M'?'♂ '+t('fm_sex_m'):w.sex==='F'?'♀ '+t('fm_sex_f'):'--'))
      ) +

      sec('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>', 'ທີ່ຢູ່', 'Address',
        row('ແຂວງ', 'Province', _ev(w,'province', esc(w.province||'--'), 'text')) +
        row('ເມືອງ', 'District', _ev(w,'district', esc(w.district||'--'), 'text')) +
        row('ບ້ານ',  'Village',  _ev(w,'village',  esc(w.village||'--'),  'text'))
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
      _completenessBox(w) +
    '</div>';

  return '<div class="vm-single-view">' + photoHeader + tableHtml + '</div>';
}

function _renderDetailTopbar(w, uid) {
  const el = document.getElementById('vm-topbar-actions'); if (!el) return;
  let h = '';
  // Prev / next worker (also bound to ← / → keys)
  const ni = _navUids.indexOf(uid);
  if (_navUids.length > 1 && ni >= 0) {
    const prevDis = ni <= 0 ? ' disabled' : '';
    const nextDis = ni >= _navUids.length - 1 ? ' disabled' : '';
    h += '<button class="vm-action-btn vm-nav-btn" onclick="_navWorker(-1)" title="'+esc(t('nav_prev')||'ก่อนหน้า (←)')+'"'+prevDis+'>&#8249;</button>';
    h += '<button class="vm-action-btn vm-nav-btn" onclick="_navWorker(1)" title="'+esc(t('nav_next')||'ถัดไป (→)')+'"'+nextDis+'>&#8250;</button>';
    h += '<span class="vm-nav-count">'+(ni+1)+'/'+_navUids.length+'</span>';
  }
  h += '<button class="vm-action-btn" onclick="zoomCard(\''+esc(uid)+'\')" title="'+esc(t('vd_zoom'))+'">&#10530;</button>';
  h += '<button class="vm-action-btn" onclick="openExportDialog(\'worker\',\''+esc(uid)+'\')">&#11015; Export</button>';
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
  openView(next);                 // keep the detail + state in sync
  if (zoomOpen) zoomCard(next);   // re-render the zoomed card on top
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
        if (ww) { ww.photo = dataUrl; ww.photo_orig = orig || dataUrl; }
        if (_currentViewUid === uid) openView(uid);   // refresh the KD card in place
        toast(t('photo_saved') || 'ອັບເດດຮູບແລ້ວ', 'ok');
      } catch (e) {
        toast(t('photo_save_err') || 'ບັນທຶກຮູບບໍ່ສຳເລັດ', 'err');
      }
    },
  });
}

// ── DOCUMENTS (inside the detail drawer, versioned) ───────────────
// Document categories — admin-configurable in Settings → Documents (localStorage).
// Not locked to a fixed six; admins can add/rename/remove types (e.g. residence cert).
const _DEFAULT_DOC_CATS = [
  { key: 'passport',  label: 'Passport' },
  { key: 'id_card',   label: 'ID Card' },
  { key: 'residence', label: 'Residence certificate' },
  { key: 'form_1',    label: 'Form 1' },
  { key: 'form_2',    label: 'Form 2' },
  { key: 'land_doc',  label: 'Land document' },
];
function getDocCats() {
  try { const c = DB.getSetting('doc_cats', null); if (Array.isArray(c) && c.length) return c; } catch (e) {}
  // legacy fallback (older versions stored this per-browser)
  try { const l = JSON.parse(localStorage.getItem('kd_doc_cats')); if (Array.isArray(l) && l.length) return l; } catch (e) {}
  return _DEFAULT_DOC_CATS;
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

function _renderDocs(uid) {
  const container = document.getElementById('vm-docs-content') || document.getElementById('vm-docs-' + uid);
  if (!container) return;
  const docs = _docCache[uid] || {};
  const canEdit = isAdmin();
  const html = getDocCats().map(cat => {
    const versions = docs[cat.key] || [];
    const current = versions.find(v => v.isCurrent) || versions[0];
    const history = versions.filter(v => v !== current);
    const hasFile = !!current;
    const dateRaw = current && (current.uploadedAt || current.date || current.created || current.createdAt);
    const dateStr = dateRaw ? new Date(dateRaw).toLocaleDateString() : '';

    // Preview thumbnail (monochrome) or a neutral placeholder
    const preview = hasFile
      ? '<div class="docb-preview" onclick="event.stopPropagation();openDocViewById(' + current.id + ',\'' + esc(current.path) + '\',\'' + current.type + '\',\'' + esc(current.name) + '\',\'' + esc(uid) + '\',\'' + esc(cat.key) + '\')">' +
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

    const histHtml = history.length
      ? '<div class="docb-history"><span class="docb-hist-label">' + t('doc_history') + ':</span>' +
          history.map(v =>
            '<span class="docb-hist-item" onclick="openDocViewById(' + v.id + ',\'' + esc(v.path) + '\',\'' + v.type + '\',\'' + esc(v.name) + '\',\'' + esc(uid) + '\',\'' + esc(cat.key) + '\')">v' + v.version +
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
  body.innerHTML = type === 'pdf'
    ? '<iframe class="docview-pdf" src="' + esc(path) + '"></iframe>'
    : '<img class="docview-img" src="' + esc(path) + '" alt="' + esc(name || '') + '" onclick="_docZoomCycle(event)" title="' + esc(bi('ຄລິກເພື່ອຊູມ', 'Click to zoom', 'คลิกเพื่อซูม', '클릭하여 확대')) + '">';
  // The Edit/crop button only makes sense for an admin editing a real image
  // attached to a known worker + category (so we can upload the result back).
  const editBtn = document.getElementById('docview-edit');
  if (editBtn) editBtn.style.display = (type === 'image' && uid && cat && isAdmin()) ? '' : 'none';
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
    document.getElementById('f-supervisor').value      = w.group_supervisor || '';
    document.getElementById('f-en-name').value         = w.en_name || '';
    document.getElementById('f-lo-name').value         = w.lo_name || '';
    setDatePicker('dp-dob', w.dob || '');
    document.getElementById('f-province').value        = w.province || '';
    document.getElementById('f-district').value        = w.district || '';
    document.getElementById('f-village').value         = w.village || '';
    _editLocNames = { 0: w.province || '', 1: w.district || '', 2: w.village || '' };
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
  renderFormLocation();
  if (!editUid) regenWorkerId();
  updateIdPreview();
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
function onWorkerIdInput(v) { _widManual = true; checkWorkerIdDup(v); }

// ── WORKER FORM: cascading Location Dictionary selects ────────────
let _editLocNames = null;
const _LOC_INPUTS = ['f-province', 'f-district', 'f-village'];   // level 0,1,2 → columns

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
  selBlock.innerHTML = ld.levels.map((lv, i) =>
    '<div class="addr-field">' +
      '<label class="addr-lbl">' + esc(lv.name) + '</label>' +
      '<select class="addr-input loc-select" id="locsel-' + esc(lv.id) + '" onchange="onLocSelect(' + i + ')"></select>' +
    '</div>'
  ).join('');
  for (let i = 0; i < ld.levels.length; i++) {
    _fillLocSelect(i, _editLocNames ? (_editLocNames[i] || '') : '');
  }
}

function _fillLocSelect(i, preselectName) {
  const ld = DB.getLocDict();
  const lv = ld.levels[i];
  if (!lv) return;
  const sel = document.getElementById('locsel-' + lv.id);
  if (!sel) return;
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
      esc(it.name) + (it.code ? ' (' + esc(it.code) + ')' : '') + '</option>').join('');
  if (preselectName) {
    const match = items.find(it => it.name === preselectName);
    if (match) sel.value = match.id;
  }
  _writeLocInput(i);
}

function _writeLocInput(i) {
  const ld  = DB.getLocDict();
  const lv  = ld.levels[i];
  const inp = document.getElementById(_LOC_INPUTS[i]);
  if (!lv || !inp) return;
  const sel = document.getElementById('locsel-' + lv.id);
  const it  = sel && ld.items.find(x => x.id === sel.value);
  inp.value = it ? it.name : '';
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
  document.getElementById('gf-name').value          = '';
  document.getElementById('gf-site-code').value     = '';
  document.getElementById('gf-province-code').value = '';
  document.getElementById('gf-date').value          = '';
  document.getElementById('gf-route').value         = '';
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

// ── EXPORT CSV ────────────────────────────────────────────────────
// Safe download filename: keep Unicode letters (Lao/Thai/…), strip only the
// characters a filesystem rejects, and fall back when nothing usable remains.
function _safeFile(name, fallback) {
  let s = (name == null ? '' : String(name)).trim()
    .replace(/[\/\\:*?"<>|\x00-\x1f]+/g, '_')   // illegal FS chars → _
    .replace(/\s+/g, ' ')
    .replace(/_{2,}/g, '_')
    .replace(/^[_\s]+|[_\s]+$/g, '');
  return s || fallback || 'export';
}

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
  a.download = _safeFile(g && g.name, 'workers') + '.csv';
  a.click();
}

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

function openExportDialog(scope, uid) {
  _exportCtx = { scope, uid: uid || null };
  const g  = DB.getGroup(activeGroupId);
  const ws = scope === 'worker'
    ? (g ? g.workers.filter(x => x.uid === (uid || _currentViewUid)) : [])
    : (tableFiltered.length ? tableFiltered : DB.getWorkers(activeGroupId));

  const subjEl = document.getElementById('export-subject');
  if (scope === 'worker') {
    const w = ws[0];
    subjEl.textContent = w ? (w.en_name || w.lo_name || 'Worker') : 'Worker';
  } else {
    subjEl.textContent = (g ? g.name : '') + (ws.length ? ' · ' + ws.length + ' ' + bi('ຄົນ','people','คน','명') : '');
  }

  // detail-pdf only makes sense for single worker
  const detBtn = document.querySelector('.export-opt[data-fmt="detail-pdf"]');
  if (detBtn) detBtn.style.display = scope === 'worker' ? '' : 'none';
  // the full-database bundle is a whole-group export only
  const kdbBtn = document.querySelector('.export-opt[data-fmt="kdb"]');
  if (kdbBtn) kdbBtn.style.display = scope === 'worker' ? 'none' : '';

  // reset + default selection (honours Settings → Data & Backup default)
  document.querySelectorAll('.export-opt').forEach(el => el.classList.remove('sel'));
  let defFmt = DB.getSetting('export_default', 'kd-pdf');
  if (scope !== 'worker' && defFmt === 'detail-pdf') defFmt = 'kd-pdf';
  let defEl = document.querySelector('.export-opt[data-fmt="' + defFmt + '"]');
  if (!defEl) defEl = document.querySelector('.export-opt[data-fmt="kd-pdf"]');
  if (defEl) defEl.classList.add('sel');

  _updateCsvFieldsVis();
  _renderExportFields();
  openOverlay('export-overlay');
}

function toggleExportFmt(el) {
  el.classList.toggle('sel');
  _updateCsvFieldsVis();
}

function _updateCsvFieldsVis() {
  const on = !!document.querySelector('.export-opt[data-fmt="csv"].sel');
  document.getElementById('export-csv-fields').style.display = on ? '' : 'none';
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

async function doExport() {
  const fmts = [...document.querySelectorAll('.export-opt.sel')].map(el => el.dataset.fmt);
  if (!fmts.length) { toast(bi('ກະລຸນາເລືອກຢ່າງໜ້ອຍ 1 ຮູບແບບ','Please select at least 1 format','โปรดเลือกอย่างน้อย 1 รูปแบบ','형식을 1개 이상 선택하세요'), 'warn'); return; }

  closeOverlay('export-overlay');
  await new Promise(r => setTimeout(r, 150));

  const scope = _exportCtx.scope;
  const g = DB.getGroup(activeGroupId);
  let workers;
  if (scope === 'worker') {
    const uid = _exportCtx.uid || _currentViewUid;
    workers = g ? g.workers.filter(x => x.uid === uid) : [];
  } else {
    workers = tableFiltered.length ? tableFiltered : DB.getWorkers(activeGroupId);
  }
  // The .kdb bundle always exports the COMPLETE group (never the filtered view),
  // so it can run even when the current search/filter shows nothing.
  if (!workers.length && !fmts.includes('kdb')) { toast(bi('ບໍ່ມີຂໍ້ມູນ','No data','ไม่มีข้อมูล','데이터 없음'), 'warn'); return; }

  for (const fmt of fmts) {
    if      (fmt === 'detail-pdf') { exportWorkerPDF(); await new Promise(r => setTimeout(r, 200)); }
    else if (fmt === 'kd-pdf')     _doKdCardPdf(workers, g);
    else if (fmt === 'kd-png')     await _doKdCardPng(workers, g);
    else if (fmt === 'pptx')       await _doKdCardPptx(workers, g);
    else if (fmt === 'csv')        _doExportCsv(workers, g);
    else if (fmt === 'docs')       await _doExportDocs(workers);
    else if (fmt === 'kdb')        await _doDatabaseBundle(g);
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
  if (!window.html2canvas) { toast(bi('html2canvas ບໍ່ໄດ້ໂຫລດ','html2canvas not loaded','html2canvas ยังไม่โหลด','html2canvas가 로드되지 않음'), 'warn'); return; }
  const showProg = workers.length > 3;
  if (showProg) _progressShow(bi('ກຳລັງສ້າງຮູບ KD Card', 'Creating KD Card image', 'กำลังสร้างรูป KD Card', 'KD 카드 이미지 생성 중'));
  try {
  for (let i = 0; i < workers.length; i++) {
    const w = workers[i];
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-999;background:#fff;padding:8px;width:340px;';
    wrap.innerHTML = _renderKdCard(w, g);
    document.body.appendChild(wrap);
    try {
      const canvas = await html2canvas(wrap, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = _safeFile(w.en_name || w.lo_name, 'worker') + '_kd_card.png';
      a.click();
      URL.revokeObjectURL(url);
      if (showProg) _progressSet((i + 1) / workers.length * 100, (i + 1) + '/' + workers.length);
      if (workers.length > 1) await new Promise(r => setTimeout(r, 400));
    } finally {
      document.body.removeChild(wrap);
    }
  }
  } finally { if (showProg) _progressDone(); }
}

function _doExportCsv(workers, g) {
  const selFields = [];
  _EXPORT_FIELDS.forEach(grp => {
    grp.fields.forEach(f => {
      const el = document.querySelector('#export-field-list input[name="ef-' + f.key + '"]');
      if (el && el.checked) selFields.push(f);
    });
  });
  if (!selFields.length) { toast(bi('ກະລຸນາເລືອກ field ຢ່າງໜ້ອຍ 1 ອັນ','Please select at least 1 field','โปรดเลือกฟิลด์อย่างน้อย 1 ช่อง','항목을 1개 이상 선택하세요'), 'warn'); return; }
  const gName = g ? g.name : '';
  const rows = workers.map(w => selFields.map(f => {
    let v = '';
    if (f.key === 'age')        v = calcAge(w.dob) || '';
    else if (f.key === 'group_name') v = gName;
    else                        v = w[f.key] || '';
    return '"' + v.toString().replace(/"/g, '""') + '"';
  }).join(','));
  const csv = '﻿' + [selFields.map(f => f.label).join(','), ...rows].join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = _safeFile(gName, 'workers') + '.csv';
  a.click();
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
  const url = URL.createObjectURL(content);
  const a = document.createElement('a');
  a.href = url;
  a.download = _safeFile((DB.getGroup(activeGroupId) || {}).name, 'workers') + '_docs.zip';
  a.click();
  URL.revokeObjectURL(url);
  } catch (e) {
    toast('Export failed: ' + (e && e.message || e), 'warn');
  } finally {
    _progressDone();
  }
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
function _paint() { return new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))); }

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

  const _extFor = (p, mime) => {
    const m = (p || '').match(/\.([a-z0-9]+)(?:[?#].*)?$/i);
    if (m) return m[1].toLowerCase();
    if (/png/.test(mime))  return 'png';
    if (/webp/.test(mime)) return 'webp';
    if (/pdf/.test(mime))  return 'pdf';
    return 'jpg';
  };
  // Fetch a /uploads path (or data: URL) → raw bytes, or null if unavailable.
  const _grab = async (src) => {
    if (!src) return null;
    try {
      const resp = await fetch(src);
      if (!resp.ok) return null;
      const blob = await resp.blob();
      return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || '' };
    } catch (e) { return null; }
  };

  const zip = new JSZip();
  const media = zip.folder('media');
  const out = [];
  let nPhotos = 0, nDocs = 0;

  for (let wi = 0; wi < workers.length; wi++) {
    const w = workers[wi];
    const rec = { ...w };
    delete rec.photo; delete rec.photo_orig; delete rec.documents;

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
  const url = URL.createObjectURL(content);
  const a = document.createElement('a');
  a.href = url;
  a.download = _safeFile(g.name, 'database') + '.kdb';
  a.click();
  URL.revokeObjectURL(url);
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
// One KD card per slide. Each card is rasterised with html2canvas (same path as
// the PNG export) and packed into a minimal-but-valid OOXML package via JSZip —
// no external pptx library required. Output opens cleanly in PowerPoint / Google
// Slides / Keynote with one editable picture per slide.
const _PPTX_W = 12192000, _PPTX_H = 6858000;            // 16:9 slide (EMU)
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

async function _buildPptx(slides) {
  const n = slides.length;
  const zip = new JSZip();

  // [Content_Types].xml
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

  // slides + media
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

async function _doKdCardPptx(workers, g) {
  if (!window.html2canvas) { toast(bi('html2canvas ບໍ່ໄດ້ໂຫລດ','html2canvas not loaded','html2canvas ยังไม่โหลด','html2canvas가 로드되지 않음'), 'warn'); return; }
  if (!window.JSZip)       { toast(bi('JSZip ບໍ່ໄດ້ໂຫລດ','JSZip not loaded','JSZip ยังไม่โหลด','JSZip가 로드되지 않음'), 'warn'); return; }
  _progressShow(bi('ກຳລັງສ້າງ PowerPoint', 'Creating PowerPoint', 'กำลังสร้าง PowerPoint', 'PowerPoint 생성 중'));
  try {
  const slides = [];
  for (let i = 0; i < workers.length; i++) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-999;background:#fff;padding:8px;width:340px;';
    wrap.innerHTML = _renderKdCard(workers[i], g);
    document.body.appendChild(wrap);
    try {
      const canvas = await html2canvas(wrap, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
      slides.push({ b64: canvas.toDataURL('image/png').split(',')[1], w: canvas.width, h: canvas.height });
    } finally {
      document.body.removeChild(wrap);
    }
    _progressSet((i + 1) / workers.length * 90, bi('ສ້າງສະໄລ້ ', 'Creating slide ', 'สร้างสไลด์ ', '슬라이드 생성 중 ') + (i + 1) + '/' + workers.length);
    await _paint();
  }
  if (!slides.length) { toast(bi('ບໍ່ມີຂໍ້ມູນ','No data','ไม่มีข้อมูล','데이터 없음'), 'warn'); return; }
  _progressSet(95, bi('ປະກອບໄຟລ໌...', 'Assembling file…', 'ประกอบไฟล์...', '파일 조합 중…'));
  const blob = await _buildPptx(slides);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = _safeFile(g && g.name, 'workers') + '.pptx';
  a.click();
  URL.revokeObjectURL(url);
  toast('PowerPoint ✓', 'ok');
  } catch (e) {
    toast('Export failed: ' + (e && e.message || e), 'warn');
  } finally {
    _progressDone();
  }
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

// ── SETTINGS (all users — admin sees Cities+Users tabs, viewer sees Appearance only) ──
const _SET_TABS = ['appearance','company','cities','documents','notifications','data','users','about'];
let _currentSetTab = 'appearance';

function openSettings() {
  renderSettings();
  const search = document.getElementById('settings-search-input');
  if (search) search.value = '';
  switchSettingsTab('appearance');
  openOverlay('settings-overlay');
}

function switchSettingsTab(tab) {
  _currentSetTab = tab;
  document.querySelectorAll('.set-nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  _SET_TABS.forEach(t2 => {
    const p = document.getElementById('set-pane-' + t2);
    if (p) p.style.display = (t2 === tab) ? 'block' : 'none';
  });
}

// Search box in the header — filter sections + rows by keyword (data-kw).
function filterSettings(q) {
  q = (q || '').trim().toLowerCase();
  const navs = document.querySelectorAll('#set-tabs .set-nav-item');
  const rows = document.querySelectorAll('#settings-overlay .set-row');
  if (!q) {
    navs.forEach(n => { n.style.display = ''; });
    rows.forEach(r => { r.style.display = ''; });
    switchSettingsTab(_currentSetTab || 'appearance');
    return;
  }
  let firstShown = null;
  _SET_TABS.forEach(tab => {
    const pane = document.getElementById('set-pane-' + tab);
    const nav  = document.querySelector('.set-nav-item[data-tab="' + tab + '"]');
    if (!pane || !nav) return;
    const adminOnly = nav.classList.contains('admin-only');
    if (adminOnly && !isAdmin()) { nav.style.display = 'none'; pane.style.display = 'none'; return; }
    const navKw = (nav.dataset.kw || '').toLowerCase();
    const headTxt = (pane.querySelector('.ssh-title')?.textContent || '').toLowerCase();
    const sectionMatch = navKw.includes(q) || headTxt.includes(q);
    let anyRow = false;
    pane.querySelectorAll('.set-row').forEach(r => {
      const kw = ((r.dataset.kw || '') + ' ' + (r.textContent || '')).toLowerCase();
      const m = sectionMatch || kw.includes(q);
      r.style.display = m ? '' : 'none';
      if (m) anyRow = true;
    });
    // panes without .set-row (cities/data lists/users/about) match on section only
    const hasRows = pane.querySelector('.set-row');
    const show = sectionMatch || (hasRows ? anyRow : false);
    pane.style.display = show ? 'block' : 'none';
    nav.style.display = show ? '' : 'none';
    nav.classList.toggle('active', false);
    if (show && !firstShown) { firstShown = nav; nav.classList.add('active'); }
  });
}

function renderAppearance() {
  const pref = localStorage.getItem('kd_theme') || 'system';
  document.querySelectorAll('.theme-opt').forEach(b => {
    b.classList.toggle('active', b.dataset.themeVal === pref);
  });
  _syncSetLangDD();
  updateLogoDisplay();
}

// ── Custom language dropdown (Settings → Appearance) ──────────────
const _LANG_NAMES = { en: 'English', th: 'ไทย', lo: 'ລາວ', ko: '한국어' };
function _syncSetLangDD() {
  const cur = (typeof currentLang !== 'undefined' ? currentLang : 'en');
  const lbl = document.getElementById('set-lang-cur');
  if (lbl) lbl.textContent = _LANG_NAMES[cur] || 'English';
  document.querySelectorAll('#set-lang-menu button').forEach(b => b.classList.toggle('on', b.dataset.lang === cur));
}
function toggleSetLangDD(e) {
  if (e) e.stopPropagation();
  const dd = document.getElementById('set-lang-dd');
  if (!dd) return;
  const open = dd.classList.toggle('open');
  document.getElementById('set-lang-btn')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) _syncSetLangDD();
}
function closeSetLangDD() {
  document.getElementById('set-lang-dd')?.classList.remove('open');
  document.getElementById('set-lang-btn')?.setAttribute('aria-expanded', 'false');
}
function setLangFromDD(lang) {
  closeSetLangDD();
  changeLangFromSettings(lang);   // switch + live re-render (renderSettings → _syncSetLangDD)
}

// Language dropdown in Settings → Appearance
function changeLangFromSettings(lang) {
  setLang(lang);
  if (!document.body.classList.contains('authed')) return;
  rebuildFilters(); renderTable(); renderSidebar(); renderSidebarUser(); renderStats();
  if (document.getElementById('dashboard-welcome')?.style.display !== 'none') renderDashboard();
  renderSettings();
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
async function toggleRestoreList() {
  const box = document.getElementById('set-backup-list');
  if (!box) return;
  if (box.style.display !== 'none') { box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = '<div class="set-card-label">' + bi('ກຳລັງໂຫລດ...','Loading…','กำลังโหลด...','불러오는 중…') + '</div>';
  let files = [];
  try { files = await DB.listBackups(); } catch (e) {}
  if (!files.length) { box.innerHTML = '<div class="set-card-label">' + bi('ບໍ່ມີໄຟລ໌ສຳຮອງ','No backups','ไม่มีไฟล์สำรอง','백업 없음') + '</div>'; return; }
  box.innerHTML = '<div class="set-card-label">' + bi('ເລືອກໄຟລ໌ເພື່ອກູ້ຄືນ','Choose a backup','เลือกไฟล์เพื่อกู้คืน','복원할 백업 선택') + '</div>' +
    '<div class="set-card"><div class="set-list" style="padding:5px 10px">' +
    files.map(f => {
      const name = typeof f === 'string' ? f : (f.file || f.name || JSON.stringify(f));
      return '<div class="set-item"><span class="set-name" style="flex:1">' + esc(name) + '</span>' +
        '<button class="btn btn-sm" onclick="doRestore(\'' + esc(name) + '\')">' + bi('ກູ້ຄືນ','Restore','กู้คืน','복원') + '</button></div>';
    }).join('') + '</div></div>';
}
function doRestore(file) {
  showConfirm(bi('ກູ້ຄືນຂໍ້ມູນ','Restore data','กู้คืนข้อมูล','데이터 복원'), bi('ກູ້ຄືນຈາກ ','Restore from ','กู้คืนจาก ','복원: ') + file + bi('? ຂໍ້ມູນປັດຈຸບັນຈະຖືກແທນທີ່.','? Current data will be replaced.','? ข้อมูลปัจจุบันจะถูกแทนที่','? 현재 데이터가 대체됩니다.'), async () => {
    try { await DB.restore(file); toast(bi('ກູ້ຄືນສຳເລັດ','Restored','กู้คืนสำเร็จ','복원됨'), 'ok'); closeOverlay('settings-overlay'); refreshAll(); }
    catch (e) { toast('Restore failed: ' + (e.message || e), 'warn'); }
  });
}
function exportAllData() {
  const data = { exported_at: new Date().toISOString(), groups: DB.getGroups(), cities: DB.getCities(), users: DB.getUsers() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'kd-database-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
}
function confirmHardReset() {
  showConfirm(t('confirm_delete') || 'Reset', bi('ລ້າງຂໍ້ມູນທັງໝົດຖາວອນ? ບໍ່ສາມາດກູ້ຄືນໄດ້ (ນອກຈາກມີສຳຮອງ).','Permanently erase ALL data? Cannot be undone (unless you have a backup).','ล้างข้อมูลทั้งหมดถาวร? ไม่สามารถกู้คืนได้ (นอกจากมีสำรอง)','모든 데이터를 영구 삭제할까요? 되돌릴 수 없습니다 (백업이 없으면).'), () => {
    DB.hardReset();
    setTimeout(() => location.reload(), 400);
  });
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
    [bi('ຜູ້ໃຊ້', 'Users', 'ผู้ใช้', '사용자'), DB.getUsers().length],
  ];
  el.innerHTML = rows.map(([k, v]) =>
    '<div class="set-item"><span class="set-name" style="flex:1">' + k + '</span>' +
    '<span class="set-code">' + v + '</span></div>').join('');
}

function renderSettings() {
  renderAppearance();
  renderAbout();
  if (isAdmin()) {
    renderCompany();
    renderCityList('kr');
    renderCityList('la');
    renderLocDictSettings();
    renderDocCatsSettings();
    renderReqFields();
    renderNotifPrefs();
    renderExportDefault();
    renderUserList();
  }
}

// ── Document categories (Settings → Documents) — admin-configurable ──
function renderDocCatsSettings(editIdx) {
  const el = document.getElementById('set-doccats-list'); if (!el) return;
  const cats = getDocCats();
  el.innerHTML = cats.map((c, i) => {
    if (i === editIdx) {
      return '<div class="set-item set-item-editing">' +
        '<input id="set-doccat-edit-' + i + '" class="set-inline-input" value="' + esc(c.label) + '" ' +
        'onkeydown="if(event.key===\'Enter\')saveDocCat(' + i + ');if(event.key===\'Escape\')renderDocCatsSettings();">' +
        '<button class="set-act set-save" onclick="saveDocCat(' + i + ')" title="Save">&#x2713;</button>' +
        '<button class="set-act set-cancel" onclick="renderDocCatsSettings()" title="Cancel">&#x2715;</button>' +
        '</div>';
    }
    return '<div class="set-item">' +
      '<span class="set-name" style="flex:1">' + esc(c.label) + '</span>' +
      '<button class="set-act set-move" onclick="moveDocCat(' + i + ',-1)" title="' + esc(t('move_up') || 'เลื่อนขึ้น') + '"' + (i === 0 ? ' disabled' : '') + '>&#9650;</button>' +
      '<button class="set-act set-move" onclick="moveDocCat(' + i + ',1)" title="' + esc(t('move_down') || 'เลื่อนลง') + '"' + (i === cats.length - 1 ? ' disabled' : '') + '>&#9660;</button>' +
      '<button class="set-act set-edit" onclick="renderDocCatsSettings(' + i + ')" title="Edit">&#x270E;</button>' +
      (cats.length > 1 ? '<button class="set-act set-del" onclick="delDocCat(' + i + ')" title="Delete">&#x2715;</button>' : '') +
      '</div>';
  }).join('') || '<div class="set-empty">—</div>';
  if (editIdx !== undefined) {
    const inp = document.getElementById('set-doccat-edit-' + editIdx);
    if (inp) { inp.focus(); inp.select(); }
  }
}
// Required-field picker (Settings → Documents): which fields the data-% counts.
function renderReqFields() {
  const el = document.getElementById('set-reqfields-list'); if (!el) return;
  const sel = new Set(getReqFields());
  el.innerHTML = _reqFieldCatalog().map(([key, label]) =>
    '<label class="reqf-item">' +
      '<input type="checkbox"' + (sel.has(key) ? ' checked' : '') + (isAdmin() ? '' : ' disabled') +
        ' onchange="toggleReqField(\'' + key + '\',this.checked)">' +
      '<span>' + esc(label) + '</span>' +
    '</label>'
  ).join('');
}
function toggleReqField(key, on) {
  if (!isAdmin()) return;
  let cur = getReqFields().slice();
  if (on) { if (!cur.includes(key)) cur.push(key); }
  else    { cur = cur.filter(k => k !== key); }
  if (!cur.length) { cur = ['en_name']; renderReqFields(); }   // never empty
  DB.setSetting('req_fields', cur);
}
function _saveDocCats(cats) { DB.setSetting('doc_cats', cats); }
// Reorder a category up/down. The array order IS the display order everywhere
// (detail drawer, export), and it's persisted server-side via doc_cats.
function moveDocCat(i, dir) {
  if (!isAdmin()) return;
  const cats = getDocCats().slice();
  const j = i + dir;
  if (j < 0 || j >= cats.length) return;
  const tmp = cats[i]; cats[i] = cats[j]; cats[j] = tmp;
  _saveDocCats(cats); renderDocCatsSettings();
}
function addDocCat() {
  if (!isAdmin()) return;
  const inp = document.getElementById('set-doccat-name');
  const label = (inp.value || '').trim(); if (!label) return;
  const cats = getDocCats().slice();
  cats.push({ key: 'doc_' + Date.now().toString(36), label });
  _saveDocCats(cats); inp.value = ''; renderDocCatsSettings();
}
function saveDocCat(i) {
  if (!isAdmin()) return;
  const inp = document.getElementById('set-doccat-edit-' + i);
  const label = inp ? inp.value.trim() : '';
  if (!label) return;
  const cats = getDocCats().slice();
  if (!cats[i]) return;
  cats[i] = { ...cats[i], label };
  _saveDocCats(cats); renderDocCatsSettings();
}
function delDocCat(i) {
  if (!isAdmin()) return;
  const cats = getDocCats().slice();
  const c = cats[i]; if (!c) return;
  showConfirm(t('confirm_delete') || 'Delete',
    bi('ລຶບປະເພດເອກະສານ ', 'Remove document type ', 'ลบประเภทเอกสาร ', '문서 유형 제거 ') + '"' + c.label + '"?',
    () => { cats.splice(i, 1); _saveDocCats(cats); renderDocCatsSettings(); });
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
  html += '<div class="locdict-card"><div class="locdict-sub">' +
    esc(bi('ໝວດ (ຊັ້ນ) — ສູງສຸດ 3','Categories (levels) — max 3','หมวด (ชั้น) — สูงสุด 3','범주 (단계) — 최대 3')) + '</div>';
  html += ld.levels.length
    ? ld.levels.map((lv, i) =>
        '<div class="locdict-row">' +
          '<span class="locdict-lvl-no">' + (i + 1) + '</span>' +
          '<input class="locdict-name-in" value="' + esc(lv.name) + '" onchange="locRenameLevel(\'' + lv.id + '\', this.value)">' +
          '<button class="locdict-ic" onclick="locMoveLevel(\'' + lv.id + '\',-1)"' + (i === 0 ? ' disabled' : '') + '>&#9650;</button>' +
          '<button class="locdict-ic" onclick="locMoveLevel(\'' + lv.id + '\',1)"' + (i === ld.levels.length - 1 ? ' disabled' : '') + '>&#9660;</button>' +
          '<button class="locdict-ic danger" onclick="locDelLevel(\'' + lv.id + '\')">&#10005;</button>' +
        '</div>')
      .join('')
    : '<div class="set-empty">—</div>';
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
    html += '<div class="locdict-card"><div class="locdict-sub">' + esc(bi('ລາຍການ','Items','รายการ','항목')) + '</div>';
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
          esc(p.name) + (p.code ? ' (' + esc(p.code) + ')' : '') + '</option>').join('') + '</select></div>';
    }

    if (!parentOk) {
      html += '<div class="set-empty">' + esc(bi('ເພີ່ມລາຍການຊັ້ນເທິງກ່ອນ','Add a parent item first','เพิ่มรายการชั้นบนก่อน','상위 항목을 먼저 추가하세요')) + '</div>';
    } else {
      const items = ld.items.filter(it => it.levelId === lv.id && (_locEditLevel === 0 || it.parentId === _locEditParent)).sort((a, b) => a.order - b.order);
      html += items.length ? items.map((it, idx) =>
        '<div class="locdict-row">' +
          '<span class="set-code">' + esc(it.code || '—') + '</span>' +
          '<span class="set-name" style="flex:1">' + esc(it.name) + '</span>' +
          '<button class="locdict-ic" onclick="locMoveItem(\'' + it.id + '\',-1)"' + (idx === 0 ? ' disabled' : '') + '>&#9650;</button>' +
          '<button class="locdict-ic" onclick="locMoveItem(\'' + it.id + '\',1)"' + (idx === items.length - 1 ? ' disabled' : '') + '>&#9660;</button>' +
          '<button class="locdict-ic danger" onclick="locDelItem(\'' + it.id + '\')">&#10005;</button>' +
        '</div>').join('') : '<div class="set-empty">—</div>';
      html += '<div class="set-add-row" style="margin-top:8px">' +
        '<input id="locdict-item-name" placeholder="' + esc(bi('ຊື່','Name','ชื่อ','이름')) + '">' +
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
  if (!name) return;
  _locMutate(ld => {
    if (ld.levels.length >= 3) return;
    ld.enabled = true;
    ld.levels.push({ id: DB._newLocId(), name, order: ld.levels.length });
  });
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
function locMoveLevel(id, dir) {
  _locMutate(ld => {
    const i = ld.levels.findIndex(l => l.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= ld.levels.length) return;
    const tmp = ld.levels[i]; ld.levels[i] = ld.levels[j]; ld.levels[j] = tmp;
    ld.levels.forEach((l, k) => { l.order = k; });
  });
}
function locSelectEditLevel(i) { _locEditLevel = i; _locEditParent = ''; renderLocDictSettings(); }
function locSelectEditParent(v) { _locEditParent = v; renderLocDictSettings(); }
function locAddItem() {
  const nameEl = document.getElementById('locdict-item-name');
  const codeEl = document.getElementById('locdict-item-code');
  const name = nameEl ? nameEl.value.trim() : '';
  const code = codeEl ? codeEl.value.trim().toUpperCase() : '';
  if (!name) return;
  _locMutate(ld => {
    const lv = ld.levels[_locEditLevel]; if (!lv) return;
    const parentId = _locEditLevel > 0 ? (_locEditParent || null) : null;
    const sibs = ld.items.filter(it => it.levelId === lv.id && it.parentId === parentId).length;
    ld.items.push({ id: DB._newLocId(), levelId: lv.id, parentId, name, code, order: sibs });
  });
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
function locMoveItem(id, dir) {
  _locMutate(ld => {
    const it = ld.items.find(x => x.id === id); if (!it) return;
    const sibs = ld.items.filter(x => x.levelId === it.levelId && x.parentId === it.parentId).sort((a, b) => a.order - b.order);
    const i = sibs.findIndex(x => x.id === id), j = i + dir;
    if (j < 0 || j >= sibs.length) return;
    const o = sibs[i].order; sibs[i].order = sibs[j].order; sibs[j].order = o;
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

const _SVG_SWAP  ='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3l4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16"/></svg>';
const _SVG_KEY   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.5 12.5L20 3M16 7l3 3"/></svg>';
const _SVG_EDIT  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const _SVG_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

function renderUserList() {
  const users = DB.getUsers();
  const el = document.getElementById('set-users-list');
  if (!el) return;
  el.innerHTML = users.map(u => {
    const self = currentUser && u.username === currentUser.username;
    const roleCls = u.role === 'admin' ? 'role-admin' : 'role-viewer';
    const roleLbl = t(u.role === 'admin' ? 'role_admin' : 'role_viewer');
    const initial = esc((u.name || u.username || '?').trim().charAt(0).toUpperCase());
    const uesc = esc(u.username);
    return '<div class="set-user-row">' +
      '<div class="set-user-av">' + initial + '</div>' +
      '<div class="set-user-info">' +
        '<div class="set-user-name">' + esc(u.name || u.username) + (self ? ' <span class="set-user-sub">(' + bi('ທ່ານ','you','คุณ','나') + ')</span>' : '') + '</div>' +
        '<div class="set-user-sub">@' + uesc + ' · <span class="role-badge ' + roleCls + '">' + roleLbl + '</span></div>' +
      '</div>' +
      '<div class="set-user-actions">' +
        '<button class="set-icon-btn" title="' + esc(bi('ປ່ຽນບົດບາດ','Change role','เปลี่ยนบทบาท','역할 변경')) + '" onclick="toggleUserRole(\'' + uesc + '\')">' + _SVG_SWAP + '</button>' +
        '<button class="set-icon-btn" title="' + esc(bi('ຣີເຊັດລະຫັດ','Reset password','รีเซ็ตรหัสผ่าน','비밀번호 재설정')) + '" onclick="resetUserPw(\'' + uesc + '\')">' + _SVG_KEY + '</button>' +
        '<button class="set-icon-btn" title="' + esc(bi('ແກ້ໄຂຊື່','Rename','เปลี่ยนชื่อ','이름 변경')) + '" onclick="renameUser(\'' + uesc + '\')">' + _SVG_EDIT + '</button>' +
        (self ? '' : '<button class="set-icon-btn danger" title="' + esc(bi('ລຶບ','Delete','ลบ','삭제')) + '" onclick="delUser(\'' + uesc + '\')">' + _SVG_TRASH + '</button>') +
      '</div>' +
    '</div>';
  }).join('');
}

function toggleUserRole(username) {
  if (!isAdmin()) return;
  const u = DB.getUsers().find(x => x.username === username);
  if (!u) return;
  const newRole = u.role === 'admin' ? 'viewer' : 'admin';
  const res = DB.updateUser(username, { role: newRole });
  if (res === 'last-admin') { alert(t('set_last_admin') || bi('ຕ້ອງມີ admin ຢ່າງໜ້ອຍ 1 ຄົນ','At least 1 admin is required','ต้องมีแอดมินอย่างน้อย 1 คน','관리자가 최소 1명 필요합니다')); return; }
  renderUserList();
}
function resetUserPw(username) {
  if (!isAdmin()) return;
  const pw = prompt(bi('ລະຫັດຜ່ານໃໝ່ສຳລັບ @','New password for @','รหัสผ่านใหม่สำหรับ @','새 비밀번호 (@') + username + bi(' · New password:','',' · รหัสผ่านใหม่:','):'));
  if (pw == null || pw === '') return;
  DB.updateUser(username, { password: pw });
  toast(bi('ປ່ຽນລະຫັດຜ່ານແລ້ວ','Password reset','เปลี่ยนรหัสผ่านแล้ว','비밀번호가 재설정됨'), 'ok');
}
function renameUser(username) {
  if (!isAdmin()) return;
  const u = DB.getUsers().find(x => x.username === username);
  const name = prompt(bi('ຊື່ສະແດງ · Display name:','Display name:','ชื่อที่แสดง:','표시 이름:'), u ? (u.name || '') : '');
  if (name == null) return;
  DB.updateUser(username, { name });
  renderUserList();
  if (typeof renderSidebarUser === 'function') renderSidebarUser();
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
