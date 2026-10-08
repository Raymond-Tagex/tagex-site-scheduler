// POST /api/ticket-report — the Service Ticket Report for one ticket, as a PDF.
// POST /api/ticket-report { list: { status, ids? , search? } } — the ticket LIST, as a PDF.
//
// The list shares this endpoint rather than taking a new one: the deployment counts against
// the Hobby plan's twelve functions, and both are the same export right on the same table.
//
// THE CLIENT SENDS A RECORD ID AND NOTHING ELSE.
//
// Everything printed is read here, through the same permission rules as any other request:
// the role must hold tickets:export, and any field it may not read is stripped before the
// layout ever sees it. A report assembled from a body the browser posted would be a way to
// print whatever the browser chose to claim, including fields the role is denied.
//
// Reads are deliberately fresh rather than cached: this is a document someone signs.

'use strict';

const at = require('./_lib/airtable.js');
const S = require('./_lib/session.js');
const H = require('./_lib/http.js');
const A = require('./_lib/audit.js');
const T = require('./_lib/tables.js');
const P = require('./_lib/permissions.js');
const R = require('./_lib/ticketreport.js');

const BASE = 'OM';
const MAX_LIST_IDS = 5000;
const MAX_VISITS = 200;
const MAX_SPARES = 500;
const MAX_ACTS = 500;

/** A link field as a plain array of record ids. */
const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/** Read one table's rows, already stripped of whatever this role may not read. */
async function readAll(auth, moduleKey, sub, tableSymbolForRule) {
  const r = T.resolve(BASE, moduleKey, sub);
  if (!r.ok) throw Object.assign(new Error(r.detail), { status: r.status, reason: r.reason });
  const rule = auth.perms && auth.perms[tableSymbolForRule || moduleKey];
  const rows = await at.list(r.baseId, r.tableId, {});
  const { idToName } = await at.fieldMaps(r.baseId, r.tableId);
  return rows.map((rec) => ({
    id: rec.id,
    createdTime: rec.createdTime,
    fields: P.filterReadFields(rule, rec.fields, idToName),
  }));
}

module.exports = async function handler(req, res) {
  if (!H.methodGuard(req, res, 'POST')) return;
  if (!H.sessionModeGuard(res)) return;

  const auth = await S.authenticate(req);
  if (!auth.ok) return H.fail(res, auth.status || 401, auth.reason || 'unauthorised', auth.detail);

  const ctx = {
    ip: S.clientIp(req), userAgent: S.userAgent(req), module: 'tickets',
    userEmail: auth.email, userRecordId: auth.userRecordId, sessionId: auth.sid,
  };

  const rl = H.sessionRateLimit(auth.sid);
  if (!rl.ok) {
    await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: 'rate_limited' });
    return H.tooManyRequests(res, rl.retryAfter);
  }

  // Exporting a ticket is an export. Technician / Field does not hold it.
  const allowed = P.can(auth.perms, 'tickets', 'export');
  if (!allowed.ok) {
    await A.auditNow({ ...ctx, action: 'Export', result: 'Denied', denialReason: allowed.reason });
    return H.fail(res, allowed.status, allowed.reason, allowed.detail);
  }

  let body;
  try { body = await H.readBody(req); }
  catch (e) { return H.fail(res, 400, e.code || 'bad_request', e.message); }

  if (body.list) return listReport(auth, ctx, body.list, res);

  const ticketId = String(body.ticketId || '').trim();
  if (!/^rec[A-Za-z0-9]{14}$/.test(ticketId)) {
    return H.fail(res, 400, 'bad_request', 'A ticket record id is required.');
  }

  try {
    const tickets = await readAll(auth, 'tickets', 'ticket');
    const ticket = tickets.find((x) => x.id === ticketId);
    if (!ticket) {
      await A.auditNow({ ...ctx, action: 'Export', result: 'Denied', denialReason: 'not_found', recordId: ticketId });
      return H.fail(res, 404, 'not_found', 'No such ticket, or it is outside your access.');
    }

    const jcId = ids(ticket.fields['Job Card'])[0] || null;
    let jobcard = {};
    if (jcId) {
      const jcs = await readAll(auth, 'job_cards');
      jobcard = (jcs.find((x) => x.id === jcId) || {}).fields || {};
    }

    // People, so a technician link becomes a name rather than a record id.
    const names = {};
    try {
      for (const p of await readAll(auth, 'people')) {
        names[p.id] = R.str(p.fields.Name || p.fields['Full Name'] || '');
      }
    } catch (e) { /* a role without people still gets a report, just without names */ }

    const visitIds = ids(ticket.fields['Site Visits']);
    let visits = [];
    if (visitIds.length) {
      const all = await readAll(auth, 'site_visits');
      visits = all.filter((v) => visitIds.includes(v.id)).slice(0, MAX_VISITS).map((v) => {
        const f = v.fields;
        return {
          start: f['Start DateTime'] || null,
          end: f['End DateTime'] || null,
          type: R.str(f['Visit Type']),
          tech: ids(f['Assigned Technician']).map((i) => names[i] || '?').join(', '),
          status: R.str(f.Status),
          notes: R.str(f.Notes),
        };
      }).sort((a, b) => String(a.start).localeCompare(String(b.start)));
    }

    let spares = [];
    try {
      spares = (await readAll(auth, 'tickets', 'spares'))
        .filter((x) => ids(x.fields.Ticket).includes(ticketId))
        .slice(0, MAX_SPARES)
        .map((x) => ({
          code: R.str(x.fields['Palladium Stock Code']),
          desc: R.str(x.fields['Item Description']),
          req: x.fields['Qty Required'],
          issued: x.fields['Qty Issued'],
          status: R.str(x.fields.Status),
        }));
    } catch (e) { /* no spares table access: the section is simply absent */ }

    // Entries carrying this ticket's link, and nothing else. The visit entries written by
    // saveVisit carry only a Job Card link, so they are not here — say so rather than pad the
    // section with entries that may belong to another fault on the same installation.
    let activity = [];
    let activityNote = '';
    try {
      activity = (await readAll(auth, 'activity_log'))
        .filter((x) => ids(x.fields.Ticket).includes(ticketId))
        .slice(0, MAX_ACTS)
        .map((x) => ({ at: x.createdTime, type: R.str(x.fields['Action Type']), note: R.str(x.fields.Update) }))
        .sort((a, b) => String(a.at).localeCompare(String(b.at)));
      // The note used to say flatly that job card entries are not here. They are, once
      // somebody has pulled them onto the ticket, and a report that denies what it is
      // printing is worse than one that says nothing.
      activityNote = 'Every entry linked to this ticket, including any job card history pulled '
        + 'onto it. Entries still recorded against the job card alone are not listed.';
    } catch (e) {
      activityNote = 'The activity log could not be read for this report.';
    }

    const payload = {
      ticket: ticket.fields,
      jobcard,
      visits,
      spares,
      activity,
      activityNote,
      generatedBy: auth.email,
      generatedAt: new Date().toISOString(),
    };

    const pdf = await R.ticketReportPdf(payload);

    await A.auditNow({
      ...ctx, action: 'Export', result: 'Allowed', recordId: ticketId, field: 'Report',
      newValue: 'Service ticket report for ' + (R.str(ticket.fields['Ticket Ref']) || ticketId)
        + ` (${visits.length} visit(s), ${spares.length} spare(s))`,
    });

    return H.ok(res, {
      filename: R.reportFilename(payload),
      contentType: 'application/pdf',
      content: pdf.toString('base64'),
      bytes: pdf.length,
    });
  } catch (e) {
    if (e.status) return H.fail(res, e.status, e.reason || 'error', e.message);
    return H.fail(res, 500, 'report_failed',
      'The report could not be compiled: ' + String(e.message || e).slice(0, 200));
  }
};

