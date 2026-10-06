// TAGEX — build a site from a folder of documents.
//
// Drop the folder you already keep for a site. One file in it is the job card; the rest are the
// CoC, the SLD, the handover pack and the photographs. This reads the job card, asks Airtable
// what it already knows about that site, and proposes a complete Site Information record. You
// confirm it, and then everything in the folder is attached to the site.
//
// NOTHING IS WRITTEN UNTIL THE REVIEW STEP IS CONFIRMED.
//
// /api/siteinfo-ocr cannot write — it only reads and proposes. The writes happen from here
// through the ordinary /api/at and /api/siteinfo-upload routes, so every field change is
// audited and re-checked against the role exactly as a hand-typed edit would be. OCR gets no
// privileged path into the data.
//
// PRECEDENCE, RESTATED WHERE IT IS VISIBLE
//
// Airtable outranks the scan. A site that already exists is the authority on itself, then its
// job card, then its client record, and only then OCR — and only into fields still blank. Where
// the scan disagrees with a stored value the stored value stands and the disagreement is shown.
// A scanner misreading a SUB/SOL number must never overwrite the real one.

(function () {
  'use strict';

  const $ = TX.$;
  const esc = TX.esc;

  // Vercel refuses a request body over ~4.5MB and base64 costs a third on top, so the server
  // caps a readable file at 3MB. Photographs routinely exceed that, so they are downscaled here
  // rather than being refused: 2400px on the long edge is about 200dpi across an A4 page, which
  // is comfortably enough for Tesseract and roughly a tenth of the bytes.
  const OCR_MAX_BYTES = 3 * 1024 * 1024;
  const OCR_MAX_EDGE = 2400;
  // The same platform ceiling applies to an upload, which is NOT downscaled: a site photo
  // is kept at the resolution it was taken at, so the limit has to be reported rather than
  // engineered around.
  const UPLOAD_MAX_BYTES = 3 * 1024 * 1024;
  // A PDF is no longer sent, so the platform's body limit does not apply to it — this is about
  // what a browser can sensibly open and hold in memory, which is a far larger number.
  const PDF_MAX_BYTES = 60 * 1024 * 1024;

  let FILES = [];          // [{ file, rel }]
  let CARD = -1;           // index in FILES of the job card
  let RESULT = null;       // the server's proposal
  let EDIT = {};           // field -> value, as shown in the review table
  let EQUIP = [];          // [{ row, take:boolean }]
  let BASE = 'OM';
  let BUSY = false;
  let REFUSED = [];        // [{ file, rel, reason, verdict, canOverride }]
  let SITE = null;         // { id, base } once the site has been written
  // 'site'    — start from a folder and work out which site it is (the original route).
  // 'jobcard' — start from a job card, which already knows its client, address and site.
  let MODE = 'site';
  let JOBCARD = null;      // the chosen job card
  let CARDS = [];          // the searchable list, fetched once
  let CARDQ = '';
  let ORIGIN = {};         // field -> the filename it was read from
  let SOURCES = [];        // [{ name, read, chars, note }] — every document opened
  let EXTRA_WARN = [];     // warnings gathered across all the documents

  // How many documents one run will read. Each is its own request, so there is no function
  // timeout to worry about, but a folder of 240 planning spreadsheets is not worth reading end
  // to end: the useful ones sort to the front and the rest are attached unread.
  const MAX_READ = 10;

  const bytes = (n) => (n < 1024 ? n + ' B'
    : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

  /**
   * Files whose text can be read.
   *
   * Word and Excel are in here now. They are not OCR'd — they are unzipped, since an Office
   * file is a ZIP of XML — and they are the documents that actually describe the system: the
   * scope of work in prose and the bill of materials as a table. Excluding them meant the SOW
   * and the BOM were uploaded and never read.
   */
  const readable = (f) => /^image\//.test(f.type || '')
    || /\.(jpe?g|png|gif|webp|pdf|docx|xlsx)$/i.test(f.name);

  /**
   * Guess which file is the job card, so the common case needs no thought.
   * A name that says so wins; failing that the first readable file, which in a scanned folder
   * is almost always the card itself.
   */
  function guessCard(files) {
    // A scope of work or a bill of materials is typed, so it reads perfectly and carries the
    // system detail. A job card is usually a scan of a handwritten form. Prefer the former.
    // Same underscore trap as readingOrder(): \b does not fire between "_" and "s".
    const spec = files.findIndex((r) => readable(r.file)
      && /(^|[^a-z0-9])(sow|bom)([^a-z0-9]|$)|scope\s*of\s*work|bill\s*of\s*material/i
        .test(r.file.name));
    if (spec >= 0) return spec;
    const named = files.findIndex((r) => /job\s*card|jobcard|\bjc\b|work\s*order/i.test(r.file.name));
    if (named >= 0) return named;
    return files.findIndex((r) => readable(r.file));
  }

  // ── file preparation ──────────────────────────────────────────────────────

  /**
   * Get a file into a shape the reader can actually read.
   *
   * A PDF IS RENDERED HERE, page by page, and the pages are what get sent.
   *
   * It used to be passed through whole, on the reasoning that re-compressing it would need a
   * renderer and the server could lift the page images out instead. That holds only while a
   * scanned page IS one image. A composited scan — the scanner separating each page into a text
   * mask and a background, often in strips — is not: a real 38-page site agreement turned out to
   * hold 609 image objects, and the server found four fragments in the whole document. The
   * browser has a renderer that composites those layers the way the page is meant to look, so
   * the rendering happens here.
   *
   * It also removes the size limit on PDFs. The ceiling was on the FILE, because the file was
   * what got sent; now the pages are, so a 40 MB scan is opened locally and a dozen page
   * pictures go over the wire.
   *
   * An image still only needs shrinking.
   */
  function prepare(file, onProgress) {
    if (TX.pdfPages && TX.pdfPages.isPdf(file)) {
      if (file.size > PDF_MAX_BYTES) {
        return Promise.reject(new Error('That PDF is ' + bytes(file.size) + ', over the '
          + bytes(PDF_MAX_BYTES) + ' limit for opening a file in the browser. Split it first.'));
      }
      return TX.pdfPages.render(file, { onProgress }).then((out) => ({
        pages: out.pages,
        total: out.total,
        type: file.type || 'application/pdf',
        name: file.name,
      }));
    }
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type || '')) {
        if (file.size > OCR_MAX_BYTES) {
          reject(new Error('That file is ' + bytes(file.size) + ', over the ' + bytes(OCR_MAX_BYTES)
            + ' reading limit.'));
          return;
        }
        resolve({ blob: file, type: file.type || 'application/octet-stream', name: file.name });
        return;
      }

      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const long = Math.max(img.width, img.height);
        const scale = long > OCR_MAX_EDGE ? OCR_MAX_EDGE / long : 1;
        if (scale === 1 && file.size <= OCR_MAX_BYTES) {
          resolve({ blob: file, type: file.type, name: file.name });
          return;
        }
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, c.width, c.height);
        c.toBlob((blob) => {
          if (!blob) { reject(new Error('That image could not be prepared for reading.')); return; }
          resolve({ blob, type: 'image/jpeg', name: file.name });
        }, 'image/jpeg', 0.85);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('That image could not be opened.'));
      };
      img.src = url;
    });
  }

  const toBase64 = (blob) => TX.siteinfo.files.toBase64(blob);

  /**
   * The request fields for a prepared file: either the file itself, or its rendered pages.
   *
   * Both call sites go through this, so a PDF cannot be rendered on one path and sent whole on
   * the other — which is how the batch reader and the single reader came to disagree before.
   */
  async function asRequest(prepped) {
    const req = { filename: prepped.name, contentType: prepped.type };
    if (prepped.pages) {
      req.pages = [];
      for (const p of prepped.pages) {
        req.pages.push({ page: p.page, content: await toBase64(p.blob) });
      }
    } else {
      req.content = await toBase64(prepped.blob);
    }
    return req;
  }

  // ── the modal ─────────────────────────────────────────────────────────────

  function open(mode) {
    if ($('#siBatchModal')) return;
    FILES = []; CARD = -1; RESULT = null; EDIT = {}; EQUIP = []; BUSY = false;
    REFUSED = []; SITE = null;
    MODE = ['jobcard', 'report'].indexOf(mode) >= 0 ? mode : 'site';
    JOBCARD = null; CARDQ = '';
    ORIGIN = {}; SOURCES = []; EXTRA_WARN = [];

    const wrap = document.createElement('div');
    wrap.className = 'si-modal';
    wrap.id = 'siBatchModal';
    wrap.innerHTML = '<div class="si-modal-card si-batch">'
      + '<div class="si-modal-head"><h2>' + (mode === 'jobcard'
        ? 'File documents against a job card'
        : (mode === 'report'
          ? 'Read a folder and write the site report'
          : 'Build a site from its documents')) + '</h2>'
      + '<button class="si-x" data-act="siBatchClose" aria-label="Close">×</button></div>'
      + '<div class="si-modal-body">'
      + '<div class="si-warn">Operational and technical documents only. Every file is read and '
      + 'checked on the server before it is stored, and anything that looks like FICA, identity, '
      + 'banking or financial material is refused — including photographs and scans.</div>'
      + '<div class="si-form" id="batchForm">'
      + '<div class="si-f"><label for="batchBase">Base</label>'
      + '<select id="batchBase"><option value="OM">O&amp;M</option>'
      + '<option value="CI">C&amp;I</option></select></div>'
      + '<div class="si-f si-wide"><label>Documents</label>'
      + '<label class="si-drop" id="batchDrop">'
      + '<span>Drop the site folder here, or choose files</span>'
      + '<input id="batchFiles" type="file" multiple hidden>'
      + '<input id="batchFolder" type="file" webkitdirectory directory multiple hidden>'
      + '<span class="si-drop-actions">'
      + '<button class="si-btn" type="button" data-act="siBatchPickFiles">Choose files</button> '
      + '<button class="si-btn" type="button" data-act="siBatchPickFolder">Choose a folder</button>'
      + '</span></label></div>'
      + '</div>'
      + '<div id="batchBody"></div>'
      + '</div>'
      + '<div class="si-modal-foot" id="batchFoot">'
      + '<button class="si-btn" data-act="siBatchClose">Cancel</button>'
      + '</div></div>';
    ($('#modSiteInfo') || document.body).appendChild(wrap);

    $('#batchBase').addEventListener('change', (e) => { BASE = e.target.value; });
    $('#batchFiles').addEventListener('change', (e) => add([...e.target.files]));
    $('#batchFolder').addEventListener('change', (e) => add([...e.target.files]));

    const drop = $('#batchDrop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      // A dropped folder arrives as a directory entry and contributes nothing to
      // dataTransfer.files, so it has to be walked. Same rules as the Photos tab.
      const entries = [...(e.dataTransfer.items || [])]
        .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
        .filter(Boolean);
      if (entries.length) {
        drop.classList.add('busy');
        const found = [];
        for (const en of entries) await TX.siteinfo.files.walk(en, found);
        drop.classList.remove('busy');
        add(found);
        return;
      }
      add([...(e.dataTransfer.files || [])]);
    });

    render();
  }

  function close() {
    const m = $('#siBatchModal');
    if (m) m.remove();
    FILES = []; CARD = -1; RESULT = null; EDIT = {}; EQUIP = []; BUSY = false;
    REFUSED = []; SITE = null; JOBCARD = null; CARDQ = '';
    ORIGIN = {}; SOURCES = []; EXTRA_WARN = [];
  }

  /** Add files, filtered by the module's own rules, without duplicating what is already queued. */
  function add(list) {
    const keep = TX.siteinfo.files.usable(list || []);
    const seen = new Set(FILES.map((r) => r.file.name + ':' + r.file.size));
    for (const f of keep) {
      const k = f.name + ':' + f.size;
      if (seen.has(k)) continue;
      seen.add(k);
      FILES.push({ file: f, rel: f.webkitRelativePath || f.name });
    }
    if (CARD < 0) CARD = guessCard(FILES);
    render();
  }

  // ── step 0 (job-card mode): choose the job card ───────────────────────────
  //
  // The job card is the better starting point for everyday work: it already names the client,
  // carries the site address, and links to its own Site Information record. Nothing has to be
  // inferred from a scan, so a misread reference cannot file paperwork against the wrong site.

  /**
   * Every job card, both bases, fetched once.
   *
   * Filtered in the browser rather than by formula. There are a couple of hundred, so the whole
   * list costs one request, and building a filterByFormula out of whatever someone types is how
   * a search box turns into a formula-injection bug.
   */
  async function loadCards() {
    if (CARDS.length) return CARDS;
    const params = {
      pageSize: 100,
      // "Client" as well as "Client Name": the two bases do not agree about which one holds
      // the client, and one of them is empty everywhere. See clientNameOf().
      fields: ['JC Reference', 'Title', 'Client Name', 'Client', 'Status', 'Site / Address',
        'Site Information'],
      sort: [{ field: 'JC Reference', direction: 'desc' }],
    };
    const cliParams = { pageSize: 100, fields: ['Client Name'] };
    const siteParams = { pageSize: 100, fields: ['Site Name'] };
    const [ci, om, ciCli, omCli, ciSite, omSite] = await Promise.all([
      TX.list('CI', 'job_cards', params).catch(() => ({ records: [] })),
      TX.list('OM', 'job_cards', params).catch(() => ({ records: [] })),
      TX.list('CI', 'clients', cliParams).catch(() => ({ records: [] })),
      TX.list('OM', 'clients', cliParams).catch(() => ({ records: [] })),
      TX.list('CI', 'site_information', siteParams).catch(() => ({ records: [] })),
      TX.list('OM', 'site_information', siteParams).catch(() => ({ records: [] })),
    ]);

    // Keyed by base as well as id. The two bases are duplicates of one another and share
    // table ids; assuming they cannot also share a record id is the kind of thing that is
    // true until it is not.
    const names = {};
    const sites = {};
    const learn = (res, base, field, into) => (res.records || []).forEach((r) => {
      const n = first(r.fields[field]);
      if (n) into[base + ':' + r.id] = n;
    });
    learn(ciCli, 'CI', 'Client Name', names);
    learn(omCli, 'OM', 'Client Name', names);
    learn(ciSite, 'CI', 'Site Name', sites);
    learn(omSite, 'OM', 'Site Name', sites);

    const take = (r, base) => ({
      id: r.id,
      base,
      ref: String(r.fields['JC Reference'] || ''),
      title: String(r.fields.Title || ''),
      client: clientNameOf(r, base, names),
      address: first(r.fields['Site / Address']) || siteNameOf(r, base, sites),
      status: String(r.fields.Status || ''),
      hasSite: (r.fields['Site Information'] || []).length > 0,
    });
    CARDS = [
      ...(ci.records || []).map((r) => take(r, 'CI')),
      ...(om.records || []).map((r) => take(r, 'OM')),
    ].filter((c) => c.ref);
    return CARDS;
  }

  // Only ever a last-resort guard, for an id that resolved to nothing. Deliberately loose:
  // pinning Airtable's id length here is how a working check breaks the day it changes.
  const RECID = /^rec[A-Za-z0-9]+$/;

  /**
   * The name of the site a job card is linked to, for cards that have no address.
   *
   * "Site / Address" is a lookup, and it is empty on 52 of the 168 cards. Where such a card is
   * linked to a Site Information record, that record's Site Name is the next best way to say
   * which site this is.
   *
   * Today this fires on none of them: only two job cards in either base are linked to a site
   * record at all, and both of those already have an address. It earns its keep as sites get
   * built, not now. A site id is never shown for the same reason a client id is not.
   */
  function siteNameOf(r, base, sites) {
    const ids = [].concat(r.fields['Site Information'] || [])
      .filter((x) => typeof x === 'string' && x);
    for (let i = 0; i < ids.length; i++) {
      const n = sites[base + ':' + ids[i]];
      if (n) return n;
    }
    return '';
  }

  /**
   * The client's name for a job card, whichever way this base stores it.
   *
   * WHY THIS IS NOT JUST first(fields['Client Name']).
   *
   * In O&M, "Client Name" is a LOOKUP and holds the name. In C&I a field of the same name is a
   * LINK, holds record ids, and is empty on all 55 cards there — the link that is actually
   * populated is "Client". So every C&I row in this picker showed a blank where the client
   * should be, which is what "not displaying the site name eg Easy Green" was.
   *
   * HOW IT DECIDES. Resolution comes first: any value, from either field, that names a client
   * we loaded wins. That is structural, and it does not care what a record id looks like —
   * an earlier version of this test-drove a length check and got it wrong.
   *
   * Only when nothing resolves does the shape matter, and then only to decide what NOT to
   * show. A value from "Client Name" may genuinely be the name, so it is shown unless it looks
   * like an id. A value from "Client" is a link and is never shown: the alternative is putting
   * "rec3vwDzbqzD4KUxN" on screen as a client, which is worse than a blank.
   */
  function clientNameOf(r, base, names) {
    const strs = (v) => [].concat(v || []).filter((x) => typeof x === 'string' && x);
    const named = strs(r.fields['Client Name']);
    const linked = strs(r.fields.Client);
    const all = named.concat(linked);
    for (let i = 0; i < all.length; i++) {
      const n = names[base + ':' + all[i]];
      if (n) return n;
    }
    return named.find((x) => !RECID.test(x)) || '';
  }

  /** A lookup arrives as an array of values; take the first usable one. */
  function first(v) {
    if (Array.isArray(v)) return String(v.find((x) => typeof x === 'string') || '');
    return v == null ? '' : String(v);
  }

  function matchingCards() {
    const q = CARDQ.trim().toLowerCase();
    if (!q) return CARDS.slice(0, 40);
    return CARDS.filter((c) => (
      (c.ref + ' ' + c.title + ' ' + c.client + ' ' + c.address).toLowerCase().indexOf(q) >= 0
    )).slice(0, 40);
  }

  async function renderCards() {
    const body = $('#batchBody');
    const foot = $('#batchFoot');
    const form = $('#batchForm');
    if (form) form.hidden = true;          // the job card decides the base

    if (!CARDS.length) {
      body.innerHTML = '<div class="si-empty">Loading job cards…</div>';
      foot.innerHTML = '<button class="si-btn" data-act="siBatchClose">Cancel</button>';
      try {
        await loadCards();
      } catch (e) {
        body.innerHTML = '<div class="si-msg err">' + esc(TX.errorText(e)) + '</div>';
        return;
      }
    }

    // THE SEARCH BOX IS RENDERED ONCE AND THEN LEFT ALONE.
    //
    // Rebuilding the whole panel on every keystroke destroys the <input> the person is typing
    // into: focus goes, the caret jumps, and characters typed during the re-render land
    // nowhere. Only the list below it is redrawn.
    if (!$('#batchCardQ')) {
      body.innerHTML = '<h3 class="si-h3">Choose the job card</h3>'
        + '<p class="si-hint">Search by reference, title, client or address. '
        + CARDS.length + ' job card(s) available.</p>'
        + '<input type="search" class="si-cardsearch" id="batchCardQ" '
        + 'placeholder="OM-2026-0146, Brendan Venter, Clubview…" '
        + 'data-act="siBatchCardQ" data-on="input" data-a1="@val" autocomplete="off" '
        + 'spellcheck="false">'
        + '<div id="batchCardList"></div>';
      const q = $('#batchCardQ');
      if (q) q.focus();
    }

    const rows = matchingCards();
    const list = $('#batchCardList');
    if (list) {
      list.innerHTML = rows.length
        ? '<div class="si-batch-files">' + rows.map((c) => (
          '<button type="button" class="si-batch-file si-cardrow" data-act="siBatchPickCard" '
          + 'data-a1="' + esc(c.id) + '">'
          + '<span class="si-batch-name"><strong>' + esc(c.ref) + '</strong>'
          + (c.title ? ' — ' + esc(c.title) : '')
          + '<br><span class="si-cardmeta">' + esc([c.client, c.address].filter(Boolean).join(' · '))
          + '</span></span>'
          + '<span class="si-batch-size">' + esc(c.base === 'OM' ? 'O&M' : 'C&I')
          + (c.status ? ' · ' + esc(c.status) : '') + '</span>'
          + (c.hasSite ? '<span class="si-chip">has a site</span>' : '')
          + '</button>')).join('') + '</div>'
        : '<div class="si-empty">No job card matches.</div>';
    }

    foot.innerHTML = '<button class="si-btn" data-act="siBatchClose">Cancel</button>';
  }

  function setCardQuery(v) {
    CARDQ = String(v == null ? '' : v);
    renderCards();
  }

  function chooseCard(id) {
    const c = CARDS.find((x) => x.id === id);
    if (!c) return;
    JOBCARD = c;
    BASE = c.base;
    const form = $('#batchForm');
    if (form) form.hidden = false;
    const sel = $('#batchBase');
    if (sel) { sel.value = c.base; sel.disabled = true; }
    render();
  }

  // ── step 1: the file list ─────────────────────────────────────────────────

  function render() {
    const body = $('#batchBody');
    const foot = $('#batchFoot');
    if (!body || !foot) return;

    if (MODE === 'jobcard' && !JOBCARD) { renderCards(); return; }
    if (RESULT) { renderReview(); return; }

    if (!FILES.length) {
      body.innerHTML = (JOBCARD
        ? '<div class="si-msg ok">Filing against <strong>' + esc(JOBCARD.ref) + '</strong>'
          + (JOBCARD.client ? ' — ' + esc(JOBCARD.client) : '')
          + ' <button type="button" class="si-linkbtn" data-act="siBatchChangeCard">change</button>'
          + '</div>'
        : '')
        + '<div class="si-empty">No files yet. Drop the folder above'
        + (MODE === 'jobcard' ? ', or continue to build the site record from the job card alone.'
          : '.') + '</div>';
      foot.innerHTML = '<button class="si-btn" data-act="siBatchClose">Cancel</button>'
        + (MODE === 'jobcard'
          ? '<button class="si-btn primary" data-act="siBatchRead">Continue</button>' : '');
      return;
    }

    const anyReadable = FILES.some((r) => readable(r.file));
    body.innerHTML = (JOBCARD
      ? '<div class="si-msg ok">Filing against <strong>' + esc(JOBCARD.ref) + '</strong>'
        + (JOBCARD.client ? ' — ' + esc(JOBCARD.client) : '')
        + ' <button type="button" class="si-linkbtn" data-act="siBatchChangeCard">change</button>'
        + '</div>'
      : '')
      + '<h3 class="si-h3">' + FILES.length + ' file(s)</h3>'
      + '<p class="si-hint">Choose the document to read — the scope of work, the bill of '
      + 'materials, or the job card. Its panel, inverter, battery and monitoring detail fills '
      + 'the site record. Everything else is attached as a document.</p>'
      + '<div class="si-batch-files">' + FILES.map((r, i) => {
        const can = readable(r.file);
        return '<label class="si-batch-file' + (can ? '' : ' muted') + '">'
          + '<input type="radio" name="batchCard" data-act="siBatchCard" data-on="change" '
          + 'data-a1="' + i + '"'
          + (i === CARD ? ' checked' : '') + (can ? '' : ' disabled') + '>'
          + '<span class="si-batch-name">' + esc(r.rel) + '</span>'
          + '<span class="si-batch-size">' + bytes(r.file.size) + '</span>'
          + (can ? '' : '<span class="si-chip">not readable</span>')
          + '</label>';
      }).join('') + '</div>'
      + (anyReadable ? '' : '<div class="si-msg warn">None of these files can be read for text. '
        + 'Add a PDF or a photograph of the job card, or create the site by hand.</div>');

    const canGo = (CARD >= 0 && anyReadable) || MODE === 'jobcard';
    foot.innerHTML = '<button class="si-btn" data-act="siBatchClose">Cancel</button>'
      + '<button class="si-btn" data-act="siBatchClear">Clear</button>'
      + '<button class="si-btn primary" data-act="siBatchRead"' + (canGo ? '' : ' disabled')
      + '>' + (CARD >= 0 && anyReadable ? 'Read the document' : 'Continue') + '</button>';
  }

  /**
   * The common top-level folder of everything dropped, if there is one.
   *
   * webkitRelativePath gives "H68 BOERDERYE/H68 - MDP Files/plan.xlsx". A folder picked as a
   * whole is named after the site far more reliably than a handwritten job card scans.
   */
  function folderName() {
    const tops = new Set();
    for (const r of FILES) {
      const parts = String(r.rel || '').split('/');
      if (parts.length > 1 && parts[0].trim()) tops.add(parts[0].trim());
    }
    return tops.size === 1 ? [...tops][0] : '';
  }

  // ── step 2: read it ───────────────────────────────────────────────────────

  async function read() {
    // In report mode the whole folder is the source, not one chosen file.
    if (MODE === 'report') return readAll();
    if (BUSY) return;
    // In job-card mode a scan is optional: the job card already carries the client, the address
    // and the link to its site, so there may be nothing worth reading.
    const willRead = CARD >= 0 && !!FILES[CARD];
    if (!willRead && MODE !== 'jobcard') return;

    BUSY = true;
    const body = $('#batchBody');
    const foot = $('#batchFoot');
    foot.innerHTML = '<button class="si-btn" disabled>'
      + (willRead ? 'Reading…' : 'Checking…') + '</button>';
    body.innerHTML = '<div class="si-empty">' + (willRead
      ? 'Reading ' + esc(FILES[CARD].file.name) + ' and checking Airtable…'
      : 'Reading the job card from Airtable…') + '</div>';

    try {
      const req = {};
      if (JOBCARD) { req.jobCardId = JOBCARD.id; req.base = JOBCARD.base; }
      // The top folder of a dropped directory is nearly always the site: "H68 BOERDERYE/H68 -
      // MDP Files/...". Offered as a last-resort name, clearly labelled, never overriding a
      // real source.
      const top = folderName();
      if (top) req.siteNameHint = top;
      if (willRead) {
        // say() belongs to the batch reader's scope. This one writes into its own body.
        const prepped = await prepare(FILES[CARD].file, (done, of) => {
          body.innerHTML = '<div class="si-empty">Rendering page ' + done + ' of ' + of
            + ' of ' + esc(FILES[CARD].file.name) + '\u2026</div>';
        });
        Object.assign(req, await asRequest(prepped));
      }
      RESULT = await TX.request('/api/siteinfo-ocr', req);

      EDIT = Object.assign({}, RESULT.proposal || {});
      EQUIP = ((RESULT.parsed && RESULT.parsed.equipment) || []).map((row) => ({ row, take: true }));
      if (RESULT.existing && RESULT.existing.base) BASE = RESULT.existing.base;
      const sel = $('#batchBase');
      if (sel) { sel.value = BASE; sel.disabled = !!RESULT.existing; }
    } catch (e) {
      RESULT = null;
      body.innerHTML = '<div class="si-msg err">' + esc(TX.errorText(e)) + '</div>';
      foot.innerHTML = '<button class="si-btn" data-act="siBatchClose">Cancel</button>'
        + '<button class="si-btn primary" data-act="siBatchRead">Try again</button>';
      BUSY = false;
      return;
    }

    BUSY = false;
    render();
  }

  /**
   * The documents worth reading, best first.
   *
   * A scope of work and a bill of materials are typed and carry the system detail. A job card
   * or a certificate is usually a scan. Photographs are excluded: a folder of 200 roof pictures
   * would take an hour to OCR and none of them say what inverter was fitted.
   */
  function readingOrder() {
    // A WORD BOUNDARY IS THE WRONG TEST ON A FILENAME. "_" is a word character, so
    // \bsow\b does not match "TINCUP_SOW_Complete 10Sep.docx" — and underscores are
    // exactly how these files are named. Separators are matched explicitly instead.
    const word = (w) => new RegExp('(^|[^a-z0-9])' + w + '([^a-z0-9]|$)');
    const score = (r) => {
      const n = r.rel.toLowerCase();
      if (word('sow').test(n) || /scope\s*of\s*work/.test(n)) return 0;
      if (word('bom').test(n) || /bill\s*of\s*material/.test(n)) return 1;
      if (/job\s*card|jobcard/.test(n) || word('jc').test(n) || /work\s*order/.test(n)) return 2;
      if (word('coc').test(n) || /certificate|compliance/.test(n)) return 3;
      if (word('sld').test(n) || /single\s*line|schematic|drawing/.test(n)) return 4;
      if (/\.(docx|xlsx)$/i.test(n)) return 5;
      if (/\.pdf$/i.test(n)) return 6;
      return 9;
    };
    return FILES
      .map((r, i) => ({ r, i, s: score(r) }))
      .filter((x) => x.s < 9 && readable(x.r.file))
      .sort((a, b) => (a.s !== b.s ? a.s - b.s : a.i - b.i))
      .slice(0, MAX_READ);
  }

  /**
   * Read every worthwhile document in the folder and merge what they say.
   *
   * Precedence is unchanged and still decided on the server for the FIRST document: the existing
   * site record, then the job card, then the client, then that document. The remaining documents
   * can only fill fields that are STILL blank, best-document-first — so a scope of work beats a
   * planning spreadsheet, and nothing ever overwrites what Airtable already held.
   */
  async function readAll() {
    if (BUSY) return;
    BUSY = true;
    const body = $('#batchBody');
    const foot = $('#batchFoot');
    const queue = readingOrder();

    ORIGIN = {}; SOURCES = []; EXTRA_WARN = [];

    const say = (t) => { body.innerHTML = '<div class="si-empty">' + esc(t) + '</div>'; };
    foot.innerHTML = '<button class="si-btn" disabled>Reading…</button>';

    for (let n = 0; n < queue.length; n += 1) {
      const entry = queue[n];
      const file = entry.r.file;
      say('Reading ' + (n + 1) + ' of ' + queue.length + ': ' + file.name);

      let res = null;
      let note = '';
      try {
        const prepped = await prepare(file);
        const req = await asRequest(prepped);
        if (JOBCARD) { req.jobCardId = JOBCARD.id; req.base = JOBCARD.base; }
        const top = folderName();
        if (top) req.siteNameHint = top;
        res = await TX.request('/api/siteinfo-ocr', req);
      } catch (e) {
        note = TX.errorText(e);
      }

      if (!res) {
        SOURCES.push({ name: entry.r.rel, read: false, chars: 0, note });
        continue;
      }

      const parsed = (res.parsed && res.parsed.fields) || {};
      SOURCES.push({
        name: entry.r.rel,
        read: (res.text || '').trim().length > 0,
        chars: (res.text || '').length,
        note: res.note || (res.confidence && res.confidence < 70
          ? res.confidence + '% confidence' : ''),
      });
      for (const w of (res.parsed && res.parsed.warnings) || []) EXTRA_WARN.push(w);

      if (n === 0) {
        // The first result carries everything Airtable knows, so it becomes the proposal.
        RESULT = res;
        EDIT = Object.assign({}, res.proposal || {});
        EQUIP = ((res.parsed && res.parsed.equipment) || []).map((row) => ({ row, take: true }));
        for (const k of Object.keys(parsed)) {
          if (EDIT[k] !== undefined && EDIT[k] !== '') ORIGIN[k] = entry.r.rel;
        }
        if (res.existing && res.existing.base) BASE = res.existing.base;
      } else {
        // Later documents fill gaps only.
        for (const [k, v] of Object.entries(parsed)) {
          if (v === '' || v == null) continue;
          if (EDIT[k] !== undefined && EDIT[k] !== '') continue;
          EDIT[k] = v;
          RESULT.provenance = RESULT.provenance || {};
          RESULT.provenance[k] = 'ocr';
          ORIGIN[k] = entry.r.rel;
        }
        const have = new Set(EQUIP.map((e) => e.row['Equipment Type']));
        for (const row of (res.parsed && res.parsed.equipment) || []) {
          if (!have.has(row['Equipment Type'])) EQUIP.push({ row, take: true });
        }
      }
    }

    BUSY = false;

    if (!RESULT) {
      body.innerHTML = '<div class="si-msg err">Nothing in this folder could be read. '
        + 'Add a scope of work, a bill of materials or a job card.</div>';
      foot.innerHTML = '<button class="si-btn" data-act="siBatchClose">Cancel</button>'
        + '<button class="si-btn primary" data-act="siBatchRead">Try again</button>';
      return;
    }

    // Every document's warnings belong on the review screen, not just the first one's.
    RESULT.parsed = RESULT.parsed || {};
    RESULT.parsed.warnings = EXTRA_WARN.slice(0, 40);
    RESULT.sourcesRead = SOURCES.length;
    render();
  }

  // ── step 3: review ────────────────────────────────────────────────────────

  const SOURCE_LABEL = {
    site: 'on the site record', jobcard: 'from the job card',
    client: 'from the client', ocr: 'read from the scan',
    folder: 'from the folder name',
  };

  function renderReview() {
    const body = $('#batchBody');
    const foot = $('#batchFoot');
    const r = RESULT;
    const prov = r.provenance || {};
    const schema = (TX.siteinfo.schema && TX.siteinfo.schema.selects) || {};

    // CORE FIELDS ARE ALWAYS SHOWN, even when nothing proposed a value for them.
    //
    // The table used to render only the keys the proposal happened to contain. When no source
    // supplied a Site Name — a job card whose client lookup is empty, a scan that read nothing —
    // there was no Site Name row at all, so "A site name is required" was an error with no way
    // to act on it: the one field needed to proceed was the one field not on screen.
    const CORE = ['Site Name', 'Client Name', 'Property Address', 'Job Card Number',
      'SUB / SOL Number', 'Installation Category', 'Site Type'];
    for (const k of CORE) {
      if (!Object.prototype.hasOwnProperty.call(EDIT, k)) EDIT[k] = '';
    }

    const keys = Object.keys(EDIT).sort((a, b) => {
      // A required field that is still empty is what stops the save, so it goes first.
      const blocked = (k) => (k === 'Site Name' && !String(EDIT[k] || '').trim() ? 0 : 1);
      if (blocked(a) !== blocked(b)) return blocked(a) - blocked(b);
      // Then anything the scan contributed — that is what actually needs checking.
      const pa = prov[a] === 'ocr' ? 0 : 1;
      const pb = prov[b] === 'ocr' ? 0 : 1;
      return pa !== pb ? pa - pb : a.localeCompare(b);
    });

    const head = r.existing
      ? '<div class="si-msg ok">This site already exists in ' + esc(r.existing.base === 'OM' ? 'O&M' : 'C&I')
        + ' as <strong>' + esc(r.existing.name) + '</strong>. Its stored values are kept; the scan '
        + 'only fills what was blank. Saving updates that record.</div>'
      : '<div class="si-msg">No matching site was found in C&amp;I or O&amp;M, so this will create '
        + 'a new one.</div>';

    const dupes = (r.duplicates || []).length
      ? '<div class="si-msg warn">Other sites with a similar name: '
        + r.duplicates.map((d) => esc(d.name) + ' (' + esc(d.base) + ')').join(', ')
        + '. Check you are not creating a second record for the same site.</div>'
      : '';

    const linked = [
      r.jobCard ? 'job card ' + esc(r.jobCard.number) : '',
      r.client ? 'client ' + esc(r.client.name) : '',
    ].filter(Boolean);
    const pulled = linked.length
      ? '<div class="si-msg ok">Pulled from Airtable: ' + linked.join(' and ') + '.</div>' : '';

    const conflicts = (r.conflicts || []).length
      ? '<div class="si-msg warn"><strong>The scan disagrees with what is stored.</strong> '
        + 'The stored value is kept. Change it yourself if the scan is right.<ul>'
        + r.conflicts.map((c) => '<li>' + esc(c.field) + ': stored <strong>'
          + esc(String(c.stored)) + '</strong>, scan read <strong>' + esc(String(c.scanned))
          + '</strong></li>').join('') + '</ul></div>'
      : '';

    const warnings = ((r.parsed && r.parsed.warnings) || []).length
      ? '<div class="si-msg warn"><strong>Not everything read cleanly.</strong><ul>'
        + r.parsed.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul></div>'
      : '';

    const quality = '<div class="si-hint">Read ' + (r.pages || 0) + ' page(s) at '
      + Math.round(r.confidence || 0) + '% confidence, matching ' + ((r.parsed && r.parsed.matched) || 0)
      + ' line(s). ' + (r.confidence < 70
        ? '<strong>That is low — check every value below.</strong> '
        : '')
      + 'Handwriting does not read reliably; anything filled in by hand is likely blank or wrong.'
      + (r.note ? ' ' + esc(r.note) : '') + '</div>';

    const rows = keys.map((k) => {
      const source = prov[k] || 'ocr';
      const opts = schema[k];
      const v = EDIT[k] == null ? '' : String(EDIT[k]);
      const input = opts
        ? '<select data-act="siBatchField" data-on="change" data-a1="' + esc(k) + '" data-a2="@val">'
          + '<option value="">—</option>'
          + opts.map((o) => '<option' + (o === v ? ' selected' : '') + '>' + esc(o) + '</option>').join('')
          + '</select>'
        : '<input type="text" value="' + esc(v) + '" data-act="siBatchField" data-on="change" '
          + 'data-a1="' + esc(k) + '" data-a2="@val">';
      const required = k === 'Site Name';
      const missing = required && !String(v).trim();
      return '<tr class="src-' + source + (missing ? ' si-needed' : '') + '"><th>' + esc(k)
        + (required ? ' <span class="si-req">required</span>' : '') + '</th>'
        + '<td>' + input + '</td>'
        + '<td class="si-batch-src">'
        + esc(missing ? 'type this in' : (SOURCE_LABEL[source] || source))
        + '</td></tr>';
    }).join('');

    const equip = EQUIP.length
      ? '<h3 class="si-h3">Equipment read from the job card</h3>'
        + '<p class="si-hint">These become Site Equipment rows. Untick anything you do not want.</p>'
        + '<div class="si-batch-files">' + EQUIP.map((e, i) => (
          '<label class="si-batch-file"><input type="checkbox" data-act="siBatchEq" '
          + 'data-on="change" data-a1="' + i + '" data-a2="@checked"'
          + (e.take ? ' checked' : '') + '>'
          + '<span class="si-batch-name">' + esc(e.row['Equipment Type']) + ' — '
          + esc([e.row.Manufacturer, e.row.Model, e.row['Serial Number']].filter(Boolean).join(' '))
          + '</span>'
          + (e.row.Quantity != null ? '<span class="si-batch-size">×' + esc(e.row.Quantity) + '</span>' : '')
          + '</label>')).join('') + '</div>'
      : '';

    const others = FILES.filter((_, i) => i !== CARD);
    const attach = '<h3 class="si-h3">Documents to attach</h3>'
      + '<p class="si-hint">All ' + FILES.length + ' file(s), the job card included, are uploaded '
      + 'and linked to the site once it is saved.</p>'
      + '<div class="si-batch-files">'
      + FILES.map((f, i) => '<label class="si-batch-file"><span class="si-batch-name">'
        + esc(f.rel) + (i === CARD ? ' <span class="si-chip">job card</span>' : '')
        + '</span><span class="si-batch-size">' + bytes(f.file.size) + '</span></label>').join('')
      + '</div>'
      + (others.length ? '' : '<div class="si-hint">Only the job card — no other documents.</div>');

    body.innerHTML = head + dupes + pulled + quality + conflicts + warnings
      + '<h3 class="si-h3">Site details</h3>'
      + '<table class="si-batch-table"><tbody>' + rows + '</tbody></table>'
      + equip + attach
      + '<div id="batchMsg"></div>';

    foot.innerHTML = '<button class="si-btn" data-act="siBatchClose">Cancel</button>'
      + '<button class="si-btn" data-act="siBatchRestart">Start over</button>'
      + '<button class="si-btn primary" data-act="siBatchApply">'
      + (r.existing ? 'Update the site and attach' : 'Create the site and attach') + '</button>';
  }

  function setField(k, v) {
    if (v === '' || v == null) delete EDIT[k];
    else EDIT[k] = v;
  }

  /**
   * Set, never toggle. The dispatcher hands over the box's own state, so if this ever
   * runs twice for one click the answer is the same both times.
   */
  function setEquip(i, checked) {
    const e = EQUIP[Number(i)];
    if (e) e.take = checked === true || checked === 'true';
  }

  // ── step 4: write ─────────────────────────────────────────────────────────

  /**
   * Values are sent as the schema expects them: numbers as numbers, everything else as trimmed
   * text. The proxy validates against the real table schema and rejects an unknown field or a
   * bad select option, so a wrong guess here fails loudly rather than writing nonsense.
   */
  function payload() {
    const schema = TX.siteinfo.schema || {};
    const nums = schema.numbers || [];
    const out = {};
    for (const [k, v] of Object.entries(EDIT)) {
      if (v === '' || v == null) continue;
      if (nums.indexOf(k) >= 0) {
        const n = Number(String(v).replace(',', '.').replace(/[^0-9.-]/g, ''));
        if (Number.isFinite(n)) out[k] = n;
        continue;
      }
      out[k] = typeof v === 'string' ? v.trim() : v;
    }
    return out;
  }

  async function apply() {
    if (BUSY) return;
    const name = String(EDIT['Site Name'] || '').trim();
    if (!name) {
      const m = $('#batchMsg');
      if (m) m.innerHTML = '<div class="si-msg err">A site name is required.</div>';
      return;
    }

    BUSY = true;
    const foot = $('#batchFoot');
    const msg = $('#batchMsg');
    const step = (t) => { if (msg) msg.innerHTML = '<div class="si-msg">' + esc(t) + '</div>'; };
    foot.innerHTML = '<button class="si-btn" disabled>Saving…</button>';

    const base = RESULT.existing ? RESULT.existing.base : BASE;
    let siteId = RESULT.existing ? RESULT.existing.id : '';
    const problems = [];

    try {
      const fields = payload();
      const now = new Date().toISOString();

      // Linked from the SITE side on purpose. Site Information has a "Job Cards" field and
      // Airtable maintains the reverse link itself, so this needs site_information:edit — which
      // the person already has to be here — rather than job_cards:edit, which they may not.
      if (JOBCARD) fields['Job Cards'] = [JOBCARD.id];

      if (siteId) {
        step('Updating the site record…');
        fields['Modified By (App)'] = TX.userEmail();
        fields['Modified Date'] = now;
        await TX.update(base, 'site_information', siteId, fields);
      } else {
        step('Creating the site record…');
        fields['Created By (App)'] = TX.userEmail();
        fields['Created Date'] = now;
        const res = await TX.create(base, 'site_information', fields);
        const rec = (res.records || [])[0];
        if (!rec) throw new Error('The site record was not created.');
        siteId = rec.id;
      }
    } catch (e) {
      BUSY = false;
      if (msg) msg.innerHTML = '<div class="si-msg err">The site could not be saved: '
        + esc(TX.errorText(e)) + '</div>';
      foot.innerHTML = '<button class="si-btn" data-act="siBatchClose">Close</button>'
        + '<button class="si-btn primary" data-act="siBatchApply">Try again</button>';
      return;
    }

    // Equipment. A failure here must not lose the site that was just written, so each row is
    // reported and the run continues.
    const take = EQUIP.filter((e) => e.take);
    if (take.length) {
      step('Adding ' + take.length + ' equipment row(s)…');
      for (const e of take) {
        try {
          await TX.create(base, 'site_equipment', Object.assign({}, e.row, {
            'Site Information': [siteId],
            'Site Name': String(EDIT['Site Name'] || ''),
            Status: 'Active',
            'Created By (App)': TX.userEmail(),
            'Created Date': new Date().toISOString(),
          }));
        } catch (err) {
          problems.push('Equipment ' + e.row['Equipment Type'] + ': ' + TX.errorText(err));
        }
      }
    }

    // THE REPORT, compiled from the values that were just confirmed.
    //
    // Written before the source documents are uploaded so that a run which fails part way still
    // leaves the record of what was read. It is uploaded through the ordinary route, so it is
    // classified and audited like any other document.
    let report = null;
    if (MODE === 'report') {
      step('Writing the scope of work and site report…');
      try {
        report = await TX.request('/api/siteinfo-report', {
          fields: payload(),
          provenance: (RESULT && RESULT.provenance) || {},
          origin: ORIGIN,
          equipment: EQUIP.filter((e) => e.take).map((e) => e.row),
          // Deduplicated: RESULT.parsed.warnings IS EXTRA_WARN after a multi-document read,
          // so concatenating the two listed every warning twice in the report.
          warnings: [...new Set(
            ((RESULT && RESULT.parsed && RESULT.parsed.warnings) || []).concat(EXTRA_WARN),
          )].slice(0, 60),
          sources: SOURCES.concat(
            // Everything in the folder that was attached but never read.
            FILES.filter((f) => !SOURCES.some((x) => x.name === f.rel))
              .map((f) => ({ name: f.rel, read: false, chars: 0, note: 'attached, not read' })),
          ),
        });
      } catch (e) {
        problems.push('Site report: ' + TX.errorText(e));
      }
    }

    // Documents, one at a time — each is classified on the server and may be refused.
    let uploaded = 0;
    for (let i = 0; i < FILES.length; i += 1) {
      const r = FILES[i];
      step('Uploading ' + (i + 1) + ' of ' + FILES.length + ': ' + r.file.name);

      // Vercel rejects a request body over ~4.5MB, and base64 adds a third — so a file much
      // over 3MB never reaches our handler and fails with an opaque platform error instead of
      // the handler's own message. Say so plainly here rather than letting it look like a
      // refusal by the FICA classifier, which is what an unexplained failure would read as.
      if (r.file.size > UPLOAD_MAX_BYTES) {
        problems.push(r.file.name + ': ' + bytes(r.file.size) + ' is too large to upload ('
          + 'the limit is ' + bytes(UPLOAD_MAX_BYTES) + '). It was not refused — it was never '
          + 'sent. Resize it, or add it from the Photos tab.');
        continue;
      }

      try {
        const content = await TX.siteinfo.files.toBase64(r.file);
        await TX.request('/api/siteinfo-upload', {
          base,
          // Filed against the job card when there is one: that is what Documents.Job Card is
          // for, and the server then leaves the site's own document list alone so one file
          // cannot appear twice.
          ...(JOBCARD ? { jobCardId: JOBCARD.id } : { siteId }),
          filename: r.file.name,
          contentType: r.file.type || 'application/octet-stream',
          category: i === CARD ? 'Site' : 'Site',
          description: r.rel,
          content,
          // NOT pre-confirmed. A file the server cannot classify is refused and listed, so
          // nothing is waved through on the strength of having been in the folder.
          confirmedOperational: false,
        });
        uploaded += 1;
      } catch (err) {
        problems.push(r.file.name + ': ' + TX.errorText(err));
        // A refusal by the classifier is a decision someone can revisit; a network failure is
        // not. Only the former is offered for a second look.
        const p = (err && err.payload) || {};
        if (p.verdict === 'REVIEW' || p.verdict === 'BLOCKED') {
          REFUSED.push({
            file: r.file,
            rel: r.rel,
            reason: TX.errorText(err),
            verdict: p.verdict,
            canOverride: p.canOverride === true,
          });
        }
      }
    }

    if (report && report.content) {
      step('Attaching the site report…');
      try {
        await TX.request('/api/siteinfo-upload', {
          base,
          ...(JOBCARD ? { jobCardId: JOBCARD.id } : { siteId }),
          filename: report.filename,
          contentType: 'application/pdf',
          description: 'Scope of work and site report, compiled from the uploaded documents',
          content: report.content,
          confirmedOperational: false,
        });
        uploaded += 1;
      } catch (e) {
        problems.push(report.filename + ': ' + TX.errorText(e));
      }
    }

    BUSY = false;
    SITE = { id: siteId, base };

    const summary = (RESULT.existing ? 'Site updated. ' : 'Site created. ')
      + (report ? 'Site report written. ' : '')
      + uploaded + ' of ' + (FILES.length + (report ? 1 : 0)) + ' document(s) attached'
      + (take.length ? ', ' + (take.length - problems.filter((p) => /^Equipment/.test(p)).length)
        + ' equipment row(s) added' : '') + '.';

    if (msg) {
      msg.innerHTML = '<div class="si-msg ' + (problems.length ? 'warn' : 'ok') + '">'
        + esc(summary)
        + (problems.length
          ? '<br><strong>Refused or failed:</strong><ul>'
            + problems.map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul>'
            + '<span class="si-hint">Each line above says what happened to that file. A file the '
            + 'server judged to contain FICA or financial content was refused and should stay '
            + 'out; one it could not classify, or that was too large to send, can be added by '
            + 'hand from the Photos tab if it really is operational.</span>'
          : '')
        + '</div>';
    }

    if (REFUSED.length) renderRefused();

    foot.innerHTML = '<button class="si-btn primary" data-act="siBatchDone" '
      + 'data-a1="' + siteId + '" data-a2="' + base + '">Open the site</button>';
  }

  async function done(siteId, base) {
    close();
    await TX.siteinfo.reload();
    if (siteId) TX.siteinfo.open(siteId, base);
  }

  // ── a second look at what the classifier refused ──────────────────────────
  //
  // Without this the batch flow could never store a scanned CoC: it sends every file
  // unconfirmed, so anything the server could not read came back REVIEW and was simply listed
  // as a failure with no way to act on it. The rules are the same as the Photos tab's —
  // REVIEW is a confirmation anyone may give, BLOCKED needs the admin gate — and the SERVER
  // decides both again regardless of what is rendered here.

  function mayClassifyFica() {
    const me = TX.me();
    return !!(me && me.user && me.user.canViewRestricted === true);
  }

  function renderRefused() {
    const host = $('#batchMsg');
    if (!host || !REFUSED.length) return;
    const admin = mayClassifyFica();

    const rows = REFUSED.map((r, i) => {
      const allowed = r.verdict === 'REVIEW' || (r.verdict === 'BLOCKED' && admin);
      return '<label class="si-batch-file' + (allowed ? '' : ' muted') + '">'
        + '<input type="checkbox" data-on="change" data-act="siBatchRetryPick" data-a1="' + i + '"'
        + ' data-a2="@checked"' + (allowed ? '' : ' disabled') + '>'
        + '<span class="si-batch-name">' + esc(r.rel) + '</span>'
        + '<span class="si-batch-size">' + esc(r.verdict) + '</span>'
        + (allowed ? '' : '<span class="si-chip">admin only</span>')
        + '</label>';
    }).join('');

    const anyBlocked = REFUSED.some((r) => r.verdict === 'BLOCKED');
    host.insertAdjacentHTML('beforeend',
      '<h3 class="si-h3">Refused — look at these yourself</h3>'
      + '<p class="si-hint">Tick anything you have checked and know carries only operational '
      + 'information. A REVIEW file simply could not be read. '
      + (anyBlocked
        ? (admin
          ? '<strong>A BLOCKED file looked like FICA or financial material</strong> — uploading '
            + 'one anyway is recorded against your name, in the audit log and on the document.'
          : 'A BLOCKED file looked like FICA or financial material and only an administrator '
            + 'may overrule that.')
        : '')
      + '</p>'
      + '<div class="si-batch-files">' + rows + '</div>'
      + '<div class="si-actions"><button class="si-btn" data-act="siBatchRetry">'
      + 'Upload the ticked files</button></div>'
      + '<div id="batchRetryMsg"></div>');
  }

  const RETRY = new Set();
  function pickRetry(i, checked) {
    const n = Number(i);
    if (checked === true || checked === 'true') RETRY.add(n);
    else RETRY.delete(n);
  }

  async function retryRefused() {
    if (BUSY || !SITE) return;
    const out = $('#batchRetryMsg');
    const chosen = [...RETRY].map((i) => REFUSED[i]).filter(Boolean);
    if (!chosen.length) {
      if (out) out.innerHTML = '<div class="si-msg warn">Tick a file first.</div>';
      return;
    }

    BUSY = true;
    let ok = 0;
    const failed = [];
    for (const r of chosen) {
      if (out) out.innerHTML = '<div class="si-msg">Uploading ' + esc(r.file.name) + '…</div>';
      try {
        const content = await TX.siteinfo.files.toBase64(r.file);
        await TX.request('/api/siteinfo-upload', {
          base: SITE.base,
          ...(JOBCARD ? { jobCardId: JOBCARD.id } : { siteId: SITE.id }),
          filename: r.file.name,
          contentType: r.file.type || 'application/octet-stream',
          category: 'Site',
          description: r.rel,
          content,
          // REVIEW needs only a confirmation; BLOCKED needs the explicit classification, which
          // the server honours only from someone who passes its own admin gate.
          confirmedOperational: true,
          classification: r.verdict === 'BLOCKED' ? 'operational' : '',
        });
        ok += 1;
      } catch (e) {
        failed.push(r.file.name + ': ' + TX.errorText(e));
      }
    }
    BUSY = false;
    RETRY.clear();

    if (out) {
      out.innerHTML = '<div class="si-msg ' + (failed.length ? 'warn' : 'ok') + '">'
        + ok + ' of ' + chosen.length + ' uploaded.'
        + (failed.length ? '<ul><li>' + failed.map(esc).join('</li><li>') + '</li></ul>' : '')
        + '</div>';
    }
  }

  TX.sitebatch = {
    open, close, read, apply, done, setField, setEquip,
    pickRetry, retryRefused,
    setCardQuery, chooseCard, readAll, readingOrder,
    changeCard: () => { JOBCARD = null; RESULT = null; render(); },
    pickCard: (i) => { CARD = Number(i); },
    clear: () => { FILES = []; CARD = -1; render(); },
    restart: () => { RESULT = null; EDIT = {}; EQUIP = []; render(); },
    // Exposed for the test suite.
    guessCard, readable, prepare, payloadOf: () => payload(), state: () => (
      { FILES, CARD, RESULT, EDIT, EQUIP, BASE }),
    setState: (s) => {
      if (s.FILES) FILES = s.FILES;
      if (s.CARD != null) CARD = s.CARD;
      if (s.RESULT !== undefined) RESULT = s.RESULT;
      if (s.EDIT) EDIT = s.EDIT;
      if (s.EQUIP) EQUIP = s.EQUIP;
      if (s.BASE) BASE = s.BASE;
    },
  };
})();
