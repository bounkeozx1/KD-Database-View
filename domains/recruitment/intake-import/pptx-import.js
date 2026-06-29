/**
 * pptx-import.js — Parse a PPTX file (KD worker card format) in the browser.
 *
 * Each worker card slide has the following text blocks (extracted in order):
 *   Line 0 : "VK/DY2026-001  A  B+  B-  C"     → worker_id + blood checkboxes
 *   Table 0 : supervisor | seq                   → group_supervisor
 *   Table rows: label | value pairs              → all other fields
 *
 * Depends on JSZip (loaded from CDN in index.html).
 */

/* ── Public API ──────────────────────────────────────────────────── */

/**
 * Parse a PPTX ArrayBuffer → array of worker objects ready for DB.addWorker().
 * Returns { groupMeta, workers } where groupMeta is from the first slide.
 */
async function parsePptxWorkers(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);

  // Gather slide XML files in order
  const slideFiles = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/\d+/)[0]);
      const nb = parseInt(b.match(/\d+/)[0]);
      return na - nb;
    });

  const groupMeta = {};
  const workers = [];

  for (let si = 0; si < slideFiles.length; si++) {
    const xmlStr = await zip.files[slideFiles[si]].async('text');
    const parsed = _parseSlide(xmlStr, si);
    if (parsed === null) continue;
    if (parsed._type === 'group_header') {
      Object.assign(groupMeta, parsed);
    } else if (parsed._type === 'worker') {
      workers.push(parsed);
    }
  }

  return { groupMeta, workers };
}

/* ── Slide parser ────────────────────────────────────────────────── */

function _parseSlide(xmlStr, slideIndex) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, 'application/xml');

  // Extract texts — table rows joined with |, other shapes line by line
  const allText = _extractTexts(doc);
  if (!allText.length) return null;

  // Group header slide: contains route info, no Passport No
  if (slideIndex === 0 ||
      (allText.some(t => /VTE|ICN|ICH/.test(t)) &&
       !allText.some(t => /Passport\s*No|ເລກທີພາສປອດ/i.test(t)))) {
    return _parseGroupHeader(allText);
  }

  // Worker slide
  const hasPassport = allText.some(t => /Passport\s*No|ເລກທີພາສປອດ/i.test(t));
  const hasWorkerId = allText.some(t => /[A-Z]{1,5}\/\s*DY\d{4}/i.test(t));
  if (!hasPassport && !hasWorkerId) return null;

  return _parseWorkerSlide(allText);
}

/**
 * Extract text from a slide XML document.
 * - Table rows  → "Cell1 | Cell2 | Cell3"  (mirrors the Python parser)
 * - Other shapes → one entry per paragraph
 *
 * This is the critical fix: previously ALL <a:p> elements were read in flat
 * document order, so table cells never got the `|` separator that the field
 * parser relies on.
 */
