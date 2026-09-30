// POST /api/siteinfo-upload — attach a photo or operational document to a Site Information record.
//
// WHY THIS EXISTS RATHER THAN GOING THROUGH /api/at
//
// Two reasons. Airtable attachments cannot be written as an ordinary field value — they need the
// content API — and, more importantly, the rule that keeps FICA and financial documents out of
// this module has to be enforced somewhere the browser cannot reach. The check in
// mod-siteinfo.js is a courtesy so the user sees a verdict before a slow upload. THIS is the
// control.
//
// The classifier is deliberately conservative and openly imperfect:
//   BLOCKED  — the name or the extracted text clearly indicates FICA or financial content.
//   REVIEW   — it cannot tell. Refused unless the caller has explicitly confirmed the file is
//              operational only, so "not sure" never silently becomes "uploaded".
//   ALLOWED  — an image, or a document whose text looks operational.
//
// It judges the filename always, the literal text of a PDF where there is a text layer, and —
// where there is not — the text OCR can recover from the scan (see classifyDeep). OCR only ever
// makes the verdict stricter: it can turn REVIEW into BLOCKED, never into ALLOWED.
//
// It is still not a guarantee and must not be described as one. Handwriting does not OCR, a
// photograph at an angle may yield nothing, and a document that says nothing incriminating in
// print can still carry personal data. REVIEW continues to mean "a person must look".

'use strict';

const T = require('./_lib/tables.js');
const P = require('./_lib/permissions.js');
const at = require('./_lib/airtable.js');
const S = require('./_lib/session.js');
const H = require('./_lib/http.js');
const A = require('./_lib/audit.js');

// Pages sampled when OCR is used as the FICA check. Six pages at ~2.5s each sits inside the
// function's 60s budget with room for the upload that follows.
const FICA_SCAN_PAGES = 6;

const MAX_BYTES = 12 * 1024 * 1024;          // Airtable's own attachment ceiling is higher; this
                                             // keeps one bad file from filling a function's memory.

// Words that make a document financial or FICA regardless of context.
const NAME_BLOCK = /(fica|kyc|\bid[\s_-]?(doc|copy|document|number)|identity|passport|licence|license|driver'?s?[\s_-]?lic|proof[\s_-]?of[\s_-]?(res|address|payment)|\bpop\b|bank[\s_-]?(statement|confirmation|letter|details)|statement|invoice|proforma|pro[\s_-]?forma|quotation|\bquote\b|remittance|credit[\s_-]?app|sars|vat[\s_-]?cert|financial|payslip|salary|account[\s_-]?number|card[\s_-]?number)/i;

// Phrases that only appear in the body of a financial or identity document.
//
// TWO OF THESE FIRE ON DATA RATHER THAN ON A LABEL, and the distinction is load-bearing.
//
// A bare "ID No:" is a printed field on a blank form, not identity data. The statutory
// Certificate of Compliance carries one for the registered electrician on every single
// certificate ever issued — so matching the label alone made it impossible to store any CoC,
// in a module whose own schema has an "Electrical CoC" document status and therefore expects
// them. Measured on a real certificate: the label matched, the handwritten number next to it
// did not even OCR, and the document was refused.
//
// So "ID No" and "Passport No" now require a plausible number nearby. An actual identity
// number still blocks; an empty form field does not. The cost is honest: an ID number that
// fails to OCR is no longer caught by THIS rule — which is why REVIEW still means a person
// must look, and why the filename rule and every financial rule below are unchanged.
const TEXT_BLOCK = [
  /bank\s+statement/i, /statement\s+of\s+account/i, /proof\s+of\s+payment/i,
  /tax\s+invoice/i, /\binvoice\s+(no|number|date)\b/i, /pro\s?forma/i,
  /account\s+(number|holder)/i, /branch\s+code/i, /swift\s+code/i, /\biban\b/i,
  /identity\s+(number|document)/i,
  /\bid\s*(?:no|number)\b[^0-9]{0,24}\d{6,}/i,
  /passport\s*(?:no|number)\b[^0-9]{0,24}\d{5,}/i,
  /driver'?s?\s+licence/i, /date\s+of\s+birth/i,
  /vat\s+registration/i, /credit\s+application/i, /banking\s+details/i,
];

/** Literal text out of a PDF. Returns '' for a scan — which lands the file in REVIEW, not ALLOWED. */
function pdfText(buf) {
  const zlib = require('zlib');
  const s = buf.toString('latin1');
  let out = '';
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s)) && out.length < 200000) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) continue;
    const chunk = Buffer.from(s.slice(start, end), 'latin1');
    let body;
    try { body = zlib.inflateSync(chunk).toString('latin1'); } catch (e) { body = chunk.toString('latin1'); }
    for (const t of body.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out += t[1] + ' ';
    for (const t of body.matchAll(/\[((?:[^\][\\]|\\.)*)\]\s*TJ/g)) {
      for (const p of t[1].matchAll(/\(((?:\\.|[^\\)])*)\)/g)) out += p[1];
      out += ' ';
    }
  }
  return out;
}

