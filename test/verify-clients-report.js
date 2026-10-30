#!/usr/bin/env node
// Clients tab: the report over the subscriber contracts (api/_lib/clientsreport.js).
//
//   node test/verify-clients-report.js
//
// What is proved: a category or section left unticked is left out; nothing ticked means everything; the
// totals are the rows added up; the O&M figures are left out unless the account holds clients_money; a
// contract with no client link is counted as unlinked; the equipment is
// counted by type and by funder (the contract's category), with a system counted once; and the subscribers
// table resolves for the C&I base only, with clients_report as a UI key that no role holds.
//
// Real: clientsreport.js, tables.js. Nothing is stubbed; buildReport is pure.

'use strict';

const path = require('path');
const CR = require(path.join(__dirname, '..', 'api', '_lib', 'clientsreport.js'));
const T = require(path.join(__dirname, '..', 'api', '_lib', 'tables.js'));

let failed = 0;
let passed = 0;
function t(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++; else failed++;
  console.log((ok ? '  \x1b[32mpass\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m  ') + label
    + (ok ? '' : '\n        expected ' + JSON.stringify(expected) + '\n        got      ' + JSON.stringify(actual)));
}

const rows = [
  { id: 'r1', contract: 'SUB-0001', client: 'A', category: 'PPA', firstInvoice: '2025-01-01', description: 'X1', omReceived: 100, clientIds: ['recC1'],
    equipment: [{ type: 'PV panel', item: 'Jinko 450', qty: 10 }, { type: 'Battery', item: 'Pylon', qty: 2 }] },
  { id: 'r2', contract: 'SUB-0002', client: 'B', category: 'PPA', firstInvoice: null, description: 'X3', omReceived: 250.5, clientIds: [],
    equipment: [{ type: 'Inverter', item: 'Solax 7.5', qty: 2 }, { type: 'Battery', item: 'Pylon', qty: 4 }] },
  { id: 'r3', contract: 'SUB-0003', client: 'C', category: 'Alpine', firstInvoice: '2025-02-01', description: 'IES', omReceived: 40, clientIds: ['recC1', 'recC2'],
    equipment: [{ type: 'PV panel', item: 'Jinko 450', qty: 6 }] },
  { id: 'r4', contract: 'SUB-0004', client: 'D', category: 'TxE', firstInvoice: '2025-03-01', description: '', omReceived: 0, clientIds: ['recC2'], equipment: [] },
];
const names = { recC1: 'Client One', recC2: 'Client Two' };

const all = CR.buildReport(rows, names, { money: true });
t('nothing ticked: every category', all.categories, ['PPA', 'Alpine', 'TxE', 'PrefCap']);
t('nothing ticked: every section', all.sections, ['summary', 'subscribers', 'equipment', 'clients']);
t('nothing ticked: all contracts', all.contracts, 4);
t('summary per category, in screen order', all.summary.byCategory.map((b) => [b.category, b.contracts, b.omReceived]),
  [['PPA', 2, 350.5], ['Alpine', 1, 40], ['TxE', 1, 0], ['PrefCap', 0, 0]]);
t('summary overall', all.summary.omReceived, 390.5);

const one = CR.buildReport(rows, names, { categories: ['PPA'], sections: ['summary', 'subscribers'], money: true });
t('only the ticked category is counted', one.contracts, 2);
t('only the ticked category in the list', one.subscribers.map((r) => r.contract), ['SUB-0001', 'SUB-0002']);
t('unticked sections are absent', [one.equipmentByType, one.clients], [undefined, undefined]);
t('linked client name carried', one.subscribers[0].linkedClient, 'Client One');
t('unlinked contract has no client text', one.subscribers[1].linkedClient, '');

const cl = CR.buildReport(rows, names, { sections: ['clients'], money: true });
t('clients: one line per linked client, with contracts counted',
  cl.clients, [{ name: 'Client One', contracts: 2 }, { name: 'Client Two', contracts: 2 }]);
t('clients: contracts with no link counted as unlinked', cl.unlinked, 1);

const eq = CR.buildReport(rows, names, { sections: ['equipment'], money: true });
t('equipment by type: systems counted once, units added, sorted by type',
  eq.equipmentByType, [
    { type: 'PV panel', item: 'Jinko 450', systems: 2, qty: 16 },
    { type: 'Inverter', item: 'Solax 7.5', systems: 1, qty: 2 },
    { type: 'Battery', item: 'Pylon', systems: 2, qty: 6 },
  ]);
