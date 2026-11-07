#!/usr/bin/env node
// Load a SolaX Cloud plant list into the client register's SolaX Plants table.
//
//   node scripts/load-solax-plants.js <plants.csv|plants.xlsx> [--report <file>] [--apply]
//
// Dry run by default: it writes nothing and reports what it would do.
//
// The export is SolaX Cloud's plant list (global.solaxcloud.com -> Plants), one row per plant:
// Plant Name, Plant Type, Plant Status, Grid Status, User Name, Country/Region,
// Installer/Distributor, Location. Columns are found by their heading, in any order; one the
// export does not have is simply left empty. Raymond, 6 Nov 2026.
//
// MATCHING A PLANT TO ITS CLIENT, most certain first:
//   1. the plant's User Name is the client's Email (SolaX logins are usually the client's email);
//   2. a SUB / SOL number in the plant name is one of the client's contracts or Palladium codes;
//   3. the plant name is the client's name ("Victory Village Main" -> a client "Victory Village");
//   4. the plant's Location begins with the client's Sites.
// More than one client by the same rule, or none, and the plant is loaded unlinked and reported:
// a plant hung on the wrong client would send a technician to the wrong house.
//
// FILLING THE CLIENT. A matched client with no Email takes the plant's User Name when it is an
// email, and one with no Sites takes the Location. Nothing the register already holds is changed.
//
// A re-run updates the plants it loaded before (same Plant Name and User Name), never doubling
// them. Status is written as "<plant> / <grid> status" on the import date: it is not live.
//
// The export holds personal information (POPIA): read from the file, never committed.

'use strict';

const fs = require('fs');
const zlib = require('zlib');
const T = require('../api/_lib/tables.js');
const { call, all } = require('./_airtable.js');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const file = args.find((a) => /\.(csv|xlsx)$/i.test(a));
const reportAt = args.includes('--report') ? args[args.indexOf('--report') + 1] : null;
if (!file) { console.error('usage: load-solax-plants.js <plants.csv|plants.xlsx> [--report file] [--apply]'); process.exit(2); }

const sp = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const key = (s) => String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/\b(pty|ltd|limited|cc|npc)\b/g, ' ').replace(/[^a-z0-9]+/g, '');
const nums = (s) => [...String(s || '').matchAll(/\b(?:TE)?(SUB|SOL)[\s\-_]*0*(\d+)/gi)].map((m) => m[1].toUpperCase() + '-' + m[2]);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(s || '').trim());

// ── reading the export ─────────────────────────────────────────────────────

