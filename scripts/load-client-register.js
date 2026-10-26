#!/usr/bin/env node
// Load the client register (TAGEX Clients base) from the operating bases' Clients tables and
// the SxE Portfolio Maintenance Cost Log, and stamp each mirror row with its Master Client ID.
//
//   node scripts/load-client-register.js <cost-log.xlsx> [--report <file>] [--apply]
//
// Dry run by default: it writes nothing and prints, or saves with --report, what it would do.
//
// MATCHING IS BY NAME AND IS CAUTIOUS. Names are compared with case, spacing, punctuation and
// anything in brackets ignored ("Sean Bisset (Additionals)" is Sean Bisset). Only an exact
// match on that form is merged. Anything merely similar is listed under "for a person" and
// left as two clients -- merging two real people is far worse than a duplicate, and a
// duplicate can be merged later; a merge cannot be told apart again.
//
// Where two bases hold different details for the same client, the register takes O&M's, then
// C&I's, and the difference is reported. Nothing in an operating base is changed except its
// empty Master Client ID. No money is read: the monthly O&M columns are skipped.
//
// The spreadsheet is read straight from the .xlsx so no copy of the client list is committed.
// It holds personal information (POPIA); keep it out of git.

'use strict';

const fs = require('fs');
const zlib = require('zlib');
const T = require('../api/_lib/tables.js');
const { call, all, inTens } = require('./_airtable.js');

// With no spreadsheet it loads from the mirrors alone: that is how a client added straight into
// a base's Clients table is adopted into the register and stamped.
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const xlsx = args.find((a) => /\.xlsx$/i.test(a));
const reportAt = args.includes('--report') ? args[args.indexOf('--report') + 1] : null;

// ── the spreadsheet ────────────────────────────────────────────────────────

