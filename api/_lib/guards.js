// TAGEX — invariants that must hold no matter what the UI sends.
//
// These are lockout protections. An Admin who removes their own Admin rights, or deletes the
// last Admin, locks the organisation out of its own user management with no way back in
// except editing Airtable by hand. The Admin UI hides those controls; this makes hiding them
// unnecessary, because a direct curl cannot do it either.

'use strict';

const at = require('./airtable.js');
const T = require('./tables.js');

const IAM = () => T.BASES.IAM;
const USERS = () => T.TABLES.users.IAM;
const LEVELS = () => T.TABLES.access_levels.IAM;

const esc = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

let adminRoleCache = null;
let adminRoleCachedAt = 0;
const ROLE_TTL = 5 * 60 * 1000;

/** Record ids of every Access Level that can manage users. */
async function adminRoleIds() {
  if (adminRoleCache && Date.now() - adminRoleCachedAt < ROLE_TTL) return adminRoleCache;
  const rows = await at.list(IAM(), LEVELS(), {
    filterByFormula: '{Can Manage Users} = 1',
    fields: ['Role Name', 'Can Manage Users'],
  });
  adminRoleCache = rows.map((r) => r.id);
  adminRoleCachedAt = Date.now();
  return adminRoleCache;
}

/** How many Active users currently hold an admin-capable role. */
async function countActiveAdmins() {
  const adminIds = await adminRoleIds();
  if (!adminIds.length) return 0;
  const rows = await at.list(IAM(), USERS(), {
    filterByFormula: '{Status} = "Active"',
    fields: ['Email', 'Status'],
  });
  // Access Level is a link field; the list response carries record ids, so filter in code.
  const full = await Promise.all(rows.map((r) => at.get(IAM(), USERS(), r.id).catch(() => null)));
  return full.filter((r) => {
    if (!r) return false;
    const links = r.fields['Access Level'];
    return Array.isArray(links) && links.some((id) => adminIds.includes(id));
  }).length;
}

async function isAdminUserRecord(userRecord) {
  const adminIds = await adminRoleIds();
  const links = userRecord && userRecord.fields && userRecord.fields['Access Level'];
  return Array.isArray(links) && links.some((id) => adminIds.includes(id));
}

/**
 * Guard an update to a Users record.
 *
 * Blocks:
 *   • an Admin removing their own admin role
 *   • an Admin suspending or disabling their own account
 *   • demoting, suspending or disabling the LAST active Admin
 *
 * @returns {{ok:true} | {ok:false, status, reason, detail}}
 */
async function guardUserUpdate({ actorEmail, targetRecordId, fields }) {
  const touchingRole = Object.prototype.hasOwnProperty.call(fields, 'Access Level');
  const touchingStatus = Object.prototype.hasOwnProperty.call(fields, 'Status');
  if (!touchingRole && !touchingStatus) return { ok: true };

  const target = await at.get(IAM(), USERS(), targetRecordId).catch(() => null);
  if (!target) return { ok: true }; // a missing record fails later, on its own terms

  const targetIsAdmin = await isAdminUserRecord(target);
  if (!targetIsAdmin) return { ok: true };

  const adminIds = await adminRoleIds();
  const newRoleIsAdmin = touchingRole
    ? (Array.isArray(fields['Access Level']) && fields['Access Level'].some((id) => adminIds.includes(id)))
    : true;
  const newStatusActive = touchingStatus ? fields.Status === 'Active' : true;

  const stillAdmin = newRoleIsAdmin && newStatusActive;
  if (stillAdmin) return { ok: true };

  const targetEmail = String(target.fields.Email || '').toLowerCase();
  const isSelf = targetEmail === String(actorEmail || '').toLowerCase();

  if (isSelf && touchingRole && !newRoleIsAdmin) {
    return {
      ok: false, status: 403, reason: 'cannot_demote_self',
      detail: 'You cannot remove your own administrator rights. Ask another administrator to do it.',
    };
  }
  if (isSelf && touchingStatus && !newStatusActive) {
    return {
      ok: false, status: 403, reason: 'cannot_deactivate_self',
      detail: 'You cannot suspend or disable your own account.',
    };
  }

  const activeAdmins = await countActiveAdmins();
  if (activeAdmins <= 1) {
    return {
      ok: false, status: 403, reason: 'last_admin',
      detail: 'This is the last active administrator. Promote another user first, or the organisation will be locked out of user management.',
    };
  }

  return { ok: true };
}