t('equipment by funder: the contract category is the funder',
  eq.equipmentByFunder.map((g) => [g.funder, g.type, g.item, g.systems, g.qty]), [
    ['PPA', 'PV panel', 'Jinko 450', 1, 10],
    ['PPA', 'Inverter', 'Solax 7.5', 1, 2],
    ['PPA', 'Battery', 'Pylon', 2, 6],
    ['Alpine', 'PV panel', 'Jinko 450', 1, 6],
  ]);
t('equipment: contracts with equipment', eq.equipmentContracts, 3);

const pref = CR.buildReport(rows, names, { categories: ['PrefCap'], sections: ['summary'], money: true });
t('a category with no rows gives zero, not an error', [pref.contracts, pref.summary.omReceived], [0, 0]);

// ── the money rule: O&M figures only for an MFA account ───────────────────────────────────────
const noMoney = CR.buildReport(rows, names, { money: false });
t('no MFA: summary has no money', noMoney.summary.omReceived, undefined);
t('no MFA: summary rows have no money', noMoney.summary.byCategory[0], { category: 'PPA', contracts: 2 });
t('no MFA: subscriber rows have no money', Object.keys(noMoney.subscribers[0]).includes('omReceived'), false);
t('no MFA: the report says it carries no money', noMoney.money, false);
t('no MFA: the equipment still counts', noMoney.equipmentByType.length, 3);
t('money holder: money included', CR.buildReport(rows, names, { money: true }).subscribers[0].omReceived, 100);
t('money key is clients_money', CR.MONEY_MODULE, 'clients_money');

t('subscribers resolves in O&M', !!T.resolve('OM', 'subscribers').ok, true);
t('subscribers is not in C&I any more', T.resolve('CI', 'subscribers').ok, false);
t('clients_report is a UI key', T.VIRTUAL_MODULES.has('clients_report'), true);
t('clientBase: a linked contract says O&M', CR.buildReport(rows, names, { money: false }).subscribers[0].clientBase, 'O&M');
t('clientBase: an unlinked contract says Not linked', CR.buildReport(rows, names, { money: false }).subscribers[1].clientBase, 'Not linked');
t('subscriber rows carry their record id', CR.buildReport(rows, names, { money: false }).subscribers[0].id, 'r1');

// ── linking a contract to a client: the server's write path, with Airtable stubbed ────────────
const path2 = path.join(__dirname, '..', 'api', '_lib');
const AT = require(path.join(path2, 'airtable.js'));
const AU = require(path.join(path2, 'audit.js'));

const SUB = 'recSUB00000000001';
const CLI = 'recCLI00000000001';
const CLI2 = 'recCLI00000000002';

function res() {
  return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, send(b) { this.body = JSON.parse(b); } };
}
async function run(body, perms) {
  const calls = { update: [], create: [], list: [], audit: [] };
  const saved = { get: AT.get, update: AT.update, create: AT.create, list: AT.list, audit: AU.audit, auditNow: AU.auditNow, fc: AU.auditFieldChanges };
  AT.get = async (b, tb, id) => {
    if (id === SUB) return { id, fields: { 'Client Record': [CLI] } };
    if (id === CLI || id === CLI2) return { id, fields: { 'Client Name': 'Client ' + id } };
    throw new Error('404');
  };
  AT.update = async (b, tb, id, fields) => { calls.update.push({ id, fields }); return { id, fields }; };
  AT.create = async (b, tb, arr) => { calls.create.push(arr); return [{ id: CLI2, fields: arr[0] }]; };
  AT.list = async (b, tb, params) => {
    calls.list.push(params);
    if (params.filterByFormula && /Acme/i.test(params.filterByFormula)) return [{ id: CLI, fields: { 'Client Name': 'Acme Ltd' } }];
    return [];
  };
  AU.audit = () => {}; AU.auditNow = async (e) => { calls.audit.push(e); }; AU.auditFieldChanges = async (e) => { calls.audit.push(e); };
  const r = res();
  try {
    const perm = perms || { clients: { view: true }, clients_report: { view: true, export: true, edit: true } };
    await CR.handle({ body: { op: 'clients_report', ...body }, auth: { perms: perm, user: {}, isAgent: false }, ctx: { module: CR.MODULE }, res: r });
  } finally {
    Object.assign(AT, { get: saved.get, update: saved.update, create: saved.create, list: saved.list });
    AU.audit = saved.audit; AU.auditNow = saved.auditNow; AU.auditFieldChanges = saved.fc;
  }
  return { r, calls };
}

