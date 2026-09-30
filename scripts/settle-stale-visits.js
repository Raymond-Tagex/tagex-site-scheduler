#!/usr/bin/env node
// Settle visits that a finished ticket left behind.
//
//   node scripts/settle-stale-visits.js            # dry run — prints, writes nothing
//   node scripts/settle-stale-visits.js --apply    # writes
//
// WHY THIS EXISTS
//
// omSyncVisitsToTicket() settles a ticket's visits when the ticket's status MOVES. Tickets that
// were already finished before it shipped never moved again, so their visits are still sitting
// on the calendar as outstanding work — and because "Scheduled" counts as active, they go on
// blocking the technician's slot in conflict detection.
//
// This applies the same rule once, to the records already in that state:
//
//   ticket Cancelled            -> visit Cancelled   (it never happened)
//   visit still in the future   -> visit Cancelled   (it is not going to happen)
//   visit already in the past   -> visit Completed   (a resolved ticket means the work was done)
//
// A visit that is already Completed or Cancelled is never touched.
//
// The activity entry is written BEFORE the status, on purpose. cancel-tickets.js once wrote the
// status first, hit a 422 on the entry, and left TKT-2026-0003 cancelled with nothing in the
// log to say why. A record with an entry and no status change is recoverable; the reverse is a
// change nobody can account for.

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'app0tq4y9wH10h6Up';          // O&M. NOT appfzAX5YHqg4UXCl, which is C&I.
const T_TICKETS = 'tbln5V2ynpBY9sIOc';
const T_VISITS = 'tblny4UUKq8OIHQlw';
const T_ACTIVITY = 'tblWSJlbiGWlZ6yGL';

// By field ID throughout. Writing "Job Card" by its display name is what 422'd cancel-tickets.js
// — the field is actually called "Job Card [PRIMARY LINK]".
const TK = { ref: 'fldbjeLNIHNPDF7kq', status: 'fldmYRxOOgzKwRMy2', visits: 'fld8vQQgOFxSsv1yR',
  jc: 'fldp7kgz6Dt9E9QUg' };
const V = { status: 'fldEoAd9YkLfCIBDj', start: 'fldDB3DUqHvADw0op', visitId: 'fldkpn9x6pM0wXXdz' };
const AL = { note: 'fldcciRgQcM8gPwBR', jc: 'fldq3dlkkE6lRd9za', type: 'fld3Im7LzAcn6ckQe',
  ticket: 'fldReqf27Knw3N1nk' };

const TKT_TERMINAL = ['Resolved', 'Closed', 'Cancelled'];
const VISIT_DONE = ['Completed', 'Cancelled'];

const APPLY = process.argv.includes('--apply');

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

async function listAll(table) {
  let offset = '';
  const out = [];
  do {
    const u = `https://api.airtable.com/v0/${BASE}/${table}`
      + `?pageSize=100&returnFieldsByFieldId=true${offset ? '&offset=' + offset : ''}`;
    const p = await api(u);
    out.push(...(p.records || []));
    offset = p.offset || '';
  } while (offset);
  return out;
}

/** The app's fmtDateTime, near enough: SAST wall clock, which is what the log everywhere else shows. */
function sast(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const s = d.toLocaleString('en-ZA', {
    timeZone: 'Africa/Johannesburg', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return s.replace(',', '');
}

(async () => {
  const [tickets, visits] = await Promise.all([listAll(T_TICKETS), listAll(T_VISITS)]);
  const byId = {};
  visits.forEach((v) => { byId[v.id] = v; });

  const now = Date.now();
  const todo = [];

  for (const t of tickets) {
    const tStatus = t.fields[TK.status] || '';
    if (!TKT_TERMINAL.includes(tStatus)) continue;
    for (const id of [].concat(t.fields[TK.visits] || [])) {
      const v = byId[id];
      if (!v) { console.log(`  ? visit ${id} on ${t.fields[TK.ref]} is not readable — skipped`); continue; }
      const was = v.fields[V.status] || '';
      if (VISIT_DONE.includes(was)) continue;
      const start = v.fields[V.start];
      const future = !!start && Date.parse(start) > now;
      const to = (tStatus === 'Cancelled' || future) ? 'Cancelled' : 'Completed';
      if (was === to) continue;
      todo.push({
        ticketId: t.id, ref: t.fields[TK.ref] || t.id, tStatus,
        jc: [].concat(t.fields[TK.jc] || []),
        visitId: v.id, label: v.fields[V.visitId] || v.id, was, to, start, future,
      });
    }
  }

  console.log(`\n\x1b[1mVISITS LEFT BEHIND BY A FINISHED TICKET\x1b[0m`);
  console.log(`  ${tickets.length} ticket(s), ${visits.length} visit(s) read\n`);
  if (!todo.length) { console.log('  Nothing to settle.\n'); return; }

  for (const x of todo) {
    console.log(`  ${x.ref} (${x.tStatus})  ->  ${x.label}   ${x.was} → ${x.to}`
      + `   ${x.start ? sast(x.start) : '(no date)'}  [${x.future ? 'still to come' : 'already past'}]`);
  }
  console.log('');

  if (!APPLY) {
    console.log(`  ${todo.length} visit(s) would be settled. DRY RUN — nothing was written.`);
    console.log('  Re-run with --apply to write.\n');
    return;
  }

  let done = 0;
  const problems = [];
  for (const x of todo) {
    const note = `[${x.ref}] Visit ${x.label} ${x.was} → ${x.to} because the ticket was `
      + `${x.tStatus.toLowerCase()}`
      + (x.start ? ` (was booked for ${sast(x.start)})` : '')
      + ' — settled by scripts/settle-stale-visits.js, which applied the rule to records that '
      + 'were already finished when it shipped.';
    try {
      // Entry first. See the note at the top.
      await api(`https://api.airtable.com/v0/${BASE}/${T_ACTIVITY}`, {
        method: 'POST',
        body: JSON.stringify({ fields: {
          [AL.note]: note,
          [AL.jc]: x.jc,
          [AL.ticket]: [x.ticketId],
          [AL.type]: x.to === 'Cancelled' ? 'Visit Cancelled' : 'Visit Completed',
        }, typecast: false }),
      });
    } catch (e) {
      problems.push(`${x.label}: the activity entry failed (${e.message}) — status NOT changed`);
      continue;
    }
    try {
      await api(`https://api.airtable.com/v0/${BASE}/${T_VISITS}/${x.visitId}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields: { [V.status]: x.to } }),
      });
      done += 1;
      console.log(`  \x1b[32mdone\x1b[0m  ${x.label} → ${x.to}`);
    } catch (e) {
      problems.push(`${x.label}: the entry was written but the status was NOT (${e.message})`);
    }
  }

  console.log(`\n  ${done} of ${todo.length} settled.`);
  if (problems.length) {
    console.log('\n\x1b[31m  NEEDS A PERSON:\x1b[0m');
    problems.forEach((p) => console.log('    ' + p));
    process.exit(1);
  }
  console.log('');
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
