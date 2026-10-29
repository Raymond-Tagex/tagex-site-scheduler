// /api/expenses — expense claims against job cards.
//
//   { op:'init' }                                      -> { me, can, categories }
//   { op:'jobcards', q }                               -> { jobcards:[…] }   job cards to claim against
//   { op:'list', jobcardId?, status? }                 -> { claims:[…], jobcardTotal? }
//   { op:'get', claimId }                              -> { claim, lines, history }
//   { op:'save', claimId?, requestId?, claim, lines }  -> { claim, lines, history }   a draft
//   { op:'submit', claimId, declaration }              -> …                          to the approver
//   { op:'review', claimId, action, comment?, approvedAmount? } -> …   approve / reject / request_info
//   { op:'remove_line', claimId, itemId, reason }      -> …   a duplicate or wrong line, logged
//   { op:'export', claimId }                           -> { filename, base64 }       the TAGEX sheet
//
// WHY AN ENDPOINT AND NOT THE PROXY. A claim's status, approved amount and payment must only move
// the way _lib/expenses.js allows: an employee may not approve their own claim, approving never
// marks it paid, a rejection carries a reason. /api/at writes any field a role may edit, so the
// expense tables are not in its whitelist at all (T.EXPENSES), and every change comes through here.
//
// WHO SEES WHAT. Money is personal and the job card money rule (CLAUDE.md) applies:
//   expenses:view/create/edit/export   your own claims
//   expense_approval:view / :edit      every claim / approve, reject, ask for information
//   project_costing:view               the total claimed against a job card across everyone
// Record scope is deliberately not used: most roles run at All Records, which would show every
// employee's claims to every technician.
//
// NOTHING IS DELETED (CLAUDE.md rule 10). Removing a line ticks Removed, keeps the row and writes
// a Remove Line event to Expense Approval History.

'use strict';

const at = require('./_lib/airtable.js');
const S = require('./_lib/session.js');
const H = require('./_lib/http.js');
const A = require('./_lib/audit.js');
const T = require('./_lib/tables.js');
const P = require('./_lib/permissions.js');
const E = require('./_lib/expenses.js');
const X = require('./_lib/expensesheet.js');

const X_ = T.EXPENSES;
const BASE = () => T.BASES[X_.base];

// Field ids (see T.EXPENSES). Formulas below use names, which Airtable formulas require.
const C = Object.freeze({
  seq: 'fldUaaLyFnFOFpk7I', ref: 'fldPOc7KK0JMYrE22', date: 'fld9IxwO9Cdoh0doJ',
  empName: 'fldxiLYtOoDHyLcOJ', empEmail: 'fldPo0JSXvwrhnyV7', empId: 'fldTpqICLkdg1sgbm',
  desc: 'fldbw0NfqBQm9cluK', payMethod: 'fldpGFNNcjVhfMYLN', type: 'fldNOGYoq25njO4RH',
  km: 'fld0MFJcXxQre7R5c', advances: 'fldu1DLTU8cIVTHTq', approved: 'fld8WOKzJlNVPBVjI',
  status: 'fldr8qYMCYHDZNODn', comment: 'fldCNI3SaCUisRKaz', submittedAt: 'fldYfKlHw1OJ5ZEgN',
  submittedBy: 'fld3vFVRzk2GKqifR', reviewedBy: 'fldUvB6MOae5R7kGh', reviewedAt: 'flddtIn5XtYHbFVdt',
  dup: 'fldv6kZ71WEkO6Bsi', changedBy: 'fldQHlUVU4KaTWZ3J', jobcard: 'fldbzGvlYRUj2dbLW',
  client: 'fldwVsbgughy8BOYt', project: 'flddRJtJykz3nFYBx', legacyRef: 'fldWzROaNwbBLxfI0',
  items: 'fld4JsJ5MyOUmkOpZ', history: 'fldigzdjdu3hOMuFy', totalPaid: 'fldjQ6BKCTwa7LOhy',
  requestId: 'fldrG6c6rdEF3R4ci',
});
const I = Object.freeze({
  seq: 'fldecDXboUxeBXnjE', date: 'fldb746avc7Ul9GL2', supplier: 'fldkhgBSezmSEfYKt',
  desc: 'fldJ6jnAgSPp6FZI2', receiptNo: 'fldL6f2DjAb5xAKUZ', amount: 'fldXbfz3h9Pyc9y1a',
  receiptAttached: 'fldLMdxkBEYdBmBEn', dup: 'fld7XkDVqew6O9Ibc', dupNote: 'fld6Lf4VlNvpc2tIw',
  sort: 'fldkBTklgeTK5rHBh', claim: 'fldnHEzdZh3zskuOf', category: 'fldcIZsq7VgO1xUXY',
  removed: 'fldWGZdU92yOWb5Gs', removedReason: 'fldIus6HXdnYa8Mj9', removedBy: 'fldgvw0MlnIb4jnv1',
});
const HX = Object.freeze({
  event: 'fldB05LHl6cKTlVV8', prev: 'fldQu60ngN02kYsXq', next: 'fldqHxoyPo58yk6gk',
  byEmail: 'fldiVpJ7Ax0e0vyCK', byName: 'fldZZQOnQ79t51OBx', comment: 'fldBZIRm85c2GzTK9',
  claim: 'fldHDWyLv11pvICHf', at: 'fldNCQz8nZKYf1lxQ', item: 'fldUuswaTk4RoU5GT',
});
const CAT = Object.freeze({ name: 'fldZuCAjblcOmTx2V', active: 'fldJiWX0NcF2QwlyU', sort: 'fldQ1IbETc0GplLA5' });

