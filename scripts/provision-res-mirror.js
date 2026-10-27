#!/usr/bin/env node
// The fields RES is missing that an app actually maps.
//
//   node scripts/provision-res-mirror.js            # dry run
//   node scripts/provision-res-mirror.js --apply    # creates them
//
// RES is a structure-only duplicate of O&M, and both the scheduler (mirrorOmToRes) and the
// residential app hand RES O&M's table ids and field aliases on the understanding that the two
// bases stay the same shape. They had drifted by 45 fields.
//
//   SIX sat on tables the SCHEDULER maps -- Delivery Notes, Picking Slips, Signatures -- which is
//   what test/verify-res-mirror.js went red on. Created 27 Oct 2026.
//
//   THIRTY-SIX sat on the BOM, ordering, receiving and quoting tables. These were first written
//   off as latent "until residential needs BOMs". That was wrong, and the mistake is worth
//   recording: tagex-residential maps all five of those tables onto RES and its TAGEX BOM screen
//   is fully wired, so 25 of the 36 are named in its code and about 18 are on write paths.
//   api/_lib/bom.js writes 'Approved By (App)', 'Approved At' and 'Approval Log' in one go, none
//   of which RES had -- approving a BOM there would have sent three unknown field names to
//   Airtable and got a 422. Nothing caught it because every residential suite stubs Airtable.
//   Raymond approved creating all 36 on 27 Oct 2026, with a live check to stop it recurring.
//
// ADDITIVE ONLY. A field that already exists by name is left exactly as it is, whatever its type;
// nothing here deletes, retypes or empties anything. Run it twice and the second run does nothing.
//
// THE DEFINITIONS ARE READ FROM O&M AT RUN TIME, not hardcoded below. Only the NAMES are fixed.
// A list of types and options copied into a script is a second copy of the schema that starts
// going stale the moment O&M changes; reading them live means this cannot create a field that
// differs from the one it is mirroring. If a name has since left O&M, it says so and skips.
//
// THREE THINGS NEED CARE, AND ARE HANDLED BELOW
//
//   1. LINK FIELDS BRING THEIR INVERSE. Airtable has no one-way link, so each one also creates a
//      field on the far side and names it after the source table -- which is not always what O&M
//      calls it ("Picking Slip", singular, on BOM Items). Each inverse is renamed to O&M's name
//      afterwards, or the far table drifts instead of the near one.
//
//   2. COMPUTED FIELDS GO LAST, AND THEIR IDS ARE TRANSLATED. 'Chosen Qty' is a rollup through
//      'Chosen Quote Line' onto Quote Lines' 'Qty Quoted' -- and 'Qty Quoted' is itself one of
//      the missing fields, so it has to exist first. Worse, a rollup's options name FIELD IDS,
//      and a field this script creates gets a fresh id rather than O&M's. So every id inside a
//      computed field's options is translated O&M id -> field name -> the RES id of the field
//      with that name. Copying the options across verbatim would silently point at nothing.
//
//   3. AIRTABLE MAY REFUSE A COMPUTED FIELD OUTRIGHT. The meta API does not create every type.
//      If it refuses, the script says exactly what to make by hand rather than dying, and exits
//      non-zero so nobody reads a partial run as a finished one.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const T = require(path.join(ROOT, 'api', '_lib', 'tables.js'));

const APPLY = process.argv.includes('--apply');

