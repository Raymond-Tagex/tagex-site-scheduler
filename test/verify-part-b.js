#!/usr/bin/env node
// Part B verification — asserts the seeded Permissions JSON against the permission matrix
// exactly as written in the brief, cell by cell, plus the field-level restriction table and
// the record-scope rules.
//
//   node test/verify-part-b.js
//
// This proves the ENGINE and the SEED agree with the spec. It does not prove the HTTP layer
// enforces them — that is Part D, which re-runs equivalent assertions with real curl calls
// against a live session cookie.

'use strict';

const path = require('path');
const P = require(path.join(__dirname, '..', 'api', '_lib', 'permissions.js'));
const T = require(path.join(__dirname, '..', 'api', '_lib', 'tables.js'));
const ROLES = require(path.join(__dirname, 'roles.fixture.json'));

const ADMIN = 'Admin / Director';
const OPS   = 'Operations / Project Manager';
const TECH  = 'Technician / Field';
const WH    = 'Warehouse / Stores';
const ROLE_ORDER = [ADMIN, OPS, TECH, WH];

// ── Part B, transcribed verbatim. "-" = no access. ───────────────────────────
// V=view C=create E=edit D=delete X=export
const MATRIX = {
  clients:             { [ADMIN]: 'VCEDX', [OPS]: 'VCEX', [TECH]: 'V',   [WH]: 'V'     },
  systems:             { [ADMIN]: 'VCEDX', [OPS]: 'VCEX', [TECH]: 'V',   [WH]: 'V'     },
  contracts:           { [ADMIN]: 'VCEDX', [OPS]: 'VCE',  [TECH]: '-',   [WH]: '-'     },
  slas:                { [ADMIN]: 'VCEDX', [OPS]: 'VCE',  [TECH]: 'V',   [WH]: '-'     },
  warranty_register:   { [ADMIN]: 'VCEDX', [OPS]: 'VCEX', [TECH]: 'V',   [WH]: 'V'     },
  documents:           { [ADMIN]: 'VCEDX', [OPS]: 'VCEX', [TECH]: 'V',   [WH]: 'V'     },
  restricted_personal: { [ADMIN]: 'VCED',  [OPS]: '-',    [TECH]: '-',   [WH]: '-'     },
  tickets:             { [ADMIN]: 'VCEDX', [OPS]: 'VCEX', [TECH]: 'VCE', [WH]: 'V'     },
  error_criteria:      { [ADMIN]: 'VCED',  [OPS]: 'VCE',  [TECH]: 'V',   [WH]: '-'     },
  job_cards:           { [ADMIN]: 'VCEDX', [OPS]: 'VCEX', [TECH]: 'VE',  [WH]: 'V'     },
  delivery_notes:      { [ADMIN]: 'VCEDX', [OPS]: 'VCEX', [TECH]: 'V',   [WH]: 'VCEX'  },
  delivery_lines:      { [ADMIN]: 'VCEDX', [OPS]: 'VCEX', [TECH]: 'V',   [WH]: 'VCE'   },
  stock_items:         { [ADMIN]: 'VCEDX', [OPS]: 'VCEX', [TECH]: 'V',   [WH]: 'VCEX'  },
  second_hand_parts:   { [ADMIN]: 'VCEDX', [OPS]: 'VCEX', [TECH]: 'VE',  [WH]: 'VCEX'  },
  site_visits:         { [ADMIN]: 'VCEDX', [OPS]: 'VCEX', [TECH]: 'VCE', [WH]: '-'     },
  support_requests:    { [ADMIN]: 'VCEDX', [OPS]: 'VCEX', [TECH]: 'V',   [WH]: '-'     },
  response_templates:  { [ADMIN]: 'VCED',  [OPS]: 'VE',   [TECH]: 'V',   [WH]: '-'     },
  users:               { [ADMIN]: 'VCED',  [OPS]: '-',    [TECH]: '-',   [WH]: '-'     },
  access_levels:       { [ADMIN]: 'VCED',  [OPS]: '-',    [TECH]: '-',   [WH]: '-'     },
  audit_log:           { [ADMIN]: 'VX',    [OPS]: 'V',    [TECH]: 'V',   [WH]: 'V'     },
  reports:             { [ADMIN]: 'VX',    [OPS]: 'VX',   [TECH]: '-',   [WH]: 'VX'    },
};

