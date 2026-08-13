/**
 * import-report.js — what the import actually did, and what to do about it.
 *
 * An import used to end with a toast, which is the wrong shape for this
 * information: a toast is gone in four seconds and cannot be acted on. This
 * screen opens by itself when the result is INCOMPLETE, because a warning
 * nobody goes looking for is a warning nobody reads, and it carries the two
 * buttons that close the gap — retry the uploads that failed, and identify the
 * pictures the classifier could not.
 *
 * Reads `getLastImportReport()` from pptx-import.js; writes nothing except the
 * history and, when a human identifies a photograph, that one worker's photo.
 */

const IMPORT_LOG_KEY  = 'import_log';
const IMPORT_LOG_KEEP = 40;

/** Append a report to the history. Live handles (keys starting `_`) are
 *  stripped: the log is a record, not a resumable job, and a stored zip would
 *  never be reopened. */
function _saveImportLog(rep) {
  try {
    const slim = JSON.parse(JSON.stringify(rep, (k, v) => (k.charAt(0) === '_' ? undefined : v)));
    const log = DB.getSetting(IMPORT_LOG_KEY, []) || [];
    log.unshift(slim);
    DB.setSetting(IMPORT_LOG_KEY, log.slice(0, IMPORT_LOG_KEEP));
  } catch (e) { console.warn('[import] could not write the log:', e && e.message); }
}

function _irChip(label, n, tone) {
  return '<span class="ir-chip' + (tone ? ' ir-' + tone : '') + '">' + esc(label) + '<b>' + n + '</b></span>';
}

const _IR_OK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
const _IR_BAD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

