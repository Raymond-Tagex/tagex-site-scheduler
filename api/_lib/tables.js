// TAGEX Operations Platform — server-side base/table whitelist
//
// THE CLIENT NEVER NAMES AN AIRTABLE ID. It sends symbols ("CI", "delivery_notes")
// and this module resolves them. Nothing in this file is ever sent to the browser.
//
// Deny by default: a symbol absent from these maps is denied. Adding a table here is
// what grants the *possibility* of access; the role's Permissions JSON decides the rest.
//
// CommonJS to match the rest of api/. Node 24.

'use strict';

// ─────────────────────────────────────────────────────────────
// BASES
// ─────────────────────────────────────────────────────────────
const BASES = {
  CI:  'appfzAX5YHqg4UXCl', // TAGEX – C&I Operations Platform
  OM:  'app0tq4y9wH10h6Up', // TAGEX – O&M Platform
  IAM: 'appVrQ4Nuwb9gk6Ip', // TAGEX – Identity & Access (Workspace 2, Directors only)
  // The stock catalogue lives in its own base. It is a supplier/product master, not an
  // operations base: it carries no job cards, no delivery notes and no personal data, so the
  // only module mapped into it is stock_items.
  STK: 'appeEsQofgu9tgngN', // TAGEX – Palladium Stock Master
};

