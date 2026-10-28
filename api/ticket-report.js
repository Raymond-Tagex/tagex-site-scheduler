// POST /api/ticket-report — the Service Ticket Report for one ticket, as a PDF.
// POST /api/ticket-report { list: { status, ids? , search?, sort?, dir? } } — the ticket LIST, as a PDF.
//   sort: 'ref' | 'date' | 'tech', dir: 'asc' | 'desc'; neither = ticket number, newest first.
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
//
// POST /api/ticket-report { ticketId, form: true } -- the ticket as a FORM, in the job card's
// format (_lib/ticketform.js), rather than the report. Same right, same reads, same endpoint:
// a thirteenth function would not deploy on the Hobby plan.
// Add file: true and a copy is kept in Documents against the ticket's job card -- the scheduler
// sends that once, straight after a ticket is raised. See _lib/formfile.js for what it checks.

'use strict';

const at = require('./_lib/airtable.js');
const S = require('./_lib/session.js');
const H = require('./_lib/http.js');
const A = require('./_lib/audit.js');
const T = require('./_lib/tables.js');
const P = require('./_lib/permissions.js');
const R = require('./_lib/ticketreport.js');
const TF = require('./_lib/ticketform.js');
const FF = require('./_lib/formfile.js');

const MAX_LIST_IDS = 5000;
const MAX_VISITS = 200;
const MAX_SPARES = 500;
const MAX_ACTS = 500;

/** A link field as a plain array of record ids. */
const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/**
 * Client names by record id. A ticket may be raised against a client before it has a job card,
 * and then its own Client link is the only place its client is named. A role that cannot read
 * clients gets an empty map, and the client is left blank as it was before.
 */
async function clientNames(auth, base) {
  const out = {};
  // Checked here, not left to readAll: filterReadFields with no rule returns every field.
  if (!P.can(auth.perms, 'clients', 'view').ok) return out;
  try {
    for (const c of await readAll(auth, base, 'clients')) out[c.id] = R.str(c.fields['Client Name']);
  } catch (e) { /* no client access */ }
  return out;
}

