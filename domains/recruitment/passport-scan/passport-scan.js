/**
 * passport-scan.js — Camera + Tesseract.js OCR + MRZ parser (v2)
 *
 * What changed from v1:
 *  - Pattern-based MRZ extraction (no longer requires exact 44-char lines)
 *  - OCR character substitution to fix common Tesseract errors
 *  - "Take Photo" manual-capture button (much more reliable than continuous scan)
 *  - Robust form filling: dispatches input/change events, checks form is open,
 *    shows a green highlight on every filled field, and logs all steps.
 *  - Multiple OCR passes: full image + MRZ-crop, different preprocessing
 *  - Shows raw OCR text for debugging
 *
 * MRZ format (TD3 — standard 34-page passport):
 *   Line 1: P<NNNSurname<<GivenNames<<<<<<<<<<<<<<<<<<<<<   (44 chars)
 *   Line 2: PassportNo(9)+chk+Nat(3)+DOB(6)+chk+Sex+Exp(6)+chk+...  (44 chars)
 */

/* ── State ───────────────────────────────────────────────────────── */
const SCAN = {
  stream:   null,   // MediaStream
  worker:   null,   // Tesseract worker
  timer:    null,   // auto-scan interval
  scanning: false,  // OCR in progress
  paused:   false,  // user paused
  found:    null,   // last successful parse
  attempts: 0,
  lastRaw:  '',     // last raw OCR text (for debugging)
};

/* ══════════════════════════════════════════════════════════════════
   PUBLIC API
   ══════════════════════════════════════════════════════════════════ */

async function openPassportScan() {
  if (!isAdmin()) return;

  // Reset
  SCAN.found    = null;
  SCAN.paused   = false;
  SCAN.attempts = 0;
  SCAN.lastRaw  = '';

  _scanUI('reset');
  openOverlay('scan-overlay');

  try {
    _scanSetStatus('กำลังเปิดกล้อง…', 'idle');
    await _scanStartCamera();
    _scanSetStatus('กำลังโหลด OCR engine (ครั้งแรกใช้เวลา ~10 วินาที)…', 'idle');
    await _scanInitWorker();
    _scanSetStatus('พร้อมแล้ว — กด 📸 ถ่ายภาพ หรือรอให้ระบบ scan อัตโนมัติ', 'scanning');
    _scanStartLoop();
  } catch (err) {
    _scanSetStatus('❌ ' + (err.message || String(err)), 'error');
    console.error('[Scan] init error:', err);
  }
}

function closePassportScan() {
  _scanStop();
  closeOverlay('scan-overlay');
}

/** Manual capture button */
async function scanCaptureNow() {
  if (SCAN.scanning) return;
  _scanSetStatus('กำลังประมวลผล…', 'scanning');
  await _scanProcessFrame(true); // forceFullImage = true
}

/** Pause / resume */
function scanTogglePause() {
  SCAN.paused = !SCAN.paused;
  const btn = document.getElementById('scan-pause-btn');
  if (btn) btn.textContent = SCAN.paused ? '▶ เล่นต่อ' : '⏸ หยุด';
  if (!SCAN.paused) {
    _scanSetStatus('กำลังสแกน…', 'scanning');
    _scanStartLoop();
  }
}

/**
 * Apply scan result to the worker form.
 * This is the critical function — must be bulletproof.
 */
