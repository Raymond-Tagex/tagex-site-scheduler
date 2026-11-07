// The O&M cover sheet: "Operations Maintenance & Service Assessment Form".
//
// Raymond, 5 Nov 2026: *O AND M EXECUTIVE SUMMERY.docx* becomes the cover sheet of every ticket
// and job card, printed from either screen. One A4 sheet, in the template's order:
//   date, reference, SOL / SUB number
//   1 client details        2 system installed       3 problem / customer concerns
//   4 recommended action    5 estimated cost         6 office use
//   and the "in file" checklist (supplier quote, warehouse list, delivery note, ...).
//
// FILLED FROM THE RECORDS, BLANK WHERE THEY ARE SILENT. Every line is either the data or a ruled
// line to write on, as the job card form does: a cover sheet missing a row would leave nowhere to
// write the answer.
//   - Client details come from the client register (TAGEX Clients base) through the record's
//     client copy, falling back to that copy itself.
//   - The SOL / SUB number is the record's Contract Number and the client's Palladium code(s).
//   - The system is the contract's (register Contracts) and the Site Equipment on that contract.
//   - Warranty is NOT decided here. The template asks "is the work covered?", which depends on the
//     fault; the sheet prints each warranty class's end date (contract-panel.js, the same rules as
//     the screen) and leaves Yes / No / To be confirmed to a person.
//   - Estimated cost is left blank on purpose: job card money is for four people (CLAUDE.md), and
//     a sheet printed by anyone with the export right must not carry it.
//   - A checklist box is ticked Yes only when the record proves the document is there. No is never
//     ticked from data -- an absent link and a missing document look the same.
//
// Every read is checked against the role first. readAll's filterReadFields returns every field for
// a module the role has no rule for, so a role denied site equipment, documents or clients would
// otherwise see them on the sheet.

'use strict';

const at = require('./airtable.js');
const P = require('./permissions.js');
const T = require('./tables.js');
const J = require('./jobcardform.js');
const C = require('../../public/js/contract-panel.js');
const { rgb } = require('pdf-lib');

const MUTED = rgb(0.42, 0.45, 0.5);   // the forms' prompt-line grey (jobcardform.js)
const ACCENT = rgb(0.16, 0.42, 0.28); // the forms' title green (jobcardform.js)

const str = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(', ');
  if (typeof v === 'object') return str(v.name || v.email || '');
  return String(v).trim();
};
const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const day = (iso) => String(iso || '').slice(0, 10);
const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');

/** What the role may read, or null. Checked before every read: see the header. */
function may(auth, moduleKey) {
  const c = P.can(auth.perms, moduleKey, 'view');
  return c.ok ? c : null;
}

/**
 * The facts the sheet needs beyond the ticket or job card itself.
 *
 * @param {object} o
 *   auth, base       the caller and the scheduler base
 *   read             (moduleKey, sub?) -> rows, already field-filtered (the endpoint's readAll)
 *   clientIds        the record's Client link: copies in this base
 *   contractNo       the record's Contract Number ('' when it names none)
 *   jobcardId        the job card behind it, for its documents ('' when none)
 */