/**
 * The tickets under one status chip, as the Tickets screen lists them.
 *
 * THE SERVER DECIDES WHICH TICKETS ARE PRINTED. The browser names the chip; the status test is
 * applied here, to rows read here, through the role's own read rules. When a search is active
 * the browser also sends the ids it is showing -- matching the screen's search exactly would
 * mean re-implementing it twice -- and those only ever NARROW the list: an id outside the chip,
 * or one the role cannot read, is simply not printed.
 */
async function listReport(auth, ctx, list, res) {
  const filter = String((list && list.status) || '').trim();
  if (!['OPEN', 'ALL', ...R.TICKET_STATUSES].includes(filter)) {
    return H.fail(res, 400, 'bad_request', 'Choose which tickets to print.');
  }
  let only = null;
  if (list.ids != null) {
    if (!Array.isArray(list.ids) || list.ids.length > MAX_LIST_IDS
      || !list.ids.every((x) => typeof x === 'string' && /^rec[A-Za-z0-9]{14}$/.test(x))) {
      return H.fail(res, 400, 'bad_request', 'The ticket list sent is not valid.');
    }
    only = new Set(list.ids);
  }
  // Printed as typed, so it is cut short and stripped of anything that is not text.
  const search = String(list.search || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);

  try {
    const tickets = (await readAll(auth, 'tickets', 'ticket'))
      .filter((x) => R.inFilter(x.fields.Status, filter))
      .filter((x) => !only || only.has(x.id));

    // Job cards give each ticket its reference and client, as on screen. A role that cannot
    // read them still gets its list, with those two columns empty.
    const jcs = {};
    try {
      for (const j of await readAll(auth, 'job_cards')) jcs[j.id] = j.fields;
    } catch (e) { /* no job card access */ }

    const rows = tickets.map((x) => {
      const f = x.fields;
      const jc = jcs[ids(f['Job Card'])[0]] || {};
      return {
        ref: R.str(f['Ticket Ref']),
        reportedAt: f['Reported At'] || null,
        closedAt: f['Closed At'] || null,
        client: R.str(jc['Client Name']),
        jc: R.str(jc['JC Reference']),
        subject: R.str(f.Subject),
        category: R.str(f['Fault Category']),
        priority: R.str(f.Priority),
        status: R.str(f.Status),
      };
    // Newest first, the order the screen lists them in.
    }).sort((a, b) => b.ref.localeCompare(a.ref));

    const payload = {
      filter, search, rows, generatedBy: auth.email, generatedAt: new Date().toISOString(),
    };
    const pdf = await R.ticketListPdf(payload);

    await A.auditNow({
      ...ctx, action: 'Export', result: 'Allowed', field: 'Ticket list',
      newValue: `Service ticket list: ${R.filterLabel(filter)}, ${rows.length} ticket(s)`
        + (search ? `, search "${search}"` : ''),
    });

    return H.ok(res, {
      filename: R.listFilename(payload),
      contentType: 'application/pdf',
      content: pdf.toString('base64'),
      bytes: pdf.length,
      count: rows.length,
    });
  } catch (e) {
    if (e.status) return H.fail(res, e.status, e.reason || 'error', e.message);
    return H.fail(res, 500, 'report_failed',
      'The ticket list could not be compiled: ' + String(e.message || e).slice(0, 200));
  }
}
