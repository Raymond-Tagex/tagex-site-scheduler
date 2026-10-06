#!/usr/bin/env node
// The Warehouse / Supplier split the printed cost grid asks for.
//
//   node scripts/provision-costing-split.js            # dry run
//   node scripts/provision-costing-split.js --apply    # creates them
//
// The form's SUMMARY OF COSTS has three money columns per category — Warehouse, Supplier and
// Total — and Costing held one figure. These are the other two.
//
// THE EXISTING "<X> Cost" FIELDS ARE NOT TOUCHED. They hold live money (five rows, R33 820.75
// in Material Cost alone) and the Total formula is built on them. Turning one into a rollup of
// the new pair would need a type change, which the API cannot do, and would overwrite what is
// there. So each category keeps its total field and gains two that break it down.
//
// Additive only: a field that already exists is left exactly as it is.

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'app0tq4y9wH10h6Up';          // O&M. NOT appfzAX5YHqg4UXCl, which is C&I.
const COSTING = 'tblLZ7zJFusjwUkbU';

const APPLY = process.argv.includes('--apply');

// Every money column on the Costing table, in the order the printed grid lists them.
const CATEGORIES = [
  ['Capital Cost', 'Capital Goods'],
  ['DC Cost', 'DC Equipment'],
  ['AC Cost', 'AC Equipment'],
  ['Material Cost', 'Materials'],
  ['Transport Cost', 'Travelling'],
  ['Accommodation Cost', 'Accommodation'],
  ['Labour Cost', 'Labour'],
  ['Rental Cost', 'Equipment Rental'],
  ['Other Cost', 'Unforseen items'],
];

const currency = (name, description) => ({
  name, type: 'currency', description,
  options: { precision: 2, symbol: 'R ' },
});

const WANT = [];
CATEGORIES.forEach(([field, row]) => {
  WANT.push(currency(`${field} (Warehouse)`,
    `"${row}" on the printed job card, Warehouse column. ${field} stays the row's total.`));
  WANT.push(currency(`${field} (Supplier)`,
    `"${row}" on the printed job card, Supplier column. ${field} stays the row's total.`));
});

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

  // Every category must already have its total field, or the pair would break down nothing.
  const have = new Set(table.fields.map((f) => f.name));
  const orphan = CATEGORIES.map(([f]) => f).filter((f) => !have.has(f));
  if (orphan.length) {
    console.error('REFUSED: no such cost field(s) on Costing: ' + orphan.join(', '));
    process.exit(1);
  }

  const todo = WANT.filter((f) => !have.has(f.name));

  console.log('\n\x1b[1mWAREHOUSE / SUPPLIER SPLIT ON COSTING\x1b[0m\n');
  console.log(`  Costing has ${table.fields.length} field(s) today.`);
  console.log(`  ${WANT.length - todo.length} of the ${WANT.length} wanted are already there.\n`);

  if (!todo.length) { console.log('  Nothing to create.\n'); return; }
  todo.forEach((f) => console.log(`  ${f.name}`));

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
