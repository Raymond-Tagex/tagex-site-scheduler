#!/usr/bin/env node
// Splitting FICA pages out of a scanned PDF — node test/verify-fica-split.js
//
// Drives the REAL api/fica-docs.js handler with Airtable, the session, the audit writer and
// fetch stubbed, and real OCR on the fixtures, so nothing here needs a token or touches a base.
// Also checks the PDF writer against the server's own PDF reader, and the screen's rules.
//
// What is proved:
//   - classify writes nothing and never returns the text it read
//   - filing, indexing and opening need the role permission AND both flags, every time
//   - a page that could not be read is never cleared: the screen starts it as FICA
//   - FICA bytes reach the browser only from open, and never as a link
//   - every restricted read is audited

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const api = (m) => path.join(__dirname, '..', 'api', m);
const pub = (m) => path.join(__dirname, '..', 'public', m);

process.env.AUTH_MODE = 'session';
process.env.AIRTABLE_PAT = process.env.AIRTABLE_PAT || 'pat-test';

// ── the stubbed Airtable ───────────────────────────────────────────────────
const RECORDS = {};
let WRITES = [];
let LISTS = [];
const airtable = {
  AirtableError: class extends Error {},
  COMPUTED_TYPES: new Set(),
  async get(baseId, tableId, id) {
    if (!RECORDS[id]) throw Object.assign(new Error('not found'), { status: 404 });
    return JSON.parse(JSON.stringify(RECORDS[id]));
  },
  async list(baseId, tableId, opts) {
    LISTS.push({ baseId, tableId, opts });
    return Object.values(RECORDS).filter((r) => r.fields['Site Record ID']);
  },
  async create(baseId, tableId, rows) {
    WRITES.push({ op: 'create', baseId, tableId, rows });
    const rec = { id: 'recFICA0000000001', fields: rows[0] };
    RECORDS[rec.id] = rec;
    return [rec];
  },
  async update(baseId, tableId, id, fields) { WRITES.push({ op: 'update', id, fields }); return { id, fields }; },
  async destroy() { throw new Error('nothing is ever deleted'); },
  async fieldMaps() { return { idToName: {}, nameToId: { File: 'fldpDV0Sdvvb8a6XW' } }; },
};

let WHO = null;
const session = {
  async authenticate() { return WHO; },
  clientIp: () => '127.0.0.1',
  userAgent: () => 'verify-fica-split',
  mustEnrolMfa: () => false,
  markSessionTouchedRestricted: async () => {},
};

let AUDIT = [];
const audit = {
  audit: (e) => { AUDIT.push(e); },
  auditNow: async (e) => { AUDIT.push(e); },
  auditFieldChanges: async () => {},
};

