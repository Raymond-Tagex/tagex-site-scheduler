// A job card's stock returns, on its detail screen.
//
// Stock back from site against a delivery note is raised, received and closed in the delivery app
// (its Stock Returns tab, 23 Nov 2026), whose server is the only writer of the Stock Returns table.
// Raymond asked for returns to be linked to job cards; this shows them there. Read only: the proxy
// refuses every write to stock_returns (tables.js readOnly).
//
// Credit Value is what went back on the shelf, and the delivery app's Project Costing takes it off
// the job's materials -- so it is money, shown only to a role that may view costing. The proxy
// strips it for everyone else whatever this file does; it is not even asked for here.
//
// O&M only: RES has no Stock Returns table, so the job card's link field exists only in O&M.
//
// Loaded as a plain script in the browser (TX.stockReturns) and with require() by the test suite.

(function (root) {
  'use strict';

  // Job Cards → Stock Returns (O&M). RES has no such field.
  const JC_LINK = { OM: 'fldBuIF7PduXj9jh9' };
  const BASE_FIELDS = ['Return Number', 'Status', 'Return Date', 'DN Number'];
  const CREDIT = 'Credit Value';
  // The statuses whose credit is off the job's materials, as the delivery app's Project Costing counts it.
  const CREDITED = ['Received', 'Closed'];
  const CHUNK = 50;

  /** The link field for this base, or null where the base has no stock returns. */
  function linkField(base) { return JC_LINK[base] || null; }

  /** The returns a job card links to, as record ids. Null when the field is absent (not readable here). */
  function idsOf(fields, base) {
    const fid = linkField(base);
    if (!fid || !fields || !(fid in fields)) return null;
    return [].concat(fields[fid] || []).map((x) => (x && x.id) || x).filter((x) => typeof x === 'string' && /^rec\w+$/.test(x));
  }

  /** The fields to ask for: the credit only for a role that may view costing. */
  function fieldsFor(canCost) { return canCost ? BASE_FIELDS.concat(CREDIT) : BASE_FIELDS.slice(); }

  /** One filterByFormula per chunk of ids. Record ids only, so nothing a person typed reaches a formula. */
  function filters(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      out.push('OR(' + ids.slice(i, i + CHUNK).map((x) => 'RECORD_ID()="' + x + '"').join(',') + ')');
    }
    return out;
  }

  const sel = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v.name : v) || '';
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const rand = (n) => 'R ' + Number(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dateText = (d) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
    if (!m) return '';
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1];
    return mon ? Number(m[3]) + ' ' + mon + ' ' + m[1] : '';
  };

  /** Rows for the screen, newest first. Credit is null for a role without costing view, whatever the record holds. */
  function rows(records, canCost) {
    return (records || []).map((r) => {
      const f = (r && r.fields) || {};
      return {
        id: r.id,
        number: f['Return Number'] || '',
        status: sel(f.Status),
        date: f['Return Date'] || '',
        dn: f['DN Number'] || '',
        credit: canCost ? num(f[CREDIT]) : null,
      };
    }).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.number).localeCompare(String(a.number)));
  }

  /** Credit off the job's materials: received and closed returns only. */
  function creditTotal(list) {
    return list.filter((r) => CREDITED.includes(r.status) && r.credit !== null).reduce((s, r) => s + r.credit, 0);
  }

  const STATUS_COLOUR = { Submitted: '#f0c000', Received: 'var(--accent)', Closed: 'var(--muted2)', Cancelled: '#e05555' };

  /**
   * The section's HTML. state: { rows, error } from the loader, or null when nothing is to be drawn
   * (wrong base, no stock_returns view, link not readable). esc is the page's escaper.
   */
  function panelHtml(state, o) {
    if (!state) return '';
    const esc = o.esc;
    const list = state.rows || [];
    const head = '<div class="om-slbl">Stock returns' + (list.length ? ' (' + list.length + ')' : '') + '</div>';
    if (state.error) {
      return '<div class="om-df om-sr">' + head + '<div class="om-err">⚠ Could not read stock returns: ' + esc(state.error) + '</div></div>';
    }
    if (!list.length) {
      return '<div class="om-df om-sr">' + head + '<div style="font-size:12px;color:var(--muted2)">None. Returns are raised against a delivery note in the delivery app.</div></div>';
    }
    const cell = 'padding:4px 6px;border-bottom:1px solid var(--line);';
    const th = (t, right) => '<th style="' + cell + 'text-align:' + (right ? 'right' : 'left') + ';font-weight:600;color:var(--muted2)">' + t + '</th>';
    const body = list.map((r) => '<tr>'
      + '<td style="' + cell + 'font-family:monospace">' + esc(r.number || '—') + '</td>'
      + '<td style="' + cell + 'color:' + (STATUS_COLOUR[r.status] || 'inherit') + '">' + esc(r.status || '—') + '</td>'
      + '<td style="' + cell + '">' + esc(dateText(r.date) || '—') + '</td>'
      + '<td style="' + cell + 'font-family:monospace">' + esc(r.dn || '—') + '</td>'
      + (o.canCost ? '<td style="' + cell + 'text-align:right;font-family:monospace">' + (r.credit !== null ? esc(rand(r.credit)) : '—') + '</td>' : '')
      + '</tr>').join('');
    const foot = o.canCost
      ? '<div style="font-size:12px;margin-top:6px">Credited to this job (received and closed): <b style="font-family:monospace">' + esc(rand(creditTotal(list))) + '</b></div>'
      : '';
    return '<div class="om-df om-sr">' + head
      + '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">'
      + '<thead><tr>' + th('Return') + th('Status') + th('Date') + th('Delivery note') + (o.canCost ? th('Credit', true) : '') + '</tr></thead>'
      + '<tbody>' + body + '</tbody></table></div>' + foot + '</div>';
  }

  const api = { JC_LINK, BASE_FIELDS, CREDIT, CREDITED, linkField, idsOf, fieldsFor, filters, rows, creditTotal, dateText, panelHtml };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TX.stockReturns = api;
})(typeof window !== 'undefined' ? window : this);
