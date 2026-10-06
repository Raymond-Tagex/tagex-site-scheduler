// The TAGEX job card, as the printed form.
//
// SOURCE: TAGEX JOB CARD TEMPLATE SEP2026.docx. This reproduces that form — the same sections in
// the same order, with the same wording — and fills in whatever the record knows.
//
// WHY IT IS DRAWN RATHER THAN MAIL-MERGED. The .docx is a form to be written on: ruled lines,
// tick boxes, blank grids. Merging fields into a copy of it needs Word on a server. Drawing it
// with pdf-lib, which this app already uses for the ticket report, gives the same sheet with the
// known values already on it and a ruled line everywhere else — which is what somebody carrying
// it to site actually needs.
//
// WHAT IS FILLED AND WHAT IS LEFT BLANK
//
// Filled:  everything on the Job Cards record, the Summary of Costs total column from the
//          Costing table, and the two visit tables from Site Visits.
// Blank:   the Warehouse and Supplier columns of the cost grid (Costing holds one figure per
//          category, not the split), and the travel / accommodation / labour / rental detail,
//          which is captured as costs rather than as the form's individual lines.
//
// A TICK BOX IS A DRAWN RECTANGLE. U+2610 is not in WinAnsi, so text() would drop it — and a
// form whose boxes silently vanish is worse than one with no boxes at all.

'use strict';

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { wrap, str, fmtDate } = require('./ticketreport.js');

const A4 = { w: 595.28, h: 841.89 };
const M = 42;
const CW = A4.w - 2 * M;

const INK = rgb(0.08, 0.09, 0.11);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.72, 0.74, 0.78);
const BAND = rgb(0.93, 0.94, 0.96);
const ACCENT = rgb(0.16, 0.42, 0.28);

const CO = Object.freeze({
  name: 'TAGEX ENERGY (PTY) Ltd',
  addr: '412 Heidelberg Street, Tulisa Park, Alberton',
});

// Verbatim from the template. Word ran the sub-clauses together inside one paragraph; they are
// split here so they read as clauses, but not a word is changed.
const TERMS = [
  '1. Call-Out Authorization',
  '1.1 A call-out is initiated upon client request and confirmation by the service provider.',
  '1.2 By requesting a call-out, the client agrees to the terms outlined below.',
  '1.3 Minimum call-out charges may apply, regardless of fault found.',
  '2. Client Responsibility for Faults',
  '2.1 If, upon inspection, a fault is determined to have been caused by client misuse, negligence, lack of WiFi service due to client-side issues, improper operation, unauthorised modifications or repairs, failure to follow operating or maintenance instructions, or damage caused by third parties under the client’s control, the client shall be fully responsible for all associated costs.',
  'For purposes of this clause, WiFi services shall be deemed “not operational” or “faulty” due to client cause where the disruption or loss of connectivity arises from:',
  'a) Power interruptions or improperly powered equipment within the client’s premises;',
  'b) Unauthorised configuration changes, resets, firmware updates, or network setting modifications by the client or third parties;',
  'c) Physical damage, disconnection, relocation, or tampering with network equipment or cabling under the client’s control;',
  'd) Faulty or misconfigured client-owned devices;',
  'e) Third-party equipment or services interfering with network performance; or',
  'f) Environmental or structural changes affecting signal strength or coverage.',
  'WiFi services shall not be deemed client-caused where the fault is directly attributable to defective equipment supplied by the service provider (under warranty) or to incorrect installation or configuration performed by the service provider.',
  '2.2 Any repairs, replacement parts, or additional work required due to such faults will be quoted separately and billed to the client upon approval.',
  '3. Travel and On-Site Charges',
  '3.1 Travel costs to and from the client’s premises will be charged to the client’s account.',
  '3.2 Travel time may be billed at the applicable hourly rate.',
  '3.3 All time spent on-site, including inspection, diagnostics, waiting time, and repair work, will be charged at the applicable hourly rate.',
  '3.4 Overtime, after-hours, weekend, and public holiday rates may apply where relevant.',
  '4. Access and Delays',
  '4.1 The client must ensure safe and reasonable access to the site and equipment.',
  '4.2 Delays caused by lack of access, site readiness, or client unavailability will be billed as on-site time.',
  '5. Payment Terms',
  '5.1 All call-out, travel, labour, and related charges will be invoiced to the client’s account.',
  '5.2 Payment is due in accordance with the agreed credit terms, or immediately for non-account clients.',
  '6. Acceptance',
  'Requesting and/or confirming a call-out constitutes acceptance of these terms and conditions.',
];

