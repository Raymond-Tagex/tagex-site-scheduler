#!/usr/bin/env node
// /api/expenses: the claim workflow as the server enforces it. Airtable, the session and the
// audit log are stubbed; the permission engine and the claim rules are the real ones.
//
//   node test/verify-expenses-route.js

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
const X = T.EXPENSES;
const OM = T.BASES.OM;
const JC_TBL = T.resolve('OM', 'job_cards').tableId;
// Field ids the route uses (api/expenses.js). Repeated here on purpose: a test that imported
// them could not notice them changing.
const C = { email: 'fldPo0JSXvwrhnyV7', status: 'fldr8qYMCYHDZNODn', items: 'fld4JsJ5MyOUmkOpZ', history: 'fldigzdjdu3hOMuFy',
  approved: 'fld8WOKzJlNVPBVjI', jobcard: 'fldbzGvlYRUj2dbLW', requestId: 'fldrG6c6rdEF3R4ci', dup: 'fldv6kZ71WEkO6Bsi' };
const I = { claim: 'fldnHEzdZh3zskuOf', removed: 'fldWGZdU92yOWb5Gs', dup: 'fld7XkDVqew6O9Ibc', amount: 'fldXbfz3h9Pyc9y1a' };
const HX = { claim: 'fldHDWyLv11pvICHf', event: 'fldB05LHl6cKTlVV8' };
const CAT = { name: 'fldZuCAjblcOmTx2V', active: 'fldJiWX0NcF2QwlyU', sort: 'fldQ1IbETc0GplLA5' };

// ── the stubbed world ──────────────────────────────────────────────────────
let DB, SEQ, DESTROYED, AUDIT;
const tbl = (id) => (DB[id] || (DB[id] = []));
function reset() {
  SEQ = 0; DESTROYED = 0; AUDIT = [];
  DB = {
    [X.categories]: [
      { id: 'recCATFUEL0000001', fields: { [CAT.name]: 'Fuel', [CAT.active]: true, [CAT.sort]: 3 } },
      { id: 'recCATMEALS000001', fields: { [CAT.name]: 'Meals', [CAT.active]: true, [CAT.sort]: 4 } },
      { id: 'recCATOLD00000001', fields: { [CAT.name]: 'Old', [CAT.active]: false, [CAT.sort]: 9 } },
    ],
    [X.claims]: [], [X.items]: [], [X.history]: [],
    [JC_TBL]: [
      { id: 'recJCEASYGREENS01', fields: { 'JC Reference': 'JC-0101', Title: 'Easygreens install', 'Client Name': ['Easygreens'], 'Site / Address': 'Meyerton', Status: 'In Progress', Budget: 99999 } },
      { id: 'recJCKOFFIEWATER1', fields: { 'JC Reference': 'JC-0102', Title: 'Koffiewater service', 'Client Name': ['J vd Merwe'], Status: 'Open' } },
    ],
  };
}
// The formulas the route writes, read back the way Airtable would.
function matches(r, f) {
  if (!f) return true;
  const ids = [...f.matchAll(/RECORD_ID\(\) = "(rec\w+)"/g)].map((m) => m[1]);
  if (ids.length && !ids.includes(r.id)) return false;
  const em = /LOWER\(\{Employee Email\}\) = "([^"]*)"/.exec(f);
  if (em && String(r.fields[C.email] || '').toLowerCase() !== em[1]) return false;
  const st = /\{Claim Status\} = "([^"]*)"/.exec(f);
  if (st && r.fields[C.status] !== st[1]) return false;
  const rq = /\{Request ID\} = "([^"]*)"/.exec(f);
  if (rq && r.fields[C.requestId] !== rq[1]) return false;
  return true;
}
// Airtable keeps both ends of a link; the stub does the same for the three child tables.
function linkBack(tableId, rec) {
  const pairs = { [X.items]: [I.claim, C.items], [X.history]: [HX.claim, C.history] };
  const p = pairs[tableId];
  if (!p) return;
  for (const cid of rec.fields[p[0]] || []) {
    const c = tbl(X.claims).find((x) => x.id === cid);
    c.fields[p[1]] = (c.fields[p[1]] || []).concat(rec.id);
  }
}
const stub = (file, exports) => {
  const id = require.resolve(api(file));
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
stub('_lib/airtable.js', {
  async list(baseId, tableId, params) {
    return JSON.parse(JSON.stringify(tbl(tableId).filter((r) => matches(r, params && params.filterByFormula))));
  },
  async get(baseId, tableId, recordId) {
    const r = tbl(tableId).find((x) => x.id === recordId);
    if (!r) { const e = new Error('NOT_FOUND'); e.status = 404; throw e; }
    return JSON.parse(JSON.stringify(r));
  },
  async findOne(baseId, tableId, formula) {
    return tbl(tableId).find((r) => matches(r, formula)) || null;
  },
  async create(baseId, tableId, list) {
    return list.map((fields) => {
      const rec = { id: 'recNEW' + String(++SEQ).padStart(11, '0'), fields: { ...fields } };
      tbl(tableId).push(rec);
      linkBack(tableId, rec);
      return rec;
    });
  },
  async update(baseId, tableId, recordId, fields) {
    const r = tbl(tableId).find((x) => x.id === recordId);
    Object.assign(r.fields, fields);
    return r;
  },
  async destroy() { DESTROYED++; },
});
let WHO = null;
stub('_lib/session.js', {
  async authenticate() { return WHO; }, clientIp: () => '127.0.0.1', userAgent: () => 'verify',
  mustEnrolMfa: () => false,
});
stub('_lib/audit.js', { audit: (e) => AUDIT.push(e), auditNow: async (e) => { AUDIT.push(e); } });
const P = require(api('_lib/permissions.js'));
const handler = require(api('expenses.js'));

const ALL = { view: true, create: true, edit: true, delete: false, export: true };
const READ = { view: true, create: false, edit: false, delete: false, export: false };
const person = (email, name, modules) => ({ ok: true, email, userRecordId: 'recUSER' + email.slice(0, 10).replace(/\W/g, 'x').padEnd(10, 'x'),
  sid: 'sid-' + email, role: {}, user: { Email: email, 'Full Name': name },
  perms: P.effectivePermissions(JSON.stringify(modules), null) });
const DYLAN = person('dylan@tagexenergy.co.za', 'Dylan', { expenses: ALL, job_cards: READ });
const HENNIE = person('hennie@tagexenergy.co.za', 'Hennie', { expenses: ALL, job_cards: READ });
const MAURICE = person('maurice@tagexenergy.co.za', 'Maurice', { expenses: ALL, job_cards: READ,
  expense_approval: { view: true, create: false, edit: true, delete: false, export: false } });
const CHANE = person('chane@tagexenergy.co.za', 'Chane', { expenses: READ, job_cards: READ,
  expense_approval: { ...READ }, project_costing: READ });
const NOBODY = person('stores@tagexenergy.co.za', 'Stores', { job_cards: READ });

const call = async (as, body) => {
  WHO = as;
  const res = { code: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; },
    send(b) { this.body = JSON.parse(b); return this; }, end() { return this; } };
  await handler({ method: 'POST', body, headers: {}, url: '/api/expenses' }, res);
  return res;
};
const events = (claimId) => tbl(X.history).filter((h) => (h.fields[HX.claim] || []).includes(claimId)).map((h) => h.fields[HX.event]);
const line = (o) => ({ date: '2026-10-26', categoryId: 'recCATFUEL0000001', supplier: 'Engen', description: 'Diesel', amount: 879, ...o });

