#!/usr/bin/env node
// The six fields RES is missing that the app actually maps.
//
//   node scripts/provision-res-mirror.js            # dry run
//   node scripts/provision-res-mirror.js --apply    # creates them
//
// RES is a structure-only duplicate of O&M, so tables.js hands RES every O&M table id and field
// alias on the understanding that the two bases stay the same shape (mirrorOmToRes). They have
// drifted: 45 fields exist in O&M and not in RES. SIX of them sit on tables the scheduler maps,
// which is what test/verify-res-mirror.js goes red on, and this creates those six.
//
// The other 39 are BOM, ordering and receiving fields on tables neither app reaches in RES --
// the delivery app has no RES in its BASES at all. They are left alone deliberately: creating
// 39 fields nobody reads is 39 chances to create one subtly wrong. Raymond's call, 27 Oct 2026.
//
// ADDITIVE ONLY. A field that already exists by name is left exactly as it is, whatever its type;
// nothing here deletes, retypes or empties anything. Run it twice and the second run does nothing.
//
// THE DEFINITIONS ARE READ FROM O&M AT RUN TIME, not hardcoded below. Only the NAMES are fixed.
// A list of types and options copied into a script is a second copy of the schema that starts
// going stale the moment O&M changes; reading them live means this cannot create a field that
// differs from the one it is mirroring. If a name has since left O&M, it says so and skips.
//
// THE LINK FIELDS ALSO CREATE THEIR OWN INVERSE. A link field creates the field on the far side
// too, and Airtable names that one after the source table -- which matches O&M for two of them
// and not for the third ("Picking Slip", singular, on BOM Items). So each inverse is renamed to
// the name O&M uses once it exists. That closes three more of the 39 as a side effect, which is
// unavoidable rather than intended: there is no way to make a link in one direction only.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const T = require(path.join(ROOT, 'api', '_lib', 'tables.js'));

const APPLY = process.argv.includes('--apply');

// Table id -> the field names to mirror. Nothing outside this list is touched, however far the
// two bases have drifted. The ids are shared: RES is a duplicate, so a table keeps O&M's id.
const WANT = [
  ['tblCnFI2EDwBgEKmi', 'Delivery Notes', ['TAGEX BOM']],
  ['tbldwxyX9xaDwmG1Y', 'Picking Slips', ['TAGEX BOM', 'BOM Items', 'Authorised By (App)', 'Authorised At']],
  ['tblhRTr4W0DnzGs4d', 'Signatures', ['Signature Meaning']],
];