const REC_RE = /^rec[A-Za-z0-9]{14}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CLAIM_TYPES = ['Fuel', 'Travel', 'Accommodation', 'Meals', 'Site Purchases', 'Other'];
const PAY_METHODS = ['Transfer', 'Cash', 'Company Card'];
// What an employee may still change. Everything else belongs to the approver or Finance.
const EDITABLE = [E.STATUS.DRAFT, E.STATUS.REJECTED, E.STATUS.INFO_REQUESTED];
// Receipts are required at or above this amount (rand). Not enforced until TAGEX sets the rule;
// a business rule, so it lives here and not in the UI.
const RECEIPT_THRESHOLD = Infinity;
const MAX_LINES = 60;

const str = (v, max = 500) => (v == null ? '' : String(v).trim()).slice(0, max);
const ids = (v) => [].concat(v || []).filter((x) => REC_RE.test(String(x)));
const byId = { returnFieldsByFieldId: true };

class Refusal extends Error {
  constructor(status, reason, detail) { super(detail); this.status = status; this.reason = reason; }
}
const refuse = (status, reason, detail) => { throw new Refusal(status, reason, detail); };

module.exports = async function handler(req, res) {
  if (!H.methodGuard(req, res, 'POST')) return;
  if (!H.sessionModeGuard(res)) return;

  let body;
  try { body = await H.readBody(req); } catch (e) { return H.fail(res, 400, e.code || 'bad_request', e.message); }

  // Symbols only, as at /api/at, and before authentication. Record ids are fine.
  if (T.findRawIdInRequest(body)) return H.fail(res, 400, 'raw_id_rejected', 'This API accepts symbolic names only.');

  const op = str(body.op, 20);
  const OPS = ['init', 'jobcards', 'list', 'get', 'save', 'submit', 'review', 'remove_line', 'export'];
  if (!OPS.includes(op)) return H.fail(res, 400, 'unknown_op', 'Unknown operation.');
  const action = { init: 'View', jobcards: 'View', list: 'View', get: 'View', export: 'Export' }[op] || 'Update';

  const auth = await S.authenticate(req);
  if (!auth.ok) {
    await A.auditNow({ action, result: 'Denied', denialReason: auth.reason, module: 'expenses',
      ip: S.clientIp(req), userAgent: S.userAgent(req), detail: auth.detail });
    return H.fail(res, auth.status, auth.reason, auth.detail);
  }
  const ctx = { userEmail: auth.email, userRecordId: auth.userRecordId, sessionId: auth.sid,
    ip: S.clientIp(req), userAgent: S.userAgent(req), module: 'expenses', baseSymbol: X_.base, table: 'expense_claims' };

  if (auth.user['Must Change Password'] === true) {
    await A.auditNow({ ...ctx, action, result: 'Denied', denialReason: 'password_change_required' });
    return H.fail(res, 403, 'password_change_required', 'You must set a new password before continuing.');
  }
  if (S.mustEnrolMfa(auth.role, auth.user)) {
    await A.auditNow({ ...ctx, action, result: 'Denied', denialReason: 'mfa_enrolment_required' });
    return H.fail(res, 403, 'mfa_enrolment_required', 'Two-factor authentication is mandatory for administrators.');
  }
  const rl = H.sessionRateLimit(auth.sid);
  if (!rl.ok) {
    await A.auditNow({ ...ctx, action, result: 'Denied', denialReason: 'rate_limited' });
    return H.tooManyRequests(res, rl.retryAfter);
  }

  const has = (m, o) => P.can(auth.perms, m, o).ok;
  const can = {
    view: has('expenses', 'view'),
    create: has('expenses', 'create'),
    edit: has('expenses', 'edit'),
    export: has('expenses', 'export'),
    seeAll: has('expense_approval', 'view'),
    approve: has('expense_approval', 'edit'),
    jobcardTotals: has('project_costing', 'view'),
    jobcards: has('job_cards', 'view'),
  };
  if (!can.view && !can.seeAll) {
    await A.auditNow({ ...ctx, action, result: 'Denied', denialReason: 'module_denied' });
    return H.fail(res, 403, 'module_denied', 'Your role has no access to expense claims.');
  }
  const me = { email: String(auth.email || '').toLowerCase(), name: str(auth.user['Full Name'], 200) || auth.email, id: auth.userRecordId };

  try {
    const out = await run(op, body, { can, me, ctx, auth });
    return H.ok(res, out);
  } catch (e) {
    if (e instanceof Refusal) {
      await A.auditNow({ ...ctx, action, result: 'Denied', denialReason: e.reason, detail: e.message.slice(0, 200) });
      return H.fail(res, e.status, e.reason, e.message);
    }
    await A.auditNow({ ...ctx, action, result: 'Denied', denialReason: 'error', detail: String(e.message || e).slice(0, 200) });
    return H.fail(res, e.status && e.status < 500 ? 400 : 502, 'expenses_unavailable', 'Expense claims could not be reached. Try again.');
  }
};

