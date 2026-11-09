#!/usr/bin/env node
// The O&M cover sheet (api/_lib/coversheet.js): what goes on it, what never does, and that a role
// sees on it only what it could see anyway. Airtable is stubbed; the permission rules are real.
//
//   node test/verify-cover-sheet.js

'use strict';

const path = require('path');
const fs = require('fs');
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
const R = T.CLIENT_REGISTER;
const RB = T.BASES[R.base];

// ── stubbed Airtable: the register, read straight; base tables come through `read` ──
const REG = [
  { id: 'recREGBISSET00001', fields: { 'Client Name': 'Sean Bisset', 'Contact Person': '082 111 2222',
    'Mobile Number': '082 111 2222', Phone: '011 555 0000', Email: 'sean@bisset.co.za', Sites: '12 Main Rd, Benoni',
    'Postal / Billing Address': 'PO Box 7', 'Palladium Code': 'TESUB-0148' } },
];
const CON = [
  { id: 'recCON1', fields: { 'Contract Number': 'SUB-148', Client: ['recREGBISSET00001'], Status: 'Active', Portfolio: 'PPA',
    'First Invoice Date': '2025-09-25', 'System Description': '2x 7.5kw G4 Single phase' } },
  { id: 'recCON2', fields: { 'Contract Number': 'SUB-999', Client: ['recSOMEONEELSE001'], Status: 'Active', Portfolio: 'Alpine',
    'First Invoice Date': '2020-01-01', 'System Description': 'Someone else' } },
];
// SolaX plants: one on Sean's contract, one on another of his contracts.
const PLANTS = [
  { id: 'recPL1', fields: { 'Plant Name': 'Bisset House', Client: ['recREGBISSET00001'], 'User Name': 'solax.sean@gmail.com',
    Location: '12 Main Rd, Benoni', 'Contract Number': 'SUB-148' } },
  { id: 'recPL2', fields: { 'Plant Name': 'Bisset Office', Client: ['recREGBISSET00001'], 'Contract Number': 'SUB-150' } },
];
const LISTED = [];
const stub = (file, exports) => { const id = require.resolve(api(file)); require.cache[id] = { id, filename: id, loaded: true, exports }; };
stub('_lib/airtable.js', {
  async list(base, table) { LISTED.push(table); return JSON.parse(JSON.stringify(base === RB && table === R.clients ? REG
    : base === RB && table === R.contracts ? CON : base === RB && table === R.plants ? PLANTS : [])); },
  async fieldMaps() { return { idToName: {}, nameToId: {} }; },
});
const P = require(api('_lib/permissions.js'));
const CS = require(api('_lib/coversheet.js'));

const BASE_ROWS = {
  clients: [{ id: 'recOMBISSET000001', fields: { 'Client Name': 'Sean Bisset', 'Master Client ID': 'recREGBISSET00001' } }],
  site_equipment: [
    { id: 'recEQ1', fields: { 'Equipment Type': 'Inverter', Manufacturer: 'Solax', Model: 'X1-7.5', 'Serial Number': 'SN-1', Quantity: 2,
      'Warranty Expiry': '2035-09-25', 'Contract Number': 'sub-148', Status: 'Active' } },
    { id: 'recEQ2', fields: { 'Equipment Type': 'Battery', 'Serial Number': 'SN-OLD', 'Contract Number': 'SUB-148', Status: 'Replaced' } },
    { id: 'recEQ3', fields: { 'Equipment Type': 'Inverter', 'Serial Number': 'SN-OTHER', 'Contract Number': 'SUB-999' } },
  ],
  documents: [
    { id: 'recDOC1', fields: { 'Job Card': ['recJC0000000000001'], 'Document Type': 'Site Photos' } },
    { id: 'recDOC2', fields: { 'Job Card': ['recJC0000000000001'], 'Document Type': 'Site Report', 'Record Status': 'Deleted' } },
    { id: 'recDOC3', fields: { 'Job Card': ['recOTHERJC0000001'], 'Document Type': 'Invoice' } },
  ],
};
const ALL = { view: true, create: true, edit: true, delete: false, export: true };
const asRole = (rules) => ({ perms: P.effectivePermissions(JSON.stringify(rules), null) });
/** The endpoint's read: its rows, filtered by the role's rule as readAll does. Records what it read. */
const reader = (auth, seen) => async (m) => {
  seen.push(m);
  return (BASE_ROWS[m] || []).map((r) => ({ id: r.id, fields: P.filterReadFields(auth.perms[m], r.fields, {}) }));
};

