// POST /api/siteinfo-report — compile the Scope of Work / Site Report for a site.
//
// THIS ENDPOINT WRITES NOTHING EITHER.
//
// It takes the values a person has just confirmed on the review screen, together with the list
// of documents that were read to reach them, and returns a PDF. The client then uploads that PDF
// through /api/siteinfo-upload like any other document — which means the report passes the same
// FICA classifier as everything else, and is audited the same way.
//
// Generating it here rather than in the browser keeps one implementation of the layout, and
// keeps the PDF writer next to the pdfText() reader that has to be able to read it back.

'use strict';

const P = require('./_lib/permissions.js');
const S = require('./_lib/session.js');
const H = require('./_lib/http.js');
const A = require('./_lib/audit.js');
const R = require('./_lib/sitereport.js');

// A report is text; this is far more than it can legitimately need, and bounds the work.
const MAX_FIELDS = 200;
const MAX_SOURCES = 500;

/** Keep only what the report is allowed to print: strings and numbers, capped. */
function cleanMap(obj, cap) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj || {})) {
    if (n++ >= cap) break;
    if (typeof k !== 'string' || k.length > 120) continue;
    if (v == null || v === '') continue;
    if (typeof v === 'number') { out[k] = v; continue; }
    if (typeof v === 'string') { out[k] = v.slice(0, 500); continue; }
  }
  return out;
}

function cleanList(arr, cap, shape) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, cap).map(shape).filter(Boolean);
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

  const rl = H.sessionRateLimit(auth.sid);
  if (!rl.ok) {
    await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: 'rate_limited' });
    return H.tooManyRequests(res, rl.retryAfter);
  }

  // Compiling the record of a site is site_information work.
  const allowed = P.can(auth.perms, 'site_information', 'create');
  if (!allowed.ok) {
    await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: allowed.reason });
    return H.fail(res, allowed.status, allowed.reason, allowed.detail);
  }

  let body;
  try { body = await H.readBody(req); }
  catch (e) { return H.fail(res, 400, e.code || 'bad_request', e.message); }

  const fields = cleanMap(body.fields, MAX_FIELDS);
  if (!fields['Site Name']) {
    return H.fail(res, 400, 'bad_request', 'A site name is required to compile a report.');
  }

  const payload = {
    fields,
    provenance: cleanMap(body.provenance, MAX_FIELDS),
    origin: cleanMap(body.origin, MAX_FIELDS),
    equipment: cleanList(body.equipment, 50, (e) => (e && typeof e === 'object' ? {
      'Equipment Type': String(e['Equipment Type'] || '').slice(0, 60),
      Manufacturer: String(e.Manufacturer || '').slice(0, 80),
      Model: String(e.Model || '').slice(0, 80),
      'Serial Number': String(e['Serial Number'] || '').slice(0, 80),
      Quantity: typeof e.Quantity === 'number' ? e.Quantity : null,
    } : null)),
    warnings: cleanList(body.warnings, 100, (w) => (typeof w === 'string' ? w.slice(0, 400) : null)),
    sources: cleanList(body.sources, MAX_SOURCES, (s) => (s && typeof s === 'object' ? {
      name: String(s.name || '').slice(0, 200),
      read: s.read === true,
      chars: typeof s.chars === 'number' ? s.chars : 0,
      note: String(s.note || '').slice(0, 200),
    } : null)),
    author: auth.email,
  };

  let pdf;
  try {
    pdf = R.reportPdf(payload);
  } catch (e) {
    return H.fail(res, 500, 'report_failed',
      'The report could not be compiled: ' + String(e.message || e).slice(0, 200));
  }

  await A.auditNow({
    ...ctx, action: 'View', result: 'Allowed', field: 'Report',
    newValue: 'Compiled a site report for ' + fields['Site Name']
      + ' from ' + payload.sources.length + ' document(s)',
  });

  return H.ok(res, {
    filename: R.reportFilename(payload),
    contentType: 'application/pdf',
    content: pdf.toString('base64'),
    text: R.reportText(payload).slice(0, 20000),
    bytes: pdf.length,
  });
};
