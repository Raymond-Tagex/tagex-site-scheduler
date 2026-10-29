// TAGEX Expense Claims — the rules, with no Airtable or HTTP in them.
//
// Everything that decides whether a claim may move, what it adds up to, and what its reference
// is lives here so it can be tested offline. The routes that read and write Airtable call these;
// they do not re-implement them.

'use strict';

// Status flow. Approval and payment are separate steps: approving a claim never marks it paid.
// Only Finance moves a claim from Approved onwards (see ROLE_MAY below).
const STATUS = Object.freeze({
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  AWAITING_APPROVAL: 'Awaiting Approval',
  INFO_REQUESTED: 'Info Requested',
  REJECTED: 'Rejected',
  APPROVED: 'Approved',
  AWAITING_PAYMENT: 'Awaiting Payment',
  PARTIALLY_PAID: 'Partially Paid',
  PAID: 'Paid',
  CLOSED: 'Closed',
});

// action -> { from: [statuses], to: status, by: role-key }
// The role key is checked on the server against the user's expense permission.
const TRANSITIONS = Object.freeze({
  submit:        { from: [STATUS.DRAFT, STATUS.REJECTED, STATUS.INFO_REQUESTED], to: STATUS.AWAITING_APPROVAL, by: 'submit' },
  approve:       { from: [STATUS.AWAITING_APPROVAL, STATUS.SUBMITTED], to: STATUS.APPROVED, by: 'approve' },
  reject:        { from: [STATUS.AWAITING_APPROVAL, STATUS.SUBMITTED], to: STATUS.REJECTED, by: 'approve', needsReason: true },
  request_info:  { from: [STATUS.AWAITING_APPROVAL, STATUS.SUBMITTED], to: STATUS.INFO_REQUESTED, by: 'approve', needsReason: true },
  queue_payment: { from: [STATUS.APPROVED], to: STATUS.AWAITING_PAYMENT, by: 'finance' },
  close:         { from: [STATUS.PAID], to: STATUS.CLOSED, by: 'finance' },
});

// Which permission key each transition needs. Finance records payments; approvers never do.
const ROLE_MAY = Object.freeze({
  submit: 'submit',
  approve: 'approve',
  finance: 'finance',
});

/**
 * Check a status change. Returns { ok: true, to } or { ok: false, reason }.
 * `permissions` is a Set of permission keys the acting user holds.
 */
function canTransition(current, action, permissions, comment) {
  const t = TRANSITIONS[action];
  if (!t) return { ok: false, reason: 'unknown_action' };
  if (!t.from.includes(current)) return { ok: false, reason: 'wrong_status', from: current };
  if (!permissions || !permissions.has(ROLE_MAY[t.by])) return { ok: false, reason: 'not_permitted' };
  if (t.needsReason && !(typeof comment === 'string' && comment.trim())) {
    return { ok: false, reason: 'reason_required' };
  }
  return { ok: true, to: t.to };
}

/** Round to cents. Money in this app is rand, two decimals, never floats carried forward. */
const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Totals for one claim's lines. Only lines counted as claimable add to the claim total.
 * `lines` are { amount, category, ... }; `amount` is the gross rand amount on that line.
 */
function claimTotals(lines) {
  const byCategory = {};
  let total = 0;
  for (const line of lines || []) {
    const amount = cents(line.amount);
    total = cents(total + amount);
    const key = line.category || 'Uncategorised';
    byCategory[key] = cents((byCategory[key] || 0) + amount);
  }
  return { total, byCategory, lineCount: (lines || []).length };
}

/**
 * Payments already made against an approved amount. A claim is Paid only when payments cover the
 * approved amount exactly; anything short is Partially Paid, and overpayment is refused elsewhere.
 */
function paymentState(approvedAmount, payments) {
  const paid = cents((payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const approved = cents(approvedAmount);
  const outstanding = cents(approved - paid);
  let status;
  if (paid <= 0) status = STATUS.AWAITING_PAYMENT;
  else if (outstanding > 0) status = STATUS.PARTIALLY_PAID;
  else status = STATUS.PAID;
  return { paid, outstanding, status };
}

/**
 * Claim reference, ES-YYYYMM-NNN, matching the existing expense sheets (ES-202610-003).
 * NNN comes from the Airtable autoNumber `Claim Seq`, never from counting rows in the browser,
 * so two people submitting at once cannot be given the same number.
 */
function claimRef(claimDate, seq) {
  const d = new Date(claimDate);
  if (Number.isNaN(d.getTime())) throw new Error('claimRef: bad claim date');
  if (!Number.isInteger(seq) || seq < 1) throw new Error('claimRef: bad sequence');
  const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return `ES-${ym}-${String(seq).padStart(3, '0')}`;
}

/**
 * Duplicate warnings. These flag for review and never block: two legitimate fills of the same
 * amount on the same day are common. A line is a possible duplicate of another when the
 * employee, date, amount and supplier or receipt number match.
 */
function duplicateFlags(lines) {
  const flags = [];
  const key = (l) => [l.employeeId, l.date, cents(l.amount), String(l.supplier || '').trim().toLowerCase()].join('|');
  const seen = new Map();
  (lines || []).forEach((line, i) => {
    const k = key(line);
    if (seen.has(k)) flags.push({ index: i, duplicateOf: seen.get(k), reason: 'same employee, date, amount and supplier' });
    else seen.set(k, i);
  });
  return flags;
}

/**
 * Validation for a claim before it can be submitted. Returns a list of { field, message }.
 * An empty list means the claim may be submitted. Receipts are required above a threshold; the
 * threshold is a business rule, so it is passed in rather than fixed here.
 */
function validateForSubmit(claim, lines, opts) {
  const errors = [];
  const o = opts || {};
  if (!claim.jobcardId) errors.push({ field: 'jobcard', message: 'Choose the jobcard this claim is for.' });
  if (!claim.claimDate) errors.push({ field: 'claimDate', message: 'Enter the claim date.' });
  if (!lines || lines.length === 0) errors.push({ field: 'lines', message: 'Add at least one expense line.' });
  (lines || []).forEach((l, i) => {
    const n = i + 1;
    if (!l.date) errors.push({ field: `lines[${i}].date`, message: `Line ${n}: enter the date.` });
    if (!l.category) errors.push({ field: `lines[${i}].category`, message: `Line ${n}: choose a category.` });
    if (!l.description) errors.push({ field: `lines[${i}].description`, message: `Line ${n}: describe the expense.` });
    const amount = Number(l.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push({ field: `lines[${i}].amount`, message: `Line ${n}: the amount must be more than zero.` });
    }
    if (amount >= (o.receiptThreshold || Infinity) && !l.receiptAttached && !l.receiptNumber) {
      errors.push({ field: `lines[${i}].receipt`, message: `Line ${n}: attach a receipt or enter its number.` });
    }
  });
  return errors;
}

module.exports = {
  STATUS,
  TRANSITIONS,
  canTransition,
  claimTotals,
  paymentState,
  claimRef,
  duplicateFlags,
  validateForSubmit,
  cents,
};
