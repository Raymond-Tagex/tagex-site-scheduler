#!/usr/bin/env node
// /api/client-register: the client register as the scheduler sees it. Airtable, the session and
// the audit log are stubbed; the permission rules are the real ones.
//
//   node test/verify-client-register.js

'use strict';

const path = require('path');
const api = (f) => path.join(__dirname, '..', 'api', f);

let bad = 0, n = 0;
const t = (name, got, want) => {
  n++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log((ok ? '  \x1b[32mpass\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m  ') + name
    + (ok ? '' : '\n          got  ' + JSON.stringify(got) + '\n          want ' + JSON.stringify(want)));
};

const T = require(api('_lib/tables.js'));
const REG = T.CLIENT_REGISTER.clients;
const CON = T.CLIENT_REGISTER.contracts;
const CLI_TBL = T.resolve('OM', 'clients').tableId;

// ── the stubbed world ──────────────────────────────────────────────────────
let DB, SEQ, WRITES, AUDIT, FAIL_LIST, LISTS;
function reset() {
  SEQ = 0; WRITES = []; AUDIT = []; FAIL_LIST = false; LISTS = [];
  DB = {
    [T.BASES.CLI]: {
      [REG]: [
        { id: 'recREGGROOTVLEI01', fields: { 'Client Name': 'Grootvlei', Status: 'Active', 'Contact Person': 'Oubaas',
          Email: 'oubaas@grootvlei.co.za', 'Mobile Number': '082 555 1234', 'OM Client Record': 'recOMGROOTVLEI001, recOMGROOTVLEI002', 'Use In': ['OM'] } },
        { id: 'recREGBISSET00001', fields: { 'Client Name': 'Sean Bisset', Status: 'Active', Sites: '12 Main Rd, Benoni' } },
        { id: 'recREGDELMAS00001', fields: { 'Client Name': 'Delmas Dairy', Status: 'Active', 'CI Client Record': 'recCIDELMAS000001', 'Use In': ['CI'] } },
      ],
      [CON]: [
        { id: 'recCON0000000001', fields: { 'Contract Number': 'SUB-148', Client: ['recREGBISSET00001'], Status: 'Active',
          Portfolio: 'PPA', 'First Invoice Date': '2025-09-25', 'System Description': '2x 7.5kw G4 Single phase', 'Contract Kind': 'Subscription' } },
        { id: 'recCON0000000002', fields: { 'Contract Number': 'SUB-148-1', Client: ['recREGBISSET00001'], Status: 'Active',
          Portfolio: 'Alpine', 'First Invoice Date': '2025-11-25', 'System Description': 'Additional Slave Battery x2' } },
        { id: 'recCON0000000003', fields: { 'Contract Number': 'SUB-099', Client: ['recREGBISSET00001'], Status: 'Inactive' } },
      ],
    },
    [T.BASES.OM]: {
      [CLI_TBL]: [
        { id: 'recOMGROOTVLEI001', fields: { 'Client Name': 'Grootvlei', 'Master Client ID': 'recREGGROOTVLEI01' } },
        { id: 'recOMGROOTVLEI002', fields: { 'Client Name': 'Grootvlei Farm', 'Master Client ID': 'recREGGROOTVLEI01' } },
        { id: 'recOMWALKIN000001', fields: { 'Client Name': 'Walk-in Client', 'Contact Person': 'Thabo' } },   // not adopted yet
      ],
    },
    [T.BASES.RES]: { [CLI_TBL]: [] },
    [T.BASES.CI]: { [CLI_TBL]: [{ id: 'recCIDELMAS000001', fields: { 'Client Name': 'Delmas Dairy', 'Master Client ID': 'recREGDELMAS00001' } }] },
  };
}
const rows = (b, tb) => ((DB[b] || {})[tb] || (DB[b][tb] = []));
const NAMES = {
  [CLI_TBL]: ['Client Name', 'Contact Person', 'Mobile Number', 'Email', 'Sites', 'Master Client ID'],
  [REG]: ['Client Name', 'Status', 'Contact Person', 'Mobile Number', 'Email', 'Sites', 'Use In', 'Source', 'Segment',
    'CI Client Record', 'OM Client Record', 'RES Client Record'],
};
const stub = (file, exports) => {
  const id = require.resolve(api(file));
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
let ASSIGNED = null;   // client names an assigned-scope user may see, when the filter is scoped
stub('_lib/airtable.js', {
  async list(baseId, tableId, params) {
    LISTS.push({ baseId, tableId, filter: params && params.filterByFormula });
    if (FAIL_LIST) throw new Error('airtable down');
    let out = JSON.parse(JSON.stringify(rows(baseId, tableId)));
    const f = params && params.filterByFormula;
    const m = f && /\{Master Client ID\} = "(rec\w+)"/.exec(f);
    if (m) out = out.filter((r) => r.fields['Master Client ID'] === m[1]);
    else if (f && ASSIGNED) out = out.filter((r) => ASSIGNED.includes(r.fields['Client Name']));
    return out;
  },
  async fieldMaps(baseId, tableId) {
    const idToName = {}, nameToId = {};
    (NAMES[tableId] || []).forEach((nm, i) => { idToName['fld' + tableId.slice(3, 8) + 'x' + String(i).padStart(8, '0')] = nm; });
    for (const [k, v] of Object.entries(idToName)) nameToId[v] = k;
    return { idToName, nameToId };
  },
  async create(baseId, tableId, list) {
    return list.map((fields) => {
      const rec = { id: 'recNEW' + String(++SEQ).padStart(11, '0'), fields: { ...fields } };
      rows(baseId, tableId).push(rec);
      WRITES.push({ op: 'create', baseId, tableId, fields });
      return rec;
    });
  },
  async update(baseId, tableId, recordId, fields) {
    const r = rows(baseId, tableId).find((x) => x.id === recordId);
    Object.assign(r.fields, fields);
    WRITES.push({ op: 'update', baseId, tableId, recordId, fields });
    return r;
  },
});
let WHO = null;
stub('_lib/session.js', {
  async authenticate() { return WHO; }, clientIp: () => '127.0.0.1', userAgent: () => 'verify',
  mustEnrolMfa: () => false,
});
stub('_lib/audit.js', { audit: (e) => AUDIT.push(e), auditNow: async (e) => { AUDIT.push(e); } });
const P = require(api('_lib/permissions.js'));
const handler = require(api('client-register.js'));

const who = (clients, user) => ({ ok: true, email: 'ops@tagexenergy.co.za', userRecordId: 'recUSER0000000000',
  sid: 'sid-' + Math.random(), role: {}, user: { Email: 'ops@tagexenergy.co.za', ...(user || {}) },
  perms: P.effectivePermissions(JSON.stringify({ clients }), null) });
const OPS = who({ view: true, create: true, edit: true, delete: false, export: true });
const TECH = who({ view: true, create: false, edit: false, delete: false, export: false });
const STORES = who({ view: true, create: false, edit: false, delete: false, export: false,
  fields: { deny_read: ['Contact Person', 'Email', 'Mobile Number'] } });
const SCOPED = who({ view: true, create: true, edit: true, delete: false, export: false },
  { 'Record Scope': 'Assigned Only', 'Assigned Clients': JSON.stringify(['Grootvlei']) });
const NONE = { ok: true, email: 'x@y', userRecordId: 'recUSER0000000001', sid: 's', role: {}, user: { Email: 'x@y' },
  perms: P.effectivePermissions(JSON.stringify({}), null) };

const call = async (as, body) => {
  WHO = as;
  const res = { code: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; },
    send(b) { this.body = JSON.parse(b); return this; }, end() { return this; } };
  await handler({ method: 'POST', body, headers: {}, url: '/api/client-register' }, res);
  return res;
};
const byName = (r, nm) => (r.body.clients || []).find((c) => c.name === nm);

