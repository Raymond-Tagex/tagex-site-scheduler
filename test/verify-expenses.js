#!/usr/bin/env node
// Expense claims — node test/verify-expenses.js
//
// The claim rules (status flow, totals, payment state, reference format, duplicate warnings,
// submit validation) and the expense sheet export. Offline: no Airtable, no network.

'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const E = require(path.join(ROOT, 'api', '_lib', 'expenses.js'));
const X = require(path.join(ROOT, 'api', '_lib', 'expensesheet.js'));
const JSZip = require(path.join(ROOT, 'node_modules', 'jszip'));

let pass = 0, fail = 0;
const failures = [];
function t(label, ok, detail) {
  if (ok) pass++; else { fail++; failures.push(label + (detail ? `\n      ${detail}` : '')); }
  console.log(`  ${ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}`);
}

(async () => {
  const { STATUS } = E;
  const FINANCE = new Set(['finance']);
  const APPROVER = new Set(['approve']);
  const SUBMITTER = new Set(['submit']);

  console.log('\nStatus flow');
  t('employee submits a draft', E.canTransition(STATUS.DRAFT, 'submit', SUBMITTER).ok === true);
  t('employee cannot approve', E.canTransition(STATUS.AWAITING_APPROVAL, 'approve', SUBMITTER).reason === 'not_permitted');
  const approved = E.canTransition(STATUS.AWAITING_APPROVAL, 'approve', APPROVER);
  t('approval moves to Approved, never Paid', approved.ok && approved.to === STATUS.APPROVED && approved.to !== STATUS.PAID);
  t('approver cannot queue payment', E.canTransition(STATUS.APPROVED, 'queue_payment', APPROVER).reason === 'not_permitted');
  t('finance queues an approved claim', E.canTransition(STATUS.APPROVED, 'queue_payment', FINANCE).to === STATUS.AWAITING_PAYMENT);
  t('cannot skip approval', E.canTransition(STATUS.DRAFT, 'approve', APPROVER).reason === 'wrong_status');
  t('rejection needs a reason', E.canTransition(STATUS.AWAITING_APPROVAL, 'reject', APPROVER).reason === 'reason_required');
  t('rejection with reason is accepted', E.canTransition(STATUS.AWAITING_APPROVAL, 'reject', APPROVER, 'No receipt').to === STATUS.REJECTED);
  t('rejected claim can be corrected and resubmitted', E.canTransition(STATUS.REJECTED, 'submit', SUBMITTER).to === STATUS.AWAITING_APPROVAL);
  t('info request needs a question', E.canTransition(STATUS.AWAITING_APPROVAL, 'request_info', APPROVER, '  ').reason === 'reason_required');
  t('closing needs a paid claim', E.canTransition(STATUS.AWAITING_PAYMENT, 'close', FINANCE).reason === 'wrong_status');
  t('unknown action refused', E.canTransition(STATUS.DRAFT, 'delete', SUBMITTER).reason === 'unknown_action');

  console.log('\nTotals and payments');
  const lines = [
    { amount: 879, category: 'Fuel' },
    { amount: 621, category: 'Fuel' },
    { amount: 100.1, category: 'Meals' },
  ];
  const totals = E.claimTotals(lines);
  t('claim total adds to the cent', totals.total === 1600.1, `got ${totals.total}`);
  t('totals split by category', totals.byCategory.Fuel === 1500 && totals.byCategory.Meals === 100.1);
  t('float drift does not leak', E.claimTotals([{ amount: 0.1 }, { amount: 0.2 }]).total === 0.3);
  const partial = E.paymentState(1600.1, [{ amount: 1000 }]);
  t('partial payment keeps an outstanding balance', partial.status === STATUS.PARTIALLY_PAID && partial.outstanding === 600.1);
  t('full payment marks Paid', E.paymentState(1600.1, [{ amount: 1000 }, { amount: 600.1 }]).status === STATUS.PAID);
  t('no payment is Awaiting Payment', E.paymentState(500, []).status === STATUS.AWAITING_PAYMENT);

  console.log('\nReference');
  t('reference matches the sheet style', E.claimRef('2026-10-26', 3) === 'ES-202610-003');
  t('reference pads and grows', E.claimRef('2026-10-01', 1234) === 'ES-202610-1234');
  let threw = false; try { E.claimRef('not a date', 1); } catch { threw = true; }
  t('bad date refused', threw);
  threw = false; try { E.claimRef('2026-10-26', 0); } catch { threw = true; }
  t('sequence must be positive', threw);

  console.log('\nDuplicates and validation');
  const dup = E.duplicateFlags([
    { employeeId: 'a', date: '2026-10-26', amount: 879, supplier: 'Tagex' },
    { employeeId: 'a', date: '2026-10-26', amount: 879, supplier: ' tagex ' },
    { employeeId: 'a', date: '2026-10-26', amount: 621, supplier: 'Tagex' },
  ]);
  t('same employee, date, amount and supplier is flagged', dup.length === 1 && dup[0].duplicateOf === 0);
  const errs = E.validateForSubmit({ jobcardId: 'rec1', claimDate: '2026-10-26' },
    [{ date: '2026-10-26', category: 'Fuel', description: 'Diesel', amount: 900 }], { receiptThreshold: 100 });
  t('large line without receipt is refused', errs.some((e) => e.field === 'lines[0].receipt'));
  const ok = E.validateForSubmit({ jobcardId: 'rec1', claimDate: '2026-10-26' },
    [{ date: '2026-10-26', category: 'Fuel', description: 'Diesel', amount: 900, receiptAttached: true }], { receiptThreshold: 100 });
  t('same line with a receipt passes', ok.length === 0);
  const bad = E.validateForSubmit({}, [{ amount: -5 }]);
  t('missing jobcard, date and amount are all reported', bad.length >= 5, `got ${bad.length}`);

  console.log('\nExpense sheet export');
  const claim = {
    ref: 'ES-202610-003', employeeName: 'Test Employee', paymentMethod: 'TRF CC', claimType: 'Fuel',
    purpose: 'Fuel for test bakkie', projectName: 'Test Project', claimDate: '2026-10-26',
    kilometres: 343050, advances: 879, fundsNote: 'Funds to be deposited into test account',
  };
  const sheetLines = [
    { date: '2026-10-26', supplier: 'Tagex', description: 'Fuel (EFT)', category: 'Fuel', amount: 879 },
    { date: '2026-10-26', supplier: 'Tagex', description: 'Fuel (own funds)', category: 'Fuel', amount: 621 },
    { date: '2026-10-27', supplier: 'Cafe & Co', description: 'Lunch <team>', category: 'Meals', amount: 150 },
  ];
  const buf = await X.buildExpenseSheet(claim, sheetLines);
  const zip = await JSZip.loadAsync(buf);
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const wb = await zip.file('xl/workbook.xml').async('string');
  const table = await zip.file('xl/tables/table1.xml').async('string');

  t('export is a valid zip with the template parts', !!zip.file('xl/worksheets/sheet1.xml') && !!zip.file('xl/media/image1.png'));
  t('header values are written', /<t xml:space="preserve">Test Employee<\/t>/.test(sheet) && /<t xml:space="preserve">ES-202610-003<\/t>/.test(sheet));
  t('date written as an Excel serial', /<c r="G10" s="\d+"><v>46321<\/v><\/c>/.test(sheet));
  t('fuel line goes to the fuel column', /<c r="I16" s="\d+"><v>879<\/v><\/c>/.test(sheet));
  t('meal line goes to the meals column', /<c r="J18" s="\d+"><v>150<\/v><\/c>/.test(sheet));
  t('total is a formula, not a typed number', /<c r="N16" s="\d+"><f>SUM\(F16:G16,I16,J16:M16\)<\/f><\/c>/.test(sheet));
  t('fuel is in the line total', !/N16[^>]*><f>SUM\(F16:G16,J16/.test(sheet));
  t('balance formula kept from the template', /<f>Subtotal-Advances<\/f>/.test(sheet));
  t('subtotal formula kept from the template', /<f>SUBTOTAL\(109,tblData/.test(sheet));
  t('named ranges and print area kept', /name="Subtotal"/.test(wb) && /name="Advances"/.test(wb) && /Print_Area/.test(wb));
  t('the table tblData is kept', /name="tblData"/.test(table) && /ref="C15:N22"/.test(table));
  t('sheet is set to recalculate on open', /fullCalcOnLoad="1"/.test(wb));
  t('special characters are escaped', /Cafe &amp; Co/.test(sheet) && /Lunch &lt;team&gt;/.test(sheet));
  t('no sample personal data left in the template', !/Silver Ford|Easygreens|Dylan/.test(sheet + wb));

  let tooMany = null;
  try { await X.buildExpenseSheet(claim, new Array(8).fill(sheetLines[0])); } catch (e) { tooMany = e; }
  t('more than seven lines is refused, not truncated', tooMany && tooMany.code === 'too_many_lines');

  t('file name is TAGEX_ExpenseClaim_[ref].xlsx', X.claimFileName('ES-202610-003') === 'TAGEX_ExpenseClaim_ES-202610-003.xlsx');
  t('file name strips unsafe characters', X.claimFileName('ES/../x y') === 'TAGEX_ExpenseClaim_ES____x_y.xlsx', X.claimFileName('ES/../x y'));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
