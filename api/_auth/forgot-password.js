// POST /api/auth/forgot-password   { email }
//
// ALWAYS returns the same success response, whether or not the address exists. No enumeration.
// The work is done after the response shape is decided, and a fixed floor delay smooths the
// timing difference between "sent an email" and "did nothing".

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
const RESET_MINUTES = 60;
const FLOOR_MS = 700;

const SAME_ANSWER = 'If that email address has an account, a reset link is on its way.';

module.exports = async function handler(req, res) {
  if (!H.methodGuard(req, res, 'POST')) return;
  if (!H.sessionModeGuard(res)) return;

  const started = Date.now();
  const ip = S.clientIp(req);
  const ua = S.userAgent(req);

  const rl = H.authRateLimit(ip, 'forgot');
  if (!rl.ok) return H.tooManyRequests(res, rl.retryAfter);

  let body;
  try { body = await H.readBody(req); }
  catch (e) { return H.fail(res, 400, e.code || 'bad_request', e.message); }

  const email = String(body.email || '').toLowerCase().trim();

  const finish = async () => {
    const elapsed = Date.now() - started;
    if (elapsed < FLOOR_MS) await new Promise((r) => setTimeout(r, FLOOR_MS - elapsed));
    return H.ok(res, { message: SAME_ANSWER });
  };

  if (!email) return finish();

  try {
    const user = await S.findUserByEmail(email);

    if (!user || user.fields.Status === 'Disabled') {
      await A.auditNow({
        action: 'Password Reset', result: 'Denied',
        denialReason: user ? 'user_disabled' : 'no_such_user',
        userEmail: email, ip, userAgent: ua,
      });
      return finish();
    }

    const token = C.newToken();
    await at.update(IAM(), USERS(), user.id, {
      'Invite Token Hash': C.hashToken(token),  // doubles as the reset token — same one-time semantics
      'Invite Expires': new Date(Date.now() + RESET_MINUTES * 60_000).toISOString(),
    });

    await M.sendPasswordReset({ to: email, token, req });

    await A.auditNow({
      action: 'Password Reset', result: 'Allowed',
      userEmail: email, userRecordId: user.id, ip, userAgent: ua,
      newValue: 'reset link issued',
    });
  } catch (e) {
    // Even a mail or Airtable failure returns the same answer — the response must not vary.
    console.error('[forgot-password] failed:', e && e.message);
  }

  return finish();
};
