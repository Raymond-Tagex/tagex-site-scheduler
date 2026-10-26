#!/usr/bin/env node
// Create the central client register in the TAGEX Clients base (CLI symbol), and the
// "Master Client ID" field that ties each operating base's Clients row to it.
//
// WHY A SEPARATE BASE (Raymond, 26 Oct 2026). Every app used to read clients from its own
// base, and the bases had drifted: 65 in C&I, 159 in O&M, none in RES, and 15 names twice in
// O&M. Airtable cannot link across bases, and job cards, delivery notes, tickets and site
// information all link to their own base's Clients table -- so those tables stay, as mirrors.
// The register is the one place a client's details are kept; scripts/sync-client-register.js
// copies them down. Each mirror row names its master by record id in "Master Client ID".
//
// Contracts are the subscription and C&I agreements from the SxE Portfolio Maintenance Cost
// Log. No money is kept here: the monthly O&M figures stay out (job card money is for four
// people; see CLAUDE.md).
//
// Dry run by default; --apply to create. Never deletes or renames anything that exists.

'use strict';

const fs = require('fs');
const path = require('path');
const T = require('../api/_lib/tables.js');

const APPLY = process.argv.includes('--apply');

function pat() {
  if (process.env.AIRTABLE_PAT) return process.env.AIRTABLE_PAT;
  const f = path.join(__dirname, '..', '.env.local');
  const m = fs.existsSync(f) && /^AIRTABLE_PAT=(.*)$/m.exec(fs.readFileSync(f, 'utf8'));
  if (!m) throw new Error('AIRTABLE_PAT is not set');
  return m[1].trim().replace(/^"|"$/g, '');
}
const H = { Authorization: 'Bearer ' + pat(), 'Content-Type': 'application/json' };

async function call(method, url, body) {
  const r = await fetch('https://api.airtable.com/v0/' + url, { method, headers: H, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(method + ' ' + url + ' -> ' + r.status + ' ' + JSON.stringify(j));
  return j;
}

const STATUS = { choices: [{ name: 'Active' }, { name: 'Inactive' }] };

const CLIENT_FIELDS = [
  { name: 'Client Name', type: 'singleLineText' },
  { name: 'Status', type: 'singleSelect', options: STATUS },
  { name: 'Segment', type: 'singleSelect', options: { choices: [{ name: 'Residential' }, { name: 'C&I' }] } },
  { name: 'Contact Person', type: 'singleLineText' },
  { name: 'Mobile Number', type: 'phoneNumber' },
  { name: 'Email', type: 'email' },
  { name: 'Sites', type: 'multilineText' },
  { name: 'Notes', type: 'multilineText' },
  // Where each operating base keeps its copy. Text, because Airtable cannot link across bases.
  // Comma-separated where a base holds the same client more than once, until a person merges them.
  { name: 'CI Client Record', type: 'singleLineText' },
  { name: 'OM Client Record', type: 'singleLineText' },
  { name: 'RES Client Record', type: 'singleLineText' },
  // Which operating bases need a copy. sync-client-register.js creates one where it is missing,
  // which is how a client added here reaches the apps. Clearing a base never deletes its copy.
  { name: 'Use In', type: 'multipleSelects', options: { choices: [{ name: 'CI' }, { name: 'OM' }, { name: 'RES' }] } },
  { name: 'Source', type: 'multipleSelects', options: { choices: [
    { name: 'SxE Cost Log 26 Oct 2026' }, { name: 'CI Clients' }, { name: 'OM Clients' }, { name: 'RES Clients' }, { name: 'Entered here' }] } },
];

const CONTRACT_FIELDS = (clientsTableId) => [
  { name: 'Contract Number', type: 'singleLineText' },
  { name: 'Client', type: 'multipleRecordLinks', options: { linkedTableId: clientsTableId } },
  { name: 'Status', type: 'singleSelect', options: STATUS },
  { name: 'Portfolio', type: 'singleSelect', options: { choices: [
    { name: 'PPA' }, { name: 'Alpine' }, { name: 'PrefCap' }, { name: 'TxE' }] } },
  { name: 'Contract Kind', type: 'singleSelect', options: { choices: [{ name: 'Subscription' }, { name: 'C&I' }] } },
  { name: 'First Invoice Date', type: 'date', options: { dateFormat: { name: 'iso' } } },
  { name: 'System Description', type: 'multilineText' },
  { name: 'Notes', type: 'multilineText' },
];

(async () => {
  const base = T.BASES.CLI;
  if (!base) throw new Error('BASES.CLI is not in api/_lib/tables.js');
  const meta = await call('GET', 'meta/bases/' + base + '/tables');
  const byName = (n) => meta.tables.find((t) => t.name === n);
  const plan = [];

  let clients = byName('Clients');
  if (!clients) plan.push('create table Clients (' + CLIENT_FIELDS.length + ' fields)');
  else {
    const missing = CLIENT_FIELDS.filter((f) => !clients.fields.some((x) => x.name === f.name));
    missing.forEach((f) => plan.push('add Clients.' + f.name));
  }
  const contracts = byName('Contracts');
  if (!contracts) plan.push('create table Contracts');

  // The mirror field, in every operating base's Clients table. O&M and RES keep the same
  // structure (verify-res-mirror.js), so both get it.
  const mirrors = [];
  for (const sym of ['CI', 'OM', 'RES']) {
    const m = await call('GET', 'meta/bases/' + T.BASES[sym] + '/tables');
    const t = m.tables.find((x) => x.id === T.TABLES.clients[sym === 'RES' ? 'OM' : sym]);
    if (!t) throw new Error(sym + ' has no Clients table');
    if (!t.fields.some((f) => f.name === 'Master Client ID')) {
      plan.push(sym + ' Clients: add Master Client ID');
      mirrors.push({ sym, tableId: t.id });
    }
  }

  console.log((APPLY ? 'APPLYING' : 'DRY RUN') + ' -- ' + (plan.length ? plan.join('\n  ') : 'nothing to do'));
  if (!APPLY || !plan.length) return;

  if (!clients) {
    clients = await call('POST', 'meta/bases/' + base + '/tables', {
      name: 'Clients', description: 'The one register of TAGEX clients. Operating bases keep mirrors.', fields: CLIENT_FIELDS });
    console.log('created Clients', clients.id);
  } else {
    for (const f of CLIENT_FIELDS.filter((f) => !clients.fields.some((x) => x.name === f.name))) {
      await call('POST', 'meta/bases/' + base + '/tables/' + clients.id + '/fields', f);
      console.log('added Clients.' + f.name);
    }
  }
  if (!contracts) {
    const c = await call('POST', 'meta/bases/' + base + '/tables', {
      name: 'Contracts', description: 'Subscription and C&I contracts, one per number. No money.', fields: CONTRACT_FIELDS(clients.id) });
    console.log('created Contracts', c.id);
  }
  for (const m of mirrors) {
    await call('POST', 'meta/bases/' + T.BASES[m.sym] + '/tables/' + m.tableId + '/fields', {
      name: 'Master Client ID', type: 'singleLineText',
      description: 'Record id of this client in the TAGEX Clients register. Set by scripts/sync-client-register.js.' });
    console.log(m.sym + ' Clients: added Master Client ID');
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
