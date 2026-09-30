// TAGEX — POST /api/at
//
// The ONLY path from the app to Airtable. One service PAT lives in AIRTABLE_PAT and never
// reaches the browser; the browser holds an HttpOnly session cookie and nothing else.
//
// Request:
//   { "op": "list"|"get"|"create"|"update"|"delete",
//     "base": "CI"|"OM"|"IAM",        symbolic only — never a raw app… id
//     "table": "delivery_notes",      symbolic only — never a raw tbl… id
//     "sub": "financial_vetting",     only for restricted_personal
//     "recordId": "rec…",
//     "fields": { … },
//     "params": { filterByFormula, sort, fields, pageSize, maxRecords } }
//
// ENFORCEMENT ORDER — no shortcuts, no exceptions:
//   0. reject any raw app…/tbl…/fld… id anywhere in the body   (pre-auth, so it is not an oracle)
//   1. verify the session cookie: signature, expiry, idle timeout
//   2. load user + role; Status must be Active
//   3. resolve base/table symbols against the whitelist
//   4. module + operation against Permissions, then per-user Overrides
//   5. reads: inject record scope (AND-ed, never replacing), strip deny_read + over-sensitivity
//   6. writes: reject deny_write / unknown / computed fields, naming them; validate against schema
//   7. deletes: soft-delete where the module declares one
//   8. execute with the service PAT
//   9. audit — allowed or denied, with old → new on updates
//  10. rate limit, 120/min per session

'use strict';

const T = require('./_lib/tables.js');
const P = require('./_lib/permissions.js');
const at = require('./_lib/airtable.js');
const S = require('./_lib/session.js');
const H = require('./_lib/http.js');
const A = require('./_lib/audit.js');
const G = require('./_lib/guards.js');

const VALID_OPS = new Set(['list', 'get', 'create', 'update', 'delete']);