/** The summary screen. */
function openImportReport() {
  const r = getLastImportReport();
  if (!r) return;
  const man = r.manifest;
  const ok = r.complete;

  const icon = document.getElementById('ir-icon');
  if (icon) icon.innerHTML = ok ? _IR_OK_ICON : _IR_BAD_ICON;

  const title = document.getElementById('ir-title');
  if (title) {
    title.textContent = ok
      ? bi('ນຳເຂົ້າຄົບ', 'Import complete', 'นำเข้าครบ', '가져오기 완료')
      : bi('ນຳເຂົ້າບໍ່ຄົບ', 'Import incomplete', 'นำเข้าไม่ครบ', '가져오기 미완료');
    title.className = ok ? 'ir-ok' : 'ir-bad';
  }
  const sub = document.getElementById('ir-sub');
  if (sub) sub.textContent = (r.file || '') + ' → ' + (r.groupName || '');

  let body = '<div class="ir-block">' +
    '<div class="ir-row"><span>' + esc(bi('ເພີ່ມແລ້ວ', 'Records added', 'เพิ่มแล้ว', '추가됨')) +
      '</span><b>' + r.added + '</b></div>' +
    (r.skipped ? '<div class="ir-row"><span>' + esc(bi('ຂ້າມ', 'Skipped', 'ข้าม', '건너뜀')) +
      '</span><b>' + r.skipped + '</b></div>' : '') +
  '</div>';

  if (man) {
    /* The accounting line, in the shape the contract is written in: every
       picture the deck holds, what each was judged to be, and whether the two
       totals agree. */
    const chips = ['PERSON', 'FACEBOOK', 'LOGO', 'OTHER', 'UNKNOWN']
      .map(c => _irChip(c, man.counts[c] || 0, (c === 'UNKNOWN' && man.counts[c]) ? 'warn' : ''))
      .join('');
    const agree = man.accounted === man.detected;
    body += '<div class="ir-block">' +
      '<div class="ir-head">' + esc(bi('ບັນຊີຮູບ', 'Picture accounting', 'บัญชีรูป', '사진 집계')) + '</div>' +
      '<div class="ir-chips">' + chips + '</div>' +
      '<div class="ir-total ' + (agree ? 'ir-ok' : 'ir-bad') + '">Detected ' + man.detected +
        ' · Accounted ' + man.accounted + '/' + man.detected + (agree ? ' ✅' : ' ❌') + '</div>' +
      (man.orphans ? '<div class="ir-note">' + man.orphans + ' ' +
        esc(bi('ໄຟລ໌ໃນເດັກທີ່ບໍ່ມີສະໄລ້ໃຊ້', 'file(s) in the deck no slide uses',
               'ไฟล์ในเด็คที่ไม่มีสไลด์ไหนใช้', '어떤 슬라이드도 쓰지 않는 파일')) + '</div>' : '') +
      ((man.problems || []).length
        ? '<div class="ir-note ir-bad">' + esc(man.problems.join('; ')) + '</div>' : '') +
    '</div>';
  }

  if (r.docFail) {
    body += '<div class="ir-block ir-block-bad">' +
      '<div class="ir-head">' + esc(bi('ອັບໂຫລດບໍ່ສຳເລັດ', 'Uploads that failed', 'อัปโหลดไม่สำเร็จ', '업로드 실패')) +
        ' <b>' + r.docFail + '</b></div>' +
      '<div class="ir-note">' + esc(bi(
        'ຂໍ້ມູນເຂົ້າແລ້ວ ແຕ່ໄຟລ໌ເຫຼົ່ານີ້ຍັງບໍ່ຂຶ້ນ — ກົດລອງໃໝ່ ບໍ່ຕ້ອງນຳເຂົ້າໃໝ່ທັງໄຟລ໌',
        'The records are in; these files are not. Retry sends only them — the deck does not need importing again.',
        'ข้อมูลเข้าแล้ว แต่ไฟล์เหล่านี้ยังไม่ขึ้น — กดลองใหม่ ไม่ต้องนำเข้าใหม่ทั้งไฟล์',
        '레코드는 들어갔지만 이 파일들은 아직입니다. 재시도는 이 파일만 다시 보냅니다.')) + '</div>' +
    '</div>';
  }

  const unknown = (r._unknown || []).length;
  if (unknown) {
    body += '<div class="ir-block ir-block-warn">' +
      '<div class="ir-head">' + esc(bi('ຮູບທີ່ຍັງບໍ່ຮູ້', 'Unidentified pictures', 'รูปที่ยังระบุไม่ได้', '미확인 사진')) +
        ' <b>' + unknown + '</b></div>' +
      '<div class="ir-note">' + esc(bi(
        'ນັບຄົບແລ້ວ ແຕ່ຍັງບໍ່ຮູ້ວ່າແມ່ນຫຍັງ — ກວດເອງໄດ້',
        'Counted, but not identified. Reviewing them closes the gap.',
        'นับครบแล้ว แต่ยังไม่รู้ว่าเป็นอะไร — ตรวจเองได้',
        '집계는 되었지만 분류되지 않았습니다.')) + '</div>' +
      '<button class="exp-btn ir-inline" onclick="openImageReview()">' +
        esc(bi('ກວດຮູບ', 'Review pictures', 'ตรวจรูป', '사진 검토')) + ' →</button>' +
    '</div>';
  }

  if ((r.noPhotoSlides || []).length) {
    body += '<div class="ir-block">' +
      '<div class="ir-head">' + esc(bi('ບໍ່ມີຮູບ', 'Without a photograph', 'ไม่มีรูป', '사진 없음')) +
        ' <b>' + r.noPhotoSlides.length + '</b></div>' +
      '<div class="ir-note">' + esc(bi('ສະໄລ້', 'slides', 'สไลด์', '슬라이드')) + ' ' +
        r.noPhotoSlides.join(', ') + '</div>' +
    '</div>';
  }

  const el = document.getElementById('ir-body');
  if (el) el.innerHTML = body;
  const retry = document.getElementById('ir-retry');
  if (retry) retry.style.display = r.docFail ? '' : 'none';
  openOverlay('importreport-overlay');
}

/**
 * Send the failed uploads again — only those, not the deck.
 *
 * The jobs are the same objects the pool ran, so a retry is the identical call
 * with the identical bytes: nothing is re-parsed and no record is written
 * twice. It needs the zip still open, which it is until another file is
 * chosen; if it has gone, the button says so rather than failing quietly.
 */