async function gather(o) {
  const { auth, base, read } = o;
  const out = { client: null, contract: null, equipment: [], documents: [] };
  const R = T.CLIENT_REGISTER, rb = T.BASES[R.base];
  const cv = may(auth, 'clients');

  // Everything at once, not one after another: the ticket endpoint has already spent several
  // seconds on its own reads, and the function has 30 (vercel.json). A read that fails costs the
  // sheet that section, never the sheet.
  const none = () => [];
  const [mirrors, regRows, conRows, regNames, equipRows, docRows, plantRows] = await Promise.all([
    cv ? read('clients').catch(none) : [],
    cv ? at.list(rb, R.clients, {}).catch(none) : [],
    cv ? at.list(rb, R.contracts, {}).catch(none) : [],
    cv ? at.fieldMaps(rb, R.clients).then((m) => m.idToName).catch(() => ({})) : {},
    may(auth, 'site_equipment') ? read('site_equipment').catch(none) : [],
    o.jobcardId && may(auth, 'documents') ? read('documents').catch(none) : [],
    cv && R.plants ? at.list(rb, R.plants, {}).catch(none) : [],
  ]);

  // ── the client: its copy here names its register record ──
  const mirror = mirrors.find((r) => (o.clientIds || []).includes(r.id)) || null;
  let reg = null;
  if (cv && mirror) {
    const m = regRows.find((r) => r.id === str(mirror.fields['Master Client ID']));
    if (m) reg = { id: m.id, fields: P.filterReadFields(T.expandFieldRules(cv.rule, 'clients', base), m.fields, regNames) };
  }
  const contracts = conRows.filter((c) => str(c.fields.Status) !== 'Inactive');
  const src = (reg && reg.fields) || (mirror && mirror.fields) || null;
  if (src) {
    out.client = {
      name: str(src['Client Name']),
      contact: str(src['Contact Person']),
      phones: [str(src['Mobile Number']), str(src.Phone)].filter(Boolean),
      email: str(src.Email),
      install: str(src.Sites),
      billing: str(src['Postal / Billing Address']),
      palladium: str(src['Palladium Code']),
      // SolaX plants (6 Nov 2026). Login and location are read as the Email and Sites they stand
      // for, so a role denied those on clients is denied them here (as /api/client-register does).
      plants: reg ? plantRows.filter((p) => ids(p.fields.Client).includes(reg.id)).map((p) => {
        const v = P.filterReadFields(T.expandFieldRules(cv.rule, 'clients', base),
          { Email: p.fields['User Name'], Sites: p.fields.Location }, regNames);
        return { name: str(p.fields['Plant Name']), user: str(v.Email), location: str(v.Sites), contract: str(p.fields['Contract Number']) };
      }) : [],
    };
  }

  // ── the contract: the one the record names, or the client's only one (contract-panel rules) ──
  const mine = reg ? contracts.filter((c) => ids(c.fields.Client).includes(reg.id)) : [];
  const details = mine.map((c) => ({ number: str(c.fields['Contract Number']), funder: str(c.fields.Portfolio),
    firstInvoice: day(c.fields['First Invoice Date']), system: str(c.fields['System Description']) }));
  let picked = C.resolve(reg ? details : null, o.contractNo).contract;
  // A record can name a contract its client's register entry does not hold (a stale or misfiled
  // client); the number is still a contract, so look for it across the register.
  if (!picked && o.contractNo) {
    const hit = contracts.find((c) => norm(c.fields['Contract Number']) === norm(o.contractNo));
    if (hit) picked = { number: str(hit.fields['Contract Number']), funder: str(hit.fields.Portfolio),
      firstInvoice: day(hit.fields['First Invoice Date']), system: str(hit.fields['System Description']) };
  }
  if (picked) out.contract = { ...picked, warranty: C.warranty(picked.firstInvoice) };
  const contractNo = (picked && picked.number) || o.contractNo || '';

  // ── equipment on that contract (removed or replaced units are no longer the system) ──
  if (contractNo) {
    out.equipment = equipRows
      .filter((r) => norm(r.fields['Contract Number']) === norm(contractNo))
      .filter((r) => !['Removed', 'Replaced'].includes(str(r.fields.Status)))
      .map((r) => ({ type: str(r.fields['Equipment Type']), make: [str(r.fields.Manufacturer), str(r.fields.Model)].filter(Boolean).join(' '),
        serial: str(r.fields['Serial Number']), qty: str(r.fields.Quantity), until: day(r.fields['Warranty Expiry']) }));
  }

  // ── documents filed against the job card, for the checklist ──
  out.documents = docRows
    .filter((r) => ids(r.fields['Job Card']).includes(o.jobcardId))
    .filter((r) => str(r.fields['Record Status']) !== 'Deleted')
    .map((r) => str(r.fields['Document Type']));
  out.contractNo = contractNo;
  return out;
}

