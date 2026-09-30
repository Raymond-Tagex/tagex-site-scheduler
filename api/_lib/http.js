// TAGEX — HTTP helpers: body parsing, JSON responses, security headers, rate limiting.

'use strict';

// ── responses ──────────────────────────────────────────────────────────────

/**
 * Same-origin only. The old api/send-slip.js sent Access-Control-Allow-Origin:* on an
 * unauthenticated endpoint, which made it an open mail relay. Nothing here echoes an origin.
 */
function baseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

function json(res, status, payload) {
  baseHeaders(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).send(JSON.stringify(payload));
}

/** Error shape the front end understands: { error, reason, detail, fields? } */
function fail(res, status, reason, detail, extra = {}) {
  json(res, status, { error: true, reason, detail, ...extra });
}

const ok = (res, payload = {}) => json(res, 200, { ok: true, ...payload });

// ── migration flag ─────────────────────────────────────────────────────────
//
// AUTH_MODE = 'session' | 'pat'
//
// 'session' is the model built here. 'pat' is the retired one, where each user pasted their
// own Airtable token — that path has no server component at all, so this flag acts as a KILL
// SWITCH: it turns the session endpoints off rather than turning a second auth system on.
//
// A deliberate choice. Running both models live in one deployment would double the attack
// surface during exactly the window when it matters most, and the PAT path cannot be made to
// respect any of the access control in this codebase. The tested rollback is Vercel's instant
// rollback to the previous deployment, which restores a whole known-good bundle. The flag
// exists so the new endpoints can be shut off in seconds without a redeploy.

const authMode = () => (process.env.AUTH_MODE || 'session').toLowerCase();

/** Returns true when the handler should continue. Writes the 503 itself when it should not. */
function sessionModeGuard(res) {
  if (authMode() === 'session') return true;
  fail(res, 503, 'auth_mode_disabled',
    'Session authentication is currently disabled (AUTH_MODE is not "session"). '
    + 'The application is running in legacy mode.');
  return false;
}

// ── body ───────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 1_000_000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === 'string') {
        try { return resolve(req.body ? JSON.parse(req.body) : {}); }
        catch { return reject(Object.assign(new Error('Malformed JSON body'), { code: 'bad_json' })); }
      }
      return resolve(req.body);
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { code: 'body_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error('Malformed JSON body'), { code: 'bad_json' })); }
    });
    req.on('error', reject);
  });
}

/** Guard a handler to a single method. */
function methodGuard(req, res, allowed) {
  const list = Array.isArray(allowed) ? allowed : [allowed];
  if (list.includes(req.method)) return true;
  res.setHeader('Allow', list.join(', '));
  fail(res, 405, 'method_not_allowed', `Use ${list.join(' or ')}.`);
  return false;
}

// ── rate limiting ──────────────────────────────────────────────────────────
//
// In-memory, per warm instance. On serverless this is best-effort: it blunts a burst from one
// client hitting one instance, it is not a global quota. The DURABLE control on credential
// guessing is the per-user lockout stored on the Users record (Failed Login Attempts /
// Locked Until), which survives instance churn — see api/auth/login.js.

const buckets = new Map();

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfter: 0 };
  }
  b.count += 1;
  if (b.count > limit) {
    return { ok: false, remaining: 0, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  }
  return { ok: true, remaining: limit - b.count, retryAfter: 0 };
}

// Keep the map from growing without bound on a long-lived instance.
function sweepBuckets() {
  const now = Date.now();
  if (buckets.size < 5000) return;
  for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
}

/** 120 requests/minute per session, per Part C1. */
function sessionRateLimit(sid) {
  sweepBuckets();
  return rateLimit(`sess:${sid}`, 120, 60_000);
}

/** Tighter, per-IP, on the auth endpoints. */
function authRateLimit(ip, bucket = 'auth') {
  sweepBuckets();
  return rateLimit(`${bucket}:${ip}`, 20, 60_000);
}

function tooManyRequests(res, retryAfter) {
  res.setHeader('Retry-After', String(retryAfter || 60));
  fail(res, 429, 'rate_limited', 'Too many requests. Please wait a moment and try again.');
}

module.exports = {
  baseHeaders, json, fail, ok,
  authMode, sessionModeGuard,
  readBody, MAX_BODY_BYTES, methodGuard,
  rateLimit, sessionRateLimit, authRateLimit, tooManyRequests,
};
