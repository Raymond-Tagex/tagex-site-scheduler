#!/usr/bin/env node
// Raise the ticket for a visit that was booked before the app did it automatically.
//
//   node scripts/raise-ticket-for-visit.js SV-QwV5wP            # dry run
//   node scripts/raise-ticket-for-visit.js SV-QwV5wP --apply    # writes
//
// WHY THIS EXISTS
//
// omRaiseTicketForVisit() raises a ticket when a visit is booked from the calendar. It shipped
// on 26 September 2026; 70 of the 72 visits in the base were booked before that and have no
// ticket. Most are past and settled, so this takes one visit at a time by its Visit ID rather
// than sweeping them all — a ticket is a live piece of work, not a tidy-up.
//
// It mirrors omRaiseTicketForVisit exactly, with two deliberate differences, both because this
// is retrospective:
//
//   Reported At  is the date the VISIT was created, not now. Saying a fault was reported today
//                when the visit was booked five days ago is just false.
//   The note     says it was raised retrospectively, and by whom the visit was booked, so the
//                gap is visible to whoever reads the ticket next.
//
// Fault Category is left empty where the visit type does not map to one — which is what the app
// does, and what TKT-2026-0009 (the first ticket it raised) looks like. A Fault Investigation
// is not one of the ten fault categories, and guessing one would put a made-up word on a record
// somebody later reports on.

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'app0tq4y9wH10h6Up';          // O&M. NOT appfzAX5YHqg4UXCl, which is C&I.
const T_TICKETS = 'tbln5V2ynpBY9sIOc';
const T_VISITS = 'tblny4UUKq8OIHQlw';
const T_JOBCARDS = 'tbl2wqnfM0eDa8M7P';
const T_PEOPLE = 'tblYXKBqfN4zituh1';
const T_ACTIVITY = 'tblWSJlbiGWlZ6yGL';

// By field ID. "Job Card" is really called "Job Card [PRIMARY LINK]", which is how writing it
// by display name once 422'd halfway through cancel-tickets.js.
const TK = { jc: 'fldp7kgz6Dt9E9QUg', client: 'fldBcFPZibnYFr3jk', channel: 'fld6cRgibIeM3XNEo',
  reportedBy: 'fldYNYydGzgSXYcIx', reportedAt: 'fldy71i7KJKzKmM26', subject: 'fldeOJhKpW4SsoSFD',
  desc: 'fld0Q7seNAGeBrEPb', priority: 'fldYfWPp2iFUWsXjF', status: 'fldmYRxOOgzKwRMy2',
  visits: 'fld8vQQgOFxSsv1yR', createdBy: 'fld2DdtjAurZvtJT6', ref: 'fldbjeLNIHNPDF7kq',
  category: 'fld6LEgRNYBCI6Y9U' };
const AL = { note: 'fldcciRgQcM8gPwBR', jc: 'fldq3dlkkE6lRd9za', type: 'fld3Im7LzAcn6ckQe',
  ticket: 'fldReqf27Knw3N1nk' };

// The same three the app maps, and for the same reason: they are the ones that mean the same
// thing. Everything else gets no category rather than a guess.
const CATEGORY_FOR_VISIT = {
  Maintenance: 'Preventative Maintenance',
  'Emergency Callout': 'Emergency Callout',
  'Warranty Assessment': 'Warranty Claim',
};

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const WHO = (ARGS.find((a) => a.startsWith('--as=')) || '--as=raymond@tagexenergy.co.za').slice(5);
const VISIT_ID = ARGS.find((a) => !a.startsWith('--'));

if (!VISIT_ID) {
  console.error('Usage: node scripts/raise-ticket-for-visit.js <Visit ID> [--apply] [--as=email]');
  process.exit(1);
}

function pat() {
  const f = path.join(__dirname, '..', '.env.local');
  const m = fs.existsSync(f) && fs.readFileSync(f, 'utf8').match(/^AIRTABLE_PAT=(.*)$/m);
  const v = (m && m[1].trim()) || process.env.AIRTABLE_PAT;
  if (!v) { console.error('No AIRTABLE_PAT in .env.local or the environment.'); process.exit(1); }
  return v;
}
const PAT = pat();

async function api(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : {};
}

const one = (v) => (Array.isArray(v) ? v[0] : v);

function sast(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-ZA', {
    timeZone: 'Africa/Johannesburg', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).replace(',', '');
}

