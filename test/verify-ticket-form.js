#!/usr/bin/env node
// The printed ticket form, the copy filed in Documents, and the scheduler raising both.
//
// What is checked:
//   - the ticket form carries the job card's head, every option the ticket screens offer, the
//     values the ticket holds, the terms word for word, and nothing off the page;
//   - an empty ticket still prints a usable blank form;
//   - filing a form refuses what the role may not do, never files twice, never leaves an empty
//     document looking like a real one, and links the copy to its job card;
//   - every place that raises a job card or a ticket produces its form.
//
// Airtable, the audit log and the upload are stubbed: these are the controls, so they are
// asserted directly rather than through a live write.

'use strict';

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const LIB = path.join(__dirname, '..', 'api', '_lib');

// ── stubs, installed before anything requires the real modules ─────────────
const calls = { create: [], update: [], findOne: [], audit: [], upload: [] };
const stub = {
  existing: null,          // what findOne returns
  uploadOk: true,
};
function install(file, exports) {
  const id = path.join(LIB, file);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
install('airtable.js', {
  findOne: async (baseId, tableId, formula, fields) => {
    calls.findOne.push({ baseId, tableId, formula, fields });
    return stub.existing;
  },
  create: async (baseId, tableId, rows) => {
    calls.create.push({ baseId, tableId, rows });
    return [{ id: 'recDOC0000000001', fields: rows[0] }];
  },
  update: async (baseId, tableId, id, fields) => { calls.update.push({ id, fields }); return {}; },
  fieldMaps: async () => ({ nameToId: { File: 'fldMwlk40BSwBuDiO' }, idToName: {} }),
});
install('audit.js', { auditNow: async (e) => { calls.audit.push(e); }, audit: () => {} });
global.fetch = async (url, opts) => {
  calls.upload.push({ url, body: JSON.parse(opts.body) });
  return stub.uploadOk
    ? { ok: true, json: async () => ({}) }
    : { ok: false, status: 422, json: async () => ({ error: { message: 'INVALID_FILE' } }) };
};
process.env.AIRTABLE_PAT = process.env.AIRTABLE_PAT || 'test-not-a-token';

const TF = require(path.join(LIB, 'ticketform.js'));
const J = require(path.join(LIB, 'jobcardform.js'));
const FF = require(path.join(LIB, 'formfile.js'));

let pass = 0;
let fail = 0;
const failures = [];
function t(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (ok) pass += 1; else { fail += 1; failures.push(`${label}\n      expected ${e}\n      actual   ${a}`); }
  console.log(`  ${ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}`);
}

/** Every drawn string, decoded as cp1252 (WinAnsi). Same reader as verify-jobcard-form.js. */
function pages(bytes) {
  const raw = Buffer.from(bytes).toString('latin1');
  const out = [];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const from = m.index + m[0].length;
    const to = raw.indexOf('endstream', from);
    if (to < 0) continue;
    let body;
    try { body = zlib.inflateSync(Buffer.from(raw.slice(from, to), 'latin1')); } catch (e) { continue; }
    const s = body.toString('latin1');
    const runs = [];
    const dec = (buf) => new TextDecoder('windows-1252').decode(buf);
    for (const g of s.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) runs.push(dec(Buffer.from(g[1], 'latin1')));
    for (const g of s.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
      runs.push(dec(Buffer.from(g[1].replace(/\s+/g, ''), 'hex')));
    }
    if (runs.length) out.push(runs);
  }
  return out;
}
const flatten = (p) => p.map((x) => x.join('\n')).join('\n');
function yPositions(bytes) {
  const raw = Buffer.from(bytes).toString('latin1');
  const ys = [];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const from = m.index + m[0].length;
    const to = raw.indexOf('endstream', from);
    if (to < 0) continue;
    let body;
    try { body = zlib.inflateSync(Buffer.from(raw.slice(from, to), 'latin1')).toString('latin1'); }
    catch (e) { continue; }
    for (const g of body.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)) ys.push(Number(g[2]));
  }
  return ys;
}