/** The checklist, from the job card's links and its documents. true = proven; null = unknown. */
function inFile(jc, docs) {
  const f = jc || {};
  const has = (...t) => (docs || []).some((d) => t.includes(d)) || null;
  // Short labels, three to a line, under an "In file" heading: the template's nine one-line
  // tables, kept on the sheet's single page.
  return [
    ['Supplier quote', f['Supplier Quotes Attached'] === true || null],
    ['Warehouse list', null],
    ['Delivery note', ids(f['Delivery Notes']).length > 0 || has('Delivery Note')],
    ['Picking slip', ids(f['Picking Slips']).length > 0 || null],
    ['Expense sheet', ids(f['Expense Claims']).length > 0 || null],
    ['Quote', null],
    ['Invoice', !!str(f.Invoice) || has('Invoice')],
    ['Full report*', has('Site Report')],
    ['Photos*', has('Site Photos', 'Before Photos', 'After Photos')],
  ].map(([l, v]) => [l, v === true]);
}

/** Visits as "2026-10-02 Completed -- notes", newest first, for "previous work done". */
const visitLines = (visits) => (visits || []).slice()
  .sort((a, b) => String(b.start).localeCompare(String(a.start))).slice(0, 4)
  .map((v) => [day(v.start), str(v.status), str(v.tech)].filter(Boolean).join(' ') + (str(v.notes) ? ' — ' + str(v.notes) : ''));

/**
 * The sheet's contents, from a ticket and/or a job card and the gathered facts.
 * @param {object} d { kind, ticket?, jobcard?, jobcardRef?, visits?, spares?, facts, generatedBy, today? }
 */
