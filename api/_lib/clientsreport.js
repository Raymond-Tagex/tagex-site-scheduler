// TAGEX — Clients tab: the maintenance subscriber contracts (SxE Portfolio Maintenance Cost Log, 26 Oct 2026)
// and a report over them that the user shapes by category and by section.
//
// Reached as POST /api/at { op: 'clients_report', action, … } -- inside the proxy, like project_costing,
// because the deployment is at the plan's function limit. `clients_report` is a UI key (VIRTUAL_MODULES in
// tables.js), switched OFF on every role; a person sees the tab only when it is switched on for them.
//
// The subscriber rows live in the 'subscribers' table of the O&M base (tables.js), beside the O&M clients they link to. Nothing else in the
// app reads that table, so it has no role permission of its own: this module reads it with the server's
// access, and only after clients_report:view (or :export) is checked here.
//
// MONEY IS FOR ONE PERMISSION (Raymond, 28 Oct 2026: "Chane would be the only person to see the costing/values").
// The O&M received figures are left out of every answer -- report and Excel alike -- unless the account holds
// `clients_money` view. That key is a UI key (VIRTUAL_MODULES in tables.js), off on every role, so it is switched
// on for one person's Permission Overrides and no one else's. The server decides; the screen only hides what it
// was not sent.
//
// EVERY FIGURE IS THE SERVER'S. The browser sends which categories and which sections were ticked; this
// module filters the rows and adds them up, and returns the report. The browser only draws it and writes
// the Excel from it, so the screen and the file cannot tell two stories.

'use strict';

const T = require('./tables.js');
const P = require('./permissions.js');
const at = require('./airtable.js');
const H = require('./http.js');
const A = require('./audit.js');

const MODULE = 'clients_report';
const CATEGORIES = Object.freeze(['PPA', 'Alpine', 'TxE', 'PrefCap']);
const SECTIONS = Object.freeze(['summary', 'subscribers', 'equipment', 'clients']);
const SUB_FIELDS = ['Contract', 'Client', 'Category', 'First Invoice Date', 'System Description', 'O&M Received',
  'Client Record', 'Source Row', 'PV Panel', 'PV Panel Qty', 'Inverter', 'Inverter Qty', 'Battery 1', 'Battery 1 Qty',
  'Battery 2', 'Battery 2 Qty', 'PV-Therm', 'PV-Therm Qty'];
// Each equipment field, the qty beside it, and the type it counts as. Both batteries are one type.
const EQUIPMENT = Object.freeze([
  { field: 'PV Panel', qty: 'PV Panel Qty', type: 'PV panel' },
  { field: 'Inverter', qty: 'Inverter Qty', type: 'Inverter' },
  { field: 'Battery 1', qty: 'Battery 1 Qty', type: 'Battery' },
  { field: 'Battery 2', qty: 'Battery 2 Qty', type: 'Battery' },
  { field: 'PV-Therm', qty: 'PV-Therm Qty', type: 'PV-Therm' },
]);
const TYPES = Object.freeze(['PV panel', 'Inverter', 'Battery', 'PV-Therm']);

const MONEY_MODULE = 'clients_money';

const ACTIONS = Object.freeze({
  report: { verb: 'view', audit: 'View' },
  report_export: { verb: 'export', audit: 'Export' },
  clients_search: { verb: 'view', audit: 'View' },
  suggest_link: { verb: 'view', audit: 'View' },
  link_client: { verb: 'edit', audit: 'Update' },
});
const CLIENT_NAME = 'Client Name';
const LINK = 'Client Record';
const RECID = /^rec[A-Za-z0-9]{14}$/;

const r2 = (n) => Math.round(n * 100) / 100;
const txt = (v) => (v == null ? '' : String(v).trim());
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
const sel = (v) => (v && typeof v === 'object' ? v.name || '' : txt(v));
const ids = (v) => (Array.isArray(v) ? v : []).map((x) => (x && typeof x === 'object' ? x.id : x)).filter(Boolean);


// ── the arithmetic, kept apart from Airtable so it can be proved on its own ──────────────────

/**
 * @param {object[]} rows     subscriber rows as { contract, client, category, firstInvoice, description,
 *                            omReceived, clientIds, regClient: { id, name } | null, equipment: [{ type, item, qty }] }
 * @param {object}   names    client record id -> client name
 * @param {{categories?: string[], sections?: string[], money?: boolean}} want
 *                            what the user ticked (nothing ticked = everything); money: whether the
 *                            O&M figures may be in the answer
 */
