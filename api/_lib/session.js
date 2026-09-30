// TAGEX — session handling: cookie, JWT, Sessions registry, idle timeout, user+role loading.

'use strict';

const at = require('./airtable.js');
const C = require('./crypto.js');
const T = require('./tables.js');
const P = require('./permissions.js');

const COOKIE = 'tagex_session';

const SESSION_TTL_HOURS      = () => Number(process.env.SESSION_TTL_HOURS || 8);
const IDLE_TIMEOUT_MINUTES   = () => Number(process.env.IDLE_TIMEOUT_MINUTES || 30);

/**
 * Whether two-factor authentication is compulsory for admin-capable roles.
 *
 * DEFAULTS TO FALSE — sign-in is email and password only. Set REQUIRE_ADMIN_MFA=true to make
 * it compulsory again; the whole TOTP implementation is still here and still tested.
 *
 * The trade-off, recorded so it is not forgotten: with this off, one password is the only
 * thing between an attacker and the FICA / personal records in the C&I base, user management,
 * and permission editing. A reused or phished password is a total compromise. Account lockout
 * (5 attempts, 15 minutes) and the audit trail still apply, but neither stops someone holding
 * the correct password.
 *
 * Everything else is enforced regardless: scrypt password hashing, session expiry, idle
 * timeout, the permission matrix, field-level rules, and the restricted-data double gate.
 *
 * A user who opts into MFA on their own account is still challenged at login — see
 * api/auth/login.js. This flag governs only whether it is FORCED on administrators.
 */
const REQUIRE_ADMIN_MFA = () =>
  String(process.env.REQUIRE_ADMIN_MFA || 'false').toLowerCase() === 'true';

/** True when this session must enrol MFA before it may do anything else. */
function mustEnrolMfa(role, userFields) {
  if (!REQUIRE_ADMIN_MFA()) return false;
  if (!role || role['Can Manage Users'] !== true) return false;
  return !(userFields && userFields['MFA Enabled'] === true && userFields['MFA Secret']);
}
// Any session that has touched restricted personal data drops to a tighter idle window.
const RESTRICTED_IDLE_MINUTES = 15;
// "Remember this device" extends only the ABSOLUTE window. It never stores credentials,
// never stores a token anywhere but the HttpOnly cookie, and never relaxes the idle timeout.
const REMEMBER_TTL_HOURS = 30 * 24;

const IAM = () => T.BASES.IAM;
const USERS = () => T.TABLES.users.IAM;
const SESSIONS = () => T.TABLES.sessions.IAM;
const LEVELS = () => T.TABLES.access_levels.IAM;

// ── cookies ────────────────────────────────────────────────────────────────

function readCookie(req, name = COOKIE) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(res, token, maxAgeSeconds) {
  const bits = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
  ];
  res.setHeader('Set-Cookie', bits.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
}

// ── request metadata ───────────────────────────────────────────────────────

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

const userAgent = (req) => String(req.headers['user-agent'] || '').slice(0, 500);

// ── caches ─────────────────────────────────────────────────────────────────
// Serverless: per-instance and best-effort. Bounded so a revocation or role change takes
// effect within one TTL rather than a full session.

const SESSION_CACHE_MS = 60 * 1000;   // revoking a session bites within ~60s
const ROLE_CACHE_MS    = 60 * 1000;
const LAST_SEEN_WRITE_MS = 2 * 60 * 1000; // only touch Last Seen if this stale

const sessionCache = new Map();
const roleCache = new Map();

function cacheGet(map, key, ttl) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  map.delete(key);
  return null;
}
function cacheSet(map, key, value) { map.set(key, { at: Date.now(), value }); }
function cacheDrop(map, key) { map.delete(key); }

// ── lookups ────────────────────────────────────────────────────────────────

const esc = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

async function findUserByEmail(email) {
  const clean = String(email || '').toLowerCase().trim();
  if (!clean) return null;
  return at.findOne(IAM(), USERS(), `LOWER({Email}) = "${esc(clean)}"`);
}

async function loadRole(recordId) {
  const hit = cacheGet(roleCache, recordId, ROLE_CACHE_MS);
  if (hit) return hit;
  const rec = await at.get(IAM(), LEVELS(), recordId);
  const role = { id: rec.id, ...rec.fields };
  cacheSet(roleCache, recordId, role);
  return role;
}