function contents(d) {
  const t = d.ticket || null, jc = d.jobcard || {}, f = d.facts || {};
  const cl = f.client || {};
  const ref = t ? str(t['Ticket Ref']) : str(jc['JC Reference']);
  const jcRef = str(jc['JC Reference']);

  const problem = [];
  if (t) {
    problem.push([str(t['Fault Category']), str(t.Subject)].filter(Boolean).join(' — '));
    if (str(t.Description)) problem.push(str(t.Description));
    const codes = [str(t['Error Code']) && 'Error code: ' + str(t['Error Code']),
      str(t['Asset / Inverter']) && 'Asset: ' + str(t['Asset / Inverter'])].filter(Boolean);
    if (codes.length) problem.push(codes.join('   '));
    const rep = [t['Reported At'] && 'Reported ' + day(t['Reported At']), str(t['Source Channel']) && 'via ' + str(t['Source Channel']),
      str(t['Reported By']) && 'by ' + str(t['Reported By'])].filter(Boolean).join(' ');
    if (rep) problem.push(rep);
  } else {
    if (str(jc.Title)) problem.push(str(jc.Title));
    if (str(jc['Ticket Raised By'])) problem.push('Raised by ' + str(jc['Ticket Raised By']));
    if (str(jc['Pre-Visit Notes'])) problem.push(str(jc['Pre-Visit Notes']));
    if ((d.ticketRefs || []).length) problem.push('Tickets: ' + d.ticketRefs.join(', '));
  }
  const prev = visitLines(d.visits);
  if (prev.length) problem.push('Previous work: ' + prev.join('; '));
  if (t && str(t['Resolution Summary'])) problem.push('Done so far: ' + str(t['Resolution Summary']));

  const action = [];
  const acts = [].concat(jc['Suggested Site Actions'] || []).map(str).filter(Boolean);
  if (acts.length) action.push('Suggested: ' + acts.join(', ') + (str(jc['Suggested Site Actions — Other']) ? ' (' + str(jc['Suggested Site Actions — Other']) + ')' : ''));
  if (str(jc['Pre-Site Scope of Work'])) action.push(str(jc['Pre-Site Scope of Work']));
  if (str(jc['Actual Site Scope of Work'])) action.push('On site: ' + str(jc['Actual Site Scope of Work']));
  const spares = (d.spares || []).map((s) => (s.req ? s.req + ' × ' : '') + [str(s.code), str(s.desc)].filter(Boolean).join(' ')).filter(Boolean);
  if (spares.length) action.push('Spares requested: ' + spares.join('; '));

  // The client's plants on this contract; a plant naming no contract belongs to the client as a whole.
  const plants = (cl.plants || []).filter((p) => !p.contract || !f.contractNo || norm(p.contract) === norm(f.contractNo));
  const latestTech =(d.visits || []).slice().sort((a, b) => String(b.start).localeCompare(String(a.start)))
    .map((v) => str(v.tech)).find(Boolean) || '';
  const w = (f.contract && f.contract.warranty) || [];
  return {
    ref,
    date: day(d.today || new Date().toISOString()),
    numbers: [f.contractNo, cl.palladium].filter(Boolean).join(' · '),
    client: {
      name: cl.name || str(jc['Client Name']),
      // Its own line (Raymond, 6 Nov 2026). Some Contact Person fields hold a phone number: that
      // goes with the numbers, and the contact line is left to write a name on.
      contact: /[a-z]{2}/i.test(cl.contact || '') ? cl.contact : '',
      // No email in the register: the client's SolaX login, when it is one, is the email they use.
      reach: [...(/[a-z]{2}/i.test(cl.contact || '') ? [] : [cl.contact]), ...(cl.phones || []),
        cl.email || (plants.map((p) => p.user).find((u) => /@/.test(u)) || '')]
        .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · '),
      install: cl.install || str(jc['Site / Address']) || (plants.map((p) => p.location).find(Boolean) || '') || cl.billing,
    },
    plantLine: plants.map((p) => [p.name, p.user, p.location].filter(Boolean).join(' · ')).join('\n'),
    contractLine: f.contract ? [f.contract.number, f.contract.funder && 'funder ' + f.contract.funder,
      f.contract.firstInvoice && '1st invoice ' + f.contract.firstInvoice].filter(Boolean).join(' · ') : '',
    system: f.contract ? f.contract.system : '',
    equipment: f.equipment || [],
    problem: problem.filter(Boolean).join('\n'),
    action: action.join('\n'),
    warranty: w.map((x) => x.label.replace(/ \(.*\)$/, '') + ' to ' + x.until + (x.inWarranty ? ' (in warranty)' : ' (ended)')),
    quotation: str(jc.Status) === 'Quotation Pending',
    siteInspection: acts.includes('Site Inspection'),
    technician: str(jc['Technician / Installer']) || latestTech,
    jcRef,
    checklist: inFile(jc, f.documents),
    generatedBy: d.generatedBy || '',
  };
}

