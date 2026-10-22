// TAGEX — split a scanned PDF into its FICA pages and the rest.
//
// A site pack is often one scan: the job card, the CoC and the drawings, with the owner's ID and
// a bank statement somewhere in the middle. Site Information refuses the whole file, rightly, and
// that leaves the person with a PDF they cannot file anywhere. This takes it apart:
//
//   1. Every page is rendered here, in the browser (pdfpages.js). Nothing is uploaded to do it.
//   2. Each page picture is sent to /api/fica-docs to be read. That route writes nothing and
//      returns a verdict per page -- never the text, which on an ID page is the ID number.
//   3. The person looks at every page and confirms which are FICA. A page the reader could not
//      make out starts as FICA: unreadable never clears (the rule in api/siteinfo-upload.js).
//   4. FICA pages are filed in the restricted FICA Documents table against a site, one record
//      for the source PDF, one PDF per page. Only someone holding the restricted-personal double
//      gate can do that. Anyone else is told so, and those pages are dropped -- never uploaded.
//   5. The other pages are put back into PDFs and handed to the ordinary import routes
//      (siteinfo-batch.js), which check every file again on the server exactly as if dropped.
//
// The verdicts are a reader's guess and are shown as one. Tesseract does not read handwriting.

(function () {
  'use strict';

  const $ = TX.$;
  const esc = TX.esc;

  // One classify request carries at most this many raw bytes of page pictures: base64 adds a
  // third, and Vercel refuses a body over ~4.5 MB. CLASSIFY_PAGES matches the server's cap.
  const CLASSIFY_BYTES = 2.4 * 1024 * 1024;
  const CLASSIFY_PAGES = 3;
  // A PDF handed on is uploaded as it stands, and siteinfo-batch.js refuses an upload over 3 MB
  // (UPLOAD_MAX_BYTES), so the other pages go on in parts that each fit.
  const PART_BYTES = 2.8 * 1024 * 1024;

  let FILE = null;          // the source PDF
  let PAGES = [];           // [{ page, blob, width, height, url, verdict, reason, choice }]
  let TOTAL = 0;
  let STAGE = 'pick';       // pick | reading | review
  let STATUS = '';          // progress line while reading or filing
  let ERROR = '';
  let MAYFILE = false;      // may this person file FICA pages? (server says so after classify)
  let SITE = '';            // 'BASE:recXXXX' -- where FICA pages are filed
  let FILED = null;         // { id, done:Set<page> } once a record exists
  let SKIPPED = false;      // the person chose not to file the FICA pages
  let BUSY = false;

  const ficaPages = () => PAGES.filter((p) => p.choice === 'fica');
  const otherPages = () => PAGES.filter((p) => p.choice === 'other');
  const stem = () => String((FILE && FILE.name) || 'scan.pdf').replace(/\.pdf$/i, '');

  /** [1,2,3,6,8,9] -> "1–3, 6, 8–9" */
  function ranges(nums) {
    const out = [];
    for (let i = 0; i < nums.length; i++) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      out.push(j > i ? nums[i] + '–' + nums[j] : String(nums[i]));
      i = j;
    }
    return out.join(', ');
  }

  /** Pages grouped into runs whose pictures together stay under `limit` bytes. */
  function parts(pages, limit) {
    const out = [];
    let cur = [];
    let size = 0;
    for (const p of pages) {
      if (cur.length && size + p.blob.size > limit) { out.push(cur); cur = []; size = 0; }
      cur.push(p);
      size += p.blob.size;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  async function bytesOf(blob) { return new Uint8Array(await blob.arrayBuffer()); }

  async function pdfOf(pages) {
    const list = [];
    for (const p of pages) list.push({ bytes: await bytesOf(p.blob), width: p.width, height: p.height });
    return TX.pdfWrite.fromJpegs(list);
  }

  function base64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // ── the modal ─────────────────────────────────────────────────────────────

  function reset() {
    for (const p of PAGES) if (p.url) URL.revokeObjectURL(p.url);
    FILE = null; PAGES = []; TOTAL = 0; STAGE = 'pick'; STATUS = ''; ERROR = '';
    FILED = null; SKIPPED = false; BUSY = false; SITE = '';
    MAYFILE = TX.can('restricted_personal', 'create') && !!(TX.me() && TX.me().user.canViewRestricted);
  }

  /** Opened from the list, or from a site -- which then is where its FICA pages go. */
  function open(siteId, base) {
    if ($('#siSplitModal')) return;
    reset();
    if (siteId && base) SITE = base + ':' + siteId;

    const wrap = document.createElement('div');
    wrap.className = 'si-modal';
    wrap.id = 'siSplitModal';
    wrap.innerHTML = '<div class="si-modal-card si-batch">'
      + '<div class="si-modal-head"><h2>Split a scanned PDF</h2>'
      + '<button class="si-x" data-act="siSplitClose" aria-label="Close">×</button></div>'
      + '<div class="si-modal-body" id="splitBody"></div>'
      + '<div class="si-modal-foot" id="splitFoot"></div></div>';
    ($('#modSiteInfo') || document.body).appendChild(wrap);
    render();
  }

  function close() {
    const m = $('#siSplitModal');
    if (m) m.remove();
    reset();
  }

  function render() {
    const body = $('#splitBody');
    const foot = $('#splitFoot');
    if (!body) return;

    if (STAGE === 'pick') {
      body.innerHTML = '<div class="si-warn">Each page is read on its own, and pages that look like '
        + 'FICA — an ID, a bank statement, proof of address — are set aside for you to confirm. '
        + 'The reading is a guess: you decide every page before anything is stored.</div>'
        + '<label class="si-drop" id="splitDrop">'
        + '<span>Drop a scanned PDF here</span>'
        + '<input id="splitFile" type="file" accept="application/pdf,.pdf" hidden>'
        + '<span class="si-drop-actions"><button class="si-btn" type="button" data-act="siSplitPick">'
        + 'Choose a PDF</button></span></label>'
        + (ERROR ? '<div class="si-msg err">' + esc(ERROR) + '</div>' : '');
      foot.innerHTML = '<button class="si-btn" data-act="siSplitClose">Cancel</button>';
      const input = $('#splitFile');
      input.addEventListener('change', (e) => start(e.target.files && e.target.files[0]));
      const drop = $('#splitDrop');
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        start(e.dataTransfer.files && e.dataTransfer.files[0]);
      });
      return;
    }

    if (STAGE === 'reading') {
      body.innerHTML = '<div class="si-empty">' + esc(STATUS || 'Reading…') + '</div>' + grid(false);
      foot.innerHTML = '<button class="si-btn" data-act="siSplitClose">Cancel</button>';
      return;
    }

    // review
    const fica = ficaPages();
    const other = otherPages();
    const unsure = PAGES.filter((p) => p.verdict === 'unsure').length;
    body.innerHTML = '<div class="si-split-sum"><b>' + esc(FILE.name) + '</b> — ' + TOTAL + ' page'
      + (TOTAL === 1 ? '' : 's') + ': <span class="si-split-n fica">' + fica.length + ' FICA</span> '
      + '<span class="si-split-n">' + other.length + ' other</span></div>'
      + (unsure ? '<div class="si-msg warn">' + unsure + ' page' + (unsure === 1 ? ' was' : 's were')
        + ' too hard to read and ' + (unsure === 1 ? 'is' : 'are') + ' marked FICA until you say '
        + 'otherwise. Look at ' + (unsure === 1 ? 'it' : 'them') + ' before going on.</div>' : '')
      + grid(true)
      + ficaSection(fica)
      + otherSection(other)
      + (ERROR ? '<div class="si-msg err">' + esc(ERROR) + '</div>' : '')
      + (STATUS ? '<div class="si-msg">' + esc(STATUS) + '</div>' : '');
    foot.innerHTML = '<button class="si-btn" data-act="siSplitClose">Close</button>';
  }

  function grid(editable) {
    if (!PAGES.length) return '';
    const locked = !!FILED || SKIPPED || BUSY;
    return '<div class="si-split-grid">' + PAGES.map((p) => {
      const tag = p.verdict === 'fica' ? 'Reads as FICA'
        : p.verdict === 'other' ? 'Reads as other'
          : p.verdict === 'unsure' ? 'Could not tell' : 'Reading…';
      return '<figure class="si-split-page ' + esc(p.choice || 'pending') + '">'
        + '<img src="' + p.url + '" alt="Page ' + p.page + '" loading="lazy">'
        + '<figcaption><b>Page ' + p.page + '</b>'
        + '<span class="si-split-tag ' + esc(p.verdict || '') + '" title="' + esc(p.reason || '') + '">'
        + esc(tag) + '</span>'
        + (editable
          ? '<span class="si-split-choice">'
            + btn(p, 'fica', 'FICA', locked) + btn(p, 'other', 'Other', locked) + '</span>'
          : '')
        + '</figcaption></figure>';
    }).join('') + '</div>';
  }

  function btn(p, choice, label, locked) {
    return '<button type="button" class="si-btn' + (p.choice === choice ? ' on' : '') + '"'
      + (locked ? ' disabled' : '')
      + ' data-act="siSplitSet" data-a1="' + p.page + '" data-a2="' + choice + '">' + label + '</button>';
  }

  function ficaSection(fica) {
    if (!fica.length) return '';
    let h = '<section class="si-split-step"><h3>FICA pages (' + esc(ranges(fica.map((p) => p.page))) + ')</h3>';
    if (!MAYFILE) {
      return h + '<div class="si-msg warn">These pages will not be uploaded. FICA documents can only '
        + 'be filed by an administrator who holds the restricted-documents permission — keep the '
        + 'original PDF and pass it to them if it needs to be kept.</div></section>';
    }
    if (FILED && FILED.done.size === fica.length) {
      return h + '<div class="si-msg ok">Filed in FICA Documents: ' + fica.length + ' page'
        + (fica.length === 1 ? '' : 's') + '. Open them later from the site’s FICA documents button.'
        + '</div></section>';
    }
    if (SKIPPED) {
      return h + '<div class="si-msg warn">Not filed. These pages will not be uploaded.</div></section>';
    }
    const sites = (TX.siteinfo && TX.siteinfo.sites ? TX.siteinfo.sites() : [])
      .slice().sort((a, b) => String(a.fields['Site Name']).localeCompare(String(b.fields['Site Name'])));
    h += '<div class="si-f si-wide"><label for="splitSite">File them against</label>'
      + '<select id="splitSite" data-act="siSplitSite" data-on="change" data-a1="@val"'
      + (FILED || BUSY ? ' disabled' : '') + '><option value="">Choose a site…</option>'
      + sites.map((s) => {
        const v = s._base + ':' + s.id;
        return '<option value="' + esc(v) + '"' + (v === SITE ? ' selected' : '') + '>'
          + esc(s.fields['Site Name']) + ' · ' + esc(s._base) + '</option>';
      }).join('') + '</select></div>'
      + '<div class="si-actions">'
      + '<button class="si-btn primary" data-act="siSplitFile"' + (BUSY || !SITE ? ' disabled' : '') + '>'
      + (FILED ? 'Retry the pages not yet filed' : 'File ' + fica.length + ' FICA page' + (fica.length === 1 ? '' : 's'))
      + '</button>'
      + (FILED ? '' : '<button class="si-btn" data-act="siSplitSkip"' + (BUSY ? ' disabled' : '') + '>Do not file them</button>')
      + '</div></section>';
    return h;
  }

  function otherSection(other) {
    if (!other.length) return '';
    const n = parts(other, PART_BYTES).length;
    return '<section class="si-split-step"><h3>Other pages (' + esc(ranges(other.map((p) => p.page))) + ')</h3>'
      + '<p class="si-hint">Carry on with them as you would with any document'
      + (n > 1 ? ' — they go on as ' + n + ' PDFs, to stay under the upload limit' : '')
      + '. They are checked again on the server before anything is stored.</p>'
      + '<div class="si-actions">'
      + '<button class="si-btn" data-act="siSplitOn" data-a1="site"' + (BUSY ? ' disabled' : '') + '>Build a site from them</button>'
      + '<button class="si-btn" data-act="siSplitOn" data-a1="jobcard"' + (BUSY ? ' disabled' : '') + '>File against a job card</button>'
      + '<button class="si-btn" data-act="siSplitOn" data-a1="report"' + (BUSY ? ' disabled' : '') + '>Folder → Site Report</button>'
      + '<button class="si-btn" data-act="siSplitDownload"' + (BUSY ? ' disabled' : '') + '>Download as PDF</button>'
      + '</div></section>';
  }

  // ── reading ───────────────────────────────────────────────────────────────

  async function start(file) {
    if (!file) return;
    ERROR = '';
    if (!TX.pdfPages.isPdf(file)) { ERROR = 'That is not a PDF.'; render(); return; }
    FILE = file;
    STAGE = 'reading';
    STATUS = 'Opening the PDF…';
    render();
    try {
      const out = await TX.pdfPages.render(file, {
        all: true,
        onProgress: (done, of) => { STATUS = 'Rendering page ' + done + ' of ' + of + '…'; render(); },
      });
      TOTAL = out.total;
      PAGES = out.pages.map((p) => Object.assign({}, p, {
        url: URL.createObjectURL(p.blob), verdict: '', reason: '', choice: '',
      }));
      await classifyAll();
      STAGE = 'review';
      STATUS = '';
    } catch (e) {
      STAGE = PAGES.length ? 'review' : 'pick';
      ERROR = TX.errorText(e);
      // A page that was never read is a page nobody can vouch for: it stays FICA.
      for (const p of PAGES) if (!p.choice) Object.assign(p, { verdict: 'unsure', reason: 'Not read.', choice: 'fica' });
      STATUS = '';
    }
    render();
  }

  async function classifyAll() {
    const batches = [];
    let cur = [];
    let size = 0;
    for (const p of PAGES) {
      if (cur.length && (cur.length >= CLASSIFY_PAGES || size + p.blob.size > CLASSIFY_BYTES)) {
        batches.push(cur); cur = []; size = 0;
      }
      cur.push(p);
      size += p.blob.size;
    }
    if (cur.length) batches.push(cur);

    let done = 0;
    for (const batch of batches) {
      STATUS = 'Reading page ' + (done + 1) + ' of ' + PAGES.length + '…';
      render();
      const pages = [];
      for (const p of batch) pages.push({ page: p.page, content: base64(await bytesOf(p.blob)) });
      const r = await TX.request('/api/fica-docs', { op: 'classify', pages });
      MAYFILE = !!r.mayFile;
      for (const v of r.pages || []) {
        const p = PAGES.find((x) => x.page === v.page);
        if (!p) continue;
        // 'unsure' starts as FICA: unreadable never clears.
        Object.assign(p, { verdict: v.verdict, reason: v.reason, choice: v.verdict === 'other' ? 'other' : 'fica' });
      }
      done += batch.length;
    }
  }

  function choose(page, choice) {
    if (FILED || SKIPPED || BUSY) return;
    const p = PAGES.find((x) => x.page === Number(page));
    if (p && (choice === 'fica' || choice === 'other')) p.choice = choice;
    render();
  }

  function setSite(v) { SITE = String(v || ''); render(); }

  // ── filing the FICA pages ─────────────────────────────────────────────────

  async function fileFica() {
    if (BUSY || !MAYFILE) return;
    const fica = ficaPages();
    const [base, id] = SITE.split(':');
    if (!fica.length || !base || !id) return;
    BUSY = true; ERROR = '';
    try {
      if (!FILED) {
        STATUS = 'Creating the FICA record…';
        render();
        const r = await TX.request('/api/fica-docs', {
          op: 'create', siteBase: base, siteId: id, sourceFile: FILE.name, pageCount: TOTAL,
          pages: fica.map((p) => p.page),
          detection: fica.map((p) => ({ page: p.page, verdict: p.verdict })),
        });
        FILED = { id: r.id, done: new Set() };
      }
      for (const p of fica) {
        if (FILED.done.has(p.page)) continue;
        STATUS = 'Filing page ' + p.page + ' (' + (FILED.done.size + 1) + ' of ' + fica.length + ')…';
        render();
        const pdf = await pdfOf([p]);
        await TX.request('/api/fica-docs', { op: 'attach', id: FILED.id, page: p.page, content: base64(pdf) });
        FILED.done.add(p.page);
      }
      STATUS = '';
    } catch (e) {
      ERROR = 'Filing stopped: ' + TX.errorText(e)
        + (FILED ? ' ' + FILED.done.size + ' of ' + fica.length + ' pages are filed; retry to file the rest.' : '');
      STATUS = '';
    }
    BUSY = false;
    render();
  }

  function skipFica() {
    if (BUSY || FILED) return;
    SKIPPED = true;
    render();
  }

  // ── the other pages ───────────────────────────────────────────────────────

  /** The other pages as PDF Files, in parts that each fit the upload limit. */
  async function otherFiles() {
    const groups = parts(otherPages(), PART_BYTES);
    const files = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const name = stem() + ' — pages ' + ranges(g.map((p) => p.page))
        + (groups.length > 1 ? ' (part ' + (i + 1) + ' of ' + groups.length + ')' : '') + '.pdf';
      files.push(new File([await pdfOf(g)], name, { type: 'application/pdf' }));
    }
    return files;
  }

  /** FICA pages someone could still file, and has not: leaving now drops them. */
  function unfiledFica() {
    const fica = ficaPages();
    return MAYFILE && fica.length && !SKIPPED && !(FILED && FILED.done.size === fica.length)
      ? fica.length : 0;
  }

  async function handOff(mode) {
    if (BUSY || ['site', 'jobcard', 'report'].indexOf(mode) < 0) return;
    const left = unfiledFica();
    if (left && !window.confirm(left + ' FICA page' + (left === 1 ? ' has' : 's have')
      + ' not been filed and will not be kept. Carry on with the other pages anyway?')) return;
    BUSY = true; STATUS = 'Putting the other pages together…'; render();
    try {
      const files = await otherFiles();
      close();
      TX.sitebatch.open(mode, files);
    } catch (e) {
      BUSY = false; STATUS = ''; ERROR = TX.errorText(e); render();
    }
  }

  async function download() {
    if (BUSY) return;
    BUSY = true; STATUS = 'Putting the other pages together…'; render();
    try {
      for (const f of await otherFiles()) {
        const url = URL.createObjectURL(f);
        const a = document.createElement('a');
        a.href = url; a.download = f.name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
      STATUS = '';
    } catch (e) {
      ERROR = TX.errorText(e); STATUS = '';
    }
    BUSY = false;
    render();
  }

  // ── what is filed against a site ──────────────────────────────────────────
  //
  // Asked for, never loaded on sight: the list is an audited restricted view in its own right.

  async function showIndex(siteId, base) {
    if ($('#siFicaModal')) return;
    const wrap = document.createElement('div');
    wrap.className = 'si-modal';
    wrap.id = 'siFicaModal';
    wrap.innerHTML = '<div class="si-modal-card si-batch">'
      + '<div class="si-modal-head"><h2>FICA documents</h2>'
      + '<button class="si-x" type="button" id="siFicaX" aria-label="Close">×</button></div>'
      + '<div class="si-modal-body" id="ficaBody"><div class="si-empty">Loading…</div></div>'
      + '<div class="si-modal-foot"><button class="si-btn" type="button" id="siFicaClose">Close</button></div></div>';
    ($('#modSiteInfo') || document.body).appendChild(wrap);
    const shut = () => wrap.remove();
    $('#siFicaX').addEventListener('click', shut);
    $('#siFicaClose').addEventListener('click', shut);

    const host = $('#ficaBody');
    try {
      const r = await TX.request('/api/fica-docs', { op: 'index', siteBase: base, siteId });
      const list = r.entries || [];
      host.innerHTML = '<div class="si-warn">Restricted personal information. Opening a page is '
        + 'recorded against your name.</div>'
        + (list.length ? list.map((e) => '<div class="si-split-entry"><div><b>' + esc(e.sourceFile)
          + '</b><br><span class="si-hint">Pages ' + esc(e.pages) + ' · filed by ' + esc(e.filedBy)
          + (e.filedAt ? ' · ' + esc(String(e.filedAt).slice(0, 10)) : '') + '</span></div><div>'
          + Array.from({ length: e.files }, (x, i) => '<button class="si-btn" type="button" data-act="siFicaOpen"'
            + ' data-a1="' + esc(e.id) + '" data-a2="' + i + '">Page ' + (i + 1) + '</button>').join('')
          + '</div></div>').join('')
          : '<div class="si-empty">Nothing is filed against this site.</div>');
    } catch (e) {
      host.innerHTML = '<div class="si-msg err">' + esc(TX.errorText(e)) + '</div>';
    }
  }

  async function openPage(id, n) {
    try {
      const r = await TX.request('/api/fica-docs', { op: 'open', id, n: Number(n) || 0 });
      const bin = atob(r.content);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: r.contentType || 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url; a.download = r.filename || 'fica-page.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      window.alert(TX.errorText(e));
    }
  }

  TX.sitesplit = {
    open, close, choose, setSite, fileFica, skipFica, handOff, download, showIndex, openPage,
    // Exposed for the test suite.
    ranges, parts,
    state: () => ({ PAGES, STAGE, MAYFILE, SITE, FILED, SKIPPED }),
    setState: (s) => {
      if (s.PAGES) PAGES = s.PAGES;
      if (s.STAGE) STAGE = s.STAGE;
      if (s.MAYFILE !== undefined) MAYFILE = s.MAYFILE;
      if (s.FILE) FILE = s.FILE;
      if (s.TOTAL) TOTAL = s.TOTAL;
      render();
    },
  };
})();
