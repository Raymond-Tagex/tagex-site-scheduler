#!/usr/bin/env node
// Load the Palladium customer list into the client register (TAGEX Clients base).
//
//   node scripts/load-palladium-customers.js <customers.xlsx> [--report <file>] [--apply]
//
// Dry run by default: it writes nothing and reports what it would do.
//
// The export ("Customer Information Tagex Energy CLEANED", 3 Nov 2026) has one row per Palladium
// customer: SOL_Number (the customer code -- SOL…, TESUB-/SUB- subscriptions, C&I-…), Name,
// postal address, Phone, Fax, Email. Raymond, 3 Nov 2026: every customer becomes a register
// client; matched clients have their blanks filled and nothing overwritten; names never change.
//
// MATCHING, most certain first:
//   1. the Palladium Code already on a register client (a re-run);
//   2. a subscription code (TESUB-0001, SUB-0028) -> the register contract SUB-1, SUB-28. "#k"
//      stays apart, as in load-client-register.js: SUB-0028#2 is a different party;
//   3. a SOL code already written into a register client's name ("SOL120 - Elmar");
//   4. the same name, ignoring case, punctuation, brackets and (Pty) Ltd / CC / NPC.
// Anything else is a new client. Rows sharing a name (ABSA BANK LIMITED under several site codes)
// become ONE client carrying every code: the register refuses two clients of one name.
//
// CASH and TEST rows are not clients and are skipped. An email that is still not an address once
// stray spaces are removed ("01Hgmail.com") is reported and left out, never guessed at.
//
// The export holds personal information (POPIA): it is read from the .xlsx, never committed.

'use strict';

const fs = require('fs');
const zlib = require('zlib');
const T = require('../api/_lib/tables.js');
const { call, all, inTens } = require('./_airtable.js');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const xlsx = args.find((a) => /\.xlsx$/i.test(a));
const reportAt = args.includes('--report') ? args[args.indexOf('--report') + 1] : null;
if (!xlsx) { console.error('usage: load-palladium-customers.js <customers.xlsx> [--report file] [--apply]'); process.exit(2); }

const SOURCE = 'Palladium customers 3 Nov 2026';
// New register fields (Raymond, 3 Nov 2026). Additive; created on --apply when missing.
const NEW_FIELDS = [
  { name: 'Palladium Code', type: 'singleLineText',
    description: 'Palladium customer code(s): SOL…, TESUB-…, C&I-…. Comma-separated when one client has several.' },
  { name: 'Postal / Billing Address', type: 'multilineText',
    description: 'From Palladium. Not the installation: that is Sites.' },
  { name: 'Phone', type: 'phoneNumber', description: 'From Palladium. Mobile Number is kept as it was.' },
];

// ── the spreadsheet ────────────────────────────────────────────────────────

function unzip(buf) {
  const files = {}; let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  let p = buf.readUInt32LE(e + 16); const n = buf.readUInt16LE(e + 10);
  for (let i = 0; i < n; i++) {
    const m = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42), name = buf.toString('utf8', p + 46, p + 46 + nl);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files[name] = m === 8 ? zlib.inflateRawSync(data) : data;
    p += 46 + nl + el + cl;
  }
  return files;
}
const dec = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** The first sheet's rows, keyed by the header row that starts with SOL_Number. */
function readCustomers(file) {
  // Read, not opened: Excel keeps the file locked while it is open, and a plain read still works.
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
      const body = cm[2] || '';
      let v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
      if (t === 's') v = ss[+v];
      else if (t === 'inlineStr') v = dec([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((q) => q[1]).join(''));
      else if (v != null) v = dec(v);
      if (v != null && String(v).trim() !== '') row[col] = String(v).trim();
    }
    rows.push(row);
  }
  const head = rows.find((r) => Object.values(r).includes('SOL_Number'));
  if (!head) throw new Error('No header row with SOL_Number -- has the export changed?');
  const col = {};
  for (const [k, label] of Object.entries({ code: 'SOL_Number', name: 'Name', s1: 'Street 1', s2: 'Street 2', city: 'City',
    prov: 'Province', postal: 'Postal', country: 'Country', phone: 'Phone', fax: 'Fax', email: 'Email' })) {
    col[k] = Object.keys(head).find((c) => head[c] === label);
    if (!col[k]) throw new Error('The export has no "' + label + '" column.');
  }
  return rows.filter((r) => r._r > head._r && r[col.code] && r[col.name]).map((r) => {
    const g = (k) => sp(r[col[k]]);
    return { row: r._r, code: sp(r[col.code]), name: sp(r[col.name]), phone: g('phone'), fax: g('fax'), email: g('email'),
      address: [g('s1'), g('s2'), g('city'), [g('prov'), g('postal')].filter(Boolean).join(' ')]
        .filter(Boolean).join('\n') };
  });
}
const sp = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// ── matching ───────────────────────────────────────────────────────────────

