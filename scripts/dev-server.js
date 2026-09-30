#!/usr/bin/env node
// Plain Node development server. No Vercel CLI in the loop.
//
//   node scripts/dev-server.js          -> http://localhost:3000
//   node scripts/dev-server.js 4000     -> a different port
//
// WHY. `vercel dev` has been unreliable here: it refuses to start if package.json has a `dev`
// script, it shells out to npm (blocked by the PowerShell execution policy), and it loads
// .env.local only at process start, which made an env-var change look like it had no effect.
//
// This does the same job with no moving parts: it reads .env.local explicitly, serves public/
// statically, and routes /api/* to the same handler files Vercel deploys. Handlers are
// re-required on every request, so editing one takes effect without a restart.
//
// Development only. It is not in the deployment bundle and Vercel never runs it.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const API = path.join(ROOT, 'api');
const PORT = Number(process.argv[2] || process.env.PORT || 3000);

// ── env ────────────────────────────────────────────────────────────────────
/**
 * Standard dotenv precedence: a variable already present in the real environment WINS, and the
 * file only fills the gaps. That makes a one-off override behave the way you would expect —
 *
 *   REQUIRE_ADMIN_MFA=true node scripts/dev-server.js
 *
 * — instead of being silently overwritten by .env.local. Anything the file could not set is
 * reported in the banner, so a surprising value is never invisible.
 */
function loadEnv(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return { loaded: [], overridden: [] };
  const loaded = [], overridden = [];
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i === -1) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (k in process.env && process.env[k] !== '') { overridden.push(k); continue; }
    process.env[k] = v;
    loaded.push(k);
  }
  return { loaded, overridden };
}

const { loaded, overridden } = loadEnv('.env.local');

// ── static ─────────────────────────────────────────────────────────────────
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' || pathname === '/index' ? '/index.html' : pathname;
  // Never let a request climb out of public/.
  const full = path.normalize(path.join(PUBLIC, rel));
  if (!full.startsWith(PUBLIC)) { res.statusCode = 403; res.end('Forbidden'); return; }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.statusCode = 404; res.end('Not found'); return;
  }
  res.setHeader('Content-Type', TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');   // so an edited js/css file is never stale
  fs.createReadStream(full).pipe(res);
}

// ── Vercel-style response shims ────────────────────────────────────────────
// The handlers are written for Vercel's res.status().json()/.send(). Node's ServerResponse
// has neither, so add them.
function decorate(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (body) => {
    if (body === undefined || body === null) return res.end();
    if (Buffer.isBuffer(body) || typeof body === 'string') return res.end(body);
    return res.json(body);
  };
  return res;
}

/**
 * Map a request path to a handler file.
 *
 *   /api/at            -> api/at.js
 *   /api/dn/reserve    -> api/dn/reserve.js
 *   /api/auth/login    -> api/auth.js        (no auth/login.js exists — auth.js routes it)
 *
 * That last case mirrors the production rewrite in vercel.json. The nine auth endpoints are
 * one function so the deployment fits inside the Hobby plan's 12-function limit; api/auth.js
 * reads the action from the path, so no query rewriting is needed here.
 */
function resolveHandler(pathname) {
  const rel = pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  if (!rel) return null;
  if (rel.split('/').some((seg) => seg === '..' || seg.startsWith('_'))) return null;

  const exact = path.normalize(path.join(API, rel + '.js'));
  if (exact.startsWith(API) && fs.existsSync(exact)) return exact;

  // Fall back to a parent catch-all: /api/auth/login -> api/auth.js
  const segments = rel.split('/');
  while (segments.length > 1) {
    segments.pop();
    const parent = path.normalize(path.join(API, segments.join('/') + '.js'));
    if (parent.startsWith(API) && fs.existsSync(parent)) return parent;
  }
  return null;
}

/** Drop cached modules so editing a handler takes effect without a restart. */
function freshRequire(file) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(API)) delete require.cache[key];
  }
  return require(file);
}