const ENTITIES = ['Tagex Energy', 'Solax Energy', 'PPA', 'Alpine', 'Direct Purchase'];
const ACTIONS = ['Site Inspection', 'Installation', 'Maintenance', 'Decommissioning',
  'Testing & Commissioning', 'Warranty Work', 'Stock / Asset Allocation', 'Other'];
const CLASSES = ['Standard Operational Activity', 'Emergency / Critical Response'];
const CONFIRMS = ['Structural Integrity Visually Confirmed', 'Electrical Infrastructure Verified',
  'Access & Safety Clearance Confirmed', 'Client Requirements Confirmed',
  'Photographic Evidence Attached'];

// The form's Summary of Costs, against the Costing table's columns, in the paper's order.
//
// MATERIALS IS NOT ON THE PAPER, and is here anyway. Costing carries a Material Cost column --
// R33 820.75 across the live rows -- and its Total formula includes it. Printing the eight
// paper rows and that total gave a grid whose own column did not add up, which on a cost
// summary somebody signs is worse than a row the template did not anticipate.
const COST_ROWS = [
  ['Capital Goods', 'Capital Cost'],
  ['DC Equipment', 'DC Cost'],
  ['AC Equipment', 'AC Cost'],
  ['Materials', 'Material Cost'],
  ['Travelling', 'Transport Cost'],
  ['Accommodation', 'Accommodation Cost'],
  ['Labour', 'Labour Cost'],
  ['Equipment Rental', 'Rental Cost'],
  ['Unforseen items', 'Other Cost'],
];

/**
 * One row of the cost grid: what the warehouse supplied, what a supplier did, and the total.
 *
 * The total is the category's own field where it has a value, because that is the figure
 * Costing's Total formula is built on and what the job card was budgeted against. Where it is
 * empty but the split has been filled in, the two are added -- so a row somebody entered only
 * as a split still carries a total rather than printing as nothing.
 */
function costRow(costing, key) {
  const wh = costing[key + ' (Warehouse)'];
  const sup = costing[key + ' (Supplier)'];
  const own = costing[key];
  const has = (n) => n !== null && n !== undefined && n !== '';
  const total = has(own) ? Number(own)
    : ((has(wh) || has(sup)) ? Number(wh || 0) + Number(sup || 0) : null);
  return { wh, sup, total };
}

const list = (v) => (Array.isArray(v) ? v.map((x) => ((x && x.name) || x)).filter(Boolean) : (v ? [str(v)] : []));
const money = (n) => (n === null || n === undefined || n === '' ? '' : 'R ' + Number(n).toFixed(2));
const qty = (n) => (n === null || n === undefined || n === '' ? '' : String(n));
// A checkbox Airtable did not send is unanswered, not No -- so a blank, for a pen.
const yesno = (v) => (v ? 'Yes' : '');

/**
 * The four logistics blocks of the form, against the Costing table's columns.
 *
 * [heading, required-tick field, approved-tick field, total field, [label, field, format]...]
 *
 * One list, used to lay the blocks out and to check them, so a field cannot be added to the
 * table and silently never printed.
 */