/** Resolve a user record's linked Access Level. Exactly one is required. */
async function roleForUser(userFields) {
  const links = userFields['Access Level'];
  if (!Array.isArray(links) || links.length !== 1) return null;
  return loadRole(links[0]);
}

// ── session lifecycle ──────────────────────────────────────────────────────

async function createSession({ user, req, remember }) {
  const sid = C.newSessionId();
  const ttlHours = remember ? REMEMBER_TTL_HOURS : SESSION_TTL_HOURS();
  const ttlSeconds = ttlHours * 3600;
  const now = new Date();
  const expires = new Date(now.getTime() + ttlSeconds * 1000);

  const created = await at.create(IAM(), SESSIONS(), [{
    'Session ID': sid,
    User: [user.id],
    'User Email': String(user.fields.Email).toLowerCase(),
    'Issued At': now.toISOString(),
    'Expires At': expires.toISOString(),
    'Last Seen': now.toISOString(),
    IP: clientIp(req),
    'User Agent': userAgent(req),
    Revoked: false,
  }]);

  // Carry the Airtable RECORD ID in the token, not just our own session id.
  //
  // Airtable's filterByFormula index is eventually consistent: a row created milliseconds ago
  // frequently is not findable by query yet. Looking the session up that way immediately after
  // login therefore returned "not found" -> 401 -> the app bounced straight back to the login
  // screen. Fetching by record id is a direct read and is consistent at once.
  const srid = created && created[0] && created[0].id;

  const token = C.signJwt(
    { sub: String(user.fields.Email).toLowerCase(), sid, srid },
    ttlSeconds
  );

  return { sid, srid, token, ttlSeconds, expiresAt: expires };
}

/**
 * Find a session row. Prefers a direct record fetch (immediately consistent); falls back to a
 * query for tokens issued before record ids were embedded, retrying briefly to ride out the
 * index lag described above.
 */
async function findSessionRow(sid, srid) {
  if (srid) {
    try {
      return await at.get(IAM(), SESSIONS(), srid);
    } catch (e) {
      if (e.status !== 404) throw e;
      return null; // genuinely deleted
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await at.findOne(IAM(), SESSIONS(), `{Session ID} = "${esc(sid)}"`);
    if (row) return row;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 350));
  }
  return null;
}

async function revokeSession(sid, byEmail) {
  const row = await findSessionRow(sid);
  if (!row) return false;
  await at.update(IAM(), SESSIONS(), row.id, {
    Revoked: true,
    'Revoked By': byEmail || '',
    'Revoked At': new Date().toISOString(),
  });
  cacheDrop(sessionCache, sid);
  return true;
}

/** Revoke every live session for a user. Used on password reset and on suspend. */
async function revokeAllForUser(email, byEmail) {
  const clean = String(email || '').toLowerCase();
  const rows = await at.list(IAM(), SESSIONS(), {
    filterByFormula: `AND(LOWER({User Email}) = "${esc(clean)}", NOT({Revoked}))`,
    fields: ['Session ID'],
  });
  for (const row of rows) {
    await at.update(IAM(), SESSIONS(), row.id, {
      Revoked: true, 'Revoked By': byEmail || 'system', 'Revoked At': new Date().toISOString(),
    });
    cacheDrop(sessionCache, row.fields['Session ID']);
  }
  return rows.length;
}

async function markSessionTouchedRestricted(sid) {
  const row = await findSessionRow(sid);
  if (!row || row.fields['Touched Restricted']) return;
  await at.update(IAM(), SESSIONS(), row.id, { 'Touched Restricted': true });
  cacheDrop(sessionCache, sid);
}

/**
 * Authenticate a request.
 *
 * Steps 1 and 2 of the Part C1 enforcement chain:
 *   1. valid JWT (signature, algorithm, expiry) + live, unrevoked session + idle timeout
 *   2. user exists, Status === 'Active', exactly one role
 *
 * @returns {{ok:true, ...ctx} | {ok:false, status:number, reason:string, detail:string}}
 */
