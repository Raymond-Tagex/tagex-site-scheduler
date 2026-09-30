// TAGEX — Site Information.
//
// The persistent profile of a site and its system. A job card is one event; this is what stays
// true between them. Before this module a site existed only as free text on Clients and as a
// lookup on Job Cards, so nothing held the panels, inverters, batteries, monitoring platform or
// equipment serials — every job card asked for them again.
//
// NO FINANCIAL OR FICA DATA. The table carries no such fields, the upload path refuses documents
// that look like they contain them, and the refusal is enforced on the SERVER. The reference
// jobcard template lists "Invoice / Proforma" under documents on file; its absence here is the
// point of the module, not an omission.
//
// EVERY PERMISSION DECISION HERE IS COSMETIC. /api/at re-checks the role on each request, so a
// role without site_information is refused whatever this file renders.

(function () {
  'use strict';

  const $ = TX.$;
  const esc = TX.esc;

  // ── state ────────────────────────────────────────────────────────────────
  let SITES = [];
  let CURRENT = null;          // { rec, base, equipment, documents }
  let TAB = 'overview';
  let JOBCARDS = [];           // cached, for linking

  const F = {
    name: 'Site Name', id: 'Site ID', clientName: 'Client Name', client: 'Client',
    jobCards: 'Job Cards', jcNumber: 'Job Card Number', subSol: 'SUB / SOL Number',
    category: 'Installation Category', siteType: 'Site Type', sourceBase: 'Source Base',
    responsible: 'Responsible Person', pm: 'Project Manager', om: 'Operations Manager',
    lead: 'Team Leader',
    issued: 'Date Issued', start: 'Start Date', end: 'End Date',
    installed: 'Installation Date', omStart: 'O&M Start Date', contractStart: 'Contract Start Date',
    address: 'Property Address', postal: 'Postal Address', contact: 'Site Contact',
    cell: 'Cell Number', altNo: 'Alternative Number', email: 'Email Address',
    contractType: 'Contract Type', signed: 'Contract Signed Date', term: 'Contract Term',
    buyout: 'Buyout / Transfer Information',
    panelMake: 'Panel Manufacturer', panelModel: 'Panel Model', panelQty: 'Panel Quantity',
    panelKw: 'Total Panel Capacity (kWp)',
    invMake: 'Inverter Manufacturer', invModel: 'Inverter Model', invQty: 'Inverter Quantity',
    invKw: 'Total Inverter Capacity (kW)',
    battMake: 'Battery Manufacturer', battModel: 'Battery Model', battQty: 'Battery Quantity',
    battKw: 'Total Battery Capacity (kWh)',
    monSystem: 'Monitoring System', monPlatform: 'Monitoring Platform', monRef: 'Monitoring Reference',
    omAgreement: 'O&M Agreement', omContact: 'O&M Contact', status: 'Current System Status',
    lastService: 'Last Service Date', nextService: 'Next Service Date',
    docs: 'Documents',
    reqs: 'Operational Requirements', techNotes: 'Technical Notes', omNotes: 'O&M Notes',
    siteNotes: 'Site Notes',
    createdBy: 'Created By (App)', createdAt: 'Created Date',
    modifiedBy: 'Modified By (App)', modifiedAt: 'Modified Date', history: 'History',
  };

  const EF = {
    id: 'Equipment ID', site: 'Site Information', siteName: 'Site Name',
    type: 'Equipment Type', make: 'Manufacturer', model: 'Model', serial: 'Serial Number',
    qty: 'Quantity', installed: 'Installation Date', warranty: 'Warranty Expiry',
    status: 'Status', notes: 'Notes', createdBy: 'Created By (App)', createdAt: 'Created Date',
  };

  const DOC_KEYS = ['Installation Documents', 'Electrical CoC', 'System Handover',
    'Warranty Documents', 'Site Photos', 'Previous Service Reports', 'SLD',
    'Electrical Drawings', 'Datasheets', 'Commissioning Documents'];
  const DOC_STATUS = ['', 'Complete', 'Missing', 'Pending', 'Not Applicable'];
  const SYSTEM_STATUS = ['', 'Operational', 'Operational - Monitoring Issue',
    'Partially Operational', 'Offline', 'Under Maintenance', 'Awaiting Parts',
    'Awaiting Client', 'Awaiting Insurance', 'Decommissioned', 'Unknown'];
  const CATEGORIES = ['', 'Project - PPA', 'Project - Direct Purchase', 'Residential - SUBS',
    'Residential - Direct Purchase', 'Commercial', 'Other'];
  const SITE_TYPES = ['', 'Residential', 'Commercial', 'Industrial', 'Agricultural', 'Other'];
  const CONTRACT_TYPES = ['', 'PPA', 'SUB', 'Direct Purchase', 'Rental', 'Other'];
  const EQUIP_TYPES = ['PV Module', 'Inverter', 'Battery', 'Monitoring', 'DB', 'Meter',
    'Mounting', 'Cabling', 'Other'];
  const EQUIP_STATUS = ['Active', 'Faulty', 'Removed', 'Replaced', 'RMA',
    'Under Warranty Claim', 'Unknown'];
  const PHOTO_CATEGORIES = ['Site', 'Roof', 'PV Panels', 'Inverter', 'Battery', 'DB',
    'Electrical', 'Meter', 'Equipment', 'Defect', 'Before', 'After', 'Other'];

  // ── re-filing photos after the fact ──────────────────────────────────────
  //
  // Picking one category before a folder upload assumes you know what is in the folder. Nobody
  // does: a site visit produces roof shots, DB shots, a meter reading and three defects in one
  // camera roll, and they all arrive under whatever was in the dropdown.
  //
  // So the category is set again here, on what you can see. Held in module scope rather than in
  // the markup because renderDetail() rebuilds the tab on every change, and a selection that
  // does not survive its own re-render is no use across 224 files.
  const PHOTO_CAT_FIELD = 'Photo Category';
  const UNCATEGORISED = '__none__';
  let PHOTO_SEL = new Set();
  let PHOTO_FILTER = 'all';

  const photoCat = (d) => sel(d.fields[PHOTO_CAT_FIELD]);

  /** The documents the gallery is currently showing, after the filter. */
  function visibleDocs() {
    const docs = CURRENT.documents || [];
    if (PHOTO_FILTER === 'all') return docs;
    if (PHOTO_FILTER === UNCATEGORISED) return docs.filter((d) => !photoCat(d));
    return docs.filter((d) => photoCat(d) === PHOTO_FILTER);
  }

  const sel = (v) => (v && typeof v === 'object' ? (v.name || '') : (v == null ? '' : String(v)));
  const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
  const fmtKw = (v) => (num(v) ? num(v).toFixed(2).replace(/\.00$/, '') : '—');

  function msg(kind, text) {
    const out = $('#siMsg');
    if (out) out.innerHTML = '<div class="si-msg ' + kind + '">' + esc(text) + '</div>';
  }
  function view(name) {
    ['siListView', 'siDetail', 'siNew'].forEach((v) => {
      const el = $('#' + v);
      if (el) el.hidden = v !== name;
    });
  }

  // ── loading ──────────────────────────────────────────────────────────────

  async function loadSites() {
    const host = $('#siList');
    if (host) host.innerHTML = '<div class="si-empty">Loading sites…</div>';

    const params = { pageSize: 100, sort: [{ field: F.name, direction: 'asc' }] };
    try {
      const [ci, om] = await Promise.all([
        TX.list('CI', 'site_information', params).catch(() => ({ records: [] })),
        TX.list('OM', 'site_information', params).catch(() => ({ records: [] })),
      ]);
      SITES = [
        ...(ci.records || []).map((r) => Object.assign({}, r, { _base: 'CI' })),
        ...(om.records || []).map((r) => Object.assign({}, r, { _base: 'OM' })),
      ].filter((r) => r.fields[F.name]);
      renderList();
    } catch (e) {
      if (host) host.innerHTML = '<div class="si-empty err">⚠ ' + esc(TX.errorText(e)) + '</div>';
    }
  }

  /** Job cards, for linking a site to the work raised against it. Cached: both bases, once. */
  async function loadJobCards() {
    if (JOBCARDS.length) return JOBCARDS;
    const params = {
      fields: ['JC Reference', 'Title', 'Client Name', 'Status'],
      filterByFormula: 'NOT({Status} = "Completed")',
      pageSize: 100,
      sort: [{ field: 'JC Reference', direction: 'desc' }],
    };
    const [ci, om] = await Promise.all([
      TX.list('CI', 'job_cards', params).catch(() => ({ records: [] })),
      TX.list('OM', 'job_cards', params).catch(() => ({ records: [] })),
    ]);
    JOBCARDS = [
      ...(ci.records || []).map((r) => ({ id: r.id, base: 'CI', ref: String(r.fields['JC Reference'] || ''), title: String(r.fields.Title || ''), client: String(r.fields['Client Name'] || '') })),
      ...(om.records || []).map((r) => ({ id: r.id, base: 'OM', ref: String(r.fields['JC Reference'] || ''), title: String(r.fields.Title || ''), client: String(r.fields['Client Name'] || '') })),
    ].filter((j) => j.ref);
    return JOBCARDS;
  }

  // ── list ─────────────────────────────────────────────────────────────────

  function renderList() {
    const host = $('#siList');
    if (!host) return;
    const q = String(($('#siSearch') || {}).value || '').trim().toLowerCase();
    const cat = String(($('#siFilterCat') || {}).value || '');
    const st = String(($('#siFilterStatus') || {}).value || '');

    let rows = SITES;
    if (q) {
      rows = rows.filter((r) => {
        const f = r.fields;
        return [F.name, F.clientName, F.jcNumber, F.subSol, F.monRef, F.address]
          .some((k) => String(f[k] || '').toLowerCase().includes(q));
      });
    }
    if (cat) rows = rows.filter((r) => sel(r.fields[F.category]) === cat);
    if (st) rows = rows.filter((r) => sel(r.fields[F.status]) === st);

    $('#siCount').textContent = rows.length + ' of ' + SITES.length;

    if (!rows.length) {
      host.innerHTML = '<div class="si-empty">'
        + (SITES.length ? 'No site matches.' : 'No sites yet. Use “+ New Site” to add the first.')
        + '</div>';
      return;
    }

    host.innerHTML = rows.map((r) => {
      const f = r.fields;
      const status = sel(f[F.status]) || 'Unknown';
      const pv = num(f[F.panelKw]);
      const inv = num(f[F.invKw]);
      const batt = num(f[F.battKw]);
      return '<button type="button" class="si-row" data-act="siOpen" data-a1="' + r.id
        + '" data-a2="' + r._base + '">'
        + '<div class="si-row-main">'
        + '<div class="si-row-top"><span class="si-name">' + esc(f[F.name]) + '</span>'
        + '<span class="si-badge ' + statusClass(status) + '">' + esc(status) + '</span>'
        + '<span class="si-chip">' + esc(r._base === 'OM' ? 'O&M' : 'C&I') + '</span></div>'
        + '<div class="si-row-meta">' + esc(f[F.clientName] || 'No client')
        + (f[F.jcNumber] ? ' · ' + esc(f[F.jcNumber]) : '')
        + (f[F.subSol] ? ' · SUB/SOL ' + esc(f[F.subSol]) : '')
        + (sel(f[F.category]) ? ' · ' + esc(sel(f[F.category])) : '') + '</div>'
        + '</div>'
        + '<div class="si-row-sys">'
        + '<span>PV ' + (pv ? fmtKw(pv) + ' kWp' : '—') + '</span>'
        + '<span>INV ' + (inv ? fmtKw(inv) + ' kW' : '—') + '</span>'
        + '<span>BATT ' + (batt ? fmtKw(batt) + ' kWh' : '—') + '</span>'
        + '</div></button>';
    }).join('');
  }

  function statusClass(s) {
    if (/^Operational$/.test(s)) return 'ok';
    if (/Offline|Decommissioned/.test(s)) return 'bad';
    if (/Awaiting|Maintenance|Partially|Monitoring Issue/.test(s)) return 'warn';
    return '';
  }

  // ── detail ───────────────────────────────────────────────────────────────

  // A record-id filter costs about 32 characters each, and the proxy refuses any client filter
  // over 4000 — so one OR() over every document silently failed at around 125 documents. A real
  // site with 224 of them produced a 7171-character formula, a refusal, and a gallery that said
  // "No photos or documents yet". Sixty at a time keeps every request well inside the limit.
  const DOC_CHUNK = 60;

  /**
   * The document records for a site, fetched in batches.
   *
   * Errors are RETURNED, not swallowed. The previous version ended in `.catch(() => [])`, so a
   * refused request and a site with no documents rendered identically — which is precisely how
   * 224 uploaded files came to look like none at all.
   *
   * @returns {Promise<{records: Array, error: string}>}
   */
  async function loadDocuments(base, docIds) {
    if (!docIds.length) return { records: [], error: '' };

    const records = [];
    let error = '';
    for (let i = 0; i < docIds.length; i += DOC_CHUNK) {
      const chunk = docIds.slice(i, i + DOC_CHUNK);
      try {
        const page = await TX.list(base, 'documents', {
          filterByFormula: 'OR(' + chunk.map((x) => 'RECORD_ID()="' + x + '"').join(',') + ')',
          pageSize: 100,
        });
        records.push(...(page.records || []));
      } catch (e) {
        error = TX.errorText(e);
        break;
      }
    }
    return { records, error };
  }

  async function openSite(id, base) {
    // Selection belongs to the site being looked at. Carrying it across would offer to re-file
    // one site's photos while another site's records were ticked.
    PHOTO_SEL = new Set();
    PHOTO_FILTER = 'all';
    view('siDetail');
    $('#siDetailBody').innerHTML = '<div class="si-empty">Loading…</div>';
    try {
      const r = await TX.get(base, 'site_information', id);
      const rec = (r.records || [])[0] || r;
      if (!rec || !rec.fields) throw new Error('That site could not be read.');

      // Equipment is matched on the denormalised Site Name: Airtable cannot match a link field
      // from the child side in a formula, which is why that field exists.
      const siteName = String(rec.fields[F.name] || '').replace(/"/g, '');
      const eq = await TX.list(base, 'site_equipment', {
        filterByFormula: '{' + EF.siteName + '} = "' + siteName + '"',
        pageSize: 100,
      }).catch(() => ({ records: [] }));

      // Documents are reached through the site's own link array, by record id.
      const docIds = (rec.fields[F.docs] || []).map((x) => (typeof x === 'string' ? x : x.id));
      const loaded = await loadDocuments(base, docIds);

      CURRENT = {
        rec,
        base,
        equipment: eq.records || [],
        documents: loaded.records,
        docError: loaded.error,
      };
      TAB = 'overview';
      renderDetail();
    } catch (e) {
      $('#siDetailBody').innerHTML = '<div class="si-empty err">⚠ ' + esc(TX.errorText(e)) + '</div>';
    }
  }

  const TABS = [
    ['overview', 'Overview'], ['client', 'Client & Site'], ['system', 'System'],
    ['equipment', 'Equipment'], ['om', 'O&M'], ['docs', 'Documents'],
    ['photos', 'Photos'], ['history', 'History'],
  ];

  function renderDetail() {
    const { rec, base } = CURRENT;
    const f = rec.fields;
    const mayEdit = TX.can('site_information', 'edit');

    $('#siDetailName').textContent = f[F.name] || '';
    $('#siDetailSub').textContent = [f[F.clientName], sel(f[F.category]),
      base === 'OM' ? 'O&M' : 'C&I'].filter(Boolean).join(' · ');

    const tabs = '<nav class="si-tabs" role="tablist">' + TABS.map(([k, label]) => (
      '<button type="button" role="tab" class="' + (k === TAB ? 'active' : '')
      + '" data-act="siTab" data-a1="' + k + '">' + esc(label) + '</button>'
    )).join('') + '</nav>';

    const body = {
      overview: tabOverview, client: tabClient, system: tabSystem,
      equipment: tabEquipment, om: tabOm, docs: tabDocs,
      photos: tabPhotos, history: tabHistory,
    }[TAB](f, mayEdit);

    $('#siDetailBody').innerHTML = tabs + '<div class="si-tabbody">' + body + '</div>'
      + '<div id="siMsg"></div>';
  }

  const fact = (k, v) => '<div class="si-fact"><dt>' + esc(k) + '</dt><dd>'
    + esc(v || '—') + '</dd></div>';

  function tabOverview(f) {
    const jc = (f[F.jobCards] || []).length;
    const docCards = DOC_KEYS.map((k) => {
      const v = sel(f[k]);
      const cls = v === 'Complete' ? 'ok' : (v === 'Missing' ? 'bad'
        : (v === 'Pending' ? 'warn' : ''));
      const mark = v === 'Complete' ? '✓' : (v === 'Missing' ? '✕'
        : (v === 'Pending' ? '⚠' : '–'));
      return '<div class="si-doc ' + cls + '"><span>' + esc(k) + '</span><b>' + mark + '</b></div>';
    }).join('');

    return '<div class="si-grid3">'
      + '<section class="si-card"><h3>Job card</h3><dl class="si-facts">'
      + fact('Job card', f[F.jcNumber]) + fact('SUB / SOL', f[F.subSol])
      + fact('Category', sel(f[F.category])) + fact('Responsible', f[F.responsible])
      + fact('Issued', f[F.issued]) + fact('Start', f[F.start]) + fact('End', f[F.end])
      + fact('Linked job cards', jc ? String(jc) : '—')
      + '</dl></section>'

      + '<section class="si-card"><h3>Site</h3><dl class="si-facts">'
      + fact('Client', f[F.clientName]) + fact('Site', f[F.name])
      + fact('Address', f[F.address]) + fact('Site type', sel(f[F.siteType]))
      + fact('Contact', f[F.contact]) + fact('Cell', f[F.cell])
      + '</dl></section>'

      + '<section class="si-card"><h3>System</h3><dl class="si-facts">'
      + fact('PV', num(f[F.panelKw]) ? fmtKw(f[F.panelKw]) + ' kWp' : '—')
      + fact('Inverter', num(f[F.invKw]) ? fmtKw(f[F.invKw]) + ' kW' : '—')
      + fact('Battery', num(f[F.battKw]) ? fmtKw(f[F.battKw]) + ' kWh' : '—')
      + fact('Panels', num(f[F.panelQty]) || '—')
      + fact('Inverters', num(f[F.invQty]) || '—')
      + fact('Batteries', num(f[F.battQty]) || '—')
      + fact('Monitoring', f[F.monPlatform])
      + '</dl></section>'

      + '<section class="si-card"><h3>O&amp;M</h3><dl class="si-facts">'
      + fact('Agreement', sel(f[F.omAgreement])) + fact('O&M start', f[F.omStart])
      + fact('O&M contact', f[F.omContact]) + fact('Status', sel(f[F.status]))
      + fact('Last service', f[F.lastService]) + fact('Next service', f[F.nextService])
      + '</dl></section>'

      + '<section class="si-card si-span2"><h3>Documents on file</h3>'
      + '<div class="si-docs">' + docCards + '</div></section>'
      + '</div>'

      + '<div class="si-actions">'
      + '<button class="si-btn" data-act="siTab" data-a1="photos">Photos</button>'
      + '<button class="si-btn" data-act="siTab" data-a1="equipment">Equipment</button>'
      + (TX.can('job_cards', 'view')
        ? '<button class="si-btn" data-act="siJobCards">Linked job cards</button>' : '')
      + '<button class="si-btn" data-act="siBack">Back to list</button>'
      + '</div>';
  }

  // a labelled input bound to one field
  function inp(label, key, type, mayEdit, opts) {
    const f = CURRENT.rec.fields;
    const v = f[key];
    const dis = mayEdit && TX.canField('site_information', key, 'write') ? '' : ' disabled';
    if (opts) {
      return '<div class="si-f"><label>' + esc(label) + '</label><select data-act="siField"'
        + ' data-on="change" data-a1="' + esc(key) + '" data-a2="@val"' + dis + '>'
        + opts.map((o) => '<option' + (sel(v) === o ? ' selected' : '') + '>' + esc(o)
          + '</option>').join('') + '</select></div>';
    }
    if (type === 'textarea') {
      return '<div class="si-f si-wide"><label>' + esc(label) + '</label><textarea rows="3"'
        + ' data-act="siField" data-on="change" data-a1="' + esc(key) + '" data-a2="@val"'
        + dis + '>' + esc(v || '') + '</textarea></div>';
    }
    return '<div class="si-f"><label>' + esc(label) + '</label><input type="' + (type || 'text')
      + '" value="' + esc(v == null ? '' : v) + '" data-act="siField" data-on="change"'
      + ' data-a1="' + esc(key) + '" data-a2="@val"' + dis + '></div>';
  }

  function tabClient(f, mayEdit) {
    return '<div class="si-form">'
      + inp('Site name', F.name, 'text', mayEdit)
      + inp('Client name', F.clientName, 'text', mayEdit)
      + inp('Site type', F.siteType, null, mayEdit, SITE_TYPES)
      + inp('Installation category', F.category, null, mayEdit, CATEGORIES)
      + inp('SUB / SOL number', F.subSol, 'text', mayEdit)
      + inp('Job card number', F.jcNumber, 'text', mayEdit)
      + inp('Site contact', F.contact, 'text', mayEdit)
      + inp('Cell number', F.cell, 'tel', mayEdit)
      + inp('Alternative number', F.altNo, 'tel', mayEdit)
      + inp('Email address', F.email, 'email', mayEdit)
      + inp('Property address', F.address, 'textarea', mayEdit)
      + inp('Postal address', F.postal, 'textarea', mayEdit)
      + inp('Contract type', F.contractType, null, mayEdit, CONTRACT_TYPES)
      + inp('Contract signed', F.signed, 'date', mayEdit)
      + inp('Contract start', F.contractStart, 'date', mayEdit)
      + inp('Contract term', F.term, 'text', mayEdit)
      + inp('Installation date', F.installed, 'date', mayEdit)
      + inp('Responsible person', F.responsible, 'text', mayEdit)
      + inp('Project manager', F.pm, 'text', mayEdit)
      + inp('Operations manager', F.om, 'text', mayEdit)
      + inp('Team leader', F.lead, 'text', mayEdit)
      + inp('Buyout / transfer information', F.buyout, 'textarea', mayEdit)
      + '</div>'
      + '<p class="si-note">Operational and site information only. Banking, payment and '
      + 'identity details must not be recorded here.</p>';
  }

  function tabSystem(f, mayEdit) {
    return '<div class="si-form">'
      + '<h3 class="si-sub">Solar panels</h3>'
      + inp('Manufacturer', F.panelMake, 'text', mayEdit)
      + inp('Model', F.panelModel, 'text', mayEdit)
      + inp('Quantity', F.panelQty, 'number', mayEdit)
      + inp('Total capacity (kWp)', F.panelKw, 'number', mayEdit)
      + '<h3 class="si-sub">Inverters</h3>'
      + inp('Manufacturer', F.invMake, 'text', mayEdit)
      + inp('Model', F.invModel, 'text', mayEdit)
      + inp('Quantity', F.invQty, 'number', mayEdit)
      + inp('Total capacity (kW)', F.invKw, 'number', mayEdit)
      + '<h3 class="si-sub">Batteries</h3>'
      + inp('Manufacturer', F.battMake, 'text', mayEdit)
      + inp('Model', F.battModel, 'text', mayEdit)
      + inp('Quantity', F.battQty, 'number', mayEdit)
      + inp('Total capacity (kWh)', F.battKw, 'number', mayEdit)
      + '<h3 class="si-sub">Monitoring</h3>'
      + inp('Monitoring system', F.monSystem, 'text', mayEdit)
      + inp('Monitoring platform', F.monPlatform, 'text', mayEdit)
      + inp('Monitoring reference', F.monRef, 'text', mayEdit)
      + '</div>'
      + '<p class="si-note">Where a site has more than one panel or inverter model, record each '
      + 'one in the Equipment register — these totals are the system summary.</p>';
  }

  function tabOm(f, mayEdit) {
    return '<div class="si-form">'
      + inp('O&M agreement', F.omAgreement, null, mayEdit, ['', 'Yes', 'No', 'Pending', 'Not Applicable'])
      + inp('O&M start date', F.omStart, 'date', mayEdit)
      + inp('O&M contact', F.omContact, 'text', mayEdit)
      + inp('Current system status', F.status, null, mayEdit, SYSTEM_STATUS)
      + inp('Last service date', F.lastService, 'date', mayEdit)
      + inp('Next service date', F.nextService, 'date', mayEdit)
      + inp('Operational requirements', F.reqs, 'textarea', mayEdit)
      + inp('O&M notes', F.omNotes, 'textarea', mayEdit)
      + inp('Technical notes', F.techNotes, 'textarea', mayEdit)
      + inp('Site notes', F.siteNotes, 'textarea', mayEdit)
      + '</div>';
  }

  function tabDocs(f, mayEdit) {
    return '<div class="si-form">'
      + DOC_KEYS.map((k) => inp(k, k, null, mayEdit, DOC_STATUS)).join('')
      + '</div>'
      + '<p class="si-note">This is a checklist of what exists, not the files themselves. '
      + 'Upload the files under Photos, which refuses FICA and financial documents.</p>';
  }

  // ── equipment ────────────────────────────────────────────────────────────

  function tabEquipment() {
    const rows = CURRENT.equipment;
    const mayAdd = TX.can('site_equipment', 'create');
    const mayEdit = TX.can('site_equipment', 'edit');
    const mayDel = TX.can('site_equipment', 'delete');

    const list = rows.length ? rows.map((r) => {
      const e = r.fields;
      return '<tr>'
        + '<td>' + esc(sel(e[EF.type])) + '</td>'
        + '<td>' + esc(e[EF.make] || '—') + '</td>'
        + '<td>' + esc(e[EF.model] || '—') + '</td>'
        + '<td class="si-mono">' + esc(e[EF.serial] || '—') + '</td>'
        + '<td>' + (num(e[EF.qty]) || '—') + '</td>'
        + '<td>' + esc(e[EF.installed] || '—') + '</td>'
        + '<td>' + esc(e[EF.warranty] || '—') + '</td>'
        + '<td><span class="si-badge ' + (sel(e[EF.status]) === 'Active' ? 'ok' : 'warn') + '">'
        + esc(sel(e[EF.status]) || '—') + '</span></td>'
        + '<td>' + (mayDel
          ? '<button class="si-x" data-act="siEqDel" data-a1="' + r.id + '" title="Remove">×</button>'
          : '') + '</td>'
        + '</tr>';
    }).join('') : '<tr><td colspan="9" class="si-empty">No equipment recorded.</td></tr>';

    return (mayAdd ? '<div class="si-actions"><button class="si-btn primary" data-act="siEqNew">'
      + '+ Add equipment</button></div>' : '')
      + '<div class="si-tablewrap"><table class="si-table"><thead><tr>'
      + '<th>Type</th><th>Manufacturer</th><th>Model</th><th>Serial</th><th>Qty</th>'
      + '<th>Installed</th><th>Warranty</th><th>Status</th><th></th>'
      + '</tr></thead><tbody>' + list + '</tbody></table></div>'
      + (mayEdit ? '' : '<p class="si-note">Your role may view equipment but not change it.</p>');
  }

  function openEquipForm() {
    const wrap = document.createElement('div');
    wrap.className = 'si-modal';
    wrap.id = 'siEqModal';
    wrap.innerHTML = '<div class="si-modal-card">'
      + '<div class="si-modal-head"><h2>Add equipment</h2>'
      + '<button class="si-x" data-act="siEqClose" aria-label="Close">×</button></div>'
      + '<div class="si-modal-body"><div class="si-form">'
      + '<div class="si-f"><label>Type *</label><select id="eqType">'
      + EQUIP_TYPES.map((t) => '<option>' + esc(t) + '</option>').join('') + '</select></div>'
      + '<div class="si-f"><label>Manufacturer</label><input id="eqMake" type="text"></div>'
      + '<div class="si-f"><label>Model</label><input id="eqModel" type="text"></div>'
      + '<div class="si-f"><label>Serial number</label><input id="eqSerial" type="text"></div>'
      + '<div class="si-f"><label>Quantity</label><input id="eqQty" type="number" min="0" value="1"></div>'
      + '<div class="si-f"><label>Installation date</label><input id="eqInstalled" type="date"></div>'
      + '<div class="si-f"><label>Warranty expiry</label><input id="eqWarranty" type="date"></div>'
      + '<div class="si-f"><label>Status</label><select id="eqStatus">'
      + EQUIP_STATUS.map((t) => '<option>' + esc(t) + '</option>').join('') + '</select></div>'
      + '<div class="si-f si-wide"><label>Notes</label><textarea id="eqNotes" rows="2"></textarea></div>'
      + '</div><div id="siEqMsg"></div></div>'
      + '<div class="si-modal-foot">'
      + '<button class="si-btn" data-act="siEqClose">Cancel</button>'
      + '<button class="si-btn primary" data-act="siEqSave">Add equipment</button>'
      + '</div></div>';
    ($('#modSiteInfo') || document.body).appendChild(wrap);
  }

  function closeEquipForm() {
    const m = $('#siEqModal');
    if (m) m.remove();
  }

  async function saveEquip() {
    const { rec, base } = CURRENT;
    const type = $('#eqType').value;
    const out = $('#siEqMsg');
    const btn = document.querySelector('[data-act="siEqSave"]');
    btn.disabled = true;
    btn.textContent = 'Adding…';

    const n = CURRENT.equipment.length + 1;
    const fields = {
      [EF.id]: (rec.fields[F.id] || rec.fields[F.name]) + ' / E' + String(n).padStart(2, '0'),
      [EF.siteName]: rec.fields[F.name] || '',
      [EF.site]: [rec.id],
      [EF.type]: type,
      [EF.status]: $('#eqStatus').value,
      [EF.createdBy]: TX.userEmail(),
      [EF.createdAt]: new Date().toISOString(),
    };
    const opt = (id, key, cast) => {
      const v = ($('#' + id).value || '').trim();
      if (v) fields[key] = cast ? cast(v) : v;
    };
    opt('eqMake', EF.make); opt('eqModel', EF.model); opt('eqSerial', EF.serial);
    opt('eqQty', EF.qty, Number); opt('eqInstalled', EF.installed);
    opt('eqWarranty', EF.warranty); opt('eqNotes', EF.notes);

    try {
      const r = await TX.create(base, 'site_equipment', fields);
      const created = (r.records || [])[0];
      if (created) CURRENT.equipment.push(created);
      await note('Equipment added: ' + type + (fields[EF.model] ? ' ' + fields[EF.model] : ''));
      closeEquipForm();
      renderDetail();
    } catch (e) {
      out.innerHTML = '<div class="si-msg err">' + esc(TX.errorText(e)) + '</div>';
      btn.disabled = false;
      btn.textContent = 'Add equipment';
    }
  }

  async function delEquip(id) {
    const row = CURRENT.equipment.find((r) => r.id === id);
    if (!row) return;
    try {
      await TX.remove(CURRENT.base, 'site_equipment', id);
      CURRENT.equipment = CURRENT.equipment.filter((r) => r.id !== id);
      await note('Equipment removed: ' + sel(row.fields[EF.type]));
      renderDetail();
    } catch (e) { msg('err', TX.errorText(e)); }
  }

  // ── photos ───────────────────────────────────────────────────────────────

  function tabPhotos() {
    const docs = CURRENT.documents;
    const mayUpload = TX.can('documents', 'create');
    const partial = CURRENT.docError && docs.length
      ? '<div class="si-msg warn">Showing ' + docs.length + ' document(s); the rest could not '
        + 'be loaded: ' + esc(CURRENT.docError) + '</div>'
      : '';

    const shown = visibleDocs();
    const mayRefile = TX.can('documents', 'edit');

    const gallery = shown.length ? shown.map((d) => {
      const files = d.fields.File || [];
      const first = files[0] || {};
      const thumb = (first.thumbnails && first.thumbnails.large && first.thumbnails.large.url)
        || first.url || '';
      const isImg = /^image\//.test(first.type || '');
      const cat = photoCat(d);
      return '<figure class="si-photo' + (PHOTO_SEL.has(d.id) ? ' is-picked' : '') + '">'
        + (mayRefile
          ? '<label class="si-photo-pick"><input type="checkbox"'
            + (PHOTO_SEL.has(d.id) ? ' checked' : '')
            + ' data-act="siPhotoPick" data-on="change" data-a1="' + d.id + '" data-a2="@checked"'
            + ' aria-label="Select ' + esc(d.fields['Document Name'] || 'this file') + '"></label>'
          : '')
        + (isImg && thumb
          ? '<img src="' + esc(thumb) + '" alt="' + esc(d.fields['Document Name'] || '') + '" loading="lazy">'
          : '<div class="si-photo-file">' + esc((first.type || 'file').split('/').pop().toUpperCase()) + '</div>')
        // The category is what this screen is for, so it leads. The document type stays
        // beside it, quieter -- they are different facts and were being conflated.
        + '<figcaption>' + esc(d.fields['Document Name'] || first.filename || 'Untitled')
        + '<span>' + (cat
          ? '<b class="si-photo-cat">' + esc(cat) + '</b>'
          : '<b class="si-photo-cat is-none">No category</b>')
        + ' · ' + esc(sel(d.fields['Document Type']) || '—') + '</span></figcaption>'
        + (first.url ? '<a class="si-photo-open" href="' + esc(first.url)
          + '" target="_blank" rel="noopener">Open</a>' : '')
        + '</figure>';
    }).join('')
      // "None" and "could not be loaded" must not look the same. They did, and 224 uploaded
      // files read as an empty site.
      : (CURRENT.docError
        ? '<div class="si-msg err">The documents for this site could not be loaded: '
          + esc(CURRENT.docError) + '</div>'
        // Three different nothings, and they must not read the same. The site has none; the
        // filter excluded them all; or the load failed. Only the last is a problem.
        : (docs.length
          ? '<div class="si-empty">None of the ' + docs.length + ' file(s) here match that '
            + 'filter.</div>'
          : '<div class="si-empty">No photos or documents yet.</div>'));

    return partial + (mayUpload ? '<div class="si-upload">'
      + '<div class="si-warn">Do not upload FICA, personal identity documents, banking '
      + 'information or financial documents. Uploads are checked and refused on the server, but '
      + 'that check cannot catch everything — it is not a substitute for judgement.</div>'
      + '<div class="si-f"><label for="siPhotoCat">Category</label>'
      + '<select id="siPhotoCat">' + PHOTO_CATEGORIES.map((c) => '<option>' + esc(c)
        + '</option>').join('') + '</select></div>'
      + '<div class="si-f si-wide"><label for="siPhotoDesc">Description</label>'
      + '<input id="siPhotoDesc" type="text" placeholder="What this shows"></div>'
      + '<label class="si-drop" id="siDrop">'
      + '<input type="file" id="siFiles" multiple accept="image/*,.pdf,.docx,.xlsx,.csv" hidden>'
      + '<span>Drag files <b>or a whole folder</b> here, or tap to choose. Photos can be taken '
      + 'with the camera.</span>'
      + '</label>'
      // A folder needs its own input: `webkitdirectory` cannot be toggled on the file picker,
      // and dropping a folder is handled separately again (see the drop handler).
      + '<div class="si-actions">'
      + '<input type="file" id="siFolder" webkitdirectory directory multiple hidden>'
      + '<button class="si-btn" data-act="siPickFolder" type="button">Choose a folder&hellip;</button>'
      + '<span class="si-note" style="margin:0;align-self:center">Sub-folders are included. '
      + 'Only images, PDF, Word, Excel and CSV are taken; anything else is skipped.</span>'
      + '</div>'
      + '<div id="siQueue"></div>'
      + '</div>' : '')
      + refileBar(docs, shown, mayRefile)
      + '<div class="si-gallery">' + gallery + '</div>';
  }

  /**
   * The bar that re-files photos in bulk.
   *
   * Shown only when there is something to file and the person may edit documents. The counts
   * are spelled out -- "Apply to 12 selected" rather than "Apply" -- because this writes to
   * twelve records at once and the number is the last chance to notice it is wrong.
   */
  function refileBar(docs, shown, mayRefile) {
    if (!mayRefile || !docs.length) return '';

    const counts = { all: docs.length, [UNCATEGORISED]: docs.filter((d) => !photoCat(d)).length };
    for (const c of PHOTO_CATEGORIES) counts[c] = docs.filter((d) => photoCat(d) === c).length;

    const opt = (value, label) => '<option value="' + esc(value) + '"'
      + (PHOTO_FILTER === value ? ' selected' : '') + '>'
      + esc(label) + ' (' + counts[value] + ')</option>';

    // Selection is tracked across filters, so the count can exceed what is on screen. Saying so
    // is better than silently applying to something the person cannot see.
    const picked = PHOTO_SEL.size;
    const offscreen = picked - shown.filter((d) => PHOTO_SEL.has(d.id)).length;

    return '<div class="si-refile">'
      + '<div class="si-refile-row">'
      + '<label for="siPhotoFilter">Show</label>'
      + '<select id="siPhotoFilter" data-act="siPhotoFilter" data-on="change" data-a1="@val">'
      + opt('all', 'Everything')
      + opt(UNCATEGORISED, 'No category yet')
      + PHOTO_CATEGORIES.filter((c) => counts[c]).map((c) => opt(c, c)).join('')
      + '</select>'
      + '<button class="si-btn" type="button" data-act="siPhotoAll">Select all '
      + shown.length + ' shown</button>'
      + (picked ? '<button class="si-btn" type="button" data-act="siPhotoNone">Clear</button>' : '')
      + '</div>'
      + (picked
        ? '<div class="si-refile-row si-refile-apply">'
          + '<label for="siBulkCat">Set category to</label>'
          + '<select id="siBulkCat">'
          + PHOTO_CATEGORIES.map((c) => '<option>' + esc(c) + '</option>').join('')
          + '</select>'
          + '<button class="si-btn primary" type="button" data-act="siPhotoApply">'
          + 'Apply to ' + picked + ' selected</button>'
          + (offscreen > 0
            ? '<span class="si-note">' + offscreen + ' of them are hidden by the filter.</span>'
            : '')
          + '</div>'
        : '<div class="si-note">Tick the photos you want to re-file, then choose a category.</div>')
      + '<div id="siRefileMsg"></div>'
      + '</div>';
  }

  function pickPhoto(id, checked) {
    if (checked) PHOTO_SEL.add(id); else PHOTO_SEL.delete(id);
    renderDetail();
  }

  /**
   * Writes the chosen category onto every selected document.
   *
   * ONE RECORD AT A TIME, because the proxy takes one record per request, and in small batches
   * so a folder of two hundred does not open two hundred sockets at once. A failure on one file
   * does not stop the rest and is NOT swallowed: the ones that did not save are named, because
   * "done" over a silent partial failure is how people stop trusting the screen.
   */
  async function applyCategory() {
    const cat = ($('#siBulkCat') || {}).value || '';
    const ids = [...PHOTO_SEL];
    const out = $('#siRefileMsg');
    if (!cat || !ids.length) return;

    const btn = document.querySelector('[data-act="siPhotoApply"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    const { base } = CURRENT;
    const failed = [];
    const failedIds = new Set();
    let done = 0;

    const nameOf = (id) => {
      const d = (CURRENT.documents || []).find((r) => r.id === id);
      return (d && (d.fields['Document Name'] || (d.fields.File || [])[0]?.filename)) || id;
    };

    for (let i = 0; i < ids.length; i += 5) {
      const batch = ids.slice(i, i + 5);
      await Promise.all(batch.map(async (id) => {
        try {
          await TX.update(base, 'documents', id, { [PHOTO_CAT_FIELD]: cat });
          const d = (CURRENT.documents || []).find((r) => r.id === id);
          if (d) d.fields[PHOTO_CAT_FIELD] = cat;
          done++;
        } catch (e) {
          // The ID, not the name. Matching failures back by their display text breaks the
          // moment two files share a name, which in a folder upload they routinely do.
          failedIds.add(id);
          failed.push(nameOf(id) + ' — ' + TX.errorText(e));
        }
      }));
      if (out) {
        out.innerHTML = '<div class="si-msg">Filed ' + done + ' of ' + ids.length + '…</div>';
      }
    }

    // What saved is deselected; what failed stays ticked, so a retry is one click and does not
    // rewrite the ones that already worked.
    PHOTO_SEL = failedIds;
    if (done) await note(done + ' file(s) re-filed as ' + cat);
    renderDetail();

    const after = $('#siRefileMsg');
    if (after) {
      after.innerHTML = failed.length
        ? '<div class="si-msg err">Filed ' + done + ' of ' + ids.length + '. These did not save '
          + 'and are still selected:<br>' + failed.slice(0, 8).map(esc).join('<br>')
          + (failed.length > 8 ? '<br>… and ' + (failed.length - 8) + ' more.' : '') + '</div>'
        : '<div class="si-msg ok">✓ ' + done + ' file(s) filed as ' + esc(cat) + '.</div>';
    }
  }

  // ── history ──────────────────────────────────────────────────────────────

  function tabHistory(f) {
    const raw = String(f[F.history] || '').trim();
    const lines = raw ? raw.split(/\n+/).reverse() : [];
    return '<dl class="si-facts">'
      + fact('Created', [f[F.createdAt], f[F.createdBy]].filter(Boolean).join(' · '))
      + fact('Last modified', [f[F.modifiedAt], f[F.modifiedBy]].filter(Boolean).join(' · '))
      + '</dl>'
      + '<h3 class="si-sub">Activity</h3>'
      + (lines.length
        ? '<ul class="si-history">' + lines.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>'
        : '<div class="si-empty">No recorded activity yet.</div>');
  }

  /** Appends one line to the site's history. Never blocks the action it describes. */
  async function note(text) {
    if (!CURRENT) return;
    const { rec, base } = CURRENT;
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const line = stamp + ' · ' + (TX.userEmail() || 'unknown') + ' · ' + text;
    const next = [String(rec.fields[F.history] || '').trim(), line].filter(Boolean).join('\n');
    try {
      await TX.update(base, 'site_information', rec.id, {
        [F.history]: next,
        [F.modifiedBy]: TX.userEmail(),
        [F.modifiedAt]: new Date().toISOString(),
      });
      rec.fields[F.history] = next;
    } catch (e) { /* history is a convenience, not a control */ }
  }

  // ── editing ──────────────────────────────────────────────────────────────

  async function setField(key, value) {
    const { rec, base } = CURRENT;
    const before = rec.fields[key];
    let v = value;
    if (/Quantity|Capacity/.test(key)) v = value === '' ? null : Number(value);
    if (v === '') v = null;

    try {
      await TX.update(base, 'site_information', rec.id, {
        [key]: v,
        [F.modifiedBy]: TX.userEmail(),
        [F.modifiedAt]: new Date().toISOString(),
      });
      rec.fields[key] = v;
      msg('ok', key + ' saved.');
      if (key === F.status) await note('Status changed: ' + (sel(before) || '—') + ' → ' + (v || '—'));
      const row = SITES.find((s) => s.id === rec.id);
      if (row) row.fields[key] = v;
    } catch (e) {
      msg('err', TX.errorText(e));
    }
  }

  // ── new site, with duplicate detection ───────────────────────────────────

  async function openNew() {
    view('siNew');
    ['#nsSiteName', '#nsClientName', '#nsAddress', '#nsJc', '#nsSubSol'].forEach((k) => {
      const el = $(k);
      if (el) el.value = '';
    });
    $('#siNewMsg').innerHTML = '';
    $('#nsDupes').innerHTML = '';
  }

  /** Flags a likely duplicate on client+site, job card or SUB/SOL before anything is created. */
  function findDuplicates(name, client, jc, subSol) {
    const n = name.toLowerCase().trim();
    const c = client.toLowerCase().trim();
    return SITES.filter((s) => {
      const f = s.fields;
      if (jc && String(f[F.jcNumber] || '').toLowerCase().trim() === jc.toLowerCase().trim()) return true;
      if (subSol && String(f[F.subSol] || '').toLowerCase().trim() === subSol.toLowerCase().trim()) return true;
      const sn = String(f[F.name] || '').toLowerCase().trim();
      const sc = String(f[F.clientName] || '').toLowerCase().trim();
      return n && sn === n && (!c || sc === c);
    });
  }

  function checkDupes() {
    const host = $('#nsDupes');
    const hits = findDuplicates($('#nsSiteName').value, $('#nsClientName').value,
      $('#nsJc').value, $('#nsSubSol').value);
    if (!hits.length) { host.innerHTML = ''; return; }
    host.innerHTML = '<div class="si-msg warn"><b>This site may already exist.</b><br>'
      + hits.slice(0, 4).map((s) => '<button type="button" class="si-link" data-act="siOpen"'
        + ' data-a1="' + s.id + '" data-a2="' + s._base + '">Open ' + esc(s.fields[F.name])
        + (s.fields[F.clientName] ? ' · ' + esc(s.fields[F.clientName]) : '') + '</button>').join('<br>')
      + '</div>';
  }

  async function saveNew() {
    const out = $('#siNewMsg');
    const name = ($('#nsSiteName').value || '').trim();
    const client = ($('#nsClientName').value || '').trim();
    const base = $('#nsBase').value;
    if (!name) { out.innerHTML = '<div class="si-msg err">A site name is required.</div>'; return; }

    const btn = document.querySelector('[data-act="siSaveNew"]');
    btn.disabled = true;
    btn.textContent = 'Creating…';

    const seq = SITES.length + 1;
    const fields = {
      [F.name]: name,
      [F.id]: 'SITE-' + String(seq).padStart(4, '0'),
      [F.clientName]: client,
      [F.sourceBase]: base === 'OM' ? 'O&M' : 'C&I',
      [F.createdBy]: TX.userEmail(),
      [F.createdAt]: new Date().toISOString(),
      [F.history]: new Date().toISOString().slice(0, 16).replace('T', ' ')
        + ' · ' + (TX.userEmail() || 'unknown') + ' · Site created',
    };
    const opt = (id, key) => {
      const v = ($('#' + id).value || '').trim();
      if (v) fields[key] = v;
    };
    opt('nsAddress', F.address); opt('nsJc', F.jcNumber); opt('nsSubSol', F.subSol);
    const cat = $('#nsCategory').value;
    if (cat) fields[F.category] = cat;

    try {
      const r = await TX.create(base, 'site_information', fields);
      const created = (r.records || [])[0];
      await loadSites();
      if (created) await openSite(created.id, base);
      else view('siListView');
    } catch (e) {
      out.innerHTML = '<div class="si-msg err">' + esc(TX.errorText(e)) + '</div>';
      btn.disabled = false;
      btn.textContent = 'Create site';
    }
  }

  // ── job cards ────────────────────────────────────────────────────────────

  async function showJobCards() {
    const { rec, base } = CURRENT;
    const linked = (rec.fields[F.jobCards] || []).map((x) => (typeof x === 'string' ? x : x.id));
    let all = [];
    try { all = await loadJobCards(); } catch (e) { /* listed below as unavailable */ }

    const mine = all.filter((j) => j.base === base);
    const wrap = document.createElement('div');
    wrap.className = 'si-modal';
    wrap.id = 'siJcModal';
    wrap.innerHTML = '<div class="si-modal-card">'
      + '<div class="si-modal-head"><h2>Job cards for this site</h2>'
      + '<button class="si-x" data-act="siJcClose" aria-label="Close">×</button></div>'
      + '<div class="si-modal-body">'
      + '<p class="si-note">A job card is one piece of work. This record is the site profile it '
      + 'draws on, so linking here saves re-entering the system details on every job.</p>'
      + (mine.length
        ? '<div class="si-jclist">' + mine.slice(0, 60).map((j) => (
          '<label class="si-jc"><input type="checkbox" value="' + j.id + '"'
          + (linked.includes(j.id) ? ' checked' : '') + '>'
          + '<span><b>' + esc(j.ref) + '</b> ' + esc(j.title.slice(0, 48))
          + (j.client ? ' · ' + esc(j.client) : '') + '</span></label>'
        )).join('') + '</div>'
        : '<div class="si-empty">No open job cards available in this base.</div>')
      + '<div id="siJcMsg"></div></div>'
      + '<div class="si-modal-foot">'
      + '<button class="si-btn" data-act="siJcClose">Cancel</button>'
      + '<button class="si-btn primary" data-act="siJcSave">Save links</button>'
      + '</div></div>';
    ($('#modSiteInfo') || document.body).appendChild(wrap);
  }

  async function saveJobCards() {
    const ids = [...document.querySelectorAll('#siJcModal input[type=checkbox]')]
      .filter((c) => c.checked).map((c) => c.value);
    const btn = document.querySelector('[data-act="siJcSave"]');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await TX.update(CURRENT.base, 'site_information', CURRENT.rec.id, { [F.jobCards]: ids });
      CURRENT.rec.fields[F.jobCards] = ids;
      await note('Job card links updated (' + ids.length + ')');
      const m = $('#siJcModal');
      if (m) m.remove();
      renderDetail();
    } catch (e) {
      $('#siJcMsg').innerHTML = '<div class="si-msg err">' + esc(TX.errorText(e)) + '</div>';
      btn.disabled = false;
      btn.textContent = 'Save links';
    }
  }

  // ── wiring ───────────────────────────────────────────────────────────────

  const ACTIONS = {
    siOpen: openSite,
    siPhotoFilter: (v) => { PHOTO_FILTER = v; renderDetail(); },
    siPhotoPick: pickPhoto,
    siPhotoAll: () => { visibleDocs().forEach((d) => PHOTO_SEL.add(d.id)); renderDetail(); },
    siPhotoNone: () => { PHOTO_SEL = new Set(); renderDetail(); },
    siPhotoApply: applyCategory,
    siBack: () => { view('siListView'); CURRENT = null; loadSites(); },
    siTab: (k) => { TAB = k; renderDetail(); },
    siField: setField,
    siNew: openNew,
    siSaveNew: saveNew,
    siCancelNew: () => view('siListView'),
    siDupeCheck: checkDupes,
    siEqNew: openEquipForm,
    siEqClose: closeEquipForm,
    siEqSave: saveEquip,
    siEqDel: delEquip,
    siJobCards: showJobCards,
    siJcClose: () => { const m = $('#siJcModal'); if (m) m.remove(); },
    siJcSave: saveJobCards,
    // CSV import lives in siteinfo-import.js; the modal it builds is inside this panel, so
    // its buttons are dispatched here.
    siImport: () => TX.siteimport && TX.siteimport.open(),
    siImpClose: () => TX.siteimport && TX.siteimport.close(),
    siImpRun: () => TX.siteimport && TX.siteimport.run(),
    // Building a site from a folder of documents lives in siteinfo-batch.js, and its modal is
    // also inside this panel, so the same dispatcher carries it.
    siBatch: () => TX.sitebatch && TX.sitebatch.open('site'),
    siFromJobCard: () => TX.sitebatch && TX.sitebatch.open('jobcard'),
    siFolderReport: () => TX.sitebatch && TX.sitebatch.open('report'),
    siBatchCardQ: (v) => TX.sitebatch && TX.sitebatch.setCardQuery(v),
    siBatchPickCard: (id) => TX.sitebatch && TX.sitebatch.chooseCard(id),
    siBatchChangeCard: () => TX.sitebatch && TX.sitebatch.changeCard(),
    siBatchClose: () => TX.sitebatch && TX.sitebatch.close(),
    siBatchRead: () => TX.sitebatch && TX.sitebatch.read(),
    siBatchApply: () => TX.sitebatch && TX.sitebatch.apply(),
    siBatchDone: (id, base) => TX.sitebatch && TX.sitebatch.done(id, base),
    siBatchCard: (i) => TX.sitebatch && TX.sitebatch.pickCard(i),
    siBatchClear: () => TX.sitebatch && TX.sitebatch.clear(),
    siBatchRestart: () => TX.sitebatch && TX.sitebatch.restart(),
    siBatchField: (k, v) => TX.sitebatch && TX.sitebatch.setField(k, v),
    siBatchEq: (i, checked) => TX.sitebatch && TX.sitebatch.setEquip(i, checked),
    siBatchRetryPick: (i, checked) => TX.sitebatch && TX.sitebatch.pickRetry(i, checked),
    siBatchRetry: () => TX.sitebatch && TX.sitebatch.retryRefused(),
    siBatchPickFiles: () => { const el = $('#batchFiles'); if (el) el.click(); },
    siBatchPickFolder: () => { const el = $('#batchFolder'); if (el) el.click(); },
    siReload: loadSites,
    siRender: renderList,
    siUpload: () => { const el = $('#siFiles'); if (el) el.click(); },
    siPickFolder: () => { const el = $('#siFolder'); if (el) el.click(); },
  };

  /**
   * Runs the action a control declares, for the event it declared. `data-on` defaults to click,
   * so a select must say data-on="change" and a search box data-on="input" — otherwise a change
   * handler would fire on every keystroke and write to Airtable per character.
   */
  function dispatch(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    if ((el.dataset.on || 'click') !== e.type) return;
    const fn = ACTIONS[el.dataset.act];
    if (!fn) return;
    // @val passes the control's value; @checked passes a checkbox's state. @checked exists so a
    // tick box can SET rather than TOGGLE — a toggle silently inverts itself if the handler ever
    // runs twice, leaving the box showing one thing and the data holding the other.
    const arg = (v) => (v === '@val' ? el.value : (v === '@checked' ? el.checked : v));
    fn(...[el.dataset.a1, el.dataset.a2, el.dataset.a3]
      .filter((x) => x !== undefined).map(arg));
  }

  function start() {
    const panel = $('#modSiteInfo');
    if (!panel) return;
    if (!TX.can('site_information', 'view')) { panel.hidden = true; return; }

    panel.addEventListener('click', (e) => {
      if (e.target.closest('input, select, textarea, a')) return;
      dispatch(e);
    });
    panel.addEventListener('change', dispatch);
    panel.addEventListener('input', dispatch);

    const s = $('#siSearch');
    if (s) s.addEventListener('input', renderList);
    for (const id of ['#siFilterCat', '#siFilterStatus']) {
      const el = $(id);
      if (el) el.addEventListener('change', renderList);
    }
    for (const id of ['#nsSiteName', '#nsClientName', '#nsJc', '#nsSubSol']) {
      const el = $(id);
      if (el) el.addEventListener('change', checkDupes);
    }

    const cat = $('#siFilterCat');
    if (cat) cat.innerHTML = CATEGORIES.map((c) => '<option value="' + esc(c) + '">'
      + esc(c || 'All categories') + '</option>').join('');
    const st = $('#siFilterStatus');
    if (st) st.innerHTML = SYSTEM_STATUS.map((c) => '<option value="' + esc(c) + '">'
      + esc(c || 'All statuses') + '</option>').join('');
    const nc = $('#nsCategory');
    if (nc) nc.innerHTML = CATEGORIES.map((c) => '<option value="' + esc(c) + '">'
      + esc(c || '— none —') + '</option>').join('');

    view('siListView');
    loadSites();
    wireUpload();
  }

  // Shared with the CSV importer so the two cannot drift: one definition of what a field is
  // called and which values a select accepts. Airtable rejects an unknown select option by
  // name (typecast is off), so the importer validates against these before sending anything.
  const SCHEMA = {
    fields: F,
    selects: {
      [F.category]: CATEGORIES.filter(Boolean),
      [F.siteType]: SITE_TYPES.filter(Boolean),
      [F.contractType]: CONTRACT_TYPES.filter(Boolean),
      [F.status]: SYSTEM_STATUS.filter(Boolean),
      [F.omAgreement]: ['Yes', 'No', 'Pending', 'Not Applicable'],
      ...Object.fromEntries(DOC_KEYS.map((k) => [k, DOC_STATUS.filter(Boolean)])),
    },
    numbers: [F.panelQty, F.panelKw, F.invQty, F.invKw, F.battQty, F.battKw],
    dates: [F.issued, F.start, F.end, F.installed, F.omStart, F.contractStart,
      F.signed, F.lastService, F.nextService],
  };

  TX.siteinfo = {
    start, reload: loadSites, schema: SCHEMA,
    // The importer needs to warn about duplicates using exactly the rule the New Site form
    // uses, and to refresh the list once it has written.
    duplicatesOf: findDuplicates,
    sites: () => SITES,
    // The batch builder in siteinfo-batch.js opens the site it has just created or updated, and
    // reuses this module's folder walk and file filter rather than keeping a second copy of the
    // rules about what counts as an uploadable file.
    open: (id, base) => openSite(id, base),
    files: {
      usable: (list) => usable(list),
      walk: (entry, out, depth) => walkEntry(entry, out, depth),
      toBase64: (file) => readAsBase64(file),
    },
  };
  TX.on('auth:signedout', () => { SITES = []; CURRENT = null; JOBCARDS = []; });

  // ── upload (defined last: it needs the module's state) ───────────────────
  // The classifier that refuses FICA and financial documents runs on the SERVER, in
  // api/siteinfo-upload.js. What happens here is a courtesy so the user sees the verdict
  // before a slow upload, and it is not the control.

  // Everything a folder carries that is not site information: OS metadata, thumbnails and
  // resource forks. Skipped silently — they are noise, not decisions.
  const JUNK = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\.localized)$|^\._|^~\$/i;
  const TAKE = /\.(jpe?g|png|gif|webp|heic|heif|pdf|docx?|xlsx?|csv|txt)$/i;

  /** Filters a flat file list down to what this module will accept. */
  function usable(files) {
    return files.filter((f) => {
      const name = (f.name || '').trim();
      if (!name || JUNK.test(name)) return false;
      if (!f.size) return false;                       // a folder entry, or an empty file
      return TAKE.test(name) || /^image\//.test(f.type || '');
    });
  }

  /**
   * Walks a dropped directory entry, depth first, collecting Files.
   * readEntries returns at most 100 at a time, so it has to be called until it returns none —
   * the single call a naive implementation makes silently truncates a folder of 100+ photos.
   */
  async function walkEntry(entry, out, depth) {
    if ((depth || 0) > 6) return;                      // a guard against a pathological tree
    if (entry.isFile) {
      await new Promise((res) => entry.file((f) => { out.push(f); res(); }, res));
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, out, (depth || 0) + 1);
    }
  }

  function wireUpload() {
    const panel = $('#modSiteInfo');
    if (!panel) return;

    panel.addEventListener('change', (e) => {
      if (!e.target) return;
      // A folder input hands back every file it contains, sub-folders included, each with a
      // webkitRelativePath. Junk that every Windows and macOS folder carries is dropped here
      // rather than shown to the user as something to decide about.
      if (e.target.id === 'siFiles' || e.target.id === 'siFolder') {
        handleFiles(usable([...e.target.files]));
      }
    });
    panel.addEventListener('dragover', (e) => {
      const drop = e.target.closest('#siDrop');
      if (!drop) return;
      e.preventDefault();
      drop.classList.add('over');
    });
    panel.addEventListener('dragleave', (e) => {
      const drop = e.target.closest('#siDrop');
      if (drop) drop.classList.remove('over');
    });
    panel.addEventListener('drop', async (e) => {
      const drop = e.target.closest('#siDrop');
      if (!drop) return;
      e.preventDefault();
      drop.classList.remove('over');

      // A dropped FOLDER appears in dataTransfer.items as a directory entry and contributes
      // nothing to dataTransfer.files, so dragging one in would silently do nothing without
      // this. The entries have to be captured before the first await, because the DataTransfer
      // is emptied as soon as the handler yields.
      const entries = [...(e.dataTransfer.items || [])]
        .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
        .filter(Boolean);

      if (entries.some((en) => en.isDirectory)) {
        drop.classList.add('busy');
        const found = [];
        for (const en of entries) await walkEntry(en, found);
        drop.classList.remove('busy');
        handleFiles(usable(found));
        return;
      }
      handleFiles(usable([...(e.dataTransfer.files || [])]));
    });
  }

  // Kept in step with the server's list. A local match is a fast refusal, not the decision.
  const LOOKS_SENSITIVE = /(fica|kyc|\bid[\s_-]?(doc|copy|document|number)|identity|passport|licence|license|driver'?s?[\s_-]?lic|proof[\s_-]?of[\s_-]?(res|address|payment)|\bpop\b|bank|statement|invoice|proforma|pro[\s_-]?forma|quote|quotation|payment|remittance|credit[\s_-]?app|sars|vat[\s_-]?cert|financial|payslip|salary|account[\s_-]?number|card)/i;

  /**
   * May this person overrule the FICA classifier?
   *
   * Mirrors the server's double gate (role permission AND per-user flag), which /api/auth/me
   * already resolves into user.canViewRestricted. Cosmetic, like every permission decision in
   * this file: siteinfo-upload.js re-checks it and refuses regardless of what is rendered here.
   */
  function mayClassifyFica() {
    const me = TX.me();
    return !!(me && me.user && me.user.canViewRestricted === true);
  }

  function verdictOf(file) {
    if (LOOKS_SENSITIVE.test(file.name)) return ['BLOCKED', 'Name suggests FICA or financial content'];
    if (/^image\//.test(file.type)) return ['ALLOWED', 'Image'];
    if (/pdf|word|excel|sheet|csv|text/i.test(file.type)) return ['REVIEW', 'Document — confirm it is operational only'];
    if (!file.type) return ['REVIEW', 'Unrecognised type'];
    return ['REVIEW', 'Confirm content'];
  }

  async function handleFiles(files) {
    if (!CURRENT || !files.length) return;
    const host = $('#siQueue');
    const cat = ($('#siPhotoCat') || {}).value || 'Site';
    const desc = (($('#siPhotoDesc') || {}).value || '').trim();

    const admin = mayClassifyFica();
    const rows = files.map((f) => {
      const [v, why] = verdictOf(f);
      return { file: f, verdict: v, why };
    });

    host.innerHTML = '<table class="si-table si-queue"><thead><tr><th>File</th><th>Type</th>'
      + '<th>Size</th><th>Status</th></tr></thead><tbody>'
      + rows.map((r, i) => '<tr id="q' + i + '"><td>' + esc(r.file.name) + '</td>'
        + '<td>' + esc(r.file.type || '—') + '</td>'
        + '<td>' + (r.file.size / 1024 < 1024
          ? (r.file.size / 1024).toFixed(0) + ' KB'
          : (r.file.size / 1048576).toFixed(1) + ' MB') + '</td>'
        + '<td class="si-verdict ' + r.verdict.toLowerCase() + '">' + r.verdict
        + (r.verdict === 'BLOCKED' ? ' — ' + esc(r.why) : '')
        // REVIEW means the server could not read the file well enough to clear it — a scan with
        // no text layer, most often. It refuses unless a person takes responsibility for it, so
        // the confirmation has to exist here or an ordinary scanned CoC could never be uploaded.
        + (r.verdict === 'REVIEW' && !admin
          ? '<label class="si-confirm"><input type="checkbox" data-confirm="' + i + '"> '
            + 'This contains only operational information</label>'
          : '')
        // An admin decides for themselves. The tick box above is a single yes/no for an
        // unreadable file; this is the full judgement, and it can also overrule a BLOCK.
        // Saying "this IS FICA" is offered to everyone the control is shown to, because
        // keeping something out should never need a privilege.
        + (admin && r.verdict !== 'ALLOWED'
          ? '<label class="si-confirm"><select class="si-classify" data-classify="' + i + '">'
            + '<option value="">— not classified —</option>'
            + '<option value="operational">Operational — upload it</option>'
            + '<option value="fica">FICA / financial — do not upload</option>'
            + '</select></label>'
          : '')
        + '</td></tr>').join('')
      + '</tbody></table>'
      + (admin && rows.some((r) => r.verdict !== 'ALLOWED')
        ? '<div class="si-hint">You may classify these yourself. Anything you mark operational '
          + 'is uploaded even if the automatic check refused it, and the override is recorded '
          + 'against your name in the audit log and on the document.</div>'
        : '')
      + (rows.some((r) => r.verdict !== 'BLOCKED') || admin
        ? '<div class="si-actions"><button class="si-btn primary" data-act="siUploadGo">'
          + 'Upload</button>'
          + '<button class="si-btn" data-act="siUploadClear">Clear</button></div>'
        : '<div class="si-msg err">Nothing here can be uploaded. Remove the files and try again.'
          + '</div>');

    ACTIONS.siUploadClear = () => { host.innerHTML = ''; $('#siFiles').value = ''; };
    ACTIONS.siUploadGo = () => {
      // A REVIEW file goes only if someone has ticked its box or classified it; "not sure" must
      // never become "uploaded" by default. A BLOCKED file goes only on an admin's explicit
      // "operational", and "fica" always holds a file back whatever the classifier said.
      const classOf = (i) => {
        const el = document.querySelector('[data-classify="' + i + '"]');
        return el ? el.value : '';
      };

      const marked = rows.map((r, i) => Object.assign({}, r, {
        classification: classOf(i),
        confirmed: !!document.querySelector('[data-confirm="' + i + '"]:checked'),
      }));

      const sendable = (r) => {
        if (r.classification === 'fica') return false;
        if (r.classification === 'operational' && admin) return true;
        if (r.verdict === 'ALLOWED') return true;
        return r.verdict === 'REVIEW' && r.confirmed;
      };

      const send = marked.filter(sendable);
      // Two different reasons to hold a file back, which must not be reported as one: a file
      // deliberately marked FICA was a decision, not an omission.
      const heldFica = marked.filter((r) => r.classification === 'fica').length;
      const heldUnconfirmed = marked.filter((r) => !sendable(r)
        && r.classification !== 'fica').length;
      const held = heldFica + heldUnconfirmed;
      if (!send.length) {
        host.insertAdjacentHTML('beforeend', '<div class="si-msg warn">Nothing to upload. '
          + (admin
            ? 'Classify a file as operational to upload it, or remove it.'
            : 'Tick the confirmation on any file you have checked yourself, or remove it.')
          + '</div>');
        return;
      }
      uploadAll(send, cat, desc, { fica: heldFica, unconfirmed: heldUnconfirmed });
    };
  }

  const readAsBase64 = (file) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(new Error('That file could not be read.'));
    fr.readAsDataURL(file);
  });

  /**
   * @param {{fica:number, unconfirmed:number}} heldBack  why files did not go, counted apart
   */
  /**
   * One line per DISTINCT reason, not one per file.
   *
   * A single misconfigured field produced the same error for all 33 files in a dropped folder,
   * and the summary printed it 33 times — several screens of identical text with the one
   * genuinely different failure buried in the middle of it. What matters is what went wrong and
   * how many it hit.
   */
  function groupFailures(failures) {
    const byReason = new Map();
    for (const f of failures) {
      if (!byReason.has(f.why)) byReason.set(f.why, []);
      byReason.get(f.why).push(f.name);
    }
    return [...byReason.entries()].map(([why, names]) => (
      names.length > 3
        ? names.length + ' files — ' + why
        : names.join(', ') + ' — ' + why
    )).join(' | ');
  }

  async function uploadAll(rows, category, description, heldBack) {
    const held = heldBack || { fica: 0, unconfirmed: 0 };
    const host = $('#siQueue');
    const btn = document.querySelector('[data-act="siUploadGo"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }

    let ok = 0;
    const failures = [];
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      try {
        const content = await readAsBase64(r.file);
        const res = await TX.request('/api/siteinfo-upload', {
          base: CURRENT.base,
          siteId: CURRENT.rec.id,
          filename: r.file.name,
          contentType: r.file.type || 'application/octet-stream',
          category,
          description,
          content,
          confirmedOperational: r.confirmed === true,
          classification: r.classification || '',
        });
        if (res && res.record) CURRENT.documents.push(res.record);
        ok += 1;
      } catch (e) {
        failures.push({ name: r.file.name, why: TX.errorText(e) });
      }
    }

    // The site's own history line records an override, so it is visible to anyone reading the
    // site rather than only to whoever reads the audit log.
    const overrode = rows.filter((r) => r.classification === 'operational').length;
    if (ok) {
      await note(ok + ' file(s) uploaded (' + category + ')'
        + (overrode ? ' — ' + overrode + ' classified operational by hand after an automatic '
          + 'FICA/financial block' : ''));
    }

    const summary = ok + ' uploaded'
      + (failures.length ? ', ' + failures.length + ' refused: ' + groupFailures(failures) : '.')
      + (held.fica
        ? ' ' + held.fica + ' file(s) you marked as FICA or financial were not uploaded.' : '')
      + (held.unconfirmed
        ? ' ' + held.unconfirmed + ' file(s) left unconfirmed and not uploaded.' : '');

    const el = $('#siFiles');
    if (el) el.value = '';

    // The re-render rebuilds the whole tab, queue included, so the summary has to be written
    // AFTER it — otherwise the upload appears to do nothing at all.
    renderDetail();
    msg(failures.length || heldBack ? 'warn' : 'ok', summary);
  }
})();