/** Guard a delete of a Users record. The last active Admin can never be deleted. */
async function guardUserDelete({ actorEmail, targetRecordId }) {
  const target = await at.get(IAM(), USERS(), targetRecordId).catch(() => null);
  if (!target) return { ok: true };

  const targetEmail = String(target.fields.Email || '').toLowerCase();
  if (targetEmail === String(actorEmail || '').toLowerCase()) {
    return {
      ok: false, status: 403, reason: 'cannot_delete_self',
      detail: 'You cannot delete your own account.',
    };
  }

  if (!(await isAdminUserRecord(target))) return { ok: true };

  const activeAdmins = await countActiveAdmins();
  if (activeAdmins <= 1) {
    return {
      ok: false, status: 403, reason: 'last_admin',
      detail: 'This is the last active administrator and cannot be deleted.',
    };
  }
  return { ok: true };
}

/**
 * Guard an edit to an Access Level. Removing Can Manage Users from the only admin-capable
 * role is the same lockout by another route.
 */
async function guardRoleUpdate({ targetRecordId, fields }) {
  const touchingManage = Object.prototype.hasOwnProperty.call(fields, 'Can Manage Users');
  const touchingActive = Object.prototype.hasOwnProperty.call(fields, 'Active');
  if (!touchingManage && !touchingActive) return { ok: true };

  const losingAdmin = (touchingManage && fields['Can Manage Users'] !== true)
                   || (touchingActive && fields.Active !== true);
  if (!losingAdmin) return { ok: true };

  const adminIds = await adminRoleIds();
  if (!adminIds.includes(targetRecordId)) return { ok: true };

  if (adminIds.length <= 1) {
    return {
      ok: false, status: 403, reason: 'last_admin_role',
      detail: 'This is the only access level that can manage users. Removing that would lock everyone out of user management.',
    };
  }
  return { ok: true };
}

function invalidateRoleCache() { adminRoleCache = null; adminRoleCachedAt = 0; }


// ── Picking slip lock ────────────────────────────────────────────────────────
//
// Once the warehouse signs, the picked quantities are evidence. Rule 11: signed information
// is protected from normal editing.
//
// This lives here, not in the screen, for the same reason the admin lockout guards do: a
// direct POST to /api/at must be refused too. Hiding the input would only stop the honest.
//
// The override is the role's delete right on picking slips, which only Admin has. That is a
// deliberate choice of an existing permission rather than a new flag nobody would maintain —
// and the override is audited by the caller either way.

const LOCK_EXEMPT = Object.freeze([
  // Set BY the signing action itself, so they must remain writable as the lock goes on.
  'Locked', 'Picked By (App)', 'Picked At', 'Status',
]);

/**
 * Refuses an edit to a signed picking slip, or to a line belonging to one.
 *
 * @param {object}  a
 * @param {string}  a.tableSymbol   'picking_slips' or 'picking_slip_items'
 * @param {object}  a.existing      the record as it is now
 * @param {object}  a.fields        the fields being written
 * @param {boolean} a.canOverride   the role may edit signed records
 * @param {Function} a.loadParent   async (recordId) => parent slip record, for line edits
 * @returns {Promise<{ok:boolean, status?:number, reason?:string, detail?:string}>}
 */
