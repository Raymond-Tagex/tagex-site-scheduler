#!/usr/bin/env node
// Drives the REAL api/at.js handler to prove the order of its checks on update and delete.
//
//   node test/verify-at-order.js
//
// What is proved: a record outside the caller's scope is indistinguishable from one that does
// not exist -- same status, same body -- and nothing about it is decided, audited as Allowed,
// or written before that is established. A guard that runs first ("locked", "cannot cancel")
// answers differently depending on what the record holds, which tells someone with no access to
// it that it exists and what state it is in.
//
// Real: at.js, permissions.js, tables.js, guards.js, http.js. Stubbed: Airtable, the session,
// and the audit writer -- so nothing here needs a token or touches a base.

'use strict';

const path = require('path');
const api = (m) => path.join(__dirname, '..', 'api', m);

process.env.AUTH_MODE = 'session';

// ── the stubbed Airtable ───────────────────────────────────────────────────
const RECORDS = {};
const IN_SCOPE = new Set();
let WRITES = [];

const notFound = () => Object.assign(new Error('not found'), { status: 404, name: 'AirtableError' });
const airtable = {
  AirtableError: class extends Error {},
  COMPUTED_TYPES: new Set(),
  async get(baseId, tableId, id) {
    if (!RECORDS[id]) throw notFound();
    return JSON.parse(JSON.stringify(RECORDS[id]));
  },
  async list(baseId, tableId, opts) {
    // recordPassesScope asks: AND(RECORD_ID() = "rec…", <scope filter>). The stub answers it.
    const m = /RECORD_ID\(\) = "([^"]+)"/.exec((opts && opts.filterByFormula) || '');
    if (m) return IN_SCOPE.has(m[1]) && RECORDS[m[1]] ? [RECORDS[m[1]]] : [];
    return [];
  },
  async update(baseId, tableId, id, fields) {
    WRITES.push({ op: 'update', id, fields });
    return { id, fields: Object.assign({}, (RECORDS[id] || {}).fields, fields) };
  },
  async destroy(baseId, tableId, id) { WRITES.push({ op: 'destroy', id }); return { id }; },
  async create(baseId, tableId, rows) { WRITES.push({ op: 'create', rows }); return [{ id: 'recNEW00000000000', fields: rows[0] }]; },
  async findOne() { return null; },
  async fieldMaps() { return { idToName: {}, nameToId: {} }; },
  async validateAgainstSchema() { return { ok: true }; },
  async tableSchema() { return null; },
  async baseSchema() { return null; },
};

// ── the stubbed session: whoever the test says is signed in ────────────────
let WHO = null;
const session = {
  async authenticate() { return WHO; },
  clientIp: () => '127.0.0.1',
  userAgent: () => 'verify-at-order',
  mustEnrolMfa: () => false,
  markSessionTouchedRestricted: async () => {},
};

let AUDIT = [];
const audit = {
  audit: (e) => { AUDIT.push(e); },
  auditNow: async (e) => { AUDIT.push(e); },
  auditFieldChanges: async (e) => { AUDIT.push({ ...e, action: 'Update', result: 'Allowed' }); },
};

