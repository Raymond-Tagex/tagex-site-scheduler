// POST /api/auth/logout — clear the cookie and revoke the session row.
//
// Always returns 200. Logging out must never fail: if the session was already gone, the user
// still ends up signed out, which is the outcome they asked for.

'use strict';

const S = require('../_lib/session.js');
const H = require('../_lib/http.js');
const A = require('../_lib/audit.js');
const C = require('../_lib/crypto.js');

module.exports = async function handler(req, res) {
  if (!H.methodGuard(req, res, 'POST')) return;
  if (!H.sessionModeGuard(res)) return;

  const token = S.readCookie(req);
  S.clearSessionCookie(res);

  if (token) {
    const v = C.verifyJwt(token);
    if (v.ok && v.payload.sid) {
      try {
        await S.revokeSession(v.payload.sid, v.payload.sub || 'self');
        S.invalidateUser(v.payload.sub);
        await A.auditNow({
          action: 'Logout', result: 'Allowed',
          userEmail: v.payload.sub, sessionId: v.payload.sid,
          ip: S.clientIp(req), userAgent: S.userAgent(req),
        });
      } catch (e) {
        console.error('[logout] revoke failed (cookie still cleared):', e && e.message);
      }
    }
  }

  return H.ok(res, { signedOut: true });
};
