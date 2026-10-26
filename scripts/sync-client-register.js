#!/usr/bin/env node
// Copy the client register (TAGEX Clients base) down to each operating base's Clients table.
//
//   node scripts/sync-client-register.js [--overwrite] [--names] [--report <file>] [--apply]
//
// Dry run by default: it writes nothing and lists every change it would make, old and new.
//
// BLANKS ARE FILLED; DIFFERENCES ARE REPORTED. Contact Person, Mobile Number, Email and Sites go
// from the register to every mirror row whose Master Client ID names the client -- but only into
// an empty field. Where the mirror already says something else, the difference is listed for a
// person and the mirror is left alone. The first dry run showed why: the register's details came
// from whichever O&M row was read first, and writing them over the bases would have turned
// "Sharon" into "Unknown" and full addresses into a suburb. Once the register has been checked,
// --overwrite makes it win outright. A field empty in the register is never written either way.
//
// NAMES ONLY WITH --names. Many register names were taken from the cost log as typed there
// ("Norma-Jean System-->Carlien Cotzer"), and a mirror's name is what every job card, delivery
// note and ticket in that base shows. Tidy the register's names first, then sync them.
//
// "Use In" says which bases need a copy. A client listed for a base it has no row in gets one
// there, stamped, and the register records it. A base already holding the client is added to
// Use In; one taken out of Use In keeps its row -- nothing is ever deleted (CLAUDE.md rule 10).
//
// Mirror rows with no Master Client ID, or one naming no register client, are reported and
// left alone. `node scripts/load-client-register.js --apply` adopts them into the register.

'use strict';

const fs = require('fs');
const T = require('../api/_lib/tables.js');
const { call, all, inTens } = require('./_airtable.js');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const NAMES = args.includes('--names');
const OVERWRITE = args.includes('--overwrite');
const reportAt = args.includes('--report') ? args[args.indexOf('--report') + 1] : null;

const BASES = ['CI', 'OM', 'RES'];
const DETAILS = ['Contact Person', 'Mobile Number', 'Email', 'Sites'];
const clientsTable = (sym) => T.TABLES.clients[sym === 'RES' ? 'OM' : sym];
const recIds = (v) => String(v || '').split(/,\s*/).map((s) => s.trim()).filter(Boolean);
const same = (a, b) => String(a || '').trim() === String(b || '').trim();
// A placeholder is not a value: "Unknown" copied into an empty Contact Person reads as a name.
const PLACEHOLDER = /^(unknown|n\/?a|none|tbc|tba|-+|\.+|\?+)$/i;
const real = (v) => { const s = String(v || '').trim(); return s && !PLACEHOLDER.test(s) ? s : ''; };
const short = (v) => JSON.stringify(String(v || '').replace(/\s*\n\s*/g, ' / ').slice(0, 80));