const LOGISTICS = [
  ['Transportation Details', 'Travel Required', 'Travel Approved by Management', 'Transport Cost', [
    ['Vehicle Allocation:', 'Vehicle Allocation', str],
    ['Driver Name:', 'Driver Name', str],
    ['Fuel = R', 'Fuel Rate per km', qty, '/km'],
    ['Inclusive = R', 'Inclusive Rate per km', qty, '/km'],
    ['Distance to Site (km):', 'Distance to Site (km)', qty],
    ['Total Km:', 'Total Km', qty],
    ['Site Visit Km:', 'Site Visit Km', qty],
    ['Trip 2 Km:', 'Trip 2 Km', qty],
    ['Trip 3 Km:', 'Trip 3 Km', qty],
    ['Toll Fees Required:', 'Toll Fees Required', yesno],
    ['Toll Fees:', 'Toll Fees', money],
  ], 'Total Travel Cost:'],
  ['Accommodation Details', 'Accommodation Required', 'Accommodation Approved by Management',
    'Accommodation Cost', [
      ['Location / Establishment Name:', 'Accommodation Establishment', str],
      ['Number of Personnel:', 'Accommodation Personnel', qty],
      ['From Date:', 'Accommodation From', fmtDate],
      ['To Date:', 'Accommodation To', fmtDate],
      ['Number of Nights:', 'Accommodation Nights', qty],
      ['Cost per Night:', 'Accommodation Cost per Night', money],
    ], 'Total Accommodation Cost:'],
  ['Labour Details', 'Labour Required', 'Labour Approved by Management', 'Labour Cost', [
    ['Location / Establishment Name:', 'Labour Location', str],
    ['Number of days:', 'Labour Days', qty],
    ['Cost per day:', 'Labour Cost per Day', money],
    ['Staff Names:', 'Staff Names', str],
  ], 'Total Cost:'],
  ['Rental Details', 'Rental Required', 'Rental Approved by Management', 'Rental Cost', [
    ['Location / Establishment Name:', 'Rental Location', str],
    ['Equipment:', 'Rental Equipment', str],
    ['Number of days:', 'Rental Days', qty],
    ['Fixed Cost:', 'Rental Fixed Cost', money],
    ['Cost per day:', 'Rental Cost per Day', money],
  ], 'Total Cost:'],
];

class Form {
  constructor(doc, fonts) {
    this.doc = doc;
    this.f = fonts;
    this.pages = [];
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([A4.w, A4.h]);
    this.pages.push(this.page);
    this.y = A4.h - M;
    return this.page;
  }

  need(h) { if (this.y - h < M + 26) this.newPage(); }

  rect(x, y, w, h, opts = {}) {
    this.page.drawRectangle({ x, y, width: w, height: h,
      borderWidth: opts.bw === undefined ? 0.7 : opts.bw,
      borderColor: opts.bc || RULE, color: opts.fill });
  }

