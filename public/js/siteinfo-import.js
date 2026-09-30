// TAGEX — Site Information CSV import.
//
// Sites already exist in spreadsheets. Retyping forty of them into the New Site form is how
// people give up on a system, so this reads a CSV, maps its columns onto the Site Information
// fields, shows exactly what it would create, and only then writes.
//
// THREE THINGS IT REFUSES TO DO
//
//   1. Import a column that looks like FICA or financial data. Those columns are dropped from
//      the mapping entirely and named on screen — the module's whole purpose is that such data
//      never lands in it, and a free-text field is the obvious way to smuggle it in.
//   2. Send a row Airtable will reject. `typecast` is off, so an unknown select option fails by
//      name. Rows are validated against the module's own option lists first and reported as
//      INVALID rather than fired off to fail one at a time.
//   3. Create a duplicate silently. Rows matching an existing site on client+site, job card or
//      SUB/SOL are marked DUPLICATE and skipped unless explicitly included.
//
// The parser is a real one — quoted fields, embedded commas, doubled quotes and newlines inside
// values. A split(',') importer looks fine until the first address with a comma in it.

(function () {
  'use strict';

  const $ = TX.$;
  const esc = TX.esc;

  let ROWS = [];        // parsed data rows, as arrays
  let HEADERS = [];
  let MAP = {};         // header index -> field name ('' = ignore)
  let BLOCKED = [];     // header indexes refused outright
  let BASE = 'OM';

  // Same vocabulary the upload classifier uses. A column called "Bank Account" has no business
  // in this module whatever a person maps it to.
  const SENSITIVE_HEADER = /(fica|kyc|\bid[\s_-]?(no|number|doc)|identity|passport|licence|license|bank|account[\s_-]?(no|number)|branch[\s_-]?code|iban|swift|invoice|proforma|quote|quotation|payment|\bpop\b|credit|salary|payslip|price|pricing|amount|cost|\brand\b|\bzar\b|vat|financial|statement)/i;

  /**
   * A real CSV parser: handles quoted fields, embedded commas and newlines, and "" escapes.
   * @returns {string[][]} rows of cells, including the header row
   */
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    const s = String(text).replace(/^﻿/, '');   // strip a BOM: Excel writes one

    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') { cell += '"'; i += 1; } else inQuotes = false;
        } else cell += c;
        continue;
      }
      if (c === '"') { inQuotes = true; continue; }
      if (c === ',') { row.push(cell); cell = ''; continue; }
      if (c === '\r') continue;
      if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
      cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
  }

  /** Best guess at which field a column heading means. Never guesses a sensitive column. */
  function autoMap(headers) {
    const F = TX.siteinfo.schema.fields;
    const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
    const targets = Object.values(F);
    const map = {};
    const blocked = [];

    headers.forEach((h, i) => {
      if (SENSITIVE_HEADER.test(h)) { blocked.push(i); map[i] = ''; return; }
      const n = norm(h);
      // exact, then a contains match, so "Site Name" and "site_name" both land
      const hit = targets.find((t) => norm(t) === n)
        || targets.find((t) => norm(t).includes(n) && n.length > 3)
        || targets.find((t) => n.includes(norm(t)) && norm(t).length > 3);
      map[i] = hit || '';
    });
    return { map, blocked };
  }

  /**
   * What this row would become, and whether it can be written.
   * @param {string[]} cells
   * @param {object} [mapping] column index -> field name; defaults to the live mapping.
   *   NOTE: never pass this function bare to Array.map — map would supply the row index as
   *   the mapping, and every row after the first would map nothing at all.
   *   Passed
   *   explicitly by the tests, which have no UI to build one from.
   */
  function assess(cells, mapping) {
    const F = TX.siteinfo.schema.fields;
    const S = TX.siteinfo.schema;
    const fields = {};
    const problems = [];

    Object.entries(mapping || MAP).forEach(([idx, field]) => {
      if (!field) return;
      const raw = String(cells[idx] == null ? '' : cells[idx]).trim();
      if (!raw) return;

      if (S.selects[field]) {
        // Case-insensitive on the way in, exact on the way out: Airtable's options are
        // case-sensitive on write and will refuse a near miss.
        const match = S.selects[field].find((o) => o.toLowerCase() === raw.toLowerCase());
        if (!match) {
          problems.push(field + ': "' + raw + '" is not one of ' + S.selects[field].join(' / '));
          return;
        }
        fields[field] = match;
        return;
      }
      if (S.numbers.includes(field)) {
        const n = Number(String(raw).replace(/[^\d.\-]/g, ''));
        if (!Number.isFinite(n)) { problems.push(field + ': "' + raw + '" is not a number'); return; }
        fields[field] = n;
        return;
      }
      if (S.dates.includes(field)) {
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) { problems.push(field + ': "' + raw + '" is not a date'); return; }
        fields[field] = d.toISOString().slice(0, 10);
        return;
      }
      fields[field] = raw;
    });

    if (!fields[F.name]) problems.push('No site name');

    const dupes = fields[F.name]
      ? TX.siteinfo.duplicatesOf(fields[F.name], fields[F.clientName] || '',
        fields[F.jcNumber] || '', fields[F.subSol] || '')
      : [];

    let status = 'NEW';
    if (problems.length) status = 'INVALID';
    else if (dupes.length) status = 'DUPLICATE';

    return { fields, problems, dupes, status };
  }

  // ── UI ───────────────────────────────────────────────────────────────────

  function open() {
    const wrap = document.createElement('div');
    wrap.className = 'si-modal';
    wrap.id = 'siImportModal';
    wrap.innerHTML = '<div class="si-modal-card si-import">'
      + '<div class="si-modal-head"><h2>Import sites from a CSV</h2>'
      + '<button class="si-x" data-act="siImpClose" aria-label="Close">×</button></div>'
      + '<div class="si-modal-body">'
      + '<div class="si-warn">Operational and technical site information only. Columns that look '
      + 'like FICA, identity, banking or financial data are refused and cannot be mapped.</div>'
      + '<div class="si-form">'
      + '<div class="si-f"><label for="impBase">Import into</label>'
      + '<select id="impBase"><option value="OM">O&amp;M</option><option value="CI">C&amp;I</option></select></div>'
      + '<div class="si-f si-wide"><label for="impFile">CSV file</label>'
      + '<input id="impFile" type="file" accept=".csv,text/csv"></div>'
      + '</div>'
      + '<div id="impBody"></div>'
      + '</div>'
      + '<div class="si-modal-foot">'
      + '<button class="si-btn" data-act="siImpClose">Cancel</button>'
      + '<button class="si-btn primary" data-act="siImpRun" disabled>Import</button>'
      + '</div></div>';
    ($('#modSiteInfo') || document.body).appendChild(wrap);

    $('#impFile').addEventListener('change', (e) => {
      const f = (e.target.files || [])[0];
      if (f) readFile(f);
    });
    $('#impBase').addEventListener('change', (e) => { BASE = e.target.value; renderPreview(); });
  }

  function close() {
    const m = $('#siImportModal');
    if (m) m.remove();
    ROWS = []; HEADERS = []; MAP = {}; BLOCKED = [];
  }

  function readFile(file) {
    const fr = new FileReader();
    fr.onload = () => {
      const rows = parseCsv(String(fr.result));
      if (rows.length < 2) {
        $('#impBody').innerHTML = '<div class="si-msg err">That file has no data rows.</div>';
        return;
      }
      HEADERS = rows[0].map((h) => String(h).trim());
      ROWS = rows.slice(1);
      const a = autoMap(HEADERS);
      MAP = a.map;
      BLOCKED = a.blocked;
      renderPreview();
    };
    fr.onerror = () => {
      $('#impBody').innerHTML = '<div class="si-msg err">That file could not be read.</div>';
    };
    fr.readAsText(file);
  }

  function renderPreview() {
    const F = TX.siteinfo.schema.fields;
    const targets = Object.values(F).filter((t) => t !== F.history);
    const assessed = ROWS.map((cells) => assess(cells));
    const counts = assessed.reduce((a, r) => {
      a[r.status] = (a[r.status] || 0) + 1;
      return a;
    }, {});

    const mapping = '<div class="si-maprows">' + HEADERS.map((h, i) => {
      if (BLOCKED.includes(i)) {
        return '<div class="si-maprow blocked"><span>' + esc(h) + '</span>'
          + '<em>refused — looks like FICA or financial data</em></div>';
      }
      return '<div class="si-maprow"><span>' + esc(h) + '</span>'
        + '<select data-map="' + i + '">'
        + '<option value="">— ignore —</option>'
        + targets.map((t) => '<option value="' + esc(t) + '"'
          + (MAP[i] === t ? ' selected' : '') + '>' + esc(t) + '</option>').join('')
        + '</select></div>';
    }).join('') + '</div>';

    const preview = assessed.slice(0, 12).map((r, i) => (
      '<tr class="si-imp-' + r.status.toLowerCase() + '">'
      + '<td>' + (i + 1) + '</td>'
      + '<td>' + esc(r.fields[F.name] || '—') + '</td>'
      + '<td>' + esc(r.fields[F.clientName] || '—') + '</td>'
      + '<td><span class="si-verdict ' + (r.status === 'NEW' ? 'allowed'
        : (r.status === 'INVALID' ? 'blocked' : 'review')) + '">' + r.status + '</span></td>'
      + '<td>' + esc(r.problems.length ? r.problems.join('; ')
        : (r.dupes.length ? 'Matches ' + r.dupes[0].fields[F.name] : '')) + '</td>'
      + '</tr>'
    )).join('');

    $('#impBody').innerHTML = mapping
      + '<div class="si-impcount">' + ROWS.length + ' row(s): '
      + (counts.NEW || 0) + ' new, ' + (counts.DUPLICATE || 0) + ' duplicate, '
      + (counts.INVALID || 0) + ' invalid'
      + (BLOCKED.length ? ' · ' + BLOCKED.length + ' column(s) refused' : '') + '</div>'
      + (counts.DUPLICATE
        ? '<label class="si-confirm"><input type="checkbox" id="impDupes"> '
          + 'Import the ' + counts.DUPLICATE + ' duplicate row(s) anyway</label>' : '')
      + '<div class="si-tablewrap"><table class="si-table"><thead><tr>'
      + '<th>#</th><th>Site</th><th>Client</th><th>Status</th><th>Note</th>'
      + '</tr></thead><tbody>' + preview + '</tbody></table></div>'
      + (ROWS.length > 12 ? '<p class="si-note">Showing the first 12 of ' + ROWS.length
        + '. Every row is checked, not just these.</p>' : '');

    $('#impBody').querySelectorAll('[data-map]').forEach((s2) => {
      s2.addEventListener('change', (e) => {
        MAP[e.target.dataset.map] = e.target.value;
        renderPreview();
      });
    });

    const run = document.querySelector('[data-act="siImpRun"]');
    if (run) {
      const importable = (counts.NEW || 0) + (counts.DUPLICATE || 0);
      run.disabled = !importable;
      run.textContent = importable ? 'Import ' + (counts.NEW || 0) + ' site(s)' : 'Nothing to import';
    }
  }

  async function run() {
    const F = TX.siteinfo.schema.fields;
    const includeDupes = !!($('#impDupes') || {}).checked;
    const assessed = ROWS.map((cells) => assess(cells))
      .filter((r) => r.status === 'NEW' || (r.status === 'DUPLICATE' && includeDupes));

    const btn = document.querySelector('[data-act="siImpRun"]');
    btn.disabled = true;

    const existing = TX.siteinfo.sites().length;
    let ok = 0;
    const failed = [];

    for (let i = 0; i < assessed.length; i += 1) {
      const r = assessed[i];
      btn.textContent = 'Importing ' + (i + 1) + ' of ' + assessed.length + '…';
      const now = new Date().toISOString();
      const fields = Object.assign({}, r.fields, {
        [F.id]: 'SITE-' + String(existing + ok + 1).padStart(4, '0'),
        [F.sourceBase]: BASE === 'OM' ? 'O&M' : 'C&I',
        [F.createdBy]: TX.userEmail(),
        [F.createdAt]: now,
        [F.history]: now.slice(0, 16).replace('T', ' ') + ' · ' + (TX.userEmail() || 'unknown')
          + ' · Imported from CSV',
      });
      try {
        await TX.create(BASE, 'site_information', fields);
        ok += 1;
      } catch (e) {
        failed.push((r.fields[F.name] || 'row ' + (i + 1)) + ': ' + TX.errorText(e));
      }
    }

    $('#impBody').innerHTML = '<div class="si-msg ' + (failed.length ? 'warn' : 'ok') + '">'
      + ok + ' site(s) imported into ' + (BASE === 'OM' ? 'O&M' : 'C&I') + '.'
      + (failed.length ? '<br>' + failed.length + ' failed:<br>'
        + failed.map((f) => esc(f)).join('<br>') : '')
      + '</div>';
    btn.textContent = 'Done';
    await TX.siteinfo.reload();
  }

  TX.siteimport = { open, close, run, parseCsv, autoMap, assess };
})();
