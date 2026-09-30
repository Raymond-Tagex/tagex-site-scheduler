#!/usr/bin/env node
// Link a job card's loose activity entries onto one of its tickets.
//
//   node scripts/pull-jobcard-history.js TKT-2026-0041            # dry run
//   node scripts/pull-jobcard-history.js TKT-2026-0041 --apply    # writes
//
// The same rule as the "Pull job card history" button on the ticket screen, for doing it to a
// ticket without opening the app.
//
// WHAT IT TAKES. Every Activity Log entry linked to the ticket's job card that carries no
// ticket link at all. The job card link is left exactly as it is: an entry belongs to both, and
// the card's own history must not lose it.
//
// WHAT IT WILL NOT TAKE. An entry already linked to another ticket. Two faults on one
// installation are common, and moving one fault's history onto another's report would be worse
// than leaving it where it is.

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'app0tq4y9wH10h6Up';          // O&M. NOT appfzAX5YHqg4UXCl, which is C&I.
const T_TICKETS = 'tbln5V2ynpBY9sIOc';
const T_ACTIVITY = 'tblWSJlbiGWlZ6yGL';

// By field ID: "Job Card" on the Tickets table is really "Job Card [PRIMARY LINK]".
const TK = { ref: 'fldbjeLNIHNPDF7kq', jc: 'fldp7kgz6Dt9E9QUg' };
const AL = { note: 'fldcciRgQcM8gPwBR', jc: 'fldq3dlkkE6lRd9za', type: 'fld3Im7LzAcn6ckQe',
  ticket: 'fldReqf27Knw3N1nk' };

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const REF = ARGS.find((a) => !a.startsWith('--'));

if (!REF) {
  console.error('Usage: node scripts/pull-jobcard-history.js <Ticket Ref> [--apply]');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, opts = {}) {
  await sleep(220);                         // Airtable allows 5 requests a second per base
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
    const u = `https://api.airtable.com/v0/${BASE}/${table}`
      + `?pageSize=100&returnFieldsByFieldId=true${offset ? '&offset=' + offset : ''}`;
    const p = await api(u);
    out.push(...(p.records || []));
    offset = p.offset || '';
  } while (offset);
  return out;
}

const ids = (v) => [].concat(v || []).map((x) => (x && x.id) || x).filter((x) => typeof x === 'string');

function sast(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-ZA', {
    timeZone: 'Africa/Johannesburg', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).replace(',', '');
}

(async () => {
  const tickets = await listAll(T_TICKETS);
  const ticket = tickets.find((t) => (t.fields[TK.ref] || '') === REF);
  if (!ticket) { console.error(`No ticket with reference "${REF}".`); process.exit(1); }

  const jcId = ids(ticket.fields[TK.jc])[0];
  if (!jcId) { console.error(`${REF} has no job card, so there is no history to pull.`); process.exit(1); }

  const acts = await listAll(T_ACTIVITY);
  const loose = [];
  let mine = 0;
  let others = 0;
  for (const a of acts) {
    if (!ids(a.fields[AL.jc]).includes(jcId)) continue;
    const on = ids(a.fields[AL.ticket]);
    if (on.includes(ticket.id)) { mine += 1; continue; }
    if (on.length) { others += 1; continue; }
    loose.push(a);
  }

  console.log(`\n\x1b[1mPULL JOB CARD HISTORY ONTO ${REF}\x1b[0m\n`);
  console.log(`  already on this ticket        : ${mine}`);
  console.log(`  belonging to another ticket   : ${others}  (left alone)`);
  console.log(`  to pull                       : ${loose.length}\n`);

  loose.sort((a, b) => String(a.createdTime).localeCompare(String(b.createdTime)));
  for (const a of loose) {
    console.log(`  ${sast(a.createdTime)}  ${String(a.fields[AL.type] || '').padEnd(20)}`
      + `  ${String(a.fields[AL.note] || '').replace(/\s+/g, ' ').slice(0, 62)}`);
  }

  if (!loose.length) { console.log('\n  Nothing to pull.\n'); return; }
  if (!APPLY) {
    console.log(`\n  ${loose.length} entr${loose.length === 1 ? 'y' : 'ies'} would be linked. `
      + 'DRY RUN — nothing was written.\n  Re-run with --apply to write.\n');
    return;
  }

  console.log('');
  let done = 0;
  const problems = [];
  for (const a of loose) {
    try {
      // The ticket link only. Sending the job card link as well would rewrite it for nothing.
      await api(`https://api.airtable.com/v0/${BASE}/${T_ACTIVITY}/${a.id}`, {
        method: 'PATCH', body: JSON.stringify({ fields: { [AL.ticket]: [ticket.id] } }),
      });
      done += 1;
      console.log(`  \x1b[32mlinked\x1b[0m  ${String(a.fields[AL.type] || a.id)}`);
    } catch (e) {
      problems.push(`${a.fields[AL.type] || a.id}: ${e.message}`);
    }
  }

  if (done) {
    try {
      await api(`https://api.airtable.com/v0/${BASE}/${T_ACTIVITY}`, {
        method: 'POST',
        body: JSON.stringify({ fields: {
          [AL.note]: `[${REF}] ${done} earlier job card entr${done === 1 ? 'y' : 'ies'} pulled onto `
            + 'this ticket, so the report carries the full history of the work '
            + '— scripts/pull-jobcard-history.js.',
          [AL.jc]: [jcId],
          [AL.ticket]: [ticket.id],
          [AL.type]: 'System',
        }, typecast: false }),
      });
    } catch (e) { problems.push(`the entry recording the pull: ${e.message}`); }
  }

  console.log(`\n  ${done} of ${loose.length} linked.`);
  if (problems.length) {
    console.log('\n\x1b[31m  NEEDS A PERSON:\x1b[0m');
    problems.forEach((p) => console.log('    ' + p));
    process.exit(1);
  }
  console.log('');
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