  line(x1, y1, x2, y2, th = 0.6, c = RULE) {
    this.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: th, color: c });
  }

  write(s, x, y, size = 9, font = this.f.reg, colour = INK) {
    this.page.drawText(str(s), { x, y, size, font, color: colour });
  }

  /** A drawn box, ticked or not, with its label beside it. Returns the width it used. */
  tick(x, y, label, on, size = 8.5) {
    const s = 8;
    this.rect(x, y - 1, s, s, { bc: on ? INK : RULE, bw: on ? 1 : 0.7 });
    if (on) {
      this.line(x + 1.6, y + 3, x + 3.2, y + 0.8, 1.1, INK);
      this.line(x + 3.2, y + 0.8, x + 6.6, y + 6, 1.1, INK);
    }
    this.write(label, x + s + 4, y, size, on ? this.f.bold : this.f.reg);
    return s + 8 + this.f.reg.widthOfTextAtSize(str(label), size);
  }

  /** A row of tick boxes, wrapping onto further lines when it runs out of width. */
  ticks(options, chosen, size = 8.5) {
    const on = new Set(list(chosen).map((c) => String(c)));
    let x = M;
    this.need(14);
    this.y -= 11;
    options.forEach((o) => {
      const w = 8 + 4 + this.f.reg.widthOfTextAtSize(String(o), size) + 14;
      if (x + w > M + CW) { this.need(13); this.y -= 12; x = M; }
      this.tick(x, this.y, o, on.has(o), size);
      x += w;
    });
    this.y -= 5;
  }

  heading(s) {
    this.need(26);
    this.y -= 16;
    this.rect(M, this.y - 3, CW, 15, { fill: BAND, bw: 0 });
    this.write(String(s).toUpperCase(), M + 5, this.y + 1.5, 8.5, this.f.bold, ACCENT);
    this.y -= 7;
  }

  /**
   * A label and, beside it, either the value or a ruled line to write one on.
   *
   * The ruled line is the point: this is a form. A row that simply vanished when the field was
   * empty would leave somebody on site with nowhere to write the answer.
   */
  field(label, value, opts = {}) {
    const w = opts.width || CW;
    const size = 8.5;
    const labelW = this.f.bold.widthOfTextAtSize(String(label), size) + 6;
    const x = opts.x === undefined ? M : opts.x;
    if (opts.x === undefined) { this.need(16); this.y -= 13; }
    this.write(label, x, this.y, size, this.f.bold);
    const v = str(value);
    if (v) this.write(v, x + labelW, this.y, size, this.f.reg);
    else this.line(x + labelW, this.y - 1.5, x + w - 4, this.y - 1.5);
    return x + w;
  }

  /** Two fields side by side, the way the form pairs them. */
  pair(l1, v1, l2, v2) {
    this.need(16);
    this.y -= 13;
    const half = CW / 2;
    this.field(l1, v1, { x: M, width: half - 8 });
    this.field(l2, v2, { x: M + half, width: half });
  }

  /** A block of text, or ruled lines to write one in. */
  block(value, lines = 3) {
    const v = str(value);
    const size = 8.5;
    if (v) {
      const rows = wrap(v, this.f.reg, size, CW - 10);
      this.need(rows.length * 11 + 8);
      const h = rows.length * 11 + 8;
      this.rect(M, this.y - h + 4, CW, h);
      let ty = this.y - 7;
      rows.forEach((r) => { this.write(r, M + 5, ty, size); ty -= 11; });
      this.y -= h;
      return;
    }
    this.need(lines * 14 + 6);
    for (let i = 0; i < lines; i++) { this.y -= 14; this.line(M, this.y, M + CW, this.y); }
    this.y -= 4;
  }

  /** A bordered grid whose heading repeats on every page it runs onto. */
  grid(cols, rows, opts = {}) {
    const size = 8;
    const head = () => {
      this.need(16);
      this.y -= 14;
      let x = M;
      cols.forEach((c) => {
        this.rect(x, this.y - 2, c.w, 14, { fill: BAND });
        this.write(c.t, x + 4, this.y + 2, size, this.f.bold);
        x += c.w;
      });
      this.y -= 2;
    };
    head();
    rows.forEach((r) => {
      const rowH = opts.rowH || 15;
      if (this.y - rowH < M + 26) { this.newPage(); head(); }
      this.y -= rowH;
      let x = M;
      cols.forEach((c, i) => {
        this.rect(x, this.y, c.w, rowH);
        const cell = str(r[i]);
        if (cell) {
          const fit = wrap(cell, this.f.reg, size, c.w - 8)[0] || '';
          this.write(fit, x + 4, this.y + rowH / 2 - 3, size,
            r.bold ? this.f.bold : this.f.reg);
        }
        x += c.w;
      });
    });
    this.y -= 4;
  }

  /** A name-and-date signature row, as the form lays them out. */
  signature(label, name, when) {
    this.need(20);
    this.y -= 17;
    const size = 8.5;
    this.write(label, M, this.y, size, this.f.bold);
    const lx = M + 160;
    const nameW = 200;
    if (str(name)) this.write(name, lx, this.y, size);
    else this.line(lx, this.y - 1.5, lx + nameW, this.y - 1.5);
    this.write('Date:', lx + nameW + 14, this.y, size, this.f.bold);
    const dx = lx + nameW + 46;
    if (str(when)) this.write(fmtDate(when), dx, this.y, size);
    else this.line(dx, this.y - 1.5, M + CW, this.y - 1.5);
  }
}

/**
 * Draw the job card.
 *
 * @param {object} d  { jobcard, client, site, costing, visits, ticketRefs, generatedBy }
 * @returns {Promise<Uint8Array>}
 */
