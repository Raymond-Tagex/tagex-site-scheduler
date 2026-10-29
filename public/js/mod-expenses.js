// TAGEX — Expense claims.
//
// One claim per employee per job card, many lines per claim. Everything goes through
// /api/expenses, which decides who may see, change, submit, approve or export a claim; the
// buttons drawn here follow the flags the server returns (claim.canEdit and friends) and are a
// courtesy only.
//
// Lines are never deleted. "Remove" asks for a reason, keeps the line, strikes it through and
// writes the reason to the claim's history.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => TX.esc(s);
  const api = (body) => TX.request('/api/expenses', body);
  const money = (n) => 'R ' + (Number(n) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const today = () => new Date().toISOString().slice(0, 10);
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));

  const STATUSES = ['Draft', 'Awaiting Approval', 'Info Requested', 'Rejected', 'Approved',
    'Awaiting Payment', 'Partially Paid', 'Paid', 'Closed'];
  const STATUS_TONE = { Draft: 'grey', 'Awaiting Approval': 'amber', 'Info Requested': 'amber', Rejected: 'red',
    Approved: 'green', 'Awaiting Payment': 'blue', 'Partially Paid': 'blue', Paid: 'green', Closed: 'grey' };

  const S = {
    init: null, claims: [], jobcardTotal: null, filterJc: null,
    // the open claim
    claim: null, lines: [], history: [], requestId: null, selected: new Set(), lineSort: { key: 'sort', dir: 1 },
    busy: false,
  };

  // ── start / list ────────────────────────────────────────────────────────

  async function start() {
    msg('exListMsg', 'Loading…', 'inf');
    try {
      S.init = await api({ op: 'init' });
    } catch (e) { return msg('exListMsg', TX.errorText(e), 'err'); }
    $('exStatus').innerHTML = '<option value="">All statuses</option>'
      + STATUSES.map((s) => '<option>' + esc(s) + '</option>').join('');
    $('exNewBtn').hidden = !S.init.can.create;
    $('exMineWrap').hidden = !S.init.can.seeAll;
    paintJcPick(document.querySelector('[data-jcpick="filter"]'), S.filterJc, 'filter');
    await load();
  }

  async function load() {
    msg('exListMsg', 'Loading claims…', 'inf');
    try {
      const r = await api({ op: 'list', jobcardId: S.filterJc ? S.filterJc.id : '', status: $('exStatus').value,
        mine: $('exMine').checked });
      S.claims = r.claims || [];
      S.jobcardTotal = r.jobcardTotal || null;
      msg('exListMsg', '');
    } catch (e) { S.claims = []; msg('exListMsg', TX.errorText(e), 'err'); }
    paintList();
  }

  function sorted(list) {
    const k = $('exSort').value;
    const by = {
      new: (a, b) => b.date.localeCompare(a.date) || (b.seq || 0) - (a.seq || 0),
      old: (a, b) => a.date.localeCompare(b.date) || (a.seq || 0) - (b.seq || 0),
      high: (a, b) => b.total - a.total,
      low: (a, b) => a.total - b.total,
      status: (a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status),
      employee: (a, b) => a.employeeName.localeCompare(b.employeeName),
    }[k] || (() => 0);
    return list.slice().sort(by);
  }

  function paintList() {
    const q = $('exSearch').value.trim().toLowerCase();
    const shown = sorted(S.claims.filter((c) => !q || [c.ref, c.legacyRef, c.employeeName, c.jobcardRef, c.jobcardTitle,
      c.project, c.client, c.description].join(' ').toLowerCase().includes(q)));

    const t = S.jobcardTotal;
    $('exJcTotal').innerHTML = t ? '<div class="ex-sum">'
      + sum('Claims', t.claims) + sum('Employees', t.employees) + sum('Submitted', money(t.submitted))
      + sum('Approved', money(t.approved)) + sum('Paid', money(t.paid)) + sum('Outstanding', money(t.outstanding))
      + '</div>' : '';

    if (!shown.length) {
      $('exRows').innerHTML = '<div class="ex-empty">' + (S.claims.length ? 'No claims match.' : 'No claims yet.') + '</div>';
      return;
    }
    $('exRows').innerHTML = shown.map((c) => '<button type="button" class="ex-row" data-act="exOpen" data-id="' + esc(c.id) + '">'
      + '<span class="ex-row-main">'
      + '<span class="ex-row-ref">' + esc(c.ref || c.legacyRef || 'New claim') + (c.legacyRef && c.ref ? ' <span class="ex-dim">(' + esc(c.legacyRef) + ')</span>' : '') + '</span>'
      + '<span class="ex-row-sub">' + esc([c.date, c.employeeName, c.jobcardRef || c.project].filter(Boolean).join(' · ')) + '</span>'
      + (c.description ? '<span class="ex-row-desc">' + esc(c.description) + '</span>' : '')
      + '</span>'
      + '<span class="ex-row-side">'
      + chip(c.status) + (c.duplicate ? '<span class="ex-chip red" title="A line matches another claim">possible duplicate</span>' : '')
      + '<span class="ex-row-amt">' + money(c.total) + '</span>'
      + '<span class="ex-dim">' + c.lineCount + ' line' + (c.lineCount === 1 ? '' : 's') + '</span>'
      + '</span></button>').join('');
  }

  const sum = (k, v) => '<div class="ex-sum-cell"><span class="ex-lbl">' + esc(k) + '</span><b>' + esc(v) + '</b></div>';
  const chip = (s) => '<span class="ex-chip ' + (STATUS_TONE[s] || 'grey') + '">' + esc(s) + '</span>';

  // ── job card picker ─────────────────────────────────────────────────────
  // A search box over the job cards this role may see; the server matches number, title,
  // client and site. Used twice: the list filter and the claim's own job card.

  function paintJcPick(host, chosen, which, disabled) {
    if (!host) return;
    if (!S.init.can.jobcards) {
      host.innerHTML = chosen ? '<span>' + esc(chosen.ref || chosen.title) + '</span>' : '<span class="ex-dim">Job cards are not available to your role.</span>';
      return;
    }
    host.innerHTML = chosen
      ? '<span class="ex-jc-chosen"><b>' + esc(chosen.ref) + '</b> ' + esc(chosen.title || '') + (chosen.client ? ' · ' + esc(chosen.client) : '') + '</span>'
        + (disabled ? '' : '<button type="button" class="ex-btn sm" data-act="exJcClear" data-which="' + which + '">Change</button>')
      : (disabled ? '<span class="ex-dim">None</span>'
        : '<input type="search" class="ex-jc-q" data-which="' + which + '" placeholder="Search job card number, client or site…" autocomplete="off">'
          + '<div class="ex-jc-results" data-results="' + which + '"></div>');
  }

  let jcTimer = null;
  function jcSearch(input) {
    clearTimeout(jcTimer);
    const which = input.dataset.which;
    const box = document.querySelector('[data-results="' + which + '"]');
    jcTimer = setTimeout(async () => {
      try {
        const r = await api({ op: 'jobcards', q: input.value });
        S.jcResults = r.jobcards || [];
        box.innerHTML = S.jcResults.length ? S.jcResults.map((j, i) => '<button type="button" class="ex-jc-hit" data-act="exJcPick" data-which="' + which + '" data-i="' + i + '">'
          + '<b>' + esc(j.ref) + '</b> ' + esc(j.title) + '<span class="ex-dim">' + esc([j.client, j.site, j.status].filter(Boolean).join(' · ')) + '</span></button>').join('')
          : '<div class="ex-dim ex-pad">No job cards match.</div>';
      } catch (e) { box.innerHTML = '<div class="ex-err ex-pad">' + esc(TX.errorText(e)) + '</div>'; }
    }, 250);
  }

  // ── claim detail ────────────────────────────────────────────────────────

  async function open(id) {
    S.selected.clear();
    $('exList').hidden = true;
    $('exDetail').hidden = false;
    $('exDetail').innerHTML = '<div class="ex-pad">Loading…</div>';
    try {
      const r = await api({ op: 'get', claimId: id });
      setClaim(r);
    } catch (e) { $('exDetail').innerHTML = backBar() + '<div class="status err">' + esc(TX.errorText(e)) + '</div>'; }
  }

  function startNew() {
    S.selected.clear();
    S.requestId = newId();
    S.claim = { id: '', status: 'Draft', date: today(), employeeName: S.init.me.name, canEdit: true, canSubmit: false,
      canExport: false, canReview: false, mine: true, description: '', project: '', client: '', claimType: '', paymentMethod: '',
      kilometres: null, jobcardId: '', jobcardRef: '' };
    S.lines = [blankLine()];
    S.history = [];
    S.claimJc = S.filterJc || null;
    $('exList').hidden = true;
    $('exDetail').hidden = false;
    paintDetail();
  }

  function setClaim(r) {
    S.claim = r.claim;
    S.lines = r.lines || [];
    S.history = r.history || [];
    S.claimJc = r.claim.jobcardId ? { id: r.claim.jobcardId, ref: r.claim.jobcardRef, title: r.claim.jobcardTitle } : null;
    if (S.claim.canEdit && !S.lines.some((l) => !l.removed)) S.lines.push(blankLine());
    paintDetail();
  }

  const blankLine = () => ({ id: '', key: newId(), date: today(), categoryId: '', supplier: '', description: '', receiptNumber: '', amount: '' });

  const backBar = () => '<header class="ex-topbar"><button class="ex-btn" data-act="exBack" type="button">&#8249; Claims</button></header>';

  function paintDetail() {
    const c = S.claim;
    const ed = c.canEdit;
    const dis = ed ? '' : ' disabled';
    const opts = (list, v) => '<option value=""></option>' + list.map((x) => '<option' + (x === v ? ' selected' : '') + '>' + esc(x) + '</option>').join('');
    const live = S.lines.filter((l) => !l.removed);
    const total = live.reduce((s, l) => s + (Number(l.amount) || 0), 0);

    $('exDetail').innerHTML = backBar()
      + '<div class="ex-head">'
      + '<div><div class="ex-title">' + esc(c.ref || c.legacyRef || 'New claim') + ' ' + chip(c.status) + '</div>'
      + '<div class="ex-dim">' + esc([c.employeeName, c.submittedAt ? 'submitted ' + c.submittedAt.slice(0, 10) : ''].filter(Boolean).join(' · ')) + '</div></div>'
      + '<div class="ex-total"><span class="ex-lbl">Total</span><b id="exTotal">' + money(total) + '</b>'
      + (c.totalApproved != null ? '<span class="ex-dim">Approved ' + money(c.totalApproved) + '</span>' : '') + '</div>'
      + '</div>'
      + (c.comment && ['Rejected', 'Info Requested'].includes(c.status) ? '<div class="status err">' + esc(c.status === 'Rejected' ? 'Rejected: ' : 'Information requested: ') + esc(c.comment) + '</div>' : '')
      + '<div class="ex-form">'
      + field('Claim date', '<input type="date" id="exDate" value="' + esc(c.date) + '"' + dis + '>')
      + field('Job card', '<div class="ex-jcpick" data-jcpick="claim"></div>', true)
      + field('Project (as claimed)', '<input id="exProject" value="' + esc(c.project) + '" placeholder="If there is no job card"' + dis + '>')
      + field('Client (as claimed)', '<input id="exClient" value="' + esc(c.client) + '"' + dis + '>')
      + field('Type of expense', '<select id="exType"' + dis + '>' + opts(S.init.claimTypes, c.claimType) + '</select>')
      + field('Payment method', '<select id="exPay"' + dis + '>' + opts(S.init.paymentMethods, c.paymentMethod) + '</select>')
      + field('Kilometres', '<input type="number" inputmode="numeric" min="0" id="exKm" value="' + esc(c.kilometres == null ? '' : c.kilometres) + '"' + dis + '>')
      + field('Purpose', '<textarea id="exDesc" rows="2"' + dis + '>' + esc(c.description) + '</textarea>', true)
      + '</div>'
      + linesBlock()
      + actionsBlock()
      + historyBlock();
    paintJcPick(document.querySelector('[data-jcpick="claim"]'), S.claimJc, 'claim', !ed);
  }

  const field = (label, html, wide) => '<div class="ex-f' + (wide ? ' ex-wide' : '') + '"><label>' + esc(label) + '</label>' + html + '</div>';

  function sortedLines() {
    const { key, dir } = S.lineSort;
    const val = (l) => (key === 'amount' ? Number(l.amount) || 0 : key === 'category' ? catName(l.categoryId) : key === 'sort' ? (l.sort || 1e9) : String(l[key] || ''));
    return S.lines.slice().sort((a, b) => {
      const x = val(a); const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
  }
  const catName = (id) => (S.init.categories.find((c) => c.id === id) || {}).name || '';
  const lineKey = (l) => l.id || l.key;

  function linesBlock() {
    const c = S.claim;
    const ed = c.canEdit;
    const mayRemove = ed || c.canReview;
    const head = (k, label) => '<th><button type="button" class="ex-sorth" data-act="exSortLines" data-k="' + k + '">' + esc(label)
      + (S.lineSort.key === k ? (S.lineSort.dir > 0 ? ' ▲' : ' ▼') : '') + '</button></th>';
    const catOpts = (v) => '<option value=""></option>' + S.init.categories.map((x) => '<option value="' + esc(x.id) + '"' + (x.id === v ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('');
    const rows = sortedLines().map((l) => {
      const k = lineKey(l);
      const off = !ed || l.removed;
      const d = off ? ' disabled' : '';
      return '<tr class="' + (l.removed ? 'ex-removed' : '') + (l.duplicate && !l.removed ? ' ex-dupe' : '') + '" data-line="' + esc(k) + '">'
        + '<td class="ex-sel">' + (mayRemove && !l.removed && l.id ? '<input type="checkbox" data-act="exSel" data-k="' + esc(k) + '"' + (S.selected.has(k) ? ' checked' : '') + ' aria-label="Select line">' : '') + '</td>'
        + '<td data-l="Date"><input type="date" data-f="date" value="' + esc(l.date) + '"' + d + '></td>'
        + '<td data-l="Category"><select data-f="categoryId"' + d + '>' + catOpts(l.categoryId) + '</select></td>'
        + '<td data-l="Supplier"><input data-f="supplier" value="' + esc(l.supplier) + '"' + d + '></td>'
        + '<td data-l="Description"><input data-f="description" value="' + esc(l.description) + '"' + d + '>'
        + (l.duplicate && !l.removed ? '<div class="ex-warn">' + esc(l.duplicateNote || 'Possible duplicate') + '</div>' : '')
        + (l.removed ? '<div class="ex-warn">Removed by ' + esc(l.removedBy) + ': ' + esc(l.removedReason) + '</div>' : '') + '</td>'
        + '<td data-l="Receipt no."><input data-f="receiptNumber" value="' + esc(l.receiptNumber) + '"' + d + '></td>'
        + '<td data-l="Amount" class="ex-num"><input type="number" inputmode="decimal" step="0.01" min="0" data-f="amount" value="' + esc(l.amount) + '"' + d + '></td>'
        + '</tr>';
    }).join('');
    return '<h3 class="ex-h3">Expenses</h3>'
      + '<div class="ex-linebar">'
      + (ed ? '<button type="button" class="ex-btn" data-act="exAddLine">+ Add expense</button>' : '')
      + (mayRemove ? '<button type="button" class="ex-btn" data-act="exRemoveSel" id="exRemoveBtn"' + (S.selected.size ? '' : ' disabled') + '>Remove selected (' + S.selected.size + ')</button>' : '')
      // The column headings sort too, but a phone shows no headings: this works everywhere.
      + '<select id="exLineSort" aria-label="Sort expenses">'
      + [['sort', 'Order added'], ['date', 'Date'], ['category', 'Category'], ['supplier', 'Supplier'], ['amount', 'Amount']]
        .map(([k, label]) => '<option value="' + k + '"' + (S.lineSort.key === k ? ' selected' : '') + '>Sort: ' + label + '</option>').join('')
      + '</select>'
      + '<span class="ex-dim">Removed lines stay on record.</span>'
      + '</div>'
      + '<div class="ex-tablewrap"><table class="ex-lines"><thead><tr><th></th>'
      + head('date', 'Date') + head('category', 'Category') + head('supplier', 'Supplier') + head('description', 'Description')
      + head('receiptNumber', 'Receipt no.') + head('amount', 'Amount')
      + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function actionsBlock() {
    const c = S.claim;
    let h = '<div class="ex-actions">';
    if (c.canEdit) h += '<button type="button" class="ex-btn" data-act="exSave">Save draft</button>';
    if (c.canEdit) {
      h += '<div class="ex-declare"><label><input type="checkbox" id="exDeclare"> I confirm these expenses were incurred for TAGEX business, '
        + 'the information is accurate, supporting documents are attached where required, and I have not claimed them before.</label>'
        + '<button type="button" class="ex-btn primary" data-act="exSubmit">Submit for approval</button></div>';
    }
    if (c.canExport && c.id) h += '<button type="button" class="ex-btn" data-act="exExport">Download expense sheet</button>';
    if (c.canReview) {
      h += '<div class="ex-review"><h3 class="ex-h3">Review</h3>'
        + field('Approved amount', '<input type="number" step="0.01" min="0" id="exApproveAmt" placeholder="' + esc((S.lines.filter((l) => !l.removed).reduce((s, l) => s + (Number(l.amount) || 0), 0)).toFixed(2)) + '">')
        + field('Comment (required to reject or ask)', '<textarea id="exReviewNote" rows="2"></textarea>', true)
        + '<div class="ex-actions">'
        + '<button type="button" class="ex-btn primary" data-act="exReview" data-a="approve">Approve</button>'
        + '<button type="button" class="ex-btn" data-act="exReview" data-a="request_info">Ask for information</button>'
        + '<button type="button" class="ex-btn danger" data-act="exReview" data-a="reject">Reject</button>'
        + '</div></div>';
    }
    return h + '</div><div id="exMsg"></div>';
  }

  function historyBlock() {
    if (!S.history.length) return '';
    return '<h3 class="ex-h3">History</h3><ol class="ex-hist">' + S.history.map((h) => '<li><b>' + esc(h.event) + '</b> '
      + esc(h.by) + ' <span class="ex-dim">' + esc(h.at ? h.at.replace('T', ' ').slice(0, 16) : '') + '</span>'
      + (h.from || h.to ? ' <span class="ex-dim">' + esc(h.from) + ' → ' + esc(h.to) + '</span>' : '')
      + (h.comment ? '<div>' + esc(h.comment) + '</div>' : '') + '</li>').join('') + '</ol>';
  }

  // Read the form back into S before anything repaints it.
  function collect() {
    if (!S.claim || !S.claim.canEdit) return;
    const v = (id) => ($(id) ? $(id).value : '');
    Object.assign(S.claim, { date: v('exDate'), project: v('exProject'), client: v('exClient'), claimType: v('exType'),
      paymentMethod: v('exPay'), kilometres: v('exKm'), description: v('exDesc') });
    document.querySelectorAll('#exDetail tr[data-line]').forEach((tr) => {
      const l = S.lines.find((x) => lineKey(x) === tr.dataset.line);
      if (!l || l.removed) return;
      tr.querySelectorAll('[data-f]').forEach((inp) => { l[inp.dataset.f] = inp.value; });
    });
  }

  function payload() {
    const c = S.claim;
    return {
      claim: { claimDate: c.date, jobcardId: S.claimJc ? S.claimJc.id : '', project: c.project, client: c.client,
        claimType: c.claimType, paymentMethod: c.paymentMethod, kilometres: c.kilometres, description: c.description },
      // A blank new row is left out rather than saved as an empty expense.
      lines: S.lines.filter((l) => !l.removed && (l.id || l.amount !== '' || l.description || l.supplier))
        .map((l) => ({ id: l.id || undefined, date: l.date, categoryId: l.categoryId, supplier: l.supplier,
          description: l.description, receiptNumber: l.receiptNumber, amount: l.amount === '' ? null : l.amount })),
    };
  }

  async function busy(fn) {
    if (S.busy) return;
    S.busy = true;
    document.querySelectorAll('#exDetail .ex-btn').forEach((b) => { b.disabled = true; });
    try { await fn(); } catch (e) { msg('exMsg', TX.errorText(e), 'err'); } finally {
      S.busy = false;
      document.querySelectorAll('#exDetail .ex-btn').forEach((b) => { b.disabled = b.id === 'exRemoveBtn' && !S.selected.size; });
    }
  }

  const save = () => busy(async () => {
    collect();
    const r = await api({ op: 'save', claimId: S.claim.id || undefined, requestId: S.claim.id ? undefined : S.requestId, ...payload() });
    setClaim(r);
    msg('exMsg', 'Saved.', 'ok');
  });

  const submit = () => busy(async () => {
    if (!$('exDeclare').checked) return msg('exMsg', 'Tick the declaration first.', 'err');
    collect();
    let r = await api({ op: 'save', claimId: S.claim.id || undefined, requestId: S.claim.id ? undefined : S.requestId, ...payload() });
    r = await api({ op: 'submit', claimId: r.claim.id, declaration: true });
    setClaim(r);
    msg('exMsg', 'Submitted. ' + (r.claim.ref || '') + ' is now awaiting approval.', 'ok');
  });

  const reviewAct = (action) => busy(async () => {
    const comment = $('exReviewNote').value.trim();
    if (action !== 'approve' && !comment) return msg('exMsg', 'Say why, in the comment.', 'err');
    const amt = $('exApproveAmt').value;
    const r = await api({ op: 'review', claimId: S.claim.id, action, comment, approvedAmount: amt === '' ? undefined : amt });
    setClaim(r);
    msg('exMsg', { approve: 'Approved.', reject: 'Rejected.', request_info: 'Sent back for information.' }[action], 'ok');
  });

  const removeSelected = () => busy(async () => {
    const keys = [...S.selected];
    if (!keys.length) return;
    // eslint-disable-next-line no-alert
    const reason = window.prompt('Why are ' + (keys.length === 1 ? 'this line' : 'these ' + keys.length + ' lines') + ' being removed? (e.g. duplicate of another claim)');
    if (!reason || !reason.trim()) return;
    if (S.claim.canEdit) { collect(); setClaim(await api({ op: 'save', claimId: S.claim.id, ...payload() })); }
    let r = null;
    for (const k of keys) r = await api({ op: 'remove_line', claimId: S.claim.id, itemId: k, reason: reason.trim() });
    S.selected.clear();
    if (r) setClaim(r);
    msg('exMsg', 'Removed and logged in the history.', 'ok');
  });

  const exportSheet = () => busy(async () => {
    const r = await api({ op: 'export', claimId: S.claim.id });
    const bytes = Uint8Array.from(atob(r.base64), (ch) => ch.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a');
    a.href = url; a.download = r.filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    msg('exMsg', 'Downloaded ' + r.filename + '.', 'ok');
  });

  function msg(id, text, tone) {
    const el = $(id);
    if (!el) return;
    el.innerHTML = text ? '<div class="status ' + (tone || 'inf') + '">' + esc(text) + '</div>' : '';
  }

  function back() {
    $('exDetail').hidden = true;
    $('exDetail').innerHTML = '';
    $('exList').hidden = false;
    S.claim = null;
    load();
  }

  // ── events ──────────────────────────────────────────────────────────────

  document.addEventListener('click', (e) => {
    const t = e.target.closest('#modExpenses [data-act]');
    if (!t) return;
    const a = t.dataset.act;
    if (a === 'exReload') return load();
    if (a === 'exNew') return startNew();
    if (a === 'exOpen') return open(t.dataset.id);
    if (a === 'exBack') return back();
    if (a === 'exSave') return save();
    if (a === 'exSubmit') return submit();
    if (a === 'exExport') return exportSheet();
    if (a === 'exReview') return reviewAct(t.dataset.a);
    if (a === 'exRemoveSel') return removeSelected();
    if (a === 'exAddLine') { collect(); S.lines.push(blankLine()); return paintDetail(); }
    if (a === 'exSortLines') {
      collect();
      S.lineSort = { key: t.dataset.k, dir: S.lineSort.key === t.dataset.k ? -S.lineSort.dir : 1 };
      return paintDetail();
    }
    if (a === 'exSel') {
      if (t.checked) S.selected.add(t.dataset.k); else S.selected.delete(t.dataset.k);
      const b = $('exRemoveBtn');
      if (b) { b.disabled = !S.selected.size; b.textContent = 'Remove selected (' + S.selected.size + ')'; }
      return;
    }
    if (a === 'exJcPick' || a === 'exJcClear') {
      const which = t.dataset.which;
      const chosen = a === 'exJcPick' ? (S.jcResults || [])[Number(t.dataset.i)] : null;
      if (which === 'filter') {
        S.filterJc = chosen;
        paintJcPick(document.querySelector('[data-jcpick="filter"]'), chosen, 'filter');
        return load();
      }
      collect();
      S.claimJc = chosen;
      // A job card answers "which project": fill the client from it when none is typed yet.
      if (chosen && S.claim && !S.claim.client && chosen.client) S.claim.client = chosen.client;
      return paintDetail();
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.matches('#modExpenses .ex-jc-q')) return jcSearch(e.target);
    if (e.target.matches('#exSearch')) return paintList();
    if (e.target.matches('#exDetail [data-f="amount"]')) {
      collect();
      const t = S.lines.filter((l) => !l.removed).reduce((s, l) => s + (Number(l.amount) || 0), 0);
      if ($('exTotal')) $('exTotal').textContent = money(t);
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.matches('#exStatus, #exMine')) return load();
    if (e.target.matches('#exSort')) return paintList();
    if (e.target.matches('#exLineSort')) {
      collect();
      // Amounts read best largest first; everything else ascending.
      S.lineSort = { key: e.target.value, dir: e.target.value === 'amount' ? -1 : 1 };
      return paintDetail();
    }
  });

  TX.expenses = { start };
})();