function csvRows(text) {
  const out = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out;
}
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
function xlsxRows(buf) {
  const z = unzip(buf);
  const ss = [...String(z['xl/sharedStrings.xml'] || '').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => dec([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
  const col = (ref) => ref.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return [...String(z['xl/worksheets/sheet1.xml']).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((rm) => {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = (/r="([A-Z]+)\d+"/.exec(cm[1]) || [])[1]; if (!ref) continue;
      const t = (/t="(\w+)"/.exec(cm[1]) || [])[1], body = cm[2] || '';
      let v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
      if (t === 's') v = ss[+v]; else if (t === 'inlineStr') v = dec([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((q) => q[1]).join('')); else if (v != null) v = dec(v);
      row[col(ref)] = v == null ? '' : v;
    }
    return row;
  });
}
function readPlants(path) {
  // Read, not opened: Excel keeps the file locked while open, and a plain read still works.
  const buf = fs.readFileSync(path);
  const rows = /\.csv$/i.test(path) ? csvRows(buf.toString('utf8').replace(/^﻿/, '')) : xlsxRows(buf);
  const want = { name: /^plant\s*name$/i, type: /^plant\s*type$/i, status: /^plant\s*status$/i, grid: /^grid\s*status$/i,
    user: /^user\s*name$/i, country: /^country/i, installer: /^installer/i, location: /^location$/i };
  const hi = rows.findIndex((r) => (r || []).some((c) => want.name.test(sp(c))));
  if (hi < 0) throw new Error('No "Plant Name" heading -- is this the SolaX plant list?');
  const head = rows[hi].map(sp), at = {};
  for (const [k, re] of Object.entries(want)) at[k] = head.findIndex((h) => re.test(h));
  return rows.slice(hi + 1).map((r, i) => {
    const g = (k) => (at[k] >= 0 ? sp((r || [])[at[k]]) : '');
    return { row: hi + i + 2, name: g('name'), type: g('type'), status: g('status'), grid: g('grid'), user: g('user'),
      country: g('country'), installer: g('installer'), location: g('location') };
  }).filter((p) => p.name);
}

(async () => {
  const plants = readPlants(file);
  const R = T.CLIENT_REGISTER, base = T.BASES[R.base];
  const [reg, con, existing] = await Promise.all([all(base, R.clients), all(base, R.contracts), all(base, R.plants)]);
  const today = new Date().toISOString().slice(0, 10);

  // What each client is known by.
  const byEmail = new Map(), byNum = new Map(), byName = new Map();
  const add = (m, k, id) => { if (!k) return; m.set(k, (m.get(k) || new Set()).add(id)); };
  for (const c of reg) {
    add(byEmail, String(c.fields.Email || '').trim().toLowerCase(), c.id);
    add(byName, key(c.fields['Client Name']), c.id);
    for (const n of nums(c.fields['Palladium Code']).concat(nums(c.fields['Client Name']))) add(byNum, n, c.id);
  }
  for (const k of con) for (const n of nums(k.fields['Contract Number'])) for (const id of [].concat(k.fields.Client || [])) add(byNum, n, id);
  const regById = new Map(reg.map((c) => [c.id, c]));
  const one = (set) => (set && set.size === 1 ? [...set][0] : set && set.size > 1 ? 'MANY' : '');

  const results = plants.map((p) => {
    let id = '', how = '', many = false;
    const tryRule = (got, label) => { if (id || !got) return; if (got === 'MANY') { many = true; return; } id = got; how = label; };
    tryRule(isEmail(p.user) ? one(byEmail.get(p.user.toLowerCase())) : '', 'email');
    for (const n of nums(p.name)) tryRule(one(byNum.get(n)), 'number ' + n);
    // The plant name, then the plant name less a trailing word ("Victory Village Main").
    tryRule(one(byName.get(key(p.name))), 'name');
    tryRule(one(byName.get(key(p.name.replace(/\s+\S+$/, '')))), 'name');
    if (!id && p.location) {
      const loc = key(p.location);
      const hits = reg.filter((c) => { const s = key(c.fields.Sites); return s.length > 8 && loc.indexOf(s) === 0; });
      tryRule(hits.length === 1 ? hits[0].id : hits.length > 1 ? 'MANY' : '', 'location');
    }
    return { p, id, how, many: !id && many };
  });

  // Plants loaded before, by name and login.
  const plantKey = (n, u) => key(n) + '|' + String(u || '').toLowerCase();
  const prior = new Map(existing.map((r) => [plantKey(r.fields['Plant Name'], r.fields['User Name']), r]));
  const fieldsOf = (x) => {
    const f = { 'Plant Name': x.p.name, 'Imported': today };
    if (x.p.type) f['Plant Type'] = x.p.type;
    if (x.p.user) f['User Name'] = x.p.user;
    if (x.p.location) f.Location = x.p.location;
    if (x.p.installer) f['Installer / Distributor'] = x.p.installer;
    if (x.p.country) f['Country / Region'] = x.p.country;
    const st = [x.p.status && 'Plant ' + x.p.status, x.p.grid && x.p.grid !== '--' && 'grid ' + x.p.grid].filter(Boolean).join(', ');
    if (st) f['Status at Import'] = st;
    if (x.id) {
      f.Client = [x.id];
      const cn = nums(x.p.name)[0];
      if (cn) f['Contract Number'] = cn;
    }
    return f;
  };
  const creates = [], updates = [], fills = new Map();
  for (const x of results) {
    const old = prior.get(plantKey(x.p.name, x.p.user));
    const f = fieldsOf(x);
    if (old) {
      // A plant somebody linked by hand keeps that link.
      if ([].concat(old.fields.Client || []).length) delete f.Client;
      updates.push({ id: old.id, fields: f });
    } else creates.push({ fields: f });
    if (x.id) {
      const c = regById.get(x.id), fill = fills.get(x.id) || {};
      if (!String(c.fields.Email || '').trim() && isEmail(x.p.user) && !fill.Email) fill.Email = x.p.user.toLowerCase();
      if (!String(c.fields.Sites || '').trim() && x.p.location && !fill.Sites) fill.Sites = x.p.location;
      if (Object.keys(fill).length) fills.set(x.id, fill);
    }
  }

  // ── report ─────────────────────────────────────────────────────────────
  const L = [];
  L.push('SOLAX PLANTS -> CLIENT REGISTER -- ' + (APPLY ? 'APPLIED' : 'DRY RUN, nothing written'));
  L.push('');
  L.push('Export: ' + plants.length + ' plants. Register: ' + reg.length + ' clients, ' + existing.length + ' plants already loaded.');
  L.push('  matched to a client ............. ' + results.filter((x) => x.id).length);
  for (const h of ['email', 'number', 'name', 'location']) L.push('      by ' + h.padEnd(9, '.') + ' ' + results.filter((x) => x.how.startsWith(h)).length);
  L.push('  more than one client fits ....... ' + results.filter((x) => x.many).length + '  (loaded unlinked)');
  L.push('  no client found ................. ' + results.filter((x) => !x.id && !x.many).length + '  (loaded unlinked)');
  L.push('  plants to create / update ....... ' + creates.length + ' / ' + updates.length);
  L.push('  clients given an email / address  ' + [...fills.values()].filter((f) => f.Email).length + ' / ' + [...fills.values()].filter((f) => f.Sites).length);
  L.push('');
  L.push('MATCHED');
  results.filter((x) => x.id).forEach((x) => L.push('  ' + x.p.name + '  ->  ' + regById.get(x.id).fields['Client Name'] + '  [' + x.how + ']'));
  L.push('');
  L.push('NOT LINKED -- link these by hand in the SolaX Plants table');
  results.filter((x) => !x.id).forEach((x) => L.push('  ' + x.p.name + (x.p.user ? '  (' + x.p.user + ')' : '') + (x.many ? '  -- more than one client fits' : '')));
  L.push('');
  L.push('CLIENT DETAILS FILLED (blanks only)');
  for (const [id, f] of fills) L.push('  ' + regById.get(id).fields['Client Name'] + ': ' + Object.entries(f).map(([k, v]) => k + ' "' + v + '"').join(', '));
  const text = L.join('\n') + '\n';
  if (reportAt) { fs.writeFileSync(reportAt, text); console.log(L.slice(0, 12).join('\n')); console.log('report written to ' + reportAt); }
  else console.log(text);

  if (!APPLY) return;
  const send = async (method, table, recs) => {
    let n = 0;
    for (let i = 0; i < recs.length; i += 10) n += (await call(method, base + '/' + table, { records: recs.slice(i, i + 10), typecast: false })).records.length;
    return n;
  };
  console.log('plants created: ' + await send('POST', R.plants, creates));
  console.log('plants updated: ' + await send('PATCH', R.plants, updates));
  console.log('clients filled: ' + await send('PATCH', R.clients, [...fills].map(([id, fields]) => ({ id, fields }))));
})().catch((e) => { console.error(e.message); process.exit(1); });