const stub = (file, exports) => {
  const id = require.resolve(api(file));
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
stub('_lib/airtable.js', airtable);
stub('_lib/session.js', session);
stub('_lib/audit.js', audit);

// fetch: Airtable's content API (attach) and an attachment's download link (open).
let FETCHES = [];
const PAGE_PDF = Buffer.from('%PDF-1.4\n% one filed page\n%%EOF\n', 'latin1');
global.fetch = async (url, opts) => {
  FETCHES.push({ url: String(url), opts });
  if (/content\.airtable\.com/.test(url)) return { ok: true, json: async () => ({}) };
  return { ok: true, arrayBuffer: async () => PAGE_PDF.buffer.slice(PAGE_PDF.byteOffset, PAGE_PDF.byteOffset + PAGE_PDF.length) };
};

const P = require(api('_lib/permissions.js'));
const T = require(api('_lib/tables.js'));
const handler = require(api('fica-docs.js'));
const W = require(pub('js/pdfwrite.js'));
const IMG = require(api('_lib/pdfimages.js'));

// ── people ─────────────────────────────────────────────────────────────────
// The seeded Admin rule for restricted_personal, verbatim (test/roles.fixture.json).
const RESTRICTED = { view: true, create: true, edit: true, delete: true, export: false,
  sensitivity_max: 'Restricted', require_user_flag: true, audit_every_read: true, list_view: false };
const SITE_VIEW = { site_information: { view: true, create: true, edit: true, delete: false, export: false } };

function signedIn(email, perms, roleFlag, userFlag) {
  return {
    ok: true, email, userRecordId: 'recUSER0000000000', sid: 'sid-' + email,
    user: { Email: email, Status: 'Active', 'Can View Restricted Documents': userFlag },
    role: { 'Role Name': 'Test', 'Can View Restricted Documents': roleFlag },
    perms: P.effectivePermissions(JSON.stringify(perms), null),
  };
}
const admin = signedIn('admin@tagexenergy.co.za', { ...SITE_VIEW, restricted_personal: RESTRICTED }, true, true);
// The admin role, but this person was never given the flag.
const adminNoFlag = signedIn('noflag@tagexenergy.co.za', { ...SITE_VIEW, restricted_personal: RESTRICTED }, true, false);
// A role whose rule was edited to drop require_user_flag: the endpoint must still ask for both.
const looseRule = signedIn('loose@tagexenergy.co.za',
  { ...SITE_VIEW, restricted_personal: Object.assign({}, RESTRICTED, { require_user_flag: false }) }, true, false);
const tech = signedIn('tech@tagexenergy.co.za', SITE_VIEW, false, false);
const nobody = signedIn('nobody@tagexenergy.co.za', {}, false, false);

function reset() {
  for (const k of Object.keys(RECORDS)) delete RECORDS[k];
  RECORDS.recSITE0000000001 = { id: 'recSITE0000000001', fields: { 'Site Name': 'H68 BOERDERYE' } };
  WRITES = []; LISTS = []; AUDIT = []; FETCHES = [];
}

async function call(who, body) {
  WHO = who;
  const res = {
    code: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    send(b) { this.body = JSON.parse(b); return this; },
  };
  await handler({ method: 'POST', body, headers: {}, url: '/api/fica-docs' }, res);
  return res;
}

// ── assertions ─────────────────────────────────────────────────────────────
let failed = 0;
let passed = 0;
function t(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++; else failed++;
  console.log((ok ? '  \x1b[32mpass\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m  ') + label
    + (ok ? '' : '\n        expected ' + JSON.stringify(expected) + '\n        got      ' + JSON.stringify(actual)));
}

const jpegSize = (b) => {
  let i = 2;
  while (i < b.length) {
    const m = b[i + 1]; const len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xc3) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
};

(async () => {
  const bank = fs.readFileSync(path.join(__dirname, 'fixtures', 'bank-statement.jpg'));
  const card = fs.readFileSync(path.join(__dirname, 'fixtures', 'jobcard.jpg'));

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n\x1b[1mTHE PDF WRITER\x1b[0m\n');
  {
    const sb = jpegSize(bank); const sc = jpegSize(card);
    const pdf = Buffer.from(W.fromJpegs([
      { bytes: new Uint8Array(bank), ...sb }, { bytes: new Uint8Array(card), ...sc }]));
    const s = pdf.toString('latin1');
    t('it is a PDF', s.startsWith('%PDF-1.4\n') && s.trimEnd().endsWith('%%EOF'), true);
    t('with one page per picture', /\/Type \/Pages \/Count 2 /.test(s), true);
    const xref = Number(/startxref\n(\d+)\n%%EOF/.exec(s)[1]);
    t('startxref points at the cross-reference table', s.slice(xref, xref + 5), 'xref\n');
    const offs = [...s.slice(xref).matchAll(/(\d{10}) 00000 n \n/g)].map((m) => Number(m[1]));
    t('and every entry points at its own object', offs.every((o, i) => s.startsWith((i + 1) + ' 0 obj', o)), true);
    const read = IMG.extractPageImages(pdf, 10, false);
    t('the server reads both pages back out of it', read.images.length, 2);
    t('byte for byte, nothing re-encoded', [Buffer.compare(read.images[0].data, bank), Buffer.compare(read.images[1].data, card)], [0, 0]);
    t('a landscape page is laid out landscape', /MediaBox \[0 0 842\.00 /.test(s), true);
    let threw = '';
    try { W.fromJpegs([{ bytes: new Uint8Array(Buffer.from('%PDF-1.4')), width: 10, height: 10 }]); } catch (e) { threw = e.message; }
    t('anything but a JPEG is refused', threw, 'Every page must be a JPEG.');
    threw = '';
    try { W.fromJpegs([]); } catch (e) { threw = e.message; }
    t('and so is nothing at all', threw, 'A PDF needs at least one page.');
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n\x1b[1mA VERDICT PER PAGE\x1b[0m\n');
  {
    const V = handler.pageVerdict;
    t('a bank statement is FICA', V('BANK STATEMENT\nAccount number 62000000000 Branch code 250655').verdict, 'fica');
    t('an identity number is FICA', V('Identity number: 8001015009087').verdict, 'fica');
    t('a few stray words are not a reading', V('Signed  date  ').verdict, 'unsure');
    t('nothing at all is not a reading either', V('').verdict, 'unsure');
    t('a page of ordinary text is other', V('Inverter commissioning. Strings 1 to 6 tested. '.repeat(5)).verdict, 'other');
    t('an empty CoC field is not identity data', V('Certificate of Compliance. Registered person ID No: ____ '.repeat(4)).verdict, 'other');
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n\x1b[1mCLASSIFY READS, WRITES NOTHING\x1b[0m\n');
  {
    reset();
    const r = await call(tech, { op: 'classify', pages: [
      { page: 1, content: card.toString('base64') },
      { page: 2, content: bank.toString('base64') },
    ] });
    t('anyone who may import sites may ask', r.code, 200);
    const v = Object.fromEntries((r.body.pages || []).map((p) => [p.page, p.verdict]));
    t('the bank statement (real OCR) reads as FICA', v[2], 'fica');
    t('the job card (real OCR) does not', v[1] !== 'fica', true);
    t('the text read is never sent back', JSON.stringify(r.body).includes('"text"'), false);
    t('nothing was written', WRITES.length, 0);
    t('a technician is told they may not file FICA pages', r.body.mayFile, false);
    const a = await call(admin, { op: 'classify', pages: [{ page: 1, content: card.toString('base64') }] });
    t('an admin holding both flags is told they may', a.body.mayFile, true);
    const nf = await call(adminNoFlag, { op: 'classify', pages: [{ page: 1, content: card.toString('base64') }] });
    t('the admin role without the personal flag may not', nf.body.mayFile, false);
    const lr = await call(looseRule, { op: 'classify', pages: [{ page: 1, content: card.toString('base64') }] });
    t('nor can a rule that dropped require_user_flag', lr.body.mayFile, false);
    const no = await call(nobody, { op: 'classify', pages: [{ page: 1, content: card.toString('base64') }] });
    t('someone who may not see sites may not ask', no.code, 403);
    const many = await call(tech, { op: 'classify', pages: [1, 2, 3, 4].map((page) => ({ page, content: 'eA==' })) });
    t('more pages than one request can read in time are refused', many.code, 400);
    const empty = await call(tech, { op: 'classify', pages: [{ page: 1, content: '' }] });
    t('an empty page is unsure, never other', empty.body.pages[0].verdict, 'unsure');
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n\x1b[1mFILING: THE DOUBLE GATE, EVERY TIME\x1b[0m\n');
  const createBody = { op: 'create', siteBase: 'CI', siteId: 'recSITE0000000001', sourceFile: 'site pack.pdf',
    pageCount: 12, pages: [3, 7], detection: [{ page: 3, verdict: 'fica' }, { page: 7, verdict: 'unsure' }],
    siteName: 'A NAME THE CALLER MADE UP' };
  {
    for (const [who, label] of [[tech, 'a technician'], [adminNoFlag, 'the admin role without the personal flag'],
      [looseRule, 'a role whose rule dropped require_user_flag']]) {
      reset();
      const r = await call(who, createBody);
      t(label + ' cannot file', [r.code, WRITES.length], [403, 0]);
      t('  and the refusal is audited', AUDIT.some((e) => e.result === 'Denied' && e.action === 'Create'), true);
    }

    reset();
    const r = await call(admin, createBody);
    t('an admin holding both flags can', r.code, 200);
    const row = WRITES[0] && WRITES[0].rows[0];
    t('into FICA Documents, in O&M', [WRITES[0].baseId, WRITES[0].tableId], [T.BASES.OM, 'tbl5z9m0gfMV6QPXB']);
    t('for a site in another base, named by base and id', [row['Site Base'], row['Site Record ID']], ['CI', 'recSITE0000000001']);
    t('with the site name read from the site, not taken from the caller', row['Site Name'], 'H68 BOERDERYE');
    t('which pages, of how many', row.Pages, '3, 7 of 12');
    t('who filed it', row['Filed By (App)'], 'admin@tagexenergy.co.za');
    t('a page a person moved to FICA says so', /Page 7: read as unsure, confirmed FICA by admin@/.test(row.Detection), true);
    t('and it is live', row['Record Status'], 'Active');
    t('the filing is audited', AUDIT.some((e) => e.action === 'Create' && e.result === 'Allowed' && e.recordId === 'recFICA0000000001'), true);

    reset();
    const bad = await call(admin, { ...createBody, siteId: "x' , TRUE(), '" });
    t('a site id that is not a record id is refused before anything runs', [bad.code, WRITES.length], [400, 0]);
    const none = await call(admin, { ...createBody, pages: [] });
    t('so is filing no pages', none.code, 400);
    const gone = await call(admin, { ...createBody, siteId: 'recNOSUCHSITE0001' });
    t('and a site that does not exist', [gone.code, WRITES.length], [404, 0]);
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n\x1b[1mATTACHING A PAGE\x1b[0m\n');
  {
    reset();
    await call(admin, createBody);
    const onePage = Buffer.from(W.fromJpegs([{ bytes: new Uint8Array(bank), ...jpegSize(bank) }])).toString('base64');
    FETCHES = []; AUDIT = [];
    const r = await call(admin, { op: 'attach', id: 'recFICA0000000001', page: 3, content: onePage });
    t('the filer adds a page', r.code, 200);
    t('through Airtable\'s content API, onto that record', /content\.airtable\.com\/v0\/app0tq4y9wH10h6Up\/recFICA0000000001\//.test(FETCHES[0] && FETCHES[0].url), true);
    t('named for the source and the page', JSON.parse(FETCHES[0].opts.body).filename, 'site pack — page 3.pdf');
    t('and it is audited', AUDIT.some((e) => e.action === 'Update' && e.result === 'Allowed'), true);

    const notPdf = await call(admin, { op: 'attach', id: 'recFICA0000000001', page: 3, content: bank.toString('base64') });
    t('a page that is not a PDF is refused', notPdf.code, 400);

    const other = signedIn('other-admin@tagexenergy.co.za', { ...SITE_VIEW, restricted_personal: RESTRICTED }, true, true);
    FETCHES = [];
    const theirs = await call(other, { op: 'attach', id: 'recFICA0000000001', page: 4, content: onePage });
    t('nobody else can add pages to it', [theirs.code, FETCHES.length], [404, 0]);
    RECORDS.recFICA0000000001.fields['Record Status'] = 'Deleted';
    const retired = await call(admin, { op: 'attach', id: 'recFICA0000000001', page: 4, content: onePage });
    t('nor can anyone add to a retired record', retired.code, 404);
    const tk = await call(tech, { op: 'attach', id: 'recFICA0000000001', page: 4, content: onePage });
    t('and a technician cannot attach at all', tk.code, 403);
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n\x1b[1mFINDING AND OPENING THEM LATER\x1b[0m\n');
  {
    reset();
    RECORDS.recFICA0000000001 = { id: 'recFICA0000000001', fields: {
      'Source File': 'site pack.pdf', Pages: '3, 7 of 12', 'Site Base': 'CI', 'Site Record ID': 'recSITE0000000001',
      'Filed By (App)': 'admin@tagexenergy.co.za', 'Filed At': '2026-10-22T20:00:00.000Z', 'Record Status': 'Active',
      Detection: 'Page 3: read as fica',
      File: [{ url: 'https://v5.airtableusercontent.com/secret-link', filename: 'site pack — page 3.pdf', type: 'application/pdf' }],
    } };

    const ix = await call(admin, { op: 'index', siteBase: 'CI', siteId: 'recSITE0000000001' });
    t('an admin can see what is filed against a site', ix.code, 200);
    t('by an exact match the server writes', LISTS[0] && LISTS[0].opts.filterByFormula,
      "AND({Site Base} = 'CI', {Site Record ID} = 'recSITE0000000001', {Record Status} != 'Deleted')");
    t('the index carries no link to a file', JSON.stringify(ix.body).includes('airtableusercontent'), false);
    t('just the count of pages', ix.body.entries[0].files, 1);
    t('and looking is itself a restricted view, audited', AUDIT.some((e) => e.action === 'Restricted Document Viewed'), true);
    const ixTech = await call(tech, { op: 'index', siteBase: 'CI', siteId: 'recSITE0000000001' });
    t('a technician cannot', ixTech.code, 403);
    const ixNf = await call(adminNoFlag, { op: 'index', siteBase: 'CI', siteId: 'recSITE0000000001' });
    t('nor can the admin role without the flag', ixNf.code, 403);

    AUDIT = [];
    const op = await call(admin, { op: 'open', id: 'recFICA0000000001', n: 0 });
    t('an admin can open a page', op.code, 200);
    t('as the bytes', Buffer.from(op.body.content, 'base64').toString('latin1').startsWith('%PDF-'), true);
    t('never as Airtable\'s link, which anyone holding it could use for hours',
      JSON.stringify(op.body).includes('airtableusercontent'), false);
    t('and the opening is audited against the record',
      AUDIT.some((e) => e.action === 'Restricted Document Viewed' && e.recordId === 'recFICA0000000001'), true);
    const opNf = await call(adminNoFlag, { op: 'open', id: 'recFICA0000000001', n: 0 });
    t('the admin role without the flag cannot open it', opNf.code, 403);
    RECORDS.recFICA0000000001.fields['Record Status'] = 'Deleted';
    const opGone = await call(admin, { op: 'open', id: 'recFICA0000000001', n: 0 });
    t('a retired record does not open', opGone.code, 404);
    const unknownOp = await call(admin, { op: 'list' });
    t('there is no list operation', unknownOp.code, 400);
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n\x1b[1mTHE SCREEN\x1b[0m\n');
  {
    const src = fs.readFileSync(pub('js/siteinfo-split.js'), 'utf8').replace(/\r\n/g, '\n');
    const TX = { $: () => null, esc: (s) => String(s), can: () => false, me: () => null };
    const ctx = vm.createContext({ TX, window: {}, URL, Blob, File: class {}, btoa, atob, console });
    vm.runInContext(src, ctx);
    const S = TX.sitesplit;
    t('page runs read the way a person would say them', S.ranges([1, 2, 3, 6, 8, 9]), '1–3, 6, 8–9');
    const pg = (page, size) => ({ page, blob: { size } });
    t('the other pages go on in parts under the upload limit',
      S.parts([pg(1, 2), pg(2, 2), pg(3, 2), pg(4, 1)], 4).map((g) => g.map((p) => p.page)), [[1, 2], [3, 4]]);
    t('a page the reader could not make out starts as FICA',
      /choice: v\.verdict === 'other' \? 'other' : 'fica'/.test(src), true);
    t('and so does a page that was never read', /if \(!p\.choice\) Object\.assign\(p, \{ verdict: 'unsure'[^)]*choice: 'fica' \}\)/.test(src), true);
    t('the screen talks to no other endpoint', [...src.matchAll(/TX\.request\('([^']+)'/g)].every((m) => m[1] === '/api/fica-docs'), true);
    t('and never to Airtable', /airtable\.com/.test(src), false);
    t('someone who cannot file is told the pages will not be uploaded',
      /if \(!MAYFILE\) \{\s*return h \+ '<div class="si-msg warn">These pages will not be uploaded/.test(src), true);
    t('leaving with FICA pages unfiled asks first', /window\.confirm\(left \+ ' FICA page/.test(src), true);
    t('the other pages are handed to the ordinary import, not uploaded from here',
      /TX\.sitebatch\.open\(mode, files\)/.test(src), true);

    const batch = fs.readFileSync(pub('js/siteinfo-batch.js'), 'utf8').replace(/\r\n/g, '\n');
    t('which takes them as if they had been dropped', /function open\(mode, files\)[\s\S]*?if \(files && files\.length\) add\(files\)/.test(batch), true);

    const mod = fs.readFileSync(pub('js/mod-siteinfo.js'), 'utf8').replace(/\r\n/g, '\n');
    const acts = /const ACTIONS = \{([\s\S]*?)\n  \};/.exec(mod)[1];
    const used = new Set([...src.matchAll(/data-act="(si[A-Za-z]+)"/g)].map((m) => m[1]));
    for (const a of ['siSplit', 'siFicaIndex']) used.add(a);
    t('every button it draws is dispatchable', [...used].filter((a) => !new RegExp('\\n\\s*' + a + ':').test(acts)), []);
    t('the FICA list is offered only to someone with both',
      /TX\.can\('restricted_personal', 'view'\) && TX\.me\(\) && TX\.me\(\)\.user\.canViewRestricted/.test(mod), true);

    const html = fs.readFileSync(pub('index.html'), 'utf8');
    const at = (s) => html.indexOf('<script src="/js/' + s + '"></script>');
    t('the page loads the writer before the screen that uses it',
      at('pdfpages.js') > 0 && at('pdfpages.js') < at('pdfwrite.js') && at('pdfwrite.js') < at('siteinfo-split.js'), true);

    const vj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
    const fn = vj.functions['api/fica-docs.js'];
    t('the function ships the OCR language data it reads with', !!fn && /tessdata/.test(fn.includeFiles), true);
  }

  console.log('\n' + '='.repeat(70));
  console.log(failed
    ? `\n\x1b[31m\x1b[1m  ${failed} FAILED\x1b[0m, ${passed} passed`
    : `\n\x1b[32m\x1b[1m  ALL ${passed} ASSERTIONS PASSED\x1b[0m`);
  console.log('='.repeat(70) + '\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Suite crashed:', e); process.exit(1); });
