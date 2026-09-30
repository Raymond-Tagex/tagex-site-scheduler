// TAGEX — site signing links.
//
// A short-lived, single-use token that lets a site installer open ONE delivery note on their
// own phone and sign it, with no account.
//
// WHY A SEPARATE SECRET. `signJwt` normally signs with JWT_SECRET, and the session path calls
// `verifyJwt` without discriminating what a token was minted for. A link issued from that same
// secret could therefore be presented as a session cookie. Signing these with SIGN_LINK_SECRET
// means a link token cannot be VERIFIED as a session at all — a structural guarantee rather
// than a claim check somebody has to remember to write. The `typ` claim is checked too, but it
// is the belt, not the braces.
//
// WHAT THE TOKEN CARRIES. The delivery note's record id and base symbol, so the endpoint never
// takes a record id from the request. There is no parameter to tamper with: a token is a
// capability for exactly one record.

'use strict';

const crypto = require('crypto');
const C = require('./crypto.js');

const TTL_HOURS = 72;
const TYP = 'sign-link';
const ROLE = 'Site Installer';

function linkSecret() {
  const s = process.env.SIGN_LINK_SECRET;
  if (!s || s.length < 32) {
    throw new Error('SIGN_LINK_SECRET is not set, or is shorter than 32 characters');
  }
  if (s === process.env.JWT_SECRET) {
    // The whole point is that the two families cannot cross. Sharing the value would silently
    // undo it, so refuse rather than pretend.
    throw new Error('SIGN_LINK_SECRET must be different from JWT_SECRET');
  }
  return s;
}

/** True when the environment is configured for signing links. */
function isConfigured() {
  try { linkSecret(); return true; } catch (e) { return false; }
}

/**
 * Mints a link token for one delivery note.
 *
 * @param {object} a
 * @param {string} a.deliveryNoteId  Airtable record id
 * @param {string} a.baseSymbol      'CI' | 'OM'
 * @param {string} a.dnNumber        for the audit trail and error messages
 * @returns {{token:string, jti:string, expiresAt:string}}
 */
function mint({ deliveryNoteId, baseSymbol, dnNumber }) {
  if (!deliveryNoteId) throw new Error('A delivery note is required.');
  if (baseSymbol !== 'CI' && baseSymbol !== 'OM') throw new Error('Unknown base.');

  const jti = crypto.randomBytes(16).toString('hex');
  const ttl = TTL_HOURS * 3600;
  const token = C.signJwt({
    typ: TYP,
    dn: deliveryNoteId,
    b: baseSymbol,
    role: ROLE,
    ref: String(dnNumber || ''),
    jti,
  }, ttl, linkSecret());

  return {
    token,
    jti,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  };
}

/**
 * Verifies a link token.
 *
 * Every failure returns the SAME shape and the caller returns the same message, so a probe
 * cannot tell an expired link from a forged one from a revoked one.
 *
 * @returns {{ok:boolean, payload?:object, reason?:string}}
 */
function verify(token) {
  if (!token) return { ok: false, reason: 'invalid_link' };

  let r;
  try { r = C.verifyJwt(token, linkSecret()); }
  catch (e) { return { ok: false, reason: 'not_configured' }; }

  if (!r.ok) return { ok: false, reason: 'invalid_link' };

  const p = r.payload || {};
  if (p.typ !== TYP) return { ok: false, reason: 'invalid_link' };
  if (p.role !== ROLE) return { ok: false, reason: 'invalid_link' };
  if (!p.dn || typeof p.dn !== 'string') return { ok: false, reason: 'invalid_link' };
  if (p.b !== 'CI' && p.b !== 'OM') return { ok: false, reason: 'invalid_link' };
  if (!p.jti) return { ok: false, reason: 'invalid_link' };

  return { ok: true, payload: p };
}

/**
 * Decides whether a verified token may still be used against the record it names.
 *
 * Three ways a valid signature dies: it was superseded by a newer link, the note is closed, or
 * the site installer has already signed. The last one is what makes the link single-use — the
 * signature itself is the flag, not a counter that could drift.
 *
 * @param {object} payload  from verify()
 * @param {object} note     the delivery note record
 */
function checkAgainstRecord(payload, note) {
  if (!note) return { ok: false, reason: 'invalid_link' };
  const f = note.fields || {};

  if (String(f['Sign Link Jti'] || '') !== payload.jti) {
    return {
      ok: false, reason: 'superseded',
      detail: 'This link has been replaced by a newer one. Ask the driver for the current link.',
    };
  }

  const status = (f.Status && f.Status.name) || f.Status || '';
  if (String(status) === 'Closed' || String(status) === 'Cancelled') {
    return {
      ok: false, reason: 'note_closed',
      detail: `This delivery note is ${status.toLowerCase()} and can no longer be signed.`,
    };
  }

  if (String(f['Signature Roles'] || '').includes(ROLE)) {
    return {
      ok: false, reason: 'already_signed',
      detail: 'This delivery note has already been signed at site.',
    };
  }

  return { ok: true };
}

/** The fields the link may ever see. Costs are absent, so there is no rule to forget. */
const NOTE_FIELDS = Object.freeze([
  'DN Number', 'PS Number', 'Status', 'Delivery Date',
  'Client / Receiver Name', 'Delivery Site', 'JC Reference (text)',
  'Driver Name', 'Vehicle Registration', 'Notes',
  'Sign Link Jti', 'Signature Roles',
]);

const LINE_FIELDS = Object.freeze([
  'Line ID', 'Line No', 'Stock Code (text)', 'Item Description', 'Unit',
  'Quantity', 'Qty Received', 'Variance Reason', 'Serial Number',
]);

/** The only fields a link may write on a line. */
const LINE_WRITABLE = Object.freeze(['Qty Received', 'Variance Reason']);

const VARIANCE_REASONS = Object.freeze([
  'Short', 'Damaged', 'Incorrect Item', 'Not Required', 'Other',
]);

function buildUrl(origin, token) {
  const base = String(origin || process.env.APP_ORIGIN || '').replace(/\/+$/, '');
  return `${base}/sign?t=${encodeURIComponent(token)}`;
}

module.exports = {
  TTL_HOURS, TYP, ROLE,
  isConfigured, mint, verify, checkAgainstRecord, buildUrl,
  NOTE_FIELDS, LINE_FIELDS, LINE_WRITABLE, VARIANCE_REASONS,
};
