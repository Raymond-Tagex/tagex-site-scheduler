#!/usr/bin/env node
// Part C verification — the security primitives and the proxy's request-shape guards.
//
//   node test/verify-part-c.js
//
// Covers what can be proven without a live service PAT: password hashing, JWT forgery
// resistance, TOTP, one-time tokens, rate limiting, and the pre-auth raw-id rejection.
// The end-to-end HTTP assertions (real cookies, real 403s, real audit rows) are Part D.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const path = require('path');
const fs = require('fs');
const L = (m) => require(path.join(__dirname, '..', 'api', m));
const C = L('_lib/crypto.js');
const T = L('_lib/tables.js');
const H = L('_lib/http.js');

let pass = 0, fail = 0;
const failures = [];

function t(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  if (ok) pass++; else { fail++; failures.push(`${label}\n      expected ${e}\n      actual   ${a}`); }
  console.log(`  ${ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}`);
  return ok;
}

(async () => {

console.log('\n\x1b[1mPASSWORD HASHING (scrypt)\x1b[0m\n');

const pw = 'Warehouse!2026rocks';
const hash = await C.hashPassword(pw);
t('hash format is scrypt$N$r$p$salt$key', hash.split('$').length === 6 && hash.startsWith('scrypt$'), true);
t('correct password verifies', await C.verifyPassword(pw, hash), true);
t('wrong password does not verify', await C.verifyPassword('Warehouse!2026rockt', hash), false);
t('empty password does not verify', await C.verifyPassword('', hash), false);
t('same password hashes differently (per-user salt)', (await C.hashPassword(pw)) !== hash, true);
t('plaintext never appears in the stored hash', hash.includes(pw), false);
t('corrupt stored hash denies rather than throwing', await C.verifyPassword(pw, 'garbage'), false);
t('null stored hash denies rather than throwing', await C.verifyPassword(pw, null), false);
t('scrypt$ prefix with wrong part count denies', await C.verifyPassword(pw, 'scrypt$1$2$3'), false);

console.log('\n\x1b[1mPASSWORD POLICY (min 12 chars)\x1b[0m\n');
t('11 chars rejected', C.passwordComplaints('Abcdefgh12!').length > 0, true);
t('12 chars with mixed case + digit accepted', C.passwordComplaints('Abcdefgh1234'), []);
t('no uppercase rejected', C.passwordComplaints('abcdefgh1234').length > 0, true);
t('no digit rejected', C.passwordComplaints('Abcdefghijkl').length > 0, true);

console.log('\n\x1b[1mJWT — signature, algorithm, expiry\x1b[0m\n');

const token = C.signJwt({ sub: 'byron@tagexenergy.co.za', sid: 'abc123' }, 3600);
const good = C.verifyJwt(token);
t('valid token verifies', good.ok, true);
t('payload survives round trip', good.ok && good.payload.sub, 'byron@tagexenergy.co.za');

const [h, b, s] = token.split('.');
t('tampered payload is rejected',
  C.verifyJwt(`${h}.${C.b64u(JSON.stringify({ sub: 'admin@tagexenergy.co.za', sid: 'abc123', exp: 9e9 }))}.${s}`).reason,
  'bad_signature');
t('tampered signature is rejected', C.verifyJwt(`${h}.${b}.${'x'.repeat(s.length)}`).reason, 'bad_signature');
t('unsigned token (empty sig) is rejected', C.verifyJwt(`${h}.${b}.`).reason, 'bad_signature');

// alg:none — the classic JWT bypass.
const noneHeader = C.b64u(JSON.stringify({ alg: 'none', typ: 'JWT' }));
t('alg:none is rejected', C.verifyJwt(`${noneHeader}.${b}.`).reason, 'bad_alg');
const hs512 = C.b64u(JSON.stringify({ alg: 'HS512', typ: 'JWT' }));
t('algorithm swap (HS512) is rejected', C.verifyJwt(`${hs512}.${b}.${s}`).reason, 'bad_alg');

t('expired token is rejected', C.verifyJwt(C.signJwt({ sub: 'x' }, -1)).reason, 'expired');
t('garbage is rejected', C.verifyJwt('not.a.jwt').reason, 'malformed');
t('empty string is rejected', C.verifyJwt('').reason, 'malformed');
t('token signed with another secret is rejected', (() => {
  const real = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'a-completely-different-secret-32-chars!!';
  const foreign = C.signJwt({ sub: 'attacker' }, 3600);
  process.env.JWT_SECRET = real;
  return C.verifyJwt(foreign).reason;
})(), 'bad_signature');

console.log('\n\x1b[1mONE-TIME TOKENS (invite / reset)\x1b[0m\n');
const inv = C.newToken();
const invHash = C.hashToken(inv);
t('token is not recoverable from its hash', invHash.includes(inv), false);
t('hash is stable', C.hashToken(inv), invHash);
t('correct token matches', C.tokenMatches(inv, invHash), true);
t('wrong token does not match', C.tokenMatches(C.newToken(), invHash), false);
t('empty stored hash never matches', C.tokenMatches(inv, ''), false);
t('two tokens differ', C.newToken() === C.newToken(), false);

console.log('\n\x1b[1mTOTP (RFC 6238)\x1b[0m\n');
const secret = C.newMfaSecret();
const step = Math.floor(Date.now() / 1000 / 30);
t('current code verifies', C.verifyTotp(secret, C.totpAt(secret, step)), true);
t('previous step verifies (clock drift window)', C.verifyTotp(secret, C.totpAt(secret, step - 1)), true);
t('code 5 steps ago is rejected', C.verifyTotp(secret, C.totpAt(secret, step - 5)), false);
t('wrong code is rejected', C.verifyTotp(secret, '000000') && C.totpAt(secret, step) !== '000000' ? 'accepted' : 'rejected', 'rejected');
t('non-numeric code is rejected', C.verifyTotp(secret, 'abcdef'), false);
t('short code is rejected', C.verifyTotp(secret, '12345'), false);
t('otpauth URI is well formed', C.totpUri(secret, 'a@b.co').startsWith('otpauth://totp/'), true);
t("another account's secret does not verify", C.verifyTotp(C.newMfaSecret(), C.totpAt(secret, step)), false);

console.log('\n\x1b[1mSTEP 0 — RAW IDENTIFIER REJECTION (pre-auth)\x1b[0m\n');
t('raw tbl… as the table symbol', !!T.findRawId({ base: 'CI', table: 'tblpdJP1RYL9WHSMq' }), true);
t('raw app… hidden in a filter', !!T.findRawId({ params: { filterByFormula: 'appfzAX5YHqg4UXCl' } }), true);
t('raw fld… used as an object key', !!T.findRawId({ fields: { fldFel5RcuPm63ofy: 'x' } }), true);
t('raw id nested three levels deep', !!T.findRawId({ a: { b: { c: ['tblCnFI2EDwBgEKmi'] } } }), true);
t('raw id inside a sort clause', !!T.findRawId({ params: { sort: [{ field: 'fldEolwFzfI9oM5T1' }] } }), true);
t('legitimate rec… id passes', T.findRawId({ recordId: 'recQVPCk3J8F65Ngz' }), null);
t('ordinary payload passes', T.findRawId({ base: 'CI', table: 'delivery_notes', fields: { 'DN Number': 'DN-20260827-001' } }), null);

console.log('\n\x1b[1mSYMBOL RESOLUTION\x1b[0m\n');
t('restricted_personal without a sub symbol is refused', T.resolve('CI', 'restricted_personal').reason, 'sub_symbol_required');
t('restricted_personal with a valid sub resolves', T.resolve('CI', 'restricted_personal', 'financial_vetting').tableId, 'tblVUssahq7fBFOQh');
t('unknown sub symbol is refused', T.resolve('CI', 'restricted_personal', 'nope').reason, 'unknown_symbol');
t('FICA is not reachable in the O&M base', T.resolve('OM', 'restricted_personal', 'financial_vetting').reason, 'wrong_base');
t('identity tables are not reachable from an operational base', T.resolve('CI', 'users').reason, 'wrong_base');
// This used to name 'tickets'. Tickets now exist, so the example had to move to a module that
// is still only a line in the permission matrix — otherwise the assertion quietly stopped
// testing the not-provisioned path and started testing the wrong-base one.
t('unprovisioned module reports why', T.resolve('OM', 'warranty_register').reason, 'module_not_provisioned');
t('...and so does another one', T.resolve('CI', 'support_requests').reason, 'module_not_provisioned');

// Tickets: one permission key, two tables, O&M only.
t('tickets needs a sub symbol', T.resolve('OM', 'tickets').reason, 'sub_symbol_required');
t('the ticket table resolves', T.resolve('OM', 'tickets', 'ticket').tableId, 'tbln5V2ynpBY9sIOc');
t('the spares table resolves under the SAME module key',
  T.resolve('OM', 'tickets', 'spares').tableId, 'tblWkdyee2XZCFxp9');
t('an invented sub symbol is refused', T.resolve('OM', 'tickets', 'everything').reason, 'unknown_symbol');
t('tickets are not reachable in the C&I base', T.resolve('CI', 'tickets', 'ticket').reason, 'wrong_base');
// The spares table must never be addressable on its own: a second key would be a second place
// to grant access, and the roles only ever say 'tickets'.
t('ticket_spares is not a module of its own', T.resolve('OM', 'ticket_spares').reason, 'unknown_symbol');
t('the ticket tables are two distinct ids',
  T.resolve('OM', 'tickets', 'ticket').tableId !== T.resolve('OM', 'tickets', 'spares').tableId, true);
t('delivery_notes resolves per base (C&I)', T.resolve('CI', 'delivery_notes').tableId, 'tblpdJP1RYL9WHSMq');
t('delivery_notes resolves per base (O&M)', T.resolve('OM', 'delivery_notes').tableId, 'tblCnFI2EDwBgEKmi');

console.log('\n\x1b[1mRATE LIMITING\x1b[0m\n');
const key = `test-${Date.now()}`;
let last = null;
for (let i = 0; i < 6; i++) last = H.rateLimit(key, 5, 60_000);
t('6th request in a window of 5 is refused', last.ok, false);
t('refusal carries a Retry-After', last.retryAfter > 0, true);
t('a different key is unaffected', H.rateLimit(`${key}-other`, 5, 60_000).ok, true);

let sessionLimit = null;
const sid = `sid-${Date.now()}`;
for (let i = 0; i < 121; i++) sessionLimit = H.sessionRateLimit(sid);
t('session limit trips after 120 requests/min', sessionLimit.ok, false);


// Raw-identifier scan. This was a live outage, not a hypothetical: the scan rejected every
// fld… id anywhere in the body, so the O&M scheduler — which addresses fields by id via
// returnFieldsByFieldId — could not read a single record. Narrowing it to the two positions
// the client may legitimately use must not reopen base, table or view naming.
console.log('\n\x1b[1mRAW IDENTIFIER SCAN\x1b[0m\n');
{
  const FLD = 'fldBMRad0IjocAKS4';
  const TBL = 'tblny4UUKq8OIHQlw';
  const APP = 'app0tq4y9wH10h6Up';
  const VIW = 'viwAbCdEfGhIjKlMn';
  const scan = (b) => T.findRawIdInRequest(b);

  t('field ids allowed in params.fields (the list selector)',
    scan({ op: 'list', base: 'OM', table: 'site_visits', params: { fields: [FLD] } }), null);
  t('field ids allowed as fields keys (create and update)',
    scan({ op: 'create', base: 'OM', table: 'site_visits', fields: { [FLD]: 'x' } }), null);

  t('a raw table id is still rejected',
    scan({ op: 'list', base: 'OM', table: TBL }), TBL);
  t('a raw base id is still rejected',
    scan({ op: 'list', base: APP, table: 'site_visits' }), APP);
  t('a view id is still rejected',
    scan({ op: 'list', base: 'OM', table: 'site_visits', params: { view: VIW } }), VIW);
  t('a table id hidden inside params.fields is rejected',
    scan({ op: 'list', base: 'OM', table: 'site_visits', params: { fields: [TBL] } }), TBL);
  t('a field id used as the table name is rejected',
    scan({ op: 'list', base: 'OM', table: FLD }), FLD);
  t('a field id smuggled into a formula is rejected (formulas name fields, not ids)',
    scan({ op: 'list', base: 'OM', table: 'site_visits',
           params: { filterByFormula: '{' + FLD + '}>1000' } }), FLD);
  t('a field id in a nested params value is rejected',
    scan({ op: 'list', base: 'OM', table: 'site_visits', params: { sort: [{ field: FLD }] } }), FLD);
}


// Picking slip lock. Rule 11: once the warehouse signs, the picked quantities are evidence.
// Enforced in the proxy so a direct POST is refused too — hiding the input would only stop
// the honest. The signing fields themselves stay writable, or the lock could never go on.
console.log('\n\x1b[1mPICKING SLIP LOCK\x1b[0m\n');
{
  const G = L('_lib/guards.js');
  const open   = { id: 'recA', fields: { 'PS Number': 'PS-2026-00001', Locked: false } };
  const locked = { id: 'recB', fields: { 'PS Number': 'PS-2026-00002', Locked: true } };
  const lineOpen   = { id: 'recL', fields: { 'Picking Slip': ['recA'] } };
  const lineLocked = { id: 'recM', fields: { 'Picking Slip': ['recB'] } };
  const loadParent = async (id) => ({ recA: open, recB: locked }[id] || null);
  const g = (tableSymbol, existing, fields, canOverride) =>
    G.guardPickingSlipLock({ tableSymbol, existing, fields, canOverride, loadParent });

  t('an unlocked slip accepts an edit',
    (await g('picking_slips', open, { 'Qty Required': 3 }, false)).ok, true);
  t('a LOCKED slip refuses an ordinary edit',
    (await g('picking_slips', locked, { 'Site Name': 'x' }, false)).reason, 'picking_slip_locked');
  t('the refusal is a conflict, not a permission error',
    (await g('picking_slips', locked, { 'Site Name': 'x' }, false)).status, 409);
  t('the signing fields stay writable, or the lock could never be set',
    (await g('picking_slips', locked, { Locked: true, Status: 'Picked' }, false)).ok, true);
  t('a line of a LOCKED slip is refused',
    (await g('picking_slip_items', lineLocked, { 'Qty Picked': 7 }, false)).reason, 'picking_slip_locked');
  t('a line of an unlocked slip is fine',
    (await g('picking_slip_items', lineOpen, { 'Qty Picked': 7 }, false)).ok, true);
  t('an override is allowed',
    (await g('picking_slip_items', lineLocked, { 'Qty Picked': 7 }, true)).ok, true);
  t('and the override is flagged so the caller can audit it',
    (await g('picking_slip_items', lineLocked, { 'Qty Picked': 7 }, true)).overridden, true);
  t('other tables are not affected by the lock',
    (await g('delivery_notes', locked, { Status: 'x' }, false)).ok, true);
  t('an orphan line with no parent is not treated as locked',
    (await g('picking_slip_items', { id: 'x', fields: {} }, { 'Qty Picked': 1 }, false)).ok, true);
}

// Conversion. Rule 2: a picking slip must be picked and signed before it can become a
// delivery note. Rule 1 — no delivery note without a slip at all — is deliberately NOT
// enforced yet, because the warehouse still creates notes directly and that path must keep
// working until stage 4 replaces it. These assertions pin both halves of that position.
console.log('\n\x1b[1mPICKING SLIP -> DELIVERY NOTE\x1b[0m\n');
{
  const G = L('_lib/guards.js');
  const signed   = { id: 'recS', fields: { 'PS Number': 'PS-2026-00125', Locked: true } };
  const unsigned = { id: 'recU', fields: { 'PS Number': 'PS-2026-00126', Locked: false } };
  const loadSlip = async (id) => ({ recS: signed, recU: unsigned }[id] || null);
  const g = (fields, op) => G.guardDeliveryFromSlip({
    tableSymbol: 'delivery_notes', op: op || 'create', fields, loadSlip,
  });

  t('a note raised from a SIGNED slip is allowed',
    (await g({ 'Picking Slip': ['recS'] })).ok, true);
  t('a note raised from an UNSIGNED slip is refused',
    (await g({ 'Picking Slip': ['recU'] })).reason, 'picking_slip_unsigned');
  t('the refusal names the slip',
    /PS-2026-00126/.test((await g({ 'Picking Slip': ['recU'] })).detail), true);
  t('a slip that does not exist is refused',
    (await g({ 'Picking Slip': ['recZ'] })).reason, 'picking_slip_not_found');

  // The legacy path must survive until stage 4.
  t('a note with no picking slip is still allowed (today\'s warehouse flow)',
    (await g({ 'DN Number': 'DN-20260904-001' })).ok, true);
  t('an update is not affected',
    (await g({ 'Picking Slip': ['recU'] }, 'update')).ok, true);
  t('other modules are not affected',
    (await G.guardDeliveryFromSlip({ tableSymbol: 'delivery_lines', op: 'create',
      fields: { 'Picking Slip': ['recU'] }, loadSlip })).ok, true);
}

// Closing a delivery note. Rule 8: it cannot be closed while any signature is missing, and
// the refusal must name which one — 'cannot be closed' on its own leaves the person holding
// the phone with nothing to act on. The check reads the signature rollup ON THE RECORD, not
// anything the caller sent.
console.log('\n\x1b[1mDELIVERY NOTE CLOSURE\x1b[0m\n');
{
  const G = L('_lib/guards.js');
  const note = (roles, status, date, ps) => ({
    id: 'recD',
    fields: { 'DN Number': 'DN-20260904-001', 'Signature Roles': roles, Status: status,
      'Delivery Date': date, 'PS Number': ps === undefined ? 'PS-2026-00002' : ps },
  });
  // Records every consultation, so a test can assert the slip was NOT queried needlessly.
  let asked = [];
  const slipSigned = (yes) => async (ps) => { asked.push(ps); return yes; };
  const close = (existing, onSlip) => G.guardDeliveryClose({
    tableSymbol: 'delivery_notes', fields: { Status: 'Closed' }, existing,
    warehouseSignedOnSlip: onSlip,
  });
  const ALL = 'Warehouse, Driver, Site Installer';

  t('a fully signed, delivered, dated note closes',
    (await close(note(ALL, 'Delivered', '2026-09-04'))).ok, true);
  t('a partially delivered note can also close',
    (await close(note(ALL, 'Partially Delivered', '2026-09-04'))).ok, true);

  t('missing driver is refused',
    (await close(note('Warehouse, Site Installer', 'Delivered', '2026-09-04'))).reason, 'signature_outstanding');
  t('and the driver is named',
    (await close(note('Warehouse, Site Installer', 'Delivered', '2026-09-04'))).missing.join(), 'Driver');
  t('missing installer is named',
    (await close(note('Warehouse, Driver', 'Delivered', '2026-09-04'))).missing.join(), 'Site Installer');
  t('an unsigned note names all three',
    (await close(note('', 'Delivered', '2026-09-04'))).missing.length, 3);
  t('the refusal quotes the delivery note number',
    /DN-20260904-001/.test((await close(note('', 'Delivered', '2026-09-04'))).detail), true);

  t('signed but undated is refused',
    (await close(note(ALL, 'Delivered', ''))).reason, 'delivery_date_missing');
  t('signed but never delivered is refused',
    (await close(note(ALL, 'Out for Delivery', '2026-09-04'))).reason, 'not_delivered');

  t('a status change that is not a close is untouched',
    (await G.guardDeliveryClose({ tableSymbol: 'delivery_notes',
      fields: { Status: 'Out for Delivery' }, existing: note('', 'Ready for Delivery', '') })).ok, true);
  t('other modules are untouched',
    (await G.guardDeliveryClose({ tableSymbol: 'picking_slips',
      fields: { Status: 'Closed' }, existing: note('', 'x', '') })).ok, true);

  // ── the warehouse signs the SLIP, and that counts ──────────────────────────
  // The warehouse signature is taken when the stock leaves, on the picking slip, before the
  // delivery note exists. Requiring a second one on the note made closing unreachable through
  // the UI, which offers only Driver and Site Installer.
  asked = [];
  const fromSlip = await close(note('Driver, Site Installer', 'Delivered', '2026-09-04'), slipSigned(true));
  t('warehouse signature on the slip lets the note close', fromSlip.ok, true);
  t('...and it was looked up by the PS Number', asked.join(), 'PS-2026-00002');

  asked = [];
  const noSlipSig = await close(note('Driver, Site Installer', 'Delivered', '2026-09-04'), slipSigned(false));
  t('an unsigned slip still refuses', noSlipSig.reason, 'signature_outstanding');
  t('...naming the warehouse', noSlipSig.missing.join(), 'Warehouse');

  asked = [];
  await close(note(ALL, 'Delivered', '2026-09-04'), slipSigned(true));
  t('the slip is not queried when the note already carries Warehouse', asked.length, 0);

  asked = [];
  const noPs = await close(note('Driver, Site Installer', 'Delivered', '2026-09-04', ''), slipSigned(true));
  t('a note with no PS Number does not consult the slip', asked.length, 0);
  t('...and is refused', noPs.missing.join(), 'Warehouse');

  t('the slip cannot supply a signature the note is missing elsewhere',
    (await close(note('Site Installer', 'Delivered', '2026-09-04'), slipSigned(true))).missing.join(), 'Driver');
}

// Rule 1 — the switch-over. Enforcing 'no delivery note without a picking slip' ends the flow
// the warehouse uses today, so it is OFF unless REQUIRE_PICKING_SLIP=true. The date that flow
// stops is a business decision, not something that should arrive with a deploy. These
// assertions pin BOTH positions, so flipping the switch is a deliberate act.
console.log('\n\x1b[1mRULE 1 SWITCH-OVER\x1b[0m\n');
{
  const G = L('_lib/guards.js');
  const g = (fields) => G.guardDeliveryNeedsSlip({ tableSymbol: 'delivery_notes', op: 'create', fields });
  const was = process.env.REQUIRE_PICKING_SLIP;

  process.env.REQUIRE_PICKING_SLIP = 'false';
  t('off by default: a note with no slip is allowed', g({ 'DN Number': 'DN-1' }).ok, true);
  t('off by default: the flag reads false', G.requiresPickingSlip(), false);

  process.env.REQUIRE_PICKING_SLIP = 'true';
  t('switched on: a note with no slip is refused', g({ 'DN Number': 'DN-1' }).reason, 'picking_slip_required');
  t('switched on: an empty link counts as none', g({ 'Picking Slip': [] }).ok, false);
  t('switched on: a note WITH a slip is allowed', g({ 'Picking Slip': ['recX'] }).ok, true);
  t('switched on: updates are not affected',
    G.guardDeliveryNeedsSlip({ tableSymbol: 'delivery_notes', op: 'update', fields: {} }).ok, true);

  if (was === undefined) delete process.env.REQUIRE_PICKING_SLIP;
  else process.env.REQUIRE_PICKING_SLIP = was;
}

// Site signing links. A token that lets an installer with no account open ONE delivery note
// and sign it. The load-bearing property is that a link token and a session cookie are
// signed with DIFFERENT secrets, so neither can ever be presented as the other — the session
// path verifies without discriminating what a token was minted for, and a shared secret
// would make a signing link a valid login.
console.log('\n\x1b[1mSITE SIGNING LINKS\x1b[0m\n');
{
  const SL = L('_lib/signlink.js');
  const wasJwt = process.env.JWT_SECRET;
  const wasLink = process.env.SIGN_LINK_SECRET;
  process.env.JWT_SECRET = 'j'.repeat(48);
  process.env.SIGN_LINK_SECRET = 'k'.repeat(48);

  const m = SL.mint({ deliveryNoteId: 'recDN1', baseSymbol: 'CI', dnNumber: 'DN-20260904-001' });

  t('a fresh link verifies', SL.verify(m.token).ok, true);
  t('it names exactly one delivery note', SL.verify(m.token).payload.dn, 'recDN1');
  t('it carries a base SYMBOL, never a raw Airtable id', SL.verify(m.token).payload.b, 'CI');
  t('the role is fixed at mint time', SL.verify(m.token).payload.role, 'Site Installer');
  t('it expires', typeof SL.verify(m.token).payload.exp, 'number');

  // The trap this whole design exists to close.
  t('a LINK token is not accepted as a session', C.verifyJwt(m.token).ok, false);
  const session = C.signJwt({ sub: 'a@b.co', sid: 's1' }, 60);
  t('a SESSION token is not accepted as a link', SL.verify(session).ok, false);
  const forged = C.signJwt({ typ: 'sign-link', dn: 'recDN1', b: 'CI',
    role: 'Site Installer', jti: 'x' }, 60);
  t('a link forged with JWT_SECRET is refused', SL.verify(forged).ok, false);

  t('an empty token is refused', SL.verify('').reason, 'invalid_link');
  t('garbage is refused', SL.verify('abc.def.ghi').reason, 'invalid_link');
  t('every failure reads the same, so it is not an oracle',
    [SL.verify(''), SL.verify('abc.def.ghi'), SL.verify(session)]
      .every((r) => r.reason === 'invalid_link'), true);

  // Record state: three ways a structurally valid token stops working.
  const note = (jti, status, roles) => ({ id: 'recDN1',
    fields: { 'Sign Link Jti': jti, Status: status, 'Signature Roles': roles } });
  const p = SL.verify(m.token).payload;

  t('a live link on an open note is usable',
    SL.checkAgainstRecord(p, note(p.jti, 'Out for Delivery', 'Warehouse, Driver')).ok, true);
  t('issuing a newer link kills the old one',
    SL.checkAgainstRecord(p, note('other', 'Out for Delivery', '')).reason, 'superseded');
  t('a closed note refuses the link',
    SL.checkAgainstRecord(p, note(p.jti, 'Closed', '')).reason, 'note_closed');
  t('the link is single use — the signature itself is the flag',
    SL.checkAgainstRecord(p, note(p.jti, 'Delivered', 'Warehouse, Driver, Site Installer')).reason,
    'already_signed');
  t('a record with no jti accepts nothing',
    SL.checkAgainstRecord(p, note('', 'Out for Delivery', '')).reason, 'superseded');

  // What the link may ever see or write.
  t('no cost field is in the readable whitelist',
    SL.NOTE_FIELDS.filter((f) => /cost|price|value|margin/i.test(f)).length, 0);
  t('a link may write two fields and no more', SL.LINE_WRITABLE.length, 2);
  t('it may write the received quantity', SL.LINE_WRITABLE.includes('Qty Received'), true);
  t('it may NOT change the delivered quantity', SL.LINE_WRITABLE.includes('Quantity'), false);

  // Sharing the secret would silently undo the whole design, so it is refused outright.
  process.env.SIGN_LINK_SECRET = process.env.JWT_SECRET;
  t('a shared secret is refused, not tolerated', SL.isConfigured(), false);
  process.env.SIGN_LINK_SECRET = 'short';
  t('a short secret is refused', SL.isConfigured(), false);

  if (wasJwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = wasJwt;
  if (wasLink === undefined) delete process.env.SIGN_LINK_SECRET;
  else process.env.SIGN_LINK_SECRET = wasLink;
}

// ── every rewrite must point at a file that is actually served ───────────────
//
// Vercel serves public/ AT THE ROOT, so a destination of "/public/sign.html" resolves to
// nothing and 404s. That shipped: /sign was dead in production while /sign.html worked, and
// buildUrl hands every site installer <origin>/sign?t=... -- so each QR code opened a 404.
// It went unnoticed because scripts/dev-server.js mirrors the rewrite and resolves it locally.
{
  const fs = require('fs');
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  for (const rw of vercel.rewrites || []) {
    const dest = String(rw.destination || '').split('?')[0];
    if (dest.startsWith('/api/')) continue;            // functions, not static files
    t('rewrite ' + rw.source + ' does not target /public/', dest.startsWith('/public/'), false);
    t('rewrite ' + rw.source + ' targets a real file',
      fs.existsSync(path.join(__dirname, '..', 'public', dest.replace(/^\//, ''))), true);
  }
}


// ── Site Information uploads: the FICA / financial control ───────────────────
//
// This runs on the server for a reason: the check in mod-siteinfo.js is a courtesy so the user
// sees a verdict before a slow upload, and a courtesy is not a control. Asserted directly rather
// than only through a live upload, and deliberately including a file whose NAME is innocuous but
// whose TEXT is financial — otherwise the test would only prove the filename rule works.
{
  const zlib = require('zlib');
  const { classify } = require(path.join(__dirname, '..', 'api', 'siteinfo-upload.js'));

  const pdf = (text) => {
    const stream = zlib.deflateSync(Buffer.from('BT /F1 12 Tf (' + text + ') Tj ET', 'latin1'));
    return Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj<</Length ' + stream.length + '/Filter/FlateDecode>>stream\n', 'latin1'),
      stream,
      Buffer.from('\nendstream endobj\n%%EOF', 'latin1'),
    ]);
  };
  const v = (filename, contentType, buf) => classify({ filename, contentType, buf }).verdict;

  t('an ID document is blocked by name', v('id_document.pdf', 'application/pdf', Buffer.from('x')), 'BLOCKED');
  t('a bank statement is blocked by name', v('bank_statement.pdf', 'application/pdf', Buffer.from('x')), 'BLOCKED');
  t('a FICA pack is blocked by name', v('FICA_pack.pdf', 'application/pdf', Buffer.from('x')), 'BLOCKED');
  t('an invoice named innocently is blocked by its TEXT',
    v('site_report.pdf', 'application/pdf', pdf('Tax Invoice No 123 payable on receipt')), 'BLOCKED');
  t('banking details in the body are blocked',
    v('handover.pdf', 'application/pdf', pdf('Banking details branch code 250655 account number 1234')), 'BLOCKED');

  t('a site photograph is allowed', v('roof.jpg', 'image/jpeg', Buffer.from('x')), 'ALLOWED');
  t('an operational document is allowed',
    v('commissioning.pdf', 'application/pdf',
      pdf('Commissioning report for the inverter and battery installation at the site. '.repeat(6))),
    'ALLOWED');

  // A scan has no text layer and there is no OCR here, so it must NOT be waved through.
  t('a scan with no text layer needs review',
    v('scan.pdf', 'application/pdf', Buffer.from('%PDF-1.4 no text layer')), 'REVIEW');
  t('an unrecognised file needs review',
    v('unknown.bin', 'application/octet-stream', Buffer.from('x')), 'REVIEW');
}


// ── Site Information CSV import ──────────────────────────────────────────────
//
// The parser is the part that quietly breaks: a split(',') importer looks correct until the
// first address with a comma in it, and then it writes half a field into the wrong column. The
// column refusal is the second control after the upload classifier — a free-text field is the
// obvious way to smuggle banking data into a module that has no financial fields.
{
  const F = {
    name: 'Site Name', clientName: 'Client Name', jcNumber: 'Job Card Number',
    subSol: 'SUB / SOL Number', category: 'Installation Category',
    panelKw: 'Total Panel Capacity (kWp)', installed: 'Installation Date',
    history: 'History',
  };
  const EXISTING = [{ fields: { 'Site Name': 'TAQA OLIVEDALE', 'Client Name': 'TAQA' } }];

  // The importer is a browser module; give it just enough of a window to load.
  const prevTX = global.TX;
  const prevDoc = global.document;
  global.window = global;
  global.document = { createElement: () => ({ style: {}, addEventListener() {} }) };
  global.TX = {
    $: () => null,
    esc: (x) => String(x == null ? '' : x),
    userEmail: () => 'test@tagexenergy.co.za',
    errorText: (e) => String((e && e.message) || e),
    siteinfo: {
      schema: {
        fields: F,
        selects: { [F.category]: ['Project - PPA', 'Commercial', 'Other'] },
        numbers: [F.panelKw],
        dates: [F.installed],
      },
      sites: () => EXISTING,
      duplicatesOf: (name) => EXISTING.filter((x) => (
        String(x.fields['Site Name']).toLowerCase() === String(name).toLowerCase())),
    },
  };

  const fs = require('fs');
  const importPath = path.join(__dirname, '..', 'public', 'js', 'siteinfo-import.js');
  delete require.cache[require.resolve(importPath)];
  require(importPath);
  const I = global.TX.siteimport;

  // parser
  t('CSV: a quoted field may contain a comma',
    I.parseCsv('name,addr\nTAQA,"12 Main St, Olivedale"')[1], ['TAQA', '12 Main St, Olivedale']);
  t('CSV: doubled quotes collapse to one',
    I.parseCsv('a\n"He said ""hi"""')[1], ['He said "hi"']);
  t('CSV: a quoted field may contain a newline',
    I.parseCsv('a,b\n"line1\nline2",x')[1], ['line1\nline2', 'x']);
  t('CSV: CRLF is handled', I.parseCsv('a,b\r\n1,2')[1], ['1', '2']);
  t('CSV: a BOM is stripped', I.parseCsv('﻿a,b\n1,2')[0], ['a', 'b']);

  // the column refusal
  for (const h of ['Bank Account', 'ID Number', 'Invoice Total', 'Proof of Payment', 'VAT No', 'Salary']) {
    t('CSV: refuses the column "' + h + '"', I.autoMap([h]).blocked.length, 1);
  }
  for (const h of ['Site Name', 'Panel Quantity', 'Monitoring Reference']) {
    t('CSV: allows the column "' + h + '"', I.autoMap([h]).blocked.length, 0);
  }
  t('CSV: a refused column is never mapped to a field', I.autoMap(['Bank Account']).map[0], '');

  // row assessment
  const M = { 0: F.name, 1: F.clientName, 2: F.category, 3: F.panelKw, 4: F.installed };
  t('CSV: a good row is NEW',
    I.assess(['Meyerton', 'Fueltron', 'Project - PPA', '73.8', '2026-03-04'], M).status, 'NEW');
  t('CSV: a number with a unit still parses',
    I.assess(['X', '', '', '73.8 kWp', ''], M).fields[F.panelKw], 73.8);
  t('CSV: an unknown select option is INVALID, not sent',
    I.assess(['X', '', 'PPA Project', '', ''], M).status, 'INVALID');
  t('CSV: a select matches case-insensitively but stores the exact option',
    I.assess(['X', '', 'project - ppa', '', ''], M).fields[F.category], 'Project - PPA');
  t('CSV: a row with no site name is INVALID',
    I.assess(['', 'Fueltron', '', '', ''], M).status, 'INVALID');
  t('CSV: an existing site is DUPLICATE, not created twice',
    I.assess(['taqa olivedale', 'TAQA', '', '', ''], M).status, 'DUPLICATE');
  t('CSV: a blank cell writes nothing rather than an empty value',
    Object.prototype.hasOwnProperty.call(
      I.assess(['X', '', '', '', ''], M).fields, F.clientName), false);

  // assess(cells, mapping) must never be handed bare to Array.map: map supplies the row
  // INDEX as the second argument, so row 1 (index 0, falsy) worked and every later row
  // mapped nothing and reported "No site name". It looked like bad data, not bad code, and
  // an earlier test passed for the wrong reason because only the first row was assessed.
  {
    const src = fs.readFileSync(importPath, 'utf8');
    t('CSV: assess is never passed bare to Array.map', /\.map\(assess\)/.test(src), false);
  }

  global.TX = prevTX;
  global.document = prevDoc;
}


// ── OCR: reading a scanned job card ─────────────────────────────────────────
//
// The parser and the PDF image extractor are pure and are asserted directly. The classifier is
// asserted against REAL rendered documents, because the thing being claimed — "a photographed
// bank statement cannot be uploaded to Site Information" — is not provable against a stubbed
// OCR result. The fixtures are 300dpi-equivalent renderings of a job card and a bank statement.
{
  const J = L('_lib/jobcard-parse.js');
  const PI = L('_lib/pdfimages.js');
  const OCR = L('_lib/ocr.js');
  const OCRAPI = L('siteinfo-ocr.js');
  const UP = L('siteinfo-upload.js');
  const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n));

  console.log('\n\x1b[1mJOB CARD PARSER — labels\x1b[0m\n');

  t('a label maps to its field', J.fieldFor('Site Name'), 'Site Name');
  t('label matching ignores case and punctuation', J.fieldFor('SITE NAME:'), 'Site Name');
  t('a ruled-table pipe is not part of the label', J.fieldFor('| Client Name |'), 'Client Name');
  t('a synonym maps to the canonical field', J.fieldFor('Customer'), 'Client Name');
  t('an unknown label maps to nothing', J.fieldFor('Widget Colour'), null);

  // Longest-first matching. "capacity" alone is generic; the specific label must win, and a
  // shorter synonym must not shadow a longer one that also matches.
  t('the specific capacity label wins', J.fieldFor('Total Panel Capacity'),
    'Total Panel Capacity (kWp)');
  t('battery capacity is not panel capacity', J.fieldFor('Battery Capacity'),
    'Total Battery Capacity (kWh)');
  t('inverter capacity is its own field', J.fieldFor('Inverter Capacity'),
    'Total Inverter Capacity (kW)');

  // THE PRIVACY PROPERTY. There is no field for this material, so there is no label for it.
  for (const bad of ['Account Number', 'Bank Name', 'ID Number', 'Branch Code', 'VAT Number',
    'Invoice Total', 'Date of Birth', 'Passport Number']) {
    t('no site field exists for "' + bad + '"', J.fieldFor(bad), null);
  }

  console.log('\n\x1b[1mJOB CARD PARSER — values\x1b[0m\n');

  t('a plain integer parses', J.parseNumber('164'), 164);
  t('a unit is stripped', J.parseNumber('73.8 kWp'), 73.8);
  t('a South African decimal comma parses', J.parseNumber('73,8 kWp'), 73.8);
  t('a thousands space is removed', J.parseNumber('1 234 kWh'), 1234);
  t('a thousands comma is removed', J.parseNumber('1,234'), 1234);
  t('OCR letters inside a number are corrected', J.parseNumber('l64'), 164);
  t('a value with no number yields null', J.parseNumber('to be confirmed'), null);
  t('TBC in a quantity field is blank, not zero', J.parseNumber('TBC'), null);
  t('a prose value is blank, not zero', J.parseNumber('as per drawing'), null);
  t('letters are not corrected in a token with no digits',
    J.parseNumber('SOL panels 164'), 164);
  t('an empty value yields null', J.parseNumber(''), null);

  t('ISO dates parse', J.parseDate('2026-03-04').value, '2026-03-04');
  t('slashed year-first dates parse', J.parseDate('2026/03/04').value, '2026-03-04');
  t('day-first dates parse day first', J.parseDate('04/03/2026').value, '2026-03-04');
  t('a day-first date that could be month-first is flagged',
    J.parseDate('04/03/2026').ambiguous, true);
  t('an unambiguous day is not flagged', J.parseDate('24/03/2026').ambiguous, false);
  t('a written month parses', J.parseDate('4 March 2026').value, '2026-03-04');
  t('a month-name-first date parses', J.parseDate('March 4, 2026').value, '2026-03-04');
  t('a two-digit year is expanded', J.parseDate('04-03-26').value, '2026-03-04');
  t('an impossible date is refused', J.parseDate('31/02/2026').value, null);
  t('a non-date is refused', J.parseDate('next week').value, null);

  // Airtable select options are case sensitive and typecast is off, so a near miss is a failed
  // write. A guess is worse than a blank.
  t('a select matches case-insensitively but stores the exact option',
    J.matchSelect('Installation Category', 'commercial'), 'Commercial');
  t('a reordered select value is REFUSED, not guessed',
    J.matchSelect('Installation Category', 'PPA Project'), null);
  t('a partial select value is refused',
    J.matchSelect('Installation Category', 'Project'), null);

  console.log('\n\x1b[1mJOB CARD PARSER — lines and whole documents\x1b[0m\n');

  t('a colon splits label from value',
    J.splitLine('Site Name: TAQA')['value'].trim(), 'TAQA');
  t('a two-space gap splits a ruled column',
    J.splitLine('Site Name    TAQA')['value'].trim(), 'TAQA');
  // A single space must NOT split, or "Site Name" becomes label "Site" and value "Name".
  t('a single space does not split a label', J.splitLine('Site Name'), null);
  t('a blank line does not split', J.splitLine('   '), null);

  {
    const r = J.parseJobCard([
      'Site Name: TAQA OLIVEDALE',
      'Client Name: TAQA',
      'Installation Date: 04/03/2026',
      'Panel Quantity: 164',
      'Installation Category: Bananas',
      'Account Number: 62114558201',
      'Meter Serial Number: MTR-4471902',
    ].join('\n'));
    t('a good line is captured', r.fields['Site Name'], 'TAQA OLIVEDALE');
    t('a number is stored as a number', r.fields['Panel Quantity'], 164);
    t('an unknown select option is left blank', r.fields['Installation Category'], undefined);
    t('and it says why', r.warnings.some((w) => /not one of the allowed options/.test(w)), true);
    t('an ambiguous date is reported', r.warnings.some((w) => /day-first/.test(w)), true);
    t('a banking line produces NO field',
      Object.keys(r.fields).some((k) => /account/i.test(k)), false);
    t('and its value appears nowhere in the output',
      JSON.stringify(r.fields).indexOf('62114558201'), -1);
    t('a serial is captured separately from the site fields',
      r.serials.Meter, 'MTR-4471902');
    t('a serial is not written into a site field',
      Object.values(r.fields).indexOf('MTR-4471902'), -1);
  }

  {
    // A job card repeats its header on page two. The first reading is the filled-in one.
    const r = J.parseJobCard('Site Name: REAL SITE\nSite Name: page two header');
    t('the first reading of a repeated field wins', r.fields['Site Name'], 'REAL SITE');
  }

  console.log('\n\x1b[1mJOB CARD PARSER — equipment\x1b[0m\n');

  {
    const eq = J.equipmentFrom(
      { 'Inverter Manufacturer': 'Sungrow', 'Inverter Model': 'SG50CX', 'Inverter Quantity': 2 },
      { Meter: 'MTR-1' });
    t('an inverter with a make becomes a row', eq[0]['Equipment Type'], 'Inverter');
    t('its quantity is carried', eq[0].Quantity, 2);
    t('a meter serial becomes its own row',
      eq.some((r) => r['Equipment Type'] === 'Meter' && r['Serial Number'] === 'MTR-1'), true);
  }
  {
    // "2 inverters" with no make is not a record anyone can act on.
    const eq = J.equipmentFrom({ 'Inverter Quantity': 2 }, {});
    t('a bare quantity creates no equipment row', eq.length, 0);
  }
  {
    const eq = J.equipmentFrom({}, { Inverter: 'INV-9' });
    t('a serial alone is enough to create a row', eq.length, 1);
    t('and it is typed correctly', eq[0]['Equipment Type'], 'Inverter');
  }

  console.log('\n\x1b[1mPDF PAGE IMAGES\x1b[0m\n');

  {
    const pdf = fx('jobcard-scan.pdf');
    const r = PI.extractPageImages(pdf);
    t('a scanned page yields one image', r.images.length, 1);
    t('it is reported as a JPEG', r.images[0].kind, 'jpeg');
    t('the extracted bytes are a JPEG',
      r.images[0].data[0] === 0xff && r.images[0].data[1] === 0xd8, true);
    t('the extracted bytes are byte-identical to the embedded image',
      r.images[0].data.equals(fx('jobcard.jpg')), true);
    t('its dimensions are reported', [r.images[0].width, r.images[0].height], [1700, 2200]);
  }
  {
    // A PDF with a text layer and no page image. Nothing to OCR, and it must not invent one.
    const txt = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'latin1');
    const r = PI.extractPageImages(txt);
    t('a PDF with no image yields none', r.images.length, 0);
    t('and nothing is reported as unsupported', r.unsupported.length, 0);
  }
  {
    // JPEG 2000 and JBIG2 still cannot be decoded, and that must be SAID rather than returned
    // as an empty result that looks like a clean page.
    const jpx = Buffer.from('%PDF-1.4\n4 0 obj\n<< /Type /XObject /Subtype /Image /Width 1700 '
      + '/Height 2200 /Filter /JPXDecode /Length 4 >>\nstream\nABCD\nendstream\nendobj\n', 'latin1');
    const r = PI.extractPageImages(jpx);
    t('a JPEG 2000 scan yields no image', r.images.length, 0);
    t('and the codec is named so the caller can say so', r.unsupported[0], 'JPXDecode');
  }
  {
    // A declared DCTDecode stream whose bytes are not a JPEG. Never hand that to a decoder.
    const lying = Buffer.from('%PDF-1.4\n4 0 obj\n<< /Type /XObject /Subtype /Image /Width 1700 '
      + '/Height 2200 /Filter /DCTDecode /Length 4 >>\nstream\nNOPE\nendstream\nendobj\n', 'latin1');
    t('a stream that is not a JPEG is discarded', PI.extractPageImages(lying).images.length, 0);
  }
  {
    // A logo, not a page.
    const tiny = Buffer.from('%PDF-1.4\n4 0 obj\n<< /Type /XObject /Subtype /Image /Width 40 '
      + '/Height 40 /Filter /DCTDecode /Length 4 >>\nstream\n\xff\xd8\xff\xd9\nendstream\nendobj\n', 'latin1');
    t('a small decoration is not treated as a page', PI.extractPageImages(tiny).images.length, 0);
  }

  console.log('\n\x1b[1mFAX-COMPRESSED SCANS (what the office MFP actually produces)\x1b[0m\n');

  // The first real customer document was CCITT Group 4 throughout — the default black-and-white
  // text mode on an office scanner — which the first version of this extractor refused outright.
  // It does not need a decoder: TIFF stores the identical bitstream, so a header is enough.
  {
    const pdf = fx('jobcard-ccitt.pdf');
    const r = PI.extractPageImages(pdf);
    t('a Group 4 page is extracted', r.images.length, 1);
    t('it is wrapped as a TIFF for the OCR engine', r.images[0].contentType, 'image/tiff');
    t('it is reported as fax-compressed', r.images[0].kind, 'ccitt');
    t('the TIFF is little-endian', r.images[0].data.toString('latin1', 0, 2), 'II');
    t('the TIFF magic is present', r.images[0].data.readUInt16LE(2), 42);
    t('its dimensions come from DecodeParms', [r.images[0].width, r.images[0].height], [1700, 2200]);
  }

  // THE INDIRECT LENGTH. `/Length 6 0 R` points at object 6; `/Length 6` means six bytes.
  // Reading the reference as a literal truncates every stream to its first few bytes, and the
  // file then yields nothing at all — which is exactly what happened to the real document.
  t('an indirect /Length is not read as a literal length',
    PI.streamLength('<< /Length 8 0 R >>'), -1);
  t('a direct /Length still is', PI.streamLength('<< /Length 1234 >>'), 1234);
  t('a missing /Length is unknown', PI.streamLength('<< /Width 10 >>'), -1);
  {
    // The fixture uses the indirect form, so this fails outright if the distinction is lost.
    const raw = fx('jobcard-ccitt.pdf').toString('latin1');
    t('the fixture really does use an indirect length', /\/Length\s+\d+\s+\d+\s+R/.test(raw), true);
  }

  // MIXED RASTER CONTENT. A scanner splits a page into a low-detail background and the bilevel
  // masks that carry the text; OCR of the background returns a logo and nothing else. The
  // largest layer is the one worth reading.
  {
    const img = (n, w, h, filter) => n + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + w
      + ' /Height ' + h + ' /Filter ' + filter + ' /Length 4 >>\nstream\n\xff\xd8\xff\xd9\n'
      + 'endstream\nendobj\n';
    // One big "text mask" and one small "background", both valid JPEGs.
    const mrc = Buffer.from('%PDF-1.4\n' + img(4, 2400, 3400, '/DCTDecode')
      + img(5, 600, 800, '/DCTDecode'), 'latin1');
    const r = PI.extractPageImages(mrc, 4);
    t('the small background layer is dropped', r.images.length, 1);
    t('and the full-page layer is the one kept', r.images[0].width, 2400);
  }

  // SAMPLING. The FICA check must not be satisfiable by a document's cover page.
  //
  // Pages are given slightly different widths — within the area ratio, so none is filtered out —
  // purely so the test can see WHICH pages were chosen. Identical pages would make this assert
  // nothing at all.
  {
    const img = (n, w) => n + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + w
      + ' /Height 1000 /Filter /DCTDecode /Length 4 >>\nstream\n\xff\xd8\xff\xd9\n'
      + 'endstream\nendobj\n';
    let body = '%PDF-1.4\n';
    for (let i = 0; i < 20; i++) body += img(4 + i, 1000 + i);
    const many = Buffer.from(body, 'latin1');

    const front = PI.extractPageImages(many, 4, false);
    const spread = PI.extractPageImages(many, 4, true);
    const widths = (r) => r.images.map((x) => x.width - 1000);

    t('a 20-page document reports how many pages it has', front.available, 20);
    t('without sampling, the first four pages are read', widths(front), [0, 1, 2, 3]);
    t('with sampling, the same number of pages is read', spread.images.length, 4);
    t('sampling still starts at page one', widths(spread)[0], 0);
    // The point of the whole exercise: a page from the BACK of the document is read. In the
    // real 26-page pack the bank statements were on pages 11 to 13, and reading pages 1 to 4
    // returned nothing but contract boilerplate and a clean verdict.
    t('sampling reaches the last page', widths(spread)[3], 19);
    t('sampling spreads across the middle too', widths(spread), [0, 6, 13, 19]);
  }

  console.log('\n\x1b[1mPAGES THE BROWSER RENDERED\x1b[0m\n');

  // WHY THIS PATH EXISTS. Lifting the embedded images out of a PDF works while a scanned page
  // IS one image. A composited scan is not: a real 38-page site agreement holds 609 image
  // objects -- a text mask, a background and strips of each, per page -- and the largest-layer
  // heuristic above found FOUR fragments in the whole document, of four different sizes, none
  // of them a page. A renderer composites those layers back into the page a person sees, and
  // the browser has one, so the client sends pages and this reads them.
  {
    const page = fx('jobcard.jpg');

    const one = await OCR.readPages([page]);
    t('one page reads as one page', one.pages, 1);
    t('and gives up its text', one.text.length > 40, true);
    t('with a confidence', one.confidence > 0, true);

    const two = await OCR.readPages([page, page]);
    t('two pages read as two', two.pages, 2);
    t('their text is joined in the order sent',
      two.text.trim() === (one.text + '\n' + one.text).trim(), true);
    t('and nothing is reported as unavailable', two.available, 2);

    // An empty list is a caller error, not a crash, and not an empty success either.
    const none = await OCR.readPages([]);
    t('no pages is nothing read', [none.pages, none.text], [0, '']);
    t('and says so', /No page image/.test(none.note), true);
    t('an empty buffer is skipped rather than recognised',
      (await OCR.readPages([Buffer.alloc(0), page])).pages, 1);
  }

  // ── the endpoint takes them ──────────────────────────────────────────────
  {
    const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'siteinfo-ocr.js'), 'utf8');
    t('the endpoint accepts rendered pages', /Array\.isArray\(body\.pages\)/.test(api), true);
    t('and caps how many it will run OCR on', /MAX_PAGES_IN/.test(api), true);
    t('it reads them with readPages, not the image lift',
      /hasPages[\s\S]{0,60}ocr\.readPages\(pageBufs\)/.test(api), true);
    t('the whole-file path is still there for everything else',
      /ocr\.readDocument\(buf, filename, contentType, 2\)/.test(api), true);

    // THE FICA GATE STILL CLOSES. The name is judged, and so is the text OCR finds -- which on
    // correctly rendered pages is far more than the old path ever recovered.
    t('the name is still classified', /upload\.classify\(\{\s*\n?\s*filename,/.test(api), true);
    t('a page render is judged as the image it is, not as a PDF with no text layer',
      /contentType: hasPages \? 'image\/jpeg' : contentType/.test(api), true);
    t('and the text is classified after reading, as before',
      /contentType: 'text\/plain', buf: Buffer\.from\(read\.text/.test(api), true);
    t('the byte ceiling applies to the pages together, not each',
      /bytes \+= b\.length[\s\S]{0,120}bytes > MAX_BYTES/.test(api), true);
  }

  // ── and the client sends them ────────────────────────────────────────────
  {
    const cl = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'siteinfo-batch.js'), 'utf8');
    const pp = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'pdfpages.js'), 'utf8');
    const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

    t('a PDF is rendered rather than sent', /TX\.pdfPages\.isPdf\(file\)/.test(cl), true);
    t('both readers go through one request builder',
      (cl.match(/await asRequest\(prepped\)/g) || []).length, 2);
    t('neither builds the request by hand any more',
      /content: await toBase64\(prepped\.blob\),\n\s*\};/.test(cl), false);
    t('the old PDF size refusal is gone, because the file is no longer sent',
      /over the .* reading limit\. Re-save or split it/.test(cl), false);

    // THE FRONT AND A SPREAD. Reading only the first pages would let a bank statement bound
    // into the back of a long agreement past the text check.
    t('the renderer reads the front and then samples', /front/.test(pp) && /sample/.test(pp), true);
    t('the library is vendored, because script-src is self',
      /\/vendor\/pdf\.min\.js/.test(pp), true);
    t('and it really is in the repository',
      fs.existsSync(path.join(__dirname, '..', 'public', 'vendor', 'pdf.min.js')), true);
    t('with its worker', fs.existsSync(path.join(__dirname, '..', 'public', 'vendor', 'pdf.worker.min.js')), true);
    t('and its licence', fs.existsSync(path.join(__dirname, '..', 'public', 'vendor', 'pdf.js-LICENSE.txt')), true);
    t('nothing is fetched from a CDN at runtime', /https?:\/\//.test(pp.replace(/\/\/[^\n]*/g, '')), false);
    t('the module is served with the page', /<script src="\/js\/pdfpages\.js">/.test(page), true);
    t('before the module that uses it',
      page.indexOf('/js/pdfpages.js') < page.indexOf('/js/siteinfo-batch.js'), true);
  }

  console.log('\n\x1b[1mSITE MATCHING AND PRECEDENCE\x1b[0m\n');

  t('the same name matches', OCRAPI.namesMatch('ALAN AUCAMP', 'alan aucamp'), true);
  t('a stored name that extends the scanned one matches',
    OCRAPI.namesMatch('ALAN AUCAMP', 'ALAN AUCAMP RESIDENCE'), true);
  t('two different people do not match', OCRAPI.namesMatch('ALAN AUCAMP', 'ALAN BOTHA'), false);
  t('a short prefix is not enough to match', OCRAPI.namesMatch('ABC', 'ABC DEF'), false);
  t('a blank name never matches', OCRAPI.namesMatch('', 'ALAN AUCAMP'), false);
  // An array is ambiguous in Airtable: a LINK is an array of record ids, a LOOKUP is an array
  // of values. Rejecting both dropped the job card's address and client from every proposal.
  // A record id is exactly "rec" plus 14 characters — the earlier fixture here used a made-up
  // 6-character id, which is not what Airtable emits and so proved nothing.
  t('a link array is never proposed as a site value',
    OCRAPI.scalar(['recYK5Bc9pvHkZxYT']), '');
  t('a lookup array yields its value',
    OCRAPI.scalar(['14 DRIVER AVENUE X24, CLUBVIEW, 0157']), '14 DRIVER AVENUE X24, CLUBVIEW, 0157');
  t('a client-name lookup yields the name, not the address',
    OCRAPI.scalar(['WILLEM SCOTT', '14 DRIVER AVENUE']), 'WILLEM SCOTT');
  t('an ordinary word beginning "rec" is not mistaken for an id',
    OCRAPI.scalar(['Recycling Depot']), 'Recycling Depot');
  t('a collaborator field yields its name',
    OCRAPI.scalar({ id: 'usr1', email: 'a@b.c', name: 'Shantell' }), 'Shantell');
  t('an empty array yields nothing', OCRAPI.scalar([]), '');
  t('a select object is unwrapped', OCRAPI.scalar({ name: 'Commercial' }), 'Commercial');
  t('a number survives as a number', OCRAPI.scalar(73.8), 73.8);

  {
    // THE RULE THAT MATTERS: Airtable outranks the scan, always.
    const into = { 'SUB / SOL Number': 'SOL-88214' };
    const prov = { 'SUB / SOL Number': 'site' };
    const added = OCRAPI.foldIn(into, prov,
      { 'SUB / SOL Number': 'S0L-8B214', 'Client Name': 'Aucamp' },
      { 'SUB / SOL Number': 'SUB / SOL Number', 'Client Name': 'Client Name' }, 'jobcard');
    t('a stored value is never displaced by a later source',
      into['SUB / SOL Number'], 'SOL-88214');
    t('a blank field is filled by the later source', into['Client Name'], 'Aucamp');
    t('only what was added is counted', added, 1);
    t('provenance records where a value came from', prov['Client Name'], 'jobcard');
  }

  console.log('\n\x1b[1mOCR AGAINST REAL DOCUMENTS\x1b[0m\n');

  {
    const read = await OCR.readDocument(fx('jobcard-scan.pdf'), 'ALAN AUCAMP.pdf', 'application/pdf', 2);
    t('a scanned PDF is read', read.pages, 1);
    t('and it produces text', read.text.length > 200, true);

    const parsed = J.parseJobCard(read.text);
    t('the site name is recovered from the scan',
      parsed.fields['Site Name'], 'ALAN AUCAMP RESIDENCE');
    t('a number is recovered as a number', parsed.fields['Panel Quantity'], 164);
    t('a capacity with a unit is recovered',
      parsed.fields['Total Panel Capacity (kWp)'], 73.8);
    t('a date is recovered as ISO', parsed.fields['Installation Date'], '2026-03-04');
    t('a select is recovered exactly', parsed.fields['Installation Category'], 'Commercial');
    t('the meter serial is recovered', parsed.serials.Meter, 'MTR-4471902');
    t('equipment rows are proposed', parsed.equipment.length >= 2, true);
  }

  {
    // The same job card, fax-compressed the way an office MFP actually scans it. This is the
    // encoding the first customer document used, and it must yield the same fields as the JPEG.
    const read = await OCR.readDocument(fx('jobcard-ccitt.pdf'), 'scan.pdf', 'application/pdf', 2);
    t('a fax-compressed scan is read', read.pages, 1);
    t('and it reads well enough to trust', read.confidence > 80, true);

    const parsed = J.parseJobCard(read.text);
    t('the site name survives fax compression',
      parsed.fields['Site Name'], 'ALAN AUCAMP RESIDENCE');
    t('so does a quantity', parsed.fields['Panel Quantity'], 164);
    t('so does a capacity', parsed.fields['Total Panel Capacity (kWp)'], 73.8);
    t('so does a date', parsed.fields['Installation Date'], '2026-03-04');
    t('so does the meter serial', parsed.serials.Meter, 'MTR-4471902');
  }

  console.log('\n\x1b[1mTHE FICA CONTROL, AGAINST A REAL SCAN\x1b[0m\n');

  {
    const bank = fx('bank-statement.jpg');

    // Before OCR, an image was cleared on sight. This is the hole that closed: the file is
    // named innocuously, so neither the name rule nor a text layer can be what catches it.
    t('the name rule alone does not catch a photographed statement',
      UP.classify({ filename: 'site photo 4.jpg', contentType: 'image/jpeg', buf: bank }).verdict,
      'ALLOWED');
    t('reading the image blocks it',
      (await UP.classifyDeep({ filename: 'site photo 4.jpg', contentType: 'image/jpeg', buf: bank })).verdict,
      'BLOCKED');

    // ...without breaking the ordinary case, which is the whole module's daily traffic.
    t('a photographed job card is still usable',
      (await UP.classifyDeep({ filename: 'jobcard.jpg', contentType: 'image/jpeg', buf: fx('jobcard.jpg') })).verdict,
      'ALLOWED');

    // A clean read must never PROMOTE a verdict: "Tesseract found nothing" is not evidence of
    // safety, usually just evidence of handwriting.
    t('a scan that reads clean stays REVIEW rather than being cleared',
      (await UP.classifyDeep({ filename: 'ALAN AUCAMP.pdf', contentType: 'application/pdf', buf: fx('jobcard-scan.pdf') })).verdict,
      'REVIEW');

    // A SCANNED FINANCIAL DOCUMENT IN A PDF.
    //
    // This is the case the whole OCR pass exists for, and it was broken in a way no earlier
    // assertion could see. classifyDeep judged its OCR text by calling classify() with
    // contentType 'text/plain' — but classify() picks its text source by FILENAME FIRST, so a
    // ".pdf" name sent the recovered text straight back through the PDF parser, which found no
    // PDF inside a string of words and returned a clean verdict. Every scanned PDF skipped the
    // check entirely. The earlier image test passed only because its fixture was named ".jpg".
    t('a scanned bank statement in a PDF is blocked',
      (await UP.classifyDeep({
        filename: 'scan of page 3.pdf', contentType: 'application/pdf',
        buf: fx('bank-statement-ccitt.pdf'),
      })).verdict,
      'BLOCKED');

    // ...and the operational equivalent, same encoding, same naming, is still usable.
    t('a fax-compressed job card is not blocked',
      (await UP.classifyDeep({
        filename: 'scan of page 1.pdf', contentType: 'application/pdf',
        buf: fx('jobcard-ccitt.pdf'),
      })).verdict,
      'REVIEW');

    // IDENTITY RULES FIRE ON DATA, NOT ON A FORM LABEL.
    //
    // The statutory Certificate of Compliance prints an "ID No:" field for the registered
    // electrician on every certificate ever issued. Matching that label made it impossible to
    // store any CoC at all — in a module whose own schema has an "Electrical CoC" document
    // status and therefore expects them. Measured on a real certificate: the label matched and
    // the handwritten number beside it did not even OCR.
    t('a blank ID field on a form does not block',
      !!UP.textVerdict('Declaration by registered person (iD No: CFoBIY USE'), false);
    t('an empty ID label does not block', !!UP.textVerdict('ID No: ________'), false);

    // ...but an actual number still does, in each of the shapes it is written in.
    t('a real ID number blocks', UP.textVerdict('ID No: 8001015009087').verdict, 'BLOCKED');
    t('a spaced ID number blocks', UP.textVerdict('ID No. 800101 5009 087').verdict, 'BLOCKED');
    t('"Id Number" wording blocks', UP.textVerdict('Id Number 9202204720083').verdict, 'BLOCKED');
    t('a passport number blocks', UP.textVerdict('Passport No A01234567').verdict, 'BLOCKED');

    // The rules that were NOT relaxed.
    t('the "identity number" phrasing still blocks on its own',
      UP.textVerdict('(Identity Number)').verdict, 'BLOCKED');
    t('date of birth still blocks', UP.textVerdict('Date of Birth 1980-01-01').verdict, 'BLOCKED');
    t('an account number still blocks',
      UP.textVerdict('Account Number : 60113740498').verdict, 'BLOCKED');
    t('a filename saying ID still blocks whatever the text says',
      UP.classify({ filename: 'ID copy.pdf', contentType: 'application/pdf',
        buf: Buffer.from('operational', 'utf8') }).verdict, 'BLOCKED');

    // The text rules are asserted directly, so they cannot be silently bypassed by a caller
    // that hands them the wrong thing again.
    t('text rules judge text, not a filename',
      UP.textVerdict('Closing Balance 13,553.80 Cr account number 123').verdict, 'BLOCKED');
    t('operational text is not blocked',
      UP.textVerdict('Site Name: TAQA OLIVEDALE\nPanel Quantity: 164'), null);

    t('the filename rule still fires before anything is read',
      (await UP.classifyDeep({ filename: 'FICA pack.pdf', contentType: 'application/pdf', buf: fx('jobcard-scan.pdf') })).verdict,
      'BLOCKED');
  }

  console.log('\n\x1b[1mREADING WORD AND EXCEL\x1b[0m\n');

  // A .docx and a .xlsx used to yield ZERO characters: readDocument answered "Not an image or a
  // PDF" and the FICA classifier saw an empty string. So the two documents that actually
  // describe a system — the scope of work and the bill of materials — were uploaded and never
  // read, and a quotation in Word walked past the financial check unexamined.
  {
    const O = L('_lib/officetext.js');

    const doc = O.officeText(fx('sow.docx'), 'SOW - TREVOR HOWARD.docx', '');
    t('a Word document is opened', doc.kind, 'docx');
    t('and yields its text', doc.text.length > 400, true);
    t('paragraphs become separate lines', doc.text.split('\n').length > 5, true);
    t('the text is the document, not its XML', /<w:/.test(doc.text), false);

    const sheet = O.officeText(fx('bom.xlsx'), 'Trevor DC BOM.xlsx', '');
    t('a spreadsheet is opened', sheet.kind, 'xlsx');
    t('shared strings are resolved, not left as indexes',
      /JA SOLAR 545W MONO PV MODULE/.test(sheet.text), true);
    t('each row is one line with visible cell separators',
      /JA SOLAR 545W MONO PV MODULE \| 15 \| EA/.test(sheet.text), true);

    // The old binary formats are not ZIPs. Say so rather than returning a clean blank.
    const legacy = O.officeText(Buffer.from('rubbish'), 'SOW.doc', '');
    t('a legacy .doc is reported, not silently empty', /older binary Office file/.test(legacy.note), true);
    t('and a file that is not a ZIP at all is reported',
      /not a readable Office document/.test(O.officeText(Buffer.from('rubbish'), 'x.docx', '').note), true);
  }

  console.log('\n\x1b[1mSPECIFICATIONS FROM PROSE AND A BILL OF MATERIALS\x1b[0m\n');

  // The form parser reads "Panel Quantity: 164". An SOW says "15 x JA Solar ... 545W modules" and
  // a BOM says "JA SOLAR 545W PV MODULE | 15 | EA" — neither has a label, so the form parser
  // takes nothing from either. This reader recognises the THINGS instead.
  {
    const SPEC = L('_lib/spec-extract.js');
    const O = L('_lib/officetext.js');

    const sow = SPEC.extractSpecs(O.officeText(fx('sow.docx'), 'sow.docx', '').text);
    t('the panel make is read from prose', sow.fields['Panel Manufacturer'], 'JA Solar');
    t('the panel model is read from prose', sow.fields['Panel Model'], 'JAM54S30-545/MR');
    t('the panel count is read from "15 x"', sow.fields['Panel Quantity'], 15);
    t('the system size is read', sow.fields['Total Panel Capacity (kWp)'], 8.2);
    t('the inverter make is read', sow.fields['Inverter Manufacturer'], 'Sungrow');
    t('the inverter model is read', sow.fields['Inverter Model'], 'SH8.0RT');
    // One sentence naming two products must not lose the second one.
    t('a battery named in the same sentence as an inverter is still found',
      sow.fields['Battery Manufacturer'], 'BYD');
    t('and its stated total is used, not the per-unit figure',
      sow.fields['Total Battery Capacity (kWh)'], 10.2);
    t('the monitoring platform is recognised by name',
      sow.fields['Monitoring Platform'], 'iSolarCloud');
    t('the monitoring reference is read', sow.fields['Monitoring Reference'], 'ISC-773120');

    const bom = SPEC.extractSpecs(O.officeText(fx('bom.xlsx'), 'bom.xlsx', '').text);
    t('a bill of materials yields the panel make', bom.fields['Panel Manufacturer'], 'JA Solar');
    t('and the quantity from its own column', bom.fields['Panel Quantity'], 15);
    // A BOM states a rating PER ITEM. 2 x 5.1 kWh is a 10.2 kWh system.
    t('a per-item rating is multiplied out', bom.fields['Total Battery Capacity (kWh)'], 10.2);
    t('and the reader says it did so',
      bom.warnings.some((w) => /per item, read as 10\.2 kWh/.test(w)), true);
    t('a panel capacity derived from wattage is flagged too',
      bom.warnings.some((w) => /545W was read as 8\.2 kWp/.test(w)), true);
    // The leading cell of a BOM row is YOUR stock code, not the manufacturer's model.
    t('a warehouse stock code is not recorded as the panel model',
      bom.fields['Panel Model'], undefined);

    // A consumables line carries ratings that would be misread as system capacity...
    const cable = SPEC.extractSpecs('CAB-6MM-RED | 6MM RED SOLAR CABLE | 60 | M');
    t('a cable line contributes nothing', Object.keys(cable.fields).length, 0);
    // ...but a prose sentence that merely mentions brackets is still describing the system.
    // Applying the consumables rule to every line threw away the SOW's only panel sentence.
    const prose = SPEC.extractSpecs(
      'Install 12 x Canadian Solar 550W modules on rail-mounted brackets.');
    t('prose is not discarded for mentioning brackets',
      prose.fields['Panel Manufacturer'], 'Canadian Solar');
    t('and its quantity survives', prose.fields['Panel Quantity'], 12);

    // Brand knowledge is what tells three otherwise identical lines apart.
    t('a brand is attributed to the right kind of equipment',
      SPEC.brandsOn('Pylontech US3000C').map((b) => b.kind), ['battery']);
    t('a longer brand name wins over a substring',
      SPEC.brandsOn('Canadian Solar CS7L-600')[0].name, 'Canadian Solar');
    t('an unknown brand yields nothing rather than a guess',
      SPEC.brandsOn('Acme Widgets 500W').length, 0);
  }

  console.log('\n\x1b[1mA SITE WITH MANY DOCUMENTS\x1b[0m\n');

  // A site with 224 uploaded files showed "No photos or documents yet".
  //
  // The gallery asked for its documents with one OR() over every record id. At ~32 characters
  // each that formula reached 7171 characters, the proxy refuses any client filter over 4000,
  // and the refusal was swallowed by `.catch(() => ({ records: [] }))` — so a rejected request
  // and an empty site rendered identically. The cliff was at 125 documents.
  {
    const PERM = L('_lib/permissions.js');
    const idFilter = (n) => 'OR(' + Array.from({ length: n },
      (_, i) => 'RECORD_ID()="rec' + String(i).padStart(14, '0') + '"').join(',') + ')';

    // The limit itself, and where it bites.
    t('60 ids are accepted', PERM.validateClientFilter(idFilter(60)).ok, true);
    t('124 ids are still accepted', PERM.validateClientFilter(idFilter(124)).ok, true);
    t('125 ids are refused', PERM.validateClientFilter(idFilter(125)).ok, false);
    t('and the reason is the length', PERM.validateClientFilter(idFilter(125)).reason,
      'filter_too_long');
    t('the real site\'s 224 ids were far over', idFilter(224).length > 7000, true);

    const msrc = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'js', 'mod-siteinfo.js'), 'utf8');

    t('documents are fetched in batches', /const DOC_CHUNK = (\d+);/.test(msrc), true);
    const chunk = Number(/const DOC_CHUNK = (\d+);/.exec(msrc)[1]);
    t('a full batch stays inside the limit', PERM.validateClientFilter(idFilter(chunk)).ok, true);
    // Room to spare, so a longer record id format or an added clause does not reintroduce this.
    t('with room to spare', idFilter(chunk).length < 3000, true);
    t('the loader exists', /async function loadDocuments\(/.test(msrc), true);
    t('it walks the ids in steps of that size',
      /i \+= DOC_CHUNK/.test(msrc), true);

    // THE SILENT CATCH IS GONE. This is the part that made the bug invisible.
    t('a failed document fetch is no longer swallowed',
      /catch \(\) => \(\{ records: \[\] \}\)/.test(msrc), false);
    t('the error is carried back to the caller', /return \{ records, error \}/.test(msrc), true);
    t('and the screen distinguishes a failure from an empty site',
      /could not be loaded/.test(msrc), true);
    t('a genuinely empty site still says so',
      /No photos or documents yet/.test(msrc), true);
    t('a partial load says how many are shown',
      /Showing ' \+ docs\.length \+ ' document\(s\)/.test(msrc), true);
  }

  console.log('\n\x1b[1mREADING A WHOLE FOLDER, AND THE SITE REPORT\x1b[0m\n');

  {
    const R = L('_lib/sitereport.js');
    const UP2 = L('siteinfo-upload.js');

    const sample = {
      fields: {
        'Site Name': 'TINCUP Restaurant',
        'Client Name': 'TINCUP Restaurant (Pty) Ltd',
        'Panel Quantity': 180,
        'Total Panel Capacity (kWp)': 113.4,
        'Inverter Manufacturer': 'Aelio',
      },
      provenance: { 'Site Name': 'folder', 'Client Name': 'ocr' },
      origin: { 'Panel Quantity': 'TINCUP_SOW.docx' },
      equipment: [{ 'Equipment Type': 'Inverter', Manufacturer: 'Aelio', Quantity: 2 }],
      warnings: ['180 x 630W was read as 113.4 kWp. Check it.'],
      sources: [
        { name: 'TINCUP_SOW.docx', read: true, chars: 6764 },
        { name: 'JOB CARD.pdf', read: true, chars: 210, note: '25% confidence' },
        { name: 'roof photo.jpg', read: false, note: 'attached, not read' },
      ],
      author: 'raymond@tagexenergy.co.za',
    };

    const text = R.reportText(sample);
    t('the report names the site', /TINCUP Restaurant/.test(text), true);
    t('it says where a value came from', /\[TINCUP_SOW\.docx\]/.test(text), true);
    t('it names the folder as a source when that is what supplied the name',
      /from the folder name/.test(text), true);
    // What is MISSING matters as much as what was found.
    t('it lists the fields nothing supplied', /NOT FOUND IN ANY DOCUMENT/.test(text), true);
    t('it repeats every derived figure as a caution',
      /113\.4 kWp\. Check it\./.test(text), true);
    t('it lists every document, read or not', /\[not read\] roof photo\.jpg/.test(text), true);
    t('and it does not claim to be an engineering document',
      /not an engineering document/.test(text), true);

    // The PDF has to be a real PDF — and specifically one this codebase can read back.
    const pdf = R.reportPdf(sample);
    t('the report is a PDF', pdf.toString('latin1', 0, 5), '%PDF-');
    t('it ends properly', /%%EOF\s*$/.test(pdf.toString('latin1').slice(-20)), true);
    const back = UP2.pdfText(pdf);
    t('our own PDF reader can read it back', back.length > 500, true);
    t('and the site name survives the round trip', /TINCUP Restaurant/.test(back), true);
    // It is uploaded through the ordinary route, so it faces the same classifier.
    t('the report passes the FICA classifier',
      UP2.classify({ filename: R.reportFilename(sample), contentType: 'application/pdf', buf: pdf })
        .verdict, 'ALLOWED');
    t('the filename is dated and readable',
      /^TINCUP Restaurant - SOW and Site Report \d{4}-\d{2}-\d{2}\.pdf$/
        .test(R.reportFilename(sample)), true);

    // Long values must not run off the page.
    t('a long line is wrapped', R.wrap('x'.repeat(200), 88).length, 3);
    t('a paragraph break is kept', R.wrap('a\n\nb', 88).length, 3);
    // A PDF literal cannot contain a bare bracket or backslash.
    const risky = R.reportPdf({ fields: { 'Site Name': 'A (b) \\ c' }, sources: [] });
    t('brackets in a value do not corrupt the PDF',
      risky.toString('latin1').indexOf('(A \\(b\\) \\\\ c)') > 0, true);
  }
  {
    // Reading a folder: which documents, in what order, and what the merge must not do.
    const bsrc = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'js', 'siteinfo-batch.js'), 'utf8');

    t('the folder route reads many documents, not one',
      /async function readAll\(\)/.test(bsrc), true);
    t('the number read is capped', /const MAX_READ = \d+/.test(bsrc), true);
    // A WORD BOUNDARY IS THE WRONG TEST ON A FILENAME: "_" is a word character, so \bsow\b
    // never matched "TINCUP_SOW_Complete 10Sep.docx" and the SOW sorted below a spreadsheet.
    // Asserted against CODE, not comments. The comment above the fix quotes the broken
    // pattern in order to explain it, and the first version of this test matched its own
    // explanation and failed.
    const bcode = bsrc.replace(/^\s*\/\/.*$/gm, '');
    t('filenames are not matched with word boundaries',
      bcode.indexOf(String.fromCharCode(92) + 'bsow' + String.fromCharCode(92) + 'b') >= 0,
      false);
    t('separators are matched explicitly instead',
      /\(\^\|\[\^a-z0-9\]\)/.test(bsrc), true);
    // Later documents fill gaps; they never overwrite.
    t('a later document only fills a field that is still empty',
      /if \(EDIT\[k\] !== undefined && EDIT\[k\] !== ''\) continue;/.test(bsrc), true);
    t('where each value came from is remembered',
      /ORIGIN\[k\] = entry\.r\.rel/.test(bsrc), true);
    t('warnings are gathered across every document', /EXTRA_WARN\.push\(w\)/.test(bsrc), true);
    t('and are deduplicated before the report', /\[\.\.\.new Set\(/.test(bsrc), true);
    t('files that were attached but never read are still listed',
      /attached, not read/.test(bsrc), true);
    t('the report is compiled before the source documents are uploaded',
      bsrc.indexOf("'/api/siteinfo-report'") < bsrc.indexOf("step('Uploading '"), true);

    const rsrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'siteinfo-report.js'), 'utf8');
    t('compiling a report requires site_information:create',
      /P\.can\(auth\.perms, 'site_information', 'create'\)/.test(rsrc), true);
    t('the report route writes nothing to Airtable', /at\.(create|update)\(/.test(rsrc), false);
    t('it refuses to compile a report for a nameless site',
      /A site name is required to compile a report/.test(rsrc), true);
  }

  console.log('\n\x1b[1mA PROPOSAL WITH NO SITE NAME\x1b[0m\n');

  // "A site name is required" was an error nobody could act on. The review table rendered only
  // the fields the proposal happened to contain, so when no source supplied a Site Name — a job
  // card whose client lookup is empty, plus a scan that read nothing — the one field needed to
  // proceed was the one field not on screen.
  {
    const bsrc = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'js', 'siteinfo-batch.js'), 'utf8');

    t('the review table always offers the core fields',
      /const CORE = \['Site Name'/.test(bsrc), true);
    t('a missing core field is added as an empty row',
      /if \(!Object\.prototype\.hasOwnProperty\.call\(EDIT, k\)\) EDIT\[k\] = ''/.test(bsrc), true);
    t('an empty required field is sorted to the top',
      /const blocked = \(k\) => \(k === 'Site Name'/.test(bsrc), true);
    t('and is marked as the thing holding the save up',
      /si-needed/.test(bsrc), true);
    // An empty core field must not be written to Airtable as a blank value.
    t('blank values are still never sent', /if \(v === '' \|\| v == null\) continue;/.test(bsrc), true);
    t('the save still refuses without a name',
      /A site name is required/.test(bsrc), true);

    // The dropped folder is usually named after the site.
    t('the common top folder is worked out', /function folderName\(\)/.test(bsrc), true);
    t('it is only used when every file shares one',
      /tops\.size === 1 \? \[\.\.\.tops\]\[0\] : ''/.test(bsrc), true);
    t('and it is sent to the server as a hint', /req\.siteNameHint = top/.test(bsrc), true);

    const osrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'siteinfo-ocr.js'), 'utf8');
    // The server accepted siteNameHint but only ever SEARCHED with it; it never filled the field.
    t('the server proposes the folder name as a last resort',
      /provenance\[JC\.FIELD\.name\] = 'folder'/.test(osrc), true);
    t('and only when nothing better supplied one',
      /if \(!proposal\[JC\.FIELD\.name\]\) \{[\s\S]{0,300}?siteNameHint/.test(osrc), true);
  }
  {
    // A multi-line address arrived as one run-together string: "Perseel H68Loskop NoordMarble
    // HallLimpopo, 0450".
    t('a multi-line address is made legible',
      OCRAPI.scalar('Perseel H68\nLoskop Noord\nMarble Hall\nLimpopo, 0450'),
      'Perseel H68, Loskop Noord, Marble Hall, Limpopo, 0450');
    t('a single-line value is untouched', OCRAPI.scalar('Johannesburg'), 'Johannesburg');
    t('a number is still a number', OCRAPI.scalar(120), 120);
  }

  console.log('\n\x1b[1mLESSONS FROM A REAL SCOPE OF WORK\x1b[0m\n');

  // Every assertion here is a mistake the extractor actually made against a real commercial SOW.
  // The wording is reproduced; the client's name, address and pricing are not.
  {
    const SPEC = L('_lib/spec-extract.js');

    // A BRAND THAT IS ALSO AN ENGLISH WORD. "Must" is a real inverter brand, and it is also the
    // word in "Any changes must be approved in writing by both parties" — which is how a terms
    // and conditions clause came to propose the inverter manufacturer.
    t('an English word is not read as a brand',
      SPEC.brandsOn('Any changes must be approved in writing by both parties').length, 0);
    t('a brand needs equipment context at all',
      SPEC.looksLikeEquipment('Any changes must be approved in writing'), false);
    // ...but the real brand still reads when it is beside a rating.
    t('the same word beside a rating is the brand',
      SPEC.brandsOn('2x Must PV1800 5kW inverter').map((b) => b.kind), ['inverter']);

    // A WARRANTY IS NOT A QUANTITY. "PV modules: 12-year product + 25-year performance warranty"
    // is a labelled panel quantity of 12 as far as a form parser is concerned.
    const J2 = L('_lib/jobcard-parse.js');
    const warr = J2.parseJobCard('PV modules: 12-year product + 25-year performance warranty');
    t('a warranty clause does not become a panel count',
      warr.fields['Panel Quantity'], undefined);
    t('and the reader says why it refused it',
      warr.warnings.some((w) => /warranty or a duration/.test(w)), true);

    // A WRITTEN-OUT COUNT. One section said "Dual 60kW Aelio inverters" and another "2x Aelio
    // 60kW"; the first won and recorded a 60kW system where 120kW was installed.
    const dual = SPEC.extractSpecs('Hybrid Inverter: Dual 60kW Aelio inverters with cloud');
    t('"Dual" is read as two units', dual.fields['Inverter Quantity'], 2);
    t('and the rating is multiplied out', dual.fields['Total Inverter Capacity (kW)'], 120);
    t('and it says it did so',
      dual.warnings.some((w) => /60 kW per item, read as 120 kW/.test(w)), true);

    // BESS is what a commercial document calls a battery. Without the word, a line naming a real
    // battery brand did not look like equipment at all and the whole battery section was lost.
    const bess = SPEC.extractSpecs('Sunwoda/Aelio BESS System');
    t('a BESS line is recognised as a battery', bess.fields['Battery Manufacturer'], 'Sunwoda');

    // A quantity prefix is not a model, and neither is a description.
    const topcon = SPEC.extractSpecs('180x TOPCon 630W Solar Panels');
    t('a quantity prefix is not recorded as a model',
      topcon.fields['Panel Model'], undefined);
    t('but the count is read', topcon.fields['Panel Quantity'], 180);
    t('and the array size is worked out', topcon.fields['Total Panel Capacity (kWp)'], 113.4);
    // TOPCon is a cell technology, not a manufacturer. A blank is the honest answer.
    t('a technology name is not invented into a manufacturer',
      topcon.fields['Panel Manufacturer'], undefined);
    t('"3-phase" is not a model',
      SPEC.modelOn('Aelio 3-phase output', 'Aelio'), '');

    // Our own contact block is not the site's.
    const ours = J2.parseJobCard('Email: office@tagexenergy.co.za');
    t('the contractor\'s own email is not filed as the site contact',
      ours.fields['Email Address'], undefined);
    t('a client email still reads',
      J2.parseJobCard('Email: ops@tincup.co.za').fields['Email Address'], 'ops@tincup.co.za');

    // An SOW writes the address under "Location".
    t('"Location" is an address label',
      J2.parseJobCard('Location: 14 Driver Avenue, Clubview').fields['Property Address'],
      '14 Driver Avenue, Clubview');
  }

  console.log('\n\x1b[1mSTARTING FROM A JOB CARD\x1b[0m\n');

  {
    const ocrSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'siteinfo-ocr.js'), 'utf8');
    const upSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'siteinfo-upload.js'), 'utf8');
    const batchSrc2 = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'js', 'siteinfo-batch.js'), 'utf8');

    // THE FIELD IS "JC Reference". Querying {Job Card Number} — which the table does not have —
    // made Airtable reject the formula; the .catch turned that into null, so "no job card found"
    // and "the lookup is broken" were indistinguishable and the job-card rank of the precedence
    // chain never once fired.
    t('the job card lookup uses the field that exists',
      /\{JC Reference\} = /.test(ocrSrc), true);
    t('and no longer queries a field that does not',
      /\{Job Card Number\} = /.test(ocrSrc), false);

    // The old map named six fields that are not on the table, so even a working lookup would
    // have contributed nothing. These are read off the live schema.
    for (const f of ['JC Reference', 'Client Name', 'Site / Address', 'Job Type',
      'Issued Date', 'Started Project', 'Completed Project']) {
      t('the job card map reads "' + f + '"',
        Object.prototype.hasOwnProperty.call(OCRAPI.FROM_JOBCARD, f), true);
    }
    for (const f of ['Job Card Number', 'Site Address', 'Project Manager', 'Date Issued']) {
      t('the map no longer names the non-existent "' + f + '"',
        Object.prototype.hasOwnProperty.call(OCRAPI.FROM_JOBCARD, f), false);
    }
    // Title is the job description — "ADDITIONAL BATTERY" — not the site's name.
    t('the job title is never taken as the site name',
      OCRAPI.FROM_JOBCARD.Title, undefined);

    // A chosen job card decides the site outright: it links to its own Site Information record.
    t('a chosen job card is fetched by id', /function getJobCard\(/.test(ocrSrc), true);
    t('its linked site is used rather than a name match',
      /function siteForJobCard\(/.test(ocrSrc), true);
    t('the site link is read from the job card',
      /jobCard\.fields\['Site Information'\]/.test(ocrSrc), true);

    // A select only accepts its own options, and typecast is off.
    t('a select value is checked against the option list before it is proposed',
      /JC\.SELECTS\[to\] && !JC\.matchSelect\(to, v\)/.test(ocrSrc), true);

    // Documents filed against a job card.
    t('the upload route accepts a job card', /body\.jobCardId/.test(upSrc), true);
    t('reading a job card requires permission to see job cards',
      /P\.can\(perms, 'job_cards', 'view'\)/.test(upSrc), true);
    t('the link is written when the document is created, not patched on after',
      /'Job Card': \[jobCardId\]/.test(upSrc), true);
    // One file must not appear under both the site and the job card.
    t('a job-card document is not also added to the site list',
      /if \(siteId\) \{[\s\S]{0,400}?Documents: existing\.concat/.test(upSrc), true);
    t('a site or a job card is required, not a site specifically',
      /!siteId && !jobCardId/.test(upSrc), true);

    // The client sends one or the other, never both.
    t('the batch flow files against the job card when there is one',
      /\.\.\.\(JOBCARD \? \{ jobCardId: JOBCARD\.id \} : \{ siteId \}\)/.test(batchSrc2), true);
    // Linked from the site side: that needs site_information:edit, which the person already has.
    t('the site carries the link to the job card',
      /fields\['Job Cards'\] = \[JOBCARD\.id\]/.test(batchSrc2), true);

    // A search box that is rebuilt on every keystroke loses focus and drops characters.
    t('the job card search box is rendered once and then left alone',
      /if \(!\$\('#batchCardQ'\)\)/.test(batchSrc2), true);
    t('only the result list is redrawn while typing',
      /const list = \$\('#batchCardList'\)/.test(batchSrc2), true);
    // Building a formula out of typed text is how a search box becomes an injection bug.
    t('the search filters in the browser, not by formula',
      /filterByFormula[^\n]*CARDQ|CARDQ[^\n]*filterByFormula/.test(batchSrc2), false);

    // Both routes still exist; the original was not replaced.
    t('the original document-first route is still reachable',
      /data-act="siBatch"/.test(fs.readFileSync(
        path.join(__dirname, '..', 'public', 'index.html'), 'utf8')), true);
    t('and the job-card route sits beside it',
      /data-act="siFromJobCard"/.test(fs.readFileSync(
        path.join(__dirname, '..', 'public', 'index.html'), 'utf8')), true);
  }

  console.log('\n\x1b[1mWRITING A DOCUMENT RECORD\x1b[0m\n');

  // A field's TYPE decides whether it can be written at all, and two on the Documents table
  // cannot be. Getting this wrong refused 33 uploads in a row with "Cannot parse value", and
  // the second bad field was queued up behind the first.
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'siteinfo-upload.js'), 'utf8');
    const create = /at\.create\(docs\.baseId, docs\.tableId, \[\{([\s\S]*?)\}\]\)/.exec(src);
    t('the document create payload is found', !!create, true);
    const payload = create ? create[1] : '';

    // singleCollaborator: only an Airtable collaborator fits, and app users deliberately have
    // no Airtable account.
    t('"Uploaded By" is not written — it is a collaborator field',
      /^\s*'?Uploaded By'?\s*:/m.test(payload), false);
    // createdTime: Airtable computes it.
    t('"Date" is not written — Airtable computes it',
      /^\s*'?Date'?\s*:/m.test(payload), false);

    // The uploader is still recorded, in a field that can hold it.
    t('the uploader is recorded in Notes instead',
      /'Uploaded by ' \+ auth\.email/.test(payload), true);

    // Only these four remain, and each was checked against the live table schema.
    for (const f of ['Document Name', 'Document Type', 'Notes', 'Sensitivity']) {
      t('"' + f + '" is still written', new RegExp("'?" + f + "'?\\s*:").test(payload), true);
    }
  }

  // A summary that repeats one reason once per file is unreadable, and hides the failures that
  // differ. One line per distinct reason.
  {
    const modSrc = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'js', 'mod-siteinfo.js'), 'utf8');
    const fnSrc = /function groupFailures\(failures\) \{[\s\S]*?\n  \}/.exec(modSrc);
    t('the failure grouper exists', !!fnSrc, true);

    /* eslint-disable no-new-func */
    const groupFailures = new Function(
      'return (' + fnSrc[0].replace('function groupFailures', 'function') + ')')();

    const many = [];
    for (let i = 1; i <= 33; i++) many.push({ name: 'img' + i + '.jpeg', why: 'Same problem' });
    many.push({ name: 'odd.pdf', why: 'A different problem' });
    const out = groupFailures(many);

    t('33 identical failures collapse to one line', /33 files — Same problem/.test(out), true);
    t('the one different failure is still shown', /odd\.pdf — A different problem/.test(out), true);
    t('and the result is short enough to read', out.length < 200, true);
    t('a handful of files are still named individually',
      groupFailures([{ name: 'a.pdf', why: 'too large' }, { name: 'b.pdf', why: 'too large' }]),
      'a.pdf, b.pdf — too large');
  }

  console.log('\n\x1b[1mADMIN CLASSIFICATION OF UPLOADS\x1b[0m\n');

  // An admin may overrule the FICA classifier. That is the one route by which material the
  // classifier condemned can enter the module, so the gate, the audit and the one-way
  // asymmetry are all asserted rather than assumed.
  {
    const YES = { 'Can View Restricted Documents': true };
    const NO = { 'Can View Restricted Documents': false };

    // THE SAME DOUBLE GATE used for restricted personal data: role AND per-user flag.
    t('role flag and user flag together allow it', UP.mayClassify(YES, YES), true);
    t('role flag alone does not', UP.mayClassify(YES, NO), false);
    t('user flag alone does not', UP.mayClassify(NO, YES), false);
    t('neither flag does not', UP.mayClassify(NO, NO), false);
    t('a missing role does not', UP.mayClassify(null, YES), false);
    t('a missing user does not', UP.mayClassify(YES, null), false);
    // The gate is on the flags, never on what the role is CALLED.
    t('a role merely named Admin cannot override',
      UP.mayClassify({ 'Role Name': 'Admin / Director' }, YES), false);
  }
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'siteinfo-upload.js'), 'utf8');

    // Saying "this IS FICA" must need no privilege and must always refuse.
    t('a FICA classification is honoured before any permission check',
      src.indexOf("classification === 'fica'") < src.indexOf("mayClassify(auth.role"), false);
    t('a FICA classification refuses the upload',
      /classification === 'fica'[\s\S]{0,600}?return H\.fail\(res, 422/.test(src), true);

    // "This is NOT FICA" must require the gate.
    t('overruling a block requires the admin gate',
      /classification === 'operational' && isAdmin/.test(src), true);
    t('the gate is evaluated on the server from the session, not from the request',
      /isAdmin = mayClassify\(auth\.role, auth\.user\)/.test(src), true);
    t('the request cannot assert its own privilege',
      /body\.(isAdmin|admin|canOverride)/.test(src), false);

    // Every override is recorded, before the upload is attempted.
    t('an override writes its own audit entry',
      /denialReason: 'fica_override'/.test(src), true);
    t('the audit entry names the person and the verdict overruled',
      /classified operational by ' \+ auth\.email/.test(src), true);
    t('the override is also written onto the document record',
      /Classified operational by ' \+ auth\.email/.test(src), true);

    // A refusal tells the caller whether an override is even possible, so the UI can offer it
    // to the right people and no one else.
    t('a refusal reports whether this caller could override', /canOverride: isAdmin/.test(src), true);
  }
  {
    // The client gate must read the same flag the server checks.
    const modSrc = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'js', 'mod-siteinfo.js'), 'utf8');
    t('the upload queue asks whether the viewer may classify',
      /canViewRestricted === true/.test(modSrc), true);
    t('the classification control is only rendered to those people',
      /admin && r\.verdict !== 'ALLOWED'/.test(modSrc), true);
    t('a file marked FICA is never sent',
      /if \(r\.classification === 'fica'\) return false;/.test(modSrc), true);
    t('a blocked file is sent only on an explicit operational classification',
      /r\.classification === 'operational' && admin/.test(modSrc), true);
    t('the chosen classification travels with the upload',
      /classification: r\.classification \|\| ''/.test(modSrc), true);
    // A deliberate "this is FICA" must not be reported as an oversight.
    t('files held back for FICA are counted apart from unconfirmed ones',
      /heldFica/.test(modSrc) && /heldUnconfirmed/.test(modSrc), true);
  }

  console.log('\n\x1b[1mRATE-LIMIT GUARDS\x1b[0m\n');

  // sessionRateLimit/authRateLimit return a RESULT OBJECT — { ok, remaining, retryAfter } —
  // which is ALWAYS truthy. Two handlers wrote `const limited = H.sessionRateLimit(sid);
  // if (limited) return tooManyRequests(...)`, which refused 100% of requests with a 429 that
  // read as an ordinary rate limit. It shipped, and the first person to use the feature hit it
  // on their first click. Nothing in the suite could see it, so these assertions exist.
  {
    const first = H.sessionRateLimit('rl-probe-' + Date.now());
    t('a fresh session is allowed', first.ok, true);
    t('the result is an object, not a boolean', typeof first, 'object');
    t('and an allowed result is still truthy', !!first, true);
    t('it reports what is left', typeof first.remaining, 'number');
    t('an allowed result has no retry delay', first.retryAfter, 0);
  }
  {
    // Exhausting a bucket must flip .ok and give a delay to report.
    const key = 'rl-exhaust-' + Date.now();
    let last = null;
    for (let i = 0; i < 6; i++) last = H.rateLimit(key, 5, 60000);
    t('exceeding the limit is refused', last.ok, false);
    t('and says how long to wait', last.retryAfter > 0, true);
    t('a request under the limit is allowed', H.rateLimit('rl-ok-' + Date.now(), 5, 60000).ok, true);
  }
  {
    // Every handler must test .ok. A bare `if (rl)` is the bug above.
    const api = path.join(__dirname, '..', 'api');
    const files = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        if (full.endsWith('.js')) files.push(full);
      }
    };
    walk(api);

    let checked = 0;
    for (const f of files) {
      if (f.endsWith(path.join('_lib', 'http.js'))) continue;      // where they are defined
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/const\s+(\w+)\s*=\s*H\.(?:session|auth)RateLimit\([^)]*\);/g)) {
        checked++;
        const after = src.slice(m.index + m[0].length, m.index + m[0].length + 120);
        const name = path.relative(api, f).replace(/\\/g, '/');
        t(name + ' tests .ok on its rate-limit result',
          new RegExp('if\\s*\\(\\s*!\\s*' + m[1] + '\\.ok\\s*\\)').test(after), true);
        t(name + ' does not treat the result as a boolean',
          new RegExp('if\\s*\\(\\s*' + m[1] + '\\s*\\)').test(after), false);
      }
    }
    t('every rate-limit call site was checked', checked >= 9, true);
  }

  console.log('\n\x1b[1mOCR CONFIGURATION\x1b[0m\n');

  {
    t('the language data is vendored, not fetched at runtime',
      fs.existsSync(path.join(OCR.TESSDATA, 'eng.traineddata')), true);

    const src = fs.readFileSync(path.join(__dirname, '..', 'api', '_lib', 'ocr.js'), 'utf8');
    // Vercel's filesystem is read-only apart from /tmp; a cache written anywhere else fails.
    t('the OCR cache points at the only writable path', /cachePath:\s*'\/tmp'/.test(src), true);
    t('langPath points at the vendored directory', /langPath:\s*TESSDATA/.test(src), true);

    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
    for (const fn of ['api/siteinfo-ocr.js', 'api/siteinfo-upload.js']) {
      t(fn + ' bundles the language data',
        String((cfg.functions[fn] || {}).includeFiles || '').indexOf('tessdata') >= 0, true);
    }

    // The read route must not be able to change anything; writes go through the audited path.
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'siteinfo-ocr.js'), 'utf8');
    t('the OCR route never creates a record', /\bat\.create\s*\(/.test(routeSrc), false);
    t('the OCR route never updates a record', /\bat\.update\s*\(/.test(routeSrc), false);
    t('the OCR route never deletes a record', /\bat\.destroy\s*\(/.test(routeSrc), false);
  }

  await OCR.reset();
}


// ── the batch builder's wiring ──────────────────────────────────────────────
//
// A declarative dispatcher fails SILENTLY: a data-act with no matching ACTIONS entry, or an
// ACTIONS entry calling a method the module does not expose, produces a button that does
// nothing at all and no error anywhere. These are the assertions that would have caught that,
// asserted against the source rather than a browser.
{
  const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  const batchSrc = pub('js/siteinfo-batch.js');
  const modSrc = pub('js/mod-siteinfo.js');
  const htmlSrc = pub('index.html');

  const actionsBlock = /const ACTIONS = \{([\s\S]*?)\n  \};/.exec(modSrc);
  t('the ACTIONS table is found in the module', !!actionsBlock, true);
  const actionKeys = new Set(
    [...actionsBlock[1].matchAll(/^\s{4}([A-Za-z0-9_]+)\s*:/gm)].map((m) => m[1]));

  // Every data-act the batch modal renders must be dispatchable.
  const used = new Set([...batchSrc.matchAll(/data-act="([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
  for (const a of used) {
    t('data-act "' + a + '" has an ACTIONS entry', actionKeys.has(a), true);
  }
  t('the batch modal renders at least one action', used.size > 0, true);

  // ...and the toolbar button that opens it.
  t('the toolbar has a button that opens the batch builder',
    /data-act="siBatch"/.test(htmlSrc), true);
  t('that button is gated on site_information:create',
    /data-act="siBatch"[\s\S]{0,120}?data-requires="site_information:create"/.test(htmlSrc), true);
  t('the batch script is loaded by the page',
    /<script src="\/js\/siteinfo-batch\.js"><\/script>/.test(htmlSrc), true);
  t('it is loaded after the module it hangs off',
    htmlSrc.indexOf('siteinfo-batch.js') > htmlSrc.indexOf('mod-siteinfo.js'), true);

  // Every siBatch* ACTIONS entry must call a method TX.sitebatch actually exposes.
  const exposed = new Set();
  const exportBlock = /TX\.sitebatch = \{([\s\S]*?)\n  \};/.exec(batchSrc);
  t('TX.sitebatch is exported', !!exportBlock, true);
  for (const m of exportBlock[1].matchAll(/(?:^|[\s,{])([A-Za-z0-9_]+)\s*[:,]/g)) exposed.add(m[1]);
  // Shorthand entries (`open, close, read`) as well as `name: value` pairs.
  for (const m of exportBlock[1].matchAll(/\b([A-Za-z0-9_]+)\b(?=\s*[,:}])/g)) exposed.add(m[1]);

  for (const [, key, call] of modSrc.matchAll(
    /\n\s{4}(siBatch[A-Za-z0-9_]*):\s*[^\n]*?TX\.sitebatch\.([A-Za-z0-9_]+)\(/g)) {
    t('ACTIONS.' + key + ' calls TX.sitebatch.' + call + ', which exists',
      exposed.has(call), true);
  }

  // The dispatcher only fires for the event a control declares, defaulting to click. A text
  // input that forgot data-on="change" would never write the edited value back.
  const fieldControls = [...batchSrc.matchAll(/data-act="siBatchField"[^>]*/g)].map((m) => m[0]);
  t('the review table has editable controls', fieldControls.length > 0, true);
  for (const c of fieldControls) {
    t('a siBatchField control declares data-on="change"', /data-on="change"/.test(c), true);
    t('a siBatchField control passes its own value', /data-a2="@val"/.test(c), true);
  }

  // A CHECKBOX OR RADIO MUST DECLARE data-on="change".
  //
  // mod-siteinfo's click listener opens with `if (e.target.closest('input, select, textarea, a'))
  // return;`, so a click that starts on an input is never dispatched at all. A tick box relying
  // on the click default is therefore inert — and it fails silently: the box moves, the state
  // does not, and the record is written as though it had never been unticked. Found in a browser,
  // not here, which is why it is now asserted here.
  {
    // The markup is assembled from concatenated string fragments, so each control is examined as
    // the span of source running from its type attribute to the end of that element's fragment.
    const spans = [];
    const re = /type="(checkbox|radio)"/g;
    let m;
    while ((m = re.exec(batchSrc)) !== null) spans.push(batchSrc.slice(m.index, m.index + 320));

    t('the batch modal renders input-borne actions', spans.length >= 2, true);
    for (const span of spans) {
      const act = /data-act="([A-Za-z0-9_]+)"/.exec(span);
      t('an input-borne control declares an action', !!act, true);
      if (!act) continue;
      t('input action "' + act[1] + '" declares data-on (a click on an input is never dispatched)',
        /data-on="change"/.test(span), true);
    }
  }
  t('the equipment tick box SETS its state rather than toggling it',
    /data-act="siBatchEq"[\s\S]{0,200}?data-a2="@checked"/.test(batchSrc), true);
  t('the dispatcher understands @checked',
    /'@checked'\s*\?\s*el\.checked/.test(modSrc), true);
  t('no batch handler toggles a boolean it was not given',
    /take = !/.test(batchSrc), false);

  // The module must not have grown a second copy of the folder-walk rules.
  t('the batch builder reuses the module\'s file filter',
    /TX\.siteinfo\.files\.usable\(/.test(batchSrc), true);
  t('the batch builder reuses the module\'s folder walk',
    /TX\.siteinfo\.files\.walk\(/.test(batchSrc), true);
  t('the module exposes those helpers', /files: \{/.test(modSrc), true);

  // Writes must go through the audited routes, never straight to Airtable.
  t('the batch builder never names an Airtable host',
    /airtable\.com/.test(batchSrc), false);
  t('the batch builder writes through the proxy', /TX\.(create|update)\(/.test(batchSrc), true);
  t('uploads go through the classifying route',
    /'\/api\/siteinfo-upload'/.test(batchSrc), true);

  // A file in a dropped folder must not be auto-confirmed as operational: being in the folder
  // is not evidence, and the REVIEW verdict exists precisely so a person looks.
  // A file in a dropped folder is never pre-confirmed: being in the folder is not evidence.
  t('the batch run sends files unconfirmed',
    /confirmedOperational:\s*false/.test(batchSrc), true);
  {
    // `true` is legitimate in exactly ONE place — the second look, where a person has ticked
    // the file by hand after the server refused it. Anywhere else it would silently wave
    // through everything the classifier could not read.
    const retry = /async function retryRefused\(\)[\s\S]*?\n  \}/.exec(batchSrc);
    t('the second-look retry exists', !!retry, true);
    const outside = batchSrc.replace(retry ? retry[0] : '', '');
    t('nothing outside the second look pre-confirms a file',
      /confirmedOperational:\s*true/.test(outside), false);
    t('the second look confirms only what was ticked',
      /confirmedOperational:\s*true/.test(retry ? retry[0] : ''), true);
    // Overruling a BLOCK is a separate, explicit act, and only for a BLOCKED verdict.
    t('a blocked file is retried as an explicit classification',
      /classification:\s*r\.verdict === 'BLOCKED' \? 'operational' : ''/.test(batchSrc), true);
  }
  // The control the second look renders must be gated on the same flag the server checks.
  t('the second look asks whether the viewer may classify',
    /canViewRestricted\s*===\s*true/.test(batchSrc), true);
}


console.log('\n\x1b[1mFILING A DOCUMENT UNDER THE RIGHT TWO LABELS\x1b[0m\n');

{
  const U = L('siteinfo-upload.js');

  // The bug this replaced: every upload was written as 'Site Photos', so 348 spreadsheets,
  // BOMs and delivery notes across the two bases are currently filed as photographs.
  t('a BOM spreadsheet is not a photograph',
    U.documentType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Site'),
    'Other');
  t('nor is a PDF', U.documentType('application/pdf', 'Roof'), 'Other');
  t('nor a Word document',
    U.documentType('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Site'),
    'Other');
  t('nor a CSV', U.documentType('text/csv', 'Site'), 'Other');
  t('a JPEG is', U.documentType('image/jpeg', 'Roof'), 'Site Photos');
  t('and so is a HEIC off a phone', U.documentType('image/heic', 'Defect'), 'Site Photos');

  // Before and After are document types in their own right, and people expect to find them
  // there rather than under Site Photos.
  t('a Before photo is typed as one', U.documentType('image/jpeg', 'Before'), 'Before Photos');
  t('an After photo too', U.documentType('image/png', 'After'), 'After Photos');
  t('case does not matter', U.documentType('image/jpeg', 'aFtEr'), 'After Photos');
  t('but a Before SPREADSHEET is still not a photo',
    U.documentType('application/pdf', 'Before'), 'Other');

  t('a missing content type is not assumed to be an image',
    U.documentType('', 'Site'), 'Other');
  t('nor is a bare octet-stream',
    U.documentType('application/octet-stream', 'Site'), 'Other');

  // The category is a fixed list, so an unknown one is filed as Other rather than sent to
  // Airtable to be refused — a single-select rejects an option it does not have.
  t('a known category passes through', U.photoCategory('PV Panels'), 'PV Panels');
  t('case-insensitively', U.photoCategory('pv panels'), 'PV Panels');
  t('an unknown category becomes Other', U.photoCategory('Jibberish'), 'Other');
  t('so does an empty one', U.photoCategory(''), 'Other');
  t('and so does an injected one', U.photoCategory('Site"); DROP'), 'Other');
  t('every offered category is accepted by the server',
    U.PHOTO_CATEGORIES.every((c) => U.photoCategory(c) === c), true);

  // The client's list and the server's list must not drift: a category offered in the dropdown
  // and rejected on arrival would silently file everything as Other.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'mod-siteinfo.js'), 'utf8');
  const uiList = /const PHOTO_CATEGORIES = \[([\s\S]*?)\];/.exec(ui);
  t('the screen declares a category list', !!uiList, true);
  t('and it matches the server\u2019s exactly',
    (uiList ? uiList[1].match(/'([^']+)'/g).map((x) => x.slice(1, -1)) : []).join(),
    U.PHOTO_CATEGORIES.join());

  t('the category is written to its own field, not just into Notes',
    /'Photo Category': photoCategory\(category\)/.test(
      fs.readFileSync(path.join(__dirname, '..', 'api', 'siteinfo-upload.js'), 'utf8')), true);
  t('and only for images — a BOM has no photo subject',
    /isImage\(contentType\) \? \{ 'Photo Category'/.test(
      fs.readFileSync(path.join(__dirname, '..', 'api', 'siteinfo-upload.js'), 'utf8')), true);
  t('Document Type is no longer hard-coded',
    /'Document Type': 'Site Photos'/.test(
      fs.readFileSync(path.join(__dirname, '..', 'api', 'siteinfo-upload.js'), 'utf8')), false);
}

console.log('\n\x1b[1mRE-FILING PHOTOS AFTER THE UPLOAD\x1b[0m\n');

{
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'mod-siteinfo.js'), 'utf8');
  const code = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // Offered only to someone who may edit documents, and checked again by the proxy.
  t('the bar is gated on documents:edit', /TX\.can\('documents', 'edit'\)/.test(code), true);
  t('it writes through the audited proxy',
    /TX\.update\(base, 'documents', id, \{ \[PHOTO_CAT_FIELD\]: cat \}\)/.test(code), true);

  // Selection has to outlive the re-render, or it is useless past the first tick.
  t('selection lives in module scope, not the markup',
    /^\s*let PHOTO_SEL = new Set\(\);/m.test(code), true);
  t('and is cleared when a different site is opened',
    /PHOTO_SEL = new Set\(\);\s*\n\s*PHOTO_FILTER = 'all';\s*\n\s*view\('siDetail'\)/.test(code), true);

  // Controls that are inputs must declare change: the panel's click listener deliberately
  // ignores anything starting on an input or select, so a click-only tick box never fires.
  for (const act of ['siPhotoPick', 'siPhotoFilter']) {
    const tag = new RegExp('data-act="' + act + '" data-on="change"');
    t('"' + act + '" fires on change, not click', tag.test(ui), true);
  }
  t('the tick box passes its state rather than toggling',
    /data-act="siPhotoPick" data-on="change" data-a1="' \+ d\.id \+ '" data-a2="@checked"/.test(ui), true);

  // Every action is reachable.
  for (const act of ['siPhotoPick', 'siPhotoFilter', 'siPhotoAll', 'siPhotoNone', 'siPhotoApply']) {
    t('"' + act + '" is rendered and dispatchable',
      ui.includes('data-act="' + act + '"') && new RegExp('\\n\\s*' + act + ':').test(ui), true);
  }

  // A partial failure must not read as success — the recurring defect in this codebase.
  t('failures are collected, not swallowed', /failedIds\.add\(id\)/.test(code), true);
  t('and named back to the user', /did not save/.test(ui), true);
  t('what failed stays selected so a retry does not rewrite what worked',
    /PHOTO_SEL = failedIds;/.test(code), true);
  t('failures are matched by id, not by display name',
    /failed\.some\(\(f\) => f\.startsWith\(nameOf/.test(code), false);

  // "Nothing here" and "nothing matches the filter" are different facts.
  t('an empty filter result says so rather than claiming the site is empty',
    ui.includes("file(s) here match that ") && ui.includes('No photos or documents yet.'), true);

  // The count is spelled out before a write that touches many records at once.
  t('the button names how many it will change',
    /'Apply to ' \+ picked \+ ' selected<\/button>'/.test(code), true);
  t('and warns when some of them are hidden by the filter',
    /hidden by the filter/.test(ui), true);
}

console.log('\n\x1b[1mRECOVERING THE CATEGORY FROM THE OLD NOTES FORMAT\x1b[0m\n');

{
  const B = require(path.join(__dirname, '..', 'scripts', 'backfill-photo-category.js'));

  const N = (c, rest) => c + ' \u2014 ' + (rest || 'H68/pic10.jpeg \u2014 Uploaded by a@b.c');

  t('the category is read back out of Notes', B.categoryFromNotes(N('After')), 'After');
  t('including a two-word one', B.categoryFromNotes(N('PV Panels')), 'PV Panels');
  t('case-insensitively', B.categoryFromNotes(N('roof')), 'Roof');

  // IT MUST NOT GUESS. An empty cell says nobody knows; "Other" asserted over an unknown says
  // somebody decided, which is a worse thing to leave in a record.
  t('a note with no category yields nothing', B.categoryFromNotes('Uploaded by a@b.c'), null);
  t('an empty note yields nothing', B.categoryFromNotes(''), null);
  t('a missing note yields nothing', B.categoryFromNotes(undefined), null);
  t('a sentence that merely mentions a category is not mined',
    B.categoryFromNotes('Checked the roof and the inverter \u2014 all fine'), null);
  t('only the FIRST segment counts',
    B.categoryFromNotes('Uploaded by a@b.c \u2014 Roof'), null);

  // The plan, over records shaped like the real ones.
  const img = (notes, type, cat) => ({ id: 'rec1', fields: {
    File: [{ type: 'image/jpeg', filename: 'pic10.jpeg' }],
    Notes: notes, 'Document Type': type, ...(cat ? { 'Photo Category': cat } : {}) } });
  const sheet = (type) => ({ id: 'rec2', fields: {
    File: [{ type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: 'BOM.xlsx' }],
    Notes: 'Site \u2014 BOM.xlsx \u2014 Uploaded by a@b.c', 'Document Type': type } });

  const one = (rec) => (B.plan([rec])[0] || {}).patch || null;

  t('an uncategorised photo gets its category back',
    one(img(N('Roof'), 'Site Photos')), { 'Photo Category': 'Roof' });
  t('a spreadsheet filed as a photo is re-typed',
    one(sheet('Site Photos')), { 'Document Type': 'Other' });
  t('and gets no photo category, because it has no photo subject',
    'Photo Category' in (one(sheet('Site Photos')) || {}), false);
  t('a correctly typed spreadsheet is left alone', one(sheet('BOM Costings')), null);

  // NEVER over an existing value — including one a person has just fixed by hand.
  t('a category already set is never overwritten',
    one(img(N('Roof'), 'Site Photos', 'Defect')), null);

  t('a Before photo is also re-typed',
    one(img(N('Before'), 'Site Photos')),
    { 'Photo Category': 'Before', 'Document Type': 'Before Photos' });
  t('an After photo that is already typed right only gains its category',
    one(img(N('After'), 'After Photos')), { 'Photo Category': 'After' });
  t('a photo whose Notes say nothing is left for a person',
    one(img('Uploaded by a@b.c', 'Site Photos')), null);

  t('a record with no file at all is untouched',
    B.plan([{ id: 'r', fields: { Notes: N('Roof'), 'Document Type': 'Site Photos' } }]).length, 0);
}


console.log('\n\x1b[1mEVERY JOB CARD AND CLIENT PICKER IS SEARCHABLE\x1b[0m\n');
{
  // The point of this section is that it does NOT keep a list of the pickers. It finds them
  // the way a person would -- by reading the label above each dropdown -- so a job card
  // picker added next month is found by the same rule, and fails here until it is searchable.
  //
  // A <select> is searchable when its markup says so: data-search="job cards". pick.js scans
  // for that on load, and modules that build markup after load scan their own container.
  const fs = require('fs');
  const PUB = path.join(__dirname, '..', 'public');

  const selects = () => {
    const files = ['index.html'].concat(
      fs.readdirSync(path.join(PUB, 'js'))
        .filter((f) => f.endsWith('.js') && f !== 'pick.js')   // pick.js is the mechanism
        .map((f) => 'js/' + f));
    const out = [];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(PUB, rel), 'utf8');

      // <label for="x">  ->  its text, wherever in the file it sits
      const byFor = {};
      const lre = /<label[^>]*\bfor=["']([\w-]+)["'][^>]*>([\s\S]{0,80}?)<\/label>/g;
      let lm;
      while ((lm = lre.exec(src))) byFor[lm[1]] = lm[2];

      const sre = /<select\b([^>]*)>/g;
      let m;
      while ((m = sre.exec(src))) {
        const tag = m[1];
        const id = (/id=["']([\w-]+)["']/.exec(tag) || [])[1] || '';
        const aria = (/aria-label=["']([^"']*)["']/.exec(tag) || [])[1] || '';
        // A label written inline, immediately before the control.
        const near = (/<label[^>]*>([^<]{0,60})<\/label>\s*$/
          .exec(src.slice(Math.max(0, m.index - 100), m.index)) || [])[1] || '';
        out.push({
          where: rel + ':' + src.slice(0, m.index).split('\n').length,
          id,
          label: (byFor[id] || near || aria).replace(/<[^>]*>/g, '').trim(),
          declared: /\bdata-search=/.test(tag),
        });
      }
    }
    return out;
  };

  const all = selects();
  // "All statuses", "Filter by category" and the like narrow a list that is already on screen.
  const pickers = all.filter((s) => /job\s*card|client/i.test(s.label)
    && !/^all\b|filter/i.test(s.label));

  t('the scan reads real markup, not an empty file', all.length > 8, true);
  t('every job card and client picker was found', pickers.map((s) => s.id).sort(), ['mJC', 'njc-cli', 'om-jcsel']);
  t('and every one of them is searchable',
    pickers.filter((s) => !s.declared).map((s) => s.where + ' #' + s.id), []);

  // The mechanism has to be loaded before anything can use it.
  const page = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  t('pick.js is served with the page', /<script src="\/js\/pick\.js"><\/script>/.test(page), true);
  const pick = fs.readFileSync(path.join(PUB, 'js', 'pick.js'), 'utf8');
  t('it upgrades what the markup declared, on its own',
    /querySelectorAll\('select\[data-search\]'\)/.test(pick), true);
  t('including lists already on the page at load',
    /DOMContentLoaded[\s\S]{0,40}scan\(\)/.test(pick), true);
  t('the matcher ignores spacing and punctuation, so "easygreen" finds "Easy Green"',
    /replace\(\/\[\^a-z0-9\]\+\/g, ''\)/.test(pick), true);
  t('and every typed word has to match, which makes their order irrelevant',
    /if \(hay\.indexOf\(ts\[i\]\) < 0\) return false;/.test(pick), true);
  // The visit modal is built in JavaScript after the page has loaded, so nothing scans it for
  // free; the module scans the markup it has just built.
  const sched = fs.readFileSync(path.join(PUB, 'js', 'mod-scheduler.js'), 'utf8');
  t('the visit modal scans the markup it builds', /TX\.pick\.scan\(wrap\)/.test(sched), true);
}

console.log('\n' + '='.repeat(70));
if (fail === 0) console.log(`\x1b[32m\x1b[1m  ALL ${pass} ASSERTIONS PASSED\x1b[0m`);
else {
  console.log(`\x1b[31m\x1b[1m  ${fail} FAILED\x1b[0m, ${pass} passed\n`);
  failures.forEach((f) => console.log('  \x1b[31m*\x1b[0m ' + f));
}
console.log('='.repeat(70) + '\n');
process.exit(fail === 0 ? 0 : 1);

})().catch((e) => { console.error('\x1b[31mSuite crashed:\x1b[0m', e); process.exit(1); });