(async () => {
  const CLI = T.BASES.CLI;
  const meta = await call('GET', 'meta/bases/' + CLI + '/tables');
  const tClients = meta.tables.find((t) => t.name === 'Clients');
  if (!tClients || !tClients.fields.some((f) => f.name === 'Use In')) {
    throw new Error('Run scripts/provision-client-register.js --apply first');
  }
  const register = await all(CLI, tClients.id);
  const byId = new Map(register.map((r) => [r.id, r]));

  // What each mirror table can hold. C&I's Clients has no Mobile Number (FIELD_ALIASES), and a
  // field the table lacks is skipped rather than failing the batch.
  const mirrors = {}, fieldsOf = {};
  for (const sym of BASES) {
    const m = await call('GET', 'meta/bases/' + T.BASES[sym] + '/tables');
    fieldsOf[sym] = new Set(m.tables.find((t) => t.id === clientsTable(sym)).fields.map((f) => f.name));
    mirrors[sym] = await all(T.BASES[sym], clientsTable(sym));
  }

  const lines = [];
  const say = (s) => lines.push(s);
  const updates = { CI: [], OM: [], RES: [] };
  const creates = { CI: [], OM: [], RES: [] };
  const useInAdds = new Map();          // register id -> bases to add to Use In
  const orphans = [], differs = [];
  let nameDiffs = 0;

  for (const sym of BASES) {
    const cols = DETAILS.filter((d) => fieldsOf[sym].has(d));
    for (const row of mirrors[sym]) {
      const mid = String(row.fields['Master Client ID'] || '').trim();
      const master = mid && byId.get(mid);
      if (!master) { orphans.push(sym + ' ' + row.id + ' "' + (row.fields['Client Name'] || '') + '"' + (mid ? ' names ' + mid + ', not in the register' : ' has no Master Client ID')); continue; }
      const patch = {}, said = [];
      for (const d of cols) {
        const want = master.fields[d], have = row.fields[d];
        if (!real(want) || same(want, have)) continue;
        if (!real(have) || OVERWRITE) { patch[d] = want; said.push(d + ' ' + short(have) + ' -> ' + short(want)); }
        else differs.push(sym + ' ' + row.id + ' "' + (row.fields['Client Name'] || '') + '" ' + d + ': base ' + short(have) + ', register ' + short(want));
      }
      if (!same(master.fields['Client Name'], row.fields['Client Name'])) {
        nameDiffs++;
        if (NAMES) { patch['Client Name'] = master.fields['Client Name']; said.push('Client Name ' + short(row.fields['Client Name']) + ' -> ' + short(master.fields['Client Name'])); }
      }
      if (said.length) { updates[sym].push({ id: row.id, fields: patch }); say('  update ' + sym + ' ' + row.id + ': ' + said.join('; ')); }
      const useIn = [].concat(master.fields['Use In'] || []);
      if (!useIn.includes(sym)) useInAdds.set(master.id, (useInAdds.get(master.id) || new Set()).add(sym));
    }
  }

  // Bases a client is listed for but has no row in.
  for (const m of register) {
    if ((m.fields.Status || 'Active') !== 'Active') continue;
    for (const sym of [].concat(m.fields['Use In'] || [])) {
      if (!BASES.includes(sym)) continue;
      const has = mirrors[sym].some((r) => String(r.fields['Master Client ID'] || '').trim() === m.id);
      if (has) continue;
      const f = { 'Client Name': m.fields['Client Name'], 'Master Client ID': m.id };
      for (const d of DETAILS) if (fieldsOf[sym].has(d) && real(m.fields[d])) f[d] = m.fields[d];
      creates[sym].push({ master: m, fields: f });
      say('  create ' + sym + ': "' + m.fields['Client Name'] + '"');
    }
  }

  const head = [];
  head.push('CLIENT REGISTER SYNC -- ' + (APPLY ? 'APPLIED' : 'DRY RUN, nothing written') + (NAMES ? ', names included' : ''));
  head.push('');
  head.push('Register: ' + register.length + ' clients. Mirrors: CI ' + mirrors.CI.length + ', OM ' + mirrors.OM.length + ', RES ' + mirrors.RES.length + '.');
  for (const sym of BASES) head.push('  ' + sym + ': ' + updates[sym].length + ' rows to update, ' + creates[sym].length + ' to create');
  head.push('  Use In to add a base to: ' + useInAdds.size + ' clients');
  head.push('  details that differ, left as the base has them: ' + differs.length + (OVERWRITE ? '' : ' (--overwrite to write the register’s)'));
  head.push('  names that differ: ' + nameDiffs + (NAMES ? ' (being written)' : ' (left alone; --names to write them)'));
  head.push('  mirror rows not tied to the register: ' + orphans.length);
  head.push('');
  const text = head.concat(['CHANGES'], lines,
    ['', 'DETAILS THAT DIFFER -- settle in the register (or the base), then sync again'], differs.map((d) => '  ' + d),
    ['', 'NOT TIED TO THE REGISTER -- load-client-register.js --apply adopts these'], orphans.map((o) => '  ' + o)).join('\n') + '\n';
  if (reportAt) { fs.writeFileSync(reportAt, text); console.log(head.join('\n')); console.log('report written to ' + reportAt); }
  else console.log(text);

  if (!APPLY) return;

  for (const sym of BASES) {
    if (updates[sym].length) console.log(sym + ' updated: ' + (await inTens('PATCH', T.BASES[sym], clientsTable(sym), updates[sym])).length);
    if (!creates[sym].length) continue;
    const made = await inTens('POST', T.BASES[sym], clientsTable(sym), creates[sym].map((c) => ({ fields: c.fields })));
    console.log(sym + ' created: ' + made.length);
    // The register points back at the new row, beside any it already named.
    const back = made.map((r, i) => {
      const m = creates[sym][i].master;
      return { id: m.id, fields: { [sym + ' Client Record']: recIds(m.fields[sym + ' Client Record']).concat(r.id).join(', ') } };
    });
    await inTens('PATCH', CLI, tClients.id, back);
  }
  const useIn = [...useInAdds].map(([id, add]) => ({ id, fields: { 'Use In': [...new Set([].concat(byId.get(id).fields['Use In'] || []).concat([...add]))] } }));
  if (useIn.length) console.log('Use In widened: ' + (await inTens('PATCH', CLI, tClients.id, useIn)).length);
})().catch((e) => { console.error(e.message); process.exit(1); });