function buildReport(rows, names, want) {
  const cats = Array.isArray(want.categories) && want.categories.length
    ? CATEGORIES.filter((c) => want.categories.includes(c)) : CATEGORIES.slice();
  const secs = Array.isArray(want.sections) && want.sections.length
    ? SECTIONS.filter((s) => want.sections.includes(s)) : SECTIONS.slice();
  const money = want.money === true;
  const picked = rows.filter((r) => cats.includes(r.category));
  const out = { categories: cats, sections: secs, contracts: picked.length, money, generated: new Date().toISOString().slice(0, 10) };

  if (secs.includes('summary')) {
    const by = cats.map((c) => {
      const rs = picked.filter((r) => r.category === c);
      const row = { category: c, contracts: rs.length };
      if (money) row.omReceived = r2(rs.reduce((a, r) => a + r.omReceived, 0));
      return row;
    });
    out.summary = { byCategory: by };
    if (money) out.summary.omReceived = r2(by.reduce((a, b) => a + b.omReceived, 0));
  }
  if (secs.includes('subscribers')) {
    out.subscribers = picked.map((r) => {
      const row = {
        id: r.id, category: r.category, contract: r.contract, client: r.client, firstInvoice: r.firstInvoice,
        description: r.description,
        linkedClient: r.clientIds.length ? r.clientIds.map((id) => names[id] || '').filter(Boolean).join(', ')
          : (r.regClient ? r.regClient.name : ''),
        // An O&M client record where the contract is linked to one; otherwise the client register's client for
        // that contract number -- the register is what tickets and job cards read, and most subscribers have no
        // O&M client record until they first need service.
        clientBase: r.clientIds.length ? 'O&M' : (r.regClient ? 'Register' : 'Not linked'),
      };
      if (money) row.omReceived = r.omReceived;
      return row;
    });
  }
  if (secs.includes('equipment')) {
    // By type and item across the ticked contracts: how many systems carry it and how many units.
    const byItem = new Map();
    // Per funder (the contract's category), the same count.
    const byFunder = new Map();
    for (const r of picked) {
      for (const e of r.equipment) {
        const k = e.type + '\u0000' + e.item;
        const g = byItem.get(k) || { type: e.type, item: e.item, systems: new Set(), qty: 0 };
        g.systems.add(r.id); g.qty += e.qty || 0;
        byItem.set(k, g);
        const fk = r.category + '\u0000' + k;
        const f = byFunder.get(fk) || { funder: r.category, type: e.type, item: e.item, systems: new Set(), qty: 0 };
        f.systems.add(r.id); f.qty += e.qty || 0;
        byFunder.set(fk, f);
      }
    }
    const flat = (g) => ({ ...g, systems: g.systems.size });
    out.equipmentByType = [...byItem.values()].map(flat)
      .sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || a.item.localeCompare(b.item));
    out.equipmentByFunder = [...byFunder.values()].map(flat)
      .sort((a, b) => cats.indexOf(a.funder) - cats.indexOf(b.funder) || TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || a.item.localeCompare(b.item));
    out.equipmentContracts = picked.filter((r) => r.equipment.length).length;
  }
  if (secs.includes('clients')) {
    // One line per client, with how many of the ticked contracts sit under it: its O&M client record where the
    // contract is linked to one, otherwise its client in the register.
    // Each line names its contract numbers and their funders (Raymond, 30 Oct 2026: "Anita Naidoo — SUB-168 — PPA").
    const seen = new Map();
    const add = (k, name, r) => {
      const g = seen.get(k) || { name, contracts: 0, numbers: new Set(), funders: new Set() };
      g.contracts += 1;
      if (r.contract) g.numbers.add(r.contract);
      if (r.category) g.funders.add(r.category);
      seen.set(k, g);
    };
    for (const r of picked) {
      if (r.clientIds.length) for (const id of r.clientIds) add(id, names[id] || id, r);
      else if (r.regClient) add('reg:' + r.regClient.id, r.regClient.name, r);
    }
    out.clients = [...seen.values()]
      .map((g) => ({ name: g.name, contractNumbers: [...g.numbers].sort().join(', '),
        funders: cats.filter((c) => g.funders.has(c)).join(', '), contracts: g.contracts }))
      .sort((a, b) => a.name.localeCompare(b.name));
    out.unlinked = picked.filter((r) => !r.clientIds.length && !r.regClient).length;
  }
  return out;
}

