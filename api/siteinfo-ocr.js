// POST /api/siteinfo-ocr — read a jobcard, then propose a site record from it.
//
// THIS ENDPOINT WRITES NOTHING.
//
// It reads a document, reads Airtable, and returns a PROPOSAL. Creating or updating the site
// still goes through /api/at, which audits every field and re-checks the role. That split is
// deliberate: OCR is guesswork, so the guessing stays on a route that cannot change anything,
// and the route that can change things keeps the controls it already had.
//
// THE ORDER OF PRECEDENCE MATTERS
//
// A site that already exists in C&I or O&M is the authority on itself. OCR only fills fields
// that Airtable left blank. A scanner misreading "SOL-88214" as "S0L-8B214" must never be able
// to overwrite the real number that is already on the record — so `existing` wins, always, and
// every case where the two disagree is reported as a conflict for a person to settle.

'use strict';

const T = require('./_lib/tables.js');
const P = require('./_lib/permissions.js');
const at = require('./_lib/airtable.js');
const S = require('./_lib/session.js');
const H = require('./_lib/http.js');
const A = require('./_lib/audit.js');
const ocr = require('./_lib/ocr.js');
const JC = require('./_lib/jobcard-parse.js');
const SPEC = require('./_lib/spec-extract.js');
const upload = require('./siteinfo-upload.js');

// Vercel caps a request body at ~4.5 MB, and base64 inflates by a third. This is the largest
// file that can actually arrive, stated here so the refusal is ours and legible rather than a
// bare platform 413. The client downsamples photographs before sending for the same reason.
const MAX_BYTES = 3 * 1024 * 1024;

const BASES = ['CI', 'OM'];

/** Airtable formula string literal. */
const lit = P.lit;

