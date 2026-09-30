// TAGEX — password hashing, JWT, TOTP. node:crypto only, no dependencies.
//
// Passwords are scrypt with a per-user salt. Never plaintext, never recoverable, never logged.
// Comparisons are constant-time.

'use strict';

const crypto = require('crypto');

// ── base64url ──────────────────────────────────────────────────────────────
const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uDecode = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// ── passwords ──────────────────────────────────────────────────────────────
// scrypt params. N=16384 keeps hashing near ~100ms on Vercel's runtime — slow enough to
// matter to an attacker, fast enough not to hold up a warehouse login.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_PASSWORD_LENGTH = 12;

function scryptAsync(password, salt, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, opts.keylen, { N: opts.N, r: opts.r, p: opts.p, maxmem: 256 * 1024 * 1024 },
      (err, dk) => (err ? reject(err) : resolve(dk)));
  });
}

/** @returns {Promise<string>} scrypt$N$r$p$<salt-b64>$<hash-b64> */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scryptAsync(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), dk.toString('base64')].join('$');
}

/**
 * Constant-time verify. Returns false for any malformed stored value rather than throwing,
 * so a corrupt hash denies login instead of 500-ing.
 */
async function verifyPassword(password, stored) {
  try {
    if (!stored || typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const dk = await scryptAsync(password, salt, {
      N: Number(N), r: Number(r), p: Number(p), keylen: expected.length,
    });
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}

/**
 * Burn roughly the same CPU as a real verify, for logins against an email that does not exist.
 * Without this, "no such user" returns measurably faster than "wrong password" and the generic
 * error message becomes a lie a stopwatch can see through.
 */
async function dummyVerify(password) {
  try {
    await scryptAsync(String(password || ''), crypto.randomBytes(16), SCRYPT);
  } catch { /* timing only — result discarded */ }
  return false;
}

function passwordComplaints(password) {
  const out = [];
  const s = String(password || '');
  if (s.length < MIN_PASSWORD_LENGTH) out.push(`must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if (!/[a-z]/.test(s)) out.push('must contain a lowercase letter');
  if (!/[A-Z]/.test(s)) out.push('must contain an uppercase letter');
  if (!/[0-9]/.test(s)) out.push('must contain a digit');
  return out;
}

// ── one-time tokens (invite / password reset) ──────────────────────────────
// The plaintext token exists only in the emailed link. Only its SHA-256 is stored.

function newToken() { return b64u(crypto.randomBytes(32)); }
function hashToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

function tokenMatches(token, storedHash) {
  if (!storedHash) return false;
  const a = Buffer.from(hashToken(token), 'utf8');
  const b = Buffer.from(String(storedHash), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── JWT (HS256) ────────────────────────────────────────────────────────────

function jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET is not set, or is shorter than 32 characters');
  return s;
}

/**
 * Signs a JWT.
 *
 * @param {object} payload
 * @param {number} ttlSeconds
 * @param {string} [secret]  defaults to JWT_SECRET. Pass a different one to mint a token
 *                           that the session path CANNOT verify — see signlink.js.
 */
function signJwt(payload, ttlSeconds, secret) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64u(JSON.stringify(body))}`;
  const sig = b64u(crypto.createHmac('sha256', secret || jwtSecret()).update(data).digest());
  return `${data}.${sig}`;
}

/**
 * Verify signature, algorithm and expiry.
 * Rejects alg:none and any algorithm swap — the header is checked before the signature is
 * trusted, and the HMAC is recomputed with HS256 regardless of what the header claims.
 * @returns {{ok:true, payload:object} | {ok:false, reason:string}}
 */
/**
 * Verifies a JWT.
 *
 * @param {string} token
 * @param {string} [secret]  defaults to JWT_SECRET.
 * @returns {{ok:boolean, payload?:object, reason?:string}}
 */
function verifyJwt(token, secret) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [head, body, sig] = parts;

    let header;
    try { header = JSON.parse(b64uDecode(head).toString('utf8')); }
    catch { return { ok: false, reason: 'malformed' }; }
    if (!header || header.alg !== 'HS256') return { ok: false, reason: 'bad_alg' };

    const expected = b64u(crypto.createHmac('sha256', secret || jwtSecret()).update(`${head}.${body}`).digest());
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };

    let payload;
    try { payload = JSON.parse(b64uDecode(body).toString('utf8')); }
    catch { return { ok: false, reason: 'malformed' }; }

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= now) return { ok: false, reason: 'expired' };
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30s) ──────────────────────────────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function newMfaSecret(bytes = 20) {
  const buf = crypto.randomBytes(bytes);
  let bits = '', out = '';
  for (const byte of buf) bits += byte.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function b32decode(s) {
  const clean = String(s).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = '';
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 in MFA secret');
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpAt(secret, counter) {
  const key = b32decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/** Verify a TOTP code, allowing +/- `window` steps for clock drift. Constant-time compare. */
function verifyTotp(secret, code, window = 1) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  let ok = false;
  for (let w = -window; w <= window; w++) {
    const candidate = totpAt(secret, step + w);
    const a = Buffer.from(candidate, 'utf8');
    const b = Buffer.from(clean, 'utf8');
    // No early exit — every window is evaluated so timing does not reveal which one matched.
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) ok = true;
  }
  return ok;
}

function totpUri(secret, email, issuer = 'TAGEX Energy') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`
       + `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ── misc ───────────────────────────────────────────────────────────────────
const newSessionId = () => crypto.randomBytes(16).toString('hex');

module.exports = {
  MIN_PASSWORD_LENGTH,
  b64u, b64uDecode,
  hashPassword, verifyPassword, dummyVerify, passwordComplaints,
  newToken, hashToken, tokenMatches,
  signJwt, verifyJwt,
  newMfaSecret, verifyTotp, totpUri, totpAt,
  newSessionId,
};
