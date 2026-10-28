#!/usr/bin/env node
// The contract panel on tickets and job cards — node test/verify-contract-panel.js
//
// public/js/contract-panel.js decides what a ticket or job card says about its contract: the
// funder, the warranty start (1st invoice date), the system, and which warranty is still in force.
// Raymond's rules (28 Oct 2026): Solax equipment 10 years, PV panels 25, workmanship 2, material 1,
// all from the 1st invoice; each funder's monthly O&M fee and pre-approved budget; capital
// expenditure never covered under warranty.

'use strict';

const fs = require('fs');
const path = require('path');
const C = require(path.join(__dirname, '..', 'public', 'js', 'contract-panel.js'));

let failed = 0;
let passed = 0;
function t(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++; else failed++;
  console.log((ok ? '  \x1b[32mpass\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m  ') + label
    + (ok ? '' : '\n        expected ' + JSON.stringify(expected) + '\n        got      ' + JSON.stringify(actual)));
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BISSET = [
  { number: 'SUB-148', funder: 'PPA', firstInvoice: '2025-09-25', system: '2x 7.5kw G4 Single phase', kind: 'Subscription' },
  { number: 'SUB-148-1', funder: 'Alpine', firstInvoice: '2025-11-25', system: 'Additional Slave Battery x2', kind: 'Subscription' },
];

console.log('\n\x1b[1mWARRANTY, FROM THE 1ST INVOICE DATE\x1b[0m\n');
{
  t('the four covers, as Raymond gave them', C.WARRANTY.map((w) => [w.key, w.years]),
    [['equipment', 10], ['panels', 25], ['workmanship', 2], ['material', 1]]);
  const w = C.warranty('2025-09-25', '2026-10-28');
  t('each ends on the anniversary of the 1st invoice', w.map((x) => x.until),
    ['2035-09-25', '2050-09-25', '2027-09-25', '2026-09-25']);
  t('a year on, material is out and the rest are in', w.map((x) => x.inWarranty), [true, true, true, false]);
  t('the day before the anniversary is still covered',
    C.warranty('2025-09-25', '2026-09-24').find((x) => x.key === 'material').inWarranty, true);
  t('the anniversary itself is not', C.warranty('2025-09-25', '2026-09-25').find((x) => x.key === 'material').inWarranty, false);
  t('29 February runs to 1 March', C.addYears('2024-02-29', 1), '2025-03-01');
  t('no 1st invoice date, no verdict', C.warranty('', '2026-10-28'), []);
  t('nor from something that is not a date', C.warranty('25/09/2025', '2026-10-28'), []);
}

console.log('\n\x1b[1mWHICH CONTRACT A RECORD IS FOR\x1b[0m\n');
{
  t('the one the record names', C.resolve(BISSET, 'SUB-148-1').contract.number, 'SUB-148-1');
  t('matched however it was typed', C.resolve(BISSET, ' sub-148 ').how, 'set');
  t('a number the client does not have is flagged, not guessed', C.resolve(BISSET, 'SUB-999').how, 'stale');
  t('none named, several to choose from: someone must choose', C.resolve(BISSET, '').how, 'choose');
  t('and no contract is assumed', C.resolve(BISSET, '').contract, null);
  t('none named, one contract: it is shown', C.resolve([BISSET[0]], '').contract.number, 'SUB-148');
  t('but marked as not yet saved', C.resolve([BISSET[0]], '').how, 'only');
  t('a client with no contract says so', C.resolve([], '').how, 'none');
  t('a register that could not be read is unknown, never "no contract"', C.resolve(null, 'SUB-148').how, 'unknown');
}

console.log('\n\x1b[1mWHAT THE PANEL SAYS\x1b[0m\n');
{
  const html = C.panelHtml({ res: C.resolve(BISSET, 'SUB-148'), details: BISSET, esc, today: '2026-10-28',
    canEdit: true, act: 'omTktSetContract', recId: 'recTKT' });
  t('the funder', /om-con-tag fund">PPA</.test(html), true);
  t('the contract number', html.includes('<b>SUB-148</b>'), true);
  t('the system installed', html.includes('2x 7.5kw G4 Single phase'), true);
  t('the warranty start', html.includes('Warranty start (1st invoice)</span><b>2025-09-25'), true);
  t('workmanship in warranty, with its end date', /Workmanship[\s\S]*?In warranty until 2027-09-25/.test(html), true);
  t('material out of warranty, with when it ended', /Material[\s\S]*?Expired 2026-09-25/.test(html), true);
  t('the funder\'s budget rule', html.includes('Work within TAGEX O&amp;M’s pre-approved PPA budget'), true);
  t('and that capital expenditure is not covered', html.includes('Capital expenditure is not covered under warranty.'), true);
  t('the contract can be changed by someone allowed to', /<select class="om-con-pick" data-on="change" data-act="omTktSetContract" data-a1="recTKT"/.test(html), true);
  t('with the current one selected', /<option value="SUB-148" selected>/.test(html), true);
  const ro = C.panelHtml({ res: C.resolve(BISSET, 'SUB-148'), details: BISSET, esc, today: '2026-10-28', canEdit: false });
  t('and not by someone who is not', ro.includes('<select'), false);

  const choose = C.panelHtml({ res: C.resolve(BISSET, ''), details: BISSET, esc, today: '2026-10-28', canEdit: true, act: 'x', recId: 'r' });
  t('several contracts and none chosen: a warning, not a guess', /om-con-choose[\s\S]*has 2 contracts/.test(choose), true);
  t('with nothing about warranty', choose.includes('In warranty'), false);
  const none = C.panelHtml({ res: C.resolve([], ''), details: [], esc, today: '2026-10-28' });
  t('no contract: funder and warranty unknown, check before costing', /No contract in the register[\s\S]*check before any work is costed/.test(none), true);
  const only = C.panelHtml({ res: C.resolve([BISSET[0]], ''), details: [BISSET[0]], esc, today: '2026-10-28' });
  t('the only contract, shown and marked as not yet saved', only.includes('not yet saved here'), true);

  const nasty = [{ number: 'SUB-1<script>', funder: 'PPA"><b', firstInvoice: '2025-01-01', system: '<img src=x onerror=alert(1)>' }];
  const x = C.panelHtml({ res: C.resolve(nasty, 'SUB-1<script>'), details: nasty, esc, today: '2026-10-28', canEdit: true, act: 'a', recId: 'r' });
  t('everything from the register is escaped', /<script>|<img|"><b/.test(x), false);
}

console.log('\n\x1b[1mTHE SHORT FORM ON A LIST CARD\x1b[0m\n');
{
  t('funder and contract', C.chipHtml(C.resolve(BISSET, 'SUB-148-1'), esc), '<span class="om-con-chip">Alpine · SUB-148-1</span>');
  t('a warning when someone must choose', /warn/.test(C.chipHtml(C.resolve(BISSET, ''), esc)), true);
  t('nothing when the register could not be read', C.chipHtml(C.resolve(null, ''), esc), '');
}

console.log('\n\x1b[1mWIRED INTO THE SCHEDULER\x1b[0m\n');
{
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'mod-scheduler.js'), 'utf8').replace(/\r\n/g, '\n');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  t('the ticket screen opens with the panel', js.includes("<div class=\"om-dbody\">\n      ${omConPanel('tkt',rec)}"), true);
  t('so does the job card screen', js.includes("${omConPanel('jc',rec)}\n    <div class=\"om-acts\">"), true);
  t('both list cards carry the short form', [/chipHtml\(omTktContract\(rec\),esc\)/.test(js), /chipHtml\(omJcContract\(rec\),esc\)/.test(js)], [true, true]);
  t('a ticket with no contract of its own takes its job card\'s',
    /omFstr\(rec\.fields,TK\.contract\)\|\|\(jc\?omFstr\(jc\.fields,OM_F\.JC_CONTRACT\):''\)/.test(js), true);
  t('the field ids are per base (created after RES was copied)', [
    js.includes("JC_CONTRACT: SCHED_BASE==='RES' ? 'fldurJcHRH6UH4OUW' : 'fldL3oHNNsMKzbtNt'"),
    js.includes("contract: SCHED_BASE==='RES' ? 'flde4zb3fATF9Yhkr' : 'fldVh5h1cf35T2fkg'")], [true, true]);
  t('job cards are fetched with the field', /OM_F\.JC_REGION,OM_F\.JC_CONTRACT\]/.test(js), true);
  t('a new ticket saves its contract', /if\(con\) f\[TK\.contract\]=con;/.test(js), true);
  t('a new job card saves its contract', js.includes("put('njc-contract', OM_F.JC_CONTRACT);"), true);
  t('both forms have the picker', [html.includes('id="om-consel"'), html.includes('id="njc-contract"')], [true, true]);
  t('the page loads the rules before the scheduler',
    html.indexOf('/js/contract-panel.js') > 0 && html.indexOf('/js/contract-panel.js') < html.indexOf('/js/mod-scheduler.js'), true);
  t('a register read from the fallback gives unknown, not "no contract"', /cli&&!cli\.fallback \? \(cli\.contractDetails\|\|\[\]\) : null/.test(js), true);
  t('changing a contract is logged', /'Contract set to '\+num/.test(js), true);
}

console.log('\n' + '='.repeat(70));
console.log(failed
  ? `\n\x1b[31m\x1b[1m  ${failed} FAILED\x1b[0m, ${passed} passed`
  : `\n\x1b[32m\x1b[1m  ALL ${passed} ASSERTIONS PASSED\x1b[0m`);
console.log('='.repeat(70) + '\n');
process.exit(failed ? 1 : 0);
