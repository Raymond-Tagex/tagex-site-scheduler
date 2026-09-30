// TAGEX — audit trail writer.
//
// TIERED, because the Airtable Team plan caps a base at 50,000 records:
//
//   Individually logged, permanently, never collapsed:
//     Login, Login Failed, Logout, Password Reset, Create, Update, Delete, Export, Print,
//     Permission Change, Restricted Document Viewed — AND EVERY DENIAL, without exception.
//     Repeated denials are how you spot someone probing; collapsing them defeats the point.
//
//   Aggregated:
//     routine View + Allowed reads, rolled into one record per session|module|action|date,
//     incrementing Request Count.
//
// Fire-and-forget: an audit failure must NEVER block or fail the user's request. Every entry
// point swallows its own errors and reports to the platform log instead.

'use strict';

const at = require('./airtable.js');
const T = require('./tables.js');

const AUDIT_BASE = () => T.BASES.IAM;
const AUDIT_TABLE = () => T.TABLES.audit_log.IAM;

const MAX_VALUE_LEN = 500;

// Actions that are ALWAYS written individually, whatever their result.
const ALWAYS_INDIVIDUAL = new Set([
  'Login', 'Login Failed', 'Logout', 'Password Reset', 'Create', 'Update', 'Delete',
  'Export', 'Print', 'Permission Change', 'Restricted Document Viewed',
]);

/** Values of never-return fields never appear in the audit trail in clear. */
function safeValue(fieldName, value) {
  if (fieldName && T.NEVER_RETURN.includes(fieldName)) return '[REDACTED]';
  if (value == null) return '';
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s.length > MAX_VALUE_LEN) s = `${s.slice(0, MAX_VALUE_LEN)}… [truncated]`;
  return s;
}

function today() { return new Date().toISOString().slice(0, 10); }

function aggKey({ sessionId, module, action }) {
  return `${sessionId || 'anon'}|${module || '-'}|${action || '-'}|${today()}`;
}

function eventLabel({ action, module, result }) {
  return `${new Date().toISOString()} · ${action} · ${module || '-'} · ${result}`;
}

/**
 * Write one audit entry.
 *
 * @param {object} e
 * @param {string} e.action     one of the Action select options
 * @param {string} e.result     'Allowed' | 'Denied'
 * @param {string} [e.userEmail]
 * @param {string} [e.userRecordId]
 * @param {string} [e.module] [e.baseSymbol] [e.table] [e.recordId] [e.field]
 * @param {*}      [e.oldValue] [e.newValue]
 * @param {string} [e.ip] [e.userAgent] [e.sessionId] [e.denialReason]
 */
async function write(e) {
  try {
    const action = e.action || 'View';
    const result = e.result === 'Denied' ? 'Denied' : 'Allowed';
    const individual = result === 'Denied' || ALWAYS_INDIVIDUAL.has(action);

    const fields = {
      Event: eventLabel({ action, module: e.module, result }),
      Timestamp: new Date().toISOString(),
      'User Email': e.userEmail || '',
      Action: action,
      Module: e.module || '',
      'Base ID': e.baseSymbol ? `${e.baseSymbol} (${T.BASES[e.baseSymbol] || '?'})` : '',
      Table: e.table || '',
      'Record ID': e.recordId || '',
      Field: e.field || '',
      'Old Value': safeValue(e.field, e.oldValue),
      'New Value': safeValue(e.field, e.newValue),
      'IP Address': e.ip || '',
      'User Agent': (e.userAgent || '').slice(0, MAX_VALUE_LEN),
      Result: result,
      'Denial Reason': e.denialReason || '',
      'Session ID': e.sessionId || '',
      'Request Count': 1,
    };
    if (e.userRecordId) fields.User = [e.userRecordId];

    if (individual) {
      await at.create(AUDIT_BASE(), AUDIT_TABLE(), [fields]);
      return;
    }

    // Aggregated path: find today's roll-up for this session+module+action and bump it.
    const key = aggKey({ sessionId: e.sessionId, module: e.module, action });
    const esc = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const existing = await at.findOne(
      AUDIT_BASE(), AUDIT_TABLE(), `{Agg Key} = "${esc}"`, ['Agg Key', 'Request Count']
    );

    if (existing) {
      const n = Number(existing.fields['Request Count'] || 0) + 1;
      await at.update(AUDIT_BASE(), AUDIT_TABLE(), existing.id, {
        'Request Count': n,
        Timestamp: new Date().toISOString(),
      });
    } else {
      await at.create(AUDIT_BASE(), AUDIT_TABLE(), [{ ...fields, 'Agg Key': key, Aggregated: true }]);
    }
  } catch (err) {
    // Never rethrow. An audit outage must not take the warehouse down with it.
    console.error('[audit] write failed (request unaffected):', err && err.message);
  }
}

/**
 * Fire-and-forget wrapper. Returns immediately; the write settles in the background.
 * On Vercel the function may freeze before an un-awaited promise resolves, so callers that
 * can afford ~50ms should `await auditNow(...)` for security-critical events (denials,
 * logins, restricted reads). Routine reads use this.
 */
function audit(e) {
  const p = write(e);
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return p;
}

/** Await the write. Use for denials, auth events and restricted-document reads. */
async function auditNow(e) { await write(e); }

/** One entry per changed field, with old → new. Used on update. */
async function auditFieldChanges({ before, after, ...ctx }) {
  const names = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changed = [];
  for (const name of names) {
    const b = before ? before[name] : undefined;
    const a = after ? after[name] : undefined;
    if (JSON.stringify(b) !== JSON.stringify(a)) changed.push({ name, b, a });
  }
  if (!changed.length) return;
  await Promise.all(changed.map((c) => write({
    ...ctx, action: 'Update', result: 'Allowed',
    field: c.name, oldValue: c.b, newValue: c.a,
  })));
}

module.exports = { audit, auditNow, auditFieldChanges, safeValue, aggKey, ALWAYS_INDIVIDUAL };
