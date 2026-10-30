// TAGEX O&M scheduler — Clients tab: the maintenance subscriber contracts (SxE Portfolio Maintenance Cost
// Log, 26 Oct 2026) and a report over them. Brought over from the delivery app on 30 Oct 2026 (Raymond: "I
// want this CLIENTS tab in the scheduler application as well, replacing the existing tab"), where it is
// public/js/mod-clients.js. The server half is the same module (api/_lib/clientsreport.js) behind the same
// key, so the same people see it in both apps and the two cannot give different figures.
//
// The user ticks the categories and the sections; the server builds the report. This screen draws it,
// filters and sorts it, drills into a category, and links a contract to a client record. The O&M figures
// are sent only to an account holding clients_money; the money columns are left out when the answer has
// none, so nothing here re-creates them. Linking needs clients_report edit (the server says so in canLink)
// and is checked again on every link.
//
// DIFFERENT FROM THE DELIVERY APP, on purpose:
//   - The Excel file is an HTML table saved as .xls, which Excel opens. The delivery app uses the SheetJS
//     library from a CDN; this app's CSP allows scripts from itself only, and the report is a few tables.
//   - Its own markup is drawn here into #om-cli-report, and it keeps its own small dispatcher on that
//     panel: mod-scheduler.js's dispatcher ignores an action it does not know, so the two do not meet.
//   - Classes are the scheduler's (btn, om-hint, om-err ...) plus cl-* in scheduler.css.

