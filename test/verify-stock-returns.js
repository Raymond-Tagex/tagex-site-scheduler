#!/usr/bin/env node
// A job card's stock returns -- node test/verify-stock-returns.js
//
// Stock returns are the delivery app's (23 Nov 2026): its server raises, receives and closes them. This app
// shows a job card's returns on its detail screen and must never write one. Proved here:
//   - the whitelist: O&M only, read-only, not mirrored to RES;
//   - the REAL api/at.js refuses create / update / delete on stock_returns for any role, before anything is
//     written, and audits the refusal;
//   - Credit Value reaches only a role that may view costing, on the server, and cannot be filtered on;
//   - the panel (public/js/stock-returns-panel.js) asks for the credit only with costing view, draws nothing
//     in RES, and counts only received and closed credit;
//   - the screen and the Admin page are wired to it.
//
// Real: at.js, permissions.js, tables.js, guards.js, http.js. Stubbed: Airtable, the session and the audit
// writer -- nothing here needs a token or touches a base.

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const api = (m) => path.join(ROOT, 'api', m);

process.env.AUTH_MODE = 'session';

let failed = 0;
let passed = 0;
function t(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++; else failed++;
  console.log((ok ? '  \x1b[32mpass\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m  ') + label
    + (ok ? '' : '\n        expected ' + JSON.stringify(expected) + '\n        got      ' + JSON.stringify(actual)));
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── stubbed Airtable ─────────────────────────────────────────────────────────
const RET = (id, extra) => ({ id, createdTime: '2026-11-23T10:00:00.000Z',
  fields: Object.assign({ 'Return Number': 'SR-' + id.slice(-4), Status: 'Received', 'Return Date': '2026-11-23',
    'DN Number': 'DN-0042', 'Credit Value': 1234.5 }, extra) });
const RECORDS = { recRETURN00000001: RET('recRETURN00000001') };
let WRITES = [];
let LISTED = [];
const airtable = {
  AirtableError: class extends Error {},
  COMPUTED_TYPES: new Set(),
  async get(b, tb, id) {
    if (!RECORDS[id]) throw Object.assign(new Error('not found'), { status: 404 });
    return JSON.parse(JSON.stringify(RECORDS[id]));
  },
  async list(b, tb, opts) { LISTED.push(opts); return Object.values(RECORDS).map((r) => JSON.parse(JSON.stringify(r))); },
  async update(b, tb, id, fields) { WRITES.push({ op: 'update', id, fields }); return { id, fields }; },
  async destroy(b, tb, id) { WRITES.push({ op: 'destroy', id }); return { id }; },
  async create(b, tb, rows) { WRITES.push({ op: 'create', rows }); return [{ id: 'recNEW00000000000', fields: rows[0] }]; },
  async findOne() { return null; },
  async fieldMaps() { return { idToName: { fldWxokAygXAFwhxP: 'Credit Value' }, nameToId: { 'Credit Value': 'fldWxokAygXAFwhxP' } }; },
  async validateAgainstSchema() { return { ok: true }; },
  async tableSchema() { return null; },
  async baseSchema() { return null; },
};
let WHO = null;
const session = {
  async authenticate() { return WHO; },
  clientIp: () => '127.0.0.1',
  userAgent: () => 'verify-stock-returns',
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

const T = require(api('_lib/tables.js'));
const P = require(api('_lib/permissions.js'));
const handler = require(api('at.js'));
const SRP = require(path.join(ROOT, 'public', 'js', 'stock-returns-panel.js'));

const ALL = { view: true, create: true, edit: true, delete: true, export: true };
const VIEW = { view: true, create: false, edit: false, delete: false, export: false };
function signedIn(email, perms) {
  return {
    ok: true, email, userRecordId: 'recUSER0000000000', sid: 'sid-' + email,
    user: { Email: email, Status: 'Active', 'Record Scope': 'All Records' },
    role: { 'Role Name': 'Test', 'Default Record Scope': 'All Records' },
    perms: P.effectivePermissions(JSON.stringify(perms), null),
  };
}
// Every right on stock returns, and costing: the widest a role could be given in IAM.
const admin = signedIn('admin@tagexenergy.co.za', { stock_returns: ALL, costing: ALL });
// A technician: sees returns, no costing.
const tech = signedIn('tech@tagexenergy.co.za', { stock_returns: VIEW });

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
const reset = () => { WRITES = []; AUDIT = []; LISTED = []; };

(async () => {
  console.log('\nthe whitelist');
  const om = T.resolve('OM', 'stock_returns');
  t('stock_returns resolves in O&M to Stock Returns', [om.ok, om.tableId], [true, 'tblaLkt4PGXtTBgnP']);
  t('and is read-only', om.config.readOnly, true);
  t('RES has no stock returns (wrong_base, not mirrored)', [T.resolve('RES', 'stock_returns').reason, T.TABLES.stock_returns.RES], ['wrong_base', undefined]);
  t('nor C&I, in this app', T.resolve('CI', 'stock_returns').reason, 'wrong_base');
  t('it is O&M-only', T.OM_ONLY.has('stock_returns'), true);
  t('its lines are not whitelisted here', T.resolve('OM', 'stock_return_lines').reason, 'unknown_symbol');

  console.log('\nthe proxy never writes a stock return, whatever the role');
  for (const [label, body] of [
    ['create', { op: 'create', base: 'OM', table: 'stock_returns', fields: { 'Return Number': 'SR-9999' } }],
    ['update', { op: 'update', base: 'OM', table: 'stock_returns', recordId: 'recRETURN00000001', fields: { Status: 'Closed' } }],
    ['delete', { op: 'delete', base: 'OM', table: 'stock_returns', recordId: 'recRETURN00000001' }],
  ]) {
    reset();
    const r = await call(admin, body);
    t(`${label} by a role holding every right is 403 read_only_module`, [r.code, r.body.reason], [403, 'read_only_module']);
    t(`  and nothing is written`, WRITES, []);
    t(`  and the refusal is audited`, AUDIT.map((e) => [e.result, e.denialReason]), [['Denied', 'read_only_module']]);
  }

  console.log('\nreading is allowed, and the credit follows costing:view');
  reset();
  const a = await call(admin, { op: 'list', base: 'OM', table: 'stock_returns', params: { filterByFormula: 'RECORD_ID()="recRETURN00000001"' } });
  t('a role with costing view lists returns', a.code, 200);
  t('  and sees the credit', a.body.records[0].fields['Credit Value'], 1234.5);
  reset();
  const b = await call(tech, { op: 'list', base: 'OM', table: 'stock_returns', params: { filterByFormula: 'RECORD_ID()="recRETURN00000001"' } });
  t('a role without costing lists returns', b.code, 200);
  t('  without the credit', 'Credit Value' in b.body.records[0].fields, false);
  t('  but with the rest', b.body.records[0].fields['Return Number'], 'SR-0001');
  reset();
  const g = await call(tech, { op: 'get', base: 'OM', table: 'stock_returns', recordId: 'recRETURN00000001', params: { returnFieldsByFieldId: true } });
  t('read by field id, the credit is still stripped', g.code === 200 && 'Credit Value' in g.body.records[0].fields, false);
  reset();
  const peek = await call(tech, { op: 'list', base: 'OM', table: 'stock_returns', params: { filterByFormula: '{Credit Value} > 1000' } });
  t('a role without costing cannot filter on the credit', [peek.code, peek.body.reason], [403, 'filter_on_denied_field']);
  reset();
  const nobody = await call(signedIn('x@tagexenergy.co.za', { costing: ALL }), { op: 'list', base: 'OM', table: 'stock_returns' });
  t('a role without stock_returns cannot read them at all', nobody.body.reason, 'module_denied');

  console.log('\nthe panel');
  const LINK = 'fldBuIF7PduXj9jh9';
  t('O&M job cards link through Stock Returns', SRP.linkField('OM'), LINK);
  t('RES has no link, so nothing is drawn', [SRP.linkField('RES'), SRP.idsOf({ [LINK]: ['recRETURN00000001'] }, 'RES')], [null, null]);
  t('a link the role cannot read (absent) draws nothing', SRP.idsOf({}, 'OM'), null);
  t('ids are taken from strings and {id} objects', SRP.idsOf({ [LINK]: ['recA1', { id: 'recB2' }, 'bad"),TRUE()'] }, 'OM'), ['recA1', 'recB2']);
  t('the credit is asked for only with costing view', [SRP.fieldsFor(true).includes('Credit Value'), SRP.fieldsFor(false).includes('Credit Value')], [true, false]);
  const many = Array.from({ length: 120 }, (_, i) => 'recX' + String(i).padStart(13, '0'));
  t('ids are fetched in chunks of 50', SRP.filters(many).length, 3);
  t('as RECORD_ID() lookups', SRP.filters(['recA1', 'recB2'])[0], 'OR(RECORD_ID()="recA1",RECORD_ID()="recB2")');

  const recs = [
    RET('recR1', { 'Return Number': 'SR-0001', Status: { name: 'Received' }, 'Return Date': '2026-11-20', 'Credit Value': 100 }),
    RET('recR2', { 'Return Number': 'SR-0002', Status: 'Closed', 'Return Date': '2026-11-22', 'Credit Value': 50.25 }),
    RET('recR3', { 'Return Number': 'SR-0003', Status: 'Submitted', 'Return Date': '2026-11-23', 'Credit Value': 999 }),
    RET('recR4', { 'Return Number': 'SR-0004', Status: 'Cancelled', 'Return Date': '2026-11-21', 'Credit Value': 777 }),
  ];
  const rows = SRP.rows(recs, true);
  t('rows newest first', rows.map((r) => r.number), ['SR-0003', 'SR-0002', 'SR-0004', 'SR-0001']);
  t('a select read as an object or a name', rows.map((r) => r.status), ['Submitted', 'Closed', 'Cancelled', 'Received']);
  t('credit counts received and closed only', SRP.creditTotal(rows), 150.25);
  t('without costing view, no row carries a credit even if the record does', SRP.rows(recs, false).every((r) => r.credit === null), true);

  const withCost = SRP.panelHtml({ rows, error: '' }, { esc, canCost: true });
  t('with costing: a Credit column and the total', [withCost.includes('>Credit<'), withCost.includes('R 150,25') || withCost.includes('R 150.25')], [true, true]);
  t('number, status, date and delivery note are drawn', ['SR-0003', 'Submitted', '23 Nov 2026', 'DN-0042'].every((s) => withCost.includes(s)), true);
  const noCost = SRP.panelHtml({ rows: SRP.rows(recs, false), error: '' }, { esc, canCost: false });
  t('without costing: no Credit column, no total, no amount', [noCost.includes('Credit'), /R\s?\d/.test(noCost)], [false, false]);
  t('nothing to draw draws nothing', SRP.panelHtml(null, { esc, canCost: true }), '');
  t('no returns says so', SRP.panelHtml({ rows: [], error: '' }, { esc, canCost: true }).includes('None.'), true);
  t('a failed read says so, escaped', SRP.panelHtml({ rows: [], error: '<b>x</b>' }, { esc, canCost: true }).includes('&lt;b&gt;x&lt;/b&gt;'), true);
  const evil = SRP.panelHtml({ rows: SRP.rows([RET('recE', { 'Return Number': '<img src=x onerror=1>' })], false), error: '' }, { esc, canCost: false });
  t('record text is escaped', evil.includes('<img'), false);

  console.log('\nthe wiring');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  t('index.html loads the panel before mod-scheduler.js',
    html.indexOf('/js/stock-returns-panel.js') > 0 && html.indexOf('/js/stock-returns-panel.js') < html.indexOf('/js/mod-scheduler.js'), true);
  const sched = fs.readFileSync(path.join(ROOT, 'public', 'js', 'mod-scheduler.js'), 'utf8');
  const uses = sched.match(/[A-Za-z.]+\([^()]*'stock_returns'/g) || [];
  t('mod-scheduler only reads stock_returns (TX.can view, TX.list)', uses.map((u) => u.split('(')[0]).sort(), ['TX.can', 'TX.list']);
  t('the job card screen opens with its returns loaded', /await omLoadReturns\(rec\);\s*omBuildDetail\(rec,actLog\)/.test(sched), true);
  const adminJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'mod-admin.js'), 'utf8');
  const dbom = /app: 'Delivery & BOM', keys: \[([\s\S]*?)\]/.exec(adminJs);
  t('Admin lists stock_returns and stock_return_lines under Delivery & BOM',
    !!dbom && dbom[1].includes("'stock_returns'") && dbom[1].includes("'stock_return_lines'"), true);

  console.log('');
  if (failed) { console.log(`\x1b[31m\x1b[1m  ${failed} FAILED\x1b[0m, ${passed} passed\n`); process.exit(1); }
  console.log(`\x1b[32m\x1b[1m  ALL ${passed} ASSERTIONS PASSED\x1b[0m`);
})().catch((e) => { console.error(e); process.exit(1); });