const FULL = {
  ticket: {
    'Ticket Ref': 'TKT-2026-0048',
    'Source Channel': 'WhatsApp', 'Source Detail': 'Client WhatsApp group',
    'Reported By': 'Christopher Maitin', 'Reported At': '2026-10-14T06:30:00.000Z',
    'Fault Category': 'Inverter Fault', Subject: 'Inverter showing F23 grid fault',
    Description: 'Inverter tripped overnight. Display shows F23.',
    'Asset / Inverter': 'Sunsynk 8kW SN 2208123', 'Error Code': 'F23',
    Priority: 'High', Status: 'Visit Scheduled', 'Created By': 'raymond@tagexenergy.co.za',
  },
  ticketCreated: '2026-10-14T07:02:00.000Z',
  jobcard: {
    'JC Reference': 'OM-2026-0169/MAINT/TE', 'Client Name': ['SUB 139 - Christopher Maitin'],
    'Site / Address': ['12 Mill Road, Midrand'], 'Owner Category': 'SUB-RES',
  },
  visits: [{ start: '2026-10-16T07:00:00.000Z', tech: 'Geoff Oswin',
    subject: 'Inverter fault-finding', status: 'Scheduled' }],
  spares: [{ code: 'SUN-8K-FAN', desc: 'Inverter cooling fan', unit: 'ea', req: 1 }],
  generatedBy: 'raymond@tagexenergy.co.za',
};

