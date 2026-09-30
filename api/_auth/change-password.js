// POST /api/auth/change-password   { currentPassword, newPassword }
//
// Requires the current password even though the caller already holds a valid session — a
// borrowed unlocked laptop should not be enough to lock the real owner out of their account.
//
// Every OTHER session is revoked; the one making the change keeps working.

'use strict';

const at = require('../_lib/airtable.js');
const C = require('../_lib/crypto.js');
const S = require('../_lib/session.js');
const H = require('../_lib/http.js');
const A = require('../_lib/audit.js');
const T = require('../_lib/tables.js');

const IAM = () => T.BASES.IAM;
const USERS = () => T.TABLES.users.IAM;
const SESSIONS = () => T.TABLES.sessions.IAM;

module.exports = async function handler(req, res) {
  if (!H.methodGuard(req, res, 'POST')) return;
  if (!H.sessionModeGuard(res)) return;

  const auth = await S.authenticate(req);
  if (!auth.ok) return H.fail(res, auth.status, auth.reason, auth.detail);

  const ip = S.clientIp(req);
  const ua = S.userAgent(req);

  const rl = H.authRateLimit(ip, 'change-password');
  if (!rl.ok) return H.tooManyRequests(res, rl.retryAfter);

  let body;
  try { body = await H.readBody(req); }
  catch (e) { return H.fail(res, 400, e.code || 'bad_request', e.message); }

  const currentPassword = String(body.currentPassword || '');
  const newPassword = String(body.newPassword || '');

  const currentOk = await C.verifyPassword(currentPassword, auth.user['Password Hash']);
  if (!currentOk) {
    await A.auditNow({
      action: 'Password Reset', result: 'Denied', denialReason: 'bad_current_password',
      userEmail: auth.email, userRecordId: auth.userRecordId, sessionId: auth.sid, ip, userAgent: ua,
    });
    return H.fail(res, 401, 'bad_current_password', 'Your current password is not correct.');
  }

  const complaints = C.passwordComplaints(newPassword);
  if (complaints.length) {
    return H.fail(res, 400, 'weak_password', `Password ${complaints.join(', ')}.`, { complaints });
  }
  if (newPassword === currentPassword) {
    return H.fail(res, 400, 'password_unchanged', 'Choose a password you have not just used.');
  }

  const passwordHash = await C.hashPassword(newPassword);
  await at.update(IAM(), USERS(), auth.userRecordId, {
    'Password Hash': passwordHash,
    'Password Set At': new Date().toISOString(),
    'Must Change Password': false,
  });

  // Revoke every session except this one.
  let revoked = 0;
  try {
    const rows = await at.list(IAM(), SESSIONS(), {
      filterByFormula: `AND(LOWER({User Email}) = "${S.esc(auth.email)}", NOT({Revoked}), {Session ID} != "${S.esc(auth.sid)}")`,
      fields: ['Session ID'],
    });
    for (const row of rows) {
      await at.update(IAM(), SESSIONS(), row.id, {
        Revoked: true, 'Revoked By': 'system:password-change', 'Revoked At': new Date().toISOString(),
      });
      revoked++;
    }
  } catch (e) {
    console.error('[change-password] session revocation failed:', e && e.message);
  }

  S.invalidateUser(auth.email);

  await A.auditNow({
    action: 'Password Reset', result: 'Allowed',
    userEmail: auth.email, userRecordId: auth.userRecordId, sessionId: auth.sid,
    module: 'users', field: 'Password Hash', newValue: '[REDACTED]',
    ip, userAgent: ua,
  });

  return H.ok(res, { changed: true, otherSessionsRevoked: revoked });
};
