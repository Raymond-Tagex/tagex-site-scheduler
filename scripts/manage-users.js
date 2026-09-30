#!/usr/bin/env node
// List users, disable them, reset a password, or permanently delete an account.
//
//   node scripts/manage-users.js              list everyone
//   node scripts/manage-users.js disable  <email>
//   node scripts/manage-users.js enable   <email>
//   node scripts/manage-users.js reset    <email>   set a new temporary password
//   node scripts/manage-users.js delete   <email>   permanently remove the record
//
// DISABLE, DON'T DELETE — for anyone who has actually used the system.
//
// Disabling revokes every live session immediately and blocks sign-in, so it stops access just
// as completely as deletion. What it keeps is the ability to answer "who issued delivery note
// DN-20260830-004?" a year from now. Deleting the record breaks the Audit Log's link to that
// person; the entries survive because User Email is stored on each one, but the account they
// point at is gone.
//
// Delete is for mistakes — a typo'd address, an account created twice — not for leavers.

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

function ask(q) {
  return new Promise((resolve) => {
    const i = readline.createInterface({ input: process.stdin, output: process.stdout });
    i.question(q, (a) => { i.close(); resolve(a.trim()); });
  });
}

const esc = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

(async () => {
  loadEnvLocal();
  if (!process.env.AIRTABLE_PAT) { console.error('\n\x1b[31mAIRTABLE_PAT is not set.\x1b[0m\n'); process.exit(1); }

  const at = require(path.join(ROOT, 'api', '_lib', 'airtable.js'));
  const S = require(path.join(ROOT, 'api', '_lib', 'session.js'));
  const G = require(path.join(ROOT, 'api', '_lib', 'guards.js'));
  const IAM = T.BASES.IAM;
  const USERS = T.TABLES.users.IAM;

  const [, , cmd, emailArg] = process.argv;
  const action = (cmd || 'list').toLowerCase();

  // ── list ────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const rows = await at.list(IAM, USERS, {
      fields: ['Email', 'Full Name', 'Status', 'Access Level', 'Last Login At', 'Integrity Check',
        'Must Change Password'],
      sort: [{ field: 'Email', direction: 'asc' }],
    });
    const levels = await at.list(IAM, T.TABLES.access_levels.IAM, { fields: ['Role Name'] });
    const roleName = (r) => {
      const l = r.fields['Access Level'];
      if (!Array.isArray(l) || !l.length) return '—';
      const m = levels.find((x) => x.id === l[0]);
      return m ? m.fields['Role Name'] : '—';
    };

    console.log(`\n\x1b[1m  ${rows.length} user(s)\x1b[0m\n`);
    for (const r of rows) {
      const f = r.fields;
      const colour = f.Status === 'Active' ? 32 : f.Status === 'Invited' ? 33 : 31;
      console.log(`  \x1b[${colour}m${String(f.Status || '?').padEnd(10)}\x1b[0m ${String(f.Email).padEnd(34)} `
        + `${String(f['Full Name'] || '').padEnd(20)} ${roleName(r)}`);
      const notes = [];
      if (f['Must Change Password']) notes.push('must change password');
      if (!f['Last Login At']) notes.push('never signed in');
      if (f['Integrity Check'] && f['Integrity Check'] !== 'OK') notes.push(f['Integrity Check']);
      if (notes.length) console.log(`             \x1b[90m${notes.join(' · ')}\x1b[0m`);
    }
    console.log('\n  disable <email> · enable <email> · reset <email> · delete <email>\n');
    return;
  }

  if (!emailArg) { console.error(`\n\x1b[31mUsage: node scripts/manage-users.js ${action} <email>\x1b[0m\n`); process.exit(1); }
  const email = emailArg.toLowerCase();

  const user = await at.findOne(IAM, USERS, `LOWER({Email}) = "${esc(email)}"`);
  if (!user) { console.error(`\n\x1b[31mNo account with that email.\x1b[0m\n`); process.exit(1); }

  const label = `${user.fields['Full Name'] || '(no name)'} <${user.fields.Email}>`;

  // ── disable ─────────────────────────────────────────────────────────────
  if (action === 'disable') {
    if (await G.isAdminUserRecord(user)) {
      const admins = await G.countActiveAdmins();
      if (admins <= 1) {
        console.error('\n\x1b[31mThis is the last active administrator.\x1b[0m');
        console.error('Disabling it would lock everyone out of user management. Promote someone else first.\n');
        process.exit(1);
      }
    }
    const yes = await ask(`\n  Disable ${label}? They will be signed out immediately. [y/N] `);
    if (yes.toLowerCase() !== 'y') { console.log('  Cancelled.\n'); return; }

    await at.update(IAM, USERS, user.id, { Status: 'Disabled', 'Deactivated Date': new Date().toISOString() });
    const revoked = await S.revokeAllForUser(email, 'manage-users script');
    console.log(`\n\x1b[32m  Disabled.\x1b[0m ${revoked} live session(s) revoked.`);
    console.log('  Their history and audit trail are intact. Re-enable any time with "enable".\n');
    return;
  }

  // ── enable ──────────────────────────────────────────────────────────────
  if (action === 'enable') {
    await at.update(IAM, USERS, user.id, {
      Status: 'Active', 'Deactivated Date': null, 'Failed Login Attempts': 0, 'Locked Until': null,
    });
    S.invalidateUser(email);
    console.log(`\n\x1b[32m  ${label} re-enabled.\x1b[0m`);
    console.log('  Their existing password still works. Use "reset" to issue a new one.\n');
    return;
  }

  // ── reset password ──────────────────────────────────────────────────────
  if (action === 'reset') {
    const crypto = require('crypto');
    const words = ['Amber', 'Cable', 'Panel', 'Solar', 'Bright', 'Copper', 'Anchor', 'Summit'];
    const pick = () => words[crypto.randomInt(words.length)];
    const typed = await ask('\n  New temporary password (Enter to generate one): ');
    const pw = typed || `${pick()}-${pick()}${crypto.randomInt(1000, 10000)}!`;
    const complaints = C.passwordComplaints(pw);
    if (complaints.length) { console.error(`\n\x1b[31mPassword ${complaints.join(', ')}.\x1b[0m\n`); process.exit(1); }

    const hash = await C.hashPassword(pw);
    const patch = {
      'Password Hash': hash,
      'Password Set At': new Date().toISOString(),
      'Must Change Password': true,
      'Failed Login Attempts': 0,
      'Locked Until': null,
    };
    // An "Invited" account has no password and login refuses that status outright. Giving it a
    // password without activating it would leave the person locked out with working credentials
    // — so activation is part of the reset, and the unused invite token is discarded.
    if (user.fields.Status === 'Invited') {
      patch.Status = 'Active';
      patch['Invite Token Hash'] = '';
      patch['Invite Expires'] = null;
      console.log('  (account was Invited — activating it, and voiding the unused invite link)');
    }
    await at.update(IAM, USERS, user.id, patch);
    const revoked = await S.revokeAllForUser(email, 'manage-users script: password reset');
    S.invalidateUser(email);

    console.log(`\n\x1b[32m  Password reset for ${label}.\x1b[0m ${revoked} session(s) revoked.`);
    console.log('');
    console.log(`    Email     ${email}`);
    console.log(`    Password  ${pw}`);
    console.log('');
    console.log('  They must choose their own password at next sign-in. Hand this over directly.\n');
    return;
  }

  // ── delete ──────────────────────────────────────────────────────────────
  if (action === 'delete') {
    if (await G.isAdminUserRecord(user)) {
      const admins = await G.countActiveAdmins();
      if (admins <= 1) {
        console.error('\n\x1b[31mThis is the last active administrator and cannot be deleted.\x1b[0m\n');
        process.exit(1);
      }
    }

    console.log(`\n  \x1b[33mAbout to permanently delete:\x1b[0m ${label}`);
    console.log(`  Status: ${user.fields.Status} · Last sign-in: ${user.fields['Last Login At'] || 'never'}`);
    console.log('');
    if (user.fields['Last Login At']) {
      console.log('  \x1b[33mThis account has been used.\x1b[0m Audit entries will keep their email address,');
      console.log('  but the link back to this record will be broken. "disable" is almost always');
      console.log('  the better choice — it blocks access just as completely and keeps the trail.');
      console.log('');
    }
    const typed = await ask(`  Type the email to confirm deletion: `);
    if (typed.toLowerCase() !== email) { console.log('\n  Did not match. Cancelled.\n'); return; }

    const revoked = await S.revokeAllForUser(email, 'manage-users script: deletion');
    await at.destroy(IAM, USERS, user.id);
    S.invalidateUser(email);
    console.log(`\n\x1b[32m  Deleted.\x1b[0m ${revoked} session(s) revoked first.`);
    console.log('  That email address is free to use again.\n');
    return;
  }

  console.error(`\n\x1b[31mUnknown command "${action}".\x1b[0m Use list, disable, enable, reset or delete.\n`);
  process.exit(1);
})().catch((e) => { console.error('\n\x1b[31mFailed:\x1b[0m', e.message, '\n'); process.exit(1); });