function applyPassportScan() {
  const r = SCAN.found;

  if (!r) {
    console.warn('[Scan] applyPassportScan: SCAN.found is null — nothing to apply');
    _scanSetStatus('❌ ไม่มีข้อมูลที่จะกรอก — กรุณาสแกนใหม่', 'error');
    return;
  }

  console.log('[Scan] Applying to form:', JSON.stringify(r, null, 2));

  // ── Ensure the worker form is open ──
  const formOverlay = document.getElementById('form-overlay');
  if (formOverlay && !formOverlay.classList.contains('open')) {
    console.warn('[Scan] form-overlay was closed — reopening');
    formOverlay.classList.add('open');
  }

  // ── Helper: fill text input ──
  function fillText(fieldId, value) {
    if (!value) return false;
    const el = document.getElementById(fieldId);
    if (!el) { console.error('[Scan] Element not found:', fieldId); return false; }
    el.value = value;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // Green highlight
    el.style.outline = '2px solid #27ae60';
    el.style.backgroundColor = '#edfff4';
    setTimeout(() => {
      el.style.outline = '';
      el.style.backgroundColor = '';
    }, 3000);
    console.log('[Scan] ✓ Filled', fieldId, '=', value);
    return true;
  }

  // ── Helper: fill date picker (DD/MM/YYYY) ──
  function fillDate(dpId, dateStr) {
    if (!dateStr) return false;
    try {
      setDatePicker(dpId, dateStr);
      // Highlight the date picker wrapper
      const dp = document.getElementById(dpId);
      if (dp) {
        dp.style.outline = '2px solid #27ae60';
        dp.style.backgroundColor = '#edfff4';
        setTimeout(() => {
          dp.style.outline = '';
          dp.style.backgroundColor = '';
        }, 3000);
      }
      console.log('[Scan] ✓ Filled date', dpId, '=', dateStr);
      return true;
    } catch (e) {
      console.error('[Scan] ✗ Date fill error', dpId, e);
      return false;
    }
  }

  // ── Fill each field ──
  let count = 0;
  if (fillText('f-en-name',     r.fullName))    count++;
  if (fillText('f-passport-no', r.passportNo))  count++;
  if (fillText('f-nationality', r.nationality)) count++;
  if (fillDate('dp-dob',        r.dob))         count++;
  if (fillDate('dp-expiry',     r.expiry))      count++;
  // Gender (M/F) → select
  if (r.sex === 'M' || r.sex === 'F') {
    const sx = document.getElementById('f-sex');
    if (sx) { sx.value = r.sex; sx.dispatchEvent(new Event('change', { bubbles: true })); count++; }
  }

  // ── Auto document extraction ──
  if (SCAN.lastImage) {
    // File the full passport page under documents → Passport
    window._pendingScanDoc = { cat: 'passport', name: 'passport-scan.jpg', type: 'image', data: SCAN.lastImage };
  }
  // Cropped passport face photo → employee photo (if none set yet)
  if (SCAN.lastPhoto) {
    const photoEl = document.getElementById('f-photo');
    if (photoEl && !photoEl.value) {
      photoEl.value = SCAN.lastPhoto;
      if (typeof renderFormPhoto === 'function') renderFormPhoto();
      count++;
    }
  }

  console.log('[Scan] Total filled:', count);

  // ── Close scan overlay, keep form overlay open ──
  _scanStop();
  closeOverlay('scan-overlay');

  // Double-check form is still open after closing scan
  if (formOverlay && !formOverlay.classList.contains('open')) {
    formOverlay.classList.add('open');
  }

  // ── Success banner inside the form ──
  const formBody = document.querySelector('#form-overlay .form-body');
  if (formBody && count > 0) {
    // Remove any existing banner
    const existing = formBody.querySelector('.scan-fill-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.className = 'scan-fill-banner';
    banner.innerHTML = `
      <span style="font-size:1.1rem">✅</span>
      กรอกข้อมูลจากพาสปอร์ตอัตโนมัติ <strong>${count} ช่อง</strong>
      ${r.nationality ? `(สัญชาติ: ${esc(r.nationality)})` : ''}
    `;
    formBody.insertBefore(banner, formBody.firstChild);
    setTimeout(() => banner.remove(), 5000);
  }

  if (count === 0) {
    alert('ไม่สามารถกรอกข้อมูลได้ — กรุณาตรวจสอบ console log');
  }
}

/* ══════════════════════════════════════════════════════════════════
   CAMERA
   ══════════════════════════════════════════════════════════════════ */

async function _scanStartCamera() {
  const video = document.getElementById('scan-video');
  const constraints = [
    { video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } },
    { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } } },
    { video: true }
  ];

  for (const c of constraints) {
    try {
      SCAN.stream = await navigator.mediaDevices.getUserMedia(c);
      break;
    } catch (e) {
      if (c === constraints[constraints.length - 1]) throw e;
    }
  }

  video.srcObject = SCAN.stream;
  return new Promise((res, rej) => {
    video.onloadedmetadata = () => video.play().then(res).catch(rej);
    video.onerror = rej;
  });
}