// ─────────────────────────────────────────────────────────────
// TABLES
//
// Keyed by module symbol, then by base symbol. A module that resolves in one base
// and not another is normal (restricted_personal is C&I only; identity is IAM only).
//
// softDelete names the field used to retire a record instead of hard-deleting it.
// Where it is absent, delete means delete — and only Admin has it.
// ─────────────────────────────────────────────────────────────
const TABLES = {
  // ── Operational: present in both bases ──────────────────────
  job_cards: {
    CI: 'tbl2wqnfM0eDa8M7P',
    OM: 'tbl2wqnfM0eDa8M7P', // same id in both bases — not a typo
  },
  clients: {
    CI: 'tblljzSDboKGUJAXg',
    OM: 'tblljzSDboKGUJAXg',
  },
  documents: {
    CI: 'tbljdfGLoiHlrdzfs',
    OM: 'tbljdfGLoiHlrdzfs',
    softDelete: { field: 'Record Status', deletedValue: 'Deleted', excludeOnRead: true },
    sensitivityField: 'Sensitivity',
  },
  delivery_notes: {
    CI: 'tblpdJP1RYL9WHSMq',
    OM: 'tblCnFI2EDwBgEKmi',
    // "Cancelled" is a real business status, not a tombstone — a cancelled delivery note
    // must stay visible and reprintable. So delete soft-sets it, but reads do NOT exclude it.
    softDelete: { field: 'Status', deletedValue: 'Cancelled', excludeOnRead: false },
  },
  // ── Picking slip workflow ────────────────────────────────────────────────
  // A delivery note is created FROM a picking slip and never directly, so these three sit
  // alongside delivery_notes rather than replacing anything. Legacy notes simply have no
  // picking slip linked, and keep working exactly as they did.
  picking_slips: {
    CI: 'tbl7da6Nig9SYnfqI',
    OM: 'tbldwxyX9xaDwmG1Y',
    // Cancelled is a status, never a deletion — rule 10.
    softDelete: { field: 'Status', deletedValue: 'Cancelled', excludeOnRead: false },
  },
  picking_slip_items: {
    CI: 'tblKgEmdODjapwqfQ',
    OM: 'tblv8WkVkblhoMLUc',
  },
  // Signatures are append-only in practice: one row per role per document. Nothing in the
  // application ever updates or deletes one, which is what makes 'no signature may overwrite
  // another' structural rather than a rule someone has to remember.
  signatures: {
    CI: 'tbll145W3k6IYs48C',
    OM: 'tblhRTr4W0DnzGs4d',
  },
  delivery_lines: {
    CI: 'tbloMBkQNCafn8rLI',
    OM: 'tblhstPiOo5SgAF6x',
  },
  stock_items: {
    CI:  'tblaWIGSRHtKbaYBE',
    OM:  'tbl1lGcVzPHz3QLZ8',
    STK: 'tblunrbqwZld0rO1J', // PALLADIUM STOCK
  },
  site_visits: {
    CI: 'tblXDw1aHzkItZEV3',
    OM: 'tblny4UUKq8OIHQlw',
    // Field names diverge between bases — see FIELD_ALIASES below.
  },

  // ── Service tickets ──────────────────────────────────────────
  // A ticket is one reported fault: the layer between a job card (the installation) and a site
  // visit (one trip to it). One job card has many tickets; one ticket has many visits.
  //
  // O&M ONLY for now. The C&I scheduler is a different application with its own auth model, so
  // mirroring this there is separate work — a module that resolves in one base and not the
  // other is normal here.
  //
  // ADDRESSED BY SUB-SYMBOL, like restricted_personal, so that ONE permission key ('tickets',
  // already seeded in every role) governs both tables. A spare line has no meaning apart from
  // its ticket, and giving it a second key would mean an IAM change to say something the
  // ticket's own permissions already say.
  //
  // KNOWN LIMIT: Warehouse / Stores holds tickets:view and no edit, so nobody can fill
  // "Qty Issued" through this app yet. That is a real gap the day the warehouse works spares
  // from here, and closing it is an IAM change, not a code change.
  tickets: {
    OM: {
      ticket: 'tbln5V2ynpBY9sIOc',
      spares: 'tblWkdyee2XZCFxp9',
    },
  },

  // The persistent profile of a site and its system. Neither base has a Sites table -- a site
  // exists only as free text on Clients and as a lookup on Job Cards -- so this is the first
  // real per-site record in the platform. Operational and technical data only: it carries no
  // FICA, banking or financial fields, which is the module's whole reason for being separate.
  site_information: {
    CI: 'tblAEHyOU3qoJ9jX9',
    OM: 'tblVzPWfmtMEGl4Bm',
  },
  // Many rows per site, each with its own serial number and warranty expiry -- which a flat
  // field set on the site record cannot hold.
  site_equipment: {
    CI: 'tblBAweICNLJQh79d',
    OM: 'tblSD5fhzoLUu6bQS',
  },
  activity_log: {
    CI: 'tblWSJlbiGWlZ6yGL',
    OM: 'tblWSJlbiGWlZ6yGL',
    // NOTE: O&M also has "Activity Log System" (tblpnOAnvPnVEBxnC). Deliberately NOT
    // whitelisted — the delivery app has never written to it and nothing should start.
  },
  costing: {
    CI: 'tblLZ7zJFusjwUkbU',
    OM: 'tblLZ7zJFusjwUkbU',
  },
  people: {
    CI: 'tblYXKBqfN4zituh1',
    OM: 'tblYXKBqfN4zituh1',
  },

  // ── Restricted personal / FICA data — C&I ONLY, Admin only ──
  // Double-gated: the role's Can View Restricted Documents AND the per-user flag of
  // the same name must both be true. Every read is audit-logged individually as
  // "Restricted Document Viewed". Never list-viewable, never exportable.
  // Addressed as { table: 'restricted_personal', sub: 'financial_vetting' }. Sub-symbols exist
  // because the client may never name a tbl… id, and one permission key governs all five.
  restricted_personal: {
    CI: {
      financial_vetting:  'tblVUssahq7fBFOQh', // credit score, salary, judgements, adverse info
      document_folders:   'tblLz9avQ1RvRJqfy', // FICA Documents + 20 doc-category flags
      residential_leads:  'tbl9N266QxTVKGydL', // name, phone, email, SUB/SOL
      direct_purchases:   'tblBMNIQ5rgTZ9BhG', // personal details + FICA Uploaded
      commercial_leads:   'tblANaQPamedxc8xV', // contact person, phone, email
    },
  },

  // ── Identity base — IAM only ────────────────────────────────
  users:         { IAM: 'tblCIDKFtir7xQsr9' },
  access_levels: { IAM: 'tblkIysBGLDHaiXhI' },
  audit_log:     { IAM: 'tblCCaihI508YkB6r' },
  sessions:      { IAM: 'tbluVrCca6m4GKIlg' },
};