// Table id -> the field names to mirror. Nothing outside this list is touched, however far the
// two bases have drifted: this is a record of what was approved, not a diff that runs itself.
// The ids are shared -- RES is a duplicate, so a table keeps O&M's id.
const WANT = [
  ['tblCnFI2EDwBgEKmi', 'Delivery Notes', ['TAGEX BOM']],
  ['tbldwxyX9xaDwmG1Y', 'Picking Slips', ['TAGEX BOM', 'BOM Items', 'Authorised By (App)', 'Authorised At']],
  ['tblhRTr4W0DnzGs4d', 'Signatures', ['Signature Meaning']],

  // The 36. Quote Lines comes before TAGEX BOM Lines because 'Chosen Qty' rolls up 'Qty Quoted'.
  ['tblWFMjzFYQavfw4h', 'BOM Sheets', ['BOM Not Needed', 'BOM Not Needed Log']],
  ['tblCViWvJVTiyfemT', 'BOM Items', ['AC / DC', 'Not Required', 'Not Required Log']],
  ['tblTyn8CLNIrh0ep2', 'Quote Lines', ['Qty Quoted', 'Lead Time', 'Confirmed By (App)', 'Confirmed At']],
  ['tbld3vmEPL1LA20q7', 'TAGEX BOMs', [
    'Submitted By (App)', 'Submitted At', 'Approved By (App)', 'Approved At',
    'Rejected By (App)', 'Rejected At', 'Rejection Reason', 'Approval Log',
    'Qty Signed Off By (App)', 'Qty Signed Off At', 'FN1 Starts',
  ]],
  ['tblpiKz5MWbqmxtYV', 'TAGEX BOM Lines', [
    'Qty From Stock Override', 'Qty To Order Override', 'Chosen Qty', 'Qty Issued', 'AC / DC',
    'Needed By', 'Ordered At', 'Ordered By (App)', 'Qty Ordered', 'Not Required',
    'Not Required Log', 'Qty Received', 'Received At', 'Received By (App)', 'Receiving Log',
    'Kept Separate',
  ]],
];

// Airtable works these out; sending them back is at best ignored and at worst rejected.
const DERIVED_OPTIONS = ['isValid', 'referencedFieldIds', 'result'];
const COMPUTED = new Set(['rollup', 'formula', 'count', 'multipleLookupValues']);

// A rollup CANNOT be copied faithfully. Reading one gives back recordLinkFieldId,
// fieldIdInLinkedTable and the result type -- but NOT options.formula, the aggregation itself,
// which creating one requires. So the aggregation has to be stated here, and stating a guess
// silently would be worse than not trying, hence one explicit entry per field with its reasoning.
//
// This is not optional tidying. 'Chosen Qty' is in mod-tagexbom.js's LINE_FIELDS, the list of
// names used to READ a BOM line, and Airtable answers a read naming one unknown field with
// 422 UNKNOWN_FIELD_NAME for the whole request -- verified against RES on 27 Oct 2026. While the
// field is absent, every BOM line read in the residential app fails, not just this column.
//
// CHECK IT AGAINST O&M IF THE VALUE EVER LOOKS WRONG. O&M holds one TAGEX BOM Line and its
// Chosen Qty is empty, so there was no value to confirm against. The inference is from the
// result type: O&M reports singleLineText, and a numeric aggregation (SUM, MAX) would report a
// number, which leaves ARRAYJOIN. Airtable shows the real formula in the field editor.
const INFERRED_ROLLUP_FORMULA = {
  'TAGEX BOM Lines.Chosen Qty': 'ARRAYJOIN(values)',
};

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
  if (!r.ok) { const e = new Error(`${r.status} ${body.slice(0, 400)}`); e.status = r.status; throw e; }
  return body ? JSON.parse(body) : {};
}

const tables = async (base) => (await api(`https://api.airtable.com/v0/meta/bases/${base}/tables`)).tables || [];