const LETTER = { view: 'V', create: 'C', edit: 'E', delete: 'D', export: 'X' };

let pass = 0, fail = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) pass++;
  else { fail++; failures.push(`${label}\n      expected: ${expected}\n      actual:   ${actual}`); }
  return ok;
}

const perms = {};
for (const name of ROLE_ORDER) {
  perms[name] = P.effectivePermissions(ROLES[name].Permissions, null);
}

// ─────────────────────────────────────────────────────────────
console.log('\n\x1b[1mPART B — MODULE × OPERATION MATRIX\x1b[0m\n');
const W = 21;
console.log('  ' + 'Module'.padEnd(W) + ROLE_ORDER.map((r) => r.split(' ')[0].padEnd(12)).join(''));
console.log('  ' + '-'.repeat(W + 48));

for (const [moduleKey, row] of Object.entries(MATRIX)) {
  const cells = [];
  for (const role of ROLE_ORDER) {
    const granted = P.OPS.filter((op) => P.can(perms[role], moduleKey, op).ok)
      .map((op) => LETTER[op]).join('');
    const actual = granted || '-';
    const expected = row[role];
    const ok = check(`matrix ${moduleKey} / ${role}`, actual, expected);
    cells.push((ok ? '\x1b[32m' : '\x1b[31m') + actual.padEnd(12) + '\x1b[0m');
  }
  console.log('  ' + moduleKey.padEnd(W) + cells.join(''));
}

// ─────────────────────────────────────────────────────────────
console.log('\n\x1b[1mFIELD-LEVEL RESTRICTIONS\x1b[0m\n');

function readCase(label, role, moduleKey, record, mustBeAbsent, mustBePresent = []) {
  const rule = perms[role][moduleKey] || {};
  const out = P.filterReadFields(rule, record);
  const leaked = mustBeAbsent.filter((f) => f in out);
  const lost   = mustBePresent.filter((f) => !(f in out));
  const actual = leaked.length ? `LEAKED ${leaked.join(', ')}`
              : lost.length   ? `LOST ${lost.join(', ')}`
              : 'ok';
  check(label, actual, 'ok');
  console.log(`  ${leaked.length || lost.length ? '\x1b[31mFAIL\x1b[0m' : '\x1b[32mpass\x1b[0m'}  ${label}`);
}

function writeCase(label, role, moduleKey, fields, shouldReject) {
  const rule = perms[role][moduleKey] || {};
  const res = P.validateWriteFields(rule, fields);
  const actual = res.ok ? 'allowed' : `rejected: ${res.rejected.map((r) => r.field).join(', ')}`;
  const expected = shouldReject === null ? 'allowed' : `rejected: ${shouldReject}`;
  const ok = check(label, actual, expected);
  console.log(`  ${ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}`);
  if (!ok) console.log(`        got: ${actual}`);
}

const dlRecord = { 'Item Description': 'LUGS 35X8MM', Quantity: 50, 'Unit Cost': 12.5, 'Line Value': 625 };
readCase('Technician cannot read Unit Cost / Line Value on delivery_lines',
  TECH, 'delivery_lines', dlRecord, ['Unit Cost', 'Line Value'], ['Item Description', 'Quantity']);
readCase('Warehouse CAN read Unit Cost on delivery_lines (needs it to price a note)',
  WH, 'delivery_lines', dlRecord, [], ['Unit Cost', 'Line Value']);
