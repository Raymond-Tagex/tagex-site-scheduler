// TAGEX Operations Platform — permission engine (Part B)
//
// Evaluates the seeded Access Levels.Permissions JSON. This is the only place that decides
// what a session may do. The UI's copy of these rules is cosmetic; every request is
// re-checked here, server-side.
//
// Three layers, in order:
//   1. MODULE + OPERATION   can()             — the Part B matrix
//   2. FIELD               readFilter/validateWrite — the field-level restriction table
//   3. RECORD              scopeFilter()      — All Records / Assigned Only / Own Records Only
//
// Deny by default at every layer. An absent module key, an unresolvable scope field, an
// unparseable Permissions blob — all deny. There is no code path that widens access on error.
//
// CommonJS, Node 24.

'use strict';

const T = require('./tables.js');

const OPS = Object.freeze(['view', 'create', 'edit', 'delete', 'export']);

// Airtable operation → permission verb.
const OP_FOR_AIRTABLE = Object.freeze({
  list: 'view', get: 'view', create: 'create', update: 'edit', delete: 'delete',
});

// ─────────────────────────────────────────────────────────────
// FORMULA SAFETY
//
// Every string that reaches a filterByFormula goes through here. The old client-side code
// escaped only double quotes, which left a backslash able to alter the formula.
// ─────────────────────────────────────────────────────────────

/** Escape a value for use inside an Airtable formula string literal. */
function escapeFormulaString(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')   // backslash FIRST, or the quote escapes get double-escaped
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]/g, ' ');
}

/** A formula literal, quoted and escaped. */
function lit(value) {
  return `"${escapeFormulaString(value)}"`;
}

/** AND together any number of formula fragments, dropping empties. Null if nothing to add. */
function andFilters(...parts) {
  const clean = parts.filter((p) => typeof p === 'string' && p.trim() !== '');
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0];
  return `AND(${clean.join(', ')})`;
}

function orFilters(...parts) {
  const clean = parts.filter((p) => typeof p === 'string' && p.trim() !== '');
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0];
  return `OR(${clean.join(', ')})`;
}

/**
 * Delimiter-wrapped containment test, for comma-separated fields.
 * Plain FIND("a@b.co", …) would also match "xa@b.co" — this will not.
 */
function containsToken(fieldName, token) {
  const haystack = `"," & SUBSTITUTE(LOWER({${fieldName}} & ""), " ", "") & ","`;
  return `FIND(${lit(',' + String(token).toLowerCase().trim() + ',')}, ${haystack}) > 0`;
}

/** Case-insensitive substring test against a field. */
function fieldContains(fieldName, needle) {
  return `FIND(${lit(String(needle).toUpperCase())}, UPPER({${fieldName}} & "")) > 0`;
}

// ─────────────────────────────────────────────────────────────
// PARSING & MERGING
// ─────────────────────────────────────────────────────────────

/** Parse a JSON field from Airtable. Returns fallback on anything unparseable — never throws. */
function parseJsonField(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(String(raw));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback; // a corrupt Permissions blob must deny, not crash and not open up
  }
}

function mergeFieldRules(base = {}, override = {}) {
  const out = {
    deny_read:  [...new Set([...(base.deny_read || []), ...(override.deny_read || [])])],
    deny_write: [...new Set([...(base.deny_write || []), ...(override.deny_write || [])])],
  };
  // allow_write is an allow-list: when either side declares one, the result is the
  // INTERSECTION if both do, otherwise whichever exists. It can only ever narrow.
  const a = base.allow_write;
  const b = override.allow_write;
  if (a && b) out.allow_write = a.filter((f) => b.includes(f));
  else if (a) out.allow_write = [...a];
  else if (b) out.allow_write = [...b];
  return out;
}

/**
 * Merge a role's Permissions with a user's Permission Overrides.
 *
 * Denies always win. An override may narrow a granted operation to false, and may grant
 * an operation the role lacks — but ONLY on a module the role already has, so an override
 * can never hand a Warehouse user the Users module. Field denies union; allow_write
 * intersects. sensitivity_max takes the lower of the two.
 */