const C = { b: '\x1b[1m', g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', x: '\x1b[0m' };

(async () => {
  const om = await tables(T.BASES.OM);
  let res = await tables(T.BASES.RES);

  const omById = Object.fromEntries(om.map((t) => [t.id, t]));
  const omFieldById = {};
  for (const t of om) for (const f of t.fields) omFieldById[f.id] = { field: f, table: t };

  // Rebuilt after every create, because a rollup made in pass 2 must see pass 1's new ids.
  let resById = {};
  const reindex = () => { resById = Object.fromEntries(res.map((t) => [t.id, t])); };
  reindex();

  // An O&M field id means nothing in RES unless that field came across in the duplication.
  // Translate through the NAME, which is the thing the two bases actually agree on.
  function resIdFor(omFieldId) {
    const src = omFieldById[omFieldId];
    if (!src) return null;
    const dst = resById[src.table.id];
    const f = dst && dst.fields.find((x) => x.name === src.field.name);
    return f ? f.id : null;
  }

  // What goes on the wire to create a copy of an O&M field. `where` names the table, so a rollup
  // can be matched against INFERRED_ROLLUP_FORMULA.
  function spec(f, where) {
    const out = { name: f.name, type: f.type };
    if (f.description) out.description = f.description;
    if (!f.options) return { body: out, unresolved: [] };

    if (f.type === 'multipleRecordLinks') {
      // inverseLinkFieldId and isReversed are O&M's; the inverse is made for us and named after.
      out.options = { linkedTableId: f.options.linkedTableId };
      if (f.options.prefersSingleRecordLink) out.options.prefersSingleRecordLink = true;
      return { body: out, unresolved: [] };
    }

    const o = {};
    const unresolved = [];
    for (const [k, v] of Object.entries(f.options)) {
      if (DERIVED_OPTIONS.includes(k)) continue;
      if (k === 'choices' && Array.isArray(v)) {
        // A choice id belongs to the base it was made in and cannot be set: Airtable answers
        // "Ids of existing choices are immutable. To create a new choice, do not pass id."
        // Name and colour are what carry over; RES mints its own ids.
        o.choices = v.map((c) => (c.color ? { name: c.name, color: c.color } : { name: c.name }));
        continue;
      }
      if (typeof v === 'string' && /^fld[A-Za-z0-9]{14}$/.test(v)) {
        const mapped = resIdFor(v);
        if (!mapped) {
          const src = omFieldById[v];
          unresolved.push(`${k} -> ${src ? `${src.table.name}.${src.field.name}` : v} is not in RES yet`);
          continue;
        }
        o[k] = mapped;
      } else {
        o[k] = v;
      }
    }
    if (f.type === 'rollup' && !o.formula) {
      const inferred = INFERRED_ROLLUP_FORMULA[`${where}.${f.name}`];
      if (!inferred) {
        unresolved.push('a rollup needs options.formula, which reading O&M does not give back; '
          + `add "${where}.${f.name}" to INFERRED_ROLLUP_FORMULA, copying the aggregation from O&M`);
      } else {
        o.formula = inferred;
        out._inferred = `formula ${inferred} (O&M does not expose it; see INFERRED_ROLLUP_FORMULA)`;
      }
    }

    out.options = o;
    return { body: out, unresolved };
  }

  console.log(`\n${C.b}RES MIRROR${C.x}`);
  console.log(`  O&M ${T.BASES.OM}  ->  RES ${T.BASES.RES}`);
  console.log(APPLY ? `  ${C.y}APPLYING${C.x}\n` : '  dry run - nothing will be written. Add --apply.\n');

  let made = 0, skipped = 0, renamed = 0, problems = 0;
  const byHand = [];

  // Pass 1 is everything Airtable can make from scratch; pass 2 is the computed fields, which
  // need pass 1's fields to exist and to be found by their new ids.
  const PASSES = [
    ['plain fields', (f) => !COMPUTED.has(f.type)],
    ['computed fields', (f) => COMPUTED.has(f.type)],
  ];

  for (const [passName, wanted] of PASSES) {
    const work = [];
    for (const [tableId, label, names] of WANT) {
      const src = omById[tableId];
      if (!src) continue;
      for (const name of names) {
        const f = src.fields.find((x) => x.name === name);
        if (f && wanted(f)) work.push([tableId, label, name, f]);
      }
    }
    if (!work.length) continue;

    console.log(`${C.b}-- ${passName} --${C.x}\n`);
    let lastLabel = null;

    for (const [tableId, label, name, f] of work) {
      if (label !== lastLabel) { if (lastLabel) console.log(''); console.log(`${C.b}${label}${C.x}  (${tableId})`); lastLabel = label; }

      const dst = resById[tableId];
      if (!dst) { console.log(`  ${C.r}!${C.x}  ${name}: table is not in RES at all`); problems++; continue; }

      const existing = dst.fields.find((x) => x.name === name);
      if (existing) {
        const ok = existing.type === f.type;
        console.log(`  ${ok ? C.g + '=' : C.r + '!'}${C.x}  ${name}: already in RES as ${existing.type}`
          + (ok ? ', left alone' : `, and O&M has ${f.type}. The API cannot change a field's type; that one is by hand.`));
        if (ok) skipped++; else problems++;
        continue;
      }

      const { body, unresolved } = spec(f, label);
      const inferred = body._inferred;
      delete body._inferred;
      if (unresolved.length) {
        console.log(`  ${C.r}!${C.x}  ${name} [${f.type}]: ${unresolved.join('; ')}`);
        byHand.push(`${label}.${name} [${f.type}] - ${unresolved.join('; ')}`);
        problems++;
        continue;
      }

      if (!APPLY) {
        console.log(`  ${C.c}+${C.x}  ${name}  [${body.type}]${body.options ? '  ' + JSON.stringify(body.options) : ''}`);
        if (inferred) console.log(`       ${C.y}inferred:${C.x} ${inferred}`);
        if (f.type === 'multipleRecordLinks') {
          const inv = omFieldById[f.options.inverseLinkFieldId];
          const far = resById[f.options.linkedTableId];
          console.log(`       plus its inverse on "${far ? far.name : '?'}", renamed to "${inv ? inv.field.name : '?'}" if Airtable names it otherwise`);
        }
        made++;
        continue;
      }

      let created;
      try {
        created = await api(`https://api.airtable.com/v0/meta/bases/${T.BASES.RES}/tables/${tableId}/fields`,
          { method: 'POST', body: JSON.stringify(body) });
      } catch (e) {
        console.log(`  ${C.r}!${C.x}  ${name} [${f.type}]: Airtable refused - ${e.message}`);
        byHand.push(`${label}.${name} [${f.type}] - ${JSON.stringify(body.options || {})}`);
        problems++;
        continue;
      }
      console.log(`  ${C.g}+${C.x}  ${name}  [${created.type}]  ${created.id}`);
      if (inferred) console.log(`       ${C.y}inferred:${C.x} ${inferred}`);
      made++;

      res = await tables(T.BASES.RES);                 // so the next field sees this one's id
      reindex();

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
      const far = resById[farId];
      const inv = far && far.fields.find((x) => x.id === invId);
      const target = wantInverse.field.name;
      if (!inv) { console.log(`       ${C.y}?${C.x}  inverse ${invId} is not on ${farId}`); problems++; continue; }
      if (inv.name === target) { console.log(`       its inverse on "${far.name}" is already "${target}"`); continue; }
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
      res = await tables(T.BASES.RES);
      reindex();
    }
    console.log('');
  }

  console.log(`  ${made} ${APPLY ? 'created' : 'to create'}, ${renamed} inverse${renamed === 1 ? '' : 's'} renamed, ${skipped} already there, ${problems} needing a look`);
  if (byHand.length) {
    console.log(`\n  ${C.y}BY HAND IN AIRTABLE${C.x} - the meta API would not make these:`);
    for (const b of byHand) console.log(`    ${b}`);
  }
  console.log(APPLY ? '\n  Now: node test/verify-res-mirror.js, here and in tagex-residential\n'
    : '\n  Nothing was written. Re-run with --apply.\n');
  if (problems) process.exit(1);
})().catch((e) => { console.error(`${C.r}Failed:${C.x}`, (e && e.message) || e); process.exit(1); });