(async () => {
  console.log('\n\x1b[1mLIST\x1b[0m');
  reset();
  let r = await call(OPS, { op: 'list', base: 'OM' });
  t('the register is listed', r.code, 200);
  t('every register client, plus the base row not yet adopted', r.body.clients.map((c) => c.name).sort(),
    ['Delmas Dairy', 'Grootvlei', 'Sean Bisset', 'Walk-in Client']);
  t('a client carries every copy in this base', byName(r, 'Grootvlei').mirrors, ['recOMGROOTVLEI001', 'recOMGROOTVLEI002']);
  t('a client with no copy here has none', byName(r, 'Sean Bisset').mirrors, []);
  t('a copy in another base is not one here', byName(r, 'Delmas Dairy').mirrors, []);
  t('its live contracts come with it, not the inactive one', byName(r, 'Sean Bisset').contracts, ['SUB-148', 'SUB-148-1']);
  // What the ticket and job card panel shows: funder (Portfolio), warranty start, system.
  t('each with its funder, 1st invoice date and system', byName(r, 'Sean Bisset').contractDetails, [
    { number: 'SUB-148', funder: 'PPA', firstInvoice: '2025-09-25', system: '2x 7.5kw G4 Single phase', kind: 'Subscription' },
    { number: 'SUB-148-1', funder: 'Alpine', firstInvoice: '2025-11-25', system: 'Additional Slave Battery x2', kind: '' },
  ]);
  t('the unadopted row is marked and kept', [byName(r, 'Walk-in Client').unregistered, byName(r, 'Walk-in Client').mirrors], [true, ['recOMWALKIN000001']]);
  t('the details are the register’s', [byName(r, 'Grootvlei').contact, byName(r, 'Grootvlei').email], ['Oubaas', 'oubaas@grootvlei.co.za']);
  t('the view is audited as allowed', AUDIT.some((a) => a.action === 'View' && a.result === 'Allowed' && a.module === 'clients'), true);
  t('and nothing was written', WRITES.length, 0);

  reset();
  r = await call(OPS, { op: 'list' });
  t('no base named reads O&M', LISTS.some((l) => l.baseId === T.BASES.OM) && !LISTS.some((l) => l.baseId === T.BASES.RES), true);
  reset();
  r = await call(OPS, { op: 'list', base: 'RES' });
  t('RES reads RES’s copies', [r.code, LISTS.some((l) => l.baseId === T.BASES.RES), byName(r, 'Grootvlei').mirrors], [200, true, []]);

  reset();
  r = await call(STORES, { op: 'list', base: 'OM' });
  const g = byName(r, 'Grootvlei');
  t('a field the role may not read is not returned', [g.contact, g.email, g.mobile], ['', '', '']);
  t('from the unadopted row either', byName(r, 'Walk-in Client').contact, '');
  t('but the name still is', g.name, 'Grootvlei');

  reset(); ASSIGNED = ['Grootvlei'];
  r = await call(SCOPED, { op: 'list', base: 'OM' });
  ASSIGNED = null;
  t('an assigned-only role sees only the clients its copies show it', r.body.clients.map((c) => c.name), ['Grootvlei']);
  t('because the base was read through the scope filter', LISTS.some((l) => l.baseId === T.BASES.OM && l.filter), true);

  reset();
  r = await call(NONE, { op: 'list', base: 'OM' });
  t('a role without clients:view is refused', r.code, 403);
  t('and the refusal is audited', AUDIT.some((a) => a.result === 'Denied'), true);

  console.log('\n\x1b[1mENSURE: THIS BASE’S COPY\x1b[0m');
  reset();
  r = await call(TECH, { op: 'ensure', base: 'OM', clientId: 'recREGGROOTVLEI01' });
  t('a client already here is returned, even to a role that cannot create', [r.code, r.body.mirrorId, r.body.created], [200, 'recOMGROOTVLEI001', false]);
  t('without writing anything', WRITES.length, 0);

  reset();
  r = await call(OPS, { op: 'ensure', base: 'OM', clientId: 'recREGBISSET00001' });
  t('a client with no copy here gets one', [r.code, r.body.created], [200, true]);
  const made = WRITES.find((w) => w.op === 'create' && w.baseId === T.BASES.OM);
  t('in this base’s Clients', made && made.tableId, CLI_TBL);
  t('stamped with its Master Client ID', made && made.fields['Master Client ID'], 'recREGBISSET00001');
  t('carrying the register’s name and details', [made.fields['Client Name'], made.fields.Sites], ['Sean Bisset', '12 Main Rd, Benoni']);
  const back = WRITES.find((w) => w.op === 'update' && w.baseId === T.BASES.CLI);
  t('the register records where the copy is', back && back.fields['OM Client Record'], r.body.mirrorId);
  t('and that O&M uses the client', back && back.fields['Use In'], ['OM']);
  t('the copy is audited as a create', AUDIT.some((a) => a.action === 'Create' && a.result === 'Allowed' && a.recordId === r.body.mirrorId), true);
  r = await call(OPS, { op: 'ensure', base: 'OM', clientId: 'recREGBISSET00001' });
  t('asking again returns the same copy, not a second one', [r.body.mirrorId, r.body.created, WRITES.filter((w) => w.op === 'create').length], ['recNEW00000000001', false, 1]);

  reset();
  r = await call(OPS, { op: 'ensure', base: 'OM', clientId: 'recREGDELMAS00001' });
  t('a second base’s copy is added beside the first in the register', [r.code,
    DB[T.BASES.CLI][REG].find((x) => x.id === 'recREGDELMAS00001').fields['Use In']], [200, ['CI', 'OM']]);

  reset();
  r = await call(TECH, { op: 'ensure', base: 'OM', clientId: 'recREGBISSET00001' });
  t('a role without clients:create cannot make a copy', r.code, 403);
  t('and nothing is written', WRITES.length, 0);

  reset(); ASSIGNED = ['Walk-in Client'];
  r = await call(SCOPED, { op: 'ensure', base: 'OM', clientId: 'recREGGROOTVLEI01' });
  ASSIGNED = null;
  t('a copy the role cannot see is not duplicated', [r.code, r.body.reason, WRITES.length], [403, 'scope_excluded', 0]);

  reset();
  r = await call(OPS, { op: 'ensure', base: 'OM', clientId: 'recNOTINREGISTER1' });
  t('a client not in the register is not found', [r.code, WRITES.length], [404, 0]);

  console.log('\n\x1b[1mCREATE: A NEW CLIENT\x1b[0m');
  reset();
  r = await call(OPS, { op: 'create', base: 'OM', name: 'Zoete Liefde Venue', contact: 'Anna', email: 'anna@zoete.co.za', sites: 'Bapsfontein' });
  t('a new client is made', r.code, 200);
  const regMade = WRITES.find((w) => w.op === 'create' && w.baseId === T.BASES.CLI);
  t('in the register first', regMade && regMade.fields['Client Name'], 'Zoete Liefde Venue');
  t('marked as entered here, active, used in O&M', [regMade.fields.Source, regMade.fields.Status, regMade.fields['Use In']], [['Entered here'], 'Active', ['OM']]);
  const omMade = WRITES.find((w) => w.op === 'create' && w.baseId === T.BASES.OM);
  t('then its copy here, stamped with it', [omMade.fields['Master Client ID'], omMade.fields['Contact Person']], [r.body.clientId, 'Anna']);
  t('and both ids are returned', [r.body.clientId, r.body.mirrorId], [regMade && 'recNEW00000000001', 'recNEW00000000002']);

  reset();
  r = await call(OPS, { op: 'create', base: 'OM', name: '  GROOTVLEI ' });
  t('a name already in the register is refused, with the client named', [r.code, r.body.reason, r.body.clientId], [409, 'client_exists', 'recREGGROOTVLEI01']);
  t('and nothing is written', WRITES.length, 0);

  reset();
  r = await call(TECH, { op: 'create', base: 'OM', name: 'New Person' });
  t('a role without clients:create cannot add a client', [r.code, WRITES.length], [403, 0]);
  reset();
  r = await call(SCOPED, { op: 'create', base: 'OM', name: 'New Person' });
  t('nor can one limited to assigned clients', [r.code, r.body.reason, WRITES.length], [403, 'scope_excluded', 0]);
  reset();
  r = await call(OPS, { op: 'create', base: 'OM', name: '' });
  t('a client needs a name', [r.code, WRITES.length], [400, 0]);
  r = await call(OPS, { op: 'create', base: 'OM', name: 'Someone', email: 'not an email' });
  t('and a real-looking email', [r.code, WRITES.length], [400, 0]);

  console.log('\n\x1b[1mTHE FRONT DOOR\x1b[0m');
  reset();
  r = await call(OPS, { op: 'list', base: T.BASES.OM });
  t('a raw base id is refused', [r.code, r.body.reason], [400, 'raw_id_rejected']);
  r = await call(OPS, { op: 'list', base: 'IAM' });
  t('a base that keeps no clients is refused', [r.code, r.body.reason], [400, 'wrong_base']);
  r = await call(OPS, { op: 'list', base: 'CLI' });
  t('and so is the register’s own base: it is not an operations base', r.code, 400);
  r = await call(OPS, { op: 'delete', base: 'OM', clientId: 'recREGGROOTVLEI01' });
  t('there is no delete', [r.code, r.body.reason], [400, 'unknown_op']);
  r = await call({ ...OPS, user: { ...OPS.user, 'Must Change Password': true } }, { op: 'list', base: 'OM' });
  t('a password that must be changed blocks it', [r.code, r.body.reason], [403, 'password_change_required']);
  r = await call({ ok: false, status: 401, reason: 'no_session', detail: 'x' }, { op: 'list', base: 'OM' });
  t('no session, no register', r.code, 401);
  t('the general proxy cannot reach the register: it is not a module', [
    Object.values(T.TABLES).some((cfg) => JSON.stringify(cfg).includes(T.CLIENT_REGISTER.clients)),
    T.resolve('CLI', 'clients').ok], [false, false]);
  FAIL_LIST = true;
  r = await call(OPS, { op: 'list', base: 'OM' });
  t('an Airtable failure says the register could not be read', [r.code, r.body.reason], [502, 'register_unavailable']);

  console.log('\n' + (bad ? '\x1b[31m\x1b[1m  ' + bad + ' FAILED\x1b[0m, ' : '  ') + (n - bad) + ' passed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