function _extractTexts(doc) {
  const A  = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const P  = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const out = [];

  // Helper: get full text of a single <a:p> element
  function paraText(p) {
    let s = '';
    const runs = p.getElementsByTagNameNS(A, 'r');
    if (runs.length) {
      for (const r of runs) {
        const t = r.getElementsByTagNameNS(A, 't')[0];
        if (t) s += t.textContent;
      }
    } else {
      // Some writers put <a:t> directly under <a:p>
      const ts = p.getElementsByTagNameNS(A, 't');
      for (const t of ts) s += t.textContent;
    }
    return s.trim();
  }

  // Helper: get full text of a table cell <a:tc>
  function cellText(tc) {
    const paras = tc.getElementsByTagNameNS(A, 'p');
    return Array.from(paras).map(paraText).filter(Boolean).join(' ');
  }

  // Walk top-level shapes in order
  const spTree = doc.getElementsByTagNameNS(P, 'spTree')[0] ||
                 doc.querySelector('spTree');
  if (!spTree) return out;

  for (const child of spTree.children) {
    const tag = child.localName;

    // ── Regular text shape (<p:sp>) ──
    // IMPORTANT: title shapes use <p:txBody> (P namespace),
    // while some writers use <a:txBody> (A namespace). Try both.
    if (tag === 'sp') {
      const txBody = (child.getElementsByTagNameNS(P, 'txBody')[0]) ||
                     (child.getElementsByTagNameNS(A, 'txBody')[0]);
      if (!txBody) continue;
      const paras = txBody.getElementsByTagNameNS(A, 'p');
      for (const p of paras) {
        const txt = paraText(p);
        if (txt) out.push(txt);
      }
      continue;
    }

    // ── Table frame (<p:graphicFrame>) ──
    if (tag === 'graphicFrame') {
      const tbl = child.getElementsByTagNameNS(A, 'tbl')[0];
      if (!tbl) continue;
      const rows = tbl.getElementsByTagNameNS(A, 'tr');
      for (const row of rows) {
        const cells = row.getElementsByTagNameNS(A, 'tc');
        // Join all non-empty cells with ' | ' — same as Python parser
        const rowTexts = Array.from(cells)
          .map(cellText)
          .filter(Boolean);
        if (rowTexts.length) out.push(rowTexts.join(' | '));
      }
      continue;
    }

    // ── Group shape (<p:grpSp>) — recurse into children ──
    if (tag === 'grpSp') {
      const inner = child.querySelectorAll
        ? child.querySelectorAll('sp, graphicFrame')
        : [];
      for (const el of inner) {
        if (el.localName === 'sp') {
          const tb = el.getElementsByTagNameNS(P, 'txBody')[0] ||
                     el.getElementsByTagNameNS(A, 'txBody')[0];
          if (!tb) continue;
          for (const p of tb.getElementsByTagNameNS(A, 'p')) {
            const txt = paraText(p);
            if (txt) out.push(txt);
          }
        }
      }
    }
  }

  return out;
}

function _parseGroupHeader(texts) {
  const meta = { _type: 'group_header' };

  // Try to pull route: VTE 26/03/2026 - ICN 27/03/2026
  const routeText = texts.find(t => /VTE|ICN|ICH/.test(t) && /\d{2}\/\d{2}\/\d{4}/.test(t));
  if (routeText) {
    const dates = routeText.match(/\d{2}\/\d{2}\/\d{4}/g);
    if (dates && dates[0]) meta.departure = dates[0];
    const routeMatch = routeText.match(/([A-Z]{3})\s+\d.*[-–]\s*([A-Z]{3})/);
    if (routeMatch) meta.route = routeMatch[1] + ' → ' + routeMatch[2];
  }

  // Group name: first substantial text
  const name = texts.find(t => /DAMYANG|GROUPS?/i.test(t) && t.length > 3);
  if (name) meta.name = name.trim();

  return meta;
}

