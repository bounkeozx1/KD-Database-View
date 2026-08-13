/**
 * db.js — Data Layer (SQLite-backed, server-only)
 *
 * ฐานข้อมูลหลักคือ SQLite ผ่าน Node.js backend เท่านั้น
 * ไม่มี local fallback — ถ้า server ไม่รัน init() จะ throw
 *
 * Session/สิทธิ์: ไม่เก็บใน localStorage อีกต่อไป — login ด้วย username +
 * password แล้ว server จะออก session cookie (HttpOnly) ให้ ส่วน role อ่านจาก
 * server ทุกครั้ง (bootstrap.me) ดังนั้นแก้ฝั่ง browser ให้เป็น admin ไม่ได้
 */

// Legacy key — kept only so an old client-side "session" gets wiped on load.
const SESSION_KEY = 'kd_session';

const DB = (() => {
  const _clone = x => JSON.parse(JSON.stringify(x));
  let _data = { groups: [], cities: { kr: [], la: [] }, users: [] };

  // The signed-in user, as the SERVER reports it (never a client-side claim).
  let _me = null;

  /* format → permission, as the SERVER defines it. The browser used to keep its
   * own transcription of this table; sending it means the UI can never offer a
   * format the server will refuse, nor hide one the account is entitled to. */
  let _exportPerms = {};

  // Old builds cached {username, role} here and trusted it — that let anyone
  // hand themselves an admin session. Remove it on sight.
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}

  // Who is making this change. Only used for optimistic UI: the server stamps
  // the activity log from the session, so this can't be spoofed either.
  const _who = () => (_me && _me.username) || '';

  /* ── Session lost (expired / signed out elsewhere) ── */
  let _authLostCb = null;
  let _authLostFired = false;
  // Why the session ended, from the server's 401 body: idle-timeout |
  // absolute-lifetime | session-expired | unknown-session | no-token.
  let _authLostReason = '';
  // A step the account owes before the app will open (see init()).
  let _pendingStep = '';
  const _onLoginPage = () => /login\.html$/i.test(location.pathname);
  function _authLost(reason) {
    _me = null;
    _authLostReason = reason || '';
    if (_authLostFired || _onLoginPage()) return;
    _authLostFired = true;
    // Survives the navigation so login.html can explain what happened; the
    // reason is not sensitive (the user just experienced it).
    try { if (reason) sessionStorage.setItem('kd_auth_lost', reason); } catch (e) {}
    if (typeof _authLostCb === 'function') { try { _authLostCb(reason); return; } catch (e) {} }
    location.replace('login.html');
  }

  /* ── CSRF (P2) ─────────────────────────────────────────────────────
   * The server rejects every POST/PUT/PATCH/DELETE that does not echo the
   * session's CSRF token in X-CSRF-Token. The token lives in the kd_csrf cookie
   * (readable by design — it is not a credential), so it is read from there and
   * survives page reloads without extra state. If it is missing (first visit,
   * before any login) one round-trip to /api/csrf mints it. */
  let _csrf = '';
  function _readCsrfCookie() {
    const m = /(?:^|;\s*)kd_csrf=([^;]*)/.exec(document.cookie || '');
    return m ? decodeURIComponent(m[1]) : '';
  }
  async function _csrfToken() {
    const fromCookie = _readCsrfCookie();
    if (fromCookie) { _csrf = fromCookie; return _csrf; }
    if (_csrf) return _csrf;
    try {
      const r = await fetch('/api/csrf', { credentials: 'same-origin' });
      const j = await r.json();
      _csrf = (j && j.csrfToken) || '';
    } catch (e) { _csrf = ''; }
    return _csrf;
  }
  const _STATE_CHANGING = { POST: 1, PUT: 1, PATCH: 1, DELETE: 1 };

  /* ── API helper ── */
  async function _api(method, path, body, _retried) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (_STATE_CHANGING[method]) headers['X-CSRF-Token'] = await _csrfToken();

      const res = await fetch('/api' + path, {
        method,
        signal: ctrl.signal,
        credentials: 'same-origin',      // carries the HttpOnly session cookie
        headers: Object.keys(headers).length ? headers : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      // Login rotates the CSRF secret; pick the new one up immediately so the
      // next write doesn't fail with a stale token.
      if (_STATE_CHANGING[method]) { const c = _readCsrfCookie(); if (c) _csrf = c; }
      clearTimeout(timer);
      if (!res.ok) {
        const err = new Error('API ' + res.status);
        err.status = res.status;
        try { err.body = await res.json(); } catch (e) {}

        /* A stale CSRF token is recoverable and must not become a dead end:
         * without this, a server restart or a session rotated on another tab
         * would break every write until the user manually reloaded. Re-mint once
         * and retry — but only once, and only for this specific failure, so a
         * genuine cross-site attempt still gets a hard 403. */
        if (res.status === 403 && err.body && err.body.error === 'csrf-failed' && !_retried) {
          _retried = true;
          _csrf = '';
          try {
            const r2 = await fetch('/api/csrf', { credentials: 'same-origin' });
            const j2 = await r2.json();
            _csrf = (j2 && j2.csrfToken) || '';
          } catch (e2) {}
          if (_csrf) return _api(method, path, body, true);
        }

        // 401 = no/expired session. Bounce to the sign-in page (except on the
        // sign-in page itself, and except a rejected login attempt).
        if (res.status === 401 && path !== '/login') _authLost(err.body && err.body.reason);
        throw err;
      }
      return res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  /* ── Durable write queue ──────────────────────────────────────────
   * Cache อัพเดต synchronous → UI ไม่สะดุด
   * write จริงถูกส่งเป็น series ผ่าน queue พร้อม retry
   * ถ้า retry เกิน 10 ครั้ง → ข้าม job นั้น (server error ถาวร)     */
  let _statusCb = null;
  let _queue    = Promise.resolve();
  let _pending  = 0;
  let _failed   = 0;

  function _emit(event, detail) {
    if (typeof _statusCb !== 'function') return;
    try { _statusCb({ event: event || 'idle', pending: _pending, failed: _failed, mode: 'api', detail: detail || '' }); }
    catch (e) {}
  }

  function _push(method, path, body) {
    _pending++;
    _emit('saving');
    const job = async () => {
      let attempts = 0;
      for (;;) {
        try {
          await _api(method, path, body);
          _pending--;
          if (attempts > 0) _failed = Math.max(0, _failed - 1);
          _emit(_pending === 0 && _failed === 0 ? 'saved' : 'saving');
          return;
        } catch (e) {
          // Not a transient failure: the session is gone (401) or this account
          // is read-only (403). Retrying can never succeed — drop the job.
          if (e && (e.status === 401 || e.status === 403)) {
            _pending--;
            _emit('error', (e.status === 403 ? 'No permission (read-only account): ' : 'Signed out: ') + method + ' ' + path);
            throw new Error(e.status === 403 ? 'forbidden' : 'signed-out');
          }
          attempts++;
          if (attempts === 1) _failed++;
          console.warn('[DB] retry', attempts, method, path, e && e.message);
          _emit('error', (e && e.message || String(e)) + ' — retry ' + method + ' ' + path);
          if (attempts >= 10) {
            _pending--;
            _emit('error', 'Dropped (max retry): ' + method + ' ' + path);
            throw new Error('max-retries');
          }
          const wait = Math.min(15000, 1000 * Math.pow(2, Math.min(attempts, 4)));
          await new Promise(r => setTimeout(r, wait));
        }
      }
    };
    const p = _queue.then(job);
    // advance chain ไม่ว่า job จะสำเร็จหรือไม่ (prevent stuck queue)
    _queue = p.then(() => {}, () => {});
    // A dropped job (403 / signed out / max retries) is already reported through
    // _emit('error'); mark it handled so it isn't ALSO an unhandled rejection.
    p.catch(() => {});
    return p;
  }

  function _normalize(d) {
    if (!d || typeof d !== 'object') return { groups: [], cities: { kr: [], la: [] }, users: [] };
    if (!Array.isArray(d.groups))    d.groups = [];
    if (!d.cities || typeof d.cities !== 'object') d.cities = { kr: [], la: [] };
    if (!Array.isArray(d.cities.kr)) d.cities.kr = [];
    if (!Array.isArray(d.cities.la)) d.cities.la = [];
    if (!Array.isArray(d.users))     d.users = [];
    if (!d.settings || typeof d.settings !== 'object') d.settings = {};
    d.groups.forEach(g => { if (!Array.isArray(g.workers)) g.workers = []; });
    return d;
  }

  function _allWorkers() {
    const out = [];
    _data.groups.forEach(g => (g.workers || []).forEach(w => out.push(w)));
    return out;
  }
  function _parseDate(s) {
    if (!s) return null;
    const p = s.replace(/-/g, '/').split('/');
    return p.length < 3 ? null : new Date(+p[2], +p[1] - 1, +p[0]);
  }
  const _newGroupId = () => 'g-' + Date.now().toString(36);
  const _newUid     = () => 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const _newLocId   = () => 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  /* ── Location Dictionary (hierarchical, stored in app_settings) ──
   * Up to 3 levels (e.g. Province → District → Village). Each item carries a
   * short code + optional parent link. Kept additive & fully removable:
   * clearing the setting restores the original behaviour.                 */
  // Which employee column each level fills. A level's `col` is bound explicitly
  // and NOT derived from its position: the array index used to decide this, so
  // reordering or deleting a level silently re-pointed it at another column —
  // e.g. dragging Village to the top made village names save as the province.
  const LOC_COLS = ['province', 'district', 'village'];

  function _normalizeLocDict(d) {
    d = (d && typeof d === 'object') ? d : {};
    const levels = (Array.isArray(d.levels) ? d.levels : []).slice(0, 3).map((l, i) => ({
      id:    l && l.id ? String(l.id) : _newLocId(),
      name:  String((l && l.name) || '').trim() || ('Level ' + (i + 1)),
      order: typeof (l && l.order) === 'number' ? l.order : i,
      // Legacy dicts have no `col` — fall back to the old positional meaning so
      // they keep working, then it stays pinned to that column from now on.
      col:   (l && LOC_COLS.includes(l.col)) ? l.col : LOC_COLS[i],
    })).sort((a, b) => a.order - b.order).map((l, i) => ({ ...l, order: i }));
    const levelIds = new Set(levels.map(l => l.id));
    const items = (Array.isArray(d.items) ? d.items : [])
      .filter(it => it && levelIds.has(it.levelId))
      .map((it, i) => {
        // Multilingual names; migrate the old single `name` → names.en.
        const src = (it.names && typeof it.names === 'object') ? it.names : { en: it.name };
        const names = {
          en: String(src.en || '').trim(),
          lo: String(src.lo || '').trim(),
          th: String(src.th || '').trim(),
          ko: String(src.ko || '').trim(),
        };
        if (!names.en) names.en = names.lo || names.th || names.ko || '';   // English is canonical
        return {
          id:       it.id ? String(it.id) : _newLocId(),
          levelId:  String(it.levelId),
          parentId: it.parentId ? String(it.parentId) : null,
          names,
          code:     String(it.code || '').trim().toUpperCase(),
          order:    typeof it.order === 'number' ? it.order : i,
        };
      });
    const ic = (d.idConfig && typeof d.idConfig === 'object') ? d.idConfig : {};
    return {
      enabled: !!d.enabled && levels.length > 0,
      levels, items,
      idConfig: {
        source:   ic.source || 'la',                                       // 'la' | levelId
        seqPad:   Math.min(6, Math.max(1, parseInt(ic.seqPad,  10) || 3)),
        seqStart: Math.max(1, parseInt(ic.seqStart, 10) || 1),
      },
    };
  }

  /* ── Default seed: Lao administrative hierarchy (18 provinces + districts) ──
   * Seeded into the Location Dictionary on a fresh install so the address
   * dropdowns work out of the box. English is the canonical stored/displayed
   * name; province Lao names are included, districts fall back to English.
   * The Village level is defined but left EMPTY on purpose — the worker form
   * renders an empty level as a free-text field, so villages stay typed.
   * [code, EN, LO, [districts…]] — a district is 'EN' or ['EN','LO'].
   * Lao district spellings are added where existing records already use them,
   * so those records match the dictionary instead of falling back to raw text. */
  const _LAO_PROVINCES = [
    ['VTE','Vientiane Capital','ນະຄອນຫຼວງວຽງຈັນ', ['Chanthabouly','Sikhottabong','Xaysetha','Sisattanak','Naxaithong','Xaythany','Hadxaifong','Sangthong','Pak Ngum']],
    ['PSL','Phongsaly','ຜົ້ງສາລີ', ['Phongsaly','May','Khua','Samphanh','Boun Neua','Nhot Ou','Boun Tay']],
    ['LNT','Luang Namtha','ຫຼວງນ້ຳທາ', ['Namtha','Sing','Long','Viengphoukha','Nalae']],
    ['ODX','Oudomxay','ອຸດົມໄຊ', ['Xay','La','Namor','Nga','Beng','Houn','Pakbeng']],
    ['BKO','Bokeo','ບໍ່ແກ້ວ', ['Houayxay','Tonpheung','Meung','Pha Oudom','Paktha']],
    ['LPB','Luang Prabang','ຫຼວງພະບາງ', ['Luang Prabang','Xieng Ngeun','Nan','Pak Ou','Nambak','Ngoi','Pakxeng','Phonxay','Chomphet','Viengkham','Phoukhoune','Phonthong']],
    ['HOU','Houaphanh','ຫົວພັນ', ['Xamneua','Xiengkhor','Viengthong','Viengxay','Huameuang','Xamtai','Sopbao','Et','Kuan','Sone']],
    ['XAY','Xayaboury','ໄຊຍະບູລີ', ['Xayabouly','Khop','Hongsa','Ngeun','Xienghone',['Phiang','ພຽງ'],['Paklai','ປາກລາຍ'],'Kenethao','Botene',['Thongmyxay','ທົ່ງມີໄຊ'],'Xaysathan']],
    ['XIE','Xiengkhuang','ຊຽງຂວາງ', ['Pek','Kham','Nonghet','Khoune','Mokmay','Phoukoud','Phaxay']],
    ['VTP','Vientiane Province','ວຽງຈັນ', ['Phonhong',['Thoulakhom','ທຸລະຄົມ'],'Keo Oudom','Kasi','Vangvieng','Feuang','Xanakham','Mad','Viengkham','Hinheup','Meun']],
    ['BLX','Bolikhamxay','ບໍລິຄຳໄຊ', ['Pakxan','Thaphabat','Pakkading','Borikhan','Khamkeut','Viengthong','Xaychamphone']],
    ['KHM','Khammouane','ຄຳມ່ວນ', ['Thakhek','Mahaxay','Nongbok','Hinboun','Nhommalath','Bualapha','Nakai','Xebangfay','Xaybuathong','Kounkham']],
    ['SAV','Savannakhet','ສະຫວັນນະເຂດ', ['Kaysone Phomvihane','Outhoumphone','Atsaphangthong','Phin','Sepon','Nong','Thapangthong','Songkhone','Champhone','Xonbouly','Xayphoothong','Vilabouly','Atsaphone','Xaybouly','Phalanxay']],
    ['SAL','Saravane','ສາລະວັນ', ['Saravane','Ta Oy','Toumlan','Lakhonepheng','Vapy','Khongxedon','Lao Ngam','Samouay']],
    ['SEK','Sekong','ເຊກອງ', ['Lamam','Kaleum','Dakcheung','Thateng']],
    ['CHA','Champasak','ຈຳປາສັກ', ['Pakse','Sanasomboun','Bachiangchaleunsook','Paksong','Pathoumphone','Phonthong','Champasak','Sukhuma','Mounlapamok','Khong']],
    ['ATT','Attapeu','ອັດຕະປື', ['Samakkhixay','Saysettha','Sanamxay','Sanxay','Phouvong']],
    ['XSB','Xaisomboun','ໄຊສົມບູນ', ['Anouvong','Longcheng','Hom','Thathom','Longxan']],
  ];
  // District codes feed the auto worker_id (CODE-YY-NNN). These three are pinned
  // to the prefixes the existing records already use — changing them would
  // restart the running sequence and mint ids that collide with history.
  const _DIST_CODE_PINS = { 'Thoulakhom': 'TLK', 'Phiang': 'PHI', 'Paklai': 'PL' };

  // Derive a short, unique-across-the-dictionary code from an English name.
  // A pinned name returns its pin unconditionally: every pin is reserved in
  // `taken` before generation starts, so nothing else can have claimed it, and
  // checking `taken` here would only make the pin collide with itself.
  function _distCode(en, taken) {
    if (_DIST_CODE_PINS[en]) return _DIST_CODE_PINS[en];
    const base = en.replace(/[^A-Za-z]/g, '').toUpperCase();
    const tries = [
      base.slice(0, 3),                                   // Phonhong -> PHO
      base.replace(/[AEIOU]/g, '').slice(0, 3),           // ...then drop vowels -> PHN
      base.slice(0, 2) + base.slice(-1),                  // ...then first two + last
    ];
    for (const c of tries) if (c.length >= 2 && !taken.has(c)) return c;
    for (let i = 3; i < base.length; i++) {               // ...then walk the letters
      const c = base.slice(0, 2) + base[i];
      if (!taken.has(c)) return c;
    }
    for (let n = 1; n < 100; n++) {                       // ...finally give up and number it
      const c = base.slice(0, 2) + n;
      if (!taken.has(c)) return c;
    }
    return base.slice(0, 3);
  }

  function _defaultLocDict() {
    const PROV = 'LV-PROV', DIST = 'LV-DIST', VILL = 'LV-VILL';
    const items = [];
    const taken = new Set(Object.values(_DIST_CODE_PINS));   // reserve the pins up front
    _LAO_PROVINCES.forEach(([code, en, lo, dists], pi) => {
      const pid = 'P-' + code;
      items.push({ id: pid, levelId: PROV, parentId: null, names: { en, lo, th: '', ko: '' }, code, order: pi });
      dists.forEach((d, di) => {
        const den = Array.isArray(d) ? d[0] : d;
        const dlo = Array.isArray(d) ? (d[1] || '') : '';
        const dcode = _distCode(den, taken);
        taken.add(dcode);
        items.push({
          id: 'D-' + code + '-' + String(di + 1).padStart(2, '0'),
          levelId: DIST, parentId: pid,
          names: { en: den, lo: dlo, th: '', ko: '' }, code: dcode, order: di,
        });
      });
    });
    return {
      enabled: true,
      levels: [
        { id: PROV, name: 'Province', order: 0, col: 'province' },
        { id: DIST, name: 'District', order: 1, col: 'district' },
        { id: VILL, name: 'Village',  order: 2, col: 'village'  },
      ],
      items,
      // The id comes from the selected District, not from `la` (the Lao-city
      // dictionary). `la` was the old default and it never worked here: la_city
      // is empty on every record, and the four cities it offers are not ones
      // this agency recruits from — so _idSourceCode returned '' and the auto id
      // silently did nothing, leaving every worker_id typed by hand.
      idConfig: { source: DIST, seqPad: 3, seqStart: 1 },
    };
  }

  return {

    _newLocId,

    /* ── Boot ── */
    async init() {
      // throws ถ้า server ไม่ตอบ → caller จัดการ error
      // 401 (ยังไม่ login) ไม่ throw — คืนค่าว่างแล้วให้ caller พาไปหน้า login
      try {
        const r = await _api('GET', '/bootstrap');
        _data = _normalize(r.data);
        _me   = r.me || null;
        _exportPerms = (r.exportPermissions && typeof r.exportPermissions === 'object')
          ? r.exportPermissions : {};
        _pendingStep = '';
      } catch (e) {
        if (e && e.status === 401) { _me = null; _data = _normalize(null); _pendingStep = ''; return; }

        /* 403 with a known reason is NOT a broken server — the session is
         * perfectly valid, but the account owes a step before the app opens
         * (set a real password, or enrol a second factor). Rethrowing here made
         * app.js show "Server ไม่ตอบสนอง", which is both wrong and a dead end:
         * the screens that resolve these live on login.html. Report it instead
         * so the caller can route there. */
        const reason = e && e.status === 403 && e.body && e.body.error;
        if (reason === 'mfa-setup-required' || reason === 'password-change-required') {
          _pendingStep = reason;
          _data = _normalize(null);
          // Identify the user anyway — /api/me stays reachable in this state.
          try { const who = await _api('GET', '/me'); _me = (who && who.user) || null; }
          catch (e2) { _me = null; }
          return;
        }
        throw e;
      }
    },

    /** '' | 'mfa-setup-required' | 'password-change-required'
     *  Set when the server accepted the session but is holding the app closed
     *  until the account completes a step. */
    pendingStep() { return _pendingStep; },
    mode() { return 'api'; },
    // Called when the session expires mid-session (instead of the default
    // hard redirect), so the app can say why before leaving the page.
    onAuthLost(cb) { _authLostCb = cb; },

    /* ── Persistence status ── */
    onSaveStatus(cb) { _statusCb = cb; _emit('idle'); },
    hasUnsaved()   { return _pending > 0; },
    pendingCount() { return _pending; },
    failedCount()  { return _failed; },
    flush()        { return _queue; },

    /* ── Groups ── */
    getGroups()  { return _clone(_data.groups); },
    getGroup(id) { return _clone(_data.groups.find(g => g.id === id) || null); },
    createGroup(group) {
      group.id      = group.id || _newGroupId();
      group.workers = group.workers || [];
      _data.groups.push(group);
      // `_by` rides along on the payload only — never on the cached object.
      _push('POST', '/groups', { ...group, _by: _who() });
      return group.id;
    },
    updateGroup(id, patch) {
      const g = _data.groups.find(x => x.id === id);
      if (!g) return;
      Object.assign(g, patch);
      _push('PATCH', '/groups/' + encodeURIComponent(id), { ...patch, _by: _who() });
    },
    deleteGroup(id) {
      _data.groups = _data.groups.filter(g => g.id !== id);
      _push('DELETE', '/groups/' + encodeURIComponent(id));
    },

    /* ── Workers ── */
    getWorkers(groupId) {
      const g = _data.groups.find(x => x.id === groupId);
      return g ? _clone(g.workers) : [];
    },
    addWorker(groupId, worker) {
      const g = _data.groups.find(x => x.id === groupId);
      if (!g) return null;
      worker.uid = worker.uid || _newUid();
      g.workers.push(worker);
      _push('POST', '/groups/' + encodeURIComponent(groupId) + '/employees', { ...worker, _by: _who() });
      return worker.uid;
    },
    // The server keys employees by uid (PATCH/DELETE /employees/:uid), so the
    // write must ALWAYS be sent even if the passed groupId is wrong/empty
    // (e.g. editing from the Alerts/Selected/all-workers views). We locate the
    // cached row by uid across every group so the cache and server stay in sync.
    updateWorker(groupId, uid, patch) {
      let g = _data.groups.find(x => x.id === groupId);
      if (!g || !g.workers.some(w => w.uid === uid))
        g = _data.groups.find(x => (x.workers || []).some(w => w.uid === uid));
      if (g) {
        const idx = g.workers.findIndex(w => w.uid === uid);
        if (idx >= 0) g.workers[idx] = { ...g.workers[idx], ...patch };
      }
      _push('PATCH', '/employees/' + encodeURIComponent(uid), { ...patch, _by: _who() });   // always persist by uid
    },

    /**
     * Write a worker patch and WAIT for it — the same shape as uploadDocument.
     *
     * updateWorker hands its job to the durable queue and returns undefined, so
     * a caller cannot tell a landed write from a queued one. That is right for
     * someone editing a field: the queue survives a blip and the screen has
     * already moved on. It is wrong for a bulk import, and the difference
     * showed up as "some photos appear, some don't":
     *
     *   the import queued 150 PATCHes, each carrying ~200 KB of base64;
     *   the queue is a single chain, so they went up one at a time;
     *   the import then finished with `await DB.init()`, which replaces the
     *   local cache with whatever the SERVER has — and the photos still in the
     *   queue were not there yet, so they vanished from the screen.
     *
     * Nothing was lost — the queue kept going — but the app showed a half-done
     * import, which is worse than a slow one. Awaiting the write puts photos on
     * the same footing as documents: four at a time, real retries, and finished
     * means finished.
     */
    async patchWorkerNow(groupId, uid, patch) {
      const r = await _api('PATCH', '/employees/' + encodeURIComponent(uid), { ...patch, _by: _who() });
      let g = _data.groups.find(x => (x.workers || []).some(w => w.uid === uid));
      if (g) {
        const i = g.workers.findIndex(w => w.uid === uid);
        if (i >= 0) g.workers[i] = { ...g.workers[i], ...patch };
      }
      return r;
    },
    deleteWorker(groupId, uid) {
      let g = _data.groups.find(x => x.id === groupId);
      if (!g || !g.workers.some(w => w.uid === uid))
        g = _data.groups.find(x => (x.workers || []).some(w => w.uid === uid));
      if (g) g.workers = g.workers.filter(w => w.uid !== uid);
      _push('DELETE', '/employees/' + encodeURIComponent(uid));
    },
    /* Re-parent a worker. Separate from updateWorker because the cache stores
     * workers INSIDE their group, so a group change is a move between two
     * arrays — patching the row in place would leave it listed under the group
     * it just left until the next reload. */
    moveWorker(uid, toGroupId) {
      const dest = _data.groups.find(x => x.id === toGroupId);
      if (!dest) return false;
      const from = _data.groups.find(x => (x.workers || []).some(w => w.uid === uid));
      if (!from || from.id === toGroupId) return false;
      const w = from.workers.find(x => x.uid === uid);
      from.workers = from.workers.filter(x => x.uid !== uid);
      dest.workers = dest.workers || [];
      dest.workers.push(w);
      _push('PATCH', '/employees/' + encodeURIComponent(uid), { group_id: toGroupId, _by: _who() });
      return true;
    },

    /* ── Contact ID ── */
    todayCode() {
      const d = new Date();
      return String(d.getDate()).padStart(2, '0') +
             String(d.getMonth() + 1).padStart(2, '0') +
             String(d.getFullYear()).slice(-2);
    },
    nextContactId(krCode, laCode, dateCode) {
      if (!krCode || !laCode) return '';
      dateCode = dateCode || this.todayCode();
      const prefix = krCode + '-' + laCode + '-' + dateCode + '-';
      let max = 0;
      _allWorkers().forEach(w => {
        if (w.worker_id && w.worker_id.startsWith(prefix)) {
          const n = parseInt(w.worker_id.slice(prefix.length), 10);
          if (!isNaN(n) && n > max) max = n;
        }
      });
      return prefix + String(max + 1).padStart(3, '0');
    },

    /* ── App settings (server-persisted key-value) ── */
    getSetting(key, fallback) {
      const v = _data.settings ? _data.settings[key] : undefined;
      return (v === undefined || v === null) ? fallback : v;
    },
    setSetting(key, value) {
      if (!_data.settings) _data.settings = {};
      _data.settings[key] = value;
      _push('POST', '/settings', { key, value });
    },

    /* ── Cities ── */
    getCities() { return _clone(_data.cities); },
    addCity(country, { name, code }) {
      if (!_data.cities[country]) _data.cities[country] = [];
      code = (code || '').toUpperCase().trim();
      name = (name || '').trim();
      if (!name || !code) return 'invalid';
      if (_data.cities[country].some(c => c.code === code)) return 'dup';
      _data.cities[country].push({ name, code });
      _push('POST', '/cities', { country, name, code });
      return 'ok';
    },
    deleteCity(country, code) {
      if (!_data.cities[country]) return;
      _data.cities[country] = _data.cities[country].filter(c => c.code !== code);
      _push('DELETE', '/cities/' + encodeURIComponent(country) + '/' + encodeURIComponent(code));
    },

    /* ── Location Dictionary (settings-backed, hierarchical) ── */
    // Falls back to the seeded Lao hierarchy when no dictionary has actually been
    // configured. "Set but empty" (levels: []) counts as unconfigured — it holds
    // nothing worth preserving. A real user-built dictionary is respected untouched.
    getLocDict() {
      const stored = this.getSetting('loc_dict', null);
      const configured = stored && Array.isArray(stored.levels) && stored.levels.length > 0;
      return _normalizeLocDict(configured ? stored : _defaultLocDict());
    },
    saveLocDict(obj) {
      const norm = _normalizeLocDict(obj);
      this.setSetting('loc_dict', norm);
      return norm;
    },
    clearLocDict() { this.setSetting('loc_dict', null); },
    // Next running number for a worker_id prefix, honouring a user-set start.
    workerSeqForPrefix(prefix, start) {
      let max = (start && start > 1) ? start - 1 : 0;
      _allWorkers().forEach(w => {
        if (w.worker_id && w.worker_id.indexOf(prefix) === 0) {
          const n = parseInt(w.worker_id.slice(prefix.length), 10);
          if (!isNaN(n) && n > max) max = n;
        }
      });
      return max + 1;
    },

    /* ── Auth ──
     * login() คือทางเดียวที่จะได้สิทธิ์: server ตรวจ username+password แล้ว
     * ตั้ง session cookie (HttpOnly) ให้ — ฝั่ง browser สลับบัญชี/ยกระดับ
     * สิทธิ์เองไม่ได้อีกต่อไป                                              */
    async login(username, password, remember) {
      username = (username || '').trim();
      let r;
      try {
        r = await _api('POST', '/login', { username, password, remember: !!remember });
      } catch (e) {
        if (e && e.status === 429) {
          const err = new Error('too-many-attempts');
          err.code = 'too-many-attempts';
          err.retryAfter = (e.body && e.body.retryAfter) || 0;
          throw err;
        }
        return null;     // wrong username/password (or server unreachable)
      }
      // Second factor owed: no session exists yet. Hand the challenge back to
      // the caller rather than pretending this is a completed sign-in.
      if (r && r.ok && r.mfaRequired) {
        return { mfaRequired: true, mfaTicket: r.mfaTicket, methods: r.methods || {} };
      }
      if (!r || !r.ok || !r.user) return null;

      // Credentials were accepted — but only a WORKING session lets the app in.
      // Confirm it before navigating, otherwise index.html would bounce straight
      // back here and the sign-in page would just loop with no explanation.
      let who = null, why = 'no-session';
      try { who = await _api('GET', '/me'); }
      catch (e) { if (e && e.status === 404) why = 'server-outdated'; }   // pre-session build
      if (!who || !who.user) {
        const err = new Error(why);
        err.code = why;
        throw err;
      }
      _me = who.user;
      _authLostFired = false;
      // Seeded / admin-reset credentials are temporary: the server refuses every
      // other route until they are replaced, so tell the caller to show the
      // change-password step instead of navigating into an app that would 403.
      if (r.mustChangePassword || who.mustChangePassword) _me.mustChangePassword = true;
      if (r.mfaSetupRequired || who.mfaSetupRequired) _me.mfaSetupRequired = true;
      return _me;
    },

    /* ── Multi-factor authentication (P3) ── */

    /** Step two of sign-in. `opts.method` is 'totp' (default) or 'recovery'. */
    async completeMfa(mfaTicket, code, opts) {
      const o = opts || {};
      let r;
      try {
        r = await _api('POST', '/login/mfa', {
          mfaTicket, code,
          method: o.method || 'totp',
          trustDevice: !!o.trustDevice,
        });
      } catch (e) {
        const err = new Error('mfa-failed');
        err.code = (e.body && e.body.error) || 'invalid-code';
        err.retryAfter = (e.body && e.body.retryAfter) || 0;
        throw err;
      }
      // Same confirmation as the password path: credentials were accepted, but
      // only a working session lets the app in.
      let who = null;
      try { who = await _api('GET', '/me'); } catch (e) {}
      if (!who || !who.user) { const err = new Error('no-session'); err.code = 'no-session'; throw err; }
      _me = who.user;
      _authLostFired = false;
      return {
        user: _me,
        mustChangePassword: !!(r.mustChangePassword || who.mustChangePassword),
        mfaSetupRequired: !!(r.mfaSetupRequired || who.mfaSetupRequired),
      };
    },

    async mfaStatus() {
      try { return (await _api('GET', '/mfa/status')).status || null; }
      catch (e) { return null; }
    },
    async beginTotpEnrolment() { return _api('POST', '/mfa/totp/begin', {}); },
    async confirmTotpEnrolment(code) { return _api('POST', '/mfa/totp/confirm', { code }); },
    // Disabling MFA and reissuing recovery codes both re-authenticate: holding
    // the session is not enough to weaken the account's own protection.
    async disableMfa(password) { return _api('POST', '/mfa/disable', { password }); },
    async regenerateRecoveryCodes(password) {
      return (await _api('POST', '/mfa/recovery-codes', { password })).recoveryCodes || [];
    },

    async listTrustedDevices() {
      try { return (await _api('GET', '/mfa/trusted-devices')).devices || []; }
      catch (e) { return []; }
    },
    async revokeTrustedDevice(id) {
      try { await _api('DELETE', '/mfa/trusted-devices/' + encodeURIComponent(id)); return true; }
      catch (e) { return false; }
    },
    async revokeAllTrustedDevices() {
      return (await _api('POST', '/mfa/trusted-devices/revoke-all', {})).revoked || 0;
    },

    /* ── Passkeys (WebAuthn) ── */
    async passkeyLoginOptions(username) { return _api('POST', '/webauthn/login/options', { username }); },
    async passkeyLoginVerify(payload) {
      const r = await _api('POST', '/webauthn/login/verify', payload);
      let who = null;
      try { who = await _api('GET', '/me'); } catch (e) {}
      if (!who || !who.user) { const err = new Error('no-session'); err.code = 'no-session'; throw err; }
      _me = who.user;
      _authLostFired = false;
      return {
        user: _me,
        mustChangePassword: !!(r.mustChangePassword || who.mustChangePassword),
        mfaSetupRequired: !!(r.mfaSetupRequired || who.mfaSetupRequired),
      };
    },
    async passkeyRegisterOptions() { return _api('POST', '/webauthn/register/options', {}); },
    async passkeyRegisterVerify(payload) { return _api('POST', '/webauthn/register/verify', payload); },
    async listPasskeys() {
      try { return (await _api('GET', '/passkeys')).passkeys || []; }
      catch (e) { return []; }
    },
    async deletePasskey(id) {
      try { await _api('DELETE', '/passkeys/' + encodeURIComponent(id)); return true; }
      catch (e) { return false; }
    },

    /* Change your own password. `current` is required even with a live session —
     * a stolen session must not be enough to take the account over. On success
     * the server rotates this session's cookie, so the user stays signed in.   */
    async changePassword(current, next) {
      try {
        await _api('POST', '/password', { current: current, next: next });
      } catch (e) {
        const err = new Error((e.body && e.body.error) || 'change-failed');
        err.code = (e.body && e.body.error) || 'change-failed';
        throw err;
      }
      if (_me) delete _me.mustChangePassword;
      return true;
    },
    async logout() {
      _me = null;
      _authLostFired = true;                       // we're leaving on purpose
      try { await _api('POST', '/logout'); } catch (e) {}
      try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    },

    /* ── Session management (P1) ── */

    // This account's active devices. Each entry carries `current: true` for the
    // device making the call, so the UI can label it and avoid self-revoking.
    async listSessions() {
      try { return (await _api('GET', '/sessions')).sessions || []; }
      catch (e) { return []; }
    },

    // Revoke one device by id. Server-side it only matches sessions owned by
    // the caller, so a guessed id cannot touch anyone else's.
    async revokeSession(id) {
      try { await _api('DELETE', '/sessions/' + encodeURIComponent(id)); return true; }
      catch (e) { return false; }
    },

    /* Sign out everywhere. keepCurrent defaults to true so the user is not
     * logged out of the device they are using to do it — pass false to end
     * every session including this one (then send them to the login page). */
    async logoutAll(keepCurrent) {
      const keep = keepCurrent !== false;
      const r = await _api('POST', '/logout-all', { keepCurrent: keep });
      if (!keep) { _me = null; _authLostFired = true; }
      return (r && r.revoked) || 0;
    },

    // Why the last request lost the session: idle-timeout | absolute-lifetime |
    // session-expired | unknown-session | no-token. Lets the sign-in page say
    // what happened instead of silently bouncing the user.
    lastAuthLostReason() { return _authLostReason; },
    // The server's verdict, cached from /bootstrap (or the login response).
    getCurrentUser() {
      return _me ? { username: _me.username, role: _me.role, name: _me.name } : null;
    },
    // Re-ask the server (used to pick up a role change without a reload).
    async refreshCurrentUser() {
      try { _me = (await _api('GET', '/me')).user || null; } catch (e) {}
      return this.getCurrentUser();
    },
    isAdmin() { return !!_me && _me.role === 'admin'; },

    /**
     * P4 — permission-based UI gating.
     *
     * The server sends the caller's permission set with /bootstrap and decides
     * again on every request; this is presentation only. It replaces
     * `isAdmin()` at the call sites that were really asking "may this account do
     * X" — which is every one of them except the handful that genuinely mean
     * "is this the admin role".
     *
     * Unknown permission ⇒ false. A typo must hide a control, never reveal one.
     */
    can(permission) {
      const p = _me && _me.permissions;
      return !!(p && p[permission]);
    },
    /** The scope a permission is held at ('all' | 'team' | 'own'), or ''. */
    scopeOf(permission) {
      const p = _me && _me.permissions;
      return (p && p[permission]) || '';
    },
    /**
     * May this account export in `format`?
     *
     * The mapping comes from the server (see /api/bootstrap). An unknown format
     * falls back to `export.bundle` — the narrowest grant — exactly as
     * rbac.exportPermissionFor does, so a format added to the UI before the
     * table knows about it fails closed rather than open.
     */
    canExportFormat(format) {
      const perm = _exportPerms[String(format || '').toLowerCase()] || 'export.bundle';
      return this.can(perm);
    },
    permissions() { return Object.assign({}, (_me && _me.permissions) || {}); },
    myRank() { return _me && _me.rank != null ? _me.rank : null; },

    /* ── Users ── */
    /** The cached directory from /bootstrap — enough for counts and exports. */
    getUsers() {
      return _data.users.map(u => ({ username: u.username, role: u.role, name: u.name }));
    },
    /* The administration list: roles, MFA state, last login, session counts.
     * Server-authoritative and always fetched fresh — an account screen showing
     * a stale role is worse than one that takes an extra moment to load. */
    async listUsers() {
      const r = await _api('GET', '/users');
      return { users: r.users || [], roles: r.roles || [], actorRank: r.actorRank };
    },
    /* These three are deliberately NOT queued through _push().
     *
     * The write queue is fire-and-forget with optimistic local state, which is
     * right for worker records and wrong for accounts: "create user" can fail
     * with weak-password, dup, or rank-violation, and the operator has to see
     * which. They await the server and surface its verdict.
     * Return: 'ok' | 'dup' | 'weak-password:<code>' | 'rank-violation' | … */
    async addUser({ username, password, role, name }) {
      username = (username || '').trim();
      if (!username || !password) return 'invalid';
      try {
        const r = await _api('POST', '/users', { username, password, role, name: (name || username).trim() });
        if (r && r.ok) _data.users.push({ username, role, name: name || username });
        return (r && r.status) || 'ok';
      } catch (e) {
        return (e && e.body && e.body.error) || 'failed';
      }
    },
    async deleteUser(username) {
      try {
        const r = await _api('DELETE', '/users/' + encodeURIComponent(username));
        if (r && r.ok) _data.users = _data.users.filter(u => u.username !== username);
        return (r && r.status) || 'ok';
      } catch (e) {
        return (e && e.body && e.body.error) || 'failed';
      }
    },
    async updateUser(username, patch) {
      try {
        const r = await _api('PATCH', '/users/' + encodeURIComponent(username), patch);
        if (r && r.ok) {
          const t = _data.users.find(u => u.username === username);
          if (t) {
            if (typeof patch.name === 'string') t.name = patch.name.trim() || username;
            if (patch.role) t.role = patch.role;
          }
        }
        return (r && r.status) || 'ok';
      } catch (e) {
        return (e && e.body && e.body.error) || 'failed';
      }
    },

    /* ══════════════════════════════════════════════════════════════
     * P4 — Administration centre
     * ══════════════════════════════════════════════════════════════
     * Thin wrappers. No business logic lives on this side: each one is a named
     * call to an endpoint that already enforces its own permission.
     */

    /* Security */
    async securityOverview()  { return _api('GET', '/security/overview'); },
    async getPolicies()       { return (await _api('GET', '/security/policies')).policies; },
    async setPasswordPolicy(patch) { return (await _api('PATCH', '/security/policies/password', patch)).policies; },
    async setMfaPolicy(patch)      { return (await _api('PATCH', '/security/policies/mfa', patch)).policies; },
    async setSessionPolicy(patch)  { return (await _api('PATCH', '/security/policies/session', patch)).policies; },
    async mfaOverview()       { return _api('GET', '/security/mfa-overview'); },
    async forceMfa(username, required) {
      return _api('POST', '/security/mfa-enforce', { username, required: required !== false });
    },
    async resetUserMfa(username)      { return _api('POST', '/security/mfa-reset', { username }); },
    async sessionsSummary()           { return (await _api('GET', '/security/sessions')).summary || []; },
    async revokeUserSessions(username){ return _api('POST', '/security/revoke-sessions', { username }); },
    async revokeUserTrusted(username) { return _api('POST', '/security/revoke-trusted', { username }); },

    /* Audit trail — paginated + searchable. */
    async auditLog(opts) {
      const o = opts || {};
      const q = new URLSearchParams();
      ['limit', 'offset', 'username', 'action', 'result', 'since', 'until', 'q'].forEach(k => {
        if (o[k] !== undefined && o[k] !== null && o[k] !== '') q.set(k, o[k]);
      });
      const r = await _api('GET', '/auth-log' + (q.toString() ? '?' + q.toString() : ''));
      return { rows: r.rows || r.log || [], total: r.total || 0, limit: r.limit, offset: r.offset, actions: r.actions || [] };
    },

    /* Roles & permissions */
    async listRoles()      { return (await _api('GET', '/roles')).roles || []; },
    async roleMatrix()     { return _api('GET', '/roles/matrix'); },
    async listPermissions(){ return _api('GET', '/permissions'); },
    async createRole(def)  { return _api('POST', '/roles', def); },
    async updateRole(key, patch) { return _api('PATCH', '/roles/' + encodeURIComponent(key), patch); },
    async setRoleGrants(key, grants) {
      return _api('PATCH', '/roles/' + encodeURIComponent(key) + '/permissions', { grants });
    },
    async deleteRole(key)  { return _api('DELETE', '/roles/' + encodeURIComponent(key)); },

    /**
     * Authorise and record an export before writing the file (P4.5).
     *
     * Called BEFORE the export runs, and the export is abandoned if this is
     * refused — so the permission is enforced by the server, not by hiding a
     * button. Returns true when the export may proceed.
     *
     * Honest limitation: the records are already in this browser, so this cannot
     * stop a determined authorised reader from copying data by other means. What
     * it does do is refuse the ordinary path for a role without the grant, and
     * put every export that happens into the audit trail.
     */
    async recordExport(format, scope, records) {
      try {
        const r = await _api('POST', '/export', { format, scope, records });
        /* P4.6: the server issues a receipt (id + watermark line) that the caller
         * stamps into the file. Truthy return keeps every existing call site
         * working unchanged; callers that want to watermark read the object. */
        return r || true;
      } catch (e) {
        if (e && e.status === 403) return false;
        /* A network or server error must not silently block an export the user
         * is entitled to — the permission was already checked server-side on the
         * way in, and losing the audit row is the lesser failure. It is reported
         * to the console so it is not invisible. */
        console.warn('[export] could not record export:', e && e.message || e);
        return true;
      }
    },

    /* ── Export package (photos + documents, per worker) ──
     * Built on the SERVER, because the files are hundreds of megabytes of scans
     * that already live there. These three mirror the three routes: start,
     * poll, and the download URL the browser navigates to.
     *
     * A 403 is returned as a value rather than thrown, matching recordExport —
     * "this account may not do that" is an answer, not a failure. */
    /**
     * Upload one browser-generated report (XLSX / PDF / PPTX) to be placed
     * inside the package. Returns its staging id.
     *
     * Not routed through _api: that helper serialises a JSON body, and sending
     * a multi-megabyte file as base64 inside JSON would inflate it by a third
     * and force the whole thing through a JS string on both sides. The blob is
     * posted raw, with the same CSRF token every other write carries.
     */
    async attachExportFile(name, blob) {
      const res = await fetch('/api/export/package/attach', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'X-CSRF-Token': await _csrfToken(),
          'X-KD-Filename': encodeURIComponent(name),
          'Content-Type': blob.type || 'application/octet-stream',
        },
        body: blob,
      });
      let out = null;
      try { out = await res.json(); } catch (e) {}
      if (!res.ok || !out || !out.ok) {
        const err = new Error((out && out.error) || ('attach failed: ' + res.status));
        err.status = res.status;
        throw err;
      }
      return out.id;
    },

    async startExportPackage(uids, options, scope, attachments) {
      try {
        return await _api('POST', '/export/package', { uids, options, scope, attachments });
      } catch (e) {
        if (e && e.status === 403) return { ok: false, error: 'forbidden' };
        if (e && e.status === 429) return { ok: false, error: 'busy' };
        if (e && e.body && e.body.error) return { ok: false, ...e.body };
        throw e;
      }
    },
    async exportPackageStatus(jobId) {
      return _api('GET', '/export/package/' + encodeURIComponent(jobId));
    },
    exportPackageUrl(jobId) {
      return '/api/export/package/' + encodeURIComponent(jobId) + '/download';
    },

    /* ── Complete system recovery (P5.1) ──
     * A full package holds the database, every upload and the audit-chain key.
     * `backup()` above still exists and still takes a database-only snapshot —
     * both are real, and the UI labels the difference rather than hiding it. */
    async createFullBackup(reason) {
      return _api('POST', '/admin/backups/full', { reason: reason || 'manual' });
    },
    async verifyPackage(file, deep) {
      return (await _api('POST', '/admin/backups/' + encodeURIComponent(file) + '/verify',
                         { deep: !!deep })).report;
    },
    async previewPackage(file) {
      return (await _api('GET', '/admin/backups/' + encodeURIComponent(file) + '/preview')).preview;
    },
    async restorePackage(file, opts) {
      const o = opts || {};
      return _api('POST', '/admin/backups/' + encodeURIComponent(file) + '/restore',
                  { allowPartial: !!o.allowPartial, dryRun: !!o.dryRun });
    },
    async uploadOffsite(file) {
      return _api('POST', '/admin/backups/' + encodeURIComponent(file) + '/offsite');
    },
    async backupHealth() { return (await _api('GET', '/admin/backup-health')).health; },
    async backupInventory() {
      const r = await _api('GET', '/admin/backups');
      return { inventory: r.inventory || [], packages: r.packages || [],
               snapshots: r.entries || [], health: r.health || null };
    },
    async applyRetention(opts) {
      return (await _api('POST', '/admin/retention', opts || {})).result;
    },

    /* Integrity (P4.6) */
    async auditIntegrity() { return (await _api('GET', '/security/audit-integrity')).integrity; },
    async reanchorAudit(reason) { return _api('POST', '/security/audit-reanchor', { reason }); },
    async verifyBackup(file) {
      return (await _api('POST', '/admin/backups/' + encodeURIComponent(file) + '/verify')).report;
    },
    async previewRestore(file) {
      return (await _api('GET', '/admin/backups/' + encodeURIComponent(file) + '/preview')).preview;
    },

    /* Monitoring */
    async systemHealth()   { return _api('GET', '/admin/health'); },
    async storageStats()   { return _api('GET', '/admin/storage'); },
    async cleanupStorage(opts) { return _api('POST', '/admin/cleanup', opts || {}); },

    /* Backups with size / author / status. `backupUrl` is a plain link the
     * browser downloads directly — streaming a database through fetch() into a
     * Blob would hold the whole file in memory for no benefit. */
    async listBackupsDetailed() { return (await _api('GET', '/admin/backups')).entries || []; },
    backupUrl(file) { return '/api/admin/backups/' + encodeURIComponent(file) + '/download'; },

    /* ── Stats ── */
    getAllStats() {
      return _data.groups.map(g => ({
        id: g.id, name: g.name, count: g.workers.length,
        expiring: g.workers.filter(w => {
          const d = _parseDate(w.passport_expiry);
          return d && (d - Date.now()) < 2 * 365.25 * 864e5;
        }).length,
      }));
    },

    /* ── Documents (versioned) ── */
    async getDocuments(uid) {
      return (await _api('GET', '/employees/' + encodeURIComponent(uid) + '/documents')).docs || {};
    },
    async uploadDocument(uid, groupId, category, dataUrl, name) {
      return _api('POST', '/employees/' + encodeURIComponent(uid) + '/documents',
        { groupId, category, data: dataUrl, name: name || '', uploadedBy: _who() });
    },
    async deleteDocument(docId) {
      return _api('DELETE', '/documents/' + docId);
    },

    /* ── AI document extraction (Gemini) ── */
    async aiExtract(imageDataUrl, docType) {
      try { return await _api('POST', '/ai/extract', { image: imageDataUrl, docType: docType || 'passport' }); }
      catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    },

    /* ── Activity Log ── */
    async getActivity(uid) {
      return (await _api('GET', '/employees/' + encodeURIComponent(uid) + '/activity')).log || [];
    },
    async getGroupActivity(groupId) {
      return (await _api('GET', '/groups/' + encodeURIComponent(groupId) + '/activity')).log || [];
    },

    /* ── Trash (soft-delete bin) ── */
    // deleteWorker/deleteGroup above already move rows to the trash server-side
    // (the DELETE endpoints are soft) and drop them from the local cache, so a
    // trashed item disappears from views at once. These manage the bin itself.
    async getTrash() {
      await _queue;   // make sure any just-queued deletes have reached the server
      return (await _api('GET', '/trash')).trash || { groups: [], employees: [] };
    },
    async restoreTrash(type, id) {
      const r = await _api('POST', '/trash/restore', { type, id });
      if (r && r.data) _data = _normalize(r.data);   // restored row reappears in cache
      return true;
    },
    async purgeTrash(type, id) { return _api('POST', '/trash/purge', { type, id }); },
    async emptyTrash()         { return _api('POST', '/trash/empty'); },

    /* ── Admin ── */
    async backup()      { return (await _api('POST', '/admin/backup')).file; },
    async listBackups() { return (await _api('GET', '/admin/backups')).files || []; },
    async restore(file) {
      const r = await _api('POST', '/admin/restore', { file });
      _data = _normalize(r.data);
      return true;
    },
    hardReset() {
      try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
      _api('POST', '/admin/reset').then(r => { _data = _normalize(r.data); }).catch(() => {});
    },
  };
})();
