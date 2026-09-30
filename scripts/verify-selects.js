#!/usr/bin/env node
//
// Compares every single-select list the browser code offers, and every literal status value
// its quick-action buttons write, against the LIVE Airtable schema.
//
//   node scripts/verify-selects.js
//
// WHY THIS EXISTS. The client holds its own copies of Airtable's select options so it can
// render dropdowns without a schema round-trip. Those copies drift silently: someone edits a
// single-select in Airtable and nothing in the app complains until a user picks the missing
// option and gets `invalid_option` from the proxy — or, worse, an option Airtable no longer
// has stays in a dropdown and every save through it fails.
//
// That is not hypothetical. The job card sheet shipped a "Monitoring" button for a status
// that did not exist in the base, so the button could never work. This check would have
// caught it the day it was written.
//
// The option lists are READ OUT OF THE SOURCE FILE rather than repeated here, because a
// checker with its own copy of the data is just a third copy to drift.

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public', 'js', 'mod-scheduler.js');

// .env.local, then the real environment (which wins if already set).
for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const PAT = process.env.AIRTABLE_PAT;
if (!PAT) { console.error('AIRTABLE_PAT is not set.'); process.exit(1); }

const OM = 'app0tq4y9wH10h6Up';

const get = (url) => new Promise((res, rej) => {
  https.get(url, { headers: { Authorization: 'Bearer ' + PAT } }, (r) => {
    let b = '';
    r.on('data', (c) => { b += c; });
    r.on('end', () => (r.statusCode === 200
      ? res(JSON.parse(b))
      : rej(new Error(r.statusCode + ' ' + b.slice(0, 300)))));
  }).on('error', rej);
});

const src = fs.readFileSync(SRC, 'utf8');