// ─────────────────────────────────────────────────────────────
// NOT PROVISIONED
//
// Modules named in the Part B permission matrix that have no table in either base.
// They are seeded in the roles' Permissions JSON so the matrix is encoded faithfully
// and lights up the day the tables are built. Until then they deny with a reason that
// distinguishes "you may not" from "it does not exist yet" — which matters when an
// Admin is debugging why something 403s.
// ─────────────────────────────────────────────────────────────
const NOT_PROVISIONED = new Set([
  'systems',
  'contracts',
  'slas',
  'warranty_register',
  'error_criteria',
  'second_hand_parts',
  'support_requests',
  'response_templates',
]);

// UI-only surfaces. Never resolve to a table; permission checks on them govern
// whether the nav item renders and whether an export is allowed to run.
const VIRTUAL_MODULES = new Set(['dashboard', 'reports']);

// ─────────────────────────────────────────────────────────────
// GLOBAL NEVER-RETURN FIELDS
//
// Stripped from every response body for EVERY role including Admin, and rejected on
// write, before any role logic runs. Enforced as a filter on the response — not merely
// by omitting them from fields[] — because a request with no fields[] returns everything.
// ─────────────────────────────────────────────────────────────
const NEVER_RETURN = Object.freeze([
  'Password Hash',
  'MFA Secret',
  'Invite Token Hash',
  // Pre-existing plaintext password field on Sign-Offs in BOTH operational bases
  // (fldrbYUYwcrdVJt0G). Sign-Offs is not whitelisted above, so this is belt-and-braces
  // for the day someone adds it. See inventory §4.1 — this field still needs purging.
  'Password',
]);

// ─────────────────────────────────────────────────────────────
// FIELD ALIASES
//
// Tables whose field names differ between C&I and O&M. Any rule keyed on a field name
// must be resolved through here first, or it silently fails to bite on one base.
// ─────────────────────────────────────────────────────────────
const FIELD_ALIASES = {
  site_visits: {
    CI: { technician: 'Technician',          start: 'Start',          end: 'End' },
    OM: { technician: 'Assigned Technician', start: 'Start DateTime', end: 'End DateTime' },
  },
  clients: {
    CI: { mobile: null },              // C&I Clients has no Mobile Number field
    OM: { mobile: 'Mobile Number' },
  },
};