(async () => {
  const bytes = await TF.ticketFormPdf(FULL);
  const p = pages(bytes);
  const all = flatten(p);
  const flat = all.replace(/\s+/g, ' ');

  console.log('\n\x1b[1mTHE TICKET FORM IS THE JOB CARD’S FORMAT\x1b[0m\n');
  const SECTIONS = ['SERVICE TICKET', 'HOW THE ISSUE WAS REPORTED', 'FAULT DETAILS', 'SITE VISITS',
    'SPARES REQUIRED / ISSUED', 'RESOLUTION', 'SIGNATURES', 'Service Call-Out Terms and Conditions',
    'CLIENT ACCEPTANCE OF TERMS AND CONDITIONS'];
  t('every section is on the sheet', SECTIONS.filter((h) => !all.includes(h)), []);
  // The same head as the job card, so the two sheets read alike.
  const HEAD = ['Project Type:', 'Ticket Number:', 'Job Card Number:', 'Project Reference Number:',
    'Client Name:', 'Site Address:', 'Actual Date Issue Reported:', 'Ticket Raised By:',
    'Actual Date Ticket Created:', 'Logged By:'];
  t('with the job card’s head', HEAD.filter((l) => !all.includes(l)), []);
  t('and the company line', all.includes(J.CO.name), true);

  {
    // Both forms' section bands are set larger than the paper's 8.5pt, as the business asked --
    // the ticket first, then the job card -- and at the same size, so the two read alike.
    const sizeOf = (b, word) => {
      const raw = Buffer.from(b).toString('latin1');
      const hex = Buffer.from(word, 'latin1').toString('hex').toUpperCase();
      for (const m of raw.matchAll(/stream\r?\n/g)) {
        const from = m.index + m[0].length;
        let body;
        try { body = zlib.inflateSync(Buffer.from(raw.slice(from, raw.indexOf('endstream', from)), 'latin1')).toString('latin1'); }
        catch (e) { continue; }
        const g = new RegExp('/\\S+ ([\\d.]+) Tf\\s+[\\d.]+ TL\\s+1 0 0 1 [\\d.]+ [\\d.]+ Tm\\s*<' + hex + '> Tj').exec(body);
        if (g) return Number(g[1]);
      }
      return null;
    };
    const jcBytes = await J.jobCardFormPdf({ jobcard: {} });
    const H = J.SECTION_HEADING;
    t('the ticket’s section headings are set at the section size',
      ['FAULT DETAILS', 'SITE VISITS', 'RESOLUTION'].map((h) => sizeOf(bytes, h)), [H, H, H]);
    t('and so are the job card’s',
      ['PRE-VISIT NOTES', 'ON-SITE INSPECTION', 'STOCK, MATERIAL & LOGISTICS ALLOCATION', 'SUMMARY OF COSTS',
        'SIGNATURES FOR APPROVALS'].map((h) => sizeOf(jcBytes, h)), [H, H, H, H, H]);
    t('which is larger than the paper’s 8.5pt labels', H > 8.5, true);
    t('and smaller than a logistics section’s own title, which sits under a band', H < 12, true);
    t('and the logo heads the ticket too', /\/Subtype \/Image/.test(Buffer.from(bytes).toString('latin1')), true);
    t('with its job card named in the letterhead', all.includes('Job Card: OM-2026-0169/MAINT/TE'), true);
  }

  console.log('\n\x1b[1mWHAT THE TICKET KNOWS IS PRINTED\x1b[0m\n');
  t('its reference and its job card',
    ['TKT-2026-0048', 'OM-2026-0169/MAINT/TE'].filter((x) => !all.includes(x)), []);
  t('the client and the site, from the job card',
    ['SUB 139 - Christopher Maitin', '12 Mill Road, Midrand'].filter((x) => !all.includes(x)), []);
  t('who reported it and how', ['Christopher Maitin', 'Client WhatsApp group']
    .filter((x) => !all.includes(x)), []);
  // Reported 08:30 SAST, logged 09:02 SAST: both are printed, and in SAST.
  t('when it was reported, in SAST', all.includes('14/10/2026 08:30'), true);
  t('and when it was logged', all.includes('14/10/2026 09:02'), true);
  t('the fault itself', ['Inverter showing F23 grid fault', 'Sunsynk 8kW SN 2208123', 'F23',
    'Inverter tripped overnight. Display shows F23.'].filter((x) => !flat.includes(x)), []);
  t('the visit booked for it', ['Geoff Oswin', 'Inverter fault-finding'].filter((x) => !all.includes(x)), []);
  t('and the spare it needs', ['SUN-8K-FAN', 'Inverter cooling fan'].filter((x) => !all.includes(x)), []);

  console.log('\n\x1b[1mEVERY OPTION THE TICKET SCREENS OFFER IS A BOX\x1b[0m\n');
  t('every channel', TF.CHANNELS.filter((c) => !all.includes(c)), []);
  t('every fault category', TF.CATEGORIES.filter((c) => !all.includes(c)), []);
  t('every priority', TF.PRIORITIES.filter((c) => !all.includes(c)), []);
  t('every project type', J.PROJECT_TYPES.filter((c) => !all.includes(c)), []);
  t('no ballot-box character, which WinAnsi would drop', all.includes('☐'), false);
  {
    // The lists must be the ones the screens write, or a ticket prints with nothing ticked.
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'mod-scheduler.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const cats = /const TKT_CATEGORIES = \[([^\]]*)\]/.exec(js)[1]
      .split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
    t('the categories match the scheduler’s', cats, TF.CATEGORIES);
    const chans = [...(/const TKT_CHANNELS = \[([\s\S]*?)\];/.exec(js)[1]
      .matchAll(/\['([^']+)',/g))].map((m) => m[1]);
    t('the channels match the scheduler’s', chans, TF.CHANNELS);
    const pris = [...html.matchAll(/data-act="omSelPri" data-a1="@el" data-a2="([^"]+)"/g)].map((m) => m[1]);
    t('the priorities match the New Ticket form’s', pris, TF.PRIORITIES);
  }

  console.log('\n\x1b[1mTHE TERMS ARE THE JOB CARD’S, WORD FOR WORD\x1b[0m\n');
  t('every clause', J.TERMS.filter((c) => !flat.includes(c.replace(/\s+/g, ' '))), []);

  console.log('\n\x1b[1mNOTHING RUNS OFF THE SHEET\x1b[0m\n');
  t('every line is inside the page', yPositions(bytes).filter((y) => y < 20 || y > 820), []);
  t('every page says which page it is',
    p.every((page) => page.some((r) => /^Page \d+ of \d+$/.test(r))), true);
  t('and carries the ticket reference', p.every((page) => page.some((r) => r.includes('TKT-2026-0048'))), true);
  t('it is more than one page', (await PDFDocument.load(bytes)).getPageCount() > 1, true);

  console.log('\n\x1b[1mAN EMPTY TICKET STILL PRINTS A USABLE FORM\x1b[0m\n');
  {
    const blank = flatten(pages(await TF.ticketFormPdf({ ticket: {} })));
    t('every section', SECTIONS.filter((h) => !blank.includes(h)), []);
    t('and every label of the head', HEAD.filter((l) => !blank.includes(l)), []);
    t('no value is invented', /undefined|NaN|\[object/.test(blank), false);
    t('Cost Recoverable is offered both ways for a pen',
      /Cost Recoverable from Client:\nYes\nNo/.test(blank), true);
  }

  console.log('\n\x1b[1mTHE FILENAME\x1b[0m\n');
  t('is the reference, "form" and the date', TF.ticketFormFilename('TKT-2026-0048'),
    'TKT-2026-0048-form-' + new Date().toISOString().slice(0, 10) + '.pdf');

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n\x1b[1mFILING A FORM: WHAT IS REFUSED\x1b[0m\n');
  const auth = (docs) => ({ email: 'pm@tagexenergy.co.za', perms: docs ? { documents: docs } : {} });
  const ctx = { userEmail: 'pm@tagexenergy.co.za', module: 'job_cards' };
  const base = { base: 'OM', ctx, jobCardId: 'recJC00000000001', name: 'Job Card form — OM-2026-0169',
    filename: 'JC-OM-2026-0169.pdf', bytes: Buffer.from('%PDF-1.7 test'), notes: 'n' };
  const reset = () => { Object.keys(calls).forEach((k) => { calls[k] = []; }); stub.existing = null; stub.uploadOk = true; };

  reset();
  let r = await FF.fileForm({ ...base, auth: auth(null), sensitivity: 'Internal' });
  t('a role with no Documents access files nothing', [r.ok, r.reason, calls.create.length], [false, 'module_denied', 0]);
  t('and the refusal is audited', calls.audit.map((a) => [a.result, a.module]), [['Denied', 'documents']]);

  reset();
  // Warehouse / Stores and Technician / Field: they may read Internal documents, not add them.
  r = await FF.fileForm({ ...base, auth: auth({ view: true, sensitivity_max: 'Internal' }), sensitivity: 'Internal' });
  t('read-only Documents access files nothing', [r.ok, r.reason, calls.create.length], [false, 'op_denied', 0]);

  reset();
  r = await FF.fileForm({ ...base, auth: auth({ create: true, sensitivity_max: 'Internal' }), sensitivity: 'Confidential' });
  t('a form above the role’s cap is not filed', [r.ok, r.reason, calls.create.length], [false, 'sensitivity', 0]);

  reset();
  r = await FF.fileForm({ ...base, jobCardId: '', auth: auth({ create: true, sensitivity_max: 'Confidential' }), sensitivity: 'Internal' });
  t('a form with no job card to hang off is not filed', [r.ok, r.reason, calls.create.length], [false, 'no_job_card', 0]);

  reset();
  stub.existing = { id: 'recDOCEXISTING01' };
  r = await FF.fileForm({ ...base, auth: auth({ create: true, sensitivity_max: 'Confidential' }), sensitivity: 'Internal' });
  t('a form already filed is not filed again', [r.ok, r.reason, r.documentId, calls.create.length],
    [false, 'already_filed', 'recDOCEXISTING01', 0]);
  t('and "already filed" means a live copy with a file in it',
    /\{Record Status\} != 'Deleted'/.test(calls.findOne[0].formula) && /LEN\(\{File\}/.test(calls.findOne[0].formula), true);
  t('matched on the exact name, quoted', calls.findOne[0].formula.includes('{Document Name} = "Job Card form — OM-2026-0169"'), true);

  console.log('\n\x1b[1mFILING A FORM: WHAT IS WRITTEN\x1b[0m\n');
  reset();
  r = await FF.fileForm({ ...base, auth: auth({ create: true, sensitivity_max: 'Confidential' }), sensitivity: 'Confidential' });
  t('it is filed', [r.ok, r.documentId], [true, 'recDOC0000000001']);
  const row = calls.create[0] && calls.create[0].rows[0];
  t('in the O&M Documents table', [calls.create[0].baseId, calls.create[0].tableId],
    ['app0tq4y9wH10h6Up', 'tbljdfGLoiHlrdzfs']);
  t('linked to its job card when it is created', row['Job Card'], ['recJC00000000001']);
  t('named, typed and classified', [row['Document Name'], row['Document Type'], row.Sensitivity],
    ['Job Card form — OM-2026-0169', 'Other', 'Confidential']);
  t('no collaborator or created-time field is written', ['Uploaded By', 'Date'].filter((k) => k in row), []);
  t('the PDF goes to the File field through the content API',
    calls.upload[0].url, 'https://content.airtable.com/v0/app0tq4y9wH10h6Up/recDOC0000000001/fldMwlk40BSwBuDiO/uploadAttachment');
  t('as the same bytes, base64', Buffer.from(calls.upload[0].body.file, 'base64').toString(), '%PDF-1.7 test');
  t('and as a PDF', calls.upload[0].body.contentType, 'application/pdf');
  t('the filing is audited as allowed', calls.audit.map((a) => [a.action, a.result]), [['Create', 'Allowed']]);
  t('nothing was retired', calls.update.length, 0);

  reset();
  r = await FF.fileForm({ ...base, base: 'RES', auth: auth({ create: true, sensitivity_max: 'Internal' }), sensitivity: 'Internal' });
  t('a RES job card’s form goes to the RES base', calls.create[0].baseId, 'appY81aumN7ocxMNC');

  reset();
  stub.uploadOk = false;
  r = await FF.fileForm({ ...base, auth: auth({ create: true, sensitivity_max: 'Internal' }), sensitivity: 'Internal' });
  t('an upload Airtable refuses is reported', [r.ok, r.reason], [false, 'upload_failed']);
  t('with Airtable’s reason', r.detail.includes('INVALID_FILE'), true);
  // Rule 10: never deleted. Retired, so it neither lists as a real document nor blocks a retry.
  t('the empty record is retired, not deleted', calls.update[0] && calls.update[0].fields['Record Status'], 'Deleted');
  t('and the failure is audited', calls.audit.map((a) => a.result), ['Denied']);

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n\x1b[1mEVERY PLACE THAT RAISES ONE PRODUCES ITS FORM\x1b[0m\n');
  {
    // LF, whatever the checkout: body() ends a function at '\n}\n', which on CRLF finds nothing,
    // so the slice ran to the end of the file and found other functions' 'file:'.
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'mod-scheduler.js'), 'utf8')
      .replace(/\r\n/g, '\n');
    const body = (name) => {
      const i = js.indexOf('async function ' + name + '(');
      return i < 0 ? '' : js.slice(i, js.indexOf('\n}\n', i));
    };
    t('a new job card', /omAutoForm\('jc',rec\.id\)/.test(body('omSubmitNewJC')), true);
    t('a ticket from the New Ticket form', /omAutoForm\('tkt',rec\.id\)/.test(body('omSubmit')), true);
    t('a ticket raised by booking a visit, filed without a download',
      /omAutoForm\('tkt',rec\.id,\{ download:false \}\)/.test(body('omRaiseTicketForVisit')), true);
    t('and a visit-raised ticket whose form failed says so',
      js.includes("ticketProblems.push('its ticket form: '+r.formError)"), true);
    // Only creation files a copy. A reprint is a reprint.
    const auto = body('omAutoForm');
    t('the automatic form asks the server to file it', /file:true/.test(auto), true);
    t('a reprint of a job card does not', /file:/.test(body('omJcForm')), false);
    t('nor a reprint of a ticket form', /file:/.test(body('omTktForm')), false);
    t('the ticket form can be printed from the ticket', js.includes('data-act="omTktForm"'), true);
    t('and the button is wired', js.includes("add('omTktForm'"), true);
    // A role without the print right is told, not shown an error.
    t('a role that may not print is told why, not shown a failure',
      /if\(!TX\.can\(jc\?'job_cards':'tickets','export'\)\)/.test(auto), true);

    const jcApi = fs.readFileSync(path.join(__dirname, '..', 'api', 'jobcard-form.js'), 'utf8');
    const tkApi = fs.readFileSync(path.join(__dirname, '..', 'api', 'ticket-report.js'), 'utf8');
    t('the server files only when asked in so many words',
      [/if \(body\.file === true\)/.test(jcApi), /if \(body\.file === true\)/.test(tkApi)], [true, true]);
    t('and the ticket form sits behind the same export check as the report',
      tkApi.indexOf("P.can(auth.perms, 'tickets', 'export')") < tkApi.indexOf('body.form === true'), true);
    // Still one endpoint each: the Hobby plan allows twelve functions.
    t('no new serverless function was added',
      fs.readdirSync(path.join(__dirname, '..', 'api')).filter((f) => f.endsWith('.js')).length, 7);
  }

  console.log('\n' + '='.repeat(70));
  if (fail) {
    console.log(`\x1b[31m\x1b[1m  ${fail} FAILED\x1b[0m, ${pass} passed\n`);
    failures.forEach((f) => console.log('  \x1b[31m*\x1b[0m ' + f));
    console.log('='.repeat(70));
    process.exit(1);
  }
  console.log(`\x1b[32m\x1b[1m  ALL ${pass} ASSERTIONS PASSED\x1b[0m`);
  console.log('='.repeat(70) + '\n');
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