(async () => {
  const f = encodeURIComponent(`{Visit ID}='${VISIT_ID.replace(/'/g, "\\'")}'`);
  const found = await api(`https://api.airtable.com/v0/${BASE}/${T_VISITS}?filterByFormula=${f}`);
  const visit = (found.records || [])[0];
  if (!visit) { console.error(`No visit with Visit ID "${VISIT_ID}".`); process.exit(1); }

  if ([].concat(visit.fields.Ticket || []).length) {
    console.log(`\n  ${VISIT_ID} already has a ticket. Nothing to do.\n`);
    return;
  }

  const jcId = one(visit.fields['Job Card']);
  if (!jcId) { console.error(`${VISIT_ID} has no job card; a ticket needs one.`); process.exit(1); }
  const jc = await api(`https://api.airtable.com/v0/${BASE}/${T_JOBCARDS}/${jcId}`);

  // The client comes off the JOB CARD's link, the way the app takes it. The visit's own Client
  // is a lookup on some records and a link on others; the job card's is always the link.
  const client = [].concat(jc.fields.Client || []).filter((x) => /^rec[A-Za-z0-9]+$/.test(x));

  let techName = '';
  const techId = one(visit.fields['Assigned Technician']);
  if (techId) {
    const p = await api(`https://api.airtable.com/v0/${BASE}/${T_PEOPLE}/${techId}`);
    techName = (p.fields && p.fields.Name) || '';
  }

  const vtype = visit.fields['Visit Type'] || '';
  const category = CATEGORY_FOR_VISIT[vtype] || '';
  const bookedBy = visit.fields['Created By'] || '';
  const start = visit.fields['Start DateTime'];

  const fields = {
    [TK.jc]: [jcId],
    [TK.visits]: [visit.id],
    [TK.channel]: 'Internal',
    [TK.subject]: visit.fields.Subject || jc.fields['JC Reference'] || 'Site visit',
    [TK.priority]: visit.fields.Priority || 'Normal',
    [TK.status]: 'Visit Scheduled',
    // The visit's creation date, not now. See the note at the top.
    [TK.reportedAt]: visit.createdTime,
    [TK.createdBy]: WHO,
  };
  if (client.length) fields[TK.client] = client;
  if (category) fields[TK.category] = category;
  if (techName) fields[TK.reportedBy] = techName;
  if (visit.fields.Notes) fields[TK.desc] = visit.fields.Notes;

  console.log(`\n\x1b[1mRAISE A TICKET FOR ${VISIT_ID}\x1b[0m\n`);
  console.log(`  visit        ${visit.id}   booked ${sast(visit.createdTime)} by ${bookedBy || '(unknown)'}`);
  console.log(`  scheduled    ${sast(start)}   ${vtype}   ${visit.fields.Status || ''}`);
  console.log(`  job card     ${jc.fields['JC Reference'] || jcId}`);
  console.log(`  client       ${client.length ? one(jc.fields['Client Name']) || client[0] : '(none on the job card)'}`);
  console.log(`  subject      ${fields[TK.subject]}`);
  console.log(`  priority     ${fields[TK.priority]}`);
  console.log(`  status       ${fields[TK.status]}`);
  console.log(`  reported at  ${sast(visit.createdTime)}  (the visit's creation date)`);
  console.log(`  reported by  ${techName || '(no technician on the visit)'}`);
  console.log(`  category     ${category || `(none — "${vtype}" is not one of the fault categories)`}`);
  console.log(`  created by   ${WHO}`);

  if (!APPLY) {
    console.log('\n  DRY RUN — nothing was written. Re-run with --apply.\n');
    return;
  }

  const made = await api(`https://api.airtable.com/v0/${BASE}/${T_TICKETS}`, {
    method: 'POST',
    body: JSON.stringify({ fields, typecast: false }),
  });
  const ref = (made.fields && made.fields['Ticket Ref']) || made.id;
  console.log(`\n  \x1b[32mcreated\x1b[0m  ${ref}  (${made.id})`);

  const note = `[${ref}] [Internal] Raised for the visit booked on ${sast(start)}`
    + ` ${fields[TK.subject]}`
    + ` — raised retrospectively by scripts/raise-ticket-for-visit.js. The visit was booked on `
    + `${sast(visit.createdTime)}${bookedBy ? ' by ' + bookedBy : ''}, before the app raised `
    + 'tickets for calendar bookings.';
  try {
    await api(`https://api.airtable.com/v0/${BASE}/${T_ACTIVITY}`, {
      method: 'POST',
      body: JSON.stringify({ fields: {
        [AL.note]: note, [AL.jc]: [jcId], [AL.ticket]: [made.id], [AL.type]: 'Ticket Logged',
      }, typecast: false }),
    });
    console.log('  \x1b[32mlogged\x1b[0m   activity entry written');
  } catch (e) {
    console.log(`  \x1b[31mNEEDS A PERSON\x1b[0m  the ticket exists but its activity entry does not: ${e.message}`);
    process.exit(1);
  }

  const back = await api(`https://api.airtable.com/v0/${BASE}/${T_VISITS}/${visit.id}`);
  const linked = [].concat(back.fields.Ticket || []);
  console.log(`  ${linked.includes(made.id) ? '\x1b[32mlinked\x1b[0m   the visit points back at it'
    : '\x1b[31mNOT LINKED\x1b[0m  the visit does not point back — check the link field'}\n`);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