// ─────────────────────────────────────────────────────────────
// RECORD-SCOPE FIELDS
//
// Which field each module is scoped on, per base. Part B mandates that record scope is
// enforced by a server-injected filterByFormula and NEVER by filtering in the browser —
// this map is what makes that possible.
//
// A null (or missing) entry means the scope cannot be expressed for that module. The
// engine then emits FALSE() rather than an open filter: deny by default, always. A role
// that loses visibility because a field is missing is a bug to fix, not a reason to
// widen access.
// ─────────────────────────────────────────────────────────────
const SCOPE_FIELDS = {
  site_information: {
    // Created By (App) holds the signed-in account's email, so Own Records Only is
    // expressible here -- unlike delivery_notes, whose equivalent field holds a person's name.
    ownerEmail:  { CI: 'Created By (App)', OM: 'Created By (App)' },
    clientField: { CI: 'Client Name', OM: 'Client Name' },
    siteField:   { CI: 'Site Name',   OM: 'Site Name' },
  },
  site_equipment: {
    // Equipment inherits its site's scope, resolved through the parent link.
    parentModule: 'site_information',
    parentLink:   { CI: 'Site Information', OM: 'Site Information' },
    siteField:    { CI: 'Site Name', OM: 'Site Name' },
  },
  job_cards: {
    assignedEmail: { CI: 'Assigned To (Email)', OM: 'Assigned To (Email)' },
    clientField:   { CI: 'Client Name',         OM: 'Client Name' },
    siteField:     { CI: 'Site / Address',      OM: 'Site / Address' },
    ownerEmail:    null, // Responsible/Accountable/Supervisor are singleCollaborator — unusable
  },
  site_visits: {
    assignedEmail: { CI: 'Technician Email',    OM: 'Technician Email' },
    ownerEmail:    { CI: 'Created By',          OM: 'Created By' },
  },
  delivery_notes: {
    assignedEmail: null,
    clientField:   { CI: 'Client / Receiver Name', OM: 'Client / Receiver Name' },
    siteField:     { CI: 'Delivery Site',       OM: 'Delivery Site' },
    // NOTE: Created By (App) currently holds the warehouse controller's NAME, not an email
    // — the delivery app has always written it that way and this migration deliberately does
    // not change it (DN behaviour must come out functionally identical). Own Records Only is
    // therefore not usable on this module yet; the engine emits FALSE() if asked. No seeded
    // role uses Own Records Only, so nothing is affected today.
    ownerEmail:    null,
  },
  delivery_lines: {
    // Lines inherit their parent note's scope. Enforced by resolving the parent first.
    parentModule: 'delivery_notes',
    parentLink:   { CI: 'Delivery Note',        OM: 'Delivery Note' },
  },
  clients: {
    clientField:   { CI: 'Client Name',         OM: 'Client Name' },
  },
  documents: {
    // Documents hang off a Job Card; site scope resolves through that link.
    parentModule: 'job_cards',
    parentLink:   { CI: 'Job Card',             OM: 'Job Card' },
  },
  audit_log: {
    ownerEmail:    { IAM: 'User Email' },
  },
  sessions: {
    ownerEmail:    { IAM: 'User Email' },
  },
  // Catalogue and reference tables: no record-level scope, module and field rules only.
  picking_slips: {
    // Created By (App) holds the application account email, so Own Records Only is expressible
    // here — unlike delivery_notes, where the equivalent field holds a person's name.
    ownerEmail:  { CI: 'Created By (App)', OM: 'Created By (App)' },
    clientField: { CI: 'Client / Receiver Name', OM: 'Client / Receiver Name' },
    siteField:   { CI: 'Site Name', OM: 'Site Name' },
  },
  picking_slip_items: {
    // Lines inherit their slip's scope, resolved through the parent.
    parentModule: 'picking_slips',
    parentLink:   { CI: 'Picking Slip', OM: 'Picking Slip' },
  },
  signatures: {},   // reached only through their document; no scope of their own
  stock_items:  {},
  people:       {},
  costing:      {},
  activity_log: {}, // Created By is singleCollaborator; scope not expressible — see engine
};

// ─────────────────────────────────────────────────────────────
// SENSITIVITY LADDER
// A role's sensitivity_max caps which Documents it may see. Unclassified documents are
// treated as Restricted — deny by default means an unlabelled record is the MOST
// sensitive, not the least.
// ─────────────────────────────────────────────────────────────
const SENSITIVITY_ORDER = ['Public', 'Internal', 'Confidential', 'Restricted'];
const DEFAULT_SENSITIVITY = 'Restricted';

function sensitivityRank(level) {
  const i = SENSITIVITY_ORDER.indexOf(level);
  return i === -1 ? SENSITIVITY_ORDER.length - 1 : i; // unknown label => most sensitive
}

/** True when `level` is within the role's cap. */
function sensitivityAllowed(level, max) {
  if (!max) return false; // no cap declared => nothing passes (deny by default)
  return sensitivityRank(level || DEFAULT_SENSITIVITY) <= sensitivityRank(max);
}

// ─────────────────────────────────────────────────────────────
// RAW ID REJECTION
//
// Step 0 of the enforcement chain, run BEFORE authentication so it cannot be used as an
// oracle for what exists. Any app…/tbl…/fld… shaped token anywhere in the request body
// is rejected outright. Record ids (rec…) are legitimate and deliberately not matched.
// ─────────────────────────────────────────────────────────────
const RAW_ID_RE = /\b(?:app|tbl|fld|viw|sel)[A-Za-z0-9]{14}\b/;

// The same scan minus `fld`. Field identifiers are legitimate in exactly two positions —
// `params.fields` (the list selector) and the keys of `fields` (create/update) — because the
// O&M scheduler addresses fields by id via returnFieldsByFieldId, and the permission engine
// resolves ids and names alike before applying deny_read / allow_write.
//
// They stay rejected everywhere else. app/tbl/viw ids are never acceptable from a client, and
// a filterByFormula has no legitimate reason to carry one: Airtable formula syntax addresses
// fields as {Field Name}, so tolerating ids there would widen the surface for nothing.
const RAW_ID_RE_NO_FIELD = /\b(?:app|tbl|viw|sel)[A-Za-z0-9]{14}\b/;