async function retryFailedUploads() {
  const r = getLastImportReport();
  if (!r || !(r._failed || []).length) return;
  const zip = getImportZip();
  const jobs = r._failed.slice();

  if (jobs.some(j => j.media) && !zip) {
    toast(bi('ໄຟລ໌ຖືກປິດແລ້ວ — ຕ້ອງນຳເຂົ້າໃໝ່',
             'The deck is no longer open — import it again to recover these',
             'ไฟล์ถูกปิดแล้ว — ต้องนำเข้าใหม่',
             '덱이 닫혔습니다 — 다시 가져오세요'), 'warn');
    return;
  }

  closeOverlay('importreport-overlay');
  _progressShow(bi('ກຳລັງລອງໃໝ່', 'Retrying', 'กำลังลองใหม่', '재시도 중'));
  const res = await _importPool(jobs, 4,
    job => (job.media ? _importUploadPic(job, r.group, zip)
                      : _importUploadDoc(job.uid, r.group, job.cat, job.file)),
    async (n) => { _progressSet(n / jobs.length * 100, n + '/' + jobs.length); });
  _progressDone();

  r._failed = res.failed || [];
  r.docFail = r._failed.length;
  r.complete = r.docFail === 0 &&
    (!r.manifest || (r.manifest.accounted === r.manifest.detected && !(r.manifest.problems || []).length));
  _saveImportLog(r);

  try { await DB.init(); } catch (e) {}
  refreshAll();
  toast(res.ok + ' ' + bi('ສຳເລັດ', 'recovered', 'สำเร็จ', '복구됨') +
        (res.fail ? ', ' + res.fail + ' ' + bi('ຍັງພາດ', 'still failing', 'ยังพลาด', '여전히 실패') : ''),
        res.fail ? 'warn' : 'ok');
  openImportReport();
}

/* ── Human review ──
 * The classifier answers UNKNOWN when it genuinely cannot tell: an SVG has no
 * pixel ratio to measure, a broken reference has no file at all. That is an
 * honest answer and it keeps the accounting whole, but it leaves a picture
 * nobody has looked at. This is the looking. */
let _rvQueue = [], _rvAt = 0;

function openImageReview() {
  const r = getLastImportReport();
  _rvQueue = (r && r._unknown) ? r._unknown.slice() : [];
  _rvAt = 0;
  if (!_rvQueue.length) {
    toast(bi('ບໍ່ມີຮູບຄ້າງ', 'Nothing to review', 'ไม่มีรูปค้าง', '검토할 항목 없음'), 'ok');
    return;
  }
  closeOverlay('importreport-overlay');
  openOverlay('imgreview-overlay');
  _rvRender();
}

async function _rvRender() {
  const body = document.getElementById('rv-body');
  const foot = document.getElementById('rv-foot');
  const sub  = document.getElementById('rv-sub');
  if (!body) return;

  if (_rvAt >= _rvQueue.length) {
    body.innerHTML = '<div class="rv-done">' +
      esc(bi('ກວດຄົບແລ້ວ', 'All reviewed', 'ตรวจครบแล้ว', '모두 검토됨')) + '</div>';
    if (foot) foot.innerHTML = '<button class="exp-btn" onclick="closeOverlay(\'imgreview-overlay\');openImportReport()">' +
      esc(bi('ກັບໄປລາຍງານ', 'Back to the report', 'กลับไปหน้ารายงาน', '보고서로')) + '</button>';
    if (sub) sub.textContent = '';
    return;
  }

  const u = _rvQueue[_rvAt];
  if (sub) sub.textContent = (_rvAt + 1) + ' / ' + _rvQueue.length + '  ·  ' +
    bi('ສະໄລ້', 'slide', 'สไลด์', '슬라이드') + ' ' + u.slide;

  let img = '<div class="rv-noimg">' +
    esc(bi('ເປີດຮູບບໍ່ໄດ້', 'This picture cannot be shown', 'เปิดรูปไม่ได้', '표시할 수 없음')) +
    '<span>' + esc(u.why || '') + '</span></div>';
  const zip = getImportZip();
  if (zip && u.media && zip.files[u.media]) {
    try {
      const b64 = await zip.files[u.media].async('base64');
      const ext = (u.media.split('.').pop() || '').toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'svg' ? 'image/svg+xml'
                 : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      img = '<img class="rv-img" alt="" src="data:' + mime + ';base64,' + b64 + '">';
    } catch (e) { /* keep the placeholder */ }
  }

  body.innerHTML = img + '<div class="rv-meta">' +
    esc(u.media || bi('ບໍ່ມີໄຟລ໌', 'no file', 'ไม่มีไฟล์', '파일 없음')) + '</div>';

  if (foot) foot.innerHTML =
    '<button class="exp-btn" onclick="reviewDecide(\'PERSON\')">' +
      esc(bi('ຄົນ', 'Person', 'รูปคน', '사람')) + '</button>' +
    '<button class="exp-btn exp-btn-ghost" onclick="reviewDecide(\'LOGO\')">' +
      esc(bi('ໂລໂກ້', 'Logo', 'โลโก้', '로고')) + '</button>' +
    '<button class="exp-btn exp-btn-ghost" onclick="reviewDecide(\'OTHER\')">' +
      esc(bi('ອື່ນໆ', 'Other', 'อื่นๆ', '기타')) + '</button>';
}