(async () => {
  reset();
  console.log('\n\x1b[1mACCESS\x1b[0m');
  let r = await call(NOBODY, { op: 'init' });
  t('a role with no expense module is refused', [r.code, r.body.reason], [403, 'module_denied']);
  r = await call(DYLAN, { op: 'init' });
  t('an employee sees only active categories', r.body.categories.map((c) => c.name), ['Fuel', 'Meals']);
  t('and may claim but not approve', [r.body.can.create, r.body.can.approve, r.body.can.jobcardTotals], [true, false, false]);
  r = await call(DYLAN, { op: 'get', claimId: 'tblz6IE6BOL0S71Kv' });
  t('a table id in the request is refused before anything else', [r.code, r.body.reason], [400, 'raw_id_rejected']);

  console.log('\n\x1b[1mJOB CARDS\x1b[0m');
  r = await call(DYLAN, { op: 'jobcards', q: 'easy' });
  t('job cards are searched by title or client', r.body.jobcards.map((j) => j.ref), ['JC-0101']);
  t('and never carry money', 'Budget' in r.body.jobcards[0] || JSON.stringify(r.body).includes('99999'), false);

  console.log('\n\x1b[1mA DRAFT\x1b[0m');
  r = await call(DYLAN, { op: 'save', requestId: 'req-1', claim: { claimDate: '2026-10-26', jobcardId: 'recJCEASYGREENS01', description: 'Fuel' },
    lines: [line(), line({ amount: 621, description: 'Diesel, own funds', supplier: 'Shell' })] });
  t('a claim is created as a draft', [r.code, r.body.claim.status], [200, 'Draft']);
  const D1 = r.body.claim.id;
  t('with its lines and their total', [r.body.lines.length, r.body.claim.total], [2, 1500]);
  t('linked to the job card chosen', [r.body.claim.jobcardId, r.body.claim.jobcardRef], ['recJCEASYGREENS01', 'JC-0101']);
  t('owned by the signed-in employee', tbl(X.claims).find((c) => c.id === D1).fields[C.email], 'dylan@tagexenergy.co.za');
  t('and its creation is in the history', events(D1), ['Create']);
  r = await call(DYLAN, { op: 'save', requestId: 'req-1', claim: { claimDate: '2026-10-26' }, lines: [line()] });
  t('a retry with the same request id returns the first claim', [r.body.claim.id, tbl(X.claims).length], [D1, 1]);
  r = await call(DYLAN, { op: 'save', claimId: D1, lines: [line({ amount: -5 })] });
  t('a negative amount is refused', r.code, 400);
  r = await call(DYLAN, { op: 'save', claimId: D1, lines: [line({ categoryId: 'recCATNOPE0000001' })] });
  t('an unknown category is refused', r.code, 400);

  console.log('\n\x1b[1mSEVERAL PEOPLE, ONE JOB CARD\x1b[0m');
  r = await call(HENNIE, { op: 'save', requestId: 'req-h', claim: { claimDate: '2026-10-27', jobcardId: 'recJCEASYGREENS01' },
    lines: [line({ amount: 250, categoryId: 'recCATMEALS000001', supplier: 'Spur', description: 'Lunch' })] });
  const H1 = r.body.claim.id;
  t('a second employee claims against the same job card', [r.code, r.body.claim.jobcardId], [200, 'recJCEASYGREENS01']);
  r = await call(DYLAN, { op: 'list' });
  t('each employee lists only their own claims', r.body.claims.map((c) => c.id), [D1]);
  r = await call(DYLAN, { op: 'get', claimId: H1 });
  t('and cannot open another’s, which reads as not found', [r.code, r.body.reason], [404, 'not_found']);
  r = await call(DYLAN, { op: 'save', claimId: H1, lines: [line()] });
  t('nor change it', r.code, 404);
  r = await call(MAURICE, { op: 'list', jobcardId: 'recJCEASYGREENS01' });
  t('an approver sees everyone’s claims on the job card', r.body.claims.map((c) => c.id).sort(), [D1, H1].sort());
  t('but not the job card total, which is job card money', r.body.jobcardTotal, null);
  r = await call(CHANE, { op: 'list', jobcardId: 'recJCEASYGREENS01' });
  t('the job card total is for the four (project_costing)', [r.body.jobcardTotal.claims, r.body.jobcardTotal.employees], [2, 2]);
  t('and drafts are not counted as submitted', r.body.jobcardTotal.submitted, 0);

  console.log('\n\x1b[1mSUBMIT\x1b[0m');
  r = await call(DYLAN, { op: 'submit', claimId: D1 });
  t('submitting needs the declaration', [r.code, r.body.reason], [400, 'declaration_required']);
  r = await call(DYLAN, { op: 'submit', claimId: D1, declaration: true });
  t('then the claim awaits approval', [r.code, r.body.claim.status], [200, 'Awaiting Approval']);
  r = await call(DYLAN, { op: 'submit', claimId: D1, declaration: true });
  t('a double tap does not submit twice', events(D1).filter((e) => e === 'Submit').length, 1);
  r = await call(DYLAN, { op: 'save', claimId: D1, lines: [line({ amount: 5000 })] });
  t('a submitted claim is locked to its employee', [r.code, r.body.reason], [409, 'locked']);
  r = await call(HENNIE, { op: 'submit', claimId: H1, declaration: true });
  r = await call(CHANE, { op: 'list', jobcardId: 'recJCEASYGREENS01' });
  t('submitted totals now count, from the lines', r.body.jobcardTotal.submitted, 1750);

  console.log('\n\x1b[1mREVIEW\x1b[0m');
  r = await call(DYLAN, { op: 'review', claimId: D1, action: 'approve' });
  t('an employee cannot approve their own claim', [r.code, r.body.reason], [403, 'own_claim']);
  r = await call(HENNIE, { op: 'review', claimId: D1, action: 'approve' });
  t('nor can a colleague without approval rights (cannot even see it)', r.code, 404);
  r = await call(MAURICE, { op: 'review', claimId: D1, action: 'reject' });
  t('a rejection needs a reason', [r.code, r.body.reason], [400, 'reason_required']);
  r = await call(MAURICE, { op: 'review', claimId: D1, action: 'reject', comment: 'No slip for the R621' });
  t('with one, the claim is rejected', [r.body.claim.status, r.body.claim.comment], ['Rejected', 'No slip for the R621']);
  r = await call(DYLAN, { op: 'save', claimId: D1, lines: [{ ...line({ amount: 621 }), id: r.body.lines[1].id, receiptNumber: 'SH-4471' }] });
  t('the employee may correct a rejected claim', r.code, 200);
  r = await call(DYLAN, { op: 'submit', claimId: D1, declaration: true });
  t('and resubmit it', r.body.claim.status, 'Awaiting Approval');
  r = await call(MAURICE, { op: 'review', claimId: D1, action: 'approve', approvedAmount: 99999 });
  t('an approval above the claim total is refused', r.code, 400);
  r = await call(MAURICE, { op: 'review', claimId: D1, action: 'approve' });
  t('approval sets the approved amount to the total', [r.body.claim.status, r.body.claim.totalApproved], ['Approved', 1500]);
  t('and never marks the claim paid', [r.body.claim.status === 'Paid', r.body.claim.totalPaid], [false, 0]);
  // The two refused saves (negative amount, unknown category) left no event: nothing changed.
  t('the whole path is in the history', events(D1), ['Create', 'Submit', 'Reject', 'Save', 'Submit', 'Approve']);
  r = await call(DYLAN, { op: 'save', claimId: D1, lines: [line()] });
  t('an approved claim cannot be changed by its employee', r.code, 409);

  console.log('\n\x1b[1mDUPLICATES AND REMOVING A LINE\x1b[0m');
  r = await call(DYLAN, { op: 'save', requestId: 'req-2', claim: { claimDate: '2026-10-28', jobcardId: 'recJCEASYGREENS01' },
    lines: [line(), line({ amount: 48, supplier: 'Bakwena', description: 'Toll', categoryId: 'recCATFUEL0000001' })] });
  const D2 = r.body.claim.id;
  t('a line matching one on an earlier claim is flagged, not refused', [r.code, r.body.lines[0].duplicate, r.body.lines[1].duplicate], [200, true, false]);
  t('and the claim carries the warning', r.body.claim.duplicate, true);
  const dupeLine = r.body.lines[0].id;
  r = await call(DYLAN, { op: 'remove_line', claimId: D2, itemId: dupeLine });
  t('removing a line needs a reason', [r.code, r.body.reason], [400, 'reason_required']);
  r = await call(DYLAN, { op: 'remove_line', claimId: D2, itemId: dupeLine, reason: 'Duplicate of ES-202610-003' });
  t('with one, the line is marked removed', r.body.lines.find((l) => l.id === dupeLine).removed, true);
  t('it is kept, not deleted', [DESTROYED, tbl(X.items).some((x) => x.id === dupeLine)], [0, true]);
  t('the total leaves it out', r.body.claim.total, 48);
  t('the duplicate warning clears', r.body.claim.duplicate, false);
  t('and the removal is logged with its reason', r.body.history.filter((h) => h.event === 'Remove Line').map((h) => /Duplicate of ES-202610-003/.test(h.comment)), [true]);
  r = await call(HENNIE, { op: 'remove_line', claimId: D2, itemId: r.body.lines[1].id, reason: 'x' });
  t('another employee cannot remove it', r.code, 404);
  r = await call(DYLAN, { op: 'remove_line', claimId: D1, itemId: tbl(X.claims).find((c) => c.id === D1).fields[C.items][0], reason: 'oops' });
  t('nor can the employee once the claim is approved', r.code, 403);

  console.log('\n\x1b[1mEXPORT\x1b[0m');
  r = await call(DYLAN, { op: 'export', claimId: D1 });
  t('the employee downloads the TAGEX sheet', [r.code, /^TAGEX_ExpenseClaim_.+\.xlsx$/.test(r.body.filename), r.body.base64.slice(0, 4)], [200, true, 'UEsD']);
  r = await call(HENNIE, { op: 'export', claimId: D1 });
  t('a colleague cannot download it', r.code, 404);
  r = await call(DYLAN, { op: 'save', requestId: 'req-3', claim: { claimDate: '2026-10-29' },
    lines: Array.from({ length: 8 }, (_, i) => line({ amount: 10 + i, supplier: 'S' + i })) });
  r = await call(DYLAN, { op: 'export', claimId: r.body.claim.id });
  t('a claim too long for the sheet says so', [r.code, r.body.reason], [400, 'too_many_lines']);

  console.log('\n\x1b[1mAUDIT\x1b[0m');
  t('refusals are audited', AUDIT.some((a) => a.result === 'Denied' && a.denialReason === 'own_claim'), true);
  t('downloads are audited', AUDIT.some((a) => a.action === 'Export' && a.result === 'Allowed'), true);

  console.log(`\n${n - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