/** Pull a `const NAME=['a','b'];` array literal out of the source. */
function listFromSource(name) {
  const re = new RegExp('const\\s+' + name + '\\s*=\\s*\\[([^\\]]*)\\]');
  const m = re.exec(src);
  if (!m) throw new Error(`could not find ${name} in mod-scheduler.js`);
  return m[1].split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.replace(/^['"]|['"]$/g, ''));
}

/** Pull the keys of a `const NAME={ "a":..., "b":... };` colour map. */
function keysFromSource(name) {
  const i = src.indexOf('const ' + name);
  if (i < 0) throw new Error(`could not find ${name}`);
  const body = src.slice(src.indexOf('{', i) + 1, src.indexOf('};', i));
  return [...body.matchAll(/"([^"]+)"\s*:/g)].map((m) => m[1]);
}

/** Every literal a quick-action button writes to a status field. */
function buttonWrites() {
  return [...src.matchAll(/data-act="omUpdStat"[^>]*data-a2="([^"]+)"/g)].map((m) => m[1]);
}

const CHECKS = [
  { table: 'Site Visits', field: 'Visit Type', app: () => keysFromSource('TYPE_COLOR') },
  { table: 'Site Visits', field: 'Status',     app: () => keysFromSource('STATUS_COLOR') },
  // Was not covered at all, which is how the app came to offer three priorities while
  // Airtable held a different set.
  { table: 'Site Visits', field: 'Priority',   app: () => listFromSource('VISIT_PRIS') },
  { table: 'Job Cards',   field: 'Job Type',   app: () => listFromSource('NJC_TYPES') },
  { table: 'Job Cards',   field: 'Priority',   app: () => listFromSource('NJC_PRIS') },
  { table: 'Job Cards',   field: 'Status',     app: () => listFromSource('NJC_STATS') },
  { table: 'Job Cards',   field: 'Owner Category', app: () => listFromSource('OWNER_CATS') },
  // The tickets side writes statuses from code as well as offering them as buttons, so a
  // drift here is a 422 on a visit somebody just booked, not a missing dropdown entry.
  { table: 'Tickets',     field: 'Status',     app: () => listFromSource('TICKET_STATUSES') },
];

(async () => {
  const schema = await get(`https://api.airtable.com/v0/meta/bases/${OM}/tables`);
  const field = (t, f) => {
    const tbl = schema.tables.find((x) => x.name === t);
    return tbl && tbl.fields.find((x) => x.name === f);
  };

  let problems = 0;

  console.log('\n\x1b[1mDROPDOWN LISTS vs LIVE AIRTABLE\x1b[0m\n');
  for (const c of CHECKS) {
    const f = field(c.table, c.field);
    const label = `${c.table} · ${c.field}`;
    if (!f || !f.options || !f.options.choices) {
      console.log(`  \x1b[33m?\x1b[0m      ${label} — not a single select`);
      continue;
    }
    const real = f.options.choices.map((x) => x.name);
    const mine = c.app();
    const missing = mine.filter((x) => !real.includes(x)); // app offers, Airtable rejects
    const extra = real.filter((x) => !mine.includes(x));   // Airtable has, app never offers
    if (!missing.length && !extra.length) {
      console.log(`  \x1b[32mmatch\x1b[0m  ${label.padEnd(30)} ${real.length} options`);
      continue;
    }
    problems++;
    console.log(`  \x1b[31mDIFFER\x1b[0m ${label}`);
    if (missing.length) console.log(`         app offers, Airtable rejects : ${missing.join(', ')}`);
    if (extra.length) console.log(`         Airtable has, app omits     : ${extra.join(', ')}`);
  }

  console.log('\n\x1b[1mQUICK-ACTION BUTTON WRITES\x1b[0m\n');
  const jcStatus = field('Job Cards', 'Status').options.choices.map((x) => x.name);
  for (const v of buttonWrites()) {
    const ok = jcStatus.includes(v);
    if (!ok) problems++;
    console.log(`  ${ok ? '\x1b[32mvalid\x1b[0m ' : '\x1b[31mINVALID\x1b[0m'} Job Cards · Status = "${v}"`);
  }

  console.log('\n' + '='.repeat(66));
  if (problems) {
    console.log(`\x1b[31m\x1b[1m  ${problems} mismatch(es)\x1b[0m — a user would hit an error on each`);
  } else {
    console.log('\x1b[32m\x1b[1m  Every option the app offers exists in Airtable\x1b[0m');
  }
  console.log('='.repeat(66) + '\n');

  // Field NAMES in the stock base. The picker reads Palladium by name, and nothing else
  // here would notice a rename: the list would still fill, with nothing to read.
  problems += await checkStockFields();
  console.log('');

  process.exit(problems ? 1 : 0);
})().catch((e) => { console.error('\x1b[31mFailed:\x1b[0m', e.message); process.exit(1); });

// ─────────────────────────────────────────────────────────────
// FIELD NAMES IN ANOTHER BASE
//
// The stock picker reads the Palladium master by FIELD NAME, not by id, because that base is
// not one the proxy maps field ids for. A rename there breaks the picker silently: it still
// lists every item, just with nothing to read or search on. That is how it shipped once.
// ─────────────────────────────────────────────────────────────
async function checkStockFields() {
  const src = fs.readFileSync(SRC, 'utf8');
  const m = /const STK_F=\{([^}]*)\}/.exec(src);
  if (!m) { console.log('\n  \x1b[31mSTK_F not found in mod-scheduler.js\x1b[0m'); return 1; }
  const want = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);

  const meta = await get('https://api.airtable.com/v0/meta/bases/appeEsQofgu9tgngN/tables');
  const t = (meta.tables || []).find((x) => x.id === 'tblunrbqwZld0rO1J');
  if (!t) { console.log('\n  \x1b[31mPALLADIUM STOCK table not found\x1b[0m'); return 1; }
  const have = new Set(t.fields.map((f) => f.name));

  console.log('\n\x1b[1mPALLADIUM STOCK FIELD NAMES\x1b[0m\n');
  let bad = 0;
  for (const name of want) {
    const ok = have.has(name);
    if (!ok) bad++;
    console.log('  ' + (ok ? '\x1b[32mfound\x1b[0m' : '\x1b[31mMISSING\x1b[0m') + '  ' + name);
  }
  return bad;
}
