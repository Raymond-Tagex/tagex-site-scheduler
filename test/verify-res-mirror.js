#!/usr/bin/env node
// RES mirrors O&M — node test/verify-res-mirror.js
//
// The RES base is a structure-only duplicate of O&M, and tables.js gives RES every O&M table
// id, field alias and record-scope field on that basis (mirrorOmToRes). Two things can make that
// wrong, and this checks both:
//
//   1. The mapping itself (offline, always runs): RES resolves exactly where O&M does, to the same
//      ids, and nowhere O&M does not -- C&I-only FICA data above all.
//   2. The bases themselves (live, needs AIRTABLE_PAT): every table the app maps exists in RES
//      under the same id and name, with every field O&M has. A field added to O&M and not to RES
//      is how a mirrored scope or permission rule would silently stop biting there.
//
// Without a token the live section prints SKIPPED. A skipped section is not a passing one.

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const T = require(path.join(ROOT, 'api', '_lib', 'tables.js'));

let pass = 0, fail = 0;
const failures = [];
function t(label, ok, detail) {
  if (ok) pass++; else { fail++; failures.push(label + (detail ? `\n      ${detail}` : '')); }
  console.log(`  ${ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 1. the mapping ──────────────────────────────────────────────────────────
console.log('\n\x1b[1mTHE MAPPING\x1b[0m');
t('RES is an operations base', same(T.OPS_BASES, ['CI', 'OM', 'RES']));
t('RES has its own base id, not O&M\'s', !!T.BASES.RES && T.BASES.RES !== T.BASES.OM && /^app[A-Za-z0-9]{14}$/.test(T.BASES.RES),
  `BASES.RES = ${T.BASES.RES}`);

const modules = Object.keys(T.TABLES);
// OM_ONLY modules are one store for every base, held in O&M on purpose (tables.js).
const omModules = modules.filter((m) => T.TABLES[m].OM && !T.OM_ONLY.has(m));
t('only restricted personal data and the subscriber contracts are O&M-only', same([...T.OM_ONLY], ['restricted_personal', 'subscribers']));
t('and it is not mirrored', T.TABLES.restricted_personal.RES === undefined
  && !T.resolve('RES', 'restricted_personal', 'fica_documents').ok && T.TABLES.subscribers.RES === undefined && !T.resolve('RES', 'subscribers').ok);
t('every O&M module resolves in RES', omModules.every((m) => T.resolve('RES', m, m === 'tickets' ? 'ticket' : null).ok),
  omModules.filter((m) => !T.resolve('RES', m, m === 'tickets' ? 'ticket' : null).ok).join(', '));
t('to the same table ids', omModules.every((m) => same(T.TABLES[m].RES, T.TABLES[m].OM)));
t('tickets keep both their sub-tables', same(Object.keys(T.TABLES.tickets.RES), ['ticket', 'spares']));
t('nothing resolves in RES that is not in O&M', modules.filter((m) => T.TABLES[m].RES && !T.TABLES[m].OM).length === 0);
t('FICA / restricted personal data is not reachable in RES',
  !T.TABLES.restricted_personal.RES && !T.resolve('RES', 'restricted_personal', 'financial_vetting').ok);
t('the identity tables are not reachable in RES', !T.resolve('RES', 'users').ok && !T.resolve('RES', 'sessions').ok);

for (const [m, entry] of Object.entries(T.SCOPE_FIELDS)) {
  for (const [kind, v] of Object.entries(entry || {})) {
    if (v && typeof v === 'object' && v.OM !== undefined) {
      t(`scope ${m}.${kind} is mirrored`, v.RES === v.OM, `RES=${v.RES} OM=${v.OM}`);
    }
  }
}
for (const [m, entry] of Object.entries(T.FIELD_ALIASES)) {
  if (entry.OM) t(`field aliases for ${m} are O&M's`, same(entry.RES, entry.OM));
}

// ── 3. the bases ────────────────────────────────────────────────────────────
function pat() {
  for (const f of ['.env.local', '.env']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, 'utf8').match(/^AIRTABLE_PAT=(.*)$/m);
    if (m && m[1].trim()) return m[1].trim().replace(/^"|"$/g, '');
  }
  return process.env.AIRTABLE_PAT || '';
}

