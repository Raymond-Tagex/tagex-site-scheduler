// POST /api/auth/mfa   { action: "begin" | "enable" | "disable", code?, password? }
//
// TOTP enrolment. OPT-IN by default: sign-in is email + password only unless a user turns MFA
// on for their own account, or REQUIRE_ADMIN_MFA=true forces it on administrators.
//
// When it IS forced, api/at.js refuses every request from an admin session until enrolment is
// complete — so this endpoint is deliberately reachable while that block is in force.
//
//   begin   -> generates a secret, returns it plus the otpauth:// URI. NOT yet enabled.
//   enable  -> verifies a code against the pending secret, then turns MFA on.
//   disable -> requires the current password AND a valid code. Refused for Admin roles.
//
// The secret is returned exactly once, at "begin". After that it is never readable again:
// MFA Secret is on the global never-return list.

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

  const auth = await S.authenticate(req);
  if (!auth.ok) return H.fail(res, auth.status, auth.reason, auth.detail);

  const ip = S.clientIp(req);
  const ua = S.userAgent(req);

  const rl = H.authRateLimit(ip, 'mfa');
  if (!rl.ok) return H.tooManyRequests(res, rl.retryAfter);

  let body;
  try { body = await H.readBody(req); }
  catch (e) { return H.fail(res, 400, e.code || 'bad_request', e.message); }

  const action = String(body.action || '');
  const isAdmin = auth.role['Can Manage Users'] === true;
  const enabled = auth.user['MFA Enabled'] === true && !!auth.user['MFA Secret'];

  const audit = (result, reason, note) => A.auditNow({
    action: 'Permission Change', result, denialReason: reason || '',
    module: 'users', field: 'MFA Enabled', newValue: note || '',
    userEmail: auth.email, userRecordId: auth.userRecordId, sessionId: auth.sid, ip, userAgent: ua,
  });

  // ── begin ───────────────────────────────────────────────────────────────
  if (action === 'begin') {
    if (enabled) return H.fail(res, 409, 'mfa_already_enabled', 'Two-factor authentication is already on for this account.');
    const secret = C.newMfaSecret();
    // Stored but not enabled. An abandoned enrolment leaves an unusable secret and no MFA.
    await at.update(IAM(), USERS(), auth.userRecordId, { 'MFA Secret': secret, 'MFA Enabled': false });
    S.invalidateUser(auth.email);
    return H.ok(res, {
      secret,
      otpauth: C.totpUri(secret, auth.email),
      note: 'Add this to your authenticator app, then confirm with a code. This secret is shown once.',
    });
  }

  // ── enable ──────────────────────────────────────────────────────────────
  if (action === 'enable') {
    const code = String(body.code || '');
    const secret = auth.user['MFA Secret'];
    if (!secret) return H.fail(res, 400, 'mfa_not_started', 'Start enrolment first.');
    if (!C.verifyTotp(secret, code)) {
      await audit('Denied', 'bad_mfa_code');
      return H.fail(res, 401, 'invalid_mfa', 'That code is not valid. Check your authenticator app and try again.');
    }
    await at.update(IAM(), USERS(), auth.userRecordId, { 'MFA Enabled': true });
    S.invalidateUser(auth.email);
    await audit('Allowed', '', 'MFA enabled');
    return H.ok(res, { mfaEnabled: true });
  }

  // ── disable ─────────────────────────────────────────────────────────────
  if (action === 'disable') {
    // Only refuse while the mandatory-MFA policy is switched on.
    if (isAdmin && S.REQUIRE_ADMIN_MFA()) {
      await audit('Denied', 'mfa_mandatory_for_admin');
      return H.fail(res, 403, 'mfa_mandatory', 'Two-factor authentication is mandatory for administrators and cannot be turned off.');
    }
    if (!enabled) return H.ok(res, { mfaEnabled: false });

    const passwordOk = await C.verifyPassword(String(body.password || ''), auth.user['Password Hash']);
    if (!passwordOk) {
      await audit('Denied', 'bad_current_password');
      return H.fail(res, 401, 'bad_current_password', 'Your password is not correct.');
    }
    if (!C.verifyTotp(auth.user['MFA Secret'], String(body.code || ''))) {
      await audit('Denied', 'bad_mfa_code');
      return H.fail(res, 401, 'invalid_mfa', 'That code is not valid.');
    }

    await at.update(IAM(), USERS(), auth.userRecordId, { 'MFA Enabled': false, 'MFA Secret': '' });
    S.invalidateUser(auth.email);
    await audit('Allowed', '', 'MFA disabled');
    return H.ok(res, { mfaEnabled: false });
  }

  return H.fail(res, 400, 'unknown_action', 'action must be begin, enable or disable.');
};
