#!/usr/bin/env node
// Pre-flight check. Run this BEFORE deploying, and again after setting Vercel env vars.
//
//   node scripts/check-config.js
//
// Verifies that AIRTABLE_PAT and JWT_SECRET exist, that the PAT actually reaches all three
// bases with both read and schema scope, and that the four roles are seeded. Prints nothing
// secret — token values are never echoed.

'use strict';

const path = require('path');
const T = require(path.join(__dirname, '..', 'api', '_lib', 'tables.js'));

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
let failures = 0;

// Load .env.local for local runs. On Vercel the vars are already in the environment.
function loadEnvLocal() {
  const fs = require('fs');
  const p = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(p)) return false;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i === -1) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
  return true;
}

(async () => {
  console.log('\n\x1b[1mTAGEX — configuration check\x1b[0m\n');

  if (loadEnvLocal()) console.log('  (loaded .env.local)\n');

  // ── env vars ────────────────────────────────────────────────────────────
  console.log('\x1b[1mEnvironment\x1b[0m');

  const pat = process.env.AIRTABLE_PAT;
  if (!pat) bad('AIRTABLE_PAT is not set');
  else if (!/^pat[A-Za-z0-9]+\./.test(pat)) bad('AIRTABLE_PAT does not look like a PAT (should start "pat…" and contain a dot)');
  else ok(`AIRTABLE_PAT is set (${pat.slice(0, 7)}…, ${pat.length} chars)`);

  const secret = process.env.JWT_SECRET;
  if (!secret) bad('JWT_SECRET is not set');
  else if (secret.length < 32) bad(`JWT_SECRET is only ${secret.length} characters — needs at least 32`);
  else if (/replace-me|changeme|example|secret123/i.test(secret)) bad('JWT_SECRET is still a placeholder value');
  else ok(`JWT_SECRET is set (${secret.length} chars)`);

  // Site signing links. The separate secret is the whole defence: the session path verifies
  // tokens without discriminating what they were minted for, so a shared value would make a
  // signing link a valid login. Sharing it is an error, not a warning.
  const link = process.env.SIGN_LINK_SECRET;
  if (!link) {
    warn('SIGN_LINK_SECRET not set — site signing links are unavailable (everything else works)');
  } else if (link.length < 32) {
    bad(`SIGN_LINK_SECRET is only ${link.length} characters — needs at least 32`);
  } else if (/replace-me|changeme|example/i.test(link)) {
    bad('SIGN_LINK_SECRET is still a placeholder value');
  } else if (link === secret) {
    bad('SIGN_LINK_SECRET is the SAME as JWT_SECRET — a signing link would be a valid session cookie');
  } else {
    ok(`SIGN_LINK_SECRET is set (${link.length} chars), and differs from JWT_SECRET`);
  }

  const mode = (process.env.AUTH_MODE || 'session').toLowerCase();
  if (mode === 'session') ok('AUTH_MODE = session');
  else warn(`AUTH_MODE = ${mode} — session endpoints will return 503`);

  if (!process.env.RESEND_API_KEY) warn('RESEND_API_KEY not set — invitations and password resets will fail (saving and printing still work)');
  else ok('RESEND_API_KEY is set');

  if (!process.env.APP_ORIGIN) warn('APP_ORIGIN not set — invite links will be built from the request Host header');
  else ok(`APP_ORIGIN = ${process.env.APP_ORIGIN}`);

  if (failures) {
    console.log('\n\x1b[31mStop here and fix the above before continuing.\x1b[0m\n');
    process.exit(1);
  }

  // ── base reachability ───────────────────────────────────────────────────
  console.log('\n\x1b[1mAirtable access\x1b[0m');
  const at = require(path.join(__dirname, '..', 'api', '_lib', 'airtable.js'));

  for (const [symbol, baseId] of Object.entries(T.BASES)) {
    try {
      const tables = await at.baseSchema(baseId);
      ok(`${symbol} (${baseId}) — schema readable, ${Object.keys(tables).length} tables`);
    } catch (e) {
      bad(`${symbol} (${baseId}) — ${e.message}`
        + (e.status === 403 ? '  → the PAT is missing this base, or lacks schema.bases:read' : ''));
    }
  }

  if (failures) {
    console.log('\n\x1b[31mThe PAT cannot reach every base. Add the missing base(s) to the token and retry.\x1b[0m\n');
    process.exit(1);
  }

  // ── required fields exist ───────────────────────────────────────────────
  console.log('\n\x1b[1mSchema prerequisites\x1b[0m');
  const need = [
    ['CI', 'documents', 'Sensitivity'], ['OM', 'documents', 'Sensitivity'],
    ['CI', 'documents', 'Record Status'], ['OM', 'documents', 'Record Status'],
    ['CI', 'job_cards', 'Assigned To (Email)'], ['OM', 'job_cards', 'Assigned To (Email)'],
    ['CI', 'site_visits', 'Technician Email'], ['OM', 'site_visits', 'Technician Email'],
  ];
  for (const [baseSym, moduleKey, fieldName] of need) {
    const r = T.resolve(baseSym, moduleKey);
    if (!r.ok) { bad(`${baseSym}/${moduleKey} does not resolve`); continue; }
    try {
      const schema = await at.tableSchema(r.baseId, r.tableId);
      if (schema && schema.fields[fieldName]) ok(`${baseSym} ${moduleKey}.${fieldName}`);
      else bad(`${baseSym} ${moduleKey}.${fieldName} is MISSING`);
    } catch (e) { bad(`${baseSym} ${moduleKey}.${fieldName} — ${e.message}`); }
  }

  // ── roles seeded ────────────────────────────────────────────────────────
  console.log('\n\x1b[1mIdentity\x1b[0m');
  const P = require(path.join(__dirname, '..', 'api', '_lib', 'permissions.js'));
  try {
    const roles = await at.list(T.BASES.IAM, T.TABLES.access_levels.IAM, {
      fields: ['Role Name', 'Permissions', 'Active', 'Can Manage Users'],
    });
    const expected = ['Admin / Director', 'Operations / Project Manager', 'Technician / Field', 'Warehouse / Stores'];
    for (const name of expected) {
      const r = roles.find((x) => x.fields['Role Name'] === name);
      if (!r) { bad(`Access Level "${name}" is missing`); continue; }
      const perms = P.effectivePermissions(r.fields.Permissions, null);
      const n = Object.keys(perms).length;
      if (!n) bad(`"${name}" has no usable Permissions JSON`);
      else ok(`"${name}" — ${n} modules`);
    }

    const users = await at.list(T.BASES.IAM, T.TABLES.users.IAM, {
      fields: ['Email', 'Status', 'MFA Enabled', 'Integrity Check'],
    });
    if (!users.length) {
      warn('No users yet — run: node scripts/bootstrap-admin.js');
    } else {
      ok(`${users.length} user(s)`);
      const mfaRequired = String(process.env.REQUIRE_ADMIN_MFA || 'false').toLowerCase() === 'true';
      const bads = users.filter((u) => u.fields['Integrity Check'] && u.fields['Integrity Check'] !== 'OK');
      for (const u of bads) {
        const note = u.fields['Integrity Check'];
        // The Integrity Check formula always flags an admin without MFA. When the policy is
        // switched off that is the intended state, so report it as a standing note rather
        // than a failure — but never let it go unmentioned.
        // The Integrity Check formula always flags an admin without MFA. That is the normal
        // state now, so it is not a failure — but it is never silently ignored either.
        if (!mfaRequired && note.includes('MFA')) {
          console.log(`  \x1b[90m·\x1b[0m ${u.fields.Email}: ${note} (expected — MFA is not enforced)`);
        } else {
          bad(`${u.fields.Email}: ${note}`);
        }
      }
      console.log(`  \x1b[90m·\x1b[0m Sign-in: ${mfaRequired
        ? 'email + password + TOTP (REQUIRE_ADMIN_MFA=true)'
        : 'email + password only. Set REQUIRE_ADMIN_MFA=true to require two-factor for admins.'}`);
      const admins = users.filter((u) => u.fields.Status === 'Active');
      if (!admins.length) warn('No Active users — nobody can sign in yet');
    }
  } catch (e) {
    bad(`Identity base unreadable — ${e.message}`);
  }

  console.log('');
  if (failures) {
    console.log(`\x1b[31m\x1b[1m${failures} problem(s) found.\x1b[0m\n`);
    process.exit(1);
  }
  console.log('\x1b[32m\x1b[1mConfiguration looks good.\x1b[0m\n');
})().catch((e) => { console.error('\x1b[31mCheck crashed:\x1b[0m', e.message); process.exit(1); });
