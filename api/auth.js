// TAGEX — /api/auth/* router.
//
// WHY THIS EXISTS. Vercel's Hobby plan allows 12 Serverless Functions per deployment, and each
// file under api/ becomes one. Nine separate auth endpoints plus at.js, dn/reserve.js,
// delivery-note-pdf.js and send-slip.js came to 13.
//
// The nine auth handlers share every dependency and are tiny, so they are now ONE function.
// The real handlers live in api/_auth/ — Vercel ignores anything under api/ whose name starts
// with an underscore, so they are bundled as plain modules rather than counted as functions.
//
// The URLs do not change. vercel.json rewrites /api/auth/<action> to /api/auth?action=<action>,
// and this file also derives the action straight from the path, so it behaves identically
// whether the rewrite ran or not (the local dev server relies on the second form).
//
// Function count after this: at.js, auth.js, dn/reserve.js, delivery-note-pdf.js,
// send-slip.js = 5.

'use strict';

const H = require('./_lib/http.js');

// Required eagerly: they all pull the same modules out of _lib, so there is nothing to defer.
const ROUTES = {
  'login':            require('./_auth/login.js'),
  'logout':           require('./_auth/logout.js'),
  'me':               require('./_auth/me.js'),
  'invite':           require('./_auth/invite.js'),
  'accept-invite':    require('./_auth/accept-invite.js'),
  'forgot-password':  require('./_auth/forgot-password.js'),
  'reset-password':   require('./_auth/reset-password.js'),
  'change-password':  require('./_auth/change-password.js'),
  'set-password':     require('./_auth/set-password.js'),
  'mfa':              require('./_auth/mfa.js'),
};

/** Accept ?action=login (rewritten) or the /api/auth/login path (direct). */
function resolveAction(req) {
  const raw = String(req.url || '');
  const qs = raw.indexOf('?');
  if (qs !== -1) {
    const params = new URLSearchParams(raw.slice(qs + 1));
    const a = params.get('action');
    if (a) return a.toLowerCase();
  }
  const pathname = qs === -1 ? raw : raw.slice(0, qs);
  const m = pathname.match(/\/api\/auth\/([A-Za-z-]+)\/?$/);
  return m ? m[1].toLowerCase() : null;
}

module.exports = async function handler(req, res) {
  const action = resolveAction(req);

  if (!action || !Object.prototype.hasOwnProperty.call(ROUTES, action)) {
    return H.fail(res, 404, 'unknown_action',
      `No such auth endpoint. Expected one of: ${Object.keys(ROUTES).join(', ')}.`);
  }

  return ROUTES[action](req, res);
};