/** Draw the cover sheet. @returns {Promise<Uint8Array>} */
async function coverSheetPdf(d) {
  const c = contents(d);
  const { doc, form: s } = await J.newForm('Cover sheet ' + c.ref);
  s.letterhead(c.ref, ['Cover sheet', 'Printed: ' + c.date]);
  // A smaller title than the job card's: this sheet has to fit its one page, and the 17pt title
  // with its spacing was the difference between a typical ticket on one page and on two.
  s.y -= 14;
  s.write('O&M SERVICE ASSESSMENT', J.A4.w / 2 - s.width('O&M SERVICE ASSESSMENT', 14, s.f.bold) / 2, s.y, 14, s.f.bold, ACCENT);
  s.y -= 2;
  s.row([{ l: 'Date:', w: 0.24 }, { l: 'Reference Number:', w: 0.38 }, { l: 'SOL / SUB Number:' }], [c.date, c.ref, c.numbers]);

  s.heading('1. Client details');
  s.field('Name and Surname / Business name:', c.client.name);
  s.field('Contact Person:', c.client.contact);
  s.field('Contact Number / Email:', c.client.reach);
  s.field('Installation Address:', c.client.install);

  s.heading('2. System installed details');
  // The system on the contract's own line, wrapping if long, rather than a box under it: the
  // Contact Person line (6 Nov 2026) needed the room to keep a typical record on one page.
  s.field('Contract:', [c.contractLine, c.system].filter(Boolean).join(' — '));
  if (!c.contractLine && !c.system) s.field('System:', '');
  if (c.plantLine) s.field('SolaX plant:', c.plantLine);
  if (c.equipment.length) {
    const W = J.CW;
    s.grid([{ t: 'Type', w: W * 0.16 }, { t: 'Make / Model', w: W * 0.34 }, { t: 'Serial Number', w: W * 0.26 },
      { t: 'Qty', w: W * 0.08 }, { t: 'Warranty to', w: W * 0.16 }],
    c.equipment.map((e) => [e.type, e.make, e.serial, e.qty, e.until]));
  }

  s.heading('3. Problem / customer concerns');
  s.note('Provide customer concerns, including any relevant dates, error codes, and previous work done.');
  s.block(c.problem, 3);

  // The template's heading runs on with "and/or additional materials / labour required", which
  // does not fit the band: that half is the prompt line, as section 3's is.
  s.heading('4. Possible solution / recommended action');
  s.note('Include any additional materials and / or labour required.');
  s.block(c.action, 3);

  s.heading('5. Estimated cost');
  const W = J.CW;
  s.grid([{ t: 'Description', w: W * 0.6 }, { t: 'Estimated Cost', w: W * 0.4 }],
    [['Labour', 'R'], ['Materials / Equipment', 'R'], ['Additional Costs', 'R'],
      Object.assign(['TOTAL ESTIMATED COST', 'R'], { bold: true })], { rowH: 13 });

  s.heading('6. Office use');
  s.ticks(['Yes', 'No', 'To be confirmed'], [], { label: 'Is the work covered under warranty?' });
  // Two classes to a line, so the dates are read rather than cut off at the margin.
  for (let i = 0; i < c.warranty.length; i += 2) {
    const two = c.warranty.slice(i, i + 2).join(';   ');
    s.need(12); s.y -= i ? 10 : 12;
    s.write((i ? '' : 'From the 1st invoice: ') + two, i ? J.M + 92 : J.M, s.y, 8, s.f.reg, MUTED);
  }
  s.row([{ l: 'Quotation Required:', yes: true }, { l: 'Site Inspection Required:', yes: true }], [c.quotation, c.siteInspection]);
  s.row([{ l: 'Assigned Technician:' }, { l: 'Quotation / Job Card Number:' }], [c.technician, c.jcRef]);
  s.field('Additional Notes:', '');
  s.signature('Signature:', '', '');

  // A label rather than a full section band: the sheet is one page, as the template is, and the
  // band with the room it keeps under it pushed these three lines onto a second.
  s.need(16 + 3 * 14);
  s.y -= 16;
  s.write('IN FILE  (* if required)', J.M, s.y, 9.5, s.f.bold);
  for (let i = 0; i < c.checklist.length; i += 3) {
    const three = c.checklist.slice(i, i + 3);
    s.row(three.map(([l]) => ({ l: l + ':', yes: true })), three.map(([, v]) => v));
  }

  s.footer(c.ref, c.generatedBy);
  return doc.save();
}

/** "COVER-TKT-2026-0042-2026-11-05.pdf" */
function coverFilename(ref) {
  const clean = String(ref || 'record').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return 'COVER-' + clean + '-' + new Date().toISOString().slice(0, 10) + '.pdf';
}

module.exports = { gather, contents, inFile, coverSheetPdf, coverFilename };
