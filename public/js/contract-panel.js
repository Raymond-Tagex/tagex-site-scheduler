// The contract behind a ticket or job card: who funds it, when warranty started, what is covered.
//
// Raymond, 28 Oct 2026: "There should be a clear indicator on each ticket and jobcard ... this will
// determine how the team act on repairs, costing etc." The facts come from the TAGEX Clients
// register's Contracts (loaded from the SxE Portfolio Maintenance Cost Log): the funder (its
// Portfolio field: PPA, Alpine, PrefCap, TxE), the 1st invoice date, which is when warranty
// starts, and the system as described there. A ticket or job card names its contract in its own
// Contract Number field, because links cannot cross bases.
//
// THE RULES, AS RAYMOND GAVE THEM. Warranty runs from the 1st invoice date:
//   Solax equipment (inverters, batteries etc)   10 years
//   PV panels                                    25 years
//   Workmanship                                   2 years
//   Material (breakers, isolators, DB boxes)      1 year
// Each funder receives a monthly fee from the client towards the monthly O&M service. TAGEX O&M
// holds a pre-approved budget per funder, which lets the technician do the work within it.
// Capital expenditure is not covered under the warranty.
//
// Loaded as a plain script in the browser (TX.contract) and with require() by the test suite.

(function (root) {
  'use strict';

  const WARRANTY = Object.freeze([
    { key: 'equipment',   label: 'Solax equipment (inverters, batteries)', years: 10 },
    { key: 'panels',      label: 'PV panels',                              years: 25 },
    { key: 'workmanship', label: 'Workmanship',                            years: 2 },
    { key: 'material',    label: 'Material (breakers, isolators, DB boxes)', years: 1 },
  ]);

  const ISO = /^(\d{4})-(\d{2})-(\d{2})/;

  /** 'YYYY-MM-DD' plus whole years, as 'YYYY-MM-DD'. 29 February lands on 1 March. */
  function addYears(iso, years) {
    const m = ISO.exec(String(iso || ''));
    if (!m) return '';
    const d = new Date(Date.UTC(+m[1] + years, +m[2] - 1, +m[3]));
    return d.toISOString().slice(0, 10);
  }

  /**
   * Each warranty class's end date and whether `today` is still inside it.
   * A cover is in force up to and including the day before its anniversary.
   * @returns {Array<{key,label,years,until,inWarranty}>} empty when there is no start date
   */
  function warranty(firstInvoice, today) {
    if (!ISO.test(String(firstInvoice || ''))) return [];
    const now = String(today || new Date().toISOString()).slice(0, 10);
    return WARRANTY.map((w) => {
      const until = addYears(firstInvoice, w.years);
      return Object.assign({}, w, { until, inWarranty: now < until });
    });
  }

  /**
   * Which of the client's contracts this record is for, and how that was decided.
   *   set     the record names it, and the register has it
   *   stale   the record names a contract the client no longer has (or never had)
   *   only    the record names none, and the client has exactly one -- shown, but not yet saved
   *   choose  the record names none and the client has several: someone must pick
   *   none    the client has no contract in the register
   *   unknown no client, or the register could not be read
   */
  function resolve(details, number) {
    const list = Array.isArray(details) ? details : null;
    const want = String(number || '').trim().toUpperCase();
    if (!list) return { how: 'unknown', contract: null, number: want };
    if (want) {
      const hit = list.find((d) => String(d.number || '').trim().toUpperCase() === want);
      return hit ? { how: 'set', contract: hit, number: want } : { how: 'stale', contract: null, number: want };
    }
    if (list.length === 1) return { how: 'only', contract: list[0], number: list[0].number };
    if (list.length > 1) return { how: 'choose', contract: null, number: '' };
    return { how: 'none', contract: null, number: '' };
  }

  const fmt = (iso) => String(iso || '').slice(0, 10);

  /**
   * The panel. Plain HTML from data already in the browser; every value goes through `esc`.
   * @param {object} o  { res (from resolve), details, esc, today, canEdit, act, recId }
   *   act: the data-act a contract choice dispatches to; recId its data-a1.
   */
  function panelHtml(o) {
    const esc = o.esc;
    const r = o.res;
    const c = r.contract;
    const list = Array.isArray(o.details) ? o.details : [];

    const picker = o.canEdit && list.length && o.act
      ? '<select class="om-con-pick" data-on="change" data-act="' + esc(o.act) + '" data-a1="' + esc(o.recId || '')
        + '" data-a2="@val" aria-label="Contract"><option value="">'
        + (r.how === 'set' ? 'Change contract…' : 'Choose the contract…') + '</option>'
        + list.map((d) => '<option value="' + esc(d.number) + '"' + (r.how === 'set' && c === d ? ' selected' : '') + '>'
          + esc(d.number) + (d.funder ? ' · ' + esc(d.funder) : '') + (d.system ? ' · ' + esc(d.system) : '')
          + '</option>').join('') + '</select>'
      : '';

    if (!c) {
      const msg = {
        stale: 'Contract ' + r.number + ' is on this record but not in the client’s contracts. Check it before any work is costed.',
        choose: 'This client has ' + list.length + ' contracts. Choose the one this is for: funder and warranty depend on it.',
        none: 'No contract in the register for this client. Funder and warranty are unknown — check before any work is costed.',
        unknown: 'The contract register could not be read, or there is no client yet. Funder and warranty are unknown.',
      }[r.how] || '';
      return '<div class="om-con om-con-' + esc(r.how) + '">'
        + '<div class="om-con-head"><span class="om-con-tag warn">⚠ Contract</span>'
        + (r.number ? '<b>' + esc(r.number) + '</b>' : '') + '</div>'
        + '<div class="om-con-msg">' + esc(msg) + '</div>' + picker + '</div>';
    }

    const w = warranty(c.firstInvoice, o.today);
    const rows = w.length
      ? w.map((x) => '<div class="om-con-w ' + (x.inWarranty ? 'in' : 'out') + '"><span>' + esc(x.label)
        + ' <i>' + x.years + (x.years === 1 ? ' year' : ' years') + '</i></span><b>'
        + (x.inWarranty ? '✓ In warranty until ' : '✕ Expired ') + esc(x.until) + '</b></div>').join('')
      : '<div class="om-con-msg">No 1st invoice date on the contract, so warranty cannot be worked out.</div>';

    return '<div class="om-con om-con-' + esc(r.how) + '">'
      + '<div class="om-con-head">'
      + (c.funder ? '<span class="om-con-tag fund">' + esc(c.funder) + '</span>' : '<span class="om-con-tag warn">No funder</span>')
      + '<b>' + esc(c.number) + '</b>'
      + (c.kind ? '<span class="om-con-kind">' + esc(c.kind) + '</span>' : '')
      + (r.how === 'only' ? '<span class="om-con-kind">client’s only contract — not yet saved here</span>' : '')
      + '</div>'
      + '<div class="om-con-facts">'
      + '<div><span>System installed</span><b>' + esc(c.system || '—') + '</b></div>'
      + '<div><span>Warranty start (1st invoice)</span><b>' + esc(fmt(c.firstInvoice) || '—') + '</b></div>'
      + '</div>'
      + '<div class="om-con-ws">' + rows + '</div>'
      + '<div class="om-con-rule">' + (c.funder
        ? esc(c.funder) + ' is paid a monthly O&amp;M fee by the client. Work within TAGEX O&amp;M’s pre-approved '
          + esc(c.funder) + ' budget. '
        : '') + '<b>Capital expenditure is not covered under warranty.</b></div>'
      + picker + '</div>';
  }

  /** The short form for a list card: "PPA · SUB-148", or a warning when there is no contract. */
  function chipHtml(res, esc) {
    const c = res.contract;
    if (c) return '<span class="om-con-chip">' + esc(c.funder || '?') + ' · ' + esc(c.number) + '</span>';
    if (res.how === 'choose' || res.how === 'stale' || res.how === 'none') {
      return '<span class="om-con-chip warn">⚠ contract</span>';
    }
    return '';
  }

  // ── Equipment and serial numbers, recorded against the contract ────────────────────────
  //
  // Raymond, 28 Oct 2026: the user must be able to enter the serial numbers of any equipment --
  // inverters, batteries, PV panels, dongles. Kept in Site Equipment with the Contract Number, so
  // every ticket and job card under one contract shares one list (job cards are rarely linked to
  // a site: 0 of 48 live ones were). Warranty Expiry is filled in from the 1st invoice date by
  // type: Solax equipment 10 years (inverters, batteries; the Solax dongle and monitoring kit are
  // counted as Solax equipment), PV modules 25, and everything else is material at 1 year.
  const TYPE_YEARS = Object.freeze({ Inverter: 10, Battery: 10, Dongle: 10, Monitoring: 10, 'PV Module': 25 });
  const equipYears = (type) => TYPE_YEARS[type] || 1;
  const equipExpiry = (type, firstInvoice) => addYears(firstInvoice, equipYears(type));

  /**
   * The list and, for someone who may add, the form.
   * @param {object} o { rows, esc, today, canAdd, types, act, number, readFail }
   *   rows: Site Equipment records' fields (by name) already narrowed to this contract.
   */
  function equipHtml(o) {
    const esc = o.esc;
    const now = String(o.today || new Date().toISOString()).slice(0, 10);
    const rows = Array.isArray(o.rows) ? o.rows : [];
    let body;
    if (o.readFail) body = '<div class="om-con-msg">The equipment list could not be read.</div>';
    else if (!rows.length) body = '<div class="om-con-msg">No equipment recorded under ' + esc(o.number) + ' yet.</div>';
    else {
      body = '<table class="om-eq-tbl"><tr><th>Type</th><th>Make / model</th><th>Serial number</th><th>Qty</th><th>Warranty</th></tr>'
        + rows.map((f) => {
          const exp = String(f['Warranty Expiry'] || '').slice(0, 10);
          const w = exp ? (now < exp ? '<span class="in">✓ until ' + esc(exp) + '</span>' : '<span class="out">✕ ended ' + esc(exp) + '</span>') : '—';
          return '<tr><td>' + esc(f['Equipment Type'] || '') + '</td><td>' + esc([f.Manufacturer, f.Model].filter(Boolean).join(' ')) + '</td>'
            + '<td class="om-eq-sn">' + esc(f['Serial Number'] || '—') + '</td><td>' + esc(f.Quantity == null ? '' : f.Quantity) + '</td><td>' + w + '</td></tr>';
        }).join('') + '</table>';
    }
    const form = o.canAdd && !o.readFail
      ? '<div class="om-eq-add">'
        + '<select id="om-eq-type" aria-label="Equipment type">' + (o.types || []).map((t) => '<option>' + esc(t) + '</option>').join('') + '</select>'
        + '<input id="om-eq-make" placeholder="Make (e.g. Solax)" aria-label="Make">'
        + '<input id="om-eq-model" placeholder="Model" aria-label="Model">'
        + '<input id="om-eq-serial" placeholder="Serial number *" aria-label="Serial number">'
        + '<input id="om-eq-qty" type="number" min="1" value="1" aria-label="Quantity">'
        + '<button class="btn sm" data-act="' + esc(o.act) + '" data-a1="' + esc(o.number) + '">+ Add item</button>'
        + '</div><div class="om-hint">Warranty expiry is set from the 1st invoice date: inverters, batteries and dongles 10 years, PV panels 25, everything else 1 year.</div>'
      : '';
    return '<div class="om-eq"><div class="om-eq-head">Equipment and serial numbers · ' + esc(o.number)
      + (rows.length ? ' (' + rows.length + ')' : '') + '</div>' + body + form + '</div>';
  }

  const api = { WARRANTY, addYears, warranty, resolve, panelHtml, chipHtml, TYPE_YEARS, equipYears, equipExpiry, equipHtml };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TX.contract = api;
})(typeof window !== 'undefined' ? window : this);