function _parseWorkerSlide(texts) {
  const w = { _type: 'worker' };

  // ── Worker ID (title line, first match) ──
  for (const t of texts) {
    const m = t.match(/([A-Z]{1,5})\s*\/\s*(DY\d{4}[-–]\d{3})/);
    if (m) {
      w.worker_id    = m[1] + '/' + m[2].replace('–', '-');
      w.employer_code = m[1];
      break;
    }
  }

  // ── Parse all pipe-separated rows ──
  // After the JS fix, table rows arrive as "Label | Value" or "Label | Val1 | Val2".
  // Labels can be bilingual in one cell: "Date of birth ວັນເດືອນປີເກີດ"
  for (const raw of texts) {
    if (!raw.includes('|')) continue;
    const parts = raw.split('|').map(s => s.trim());
    const label = parts[0];
    const val   = parts[1] || '';
    const val2  = parts[2] || '';

    // ── Name (EN) ──
    if (/Name.*ຊື່|Name\/ຊື່/.test(label) && val) {
      w.en_name = val.toUpperCase(); continue;
    }
    // ── Name (Lao) ──
    if (/ຊື່\s*ແລະ\s*ນາມສະກຸນ/.test(label) && val) {
      w.lo_name = val; continue;
    }
    // ── Date of birth ──
    if (/ວັນເດືອນປີເກີດ|Date of birth/i.test(label) && val) {
      w.dob = _normalizeDate(val); continue;
    }
    // ── Village ──
    if (/Village|ບ້ານ/.test(label) && val) {
      w.village = val; continue;
    }
    // ── Weight | Height  "Weight/Kg ; Height/Cm | 57Kg | 150Cm" ──
    if (/Weight.*Kg|Kg.*Height|Kg\s*;/i.test(label)) {
      const wm = val.match(/(\d+)/);  const hm = val2.match(/(\d+)/);
      if (wm) w.weight = wm[1];
      if (hm) w.height = hm[1];
      continue;
    }
    // ── Size ──
    if (/Size|ຂະຫນາດ/.test(label) && val) {
      w.size = val; continue;
    }
    // ── Hand (Left / Right) ──
    if (/ຊ້າຍຫຼືຂວາ|Left.*Right/i.test(label) && val) {
      w.hand = val; continue;
    }
    // ── Blood type ──
    if (/ກຸ[ບ່]?\s*ເລືອດ|Blood\s*clot/i.test(label) && val) {
      w.blood = val; continue;
    }
    // ── Passport issue date ──
    if (/ວັນເດືອນປີອອກພາສປອດ|Date of issue/i.test(label) && val) {
      w.passport_issue = _normalizeDate(val); continue;
    }
    // ── Passport number ──
    if (/ເລກທີພາສປອດ|Passport\s*No/i.test(label) && val) {
      w.passport_no = val.toUpperCase(); continue;
    }
    // ── Passport expiry date ──
    if (/ວັນເດືອນປີໝົດອາຍຸ|Date of expiry/i.test(label) && val) {
      w.passport_expiry = _normalizeDate(val); continue;
    }
    // ── Tel / Emergency ──
    if (/Tel.*ໂທ|ໂທ.*Emergency/i.test(label)) {
      const nums = parts.slice(1).filter(p => /0\d{2}/.test(p));
      if (nums[0] && !w.tel)     w.tel     = nums[0];
      if (nums[1] && !w.emg_tel) w.emg_tel = nums[1];
      continue;
    }
    // ── Supervisor: Korean characters + sequence like "1-1" ──
    if (/[가-힣]/.test(label) && /\d-\d/.test(val)) {
      if (!w.group_supervisor) w.group_supervisor = label;
      continue;
    }
    // ── Age (skip — we recalculate from DOB) ──
    // ── (anything else ignored) ──
  }

  // ── Fallback: Tel from any pipe-line containing phone numbers ──
  if (!w.tel) {
    for (const raw of texts) {
      if (!raw.includes('|')) continue;
      const parts = raw.split('|').map(s => s.trim());
      const nums = parts.filter(p => /^0\d{2}[\s\d-]{6,}$/.test(p));
      if (nums.length) {
        if (!w.tel)     w.tel     = nums[0];
        if (!w.emg_tel && nums[1]) w.emg_tel = nums[1];
        break;
      }
    }
  }

  // ── Couple flag ──
  w.couple  = texts.some(t => t.trim() === '부부' || /^\s*부부\s*\|/.test(t)) ? 'yes' : 'no';
  w.kr_city = '';
  w.la_city = '';
  w.uid     = undefined;
  return w;
}

/* ── Date normalizer ─────────────────────────────────────────────── */
// Accepts "DD/MM/YYYY", "DD/MM/YY", "D/M/YYYY", partial dates
function _normalizeDate(s) {
  if (!s) return '';
  s = s.trim().replace(/\s+/g, '');
  const parts = s.split('/');
  if (parts.length < 3) return s;
  let [d, m, y] = parts;
  d = d.padStart(2, '0');
  m = m.padStart(2, '0');
  if (y.length === 2) y = '20' + y;
  return d + '/' + m + '/' + y;
}

/* ════════════════════════════════════════════════════
   IMPORT UI
   ════════════════════════════════════════════════════ */