async function authenticate(req) {
  const token = readCookie(req);
  if (!token) return { ok: false, status: 401, reason: 'no_session', detail: 'Not signed in.' };

  const v = C.verifyJwt(token);
  if (!v.ok) {
    return { ok: false, status: 401, reason: `jwt_${v.reason}`, detail: 'Your session is not valid. Please sign in again.' };
  }

  const { sub: email, sid, srid } = v.payload;
  if (!email || !sid) return { ok: false, status: 401, reason: 'jwt_malformed', detail: 'Your session is not valid.' };

  let ctx = cacheGet(sessionCache, sid, SESSION_CACHE_MS);

  if (!ctx) {
    const row = await findSessionRow(sid, srid);
    if (!row) return { ok: false, status: 401, reason: 'session_unknown', detail: 'Your session has ended. Please sign in again.' };
    if (row.fields.Revoked) return { ok: false, status: 401, reason: 'session_revoked', detail: 'This session was signed out remotely.' };

    const expiresAt = row.fields['Expires At'] ? new Date(row.fields['Expires At']).getTime() : 0;
    if (expiresAt && Date.now() > expiresAt) {
      return { ok: false, status: 401, reason: 'session_expired', detail: 'Your session has expired. Please sign in again.' };
    }

    const idleLimitMs = (row.fields['Touched Restricted'] ? RESTRICTED_IDLE_MINUTES : IDLE_TIMEOUT_MINUTES()) * 60 * 1000;
    const lastSeen = row.fields['Last Seen'] ? new Date(row.fields['Last Seen']).getTime() : 0;
    if (lastSeen && Date.now() - lastSeen > idleLimitMs) {
      await revokeSession(sid, 'system:idle-timeout');
      return { ok: false, status: 401, reason: 'session_idle_timeout', detail: 'Signed out after inactivity. Please sign in again.' };
    }

    const userRec = await findUserByEmail(email);
    if (!userRec) return { ok: false, status: 401, reason: 'user_missing', detail: 'Your session is not valid.' };

    const status = userRec.fields.Status;
    if (status !== 'Active') {
      return {
        ok: false, status: 403, reason: 'user_not_active',
        detail: `This account is ${String(status || 'not active').toLowerCase()}. Contact an administrator.`,
      };
    }

    const role = await roleForUser(userRec.fields);
    if (!role) {
      return { ok: false, status: 403, reason: 'no_role', detail: 'This account has no access level assigned. Contact an administrator.' };
    }
    if (role.Active === false) {
      return { ok: false, status: 403, reason: 'role_inactive', detail: 'Your access level has been deactivated. Contact an administrator.' };
    }

    ctx = {
      sid,
      sessionRecordId: row.id,
      touchedRestricted: !!row.fields['Touched Restricted'],
      lastSeen,
      email: String(userRec.fields.Email).toLowerCase(),
      userRecordId: userRec.id,
      user: userRec.fields,
      role,
      perms: P.effectivePermissions(role.Permissions, userRec.fields['Permission Overrides']),
    };
    cacheSet(sessionCache, sid, ctx);
  }

  // Sliding refresh, rate-limited so a busy session does not write on every request.
  if (!ctx.lastSeen || Date.now() - ctx.lastSeen > LAST_SEEN_WRITE_MS) {
    const stamp = new Date().toISOString();
    at.update(IAM(), SESSIONS(), ctx.sessionRecordId, { 'Last Seen': stamp })
      .then(() => { ctx.lastSeen = Date.now(); cacheSet(sessionCache, sid, ctx); })
      .catch((e) => console.error('[session] Last Seen update failed:', e && e.message));
    ctx.lastSeen = Date.now();
  }

  return { ok: true, ...ctx };
}

/** Drop cached state for a user so a role or status change takes effect immediately. */
function invalidateUser(email) {
  const clean = String(email || '').toLowerCase();
  for (const [sid, entry] of sessionCache.entries()) {
    if (entry && entry.value && entry.value.email === clean) sessionCache.delete(sid);
  }
}
function invalidateRole(roleRecordId) {
  roleCache.delete(roleRecordId);
  for (const [sid, entry] of sessionCache.entries()) {
    if (entry && entry.value && entry.value.role && entry.value.role.id === roleRecordId) sessionCache.delete(sid);
  }
}

module.exports = {
  COOKIE,
  SESSION_TTL_HOURS, IDLE_TIMEOUT_MINUTES, RESTRICTED_IDLE_MINUTES, REMEMBER_TTL_HOURS,
  REQUIRE_ADMIN_MFA, mustEnrolMfa,
  readCookie, setSessionCookie, clearSessionCookie,
  clientIp, userAgent,
  findUserByEmail, loadRole, roleForUser,
  createSession, findSessionRow, revokeSession, revokeAllForUser, markSessionTouchedRestricted,
  authenticate, invalidateUser, invalidateRole,
  esc,
};
