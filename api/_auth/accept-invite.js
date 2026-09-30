// POST /api/auth/accept-invite   { token, password }
//
// Consumes a one-time invite token, sets the first password, clears Must Change Password and
// activates the account. The token is single-use: its hash is cleared on success, so a replay
// of the same link fails.

'use strict';

const at = require('../_lib/airtable.js');
const C = require('../_lib/crypto.js');
const S = require('../_lib/session.js');
const H = require('../_lib/http.js');
const A = require('../_lib/audit.js');
const T = require('../_lib/tables.js');

const IAM = () => T.BASES.IAM;
const USERS = () => T.TABLES.users.IAM;

const GENERIC = 'That link is not valid, or it has already been used.';

module.exports = async function handler(req, res) {
  if (!H.methodGuard(req, res, 'POST')) return;
  if (!H.sessionModeGuard(res)) return;

  const ip = S.clientIp(req);
  const ua = S.userAgent(req);

  const rl = H.authRateLimit(ip, 'accept-invite');
  if (!rl.ok) return H.tooManyRequests(res, rl.retryAfter);

  let body;
  try { body = await H.readBody(req); }
  catch (e) { return H.fail(res, 400, e.code || 'bad_request', e.message); }

  const token = String(body.token || '');
  const password = String(body.password || '');
  if (!token) return H.fail(res, 400, 'invalid_token', GENERIC);

  const complaints = C.passwordComplaints(password);
  if (complaints.length) {
    return H.fail(res, 400, 'weak_password', `Password ${complaints.join(', ')}.`, { complaints });
  }

  // Look the token up by its hash — the plaintext is never stored, so this is the only way in.
  const hash = C.hashToken(token);
  const user = await at.findOne(IAM(), USERS(), `{Invite Token Hash} = "${S.esc(hash)}"`);
  if (!user) {
    await A.auditNow({ action: 'Password Reset', result: 'Denied', denialReason: 'invite_token_unknown', ip, userAgent: ua });
    return H.fail(res, 400, 'invalid_token', GENERIC);
  }

  const f = user.fields;
  const expires = f['Invite Expires'] ? new Date(f['Invite Expires']).getTime() : 0;
  if (!expires || Date.now() > expires) {
    await A.auditNow({
      action: 'Password Reset', result: 'Denied', denialReason: 'invite_expired',
      userEmail: f.Email, userRecordId: user.id, ip, userAgent: ua,
    });
    return H.fail(res, 400, 'invite_expired', 'That invitation has expired. Ask an administrator to send a new one.');
  }
  if (f.Status === 'Suspended' || f.Status === 'Disabled') {
    return H.fail(res, 403, 'user_not_active', 'This account is not active. Contact an administrator.');
  }

  const passwordHash = await C.hashPassword(password);

  await at.update(IAM(), USERS(), user.id, {
    'Password Hash': passwordHash,
    'Password Set At': new Date().toISOString(),
    'Must Change Password': false,
    Status: 'Active',
    'Invite Token Hash': '',   // single use — consumed
    'Invite Expires': null,
    'Failed Login Attempts': 0,
    'Locked Until': null,
  });

  S.invalidateUser(f.Email);

  await A.auditNow({
    action: 'Password Reset', result: 'Allowed',
    userEmail: String(f.Email || '').toLowerCase(), userRecordId: user.id,
    module: 'users', field: 'Password Hash', newValue: '[REDACTED]',
    ip, userAgent: ua,
  });

  // No session is issued here on purpose: the user signs in with the password they just chose,
  // which proves it works and puts them through the normal login path, MFA included.
  return H.ok(res, { activated: true, email: String(f.Email || '').toLowerCase() });
};