const stub = (file, exports) => {
  const id = require.resolve(api(file));
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
stub('_lib/airtable.js', airtable);
stub('_lib/session.js', session);
stub('_lib/audit.js', audit);

const P = require(api('_lib/permissions.js'));
const handler = require(api('at.js'));

// ── people ─────────────────────────────────────────────────────────────────
const ALL = { view: true, create: true, edit: true, delete: true, export: true };
function signedIn(email, perms, scope) {
  return {
    ok: true, email, userRecordId: 'recUSER0000000000', sid: 'sid-' + email,
    user: { Email: email, Status: 'Active', 'Record Scope': scope },
    role: { 'Role Name': 'Test', 'Default Record Scope': scope },
    perms: P.effectivePermissions(JSON.stringify(perms), null),
  };
}
// May edit picking slips, may not delete them -- and sees only the slips they created.
const warehouse = signedIn('warehouse@tagexenergy.co.za',
  { picking_slips: { view: true, create: true, edit: true, delete: false, export: false } },
  'Own Records Only');
// May do anything to a picking slip, including amend a signed one -- but only their own.
const admin = signedIn('admin@tagexenergy.co.za', { picking_slips: ALL }, 'Own Records Only');

// ── records ────────────────────────────────────────────────────────────────
function reset() {
  for (const k of Object.keys(RECORDS)) delete RECORDS[k];
  IN_SCOPE.clear();
  const slip = (id, extra) => ({ id, createdTime: '2026-09-01T00:00:00.000Z',
    fields: Object.assign({ 'PS Number': 'PS-' + id.slice(-4), Status: 'Picked' }, extra) });
  RECORDS.recLOCKEDMINE0001 = slip('recLOCKEDMINE0001', { Locked: true });
  RECORDS.recLOCKEDTHEIRS01 = slip('recLOCKEDTHEIRS01', { Locked: true });
  RECORDS.recOPENTHEIRS0001 = slip('recOPENTHEIRS0001', { Status: 'Submitted' });
  RECORDS.recOPENMINE000001 = slip('recOPENMINE000001', { Status: 'Submitted' });
  IN_SCOPE.add('recLOCKEDMINE0001');
  IN_SCOPE.add('recOPENMINE000001');
  WRITES = [];
  AUDIT = [];
}

async function call(who, body) {
  WHO = who;
  const res = {
    code: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    send(b) { this.body = JSON.parse(b); return this; },
  };
  await handler({ method: 'POST', body, headers: {}, url: '/api/at' }, res);
  return res;
}

// ── assertions ─────────────────────────────────────────────────────────────
let failed = 0;
let passed = 0;
function t(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++; else failed++;
  console.log((ok ? '  \x1b[32mpass\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m  ') + label
    + (ok ? '' : '\n        expected ' + JSON.stringify(expected) + '\n        got      ' + JSON.stringify(actual)));
}
const allowed = () => AUDIT.filter((e) => e.result === 'Allowed');
const shape = (r) => ({ code: r.code, reason: r.body && r.body.reason, detail: r.body && r.body.detail });

(async () => {
  const upd = (recordId, fields, extra) => ({ op: 'update', base: 'CI', table: 'picking_slips', recordId, fields, ...extra });
  const del = (recordId, extra) => ({ op: 'delete', base: 'CI', table: 'picking_slips', recordId, ...extra });

  console.log('\nupdate: a record outside scope looks exactly like one that does not exist');
  reset();
  const ghost = await call(warehouse, upd('recDOESNOTEXIST01', { 'Site Name': 'x' }));
  t('a missing slip is 404', ghost.code, 404);

  reset();
  const theirs = await call(warehouse, upd('recLOCKEDTHEIRS01', { 'Site Name': 'x' }));
  t('someone else\'s signed slip is 404, not "locked"', theirs.body.reason, 'not_found');
  t('and the response is identical to a missing one', shape(theirs), shape(ghost));
  t('nothing was written', WRITES, []);
  t('nothing was audited as Allowed', allowed().length, 0);
  t('the denial is logged as out of scope', AUDIT.map((e) => e.denialReason), ['scope_excluded']);

  console.log('\nupdate: the guards still work once the record is in scope');
  reset();
  const mine = await call(warehouse, upd('recLOCKEDMINE0001', { 'Site Name': 'x' }));
  t('my own signed slip is refused as locked', [mine.code, mine.body.reason], [409, 'picking_slip_locked']);
  t('and not written', WRITES, []);

  reset();
  const ok = await call(warehouse, upd('recOPENMINE000001', { 'Site Name': 'Depot' }));
  t('my own open slip updates', ok.code, 200);
  t('and is written once', WRITES.map((w) => [w.op, w.id]), [['update', 'recOPENMINE000001']]);

  console.log('\nupdate: an override reaches nothing outside scope');
  reset();
  const amend = await call(admin, upd('recLOCKEDTHEIRS01', { 'Site Name': 'x' }));
  t('an admin amending someone else\'s signed slip gets 404', amend.body.reason, 'not_found');
  t('no "amended by admin" row is logged for it', allowed().length, 0);

  reset();
  const cancel = await call(admin, upd('recOPENTHEIRS0001', { Status: 'Cancelled' },
    { override: { reason: 'Stock not available from the supplier this month' } }));
  t('cancelling someone else\'s slip gets 404', cancel.body.reason, 'not_found');
  t('no "cancelled" row is logged for it', allowed().length, 0);
  t('and nothing was written', WRITES, []);

  console.log('\ndelete: now checks scope at all');
  reset();
  const delGhost = await call(admin, del('recDOESNOTEXIST01'));
  t('deleting a missing slip is 404', delGhost.code, 404);

  reset();
  const delTheirs = await call(admin, del('recOPENTHEIRS0001',
    { override: { reason: 'Stock not available from the supplier this month' } }));
  t('deleting someone else\'s slip is 404', delTheirs.body.reason, 'not_found');
  t('and looks exactly like a missing one', shape(delTheirs), shape(delGhost));
  t('and nothing was deleted or cancelled', WRITES, []);
  t('and nothing was audited as Allowed', allowed().length, 0);

  reset();
  const delMine = await call(admin, del('recOPENMINE000001',
    { override: { reason: 'Stock not available from the supplier this month' } }));
  t('deleting my own slip still works', delMine.code, 200);
  t('as a soft delete to Cancelled', WRITES.map((w) => [w.op, w.id, w.fields && w.fields.Status]),
    [['update', 'recOPENMINE000001', 'Cancelled']]);

  reset();
  const noRight = await call(warehouse, del('recOPENMINE000001'));
  t('a role without delete is still refused before any of this', noRight.code, 403);

  console.log(failed
    ? `\n\x1b[31m\x1b[1m  ${failed} FAILED\x1b[0m, ${passed} passed`
    : `\n\x1b[32m\x1b[1m  ALL ${passed} ASSERTIONS PASSED\x1b[0m`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('\x1b[31mSuite crashed:\x1b[0m', e); process.exit(1); });