module.exports = async function handler(req, res) {
  if (!H.methodGuard(req, res, 'POST')) return;
  if (!H.sessionModeGuard(res)) return;

  const ip = S.clientIp(req);
  const ua = S.userAgent(req);

  // ── body ────────────────────────────────────────────────────────────────
  let body;
  try {
    body = await H.readBody(req);
  } catch (e) {
    return H.fail(res, 400, e.code || 'bad_request', e.message);
  }

  // ── STEP 0 — raw identifier rejection, before authentication ────────────
  // Deliberately pre-auth: an unauthenticated caller must not be able to use the difference
  // between "rejected" and "unauthorised" to learn which ids exist.
  const rawId = T.findRawIdInRequest(body);
  if (rawId) {
    return H.fail(res, 400, 'raw_id_rejected',
      'This API accepts symbolic base and table names only. Raw Airtable identifiers are not permitted.',
      { offending: rawId.slice(0, 3) + '…' });
  }

  const op = String(body.op || '');
  const baseSymbol = String(body.base || '');
  const tableSymbol = String(body.table || '');
  const subSymbol = body.sub ? String(body.sub) : null;
  const recordId = body.recordId ? String(body.recordId) : null;
  const fields = body.fields && typeof body.fields === 'object' ? body.fields : null;
  const params = body.params && typeof body.params === 'object' ? body.params : {};

  if (!VALID_OPS.has(op)) {
    return H.fail(res, 400, 'unknown_op', 'op must be one of: list, get, create, update, delete.');
  }

  // ── STEPS 1 & 2 — session, user, role ───────────────────────────────────
  const auth = await S.authenticate(req);
  if (!auth.ok) {
    await A.auditNow({
      action: op === 'list' || op === 'get' ? 'View' : op === 'create' ? 'Create' : op === 'update' ? 'Update' : 'Delete',
      result: 'Denied', denialReason: auth.reason, module: tableSymbol, baseSymbol,
      ip, userAgent: ua, detail: auth.detail,
    });
    return H.fail(res, auth.status, auth.reason, auth.detail);
  }

  const ctx = {
    userEmail: auth.email, userRecordId: auth.userRecordId,
    sessionId: auth.sid, ip, userAgent: ua,
    module: tableSymbol, baseSymbol,
  };

  // ── STEP 2b — account-state gates ───────────────────────────────────────
  // These sit between "you are who you say" and "you may do this". Both are reachable states
  // for a valid session, and both must block data access without blocking the endpoint that
  // resolves them (/api/auth/change-password and /api/auth/mfa do not route through here).
  if (auth.user['Must Change Password'] === true) {
    await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: 'password_change_required' });
    return H.fail(res, 403, 'password_change_required',
      'You must set a new password before continuing.');
  }
  if (S.mustEnrolMfa(auth.role, auth.user)) {
    await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: 'mfa_enrolment_required' });
    return H.fail(res, 403, 'mfa_enrolment_required',
      'Two-factor authentication is mandatory for administrators. Complete enrolment to continue.');
  }

  // ── STEP 10 — rate limit (checked early; a limited request is still audited) ──
  const rl = H.sessionRateLimit(auth.sid);
  if (!rl.ok) {
    await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: 'rate_limited' });
    return H.tooManyRequests(res, rl.retryAfter);
  }

  // ── STEP 3 — resolve symbols ────────────────────────────────────────────
  const resolved = T.resolve(baseSymbol, tableSymbol, subSymbol);
  if (!resolved.ok) {
    await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: resolved.reason });
    return H.fail(res, resolved.status, resolved.reason, resolved.detail);
  }
  const { baseId, tableId } = resolved;
  ctx.table = resolved.sub ? `${tableSymbol}/${resolved.sub}` : tableSymbol;

  // ── STEP 4 — module + operation, then per-user overrides ────────────────
  const verb = P.OP_FOR_AIRTABLE[op];
  const allowed = P.can(auth.perms, tableSymbol, verb);
  if (!allowed.ok) {
    await A.auditNow({
      ...ctx,
      action: verb === 'view' ? 'View' : verb === 'create' ? 'Create' : verb === 'edit' ? 'Update' : 'Delete',
      result: 'Denied', denialReason: allowed.reason, recordId,
    });
    return H.fail(res, allowed.status, allowed.reason, allowed.detail);
  }
  // The role names a field once, in the operations vocabulary. Expand it to whatever THIS base
  // calls the same thing, so a rule cannot be escaped simply by reading from a different base.
  const rule = T.expandFieldRules(allowed.rule, tableSymbol, baseSymbol);

  // Restricted personal data: role permission is not enough, the per-user flag is required too.
  const gate = P.canViewRestricted(rule, auth.role, auth.user);
  if (!gate.ok) {
    await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: gate.reason, recordId });
    return H.fail(res, gate.status, gate.reason, gate.detail);
  }

  // FICA is never list-viewable. A record must be asked for by id, and the ask is logged.
  if (rule.list_view === false && op === 'list') {
    await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: 'list_view_forbidden' });
    return H.fail(res, 403, 'list_view_forbidden',
      'Restricted personal records cannot be listed. Request a single record by id.');
  }

  const scope = P.effectiveScope(auth.role, auth.user, rule);

  try {
    // Field id ↔ name maps for this table. Required because a client may ask Airtable to key
    // records by field id (returnFieldsByFieldId), while permission rules are written in field
    // names. Without translating, a deny_read would match nothing and strip nothing.
    // Resolved from the cached schema, so this is normally free.
    let idToName = null, nameToId = null;
    try {
      ({ idToName, nameToId } = await at.fieldMaps(baseId, tableId));
    } catch (e) {
      // A schema read failure must not silently downgrade field enforcement to "no rules".
      console.error('[at] field map unavailable:', e && e.message);
      await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: 'schema_unavailable' });
      return H.fail(res, 503, 'schema_unavailable',
        'Could not read the table schema, so field-level permissions cannot be applied. Refusing rather than returning unfiltered data.');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // READS
    // ═══════════════════════════════════════════════════════════════════════
    if (op === 'list' || op === 'get') {
      const filterCheck = P.validateClientFilter(params.filterByFormula);
      if (!filterCheck.ok) {
        await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: filterCheck.reason });
        return H.fail(res, 400, filterCheck.reason, filterCheck.detail);
      }

      const filter = P.buildReadFilter({
        moduleKey: tableSymbol, baseSymbol, rule, scope, user: auth.user,
        clientFilter: params.filterByFormula,
      });

      let records;
      if (op === 'get') {
        if (!recordId) return H.fail(res, 400, 'bad_request', 'recordId is required for op "get".');
        let rec = null;
        try {
          rec = await at.get(baseId, tableId, recordId, { returnFieldsByFieldId: !!params.returnFieldsByFieldId });
        } catch (e) {
          if (e.status === 404) rec = null; else throw e;
        }
        // A record outside scope must be indistinguishable from one that does not exist,
        // or "not found" vs "forbidden" becomes an enumeration oracle.
        const inScope = rec && (await recordPassesScope({
          rec, baseId, tableId, filter,
        }));
        if (!rec || !inScope || !P.recordWithinSensitivity(rule, tableSymbol, rec, nameToId)) {
          await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: 'scope_excluded', recordId });
          return H.fail(res, 404, 'not_found', 'No such record, or it is outside your access.');
        }
        records = [rec];
      } else {
        records = await at.list(baseId, tableId, {
          filterByFormula: filter || undefined,
          sort: Array.isArray(params.sort) ? params.sort : undefined,
          fields: Array.isArray(params.fields) ? params.fields : undefined,
          pageSize: params.pageSize,
          maxRecords: params.maxRecords,
          returnFieldsByFieldId: !!params.returnFieldsByFieldId,
        });
      }

      // Per-record sensitivity re-check, then field stripping. The filter should already have
      // excluded over-classified records; this catches anything it could not express.
      const out = records
        .filter((r) => P.recordWithinSensitivity(rule, tableSymbol, r, nameToId))
        .map((r) => ({ id: r.id, createdTime: r.createdTime, fields: P.filterReadFields(rule, r.fields, idToName) }));

      if (rule.audit_every_read) {
        // FICA: every read logged individually, and the session's idle timeout tightens.
        await A.auditNow({
          ...ctx, action: 'Restricted Document Viewed', result: 'Allowed',
          recordId: recordId || `${out.length} record(s)`,
        });
        S.markSessionTouchedRestricted(auth.sid).catch(() => {});
      } else {
        A.audit({ ...ctx, action: 'View', result: 'Allowed', recordId });
      }

      return H.ok(res, { records: out, scope });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // WRITES
    // ═══════════════════════════════════════════════════════════════════════
    if (op === 'create' || op === 'update') {
      if (!fields) return H.fail(res, 400, 'bad_request', 'fields is required.');
      if (op === 'update' && !recordId) return H.fail(res, 400, 'bad_request', 'recordId is required for op "update".');

      // Field-level: reject, never silently drop, and name the fields.
      const fieldCheck = P.validateWriteFields(rule, fields, idToName);
      if (!fieldCheck.ok) {
        await A.auditNow({
          ...ctx, action: op === 'create' ? 'Create' : 'Update', result: 'Denied',
          denialReason: fieldCheck.reason, recordId,
          field: fieldCheck.rejected.map((r) => r.field).join(', '),
        });
        return H.fail(res, 403, fieldCheck.reason, fieldCheck.detail, {
          fields: fieldCheck.rejected,
        });
      }

      // Schema-level: unknown names, computed fields, invalid select options.
      const schemaCheck = await at.validateAgainstSchema(baseId, tableId, fields);
      if (!schemaCheck.ok) {
        await A.auditNow({
          ...ctx, action: op === 'create' ? 'Create' : 'Update', result: 'Denied',
          denialReason: 'schema_invalid', recordId,
          field: schemaCheck.rejected.map((r) => r.field).join(', '),
        });
        return H.fail(res, 400, 'schema_invalid',
          `Rejected: ${schemaCheck.rejected.map((r) => `${r.field} (${r.detail})`).join('; ')}`,
          { fields: schemaCheck.rejected });
      }

      // Rule 2: a slip named as the source must be real and signed. Checked here so a
      // Rule 1, once the switch is thrown. Off by default; see guards.js.
      const needsSlip = G.guardDeliveryNeedsSlip({ tableSymbol, op, fields });
      if (!needsSlip.ok) {
        await A.auditNow({
          ...ctx, action: 'Create', result: 'Denied', denialReason: needsSlip.reason, recordId,
        });
        return H.fail(res, needsSlip.status, needsSlip.reason, needsSlip.detail);
      }

      // direct POST cannot skip the warehouse. See guards.js for why rule 1 is not here yet.
      const slipGuard = await G.guardDeliveryFromSlip({
        tableSymbol,
        op,
        fields,
        loadSlip: (rid) => {
          const r = T.resolve(baseSymbol, 'picking_slips');
          return r.ok ? at.get(r.baseId, r.tableId, rid).catch(() => null) : null;
        },
      });
      if (!slipGuard.ok) {
        await A.auditNow({
          ...ctx, action: 'Create', result: 'Denied', denialReason: slipGuard.reason, recordId,
        });
        return H.fail(res, slipGuard.status, slipGuard.reason, slipGuard.detail);
      }

      // Cross-base linked-record guard. The old client loaded only the C&I stock catalogue, so
      // an O&M delivery wrote a C&I record id into a link field. With typecast that silently
      // invented a junk Stock Item named after the id. typecast is gone, but reject it plainly.
      const crossBase = await findCrossBaseLinks(baseId, tableId, fields);
      if (crossBase.length) {
        await A.auditNow({
          ...ctx, action: op === 'create' ? 'Create' : 'Update', result: 'Denied',
          denialReason: 'cross_base_link', recordId, field: crossBase.map((c) => c.field).join(', '),
        });
        return H.fail(res, 400, 'cross_base_link',
          `Linked record(s) do not exist in this base: ${crossBase.map((c) => `${c.field} -> ${c.id}`).join('; ')}.`,
          { fields: crossBase });
      }

      if (op === 'create') {
        const created = await at.create(baseId, tableId, [fields], { returnFieldsByFieldId: !!params.returnFieldsByFieldId });
        const rec = created[0];
        await A.auditNow({
          ...ctx, action: 'Create', result: 'Allowed', recordId: rec && rec.id,
          newValue: fields,
        });
        return H.ok(res, {
          records: [{ id: rec.id, createdTime: rec.createdTime, fields: P.filterReadFields(rule, rec.fields, idToName) }],
        });
      }

      // Lockout invariants. Checked here, not in the Admin UI, so a direct curl cannot
      // demote the last Admin either. See api/_lib/guards.js.
      if (op === 'update' && tableSymbol === 'users') {
        const g = await G.guardUserUpdate({ actorEmail: auth.email, targetRecordId: recordId, fields });
        if (!g.ok) {
          await A.auditNow({ ...ctx, action: 'Update', result: 'Denied', denialReason: g.reason, recordId });
          return H.fail(res, g.status, g.reason, g.detail);
        }
      }
      if (op === 'update' && tableSymbol === 'access_levels') {
        const g = await G.guardRoleUpdate({ targetRecordId: recordId, fields });
        if (!g.ok) {
          await A.auditNow({ ...ctx, action: 'Permission Change', result: 'Denied', denialReason: g.reason, recordId });
          return H.fail(res, g.status, g.reason, g.detail);
        }
      }

      // update — confirm the record is in scope before touching it
      const existing = await at.get(baseId, tableId, recordId).catch((e) => {
        if (e.status === 404) return null;
        throw e;
      });
      const scopeFilter = P.buildReadFilter({
        moduleKey: tableSymbol, baseSymbol, rule, scope, user: auth.user, clientFilter: null,
      });

    // A signed picking slip is evidence. Refuse the edit here, where a direct POST is refused
    // Rule 8: closing is earned, not asserted. Reads the signature rollup on the record
    // rather than anything the caller sent, and names what is still outstanding.
    const closeGuard = await G.guardDeliveryClose({
      tableSymbol,
      fields,
      existing,
      // Looks for a Warehouse signature against the originating picking slip. One query, by
      // Document Ref, because a link field cannot be matched from the child side in a formula.
      warehouseSignedOnSlip: async (psNumber) => {
        const sig = T.resolve(baseSymbol, 'signatures');
        if (!sig.ok) return false;
        const row = await at.findOne(
          sig.baseId, sig.tableId,
          `AND({Document Ref} = "${G.esc(psNumber)}", {Role} = "Warehouse")`,
          ['Role', 'Document Ref'],
        ).catch(() => null);
        return !!row;
      },
    });
    if (!closeGuard.ok) {
      await A.auditNow({
        ...ctx, action: 'Update', result: 'Denied', denialReason: closeGuard.reason, recordId,
        newValue: (closeGuard.missing || []).join(', '),
      });
      return H.fail(res, closeGuard.status, closeGuard.reason, closeGuard.detail,
        closeGuard.missing ? { missing: closeGuard.missing } : undefined);
    }

    // too — not on the screen, where hiding the input would only stop the honest.
    const lock = await G.guardPickingSlipLock({
      tableSymbol,
      existing,
      fields,
      // Only a role that may delete picking slips may amend a signed one. Admin, in practice.
      canOverride: P.can(auth.perms, 'picking_slips', 'delete').ok,
      loadParent: (id) => at.get(baseId, T.resolve(baseSymbol, 'picking_slips').tableId, id)
        .catch(() => null),
    });
    if (!lock.ok) {
      await A.auditNow({ ...ctx, action: 'Update', result: 'Denied', denialReason: lock.reason, recordId });
      return H.fail(res, lock.status, lock.reason, lock.detail);
    }
    if (lock.overridden) {
      // An authorised change after signing must leave a mark — rule 12.
      await A.auditNow({
        ...ctx, action: 'Update', result: 'Allowed', recordId,
        denialReason: 'locked_record_amended_by_admin',
        newValue: 'fields: ' + Object.keys(fields || {}).join(', '),
      });
    }
      const inScope = existing && (await recordPassesScope({
        rec: existing, baseId, tableId, filter: scopeFilter,
      }));
      if (!existing || !inScope) {
        await A.auditNow({ ...ctx, action: 'Update', result: 'Denied', denialReason: 'scope_excluded', recordId });
        return H.fail(res, 404, 'not_found', 'No such record, or it is outside your access.');
      }

      const before = {};
      for (const k of Object.keys(fields)) before[k] = existing.fields[k];
      const updated = await at.update(baseId, tableId, recordId, fields, { returnFieldsByFieldId: !!params.returnFieldsByFieldId });

      await A.auditFieldChanges({
        ...ctx, recordId, before, after: fields,
      });

      return H.ok(res, {
        records: [{ id: updated.id, fields: P.filterReadFields(rule, updated.fields, idToName) }],
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // DELETE — soft where the module declares a tombstone field
    // ═══════════════════════════════════════════════════════════════════════
    if (op === 'delete') {
      if (!recordId) return H.fail(res, 400, 'bad_request', 'recordId is required for op "delete".');

      if (tableSymbol === 'users') {
        const g = await G.guardUserDelete({ actorEmail: auth.email, targetRecordId: recordId });
        if (!g.ok) {
          await A.auditNow({ ...ctx, action: 'Delete', result: 'Denied', denialReason: g.reason, recordId });
          return H.fail(res, g.status, g.reason, g.detail);
        }
      }

      const sd = resolved.config && resolved.config.softDelete;
      if (sd) {
        const updated = await at.update(baseId, tableId, recordId, { [sd.field]: sd.deletedValue });
        await A.auditNow({
          ...ctx, action: 'Delete', result: 'Allowed', recordId,
          field: sd.field, newValue: sd.deletedValue,
          denialReason: '',
        });
        return H.ok(res, { softDeleted: true, field: sd.field, value: sd.deletedValue, id: updated.id });
      }

      await at.destroy(baseId, tableId, recordId);
      await A.auditNow({ ...ctx, action: 'Delete', result: 'Allowed', recordId, newValue: 'HARD DELETE' });
      return H.ok(res, { deleted: true, id: recordId });
    }

    return H.fail(res, 400, 'unknown_op', 'Unsupported operation.');
  } catch (err) {
    console.error('[at] error:', err && err.message);
    if (err && err.name === 'AirtableError') {
      await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: 'airtable_error', recordId });
      // Airtable's own message can name fields and tables — return a generic one.
      return H.fail(res, err.status >= 500 ? 502 : 400, 'airtable_error',
        err.status === 404 ? 'No such record.' : 'The request could not be completed.');
    }
    return H.fail(res, 500, 'server_error', 'Something went wrong.');
  }
};

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Confirm a single record satisfies the scope filter, by re-querying with the filter AND-ed to
 * that record id. Done server-side so a get-by-id cannot bypass the scope a list would apply.
 */