function _scanStopCamera() {
  if (SCAN.stream) { SCAN.stream.getTracks().forEach(t => t.stop()); SCAN.stream = null; }
  const v = document.getElementById('scan-video');
  if (v) v.srcObject = null;
}

/* ══════════════════════════════════════════════════════════════════
   TESSERACT WORKER
   ══════════════════════════════════════════════════════════════════ */

// Local (offline) vendor location for Tesseract assets. Resolved relative to the
// current page so it works both over http(s) and when opened via file://.
function _tessVendorDir()  { return new URL('../../vendor/tesseract', location.href).href; }      // no trailing slash (langPath)
function _tessVendorFile(f) { return _tessVendorDir() + '/' + f; }

async function _scanInitWorker() {
  if (SCAN.worker) return;
  await _loadTesseractJS();

  // All paths point at the bundled vendor/ copies — NO network access required.
  SCAN.worker = await Tesseract.createWorker({
    workerPath: _tessVendorFile('worker.min.js'),
    corePath:   _tessVendorFile('tesseract-core.wasm.js'),
    langPath:   _tessVendorDir(),                 // serves eng.traineddata.gz locally
    logger: m => {
      if (m.status === 'recognizing text') {
        _scanSetStatus(`OCR ${Math.round((m.progress || 0) * 100)}%…`, 'scanning');
      }
    }
  });

  await SCAN.worker.loadLanguage('eng');
  await SCAN.worker.initialize('eng');
  // PSM 11 = sparse text (best for MRZ embedded in complex image)
  await SCAN.worker.setParameters({
    tessedit_pageseg_mode: '11',
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
    load_system_dawg: '0',
    load_freq_dawg: '0',
  });
}

async function _scanTerminateWorker() {
  if (SCAN.worker) { try { await SCAN.worker.terminate(); } catch (e) {} SCAN.worker = null; }
}

function _loadTesseractJS() {
  return new Promise((res, rej) => {
    if (typeof Tesseract !== 'undefined') return res();
    const s = document.createElement('script');
    s.src = _tessVendorFile('tesseract.min.js');   // bundled locally (offline)
    s.onload = res;
    s.onerror = () => rej(new Error('โหลด Tesseract.js ไม่ได้ — ไฟล์ vendor/tesseract/ หาย (ดู Deployment Checklist)'));
    document.head.appendChild(s);
  });
}

/* ══════════════════════════════════════════════════════════════════
   SCAN LOOP
   ══════════════════════════════════════════════════════════════════ */

function _scanStartLoop() {
  if (SCAN.timer) clearInterval(SCAN.timer);
  SCAN.timer = setInterval(async () => {
    if (!SCAN.paused && !SCAN.scanning) {
      SCAN.attempts++;
      await _scanProcessFrame(false);
    }
  }, 2000);
}

function _scanStop() {
  if (SCAN.timer) { clearInterval(SCAN.timer); SCAN.timer = null; }
  _scanStopCamera();
}