async function schema(baseId, token) {
  const r = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status} reading ${baseId === T.BASES.RES ? 'RES' : 'O&M'} - is the base on the token?`);
  const d = await r.json();
  return Object.fromEntries((d.tables || []).map((x) => [x.id, x]));
}

// ── 2. the scheduler endpoints (offline) ────────────────────────────────────
// The job card form reads every table from the base the scheduler names. A stubbed Airtable
// records which base each read hit. (The ticket report has the same checks in its own suite.)
async function endpoints() {
  console.log('\n\x1b[1mTHE JOB CARD FORM, BY BASE\x1b[0m');
  process.env.AUTH_MODE = 'session';
  const api = (m) => path.join(ROOT, 'api', m);
  const stub = (file, exports) => {
    const id = require.resolve(api(file));
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  const READ = [];
  stub('_lib/airtable.js', {
    async list(baseId) { READ.push(baseId); return []; },
    async fieldMaps() { return { idToName: {}, nameToId: {} }; },
  });
  const P = require(api('_lib/permissions.js'));
  const perms = P.effectivePermissions(JSON.stringify({ job_cards: { view: true, export: true } }), null);
  stub('_lib/session.js', {
    async authenticate() { return { ok: true, email: 'ops@x', userRecordId: 'recUSER0000000000', sid: 'sid-res', perms }; },
    clientIp: () => '127.0.0.1', userAgent: () => 'verify',
  });
  stub('_lib/audit.js', { audit: () => {}, auditNow: async () => {} });
  const handler = require(api('jobcard-form.js'));
  const call = async (body) => {
    READ.length = 0;
    const res = { code: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; }, send() { return this; }, end() { return this; } };
    await handler({ method: 'POST', body, headers: {}, url: '/api/jobcard-form' }, res);
    return res;
  };
  const JC = 'recJC000000000001';
  await call({ jobCardId: JC });
  t('no base named reads O&M only', READ.length > 0 && READ.every((b) => b === T.BASES.OM), READ.join(','));
  await call({ jobCardId: JC, base: 'RES' });
  t('base RES reads RES only', READ.length > 0 && READ.every((b) => b === T.BASES.RES), READ.join(','));
  for (const bad of ['CI', 'IAM', 'res']) {
    const r = await call({ jobCardId: JC, base: bad });
    t(`base "${bad}" is refused before anything is read`, r.code === 400 && READ.length === 0, `HTTP ${r.code}, ${READ.length} reads`);
  }
}

(async () => {
  await endpoints();

  console.log('\n\x1b[1mTHE BASES (live)\x1b[0m');
  const token = pat();
  if (!token) {
    console.log('  \x1b[33mSKIPPED\x1b[0m  no AIRTABLE_PAT in .env.local, .env or the environment');
  } else {
    try {
      const [om, res] = await Promise.all([schema(T.BASES.OM, token), schema(T.BASES.RES, token)]);
      const ids = new Set();
      for (const m of omModules) {
        const v = T.TABLES[m].OM;
        for (const id of typeof v === 'string' ? [v] : Object.values(v)) ids.add(id);
      }
      for (const id of ids) {
        const a = om[id]; const b = res[id];
        if (!a) { t(`O&M has table ${id}`, false, 'mapped in tables.js but missing from O&M itself'); continue; }
        t(`RES has "${a.name}" under the same id`, !!b && b.name === a.name, b ? `RES calls it "${b.name}"` : 'missing');
        if (!b) continue;
        const have = new Set(b.fields.map((f) => `${f.name}|${f.type}`));
        const missing = a.fields.filter((f) => !have.has(`${f.name}|${f.type}`)).map((f) => f.name);
        t(`  and every O&M field, with the same type`, !missing.length, `missing or retyped in RES: ${missing.join(', ')}`);
      }
      const src = Object.values(res).find((x) => x.id === T.TABLES.site_information.RES);
      const sb = src && src.fields.find((f) => f.name === 'Source Base');
      t('RES Site Information "Source Base" offers "RES"', !!sb && (sb.options.choices || []).some((c) => c.name === 'RES'),
        'add the choice by hand in Airtable: the API cannot add select choices');
    } catch (e) {
      t('both bases are readable', false, e.message);
    }
  }

  console.log('');
  if (fail) {
    console.log(`\x1b[31m\x1b[1m  ${fail} FAILED\x1b[0m, ${pass} passed\n`);
    for (const f of failures) console.log(`  \x1b[31m*\x1b[0m ${f}`);
    process.exit(1);
  }
  console.log(`\x1b[32m\x1b[1m  ALL ${pass} ASSERTIONS PASSED\x1b[0m`);
})();