/**
 * Walks the parsed request body looking for a raw Airtable identifier.
 * @returns {string|null} the offending token, or null if clean.
 */
function findRawId(value, depth = 0, re = RAW_ID_RE) {
  if (depth > 12) return null; // cheap guard against pathological nesting
  if (typeof value === 'string') {
    const m = value.match(re);
    return m ? m[0] : null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findRawId(v, depth + 1, re);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const keyHit = typeof k === 'string' && k.match(re);
      if (keyHit) return keyHit[0];
      const hit = findRawId(v, depth + 1, re);
      if (hit) return hit;
    }
    return null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// RESOLUTION
// ─────────────────────────────────────────────────────────────

/**
 * Resolve a (base, table) symbol pair to real Airtable ids.
 *
 * Distinguishes three failure modes deliberately:
 *   unknown_symbol         — not a module we know about at all            → 400
 *   module_not_provisioned — known module, no table built yet             → 403
 *   wrong_base             — real module, but not present in that base    → 400
 *
 * wrong_base is a 400 rather than a 403 because it is a malformed request, not a
 * permission failure. Conflating the two would leak the shape of the map to a caller
 * probing for which modules live where.
 *
 * @returns {{ok: true, baseId: string, tableIds: string[], config: object}}
 *        | {ok: false, reason: string, status: number, detail: string}
 */
function resolve(baseSymbol, tableSymbol, subSymbol) {
  const baseId = BASES[baseSymbol];
  if (!baseId) {
    return { ok: false, status: 400, reason: 'unknown_symbol', detail: 'Unknown base symbol.' };
  }

  if (VIRTUAL_MODULES.has(tableSymbol)) {
    return {
      ok: false, status: 400, reason: 'unknown_symbol',
      detail: `"${tableSymbol}" is a UI surface, not a data module.`,
    };
  }

  if (NOT_PROVISIONED.has(tableSymbol)) {
    return {
      ok: false, status: 403, reason: 'module_not_provisioned',
      detail: `The "${tableSymbol}" module is defined in the permission matrix but has no table in any base yet.`,
    };
  }

  const config = TABLES[tableSymbol];
  if (!config) {
    return { ok: false, status: 400, reason: 'unknown_symbol', detail: 'Unknown table symbol.' };
  }

  const entry = config[baseSymbol];
  if (!entry) {
    return {
      ok: false, status: 400, reason: 'wrong_base',
      detail: `Module "${tableSymbol}" does not exist in base "${baseSymbol}".`,
    };
  }

  // A module addressed by sub-symbol (restricted_personal) must name exactly one.
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const available = Object.keys(entry);
    if (!subSymbol) {
      return {
        ok: false, status: 400, reason: 'sub_symbol_required',
        detail: `"${tableSymbol}" requires a sub symbol. One of: ${available.join(', ')}.`,
      };
    }
    const tableId = entry[subSymbol];
    if (!tableId) {
      return { ok: false, status: 400, reason: 'unknown_symbol', detail: 'Unknown sub symbol.' };
    }
    return { ok: true, baseId, tableIds: [tableId], tableId, sub: subSymbol, config };
  }

  const tableIds = Array.isArray(entry) ? entry.slice() : [entry];
  return { ok: true, baseId, tableIds, tableId: tableIds[0], config };
}

/** Resolve a logical field name for a base, honouring FIELD_ALIASES. */
function fieldFor(moduleKey, baseSymbol, logicalName) {
  const m = FIELD_ALIASES[moduleKey];
  if (!m || !m[baseSymbol]) return logicalName;
  const mapped = m[baseSymbol][logicalName];
  return mapped === undefined ? logicalName : mapped;
}

/** Strip every globally-forbidden field from an Airtable record's fields object. */
function stripNeverReturn(fields) {
  if (!fields || typeof fields !== 'object') return fields;
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!NEVER_RETURN.includes(k)) out[k] = v;
  }
  return out;
}