async function guardPickingSlipLock({ tableSymbol, existing, fields, canOverride, loadParent }) {
  if (tableSymbol !== 'picking_slips' && tableSymbol !== 'picking_slip_items') return { ok: true };
  if (!existing) return { ok: true };

  let slip = existing;
  if (tableSymbol === 'picking_slip_items') {
    const link = (existing.fields || {})['Picking Slip'];
    const parentId = Array.isArray(link) ? link[0] : link;
    // No parent means nothing to protect: an orphan line is a data problem, not a locked one.
    if (!parentId || typeof loadParent !== 'function') return { ok: true };
    slip = await loadParent(typeof parentId === 'object' ? parentId.id : parentId);
    if (!slip) return { ok: true };
  }

  if (!(slip.fields || {}).Locked) return { ok: true };

  const touched = Object.keys(fields || {});
  if (tableSymbol === 'picking_slips') {
    const beyond = touched.filter((f) => !LOCK_EXEMPT.includes(f));
    if (!beyond.length) return { ok: true };
  }

  if (canOverride) return { ok: true, overridden: true };

  const ref = (slip.fields || {})['PS Number'] || slip.id;
  return {
    ok: false,
    status: 409,
    reason: 'picking_slip_locked',
    detail: `${ref} was signed by the warehouse and is locked. `
      + 'Picked quantities cannot be changed. An administrator can amend it, and the change is '
      + 'recorded in the audit trail.',
  };
}


// ── Delivery note raised from a picking slip ─────────────────────────────────
//
// Rule 2: a picking slip must be picked and signed by the warehouse before it can become a
// delivery note. Enforced here so a direct POST cannot skip the warehouse step.
//
// DELIBERATELY NOT RULE 1. "A delivery note cannot be created without a picking slip" would
// break the flow the warehouse uses today, which still creates notes directly. That switch-over
// belongs to stage 4, when the new path replaces the old one rather than sitting beside it.
// Until then this guard only checks that a slip CLAIMED as the source is a real, signed slip.

async function guardDeliveryFromSlip({ tableSymbol, op, fields, loadSlip }) {
  if (tableSymbol !== 'delivery_notes' || op !== 'create') return { ok: true };

  const link = (fields || {})['Picking Slip'];
  const id = Array.isArray(link) ? link[0] : link;
  if (!id) return { ok: true };                      // legacy path: no slip claimed
  if (typeof loadSlip !== 'function') return { ok: true };

  const slipId = (id && typeof id === 'object') ? id.id : id;
  const slip = await loadSlip(slipId);
  if (!slip) {
    return {
      ok: false, status: 400, reason: 'picking_slip_not_found',
      detail: 'The picking slip this delivery note refers to could not be read.',
    };
  }

  if (!(slip.fields || {}).Locked) {
    const ref = (slip.fields || {})['PS Number'] || slipId;
    return {
      ok: false, status: 409, reason: 'picking_slip_unsigned',
      detail: `${ref} has not been signed by the warehouse. A delivery note can only be raised `
        + 'from a picking slip that has been picked and signed.',
    };
  }

  return { ok: true };
}



// ── Closing a delivery note ──────────────────────────────────────────────────
//
// Rule 8: a delivery note cannot be closed while any signature is missing.
//
// The check reads the Signatures Complete formula on the record — a rollup of which roles have
// actually signed — rather than trusting a flag the client sends. And when it refuses it NAMES
// the missing signature, because "cannot be closed" without saying which one leaves the person
// holding the phone with nothing to act on.

const REQUIRED_SIGNATURES = Object.freeze(['Warehouse', 'Driver', 'Site Installer']);

/**
 * Refuses a close that is not yet earned.
 *
 * @param {object}  a
 * @param {string}  a.tableSymbol
 * @param {object}  a.fields     the fields being written
 * @param {object}  a.existing   the delivery note as it is now
 * @returns {{ok:boolean, status?:number, reason?:string, detail?:string, missing?:string[]}}
 */
