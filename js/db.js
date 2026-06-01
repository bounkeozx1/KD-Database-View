/**
 * db.js — Data Layer
 *
 * All data access goes through this module.
 * To connect a real backend, replace the localStorage calls below
 * with fetch() requests and keep the same function signatures.
 */

const STORE_KEY = 'kd_db_v3';

const SEED = [
  {
    id: 'group-damyang-2026-h1',
    name: 'DAMYANG 2026 – Group 1',
    departure: '26/03/2026',
    route: 'VTE → ICN',
    workers: [
      {uid:'w001',worker_id:'VK/DY2026-001',employer_code:'VK',group_supervisor:'조재희',en_name:'VIMARA BANDITH',lo_name:'ນາງ ບັນດິດ ວິມາຣາ',dob:'11/11/1998',village:'MEURNGKAO',weight:'57',height:'150',size:'M',hand:'R',blood:'O',passport_no:'PA08786',passport_issue:'12/04/2018',passport_expiry:'12/04/2028',tel:'020 5669-9444',emg_tel:'020 5249-8664',couple:'yes'},
      {uid:'w002',worker_id:'TK/DY2026-002',employer_code:'TK',group_supervisor:'조재희',en_name:'PONGKANYA KEO OUDOME',lo_name:'ທ້າວ ແກ້ວອຸດອນ ປ້ອງກັນຍາ',dob:'08/04/1998',village:'NAMAK',weight:'70',height:'177',size:'L',hand:'L',blood:'O',passport_no:'P3146343',passport_issue:'22/10/2024',passport_expiry:'21/10/2034',tel:'020 9985-1070',emg_tel:'020 5520-1106',couple:'yes'},
      {uid:'w003',worker_id:'VV/DY2026-003',employer_code:'VV',group_supervisor:'조재희',en_name:'INPHOMTHILATH ANON',lo_name:'ທ້າວ ອານົນ ອິນພົມທິລາດ',dob:'10/02/1987',village:'HOUAYPAMOM',weight:'75',height:'166',size:'XL',hand:'R',blood:'AB',passport_no:'P2843510',passport_issue:'14/12/2023',passport_expiry:'13/12/2033',tel:'020 9937-7525',emg_tel:'020 9141-1096',couple:'yes'},
      {uid:'w004',worker_id:'VV/DY2026-004',employer_code:'VV',group_supervisor:'조재희',en_name:'PHOMMASOULIDETH ONCHANH',lo_name:'ນາງ ອູ່ອນຈັນ ພົມມາສຸລິເດດ',dob:'09/05/1997',village:'HOUAYPAMOM',weight:'41',height:'150',size:'S',hand:'L',blood:'A',passport_no:'P3497586',passport_issue:'23/01/2026',passport_expiry:'22/01/2036',tel:'020 7734-9206',emg_tel:'',couple:'yes'},
      {uid:'w005',worker_id:'VV/DY2026-005',employer_code:'VV',group_supervisor:'임대현',en_name:'LOR YOUA',lo_name:'ນາງ ຢົວ ລໍ່',dob:'20/09/1992',village:'NAMONE NEUA',weight:'50',height:'155',size:'M',hand:'R',blood:'A',passport_no:'P3333685',passport_issue:'02/06/2025',passport_expiry:'01/06/2035',tel:'020 9863-3090',emg_tel:'',couple:'yes'},
      {uid:'w006',worker_id:'TK/DY2026-006',employer_code:'TK',group_supervisor:'임대현',en_name:'SIHALAT DOUANGPHIPHAT',lo_name:'ນາງ ດວງພິພັດ ສີຫາລາດ',dob:'11/07/1999',village:'NAPHEIY',weight:'47',height:'155',size:'M',hand:'R',blood:'B',passport_no:'P2607830',passport_issue:'14/04/2023',passport_expiry:'13/04/2033',tel:'020 5197-9863',emg_tel:'',couple:'yes'},
      {uid:'w007',worker_id:'',employer_code:'',group_supervisor:'최영상(토)',en_name:'KEOSIDA NALITA',lo_name:'ນາງ ນາລິຕາ ແກ້ວສິດາ',dob:'15/11/1994',village:'KHOKSAY',weight:'56',height:'158',size:'M',hand:'R',blood:'O',passport_no:'P3101052',passport_issue:'23/08/2024',passport_expiry:'22/08/2034',tel:'020 9888-4559',emg_tel:'',couple:'yes'},
      {uid:'w008',worker_id:'',employer_code:'',group_supervisor:'염민웅(토)',en_name:'KHOUMHEUANGSIN NING',lo_name:'ນາງ ຫນິງ ຄຸ້ມເຮືອງສິນ',dob:'06/06/1993',village:'PHONEPHAENG',weight:'60',height:'155',size:'L',hand:'R',blood:'O',passport_no:'P2512529',passport_issue:'05/01/2023',passport_expiry:'04/01/2033',tel:'020 5884-2823',emg_tel:'',couple:'yes'},
      {uid:'w009',worker_id:'',employer_code:'',group_supervisor:'김영회',en_name:'SIHALATH PHONEKEO',lo_name:'ທ້າວ ພອນແກ້ວ ສີຫາລາດ',dob:'07/03/1981',village:'HATSOUAN',weight:'',height:'',size:'L',hand:'R',blood:'O',passport_no:'P3515264',passport_issue:'10/02/2026',passport_expiry:'09/02/2036',tel:'020 5250-6361',emg_tel:'',couple:'yes'},
      {uid:'w010',worker_id:'',employer_code:'',group_supervisor:'최준기',en_name:'KEOMIXAY SOTH',lo_name:'ນາງ ສົດ ແກ້ວມີໄຊ',dob:'08/03/1993',village:'NAMPHAO',weight:'60',height:'160',size:'L',hand:'R',blood:'O',passport_no:'P2967838',passport_issue:'23/04/2024',passport_expiry:'22/04/2034',tel:'020 2866-7741',emg_tel:'',couple:'yes'},
      {uid:'w011',worker_id:'',employer_code:'',group_supervisor:'최준기',en_name:'SALIBOUT PHUANGPHANH',lo_name:'ນາງ ພວງພັນ ສາລິບຸດ',dob:'02/02/1990',village:'HOUAYSANGAO',weight:'',height:'158',size:'M',hand:'R',blood:'AB',passport_no:'P3467807',passport_issue:'11/12/2025',passport_expiry:'10/12/2035',tel:'020 5850-7839',emg_tel:'',couple:'yes'},
      {uid:'w012',worker_id:'',employer_code:'',group_supervisor:'최준기',en_name:'ZAMOUNTY KHAMHOU',lo_name:'ນ ຄໍາຮ້ ຊາມຸນຕີ',dob:'07/04/1999',village:'KEUNNEUA',weight:'47',height:'163',size:'M',hand:'R',blood:'O',passport_no:'P2832944',passport_issue:'01/12/2023',passport_expiry:'30/11/2033',tel:'020 9262-2208',emg_tel:'',couple:'yes'},
      {uid:'w013',worker_id:'',employer_code:'',group_supervisor:'최준기',en_name:'PHOUANGSAVATH BOUNLONG',lo_name:'ນາງ ບຸນລອງ ພວງສະຫວັດ',dob:'20/04/1990',village:'JEANG',weight:'',height:'',size:'L',hand:'R',blood:'O',passport_no:'P2620218',passport_issue:'29/04/2023',passport_expiry:'29/04/2033',tel:'020 5850-8573',emg_tel:'',couple:'yes'},
      {uid:'w014',worker_id:'',employer_code:'',group_supervisor:'김호진',en_name:'THONE',lo_name:'ນາງ ທອນ',dob:'15/06/1987',village:'BOR',weight:'51',height:'151',size:'M',hand:'R',blood:'-',passport_no:'PA0519440',passport_issue:'06/01/2026',passport_expiry:'06/01/2036',tel:'020 9575-6163',emg_tel:'',couple:'yes'},
      {uid:'w015',worker_id:'',employer_code:'',group_supervisor:'최백범',en_name:'SOUKSAMLAN PHOUTTHALUK',lo_name:'ທາງ ພຸດທະລັກ ສຸກສໍາລານ',dob:'26/07/2000',village:'PHONVIENG',weight:'62',height:'167',size:'L',hand:'R',blood:'O',passport_no:'P3496547',passport_issue:'26/01/2026',passport_expiry:'25/01/2036',tel:'020 9502-2910',emg_tel:'',couple:'yes'},
      {uid:'w016',worker_id:'',employer_code:'',group_supervisor:'김민석',en_name:'VENVANKHAM VINATH',lo_name:'ທ້າວ ວິນັດ ແຫວນວັນຄໍາ',dob:'04/08/1988',village:'PHA TUNG',weight:'60',height:'165',size:'L',hand:'R',blood:'A',passport_no:'P2604979',passport_issue:'07/04/2023',passport_expiry:'06/04/2033',tel:'020 7777-7120',emg_tel:'',couple:'yes'},
      {uid:'w017',worker_id:'',employer_code:'',group_supervisor:'한상호',en_name:'PHIATHEP PAOKHAM',lo_name:'ນາງ ເປົ້າຄໍາ ເພຍເທບ',dob:'16/03/1992',village:'KERNKANG',weight:'',height:'',size:'M',hand:'R',blood:'B',passport_no:'P2398199',passport_issue:'12/04/2022',passport_expiry:'11/04/2032',tel:'020 9436-1799',emg_tel:'',couple:'yes'},
      {uid:'w018',worker_id:'',employer_code:'',group_supervisor:'김민정',en_name:'SISUVANHNANG SIDAOSONE',lo_name:'ທ້າວ ສີດາວສອນ ສີສຸວັນນາງ',dob:'09/05/1992',village:'KEANGKHAI',weight:'',height:'',size:'L',hand:'R',blood:'O',passport_no:'P3202621',passport_issue:'08/01/2025',passport_expiry:'07/01/2035',tel:'020 5759-2233',emg_tel:'',couple:'yes'},
      {uid:'w019',worker_id:'',employer_code:'',group_supervisor:'송명수',en_name:'VONGVICHITH KEOBOUPHA',lo_name:'ທ້າວ ແກ້ວບຸບຜາ ວົງວິຈິດ',dob:'29/06/1991',village:'KEUNKANG',weight:'',height:'',size:'L',hand:'R',blood:'-',passport_no:'P2398129',passport_issue:'12/04/2022',passport_expiry:'11/04/2032',tel:'020 5207-3373',emg_tel:'',couple:'yes'},
      {uid:'w020',worker_id:'',employer_code:'',group_supervisor:'서영철',en_name:'SIHALATH SOMBOUN',lo_name:'ນາງ ສົມບຸນ ສີຫາລາດ',dob:'08/07/1989',village:'PAK HANG',weight:'59',height:'160',size:'M',hand:'R',blood:'A',passport_no:'P2847496',passport_issue:'14/12/2023',passport_expiry:'13/12/2033',tel:'020 5650-9993',emg_tel:'',couple:'yes'},
      {uid:'w021',worker_id:'',employer_code:'',group_supervisor:'서영철',en_name:'YANG KAOLEE',lo_name:'ນາງ ເກົ່າຫີ ຢ່າງ',dob:'29/09/1999',village:'HOUAY YAE',weight:'55',height:'',size:'L',hand:'R',blood:'-',passport_no:'P3497133',passport_issue:'22/01/2026',passport_expiry:'21/01/2036',tel:'020 7692-0706',emg_tel:'',couple:'yes'},
      {uid:'w022',worker_id:'',employer_code:'',group_supervisor:'공기석',en_name:'VONGXAY SOMPASONG',lo_name:'ທ້າວ ສົມປະສົງ ວົງໄຊ',dob:'11/01/2000',village:'KUENKANG',weight:'53',height:'163',size:'L',hand:'R',blood:'O',passport_no:'P2235658',passport_issue:'04/07/2019',passport_expiry:'03/07/2029',tel:'020 5237-5323',emg_tel:'',couple:'yes'},
      {uid:'w023',worker_id:'',employer_code:'',group_supervisor:'공기석',en_name:'KEOKHAMMANY ANOUSONE',lo_name:'ທ້າວ ອານຸສອນ ແກ້ວຄໍາມະນີ',dob:'03/04/1998',village:'Hongngua',weight:'61',height:'175',size:'L',hand:'R',blood:'-',passport_no:'PA0447131',passport_issue:'25/08/2022',passport_expiry:'25/08/2032',tel:'020 7777-9322',emg_tel:'',couple:'yes'},
      {uid:'w024',worker_id:'',employer_code:'',group_supervisor:'김성훈',en_name:'LATSAVONG VIENGTHONG',lo_name:'ນາງ ວຽງທອງ ລາດຊະວົງ',dob:'24/10/2000',village:'CHENG',weight:'',height:'160',size:'M',hand:'R',blood:'AB',passport_no:'P2243479',passport_issue:'19/07/2019',passport_expiry:'18/07/2029',tel:'020 2828-6027',emg_tel:'',couple:'yes'},
      {uid:'w025',worker_id:'',employer_code:'',group_supervisor:'장근택',en_name:'VONGXAI KHAMPASEUT',lo_name:'ນາງ ຄໍາປະເສີດ ວົງໄຊ',dob:'01/09/1980',village:'BARN KERN',weight:'',height:'',size:'L',hand:'L',blood:'AB',passport_no:'PA0309985',passport_issue:'04/06/2019',passport_expiry:'04/06/2029',tel:'020 9963-6871',emg_tel:'',couple:'yes'},
      {uid:'w026',worker_id:'',employer_code:'',group_supervisor:'장근택',en_name:'PHOMDOUANGSY ANOULAK',lo_name:'ທ້າວ ອານຸລັກ ພົມດວງສີ',dob:'03/08/1990',village:'KERNKANG',weight:'',height:'',size:'XL',hand:'R',blood:'-',passport_no:'P2096777',passport_issue:'08/10/2018',passport_expiry:'07/10/2028',tel:'020 9880-5566',emg_tel:'',couple:'yes'},
      {uid:'w027',worker_id:'',employer_code:'',group_supervisor:'장근택',en_name:'PHOMDOUANGSY MINAVONE',lo_name:'ນາງ ມີນາວອນ ພົມດວງສີ',dob:'07/08/1999',village:'NAKONE',weight:'',height:'',size:'L',hand:'R',blood:'-',passport_no:'P3382717',passport_issue:'05/08/2025',passport_expiry:'04/08/2035',tel:'020 9954-6673',emg_tel:'',couple:'yes'},
      {uid:'w028',worker_id:'',employer_code:'',group_supervisor:'김천희',en_name:'MANIBOULOM SOMVANG',lo_name:'ນາງ ສົມຫວັງ ມະນີບຸລົມ',dob:'05/03/1991',village:'SYKHAI THA',weight:'',height:'',size:'M',hand:'R',blood:'B',passport_no:'P3549011',passport_issue:'17/03/2026',passport_expiry:'16/03/2036',tel:'020 7744-7676',emg_tel:'',couple:'yes'},
      {uid:'w029',worker_id:'',employer_code:'',group_supervisor:'',en_name:'VONGXAI TE',lo_name:'ທ້າວ ເຕ້ ວົງໄຊ',dob:'01/03/1990',village:'',weight:'',height:'',size:'L',hand:'R',blood:'-',passport_no:'P3214799',passport_issue:'11/12/2019',passport_expiry:'10/12/2029',tel:'020 5777-9532',emg_tel:'',couple:'yes'}
    ]
  }
];