/**
 * Record a human answer for one picture.
 *
 * PERSON is the only answer that changes data — the picture becomes that
 * worker's photograph. LOGO and OTHER close the question and nothing else:
 * there is nothing to attach them to, and inventing a document for a company
 * logo would be worse than leaving it out.
 */
async function reviewDecide(cls) {
  const u = _rvQueue[_rvAt];
  if (!u) return;
  const r = getLastImportReport();
  u.class = cls;
  u.confidence = 1;
  u.why = 'reviewed by ' + ((DB.getCurrentUser() || {}).username || 'user');

  if (cls === 'PERSON') {
    const zip = getImportZip();
    const g = r && r.group ? DB.getGroup(r.group) : null;
    const w = g && (g.workers || []).find(x => x._slideNo === u.slide);
    if (zip && w && u.media && zip.files[u.media]) {
      try {
        const b64 = await zip.files[u.media].async('base64');
        await DB.patchWorkerNow(r.group, w.uid, { photo: 'data:image/jpeg;base64,' + b64 });
        toast(bi('ບັນທຶກແລ້ວ', 'Saved as the photograph', 'บันทึกเป็นรูปแล้ว', '사진으로 저장됨'), 'ok');
      } catch (e) {
        toast(bi('ບັນທຶກບໍ່ໄດ້', 'Could not save', 'บันทึกไม่ได้', '저장 실패'), 'warn');
      }
    } else {
      /* The slide→record link only exists during the import that created them.
         Afterwards the honest thing is to say so, not to guess a record. */
      toast(bi('ໝາຍແລ້ວ ແຕ່ຫາເຈົ້າຂອງບໍ່ພົບ',
               'Marked, but there is no record on that slide to attach it to',
               'ทำเครื่องหมายแล้ว แต่ไม่พบเจ้าของบนสไลด์นั้น',
               '표시했지만 연결할 레코드가 없습니다'), 'warn');
    }
  }

  if (r && r.manifest) {
    r.manifest.counts.UNKNOWN = Math.max(0, (r.manifest.counts.UNKNOWN || 0) - 1);
    r.manifest.counts[cls] = (r.manifest.counts[cls] || 0) + 1;
    _saveImportLog(r);
  }
  _rvAt++;
  _rvRender();
}

/** Every import this workspace has run, newest first. */
function openImportLog() {
  const log = DB.getSetting(IMPORT_LOG_KEY, []) || [];
  const body = document.getElementById('ir-body');
  const title = document.getElementById('ir-title');
  const sub = document.getElementById('ir-sub');
  const icon = document.getElementById('ir-icon');
  if (icon) icon.innerHTML = _IR_OK_ICON;
  if (title) {
    title.textContent = bi('ປະຫວັດການນຳເຂົ້າ', 'Import history', 'ประวัตินำเข้า', '가져오기 기록');
    title.className = '';
  }
  if (sub) sub.textContent = log.length + ' ' + bi('ຄັ້ງ', 'imports', 'ครั้ง', '회');
  const retry = document.getElementById('ir-retry');
  if (retry) retry.style.display = 'none';
  if (!body) return;

  body.innerHTML = log.length ? log.map(r => {
    const m = r.manifest;
    return '<div class="ir-log' + (r.complete ? '' : ' ir-block-bad') + '">' +
      '<div class="ir-log-top"><b>' + esc(r.file || '—') + '</b>' +
        '<span class="' + (r.complete ? 'ir-ok' : 'ir-bad') + '">' +
          (r.complete ? 'COMPLETE' : 'INCOMPLETE') + '</span></div>' +
      '<div class="ir-note">' + esc(new Date(r.at).toLocaleString()) +
        ' · ' + esc(r.groupName || '') + ' · +' + r.added +
        (m ? ' · ' + m.accounted + '/' + m.detected : '') +
        (r.docFail ? ' · ' + bi('ພາດ', 'failed', 'พลาด', '실패') + ' ' + r.docFail : '') +
      '</div></div>';
  }).join('') : '<div class="ir-note">' + esc(bi('ຍັງບໍ່ມີ', 'Nothing yet', 'ยังไม่มี', '없음')) + '</div>';
  openOverlay('importreport-overlay');
}