/** The files of a zip, by name. Enough of the format for an .xlsx; no dependency. */
function unzip(buf) {
  const files = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = buf.readUInt32LE(eocd + 16);
  const n = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    p += 46 + nl + el + cl;
  }
  return files;
}
const dec = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Rows of the first sheet ("Subscr. List") as {col: text}. Header is row 1. */
function readCostLog(file) {
  const z = unzip(fs.readFileSync(file));
  const ss = [...String(z['xl/sharedStrings.xml'] || '').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => dec([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
  const xml = String(z['xl/worksheets/sheet1.xml']);
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = { _r: +rm[1] };
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = (/r="([A-Z]+)\d+"/.exec(cm[1]) || [])[1];
      const t = (/t="(\w+)"/.exec(cm[1]) || [])[1];
      let v = (/<v>([\s\S]*?)<\/v>/.exec(cm[2] || '') || [])[1];
      if (t === 's') v = ss[+v]; else if (v != null) v = dec(v);
      if (v != null && String(v).trim() !== '') row[col] = String(v).trim();
    }
    rows.push(row);
  }
  const head = rows.find((r) => r._r === 1) || {};
  const want = { client: 'Client', contract: 'Contract', system: 'System Description', first: '1st Inv. Date' };
  const col = {};
  for (const [k, label] of Object.entries(want)) {
    col[k] = Object.keys(head).find((c) => head[c] === label);
    if (!col[k]) throw new Error('The cost log has no "' + label + '" column -- has its layout changed?');
  }
  // Column B carries the portfolio and has no heading.
  return rows.filter((r) => r._r > 1 && r[col.client]).map((r) => ({
    row: r._r,
    client: r[col.client],
    contract: String(r[col.contract] || '').replace(/\s+/g, ' ').trim(),
    portfolio: r.B || '',
    system: r[col.system] || '',
    firstInvoice: excelDate(r[col.first]),
  }));
}
/** An Excel serial day as YYYY-MM-DD. */
function excelDate(v) {
  const n = Number(v);
  if (!v || !isFinite(n)) return null;
  return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
}

// ── matching ───────────────────────────────────────────────────────────────

// A contract number as one key whatever its padding: SUB-0177-1, SUB-177 and "SUB 177" are all
// SUB-177 (checked against the cost log: no number means two clients padded and unpadded).
// "-1", "-2", "-P" are additions to the same contract; "#2" is a different party under the
// same number (SUB-0028 is a house, SUB-0028#2 a company), so it is kept.
const SUB_RE = /SUB[\s\-:]*0*(\d+)(#\d+)?/gi;
function contractKey(c) {
  const m = new RegExp(SUB_RE.source, 'i').exec(c);
  return m ? 'SUB-' + m[1] + (m[2] || '') : String(c).toUpperCase().replace(/\s+/g, '');
}
const contractsIn = (name) => [...String(name || '').matchAll(SUB_RE)].map((m) => 'SUB-' + m[1] + (m[2] || ''));

// What is left of a name once contract numbers, bracketed notes and "additionals" are gone.
const NOISE = /\b(additionals?|additonals?|add[\s-]?ons?)\s*\d*\b/gi;
function bare(s) {
  const t = String(s || '').replace(SUB_RE, ' ').replace(/\([^)]*\)/g, ' ').replace(NOISE, ' ')
    .replace(/^[\s\-:"]+|[\s\-:"]+$/g, '').replace(/\s+/g, ' ').trim();
  // "TINCUP - Tincup", "BRIAN HUGHES - Brian Hughes": a name typed twice is the name once.
  const halves = t.split(/\s+-\s+/);
  if (halves.length === 2 && flat(halves[0]) === flat(halves[1])) return halves[1];
  return t;
}
const flat = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const key = (s) => flat(bare(s));
const words = (s) => bare(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
const clean = (s) => bare(s).replace(/\s*-\s*$/, '');
const PORTFOLIOS = ['PPA', 'Alpine', 'PrefCap', 'TxE'];

(async () => {
  const sheet = xlsx ? readCostLog(xlsx) : [];

  const CLI = T.BASES.CLI;
  const meta = await call('GET', 'meta/bases/' + CLI + '/tables');
  const tClients = meta.tables.find((t) => t.name === 'Clients');
  const tContracts = meta.tables.find((t) => t.name === 'Contracts');
  if (!tClients || !tContracts) throw new Error('Run scripts/provision-client-register.js --apply first');

  const mirror = {};
  for (const sym of ['OM', 'CI', 'RES']) mirror[sym] = await all(T.BASES[sym], T.TABLES.clients[sym === 'RES' ? 'OM' : sym]);
  const existingMasters = await all(CLI, tClients.id);
  const existingContracts = new Set((await all(CLI, tContracts.id)).map((r) => String(r.fields['Contract Number'] || '').toUpperCase()));

  // Every cost-log row and every mirror row is a node. Two nodes are one client when they share
  // a compared name, or a contract number (a base row whose name carries "SUB 148" is the
  // client on SUB-148). Joined with union-find, so "SUB-126 Now Craig Thomas - Rynhart Bosch"
  // and "SUB-126-1 Craig Thomas" end up as one client by their contract.
  const nodes = [];
  for (const s of sheet) nodes.push({ kind: 'row', row: s, name: s.client, contracts: s.contract ? [contractKey(s.contract)] : [] });
  for (const sym of ['OM', 'CI', 'RES']) {           // O&M first: its details win
    for (const r of mirror[sym]) if (key(r.fields['Client Name'])) {
      nodes.push({ kind: 'rec', sym, rec: r, name: r.fields['Client Name'], contracts: contractsIn(r.fields['Client Name']) });
    }
  }
  const parent = nodes.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  const firstBy = {};
  nodes.forEach((n, i) => {
    for (const k of ['n:' + key(n.name)].concat(n.contracts.map((c) => 'c:' + c))) {
      if (k === 'n:') continue;
      if (k in firstBy) join(firstBy[k], i); else firstBy[k] = i;
    }
  });

  const DETAILS = ['Contact Person', 'Mobile Number', 'Email', 'Sites'];
  const groups = new Map();
  nodes.forEach((n, i) => {
    const g = find(i);
    if (!groups.has(g)) groups.set(g, { records: { OM: [], CI: [], RES: [] }, rows: [], details: {}, conflicts: [], names: new Set(), masterId: '' });
    const e = groups.get(g);
    e.names.add(clean(n.name));
    if (n.kind === 'row') { e.rows.push(n.row); return; }
    e.records[n.sym].push(n.rec.id);
    e.masterId = e.masterId || String(n.rec.fields['Master Client ID'] || '').trim();
    for (const d of DETAILS) {
      const v = String(n.rec.fields[d] || '').trim();
      if (!v) continue;
      if (!e.details[d]) e.details[d] = { v, from: n.sym };
      else if (e.details[d].v.toLowerCase() !== v.toLowerCase()) e.conflicts.push((d + ': kept ' + e.details[d].from + ' "' + e.details[d].v + '", ' + n.sym + ' has "' + v + '"').replace(/\s*\n\s*/g, ' / '));
    }
  });
  // The register's name: the cost log's main contract row if there is one (it is the
  // contracted party), else O&M's, else C&I's -- with contract numbers taken out.
  for (const e of groups.values()) {
    const main = e.rows.slice().sort((a, b) => a.contract.length - b.contract.length)[0];
    e.name = main ? clean(main.client) : clean([...e.names][0]);
    e.key = key(e.name);
  }
  const reg = new Map([...groups.values()].map((e, i) => [i, e]));
  const byRecord = new Map();
  for (const e of reg.values()) for (const s of ['OM', 'CI', 'RES']) for (const id of e.records[s]) byRecord.set(id, e);

  // Already in the register (a re-run): matched by a mirror record it names, or by name.
  for (const m of existingMasters) {
    const named = ['OM', 'CI', 'RES'].flatMap((s) => String(m.fields[s + ' Client Record'] || '').split(/,\s*/)).filter(Boolean);
    const e = named.map((id) => byRecord.get(id)).find(Boolean) || [...reg.values()].find((x) => x.key === key(m.fields['Client Name']));
    if (e && !e.masterId) e.masterId = m.id;
  }

  // Similar but not the same: every pair sharing a word that is rare, or one name inside another.
  const list = [...reg.values()];
  const df = {};
  for (const e of list) for (const w of new Set(words(e.name))) df[w] = (df[w] || 0) + 1;
  const similar = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    const inside = (a.key.length > 5 && b.key.includes(a.key)) || (b.key.length > 5 && a.key.includes(b.key));
    const wa = new Set(words(a.name)), shared = words(b.name).filter((w) => wa.has(w) && df[w] <= 2 && w.length > 3);
    if (inside || shared.length >= 2) similar.push([a, b]);
  }

  // ── the report ─────────────────────────────────────────────────────────
  const where = (e) => ['OM', 'CI', 'RES'].filter((s) => e.records[s].length).map((s) => s + (e.records[s].length > 1 ? '×' + e.records[s].length : '')).join('+') || '-';
  const fromSheet = list.filter((e) => e.rows.length);
  const x_names = (e) => new Set([...e.names].filter((n) => key(n) !== e.key));
  const lines = [];
  const say = (s) => lines.push(s);
  say('CLIENT REGISTER LOAD -- ' + (APPLY ? 'APPLIED' : 'DRY RUN, nothing written'));
  say('');
  say('Cost log: ' + sheet.length + ' rows with a client, ' + fromSheet.length + ' clients, '
    + sheet.filter((s) => s.contract).length + ' contracts.');
  say('Mirrors:  O&M ' + mirror.OM.length + ', C&I ' + mirror.CI.length + ', RES ' + mirror.RES.length + ' Clients rows.');
  say('Register: ' + list.length + ' clients (' + list.filter((e) => e.masterId).length + ' already in it).');
  say('');
  say('  in the cost log only ............ ' + fromSheet.filter((e) => where(e) === '-').length);
  say('  in the cost log and a base ...... ' + fromSheet.filter((e) => where(e) !== '-').length);
  say('  in a base only .................. ' + list.filter((e) => !e.rows.length).length);
  say('  in both O&M and C&I ............. ' + list.filter((e) => e.records.OM.length && e.records.CI.length).length);
  say('');
  say('ONE NAME, SEVERAL ROWS IN ONE BASE -- the register gets one client; the rows are left for a person to merge');
  for (const e of list.filter((x) => ['OM', 'CI', 'RES'].some((s) => x.records[s].length > 1))) say('  ' + e.name + '  [' + where(e) + ']');
  say('');
  say('JOINED BY CONTRACT NUMBER, THOUGH THE NAMES DIFFER -- check these');
  for (const e of list.filter((x) => new Set([...x.names].map(key)).size > 1)) {
    say('  ' + e.name + '  [' + where(e) + ']  <-  ' + [...x_names(e)].join('  |  '));
  }
  say('');
  say('DETAILS THAT DISAGREE BETWEEN BASES -- O&M kept, then C&I');
  for (const e of list.filter((x) => x.conflicts.length)) say('  ' + e.name + ': ' + e.conflicts.join('; '));
  say('');
  say('SIMILAR NAMES, NOT MERGED -- for a person to decide');
  for (const [a, b] of similar) say('  "' + a.name + '" [' + where(a) + ']   ~   "' + b.name + '" [' + where(b) + ']');
  say('');
  say('COST LOG ROWS WITHOUT A CONTRACT NUMBER -- client loaded, no contract');
  for (const s of sheet.filter((x) => !x.contract)) say('  row ' + s.row + ': ' + s.client);
  say('');
  say('COST LOG PORTFOLIOS NOT RECOGNISED');
  for (const s of sheet.filter((x) => x.portfolio && !PORTFOLIOS.includes(x.portfolio))) say('  row ' + s.row + ': ' + s.portfolio);
  say('');
  say('MATCHED TO A BASE');
  for (const e of fromSheet.filter((x) => where(x) !== '-')) say('  ' + e.name + '  [' + where(e) + ']  ' + e.rows.map((r) => r.contract).filter(Boolean).join(', '));

  const text = lines.join('\n') + '\n';
  if (reportAt) { fs.writeFileSync(reportAt, text); console.log('report written to ' + reportAt); }
  else console.log(text);

  if (!APPLY) return;

  // ── apply ──────────────────────────────────────────────────────────────
  const ids = (e) => (s) => e.records[s].join(', ');
  const toCreate = list.filter((e) => !e.masterId);
  const created = await inTens('POST', CLI, tClients.id, toCreate.map((e) => {
    const f = { 'Client Name': e.name, Status: 'Active' };
    for (const d of DETAILS) if (e.details[d]) f[d] = e.details[d].v;
    const isCI = e.records.CI.length && !e.records.OM.length || e.rows.some((r) => /^C&I/i.test(r.contract));
    f.Segment = isCI ? 'C&I' : 'Residential';
    if (e.records.CI.length) f['CI Client Record'] = ids(e)('CI');
    if (e.records.OM.length) f['OM Client Record'] = ids(e)('OM');
    if (e.records.RES.length) f['RES Client Record'] = ids(e)('RES');
    // Every base it is already in needs it there; sync-client-register.js keeps those copies.
    f['Use In'] = ['CI', 'OM', 'RES'].filter((s) => e.records[s].length);
    f.Source = [e.rows.length && 'SxE Cost Log 26 Oct 2026', e.records.CI.length && 'CI Clients',
      e.records.OM.length && 'OM Clients', e.records.RES.length && 'RES Clients'].filter(Boolean);
    if (e.conflicts.length) f.Notes = 'Loaded with differences between bases:\n' + e.conflicts.join('\n');
    return { fields: f };
  }));
  created.forEach((r, i) => { toCreate[i].masterId = r.id; });
  console.log('clients created: ' + created.length);

  const contracts = [];
  for (const e of list) for (const s of e.rows) {
    if (!s.contract || existingContracts.has(s.contract.toUpperCase())) continue;
    existingContracts.add(s.contract.toUpperCase());
    const f = { 'Contract Number': s.contract, Client: [e.masterId], Status: 'Active',
      'Contract Kind': /^C&I/i.test(s.contract) ? 'C&I' : 'Subscription' };
    if (PORTFOLIOS.includes(s.portfolio)) f.Portfolio = s.portfolio;
    if (s.firstInvoice) f['First Invoice Date'] = s.firstInvoice;
    if (s.system) f['System Description'] = s.system;
    contracts.push({ fields: f });
  }
  console.log('contracts created: ' + (await inTens('POST', CLI, tContracts.id, contracts)).length);

  // Stamp the mirrors. Only an empty Master Client ID is written; one already set is left alone.
  for (const sym of ['OM', 'CI', 'RES']) {
    const ups = [];
    for (const r of mirror[sym]) {
      if (String(r.fields['Master Client ID'] || '').trim()) continue;
      const e = byRecord.get(r.id);
      if (e && e.masterId) ups.push({ id: r.id, fields: { 'Master Client ID': e.masterId } });
    }
    const done = await inTens('PATCH', T.BASES[sym], T.TABLES.clients[sym === 'RES' ? 'OM' : sym], ups);
    console.log(sym + ' mirrors stamped: ' + done.length);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
