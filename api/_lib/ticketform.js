// The TAGEX service ticket, as a printed form in the job card's format.
//
// WHY A SECOND PDF FOR A TICKET. The Service Ticket Report (ticketreport.js) is a record: it
// lists a ticket's whole life after the fact and has nowhere to write. This is the sheet that
// goes to site when a fault is logged -- the job card's layout, its ruled lines and tick boxes,
// carrying what was known when the ticket was raised and leaving room for what was found. The
// two answer different questions and neither replaces the other.
//
// The Service Call-Out terms close it, as they close the job card: a ticket IS a call-out, and
// the client's acceptance of those terms is the thing the technician needs signed on site.
//
// Everything is drawn with the job card's Form, so the two sheets cannot drift apart in look.

'use strict';

const { str, fmtDate, fmtDateTime } = require('./ticketreport.js');
const J = require('./jobcardform.js');

// The ticket vocabularies, as Airtable holds them and in the order the New Ticket form offers
// them. test/verify-ticket-form.js compares these with mod-scheduler.js, so a choice added to the
// screen and not here fails a test rather than printing with no box ticked.
const CHANNELS = ['WhatsApp', 'Email', 'Phone Call', 'Site Walk-in', 'Portal / Monitoring Alarm',
  'Internal'];
const CATEGORIES = ['Inverter Fault', 'Battery Fault', 'Grid / Eskom Fault',
  'Solar Production Issue', 'Communication Failure', 'Monitoring Offline',
  'Preventative Maintenance', 'Emergency Callout', 'Warranty Claim', 'General Support'];
const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];

const first = (v) => (Array.isArray(v) ? str(v[0]) : str(v));

/**
 * Draw the ticket form.
 *
 * @param {object} d  { ticket, ticketCreated, jobcard, visits, spares, generatedBy }
 * @returns {Promise<Uint8Array>}
 */
async function ticketFormPdf(d) {
  const t = d.ticket || {};
  const jc = d.jobcard || {};
  const ref = str(t['Ticket Ref']);
  const { doc, form: s } = await J.newForm('TAGEX Service Ticket ' + ref);
  const CW = J.CW;

  s.letterhead(ref, ['Job Card: ' + (str(jc['JC Reference']) || '-'),
    'Printed: ' + fmtDate(new Date().toISOString())]);
  s.title('SERVICE TICKET');

  // ── identity: the same lines, in the same order, as the head of the job card ──
  s.ticks(J.PROJECT_TYPES, J.projectType(jc), { label: 'Project Type:' });
  s.field('Ticket Number:', ref);
  s.field('Job Card Number:', jc['JC Reference']);
  s.field('Project Reference Number:',
    [].concat(jc['Generated Reference String (from Job Card References)'] || []).map(str).join(', '));
  // A ticket raised against a client before it had a job card names its client itself.
  s.field('Client Name:', first(jc['Client Name']) || str(d.clientName));
  s.field('Site Address:', first(jc['Site / Address']));
  // Reported At is when the client reported it; the record's own creation is when it was
  // logged. They differ whenever a fault is logged after the phone call, and both matter.
  s.pair('Actual Date Issue Reported:', fmtDateTime(t['Reported At']), 'Ticket Raised By:', t['Reported By']);
  s.pair('Actual Date Ticket Created:', fmtDateTime(d.ticketCreated), 'Logged By:', t['Created By']);

  s.heading('How the Issue Was Reported');
  s.ticks(CHANNELS, t['Source Channel'], { label: 'Source:' });
  s.field('Source Detail:', t['Source Detail']);

  s.heading('Fault Details');
  s.ticks(CATEGORIES, t['Fault Category'], { label: 'Fault Category:' });
  s.ticks(PRIORITIES, t.Priority, { label: 'Priority:' });
  s.pair('Asset / Inverter:', t['Asset / Inverter'], 'Error Code:', t['Error Code']);
  s.field('Subject:', t.Subject);
  s.note('Description of the fault as reported:');
  s.block(t.Description, 4);

  // ── what was done about it ────────────────────────────────────────────────
  s.heading('Site Visits');
  s.grid([{ t: 'Date', w: 80 }, { t: 'Technician', w: 110 }, { t: 'Description', w: CW - 300 },
    { t: 'Outcome', w: 110 }],
  J.padTo((d.visits || []).map((v) => [fmtDate(v.start), v.tech,
    [v.subject || v.type, v.notes].filter(Boolean).join(' - '), v.status]), 6, 4));

  s.heading('Spares Required / Issued');
  s.grid([{ t: 'Stock Code', w: 90 }, { t: 'Item Description', w: CW - 300 }, { t: 'Unit', w: 50 },
    { t: 'Qty Required', w: 80 }, { t: 'Qty Issued', w: 80 }],
  J.padTo((d.spares || []).map((x) => [x.code, x.desc, x.unit,
    x.req == null ? '' : String(x.req), x.issued == null ? '' : String(x.issued)]), 5, 5));

  s.heading('Resolution');
  s.pair('Status:', t.Status, 'Closed At:', fmtDateTime(t['Closed At']));
  s.note('Resolution summary:');
  s.block(t['Resolution Summary'], 4);
  s.row([{ l: 'Cost Recoverable from Client:', yes: 'Cost Recoverable' }], [t['Cost Recoverable']]);
  s.pair('Monitored By:', t['Monitored By'], 'Monitoring Ends:', fmtDate(t['Monitoring Ends']));

  s.heading('Signatures');
  s.signature('Logged By:', t['Created By'], d.ticketCreated);
  s.signature('Technician:', '', '');
  s.signature('Resolved / Closed By:', '', t['Closed At']);
  s.signature('Client:', '', '');

  // The client's acceptance prints the job card's client and nothing more: the ticket holds no
  // contact details of its own, and the job card's acceptance block belongs to that job.
  s.terms({ name: first(jc['Client Name']) || str(d.clientName) });

  s.footer(ref, d.generatedBy);
  return doc.save();
}

/** "TKT-2026-0012-form-2026-10-15.pdf" */
function ticketFormFilename(ref) {
  const clean = String(ref || 'ticket').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return clean + '-form-' + new Date().toISOString().slice(0, 10) + '.pdf';
}

module.exports = { ticketFormPdf, ticketFormFilename, CHANNELS, CATEGORIES, PRIORITIES };