(function () {
  'use strict';

  const esc = TX.esc;
  const $ = (sel) => document.querySelector(sel);
  const CATEGORIES = ['PPA', 'Alpine', 'TxE', 'PrefCap'];
  const SECTIONS = [
    { id: 'summary', label: 'Totals by category' },
    { id: 'subscribers', label: 'Subscriber contracts' },
    { id: 'equipment', label: 'Equipment by type and funder' },
    { id: 'clients', label: 'Clients' },
  ];
  const TYPES = ['PV panel', 'Inverter', 'Battery', 'PV-Therm'];
  const BASES = ['O&M', 'Not linked'];

  let started = false;
  let DATA = null;          // the last report the server built
  const SORT = {};          // table id -> { k, dir }, kept for the session
  const FILT = {};          // table id -> { column key: text or choice }, kept for the session
  let DRILL = null;         // a category the user drilled into, or null
  let PICK = null;          // the subscriber contract being linked, or null
  let SEARCH_TIMER = null;

  const canExport = () => TX.can('clients_report', 'export');
  const money = (n) => {
    const [w, c] = Math.abs(Number(n || 0)).toFixed(2).split('.');
    return (Number(n) < 0 ? '-R ' : 'R ') + w.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + '.' + c;
  };
  const dash = (v) => (v == null || v === '' ? '—' : String(v));

  function say(kind, html) {
    const el = $('#clMsg');
    const cls = kind === 'err' ? 'om-err' : kind === 'ok' ? 'om-ok' : 'om-hint';
    if (el) el.innerHTML = html ? '<div class="' + cls + '">' + html + '</div>' : '';
  }

  function picks(name) {
    return Array.prototype.map.call(document.querySelectorAll('#om-cli-report input[name="' + name + '"]:checked'), (x) => x.value);
  }

  // The panel: the tick boxes are drawn from the lists above; the server holds the same lists and refuses others.
  function drawPanel() {
    const host = $('#om-cli-report');
    if (!host) return false;
    if (!TX.can('clients_report', 'view')) {
      host.innerHTML = '<div class="om-empty">The Clients report is switched on per person (clients_report in Access levels). Ask an Admin to switch it on for you.</div>';
      return false;
    }
    if (host.dataset.drawn) return true;
    host.dataset.drawn = '1';
    host.innerHTML = '<div class="om-fttl" style="margin-bottom:4px">Clients</div>'
      + '<div class="om-hint">Maintenance subscriber contracts from the SxE Portfolio Maintenance Cost Log (26 Oct 2026). '
      + 'Tick the categories and sections to include, then build the report.</div>'
      + '<div class="cl-choices">'
      + '<fieldset class="cl-set"><legend>Categories</legend>'
      + CATEGORIES.map((c) => '<label class="cl-tick"><input type="checkbox" name="cat" value="' + c + '" checked> ' + c + '</label>').join('')
      + '</fieldset><fieldset class="cl-set"><legend>Sections</legend>'
      + SECTIONS.map((s) => '<label class="cl-tick"><input type="checkbox" name="sec" value="' + s.id + '" checked> ' + esc(s.label) + '</label>').join('')
      + '</fieldset></div>'
      + '<div class="cl-bar"><button type="button" class="btn sm" data-act="clBuild">Build report</button>'
      + '<button type="button" class="btn ghost sm" id="clExport" data-act="clExport" hidden>&#8681; Excel report</button></div>'
      + '<div id="clMsg"></div><div id="clReport"></div>';
    return true;
  }

  async function build(exporting) {
    const cats = picks('cat');
    const secs = picks('sec');
    if (!cats.length) return say('err', 'Tick at least one category.');
    if (!secs.length) return say('err', 'Tick at least one section.');
    say('inf', exporting ? 'Preparing the report&hellip;' : 'Building the report&hellip;');
    try {
      const d = await TX.api({ op: 'clients_report', action: exporting ? 'report_export' : 'report', categories: cats, sections: secs });
      DATA = d;
      if (exporting) {
        download(workbookHtml(d), 'TAGEX clients report ' + d.generated + '.xls');
        say('ok', 'Report downloaded: ' + d.contracts + ' contract(s).');
      } else {
        say('', '');
      }
      render(d);
    } catch (e) {
      say('err', esc(TX.errorText(e)));
    }
  }

  // ── the tables: one description each, drawn on screen and written to Excel the same way ──────

  function col(k, label, extra) { return Object.assign({ k, label, filter: true }, extra || {}); }

  function tables(d) {
    const out = [];
    if (d.summary) {
      const cols = [col('category', 'Category', { options: CATEGORIES }), col('contracts', 'Contracts', { num: true })];
      if (d.money) cols.push(col('omReceived', 'O&M received', { num: true, money: true }));
      out.push({ id: 'summary', title: 'Totals by category', cols, rows: d.summary.byCategory, drill: true,
        total: d.money ? { category: 'Total', contracts: d.contracts, omReceived: d.summary.omReceived } : { category: 'Total', contracts: d.contracts } });
    }
    if (d.subscribers) {
      const cols = [col('category', 'Category', { options: CATEGORIES }), col('contract', 'Contract'), col('client', 'Client'),
        col('firstInvoice', 'First invoice'), col('description', 'System'), col('clientBase', 'Client base', { options: BASES }),
        col('linkedClient', 'Linked client')];
      if (d.money) cols.splice(5, 0, col('omReceived', 'O&M received', { num: true, money: true }));
      out.push({ id: 'subscribers', title: 'Subscriber contracts', cols, rows: d.subscribers, link: !!d.canLink });
    }
    if (d.equipmentByType) {
      out.push({ id: 'equipType', title: 'Equipment by type',
        cols: [col('type', 'Type', { options: TYPES }), col('item', 'Item'), col('systems', 'Systems', { num: true }), col('qty', 'Units', { num: true })],
        rows: d.equipmentByType });
      out.push({ id: 'equipFunder', title: 'Equipment by funder',
        cols: [col('funder', 'Funder', { options: CATEGORIES }), col('type', 'Type', { options: TYPES }), col('item', 'Item'),
          col('systems', 'Systems', { num: true }), col('qty', 'Units', { num: true })],
        rows: d.equipmentByFunder });
    }
    if (d.clients) {
      out.push({ id: 'clients', title: 'Clients', cols: [col('name', 'Client'), col('contracts', 'Contracts', { num: true })], rows: d.clients });
    }
    return out;
  }

  const filtered = (id) => !!(FILT[id] && Object.keys(FILT[id]).some((k) => FILT[id][k]));

  // The rows the table shows: the filters first, then the sort. Blanks always go last.
  function shown(t) {
    const f = FILT[t.id] || {};
    const keys = Object.keys(f).filter((k) => f[k]);
    const rows = t.rows.filter((r) => keys.every((k) => {
      const c = t.cols.find((x) => x.k === k);
      const v = r[k] == null ? '' : String(r[k]);
      return c && c.options ? v === f[k] : v.toLowerCase().includes(String(f[k]).toLowerCase());
    }));
    const s = SORT[t.id];
    if (!s) return rows;
    const c = t.cols.find((x) => x.k === s.k);
    const num = c && c.num;
    const cmp = (a, b) => {
      const x = a[s.k], y = b[s.k];
      const blankX = x == null || x === '', blankY = y == null || y === '';
      if (blankX || blankY) return blankX === blankY ? 0 : blankX ? 1 : -1;
      return num ? Number(x) - Number(y) : String(x).localeCompare(String(y), 'en', { numeric: true, sensitivity: 'base' });
    };
    return rows.slice().sort((a, b) => cmp(a, b) * s.dir);
  }

  function cell(c, r) {
    const v = r[c.k];
    if (c.money) return money(v);
    if (c.num) return v == null ? '—' : Number(v).toLocaleString('en-ZA');
    return esc(dash(v));
  }

  function bodyHtml(t) {
    const rows = shown(t).map((r) => '<tr>' + t.cols.map((c) => {
      // The category on a summary line is the drill: press it to see that category alone.
      if (t.drill && c.k === 'category') {
        return '<td><button type="button" class="cl-sort" data-act="clDrill" data-a1="' + esc(r.category) + '">' + esc(r.category) + '</button></td>';
      }
      return '<td' + (c.num ? ' class="cl-num"' : '') + '>' + cell(c, r) + '</td>';
    }).join('') + (t.link ? '<td><button type="button" class="btn ghost sm" data-act="clSuggest" data-a1="' + esc(r.id) + '">Link client</button></td>' : '') + '</tr>');
    const body = rows.length ? rows.join('') : '<tr><td colspan="' + (t.cols.length + (t.link ? 1 : 0)) + '" class="om-hint">Nothing matches the filters.</td></tr>';
    const foot = t.total && !filtered(t.id)
      ? '<tr class="cl-total">' + t.cols.map((c) => '<td' + (c.num ? ' class="cl-num"' : '') + '>' + (t.total[c.k] == null ? '' : cell(c, t.total)) + '</td>').join('') + '</tr>' : '';
    return body + foot;
  }

  function filterCell(t, c) {
    const f = (FILT[t.id] || {})[c.k] || '';
    if (c.options) {
      return '<select aria-label="Filter ' + esc(c.label) + '" data-on="change" data-act="clFilter" data-a1="' + t.id + '" data-a2="' + c.k + '" data-a3="@val">'
        + '<option value="">All</option>' + c.options.map((o) => '<option' + (o === f ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
    }
    return '<input type="search" placeholder="Filter" aria-label="Filter ' + esc(c.label) + '" value="' + esc(f) + '" autocomplete="off"'
      + ' data-on="input" data-act="clFilter" data-a1="' + t.id + '" data-a2="' + c.k + '" data-a3="@val">';
  }

  function tableHtml(t) {
    const s = SORT[t.id];
    const head = t.cols.map((c) => {
      const arrow = s && s.k === c.k ? (s.dir > 0 ? ' ▲' : ' ▼') : '';
      return '<th><button type="button" class="cl-sort" data-act="clSort" data-a1="' + t.id + '" data-a2="' + c.k + '">'
        + esc(c.label) + arrow + '</button></th>';
    }).join('') + (t.link ? '<th></th>' : '');
    const filters = t.cols.map((c) => '<td>' + (c.filter ? filterCell(t, c) : '') + '</td>').join('') + (t.link ? '<td></td>' : '');
    return '<section class="cl-block"><h3 class="cl-h">' + esc(t.title) + '</h3>'
      + '<div class="cl-scroll"><table class="cl-table"><thead><tr>' + head + '</tr><tr class="cl-filters">' + filters + '</tr></thead>'
      + '<tbody id="clB-' + t.id + '">' + bodyHtml(t) + '</tbody></table></div></section>';
  }

  // Redraw one table's rows only, so a filter being typed into keeps its place.
  function refreshTable(id) {
    const t = DATA && tables(DATA).find((x) => x.id === id);
    const b = $('#clB-' + id);
    if (t && b) b.innerHTML = bodyHtml(t);
  }

  function render(d) {
    const host = $('#clReport');
    if (!host) return;
    const parts = [];
    if (DRILL) {
      parts.push('<div class="cl-drill">Showing <b>' + esc(DRILL) + '</b> only. <button type="button" class="btn ghost sm" data-act="clDrill">Show all</button></div>');
    }
    if (PICK) parts.push(pickerHtml());
    parts.push(...tables(d).map(tableHtml));
    if (d.equipmentByType && !d.equipmentByType.length) {
      parts.push('<p class="om-hint">No equipment recorded yet. The cost log’s Asset Registry columns are blank; they are filled in on the subscriber table as each system is confirmed.</p>');
    }
    if (d.clients && d.unlinked) parts.push('<p class="om-hint">' + d.unlinked + ' contract(s) are not linked to a client record yet.</p>');
    if (!d.money) parts.push('<p class="om-hint">The O&amp;M figures are not shown to your account.</p>');
    host.innerHTML = parts.join('') || '<p class="om-hint">Nothing selected.</p>';
    const x = $('#clExport');
    if (x) x.hidden = !canExport();
  }

  // ── linking a contract to a client record ───────────────────────────────────────────────────

  function pickerHtml() {
    const c = DATA && DATA.subscribers && DATA.subscribers.find((r) => r.id === PICK);
    const who = c ? esc(c.contract + ' · ' + c.client) : 'this contract';
    return '<div class="cl-pick" id="clPick"><h3 class="cl-h">Link ' + who + ' to a client</h3>'
      + '<p class="om-hint">Type a name to search the client records. Pick one to link it, or make a new client from the name typed.</p>'
      + '<div class="cl-bar"><input type="search" id="clSearch" aria-label="Search clients" placeholder="Search client name&hellip;" autocomplete="off"'
      + ' data-on="input" data-act="clSearch" data-a1="@val"></div>'
      + '<div id="clHits"></div>'
      + '<div class="cl-bar">'
      + (c && c.clientBase !== 'Not linked' ? '<button type="button" class="btn ghost sm" data-act="clUnlink" data-a1="' + esc(PICK) + '">Unlink</button>' : '')
      + '<button type="button" class="btn ghost sm" data-act="clCancelPick">Cancel</button></div></div>';
  }

  async function search(q) {
    const box = $('#clHits');
    if (!box) return;
    q = String(q || '').trim();
    if (q.length < 2) { box.innerHTML = ''; return; }
    try {
      const d = await TX.api({ op: 'clients_report', action: 'clients_search', q });
      if (!$('#clHits')) return;
      const exact = d.hits.some((h) => h.name.toLowerCase() === q.toLowerCase());
      const hits = d.hits.length
        ? '<ul class="cl-hits">' + d.hits.map((h) => '<li><button type="button" class="btn ghost sm" data-act="clLink" data-a1="' + esc(PICK)
          + '" data-a2="' + esc(h.id) + '">' + esc(h.name) + '</button></li>').join('') + '</ul>'
        : '<p class="om-hint">No O&amp;M client matches &ldquo;' + esc(q) + '&rdquo;.</p>';
      const make = exact ? '' : '<button type="button" class="btn ghost sm" data-act="clNew" data-a1="' + esc(PICK) + '">Make a new O&amp;M client called &ldquo;' + esc(q) + '&rdquo;</button>';
      $('#clHits').innerHTML = hits + make;
    } catch (e) {
      $('#clHits').innerHTML = '<div class="om-err">' + esc(TX.errorText(e)) + '</div>';
    }
  }

  async function saveLink(body) {
    say('inf', 'Saving the link&hellip;');
    try {
      await TX.api(Object.assign({ op: 'clients_report', action: 'link_client', subscriber: PICK }, body));
      PICK = null;
      say('ok', 'Link saved.');
      await build(false);
    } catch (e) {
      say('err', esc(TX.errorText(e)));
    }
  }

  function applyDrill(cat) {
    DRILL = cat || null;
    FILT.subscribers = Object.assign({}, FILT.subscribers, { category: DRILL || '' });
    FILT.equipFunder = Object.assign({}, FILT.equipFunder, { funder: DRILL || '' });
    if (DATA) render(DATA);
  }

  // The Link client button. An exact O&M match is linked at once; nothing close is made into a new O&M client;
  // anything close is listed for the user to choose.
  async function suggestFor(sub) {
    PICK = sub;
    say('inf', 'Looking for this client&hellip;');
    try {
      const d = await TX.api({ op: 'clients_report', action: 'suggest_link', subscriber: sub });
      if (d.exact) {
        say('inf', 'Linking to ' + esc(d.exact.name) + '&hellip;');
        return saveLink({ client: d.exact.id });
      }
      if (!d.options.length && d.omAllowed) return saveLink({ create: d.name });
      say('', '');
      if (DATA) render(DATA);
      const box = $('#clHits');
      if (!box) return;
      const opts = d.options.map((o) => '<li><button type="button" class="btn ghost sm" data-act="clLink" data-a1="' + esc(sub)
        + '" data-a2="' + esc(o.id) + '">' + esc(o.name) + ' <span class="om-hint">(' + Math.round(o.score * 100) + '% match)</span></button></li>').join('');
      box.innerHTML = (d.options.length
        ? '<p class="om-hint">No exact match for &ldquo;' + esc(d.name) + '&rdquo;. Pick the client it is, or make a new one:</p><ul class="cl-hits">' + opts + '</ul>'
        : '<p class="om-hint">No O&amp;M access here, so search for the client:</p>')
        + '<button type="button" class="btn ghost sm" data-act="clNew" data-a1="' + esc(sub) + '" data-a2="' + esc(d.name) + '">Make a new O&amp;M client called &ldquo;' + esc(d.name) + '&rdquo;</button>';
      const panelEl = $('#clPick');
      if (panelEl) panelEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      say('err', esc(TX.errorText(e)));
    }
  }

  const ACTIONS = {
    clSuggest: (sub) => suggestFor(sub),
    clBuild: () => build(false),
    clExport: () => build(true),
    clSort: (id, k) => {
      const cur = SORT[id];
      SORT[id] = { k, dir: cur && cur.k === k ? -cur.dir : 1 };
      if (DATA) render(DATA);
    },
    clFilter: (id, k, v) => {
      FILT[id] = Object.assign({}, FILT[id], { [k]: v || '' });
      refreshTable(id);
    },
    clDrill: (cat) => applyDrill(cat),
    clCancelPick: () => { PICK = null; if (DATA) render(DATA); },
    clSearch: (q) => { clearTimeout(SEARCH_TIMER); SEARCH_TIMER = setTimeout(() => search(q), 250); },
    clLink: (sub, client) => saveLink({ client }),
    // A name picked from the O&M list is passed in; otherwise the name typed in the search box is used.
    clNew: (sub, name) => {
      const s = $('#clSearch');
      saveLink({ create: name || (s ? s.value : '') });
    },
    clUnlink: () => saveLink({ client: '' }),
  };

  function dispatch(e) {
    const el = e.target.closest('[data-act]');
    if (!el || (el.dataset.on || 'click') !== e.type) return;
    const fn = ACTIONS[el.dataset.act];
    if (!fn) return;
    const args = [el.dataset.a1, el.dataset.a2, el.dataset.a3]
      .filter((x) => x !== undefined)
      .map((x) => (x === '@val' ? el.value : x));
    fn(...args);
  }

  // The Excel report: one table per section, in the filters and sort the screen shows. An HTML table saved
  // as .xls opens in Excel as a sheet; numbers are left bare so Excel reads them as numbers.
  function workbookHtml(d) {
    const parts = tables(d).map((t) => {
      const head = '<tr>' + t.cols.map((c) => '<th>' + esc(c.money ? c.label + ' (R)' : c.label) + '</th>').join('') + '</tr>';
      const line = (r) => '<tr>' + t.cols.map((c) => '<td>' + esc(r[c.k] == null ? '' : r[c.k]) + '</td>').join('') + '</tr>';
      const rows = shown(t).map(line).join('') + (t.total && !filtered(t.id) ? line(t.total) : '');
      return '<h3>' + esc(t.title) + '</h3><table border="1">' + head + rows + '</table><br>';
    });
    return '<html><head><meta charset="utf-8"></head><body><h2>TAGEX clients report ' + esc(d.generated) + '</h2>'
      + parts.join('') + '</body></html>';
  }

  function download(html, name) {
    const url = URL.createObjectURL(new Blob(['﻿' + html], { type: 'application/vnd.ms-excel' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // Called each time the Clients tab is opened (mod-scheduler.js omGoView).
  function start() {
    if (!drawPanel() || started) return;
    started = true;
    const panel = $('#om-cli-report');
    panel.addEventListener('click', (e) => {
      if (e.target.closest('input, select, textarea')) return;
      dispatch(e);
    });
    panel.addEventListener('input', dispatch);
    panel.addEventListener('change', dispatch);
    TX.on('auth:signedout', () => { DATA = null; PICK = null; });
  }

  TX.clientsReport = { start, build: (exporting) => build(!!exporting), _workbookHtml: workbookHtml };
})();