async function run(op, body, env) {
  switch (op) {
    case 'init': return init(env);
    case 'jobcards': return jobcards(body, env);
    case 'list': return listClaims(body, env);
    case 'get': return getClaim(str(body.claimId, 20), env);
    case 'save': return save(body, env);
    case 'submit': return submit(body, env);
    case 'review': return review(body, env);
    case 'remove_line': return removeLine(body, env);
    case 'export': return exportSheet(body, env);
    default: return refuse(400, 'unknown_op', 'Unknown operation.');
  }
}

// ── reads ─────────────────────────────────────────────────────────────────

async function categories() {
  const rows = await at.list(BASE(), X_.categories, byId);
  return rows.filter((r) => r.fields[CAT.active] === true)
    .map((r) => ({ id: r.id, name: str(r.fields[CAT.name], 100), sort: Number(r.fields[CAT.sort]) || 99 }))
    .sort((a, b) => a.sort - b.sort);
}

async function init({ can, me }) {
  return {
    me: { name: me.name, email: me.email },
    can,
    categories: (await categories()).map(({ id, name }) => ({ id, name })),
    claimTypes: CLAIM_TYPES,
    paymentMethods: PAY_METHODS,
    maxSheetLines: X.LINE_ROWS,
  };
}

/** Job cards the user may claim against, searched by number, title, client or site. */
async function jobcards(body, env) {
  if (!env.can.jobcards) refuse(403, 'module_denied', 'Your role cannot read job cards.');
  const rows = await jobcardRows(null, env);
  const q = str(body.q, 100).toLowerCase();
  const list = rows.filter((j) => !q || [j.ref, j.title, j.client, j.site].join(' ').toLowerCase().includes(q));
  return { jobcards: list.slice(0, 40) };
}

/** Job card identity fields only, within the role's job_cards scope. Never the money fields. */
async function jobcardRows(onlyIds, env) {
  const auth = env.auth;
  const v = P.can(auth.perms, 'job_cards', 'view');
  if (!v.ok) return [];
  const rule = T.expandFieldRules(v.rule, 'job_cards', 'OM');
  const scope = P.effectiveScope(auth.role, auth.user, rule);
  const idFilter = onlyIds && onlyIds.length
    ? 'OR(' + onlyIds.map((id) => 'RECORD_ID() = ' + P.lit(id)).join(', ') + ')' : null;
  const filter = P.buildReadFilter({ moduleKey: 'job_cards', baseSymbol: 'OM', rule, scope, user: auth.user, clientFilter: idFilter });
  const jc = T.resolve('OM', 'job_cards');
  const rows = await at.list(jc.baseId, jc.tableId, {
    fields: ['JC Reference', 'Title', 'Client Name', 'Site / Address', 'Status'],
    ...(filter ? { filterByFormula: filter } : {}),
  });
  const flat = (v2) => [].concat(v2 == null ? [] : v2).map((x) => (typeof x === 'object' && x ? x.name || '' : String(x))).join(', ');
  return rows.map((r) => ({
    id: r.id, ref: str(r.fields['JC Reference'], 60), title: str(r.fields.Title, 200),
    client: str(flat(r.fields['Client Name']), 200), site: str(flat(r.fields['Site / Address']), 200),
    status: str(r.fields.Status, 60),
  })).sort((a, b) => b.ref.localeCompare(a.ref));
}