// ── reading ─────────────────────────────────────────────────────────────────────────────────

// "SUB -156" and "sub-156" are one contract number.
const contractKey = (n) => txt(n).toUpperCase().replace(/\s+/g, '');

/**
 * Contract number -> its client in the client register (TAGEX Clients base), as { id, name }. Only a number the
 * register holds once, with one client, is answered: anything else is left for a person to link. An unreadable
 * register gives an empty map, so the report still draws from the O&M links alone.
 */
async function readRegisterClients() {
  const R = T.CLIENT_REGISTER;
  const baseId = T.BASES[R.base];
  if (!baseId) return new Map();
  try {
    const [contracts, clients] = await Promise.all([
      at.list(baseId, R.contracts, { fields: ['Contract Number', 'Client'], pageSize: 100 }, 5000),
      at.list(baseId, R.clients, { fields: ['Client Name'], pageSize: 100 }, 5000),
    ]);
    const name = new Map(clients.map((c) => [c.id, txt(c.fields['Client Name'])]));
    const seen = new Map();
    for (const c of contracts) {
      const k = contractKey(c.fields['Contract Number']);
      if (!k) continue;
      const cl = ids(c.fields.Client);
      seen.set(k, seen.has(k) || cl.length !== 1 || !name.get(cl[0]) ? null : { id: cl[0], name: name.get(cl[0]) });
    }
    return seen;
  } catch (e) {
    console.error('[clients_report] client register unavailable:', e && e.message);
    return new Map();
  }
}

async function readRows() {
  const sub = T.resolve('OM', 'subscribers');
  if (!sub.ok) throw Object.assign(new Error('subscribers unavailable'), { status: 500 });
  const [recs, register] = await Promise.all([
    at.list(sub.baseId, sub.tableId, { fields: SUB_FIELDS, pageSize: 100 }, 5000),
    readRegisterClients(),
  ]);
  const rows = recs.map((rec) => {
    const f = rec.fields;
    const equipment = EQUIPMENT.map((e) => ({ type: e.type, item: txt(f[e.field]), qty: f[e.qty] == null ? null : num(f[e.qty]) }))
      .filter((e) => e.item);
    return {
      id: rec.id,
      contract: txt(f.Contract),
      client: txt(f.Client),
      category: sel(f.Category),
      firstInvoice: txt(f['First Invoice Date']) || null,
      description: txt(f['System Description']),
      omReceived: num(f['O&M Received']),
      clientIds: ids(f['Client Record']),
      regClient: register.get(contractKey(f.Contract)) || null,
      equipment,
    };
  });
  rows.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.contract.localeCompare(b.contract));
  return rows;
}

async function readClientNames(rows) {
  const want = new Set(rows.flatMap((r) => r.clientIds));
  if (!want.size) return {};
  const cl = T.resolve('OM', 'clients');
  if (!cl.ok) return {};
  const recs = await at.list(cl.baseId, cl.tableId, { fields: ['Client Name'], pageSize: 100 }, 5000);
  const names = {};
  for (const rec of recs) if (want.has(rec.id)) names[rec.id] = txt(rec.fields['Client Name']);
  return names;
}

// ── the request ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} a  { body, auth, ctx, res }  -- auth is a session that has already passed the proxy's gates.
 */
// The client records of the O&M base. The subscriber table lives in O&M too, so its Client Record link points
// at these records directly; nothing is copied between bases.
function clientTable() {
  const cl = T.resolve('OM', 'clients');
  if (!cl.ok) throw Object.assign(new Error('clients unavailable'), { status: 500 });
  return cl;
}