let _importData = null;  // { groupMeta, workers }  (workers may carry _doc for PDF/image)

function openImport() {
  if (!isAdmin()) return;
  document.getElementById('import-file').value = '';
  document.getElementById('import-preview').innerHTML = '';
  document.getElementById('import-status').textContent = '';
  document.getElementById('import-target-wrap').style.display = 'none';
  document.getElementById('import-newgroup-wrap').style.display = 'none';
  const ng = document.getElementById('import-newgroup-name'); if (ng) ng.value = '';
  document.getElementById('import-btn-go').disabled = true;
  _importData = null;
  openOverlay('import-overlay');
}

/* CSV header (normalised) → worker field key. Mirrors the Export column labels. */
const _CSV_KEYMAP = {
  workerid:'worker_id', id:'worker_id',
  enname:'en_name', 'name(en)':'en_name', englishname:'en_name', name:'en_name',
  laoname:'lo_name', 'name(lao)':'lo_name',
  sex:'sex', gender:'sex', dob:'dob', dateofbirth:'dob',
  blood:'blood', bloodtype:'blood', nationality:'nationality',
  passportno:'passport_no', passport:'passport_no',
  issue:'passport_issue', issuedate:'passport_issue',
  expiry:'passport_expiry', expirydate:'passport_expiry',
  visa:'visa_status', visastatus:'visa_status',
  village:'village', district:'district', province:'province',
  employer:'employer_code', employercode:'employer_code', supervisor:'group_supervisor',
  grade:'grade', couple:'couple',
  'weight(kg)':'weight', weight:'weight', 'height(cm)':'height', height:'height',
  size:'size', hand:'hand', tel:'tel', emergencytel:'emg_tel', emergency:'emg_tel',
};
function _csvNorm(s) { return (s || '').toLowerCase().replace(/[\s_./-]/g, ''); }

/* Parse a CSV string → array of cell-arrays (handles quoted fields + "" escapes). */
function _parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function _csvToWorkers(text) {
  const rows = _parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => _CSV_KEYMAP[_csvNorm(h)] || null);
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells.length || cells.every(c => !c.trim())) continue;
    const w = {};
    headers.forEach((key, i) => { if (key && cells[i] != null && cells[i] !== '') w[key] = cells[i].trim(); });
    if (Object.keys(w).length) out.push(w);
  }
  return out;
}
/* JSON export {groups,cities,users} OR array/{workers} → flat workers + groupMeta. */
function _jsonToImport(obj) {
  let workers = [], groupMeta = {};
  if (Array.isArray(obj)) workers = obj;
  else if (obj && Array.isArray(obj.groups)) {
    obj.groups.forEach(g => (g.workers || []).forEach(w => workers.push(w)));
    if (obj.groups.length === 1) groupMeta = { name: obj.groups[0].name, departure: obj.groups[0].departure, route: obj.groups[0].route };
  } else if (obj && Array.isArray(obj.workers)) workers = obj.workers;
  return { groupMeta, workers };
}
function _fileToDataUrlImport(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file);
  });
}

/* ── Full database bundle (.kdb) — receive what _doDatabaseBundle exported ──
 * Reads manifest.json + media/ binaries back, re-embedding photos & documents
 * as data: URLs so DB.addWorker rebuilds the group with images intact on this
 * server. Marked `full:true` so the importer keeps EVERY worker (no field is
 * required and duplicates are not dropped — it is a faithful restore). */
