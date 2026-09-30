// POST /api/auth/login   { email, password, mfaCode?, remember? }
//
// Wrong email and wrong password return the IDENTICAL error and take a comparable amount of
// time — no user enumeration, by message or by stopwatch. Every attempt is audited.
//
// Lockout is stored on the Users record (Failed Login Attempts / Locked Until), not in memory,
// so it survives serverless instance churn. Five consecutive failures lock the account for
// 15 minutes.

'use strict';

const at = require('../_lib/airtable.js');
const C = require('../_lib/crypto.js');
const S = require('../_lib/session.js');
const H = require('../_lib/http.js');
const A = require('../_lib/audit.js');
const T = require('../_lib/tables.js');

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const GENERIC = 'Invalid email or password.';

const IAM = () => T.BASES.IAM;
const USERS = () => T.TABLES.users.IAM;

module.exports = async function handler(req, res) {
  if (!H.methodGuard(req, res, 'POST')) return;
  if (!H.sessionModeGuard(res)) return;

  const ip = S.clientIp(req);
  const ua = S.userAgent(req);

  const rl = H.authRateLimit(ip, 'login');
  if (!rl.ok) {
    await A.auditNow({ action: 'Login Failed', result: 'Denied', denialReason: 'rate_limited', ip, userAgent: ua });
    return H.tooManyRequests(res, rl.retryAfter);
  }

  let body;
  try { body = await H.readBody(req); }
  catch (e) { return H.fail(res, 400, e.code || 'bad_request', e.message); }

  const email = String(body.email || '').toLowerCase().trim();
  const password = String(body.password || '');
  const mfaCode = body.mfaCode ? String(body.mfaCode) : null;
  const remember = body.remember === true;

  if (!email || !password) {
    await A.auditNow({ action: 'Login Failed', result: 'Denied', denialReason: 'missing_credentials', userEmail: email, ip, userAgent: ua });
    return H.fail(res, 401, 'invalid_credentials', GENERIC);
  }

  const user = await S.findUserByEmail(email);

  // No such user: burn comparable CPU so the timing does not betray it, then fail identically.
  if (!user) {
    await C.dummyVerify(password);
    await A.auditNow({ action: 'Login Failed', result: 'Denied', denialReason: 'no_such_user', userEmail: email, ip, userAgent: ua });
    return H.fail(res, 401, 'invalid_credentials', GENERIC);
  }

  const f = user.fields;

  // Lockout — checked before the password, so a locked account cannot be probed for free.
  const lockedUntil = f['Locked Until'] ? new Date(f['Locked Until']).getTime() : 0;
  if (lockedUntil && Date.now() < lockedUntil) {
    const mins = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 60000));
    await A.auditNow({
      action: 'Login Failed', result: 'Denied', denialReason: 'account_locked',
      userEmail: email, userRecordId: user.id, ip, userAgent: ua,
    });
    return H.fail(res, 423, 'account_locked',
      `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, { retryAfterMinutes: mins });
  }

  const passwordOk = await C.verifyPassword(password, f['Password Hash']);

  if (!passwordOk) {
    const attempts = Number(f['Failed Login Attempts'] || 0) + 1;
    const patch = { 'Failed Login Attempts': attempts };
    let locked = false;
    if (attempts >= MAX_ATTEMPTS) {
      patch['Locked Until'] = new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString();
      locked = true;
    }
    await at.update(IAM(), USERS(), user.id, patch).catch((e) => console.error('[login] counter update failed:', e.message));
    await A.auditNow({
      action: 'Login Failed', result: 'Denied',
      denialReason: locked ? 'bad_password_now_locked' : 'bad_password',
      userEmail: email, userRecordId: user.id, ip, userAgent: ua,
      newValue: `attempt ${attempts} of ${MAX_ATTEMPTS}`,
    });
    // Even on the attempt that trips the lock, the message stays generic. The lock is only
    // revealed on the NEXT attempt, so this cannot be used to confirm an address exists.
    return H.fail(res, 401, 'invalid_credentials', GENERIC);
  }

  // Password is correct from here on.

  if (f.Status !== 'Active' && f.Status !== 'Invited') {
    await A.auditNow({
      action: 'Login Failed', result: 'Denied', denialReason: 'user_not_active',
      userEmail: email, userRecordId: user.id, ip, userAgent: ua,
    });
    return H.fail(res, 403, 'user_not_active',
      `This account is ${String(f.Status || 'not active').toLowerCase()}. Contact an administrator.`);
  }
  if (f.Status === 'Invited') {
    await A.auditNow({
      action: 'Login Failed', result: 'Denied', denialReason: 'invite_not_accepted',
      userEmail: email, userRecordId: user.id, ip, userAgent: ua,
    });
    return H.fail(res, 403, 'invite_not_accepted', 'Finish setting up your account using the link in your invitation email.');
  }

  const role = await S.roleForUser(f);
  if (!role) {
    await A.auditNow({ action: 'Login Failed', result: 'Denied', denialReason: 'no_role', userEmail: email, userRecordId: user.id, ip, userAgent: ua });
    return H.fail(res, 403, 'no_role', 'This account has no access level assigned. Contact an administrator.');
  }

  const mfaEnabled = f['MFA Enabled'] === true && !!f['MFA Secret'];

  // MFA is opt-in. This challenge fires only when the USER has switched it on for their own
  // account. Whether it is FORCED on administrators is REQUIRE_ADMIN_MFA (default: off).
  if (mfaEnabled) {
    if (!mfaCode) {
      // Not an error: the client shows the code step and re-posts with the same credentials.
      return H.ok(res, { mfaRequired: true });
    }
    if (!C.verifyTotp(f['MFA Secret'], mfaCode)) {
      const attempts = Number(f['Failed Login Attempts'] || 0) + 1;
      const patch = { 'Failed Login Attempts': attempts };
      if (attempts >= MAX_ATTEMPTS) patch['Locked Until'] = new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString();
      await at.update(IAM(), USERS(), user.id, patch).catch(() => {});
      await A.auditNow({
        action: 'Login Failed', result: 'Denied', denialReason: 'bad_mfa_code',
        userEmail: email, userRecordId: user.id, ip, userAgent: ua,
      });
      return H.fail(res, 401, 'invalid_mfa', 'That authentication code is not valid.');
    }
  }

  // Session.
  const { sid, token, ttlSeconds } = await S.createSession({ user, req, remember });

  await at.update(IAM(), USERS(), user.id, {
    'Failed Login Attempts': 0,
    'Locked Until': null,
    'Last Login At': new Date().toISOString(),
    'Last Login IP': ip,
  }).catch((e) => console.error('[login] post-login update failed:', e.message));

  S.setSessionCookie(res, token, ttlSeconds);
  S.invalidateUser(email);

  await A.auditNow({
    action: 'Login', result: 'Allowed', userEmail: email, userRecordId: user.id,
    ip, userAgent: ua, sessionId: sid,
    newValue: remember ? 'remembered device' : 'session',
  });

  return H.ok(res, {
    mustChangePassword: f['Must Change Password'] === true,
    // Admin without MFA can sign in, but /api/at refuses everything until enrolment completes.
    // Blocking the login outright would make the first Admin account impossible to set up.
    mustEnrolMfa: S.mustEnrolMfa(role, f),
    user: {
      email,
      fullName: f['Full Name'] || '',
      role: role['Role Name'] || '',
    },
  });
};
