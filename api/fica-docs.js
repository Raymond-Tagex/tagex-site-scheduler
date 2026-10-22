// POST /api/fica-docs — FICA pages split out of a scanned PDF.
//
// A site pack arrives as one scan: the job card, the CoC, the SLD -- and, somewhere in the
// middle, a copy of the owner's ID and a bank statement. Site Information refuses the whole file
// (api/siteinfo-upload.js), which is right, but it leaves the person holding a PDF they cannot
// file anywhere. public/js/siteinfo-split.js renders the PDF to pages in the browser and asks
// this route which pages look like FICA; the person confirms; the FICA pages are filed HERE, in
// the restricted FICA Documents table, and the rest go through the ordinary import routes.
//
//   classify  page pictures in, a verdict per page out. WRITES NOTHING and never returns the
//             text it read: OCR text of an ID page is the ID number.
//   create    one FICA Documents record for one source PDF, against one site. No file yet.
//   attach    one confirmed page (a one-page PDF) onto that record. One page per request
//             because Vercel refuses a body over ~4.5 MB.
//   index     what is filed against one site: names, pages, who and when. Never a file.
//   open      one filed page, as bytes. The read that is audited as a restricted view.
//
// Everything but classify is the restricted_personal gate, the same one /api/at applies: the
// role's permission AND the per-user Can View Restricted Documents flag. One table in O&M for
// sites in every base (tables.js, OM_ONLY), so a site is named by base and record id.
//
// The verdict is a SUGGESTION. Tesseract does not read handwriting and a clean read is not
// evidence of a clean page, so a page it could barely read is 'unsure', never 'other' -- the
// same asymmetry as classifyDeep: unreadable never clears.

'use strict';

const T = require('./_lib/tables.js');
const P = require('./_lib/permissions.js');
const at = require('./_lib/airtable.js');
const S = require('./_lib/session.js');
const H = require('./_lib/http.js');
const A = require('./_lib/audit.js');
const U = require('./siteinfo-upload.js');

// Pages per classify request: ~2.5s of OCR each inside a 60s function, and three page JPEGs
// (~0.5 MB each, a third more as base64) well inside the body limit.
const CLASSIFY_MAX_PAGES = 3;
// One page per attach. A rendered page is far smaller; this is a ceiling, not a target.
const ATTACH_MAX_BYTES = 3 * 1024 * 1024;
// Fewer readable characters than this and the page is 'unsure': a photographed ID card or a
// handwritten form often yields a few stray words, which is not a reading.
const MIN_READ_CHARS = 120;

const REC_RE = /^rec[A-Za-z0-9]{14}$/;

/**
 * One page's verdict from its OCR text.
 *   fica   the text says FICA, identity or banking (siteinfo-upload's TEXT_BLOCK rules)
 *   unsure too little was read to say -- a person must decide, and the screen defaults it to FICA
 *   other  enough was read, and none of it looked personal
 */
function pageVerdict(text) {
  const s = String(text || '');
  if (U.textVerdict(s)) return { verdict: 'fica', reason: 'The page text looks like FICA, identity or banking.' };
  if (s.replace(/\s+/g, '').length < MIN_READ_CHARS) {
    return { verdict: 'unsure', reason: 'Too little of the page could be read to tell.' };
  }
  return { verdict: 'other', reason: 'Nothing personal was found in the text that could be read.' };
}

/**
 * Both flags, always. canViewRestricted() asks for them only when the role's rule says
 * require_user_flag, which the seeded Admin rule does -- but a role edited without it would then
 * reach FICA files on the role alone. Rule 6 is not something a Permissions JSON can switch off.
 */
const doubleGate = (rule, auth) => P.canViewRestricted(
  Object.assign({}, rule, { require_user_flag: true }), auth.role, auth.user);

/** The restricted_personal gate for one verb, audited when it refuses. */
async function gate(auth, verb, ctx) {
  const action = verb === 'view' ? 'View' : verb === 'create' ? 'Create' : 'Update';
  const allowed = P.can(auth.perms, 'restricted_personal', verb);
  if (!allowed.ok) {
    await A.auditNow({ ...ctx, action, result: 'Denied', denialReason: allowed.reason });
    return { ok: false, status: allowed.status, reason: allowed.reason, detail: allowed.detail };
  }
  const g = doubleGate(allowed.rule, auth);
  if (!g.ok) {
    await A.auditNow({ ...ctx, action, result: 'Denied', denialReason: g.reason });
    return g;
  }
  return { ok: true };
}