const _KDB_MIME = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp', pdf:'application/pdf' };
function _kdbMime(p) { return _KDB_MIME[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream'; }

async function _parseKdbBundle(arrayBuffer) {
  if (typeof JSZip === 'undefined') await _loadJSZip();
  const zip = await JSZip.loadAsync(arrayBuffer);
  const mf = zip.file('manifest.json');
  if (!mf) throw new Error('ไม่พบ manifest.json — ไฟล์นี้ไม่ใช่ฐานข้อมูล KD (.kdb)');
  const manifest = JSON.parse(await mf.async('text'));
  if (manifest.kind !== 'kd-database') throw new Error('ไฟล์ .kdb ไม่ถูกต้อง');

  async function toDataUrl(relPath) {
    if (!relPath) return '';
    const f = zip.file(relPath);
    if (!f) return '';
    const buf = await f.async('arraybuffer');
    const blob = new Blob([buf], { type: _kdbMime(relPath) });
    return await new Promise(resolve => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => resolve('');
      r.readAsDataURL(blob);
    });
  }

  const workers = [];
  for (const rec of (manifest.workers || [])) {
    const w = { ...rec };
    delete w.photo_file; delete w.photo_orig_file; delete w.documents_manifest;
    delete w.uid;   // let this server mint a fresh uid (avoid cross-server collisions)
    if (rec.photo_file)      w.photo      = await toDataUrl(rec.photo_file);
    if (rec.photo_orig_file) w.photo_orig = await toDataUrl(rec.photo_orig_file);
    if (Array.isArray(rec.documents_manifest) && rec.documents_manifest.length) {
      const docs = {};
      for (const dm of rec.documents_manifest) {
        const data = await toDataUrl(dm.file);
        if (!data) continue;
        (docs[dm.category] = docs[dm.category] || []).push({ name: dm.name || '', type: dm.type || 'image', data });
      }
      if (Object.keys(docs).length) w.documents = docs;
    }
    workers.push(w);
  }

  const gm = manifest.group || {};
  return {
    groupMeta: { name: gm.name, departure: gm.departure, route: gm.route },
    workers, full: true,
    docCats: Array.isArray(manifest.doc_cats) ? manifest.doc_cats : null,
  };
}

async function handleImportFile(input) {
  const file = input.files[0];
  if (!file) return;
  const statusEl = document.getElementById('import-status');
  const previewEl = document.getElementById('import-preview');
  statusEl.textContent = 'กำลังอ่านไฟล์…';
  previewEl.innerHTML = '';
  document.getElementById('import-btn-go').disabled = true;
  const name = (file.name || '').toLowerCase();

  try {
    if (name.endsWith('.kdb') || name.endsWith('.zip')) {
      if (typeof JSZip === 'undefined') { statusEl.textContent = 'กำลังโหลด JSZip…'; await _loadJSZip(); }
      _importData = await _parseKdbBundle(await file.arrayBuffer());
    } else if (name.endsWith('.csv')) {
      _importData = { groupMeta: {}, workers: _csvToWorkers(await file.text()) };
    } else if (name.endsWith('.json')) {
      _importData = _jsonToImport(JSON.parse(await file.text()));
    } else if (name.endsWith('.pdf') || (file.type || '').startsWith('image/')) {
      const dataUrl = await _fileToDataUrlImport(file);
      const type = name.endsWith('.pdf') ? 'pdf' : 'image';
      _importData = { groupMeta: {}, workers: [{
        en_name: (file.name || 'document').replace(/\.[^.]+$/, '').toUpperCase(),
        _doc: { cat: 'form_1', name: file.name || 'import', type, data: dataUrl },
      }] };
    } else {
      if (typeof JSZip === 'undefined') { statusEl.textContent = 'กำลังโหลด JSZip…'; await _loadJSZip(); }
      _importData = await parsePptxWorkers(await file.arrayBuffer());
    }

    const { groupMeta, workers } = _importData;
    if (!workers || !workers.length) { statusEl.textContent = 'ไม่พบข้อมูลในไฟล์นี้'; return; }

    _fillImportTargets(groupMeta.name);
    // A full .kdb restore rebuilds a whole group → default to a fresh group.
    if (_importData.full) {
      const sel = document.getElementById('import-target-group');
      if (sel && [...sel.options].some(o => o.value === '__new')) { sel.value = '__new'; onImportTargetChange(); }
    }
    statusEl.textContent = 'พบข้อมูล ' + workers.length + ' รายการ' + (_importData.full ? ' (ฐานข้อมูล + รูป)' : '');
    previewEl.innerHTML = _buildPreviewTable(workers);
    document.getElementById('import-btn-go').disabled = false;
  } catch (err) {
    statusEl.textContent = 'Error: ' + (err.message || String(err));
    console.error(err);
  }
}

/* Build the target-group dropdown: current group first, then others, then "new". */
function _fillImportTargets(suggestName) {
  const sel = document.getElementById('import-target-group');
  const groups = DB.getGroups();
  const active = (typeof activeGroupId !== 'undefined') ? activeGroupId : '';
  let html = '';
  const cur = groups.find(g => g.id === active);
  if (cur) html += '<option value="' + esc(cur.id) + '">' + esc(cur.name) + ' (ปัจจุบัน)</option>';
  html += groups.filter(g => g.id !== active).map(g =>
    '<option value="' + esc(g.id) + '">' + esc(g.name) + '</option>').join('');
  html += '<option value="__new">➕ สร้างกลุ่มใหม่...</option>';
  sel.innerHTML = html;
  const ng = document.getElementById('import-newgroup-name');
  if (ng && suggestName) ng.value = suggestName;
  document.getElementById('import-target-wrap').style.display = 'flex';
  onImportTargetChange();
}
function onImportTargetChange() {
  const v = document.getElementById('import-target-group').value;
  document.getElementById('import-newgroup-wrap').style.display = (v === '__new') ? 'flex' : 'none';
}

function _buildPreviewTable(workers) {
  const rows = workers.map((w, i) =>
    '<tr>' +
      '<td>' + (i + 1) + '</td>' +
      '<td><code>' + esc(w.worker_id || '--') + '</code></td>' +
      '<td>' + esc(w.en_name || '--') + '</td>' +
      '<td style="font-size:0.75rem;color:#666">' + esc(w.lo_name || '--') + '</td>' +
      '<td>' + esc(w.dob || '--') + '</td>' +
      '<td><code>' + esc(w.passport_no || '--') + '</code></td>' +
      '<td>' + esc(w.passport_expiry || '--') + '</td>' +
      '<td>' + esc(w.group_supervisor || '--') + '</td>' +
    '</tr>'
  ).join('');
  return '<div class="import-tbl-wrap"><table class="import-tbl">' +
    '<thead><tr><th>#</th><th>Worker ID</th><th>Name (EN)</th><th>Name (Lao)</th>' +
    '<th>DOB</th><th>Passport No</th><th>Expiry</th><th>Supervisor</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div>';
}

/* Merge document-category definitions carried inside a .kdb bundle into the
 * local (server-persisted) list. Non-destructive by design — importing one
 * group can only ADD categories, never strip another group's:
 *   • every existing category and its order is kept,
 *   • categories present only in the file are appended,
 *   • a missing or auto-derived "Document …" placeholder label is upgraded to
 *     the imported human label (mirrors _migrateDocCatsToServer's rules).
 * doc_cats is a single system-wide setting (not per-group), which is exactly why
 * we never overwrite or delete here. */
function _mergeImportedDocCats(incoming) {
  if (!Array.isArray(incoming) || !incoming.length) return false;
  if (typeof getDocCats !== 'function' || typeof DB === 'undefined') return false;
  let current = [];
  try { current = getDocCats(); } catch (e) {}
  const merged = (Array.isArray(current) ? current : []).slice();
  const byKey = new Map(merged.map((c, i) => [c && c.key, i]));
  let changed = false;
  incoming.forEach(ic => {
    if (!ic || !ic.key) return;
    if (byKey.has(ic.key)) {
      const idx = byKey.get(ic.key);
      const cur = merged[idx] || {};
      if (ic.label && ic.label !== cur.label &&
          (!cur.label || /^Document /.test(cur.label))) {
        merged[idx] = { ...cur, label: ic.label };
        changed = true;
      }
    } else {
      merged.push({ key: ic.key, label: ic.label || ic.key });
      byKey.set(ic.key, merged.length - 1);
      changed = true;
    }
  });
  if (changed) { try { DB.setSetting('doc_cats', merged); } catch (e) {} }
  return changed;
}

// ── Import upload helpers ─────────────────────────────────────────
// Upload ONE document with a few retries. Because each request now carries a
// single file (not every base64 image of a worker at once), it stays well under
// the client's 20s abort even on a slow remote like Railway — that all-in-one
// payload was exactly what used to time out, fail and stall the page.
async function _importUploadDoc(uid, groupId, cat, file, attempts) {
  attempts = attempts || 6;
  for (let i = 1; ; i++) {
    try { await DB.uploadDocument(uid, groupId, cat, file.data, file.name || ''); return true; }
    catch (e) {
      if (i >= attempts) return false;
      await new Promise(r => setTimeout(r, Math.min(8000, 500 * Math.pow(2, i))));
    }
  }
}
// Run `task` over `items` with at most `conc` in flight, calling onDone(n,ok,fail)
// as each settles so the progress bar can advance.
async function _importPool(items, conc, task, onDone) {
  let idx = 0, ok = 0, fail = 0;
  async function runner() {
    while (idx < items.length) {
      const it = items[idx++];
      if (await task(it)) ok++; else fail++;
      if (onDone) await onDone(ok + fail, ok, fail);
    }
  }
  const rs = [];
  for (let i = 0; i < Math.min(conc, items.length); i++) rs.push(runner());
  await Promise.all(rs);
  return { ok, fail };
}

async function doImport() {
  if (!isAdmin() || !_importData) return;
  const statusEl = document.getElementById('import-status');
  const btn = document.getElementById('import-btn-go');
  btn.disabled = true;

  const targetVal = document.getElementById('import-target-group').value;
  const { groupMeta, workers } = _importData;

  let groupId = targetVal;

  // Create a new group if chosen (name from the input, or PPTX/JSON header)
  if (targetVal === '__new' || targetVal === '_new') {
    const typed = (document.getElementById('import-newgroup-name')?.value || '').trim();
    groupId = DB.createGroup({
      name:      typed || groupMeta.name || 'Imported Group',
      departure: groupMeta.departure || '',
      route:     groupMeta.route || '',
    });
  }

  const isFull = !!_importData.full;
  // Restore custom document-category definitions FIRST, so each worker's
  // documents land under a category that already carries its real (custom) label
  // and order — and so the server-side self-heal never overwrites them with an
  // auto-derived "Document …" placeholder.
  _mergeImportedDocCats(_importData.docCats);
  const existingPassports = new Set(
    DB.getWorkers(groupId).map(w => w.passport_no).filter(Boolean)
  );

  // ── Plan who to add, and peel each record's documents off into a separate
  // upload list. Creating employees WITHOUT their base64 documents keeps every
  // create request tiny; sending one worker's whole image set in a single POST
  // is what blew past the 20s timeout and stalled the page on Railway.
  let added = 0, skipped = 0;
  const toCreate = [];   // { copy, docs:{cat:[file…]} }
  for (const w of workers) {
    const doc = w._doc;
    const copy = { ...w };
    delete copy._type; delete copy._doc; delete copy.full;
    // Keep anyone who carries ANY identifying data — previously a worker with
    // only a Lao name or only a Worker ID was silently dropped (59→55 problem).
    const hasIdentity = copy.en_name || copy.lo_name || copy.worker_id ||
                        copy.passport_no || copy.tel || copy.photo || copy.documents;
    if (!doc && !hasIdentity) { skipped++; continue; }
    // De-dupe by passport only for partial imports (CSV/PPTX merges). A full
    // .kdb restore is faithful — it keeps every record, duplicates included.
    if (!isFull && !doc && copy.passport_no && existingPassports.has(copy.passport_no)) { skipped++; continue; }

    const docs = {};
    if (copy.documents && typeof copy.documents === 'object') {
      Object.keys(copy.documents).forEach(cat =>
        (copy.documents[cat] || []).forEach(f => { if (f && f.data) (docs[cat] = docs[cat] || []).push(f); }));
    }
    if (doc && doc.data) (docs[doc.cat] = docs[doc.cat] || []).push({ name: doc.name, type: doc.type, data: doc.data });
    delete copy.documents;   // documents are uploaded separately in phase 2

    toCreate.push({ copy, docs });
    if (copy.passport_no) existingPassports.add(copy.passport_no);
    added++;
  }

  const totalDocs  = toCreate.reduce((n, r) => n + Object.values(r.docs).reduce((m, a) => m + a.length, 0), 0);
  const totalUnits = (toCreate.length + totalDocs) || 1;
  let done = 0, docFail = 0;

  // Block the UI + warn against closing the tab until everything is uploaded
  // (a media-heavy import can't be resumed after a reload — the base64 lives
  // only in this page — so the safest "survive a refresh" is to prevent one).
  closeOverlay('import-overlay');
  _progressShow(bi('ກຳລັງນຳເຂົ້າຂໍ້ມູນ', 'กำลังนำเข้าข้อมูล'));
  const _warn = (e) => { e.preventDefault(); e.returnValue = ''; return ''; };
  window.addEventListener('beforeunload', _warn);

  try {
    // ── Phase 1: create employees (tiny payloads) in batches, so the bar moves
    // and every row exists server-side before its documents go up.
    const BATCH = 15;
    for (let i = 0; i < toCreate.length; i += BATCH) {
      const slice = toCreate.slice(i, i + BATCH);
      slice.forEach(r => { r.uid = DB.addWorker(groupId, r.copy); });
      await DB.flush();   // wait for this batch's POSTs to actually reach the server
      done += slice.length;
      _progressSet(done / totalUnits * 100,
        bi('ສ້າງພະນັກງານ ', 'สร้างพนักงาน ') + Math.min(i + BATCH, toCreate.length) + '/' + toCreate.length);
      await _paint();
    }

    // ── Phase 2: upload documents one file at a time, a few in parallel, each
    // with its own retries. Slow/failed files retry on their own; survivors
    // never block the rest.
    const jobs = [];
    toCreate.forEach(r => Object.keys(r.docs).forEach(cat =>
      r.docs[cat].forEach(file => jobs.push({ uid: r.uid, cat, file }))));
    if (jobs.length) {
      const res = await _importPool(jobs, 4,
        job => _importUploadDoc(job.uid, groupId, job.cat, job.file),
        async (n) => {
          _progressSet((toCreate.length + n) / totalUnits * 100,
            bi('ອັບໂຫລດເອກະສານ ', 'อัปโหลดเอกสาร ') + n + '/' + jobs.length);
          if (n % 4 === 0) await _paint();
        });
      docFail = res.fail;
    }

    // ── Phase 3: pull the authoritative server state back (now with documents).
    _progressSet(99, bi('ກຳລັງໂຫລດຄືນ...', 'กำลังโหลดใหม่...'));
    try { await DB.init(); } catch (e) {}
  } finally {
    window.removeEventListener('beforeunload', _warn);
    _progressDone();
  }

  activeGroupId = groupId;
  refreshAll();
  if (statusEl) statusEl.textContent = '';
  if (typeof toast === 'function') {
    let msg = '✔ Import เสร็จ — เพิ่ม ' + added + ' รายการ';
    if (skipped) msg += ', ข้าม ' + skipped;
    if (docFail) msg += ', เอกสารพลาด ' + docFail;
    toast(msg, docFail ? 'warn' : 'ok');
  }
}

/* Load JSZip from the bundled vendor/ copy (offline — no CDN) */
function _loadJSZip() {
  return new Promise((resolve, reject) => {
    if (typeof JSZip !== 'undefined') return resolve();
    const s = document.createElement('script');
    s.src = new URL('../../vendor/jszip/jszip.min.js', location.href).href;
    s.onload  = resolve;
    s.onerror = () => reject(new Error('ไม่สามารถโหลด JSZip ได้ — ไฟล์ vendor/jszip/ หาย (ดู Deployment Checklist)'));
    document.head.appendChild(s);
  });
}