function effectivePermissions(rolePermissionsRaw, userOverridesRaw) {
  const role = parseJsonField(rolePermissionsRaw, null);
  if (!role) return {}; // unparseable or empty role => no access to anything

  const overrides = parseJsonField(userOverridesRaw, {}) || {};
  const out = {};

  for (const [moduleKey, roleRule] of Object.entries(role)) {
    if (!roleRule || typeof roleRule !== 'object') continue;
    const ov = overrides[moduleKey];
    const merged = {};

    for (const op of OPS) {
      const roleAllows = roleRule[op] === true;
      if (!ov || !(op in ov)) { merged[op] = roleAllows; continue; }
      // An override may grant or revoke, but only within a module the role already holds.
      merged[op] = ov[op] === true;
    }

    merged.fields = mergeFieldRules(roleRule.fields, ov && ov.fields);

    // sensitivity_max / export_sensitivity_max: the more restrictive of the two wins.
    for (const key of ['sensitivity_max', 'export_sensitivity_max']) {
      const roleMax = roleRule[key];
      const ovMax = ov && ov[key];
      if (roleMax && ovMax) {
        merged[key] = T.sensitivityRank(ovMax) < T.sensitivityRank(roleMax) ? ovMax : roleMax;
      } else if (roleMax) merged[key] = roleMax;
      else if (ovMax) merged[key] = ovMax;
    }

    // Passthrough flags used by restricted_personal.
    for (const flag of ['require_user_flag', 'audit_every_read', 'list_view']) {
      if (flag in roleRule) merged[flag] = roleRule[flag];
    }
    if (roleRule.scope) merged.scope = roleRule.scope;
    if (ov && ov.scope) merged.scope = ov.scope;

    out[moduleKey] = merged;
  }

  // Modules present ONLY in the overrides are ignored on purpose — an override cannot
  // introduce a module the role does not have. That is what keeps deny-by-default intact.
  return out;
}

// ─────────────────────────────────────────────────────────────
// LAYER 1 — MODULE + OPERATION
// ─────────────────────────────────────────────────────────────

/**
 * @returns {{ok: true, rule: object} | {ok: false, status: number, reason: string, detail: string}}
 */
function can(perms, moduleKey, op) {
  if (!OPS.includes(op)) {
    return { ok: false, status: 400, reason: 'unknown_op', detail: `Unknown operation "${op}".` };
  }
  const rule = perms && perms[moduleKey];
  if (!rule) {
    return {
      ok: false, status: 403, reason: 'module_denied',
      detail: `Your role has no access to the "${moduleKey}" module.`,
    };
  }
  if (rule[op] !== true) {
    return {
      ok: false, status: 403, reason: 'op_denied',
      detail: `Your role may not ${op} in the "${moduleKey}" module.`,
    };
  }
  return { ok: true, rule };
}

/**
 * The restricted-personal double gate. Role flag AND per-user flag, both required.
 * Called in addition to can(), never instead of it.
 */