/** Read one table's rows, already stripped of whatever this role may not read. */
async function readAll(auth, base, moduleKey, sub, tableSymbolForRule) {
  const r = T.resolve(base, moduleKey, sub);
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

  // Which scheduler base the ticket lives in. Every read below is confined to it.
  const base = T.schedulerBase(body.base);
  if (!base) return H.fail(res, 400, 'bad_request', 'Unknown base.');
  ctx.baseSymbol = base;

  if (body.list) return listReport(auth, ctx, base, body.list, res);

  const ticketId = String(body.ticketId || '').trim();
  if (!/^rec[A-Za-z0-9]{14}$/.test(ticketId)) {
    return H.fail(res, 400, 'bad_request', 'A ticket record id is required.');
  }

  try {
    const tickets = await readAll(auth, base, 'tickets', 'ticket');
    const ticket = tickets.find((x) => x.id === ticketId);
    if (!ticket) {
      await A.auditNow({ ...ctx, action: 'Export', result: 'Denied', denialReason: 'not_found', recordId: ticketId });
      return H.fail(res, 404, 'not_found', 'No such ticket, or it is outside your access.');
    }

    const jcId = ids(ticket.fields['Job Card'])[0] || null;
    let jobcard = {};
    if (jcId) {
      const jcs = await readAll(auth, base, 'job_cards');
      jobcard = (jcs.find((x) => x.id === jcId) || {}).fields || {};
    }

    // People, so a technician link becomes a name rather than a record id.
    const names = {};
    try {
      for (const p of await readAll(auth, base, 'people')) {
        names[p.id] = R.str(p.fields.Name || p.fields['Full Name'] || '');
      }
    } catch (e) { /* a role without people still gets a report, just without names */ }

    const visitIds = ids(ticket.fields['Site Visits']);
    let visits = [];
    if (visitIds.length) {
      const all = await readAll(auth, base, 'site_visits');
      visits = all.filter((v) => visitIds.includes(v.id)).slice(0, MAX_VISITS).map((v) => {
        const f = v.fields;
        return {
          start: f['Start DateTime'] || null,
          end: f['End DateTime'] || null,
          type: R.str(f['Visit Type']),
          tech: ids(f['Assigned Technician']).map((i) => names[i] || '?').join(', '),
          status: R.str(f.Status),
          notes: R.str(f.Notes),
          subject: R.str(f.Subject),
        };
      }).sort((a, b) => String(a.start).localeCompare(String(b.start)));
    }

    let spares = [];
    try {
      spares = (await readAll(auth, base, 'tickets', 'spares'))
        .filter((x) => ids(x.fields.Ticket).includes(ticketId))
        .slice(0, MAX_SPARES)
        .map((x) => ({
          code: R.str(x.fields['Palladium Stock Code']),
          desc: R.str(x.fields['Item Description']),
          unit: R.str(x.fields.Unit),
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
      activity = (await readAll(auth, base, 'activity_log'))
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

    // Only looked up when the job card does not already name the client.
    let clientName = '';
    if (!R.str(jobcard['Client Name']) && ids(ticket.fields.Client).length) {
      const cn = await clientNames(auth, base);
      clientName = ids(ticket.fields.Client).map((i) => cn[i]).filter(Boolean).join(', ');
    }

    const payload = {
      ticket: ticket.fields,
      clientName,
      ticketCreated: ticket.createdTime,
      jobcard,
      visits,
      spares,
      activity,
      activityNote,
      generatedBy: auth.email,
      generatedAt: new Date().toISOString(),
    };

    if (body.form === true) return ticketForm(auth, ctx, base, body, ticketId, jcId, payload, res);

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
 * The ticket as a form, and -- when asked -- a copy of it filed against its job card.
 *
 * A refusal to file does not withhold the form: building it is the export right the caller
 * has already been checked for; keeping a copy is documents:create, checked in fileForm.
 */
async function ticketForm(auth, ctx, base, body, ticketId, jcId, payload, res) {
  const ref = R.str(payload.ticket['Ticket Ref']) || ticketId;
  const bytes = await TF.ticketFormPdf(payload);
  const filename = TF.ticketFormFilename(ref);

  await A.auditNow({
    ...ctx, action: 'Export', result: 'Allowed', recordId: ticketId, field: 'Form',
    newValue: 'Service ticket form for ' + ref,
  });

  let filed = null;
  if (body.file === true) {
    try {
      filed = await FF.fileForm({
        auth, base, ctx, jobCardId: jcId, filename, bytes,
        name: 'Ticket form — ' + ref,
        // A ticket form carries no costs and no contact details beyond the reporter's name.
        sensitivity: 'Internal',
        notes: 'Service ticket ' + ref + ' as it stood when it was raised, filed automatically by '
          + 'the scheduler for ' + auth.email + ' on ' + new Date().toISOString().slice(0, 10) + '.',
      });
    } catch (e) {
      filed = { ok: false, reason: 'error', detail: String(e.message || e).slice(0, 200) };
    }
  }

  return H.ok(res, {
    filename,
    contentType: 'application/pdf',
    content: Buffer.from(bytes).toString('base64'),
    bytes: bytes.length,
    filed: FF.filedSummary(filed),
  });
}

/**
 * The tickets under one status chip, as the Tickets screen lists them.
 *
 * THE SERVER DECIDES WHICH TICKETS ARE PRINTED. The browser names the chip; the status test is
 * applied here, to rows read here, through the role's own read rules. When a search is active
 * the browser also sends the ids it is showing -- matching the screen's search exactly would
 * mean re-implementing it twice -- and those only ever NARROW the list: an id outside the chip,
 * or one the role cannot read, is simply not printed.
 */
async function listReport(auth, ctx, base, list, res) {
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
  // Neither named = ticket number, newest first, as the list printed before it could be sorted.
  const sort = list.sort == null ? 'ref' : String(list.sort);
  const dir = list.dir == null ? 'desc' : String(list.dir);
  if (!Object.prototype.hasOwnProperty.call(R.LIST_SORTS, sort) || !R.LIST_DIRS.includes(dir)) {
    return H.fail(res, 400, 'bad_request', 'Choose how to sort the list.');
  }

  try {
    const tickets = (await readAll(auth, base, 'tickets', 'ticket'))
      .filter((x) => R.inFilter(x.fields.Status, filter))
      .filter((x) => !only || only.has(x.id));

    // Job cards give each ticket its reference and client, as on screen. A role that cannot
    // read them still gets its list, with those two columns empty.
    const jcs = {};
    try {
      for (const j of await readAll(auth, base, 'job_cards')) jcs[j.id] = j.fields;
    } catch (e) { /* no job card access */ }

    // A ticket has no technician of its own: whoever is on its most recent visit is the one
    // working it. Cancelled visits do not count -- a technician taken off the job is not on it.
    // Read through the role's rules like everything else; a role that cannot read visits or
    // people still gets its list, with the column blank. The view rights are checked here, not
    // left to readAll: filterReadFields with no rule for a table returns every field, so without
    // this a role denied site visits would read technician names off the printout.
    const techOf = {};
    const mayNameTechs = P.can(auth.perms, 'site_visits', 'view').ok && P.can(auth.perms, 'people', 'view').ok;
    if (mayNameTechs) try {
      const names = {};
      for (const p of await readAll(auth, base, 'people')) {
        names[p.id] = R.str(p.fields.Name || p.fields['Full Name'] || '');
      }
      const visits = {};
      for (const v of await readAll(auth, base, 'site_visits')) visits[v.id] = v.fields;
      for (const x of tickets) {
        const latest = ids(x.fields['Site Visits']).map((id) => visits[id])
          .filter((v) => v && R.str(v.Status) !== 'Cancelled')
          .sort((a, b) => String(b['Start DateTime'] || '').localeCompare(String(a['Start DateTime'] || '')))[0];
        if (latest) {
          techOf[x.id] = ids(latest['Assigned Technician']).map((i) => names[i]).filter(Boolean).join(', ');
        }
      }
    } catch (e) { /* no visit or people access */ }

    const cn = tickets.some((x) => !ids(x.fields['Job Card']).length && ids(x.fields.Client).length)
      ? await clientNames(auth, base) : {};

    const rows = R.sortRows(tickets.map((x) => {
      const f = x.fields;
      const jc = jcs[ids(f['Job Card'])[0]] || {};
      return {
        ref: R.str(f['Ticket Ref']),
        reportedAt: f['Reported At'] || null,
        closedAt: f['Closed At'] || null,
        client: R.str(jc['Client Name']) || ids(f.Client).map((i) => cn[i]).filter(Boolean).join(', '),
        jc: R.str(jc['JC Reference']),
        tech: techOf[x.id] || '',
        subject: R.str(f.Subject),
        category: R.str(f['Fault Category']),
        priority: R.str(f.Priority),
        status: R.str(f.Status),
        region: R.str(jc.Region),
        cost: typeof f['Ticket Cost'] === 'number' ? f['Ticket Cost'] : null,
      };
    }), sort, dir);

    // The Cost column is drawn only for a role that may read Ticket Cost. readAll has already
    // stripped the values for one that may not; this keeps the column itself off the page, so a
    // blank column cannot be read as "nothing has cost anything".
    const tr = auth.perms && auth.perms.tickets;
    const showCost = !!(tr && tr.view) && !((tr.fields && tr.fields.deny_read) || []).includes('Ticket Cost');

    // The sections follow the Region field's own list in Airtable, so a region added there
    // prints in its place without a code change.
    let regions = [];
    try {
      const jr = T.resolve(base, 'job_cards');
      const schema = jr.ok ? await at.tableSchema(jr.baseId, jr.tableId) : null;
      const rf = schema && schema.fields.Region;
      if (rf && rf.type === 'singleSelect') regions = (rf.options.choices || []).map((c) => c.name);
    } catch (e) { /* the default order will do */ }

    const payload = {
      filter, search, sort, dir, rows, showCost, regions, generatedBy: auth.email, generatedAt: new Date().toISOString(),
    };
    const pdf = await R.ticketListPdf(payload);

    await A.auditNow({
      ...ctx, action: 'Export', result: 'Allowed', field: 'Ticket list',
      newValue: `Service ticket list: ${R.filterLabel(filter)}, ${rows.length} ticket(s)`
        + (search ? `, search "${search}"` : '') + `, ${R.sortLabel(sort, dir).toLowerCase()}`,
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