/**
 * The TEXT_BLOCK rules against a plain string, or null when nothing matched.
 *
 * Separated out because the alternative — re-entering classify() with contentType 'text/plain'
 * to judge some text — does not work and silently did nothing for months of PDFs: classify()
 * chooses its text source by FILENAME FIRST, so "report.pdf" sent the OCR text back through the
 * PDF parser, which found no PDF in it and returned a clean verdict. Text is judged here, by a
 * function that takes text.
 */
function textVerdict(text) {
  for (const re of TEXT_BLOCK) {
    if (re.test(text)) {
      return {
        verdict: 'BLOCKED',
        reason: 'The document text indicates FICA or financial content.',
      };
    }
  }
  return null;
}

/**
 * @returns {{verdict:'ALLOWED'|'BLOCKED'|'REVIEW', reason:string}}
 */
function classify({ filename, contentType, buf }) {
  if (NAME_BLOCK.test(String(filename || ''))) {
    return { verdict: 'BLOCKED', reason: 'The file name indicates FICA or financial content.' };
  }

  let text = '';
  if (/pdf/i.test(contentType) || /\.pdf$/i.test(filename)) {
    try { text = pdfText(buf); } catch (e) { text = ''; }
  } else if (/text|csv/i.test(contentType)) {
    text = buf.toString('utf8').slice(0, 200000);
  } else {
    // A .docx or .xlsx is a ZIP of XML and was previously opaque to this check, so a quotation
    // in Word or an invoice in Excel walked past it unexamined — the classifier can only judge
    // text it can see. No dependency: officetext.js unzips with the built-in zlib.
    try {
      const office = require('./_lib/officetext.js').officeText(buf, filename, contentType);
      text = office.text || '';
    } catch (e) { text = ''; }
  }

  const blocked = textVerdict(text);
  if (blocked) return blocked;

  // A photograph of a site is the ordinary case and carries no readable text to judge.
  if (/^image\//i.test(contentType)) return { verdict: 'ALLOWED', reason: 'Image' };

  // A document whose text we could actually read, and which said nothing financial.
  if (text.trim().length > 200) return { verdict: 'ALLOWED', reason: 'Operational document' };

  // Everything else — including a scan with no text layer — is genuinely unknown.
  return {
    verdict: 'REVIEW',
    reason: 'The contents could not be read, so this file cannot be cleared automatically.',
  };
}

/**
 * May this caller overrule the classifier?
 *
 * The SAME DOUBLE GATE the module already uses for restricted personal data: the role carries
 * the permission AND the individual user carries the flag. Only Admin / Director holds both, so
 * "admin" here means the person the organisation has already trusted with sensitive material,
 * not merely someone who can create documents.
 *
 * It is deliberately NOT derived from the role's NAME. A role called "Admin" that lacks the
 * flags cannot override, and a renamed role that holds them can.
 */
function mayClassify(role, user) {
  return role != null && user != null
    && role['Can View Restricted Documents'] === true
    && user['Can View Restricted Documents'] === true;
}

/**
 * classify(), and then OCR whatever it could not read.
 *
 * A scan has no text layer, so the synchronous classifier has nothing to judge and returns
 * REVIEW — where a person can confirm it as operational and send it through. That was the
 * weakest point in this control: a photographed bank statement looked exactly like a
 * photographed CoC. OCR closes it.
 *
 * The asymmetry is the important part. OCR text can only ever make the verdict STRICTER.
 * A file that reads clean stays REVIEW rather than being promoted to ALLOWED, because
 * "Tesseract found nothing alarming" is not evidence that a document is safe — it is often
 * just evidence that the handwriting was bad.
 */
async function classifyDeep({ filename, contentType, buf }) {
  const first = classify({ filename, contentType, buf });
  if (first.verdict === 'BLOCKED') return first;

  // An Office file was read in full by classify() above; there is no image to OCR.
  if (/\.(docx|xlsx)$/i.test(filename || '')
    || /wordprocessingml|spreadsheetml/i.test(contentType || '')) return first;

  const isImage = /^image\//i.test(contentType)
    || /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i.test(filename || '');
  const isPdf = /pdf/i.test(contentType) || /\.pdf$/i.test(filename || '');

  // An IMAGE is deep-checked even though classify() already said ALLOWED.
  //
  // That blanket allowance was the largest hole in this control. classify() clears every
  // image on the reasoning that a site photograph "carries no readable text to judge" — but a
  // phone photograph of a bank statement is also an image, and renaming it "site photo 4.jpg"
  // was enough to walk it straight past both rules. Verified: it returned ALLOWED.
  //
  // The cost is roughly a second per photograph on upload. That is worth paying for a module
  // whose entire reason to exist is that this material stays out of it.
  if (!isImage && !isPdf) return first;

  let text = '';
  try {
    const ocr = require('./_lib/ocr.js');
    // SAMPLED ACROSS THE WHOLE DOCUMENT, not its first pages.
    //
    // A real 26-page subscription pack was measured here: pages 1-10 were contract terms, and
    // the FNB bank statements were on pages 11 to 13. Reading the front of that file returns a
    // page of legal boilerplate and a clean verdict. Six pages spread across it reach the
    // statements. It is still a sample and can still miss — which is exactly why a REVIEW
    // verdict continues to mean "a person must look", and why this can only ever tighten a
    // verdict, never clear one.
    const read = await ocr.readDocument(buf, filename, contentType, FICA_SCAN_PAGES, true);
    text = read.text || '';
  } catch (e) {
    // OCR is an extra pass, not a gate. A failure leaves the verdict exactly as classify()
    // set it — no worse than before this pass existed, and never better.
    return first;
  }

  if (!text.trim()) return first;

  if (textVerdict(text)) {
    return {
      verdict: 'BLOCKED',
      reason: 'Reading the ' + (isPdf ? 'scan' : 'image') + ' showed FICA or financial content.',
    };
  }

  // Clean OCR text does NOT promote a verdict. "Tesseract found nothing alarming" is not
  // evidence a document is safe — most often it means the handwriting did not read.
  return first;
}

// ── filing a document under the right two labels ────────────────────────────
//
// 'Document Type' and 'Photo Category' answer different questions, and conflating them is what
// this code got wrong before: every upload claimed to be a site photo.
//
//   Document Type   what KIND of file this is -- SOW, CoC, Invoice, Site Photos, Other.
//   Photo Category  what a photo SHOWS -- Roof, Inverter, DB, Defect. Empty for non-photos.
//
// Both are single-selects with fixed options, so anything not on the list is filed as 'Other'
// rather than sent to Airtable to be rejected.

const isImage = (contentType) => /^image\//i.test(String(contentType || ''));

/** The photo categories offered by the app, mirrored from PHOTO_CATEGORIES in mod-siteinfo.js. */
const PHOTO_CATEGORIES = Object.freeze(['Site', 'Roof', 'PV Panels', 'Inverter', 'Battery',
  'DB', 'Electrical', 'Meter', 'Equipment', 'Defect', 'Before', 'After', 'Other']);

function photoCategory(category) {
  const c = String(category || '').trim();
  const hit = PHOTO_CATEGORIES.find((p) => p.toLowerCase() === c.toLowerCase());
  return hit || 'Other';
}

/**
 * Which Document Type option to file this under.
 *
 * Before and After are real document types in their own right, and the people who use this
 * expect a photo marked "Before" to show up under Before Photos. Every other image is a site
 * photo. Anything that is not an image is 'Other' -- honest, and correctable in one click --
 * rather than being claimed as a photograph.
 */
function documentType(contentType, category) {
  if (!isImage(contentType)) return 'Other';
  const c = String(category || '').trim().toLowerCase();
  if (c === 'before') return 'Before Photos';
  if (c === 'after') return 'After Photos';
  return 'Site Photos';
}


module.exports = async function handler(req, res) {
  if (!H.methodGuard(req, res, 'POST')) return;
  if (!H.sessionModeGuard(res)) return;

  const ip = S.clientIp(req);
  const ua = S.userAgent(req);

  const auth = await S.authenticate(req);
  if (!auth.ok) return H.fail(res, auth.status || 401, auth.reason || 'unauthorised', auth.detail);

  // sessionRateLimit returns a RESULT OBJECT, never a boolean, so `if (limited)` was always
  // true and refused every upload with 429. The check is on .ok, as in api/at.js.
  const rl = H.sessionRateLimit(auth.sid);
  if (!rl.ok) {
    await A.auditNow({
      ip, userAgent: ua, module: 'documents',
      userEmail: auth.email, userRecordId: auth.userRecordId, sessionId: auth.sid,
      action: 'Create', result: 'Denied', denialReason: 'rate_limited',
    });
    return H.tooManyRequests(res, rl.retryAfter);
  }

  let body;
  try { body = await H.readBody(req); }
  catch (e) { return H.fail(res, 400, e.code || 'bad_request', e.message); }

  const baseSymbol = String(body.base || '');
  const siteId = String(body.siteId || '');
  // A document may be filed against a job card instead of a site. Documents.Job Card is what
  // that link field is for, and it is how the rest of the platform already scopes documents.
  const jobCardId = String(body.jobCardId || '').slice(0, 40);
  const filename = String(body.filename || '').slice(0, 200);
  const contentType = String(body.contentType || 'application/octet-stream').slice(0, 120);
  const category = String(body.category || 'Site').slice(0, 60);
  const description = String(body.description || '').slice(0, 500);
  const confirmed = body.confirmedOperational === true;

  // An explicit human classification, which outranks the automatic verdict in ONE direction
  // freely and in the other only for an admin:
  //   'fica'        — "this IS FICA". Honoured from anyone, always refuses. Saying "keep this
  //                   out" needs no privilege.
  //   'operational' — "this is NOT FICA". Overrules a BLOCKED verdict, admin only.
  const classification = ['operational', 'fica'].indexOf(String(body.classification || '')) >= 0
    ? String(body.classification)
    : '';

  if ((!siteId && !jobCardId) || !filename || !body.content) {
    return H.fail(res, 400, 'bad_request',
      'A site or a job card, a filename and file content are required.');
  }

  const ctx = {
    ip, userAgent: ua, module: 'documents', base: baseSymbol,
    userEmail: auth.email, userRecordId: auth.userRecordId, sessionId: auth.sid,
  };

  // Writing a document against a site is a change to that site, and it creates a document.
  const perms = auth.perms;
  for (const [mod, op] of [['documents', 'create'], ['site_information', 'edit']]) {
    const allowed = P.can(perms, mod, op);
    if (!allowed.ok) {
      await A.auditNow({ ...ctx, action: 'Create', result: 'Denied', denialReason: allowed.reason });
      return H.fail(res, allowed.status, allowed.reason,
        'You may not upload documents against a site.');
    }
  }

  // Filing against a job card means reading that job card, so the role must be allowed to.
  let jobCard = null;
  if (jobCardId) {
    const allowed = P.can(perms, 'job_cards', 'view');
    if (!allowed.ok) {
      await A.auditNow({ ...ctx, action: 'Create', result: 'Denied', denialReason: allowed.reason });
      return H.fail(res, allowed.status, allowed.reason,
        'You may not file documents against a job card.');
    }
    jobCard = T.resolve(baseSymbol, 'job_cards');
    if (!jobCard.ok) return H.fail(res, jobCard.status, jobCard.reason, jobCard.detail);
  }

  const site = T.resolve(baseSymbol, 'site_information');
  if (!site.ok) return H.fail(res, site.status, site.reason, site.detail);
  const docs = T.resolve(baseSymbol, 'documents');
  if (!docs.ok) return H.fail(res, docs.status, docs.reason, docs.detail);

  let buf;
  try { buf = Buffer.from(String(body.content), 'base64'); }
  catch (e) { return H.fail(res, 400, 'bad_request', 'The file content could not be decoded.'); }
  if (!buf.length) return H.fail(res, 400, 'bad_request', 'The file is empty.');
  if (buf.length > MAX_BYTES) {
    return H.fail(res, 413, 'file_too_large',
      `That file is ${(buf.length / 1048576).toFixed(1)} MB. The limit is ${MAX_BYTES / 1048576} MB.`);
  }

  // ── the control ──────────────────────────────────────────────────────────
  const verdict = await classifyDeep({ filename, contentType, buf });
  const isAdmin = mayClassify(auth.role, auth.user);
  let overrode = false;

  // A person saying "this IS FICA" is always honoured, whatever the classifier concluded and
  // whoever they are. Keeping material OUT never requires a privilege.
  if (classification === 'fica') {
    await A.auditNow({
      ...ctx, action: 'Create', result: 'Denied', denialReason: 'classified_fica_by_user',
      field: 'File', newValue: filename + ' — classified as FICA by ' + auth.email
        + ' (automatic verdict: ' + verdict.verdict + ')',
    });
    return H.fail(res, 422, 'classified_fica',
      'You marked this file as FICA or financial, so it was not uploaded.',
      { verdict: verdict.verdict, classification });
  }

  if (verdict.verdict === 'BLOCKED') {
    // An admin may overrule this. Anyone else cannot, and is told an admin can.
    if (!(classification === 'operational' && isAdmin)) {
      // Log the refusal but NEVER the file's contents — the whole point is that this material
      // does not enter the system, and that includes the logs.
      await A.auditNow({
        ...ctx, action: 'Create', result: 'Denied', denialReason: 'sensitive_content',
        field: 'File', newValue: filename,
      });
      return H.fail(res, 422, 'sensitive_content',
        'This file appears to contain FICA or financial information and cannot be uploaded to '
        + 'the Site Information module.'
        + (isAdmin ? ' You may classify it as operational if you have checked it yourself.' : ''),
        { verdict: 'BLOCKED', canOverride: isAdmin });
    }
    overrode = true;
  } else if (verdict.verdict === 'REVIEW' && !confirmed && classification !== 'operational') {
    await A.auditNow({
      ...ctx, action: 'Create', result: 'Denied', denialReason: 'unclassified_content',
      field: 'File', newValue: filename,
    });
    return H.fail(res, 422, 'review_required',
      verdict.reason + ' Confirm it contains only operational information, or remove it.',
      { verdict: 'REVIEW', canOverride: isAdmin });
  }

  // AN OVERRIDE IS A SEPARATE, LOUD AUDIT ENTRY, written before the upload is attempted.
  // If the upload then fails, the record of who overruled the control still exists. This is the
  // only route by which material the classifier condemned can enter the module, so it must never
  // be inferable only from the absence of a refusal.
  if (overrode) {
    await A.auditNow({
      ...ctx, action: 'Create', result: 'Allowed', denialReason: 'fica_override',
      field: 'File', newValue: filename + ' — automatic verdict BLOCKED ('
        + verdict.reason + '), classified operational by ' + auth.email,
    });
  }

  try {
    // Read whichever record this document is being filed against, so a bad id fails before
    // anything is created rather than leaving an orphaned document behind.
    let note = null;
    let card = null;
    if (siteId) {
      note = await at.get(site.baseId, site.tableId, siteId).catch(() => null);
      if (!note) return H.fail(res, 404, 'not_found', 'That site could not be read.');
    }
    if (jobCardId) {
      card = await at.get(jobCard.baseId, jobCard.tableId, jobCardId).catch(() => null);
      if (!card) return H.fail(res, 404, 'not_found', 'That job card could not be read.');
    }

    // at.create takes plain field objects and wraps each in { fields } itself, and it returns
    // an ARRAY of records rather than { records: [...] }.
    const created = await at.create(docs.baseId, docs.tableId, [{
      'Document Name': (description || filename).slice(0, 200),

      // WHAT KIND OF DOCUMENT THIS IS, worked out from the file rather than assumed.
      //
      // This was hard-coded to 'Site Photos' for every upload, which filed BOM spreadsheets,
      // SOWs and CoC scans in the Photos tab as though they were photographs of a roof. The
      // chosen category was not written to a field at all -- it went into the Notes string,
      // where nothing can filter or group by it.
      'Document Type': documentType(contentType, category),

      // WHAT THE PHOTO SHOWS, which is a different question from what kind of file it is.
      // Empty for anything that is not an image: a BOM has no photo subject, and an empty
      // cell says that honestly where 'Site' would not.
      ...(isImage(contentType) ? { 'Photo Category': photoCategory(category) } : {}),
      // Linked AT CREATION rather than by a follow-up patch. A second write needs a second
      // permission and can fail on its own, which is exactly how the delivery app ended up
      // with orphaned signature records.
      ...(jobCardId ? { 'Job Card': [jobCardId] } : {}),
      Notes: [
        category,
        description,
        'Uploaded by ' + auth.email,
        // Visible on the document itself, not only in the audit log: someone reading this
        // record months later must be able to see that a person overruled the classifier.
        overrode ? 'Classified operational by ' + auth.email
          + ' after an automatic FICA/financial block.' : '',
      ].filter(Boolean).join(' — ').slice(0, 500),
      // NEITHER "Uploaded By" NOR "Date" IS WRITTEN, and both omissions are deliberate.
      //
      // "Uploaded By" is a singleCollaborator field. It can only hold an Airtable collaborator,
      // and the people who use this app deliberately do not have Airtable accounts — that is the
      // whole point of the proxy. Sending an email string to it fails with "Cannot parse value",
      // which is what refused 33 uploads in a row on the first real folder anyone dropped.
      //
      // "Date" is a createdTime field. Airtable computes it; writing to it is an error, and it
      // was the next failure waiting behind the first.
      //
      // The uploader is therefore recorded in Notes, which is free text. See the README note
      // about adding an "Uploaded By (App)" text field — the convention Site Information already
      // uses (Created By (App)) precisely because collaborator fields cannot hold an app user.
      // Operational site material. Never Restricted: nothing sensitive is permitted here, and
      // marking it so would hide it from the very people who need it on site.
      Sensitivity: 'Internal',
    }]);
    const doc = (Array.isArray(created) ? created : (created.records || []))[0];
    if (!doc) throw new Error('The document record could not be created.');

    // Attachments go through the content API, which takes the bytes as base64.
    const maps = await at.fieldMaps(docs.baseId, docs.tableId);
    const fileFieldId = maps.nameToId.File;
    if (!fileFieldId) throw new Error('The Documents table has no File field.');

    const up = await fetch(
      `https://content.airtable.com/v0/${docs.baseId}/${doc.id}/${fileFieldId}/uploadAttachment`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + process.env.AIRTABLE_PAT,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ contentType, file: String(body.content), filename }),
      },
    );
    if (!up.ok) {
      const d = await up.json().catch(() => ({}));
      throw new Error('Airtable refused the attachment: '
        + String((d.error && (d.error.message || d.error.type)) || up.status));
    }

    // Link it to the site, so the gallery can find it by the site's own link array. A document
    // filed against a job card is NOT added here: Airtable maintains the reverse link on the
    // job card itself, and adding it to the site as well would make one file appear twice.
    if (siteId) {
      const existing = (note.fields.Documents || []).map((x) => (typeof x === 'string' ? x : x.id));
      await at.update(site.baseId, site.tableId, siteId, {
        Documents: existing.concat(doc.id),
        'Modified By (App)': auth.email,
        'Modified Date': new Date().toISOString(),
      });
    }

    await A.auditNow({
      ...ctx, action: 'Create', result: 'Allowed', recordId: doc.id,
      field: 'File',
      newValue: filename + ' → ' + (jobCardId
        ? 'job card ' + ((card && card.fields['JC Reference']) || jobCardId)
        : ((note && note.fields['Site Name']) || siteId)),
    });

    const fresh = await at.get(docs.baseId, docs.tableId, doc.id).catch(() => doc);
    return H.ok(res, { record: fresh, verdict: verdict.verdict, overridden: overrode });
  } catch (err) {
    // Never echo the file's contents into an error.
    return H.fail(res, 500, 'upload_failed', String(err.message || err).slice(0, 300));
  }
};

// Exported for the test suite: this is the control, so it is asserted directly rather
// than only through a live upload.
module.exports.classify = classify;
module.exports.classifyDeep = classifyDeep;
module.exports.pdfText = pdfText;
module.exports.textVerdict = textVerdict;
module.exports.mayClassify = mayClassify;

// Exposed for the test suite. Which of two labels a file gets is the thing this module was
// getting wrong, so it is the thing worth testing directly.
module.exports.documentType = documentType;
module.exports.photoCategory = photoCategory;
module.exports.isImage = isImage;
module.exports.PHOTO_CATEGORIES = PHOTO_CATEGORIES;