function claimView(r, lines, env, jcMap) {
  const f = r.fields;
  const email = String(f[C.empEmail] || '').toLowerCase();
  const status = str(f[C.status], 40) || E.STATUS.DRAFT;
  const mine = !!email && email === env.me.email;
  const live = lines.filter((l) => !l.removed);
  const jobcardId = ids(f[C.jobcard])[0] || '';
  const jc = jobcardId && jcMap ? jcMap.get(jobcardId) : null;
  return {
    id: r.id, seq: f[C.seq] || null, ref: str(f[C.ref], 40), legacyRef: str(f[C.legacyRef], 40),
    date: str(f[C.date], 10), employeeName: str(f[C.empName], 200), employeeEmail: email,
    jobcardId, jobcardRef: jc ? jc.ref : '', jobcardTitle: jc ? jc.title : '',
    project: str(f[C.project], 200), client: str(f[C.client], 200), description: str(f[C.desc], 2000),
    claimType: str(f[C.type], 40), paymentMethod: str(f[C.payMethod], 40), kilometres: f[C.km] == null ? null : f[C.km],
    advances: E.cents(f[C.advances]), totalApproved: f[C.approved] == null ? null : E.cents(f[C.approved]),
    totalPaid: E.cents(f[C.totalPaid]), status, comment: str(f[C.comment], 2000),
    submittedAt: str(f[C.submittedAt], 40), submittedBy: str(f[C.submittedBy], 200),
    reviewedBy: str(f[C.reviewedBy], 200), reviewedAt: str(f[C.reviewedAt], 40),
    duplicate: f[C.dup] === true,
    total: E.claimTotals(live).total, lineCount: live.length,
    mine,
    canEdit: mine && env.can.edit && EDITABLE.includes(status),
    canSubmit: mine && env.can.edit && EDITABLE.includes(status),
    canReview: !mine && env.can.approve && [E.STATUS.AWAITING_APPROVAL, E.STATUS.SUBMITTED].includes(status),
    canExport: (mine && env.can.export) || env.can.seeAll,
  };
}

function lineView(r, catNames) {
  const f = r.fields;
  const catId = ids(f[I.category])[0] || '';
  return {
    id: r.id, seq: f[I.seq] || null, date: str(f[I.date], 10), category: catNames.get(catId) || '',
    categoryId: catId, supplier: str(f[I.supplier], 200), description: str(f[I.desc], 500),
    receiptNumber: str(f[I.receiptNo], 100), amount: E.cents(f[I.amount]),
    receiptAttached: f[I.receiptAttached] === true, duplicate: f[I.dup] === true, duplicateNote: str(f[I.dupNote], 300),
    sort: Number(f[I.sort]) || 0, removed: f[I.removed] === true,
    removedReason: str(f[I.removedReason], 300), removedBy: str(f[I.removedBy], 200),
  };
}

const byRecordIds = (list) => 'OR(' + list.map((id) => 'RECORD_ID() = ' + P.lit(id)).join(', ') + ')';

async function itemsFor(itemIds) {
  if (!itemIds.length) return [];
  const out = [];
  for (let i = 0; i < itemIds.length; i += 50) {
    out.push(...await at.list(BASE(), X_.items, { ...byId, filterByFormula: byRecordIds(itemIds.slice(i, i + 50)) }));
  }
  return out;
}

/** The claim, if this user may see it. Not found and not yours read the same: no oracle. */
async function loadClaim(claimId, env) {
  if (!REC_RE.test(claimId)) refuse(400, 'bad_request', 'A claim id is required.');
  let r;
  try { r = await at.get(BASE(), X_.claims, claimId, byId); } catch (e) {
    if (e.status === 404) refuse(404, 'not_found', 'No such claim.');
    throw e;
  }
  const email = String(r.fields[C.empEmail] || '').toLowerCase();
  if (!(env.can.seeAll || (env.can.view && email && email === env.me.email))) refuse(404, 'not_found', 'No such claim.');
  return r;
}

async function getClaim(claimId, env) {
  const r = await loadClaim(claimId, env);
  const cats = await categories();
  const catNames = new Map(cats.map((c) => [c.id, c.name]));
  const lines = (await itemsFor(ids(r.fields[C.items]))).map((x) => lineView(x, catNames))
    .sort((a, b) => a.sort - b.sort || a.date.localeCompare(b.date));
  const histIds = ids(r.fields[C.history]);
  const history = histIds.length ? (await at.list(BASE(), X_.history, { ...byId, filterByFormula: byRecordIds(histIds) }))
    .map((h) => ({
      event: str(h.fields[HX.event], 40), from: str(h.fields[HX.prev], 40), to: str(h.fields[HX.next], 40),
      by: str(h.fields[HX.byName], 200) || str(h.fields[HX.byEmail], 200), comment: str(h.fields[HX.comment], 2000),
      at: str(h.fields[HX.at], 40), item: str(h.fields[HX.item], 20),
    })).sort((a, b) => a.at.localeCompare(b.at)) : [];
  const jcId = ids(r.fields[C.jobcard])[0];
  const jcMap = new Map((jcId && env.can.jobcards ? await jobcardRows([jcId], env) : []).map((j) => [j.id, j]));
  return { claim: claimView(r, lines, env, jcMap), lines, history };
}