async function _scanProcessFrame(forceFullImage) {
  const video = document.getElementById('scan-video');
  if (!video || !video.videoWidth) return;

  // Live quality feedback. In auto mode, skip OCR on poor frames (saves CPU,
  // avoids garbage reads). A manual "capture" bypasses the gate.
  if (!forceFullImage) {
    const q = _assessQuality(video);
    if (!q.ok) {
      _scanSetStatus((q.msgKey === 'scan_q_blur' ? '🔍 ' : q.msgKey === 'scan_q_dark' ? '🔅 ' : '☀️ ') + t(q.msgKey), 'scanning');
      document.getElementById('scan-overlay-frame')?.classList.toggle('q-bad', true);
      return;
    }
    document.getElementById('scan-overlay-frame')?.classList.toggle('q-bad', false);
  }

  SCAN.scanning = true;
  try {
    let parsed = null;

    // Pass 1: MRZ crop (bottom 30%), scaled up — fastest
    const mrzCanvas = _cropMRZZone(video);
    const text1 = await _runOCR(mrzCanvas, '6');
    console.log('[Scan] MRZ crop OCR:', JSON.stringify(text1.substring(0, 200)));
    parsed = _parseMRZ(text1);

    // Pass 2: Full image — more context for line 1 (names)
    if (!parsed || forceFullImage) {
      const fullCanvas = _captureFullFrame(video);
      const text2 = await _runOCR(fullCanvas, '11');
      console.log('[Scan] Full image OCR:', JSON.stringify(text2.substring(0, 300)));
      SCAN.lastRaw = text2;
      const p2 = _parseMRZ(text2);
      if (p2 && (!parsed || _mrzScore(p2) > _mrzScore(parsed))) parsed = p2;
    }

    if (parsed) {
      SCAN.found  = parsed;
      SCAN.paused = true;
      // Capture the passport page image + crop the face photo
      try {
        SCAN.lastImage = _capturePlainFrame(video).toDataURL('image/jpeg', 0.8);
        SCAN.lastPhoto = _extractFacePhoto(video);
      } catch (e) { SCAN.lastImage = SCAN.lastImage || ''; }
      if (SCAN.timer) { clearInterval(SCAN.timer); SCAN.timer = null; }
      document.getElementById('scan-overlay-frame')?.classList.add('found');
      _scanSetStatus('✅ พบข้อมูล MRZ! ตรวจสอบด้านล่าง แล้วกด "ใช้ข้อมูลนี้"', 'found');
      _scanShowResult(parsed);
    } else {
      const dot = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'][SCAN.attempts % 10];
      _scanSetStatus(`${dot} กำลังสแกน… (ครั้งที่ ${SCAN.attempts}) — ถ่ายภาพด้วยปุ่มด้านล่าง`, 'scanning');
    }
  } catch (err) {
    console.error('[Scan] process error:', err);
    _scanSetStatus('⚠️ ' + (err.message || String(err)), 'error');
  } finally {
    SCAN.scanning = false;
  }
}

/* ══════════════════════════════════════════════════════════════════
   IMAGE CAPTURE & PREPROCESSING
   ══════════════════════════════════════════════════════════════════ */

/** Crop bottom 30% of frame = MRZ zone, scale up 3×, enhance contrast */
function _cropMRZZone(video) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const cropY = Math.floor(vh * 0.70);
  const cropH = vh - cropY;

  const raw = document.createElement('canvas');
  raw.width = vw; raw.height = cropH;
  raw.getContext('2d').drawImage(video, 0, cropY, vw, cropH, 0, 0, vw, cropH);

  return _enhanceCanvas(raw, 3.0);
}

/** Full video frame, scale up 2×, enhance (for OCR) */
function _captureFullFrame(video) {
  const raw = document.createElement('canvas');
  raw.width = video.videoWidth; raw.height = video.videoHeight;
  raw.getContext('2d').drawImage(video, 0, 0);
  return _enhanceCanvas(raw, 2.0);
}

/** Plain (un-enhanced, full-colour) frame — for storing the document image */
function _capturePlainFrame(video) {
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return c;
}

/**
 * Best-effort passport face-photo extraction.
 * On a TD3 data page the portrait sits in the upper-left quadrant. The user
 * aligns the page to the guide frame, so we crop that region by ratio from the
 * full colour frame. (Not face-detection — a pragmatic browser approach.)
 */
function _extractFacePhoto(video) {
  const vw = video.videoWidth, vh = video.videoHeight;
  // portrait region ratios (relative to the data page filling the frame)
  const x = vw * 0.05, y = vh * 0.10, w = vw * 0.30, h = vh * 0.52;
  const out = document.createElement('canvas');
  out.width = Math.round(w); out.height = Math.round(h);
  out.getContext('2d').drawImage(video, x, y, w, h, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.85);
}

/**
 * Lightweight image-quality assessment for live feedback.
 * Returns { brightness 0-255, blur (variance of Laplacian), ok, msgKey }.
 * Runs on a small grayscale downsample → cheap enough for every loop tick.
 */
