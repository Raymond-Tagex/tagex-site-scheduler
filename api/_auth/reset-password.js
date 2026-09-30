// POST /api/auth/reset-password   { token, password }
//
// Consumes the one-time reset token, sets the new hash, and revokes EVERY live session for
// that user — the point of a reset is usually that something was compromised.

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

  const rl = H.authRateLimit(ip, 'reset');
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

  const hash = C.hashToken(token);
  const user = await at.findOne(IAM(), USERS(), `{Invite Token Hash} = "${S.esc(hash)}"`);
  if (!user) {
    await A.auditNow({ action: 'Password Reset', result: 'Denied', denialReason: 'reset_token_unknown', ip, userAgent: ua });
    return H.fail(res, 400, 'invalid_token', GENERIC);
  }

  const f = user.fields;
  const expires = f['Invite Expires'] ? new Date(f['Invite Expires']).getTime() : 0;
  if (!expires || Date.now() > expires) {
    await A.auditNow({
      action: 'Password Reset', result: 'Denied', denialReason: 'reset_token_expired',
      userEmail: f.Email, userRecordId: user.id, ip, userAgent: ua,
    });
    return H.fail(res, 400, 'token_expired', 'That link has expired. Request a new one.');
  }
  if (f.Status === 'Disabled') {
    return H.fail(res, 403, 'user_not_active', 'This account is not active. Contact an administrator.');
  }

  const passwordHash = await C.hashPassword(password);
  const email = String(f.Email || '').toLowerCase();

  await at.update(IAM(), USERS(), user.id, {
    'Password Hash': passwordHash,
    'Password Set At': new Date().toISOString(),
    'Must Change Password': false,
    Status: f.Status === 'Invited' ? 'Active' : f.Status,
    'Invite Token Hash': '',
    'Invite Expires': null,
    'Failed Login Attempts': 0,
    'Locked Until': null,
  });

  const revoked = await S.revokeAllForUser(email, 'system:password-reset');
  S.invalidateUser(email);
  S.clearSessionCookie(res);

  await A.auditNow({
    action: 'Password Reset', result: 'Allowed',
    userEmail: email, userRecordId: user.id,
    module: 'users', field: 'Password Hash', newValue: '[REDACTED]',
    ip, userAgent: ua,
  });

  return H.ok(res, { reset: true, sessionsRevoked: revoked, email });
};
