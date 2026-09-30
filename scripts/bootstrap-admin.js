#!/usr/bin/env node
// Create the FIRST administrator account.
//
//   node scripts/bootstrap-admin.js
//
// WHY THIS EXISTS. /api/auth/invite requires an Admin session, and there is no Admin yet —
// a chicken-and-egg the UI cannot break. This script breaks it once, from a machine that
// already holds the service PAT, and then is never needed again: every subsequent user is
// invited through the Admin panel.
//
// The password is typed here and hashed HERE. Only the scrypt hash is sent to Airtable.
// The plaintext is never written to disk, never logged, and never leaves this process.
//
// The account is created with MFA OFF. That is deliberate and safe: api/at.js refuses every
// data request from an admin session until MFA is enrolled, so the first sign-in walks
// straight into the enrolment screen and nothing else is reachable until it is done.
//
// Refuses to run if an Active admin already exists, unless --force is passed.

'use strict';

const path = require('path');
const readline = require('readline');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const T = require(path.join(ROOT, 'api', '_lib', 'tables.js'));
const C = require(path.join(ROOT, 'api', '_lib', 'crypto.js'));

function loadEnvLocal() {
  const p = path.join(ROOT, '.env.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i === -1) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}

const rl = () => readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => {
    const i = rl();
    i.question(question, (a) => { i.close(); resolve(a.trim()); });
  });
}

/**
 * Prompt without echoing. The password is never displayed and never enters shell history.
 *
 * Uses readline's own _writeToOutput hook rather than a raw stdin listener. The listener
 * approach misbehaves on Windows consoles — double echo and stray prompt redraws — and this
 * machine runs PowerShell with PSReadLine disabled.
 */
function askHidden(question) {
  return new Promise((resolve) => {
    // Not a terminal (piped input, CI): nothing to hide, just read the line.
    if (!process.stdin.isTTY) {
      const i = rl();
      i.question(question, (a) => { i.close(); resolve(a); });
      return;
    }

    const i = readline.createInterface({
      input: process.stdin, output: process.stdout, terminal: true,
    });
    const LF = String.fromCharCode(10);
    const CR = String.fromCharCode(13);
    let muted = false;
    i._writeToOutput = function (chunk) {
      if (!muted) { i.output.write(chunk); return; }
      // Swallow typed characters; let newlines through so the cursor still advances.
      if (chunk === LF || chunk === CR || chunk === CR + LF) i.output.write(chunk);
    };
    i.question(question, (a) => {
      muted = false;
      i.close();
      process.stdout.write(LF);
      resolve(a);
    });
    muted = true; // question() has already written the prompt by this point
  });
}

