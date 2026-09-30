#!/usr/bin/env node
// Raise tickets for past site visits that were never settled, and settle the visits.
//
//   node scripts/backfill-visit-tickets.js            # dry run — prints the whole plan
//   node scripts/backfill-visit-tickets.js --apply    # writes
//
// WHAT IT TOUCHES
//
// Visits that have no ticket, whose start date is in the PAST, and whose status is still one of
// Scheduled / In Progress / Rescheduled — 37 of them, dating back to 10 June 2026. Visits that
// are already Completed or Cancelled are left alone: they have been dealt with, and a ticket
// raised now would say otherwise.
//
// For each one:
//   a ticket is created, already Closed, carrying a resolution that says it is a backfill
//   the visit is set to Completed
//   both are written to the activity log
//
// ORDER IS DELIBERATE. Visits are processed oldest first, because Seq is an Airtable autoNumber
// and is assigned in creation order. Creating them in date order is the only control this script
// has over the numbering — see the note below.
//
// THE NUMBERING IS NOT FIXED BY THIS SCRIPT.
//
// Ticket Ref is a formula over Seq, and Seq is an autoNumber, which the API cannot write. These
// tickets therefore continue the existing sequence rather than restarting at 0001. Renumbering
// needs Seq converted to a plain Number field in Airtable first; nothing here can do that.

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'app0tq4y9wH10h6Up';          // O&M. NOT appfzAX5YHqg4UXCl, which is C&I.
const T_TICKETS = 'tbln5V2ynpBY9sIOc';
const T_VISITS = 'tblny4UUKq8OIHQlw';
const T_JOBCARDS = 'tbl2wqnfM0eDa8M7P';
const T_PEOPLE = 'tblYXKBqfN4zituh1';
const T_ACTIVITY = 'tblWSJlbiGWlZ6yGL';

const TK = { jc: 'fldp7kgz6Dt9E9QUg', client: 'fldBcFPZibnYFr3jk', channel: 'fld6cRgibIeM3XNEo',
  reportedBy: 'fldYNYydGzgSXYcIx', reportedAt: 'fldy71i7KJKzKmM26', subject: 'fldeOJhKpW4SsoSFD',
  desc: 'fld0Q7seNAGeBrEPb', priority: 'fldYfWPp2iFUWsXjF', status: 'fldmYRxOOgzKwRMy2',
  visits: 'fld8vQQgOFxSsv1yR', createdBy: 'fld2DdtjAurZvtJT6', category: 'fld6LEgRNYBCI6Y9U',
  resolution: 'fldhnFgGkhtQ6IsvG', closedAt: 'fldeAsdC8J55Xy18Q' };
const V = { status: 'fldEoAd9YkLfCIBDj' };
const AL = { note: 'fldcciRgQcM8gPwBR', jc: 'fldq3dlkkE6lRd9za', type: 'fld3Im7LzAcn6ckQe',
  ticket: 'fldReqf27Knw3N1nk' };

// Only the three that mean the same thing, exactly as the app maps them. An Installation or a
// Site Inspection is not a fault, and inventing a category would put a made-up word on a record
// somebody later reports on.
const CATEGORY_FOR_VISIT = {
  Maintenance: 'Preventative Maintenance',
  'Emergency Callout': 'Emergency Callout',
  'Warranty Assessment': 'Warranty Claim',
};

const UNSETTLED = ['Scheduled', 'In Progress', 'Rescheduled'];

const APPLY = process.argv.includes('--apply');
const WHO = (process.argv.find((a) => a.startsWith('--as=')) || '--as=raymond@tagexenergy.co.za').slice(5);