/** Loose comparison for matching a scanned name against a stored one. */
function key(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Does a scanned name refer to the same site as a stored one?
 *
 * Exact match after normalisation, or one wholly containing the other — "ALAN AUCAMP" against
 * "ALAN AUCAMP RESIDENCE". Deliberately not fuzzy: a near miss here would merge two different
 * sites, which is far more damaging than failing to spot a match and creating a duplicate the
 * duplicate check will then flag.
 */
function namesMatch(a, b) {
  const x = key(a);
  const y = key(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 6 && y.indexOf(x) === 0) return true;
  if (y.length >= 6 && x.indexOf(y) === 0) return true;
  return false;
}

/** Every site in both bases whose name matches, with the base it came from. */
async function findSites(name) {
  if (!key(name)) return [];
  const out = [];
  for (const b of BASES) {
    const t = T.resolve(b, 'site_information');
    if (!t.ok) continue;
    // Fetched by prefix rather than by exact formula: Airtable's FIND is case sensitive in
    // some paths and the scan's casing is not trustworthy, so the comparison happens here.
    const page = await at.list(t.baseId, t.tableId, { pageSize: 100 }, 2000).catch(() => null);
    const recs = (page && (page.records || page)) || [];
    for (const r of recs) {
      if (namesMatch(name, r.fields && r.fields['Site Name'])) out.push({ base: b, record: r });
    }
  }
  return out;
}

/**
 * A job card by its reference, in either base.
 *
 * THE FIELD IS "JC Reference". This queried {Job Card Number} — which does not exist on the
 * table — so Airtable rejected the formula, the .catch swallowed the error, and every run
 * reported "no job card found". The entire job-card rank of the precedence chain was dead from
 * the day it was written, silently, because a lookup that errors and a lookup that finds
 * nothing both arrive here as null.
 */
async function findJobCard(reference) {
  const n = String(reference || '').trim();
  if (!n) return null;
  for (const b of BASES) {
    const t = T.resolve(b, 'job_cards');
    if (!t.ok) continue;
    const rec = await at.findOne(t.baseId, t.tableId,
      `{JC Reference} = ${lit(n)}`).catch(() => null);
    if (rec) return { base: b, record: rec };
  }
  return null;
}

/** One job card by record id, when the caller has already chosen it. */
async function getJobCard(baseSymbol, recordId) {
  const bases = baseSymbol ? [baseSymbol] : BASES;
  for (const b of bases) {
    const t = T.resolve(b, 'job_cards');
    if (!t.ok) continue;
    const rec = await at.get(t.baseId, t.tableId, recordId).catch(() => null);
    if (rec && rec.fields) return { base: b, record: rec };
  }
  return null;
}

/** The Site Information record a job card is linked to, if any. */
async function siteForJobCard(base, jobCard) {
  const ids = (jobCard.fields['Site Information'] || [])
    .map((x) => (typeof x === 'string' ? x : x && x.id))
    .filter(Boolean);
  if (!ids.length) return null;
  const t = T.resolve(base, 'site_information');
  if (!t.ok) return null;
  const rec = await at.get(t.baseId, t.tableId, ids[0]).catch(() => null);
  return rec && rec.fields ? { base, record: rec } : null;
}

/** A client by name, in either base. */
async function findClient(name) {
  if (!key(name)) return null;
  for (const b of BASES) {
    const t = T.resolve(b, 'clients');
    if (!t.ok) continue;
    const page = await at.list(t.baseId, t.tableId, { pageSize: 100 }, 2000).catch(() => null);
    const recs = (page && (page.records || page)) || [];
    for (const r of recs) {
      const f = r.fields || {};
      const nm = f['Client Name'] || f.Name || f['Company Name'];
      if (namesMatch(name, nm)) return { base: b, record: r };
    }
  }
  return null;
}

// Job Card / Client fields worth carrying onto a site, and where they land. Airtable is the
// authority for these, so they are applied BEFORE the OCR values and never overwritten by them.
// Read off the live Job Cards schema, not guessed. The previous version named six fields that
// do not exist on the table ("Site Address", "Project Manager", "Date Issued"...), so even once
// the lookup above was fixed it would have contributed nothing.
//
// "Title" is deliberately NOT mapped to Site Name: it holds the job description — "ADDITIONAL
// BATTERY", "Battery analysis and report to client" — and writing that as a site name would
// quietly rename the site after whatever work was last done there.
const FROM_JOBCARD = {
  'JC Reference': JC.FIELD.jcNumber,
  'Client Name': JC.FIELD.clientName,     // lookup: [client, address]
  'Site / Address': JC.FIELD.address,     // lookup
  'Job Type': JC.FIELD.siteType,          // "Residential" etc — checked against the options
  'Issued Date': JC.FIELD.issued,
  'Started Project': JC.FIELD.start,
  'Completed Project': JC.FIELD.end,
};

const FROM_CLIENT = {
  'Client Name': JC.FIELD.clientName,
  'Physical Address': JC.FIELD.address,
  'Postal Address': JC.FIELD.postal,
  'Contact Person': JC.FIELD.contact,
  'Cell Number': JC.FIELD.cell,
  'Telephone': JC.FIELD.altNo,
  'Email': JC.FIELD.email,
  'Email Address': JC.FIELD.email,
};

/**
 * Plain scalar, or '' for anything a site field must not be given.
 *
 * An array needs care: a LOOKUP arrives as an array of values (["14 DRIVER AVENUE, CLUBVIEW"])
 * and is worth reading, while a LINK arrives as an array of record ids (["recYK5Bc9pvHkZxYT"])
 * and must never be written into a text field. Rejecting every array dropped both, which is why
 * the job card's address and client never reached a proposal.
 *
 * A collaborator field arrives as { id, email, name } — its name is the useful part.
 */
function scalar(v) {
  if (v == null) return '';
  if (Array.isArray(v)) {
    const first = v.find((x) => typeof x === 'string' || typeof x === 'number');
    if (first == null) return '';
    if (typeof first === 'string' && /^rec[A-Za-z0-9]{14,}$/.test(first)) return '';
    return first;
  }
  if (typeof v === 'object') return v.name ? String(v.name) : '';
  if (typeof v === 'number') return v;
  // A multi-line address arrives as one string with newlines. Left alone it renders as
  // "Perseel H68Loskop NoordMarble Hall" — the lines run together with nothing between them.
  return String(v).replace(/\s*\r?\n\s*/g, ', ').replace(/,\s*,/g, ',').trim();
}

/**
 * Fold a source record's fields into the proposal, without ever displacing what is already there.
 * @returns {number} how many fields it contributed
 */
function foldIn(into, provenance, sourceFields, map, label) {
  let n = 0;
  for (const [from, to] of Object.entries(map)) {
    if (!to) continue;
    if (Object.prototype.hasOwnProperty.call(into, to)) continue;
    const v = scalar(sourceFields[from]);
    if (v === '' || v == null) continue;
    // A single select only accepts one of its own options, and typecast is off, so proposing
    // anything else turns into a failed write at the end of the flow rather than here.
    // Job Type "Residential" is a valid Site Type; "SUB-RES" is not, and is left for a person.
    if (JC.SELECTS[to] && !JC.matchSelect(to, v)) continue;
    into[to] = JC.SELECTS[to] ? JC.matchSelect(to, v) : v;
    provenance[to] = label;
    n++;
  }
  return n;
}

module.exports = async function handler(req, res) {
  if (!H.methodGuard(req, res, 'POST')) return;
  if (!H.sessionModeGuard(res)) return;

  const auth = await S.authenticate(req);
  if (!auth.ok) return H.fail(res, auth.status || 401, auth.reason || 'unauthorised', auth.detail);

  const ctx = {
    ip: S.clientIp(req), userAgent: S.userAgent(req), module: 'site_information',
    userEmail: auth.email, userRecordId: auth.userRecordId, sessionId: auth.sid,
  };

  // sessionRateLimit returns a RESULT OBJECT, never a boolean. `if (rl)` is therefore always
  // true and rejects every request with 429 — which is exactly what this route did on its first
  // day in production. The check is on rl.ok, as in api/at.js.
  const rl = H.sessionRateLimit(auth.sid);
  if (!rl.ok) {
    await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: 'rate_limited' });
    return H.tooManyRequests(res, rl.retryAfter);
  }

  let body;
  try { body = await H.readBody(req); }
  catch (e) { return H.fail(res, 400, e.code || 'bad_request', e.message); }

  const filename = String(body.filename || '').slice(0, 200);
  const contentType = String(body.contentType || 'application/octet-stream').slice(0, 120);
  // When the caller has already chosen a job card, that job card is the authority on which
  // site this is. Nothing is guessed from the scan.
  const jobCardId = String(body.jobCardId || '').slice(0, 40);
  const baseSymbol = ['CI', 'OM'].indexOf(String(body.base || '')) >= 0 ? String(body.base) : '';

  // Reading a jobcard in order to build a site is site_information work, and it reads job cards
  // and clients on the way. All three are checked, so a role that cannot see job cards cannot
  // use this route to read one.
  for (const [mod, op] of [['site_information', 'create'], ['job_cards', 'view'], ['clients', 'view']]) {
    const allowed = P.can(auth.perms, mod, op);
    if (!allowed.ok) {
      await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: allowed.reason });
      return H.fail(res, allowed.status, allowed.reason, allowed.detail);
    }
  }

  // A job card on its own is enough to build a proposal — the record already says who the
  // client is and where the site is, so a scan is an optional extra rather than the only
  // source. Without a job card there is nothing to go on but the file, so one is required.
  const hasFile = !!(filename && body.content);
  if (!hasFile && !jobCardId) {
    return H.fail(res, 400, 'bad_request',
      'Choose a job card, or send a file to read.');
  }

  let buf = null;
  if (hasFile) {
    try { buf = Buffer.from(String(body.content), 'base64'); }
    catch (e) { return H.fail(res, 400, 'bad_request', 'The file content could not be decoded.'); }
    if (!buf.length) return H.fail(res, 400, 'bad_request', 'The file is empty.');
    if (buf.length > MAX_BYTES) {
      return H.fail(res, 413, 'file_too_large',
        `That file is ${(buf.length / 1048576).toFixed(1)} MB. The limit for reading is `
        + `${MAX_BYTES / 1048576} MB — photograph the jobcard at a lower resolution, or split the PDF.`);
    }
  }

  let read = { text: '', confidence: 0, pages: 0, note: '', available: 0 };
  let post = { verdict: 'ALLOWED', reason: 'No file was read.' };

  if (hasFile) {
  // ── the FICA control, before anything is read back to the caller ─────────
  //
  // Ordinary classification first, on the name and any text layer. Note the asymmetry: a BLOCKED
  // verdict ends the request, but a REVIEW verdict does NOT — this route writes nothing, and the
  // OCR below is exactly what turns an unreadable scan into a judgeable one.
  const pre = upload.classify({ filename, contentType, buf });
  if (pre.verdict === 'BLOCKED') {
    await A.auditNow({
      ...ctx, action: 'View', result: 'Denied', denialReason: 'sensitive_content',
      field: 'File', newValue: filename,
    });
    return H.fail(res, 422, 'sensitive_content',
      'This file appears to contain FICA or financial information and will not be read.');
  }

  try {
    read = await ocr.readDocument(buf, filename, contentType, 2);
  } catch (e) {
    return H.fail(res, 500, 'ocr_failed',
      'The document could not be read: ' + String(e.message || e).slice(0, 200));
  }

  // Now judge what OCR actually found. This is the point of running it in this module at all:
  // a scanned bank statement has no text layer and used to reach REVIEW, where a person could
  // wave it through. With the text in hand it can be blocked outright.
  post = upload.classify({
    filename, contentType: 'text/plain', buf: Buffer.from(read.text, 'utf8'),
  });
  if (post.verdict === 'BLOCKED') {
    await A.auditNow({
      ...ctx, action: 'View', result: 'Denied', denialReason: 'sensitive_content_ocr',
      field: 'File', newValue: filename,
    });
    return H.fail(res, 422, 'sensitive_content',
      'Reading this document showed FICA or financial content. It will not be used, and it '
      + 'must not be uploaded to Site Information.');
  }

  }
  // ── end of the read ─────────────────────────────────────────────────────

  // TWO READERS OVER THE SAME TEXT, because the documents are two different shapes.
  //
  // jobcard-parse reads FORMS — "Panel Quantity: 164". spec-extract reads PROSE and BILLS OF
  // MATERIAL — "15 x JA Solar JAM54S30-545/MR 545W modules", "JA SOLAR 545W PV MODULE | 15 | EA"
  // — which carry no labels at all and from which the form reader takes nothing. An SOW and a
  // BOM are where the system fields actually live, so both readers run and the form reader wins
  // wherever they overlap: a labelled value was written deliberately, a recognised one inferred.
  const parsed = JC.parseJobCard(read.text);
  const specs = SPEC.extractSpecs(read.text);
  for (const [k, v] of Object.entries(specs.fields)) {
    if (!Object.prototype.hasOwnProperty.call(parsed.fields, k)) parsed.fields[k] = v;
  }
  for (const w of specs.warnings) parsed.warnings.push(w);
  // Equipment the specs imply, where the form reader proposed none of that type.
  const haveTypes = new Set(parsed.equipment.map((e) => e['Equipment Type']));
  for (const row of specs.equipment) {
    if (!haveTypes.has(row['Equipment Type'])) parsed.equipment.push(row);
  }

  // ── what Airtable already knows ─────────────────────────────────────────
  let matches = [];
  let jobCard = null;
  let client = null;
  let existing = null;

  try {
    if (jobCardId) {
      // THE CHOSEN JOB CARD DECIDES. It links to its own Site Information record, so the site
      // is known rather than matched on a name a scanner may have misread.
      jobCard = await getJobCard(baseSymbol, jobCardId);
      if (!jobCard) {
        return H.fail(res, 404, 'not_found', 'That job card could not be read.');
      }
      existing = await siteForJobCard(jobCard.base, jobCard.record);
      // No site linked yet: fall back to a name match, so a second job card for a site that
      // already exists updates it rather than creating a duplicate.
      if (!existing) {
        const name = parsed.fields[JC.FIELD.name]
          || scalar(jobCard.record.fields['Client Name'])
          || String(body.siteNameHint || '').trim();
        matches = await findSites(name);
        existing = matches[0] || null;
      }
    } else {
      const siteName = parsed.fields[JC.FIELD.name] || String(body.siteNameHint || '').trim();
      [matches, jobCard, client] = await Promise.all([
        findSites(siteName),
        findJobCard(parsed.fields[JC.FIELD.jcNumber]),
        findClient(parsed.fields[JC.FIELD.clientName] || siteName),
      ]);
      existing = matches[0] || null;
    }
  } catch (e) {
    return H.fail(res, 502, 'lookup_failed',
      'Airtable could not be searched: ' + String(e.message || e).slice(0, 200));
  }

  // ── build the proposal ──────────────────────────────────────────────────
  const proposal = {};
  const provenance = {};
  const conflicts = [];

  // 1. The existing site record is the authority on itself.
  if (existing) {
    for (const [k, v] of Object.entries(existing.record.fields || {})) {
      const val = scalar(v);
      if (val === '' || val == null) continue;
      proposal[k] = val;
      provenance[k] = 'site';
    }
  }

  // 2. Then the job card, then the client — each filling only what is still blank.
  if (jobCard) {
    foldIn(proposal, provenance, jobCard.record.fields || {}, FROM_JOBCARD, 'jobcard');
    // The Job Cards table has no site-name field — only a client and an address — so a brand
    // new site would arrive nameless and be refused at the last step. The client's name is what
    // these sites are actually called ("ALAN AUCAMP"), and it is shown for correction like any
    // other proposed value.
    if (!proposal[JC.FIELD.name]) {
      const nm = scalar(jobCard.record.fields['Client Name']);
      if (nm) { proposal[JC.FIELD.name] = nm; provenance[JC.FIELD.name] = 'jobcard'; }
    }
  }

  // LAST RESORT: the folder the documents came out of.
  //
  // A job card whose client lookup is empty, plus a scan that read nothing, left the proposal
  // with no site name at all — and the save refuses without one. The dropped folder is usually
  // named after the site ("H68 BOERDERYE"), so it is offered, labelled as coming from the
  // folder so nobody mistakes it for something a record actually said.
  if (!proposal[JC.FIELD.name]) {
    const hint = String(body.siteNameHint || '').trim().slice(0, 100);
    if (hint) { proposal[JC.FIELD.name] = hint; provenance[JC.FIELD.name] = 'folder'; }
  }
  if (client) foldIn(proposal, provenance, client.record.fields || {}, FROM_CLIENT, 'client');

  // 3. OCR last, and only into gaps. Where it disagrees with a stored value, the stored value
  //    stands and the disagreement is reported rather than silently resolved.
  let fromOcr = 0;
  for (const [k, v] of Object.entries(parsed.fields)) {
    if (v === '' || v == null) continue;
    if (Object.prototype.hasOwnProperty.call(proposal, k)) {
      if (key(proposal[k]) !== key(v)) {
        conflicts.push({ field: k, stored: proposal[k], scanned: v, source: provenance[k] });
      }
      continue;
    }
    proposal[k] = v;
    provenance[k] = 'ocr';
    fromOcr++;
  }

  // Fields that are computed, linked or audit-owned must never be proposed back as writes.
  for (const k of ['Site ID', 'Created By (App)', 'Created Date', 'Modified By (App)',
    'Modified Date', 'History', 'Documents', 'Job Cards', 'Client', 'Site Information']) {
    delete proposal[k];
    delete provenance[k];
  }

  await A.auditNow({
    ...ctx,
    action: 'View',
    result: 'Allowed',
    recordId: existing ? existing.record.id : '',
    field: 'OCR',
    newValue: filename + ' → ' + (existing ? 'matched ' + existing.base : 'new site')
      + ' (' + Object.keys(proposal).length + ' fields)',
  });

  return H.ok(res, {
    // The raw text is returned so a person can check a value against what was actually on the
    // page. It is only ever reached after both classifier passes have cleared the file.
    text: read.text.slice(0, 20000),
    confidence: read.confidence,
    pages: read.pages,
    note: read.note,
    verdict: post.verdict,
    parsed: { fields: parsed.fields, serials: parsed.serials, equipment: parsed.equipment,
      warnings: parsed.warnings, matched: parsed.matched },
    existing: existing
      ? { base: existing.base, id: existing.record.id,
        name: existing.record.fields['Site Name'] || '' }
      : null,
    duplicates: matches.slice(1).map((m) => ({
      base: m.base, id: m.record.id, name: m.record.fields['Site Name'] || '',
    })),
    jobCard: jobCard
      ? {
        base: jobCard.base,
        id: jobCard.record.id,
        number: jobCard.record.fields['JC Reference'] || '',
        title: jobCard.record.fields.Title || '',
        client: scalar(jobCard.record.fields['Client Name']),
        linkedSite: (jobCard.record.fields['Site Information'] || []).length > 0,
      }
      : null,
    client: client
      ? { base: client.base, id: client.record.id,
        name: client.record.fields['Client Name'] || client.record.fields.Name || '' }
      : null,
    proposal,
    provenance,
    conflicts,
    stats: { fromOcr, total: Object.keys(proposal).length },
  });
};

// Exported for the test suite.
module.exports.namesMatch = namesMatch;
module.exports.FROM_JOBCARD = FROM_JOBCARD;
module.exports.foldIn = foldIn;
module.exports.scalar = scalar;
module.exports.key = key;
module.exports.MAX_BYTES = MAX_BYTES;