(async () => {
  loadEnvLocal();

  console.log('\n\x1b[1mTAGEX — bootstrap the first administrator\x1b[0m\n');

  if (!process.env.AIRTABLE_PAT) { console.error('\x1b[31mAIRTABLE_PAT is not set.\x1b[0m Put it in .env.local or export it, then retry.\n'); process.exit(1); }

  const at = require(path.join(ROOT, 'api', '_lib', 'airtable.js'));
  const IAM = T.BASES.IAM;
  const USERS = T.TABLES.users.IAM;
  const LEVELS = T.TABLES.access_levels.IAM;
  const force = process.argv.includes('--force');

  // ── refuse if an admin already exists ───────────────────────────────────
  let adminRoleId = null;
  try {
    const roles = await at.list(IAM, LEVELS, { fields: ['Role Name', 'Can Manage Users', 'Active'] });
    const adminRole = roles.find((r) => r.fields['Can Manage Users'] === true && r.fields.Active !== false);
    if (!adminRole) { console.error('\x1b[31mNo admin-capable Access Level found.\x1b[0m Seed the roles first.\n'); process.exit(1); }
    adminRoleId = adminRole.id;
    console.log(`  Admin role: "${adminRole.fields['Role Name']}"`);

    const users = await at.list(IAM, USERS, { fields: ['Email', 'Status'] });
    const existing = [];
    for (const u of users) {
      const full = await at.get(IAM, USERS, u.id);
      const links = full.fields['Access Level'];
      if (Array.isArray(links) && links.includes(adminRoleId) && full.fields.Status === 'Active') {
        existing.push(full.fields.Email);
      }
    }
    if (existing.length && !force) {
      console.error(`\n\x1b[31mAn active administrator already exists:\x1b[0m ${existing.join(', ')}`);
      console.error('Invite further users from the Admin panel instead.');
      console.error('If you are certain you need another bootstrap account, re-run with --force.\n');
      process.exit(1);
    }
    if (existing.length) console.log(`  \x1b[33m! --force: ${existing.length} admin(s) already exist\x1b[0m`);
  } catch (e) {
    console.error('\x1b[31mCould not read the identity base:\x1b[0m', e.message);
    console.error('Check that AIRTABLE_PAT includes ' + IAM + ' with schema.bases:read.\n');
    process.exit(1);
  }

  // ── collect details ─────────────────────────────────────────────────────
  console.log('');
  const email = (await ask('  Email:      ')).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { console.error('\n\x1b[31mThat is not a valid email address.\x1b[0m\n'); process.exit(1); }

  const dupe = await at.findOne(IAM, USERS, `LOWER({Email}) = "${email.replace(/"/g, '\\"')}"`);
  if (dupe) { console.error(`\n\x1b[31mA user with that email already exists.\x1b[0m\n`); process.exit(1); }

  const fullName = await ask('  Full name:  ');
  if (!fullName) { console.error('\n\x1b[31mA full name is required.\x1b[0m\n'); process.exit(1); }
  const jobTitle = await ask('  Job title:  (optional) ');

  console.log('\n  Password: minimum 12 characters, with an uppercase letter, a lowercase letter and a digit.');
  console.log('  It is hashed on this machine. Only the hash is stored.\n');

  const password = await askHidden('  Password:         ');
  const complaints = C.passwordComplaints(password);
  if (complaints.length) { console.error(`\n\x1b[31mPassword ${complaints.join(', ')}.\x1b[0m\n`); process.exit(1); }
  const again = await askHidden('  Confirm password: ');
  if (password !== again) { console.error('\n\x1b[31mThe two passwords do not match.\x1b[0m\n'); process.exit(1); }

  // ── create ──────────────────────────────────────────────────────────────
  process.stdout.write('\n  Hashing… ');
  const hash = await C.hashPassword(password);
  console.log('done');

  process.stdout.write('  Creating account… ');
  const created = await at.create(IAM, USERS, [{
    Email: email,
    'Full Name': fullName,
    'Job Title / Department': jobTitle || '',
    'Access Level': [adminRoleId],
    'Password Hash': hash,
    'Password Set At': new Date().toISOString(),
    'Must Change Password': false,
    Status: 'Active',
    'Failed Login Attempts': 0,
    'Record Scope': 'All Records',
    'Can View Restricted Documents': true,
    'MFA Enabled': false,
    'Created By': 'bootstrap-admin script',
    'Created Date': new Date().toISOString(),
    'Assigned Clients': '[]',
    'Assigned Sites': '[]',
    'Assigned Systems': '[]',
    'Permission Overrides': '{}',
    Notes: 'First administrator, created by scripts/bootstrap-admin.js.',
  }]);
  console.log('done');

  const rec = created[0];
  const check = await at.get(IAM, USERS, rec.id);
  const integrity = check.fields['Integrity Check'];

  console.log('\n\x1b[32m\x1b[1m  Administrator created.\x1b[0m');
  console.log(`  ${email} — record ${rec.id}`);
  console.log(`  Integrity Check: ${integrity}`);
  if (integrity && integrity.includes('MFA')) {
    console.log('  \x1b[33m(expected — it clears the moment you enrol MFA at first sign-in)\x1b[0m');
  }

  console.log('\n\x1b[1m  Next:\x1b[0m');
  console.log('   1. Open the app and sign in with this email and password.');
  console.log('   2. You will be sent straight to two-factor enrolment. Nothing else is');
  console.log('      reachable until it is finished — that is enforced server-side.');
  console.log('   3. Scan or type the key into your authenticator app, enter the code.');
  console.log('   4. Invite everyone else from the Admin panel.\n');

  // Belt and braces: drop the plaintext reference before exit.
  process.exit(0);
})().catch((e) => {
  console.error('\n\x1b[31mFailed:\x1b[0m', e.message, '\n');
  process.exit(1);
});
