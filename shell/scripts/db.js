/**
 * db.js — Data Layer (SQLite-backed, server-only)
 *
 * ฐานข้อมูลหลักคือ SQLite ผ่าน Node.js backend เท่านั้น
 * localStorage ใช้เฉพาะ session token (login) เท่านั้น
 * ไม่มี local fallback — ถ้า server ไม่รัน init() จะ throw
 */

const SESSION_KEY = 'kd_session';

const DB = (() => {
  const _clone = x => JSON.parse(JSON.stringify(x));
  let _data = { groups: [], cities: { kr: [], la: [] }, users: [] };

  /* ── API helper ── */
  async function _api(method, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch('/api' + path, {
        method,
        signal: ctrl.signal,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('API ' + res.status);
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
      const r = await _api('GET', '/bootstrap');
      _data = _normalize(r.data);
    },
    mode() { return 'api'; },

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
      _push('POST', '/groups', group);
      return group.id;
    },
    updateGroup(id, patch) {
      const g = _data.groups.find(x => x.id === id);
      if (!g) return;
      Object.assign(g, patch);
      _push('PATCH', '/groups/' + encodeURIComponent(id), patch);
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
      _push('POST', '/groups/' + encodeURIComponent(groupId) + '/employees', worker);
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
      _push('PATCH', '/employees/' + encodeURIComponent(uid), patch);   // always persist by uid
    },
    deleteWorker(groupId, uid) {
      let g = _data.groups.find(x => x.id === groupId);
      if (!g || !g.workers.some(w => w.uid === uid))
        g = _data.groups.find(x => (x.workers || []).some(w => w.uid === uid));
      if (g) g.workers = g.workers.filter(w => w.uid !== uid);
      _push('DELETE', '/employees/' + encodeURIComponent(uid));
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

    /* ── Auth ── */
    async login(username, password) {
      username = (username || '').trim();
      try {
        const r = await _api('POST', '/login', { username, password });
        if (!r.ok || !r.user) return null;
        try { localStorage.setItem(SESSION_KEY, JSON.stringify(r.user)); } catch (e) {}
        return r.user;
      } catch (e) { return null; }
    },
    logout() {
      try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    },
    switchAccount(username) {
      const u = _data.users.find(x => x.username === username);
      if (!u) return null;
      const sess = { username: u.username, role: u.role, name: u.name };
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(sess)); } catch (e) {}
      return sess;
    },
    getCurrentUser() {
      try {
        const s = JSON.parse(localStorage.getItem(SESSION_KEY));
        if (!s) return null;
        const u = _data.users.find(x => x.username === s.username);
        return u ? { username: u.username, role: u.role, name: u.name } : null;
      } catch { return null; }
    },

    /* ── Users ── */
    getUsers() {
      return _data.users.map(u => ({ username: u.username, role: u.role, name: u.name }));
    },
    addUser({ username, password, role, name }) {
      username = (username || '').trim();
      if (!username || !password) return 'invalid';
      if (_data.users.some(u => u.username === username)) return 'dup';
      role = role === 'admin' ? 'admin' : 'viewer';
      name = (name || username).trim();
      _data.users.push({ username, password, role, name });
      _push('POST', '/users', { username, password, role, name });
      return 'ok';
    },
    deleteUser(username) {
      const target = _data.users.find(u => u.username === username);
      if (!target) return 'missing';
      if (target.role === 'admin' && _data.users.filter(u => u.role === 'admin').length <= 1)
        return 'last-admin';
      _data.users = _data.users.filter(u => u.username !== username);
      _push('DELETE', '/users/' + encodeURIComponent(username));
      return 'ok';
    },
    updateUser(username, patch) {
      const target = _data.users.find(u => u.username === username);
      if (!target) return 'missing';
      if (target.role === 'admin' && patch.role && patch.role !== 'admin'
          && _data.users.filter(u => u.role === 'admin').length <= 1) return 'last-admin';
      if (typeof patch.name === 'string') target.name = patch.name.trim() || username;
      if (patch.role) target.role = patch.role === 'admin' ? 'admin' : 'viewer';
      if (patch.password) target.password = patch.password;  // cache only; server re-hashes
      _push('PATCH', '/users/' + encodeURIComponent(username), patch);
      return 'ok';
    },

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
      const who = (() => { try { return JSON.parse(localStorage.getItem(SESSION_KEY))?.username || ''; } catch { return ''; } })();
      return _api('POST', '/employees/' + encodeURIComponent(uid) + '/documents',
        { groupId, category, data: dataUrl, name: name || '', uploadedBy: who });
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
