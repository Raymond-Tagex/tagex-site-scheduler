// TAGEX — Airtable service client.
//
// The ONLY place in this codebase that holds AIRTABLE_PAT and the only place that talks to
// api.airtable.com. Nothing here is reachable from the browser.
//
// Deliberately does NOT support `typecast`. The old client-side code sent typecast:true on every
// write, which silently coerced types and could invent new single-select options and new linked
// records. Part C6 requires validating against the live schema and rejecting unknown values, so
// writes fail loudly instead.

'use strict';

const API = 'https://api.airtable.com/v0';
const META = 'https://api.airtable.com/v0/meta/bases';

function pat() {
  const t = process.env.AIRTABLE_PAT;
  if (!t) throw new Error('AIRTABLE_PAT is not set');
  return t;
}

class AirtableError extends Error {
  constructor(status, body) {
    const msg = (body && body.error && (body.error.message || body.error.type)) || `HTTP ${status}`;
    super(msg);
    this.name = 'AirtableError';
    this.status = status;
    this.body = body;
  }
}

async function call(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${pat()}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) throw new AirtableError(res.status, body);
  return body;
}

// ── records ────────────────────────────────────────────────────────────────

/**
 * List records, following pagination.
 * @param {object} params  filterByFormula, sort, fields, pageSize, maxRecords, view
 * @param {number} hardCap  stop after this many records regardless (protects the function)
 */
async function list(baseId, tableId, params = {}, hardCap = 5000) {
  const out = [];
  let offset = null;

  do {
    const qs = new URLSearchParams();
    if (params.filterByFormula) qs.set('filterByFormula', params.filterByFormula);
    if (params.pageSize) qs.set('pageSize', String(Math.min(100, Number(params.pageSize) || 100)));
    if (params.maxRecords) qs.set('maxRecords', String(params.maxRecords));
    // Some apps address fields by id rather than name. Passed through, but the caller
    // MUST then translate before applying permission rules — see fieldMaps().
    if (params.returnFieldsByFieldId) qs.set('returnFieldsByFieldId', 'true');
    if (Array.isArray(params.fields)) params.fields.forEach((f) => qs.append('fields[]', f));
    if (Array.isArray(params.sort)) {
      params.sort.forEach((s, i) => {
        if (!s || !s.field) return;
        qs.set(`sort[${i}][field]`, s.field);
        qs.set(`sort[${i}][direction]`, s.direction === 'desc' ? 'desc' : 'asc');
      });
    }
    if (offset) qs.set('offset', offset);

    const d = await call(`${API}/${baseId}/${tableId}?${qs.toString()}`);
    out.push(...(d.records || []));
    offset = d.offset || null;
    if (out.length >= hardCap) break;
  } while (offset);

  return out;
}

async function get(baseId, tableId, recordId, opts = {}) {
  const qs = opts.returnFieldsByFieldId ? '?returnFieldsByFieldId=true' : '';
  return call(`${API}/${baseId}/${tableId}/${encodeURIComponent(recordId)}${qs}`);
}