async function listClaims(body, env) {
  const jobcardId = str(body.jobcardId, 20);
  const status = str(body.status, 40);
  const mineOnly = !env.can.seeAll || body.mine === true;
  const filter = P.andFilters(
    mineOnly ? 'LOWER({Employee Email}) = ' + P.lit(env.me.email) : null,
    status ? '{Claim Status} = ' + P.lit(status) : null,
  );
  let rows = await at.list(BASE(), X_.claims, { ...byId, ...(filter ? { filterByFormula: filter } : {}) });
  if (jobcardId) rows = rows.filter((r) => ids(r.fields[C.jobcard]).includes(jobcardId));

  const cats = await categories();
  const catNames = new Map(cats.map((c) => [c.id, c.name]));
  const items = await itemsFor(rows.flatMap((r) => ids(r.fields[C.items])));
  const linesBy = new Map();
  for (const it of items) {
    const v = lineView(it, catNames);
    for (const cid of ids(it.fields[I.claim])) linesBy.set(cid, (linesBy.get(cid) || []).concat(v));
  }
  const jcIds = [...new Set(rows.flatMap((r) => ids(r.fields[C.jobcard])))];
  const jcMap = new Map((env.can.jobcards && jcIds.length ? await jobcardRows(jcIds, env) : []).map((j) => [j.id, j]));
  const claims = rows.map((r) => claimView(r, linesBy.get(r.id) || [], env, jcMap))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.seq || 0) - (a.seq || 0));

  // The total against a job card across every employee is job card money: four people only.
  let jobcardTotal = null;
  if (jobcardId && env.can.jobcardTotals) {
    const all = (await at.list(BASE(), X_.claims, byId)).filter((r) => ids(r.fields[C.jobcard]).includes(jobcardId));
    const allItems = (await itemsFor(all.flatMap((r) => ids(r.fields[C.items])))).map((x) => lineView(x, catNames));
    const counted = all.map((r) => ({ status: str(r.fields[C.status], 40), approved: r.fields[C.approved], paid: r.fields[C.totalPaid], email: r.fields[C.empEmail] }));
    const live = allItems.filter((l) => !l.removed);
    const submitted = all.filter((r) => str(r.fields[C.status], 40) !== E.STATUS.DRAFT);
    const submittedIds = new Set(submitted.flatMap((r) => ids(r.fields[C.items])));
    jobcardTotal = {
      claims: all.length,
      employees: new Set(counted.map((c) => String(c.email || '').toLowerCase()).filter(Boolean)).size,
      submitted: E.claimTotals(live.filter((l) => submittedIds.has(l.id))).total,
      approved: E.cents(counted.filter((c) => c.status !== E.STATUS.REJECTED).reduce((s, c) => s + (Number(c.approved) || 0), 0)),
      paid: E.cents(counted.reduce((s, c) => s + (Number(c.paid) || 0), 0)),
    };
    jobcardTotal.outstanding = E.cents(jobcardTotal.approved - jobcardTotal.paid);
  }
  A.audit({ ...env.ctx, action: 'View', result: 'Allowed', detail: claims.length + ' claims' });
  return { claims, jobcardTotal };
}

// ── writes ────────────────────────────────────────────────────────────────

async function history(claimId, event, from, to, env, comment, itemId) {
  await at.create(BASE(), X_.history, [{
    [HX.claim]: [claimId], [HX.event]: event, [HX.prev]: from || '', [HX.next]: to || '',
    [HX.byEmail]: env.me.email, [HX.byName]: env.me.name, [HX.comment]: str(comment, 2000),
    ...(itemId ? { [HX.item]: itemId } : {}),
  }]);
}

