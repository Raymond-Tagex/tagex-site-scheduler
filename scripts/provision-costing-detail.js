#!/usr/bin/env node
// The travel, accommodation, labour and rental lines the printed job card asks for.
//
//   node scripts/provision-costing-detail.js            # dry run
//   node scripts/provision-costing-detail.js --apply    # creates them
//
// SOURCE: the STOCK, MATERIAL & LOGISTICS ALLOCATION section of TAGEX JOB CARD TEMPLATE
// SEP2026.docx — every blank on those four blocks that had nowhere to go.
//
// ON COSTING, NOT ON THE JOB CARD. These are the detail behind four figures the Costing table
// already carries, and they belong beside them: a job card with two trips has two costing rows,
// and putting the vehicle and the distance on the job card would leave one slot for both.
//
// EACH BLOCK'S TOTAL IS THE FIELD THAT IS ALREADY THERE. "Total Travel Cost" is Transport Cost,
// "Total Accommodation Cost" is Accommodation Cost, and so on. A second field for the same
// money is a second number to disagree with the first.
//
// STAFF NAMES IS ONE FIELD, NOT EIGHT. The paper has eight blanks on two lines; eight columns
// would mean a ninth name has nowhere to go and an empty column for most job cards. It prints
// the same either way.

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'app0tq4y9wH10h6Up';          // O&M. NOT appfzAX5YHqg4UXCl, which is C&I.
const COSTING = 'tblLZ7zJFusjwUkbU';

const APPLY = process.argv.includes('--apply');

const text = (name, description) => ({ name, type: 'singleLineText', description });
const long = (name, description) => ({ name, type: 'multilineText', description });
const check = (name, description) => ({
  name, type: 'checkbox', description, options: { icon: 'check', color: 'greenBright' } });
const date = (name, description) => ({
  name, type: 'date', description, options: { dateFormat: { name: 'iso' } } });
const num = (name, description, precision = 1) => ({
  name, type: 'number', description, options: { precision } });
const rand = (name, description) => ({
  name, type: 'currency', description, options: { precision: 2, symbol: 'R ' } });

const WANT = [
  // ── Transportation Details ───────────────────────────────────────────────
  check('Travel Required', 'Transportation Details: the Yes / No at the head of the block.'),
  rand('Fuel Rate per km', 'Transportation: "Fuel = R ___ /km".'),
  rand('Inclusive Rate per km', 'Transportation: "Inclusive = R ___ /km".'),
  text('Vehicle Allocation', 'Transportation: which vehicle.'),
  num('Distance to Site (km)', 'Transportation: one way, as the form asks.'),
  num('Total Km', 'Transportation: the total for the job.'),
  text('Driver Name', 'Transportation.'),
  check('Toll Fees Required', 'Transportation: the Toll Fees Yes / No.'),
  rand('Toll Fees', 'Transportation: the rand amount beside it.'),
  num('Site Visit Km', 'Transportation: the first trip.'),
  num('Trip 2 Km', 'Transportation.'),
  num('Trip 3 Km', 'Transportation.'),
  check('Travel Approved by Management',
    'Transportation: "Approved by Management". Total Travel Cost is Transport Cost.'),

  // ── Accommodation Details ────────────────────────────────────────────────
  check('Accommodation Required', 'Accommodation Details: the Yes / No.'),
  text('Accommodation Establishment', 'Accommodation: Location / Establishment Name.'),
  num('Accommodation Personnel', 'Accommodation: Number of Personnel.', 0),
  date('Accommodation From', 'Accommodation: From Date.'),
  date('Accommodation To', 'Accommodation: To Date.'),
  num('Accommodation Nights', 'Accommodation: Number of Nights.', 0),
  rand('Accommodation Cost per Night', 'Accommodation. The total is Accommodation Cost.'),
  check('Accommodation Approved by Management', 'Accommodation: "Approved by Management".'),

  // ── Labour Details ───────────────────────────────────────────────────────
  check('Labour Required', 'Labour Details: the Yes / No.'),
  text('Labour Location', 'Labour: Location / Establishment Name.'),
  num('Labour Days', 'Labour: Number of days.', 0),
  long('Staff Names', 'Labour: the eight name blanks on the form, one per line.'),
  rand('Labour Cost per Day', 'Labour. The total is Labour Cost.'),
  check('Labour Approved by Management', 'Labour: "Approved by Management".'),

  // ── Rental Details ───────────────────────────────────────────────────────
  check('Rental Required', 'Rental Details: the Yes / No.'),
  text('Rental Location', 'Rental: Location / Establishment Name.'),
  text('Rental Equipment', 'Rental: Equipment.'),
  num('Rental Days', 'Rental: Number of days.', 0),
  rand('Rental Fixed Cost', 'Rental: Fixed Cost.'),
  rand('Rental Cost per Day', 'Rental. The total is Rental Cost.'),
  check('Rental Approved by Management', 'Rental: "Approved by Management".'),
];

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
  await sleep(220);
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : {};
}

(async () => {
  const meta = await api(`https://api.airtable.com/v0/meta/bases/${BASE}/tables`);
  const table = (meta.tables || []).find((t) => t.id === COSTING);
  if (!table) { console.error('REFUSED: the Costing table is not in this base.'); process.exit(1); }

  // The four totals must already be there, or these details describe nothing.
  const have = new Set(table.fields.map((f) => f.name));
  const totals = ['Transport Cost', 'Accommodation Cost', 'Labour Cost', 'Rental Cost'];
  const orphan = totals.filter((t) => !have.has(t));
  if (orphan.length) {
    console.error('REFUSED: no such cost field(s) on Costing: ' + orphan.join(', '));
    process.exit(1);
  }

  const todo = WANT.filter((f) => !have.has(f.name));

  console.log('\n\x1b[1mTRAVEL, ACCOMMODATION, LABOUR AND RENTAL DETAIL\x1b[0m\n');
  console.log(`  Costing has ${table.fields.length} field(s) today.`);
  console.log(`  ${WANT.length - todo.length} of the ${WANT.length} wanted are already there.\n`);

  if (!todo.length) { console.log('  Nothing to create.\n'); return; }
  todo.forEach((f) => console.log(`  ${f.name.padEnd(36)} ${f.type}`));

  if (!APPLY) {
    console.log(`\n  ${todo.length} field(s) would be created. DRY RUN — nothing was written.`);
    console.log('  Re-run with --apply.\n');
    return;
  }

  console.log('');
  let made = 0;
  const problems = [];
  for (const f of todo) {
    try {
      await api(`https://api.airtable.com/v0/meta/bases/${BASE}/tables/${COSTING}/fields`, {
        method: 'POST', body: JSON.stringify(f),
      });
      made += 1;
      console.log(`  \x1b[32mcreated\x1b[0m  ${f.name}`);
    } catch (e) {
      problems.push(`${f.name}: ${e.message}`);
      console.log(`  \x1b[31mFAILED \x1b[0m  ${f.name}`);
    }
  }

  console.log(`\n  ${made} of ${todo.length} created.`);
  if (problems.length) {
    console.log('\n\x1b[31m  NEEDS A PERSON:\x1b[0m');
    problems.forEach((p) => console.log('    ' + p));
    process.exit(1);
  }
  console.log('');
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