readCase('Technician cannot read Unit Cost on stock_items',
  TECH, 'stock_items', { 'Item Description': 'X', 'Unit Cost': 99 }, ['Unit Cost'], ['Item Description']);
readCase('Warehouse cannot read client contact details',
  WH, 'clients', { 'Client Name': 'Acme', 'Contact Person': 'Jo', Email: 'jo@acme.co', 'Mobile Number': '+27' },
  ['Contact Person', 'Email', 'Mobile Number'], ['Client Name']);
readCase('Technician cannot read job card financials',
  TECH, 'job_cards', { 'JC Reference': 'JC1', Budget: 100, 'Actual Cost': 90, 'Project Value': 500, Status: 'Open' },
  ['Budget', 'Actual Cost', 'Project Value'], ['JC Reference', 'Status']);
readCase('Warehouse cannot read job card financials',
  WH, 'job_cards', { 'JC Reference': 'JC1', Budget: 100, Invoice: 'INV-1', Status: 'Open' },
  ['Budget', 'Invoice'], ['JC Reference', 'Status']);
readCase('Admin cannot read Password Hash / MFA Secret (global never-return)',
  ADMIN, 'users', { Email: 'a@b.co', 'Password Hash': 'scrypt$x', 'MFA Secret': 'ABC', Status: 'Active' },
  ['Password Hash', 'MFA Secret'], ['Email', 'Status']);

console.log('');
writeCase('Technician writing Unit Cost on a delivery line is rejected, naming the field',
  TECH, 'delivery_lines', { Quantity: 5, 'Unit Cost': 1 }, 'Unit Cost');
writeCase('Warehouse writing Unit Cost on a delivery line is allowed',
  WH, 'delivery_lines', { Quantity: 5, 'Unit Cost': 1 }, null);
writeCase('Technician writing job card Status is allowed (in allow_write)',
  TECH, 'job_cards', { Status: 'In Progress' }, null);
writeCase('Technician writing job card Invoice is rejected (not in allow_write)',
  TECH, 'job_cards', { Invoice: 'INV-99' }, 'Invoice');
writeCase('Technician writing an unlisted job card field is rejected (deny by default)',
  TECH, 'job_cards', { 'Some Field Nobody Thought Of': 1 }, 'Some Field Nobody Thought Of');
writeCase('Admin writing Password Hash through the proxy is rejected',
  ADMIN, 'users', { 'Password Hash': 'x' }, 'Password Hash');
writeCase('Warehouse writing second-hand part Sale Price is rejected',
  WH, 'second_hand_parts', { 'Sale Price': 100 }, 'Sale Price');

// ─────────────────────────────────────────────────────────────
console.log('\n\x1b[1mRESTRICTED PERSONAL DATA — DOUBLE GATE\x1b[0m\n');

function gateCase(label, roleName, userFlag, expectOk) {
  const rule = perms[roleName]['restricted_personal'];
  const modOk = P.can(perms[roleName], 'restricted_personal', 'view').ok;
  let ok = modOk;
  if (modOk) {
    ok = P.canViewRestricted(rule, ROLES[roleName], { 'Can View Restricted Documents': userFlag }).ok;
  }
  const okStr = ok ? 'allowed' : 'denied';
  const passed = check(label, okStr, expectOk ? 'allowed' : 'denied');
  console.log(`  ${passed ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label} -> ${okStr}`);
}

gateCase('Admin WITH per-user flag may view FICA', ADMIN, true, true);
gateCase('Admin WITHOUT per-user flag may NOT view FICA (role alone is not enough)', ADMIN, false, false);
gateCase('Ops/PM may not view FICA even with the per-user flag set', OPS, true, false);
gateCase('Technician may not view FICA even with the per-user flag set', TECH, true, false);
gateCase('Warehouse may not view FICA even with the per-user flag set', WH, true, false);

// ─────────────────────────────────────────────────────────────
console.log('\n\x1b[1mDOCUMENT SENSITIVITY (read cap and export cap)\x1b[0m\n');

