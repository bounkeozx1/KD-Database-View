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

let _importData = null;  // { groupMeta, workers }

function openImport() {
  if (!isAdmin()) return;
  document.getElementById('import-file').value = '';
  document.getElementById('import-preview').innerHTML = '';
  document.getElementById('import-status').textContent = '';
  document.getElementById('import-target-wrap').style.display = 'none';
  document.getElementById('import-btn-go').disabled = true;
  _importData = null;
  openOverlay('import-overlay');
}

async function handleImportFile(input) {
  const file = input.files[0];
  if (!file) return;
  const statusEl = document.getElementById('import-status');
  const previewEl = document.getElementById('import-preview');
  statusEl.textContent = 'กำลังอ่านไฟล์…';
  previewEl.innerHTML = '';
  document.getElementById('import-btn-go').disabled = true;

  try {
    if (typeof JSZip === 'undefined') {
      statusEl.textContent = 'กำลังโหลด JSZip…';
      await _loadJSZip();
    }
    const buf = await file.arrayBuffer();
    statusEl.textContent = 'กำลัง parse…';
    _importData = await parsePptxWorkers(buf);

    const { groupMeta, workers } = _importData;

    // Fill target group selector
    const sel = document.getElementById('import-target-group');
    const groups = DB.getGroups();
    sel.innerHTML = groups.map(g =>
      '<option value="' + esc(g.id) + '">' + esc(g.name) + '</option>'
    ).join('');
    // Add option to create new group from PPTX header
    if (groupMeta.name) {
      sel.innerHTML = '<option value="_new">' + esc(groupMeta.name) + ' (ใหม่)</option>' + sel.innerHTML;
    }
    document.getElementById('import-target-wrap').style.display = 'flex';

    // Preview table
    statusEl.textContent = 'พบข้อมูล ' + workers.length + ' คน';
    previewEl.innerHTML = _buildPreviewTable(workers);
    document.getElementById('import-btn-go').disabled = false;
  } catch (err) {
    statusEl.textContent = 'Error: ' + (err.message || String(err));
    console.error(err);
  }
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

async function doImport() {
  if (!isAdmin() || !_importData) return;
  const statusEl = document.getElementById('import-status');
  const btn = document.getElementById('import-btn-go');
  btn.disabled = true;

  const targetVal = document.getElementById('import-target-group').value;
  const { groupMeta, workers } = _importData;

  let groupId = targetVal;

  // Create new group from PPTX header if chosen
  if (targetVal === '_new') {
    groupId = DB.createGroup({
      name:      groupMeta.name || 'Imported Group',
      departure: groupMeta.departure || '',
      route:     groupMeta.route || '',
    });
  }

  let added = 0, skipped = 0;
  const existingPassports = new Set(
    DB.getWorkers(groupId).map(w => w.passport_no).filter(Boolean)
  );

  for (const w of workers) {
    if (!w.en_name && !w.passport_no) { skipped++; continue; }
    if (w.passport_no && existingPassports.has(w.passport_no)) { skipped++; continue; }
    const copy = { ...w };
    delete copy._type;
    DB.addWorker(groupId, copy);
    added++;
  }

  closeOverlay('import-overlay');
  activeGroupId = groupId;
  refreshAll();
  statusEl.textContent = '';

  // Flash message
  const bar = document.getElementById('count-bar');
  const orig = bar.innerHTML;
  bar.innerHTML = '<span style="color:#1a8a50;font-weight:700">✔ Import เสร็จ — เพิ่ม ' + added + ' คน' + (skipped ? ', ข้าม ' + skipped + ' (ซ้ำ/ว่าง)' : '') + '</span>';
  setTimeout(() => { if (bar.innerHTML.includes('Import')) bar.innerHTML = orig; refreshAll(); }, 3500);
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
