// Stubbed /api/expenses for expenses-harness.html. Shapes follow api/expenses.js.
(async function () {
  'use strict';
  const out = document.getElementById('out');
  const log = (s) => { out.textContent += s + '\n'; };
  let fails = 0;
  const check = (name, ok) => { if (!ok) fails++; log((ok ? 'pass  ' : 'FAIL  ') + name); };

  const html = await (await fetch('/index.html')).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  document.getElementById('stage').appendChild(doc.getElementById('modExpenses'));
  document.getElementById('modExpenses').hidden = false;

  const CATS = [{ id: 'recCATFUEL0000001', name: 'Fuel' }, { id: 'recCATMEALS000001', name: 'Meals' }];
  const JCS = [{ id: 'recJCEASYGREENS01', ref: 'JC-0101', title: 'Easygreens install', client: 'Easygreens', site: 'Meyerton', status: 'In Progress' }];
  const CALLS = [];
  let claims = [{ id: 'recCLAIM000000001', seq: 3, ref: 'ES-202610-003', legacyRef: '', date: '2026-10-26', employeeName: 'Dylan',
    jobcardId: 'recJCEASYGREENS01', jobcardRef: 'JC-0101', project: 'Easygreens', description: 'Fuel for Silver Ford',
    status: 'Approved', total: 1500, lineCount: 2, duplicate: false, totalApproved: 1500, canEdit: false, canExport: true }];
  let saved = null; let seq = 0;

  // A copy, as a real response would be: handing the page the stub's own array let a row the page
  // added appear in the stub's "database" too.
  const view = (c, lines) => JSON.parse(JSON.stringify({ claim: { ...c, lines: undefined,
    total: lines.filter((l) => !l.removed).reduce((s, l) => s + Number(l.amount || 0), 0) }, lines, history: c.history || [] }));

  TX.request = async (path, body) => {
    CALLS.push(JSON.parse(JSON.stringify(body)));
    await new Promise((r) => setTimeout(r, 30));
    switch (body.op) {
      case 'init': return { me: { name: 'Dylan', email: 'dylan@x' }, can: { view: true, create: true, edit: true, export: true, seeAll: false, approve: false, jobcards: true, jobcardTotals: false },
        categories: CATS, claimTypes: ['Fuel', 'Travel', 'Other'], paymentMethods: ['Transfer', 'Cash'], maxSheetLines: 7 };
      case 'list': return { claims, jobcardTotal: null };
      case 'jobcards': return { jobcards: JCS.filter((j) => (j.ref + j.title + j.client).toLowerCase().includes((body.q || '').toLowerCase())) };
      case 'get': return view(claims[0], [
        { id: 'recITEM000000001', date: '2026-10-26', categoryId: CATS[0].id, supplier: 'Engen', description: 'Diesel (EFT)', receiptNumber: '', amount: 879, sort: 1 },
        { id: 'recITEM000000002', date: '2026-10-26', categoryId: CATS[0].id, supplier: 'Shell', description: 'Diesel (own funds)', receiptNumber: '', amount: 621, sort: 2 }]);
      case 'save': {
        if (!saved) saved = { id: 'recNEWCLAIM000001', ref: 'ES-202610-005', status: 'Draft', date: body.claim.claimDate, employeeName: 'Dylan',
          canEdit: true, canSubmit: true, canExport: true, mine: true, lines: [] };
        Object.assign(saved, { project: body.claim.project, description: body.claim.description, jobcardId: body.claim.jobcardId,
          jobcardRef: body.claim.jobcardId ? 'JC-0101' : '' });
        for (const l of body.lines) {
          if (l.id) Object.assign(saved.lines.find((x) => x.id === l.id), l);
          else saved.lines.push({ ...l, id: 'recNEWITEM' + String(++seq).padStart(7, '0'), sort: seq });
        }
        return view(saved, saved.lines);
      }
      case 'remove_line': {
        const l = saved.lines.find((x) => x.id === body.itemId);
        Object.assign(l, { removed: true, removedReason: body.reason, removedBy: 'Dylan' });
        saved.history = [{ event: 'Remove Line', by: 'Dylan', at: '2026-10-29T12:00', comment: body.reason }];
        return view(saved, saved.lines);
      }
      case 'submit': saved.status = 'Awaiting Approval'; saved.canEdit = false; return view(saved, saved.lines);
      default: throw new TX.ApiError(400, { reason: 'unknown_op', detail: 'stub has no ' + body.op });
    }
  };

  const $ = (s) => document.querySelector(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms || 120));
  const click = async (sel) => { $(sel).click(); await wait(); };
  const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };

  await TX.expenses.start();
  await wait();
  check('the claim list shows the existing claim', /ES-202610-003/.test($('#exRows').textContent) && /R\s*1\s*500,00|1,500\.00|1 500/.test($('#exRows').textContent));
  check('New claim is offered to an employee who may create', !$('#exNewBtn').hidden);

  await click('#exNewBtn');
  check('a new claim opens with one blank expense row', document.querySelectorAll('#exDetail tr[data-line]').length === 1);
  set($('#exDetail .ex-jc-q'), 'easy');
  await wait(400);
  check('searching job cards lists matches', /JC-0101/.test($('[data-results="claim"]').textContent));
  await click('[data-act="exJcPick"]');
  check('the chosen job card is shown and fills the client', /JC-0101/.test($('[data-jcpick="claim"]').textContent) && $('#exClient').value === 'Easygreens');

  const row = document.querySelector('#exDetail tr[data-line]');
  row.querySelector('[data-f="categoryId"]').value = CATS[0].id;
  set(row.querySelector('[data-f="supplier"]'), 'Engen');
  set(row.querySelector('[data-f="description"]'), 'Diesel');
  set(row.querySelector('[data-f="amount"]'), '879');
  check('the total follows the amount typed', /879/.test($('#exTotal').textContent));
  await click('[data-act="exAddLine"]');
  check('Add expense adds a row and keeps the first', document.querySelectorAll('#exDetail tr[data-line]').length === 2
    && document.querySelector('#exDetail tr[data-line] [data-f="supplier"]').value === 'Engen');

  $('[data-act="exSave"]').click(); $('[data-act="exSave"]').click();
  await wait(300);
  const saves = CALLS.filter((c) => c.op === 'save');
  check('a double tap on Save sends one request', saves.length === 1);
  check('a new claim carries a request id', !!saves[0].requestId);
  check('the blank second row is not sent', saves[0].lines.length === 1 && saves[0].lines[0].amount === '879');
  check('the job card goes with it', saves[0].claim.jobcardId === 'recJCEASYGREENS01');

  // a second, duplicate line, then remove it with a reason
  await click('[data-act="exAddLine"]');
  const rows = document.querySelectorAll('#exDetail tr[data-line]');
  const r2 = rows[rows.length - 1];
  r2.querySelector('[data-f="categoryId"]').value = CATS[0].id;
  set(r2.querySelector('[data-f="supplier"]'), 'Engen');
  set(r2.querySelector('[data-f="amount"]'), '879');
  await click('[data-act="exSave"]');
  check('the second save names the claim and keeps the same lines', CALLS.filter((c) => c.op === 'save').pop().claimId === 'recNEWCLAIM000001');
  const sel = document.querySelectorAll('#exDetail [data-act="exSel"]');
  sel[sel.length - 1].click();
  await wait();
  check('selecting a line enables Remove selected', !$('#exRemoveBtn').disabled && /\(1\)/.test($('#exRemoveBtn').textContent));
  window.prompt = () => '';
  await click('#exRemoveBtn');
  check('no reason, no removal', !CALLS.some((c) => c.op === 'remove_line'));
  window.prompt = () => 'Duplicate of line 1';
  await click('#exRemoveBtn');
  await wait(300);
  const rm = CALLS.find((c) => c.op === 'remove_line');
  check('removal is sent with its reason', !!rm && rm.reason === 'Duplicate of line 1');
  check('the removed line stays on screen, struck out, with the reason', !!document.querySelector('#exDetail tr.ex-removed') && /Duplicate of line 1/.test($('#exDetail').textContent));
  window.__total = $('#exTotal').textContent;
  check('and the total drops back', /879/.test($('#exTotal').textContent) && !/758/.test($('#exTotal').textContent));
  check('the history shows the removal', /Remove Line/.test($('#exDetail').textContent));

  await click('[data-act="exSubmit"]');
  check('Submit without the declaration is stopped', !CALLS.some((c) => c.op === 'submit') && /declaration/.test($('#exMsg').textContent));
  $('#exDeclare').checked = true;
  await click('[data-act="exSubmit"]');
  await wait(300);
  check('with it, the claim is submitted', CALLS.some((c) => c.op === 'submit' && c.declaration === true) && /Awaiting Approval/.test($('#exDetail').textContent));
  check('and the form locks', !!$('#exDate').disabled);

  window.__result = fails ? 'FAIL' : 'PASS';
  document.title = 'Expense claims harness — ' + window.__result;
  log('\n' + window.__result + ' (' + fails + ' failed)');
})().catch((e) => { document.getElementById('out').textContent += '\nERROR ' + e.stack; document.title = 'Expense claims harness — FAIL'; window.__result = 'FAIL'; });
