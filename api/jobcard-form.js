// POST /api/jobcard-form — the TAGEX job card, as the printed form, for one job card.
//
// THE CLIENT SENDS A RECORD ID AND NOTHING ELSE.
//
// Everything on the sheet is read here, through the same permission rules as any other request:
// the role must hold job_cards:export, and a field it may not read is stripped before the layout
// ever sees it. Building the form from a body the browser posted would be a way to print
// whatever the browser chose to claim — including the cost figures, which several roles are
// denied.
//
// Reads are fresh rather than cached: this is a document somebody signs and takes to site.

'use strict';

const at = require('./_lib/airtable.js');
const S = require('./_lib/session.js');
const H = require('./_lib/http.js');
const A = require('./_lib/audit.js');
const T = require('./_lib/tables.js');
const P = require('./_lib/permissions.js');
const F = require('./_lib/jobcardform.js');

const BASE = 'OM';
const MAX_VISITS = 60;

const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const first = (v) => (Array.isArray(v) ? v.find((x) => typeof x === 'string' && x) || '' : (v || ''));

/** One table's rows, already stripped of whatever this role may not read. */
async function readAll(auth, moduleKey, sub) {
  const r = T.resolve(BASE, moduleKey, sub);
  if (!r.ok) throw Object.assign(new Error(r.detail), { status: r.status, reason: r.reason });
  const rule = auth.perms && auth.perms[moduleKey];
  const rows = await at.list(r.baseId, r.tableId, {});
  const { idToName } = await at.fieldMaps(r.baseId, r.tableId);
  return rows.map((rec) => ({
    id: rec.id, createdTime: rec.createdTime,
    fields: P.filterReadFields(rule, rec.fields, idToName),
  }));
}

module.exports = async function handler(req, res) {
  if (!H.methodGuard(req, res, 'POST')) return;
  if (!H.sessionModeGuard(res)) return;

  const auth = await S.authenticate(req);
  if (!auth.ok) return H.fail(res, auth.status || 401, auth.reason || 'unauthorised', auth.detail);

  const ctx = {
    ip: S.clientIp(req), userAgent: S.userAgent(req), module: 'job_cards',
    userEmail: auth.email, userRecordId: auth.userRecordId, sessionId: auth.sid,
  };

  const rl = H.sessionRateLimit(auth.sid);
  if (!rl.ok) {
    await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: 'rate_limited' });
    return H.tooManyRequests(res, rl.retryAfter);
  }

  const allowed = P.can(auth.perms, 'job_cards', 'export');
  if (!allowed.ok) {
    await A.auditNow({ ...ctx, action: 'Export', result: 'Denied', denialReason: allowed.reason });
    return H.fail(res, allowed.status, allowed.reason, 'You may not print job cards.');
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const jobCardId = String(body.jobCardId || '').trim();
  if (!/^rec[A-Za-z0-9]+$/.test(jobCardId)) {
    return H.fail(res, 400, 'bad_request', 'A job card record id is required.');
  }

  try {
    const jcs = await readAll(auth, 'job_cards');
    const jobcard = jcs.find((r) => r.id === jobCardId);
    // Not "no such record": a job card outside this role's scope was stripped by readAll, and
    // saying which of the two it was would tell the caller a record exists.
    if (!jobcard) {
      await A.auditNow({ ...ctx, action: 'Export', result: 'Denied',
        denialReason: 'not_found_or_out_of_scope', recordId: jobCardId });
      return H.fail(res, 404, 'not_found', 'No such job card, or it is outside your access.');
    }

    const f = jobcard.fields;

    // The linked records the form prints. Each is optional: a role that may not read costs
    // still gets a job card, with that section blank rather than an error.
    let costing = {};
    try {
      const rows = await readAll(auth, 'costing');
      const mine = rows.filter((r) => ids(r.fields['Job Card']).includes(jobCardId));
      // The form has one Summary of Costs grid, so several costing rows are added together.
      mine.forEach((r) => {
        Object.entries(r.fields).forEach(([k, v]) => {
          if (typeof v === 'number') costing[k] = (costing[k] || 0) + v;
        });
      });
    } catch (e) { costing = {}; }

    let visits = [];
    try {
      const rows = await readAll(auth, 'site_visits');
      visits = rows
        .filter((r) => ids(r.fields['Job Card']).includes(jobCardId))
        .slice(0, MAX_VISITS)
        .map((r) => ({
          start: r.fields['Start DateTime'] || '',
          subject: r.fields.Subject || '',
          notes: r.fields.Notes || '',
          status: (r.fields.Status && r.fields.Status.name) || r.fields.Status || '',
        }));
    } catch (e) { visits = []; }

    let ticketRefs = [];
    try {
      const rows = await readAll(auth, 'tickets', 'ticket');
      ticketRefs = rows
        .filter((r) => ids(r.fields['Job Card']).includes(jobCardId))
        .map((r) => String(r.fields['Ticket Ref'] || '')).filter(Boolean);
    } catch (e) { ticketRefs = []; }

    const bytes = await F.jobCardFormPdf({
      jobcard: f,
      client: first(f['Client Name']),
      site: first(f['Site / Address']),
      responsible: (f.Responsible && f.Responsible.name) || '',
      costing,
      visits,
      ticketRefs,
      bomCount: ids(f['BOM Sheets']).length,
      generatedBy: auth.email,
    });

    await A.auditNow({ ...ctx, action: 'Export', result: 'Allowed', recordId: jobCardId,
      newValue: 'job card form printed' });

    return H.ok(res, {
      filename: F.formFilename(f['JC Reference']),
      contentType: 'application/pdf',
      content: Buffer.from(bytes).toString('base64'),
    });
  } catch (e) {
    await A.auditNow({ ...ctx, action: 'Export', result: 'Denied',
      denialReason: e.reason || 'error', recordId: jobCardId });
    return H.fail(res, e.status || 500, e.reason || 'error',
      'The job card could not be built: ' + e.message);
  }
};
