// POST /api/auth/set-password   { email, password }
//
// Admin only. Sets a working password on an EXISTING account, without email.
//
// WHY THIS EXISTS. "Force password reset" and "Forgot password?" both depend on mail being
// delivered. When it is not — a bounced address, a mail key not yet configured, someone
// locked out on a Monday morning — there has to be a way to put a person back to work that
// does not involve waiting for a mailbox. The Admin sets a password, reads it out, and the
// person changes it the moment they sign in.
//
// WHAT IT DELIBERATELY DOES NOT DO. It cannot read an existing password: nothing can, because
// only a scrypt hash is stored. This sets a new one and says so in the audit log. An Admin
// using this on someone else's account leaves a permanent, attributable record of having done
// it — which is the honest trade for the convenience.

'use strict';

const at = require('../_lib/airtable.js');
const C = require('../_lib/crypto.js');
const S = require('../_lib/session.js');
const H = require('../_lib/http.js');
const A = require('../_lib/audit.js');
const T = require('../_lib/tables.js');

const IAM = () => T.BASES.IAM;
const USERS = () => T.TABLES.users.IAM;

module.exports = async function handler(req, res) {
  if (!H.methodGuard(req, res, 'POST')) return;
  if (!H.sessionModeGuard(res)) return;

  const ip = S.clientIp(req);
  const ua = S.userAgent(req);

  const auth = await S.authenticate(req);
  if (!auth.ok) return H.fail(res, auth.status, auth.reason, auth.detail);

  if (auth.role['Can Manage Users'] !== true) {
    await A.auditNow({
      action: 'Password Reset', result: 'Denied', denialReason: 'module_denied', module: 'users',
      userEmail: auth.email, userRecordId: auth.userRecordId, sessionId: auth.sid, ip, userAgent: ua,
    });
    return H.fail(res, 403, 'module_denied', 'Only an administrator may set a password.');
  }

  let body;
  try { body = await H.readBody(req); }
  catch (e) { return H.fail(res, 400, e.code || 'bad_request', e.message); }

  const email = String(body.email || '').toLowerCase().trim();
  const password = String(body.password || '');

  if (!email) return H.fail(res, 400, 'bad_email', 'Which account? An email address is required.');

  // Changing your own password here would skip proving you know the current one. Use the
  // ordinary Change password screen, which asks for it.
  if (email === String(auth.email || '').toLowerCase()) {
    return H.fail(res, 400, 'use_change_password',
      'To change your own password, use Change password — it asks for your current one.');
  }

  const complaints = C.passwordComplaints(password);
  if (complaints.length) {
    return H.fail(res, 400, 'weak_password', `Password ${complaints.join(', ')}.`, { complaints });
  }

  const user = await S.findUserByEmail(email);
  if (!user) return H.fail(res, 404, 'no_such_user', 'There is no account with that email address.');

  const f = user.fields;
  if (f.Status === 'Disabled') {
    return H.fail(res, 409, 'user_disabled',
      'That account is Disabled. Set it back to Active first if this person should have access again.');
  }

  const hash = await C.hashPassword(password);

  await at.update(IAM(), USERS(), user.id, {
    'Password Hash': hash,
    'Password Set At': new Date().toISOString(),
    // They must replace it at first sign-in, which is what retires the Admin's copy.
    'Must Change Password': true,
    // An Invited account has never signed in; giving it a password completes the account, so
    // it becomes Active. Suspended is left alone — a suspended person should not regain access
    // as a side effect of a password reset.
    Status: f.Status === 'Invited' ? 'Active' : f.Status,
    // Any outstanding invite or reset link is now a second, unwatched way in. Void it.
    'Invite Token Hash': '',
    'Invite Expires': null,
    // Whatever locked them out is resolved by this.
    'Failed Login Attempts': 0,
    'Locked Until': null,
  });

  S.invalidateUser(email);

  // Existing sessions were opened with the old password. If this reset is because the old one
  // was compromised, leaving those alive would defeat the point.
  let revoked = 0;
  try {
    revoked = await S.revokeAllForUser(email, auth.email);
  } catch (e) {
    console.error('[set-password] session revoke failed:', e && e.message);
  }

  await A.auditNow({
    action: 'Password Reset', result: 'Allowed', module: 'users', baseSymbol: 'IAM',
    table: 'users', recordId: user.id, field: 'Password Hash',
    newValue: `password set by administrator ${auth.email}`,
    userEmail: auth.email, userRecordId: auth.userRecordId, sessionId: auth.sid, ip, userAgent: ua,
  });

  return H.ok(res, {
    ok: true,
    email,
    sessionsRevoked: revoked,
    mustChange: true,
    message: `${f['Full Name'] || email} can sign in now with the password you set. They are asked `
           + 'to change it immediately, and your copy stops working at that point.',
  });
};
