#!/usr/bin/env node
// The printed job card, against the form it reproduces.
//
// SOURCE OF TRUTH: TAGEX JOB CARD TEMPLATE SEP2026.docx. Every heading and every clause of the
// terms below was taken from that file. If the paper form changes, these assertions are what
// should fail first.
//
// What is checked: that every section of the form is on the sheet, that the values given are
// printed, that the terms are reproduced word for word, that nothing runs off the page, and
// that a job card with nothing filled in still prints as a usable blank form — which is the
// thing somebody carries to site.

'use strict';

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const F = require(path.join(__dirname, '..', 'api', '_lib', 'jobcardform.js'));

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

/** Every drawn string, per page. Decoded as cp1252, which is what WinAnsi is — decoding as
 *  latin1 silently drops the curly quotes the terms are full of. */
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

/** Every y a piece of text was drawn at, to catch anything off the sheet. */
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
  jobcard: {
    'JC Reference': 'OM-2026-0169/MAINT/TE',
    'Director Decision': 'Approved', 'Director Decision By': 'A de Jager',
    'Director Decision Date': '2026-09-30',
    'Entity Name': 'Tagex Energy', 'Ticket Raised By': 'Maurice Kruger',
    'Suggested Site Actions': ['Maintenance', 'Warranty Work'],
    'Suggested Site Actions — Other': 'Meter swap',
    'Operational Classification': 'Standard Operational Activity',
    'Pre-Visit Notes': 'Prepaid meter reading incorrectly since the storm.',
    'General Notes': 'Client available weekday mornings only.',
    'Pre-Site Scope of Work': 'Inspect the prepaid meter and the DB feed.',
    'Actual Site Scope of Work': 'Replaced the meter and re-tested.',
    'Site Inspection Conducted By': 'Geoff Oswin', 'Date of Inspection': '2026-09-28',
    'Inspection Confirmations': ['Electrical Infrastructure Verified', 'Photographic Evidence Attached'],
    'Supplier Quotes Attached': true, 'Technician / Installer': 'Geoff Oswin - Jetnix',
    'Started Project': '2026-09-20', 'Site Visit Date': '2026-09-28',
    'Actual Installation Date': '2026-09-29', 'Completed Project': '2026-09-29',
    'Delay Explanation': 'Waited two days for the meter.',
    'Requested By': 'Raymond Fraser', 'Requested By Date': '2026-09-30',
    'Final Sign-Off By': 'A de Jager', 'Final Sign-Off Date': '2026-09-30',
    'Issued Date': '2026-09-30',
    'Client Acceptance Name': 'Christopher Maitin',
    'Client Acceptance Email': 'chris@example.co.za',
  },
  client: 'SUB 139 - Christopher Maitin',
  site: '12 Mill Road, Midrand',
  responsible: 'Adriaan de Jager',
  ticketRefs: ['TKT-2026-0048'],
  bomCount: 1,
  costing: {
    'Capital Cost': 3604.86, 'Capital Cost (Warehouse)': 3000, 'Capital Cost (Supplier)': 604.86,
    'DC Cost': 9478.63, 'DC Cost (Supplier)': 9478.63,
    'Material Cost': 2415.65,
    // Entered only as a split: no Labour Cost figure of its own.
    'Labour Cost (Warehouse)': 1400, 'Labour Cost (Supplier)': 700,
    // Deliberately wrong, and deliberately left wrong: Costing's own Total is a formula over
    // the category fields, so a row entered only as a split is missing from it. The grid must
    // print what its own rows add up to, not this.
    Total: 11083.49,

    // Transportation: a real trip, so the block has something to print.
    'Travel Required': true,
    'Vehicle Allocation': 'Hilux GP 42-KL-99',
    'Driver Name': 'Sipho Ndlovu',
    'Fuel Rate per km': 4.35,
    'Distance to Site (km)': 186,
    'Total Km': 372,
    'Site Visit Km': 186,
    'Toll Fees Required': true,
    'Toll Fees': 128.5,
    'Transport Cost': 1746.7,
    'Travel Approved by Management': true,

    // Accommodation: two nights for three. Approved by Management is deliberately NOT set --
    // the box must print empty rather than ticked No.
    'Accommodation Required': true,
    'Accommodation Establishment': 'Protea Hotel Bethlehem',
    'Accommodation Personnel': 3,
    'Accommodation From': '2026-09-28',
    'Accommodation To': '2026-09-30',
    'Accommodation Nights': 2,
    'Accommodation Cost per Night': 980,
    'Accommodation Cost': 2940,

    // Labour has no total of its own -- it is the Warehouse / Supplier split above.
    'Labour Required': true,
    'Labour Location': 'Bethlehem Substation',
    'Labour Days': 2,
    'Staff Names': 'S Ndlovu\nT Mokoena\nJ van Wyk',
    'Labour Cost per Day': 1050,

    // Rental: nothing was recorded at all. The block must still print, with ruled lines.
  },
  visits: [
    { start: '2026-09-28T07:00:00.000Z', subject: 'Prepaid meter inspection', status: 'Completed' },
    { start: '2026-10-06T07:00:00.000Z', subject: 'Replace meter', status: 'Scheduled' },
  ],
  generatedBy: 'raymond@tagexenergy.co.za',
};