// Search the O&M client records by name, as the user types. Only names and ids leave the server, and only to a
// person who may read O&M clients.
async function search({ body, auth, audit, res }) {
  if (!P.can(auth.perms, 'clients', 'view').ok) return H.fail(res, 403, 'module_denied', 'You may not read clients.');
  const q = txt(body.q).slice(0, 60);
  if (q.length < 2) return H.ok(res, { hits: [] });
  const cl = clientTable();
  const recs = await at.list(cl.baseId, cl.tableId, {
    filterByFormula: `FIND(${P.lit(q.toLowerCase())}, LOWER({${CLIENT_NAME}} & ""))`,
    fields: [CLIENT_NAME], pageSize: 30,
  }, 30);
  A.audit({ ...audit, action: 'View', result: 'Allowed', newValue: 'client search for a subscriber link' });
  return H.ok(res, { hits: recs.map((r) => ({ id: r.id, name: txt(r.fields[CLIENT_NAME]) })).filter((h) => h.name) });
}

// Link one subscriber to one O&M client record, or to a new O&M client record made from a name. Only the link
// field is written. A name that already exists (ignoring case) is linked to, not made again.
async function link({ body, auth, audit, res }) {
  const subId = String(body.subscriber || '');
  if (!RECID.test(subId)) return H.fail(res, 400, 'bad_request', 'subscriber must be a record id.');
  const sub = T.resolve('OM', 'subscribers');
  if (!sub.ok) return H.fail(res, 500, 'upstream', 'The subscribers table is unavailable.');
  const cl = clientTable();

  let before;
  try {
    const cur = await at.get(sub.baseId, sub.tableId, subId, {});
    before = ids(cur.fields[LINK]);
  } catch (e) {
    return H.fail(res, 404, 'not_found', 'No such subscriber contract.');
  }

  let clientId = null;
  let created = false;
  if (body.client) {
    clientId = String(body.client);
    if (!RECID.test(clientId)) return H.fail(res, 400, 'bad_request', 'client must be a record id.');
    try { await at.get(cl.baseId, cl.tableId, clientId, {}); } catch (e) {
      return H.fail(res, 404, 'not_found', 'No such client record.');
    }
  } else if (body.create) {
    const name = txt(body.create).replace(/\s+/g, ' ').slice(0, 120);
    if (name.length < 2) return H.fail(res, 400, 'bad_request', 'A new client needs a name.');
    const same = await at.list(cl.baseId, cl.tableId, {
      filterByFormula: `LOWER({${CLIENT_NAME}} & "") = ${P.lit(name.toLowerCase())}`,
      fields: [CLIENT_NAME], pageSize: 5,
    }, 5);
    if (same.length) {
      clientId = same[0].id;
    } else {
      const made = await at.create(cl.baseId, cl.tableId, [{ [CLIENT_NAME]: name }]);
      clientId = made[0].id;
      created = true;
      await A.auditNow({ ...audit, baseSymbol: 'OM', table: 'clients', recordId: clientId, action: 'Create', result: 'Allowed',
        newValue: `client "${name}" made from the clients report` });
    }
  }

  const after = clientId ? [clientId] : [];
  await at.update(sub.baseId, sub.tableId, subId, { [LINK]: after });
  await A.auditFieldChanges({ ...audit, baseSymbol: 'OM', table: 'subscribers', recordId: subId,
    before: { [LINK]: before }, after: { [LINK]: after } });
  return H.ok(res, { subscriber: subId, client: clientId, created });
}

// Letters and digits only, lower case: "Yahweha Rapha (Mens Center)" and "yahweha rapha mens center" are equal.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

// How close a client name is to the contract's client name, 0 to 1. A name that is the same once cleaned is 1.
// Otherwise the share of words in common, or one name inside the other when that is long enough to mean something.
function closeness(want, name) {
  const a = norm(want), b = norm(name);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 6 && b.length >= 6 && (a.includes(b) || b.includes(a))) return 0.8;
  const wa = new Set(words(want)), wb = new Set(words(name));
  if (!wa.size || !wb.size) return 0;
  const both = [...wa].filter((w) => wb.has(w)).length;
  return both / new Set([...wa, ...wb]).size;
}