function _assessQuality(video) {
  const W = 160, H = Math.round(W * (video.videoHeight / video.videoWidth || 0.66));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(video, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;

  // grayscale buffer + mean brightness
  const gray = new Float32Array(W * H);
  let sum = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    gray[p] = g; sum += g;
  }
  const brightness = sum / (W * H);

  // blur = variance of Laplacian (focus measure) over a central region
  let lapSum = 0, lapSq = 0, n = 0;
  for (let yy = 1; yy < H - 1; yy++) {
    for (let xx = 1; xx < W - 1; xx++) {
      const p = yy * W + xx;
      const lap = 4 * gray[p] - gray[p - 1] - gray[p + 1] - gray[p - W] - gray[p + W];
      lapSum += lap; lapSq += lap * lap; n++;
    }
  }
  const mean = lapSum / n;
  const blur = lapSq / n - mean * mean;   // variance — higher = sharper

  let ok = true, msgKey = 'scan_q_ok';
  if (brightness < 55)       { ok = false; msgKey = 'scan_q_dark'; }
  else if (brightness > 215) { ok = false; msgKey = 'scan_q_bright'; }
  else if (blur < 90)        { ok = false; msgKey = 'scan_q_blur'; }
  return { brightness, blur, ok, msgKey };
}

/** Grayscale + sigmoid contrast stretch → helps OCR read dark MRZ on light background */
function _enhanceCanvas(srcCanvas, scale) {
  const out = document.getElementById('scan-canvas') || document.createElement('canvas');
  out.width  = Math.round(srcCanvas.width  * scale);
  out.height = Math.round(srcCanvas.height * scale);

  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcCanvas, 0, 0, out.width, out.height);

  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d   = img.data;
  // Pass 1: grayscale + mean (so the contrast curve adapts to the actual lighting)
  let sum = 0; const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
    d[i] = g; sum += g;
  }
  const mean = sum / n;
  // Pass 2: sigmoid centred on the image mean → robust under dim/bright light
  for (let i = 0; i < d.length; i += 4) {
    const g = 255 / (1 + Math.exp(-0.085 * (d[i] - mean)));
    d[i] = d[i+1] = d[i+2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

async function _runOCR(canvas, psm) {
  if (!SCAN.worker) throw new Error('OCR worker not ready');
  // Override PSM per call if needed
  if (psm) {
    await SCAN.worker.setParameters({ tessedit_pageseg_mode: psm });
  }
  const { data: { text } } = await SCAN.worker.recognize(canvas);
  return text || '';
}

/* ══════════════════════════════════════════════════════════════════
   MRZ PARSER — Pattern-based (tolerant of OCR errors)
   ══════════════════════════════════════════════════════════════════ */

/**
 * Main entry point — tries multiple strategies in order of reliability.
 * Returns null if nothing found.
 */
function _parseMRZ(rawText) {
  if (!rawText || rawText.trim().length < 10) return null;

  // ── Strategy 1: Find two consecutive 44-char lines ──
  const s1 = _parseMRZByLines(rawText);
  if (s1) { console.log('[MRZ] Strategy 1 succeeded'); return s1; }

  // ── Strategy 2: Pattern search across the full concatenated OCR text ──
  const s2 = _parseMRZByPattern(rawText);
  if (s2) { console.log('[MRZ] Strategy 2 succeeded'); return s2; }

  // ── Strategy 3: Lenient single-line match (line 2 only) ──
  const s3 = _parseMRZLine2Only(rawText);
  if (s3) { console.log('[MRZ] Strategy 3 succeeded'); return s3; }

  return null;
}

/** Strategy 1: clean lines, find consecutive pair starting with P */
function _parseMRZByLines(rawText) {
  // Clean each line — keep only MRZ chars, apply OCR corrections
  const lines = rawText
    .split(/[\n\r]+/)
    .map(l => _cleanMRZLine(l))
    .filter(l => l.length >= 25);

  for (let i = 0; i < lines.length - 1; i++) {
    const l1 = _padTo(lines[i],   44);
    const l2 = _padTo(lines[i+1], 44);
    if (!l1.startsWith('P')) continue;

    const t2 = l2.substring(0, 44);
    if (_validLine2(t2)) {
      console.log('[MRZ] Found line pair at', i, ':', l1.substring(0,20), '|', t2.substring(0,20));
      return _extractFields(l1.substring(0,44), t2);
    }
  }
  return null;
}

/** Strategy 2: regex pattern search — key anchor is nationality+DOB+sex+expiry */
function _parseMRZByPattern(rawText) {
  // Collapse ALL whitespace first, then normalise noise → <
  // This joins split OCR lines without losing character sequence.
  const flat = rawText.toUpperCase()
    .replace(/\s+/g, '')           // join split lines
    .replace(/[^A-Z0-9<]/g, '<');  // noise → filler

  // Key insight: nationality (exactly 3 chars) immediately precedes DOB in TD3.
  // Using [A-Z0-9<]{3} avoids the "greedy digit eating" problem of a generic prefix.
  //
  // Pattern breakdown:
  //   [A-Z0-9<]{3}  = nationality (3 chars — includes OCR errors like LA0)
  //   \d{6}         = DOB (YYMMDD)
  //   \d            = DOB check digit
  //   [MF<]         = sex
  //   \d{6}         = expiry date (YYMMDD)
  //   \d            = expiry check digit
  const re = /([A-Z0-9<]{3})(\d{6})(\d)([MF<])(\d{6})(\d)/g;
  let match;

  while ((match = re.exec(flat)) !== null) {
    const natStr   = match[1]; // nationality (or OCR noise)
    const dobStr   = match[2];
    const dobChk   = parseInt(match[3], 10);
    const sex      = match[4];
    const expStr   = match[5];
    const expChk   = parseInt(match[6], 10);

    const dobOk = _checkDigit(dobStr) === dobChk;
    const expOk = _checkDigit(expStr) === expChk;

    // Require at least 1 valid check digit
    if (!dobOk && !expOk) continue;

    // Nationality starts at match.index.
    // Line 2 layout: passport(9) + check(1) + nationality(3) + ...
    // So passport no starts at match.index - 10.
    const natStart   = match.index;
    const line2Start = natStart - 10;

    let passportNo  = '';
    let nationality = natStr.replace(/</g, '').trim();

    if (line2Start >= 0) {
      const pre   = flat.substring(line2Start, natStart); // 10 chars
      passportNo  = pre.substring(0, 9).replace(/</g, '').trim();
      // Validate passport check digit too (bonus — tighten match confidence)
      const pChk = parseInt(pre.charAt(9), 10);
      if (!isNaN(pChk) && _checkDigit(pre.substring(0, 9)) !== pChk) {
        // passport check digit mismatch — only skip if dob also bad
        if (!dobOk) continue;
      }
    }

    // Try to find line 1 (names) — search backward from line2Start for "P<"
    let fullName = '', surname = '', givenNames = '';
    if (line2Start > 5) {
      const l1zone  = flat.substring(Math.max(0, line2Start - 60), line2Start);
      const pIdx    = l1zone.lastIndexOf('P<');
      if (pIdx >= 0) {
        const nameRaw = l1zone.substring(pIdx + 5); // skip "P<" + 3-char country
        const sep     = nameRaw.indexOf('<<');
        if (sep >= 0) {
          surname    = nameRaw.substring(0, sep).replace(/</g, ' ').trim();
          givenNames = nameRaw.substring(sep + 2).replace(/</g, ' ').trim();
          fullName   = (givenNames + ' ' + surname).trim();
        }
      }
    }

    return {
      passportNo,
      nationality,
      dob:       _mrzDate(dobStr, true),
      sex:       sex === 'M' ? 'M' : sex === 'F' ? 'F' : '',
      expiry:    _mrzDate(expStr, false),
      fullName:  fullName || null,
      surname,
      givenNames,
    };
  }

  return null;
}

/** Strategy 3: single line 2 (names unknown) */
function _parseMRZLine2Only(rawText) {
  const lines = rawText
    .split(/[\n\r]+/)
    .map(l => _cleanMRZLine(l))
    .filter(l => l.length >= 20);

  for (const l of lines) {
    const t2 = _padTo(l, 44).substring(0, 44);
    if (_validLine2(t2)) {
      return _extractFields(null, t2);
    }
  }
  return null;
}

/** Score a parse result (higher = more fields found) */
function _mrzScore(r) {
  let s = 0;
  if (r.passportNo)  s += 2;
  if (r.dob)         s += 2;
  if (r.expiry)      s += 2;
  if (r.fullName)    s += 3;
  if (r.nationality) s += 1;
  return s;
}

/* ── Line-level helpers ─────────────────────────────────────────── */

/**
 * Clean an OCR output line for MRZ matching.
 * KEY RULE: spaces are OCR word-segmentation artifacts — REMOVE them,
 * do NOT convert to '<'. Real '<' fillers in MRZ are read as characters
 * by Tesseract (they appear as '<' or similar glyphs, not as whitespace).
 */
function _cleanMRZLine(raw) {
  let s = raw.toUpperCase();
  s = s
    .replace(/\s+/g, '')       // ← remove spaces (NOT convert to <)
    .replace(/[,.\-_`]/g, '<') // punctuation that looks like < → filler
    .replace(/\|/g, 'I')       // pipe → I (common OCR error)
    .replace(/!/g, '1')        // exclamation → 1
    .replace(/[^A-Z0-9<]/g, ''); // drop any remaining unknown chars
  return s.trim();
}

/** Pad string with < to minimum length */
function _padTo(s, len) {
  while (s.length < len) s += '<';
  return s;
}

/** Check if a 44-char string looks like a valid MRZ line 2 */
function _validLine2(t2) {
  if (t2.length < 44) return false;
  // Must have valid DOB check digit OR valid expiry check digit
  const dobOk    = _checkDigit(t2.substring(13, 19)) === parseInt(t2.charAt(19), 10);
  const expiryOk = _checkDigit(t2.substring(21, 27)) === parseInt(t2.charAt(27), 10);
  const passOk   = _checkDigit(t2.substring(0, 9))   === parseInt(t2.charAt(9), 10);
  // Require at least 2 out of 3 check digits to be valid
  return [dobOk, expiryOk, passOk].filter(Boolean).length >= 2;
}

/* ── Check digit (ICAO Doc 9303) ──────────────────────────────── */
function _checkDigit(str) {
  const w = [7, 3, 1];
  const v = {};
  '<0123456789'.split('').forEach((c, i) => { v[c] = i === 0 ? 0 : i - 1; });
  for (let i = 0; i < 26; i++) v[String.fromCharCode(65 + i)] = 10 + i;
  let sum = 0;
  for (let i = 0; i < str.length; i++) sum += (v[str[i]] ?? 0) * w[i % 3];
  return sum % 10;
}

/* ── Field extraction ─────────────────────────────────────────── */
// Country/letter field: fix common OCR digit→letter confusions (LA0 → LAO)
function _lettersOnly(s) {
  return s.replace(/</g, '').trim()
    .replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S')
    .replace(/8/g, 'B').replace(/2/g, 'Z').replace(/[^A-Z]/g, '');
}
// Clean an MRZ name token: '<' → space, drop trailing filler garbage
// (Tesseract often reads the trailing '<' run as CCC/LLL/KKK).
function _cleanName(s) {
  let t = s.replace(/</g, ' ');
  t = t.replace(/([A-Z])\1{3,}.*$/, '');   // cut a run of 4+ identical letters and anything after
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/\s+[A-Z]$/, '');          // drop a trailing isolated single-letter (OCR filler noise)
  return t.trim();
}

function _extractFields(line1, line2) {
  const r = {};

  // From line 2
  r.passportNo  = line2.substring(0, 9).replace(/</g, '').trim();
  r.nationality = _lettersOnly(line2.substring(10, 13));
  r.dob         = _mrzDate(line2.substring(13, 19), true);
  r.sex         = line2.charAt(20) === 'M' ? 'M' : line2.charAt(20) === 'F' ? 'F' : '';
  r.expiry      = _mrzDate(line2.substring(21, 27), false);

  // From line 1 (names)
  if (line1) {
    const nameRaw = line1.substring(5, 44);
    const sep     = nameRaw.indexOf('<<');
    r.issuingCountry = _lettersOnly(line1.substring(2, 5));
    if (sep >= 0) {
      r.surname    = _cleanName(nameRaw.substring(0, sep));
      r.givenNames = _cleanName(nameRaw.substring(sep + 2));
      r.fullName   = (r.givenNames + ' ' + r.surname).trim();
    } else {
      r.fullName = _cleanName(nameRaw);
    }
  }

  return r;
}

/** YYMMDD → DD/MM/YYYY */
function _mrzDate(s, isPast) {
  if (!s || !/^\d{6}$/.test(s)) return '';
  const yy = parseInt(s.substring(0, 2), 10);
  const mm = s.substring(2, 4);
  const dd = s.substring(4, 6);
  const now = new Date().getFullYear() % 100;
  const yyyy = isPast
    ? (yy > now ? 1900 + yy : 2000 + yy)
    : (yy >= now ? 2000 + yy : 2100 + yy);
  return `${dd}/${mm}/${yyyy}`;
}

/* ══════════════════════════════════════════════════════════════════
   UI HELPERS
   ══════════════════════════════════════════════════════════════════ */

function _scanUI(action) {
  if (action === 'reset') {
    document.getElementById('scan-overlay-frame')?.classList.remove('found');
    document.getElementById('scan-result-box') && (document.getElementById('scan-result-box').style.display = 'none');
    const btn = document.getElementById('scan-apply-btn');
    if (btn) btn.disabled = true;
    const dbgBtn = document.getElementById('scan-debug-btn');
    if (dbgBtn) dbgBtn.style.display = 'none';
    const pauseBtn = document.getElementById('scan-pause-btn');
    if (pauseBtn) pauseBtn.textContent = '⏸ หยุด';
  }
}

function _scanSetStatus(msg, state) {
  const el = document.getElementById('scan-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'scan-status scan-status-' + (state || 'idle');
}

function _scanShowResult(r) {
  const box = document.getElementById('scan-result-box');
  const btn = document.getElementById('scan-apply-btn');
  if (!box) return;

  if (!r) { box.style.display = 'none'; if (btn) btn.disabled = true; return; }

  box.style.display = 'block';
  if (btn) btn.disabled = false;

  // Show debug button
  const dbgBtn = document.getElementById('scan-debug-btn');
  if (dbgBtn) dbgBtn.style.display = 'inline-flex';

  const rows = [
    ['ชื่อ-นามสกุล (EN)', r.fullName    || '— (ไม่พบ)'],
    ['เลขพาสปอร์ต',      r.passportNo  || '— (ไม่พบ)'],
    ['สัญชาติ',           r.nationality || '— (ไม่พบ)'],
    ['วันเกิด',           r.dob         || '— (ไม่พบ)'],
    ['เพศ',               r.sex === 'M' ? '♂ Male' : r.sex === 'F' ? '♀ Female' : '— (ไม่พบ)'],
    ['วันหมดอายุ',        r.expiry      || '— (ไม่พบ)'],
  ];

  box.innerHTML =
    '<div class="scan-result-title">📄 ข้อมูลที่อ่านได้จาก MRZ</div>' +
    '<table class="scan-result-tbl">' +
    rows.map(([lbl, val]) =>
      `<tr><td class="sr-label">${lbl}</td><td class="sr-val">${esc(String(val))}</td></tr>`
    ).join('') +
    '</table>';
}

/** Show raw OCR text for debugging */
function scanShowDebug() {
  const raw = SCAN.lastRaw || '(ยังไม่มีข้อมูล)';
  const win = window.open('', '_blank', 'width=600,height=400');
  if (win) {
    win.document.write(
      '<pre style="font:14px monospace;padding:16px;white-space:pre-wrap">' +
      raw.replace(/</g, '&lt;') +
      '</pre>'
    );
  } else {
    alert('RAW OCR:\n\n' + raw.substring(0, 500));
  }
}

/* Page unload: release worker */
window.addEventListener('beforeunload', () => _scanTerminateWorker());