async function recordPassesScope({ rec, baseId, tableId, filter }) {
  if (!filter) return true;
  if (filter === 'FALSE()') return false;
  const found = await at.list(baseId, tableId, {
    filterByFormula: `AND(RECORD_ID() = "${rec.id}", ${filter})`,
    pageSize: 1, maxRecords: 1, fields: [],
  });
  return found.length > 0;
}

/**
 * For every linked-record field in the payload, verify the target ids exist in THIS base.
 * Returns the offenders. See the cross-base note at the call site.
 */
async function findCrossBaseLinks(baseId, tableId, fields) {
  const schema = await at.tableSchema(baseId, tableId);
  if (!schema) return [];
  const problems = [];

  for (const [name, value] of Object.entries(fields || {})) {
    const f = schema.fields[name];
    if (!f || f.type !== 'multipleRecordLinks') continue;
    const ids = Array.isArray(value) ? value : value ? [value] : [];
    const linkedTableId = f.options && f.options.linkedTableId;
    if (!linkedTableId || !ids.length) continue;

    for (const id of ids) {
      if (typeof id !== 'string' || !/^rec[A-Za-z0-9]{14}$/.test(id)) {
        problems.push({ field: name, id: String(id), why: 'not_a_record_id' });
        continue;
      }
      try {
        await at.get(baseId, linkedTableId, id);
      } catch (e) {
        if (e.status === 404) problems.push({ field: name, id, why: 'not_in_this_base' });
        else throw e;
      }
    }
  }
  return problems;
}