async function guardDeliveryClose({ tableSymbol, fields, existing, warehouseSignedOnSlip }) {
  if (tableSymbol !== 'delivery_notes') return { ok: true };

  const next = (fields || {}).Status;
  const status = (next && typeof next === 'object') ? next.name : next;
  if (String(status || '') !== 'Closed') return { ok: true };
  if (!existing) return { ok: true };

  const f = existing.fields || {};
  const signed = String(f['Signature Roles'] || '');
  const roles = REQUIRED_SIGNATURES.filter((r) => signed.includes(r));

  // The warehouse signs the PICKING SLIP, not the delivery note -- that is where the stock
  // physically leaves, and it is signed before the note exists. Requiring a second warehouse
  // signature on the note would ask the same person to sign twice for one delivery, so the
  // slip's signature is accepted here instead.
  //
  // Matched through the note's PS Number rather than its Picking Slip link, because Airtable
  // cannot match a link field from the child side in a formula -- the same reason picking-slip
  // lines are found by their Line ID prefix.
  if (!roles.includes('Warehouse') && typeof warehouseSignedOnSlip === 'function') {
    const ps = String(f['PS Number'] || '').trim();
    if (ps && await warehouseSignedOnSlip(ps)) roles.push('Warehouse');
  }

  const missing = REQUIRED_SIGNATURES.filter((r) => !roles.includes(r));

  // A delivery that never happened cannot be closed as though it did.
  const delivered = String((f.Status && f.Status.name) || f.Status || '');
  const hasDate = !!f['Delivery Date'];

  if (missing.length) {
    const ref = f['DN Number'] || existing.id;
    return {
      ok: false, status: 409, reason: 'signature_outstanding', missing,
      detail: `${ref} cannot be closed — signature outstanding: ${missing.join(', ')}.`,
    };
  }

  if (!hasDate) {
    return {
      ok: false, status: 409, reason: 'delivery_date_missing',
      detail: 'This delivery note cannot be closed without a delivery date.',
    };
  }

  if (delivered !== 'Delivered' && delivered !== 'Partially Delivered') {
    return {
      ok: false, status: 409, reason: 'not_delivered',
      detail: `This delivery note is "${delivered || 'unset'}". Only a delivered note can be closed.`,
    };
  }

  return { ok: true };
}

// ── Rule 1: no delivery note without a picking slip ──────────────────────────
//
// THE SWITCH-OVER. Turning this on ends the old flow, where the warehouse types a delivery note
// directly. It is therefore OFF unless REQUIRE_PICKING_SLIP=true is set in the environment —
// the date that flow stops is a business decision with a day and an hour attached to it, not
// something that should arrive with a deploy.
//
// Legacy notes are unaffected either way: this only looks at creation.

function requiresPickingSlip() {
  return String(process.env.REQUIRE_PICKING_SLIP || 'false').toLowerCase() === 'true';
}

function guardDeliveryNeedsSlip({ tableSymbol, op, fields }) {
  if (tableSymbol !== 'delivery_notes' || op !== 'create') return { ok: true };
  if (!requiresPickingSlip()) return { ok: true };

  const link = (fields || {})['Picking Slip'];
  const has = Array.isArray(link) ? link.length > 0 : !!link;
  if (has) return { ok: true };

  return {
    ok: false, status: 409, reason: 'picking_slip_required',
    detail: 'A delivery note is created from a picking slip, not on its own. Raise a picking '
      + 'slip, have the warehouse pick and sign it, then use Create delivery note.',
  };
}


module.exports = {
  adminRoleIds, countActiveAdmins, isAdminUserRecord,
  guardUserUpdate, guardUserDelete, guardRoleUpdate, guardPickingSlipLock, guardDeliveryFromSlip, guardDeliveryClose, guardDeliveryNeedsSlip, requiresPickingSlip, invalidateRoleCache, esc,
};
