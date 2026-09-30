// POST /api/auth/invite   { email, fullName, roleName, initialPassword?, jobTitle?, ... }
// Admin only. Creates a user account, one of two ways:
//
//   no initialPassword  -> Status "Invited"; a one-time link valid for 72 hours is emailed.
//   initialPassword     -> Status "Active";  the password is hashed here and no email is sent.
//
// The second exists because email is not always working, and staff who cannot sign in stop
// working. The Admin hands the password over in person, and the account is flagged Must Change
// Password so the person replaces it at first sign-in — the Admin's copy stops working then.
//
// Both paths run through THIS handler deliberately. A second creation route would drift: a
// field added to one and forgotten in the other is how an account ends up half-configured.
//
// Email uniqueness is enforced HERE, by re-scanning immediately before insert — Airtable has no
// unique index. The Users.Integrity Check formula audits the result afterwards.

'use strict';

const at = require('../_lib/airtable.js');
const C = require('../_lib/crypto.js');
const S = require('../_lib/session.js');
const H = require('../_lib/http.js');
const A = require('../_lib/audit.js');
const T = require('../_lib/tables.js');
const M = require('../_lib/mail.js');

const IAM = () => T.BASES.IAM;
const USERS = () => T.TABLES.users.IAM;
const LEVELS = () => T.TABLES.access_levels.IAM;
const INVITE_HOURS = 72;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

module.exports = async function handler(req, res) {
  if (!H.methodGuard(req, res, 'POST')) return;
  if (!H.sessionModeGuard(res)) return;

  const auth = await S.authenticate(req);
  if (!auth.ok) return H.fail(res, auth.status, auth.reason, auth.detail);
  if (auth.role['Can Manage Users'] !== true) {
    await A.auditNow({
      action: 'Create', result: 'Denied', denialReason: 'module_denied', module: 'users',
      userEmail: auth.email, userRecordId: auth.userRecordId, sessionId: auth.sid,
      ip: S.clientIp(req), userAgent: S.userAgent(req),
    });
    return H.fail(res, 403, 'module_denied', 'Only an administrator may invite users.');
  }

  let body;
  try { body = await H.readBody(req); }
  catch (e) { return H.fail(res, 400, e.code || 'bad_request', e.message); }

  const email = String(body.email || '').toLowerCase().trim();
  const fullName = String(body.fullName || '').trim();
  const roleName = String(body.roleName || '').trim();

  // An empty string means "not supplied" and must never be treated as a password.
  const initialPassword = String(body.initialPassword || '');
  const withPassword = initialPassword.length > 0;

  if (!EMAIL_RE.test(email)) return H.fail(res, 400, 'bad_email', 'Enter a valid email address.');
  if (!fullName) return H.fail(res, 400, 'bad_name', 'Full name is required.');
  if (!roleName) return H.fail(res, 400, 'bad_role', 'An access level is required.');

  // The same strength rules the user would face setting it themselves. An Admin-chosen password
  // is not exempt: it is a real working credential until the person changes it.
  if (withPassword) {
    const complaints = C.passwordComplaints(initialPassword);
    if (complaints.length) {
      return H.fail(res, 400, 'weak_password', `Password ${complaints.join(', ')}.`, { complaints });
    }
  }

  // Re-scan for an existing address. This is the uniqueness enforcement.
  const existing = await S.findUserByEmail(email);
  if (existing) return H.fail(res, 409, 'email_exists', 'An account with that email already exists.');

  const role = await at.findOne(IAM(), LEVELS(), `{Role Name} = "${S.esc(roleName)}"`);
  if (!role) return H.fail(res, 400, 'unknown_role', 'That access level does not exist.');
  if (role.fields.Active === false) return H.fail(res, 400, 'role_inactive', 'That access level is not active.');

  const now = new Date();
  // Only mint an invite token for the emailed path. An account that already has a password must
  // not also carry a live invite link — that is a second way in, valid for three days, that
  // nobody is watching.
  const token = withPassword ? null : C.newToken();
  const passwordHash = withPassword ? await C.hashPassword(initialPassword) : '';

  const fields = {
    Email: email,
    'Full Name': fullName,
    'Access Level': [role.id],
    'Job Title / Department': String(body.jobTitle || '').trim(),
    Status: withPassword ? 'Active' : 'Invited',
    // True either way. An invited user clears it by choosing their own password; a user given
    // one by an Admin clears it at first sign-in, which is what retires the Admin's copy.
    'Must Change Password': true,
    'Password Hash': passwordHash,
    'Password Set At': withPassword ? now.toISOString() : null,
    'Invite Token Hash': withPassword ? '' : C.hashToken(token),
    'Invite Expires': withPassword ? null : new Date(now.getTime() + INVITE_HOURS * 3600_000).toISOString(),
    'Failed Login Attempts': 0,
    'Record Scope': body.recordScope || role.fields['Default Record Scope'] || 'All Records',
    'Can View Restricted Documents': body.canViewRestricted === true,
    'MFA Enabled': false,
    'Created By': auth.email,
    'Created Date': now.toISOString(),
    'Assigned Clients': JSON.stringify(Array.isArray(body.assignedClients) ? body.assignedClients : []),
    'Assigned Sites': JSON.stringify(Array.isArray(body.assignedSites) ? body.assignedSites : []),
    'Assigned Systems': JSON.stringify(Array.isArray(body.assignedSystems) ? body.assignedSystems : []),
    'Permission Overrides': '{}',
  };
  if (body.mobile) fields['Mobile Number'] = String(body.mobile).trim();
  if (typeof body.approvalLimit === 'number') fields['Approval Limit (R)'] = body.approvalLimit;

  const created = await at.create(IAM(), USERS(), [fields]);
  const rec = created[0];

  await A.auditNow({
    action: 'Create', result: 'Allowed', module: 'users', baseSymbol: 'IAM',
    table: 'users', recordId: rec.id, field: 'Email', newValue: email,
    userEmail: auth.email, userRecordId: auth.userRecordId, sessionId: auth.sid,
    ip: S.clientIp(req), userAgent: S.userAgent(req),
  });

  // Recorded as its own event so "who gave this person their first password" is answerable.
  // The value is a description, never the password — nothing may write a password to the log.
  if (withPassword) {
    await A.auditNow({
      action: 'Password Reset', result: 'Allowed', module: 'users', baseSymbol: 'IAM',
      table: 'users', recordId: rec.id, field: 'Password Hash',
      newValue: 'initial password set by administrator at account creation',
      userEmail: auth.email, userRecordId: auth.userRecordId, sessionId: auth.sid,
      ip: S.clientIp(req), userAgent: S.userAgent(req),
    });
    return H.ok(res, {
      created: true, id: rec.id, emailSent: false, passwordSet: true,
      message: `${fullName} can sign in now with the password you set. They are asked to change `
             + 'it immediately, and your copy stops working at that point.',
    });
  }

  // The account exists whether or not the mail goes out — say which happened, so an Admin
  // is never left guessing why nothing arrived.
  try {
    await M.sendInvite({ to: email, fullName, token, req });
  } catch (e) {
    console.error('[invite] mail failed:', e && e.message);
    return H.ok(res, {
      created: true, id: rec.id, emailSent: false,
      warning: `The account was created but the invitation email could not be sent (${e.code || 'mail error'}). Use "Resend invite" once email is working.`,
    });
  }

  return H.ok(res, { created: true, id: rec.id, emailSent: true, expiresInHours: INVITE_HOURS });
};