/** Names in `fields` that may never be written by any client. */
function forbiddenWrites(fields) {
  if (!fields || typeof fields !== 'object') return [];
  return Object.keys(fields).filter((k) => NEVER_RETURN.includes(k));
}


/**
 * Scans a parsed /api/at request body for raw Airtable identifiers.
 *
 * Identical to findRawId except that field ids are tolerated in the two positions where the
 * client is entitled to use them. Base, table, view and formula stay strictly symbolic, which
 * is the guarantee this check exists for: the client can never name a base or table.
 *
 * @returns {string|null} the offending token, or null if clean.
 */
function findRawIdInRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return findRawId(body);

  for (const [k, v] of Object.entries(body)) {
    // A key that is itself an id is never acceptable, wherever it appears.
    const keyHit = k.match(RAW_ID_RE);
    if (keyHit) return keyHit[0];

    if (k === 'fields') {
      const hit = findRawId(v, 0, RAW_ID_RE_NO_FIELD);
      if (hit) return hit;
      continue;
    }

    if (k === 'params' && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [pk, pv] of Object.entries(v)) {
        const hit = findRawId(pv, 0, pk === 'fields' ? RAW_ID_RE_NO_FIELD : RAW_ID_RE);
        if (hit) return hit;
      }
      continue;
    }

    const hit = findRawId(v, 0, RAW_ID_RE);
    if (hit) return hit;
  }
  return null;
}


/**
 * Field-name equivalences, per module and base.
 *
 * A permission rule names a field ONCE, in the vocabulary of the operations bases — a role
 * says deny_read: ["Unit Cost"] and means "this person may not see what the item costs".
 * The stock master expresses that same idea under seventeen different names, none of which is
 * "Unit Cost".
 *
 * Without this table, pointing the catalogue at that base would silently un-deny cost to every
 * role that was denied it — the rule would still be there, still say "Unit Cost", and match
 * nothing. The rule is expanded here instead of being rewritten in each role's JSON, so the
 * roles stay readable and a future base cannot quietly escape an existing rule.
 */
const FIELD_EQUIVALENTS = {
  stock_items: {
    STK: {
      'Unit Cost': [
        'Selling Price', 'Last Purchase Price', 'Preferred Supplier Price',
        'Lowest Supplier Price', 'Highest Supplier Price', 'Average Supplier Price',
        'PA Price', 'ROMOR Price', 'Century Price',
        'PA Price Safe', 'ROMOR Price Safe', 'Century Price Safe',
        'PA Price/Unit', 'ROMOR Price/Unit', 'Century Price/Unit',
        'Mark-up %', 'Margin %',
      ],
    },
  },
};

/**
 * Returns a copy of `rule` whose field lists also carry every equivalent name for this base.
 * Only ever ADDS names, so an expansion can tighten a rule and never loosen one.
 *
 * @returns {object} the rule, unchanged when nothing applies.
 */
function expandFieldRules(rule, module, baseSymbol) {
  const map = FIELD_EQUIVALENTS[module] && FIELD_EQUIVALENTS[module][baseSymbol];
  if (!map || !rule || !rule.fields) return rule;

  const out = Object.assign({}, rule, { fields: Object.assign({}, rule.fields) });
  for (const listName of ['deny_read', 'deny_write']) {
    const list = rule.fields[listName];
    if (!Array.isArray(list) || !list.length) continue;
    const extra = [];
    for (const name of list) {
      if (map[name]) extra.push(...map[name]);
    }
    if (extra.length) out.fields[listName] = [...new Set([...list, ...extra])];
  }
  // allow_write is a whitelist: adding names would WIDEN it, so it is deliberately untouched.
  return out;
}

module.exports = {
  BASES,
  TABLES,
  NOT_PROVISIONED,
  VIRTUAL_MODULES,
  NEVER_RETURN,
  FIELD_ALIASES,
  SCOPE_FIELDS,
  SENSITIVITY_ORDER,
  DEFAULT_SENSITIVITY,
  sensitivityRank,
  sensitivityAllowed,
  RAW_ID_RE,
  expandFieldRules,
  FIELD_EQUIVALENTS,
  findRawId,
  findRawIdInRequest,
  resolve,
  fieldFor,
  stripNeverReturn,
  forbiddenWrites,
};