(async () => {
  {
    const { r, calls } = await run({ action: 'link_client', subscriber: SUB, client: CLI2 });
    t('link: an existing client is linked', [r.code, r.body.client], [200, CLI2]);
    t('link: only the link field is written', calls.update, [{ id: SUB, fields: { 'Client Record': [CLI2] } }]);
    t('link: nothing is created', calls.create.length, 0);
  }
  {
    const { r, calls } = await run({ action: 'link_client', subscriber: SUB, client: '' });
    t('unlink: the link is cleared', [r.code, calls.update[0].fields], [200, { 'Client Record': [] }]);
  }
  {
    const { r, calls } = await run({ action: 'link_client', subscriber: SUB, create: 'acme   ltd' });
    t('create: a name already there is linked, not made again', [r.code, r.body.created, calls.create.length], [200, false, 0]);
    t('create: the existing record is the one linked', calls.update[0].fields, { 'Client Record': [CLI] });
  }
  {
    const { r, calls } = await run({ action: 'link_client', subscriber: SUB, create: 'Brand New Client' });
    t('create: a new name makes one client record', [r.code, calls.create.length], [200, 1]);
    t('create: the new record is the one linked', [r.body.created, calls.update[0].fields], [true, { 'Client Record': [CLI2] }]);
  }
  {
    const { r, calls } = await run({ action: 'link_client', subscriber: 'not-an-id', client: CLI });
    t('link: a bad subscriber id is refused', [r.code, calls.update.length], [400, 0]);
  }
  {
    const { r, calls } = await run({ action: 'link_client', subscriber: SUB, client: 'bogus' });
    t('link: a bad client id is refused', [r.code, calls.update.length], [400, 0]);
  }
  {
    const { r, calls } = await run({ action: 'link_client', subscriber: SUB, client: CLI2 }, { clients_report: { view: true, export: true } });
    t('link: without the edit permission it is refused', [r.code, calls.update.length], [403, 0]);
  }
  {
    const { r } = await run({ action: 'clients_search', q: 'acme' });
    t('search: a name match comes back with its id', r.body.hits, [{ id: CLI, name: 'Acme Ltd' }]);
  }
  {
    const { r, calls } = await run({ action: 'clients_search', q: 'a' });
    t('search: under two letters asks nothing of Airtable', [r.body.hits, calls.list.length], [[], 0]);
  }
  {
    const { r } = await run({ action: 'report', sections: ['summary'] });
    t('report: canLink is true with edit', r.body.canLink, true);
    const v = await run({ action: 'report', sections: ['summary'] }, { clients_report: { view: true, export: true } });
    t('report: canLink is false without edit', v.r.body.canLink, false);
  }

  // ── suggesting a link: exact, close, and nothing close ──────────────────────────────────────
  const OM_BASE = T.resolve('OM', 'clients').baseId;
  async function suggestFor(contractClient, perms) {
    const saved = { get: AT.get, list: AT.list };
    AT.get = async () => ({ id: SUB, fields: { Client: contractClient } });
    AT.list = async (b) => {
      if (b === OM_BASE) return [{ id: CLI2, fields: { 'Client Name': 'Acme Ltd' } }, { id: 'recOM0000000000001', fields: { 'Client Name': 'YAHWEH RAPHA HOUSE' } }, { id: 'recOM0000000000002', fields: { 'Client Name': 'Yahweh Rapha Ladies Centre' } }];
      return [];
    };
    const r = res();
    try {
      await CR.handle({ body: { op: 'clients_report', action: 'suggest_link', subscriber: SUB }, auth: { perms: perms || { clients: { view: true }, clients_report: { view: true } }, user: {}, isAgent: false }, ctx: { module: CR.MODULE }, res: r });
    } finally { AT.get = saved.get; AT.list = saved.list; }
    return r.body;
  }
  {
    const b = await suggestFor('acme ltd');
    t('suggest: a cleaned-up exact name is an exact O&M match', [b.exact.base, b.exact.name], ['O&M', 'Acme Ltd']);
  }
  {
    const b = await suggestFor('YAHWEH RAPHA HOUSE');
    t('suggest: an exact O&M name is an exact O&M match', [b.exact.base, b.exact.name], ['O&M', 'YAHWEH RAPHA HOUSE']);
  }
  {
    const b = await suggestFor('Yahweha Rapha (Mens Center)');
    t('suggest: a close name is not exact, and the options are listed', [b.exact, b.options.length > 0], [null, true]);
    t('suggest: the close O&M name is among the options', b.options.some((o) => o.name === 'Yahweh Rapha Ladies Centre' && o.base === 'O&M'), true);
  }
  {
    const b = await suggestFor('Completely Unrelated Firm');
    t('suggest: nothing close gives no exact and no options', [b.exact, b.options], [null, []]);
  }
  {
    const b = await suggestFor('YAHWEH RAPHA HOUSE', { clients: { view: false }, clients_report: { view: true } });
    t('suggest: without O&M clients access, O&M names are not shown', [b.omAllowed, b.exact], [false, null]);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