/** Whether this person may file FICA pages at all, for the screen to say so up front. */
function mayFile(auth) {
  const c = P.can(auth.perms, 'restricted_personal', 'create');
  return c.ok && doubleGate(c.rule, auth).ok;
}

module.exports = async function handler(req, res) {
  if (!H.methodGuard(req, res, 'POST')) return;
  if (!H.sessionModeGuard(res)) return;

  const auth = await S.authenticate(req);
  if (!auth.ok) return H.fail(res, auth.status || 401, auth.reason || 'unauthorised', auth.detail);

  const ctx = {
    ip: S.clientIp(req), userAgent: S.userAgent(req),
    module: 'restricted_personal', table: 'restricted_personal/fica_documents', base: 'OM',
    userEmail: auth.email, userRecordId: auth.userRecordId, sessionId: auth.sid,
  };

  // The same two states /api/at stops at: a session that must change its password or enrol in
  // MFA reaches no data, and certainly not this.
  if (auth.user['Must Change Password'] === true) {
    await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: 'password_change_required' });
    return H.fail(res, 403, 'password_change_required', 'You must set a new password before continuing.');
  }
  if (S.mustEnrolMfa(auth.role, auth.user)) {
    await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: 'mfa_enrolment_required' });
    return H.fail(res, 403, 'mfa_enrolment_required',
      'Two-factor authentication is mandatory for administrators. Complete enrolment to continue.');
  }

  const rl = H.sessionRateLimit(auth.sid);
  if (!rl.ok) {
    await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: 'rate_limited' });
    return H.tooManyRequests(res, rl.retryAfter);
  }

  let body;
  try { body = await H.readBody(req); }
  catch (e) { return H.fail(res, 400, e.code || 'bad_request', e.message); }
  const op = String(body.op || '');

  // ── classify: writes nothing ─────────────────────────────────────────────
  if (op === 'classify') {
    // Splitting a PDF is part of importing into Site Information, so that is the right asked of
    // it. It reads pictures the caller already holds and returns verdicts, nothing more.
    const allowed = P.can(auth.perms, 'site_information', 'view');
    if (!allowed.ok) {
      await A.auditNow({ ...ctx, module: 'site_information', table: undefined, action: 'View', result: 'Denied', denialReason: allowed.reason });
      return H.fail(res, allowed.status, allowed.reason, allowed.detail);
    }
    const pages = Array.isArray(body.pages) ? body.pages : [];
    if (!pages.length || pages.length > CLASSIFY_MAX_PAGES) {
      return H.fail(res, 400, 'bad_request', `Send between 1 and ${CLASSIFY_MAX_PAGES} pages.`);
    }
    const ocr = require('./_lib/ocr.js');
    const out = [];
    for (const p of pages) {
      const page = Number(p && p.page) || 0;
      let buf;
      try { buf = Buffer.from(String((p && p.content) || ''), 'base64'); } catch (e) { buf = null; }
      if (!buf || !buf.length) { out.push({ page, verdict: 'unsure', reason: 'The page picture was empty.' }); continue; }
      let text = '';
      try { text = (await ocr.recognise(buf)).text || ''; }
      catch (e) { out.push({ page, verdict: 'unsure', reason: 'The page could not be read.' }); continue; }
      // The text itself is NOT returned, logged or kept. On an ID page it is the ID number.
      out.push({ page, ...pageVerdict(text) });
    }
    return H.ok(res, { pages: out, mayFile: mayFile(auth) });
  }

  if (['create', 'attach', 'index', 'open'].indexOf(op) < 0) {
    return H.fail(res, 400, 'bad_request', 'op must be one of: classify, create, attach, index, open.');
  }

  const verb = op === 'create' ? 'create' : op === 'attach' ? 'edit' : 'view';
  const g = await gate(auth, verb, ctx);
  if (!g.ok) return H.fail(res, g.status, g.reason, g.detail);

  const fica = T.resolve('OM', 'restricted_personal', 'fica_documents');
  if (!fica.ok) return H.fail(res, fica.status, fica.reason, fica.detail);

  try {
    // ── create ───────────────────────────────────────────────────────────────
    if (op === 'create') {
      const siteBase = String(body.siteBase || '');
      const siteId = String(body.siteId || '');
      if (T.OPS_BASES.indexOf(siteBase) < 0 || !REC_RE.test(siteId)) {
        return H.fail(res, 400, 'bad_request', 'A site (its base and record id) is required.');
      }
      const pages = (Array.isArray(body.pages) ? body.pages : []).map(Number).filter((n) => n > 0);
      const pageCount = Number(body.pageCount) || 0;
      if (!pages.length) return H.fail(res, 400, 'bad_request', 'No pages were confirmed as FICA.');
      const sourceFile = String(body.sourceFile || 'scan.pdf').slice(0, 200);

      // The site's name is read from the site, not taken from the caller: it is what someone
      // will search by months from now, so it must be the real one.
      const site = T.resolve(siteBase, 'site_information');
      if (!site.ok) return H.fail(res, site.status, site.reason, site.detail);
      const rec = await at.get(site.baseId, site.tableId, siteId).catch(() => null);
      if (!rec) return H.fail(res, 404, 'not_found', 'That site could not be read.');
      const siteName = String(rec.fields['Site Name'] || '').slice(0, 200);

      const detection = (Array.isArray(body.detection) ? body.detection : []).slice(0, 500)
        .map((d) => 'Page ' + (Number(d && d.page) || '?') + ': read as ' + String((d && d.verdict) || '?').slice(0, 10)
          + (d && d.verdict !== 'fica' ? ', confirmed FICA by ' + auth.email : ''))
        .join('\n');

      const created = await at.create(fica.baseId, fica.tableId, [{
        'Document Name': ('FICA — ' + (siteName || siteId) + ' — ' + sourceFile).slice(0, 200),
        'Source File': sourceFile,
        Pages: pages.join(', ') + (pageCount ? ' of ' + pageCount : ''),
        'Site Base': siteBase,
        'Site Record ID': siteId,
        'Site Name': siteName,
        Detection: detection.slice(0, 5000),
        'Filed By (App)': auth.email,
        'Filed At': new Date().toISOString(),
        'Record Status': 'Active',
      }]);
      const doc = (Array.isArray(created) ? created : (created.records || []))[0];
      if (!doc) throw new Error('The FICA record could not be created.');
      await A.auditNow({
        ...ctx, action: 'Create', result: 'Allowed', recordId: doc.id,
        newValue: sourceFile + ' pages ' + pages.join(', ') + ' → ' + siteBase + ' ' + (siteName || siteId),
      });
      S.markSessionTouchedRestricted(auth.sid).catch(() => {});
      return H.ok(res, { id: doc.id });
    }

    // Every other op names one FICA record.
    const id = String(body.id || '');

    // ── attach ───────────────────────────────────────────────────────────────
    if (op === 'attach') {
      if (!REC_RE.test(id)) return H.fail(res, 400, 'bad_request', 'A FICA record id is required.');
      const page = Number(body.page) || 0;
      let buf;
      try { buf = Buffer.from(String(body.content || ''), 'base64'); } catch (e) { buf = null; }
      if (!buf || !buf.length) return H.fail(res, 400, 'bad_request', 'The page is empty.');
      if (buf.length > ATTACH_MAX_BYTES) return H.fail(res, 413, 'file_too_large', 'That page is too large to file.');
      if (buf.slice(0, 5).toString('latin1') !== '%PDF-') {
        return H.fail(res, 400, 'bad_request', 'A page is filed as a PDF.');
      }

      const rec = await at.get(fica.baseId, fica.tableId, id).catch(() => null);
      // Pages are added only by whoever filed the record, while it is live: attach is the second
      // half of create, not a way to slip a file into somebody else's record.
      if (!rec || rec.fields['Record Status'] === 'Deleted' || rec.fields['Filed By (App)'] !== auth.email) {
        await A.auditNow({ ...ctx, action: 'Update', result: 'Denied', denialReason: 'scope_excluded', recordId: id });
        return H.fail(res, 404, 'not_found', 'No such record, or it is outside your access.');
      }

      const maps = await at.fieldMaps(fica.baseId, fica.tableId);
      const fileFieldId = maps.nameToId.File;
      if (!fileFieldId) throw new Error('The FICA Documents table has no File field.');
      const filename = (String(rec.fields['Source File'] || 'scan.pdf').replace(/\.pdf$/i, '')
        + ' — page ' + page + '.pdf').slice(0, 200);
      const up = await fetch(
        `https://content.airtable.com/v0/${fica.baseId}/${id}/${fileFieldId}/uploadAttachment`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + process.env.AIRTABLE_PAT, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentType: 'application/pdf', file: buf.toString('base64'), filename }),
        },
      );
      if (!up.ok) {
        const d = await up.json().catch(() => ({}));
        throw new Error('Airtable refused the page: '
          + String((d.error && (d.error.message || d.error.type)) || up.status));
      }
      await A.auditNow({ ...ctx, action: 'Update', result: 'Allowed', recordId: id, field: 'File', newValue: filename });
      return H.ok(res, { id, page });
    }

    // ── index ────────────────────────────────────────────────────────────────
    if (op === 'index') {
      const siteBase = String(body.siteBase || '');
      const siteId = String(body.siteId || '');
      if (T.OPS_BASES.indexOf(siteBase) < 0 || !REC_RE.test(siteId)) {
        return H.fail(res, 400, 'bad_request', 'A site (its base and record id) is required.');
      }
      // Not a list view: one site's entries, by an exact match the server writes itself, with no
      // file and no field a person's details could be in. The caller cannot widen the filter.
      const rows = await at.list(fica.baseId, fica.tableId, {
        filterByFormula: `AND({Site Base} = '${siteBase}', {Site Record ID} = '${siteId}', {Record Status} != 'Deleted')`,
        fields: ['Source File', 'Pages', 'Filed By (App)', 'Filed At', 'File'],
      }, 200);
      const entries = rows.map((r) => ({
        id: r.id,
        sourceFile: r.fields['Source File'] || '',
        pages: r.fields.Pages || '',
        filedBy: r.fields['Filed By (App)'] || '',
        filedAt: r.fields['Filed At'] || '',
        files: (r.fields.File || []).length,
      }));
      await A.auditNow({
        ...ctx, action: 'Restricted Document Viewed', result: 'Allowed',
        recordId: entries.length + ' FICA record(s) indexed for ' + siteBase + ' ' + siteId,
      });
      S.markSessionTouchedRestricted(auth.sid).catch(() => {});
      return H.ok(res, { entries });
    }

    // ── open ─────────────────────────────────────────────────────────────────
    if (!REC_RE.test(id)) return H.fail(res, 400, 'bad_request', 'A FICA record id is required.');
    const n = Number(body.n) || 0;
    const rec = await at.get(fica.baseId, fica.tableId, id).catch(() => null);
    const file = rec && rec.fields['Record Status'] !== 'Deleted' && (rec.fields.File || [])[n];
    if (!file) {
      await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: 'scope_excluded', recordId: id });
      return H.fail(res, 404, 'not_found', 'No such record, or it is outside your access.');
    }
    // The bytes come through here rather than the browser being handed Airtable's link: that
    // link works for anyone holding it for hours, and FICA material never travels in a URL.
    const got = await fetch(file.url);
    if (!got.ok) throw new Error('The page could not be fetched from Airtable.');
    const bytes = Buffer.from(await got.arrayBuffer());
    await A.auditNow({
      ...ctx, action: 'Restricted Document Viewed', result: 'Allowed', recordId: id,
      field: 'File', newValue: file.filename || ('page ' + (n + 1)),
    });
    S.markSessionTouchedRestricted(auth.sid).catch(() => {});
    return H.ok(res, {
      filename: file.filename || 'fica-page.pdf',
      contentType: file.type || 'application/pdf',
      content: bytes.toString('base64'),
    });
  } catch (err) {
    // Never echo a file or a page's text into an error.
    return H.fail(res, 500, 'fica_failed', String(err.message || err).slice(0, 300));
  }
};

// Exported for the test suite.
module.exports.pageVerdict = pageVerdict;
module.exports.mayFile = mayFile;
module.exports.CLASSIFY_MAX_PAGES = CLASSIFY_MAX_PAGES;
module.exports.MIN_READ_CHARS = MIN_READ_CHARS;