function pat() {
  const f = path.join(__dirname, '..', '.env.local');
  const m = fs.existsSync(f) && fs.readFileSync(f, 'utf8').match(/^AIRTABLE_PAT=(.*)$/m);
  const v = (m && m[1].trim()) || process.env.AIRTABLE_PAT;
  if (!v) { console.error('No AIRTABLE_PAT in .env.local or the environment.'); process.exit(1); }
  return v;
}
const PAT = pat();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, opts = {}) {
  // Airtable allows 5 requests a second per base. This runs a few hundred writes; pacing them
  // is cheaper than handling 429s halfway through a half-finished backfill.
  await sleep(220);
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${body.slice(0, 260)}`);
  return body ? JSON.parse(body) : {};
}

async function listAll(table) {
  let offset = '';
  const out = [];
  do {
    const u = `https://api.airtable.com/v0/${BASE}/${table}?pageSize=100${offset ? '&offset=' + offset : ''}`;
    const p = await api(u);
    out.push(...(p.records || []));
    offset = p.offset || '';
  } while (offset);
  return out;
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
  const [visits, jobcards, people] = await Promise.all([
    listAll(T_VISITS), listAll(T_JOBCARDS), listAll(T_PEOPLE),
  ]);
  const jcById = {};
  jobcards.forEach((r) => { jcById[r.id] = r; });
  const personById = {};
  people.forEach((r) => { personById[r.id] = (r.fields && r.fields.Name) || ''; });

  const now = Date.now();
  const todo = visits
    .filter((v) => ![].concat(v.fields.Ticket || []).length)
    .filter((v) => v.fields['Start DateTime'] && Date.parse(v.fields['Start DateTime']) <= now)
    .filter((v) => UNSETTLED.includes(v.fields.Status || ''))
    .sort((a, b) => Date.parse(a.fields['Start DateTime']) - Date.parse(b.fields['Start DateTime']));

  console.log('\n\x1b[1mBACKFILL TICKETS FOR UNSETTLED PAST VISITS\x1b[0m\n');
  console.log(`  ${visits.length} visits read; ${todo.length} qualify\n`);

  const skipped = [];
  const plan = [];
  for (const v of todo) {
    const jcId = one(v.fields['Job Card']);
    if (!jcId || !jcById[jcId]) { skipped.push(`${v.fields['Visit ID'] || v.id}: no job card`); continue; }
    const jc = jcById[jcId];
    const vtype = v.fields['Visit Type'] || '';
    plan.push({
      visit: v,
      vid: v.fields['Visit ID'] || v.id,
      jcId,
      jcRef: jc.fields['JC Reference'] || jcId,
      client: [].concat(jc.fields.Client || []).filter((x) => /^rec[A-Za-z0-9]+$/.test(x)),
      tech: personById[one(v.fields['Assigned Technician'])] || '',
      vtype,
      category: CATEGORY_FOR_VISIT[vtype] || '',
      start: v.fields['Start DateTime'],
      wasStatus: v.fields.Status || '',
      subject: v.fields.Subject || jc.fields['JC Reference'] || 'Site visit',
      priority: v.fields.Priority || 'Normal',
    });
  }

  plan.forEach((p, i) => {
    console.log(`  ${String(i + 1).padStart(2)}  ${p.vid.padEnd(12)} ${sast(p.start).slice(0, 10)}`
      + `  ${p.wasStatus.padEnd(12)} → Completed   ${p.jcRef.padEnd(24)}`
      + `  ${p.category || '(no category)'}`);
  });
  if (skipped.length) {
    console.log('\n  SKIPPED:');
    skipped.forEach((x) => console.log('    ' + x));
  }

  console.log(`\n  ${plan.length} ticket(s) would be created, already Closed, each carrying a`);
  console.log('  backfill resolution; each visit would be set to Completed; two activity');
  console.log('  entries would be written per visit.');
  console.log('\n  \x1b[33mNumbering:\x1b[0m Seq is an autoNumber, so these continue from the current');
  console.log('  highest. They are created oldest-visit-first, which is the only ordering this');
  console.log('  script can influence. Restarting at 0001 needs Seq converted to a Number field.');

  if (!APPLY) { console.log('\n  DRY RUN — nothing was written. Re-run with --apply.\n'); return; }

  console.log('');
  let made = 0;
  const problems = [];
  for (const p of plan) {
    let ticket;
    try {
      const resolution = `Raised retrospectively from a historic site visit on ${sast(p.start)} and `
        + 'closed without a record of what was done. The visit predates automatic ticket creation '
        + '(26 September 2026), so no account of the work was captured at the time. '
        + `The visit was left at "${p.wasStatus}" and has been set to Completed by this backfill.`;
      const fields = {
        [TK.jc]: [p.jcId],
        [TK.visits]: [p.visit.id],
        [TK.channel]: 'Internal',
        [TK.subject]: p.subject,
        [TK.priority]: p.priority,
        [TK.status]: 'Closed',
        [TK.closedAt]: new Date().toISOString(),
        [TK.resolution]: resolution,
        [TK.reportedAt]: p.visit.createdTime,
        [TK.createdBy]: WHO,
      };
      if (p.client.length) fields[TK.client] = p.client;
      if (p.category) fields[TK.category] = p.category;
      if (p.tech) fields[TK.reportedBy] = p.tech;
      if (p.visit.fields.Notes) fields[TK.desc] = p.visit.fields.Notes;

      ticket = await api(`https://api.airtable.com/v0/${BASE}/${T_TICKETS}`, {
        method: 'POST', body: JSON.stringify({ fields, typecast: false }),
      });
    } catch (e) {
      problems.push(`${p.vid}: the ticket was not created (${e.message})`);
      continue;
    }
    const ref = (ticket.fields && ticket.fields['Ticket Ref']) || ticket.id;
    made += 1;

    try {
      await api(`https://api.airtable.com/v0/${BASE}/${T_ACTIVITY}`, {
        method: 'POST', body: JSON.stringify({ fields: {
          [AL.note]: `[${ref}] [Internal] Raised retrospectively for the visit on ${sast(p.start)}`
            + ` ${p.subject} — the visit predates automatic ticket creation. Raised already`
            + ' Closed by scripts/backfill-visit-tickets.js.',
          [AL.jc]: [p.jcId], [AL.ticket]: [ticket.id], [AL.type]: 'Ticket Logged',
        }, typecast: false }),
      });
    } catch (e) { problems.push(`${p.vid} (${ref}): the Ticket Logged entry failed (${e.message})`); }

    // Entry before status, so a failure leaves an account rather than a silent change.
    let logged = true;
    try {
      await api(`https://api.airtable.com/v0/${BASE}/${T_ACTIVITY}`, {
        method: 'POST', body: JSON.stringify({ fields: {
          [AL.note]: `[${ref}] Visit ${p.vid} ${p.wasStatus} → Completed because the ticket was`
            + ' closed — settled by scripts/backfill-visit-tickets.js'
            + ` (was booked for ${sast(p.start)}).`,
          [AL.jc]: [p.jcId], [AL.ticket]: [ticket.id], [AL.type]: 'Visit Completed',
        }, typecast: false }),
      });
    } catch (e) {
      logged = false;
      problems.push(`${p.vid} (${ref}): the Visit Completed entry failed (${e.message}) — visit NOT changed`);
    }
    if (logged) {
      try {
        await api(`https://api.airtable.com/v0/${BASE}/${T_VISITS}/${p.visit.id}`, {
          method: 'PATCH', body: JSON.stringify({ fields: { [V.status]: 'Completed' } }),
        });
      } catch (e) {
        problems.push(`${p.vid} (${ref}): the entry was written but the visit was NOT set to Completed (${e.message})`);
      }
    }
    console.log(`  \x1b[32mdone\x1b[0m  ${ref}  ${p.vid}  ${p.jcRef}`);
  }

  console.log(`\n  ${made} of ${plan.length} ticket(s) created.`);
  if (problems.length) {
    console.log('\n\x1b[31m  NEEDS A PERSON:\x1b[0m');
    problems.forEach((x) => console.log('    ' + x));
    process.exit(1);
  }
  console.log('');
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