const JC = {
  'JC Reference': 'OM-2026-0169/MAINT/TE', Title: 'Inverter tripping', Status: 'Quotation Pending',
  'Suggested Site Actions': ['Site Inspection', 'Maintenance'], 'Pre-Site Scope of Work': 'Replace the DC isolator',
  'Delivery Notes': ['recDN0000000000001'], 'Supplier Quotes Attached': true, Client: ['recOMBISSET000001'],
  'Contract Number': 'SUB-148', Budget: 12345, 'Actual Cost': 9999,
};
const TICKET = {
  'Ticket Ref': 'TKT-2026-0042', 'Fault Category': 'Inverter Fault', Subject: 'Inverter offline', Description: 'Error 0x33 since Tuesday.',
  'Error Code': '0x33', 'Asset / Inverter': 'INV-2', 'Reported At': '2026-11-01T06:00:00Z', 'Source Channel': 'WhatsApp',
  'Reported By': 'Oubaas', 'Contract Number': 'SUB-148', Client: ['recOMBISSET000001'],
};

(async () => {
  console.log('\n\x1b[1mWHAT THE ROLE MAY SEE\x1b[0m');
  const full = asRole({ clients: ALL, site_equipment: ALL, documents: ALL });
  let seen = [];
  const facts = await CS.gather({ auth: full, base: 'OM', read: reader(full, seen), clientIds: ['recOMBISSET000001'],
    contractNo: 'SUB-148', jobcardId: 'recJC0000000000001' });
  t('the register client is found through its copy here', facts.client && facts.client.name, 'Sean Bisset');
  t('the contract the record names, not another client’s', facts.contract && [facts.contract.number, facts.contract.funder], ['SUB-148', 'PPA']);
  t('warranty runs from the 1st invoice, by the contract panel’s rules',
    facts.contract.warranty.map((w) => w.until), ['2035-09-25', '2050-09-25', '2027-09-25', '2026-09-25']);
  t('the equipment on that contract, however its number is cased, not removed or replaced units',
    facts.equipment.map((e) => e.serial), ['SN-1']);
  t('the job card’s live documents only', facts.documents, ['Site Photos']);

  seen = [];
  const narrow = asRole({ clients: ALL });
  const f2 = await CS.gather({ auth: narrow, base: 'OM', read: reader(narrow, seen), clientIds: ['recOMBISSET000001'],
    contractNo: 'SUB-148', jobcardId: 'recJC0000000000001' });
  t('a role without site equipment or documents gets neither', [f2.equipment, f2.documents], [[], []]);
  t('and they are never read for it', seen.filter((m) => m !== 'clients'), []);

  seen = []; LISTED.length = 0;
  const noClients = asRole({ site_equipment: ALL });
  const f3 = await CS.gather({ auth: noClients, base: 'OM', read: reader(noClients, seen), clientIds: ['recOMBISSET000001'], contractNo: 'SUB-148' });
  t('a role without clients gets no client details, and the register is not read', [f3.client, seen.includes('clients'), LISTED.length], [null, false, 0]);

  const hidden = asRole({ clients: { ...ALL, fields: { deny_read: ['Email', 'Mobile Number', 'Phone', 'Contact Person'] } } });
  const f4 = await CS.gather({ auth: hidden, base: 'OM', read: reader(hidden, []), clientIds: ['recOMBISSET000001'], contractNo: 'SUB-148' });
  t('a client field the role may not read is not on the sheet', [f4.client.email, f4.client.phones, f4.client.contact], ['', [], '']);

  console.log('\n\x1b[1mWHAT GOES ON IT\x1b[0m');
  const c = CS.contents({ ticket: TICKET, jobcard: JC, facts, visits: [{ start: '2026-11-02T08:00:00Z', status: 'Completed', tech: 'Zola', notes: 'Reset inverter' }],
    spares: [{ code: 'DC-ISO-32', desc: 'DC isolator', req: 1 }], today: '2026-11-05' });
  t('the reference is the ticket’s, the job card number is the job card’s', [c.ref, c.jcRef], ['TKT-2026-0042', 'OM-2026-0169/MAINT/TE']);
  t('the SOL / SUB number is the contract and the Palladium code', c.numbers, 'SUB-148 · TESUB-0148');
  t('a phone number in Contact Person goes with the numbers, not beside the name',
    [c.client.name, c.client.reach], ['Sean Bisset', '082 111 2222 · 011 555 0000 · sean@bisset.co.za']);
  t('the installation address is the register’s Sites', c.client.install, '12 Main Rd, Benoni');
  t('the problem carries the fault, the codes, how it was reported and the work done',
    c.problem.split('\n'), ['Inverter Fault — Inverter offline', 'Error 0x33 since Tuesday.', 'Error code: 0x33   Asset: INV-2',
      'Reported 2026-11-01 via WhatsApp by Oubaas', 'Previous work: 2026-11-02 Completed Zola — Reset inverter']);
  t('the action carries the job card’s suggestions, scope and the spares asked for', c.action.split('\n'),
    ['Suggested: Site Inspection, Maintenance', 'Replace the DC isolator', 'Spares requested: 1 × DC-ISO-32 DC isolator']);
  t('Quotation Pending and a suggested site inspection are ticked', [c.quotation, c.siteInspection], [true, true]);
  t('the technician falls back to the latest visit’s', c.technician, 'Zola');
  t('the checklist ticks only what the record proves', c.checklist.filter(([, v]) => v).map(([l]) => l),
    ['Supplier quote', 'Delivery note', 'Photos*']);
  t('no job card money reaches the sheet', /12345|9999|12 345/.test(JSON.stringify(c)), false);

  t('the plant on this contract is named, not one on another', c.plantLine, 'Bisset House · solax.sean@gmail.com · 12 Main Rd, Benoni');
  t('a phone number in Contact Person leaves the contact line to be written on', c.client.contact, '');
  const named = CS.contents({ ticket: TICKET, facts: { ...facts, client: { ...facts.client, contact: 'Lerato Bisset' } }, today: '2026-11-05' });
  t('a contact person’s name has its own line', named.client.contact, 'Lerato Bisset');
  const gaps = CS.contents({ ticket: TICKET, facts: { ...facts, client: { ...facts.client, email: '', install: '', phones: [], contact: '' } }, today: '2026-11-05' });
  t('no email or address in the register: the SolaX login and location fill them',
    [gaps.client.reach, gaps.client.install], ['solax.sean@gmail.com', '12 Main Rd, Benoni']);
  const noMail = asRole({ clients: { ...ALL, fields: { deny_read: ['Email', 'Sites'] } } });
  const f5 = await CS.gather({ auth: noMail, base: 'OM', read: reader(noMail, []), clientIds: ['recOMBISSET000001'], contractNo: 'SUB-148' });
  t('a role denied Email and Sites does not get them through the plant', [f5.client.plants[0].user, f5.client.plants[0].location], ['', '']);

  t('section 1 carries the contract panel: funder, number and kind', c.con && c.con.head, 'PPA · SUB-148');
  t('the system and the warranty start', c.con && [c.con.system, c.con.start], ['2x 7.5kw G4 Single phase', '2025-09-25']);
  t('each warranty class, in or out, as the screen shows it', c.warranty.map((w) => w.label + ': ' + w.status),
    ['Solax equipment 10 yrs: in warranty until 2035-09-25', 'PV panels 25 yrs: in warranty until 2050-09-25',
      'Workmanship 2 yrs: in warranty until 2027-09-25', 'Material 1 yr: expired 2026-09-25']);
  t('and the funder’s rule', c.con && c.con.rule, 'PPA is paid a monthly O&M fee by the client. Work within TAGEX O&M\'s pre-approved PPA budget.');
  t('the contact number and email are their own lines', [c.client.phone, c.client.email], ['082 111 2222 · 011 555 0000', 'sean@bisset.co.za']);
  const noCon = CS.contents({ ticket: TICKET, facts: { ...facts, contract: null, contractWhy: { how: 'choose', count: 2 } }, today: '2026-11-05' });
  t('with no settled contract the panel’s reason is printed, not blank lines', [noCon.con, noCon.conWhy],
    [null, 'This client has 2 contracts. Choose the one this is for: funder and warranty depend on it.']);

  const bare = CS.contents({ jobcard: { 'JC Reference': 'OM-1', 'Site / Address': ['Plot 9'] }, facts: {}, today: '2026-11-05' });
  t('with nothing known the lines stay blank to fill in, not filled with guesses',
    [bare.numbers, bare.client.reach, bare.action, bare.quotation, bare.technician, bare.warranty], ['', '', '', false, '', []]);
  t('and the address falls back to the job card’s site', bare.client.install, 'Plot 9');

  console.log('\n\x1b[1mTHE PAPER\x1b[0m');
  const { PDFDocument } = require('pdf-lib');
  // A typical record is the template's one A4 page. A long one (an equipment table, a long fault
  // history) runs on to a second rather than being cut: nothing the record holds is dropped.
  const typical = await PDFDocument.load(await CS.coverSheetPdf({ ticket: TICKET, jobcard: JC,
    facts: { ...facts, equipment: [] }, generatedBy: 'test', today: '2026-11-05' }));
  t('a typical record is one A4 page, as the template is', [typical.getPageCount(), Math.round(typical.getPage(0).getWidth())], [1, 595]);
  const long = await PDFDocument.load(await CS.coverSheetPdf({ ticket: TICKET, jobcard: JC,
    facts: { ...facts, equipment: Array.from({ length: 12 }, (_, i) => ({ type: 'PV Module', serial: 'SN-' + i })) }, generatedBy: 'test' }));
  t('a long one runs on to a second page rather than losing rows', long.getPageCount() >= 2, true);
  t('named for the record', CS.coverFilename('TKT-2026-0042').replace(/-\d{4}-\d{2}-\d{2}\.pdf$/, ''), 'COVER-TKT-2026-0042');

  console.log('\n\x1b[1mTHE ENDPOINTS\x1b[0m');
  for (const f of ['ticket-report.js', 'jobcard-form.js']) {
    const s = fs.readFileSync(api(f), 'utf8');
    const exp = s.indexOf(f === 'ticket-report.js' ? "P.can(auth.perms, 'tickets', 'export')" : "P.can(auth.perms, 'job_cards', 'export')");
    t(f + ': the cover sheet sits behind the export right', exp > 0 && exp < s.indexOf('body.cover === true'), true);
    t(f + ': and is audited, never filed', /cover sheet printed for/.test(s) && !/cover[\s\S]{0,400}FF\.fileForm/.test(s.slice(s.indexOf('body.cover === true'), s.indexOf('body.cover === true') + 700)), true);
  }
  const vj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  t('both functions ship the warranty rules they require', ['api/ticket-report.js', 'api/jobcard-form.js']
    .every((k) => /contract-panel\.js/.test(vj.functions[k].includeFiles)), true);

  console.log('\n' + (bad ? '\x1b[31m\x1b[1m  ' + bad + ' FAILED\x1b[0m, ' : '  ') + (n - bad) + ' passed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
