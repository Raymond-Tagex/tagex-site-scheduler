#!/usr/bin/env node
// The fields the paper job card asks for and the Job Cards table did not have.
//
//   node scripts/provision-jobcard-template.js            # dry run
//   node scripts/provision-jobcard-template.js --apply    # creates them
//
// SOURCE: TAGEX JOB CARD TEMPLATE SEP2026.docx. Every field below exists because a line on that
// form had nowhere to go.
//
// WHAT IS DELIBERATELY NOT HERE
//
//   The cost breakdown.  The Costing table already carries Capital / DC / AC / Transport /
//                        Accommodation / Labour / Rental / Other and a Total formula, which is
//                        the form's Summary of Costs grid one for one. Adding the same columns
//                        to Job Cards would be a second place for the same number.
//
//   The visit rows.      "Pre-Site Visit" and "Actual-Site Visit" are dated rows with a
//                        description, which is what Site Visits already holds and what the
//                        scheduler already writes. The printed tables are filled from those.
//
//   Anything that exists. Job Card Number is JC Reference; Actual Date of Issue is Issued Date;
//                        Client Name, Site / Address, Tickets, BOM Sheets, Responsible and the
//                        start and completion dates are all already there. The print reads
//                        them; nothing is duplicated.
//
// Airtable DOES allow a field to be created through the metadata API, unlike adding a choice to
// an existing select — so this runs unattended. It is still additive only: it never alters or
// removes a field, and a field that is already there is left exactly as it is.

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'app0tq4y9wH10h6Up';          // O&M. NOT appfzAX5YHqg4UXCl, which is C&I.
const JOB_CARDS = 'tbl2wqnfM0eDa8M7P';

const APPLY = process.argv.includes('--apply');

const text = (name, description) => ({ name, type: 'singleLineText', description });
const long = (name, description) => ({ name, type: 'multilineText', description });
const date = (name, description) => ({
  name, type: 'date', description, options: { dateFormat: { name: 'iso' } } });
const pick = (name, choices, description) => ({
  name, type: 'singleSelect', description, options: { choices: choices.map((c) => ({ name: c })) } });
const multi = (name, choices, description) => ({
  name, type: 'multipleSelects', description, options: { choices: choices.map((c) => ({ name: c })) } });

// In the order they appear on the paper, so the table reads like the form.
const WANT = [
  // ── the approval block across the top of page one ────────────────────────
  pick('Director Decision', ['Approved', 'Denied', 'Completed'],
    'The box ticked across the head of the printed job card.'),
  text('Director Decision By', 'Who signed the approval block.'),
  date('Director Decision Date', 'The date against the director signature.'),

  // ── identity ─────────────────────────────────────────────────────────────
  pick('Entity Name', ['Tagex Energy', 'Solax Energy', 'PPA', 'Alpine', 'Direct Purchase'],
    'Which entity the job is being done under. Owner Category is the commercial arrangement '
    + 'and is a different question.'),
  text('Ticket Raised By', 'Who reported the work. The Tickets link says which ticket.'),

  // ── what the visit is for ────────────────────────────────────────────────
  multi('Suggested Site Actions',
    ['Site Inspection', 'Installation', 'Maintenance', 'Decommissioning',
      'Testing & Commissioning', 'Warranty Work', 'Stock / Asset Allocation', 'Other'],
    'The ticks under "Suggested Site Actions". Several may apply, which is why this is not '
    + 'Job Type — that is a single select and the form allows more than one.'),
  text('Suggested Site Actions — Other', 'The line beside the "Other" tick.'),
  pick('Operational Classification',
    ['Standard Operational Activity', 'Emergency / Critical Response'],
    'Emergency / Critical Response requires approval on the paper form.'),

  // ── the written sections ─────────────────────────────────────────────────
  long('Pre-Visit Notes', 'The PRE-VISIT NOTES block.'),
  long('General Notes', 'The GENERAL NOTES block.'),
  long('Pre-Site Scope of Work', 'PRE-SITE VISIT — SCOPE OF WORK: what is to be done.'),
  long('Actual Site Scope of Work', 'ACTUAL SITE VISIT — SCOPE OF WORK: what was done.'),

  // ── on-site inspection ───────────────────────────────────────────────────
  text('Site Inspection Conducted By', 'ON-SITE INSPECTION: who carried it out.'),
  date('Date of Inspection', 'ON-SITE INSPECTION: when.'),
  multi('Inspection Confirmations',
    ['Structural Integrity Visually Confirmed', 'Electrical Infrastructure Verified',
      'Access & Safety Clearance Confirmed', 'Client Requirements Confirmed',
      'Photographic Evidence Attached'],
    'The five confirmation ticks under ON-SITE INSPECTION.'),

  // ── stock and logistics headline ─────────────────────────────────────────
  { name: 'Supplier Quotes Attached', type: 'checkbox',
    description: 'The Yes / No beside "Supplier Quotes Attached". BOM Attached is answered by '
      + 'the BOM Sheets link, so it has no field of its own.',
    options: { icon: 'check', color: 'greenBright' } },

  // ── who is on it ─────────────────────────────────────────────────────────
  text('Technician / Installer',
    'RESPONSIBLE PERSONNEL. Free text rather than a collaborator: a subcontracted installer is '
    + 'named on the form and is not a user of this app.'),

  // ── timeline control ─────────────────────────────────────────────────────
  date('Site Visit Date', 'TIMELINE CONTROL. Planned Start is Started Project; Actual '
    + 'Completion is Completed Project.'),
  date('Actual Installation Date', 'TIMELINE CONTROL.'),
  long('Delay Explanation', 'TIMELINE CONTROL: the line under the dates.'),

  // ── the five approval signatures ─────────────────────────────────────────
  text('Requested By', 'SIGNATURES FOR APPROVALS.'),
  date('Requested By Date', 'SIGNATURES FOR APPROVALS.'),
  text('Procurement Approved By', 'SIGNATURES FOR APPROVALS.'),
  date('Procurement Approved Date', 'SIGNATURES FOR APPROVALS.'),
  text('Operational Approved By', 'SIGNATURES FOR APPROVALS: operational / executive.'),
  date('Operational Approved Date', 'SIGNATURES FOR APPROVALS.'),
  text('Financial Approved By', 'SIGNATURES FOR APPROVALS: financial oversight.'),
  date('Financial Approved Date', 'SIGNATURES FOR APPROVALS.'),
  text('Final Sign-Off By', 'SIGNATURES FOR APPROVALS: final completion.'),
  date('Final Sign-Off Date', 'SIGNATURES FOR APPROVALS.'),

  // ── the client's acceptance of the terms ─────────────────────────────────
  text('Client Acceptance Name', 'CLIENT ACCEPTANCE OF TERMS AND CONDITIONS.'),
  text('Client Acceptance Company', 'CLIENT ACCEPTANCE: company, if applicable.'),
  text('Client Acceptance Contact', 'CLIENT ACCEPTANCE: contact number.'),
  text('Client Acceptance Email', 'CLIENT ACCEPTANCE: email address.'),
  date('Client Acceptance Date', 'CLIENT ACCEPTANCE: the date beside the signature.'),
];