function cleanHeader(c) {
  const h = c || {};
  const out = {};
  if ('claimDate' in h) {
    if (!DATE_RE.test(str(h.claimDate, 10))) refuse(400, 'bad_request', 'The claim date is not a date.');
    out[C.date] = str(h.claimDate, 10);
  }
  if ('jobcardId' in h) {
    const j = str(h.jobcardId, 20);
    if (j && !REC_RE.test(j)) refuse(400, 'bad_request', 'That job card is not valid.');
    out[C.jobcard] = j ? [j] : [];
  }
  if ('project' in h) out[C.project] = str(h.project, 200);
  if ('client' in h) out[C.client] = str(h.client, 200);
  if ('description' in h) out[C.desc] = str(h.description, 2000);
  if ('claimType' in h) {
    const t = str(h.claimType, 40);
    if (t && !CLAIM_TYPES.includes(t)) refuse(400, 'bad_request', 'Unknown claim type.');
    out[C.type] = t || null;
  }
  if ('paymentMethod' in h) {
    const p = str(h.paymentMethod, 40);
    if (p && !PAY_METHODS.includes(p)) refuse(400, 'bad_request', 'Unknown payment method.');
    out[C.payMethod] = p || null;
  }
  if ('kilometres' in h) {
    const k = h.kilometres === '' || h.kilometres == null ? null : Number(h.kilometres);
    if (k != null && (!Number.isFinite(k) || k < 0 || k > 10000000)) refuse(400, 'bad_request', 'Kilometres must be a positive number.');
    out[C.km] = k == null ? null : Math.round(k);
  }
  return out;
}

function cleanLine(l, catIds) {
  const date = str(l.date, 10);
  if (date && !DATE_RE.test(date)) refuse(400, 'bad_request', 'A line date is not a date.');
  const amount = l.amount === '' || l.amount == null ? null : Number(l.amount);
  if (amount != null && (!Number.isFinite(amount) || amount < 0 || amount > 10000000)) refuse(400, 'bad_request', 'A line amount is not valid.');
  const cat = str(l.categoryId, 20);
  if (cat && !catIds.has(cat)) refuse(400, 'bad_request', 'Unknown category.');
  return {
    [I.date]: date || null, [I.supplier]: str(l.supplier, 200), [I.desc]: str(l.description, 500),
    [I.receiptNo]: str(l.receiptNumber, 100), [I.amount]: amount == null ? null : E.cents(amount),
    [I.category]: cat ? [cat] : [], [I.receiptAttached]: l.receiptAttached === true,
  };
}

async function save(body, env) {
  const claimId = str(body.claimId, 20);
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (lines.length > MAX_LINES) refuse(400, 'bad_request', 'Too many lines on one claim.');
  const header = cleanHeader(body.claim);
  const cats = await categories();
  const catIds = new Set(cats.map((c) => c.id));
  let id = claimId;

  if (!claimId) {
    if (!env.can.create) refuse(403, 'op_denied', 'Your role may not create expense claims.');
    // A retry or a double tap sends the same request id: hand back the first claim.
    const requestId = str(body.requestId, 60);
    if (requestId) {
      const twin = await at.findOne(BASE(), X_.claims, 'AND({Request ID} = ' + P.lit(requestId)
        + ', LOWER({Employee Email}) = ' + P.lit(env.me.email) + ')');
      if (twin) return getClaim(twin.id, env);
    }
    if (!header[C.date]) header[C.date] = new Date().toISOString().slice(0, 10);
    const [made] = await at.create(BASE(), X_.claims, [{
      ...header, [C.empName]: env.me.name, [C.empEmail]: env.me.email, [C.empId]: env.me.id || '',
      [C.status]: E.STATUS.DRAFT, [C.changedBy]: env.me.email, ...(requestId ? { [C.requestId]: requestId } : {}),
    }]);
    id = made.id;
    await history(id, 'Create', '', E.STATUS.DRAFT, env, '');
    A.audit({ ...env.ctx, action: 'Create', result: 'Allowed', recordId: id });
  } else {
    const r = await loadClaim(claimId, env);
    const owner = String(r.fields[C.empEmail] || '').toLowerCase() === env.me.email;
    if (!owner || !env.can.edit) refuse(403, 'op_denied', 'Only the employee who made a claim may change it.');
    const status = str(r.fields[C.status], 40);
    if (!EDITABLE.includes(status)) refuse(409, 'locked', 'This claim is ' + status + ' and can no longer be changed.');
    if (Object.keys(header).length) await at.update(BASE(), X_.claims, claimId, { ...header, [C.changedBy]: env.me.email });
  }

  // Lines: new ones are created, known ones updated. A line that is left out is NOT removed:
  // removal is its own logged operation (remove_line).
  const current = new Map((await itemsFor(ids((await at.get(BASE(), X_.claims, id, byId)).fields[C.items]))).map((x) => [x.id, x]));
  let sort = Math.max(0, ...[...current.values()].map((x) => Number(x.fields[I.sort]) || 0));
  const toCreate = [];
  for (const l of lines) {
    const fields = cleanLine(l || {}, catIds);
    const lid = str(l && l.id, 20);
    if (lid) {
      const was = current.get(lid);
      if (!was) refuse(400, 'bad_request', 'A line does not belong to this claim.');
      if (was.fields[I.removed] === true) continue;
      await at.update(BASE(), X_.items, lid, fields);
    } else {
      toCreate.push({ ...fields, [I.claim]: [id], [I.sort]: ++sort });
    }
  }
  if (toCreate.length) await at.create(BASE(), X_.items, toCreate);
  await flagDuplicates(id, env);
  if (claimId) await history(id, 'Save', '', '', env, '');
  return getClaim(id, env);
}