function canViewRestricted(rule, role, user) {
  if (!rule || rule.require_user_flag !== true) return { ok: true };
  const roleFlag = role && role['Can View Restricted Documents'] === true;
  const userFlag = user && user['Can View Restricted Documents'] === true;
  if (!roleFlag || !userFlag) {
    return {
      ok: false, status: 403, reason: 'restricted_gate',
      detail: 'Restricted personal data requires both the role permission and the per-user Can View Restricted Documents flag.',
    };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// LAYER 2 — FIELDS
// ─────────────────────────────────────────────────────────────

/**
 * Resolve a record key to its field NAME.
 *
 * Airtable returns records keyed by field name normally, but by `fld…` id when the caller
 * asked for returnFieldsByFieldId. Permission rules are written in names, so every rule check
 * must translate first — otherwise a deny_read silently matches nothing and the field is
 * handed over anyway.
 *
 * @param {object} [idToName] map from api.fieldMaps(); omit when keys are already names
 */
function canonicalField(key, idToName) {
  if (idToName && /^fld[A-Za-z0-9]{14}$/.test(key)) return idToName[key] || key;
  return key;
}

/** True when this key refers to a field on the list, by either name or id. */
function matchesField(key, list, idToName) {
  if (!list || !list.length) return false;
  if (list.includes(key)) return true;
  const name = canonicalField(key, idToName);
  return name !== key && list.includes(name);
}

/**
 * Strip every field this role may not read, plus the global never-return list.
 * Applied to the RESPONSE BODY, not by omitting from fields[] — a request with no
 * fields[] would otherwise return everything.
 *
 * Works whether the record is keyed by field name or by field id.
 */
function filterReadFields(rule, fields, idToName) {
  const denied = (rule && rule.fields ? rule.fields.deny_read || [] : []);
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (matchesField(k, denied, idToName)) continue;
    if (matchesField(k, T.NEVER_RETURN, idToName)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Validate a write payload.
 *
 * Rejects — never silently drops — with the offending field names, so the 403 can name them:
 *   • anything on the global never-return list
 *   • anything in deny_write
 *   • anything NOT in allow_write, when an allow_write list is present
 */
function validateWriteFields(rule, fields, idToName) {
  const keys = Object.keys(fields || {});
  const fr = (rule && rule.fields) || {};
  const denyWrite = fr.deny_write || [];
  const allowWrite = fr.allow_write || null;

  const rejected = [];
  for (const key of keys) {
    // Report the human-readable name even when the client wrote by id — "Unit Cost" is a far
    // more useful 403 than "fldBMRad0IjocAKS4".
    const name = canonicalField(key, idToName);
    if (matchesField(key, T.NEVER_RETURN, idToName)) { rejected.push({ field: name, why: 'never_writable' }); continue; }
    if (matchesField(key, denyWrite, idToName))      { rejected.push({ field: name, why: 'deny_write' });     continue; }
    if (allowWrite && !matchesField(key, allowWrite, idToName)) {
      rejected.push({ field: name, why: 'not_in_allow_write' });
    }
  }

  if (rejected.length) {
    const list = rejected.map((r) => r.field).join(', ');
    return {
      ok: false, status: 403, reason: 'field_denied_write', rejected,
      detail: `Your role may not write these field(s): ${list}.`,
    };
  }
  return { ok: true };
}

/**
 * Sensitivity gate for a single record. Blank/unknown counts as Restricted.
 * Returns true when the record is within the role's cap.
 */
/** Read a field from a record whether it is keyed by name or by field id. */
function readField(record, fieldName, nameToId) {
  const f = (record && record.fields) || {};
  if (fieldName in f) return f[fieldName];
  const id = nameToId && nameToId[fieldName];
  return id && id in f ? f[id] : null;
}

function recordWithinSensitivity(rule, moduleKey, record, nameToId) {
  const cfg = T.TABLES[moduleKey];
  if (!cfg || !cfg.sensitivityField) return true; // module is not sensitivity-classified
  const max = rule && rule.sensitivity_max;
  const level = readField(record, cfg.sensitivityField, nameToId);
  const value = level && typeof level === 'object' ? level.name : level;
  return T.sensitivityAllowed(value, max);
}

/**
 * Export gate for a single record.
 *
 * Part B distinguishes what a role may SEE from what it may EXPORT: Operations/PM may view
 * Confidential documents but may only export Public and Internal ones, and Admin may view
 * Restricted but may not export it. A single `export` boolean cannot say that, so a module
 * may declare export_sensitivity_max — a second, tighter cap that applies to exports only.
 *
 * Where it is absent, export falls back to the read cap and the plain `export` flag.
 */
function recordExportable(rule, moduleKey, record, nameToId) {
  if (!rule || rule.export !== true) return false;
  const cfg = T.TABLES[moduleKey];
  if (!cfg || !cfg.sensitivityField) return true;
  const cap = rule.export_sensitivity_max || rule.sensitivity_max;
  const level = readField(record, cfg.sensitivityField, nameToId);
  const value = level && typeof level === 'object' ? level.name : level;
  return T.sensitivityAllowed(value, cap);
}

/**
 * A filterByFormula fragment restricting reads to the role's sensitivity cap.
 * Belt and braces with recordWithinSensitivity: this keeps over-classified records off
 * the wire in the first place, the per-record check catches anything the filter misses.
 */
function sensitivityFilter(rule, moduleKey) {
  const cfg = T.TABLES[moduleKey];
  if (!cfg || !cfg.sensitivityField) return null;
  const max = rule && rule.sensitivity_max;
  if (!max) return 'FALSE()'; // classified module, no cap declared => nothing passes
  const allowed = T.SENSITIVITY_ORDER.filter(
    (lvl) => T.sensitivityRank(lvl) <= T.sensitivityRank(max)
  );
  if (!allowed.length) return 'FALSE()';
  // Blank is deliberately excluded: it is not equal to any listed level, so unclassified
  // documents do not come back. That is deny-by-default working as intended.
  return orFilters(...allowed.map((lvl) => `{${cfg.sensitivityField}} = ${lit(lvl)}`));
}

/** Excludes soft-deleted rows, where the module treats its status field as a tombstone. */
function softDeleteFilter(moduleKey) {
  const cfg = T.TABLES[moduleKey];
  const sd = cfg && cfg.softDelete;
  if (!sd || !sd.excludeOnRead) return null;
  return `{${sd.field}} != ${lit(sd.deletedValue)}`;
}

// ─────────────────────────────────────────────────────────────
// LAYER 3 — RECORD SCOPE
// ─────────────────────────────────────────────────────────────

function scopeFieldFor(moduleKey, baseSymbol, kind) {
  const m = T.SCOPE_FIELDS[moduleKey];
  if (!m) return null;
  const entry = m[kind];
  if (!entry) return null;
  return entry[baseSymbol] || null;
}

/**
 * Build the record-scope filter for a module.
 *
 * Returns:
 *   null      — All Records; no restriction (caller must still AND in sensitivity/soft-delete)
 *   'FALSE()' — scope cannot be expressed against this schema; deny everything
 *   string    — the formula fragment to AND with the client's filter
 *
 * Never returns a filter that widens access, and never replaces the caller's filter.
 */
function scopeFilter({ moduleKey, baseSymbol, scope, user }) {
  if (scope === 'All Records' || !scope) return null;

  const email = String((user && user.Email) || '').toLowerCase().trim();
  if (!email) return 'FALSE()';

  const assignedClients = parseJsonField(user && user['Assigned Clients'], []) || [];
  const assignedSites   = parseJsonField(user && user['Assigned Sites'], []) || [];

  if (scope === 'Own Records Only') {
    const ownerField = scopeFieldFor(moduleKey, baseSymbol, 'ownerEmail');
    if (!ownerField) return 'FALSE()';
    return `LOWER({${ownerField}} & "") = ${lit(email)}`;
  }

  if (scope === 'Assigned Only') {
    const clauses = [];

    const assignedField = scopeFieldFor(moduleKey, baseSymbol, 'assignedEmail');
    if (assignedField) clauses.push(containsToken(assignedField, email));

    const clientField = scopeFieldFor(moduleKey, baseSymbol, 'clientField');
    if (clientField && Array.isArray(assignedClients) && assignedClients.length) {
      clauses.push(...assignedClients.map((c) => fieldContains(clientField, c)));
    }

    const siteField = scopeFieldFor(moduleKey, baseSymbol, 'siteField');
    if (siteField && Array.isArray(assignedSites) && assignedSites.length) {
      clauses.push(...assignedSites.map((s) => fieldContains(siteField, s)));
    }

    // Nothing to match on => the scope is unenforceable against this schema. Deny.
    if (!clauses.length) return 'FALSE()';
    return orFilters(...clauses);
  }

  return 'FALSE()'; // unrecognised scope value
}

/**
 * Sanity-check a client-supplied filterByFormula.
 *
 * The structural protection is in buildReadFilter: the client's formula is wrapped in its own
 * parentheses and passed as ONE argument to AND(), so it cannot close the AND early and shed
 * the scope clause — any attempt to do so unbalances the expression and Airtable rejects it.
 *
 * This adds a cheap front door: reject unbalanced delimiters and absurd lengths before they
 * reach Airtable, so a malformed filter fails as a clear 400 rather than an opaque 422.
 *
 * @returns {{ok:true} | {ok:false, reason:string, detail:string}}
 */
function validateClientFilter(formula) {
  if (formula == null || formula === '') return { ok: true };
  const s = String(formula);

  if (s.length > 4000) {
    return { ok: false, reason: 'filter_too_long', detail: 'filterByFormula is too long.' };
  }

  let depth = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }  // skip the escaped character
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth < 0) break; }
  }

  if (inString) {
    return { ok: false, reason: 'filter_malformed', detail: 'filterByFormula has an unterminated string literal.' };
  }
  if (depth !== 0) {
    return { ok: false, reason: 'filter_malformed', detail: 'filterByFormula has unbalanced parentheses.' };
  }
  return { ok: true };
}

