#!/usr/bin/env node
// Several Access Levels per user (permissions.combineRoles, session.roleForUser): the merge grants
// what any role grants and never more. Offline; Airtable is stubbed.
//
//   node test/verify-roles.js

'use strict';

const path = require('path');
const api = (f) => path.join(__dirname, '..', 'api', f);

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) pass++; else fail++;
  console.log((ok ? '  \x1b[32mpass\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m  ') + name + (ok || extra === undefined ? '' : '\n          ' + extra));
};

// Airtable stub: roles by record id, and nothing else.
const ROLES = {};
const stub = (file, exports) => {
  const id = require.resolve(api(file));
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
stub('_lib/airtable.js', {
  async get(base, table, id) {
    if (!ROLES[id]) { const e = new Error('NOT_FOUND'); e.status = 404; throw e; }
    return { id, fields: JSON.parse(JSON.stringify(ROLES[id])) };
  },
});
const P = require(api('_lib/permissions.js'));
const S = require(api('_lib/session.js'));

const ops = (v, c, e, d, x) => ({ view: v, create: c, edit: e, delete: d, export: x });
const OPS_MGR = { id: 'recOPS', 'Role Name': 'Operations Manager', Active: true, 'Default Record Scope': 'Assigned Only',
  Permissions: JSON.stringify({
    job_cards: { ...ops(true, true, true, false, true), fields: { deny_read: ['Budget', 'Actual Cost'], deny_write: ['Budget'] } },
    documents: { ...ops(true, true, true, false, true), sensitivity_max: 'Internal' },
    tickets: { ...ops(true, false, false, false, false), scope: 'own' },
  }) };
const EXPENSES = { id: 'recEXP', 'Role Name': 'Expense Verifier', Active: true, 'Approval Limit (R)': 5000,
  Permissions: JSON.stringify({
    expenses: ops(true, true, true, false, true),
    expense_approval: ops(true, false, true, false, true),
    job_cards: { ...ops(true, false, false, false, false), fields: { deny_read: ['Budget'] } },
    documents: { ...ops(true, false, false, false, false), sensitivity_max: 'Confidential' },
    tickets: { ...ops(true, false, false, false, false), scope: 'own' },
  }) };
const ADMIN = { id: 'recADM', 'Role Name': 'Admin / Director', Active: true, 'Can Manage Users': true, 'Default Record Scope': 'All Records',
  Permissions: JSON.stringify({ users: ops(true, true, true, false, false) }) };
const PERSONAL = (flag) => ({ id: 'recPER' + flag, 'Role Name': 'Personal ' + flag, Active: true,
  Permissions: JSON.stringify({ restricted_personal: { ...ops(true, false, false, false, false), require_user_flag: flag, sensitivity_max: 'Restricted' } }) });

(async () => {
  console.log('\nOne role');
  const one = P.combineRoles([OPS_MGR]);
  t('passes through unchanged', one.Permissions === OPS_MGR.Permissions && one['Role Name'] === 'Operations Manager' && one.ids.join() === 'recOPS');
  t('no roles is no role', P.combineRoles([]) === null);

  console.log('\nTwo roles');
  const both = P.combineRoles([OPS_MGR, EXPENSES]);
  const perms = P.effectivePermissions(both.Permissions, null);
  t('named for both', both['Role Name'] === 'Operations Manager + Expense Verifier' && both.ids.join() === 'recOPS,recEXP');
  t('each role keeps its own modules', P.can(perms, 'job_cards', 'edit').ok && P.can(perms, 'expense_approval', 'edit').ok);
  t('an operation either role allows is allowed', P.can(perms, 'documents', 'create').ok && P.can(perms, 'expenses', 'create').ok);
  t('a module neither role holds stays shut', !P.can(perms, 'users', 'view').ok && !P.can(perms, 'job_cards', 'delete').ok);
  t('a field both readers hide stays hidden', perms.job_cards.fields.deny_read.includes('Budget'));
  t('a field only one reader hides is readable', !perms.job_cards.fields.deny_read.includes('Actual Cost'));
  t('write denies come only from roles that write', perms.job_cards.fields.deny_write.join() === 'Budget');
  t('the widest sensitivity cap', perms.documents.sensitivity_max === 'Confidential');
  t('"own" only when every role says so', perms.tickets.scope === 'own');
  t('the widest record scope and the highest approval limit', both['Default Record Scope'] === 'Assigned Only' && both['Approval Limit (R)'] === 5000);
  t('no admin rights unless a role has them', both['Can Manage Users'] === false);
  const withAdmin = P.combineRoles([EXPENSES, ADMIN]);
  t('admin rights from the admin role', withAdmin['Can Manage Users'] === true && withAdmin['Default Record Scope'] === 'All Records');
  const ownAndAll = P.effectivePermissions(P.combineRoles([OPS_MGR, { ...EXPENSES, Permissions: JSON.stringify({ tickets: ops(true, false, false, false, false) }) }]).Permissions, null);
  t('a role that sees all tickets lifts "own"', ownAndAll.tickets.scope === undefined);
  const personal = P.effectivePermissions(P.combineRoles([PERSONAL(true), PERSONAL(false)]).Permissions, null);
  t('the restricted-personal double gate stays on if any role asks for it', personal.restricted_personal.require_user_flag === true);
  const broken = P.combineRoles([OPS_MGR, { ...EXPENSES, Permissions: '{not json' }]);
  t('an unparseable role adds nothing', P.effectivePermissions(broken.Permissions, null).expenses === undefined
    && P.can(P.effectivePermissions(broken.Permissions, null), 'job_cards', 'edit').ok);

  console.log('\nO&M');
  // Admin MFA is also held by whoever edits supplier quotes (session.mfaRole), through any role.
  const QUOTES = { id: 'recQUO', 'Role Name': 'Stock Controller', Active: true,
    Permissions: JSON.stringify({ supplier_quotes: ops(true, true, true, false, false) }) };
  t('MFA is required when any role needs it', S.mfaRole(P.combineRoles([EXPENSES, QUOTES])) === true
    && S.mfaRole(P.combineRoles([OPS_MGR, EXPENSES])) === false);

  console.log('\nInactive roles');
  const halfOff = P.combineRoles([OPS_MGR, { ...EXPENSES, Active: false }]);
  t('an inactive role is left out', halfOff.Active === true && halfOff.Permissions === OPS_MGR.Permissions && halfOff.ids.join() === 'recOPS');
  t('all inactive is refused as before', P.combineRoles([{ ...OPS_MGR, Active: false }, { ...EXPENSES, Active: false }]).Active === false);

  console.log('\nSign-in');
  Object.assign(ROLES, { recOPS: OPS_MGR, recEXP: EXPENSES, recADM: ADMIN });
  const r2 = await S.roleForUser({ 'Access Level': ['recOPS', 'recEXP'] });
  t('a user with two roles signs in with both', r2 && r2['Role Name'] === 'Operations Manager + Expense Verifier');
  t('a user with one role is unchanged', (await S.roleForUser({ 'Access Level': ['recADM'] }))['Can Manage Users'] === true);
  t('no role, or more than five, is refused', (await S.roleForUser({ 'Access Level': [] })) === null
    && (await S.roleForUser({ 'Access Level': ['recOPS', 'recEXP', 'recADM', 'recOPS', 'recEXP', 'recADM'] })) === null);

  console.log('\nAdmin panel guard');
  const G = require(api('_lib/guards.js'));
  const g0 = await G.guardUserUpdate({ actorEmail: 'a@x', targetRecordId: 'recNOBODY0000001', fields: { 'Access Level': [] } });
  t('a user cannot be left with no role', g0.ok === false && g0.reason === 'bad_roles');
  const g6 = await G.guardUserUpdate({ actorEmail: 'a@x', targetRecordId: 'recNOBODY0000001', fields: { 'Access Level': ['a', 'b', 'c', 'd', 'e', 'f'] } });
  t('nor given more than five', g6.ok === false && g6.reason === 'bad_roles');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