/**
 * Mark lines that look like a second claim for the same spend: same employee, date, amount and
 * supplier, here or on another of their claims. A warning for the approver, never a refusal.
 */
async function flagDuplicates(claimId, env) {
  const mine = await at.list(BASE(), X_.claims, { ...byId, filterByFormula: 'LOWER({Employee Email}) = ' + P.lit(env.me.email) });
  const claimOf = new Map();
  for (const c of mine) for (const iid of ids(c.fields[C.items])) claimOf.set(iid, c.id);
  const all = (await itemsFor([...claimOf.keys()])).filter((x) => x.fields[I.removed] !== true);
  const asLines = all.map((x) => ({ id: x.id, employeeId: env.me.email, date: str(x.fields[I.date], 10),
    amount: x.fields[I.amount], supplier: x.fields[I.supplier] }));
  const flags = E.duplicateFlags(asLines);
  const flagged = new Map(flags.map((f) => [asLines[f.index].id, asLines[f.duplicateOf].id]));
  let claimHasDup = false;
  for (const x of all) {
    if (claimOf.get(x.id) !== claimId) continue;
    const twin = flagged.get(x.id);
    const want = !!twin;
    if (want) claimHasDup = true;
    if ((x.fields[I.dup] === true) !== want) {
      await at.update(BASE(), X_.items, x.id, {
        [I.dup]: want,
        [I.dupNote]: want ? 'Same date, amount and supplier as ' + (claimOf.get(twin) === claimId ? 'another line on this claim' : 'a line on another of your claims') : '',
      });
    }
  }
  await at.update(BASE(), X_.claims, claimId, { [C.dup]: claimHasDup });
}

async function submit(body, env) {
  const r = await loadClaim(str(body.claimId, 20), env);
  const owner = String(r.fields[C.empEmail] || '').toLowerCase() === env.me.email;
  if (!owner) refuse(403, 'op_denied', 'Only the employee who made a claim may submit it.');
  const status = str(r.fields[C.status], 40);
  // Already on its way: a double tap is answered, not refused or logged twice.
  if (status === E.STATUS.AWAITING_APPROVAL) return getClaim(r.id, env);
  const t = E.canTransition(status, 'submit', new Set(env.can.edit ? ['submit'] : []));
  if (!t.ok) refuse(t.reason === 'not_permitted' ? 403 : 409, t.reason, 'This claim cannot be submitted now.');
  if (body.declaration !== true) refuse(400, 'declaration_required', 'Confirm the declaration before submitting.');
  const cats = await categories();
  const catNames = new Map(cats.map((c) => [c.id, c.name]));
  const lines = (await itemsFor(ids(r.fields[C.items]))).map((x) => lineView(x, catNames)).filter((l) => !l.removed);
  const errors = E.validateForSubmit(
    { jobcardId: ids(r.fields[C.jobcard])[0], claimDate: r.fields[C.date] },
    lines.map((l) => ({ ...l })), { receiptThreshold: RECEIPT_THRESHOLD });
  if (errors.length) refuse(400, 'invalid', errors.map((x) => x.message).join(' '));
  await at.update(BASE(), X_.claims, r.id, {
    [C.status]: t.to, [C.submittedAt]: new Date().toISOString(), [C.submittedBy]: env.me.name,
    [C.changedBy]: env.me.email,
  });
  await history(r.id, 'Submit', status, t.to, env, '');
  A.audit({ ...env.ctx, action: 'Update', result: 'Allowed', recordId: r.id, field: 'Claim Status', oldValue: status, newValue: t.to });
  return getClaim(r.id, env);
}