function pat() {
  for (const f of ['.env.local', '.env']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, 'utf8').match(/^AIRTABLE_PAT=(.*)$/m);
    if (m && m[1].trim()) return m[1].trim().replace(/^"|"$/g, '');
  }
  if (process.env.AIRTABLE_PAT) return process.env.AIRTABLE_PAT;
  console.error('No AIRTABLE_PAT in .env.local, .env or the environment.');
  process.exit(1);
}
const PAT = pat();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, opts = {}) {
  await sleep(220);                                  // the meta API allows 5 requests a second
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${body.slice(0, 400)}`);
  return body ? JSON.parse(body) : {};
}

const tables = async (base) => (await api(`https://api.airtable.com/v0/meta/bases/${base}/tables`)).tables || [];

// What goes on the wire to create a copy of an O&M field. Airtable rejects a field id from
// another base, so a link's inverseLinkFieldId and isReversed are dropped: the inverse is made
// for us, and named afterwards.
function spec(f) {
  const out = { name: f.name, type: f.type };
  if (f.description) out.description = f.description;
  if (f.type === 'multipleRecordLinks') {
    out.options = { linkedTableId: f.options.linkedTableId };
    if (f.options.prefersSingleRecordLink) out.options.prefersSingleRecordLink = true;
  } else if (f.options) {
    out.options = f.options;
  }
  return out;
}

const C = { b: '\x1b[1m', g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', x: '\x1b[0m' };

(async () => {
  const [om, res] = await Promise.all([tables(T.BASES.OM), tables(T.BASES.RES)]);
  const omById = Object.fromEntries(om.map((t) => [t.id, t]));
  const resById = Object.fromEntries(res.map((t) => [t.id, t]));
  const omFieldById = {};
  for (const t of om) for (const f of t.fields) omFieldById[f.id] = { field: f, table: t };

  console.log(`\n${C.b}RES MIRROR - the six fields the app maps${C.x}`);
  console.log(`  O&M ${T.BASES.OM}  ->  RES ${T.BASES.RES}`);
  console.log(APPLY ? `  ${C.y}APPLYING${C.x}\n` : '  dry run - nothing will be written. Add --apply.\n');

  let made = 0, skipped = 0, renamed = 0, problems = 0;

  for (const [tableId, label, names] of WANT) {
    const src = omById[tableId];
    const dst = resById[tableId];
    console.log(`${C.b}${label}${C.x}  (${tableId})`);
    if (!src || !dst) {
      console.log(`  ${C.r}skipped${C.x}  ${!src ? 'not in O&M' : 'not in RES'} - nothing to mirror onto`);
      problems++;
      continue;
    }

    for (const name of names) {
      const f = src.fields.find((x) => x.name === name);
      if (!f) {
        console.log(`  ${C.y}-${C.x}  ${name}: no longer in O&M, skipped`);
        problems++;
        continue;
      }

      const existing = dst.fields.find((x) => x.name === name);
      if (existing) {
        const ok = existing.type === f.type;
        console.log(`  ${ok ? C.g + '=' : C.r + '!'}${C.x}  ${name}: already in RES as ${existing.type}`
          + (ok ? ', left alone' : `, and O&M has ${f.type}. The API cannot change a field's type; that one is by hand.`));
        if (ok) skipped++; else problems++;
        continue;
      }

      const body = spec(f);
      if (!APPLY) {
        console.log(`  ${C.c}+${C.x}  ${name}  [${body.type}]${body.options ? '  ' + JSON.stringify(body.options) : ''}`);
        if (f.type === 'multipleRecordLinks') {
          const inv = omFieldById[f.options.inverseLinkFieldId];
          const far = resById[f.options.linkedTableId];
          console.log(`       plus its inverse on "${far ? far.name : '?'}", renamed to "${inv ? inv.field.name : '?'}" if Airtable names it otherwise`);
        }
        made++;
        continue;
      }

      const created = await api(`https://api.airtable.com/v0/meta/bases/${T.BASES.RES}/tables/${tableId}/fields`,
        { method: 'POST', body: JSON.stringify(body) });
      console.log(`  ${C.g}+${C.x}  ${name}  [${created.type}]  ${created.id}`);
      made++;

      if (f.type !== 'multipleRecordLinks') continue;

      // Name the inverse the way O&M names it, or the far table drifts instead of this one.
      const farId = f.options.linkedTableId;
      const wantInverse = omFieldById[f.options.inverseLinkFieldId];
      const invId = created.options && created.options.inverseLinkFieldId;
      if (!wantInverse || !invId) {
        console.log(`       ${C.y}?${C.x}  could not work out the inverse - check "${(resById[farId] || {}).name}" by hand`);
        problems++;
        continue;
      }
      const far = (await tables(T.BASES.RES)).find((x) => x.id === farId);
      const inv = far && far.fields.find((x) => x.id === invId);
      const target = wantInverse.field.name;
      if (!inv) {
        console.log(`       ${C.y}?${C.x}  inverse ${invId} is not on ${farId}`);
        problems++;
        continue;
      }
      if (inv.name === target) {
        console.log(`       its inverse on "${far.name}" is already "${target}"`);
        continue;
      }
      const clash = far.fields.find((x) => x.name === target && x.id !== invId);
      if (clash) {
        console.log(`       ${C.r}!${C.x}  "${far.name}" already has a "${target}" (${clash.type}); left the inverse as "${inv.name}"`);
        problems++;
        continue;
      }
      const patch = { name: target };
      if (wantInverse.field.description) patch.description = wantInverse.field.description;
      await api(`https://api.airtable.com/v0/meta/bases/${T.BASES.RES}/tables/${farId}/fields/${invId}`,
        { method: 'PATCH', body: JSON.stringify(patch) });
      console.log(`       its inverse on "${far.name}": "${inv.name}" -> "${target}"`);
      renamed++;
    }
    console.log('');
  }

  console.log(`  ${made} ${APPLY ? 'created' : 'to create'}, ${renamed} inverse${renamed === 1 ? '' : 's'} renamed, ${skipped} already there, ${problems} needing a look`);
  console.log(APPLY ? '\n  Now: node test/verify-res-mirror.js\n' : '\n  Nothing was written. Re-run with --apply.\n');
  if (problems) process.exit(1);
})().catch((e) => { console.error(`${C.r}Failed:${C.x}`, (e && e.message) || e); process.exit(1); });
