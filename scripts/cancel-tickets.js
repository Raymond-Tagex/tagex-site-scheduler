#!/usr/bin/env node
/**
 * Cancel tickets by reference, the way the app would.
 *
 *   node scripts/cancel-tickets.js TKT-2026-0003 TKT-2026-0005
 *   node scripts/cancel-tickets.js TKT-2026-0003 TKT-2026-0005 --apply
 *
 * WHY A SCRIPT AND NOT A CLICK
 *
 * The same outcome, but this writes the activity entry too. A status changed straight in
 * Airtable leaves a ticket whose history does not explain how it got there, which is the exact
 * failure this platform has been fixing all week: every status change says what it was, what it
 * became, and why.
 *
 * Cancelled is the one status that needs no resolution summary — a ticket that should never
 * have existed has nothing to resolve.
 *
 * It refuses to touch a ticket that is already Cancelled, and refuses a reference it cannot
 * find, rather than reporting success for nothing.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = 'app0tq4y9wH10h6Up';
const T_TKT = 'tbln5V2ynpBY9sIOc';
const T_ACT = 'tblWSJlbiGWlZ6yGL';

// BY FIELD ID, like the app. The Activity Log's link field is actually called
// "Job Card [PRIMARY LINK]", and writing to "Job Card" is a 422 that arrives AFTER the ticket
// has already been patched -- which is how one of these ended up cancelled with no entry
// explaining it. Names in that base are not what they look like.
const F = {
  ref: 'fldbjeLNIHNPDF7kq',
  status: 'fldmYRxOOgzKwRMy2',
  subject: 'fldeOJhKpW4SsoSFD',
  jc: 'fldp7kgz6Dt9E9QUg',
  alNote: 'fldcciRgQcM8gPwBR',
  alJc: 'fldq3dlkkE6lRd9za',
  alType: 'fld3Im7LzAcn6ckQe',
  alTicket: 'fldReqf27Knw3N1nk',
};

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const REFS = args.filter((a) => !a.startsWith('--'));
const REASON = 'raised in error while testing the form';

if (!REFS.length) {
  console.error('Usage: node scripts/cancel-tickets.js TKT-2026-0003 [more…] [--apply]');
  process.exit(1);
}

function pat() {
  for (const f of ['.env.local', '.env']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, 'utf8').match(/^AIRTABLE_PAT=(.*)$/m);
    if (m && m[1].trim()) return m[1].trim();
  }
  if (process.env.AIRTABLE_PAT) return process.env.AIRTABLE_PAT;
  console.error('No AIRTABLE_PAT found in .env.local, .env or the environment.');
  process.exit(1);
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

async function all(tableId) {
  const out = [];
  let offset = null;
  do {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/${tableId}`);
    u.searchParams.set('pageSize', '100');
    u.searchParams.set('returnFieldsByFieldId', 'true');
    if (offset) u.searchParams.set('offset', offset);
    const d = await api(u);
    out.push(...d.records);
    offset = d.offset || null;
  } while (offset);
  return out;
}

const sel = (v) => (v && typeof v === 'object' && v.name ? v.name : String(v || ''));

(async () => {
  const tickets = await all(T_TKT);
  const acts = await all(T_ACT);
  const byRef = {};
  tickets.forEach((t) => { byRef[String(t.fields[F.ref] || '').trim()] = t; });

  /** Has this ticket's cancellation already been written down? */
  const hasCancelEntry = (id) => acts.some((a) => (a.fields[F.alTicket] || []).includes(id)
    && /\u2192 Cancelled/.test(String(a.fields[F.alNote] || '')));

  const plan = [];
  const refuse = [];
  for (const ref of REFS) {
    const t = byRef[ref];
    if (!t) { refuse.push(`${ref}: no such ticket`); continue; }
    const was = sel(t.fields[F.status]) || 'New';
    const logged = hasCancelEntry(t.id);
    if (was === 'Cancelled' && logged) { refuse.push(`${ref}: already Cancelled, and written down`); continue; }
    // Already cancelled but with nothing saying so: finish the job rather than skip it.
    plan.push({ ref, rec: t, was, statusOnly: was !== 'Cancelled', needsLog: !logged });
  }

  plan.forEach((p) => console.log(`  ${p.ref}  ${p.was} -> Cancelled`
    + (p.was === 'Cancelled' ? '  (status already set; writing the missing entry)' : '')
    + `   ${String(p.rec.fields[F.subject] || '').slice(0, 48)}`));
  if (refuse.length) {
    console.log('\nLeft alone:');
    refuse.forEach((r) => console.log('   ' + r));
  }

  if (!APPLY) {
    console.log(`\n${plan.length} ticket(s) would be cancelled. DRY RUN — nothing was written.`);
    if (refuse.length) process.exitCode = 1;
    return;
  }

  for (const p of plan) {
    // The entry FIRST. If the status write then fails, the ticket has an entry describing a
    // change that did not happen -- visible, and fixable. The other way round leaves a silent
    // change, which is exactly what happened the first time this ran.
    if (p.needsLog) {
      await api(`https://api.airtable.com/v0/${BASE}/${T_ACT}`, {
        method: 'POST',
        body: JSON.stringify({
          fields: {
            [F.alNote]: `[${p.ref}] Status ${p.was} \u2192 Cancelled (${REASON})`,
            [F.alTicket]: [p.rec.id],
            [F.alJc]: [].concat(p.rec.fields[F.jc] || []),
            [F.alType]: 'Ticket Status Change',
          },
        }),
      });
    }
    if (p.statusOnly) {
      await api(`https://api.airtable.com/v0/${BASE}/${T_TKT}/${p.rec.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields: { [F.status]: 'Cancelled' } }),
      });
    }
    console.log(`  ${p.ref} ${p.statusOnly ? 'cancelled' : 'the missing entry was written'}`);
  }

  console.log(`\nDone. ${plan.length} ticket(s) cancelled.`);
  if (refuse.length) process.exitCode = 1;
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