// ── server ─────────────────────────────────────────────────────────────────
// Ask the real implementation rather than reimplementing the rule here — a second copy of the
// default drifts the moment the policy changes, and then the banner reports something the
// server does not actually do.
const MFA_REQUIRED = () => require(path.join(API, '_lib', 'session.js')).REQUIRE_ADMIN_MFA();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  decorate(res);

  // Dev-only fingerprint, so you can tell at a glance in DevTools → Network which server
  // answered and what policy it is running. Neither value is a secret.
  res.setHeader('X-TAGEX-Dev-Server', 'plain-node');
  res.setHeader('X-TAGEX-Admin-MFA', MFA_REQUIRED() ? 'required' : 'off');

  // Built-in diagnostic. Defined HERE, not as a file under api/, so it can never be deployed.
  // Reports policy booleans and variable NAMES only — no values, no secrets.
  if (url.pathname === '/__dev/status') {
    const S = freshRequire(path.join(API, '_lib', 'session.js'));
    res.status(200).json({
      server: 'plain-node dev-server',
      pid: process.pid,
      envFile: fs.existsSync(path.join(ROOT, '.env.local')) ? '.env.local' : '(none)',
      varsLoaded: loaded,
      policy: {
        AUTH_MODE: process.env.AUTH_MODE || 'session (default)',
        REQUIRE_ADMIN_MFA_raw: process.env.REQUIRE_ADMIN_MFA === undefined
          ? '(not set -> defaults to false: email + password only)' : process.env.REQUIRE_ADMIN_MFA,
        requireAdminMfa: S.REQUIRE_ADMIN_MFA(),
        // What the server would tell an admin whose account has MFA switched off:
        adminWithoutMfa_mustEnrol: S.mustEnrolMfa({ 'Can Manage Users': true }, {}),
      },
      secretsPresent: {
        AIRTABLE_PAT: !!process.env.AIRTABLE_PAT,
        JWT_SECRET: !!process.env.JWT_SECRET,
      },
    });
    return;
  }

  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

  const file = resolveHandler(url.pathname);
  if (!file) {
    res.status(404).json({ error: true, reason: 'not_found', detail: `No handler for ${url.pathname}` });
    return;
  }

  const started = Date.now();
  try {
    const handler = freshRequire(file);
    const fn = typeof handler === 'function' ? handler : handler.default;
    if (typeof fn !== 'function') throw new Error(`${path.basename(file)} does not export a handler`);
    await fn(req, res);
  } catch (err) {
    console.error(`  \x1b[31m${req.method} ${url.pathname}\x1b[0m`, err && err.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: true, reason: 'server_error', detail: String(err && err.message) });
    } else {
      res.end();
    }
  } finally {
    const ms = Date.now() - started;
    const colour = res.statusCode >= 500 ? 31 : res.statusCode >= 400 ? 33 : 32;
    console.log(`  \x1b[${colour}m${res.statusCode}\x1b[0m ${req.method.padEnd(4)} ${url.pathname} ${ms}ms`);
  }
});

// A port already in use almost always means an old `vercel dev` is still running and still
// answering — which looks exactly like "my change had no effect". Say so plainly.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  \x1b[31mPort ${PORT} is already in use.\x1b[0m`);
    console.error('');
    console.error('  Something else is answering on that port — most likely an old `vercel dev`.');
    console.error('  Whatever you see in the browser is coming from THAT process, not this one.');
    console.error('');
    console.error('  Find and stop it (PowerShell):');
    console.error(`    Get-NetTCPConnection -LocalPort ${PORT} -State Listen | `
      + 'ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }');
    console.error('');
    console.error(`  Or run this server on another port:   node scripts/dev-server.js ${PORT + 1}`);
    console.error('');
    process.exit(1);
  }
  console.error('  \x1b[31mServer error:\x1b[0m', err && err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  const mfa = MFA_REQUIRED();
  console.log('');
  console.log('  \x1b[1mTAGEX dev server\x1b[0m');
  console.log(`  http://localhost:${PORT}`);
  console.log('');
  console.log(`  .env.local        ${loaded.length ? `${loaded.length} vars loaded` : '\x1b[31mNOT FOUND\x1b[0m'}`);
  if (overridden.length) {
    console.log(`  \x1b[33moverridden\x1b[0m        ${overridden.join(', ')} — already set in the`);
    console.log('                    environment, so .env.local did NOT apply to these');
  }
  console.log(`  AIRTABLE_PAT      ${process.env.AIRTABLE_PAT ? '\x1b[32mset\x1b[0m' : '\x1b[31mMISSING\x1b[0m'}`);
  console.log(`  JWT_SECRET        ${process.env.JWT_SECRET ? '\x1b[32mset\x1b[0m' : '\x1b[31mMISSING\x1b[0m'}`);
  console.log(`  AUTH_MODE         ${process.env.AUTH_MODE || 'session'}`);
  console.log(`  Admin MFA         ${mfa ? '\x1b[33mREQUIRED\x1b[0m — you will be asked to enrol'
                                        : '\x1b[32mnot required\x1b[0m — password only'}`);
  console.log('');
  console.log('  Ctrl+C to stop.');
  console.log('');
});