function sensCase(label, roleName, level, expectRead, expectExport) {
  const rule = perms[roleName]['documents'] || {};
  const rec = { fields: level === null ? {} : { Sensitivity: level } };
  const r = P.recordWithinSensitivity(rule, 'documents', rec) ? 'read' : 'no-read';
  const x = P.recordExportable(rule, 'documents', rec) ? 'export' : 'no-export';
  const ok1 = check(`${label} [read]`, r, expectRead ? 'read' : 'no-read');
  const ok2 = check(`${label} [export]`, x, expectExport ? 'export' : 'no-export');
  const mark = ok1 && ok2 ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark}  ${label.padEnd(46)} ${r.padEnd(9)} ${x}`);
}

sensCase('Admin / Confidential doc',            ADMIN, 'Confidential', true,  true);
sensCase('Admin / Restricted doc',              ADMIN, 'Restricted',   true,  false);
sensCase('Ops / Internal doc',                  OPS,   'Internal',     true,  true);
sensCase('Ops / Confidential doc',              OPS,   'Confidential', true,  false);
sensCase('Ops / Restricted doc',                OPS,   'Restricted',   false, false);
sensCase('Technician / Internal doc',           TECH,  'Internal',     true,  false);
sensCase('Technician / Confidential doc',       TECH,  'Confidential', false, false);
sensCase('Warehouse / Public doc',              WH,    'Public',       true,  false);
sensCase('Warehouse / Confidential doc',        WH,    'Confidential', false, false);
sensCase('Ops / UNCLASSIFIED doc (blank)',      OPS,   null,           false, false);
sensCase('Admin / UNCLASSIFIED doc (blank)',    ADMIN, null,           true,  false);

// ─────────────────────────────────────────────────────────────
console.log('\n\x1b[1mRECORD SCOPE — server-injected filterByFormula\x1b[0m\n');

const techUser = {
  Email: 'thabo@tagexenergy.co.za',
  'Record Scope': 'Assigned Only',
  'Assigned Clients': '["Fueltron"]',
  'Assigned Sites': '["Olivedale"]',
};
const whUser = { Email: 'byron@tagexenergy.co.za', 'Record Scope': 'All Records' };

function scopeCase(label, args, expectFn) {
  const f = P.scopeFilter(args);
  const ok = expectFn(f);
  check(label, ok ? 'ok' : `unexpected: ${f}`, 'ok');
  console.log(`  ${ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}`);
  console.log(`        ${f === null ? '(no filter — All Records)' : f}`);
}

scopeCase('Warehouse / All Records -> no scope filter',
  { moduleKey: 'delivery_notes', baseSymbol: 'CI', scope: 'All Records', user: whUser },
  (f) => f === null);

scopeCase('Technician / job_cards CI -> matches Assigned To (Email), client and site',
  { moduleKey: 'job_cards', baseSymbol: 'CI', scope: 'Assigned Only', user: techUser },
  // client/site matches are upper-cased by fieldContains() to make them case-insensitive
  (f) => f && f.includes('Assigned To (Email)') && f.includes('FUELTRON') && f.includes('OLIVEDALE'));

scopeCase('Technician / site_visits OM -> matches the Technician Email lookup',
  { moduleKey: 'site_visits', baseSymbol: 'OM', scope: 'Assigned Only', user: techUser },
  (f) => f && f.includes('Technician Email') && f.includes('thabo@tagexenergy.co.za'));

scopeCase('Own Records Only on delivery_notes -> FALSE() (no email-bearing owner field)',
  { moduleKey: 'delivery_notes', baseSymbol: 'CI', scope: 'Own Records Only', user: techUser },
  (f) => f === 'FALSE()');

scopeCase('Own Records Only on audit_log -> matches User Email',
  { moduleKey: 'audit_log', baseSymbol: 'IAM', scope: 'Own Records Only', user: techUser },
  (f) => f && f.includes('User Email') && f.includes('thabo@tagexenergy.co.za'));

scopeCase('Assigned Only on a module with no scope fields -> FALSE(), never wide open',
  { moduleKey: 'stock_items', baseSymbol: 'CI', scope: 'Assigned Only', user: techUser },
  (f) => f === 'FALSE()');

scopeCase('Session with no email -> FALSE()',
  { moduleKey: 'job_cards', baseSymbol: 'CI', scope: 'Assigned Only', user: {} },
  (f) => f === 'FALSE()');

// ─────────────────────────────────────────────────────────────
console.log('\n\x1b[1mFILTER COMPOSITION AND INJECTION SAFETY\x1b[0m\n');

const clientFilter = 'NOT({Status} = "Completed")';
const composed = P.buildReadFilter({
  moduleKey: 'job_cards', baseSymbol: 'CI', rule: perms[TECH].job_cards,
  scope: 'Assigned Only', user: techUser, clientFilter,
});
let ok = composed.includes(clientFilter) && composed.startsWith('AND(') && composed.includes('Assigned To (Email)');
check('client filter is AND-ed with scope, never replaced', ok ? 'ok' : `bad: ${composed}`, 'ok');
console.log(`  ${ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  client filter is AND-ed with scope, never replaced`);
console.log(`        ${composed}`);

const docFilter = P.buildReadFilter({
  moduleKey: 'documents', baseSymbol: 'CI', rule: perms[WH].documents,
  scope: 'All Records', user: whUser, clientFilter: null,
});
ok = docFilter.includes('Sensitivity') && docFilter.includes('Record Status') && !docFilter.includes('Confidential');
check('documents read filter caps sensitivity and excludes soft-deleted', ok ? 'ok' : `bad: ${docFilter}`, 'ok');
console.log(`  ${ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  documents read filter caps sensitivity and excludes soft-deleted`);
console.log(`        ${docFilter}`);

const nasty = 'Fuel") , 1) > 0, TRUE(), FIND("';
const injUser = { Email: 'x@y.co', 'Assigned Clients': JSON.stringify([nasty]) };
const injected = P.scopeFilter({ moduleKey: 'clients', baseSymbol: 'CI', scope: 'Assigned Only', user: injUser });
// Every quote from the payload must be backslash-escaped; the formula must stay one FIND().
const quotesEscaped = !/[^\\]"/.test(injected.slice(injected.indexOf('FIND("') + 6, injected.lastIndexOf('", UPPER')));
ok = injected.includes('\\"') && quotesEscaped;
check('formula injection via Assigned Clients is escaped', ok ? 'ok' : `bad: ${injected}`, 'ok');
console.log(`  ${ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  formula injection via Assigned Clients is escaped`);
console.log(`        ${injected}`);

const bs = P.escapeFormulaString('back\\slash and "quote"');
ok = bs === 'back\\\\slash and \\"quote\\"';
check('backslash is escaped before quotes', ok ? 'ok' : `bad: ${bs}`, 'ok');
console.log(`  ${ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  backslash escaped before quotes -> ${bs}`);

// ─────────────────────────────────────────────────────────────
console.log('\n\x1b[1mPERMISSION OVERRIDES (per-user, applied on top of the role)\x1b[0m\n');

function ovCase(label, roleName, overrides, moduleKey, op, expect) {
  const merged = P.effectivePermissions(ROLES[roleName].Permissions, overrides);
  const actual = P.can(merged, moduleKey, op).ok ? 'allowed' : 'denied';
  const okk = check(label, actual, expect);
  console.log(`  ${okk ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label} -> ${actual}`);
}

ovCase('Override can revoke an operation the role grants',
  WH, '{"delivery_notes":{"export":false}}', 'delivery_notes', 'export', 'denied');
ovCase('Override cannot introduce a module the role lacks (users stays denied)',
  WH, '{"users":{"view":true,"create":true,"edit":true,"delete":true,"export":true}}', 'users', 'view', 'denied');
ovCase('Override can grant an op within a module the role already holds',
  WH, '{"delivery_notes":{"delete":true}}', 'delivery_notes', 'delete', 'allowed');
ovCase('Null overrides leave the role exactly as seeded',
  WH, null, 'delivery_notes', 'view', 'allowed');
ovCase('Corrupt override JSON is ignored, role still applies',
  WH, '{ not json at all', 'delivery_notes', 'view', 'allowed');

const corrupt = P.effectivePermissions('{ this is not json', null);
const corruptOk = P.can(corrupt, 'delivery_notes', 'view').ok ? 'allowed' : 'denied';
check('unparseable role Permissions -> denied', corruptOk, 'denied');
console.log(`  ${corruptOk === 'denied' ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  unparseable role Permissions -> ${corruptOk}`);

// ─────────────────────────────────────────────────────────────
console.log('\n\x1b[1mWAREHOUSE DELIVERY-NOTE PATH (must survive the migration intact)\x1b[0m\n');
const whPath = [
  ['job_cards',      'view',   'load the job card picker'],
  ['stock_items',    'view',   'load the stock catalogue'],
  ['activity_log',   'view',   'DN number reservation — scans the legacy log'],
  ['delivery_notes', 'view',   'DN number reservation — scans the structured table'],
  ['delivery_notes', 'create', 'write the delivery note header'],
  ['delivery_lines', 'create', 'write the delivery lines'],
  ['activity_log',   'create', 'write the job card timeline entry'],
  ['delivery_notes', 'view',   'reprint search'],
  ['delivery_lines', 'view',   'reprint search — pull lines'],
];
for (const [mod, op, why] of whPath) {
  const r = P.can(perms[WH], mod, op);
  check(`warehouse path: ${mod}.${op}`, r.ok ? 'allowed' : 'denied', 'allowed');
  console.log(`  ${r.ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${(mod + '.' + op).padEnd(24)} ${why}`);
}

// ─────────────────────────────────────────────────────────────

// Stock master (STK). It is a product catalogue, not an operations base: only stock_items is
// mapped into it, and a cost rule written as "Unit Cost" must still bite even though that base
// calls the same idea seventeen other things.
console.log('\n\x1b[1mSTOCK MASTER BASE (STK)\x1b[0m\n');
{
  const ok = T.resolve('STK', 'stock_items');
  check('stock_items resolves in STK', ok.ok, true);
  check('it points at the PALLADIUM STOCK table', ok.tableId, 'tblunrbqwZld0rO1J');

  for (const m of ['delivery_notes', 'job_cards', 'users', 'documents', 'site_visits']) {
    check('STK carries no ' + m, T.resolve('STK', m).ok, false);
  }

  const rule = { fields: { deny_read: ['Unit Cost'] } };
  const stk = T.expandFieldRules(rule, 'stock_items', 'STK');
  check('a Unit Cost rule expands for STK', stk.fields.deny_read.length > 1, true);
  for (const f of ['Preferred Supplier Price', 'Lowest Supplier Price', 'Selling Price',
                   'Last Purchase Price', 'Mark-up %', 'Margin %']) {
    check('STK cost field denied: ' + f, stk.fields.deny_read.includes(f), true);
  }
  check('the original rule is not mutated', JSON.stringify(rule.fields.deny_read), '["Unit Cost"]');
  check('CI is unaffected by the expansion',
    JSON.stringify(T.expandFieldRules(rule, 'stock_items', 'CI').fields.deny_read), '["Unit Cost"]');
  check('allow_write is never widened',
    T.expandFieldRules({ fields: { allow_write: ['Unit Cost'] } }, 'stock_items', 'STK')
      .fields.allow_write.length, 1);

  // The end-to-end effect: a Technician must receive no cost from the stock master.
  const rec = { 'Product Name': 'x', 'Preferred Supplier Price': 100, 'Selling Price': 0,
                'Lowest Supplier Price': 90, 'Mark-up %': 0.2 };
  const techPerms = JSON.parse(ROLES['Technician / Field'].Permissions);
  const allowed = P.can(techPerms, 'stock_items', 'view');
  const out = P.filterReadFields(T.expandFieldRules(allowed.rule, 'stock_items', 'STK'), rec, null);
  check('Technician sees the product name', out['Product Name'], 'x');
  check('Technician receives no cost field',
    Object.keys(out).filter((k) => /Price|Mark-up|Margin/.test(k)).length, 0);
}

// Picking slip workflow. A delivery note is created FROM a signed picking slip and never
// directly, so these modules sit alongside delivery_notes rather than replacing anything.
// The point of these assertions is that adding a workflow did not quietly widen anyone.
console.log('\n\x1b[1mPICKING SLIP WORKFLOW\x1b[0m\n');
{
  const perm = (role) => P.effectivePermissions(ROLES[role].Permissions, null);
  const can  = (role, mod, op) => P.can(perm(role), mod, op).ok;

  // resolution
  for (const m of ['picking_slips', 'picking_slip_items', 'signatures']) {
    check(m + ' resolves in C&I', T.resolve('CI', m).ok, true);
    check(m + ' resolves in O&M', T.resolve('OM', m).ok, true);
    check(m + ' is not in the stock base', T.resolve('STK', m).ok, false);
  }
  check('picking slips are cancelled, never deleted',
    T.TABLES.picking_slips.softDelete.deletedValue, 'Cancelled');

  // who may raise a slip
  check('Ops can create a picking slip',        can('Operations / Project Manager', 'picking_slips', 'create'), true);
  check('Admin can create a picking slip',      can('Admin / Director', 'picking_slips', 'create'), true);
  check('Warehouse CANNOT create a slip',       can('Warehouse / Stores', 'picking_slips', 'create'), false);
  check('Warehouse can edit a slip (picking)',  can('Warehouse / Stores', 'picking_slips', 'edit'), true);
  check('Warehouse cannot delete a slip',       can('Warehouse / Stores', 'picking_slips', 'delete'), false);
  check('Driver can read a slip',               can('Driver', 'picking_slips', 'view'), true);
  check('Driver cannot edit a slip',            can('Driver', 'picking_slips', 'edit'), false);
  check('Site Installer has no slip access',    can('Site Installer', 'picking_slips', 'view'), false);

  // signatures: everyone who signs may create, nobody may edit one
  for (const r of ['Warehouse / Stores', 'Driver', 'Site Installer', 'Admin / Director']) {
    check(r + ' can record a signature', can(r, 'signatures', 'create'), true);
    check(r + ' cannot edit a signature', can(r, 'signatures', 'edit'), false);
    check(r + ' cannot delete a signature', can(r, 'signatures', 'delete'), false);
  }
  check('Ops may read but not record signatures',
    can('Operations / Project Manager', 'signatures', 'create'), false);

  // the two new roles are scoped and skint
  for (const r of ['Driver', 'Site Installer']) {
    check(r + ' is Assigned Only', ROLES[r]['Default Record Scope'], 'Assigned Only');
    check(r + ' cannot export', ROLES[r]['Can Export Data'], false);
    check(r + ' cannot delete', ROLES[r]['Can Delete Records'], false);
    check(r + ' cannot manage users', ROLES[r]['Can Manage Users'], false);
    check(r + ' cannot edit permissions', ROLES[r]['Can Edit Permissions'], false);
    const jc = P.can(perm(r), 'job_cards', 'view').rule;
    check(r + ' is denied job card cost', (jc.fields.deny_read || []).includes('Budget'), true);
  }

  // a driver may move the delivery along, and touch nothing else on the note
  const drv = P.can(perm('Driver'), 'delivery_notes', 'edit').rule;
  check('driver write list is a whitelist', Array.isArray(drv.fields.allow_write), true);
  check('driver may set Status', drv.fields.allow_write.includes('Status'), true);
  check('driver may NOT set quantities', drv.fields.allow_write.includes('Quantity'), false);
  check('driver cannot create a delivery note', can('Driver', 'delivery_notes', 'create'), false);

  // the installer records what arrived, and nothing else
  const ins = P.can(perm('Site Installer'), 'delivery_lines', 'edit').rule;
  check('installer may set Qty Received', ins.fields.allow_write.includes('Qty Received'), true);
  check('installer may set a variance reason', ins.fields.allow_write.includes('Variance Reason'), true);
  check('installer may NOT change the delivered qty', ins.fields.allow_write.includes('Quantity'), false);
  check('installer is denied line cost', (ins.fields.deny_read || []).includes('Unit Cost'), true);

  // today's flow is untouched
  check('Warehouse still creates delivery notes', can('Warehouse / Stores', 'delivery_notes', 'create'), true);
  check('Warehouse still creates delivery lines', can('Warehouse / Stores', 'delivery_lines', 'create'), true);
  check('Ops still creates delivery notes', can('Operations / Project Manager', 'delivery_notes', 'create'), true);
}

// ── the admin role editor must be able to express every module ───────────────
//
// The editor rebuilds a role's Permissions from its checkboxes alone, so a module the server
// knows but the grid does not render had no checkbox and was dropped on save -- revoking it.
// This app shares the Identity & Access base with the delivery application, so a save here
// could revoke ITS modules.
{
  const fs = require('fs');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'mod-admin.js'), 'utf8');

  const m = src.match(/const MODULES = \[([\s\S]*?)\];/);
  check('the role editor declares a MODULES list', !!m, true);

  if (m) {
    const grid = new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    const server = [...new Set([
      ...Object.keys(T.TABLES),
      ...(T.VIRTUAL_MODULES || []),
      ...T.NOT_PROVISIONED,
    ])];
    for (const key of server.sort()) {
      check('role editor renders a row for "' + key + '"', grid.has(key), true);
    }
    for (const key of [...grid].sort()) {
      check('role editor row "' + key + '" is a real module', server.includes(key), true);
    }
  }

  check('save handler carries forward unrendered modules',
    /rendered\.has\(m\)/.test(src) && /!\(m in next\)/.test(src), true);
}


// ── operation flags must be real booleans ────────────────────────────────────
//
// The engine tests `=== true`. A rule written with 1/0 is truthy in JavaScript but denies here,
// so a role seeded that way looks completely broken rather than misconfigured — the module is
// refused for everyone, including Admin. That happened while seeding site_information, and it
// failed safe, which is exactly why it needed a test rather than a working demo to be noticed.
{
  const OPS_CHECKED = ['view', 'create', 'edit', 'delete', 'export'];
  for (const [roleName, def] of Object.entries(ROLES)) {
    if (roleName === '_comment') continue;
    const raw = typeof def.Permissions === 'string'
      ? JSON.parse(def.Permissions) : (def.Permissions || {});
    for (const [moduleKey, rule] of Object.entries(raw)) {
      if (!rule || typeof rule !== 'object') continue;
      for (const op of OPS_CHECKED) {
        if (!(op in rule)) continue;
        check(roleName + '.' + moduleKey + '.' + op + ' is a boolean',
          typeof rule[op], 'boolean');
      }
    }
  }
}

console.log('\n' + '='.repeat(70));
if (fail === 0) {
  console.log(`\x1b[32m\x1b[1m  ALL ${pass} ASSERTIONS PASSED\x1b[0m`);
} else {
  console.log(`\x1b[31m\x1b[1m  ${fail} FAILED\x1b[0m, ${pass} passed\n`);
  failures.forEach((f) => console.log('  \x1b[31m*\x1b[0m ' + f));
}
console.log('='.repeat(70) + '\n');
process.exit(fail === 0 ? 0 : 1);
