#!/usr/bin/env node
// Field-ID enforcement — permission rules must bite whether Airtable returns records keyed by
// field NAME or by field ID.
//
//   node test/verify-field-ids.js
//
// WHY THIS EXISTS. The O&M Site Visit Scheduler asks Airtable for `returnFieldsByFieldId=true`
// and hard-codes 39 field IDs. Records then come back as { "fldBMRad0IjocAKS4": 12.5 } rather
// than { "Unit Cost": 12.5 }. Permission rules are written in names, so before this was
// handled a deny_read matched nothing and stripped nothing — the field was handed over, and
// nothing anywhere reported a problem.
//
// The last case below deliberately asserts the BROKEN behaviour when no field map is supplied,
// so that the hazard stays documented and api/at.js is never quietly allowed to stop passing
// one.

'use strict';

const path = require('path');
const P = require(path.join(__dirname, '..', 'api', '_lib', 'permissions.js'));
const ROLES = require(path.join(__dirname, 'roles.fixture.json'));

const TECH = 'Technician / Field';
const WH = 'Warehouse / Stores';
const OPS = 'Operations / Project Manager';

let pass = 0, fail = 0;
const failures = [];

function t(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  if (ok) pass++; else { fail++; failures.push(`${label}\n      expected ${e}\n      actual   ${a}`); }
  console.log(`  ${ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}`);
  return ok;
}

const perms = {};
for (const r of [TECH, WH, OPS]) perms[r] = P.effectivePermissions(ROLES[r].Permissions, null);

// Real Delivery Lines field ids, C&I base.
const DL_IDS = {
  fldkKQ72uYWTVYC0f: 'Item Description',
  fldxaZD0EJOlAMGTp: 'Quantity',
  fldBMRad0IjocAKS4: 'Unit Cost',
  fldLHefJNMhQL961t: 'Line Value',
};
const byName = { 'Item Description': 'LUGS', Quantity: 50, 'Unit Cost': 12.5, 'Line Value': 625 };
const byId = {
  fldkKQ72uYWTVYC0f: 'LUGS', fldxaZD0EJOlAMGTp: 50,
  fldBMRad0IjocAKS4: 12.5, fldLHefJNMhQL961t: 625,
};

console.log('\n\x1b[1mFIELD-ID ENFORCEMENT\x1b[0m\n');

// ── reads ────────────────────────────────────────────────────────────────────
function readCase(label, role, moduleKey, record, map, mustBeAbsent, mustBePresent) {
  const rule = perms[role][moduleKey] || {};
  const out = P.filterReadFields(rule, record, map);
  const leaked = mustBeAbsent.filter((k) => k in out);
  const lost = mustBePresent.filter((k) => !(k in out));
  const actual = leaked.length ? `LEAKED ${leaked.join(', ')}`
    : lost.length ? `LOST ${lost.join(', ')}` : 'ok';
  t(label, actual, 'ok');
}

readCase('name-keyed: Technician cannot read Unit Cost or Line Value',
  TECH, 'delivery_lines', byName, DL_IDS,
  ['Unit Cost', 'Line Value'], ['Item Description', 'Quantity']);

readCase('ID-keyed: Technician cannot read Unit Cost or Line Value',
  TECH, 'delivery_lines', byId, DL_IDS,
  ['fldBMRad0IjocAKS4', 'fldLHefJNMhQL961t'], ['fldkKQ72uYWTVYC0f', 'fldxaZD0EJOlAMGTp']);

readCase('ID-keyed: Warehouse still receives Unit Cost',
  WH, 'delivery_lines', byId, DL_IDS, [], ['fldBMRad0IjocAKS4']);

readCase('mixed keys in one record are both handled',
  TECH, 'delivery_lines',
  { 'Item Description': 'LUGS', fldBMRad0IjocAKS4: 12.5 }, DL_IDS,
  ['fldBMRad0IjocAKS4'], ['Item Description']);

// ── writes ───────────────────────────────────────────────────────────────────
(() => {
  const r = P.validateWriteFields(perms[TECH].delivery_lines, { fldBMRad0IjocAKS4: 99 }, DL_IDS);
  t('write by field id is rejected', r.ok, false);
  t('…and the 403 names "Unit Cost", not the raw id',
    !r.ok && /Unit Cost/.test(r.detail) && !/fld/.test(r.detail), true);
})();

(() => {
  const r = P.validateWriteFields(perms[WH].delivery_lines, { fldBMRad0IjocAKS4: 99 }, DL_IDS);
  t('Warehouse may write Unit Cost by field id', r.ok, true);
})();

(() => {
  // allow_write must also resolve ids — Technician may write job card Status and nothing else.
  const map = { fldNoL4FzEHcT027I: 'Status', fldIUN165c8kR6Z1R: 'Invoice' };
  const okStatus = P.validateWriteFields(perms[TECH].job_cards, { fldNoL4FzEHcT027I: 'Open' }, map);
  const noInvoice = P.validateWriteFields(perms[TECH].job_cards, { fldIUN165c8kR6Z1R: 'INV-1' }, map);
  t('allow_write resolves ids: Status permitted', okStatus.ok, true);
  t('allow_write resolves ids: Invoice refused', noInvoice.ok, false);
})();

// ── sensitivity ──────────────────────────────────────────────────────────────
(() => {
  const nameToId = { Sensitivity: 'fldNsUsslEKoxSORj' };
  const restricted = { fields: { fldNsUsslEKoxSORj: 'Restricted' } };
  const internal = { fields: { fldNsUsslEKoxSORj: 'Internal' } };
  t('ID-keyed Restricted document blocked for Ops/PM',
    P.recordWithinSensitivity(perms[OPS].documents, 'documents', restricted, nameToId), false);
  t('ID-keyed Internal document allowed for Ops/PM',
    P.recordWithinSensitivity(perms[OPS].documents, 'documents', internal, nameToId), true);
  t('ID-keyed select object form is read correctly',
    P.recordWithinSensitivity(perms[OPS].documents, 'documents',
      { fields: { fldNsUsslEKoxSORj: { id: 'sel1', name: 'Restricted' } } }, nameToId), false);
})();

// ── the hazard, asserted ─────────────────────────────────────────────────────
(() => {
  const out = P.filterReadFields(perms[TECH].delivery_lines, byId, null);
  t('WITHOUT a field map an ID-keyed record leaks — api/at.js must always supply one',
    'fldBMRad0IjocAKS4' in out, true);
})();

console.log('\n' + '='.repeat(70));
if (fail === 0) console.log(`\x1b[32m\x1b[1m  ALL ${pass} ASSERTIONS PASSED\x1b[0m`);
else {
  console.log(`\x1b[31m\x1b[1m  ${fail} FAILED\x1b[0m, ${pass} passed\n`);
  failures.forEach((f) => console.log('  \x1b[31m*\x1b[0m ' + f));
}
console.log('='.repeat(70) + '\n');
process.exit(fail === 0 ? 0 : 1);