/** Create records in batches of 10. No typecast — see the file header. */
async function create(baseId, tableId, fieldsArray, opts = {}) {
  const created = [];
  for (let i = 0; i < fieldsArray.length; i += 10) {
    const chunk = fieldsArray.slice(i, i + 10).map((fields) => ({ fields }));
    const payload = { records: chunk };
    // Callers that address fields by id need the response keyed the same way, or they cannot
    // read back what they just wrote.
    if (opts.returnFieldsByFieldId) payload.returnFieldsByFieldId = true;
    const d = await call(`${API}/${baseId}/${tableId}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    created.push(...(d.records || []));
  }
  return created;
}

async function update(baseId, tableId, recordId, fields, opts = {}) {
  const payload = { fields };
  if (opts.returnFieldsByFieldId) payload.returnFieldsByFieldId = true;
  return call(`${API}/${baseId}/${tableId}/${encodeURIComponent(recordId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

async function destroy(baseId, tableId, recordId) {
  return call(`${API}/${baseId}/${tableId}/${encodeURIComponent(recordId)}`, { method: 'DELETE' });
}

/** First record matching a formula, or null. */
async function findOne(baseId, tableId, formula, fields) {
  const recs = await list(baseId, tableId, {
    filterByFormula: formula, pageSize: 1, maxRecords: 1, fields,
  });
  return recs[0] || null;
}

// ── schema cache ───────────────────────────────────────────────────────────
// Used to validate writes: unknown field names and invalid select options are rejected
// rather than coerced. Cached per warm instance; a schema change takes up to TTL to appear.

const SCHEMA_TTL_MS = 10 * 60 * 1000;
const schemaCache = new Map(); // baseId -> { at, tables }

async function baseSchema(baseId) {
  const hit = schemaCache.get(baseId);
  if (hit && Date.now() - hit.at < SCHEMA_TTL_MS) return hit.tables;
  const d = await call(`${META}/${baseId}/tables`);
  const tables = {};
  for (const t of d.tables || []) {
    const fields = {};
    for (const f of t.fields || []) fields[f.name] = f;
    tables[t.id] = { id: t.id, name: t.name, fields, primaryFieldId: t.primaryFieldId };
  }
  schemaCache.set(baseId, { at: Date.now(), tables });
  return tables;
}

async function tableSchema(baseId, tableId) {
  const tables = await baseSchema(baseId);
  return tables[tableId] || null;
}

/**
 * Field id ↔ name maps for one table.
 *
 * Needed because a client may ask Airtable for `returnFieldsByFieldId=true`, in which case
 * records come back keyed by `fld…` rather than by field name. The permission rules are
 * written in names ("Unit Cost"), so without this translation a deny_read would match nothing
 * and strip nothing — silently handing over a field the role is not allowed to see.
 *
 * @returns {{idToName: Object, nameToId: Object}}
 */
async function fieldMaps(baseId, tableId) {
  const schema = await tableSchema(baseId, tableId);
  const idToName = {};
  const nameToId = {};
  if (schema) {
    for (const [name, f] of Object.entries(schema.fields)) {
      idToName[f.id] = name;
      nameToId[name] = f.id;
    }
  }
  return { idToName, nameToId };
}

/** Values Airtable computes; never writable, and rejected with a clear reason. */
const COMPUTED_TYPES = new Set([
  'formula', 'rollup', 'count', 'multipleLookupValues', 'createdTime',
  'lastModifiedTime', 'createdBy', 'lastModifiedBy', 'autoNumber', 'button', 'aiText',
]);

/**
 * Validate a write payload against the live schema.
 * Rejects unknown fields, computed fields, and invalid single/multi-select options.
 * @returns {{ok:true} | {ok:false, rejected:Array<{field,why,detail}>}}
 */
async function validateAgainstSchema(baseId, tableId, fields) {
  const schema = await tableSchema(baseId, tableId);
  if (!schema) return { ok: false, rejected: [{ field: '*', why: 'unknown_table', detail: 'Table not in schema.' }] };

  // Accept keys given as either a field name or a field id, and report the name either way.
  const byId = {};
  for (const f of Object.values(schema.fields)) byId[f.id] = f;

  const rejected = [];
  for (const [key, value] of Object.entries(fields || {})) {
    const f = schema.fields[key] || byId[key];
    const name = f ? f.name : key;
    if (!f) { rejected.push({ field: name, why: 'unknown_field', detail: 'No such field on this table.' }); continue; }
    if (COMPUTED_TYPES.has(f.type)) {
      rejected.push({ field: name, why: 'computed_field', detail: `${f.type} fields are calculated by Airtable and cannot be written.` });
      continue;
    }
    if (f.type === 'singleSelect' && value != null && value !== '') {
      const names = (f.options && f.options.choices || []).map((c) => c.name);
      if (!names.includes(value)) {
        rejected.push({ field: name, why: 'invalid_option', detail: `"${value}" is not an option. Valid: ${names.join(', ')}.` });
      }
    }
    if (f.type === 'multipleSelects' && Array.isArray(value)) {
      const names = (f.options && f.options.choices || []).map((c) => c.name);
      const bad = value.filter((v) => !names.includes(v));
      if (bad.length) {
        rejected.push({ field: name, why: 'invalid_option', detail: `Not options: ${bad.join(', ')}. Valid: ${names.join(', ')}.` });
      }
    }
  }
  return rejected.length ? { ok: false, rejected } : { ok: true };
}

module.exports = {
  AirtableError,
  list, get, create, update, destroy, findOne,
  baseSchema, tableSchema, fieldMaps, validateAgainstSchema,
  COMPUTED_TYPES,
};
