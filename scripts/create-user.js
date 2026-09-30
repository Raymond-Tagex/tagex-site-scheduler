#!/usr/bin/env node
// Create a user with a TEMPORARY password, for people who cannot receive an invite email.
//
//   node scripts/create-user.js
//
// WHEN TO USE THIS. Warehouse staff often have no work email address, so the invite-link flow
// has nothing to send to. Here an administrator sets a starting password and hands it over in
// person.
//
// THE ACCOUNT IS CREATED WITH "Must Change Password" SET. That matters: api/at.js refuses
// every data request until the user chooses their own password, so the temporary one you type
// here stops working the moment they sign in. After that, nobody but them knows it — which is
// what keeps the audit trail meaningful, since an action logged against their name could not
// have been performed by an administrator holding their password.
//
// If they CAN receive email, prefer:  node scripts/invite-user.js
// That way no one but the user ever knows the password, at any point.

'use strict';

const path = require('path');
const readline = require('readline');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const T = require(path.join(ROOT, 'api', '_lib', 'tables.js'));
const C = require(path.join(ROOT, 'api', '_lib', 'crypto.js'));

function loadEnvLocal() {
  const p = path.join(ROOT, '.env.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i === -1) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}

function ask(question) {
  return new Promise((resolve) => {
    const i = readline.createInterface({ input: process.stdin, output: process.stdout });
    i.question(question, (a) => { i.close(); resolve(a.trim()); });
  });
}

/** Readable temporary password: two words, digits, a symbol. Meets the 12-char policy. */
function generateTempPassword() {
  const words = ['Amber', 'Cable', 'Panel', 'Solar', 'Bright', 'Copper', 'Anchor', 'Summit',
                 'Harbour', 'Falcon', 'Granite', 'Meadow', 'Compass', 'Lantern'];
  const pick = () => words[crypto.randomInt(words.length)];
  const digits = String(crypto.randomInt(1000, 10000));
  const sym = '!@#$%&*'[crypto.randomInt(7)];
  return `${pick()}-${pick()}${digits}${sym}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

(async () => {
  loadEnvLocal();
  console.log('\n\x1b[1mTAGEX — create a user with a temporary password\x1b[0m\n');

  if (!process.env.AIRTABLE_PAT) { console.error('\x1b[31mAIRTABLE_PAT is not set.\x1b[0m\n'); process.exit(1); }

  const at = require(path.join(ROOT, 'api', '_lib', 'airtable.js'));
  const IAM = T.BASES.IAM;
  const USERS = T.TABLES.users.IAM;
  const LEVELS = T.TABLES.access_levels.IAM;

  const roles = (await at.list(IAM, LEVELS, { fields: ['Role Name', 'Active', 'Default Record Scope'] }))
    .filter((r) => r.fields.Active !== false);

  console.log('  Access levels:');
  roles.forEach((r, i) => console.log(`    ${i + 1}. ${r.fields['Role Name']}`));
  console.log('');

  const email = (await ask('  Email:      ')).toLowerCase();
  if (!EMAIL_RE.test(email)) { console.error('\n\x1b[31mNot a valid email address.\x1b[0m'); console.error('It is the sign-in name, so it must be unique — a real address is not required.\n'); process.exit(1); }

  const existing = await at.findOne(IAM, USERS, `LOWER({Email}) = "${email.replace(/"/g, '\\"')}"`);
  if (existing) {
    console.error(`\n\x1b[31mThat email already has an account\x1b[0m (status: ${existing.fields.Status}).`);
    console.error('To give them a new password, use: node scripts/reset-user-password.js\n');
    process.exit(1);
  }

  const fullName = await ask('  Full name:  ');
  if (!fullName) { console.error('\n\x1b[31mA full name is required.\x1b[0m\n'); process.exit(1); }

  const pick = await ask(`  Access level (1-${roles.length}): `);
  const role = roles[Number(pick) - 1];
  if (!role) { console.error('\n\x1b[31mNo such access level.\x1b[0m\n'); process.exit(1); }

  const jobTitle = await ask('  Job title:  (optional) ');

  console.log('');
  const typed = await ask('  Temporary password (Enter to generate one): ');
  const tempPassword = typed || generateTempPassword();
  const complaints = C.passwordComplaints(tempPassword);
  if (complaints.length) {
    console.error(`\n\x1b[31mPassword ${complaints.join(', ')}.\x1b[0m\n`);
    process.exit(1);
  }

  process.stdout.write('\n  Hashing… ');
  const hash = await C.hashPassword(tempPassword);
  console.log('done');

  process.stdout.write('  Creating account… ');
  const created = await at.create(IAM, USERS, [{
    Email: email,
    'Full Name': fullName,
    'Job Title / Department': jobTitle || '',
    'Access Level': [role.id],
    'Password Hash': hash,
    'Password Set At': new Date().toISOString(),
    'Must Change Password': true,          // the whole point — they must replace it at first sign-in
    Status: 'Active',
    'Failed Login Attempts': 0,
    'Record Scope': role.fields['Default Record Scope'] || 'All Records',
    'Can View Restricted Documents': false,
    'MFA Enabled': false,
    'Created By': 'create-user script',
    'Created Date': new Date().toISOString(),
    'Assigned Clients': '[]',
    'Assigned Sites': '[]',
    'Assigned Systems': '[]',
    'Permission Overrides': '{}',
    Notes: 'Created with a temporary password. Must change it at first sign-in.',
  }]);
  console.log('done');

  const origin = (process.env.APP_ORIGIN || 'http://localhost:3000').replace(/\/+$/, '');

  console.log('');
  console.log(`\x1b[32m\x1b[1m  ${fullName} created as ${role.fields['Role Name']}\x1b[0m`);
  console.log(`  record ${created[0].id}`);
  console.log('');
  console.log('  \x1b[1mHand these over:\x1b[0m');
  console.log('');
  console.log(`    Address   ${origin}`);
  console.log(`    Email     ${email}`);
  console.log(`    Password  ${tempPassword}`);
  console.log('');
  console.log('  They will be asked to choose their own password the first time they sign in,');
  console.log('  and cannot reach any data until they do. The temporary one stops working then.');
  console.log('');
  console.log('  \x1b[33mGive it to them directly — in person, or by phone. Not on a shared');
  console.log('  channel, and not in an email you keep.\x1b[0m');
  console.log('');
})().catch((e) => { console.error('\n\x1b[31mFailed:\x1b[0m', e.message, '\n'); process.exit(1); });