// What a contract's client name matches among the O&M client records. Nothing is written here. An exact match is
// linked straight away by the screen; anything close is offered for the user to choose; with neither, the screen
// makes a new O&M client from the name.
async function suggest({ body, auth, audit, res }) {
  const subId = String(body.subscriber || '');
  if (!RECID.test(subId)) return H.fail(res, 400, 'bad_request', 'subscriber must be a record id.');
  const sub = T.resolve('OM', 'subscribers');
  if (!sub.ok) return H.fail(res, 500, 'upstream', 'The subscribers table is unavailable.');
  let want;
  try {
    want = txt((await at.get(sub.baseId, sub.tableId, subId, {})).fields.Client);
  } catch (e) {
    return H.fail(res, 404, 'not_found', 'No such subscriber contract.');
  }
  const omAllowed = P.can(auth.perms, 'clients', 'view').ok;
  const clients = omAllowed ? await allClients('OM') : [];
  const scored = clients
    .map((c) => ({ base: 'O&M', id: c.id, name: c.name, score: closeness(want, c.name) }))
    .filter((c) => c.score > 0);
  const exact = scored.find((c) => c.score === 1) || null;
  // Anything that shares a word is offered, since a name the user has to choose is never guessed here; the best ten.
  const options = scored.filter((c) => c.score < 1).sort((a, b) => b.score - a.score).slice(0, 10);
  A.audit({ ...audit, action: 'View', result: 'Allowed', newValue: 'client suggestion for a subscriber link' });
  return H.ok(res, { subscriber: subId, name: want, omAllowed, exact, options });
}

// Every client record of a base, by name. A few hundred at most, so it is read whole.
async function allClients(base) {
  const r = T.resolve(base, 'clients');
  if (!r.ok) return [];
  const recs = await at.list(r.baseId, r.tableId, { fields: [CLIENT_NAME], pageSize: 100 }, 5000);
  return recs.map((x) => ({ id: x.id, name: txt(x.fields[CLIENT_NAME]) })).filter((x) => x.name);
}

async function handle({ body, auth, ctx, res }) {
  const action = String(body.action || '');
  const spec = ACTIONS[action];
  const audit = { ...ctx, module: MODULE, table: MODULE, baseSymbol: '' };
  if (!spec) return H.fail(res, 400, 'bad_request', 'Unknown clients report action.');

  // The Palladium agent reaches one table and nothing else.
  const allowed = auth.isAgent === true
    ? { ok: false, status: 403, reason: 'module_denied', detail: 'Not available.' }
    : P.can(auth.perms, MODULE, spec.verb);
  if (!allowed.ok) {
    await A.auditNow({ ...audit, action: spec.audit, result: 'Denied', denialReason: allowed.reason });
    return H.fail(res, allowed.status, allowed.reason, allowed.detail);
  }

  if (action === 'clients_search' || action === 'suggest_link' || action === 'link_client') {
    try {
      if (action === 'clients_search') return await search({ body, auth, audit, res });
      if (action === 'suggest_link') return await suggest({ body, auth, audit, res });
      return await link({ body, auth, audit, res });
    } catch (e) {
      console.error('[clients_report]', action, e && e.message);
      return H.fail(res, 502, 'upstream', 'The client could not be read or saved. Try again.');
    }
  }

  const want = {
    categories: Array.isArray(body.categories) ? body.categories.map(String) : [],
    sections: Array.isArray(body.sections) ? body.sections.map(String) : [],
    money: auth.isAgent !== true && P.can(auth.perms, MONEY_MODULE, 'view').ok,
  };
  if (want.categories.some((c) => !CATEGORIES.includes(c)) || want.sections.some((s) => !SECTIONS.includes(s))) {
    return H.fail(res, 400, 'bad_request', 'Unknown category or section.');
  }

  try {
    const rows = await readRows();
    const names = await readClientNames(rows);
    const out = buildReport(rows, names, want);
    await (action === 'report_export' ? A.auditNow : A.audit)({
      ...audit, action: spec.audit, result: 'Allowed',
      newValue: `clients report: ${out.categories.join(', ')} / ${out.sections.join(', ')}, ${out.contracts} contract(s)`
        + (out.money ? '' : ' (money left out: no clients_money)'),
    });
    // canLink tells the screen whether to offer the link buttons; the server checks it again on every link.
    const canLink = auth.isAgent !== true && P.can(auth.perms, MODULE, 'edit').ok;
    return H.ok(res, { ...out, canLink, categoryList: CATEGORIES, sectionList: SECTIONS, typeList: TYPES });
  } catch (e) {
    console.error('[clients_report]', action, e && e.message);
    return H.fail(res, 502, 'upstream', 'The clients report could not be read. Try again.');
  }
}

module.exports = { MODULE, MONEY_MODULE, CATEGORIES, SECTIONS, TYPES, buildReport, handle };