(async () => {
  const bytes = await F.jobCardFormPdf(FULL);
  const p = pages(bytes);
  const all = flatten(p);
  const flat = all.replace(/\s+/g, ' ');

  console.log('\n\x1b[1mEVERY SECTION OF THE PAPER FORM IS ON THE SHEET\x1b[0m\n');
  const SECTIONS = ['JOB CARD', 'PRE-VISIT NOTES', 'SUGGESTED SITE ACTIONS',
    'OPERATIONAL CLASSIFICATION', 'GENERAL NOTES', 'PRE-SITE VISIT — SCOPE OF WORK',
    'ON-SITE INSPECTION', 'ACTUAL SITE VISIT — SCOPE OF WORK',
    'STOCK, MATERIAL & LOGISTICS ALLOCATION', 'UNFORSEEN COSTS', 'SUMMARY OF COSTS',
    'RESPONSIBLE PERSONNEL', 'TIMELINE CONTROL', 'SIGNATURES FOR APPROVALS',
    'Service Call-Out Terms and Conditions', 'CLIENT ACCEPTANCE OF TERMS AND CONDITIONS'];
  t('none is missing', SECTIONS.filter((h) => !all.includes(h)), []);

  console.log('\n\x1b[1mAND EVERY LABEL THE FORM ASKS FOR\x1b[0m\n');
  const LABELS = ['Entity Name:', 'Job Card Number:', 'Ticket Number:',
    'Project Reference Number:', 'Client Name:', 'Site Address:', 'Actual Date of Issue:',
    'Ticket Raised By:', 'Site Inspection Conducted By:', 'Date of Inspection:',
    'BOM Attached', 'Supplier Quotes Attached', 'Transportation Details',
    'Accommodation Details', 'Labour Details', 'Rental Details', 'Project Manager:',
    'Technician / Installer:', 'Planned Start Date:', 'Site Visit Date:',
    'Actual Installation Date:', 'Actual Completion Date:', 'Requested By:', 'Procurement:',
    'Operational / Executive Approval:', 'Financial Oversight Approval:',
    'Final Completion Sign-Off:', 'Company (if applicable):', 'Contact Number:',
    'Email Address:', 'Client Signature:'];
  t('none is missing', LABELS.filter((l) => !all.includes(l)), []);

  console.log('\n\x1b[1mWHAT THE RECORD KNOWS IS PRINTED\x1b[0m\n');
  t('the reference', all.includes('OM-2026-0169/MAINT/TE'), true);
  t('the client and the site',
    ['SUB 139 - Christopher Maitin', '12 Mill Road, Midrand'].filter((x) => !all.includes(x)), []);
  t('the ticket it came from', all.includes('TKT-2026-0048'), true);
  t('who raised it and who is on it',
    ['Maurice Kruger', 'Adriaan de Jager', 'Geoff Oswin - Jetnix'].filter((x) => !all.includes(x)), []);
  t('the written sections', all.includes('Prepaid meter reading incorrectly since the storm.'), true);
  t('and the dates, in the form South Africa writes them', all.includes('30/09/2026'), true);

  console.log('\n\x1b[1mTHE TICK BOXES ARE DRAWN, NOT TYPED\x1b[0m\n');
  // U+2610 is not in WinAnsi: drawn as text it would vanish and leave a form with no boxes.
  t('no ballot-box character is anywhere on the sheet', all.includes('☐'), false);
  t('every entity option is offered', F.ENTITIES.filter((e) => !all.includes(e)), []);
  t('every suggested action', F.ACTIONS.filter((a) => !all.includes(a)), []);
  t('every inspection confirmation', F.CONFIRMS.filter((c) => !all.includes(c)), []);

  console.log('\n\x1b[1mTHE COST GRID MATCHES THE COSTING TABLE\x1b[0m\n');
  t('every category on the paper is a row',
    F.COST_ROWS.map(([label]) => label).filter((l) => !all.includes(l)), []);
  t('the figures come through', ['R 3604.86', 'R 9478.63'].filter((x) => !all.includes(x)), []);

  console.log('\n\x1b[1mTHE COST GRID CARRIES ALL THREE COLUMNS\x1b[0m\n');
  {
    t('Warehouse and Supplier are headings on the grid',
      ['Warehouse', 'Supplier', 'Total Cost'].filter((h) => !all.includes(h)), []);
    t('a split is printed in both columns',
      ['R 3000.00', 'R 604.86'].filter((x) => !all.includes(x)), []);

    // The rule, stated on the sheet and checked here.
    t('a category with its own figure uses it as the row total',
      F.costRow(FULL.costing, 'Capital Cost').total, 3604.86);
    // Labour was entered only as a split; a row that printed nothing would hide R2 100.
    t('a category entered only as a split is added up',
      F.costRow(FULL.costing, 'Labour Cost').total, 2100);
    t('and a category with nothing at all stays empty',
      F.costRow(FULL.costing, 'Rental Cost').total, null);

    // THE DEFECT THIS REPLACES. The grid used to print eight paper rows against Costing's own
    // Total, which includes Material Cost -- so the column did not add up.
    t('Materials is a row, because Costing has that money and the total counts it',
      all.includes('Materials'), true);
    t('and its figure is printed', all.includes('R 2415.65'), true);

    // The grand total must be the sum of what is printed above it.
    const expected = F.COST_ROWS
      .map(([, key]) => F.costRow(FULL.costing, key).total || 0)
      .reduce((a, b) => a + b, 0);
    t('TOTAL COST is the sum of the rows', all.includes('R ' + expected.toFixed(2)), true);
    t('which for this job card is', expected.toFixed(2), '22285.84');
    // Costing's Total formula misses the split-only row; printing it would understate by R2100.
    t('and not Costing’s own Total, which misses the split-only row',
      all.includes('R 11083.49'), false);
    t('and the sheet says how the totals are worked out',
      /TOTAL COST is the sum of the rows above/.test(flat), true);
  }

  console.log('\n\x1b[1mTRAVEL, ACCOMMODATION, LABOUR AND RENTAL PRINT WHAT WAS RECORDED\x1b[0m\n');
  {
    t('all four blocks are headed', ['Transportation Details', 'Accommodation Details',
      'Labour Details', 'Rental Details'].filter((h) => !all.includes(h)), []);
    t('every label the four blocks ask for is on the sheet',
      F.LOGISTICS.flatMap(([, , , , rows]) => rows.map(([l]) => l))
        .filter((l) => !all.includes(l)), []);

    // THE POINT OF THE CHANGE. These four blocks used to print as ruled blanks.
    t('the vehicle and the driver are printed',
      ['Hilux GP 42-KL-99', 'Sipho Ndlovu'].filter((x) => !all.includes(x)), []);
    t('the establishment, the dates and the nights are printed',
      ['Protea Hotel Bethlehem', '28/09/2026', '30/09/2026'].filter((x) => !all.includes(x)), []);
    t('and all three staff names',
      ['S Ndlovu', 'T Mokoena', 'J van Wyk'].filter((x) => !all.includes(x)), []);
    t('a Yes / No field prints Yes, not "true"', all.includes('true'), false);

    // NO SECOND FIGURE FOR THE SAME MONEY. Each block's total is the field the cost grid
    // already prints, so the two cannot disagree on a sheet somebody signs.
    t("the block totals are the cost grid's own fields",
      F.LOGISTICS.map(([, , , totalKey]) => totalKey),
      ['Transport Cost', 'Accommodation Cost', 'Labour Cost', 'Rental Cost']);
    t('and each one is a row of the cost grid', F.LOGISTICS.map(([, , , k]) => k)
      .filter((k) => !F.COST_ROWS.some(([, key]) => key === k)), []);
    t('the travel total reads the same in both places',
      (all.match(/R 1746\.70/g) || []).length, 2);
    // Labour has no figure of its own, so its block total is the split added up -- the same
    // R2 100.00 the grid prints, not a blank line beside three men and two days.
    t('and a block with only a split still shows its total',
      (all.match(/R 2100\.00/g) || []).length, 2);

    // An unanswered checkbox is not a No. Airtable drops an unchecked box from the record, so
    // ticking No would put a management refusal on paper that nobody actually gave.
    t('nothing is ever printed as a ticked No', /: *No\b/.test(flat), false);
    t('a block with nothing recorded still prints its questions',
      ['Rental Details', 'Equipment:', 'Fixed Cost:'].filter((x) => !all.includes(x)), []);

    // DRIFT. A field provisioned onto Costing that the form never prints is a field somebody
    // fills in and never sees again.
    const script = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'provision-costing-detail.js'), 'utf8');
    const want = (script.match(/^\s*(?:check|text|long|date|num|rand)\('([^']+)'/gm) || [])
      .map((m) => m.replace(/^[^']*'/, '').replace(/'$/, ''));
    const printed = new Set(F.LOGISTICS.flatMap(([, req, app, , rows]) =>
      [req, app].concat(rows.map(([, key]) => key))));
    t('the provisioned fields are all accounted for', want.length, 34);
    t('and every one of them is printed', want.filter((f) => !printed.has(f)), []);
    t('and the form prints nothing that was never provisioned',
      [...printed].filter((f) => !want.includes(f)), []);
  }

  console.log('\n\x1b[1mTHE VISIT TABLES COME FROM SITE VISITS\x1b[0m\n');
  t('a visit already made is listed', all.includes('Prepaid meter inspection'), true);
  t('and one still to come', all.includes('Replace meter'), true);

  console.log('\n\x1b[1mTHE TERMS ARE REPRODUCED WORD FOR WORD\x1b[0m\n');
  // Wrapped across lines on the page, so compare with the whitespace taken out.
  const missing = F.TERMS.filter((clause) => !flat.includes(clause.replace(/\s+/g, ' ')));
  t('every clause of the template is on the sheet', missing, []);
  t('including the curly quotes, which WinAnsi does carry',
    flat.includes('client’s premises'), true);
  t('and the quoted phrase in clause 2.1', flat.includes('“not operational”'), true);

  console.log('\n\x1b[1mNOTHING RUNS OFF THE SHEET\x1b[0m\n');
  const ys = yPositions(bytes);
  t('every line is drawn inside the page', ys.filter((y) => y < 20 || y > 820), []);
  const doc = await PDFDocument.load(bytes);
  t('and it is more than one page', doc.getPageCount() > 1, true);
  t('every page says which page it is',
    p.every((page) => page.some((r) => /^Page \d+ of \d+$/.test(r))), true);
  t('and carries the reference', p.every((page) => page.some((r) => r.includes('OM-2026-0169'))), true);

  console.log('\n\x1b[1mAN EMPTY JOB CARD STILL PRINTS A USABLE FORM\x1b[0m\n');
  // The thing somebody actually carries to site: every heading, and a ruled line under each
  // question. A layout that skipped empty fields would hand them a page with nowhere to write.
  const blank = await F.jobCardFormPdf({ jobcard: { 'JC Reference': 'OM-2026-0170/MAINT/TE' } });
  const blankText = flatten(pages(blank));
  t('every section is still there', SECTIONS.filter((h) => !blankText.includes(h)), []);
  t('and every label', LABELS.filter((l) => !blankText.includes(l)), []);
  t('the terms are still in full', F.TERMS.filter((c) => !blankText.replace(/\s+/g, ' ').includes(c.replace(/\s+/g, ' '))), []);
  t('nothing runs off that sheet either', yPositions(blank).filter((y) => y < 20 || y > 820), []);
  t('and no value is invented', /undefined|NaN|\[object/.test(blankText), false);
  t('the four logistics blocks still have a line under every question',
    F.LOGISTICS.flatMap(([name, , , , rows]) => [name].concat(rows.map(([l]) => l)))
      .filter((l) => !blankText.includes(l)), []);
  // Yes and No are the labels beside the boxes and are always drawn — a blank form is
  // meant to be ticked by hand. Both must still be offered against every block.
  t('and each block still offers a Yes to tick by hand',
    (blankText.match(/Yes/g) || []).length >= F.LOGISTICS.length * 2, true);
  t('and a No beside it',
    (blankText.match(/No/g) || []).length >= F.LOGISTICS.length * 2, true);

  console.log('\n\x1b[1mTHE FILENAME\x1b[0m\n');
  t('is the reference and the date',
    F.formFilename('OM-2026-0169/MAINT/TE'),
    'JC-OM-2026-0169-MAINT-TE-' + new Date().toISOString().slice(0, 10) + '.pdf');
  t('and survives a job card with no reference',
    /^JC-job-card-\d{4}-\d{2}-\d{2}\.pdf$/.test(F.formFilename('')), true);

  console.log('\n\x1b[1mTHE TWO SCREENS CARRY THE SAME FIELDS THE FORM PRINTS\x1b[0m\n');
  {
    const fs = require('fs');
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'mod-scheduler.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

    // Every field id the provisioning script created, as the app knows them.
    const jcf = {};
    const block = js.slice(js.indexOf('const JCF = {'), js.indexOf('};', js.indexOf('const JCF = {')));
    for (const m of block.matchAll(/(JC_[A-Z]+):'(fld[A-Za-z0-9]+)'/g)) jcf[m[1]] = m[2];
    t('the app knows all 35 of the new fields', Object.keys(jcf).length, 35);

    // THE FAILURE THIS GUARDS AGAINST: a field drawn on the screen and then not saved, which
    // is what happens when the markup and the save are written separately. Here the detail
    // form is drawn FROM jcDetailSections(), so anything in it is necessarily wired.
    const sections = js.slice(js.indexOf('function jcDetailSections()'),
      js.indexOf('function jcControl('));
    const onDetail = new Set([...sections.matchAll(/JCF\.(JC_[A-Z]+)/g)].map((m) => m[1]));

    // The creation form carries the ones known when a job card is raised.
    const creation = js.slice(js.indexOf("const put=(elId,fid)"), js.indexOf('const acts=['));
    const onCreate = new Set([...creation.matchAll(/JCF\.(JC_[A-Z]+)/g)].map((m) => m[1]));
    onCreate.add('JC_ACTIONS');                    // the tick row, saved just below

    const missing = Object.keys(jcf).filter((k) => !onDetail.has(k) && !onCreate.has(k));
    t('every one of them is on a screen', missing, []);

    // The ones somebody fills in as the job runs belong on the detail screen, not on the form
    // that raises the card.
    ['JC_INSPBY', 'JC_INSPCONF', 'JC_REQBY', 'JC_FINALBY', 'JC_CANAME', 'JC_DDEC', 'JC_ACTSCOPE']
      .forEach((k) => t('  ' + k + ' is on the detail screen', onDetail.has(k), true));

    // And the ones known at the start are asked for while raising it.
    ['JC_ENTITY', 'JC_RAISEDBY', 'JC_OPCLASS', 'JC_PREVNOTES', 'JC_PRESCOPE', 'JC_ACTIONS']
      .forEach((k) => t('  ' + k + ' is asked for when raising one', onCreate.has(k), true));

    t('the creation form has an input for each one it saves',
      ['njc-entity', 'njc-raisedby', 'njc-opclass', 'njc-actions', 'njc-actother',
        'njc-prevnotes', 'njc-gennotes', 'njc-prescope'].filter((id) => !html.includes('id="' + id + '"')), []);

    // The option lists have to be the ones Airtable holds, or a save is a 422 the user cannot act on.
    const listOf = (name) => {
      const m = new RegExp('const ' + name + ' = \\[([^\\]]*)\\]').exec(js);
      return m ? m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];
    };
    t('the entity list matches the printed form', listOf('JC_ENTITIES'), F.ENTITIES);
    t('the site actions match', listOf('JC_ACTIONS_LIST'), F.ACTIONS);
    t('and the inspection confirmations', listOf('JC_INSP_CONFIRMS'), F.CONFIRMS);

    // Headings reworded to the paper's, so the screen and the sheet read the same.
    ['Actual date of issue', 'Planned start date', 'Actual completion date', 'Client name',
      'Project manager'].forEach((h) => t('the detail screen says "' + h + '"', js.includes(h), true));
    t('and the creation form asks for a job card number', html.includes('Job card number'), true);

    // Saving writes by field id, and takes back what Airtable returned rather than what it sent.
    t('a field saves by id', /omPatch\(OM_T\.JC, id, \{ \[fid\]: v \}\)/.test(js), true);
    t('and the cache takes what came back, not what was sent',
      /rec\.fields\[fid\]=up\.fields\[fid\]/.test(js), true);
    // An empty box must clear the field, not write the empty string into a select.
    t('clearing a field sends null', /const v=\(value===''\|\|value===undefined\)\?null:value;/.test(js), true);
    // Ticking one option must not drop the others.
    t('a tick adds to the list rather than replacing it',
      /now\.indexOf\(option\)>=0 \? now\.filter/.test(js), true);
    t('the editable form is not drawn for a role that may not edit',
      /if\(!TX\.can\('job_cards','edit'\)\) return '';/.test(js), true);
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