function pat() {
  const f = path.join(__dirname, '..', '.env.local');
  const m = fs.existsSync(f) && fs.readFileSync(f, 'utf8').match(/^AIRTABLE_PAT=(.*)$/m);
  const v = (m && m[1].trim()) || process.env.AIRTABLE_PAT;
  if (!v) { console.error('No AIRTABLE_PAT in .env.local or the environment.'); process.exit(1); }
  return v;
}
const PAT = pat();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, opts = {}) {
  await sleep(220);
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : {};
}

(async () => {
  const meta = await api(`https://api.airtable.com/v0/meta/bases/${BASE}/tables`);
  const table = (meta.tables || []).find((t) => t.id === JOB_CARDS);
  if (!table) { console.error('REFUSED: the Job Cards table is not in this base.'); process.exit(1); }

  const have = new Set(table.fields.map((f) => f.name));
  const todo = WANT.filter((f) => !have.has(f.name));
  const already = WANT.length - todo.length;

  console.log('\n\x1b[1mJOB CARD FIELDS FROM THE PAPER TEMPLATE\x1b[0m\n');
  console.log(`  Job Cards has ${table.fields.length} field(s) today.`);
  console.log(`  ${already} of the ${WANT.length} wanted are already there.\n`);

  if (!todo.length) { console.log('  Nothing to create.\n'); return; }

  todo.forEach((f) => console.log(`  ${f.name.padEnd(34)} ${f.type}`));

  if (!APPLY) {
    console.log(`\n  ${todo.length} field(s) would be created. DRY RUN — nothing was written.`);
    console.log('  Re-run with --apply.\n');
    return;
  }

  console.log('');
  let made = 0;
  const problems = [];
  for (const f of todo) {
    try {
      await api(`https://api.airtable.com/v0/meta/bases/${BASE}/tables/${JOB_CARDS}/fields`, {
        method: 'POST', body: JSON.stringify(f),
      });
      made += 1;
      console.log(`  \x1b[32mcreated\x1b[0m  ${f.name}`);
    } catch (e) {
      problems.push(`${f.name}: ${e.message}`);
      console.log(`  \x1b[31mFAILED \x1b[0m  ${f.name}`);
    }
  }

  console.log(`\n  ${made} of ${todo.length} created.`);
  if (problems.length) {
    console.log('\n\x1b[31m  NEEDS A PERSON:\x1b[0m');
    problems.forEach((p) => console.log('    ' + p));
    process.exit(1);
  }
  console.log('');
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
