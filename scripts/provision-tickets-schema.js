#!/usr/bin/env node
/**
 * Add the few Airtable pieces the ticketing feature needs that were not already built.
 *
 *   node scripts/provision-tickets-schema.js            # dry run, writes nothing
 *   node scripts/provision-tickets-schema.js --apply
 *
 * The Tickets and Ticket Spares tables already existed in the O&M base, fully shaped. What was
 * missing was small and additive: three select options on Activity Log, one on Site Visits →
 * Priority and one on Visit Type, and the Cost Recoverable field that every role's permissions
 * already deny but which did not exist — a deny naming a missing field never bites.
 *
 * ADDITIVE ONLY. It adds select choices and one field. It never renames, retypes or removes
 * anything, and it refuses outright if a field is not the type it expects. Ticket Ref must
 * already be a formula before the app is built against it; this checks that and stops if not.
 *
 * Run it once. Re-running is safe: anything already present is reported and skipped.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = 'app0tq4y9wH10h6Up';          // TAGEX – O&M Platform

const APPLY = process.argv.includes('--apply');

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
  if (!r.ok) throw new Error(`${r.status} ${body.slice(0, 400)}`);
  return body ? JSON.parse(body) : {};
}

// Choices to ADD. Anything already there is left alone.
const WANT_CHOICES = [
  ['Site Visits',  'Priority',    ['Low']],
  ['Site Visits',  'Visit Type',  ['Return Visit']],
  ['Activity Log', 'Action Type', ['Ticket Logged', 'Ticket Status Change', 'Spares Requested']],
  // "Second Visit Scheduled" was doing duty for every booked visit, including first ones.
  ['Tickets',      'Status',      ['Visit Scheduled']],
];

// Fields to ADD if absent.
const WANT_FIELDS = [
  ['Tickets', {
    name: 'Cost Recoverable',
    type: 'checkbox',
    options: { icon: 'check', color: 'greenBright' },
    description: 'Whether this ticket is billable to the client. Technicians may neither read '
      + 'nor write it, and Warehouse may not read it — see the Permissions matrix.',
  }],
];

(async () => {
  const meta = await api(`https://api.airtable.com/v0/meta/bases/${BASE}/tables`);
  const byName = {};
  for (const t of meta.tables) byName[t.name] = t;

  let changes = 0;
  let problems = 0;
  const manual = [];        // what no API can do, for a person to click

  // ── the one thing that had to be done by hand ────────────────────────────
  const tickets = byName.Tickets;
  if (!tickets) { console.error('REFUSED: no Tickets table in this base.'); process.exit(1); }
  const ref = tickets.fields.find((f) => f.id === tickets.primaryFieldId);
  if (ref.type !== 'formula') {
    console.error(`REFUSED: Tickets → ${ref.name} is "${ref.type}", not a formula.`);
    console.error('  The app reads the reference straight back off the created record. Until this');
    console.error('  is a formula, a ticket exists for a moment with no reference at all.');
    process.exit(1);
  }
  console.log(`Ticket Ref: formula, as required`);
  console.log(`  = ${String(ref.options && ref.options.formula || '').slice(0, 120)}\n`);

  // ── select options ───────────────────────────────────────────────────────
  for (const [tableName, fieldName, wanted] of WANT_CHOICES) {
    const t = byName[tableName];
    if (!t) { console.log(`  ?? no table "${tableName}"`); problems++; continue; }
    const f = t.fields.find((x) => x.name === fieldName);
    if (!f) { console.log(`  ?? ${tableName} has no "${fieldName}"`); problems++; continue; }
    if (f.type !== 'singleSelect') {
      console.log(`  ?? ${tableName} → ${fieldName} is ${f.type}, not singleSelect — skipped`);
      problems++;
      continue;
    }
    const have = (f.options.choices || []).map((c) => c.name);
    const add = wanted.filter((w) => !have.includes(w));
    if (!add.length) { console.log(`  ok  ${tableName} → ${fieldName}: already has ${wanted.join(', ')}`); continue; }

    // AIRTABLE CANNOT DO THIS THROUGH ANY API. The Metadata API's update-field endpoint accepts
    // only name and description; sending options back reads as a type change and is refused. The
    // MCP connector wraps the same endpoint and only exposes formula options.
    //
    // The other documented route — writing a record with typecast:true, which creates a missing
    // choice — is worse than it looks here. Creating a Site Visit fires this base's "Visit
    // Scheduled" automation, so forcing an option into existence would write a phantom visit and
    // an Activity Log entry to go with it. Not worth it to save a minute of clicking.
    manual.push(`${tableName} → ${fieldName}: add ${add.map((a) => `"${a}"`).join(', ')}`);
  }

  // ── fields ───────────────────────────────────────────────────────────────
  for (const [tableName, spec] of WANT_FIELDS) {
    const t = byName[tableName];
    if (!t) { console.log(`  ?? no table "${tableName}"`); problems++; continue; }
    if (t.fields.some((x) => x.name === spec.name)) {
      console.log(`  ok  ${tableName} → ${spec.name}: already there`);
      continue;
    }
    console.log(`  +   ${tableName} → ${spec.name} (${spec.type})`);
    changes++;
    if (APPLY) {
      await api(`https://api.airtable.com/v0/meta/bases/${BASE}/tables/${t.id}/fields`, {
        method: 'POST',
        body: JSON.stringify(spec),
      });
    }
  }

  console.log('');
  if (!APPLY) console.log(`${changes} change(s) would be made. DRY RUN — nothing was written.`);
  else console.log(`Done. ${changes} change(s) applied.`);

  if (manual.length) {
    console.log('\nSTILL TO DO BY HAND \u2014 Airtable has no API for adding a select option.');
    console.log('');
    // C&I and O&M are duplicated bases: same table names, same field names, near-identical
    // layout. Naming "the O&M base" is not enough to tell them apart in the UI, and options
    // added to the wrong one look exactly like success until something rejects them by name.
    console.log(`  THE BASE IS ${BASE} \u2014 check the URL. airtable.com/${BASE}/...`);
    console.log('  If Site Visits has a column called "Start", you are in C&I. The O&M one');
    console.log('  is called "Start DateTime". C&I is appfzAX5YHqg4UXCl \u2014 not this.');
    console.log('');
    console.log('  Open each field, click "Add an option", type it exactly:\n');
    manual.forEach((m) => console.log('     ' + m));
    console.log('\n  Spelling matters: the proxy validates against the live schema and rejects');
    console.log('  a value by name, so "Return visit" will not do in place of "Return Visit".');
  }
  if (problems) console.log(`\n${problems} thing(s) need a person to look at them.`);
  if (problems || manual.length) process.exit(1);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