async function jobCardFormPdf(d) {
  const doc = await PDFDocument.create();
  const fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const f = d.jobcard || {};
  const ref = str(f['JC Reference']);
  doc.setTitle('TAGEX Job Card ' + ref);

  const s = new Form(doc, fonts);

  // ── the approval strip across the head of page one ────────────────────────
  const decision = str(f['Director Decision']);
  const cellW = CW / 3;
  s.y -= 34;
  ['Approved', 'Denied', 'Completed'].forEach((word, i) => {
    const x = M + i * cellW;
    s.rect(x, s.y, cellW - 6, 34);
    s.tick(x + 6, s.y + 22, word.toUpperCase(), decision === word, 8);
    s.write('Director Signature:', x + 6, s.y + 11, 6.5, fonts.reg, MUTED);
    const who = decision === word ? str(f['Director Decision By']) : '';
    if (who) s.write(who, x + 76, s.y + 11, 6.5);
    else s.line(x + 76, s.y + 10, x + cellW - 12, s.y + 10);
    s.write('Date:', x + 6, s.y + 3, 6.5, fonts.reg, MUTED);
    const when = decision === word ? fmtDate(f['Director Decision Date']) : '';
    if (when) s.write(when, x + 30, s.y + 3, 6.5);
    else s.line(x + 30, s.y + 2, x + cellW - 12, s.y + 2);
  });
  s.y -= 6;

  // ── title ─────────────────────────────────────────────────────────────────
  s.y -= 22;
  const title = 'JOB CARD';
  s.write(title, A4.w / 2 - fonts.bold.widthOfTextAtSize(title, 17) / 2, s.y, 17, fonts.bold, ACCENT);
  s.y -= 6;
  s.write(CO.name + ' · ' + CO.addr,
    A4.w / 2 - fonts.reg.widthOfTextAtSize(CO.name + ' · ' + CO.addr, 7) / 2,
    s.y, 7, fonts.reg, MUTED);
  s.y -= 4;

  // ── identity ──────────────────────────────────────────────────────────────
  s.field('Entity Name:', '');
  s.y += 13;                                  // the ticks sit on the same line as the label
  s.ticks(ENTITIES, f['Entity Name']);

  s.pair('Job Card Number:', ref, 'Ticket Number:', (d.ticketRefs || []).join(', '));
  s.field('Project Reference Number:', list(f['Generated Reference String (from Job Card References)']).join(', '));
  s.field('Client Name:', d.client);
  s.field('Site Address:', d.site);
  s.pair('Actual Date of Issue:', fmtDate(f['Issued Date']), 'Ticket Raised By:', f['Ticket Raised By']);

  s.heading('Pre-Visit Notes');
  s.block(f['Pre-Visit Notes']);

  s.heading('Suggested Site Actions');
  s.ticks(ACTIONS, f['Suggested Site Actions']);
  s.field('Other:', f['Suggested Site Actions — Other']);

  s.heading('Operational Classification');
  s.ticks(CLASSES, f['Operational Classification']);

  s.heading('General Notes');
  s.block(f['General Notes']);

  s.heading('Pre-Site Visit — Scope of Work');
  s.write('Provide a detailed description of work to be executed:', M, s.y - 10, 8, fonts.reg, MUTED);
  s.y -= 12;
  s.block(f['Pre-Site Scope of Work']);

  // The dated rows come from Site Visits, which is where the scheduler already writes them.
  const visits = (d.visits || []).slice().sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const now = Date.now();
  const before = visits.filter((v) => !v.start || Date.parse(v.start) > now || v.status === 'Scheduled');
  const after = visits.filter((v) => before.indexOf(v) < 0);
  const padTo = (rows, n, width) => {
    const out = rows.slice();
    while (out.length < n) out.push(new Array(width).fill(''));
    return out;
  };

  s.grid([{ t: 'Date', w: 90 }, { t: 'Description', w: CW - 90 }],
    padTo(before.map((v) => [fmtDate(v.start), v.subject || v.notes || '']), 6, 2));

  s.heading('On-Site Inspection');
  s.pair('Site Inspection Conducted By:', f['Site Inspection Conducted By'],
    'Date of Inspection:', fmtDate(f['Date of Inspection']));
  s.ticks(CONFIRMS, f['Inspection Confirmations']);

  s.heading('Actual Site Visit — Scope of Work');
  s.block(f['Actual Site Scope of Work']);
  s.grid([{ t: 'Date', w: 90 }, { t: 'Description', w: CW - 240 }, { t: 'Outcome', w: 150 }],
    padTo(after.map((v) => [fmtDate(v.start), v.subject || v.notes || '', v.status || '']), 6, 3));

  // ── stock, material and logistics ─────────────────────────────────────────
  const c = d.costing || {};
  s.heading('Stock, Material & Logistics Allocation');
  s.need(16);
  s.y -= 13;
  s.tick(M, s.y, 'BOM Attached', !!(d.bomCount));
  s.tick(M + 200, s.y, 'Supplier Quotes Attached', !!f['Supplier Quotes Attached']);
  s.y -= 4;

  // Each block prints what was recorded against this job card, and a ruled line for anything
  // that was not -- the form is still something somebody writes on at site.
  LOGISTICS.forEach(([name, requiredKey, approvedKey, totalKey, rows, totalLabel]) => {
    s.need(22);
    s.y -= 15;
    s.write(name, M, s.y, 8.5, fonts.bold);
    // "Required: Yes / No" is two boxes on the paper. Airtable drops an unchecked box from
    // the record entirely, so a false checkbox and an unanswered one are the same thing here:
    // Yes is ticked when it is set, and otherwise both boxes print empty to be ticked by hand.
    const req = !!c[requiredKey];
    let x = M + fonts.bold.widthOfTextAtSize(name, 8.5) + 18;
    s.write('Required:', x, s.y, 8, fonts.reg, MUTED);
    x += 44;
    x += s.tick(x, s.y, 'Yes', req, 8) + 8;
    s.tick(x, s.y, 'No', false, 8);

    rows.forEach(([label, key, fmt, suffix]) => {
      const v = fmt ? fmt(c[key]) : str(c[key]);
      s.field(label, v ? v + (suffix || '') : '');
    });

    s.need(18);
    s.y -= 14;
    s.write(totalLabel, M, s.y, 8.5, fonts.bold);
    const tw = fonts.bold.widthOfTextAtSize(totalLabel, 8.5) + 6;
    const tv = money(costRow(c, totalKey).total);
    if (tv) s.write(tv, M + tw, s.y, 8.5, fonts.bold);
    else s.line(M + tw, s.y - 1.5, M + 220, s.y - 1.5);
    const app = !!c[approvedKey];
    let ax = M + 240;
    s.write('Approved by Management:', ax, s.y, 8, fonts.reg, MUTED);
    ax += 112;
    ax += s.tick(ax, s.y, 'Yes', app, 8) + 8;
    s.tick(ax, s.y, 'No', false, 8);
    s.y -= 3;
  });

  s.heading('Unforseen Costs');
  s.block('', 2);

  // ── summary of costs ──────────────────────────────────────────────────────
  s.heading('Summary of Costs');
  const w1 = CW - 300;
  const cols = [{ t: 'Cost Description', w: w1 }, { t: 'Warehouse', w: 100 },
    { t: 'Supplier', w: 100 }, { t: 'Total Cost', w: 100 }];
  const sums = { wh: 0, sup: 0, total: 0 };
  const costRows = COST_ROWS.map(([label, key]) => {
    const r = costRow(c, key);
    sums.wh += Number(r.wh || 0);
    sums.sup += Number(r.sup || 0);
    sums.total += Number(r.total || 0);
    return [label, money(r.wh), money(r.sup), money(r.total)];
  });
  // The grand total is the sum of the rows above it, not Costing's own Total formula. They
  // agree whenever every category's total field is filled -- and when one is not, a column
  // that does not add up is the thing somebody will query.
  const total = ['TOTAL COST', money(sums.wh || null), money(sums.sup || null), money(sums.total)];
  total.bold = true;
  costRows.push(total);
  s.grid(cols, costRows);
  s.write('Each row\u2019s total is the category figure where one is recorded, otherwise '
    + 'Warehouse plus Supplier. TOTAL COST is the sum of the rows above.',
    M, s.y - 8, 6.5, fonts.reg, MUTED);
  s.y -= 10;

  // ── people and dates ──────────────────────────────────────────────────────
  s.heading('Responsible Personnel');
  s.pair('Project Manager:', d.responsible, 'Technician / Installer:', f['Technician / Installer']);

  s.heading('Timeline Control');
  s.pair('Planned Start Date:', fmtDate(f['Started Project']), 'Site Visit Date:', fmtDate(f['Site Visit Date']));
  s.pair('Actual Installation Date:', fmtDate(f['Actual Installation Date']),
    'Actual Completion Date:', fmtDate(f['Completed Project']));
  s.write('Delay Explanation (if applicable):', M, s.y - 12, 8, fonts.reg, MUTED);
  s.y -= 14;
  s.block(f['Delay Explanation'], 2);

  s.heading('Signatures for Approvals');
  s.signature('Requested By:', f['Requested By'], f['Requested By Date']);
  s.signature('Procurement:', f['Procurement Approved By'], f['Procurement Approved Date']);
  s.signature('Operational / Executive Approval:', f['Operational Approved By'], f['Operational Approved Date']);
  s.signature('Financial Oversight Approval:', f['Financial Approved By'], f['Financial Approved Date']);
  s.signature('Final Completion Sign-Off:', f['Final Sign-Off By'], f['Final Sign-Off Date']);

  // ── terms, verbatim ───────────────────────────────────────────────────────
  s.newPage();
  s.y -= 6;
  s.write('Service Call-Out Terms and Conditions', M, s.y, 11, fonts.bold, ACCENT);
  s.y -= 6;
  TERMS.forEach((clause) => {
    const isHead = /^\d+\. [A-Z]/.test(clause);
    const font = isHead ? fonts.bold : fonts.reg;
    const rows = wrap(clause, font, 7.5, CW);
    s.need(rows.length * 9.5 + (isHead ? 8 : 3));
    s.y -= isHead ? 12 : 5;
    rows.forEach((r) => { s.y -= 9.5; s.write(r, M, s.y, 7.5, font); });
  });

  s.heading('Client Acceptance of Terms and Conditions');
  s.para = null;                               // nothing below uses it; kept explicit
  wrap('By signing below, the client confirms that they have read, understood, and agree to be '
    + 'bound by the Service Call-Out Terms and Conditions outlined above. The client further '
    + 'acknowledges acceptance of all associated costs, responsibilities, and conditions as '
    + 'defined.', fonts.reg, 8, CW).forEach((r) => { s.need(11); s.y -= 11; s.write(r, M, s.y, 8); });
  s.y -= 4;

  s.field('Client Name:', f['Client Acceptance Name'] || d.client);
  s.field('Company (if applicable):', f['Client Acceptance Company']);
  s.field('Contact Number:', f['Client Acceptance Contact']);
  s.field('Email Address:', f['Client Acceptance Email']);
  s.field('Client Signature:', '');
  s.field('Date:', fmtDate(f['Client Acceptance Date']));

  // ── footer on every page ──────────────────────────────────────────────────
  const stampText = ref + '  ·  printed ' + fmtDate(new Date().toISOString())
    + (d.generatedBy ? '  ·  ' + d.generatedBy : '');
  s.pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: M - 8 }, end: { x: M + CW, y: M - 8 }, thickness: 0.6, color: RULE });
    p.drawText(stampText, { x: M, y: M - 19, size: 6.5, font: fonts.reg, color: MUTED });
    const n = 'Page ' + (i + 1) + ' of ' + s.pages.length;
    p.drawText(n, { x: M + CW - fonts.reg.widthOfTextAtSize(n, 6.5), y: M - 19, size: 6.5,
      font: fonts.reg, color: MUTED });
  });

  return doc.save();
}

/** "JC-OM-2026-0169-MAINT-TE-2026-09-30.pdf" — safe on every filesystem. */
function formFilename(ref) {
  const clean = String(ref || 'job-card').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return 'JC-' + clean + '-' + new Date().toISOString().slice(0, 10) + '.pdf';
}

module.exports = { jobCardFormPdf, formFilename, TERMS, COST_ROWS, ENTITIES, ACTIONS,
  CONFIRMS, costRow, LOGISTICS };