/**
 * Compose the full read filter: the client's own filter AND-ed with scope, sensitivity and
 * soft-delete. The client filter is never replaced or dropped.
 */
function buildReadFilter({ moduleKey, baseSymbol, rule, scope, user, clientFilter }) {
  return andFilters(
    clientFilter && String(clientFilter).trim() ? `(${clientFilter})` : null,
    scopeFilter({ moduleKey, baseSymbol, scope, user }),
    sensitivityFilter(rule, moduleKey),
    softDeleteFilter(moduleKey)
  );
}

/** The scope a session actually runs at: the user's override, else the role's default. */
function effectiveScope(role, user, rule) {
  if (rule && rule.scope === 'own') return 'Own Records Only';
  return (user && user['Record Scope']) || (role && role['Default Record Scope']) || 'All Records';
}

module.exports = {
  OPS,
  OP_FOR_AIRTABLE,
  escapeFormulaString,
  lit,
  andFilters,
  orFilters,
  containsToken,
  fieldContains,
  parseJsonField,
  effectivePermissions,
  can,
  canViewRestricted,
  canonicalField,
  matchesField,
  readField,
  filterReadFields,
  validateWriteFields,
  recordWithinSensitivity,
  recordExportable,
  sensitivityFilter,
  softDeleteFilter,
  scopeFilter,
  validateClientFilter,
  buildReadFilter,
  effectiveScope,
};