const LEGAL = /\b(pty|proprietary|ltd|limited|cc|npc|inc)\b/g;
const key = (s) => String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(LEGAL, ' ').replace(/[^a-z0-9]+/g, '');
/** TESUB-0001, SUB 28, SUB-0028#2 -> SUB-1, SUB-28, SUB-28#2. "-1" add-ons are the same contract. */
function subKey(s) {
  const m = /(?:TE)?SUB[\s\-:_]*0*(\d+)(#\d+)?/i.exec(String(s || ''));
  return m ? 'SUB-' + m[1] + (m[2] || '') : '';
}
const solCode = (s) => { const m = /^SOL[\s\-_]*0*(\d+)$/i.exec(String(s || '').trim()); return m ? 'SOL' + m[1] : ''; };
const solsIn = (s) => [...String(s || '').matchAll(/\bSOL[\s\-_]*0*(\d+)\b/gi)].map((m) => 'SOL' + m[1]);
const codes = (v) => String(v || '').split(/,\s*/).map((s) => s.trim()).filter(Boolean);

/** An email with the spaces a hand-typed export picks up taken out, or '' when it still is not one. */
function cleanEmail(s) {
  // Quotes too: several came out of Palladium as 'name@host.co.za', quote marks and all.
  const e = String(s || '').replace(/\s+/g, '').replace(/^['"]+|['"]+$/g, '').replace(/[,;]+$/, '');
  return /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i.test(e) ? e.toLowerCase() : '';
}

(async () => {
  const rows = readCustomers(xlsx);
  const R = T.CLIENT_REGISTER, base = T.BASES[R.base];
  const meta = await call('GET', 'meta/bases/' + base + '/tables');
  const tc = meta.tables.find((t) => t.id === R.clients);
  const have = new Set(tc.fields.map((f) => f.name));
  const missing = NEW_FIELDS.filter((f) => !have.has(f.name));

  const reg = await all(base, R.clients);
  const con = await all(base, R.contracts);
  const regById = new Map(reg.map((c) => [c.id, c]));
  const byCode = new Map(), byName = new Map(), bySub = new Map(), bySol = new Map();
  for (const c of reg) {
    for (const cd of codes(c.fields['Palladium Code'])) byCode.set(cd.toUpperCase(), c.id);
    const k = key(c.fields['Client Name']); if (k && !byName.has(k)) byName.set(k, c.id);
    for (const s of solsIn(c.fields['Client Name'])) if (!bySol.has(s)) bySol.set(s, c.id);
  }
  for (const k of con) {
    const s = subKey(k.fields['Contract Number']), cid = (k.fields.Client || [])[0];
    if (s && cid && !bySub.has(s)) bySub.set(s, cid);
  }

  const skipped = [], badEmail = [];
  const toUpdate = new Map();          // register id -> { rows, via }
  const toCreate = new Map();          // name key -> rows
  for (const r of rows) {
    if (/^(CASH|TEST)/i.test(r.code)) { skipped.push(r); continue; }
    if (r.email && !cleanEmail(r.email)) badEmail.push(r);
    let id = '', via = '';
    if (byCode.has(r.code.toUpperCase())) { id = byCode.get(r.code.toUpperCase()); via = 'Palladium Code'; }
    else if (subKey(r.code) && bySub.has(subKey(r.code))) { id = bySub.get(subKey(r.code)); via = 'subscription number'; }
    else if (solCode(r.code) && bySol.has(solCode(r.code))) { id = bySol.get(solCode(r.code)); via = 'SOL code in the name'; }
    else if (byName.has(key(r.name))) { id = byName.get(key(r.name)); via = 'name'; }
    if (id) {
      const u = toUpdate.get(id) || { rows: [], via: new Set() };
      u.rows.push(r); u.via.add(via); toUpdate.set(id, u);
    } else {
      const k = key(r.name) || r.code;
      toCreate.set(k, (toCreate.get(k) || []).concat(r));
    }
  }

  // ── what each write would be ─────────────────────────────────────────────
  const firstOf = (rs, f) => (rs.find((r) => f(r)) || {});
  const fieldsFrom = (rs) => {
    const f = {};
    const cds = [...new Set(rs.map((r) => r.code))];
    if (cds.length) f['Palladium Code'] = cds.join(', ');
    const a = firstOf(rs, (r) => r.address).address; if (a) f['Postal / Billing Address'] = a;
    const p = firstOf(rs, (r) => r.phone).phone; if (p) f.Phone = p;
    const e = rs.map((r) => cleanEmail(r.email)).find(Boolean); if (e) f.Email = e;
    return f;
  };
  const updates = [], differs = [];
  for (const [id, u] of toUpdate) {
    const c = regById.get(id), want = fieldsFrom(u.rows), patch = {};
    for (const [k, v] of Object.entries(want)) {
      const now = String(c.fields[k] || '').trim();
      if (!now) patch[k] = v;
      else if (k === 'Palladium Code') {
        const merged = [...new Set(codes(now).concat(codes(v)))];
        if (merged.length > codes(now).length) patch[k] = merged.join(', ');
      } else if (now.toLowerCase() !== String(v).toLowerCase()) {
        differs.push(c.fields['Client Name'] + ' -- ' + k + ': register "' + now.replace(/\n/g, ' / ') + '", Palladium "' + String(v).replace(/\n/g, ' / ') + '"');
      }
    }
    const src = [].concat(c.fields.Source || []);
    if (!src.includes(SOURCE)) patch.Source = src.concat(SOURCE);
    updates.push({ id, name: c.fields['Client Name'], via: [...u.via], rows: u.rows, patch });
  }
  const creates = [...toCreate.values()].map((rs) => {
    const f = fieldsFrom(rs);
    const fax = rs.map((r) => r.fax).filter(Boolean);
    return { rows: rs, fields: {
      'Client Name': rs[0].name, Status: 'Active', Source: [SOURCE], ...f,
      ...(rs.some((r) => /^C&I/i.test(r.code)) ? { Segment: 'C&I' } : {}),
      ...(fax.length ? { Notes: 'Fax (Palladium): ' + [...new Set(fax)].join(', ') } : {}),
    } };
  });

  // ── report ───────────────────────────────────────────────────────────────
  const L = [];
  L.push('PALLADIUM CUSTOMERS -> CLIENT REGISTER -- ' + (APPLY ? 'APPLIED' : 'DRY RUN, nothing written'));
  L.push('');
  L.push('Export: ' + rows.length + ' customers. Register: ' + reg.length + ' clients.');
  L.push('  new register fields ............... ' + (missing.length ? missing.map((f) => f.name).join(', ') : 'none (already there)'));
  L.push('  matched to a register client ...... ' + updates.length + ' clients (' + [...toUpdate.values()].reduce((n, u) => n + u.rows.length, 0) + ' customers)');
  for (const via of ['Palladium Code', 'subscription number', 'SOL code in the name', 'name']) {
    L.push('      by ' + via.padEnd(22, '.') + ' ' + updates.filter((u) => u.via.includes(via)).length);
  }
  L.push('  new register clients .............. ' + creates.length + ' (' + creates.reduce((n, c) => n + c.rows.length, 0) + ' customers)');
  L.push('  skipped (cash / test) ............. ' + skipped.length);
  L.push('  emails left out, not an address ... ' + badEmail.length);
  L.push('  differences left for a person ..... ' + differs.length);
  L.push('  Contact Person: the export has no contact column, so none is filled.');
  L.push('');
  L.push('MATCHED -- blanks filled, nothing overwritten, names unchanged');
  for (const u of updates) L.push('  ' + u.name + '  <-  ' + u.rows.map((r) => r.code + ' ' + r.name).join(' | ') + '  [' + u.via.join(', ') + ']'
    + (Object.keys(u.patch).filter((k) => k !== 'Source').length ? '  fills: ' + Object.keys(u.patch).filter((k) => k !== 'Source').join(', ') : ''));
  L.push('');
  L.push('ONE CLIENT, SEVERAL PALLADIUM CODES');
  for (const c of creates.filter((x) => x.rows.length > 1)) L.push('  ' + c.fields['Client Name'] + ': ' + c.rows.map((r) => r.code).join(', '));
  L.push('');
  L.push('DIFFERENCES -- register kept');
  differs.forEach((d) => L.push('  ' + d));
  L.push('');
  L.push('EMAILS LEFT OUT');
  badEmail.forEach((r) => L.push('  ' + r.code + ' ' + r.name + ': "' + r.email + '"'));
  L.push('');
  L.push('SKIPPED');
  skipped.forEach((r) => L.push('  ' + r.code + ' ' + r.name));
  L.push('');
  L.push('NEW CLIENTS');
  creates.forEach((c) => L.push('  ' + c.fields['Client Name'] + '  [' + c.fields['Palladium Code'] + ']'));
  const text = L.join('\n') + '\n';
  if (reportAt) { fs.writeFileSync(reportAt, text); console.log(L.slice(0, 16).join('\n')); console.log('report written to ' + reportAt); }
  else console.log(text);

  if (!APPLY) return;

  for (const f of missing) {
    await call('POST', 'meta/bases/' + base + '/tables/' + R.clients + '/fields', f);
    console.log('added field ' + f.name);
  }
  // typecast, so "Palladium customers 3 Nov 2026" is added to Source's choices on first use: the
  // API cannot add a select choice any other way.
  const send = async (method, recs) => {
    let n = 0;
    for (let i = 0; i < recs.length; i += 10) {
      const j = await call(method, base + '/' + R.clients, { records: recs.slice(i, i + 10), typecast: true });
      n += j.records.length;
    }
    return n;
  };
  const ups = updates.filter((u) => Object.keys(u.patch).length).map((u) => ({ id: u.id, fields: u.patch }));
  console.log('clients updated: ' + await send('PATCH', ups));
  console.log('clients created: ' + await send('POST', creates.map((c) => ({ fields: c.fields }))));
})().catch((e) => { console.error(e.message); process.exit(1); });