async function review(body, env) {
  const r = await loadClaim(str(body.claimId, 20), env);
  const owner = String(r.fields[C.empEmail] || '').toLowerCase() === env.me.email;
  if (owner) refuse(403, 'own_claim', 'You cannot review your own claim.');
  const act = { approve: 'approve', reject: 'reject', request_info: 'request_info' }[str(body.action, 20)];
  if (!act) refuse(400, 'bad_request', 'Unknown review action.');
  const status = str(r.fields[C.status], 40);
  const comment = str(body.comment, 2000);
  const t = E.canTransition(status, act, new Set(env.can.approve ? ['approve'] : []), comment);
  if (!t.ok) {
    const detail = { not_permitted: 'Your role may not review expense claims.', reason_required: 'Give a reason.',
      wrong_status: 'This claim is ' + status + ' and cannot be reviewed.' }[t.reason] || 'Not allowed.';
    refuse(t.reason === 'not_permitted' ? 403 : t.reason === 'reason_required' ? 400 : 409, t.reason, detail);
  }
  const fields = { [C.status]: t.to, [C.reviewedBy]: env.me.name, [C.reviewedAt]: new Date().toISOString(),
    [C.comment]: comment, [C.changedBy]: env.me.email };
  if (act === 'approve') {
    const cats = await categories();
    const catNames = new Map(cats.map((c) => [c.id, c.name]));
    const total = E.claimTotals((await itemsFor(ids(r.fields[C.items]))).map((x) => lineView(x, catNames)).filter((l) => !l.removed)).total;
    const asked = body.approvedAmount === undefined || body.approvedAmount === '' ? total : Number(body.approvedAmount);
    if (!Number.isFinite(asked) || asked < 0 || asked > total) refuse(400, 'bad_request', 'The approved amount must be between 0 and the claim total.');
    fields[C.approved] = E.cents(asked);
  }
  await at.update(BASE(), X_.claims, r.id, fields);
  const event = { approve: 'Approve', reject: 'Reject', request_info: 'Request Info' }[act];
  await history(r.id, event, status, t.to, env, comment + (act === 'approve' ? ' (approved R' + fields[C.approved].toFixed(2) + ')' : ''));
  A.audit({ ...env.ctx, action: 'Update', result: 'Allowed', recordId: r.id, field: 'Claim Status', oldValue: status, newValue: t.to });
  return getClaim(r.id, env);
}

async function removeLine(body, env) {
  const r = await loadClaim(str(body.claimId, 20), env);
  const itemId = str(body.itemId, 20);
  if (!ids(r.fields[C.items]).includes(itemId)) refuse(400, 'bad_request', 'That line is not on this claim.');
  const reason = str(body.reason, 300);
  if (!reason) refuse(400, 'reason_required', 'Say why the line is being removed.');
  const status = str(r.fields[C.status], 40);
  const owner = String(r.fields[C.empEmail] || '').toLowerCase() === env.me.email;
  // The employee may tidy their own claim until it is submitted; the approver may take out a
  // duplicate while it waits for them. After approval the amount is settled.
  const ok = (owner && env.can.edit && EDITABLE.includes(status))
    || (!owner && env.can.approve && [E.STATUS.AWAITING_APPROVAL, E.STATUS.SUBMITTED].includes(status));
  if (!ok) refuse(403, 'op_denied', 'This line cannot be removed now.');
  const [item] = await itemsFor([itemId]);
  if (item.fields[I.removed] === true) return getClaim(r.id, env);
  await at.update(BASE(), X_.items, itemId, { [I.removed]: true, [I.removedReason]: reason, [I.removedBy]: env.me.name });
  const amount = E.cents(item.fields[I.amount]).toFixed(2);
  await history(r.id, 'Remove Line', '', '', env,
    'Removed line ' + (item.fields[I.seq] || '') + ' (R' + amount + ', ' + str(item.fields[I.desc], 80) + '): ' + reason, itemId);
  A.audit({ ...env.ctx, action: 'Update', result: 'Allowed', recordId: itemId, field: 'Removed', oldValue: 'false', newValue: 'true' });
  if (owner) await flagDuplicates(r.id, env);
  return getClaim(r.id, env);
}

async function exportSheet(body, env) {
  const full = await getClaim(str(body.claimId, 20), env);
  const c = full.claim;
  if (!c.canExport) refuse(403, 'op_denied', 'Your role may not export this claim.');
  const lines = full.lines.filter((l) => !l.removed);
  if (lines.length > X.LINE_ROWS) {
    refuse(400, 'too_many_lines', 'The expense sheet holds ' + X.LINE_ROWS + ' lines; this claim has ' + lines.length + '. Split it into two claims to print it.');
  }
  const project = [c.jobcardRef, c.project || c.jobcardTitle].filter(Boolean).join(' – ');
  const buf = await X.buildExpenseSheet({
    ref: c.ref || c.legacyRef, employeeName: c.employeeName, paymentMethod: c.paymentMethod,
    claimType: c.claimType, purpose: c.description, projectName: project, claimDate: c.date || new Date().toISOString(),
    kilometres: c.kilometres, advances: c.advances,
    fundsNote: 'Funds to be deposited into ' + (c.employeeName || 'the employee') + ' account',
  }, lines.map((l) => ({ date: l.date || c.date, supplier: l.supplier, description: l.description, category: l.category, amount: l.amount })));
  A.audit({ ...env.ctx, action: 'Export', result: 'Allowed', recordId: c.id });
  return { filename: X.claimFileName(c.ref || c.legacyRef || c.id), base64: buf.toString('base64') };
}