// ── Adapter interface ──────────────────────────────────────────────
// Replace the body of each function with fetch() calls to connect
// to a real backend (e.g. REST API, Supabase, Firebase).
// The rest of the app (app.js) only calls these functions.

const DB = (() => {
  function _load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || null; } catch { return null; }
  }
  function _save(data) {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  }
  function _init() {
    const existing = _load();
    if (!existing) { _save(SEED); return SEED; }
    return existing;
  }

  let _data = _init();

  return {
    /* ── Groups ── */
    getGroups()            { return JSON.parse(JSON.stringify(_data)); },
    getGroup(id)           { return JSON.parse(JSON.stringify(_data.find(g => g.id === id) || null)); },

    createGroup(group) {
      group.id = group.id || 'g-' + Date.now().toString(36);
      group.workers = group.workers || [];
      _data.push(group);
      _save(_data);
      return group.id;
    },

    updateGroup(id, patch) {
      const g = _data.find(x => x.id === id);
      if (g) { Object.assign(g, patch); _save(_data); }
    },

    deleteGroup(id) {
      _data = _data.filter(g => g.id !== id);
      _save(_data);
    },

    /* ── Workers ── */
    getWorkers(groupId) {
      const g = _data.find(x => x.id === groupId);
      return g ? JSON.parse(JSON.stringify(g.workers)) : [];
    },

    addWorker(groupId, worker) {
      const g = _data.find(x => x.id === groupId);
      if (!g) return null;
      worker.uid = worker.uid || 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      g.workers.push(worker);
      _save(_data);
      return worker.uid;
    },

    updateWorker(groupId, uid, patch) {
      const g = _data.find(x => x.id === groupId);
      if (!g) return;
      const idx = g.workers.findIndex(w => w.uid === uid);
      if (idx >= 0) { g.workers[idx] = { ...g.workers[idx], ...patch }; _save(_data); }
    },

    deleteWorker(groupId, uid) {
      const g = _data.find(x => x.id === groupId);
      if (!g) return;
      g.workers = g.workers.filter(w => w.uid !== uid);
      _save(_data);
    },

    /* ── Stats ── */
    getAllStats() {
      return _data.map(g => ({
        id: g.id,
        name: g.name,
        count: g.workers.length,
        expiring: g.workers.filter(w => {
          const d = _parseDate(w.passport_expiry);
          return d && (d - Date.now()) < 2 * 365.25 * 864e5;
        }).length
      }));
    },

    /* ── Reset (dev only) ── */
    resetToSeed() { _data = JSON.parse(JSON.stringify(SEED)); _save(_data); }
  };

  function _parseDate(s) {
    if (!s) return null;
    const p = s.replace(/-/g, '/').split('/');
    if (p.length < 3) return null;
    return new Date(+p[2], +p[1] - 1, +p[0]);
  }
})();
