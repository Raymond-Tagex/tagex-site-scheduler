// The TAGEX job card, as the printed form.
//
// SOURCE: TAGEX JOB CARD TEMPLATE SEP2026.docx, the revision issued with the "Project Type" line,
// "Actual Date JC Created", the ADDITIONAL SITE NOTES grid and the per-trip / per-day cost lines.
// This reproduces that form -- the same sections in the same order, with the same wording -- and
// fills in whatever the record knows.
//
// WHY IT IS DRAWN RATHER THAN MAIL-MERGED. The .docx is a form to be written on: ruled lines,
// tick boxes, blank grids. Merging fields into a copy of it needs Word on a server. Drawing it
// with pdf-lib, which this app already uses for the ticket report, gives the same sheet with the
// known values already on it and a ruled line everywhere else -- which is what somebody carrying
// it to site actually needs.
//
// WHAT IS FILLED AND WHAT IS LEFT BLANK
//
// Filled:  everything on the Job Cards record, the Costing detail behind the four logistics
//          blocks, the Summary of Costs grid, and the visit grids from Site Visits.
// Blank:   anything the record has no field for -- "Number of hrs" under Labour is the one line
//          of the template with nowhere to come from. It prints as a ruled line for a pen.
//
// A TICK BOX IS A DRAWN RECTANGLE. U+2610 is not in WinAnsi, so text() would drop it -- and a
// form whose boxes silently vanish is worse than one with no boxes at all.
//
// EVERY STRING GOES THROUGH safe(). The standard fonts carry WinAnsi and nothing else; one emoji
// typed into a job card made pdf-lib throw and the whole form fail to build. Now that the form
// is built automatically when a job card is raised, that would be a failure on every save.

'use strict';

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { wrap, str, fmtDate, safe } = require('./ticketreport.js');

const A4 = { w: 595.28, h: 841.89 };
const M = 42;
const CW = A4.w - 2 * M;

const INK = rgb(0.08, 0.09, 0.11);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.72, 0.74, 0.78);
const BAND = rgb(0.93, 0.94, 0.96);
const ACCENT = rgb(0.16, 0.42, 0.28);
// The border round each logistics section. Darker than RULE, which is every ruled line on the
// sheet: a box drawn in the same grey as the writing lines inside it does not separate anything.
const BOX = rgb(0.30, 0.34, 0.40);
const BOX_PAD = 6;

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

// Entity Name is still a field, still asked for when a job card is raised, and still the
// screen's list -- the revised paper simply stopped printing it. Kept for the app's own lists.
const ENTITIES = ['Tagex Energy', 'Solax Energy', 'PPA', 'Alpine', 'Direct Purchase'];
const ACTIONS = ['Site Inspection', 'Installation', 'Maintenance', 'Decommissioning',
  'Testing & Commissioning', 'Warranty Work', 'Stock / Asset Allocation', 'Other'];
const CLASSES = ['Standard Operational Activity', 'Emergency / Critical Response'];
const CONFIRMS = ['Structural Integrity Visually Confirmed', 'Electrical Infrastructure Verified',
  'Access & Safety Clearance Confirmed', 'Client Requirements Confirmed',
  'Photographic Evidence Attached'];

// "Project Type" on the revised paper. There is no field by that name: it is the commercial
// arrangement, which is Owner Category -- except Alpine, which Owner Category has no option for
// and Entity Name does. So Owner Category decides, and Entity Name is read only when Owner
// Category says nothing. Never both: two ticks on a one-answer line is a form nobody can trust.
const PROJECT_TYPES = ['Direct Purchase', 'PPA', 'Alpine', 'SUB'];
const OWNER_TO_TYPE = Object.freeze({
  'DIRECT-PURC': 'Direct Purchase', PPA: 'PPA', 'SUB-RES': 'SUB', 'SUB-C&I': 'SUB',
});
function projectType(f) {
  const own = OWNER_TO_TYPE[str((f || {})['Owner Category'])];
  if (own) return own;
  const ent = str((f || {})['Entity Name']);
  return PROJECT_TYPES.includes(ent) ? ent : '';
}

// The form's Summary of Costs, against the Costing table's columns, in the paper's order.
//
// CONSUMABLES IS MATERIAL COST. The previous revision of the paper had no row for it, so a
// "Materials" row was added here because Costing's Total counts Material Cost and a grid whose
// column did not add up was worse than an extra row. The revised paper added "Consumables" in
// that slot, so the extra row is now the paper's own.
const COST_ROWS = [
  ['Capital Goods', 'Capital Cost'],
  ['DC Equipment', 'DC Cost'],
  ['AC Equipment', 'AC Cost'],
  ['Consumables', 'Material Cost'],
  ['Travelling', 'Transport Cost'],
  ['Accommodation', 'Accommodation Cost'],
  ['Labour', 'Labour Cost'],
  ['Equipment Rental', 'Rental Cost'],
  ['Unforseen items', 'Other Cost'],
];

const has = (n) => n !== null && n !== undefined && n !== '';
const num = (n) => (has(n) && isFinite(Number(n)) ? Number(n) : null);

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
  const total = has(own) ? Number(own)
    : ((has(wh) || has(sup)) ? Number(wh || 0) + Number(sup || 0) : null);
  return { wh, sup, total };
}

const list = (v) => (Array.isArray(v) ? v.map((x) => ((x && x.name) || x)).filter(Boolean) : (v ? [str(v)] : []));
const money = (n) => (num(n) === null ? '' : 'R ' + Number(n).toFixed(2));
const qty = (n) => (num(n) === null ? '' : String(Number(n)));

/** The per-km rate. "Fuel Cost Inclusive Wear&Tear" on the paper is the inclusive rate. */
function kmRate(c) {
  const incl = num(c['Inclusive Rate per km']);
  return incl !== null ? incl : num(c['Fuel Rate per km']);
}
function rateText(c) {
  const incl = num(c['Inclusive Rate per km']);
  const fuel = num(c['Fuel Rate per km']);
  if (incl !== null) {
    return money(incl) + '/km' + (fuel !== null && fuel !== incl ? ' (fuel only ' + money(fuel) + '/km)' : '');
  }
  return fuel !== null ? money(fuel) + '/km (fuel only)' : '';
}

/**
 * A trip's cost: its kilometres at the inclusive rate. The paper asks for Rand; Costing holds the
 * distance, so the cost is worked out and the distance printed beside it, where anybody checking
 * the sum can see what it was worked from. With no rate, the distance alone is printed.
 */
const trip = (kmKey) => (c) => {
  const km = num(c[kmKey]);
  if (km === null) return '';
  const r = kmRate(c);
  return r === null ? km + ' km' : money(km * r) + ' (' + km + ' km)';
};

/** Day n of labour: the day rate, where the job card runs to that many days. */
const labourDay = (n) => (c) => {
  const per = num(c['Labour Cost per Day']);
  if (per === null) return '';
  const days = num(c['Labour Days']);
  if (days === null ? n > 1 : days < n) return '';
  return money(per);
};

const val = (key, fmt = str) => (c) => fmt(c[key]);

/**
 * The four logistics blocks of the form, against the Costing table's columns, laid out line by
 * line as the paper lays them out.
 *
 * A line is a list of cells. A cell is { l: label, k: [fields it reads], v: value-from-costing,
 * pre/sfx: what the paper prints either side of the blank } or { l, yes: checkbox field }.
 *
 * One list, used to lay the blocks out and to check them, so a field cannot be added to the
 * table and silently never printed.
 */
const LOGISTICS = [
  {
    name: 'Transportation Details', required: 'Travel Required',
    approved: 'Travel Approved by Management', total: 'Transport Cost',
    totalLabel: 'Total Travel Cost:',
    lines: [
      [{ l: 'Travel Required:', yes: 'Travel Required', w: 0.36 },
        { l: 'Fuel Cost Inclusive Wear&Tear =', k: ['Inclusive Rate per km', 'Fuel Rate per km'],
          v: rateText, pre: 'R', sfx: '/km', w: 0.64 }],
      [{ l: 'Vehicle Allocation:', k: ['Vehicle Allocation'], v: val('Vehicle Allocation') },
        { l: 'Distance to Site (km):', k: ['Distance to Site (km)'], v: val('Distance to Site (km)', qty) },
        { l: 'Total Km:', k: ['Total Km'], v: val('Total Km', qty) }],
      [{ l: 'Driver Name:', k: ['Driver Name'], v: val('Driver Name') },
        { l: 'Toll Fees:', yes: 'Toll Fees Required' },
        { l: 'Toll Fees:', k: ['Toll Fees'], v: val('Toll Fees', money), pre: 'R' }],
      [{ l: 'Site Visit Cost:', k: ['Site Visit Km'], v: trip('Site Visit Km'), pre: 'R' },
        { l: 'Trip 2 Cost:', k: ['Trip 2 Km'], v: trip('Trip 2 Km'), pre: 'R' },
        { l: 'Trip 3 Cost:', k: ['Trip 3 Km'], v: trip('Trip 3 Km'), pre: 'R' }],
    ],
  },
  {
    name: 'Accommodation Details', required: 'Accommodation Required',
    approved: 'Accommodation Approved by Management', total: 'Accommodation Cost',
    totalLabel: 'Total Accommodation Cost:',
    lines: [
      [{ l: 'Accommodation Required:', yes: 'Accommodation Required' }],
      [{ l: 'Location / Establishment Name:', k: ['Accommodation Establishment'],
        v: val('Accommodation Establishment') }],
      [{ l: 'Number of Personnel:', k: ['Accommodation Personnel'], v: val('Accommodation Personnel', qty) },
        { l: 'From Date:', k: ['Accommodation From'], v: val('Accommodation From', fmtDate) },
        { l: 'To Date:', k: ['Accommodation To'], v: val('Accommodation To', fmtDate) }],
      [{ l: 'Number of Nights:', k: ['Accommodation Nights'], v: val('Accommodation Nights', qty) },
        { l: 'Cost per Night:', k: ['Accommodation Cost per Night'],
          v: val('Accommodation Cost per Night', money), pre: 'R' }],
    ],
  },
  {
    name: 'Labour Details', required: 'Labour Required',
    approved: 'Labour Approved by Management', total: 'Labour Cost', totalLabel: 'Total Cost:',
    lines: [
      [{ l: 'Labour Required:', yes: 'Labour Required' }],
      // "Number of hrs" has no field behind it; it is a line for a pen. Number of days is not on
      // the paper, but the Day 2 / Day 3 costs below are read from it, so it is shown.
      [{ l: 'Location / Establishment Name:', k: ['Labour Location'], v: val('Labour Location'), w: 0.5 },
        { l: 'Number of hrs:', k: [], v: () => '', w: 0.25 },
        { l: 'Number of days:', k: ['Labour Days'], v: val('Labour Days', qty), w: 0.25 }],
      'staff',
      [{ l: 'Site Visit Cost:', k: ['Labour Cost per Day'], v: labourDay(1), pre: 'R' },
        { l: 'Day 2 Cost:', k: ['Labour Days'], v: labourDay(2), pre: 'R' },
        { l: 'Day 3 Cost:', k: ['Labour Days'], v: labourDay(3), pre: 'R' }],
    ],
  },
  {
    name: 'Rental Details', required: 'Rental Required',
    approved: 'Rental Approved by Management', total: 'Rental Cost', totalLabel: 'Total Cost:',
    lines: [
      [{ l: 'Rental Required:', yes: 'Rental Required' }],
      [{ l: 'Location / Establishment Name:', k: ['Rental Location'], v: val('Rental Location') }],
      [{ l: 'Equipment (Attached quotes):', k: ['Rental Equipment'], v: val('Rental Equipment') }],
      [{ l: 'Number of days:', k: ['Rental Days'], v: val('Rental Days', qty) }],
      [{ l: 'Fixed Cost:', k: ['Rental Fixed Cost'], v: val('Rental Fixed Cost', money), pre: 'R' },
        { l: 'Cost per day:', k: ['Rental Cost per Day'], v: val('Rental Cost per Day', money), pre: 'R' }],
    ],
  },
];
const STAFF_SLOTS = 8;

/** Every Costing field the four blocks print, for the drift check in the test suite. */
function logisticsKeys() {
  const out = new Set();
  LOGISTICS.forEach((b) => {
    out.add(b.required); out.add(b.approved);
    b.lines.forEach((line) => {
      if (line === 'staff') { out.add('Staff Names'); return; }
      line.forEach((cell) => { if (cell.yes) out.add(cell.yes); (cell.k || []).forEach((k) => out.add(k)); });
    });
  });
  return out;
}

/** A multi-line value made printable, keeping its line breaks for wrap() to honour. */
const safeLines = (v) => String(v == null ? '' : v).split(/\r?\n/).map(safe).join('\n');

class Form {
  constructor(doc, fonts) {
    this.doc = doc;
    this.f = fonts;
    this.pages = [];
    this.boxes = [];                           // where boxed() drew, for the test suite
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
    if (x2 <= x1) return;
    this.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: th, color: c });
  }

  width(s, size, font = this.f.reg) { return font.widthOfTextAtSize(safe(str(s)), size); }

  write(s, x, y, size = 9, font = this.f.reg, colour = INK) {
    this.page.drawText(safe(str(s)), { x, y, size, font, color: colour });
  }

  /** As much of a value as fits in a width, with an ellipsis where it was cut. */
  fit(s, size, font, maxW) {
    const rows = wrap(safe(str(s)), font, size, Math.max(maxW, 10));
    return rows.length > 1 ? (wrap(rows[0] + ' …', font, size, maxW)[0] || rows[0]) : (rows[0] || '');
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
    return s + 8 + this.width(label, size);
  }

  /**
   * A row of tick boxes, wrapping onto further lines when it runs out of width. With a label,
   * the boxes start on the label's own line, as the paper prints them.
   *
   * options are plain values, or [value, printed text] where the paper words it differently.
   */
  ticks(options, chosen, opts = {}) {
    const size = opts.size || 8.5;
    const on = new Set(list(chosen).map((c) => String(c)));
    this.need(14);
    this.y -= opts.label ? 13 : 11;
    let x = M;
    if (opts.label) {
      this.write(opts.label, M, this.y, size, this.f.bold);
      x = M + this.width(opts.label, size, this.f.bold) + 10;
    }
    options.forEach((o) => {
      const [v, t] = Array.isArray(o) ? o : [o, o];
      const w = 8 + 4 + this.width(t, size) + 14;
      if (x + w > M + CW) { this.need(13); this.y -= 12; x = M + (opts.label ? 12 : 0); }
      this.tick(x, this.y, t, on.has(v), size);
      x += w;
    });
    this.y -= 5;
  }

  // A heading is kept with room for the lines under it: one stranded at the foot of a page,
  // with its section on the next, reads as a section with nothing in it.
  heading(s) {
    this.need(64);
    this.y -= 20;
    this.rect(M, this.y - 3, CW, 15, { fill: BAND, bw: 0 });
    this.write(String(s).toUpperCase(), M + 5, this.y + 1.5, 8.5, this.f.bold, ACCENT);
    this.y -= 7;
  }

  /** A small grey instruction line, as the paper prints its italic prompts. */
  note(s) {
    this.need(48);                             // with the first lines of what it introduces
    this.y -= 12;
    this.write(s, M, this.y, 8, this.f.reg, MUTED);
  }

  /**
   * One labelled blank inside a line: the value, or a ruled line to write one on.
   *
   * The ruled line is the point: this is a form. A row that simply vanished when the field was
   * empty would leave somebody on site with nowhere to write the answer.
   */
  cell(x, w, cell, value) {
    const size = 8.5;
    this.write(cell.l, x, this.y, size, this.f.bold);
    if (cell.only) return;
    let lx = x + this.width(cell.l, size, this.f.bold) + 4;
    const end = x + w - 8;
    const v = str(value);
    if (v) { this.write(this.fit(v, size, this.f.reg, end - lx), lx, this.y, size); return; }
    if (cell.pre) { this.write(cell.pre, lx, this.y, size); lx += this.width(cell.pre, size) + 3; }
    const sw = cell.sfx ? this.width(cell.sfx, size) + 2 : 0;
    this.line(lx, this.y - 1.5, end - sw, this.y - 1.5);
    if (cell.sfx) this.write(cell.sfx, end - sw + 2, this.y, size);
  }

  /**
   * Draw a section inside a border, as one piece on one page.
   *
   * The height is worked out before drawing so the whole section can be moved to a new page
   * first: a box split over two pages would lose its top or bottom edge, and with it the thing
   * that tells one section from the next. Every box is the same width, just outside the text
   * margin, so the sections line up down the sheet.
   *
   * @param {number} h      the height the section's contents will take
   * @param {Function} draw draws the contents, from the current line down
   */
  boxed(h, draw) {
    this.need(h + 2 * BOX_PAD + 6);
    this.y -= 6;
    const top = this.y;
    const page = this.page;
    draw();
    this.y -= BOX_PAD + 2;
    // The estimate is generous, so this cannot happen -- and if it ever did, an unclosed box on
    // two pages would be worse than none, so none is drawn.
    if (this.page === page) {
      this.rect(M - BOX_PAD, this.y, CW + 2 * BOX_PAD, top - this.y, { bc: BOX, bw: 1 });
      this.boxes.push({ page: this.pages.length - 1, x: M - BOX_PAD, y: this.y,
        w: CW + 2 * BOX_PAD, h: top - this.y });
    }
  }

  /** A Yes / No pair beside a label. Returns nothing; draws on the current line. */
  yesNo(x, label, on) {
    this.write(label, x, this.y, 8.5, this.f.bold);
    let tx = x + this.width(label, 8.5, this.f.bold) + 8;
    tx += this.tick(tx, this.y, 'Yes', !!on, 8) + 8;
    // "No" is never ticked from the record. Airtable drops an unchecked box entirely, so a false
    // and an unanswered one look the same -- and a ticked No would put a refusal on paper that
    // nobody actually gave. It is there to be ticked by hand.
    this.tick(tx, this.y, 'No', false, 8);
  }

  /** Several cells across one line, the way the paper runs its blanks together. */
  row(cells, values) {
    this.need(16);
    this.y -= 14;
    const fixed = cells.reduce((a, c) => a + (c.w || 0), 0);
    const free = cells.filter((c) => !c.w).length;
    const share = free ? (1 - fixed) / free : 0;
    let x = M;
    cells.forEach((c, i) => {
      const w = CW * (c.w || share);
      if (c.yes !== undefined) this.yesNo(x, c.l, values[i]);
      else this.cell(x, w, c, values[i]);
      x += w;
    });
  }

  /** A label and its value across the full width, wrapping a long value rather than losing it. */
  field(label, value) {
    const size = 8.5;
    const v = str(value);
    this.need(16);
    this.y -= 14;
    if (!v) { this.cell(M, CW, { l: label }, ''); return; }
    const lw = this.width(label, size, this.f.bold) + 4;
    this.write(label, M, this.y, size, this.f.bold);
    wrap(safeLines(v), this.f.reg, size, CW - lw - 8).forEach((r, i) => {
      if (i) { this.need(12); this.y -= 11; }
      this.write(r, M + lw, this.y, size);
    });
  }

  /** Two fields side by side, the way the form pairs them. */
  pair(l1, v1, l2, v2) {
    this.row([{ l: l1 }, { l: l2 }], [v1, v2]);
  }

  /** A block of text, or ruled lines to write one in. */
  block(value, lines = 3) {
    const v = str(value);
    const size = 8.5;
    if (v) {
      const rows = wrap(safeLines(v), this.f.reg, size, CW - 10);
      const h = rows.length * 11 + 6;
      this.need(h + 8);
      this.y -= 6;
      const top = this.y;
      this.rect(M, top - h, CW, h);
      let ty = top - 9;
      rows.forEach((r) => { this.write(r, M + 5, ty, size); ty -= 11; });
      this.y = top - h;
      return;
    }
    this.need(lines * 14 + 6);
    for (let i = 0; i < lines; i++) { this.y -= 14; this.line(M, this.y, M + CW, this.y); }
    this.y -= 4;
  }

  /**
   * A bordered grid whose heading repeats on every page it runs onto.
   *
   * A cell's text wraps and the row grows to hold it. A visit note cut off at the edge of its
   * column is information the record has and the sheet silently does not.
   *
   * opts.title  a band across the whole grid, as the paper heads its visit tables
   * opts.over   a row of spanning headings above the column headings ({ t, w })
   */
  grid(cols, rows, opts = {}) {
    const size = 8;
    const band = (cells) => {
      this.y -= 14;
      let x = M;
      cells.forEach((c) => {
        this.rect(x, this.y - 2, c.w, 14, { fill: BAND });
        if (c.t) this.write(c.t, x + 4, this.y + 2, size, this.f.bold);
        x += c.w;
      });
      this.y -= 2;
    };
    const head = () => {
      this.need(16 + (opts.title ? 16 : 0) + (opts.over ? 16 : 0));
      if (opts.title) band([{ t: opts.title, w: CW }]);
      if (opts.over) band(opts.over);
      band(cols);
    };
    head();
    rows.forEach((r) => {
      const cells = cols.map((c, i) => wrap(safeLines(str(r[i])), this.f.reg, size, c.w - 8));
      const lines = Math.max(1, ...cells.map((c) => c.length));
      const rowH = Math.max(opts.rowH || 15, lines * 10 + 5);
      if (this.y - rowH < M + 26) { this.newPage(); head(); }
      this.y -= rowH;
      let x = M;
      cols.forEach((c, i) => {
        this.rect(x, this.y, c.w, rowH);
        let ty = this.y + rowH - 10;
        cells[i].forEach((line) => {
          if (line) this.write(line, x + 4, ty, size, r.bold ? this.f.bold : this.f.reg);
          ty -= 10;
        });
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
    if (str(name)) this.write(this.fit(name, size, this.f.reg, nameW), lx, this.y, size);
    else this.line(lx, this.y - 1.5, lx + nameW, this.y - 1.5);
    this.write('Date:', lx + nameW + 14, this.y, size, this.f.bold);
    const dx = lx + nameW + 46;
    if (str(when)) this.write(fmtDate(when), dx, this.y, size);
    else this.line(dx, this.y - 1.5, M + CW, this.y - 1.5);
  }

  /** The form's title and the company line under it. */
  title(text) {
    this.y -= 22;
    this.write(text, A4.w / 2 - this.width(text, 17, this.f.bold) / 2, this.y, 17, this.f.bold, ACCENT);
    this.y -= 11;
    const co = CO.name + ' · ' + CO.addr;
    this.write(co, A4.w / 2 - this.width(co, 7) / 2, this.y, 7, this.f.reg, MUTED);
    this.y -= 4;
  }

  /** The Service Call-Out terms, verbatim, and the client's acceptance of them, on a new page. */
  terms(acceptance) {
    const a = acceptance || {};
    this.newPage();
    this.y -= 6;
    this.write('Service Call-Out Terms and Conditions', M, this.y, 11, this.f.bold, ACCENT);
    this.y -= 6;
    TERMS.forEach((clause) => {
      const isHead = /^\d+\. [A-Z]/.test(clause);
      const font = isHead ? this.f.bold : this.f.reg;
      const rows = wrap(clause, font, 7.5, CW);
      this.need(rows.length * 9.5 + (isHead ? 8 : 3));
      this.y -= isHead ? 12 : 5;
      rows.forEach((r) => { this.y -= 9.5; this.write(r, M, this.y, 7.5, font); });
    });

    this.heading('Client Acceptance of Terms and Conditions');
    wrap('By signing below, the client confirms that they have read, understood, and agree to be '
      + 'bound by the Service Call-Out Terms and Conditions outlined above. The client further '
      + 'acknowledges acceptance of all associated costs, responsibilities, and conditions as '
      + 'defined.', this.f.reg, 8, CW).forEach((r) => { this.need(11); this.y -= 11; this.write(r, M, this.y, 8); });
    this.y -= 4;

    this.field('Client Name:', a.name);
    this.field('Company (if applicable):', a.company);
    this.field('Contact Number:', a.contact);
    this.field('Email Address:', a.email);
    this.field('Client Signature:', '');
    this.field('Date:', fmtDate(a.date));
  }

  /** The reference, the print date and the page count, on every page. */
  footer(ref, generatedBy) {
    const stampText = ref + '  ·  printed ' + fmtDate(new Date().toISOString())
      + (generatedBy ? '  ·  ' + generatedBy : '');
    this.pages.forEach((p, i) => {
      p.drawLine({ start: { x: M, y: M - 8 }, end: { x: M + CW, y: M - 8 }, thickness: 0.6, color: RULE });
      p.drawText(safe(stampText), { x: M, y: M - 19, size: 6.5, font: this.f.reg, color: MUTED });
      const n = 'Page ' + (i + 1) + ' of ' + this.pages.length;
      p.drawText(n, { x: M + CW - this.width(n, 6.5), y: M - 19, size: 6.5,
        font: this.f.reg, color: MUTED });
    });
  }
}

/** A fresh document with the two fonts every form uses. */
async function newForm(titleMeta) {
  const doc = await PDFDocument.create();
  const fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  doc.setTitle(safe(titleMeta));
  return { doc, form: new Form(doc, fonts), fonts };
}

const padTo = (rows, n, width) => {
  const out = rows.slice();
  while (out.length < n) out.push(new Array(width).fill(''));
  return out;
};

/**
 * Whether a printed form carries anything beyond Internal: a cost figure, or the client's own
 * contact details from the acceptance block. Decides the Sensitivity the filed copy is given,
 * so a form with money on it is not handed to every role that may read Internal documents.
 */
function jobCardSensitivity(d) {
  const c = (d && d.costing) || {};
  const money = Object.values(c).some((v) => typeof v === 'number' && v !== 0);
  const f = (d && d.jobcard) || {};
  const personal = !!(str(f['Client Acceptance Contact']) || str(f['Client Acceptance Email']));
  return money || personal ? 'Confidential' : 'Internal';
}

/**
 * Draw the job card.
 *
 * @param {object} d  { jobcard, created, client, site, responsible, costing, visits, ticketRefs,
 *                      bomCount, generatedBy }
 * @returns {Promise<Uint8Array>}
 */
async function jobCardFormPdf(d) {
  const f = d.jobcard || {};
  const ref = str(f['JC Reference']);
  const { doc, form: s, fonts } = await newForm('TAGEX Job Card ' + ref);

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
    if (who) s.write(s.fit(who, 6.5, fonts.reg, cellW - 90), x + 76, s.y + 11, 6.5);
    else s.line(x + 76, s.y + 10, x + cellW - 12, s.y + 10);
    s.write('Date:', x + 6, s.y + 3, 6.5, fonts.reg, MUTED);
    const when = decision === word ? fmtDate(f['Director Decision Date']) : '';
    if (when) s.write(when, x + 30, s.y + 3, 6.5);
    else s.line(x + 30, s.y + 2, x + cellW - 12, s.y + 2);
  });
  s.y -= 6;

  s.title('JOB CARD');

  // ── identity ──────────────────────────────────────────────────────────────
  s.ticks(PROJECT_TYPES, projectType(f), { label: 'Project Type:' });
  s.field('Job Card Number:', ref);
  s.field('Ticket Number:', (d.ticketRefs || []).join(', '));
  s.field('Project Reference Number:', list(f['Generated Reference String (from Job Card References)']).join(', '));
  s.field('Client Name:', d.client);
  s.field('Site Address:', d.site);
  // "Issue Reported" is Issued Date -- the date typed in as "Actual date of issue" when the job
  // card is raised. "JC Created" is when the record was made, which nobody types.
  s.pair('Actual Date Issue Reported:', fmtDate(f['Issued Date']), 'Ticket Raised By:', f['Ticket Raised By']);
  s.field('Actual Date JC Created:', fmtDate(d.created));

  // ── pre-visit notes ───────────────────────────────────────────────────────
  s.heading('Pre-Visit Notes');
  s.ticks(ACTIONS, f['Suggested Site Actions'], { label: 'Suggested Site Actions:' });
  s.field('Other:', f['Suggested Site Actions — Other']);
  s.ticks([CLASSES[0], [CLASSES[1], CLASSES[1] + ' (Approval Required)']],
    f['Operational Classification'], { label: 'Operational Classification:' });
  // The revised paper has no lines for free notes here, but the job card has two fields that
  // somebody typed into when raising it. They are printed where they belong rather than lost --
  // and only when there is something in them, so a blank form stays the paper's own.
  if (str(f['Pre-Visit Notes'])) s.block(f['Pre-Visit Notes']);
  if (str(f['General Notes'])) { s.note('General Notes:'); s.block(f['General Notes']); }

  // ── the visits ────────────────────────────────────────────────────────────
  // The dated rows come from Site Visits, which is where the scheduler already writes them.
  // A visit still to come is pre-site; one that has happened is a finding.
  const visits = (d.visits || []).slice().sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const now = Date.now();
  const before = visits.filter((v) => !v.start || Date.parse(v.start) > now || v.status === 'Scheduled');
  const after = visits.filter((v) => before.indexOf(v) < 0);
  const desc = (v) => v.subject || v.notes || '';

  s.heading('Pre-Site Visit - Scope of Work');
  s.note('Provide a detailed description of work to be executed:');
  if (str(f['Pre-Site Scope of Work'])) s.block(f['Pre-Site Scope of Work']);
  s.grid([{ t: 'Date', w: 90 }, { t: 'Description', w: CW - 90 }],
    padTo(before.map((v) => [fmtDate(v.start), desc(v)]), 12, 2), { title: 'PRE-SITE VISIT' });

  s.heading('On-Site Inspection');
  s.pair('Site Inspection Conducted By:', f['Site Inspection Conducted By'],
    'Date of Inspection:', fmtDate(f['Date of Inspection']));
  s.ticks(CONFIRMS, f['Inspection Confirmations']);

  s.heading('Actual Site Visit - Findings');
  if (str(f['Actual Site Scope of Work'])) s.block(f['Actual Site Scope of Work']);
  s.grid([{ t: 'Date', w: 90 }, { t: 'Description', w: CW - 240 }, { t: 'Outcome', w: 150 }],
    padTo(after.map((v) => [fmtDate(v.start), desc(v), v.status || '']), 11, 3),
    { title: 'ACTUAL-SITE VISIT' });

  // A visit's own notes, where they were not already its description above.
  s.heading('Additional Site Notes on Work Done');
  s.grid([{ t: 'Date', w: 90 }, { t: 'Description', w: CW - 90 }],
    padTo(visits.filter((v) => v.subject && v.notes).map((v) => [fmtDate(v.start), v.notes]), 27, 2),
    { rowH: 14 });

  // ── stock, material and logistics ─────────────────────────────────────────
  const c = d.costing || {};
  s.heading('Stock, Material & Logistics Allocation');
  // The warehouse costing is the Warehouse column of Costing: if any of it is filled in, it is
  // attached to this job card in the only sense the record knows.
  const warehouse = COST_ROWS.some(([, k]) => (num(c[k + ' (Warehouse)']) || 0) !== 0);
  const attached = [['BOM Attached', !!d.bomCount],
    ['Supplier Quotes Attached', !!f['Supplier Quotes Attached']],
    ['Warehouse Costing Attached', warehouse]];
  const staffNames = str(c['Staff Names']).split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);

  // How tall a block will be, so boxed() can keep it on one page. Every row() and yesNo() line
  // is 14; a field whose value wraps adds 11 a line; the title takes 18.
  const blockHeight = (b) => 18 + 28 + b.lines.reduce((h, line) => {
    if (line !== 'staff') return h + 14;
    if (!staffNames.length) return h + 28;
    const lw = s.width('Staff Names:', 8.5, fonts.bold) + 4;
    return h + 14 + 11 * (wrap(safe(staffNames.join(', ')), fonts.reg, 8.5, CW - lw - 8).length - 1);
  }, 0);

  // Each block prints what was recorded against this job card, and a ruled line for anything
  // that was not -- the form is still something somebody writes on at site.
  const drawBlock = (b) => {
    s.y -= 18;
    s.write(b.name, M, s.y, 9, fonts.bold);
    b.lines.forEach((line) => {
      if (line === 'staff') {
        if (staffNames.length) { s.field('Staff Names:', staffNames.join(', ')); return; }
        // Eight blanks on two lines, as the paper has them.
        const blanks = new Array(STAFF_SLOTS / 2).fill({ l: '' });
        s.row([{ l: 'Staff Names:', w: 0.2, only: true }].concat(blanks), []);
        s.row([{ l: '', w: 0.2, only: true }].concat(blanks), []);
        return;
      }
      s.row(line, line.map((cell) => (cell.yes !== undefined ? c[cell.yes] : cell.v(c))));
    });
    s.row([{ l: b.totalLabel, pre: 'R' }], [money(costRow(c, b.total).total)]);
    s.row([{ l: 'Approved by Management:', yes: b.approved }], [c[b.approved]]);
  };

  // ONE BOX PER SECTION, so somebody filling it in can tell where Transportation ends and
  // Accommodation begins -- run together, the four read as one long list of blanks. The three
  // "attached" questions share the first box with Transportation, as the business marked it up.
  LOGISTICS.forEach((b, i) => {
    const lead = i === 0 ? attached.length * 14 : 0;
    s.boxed(lead + blockHeight(b), () => {
      if (i === 0) attached.forEach(([l, on]) => { s.y -= 14; s.yesNo(M, l, on); });
      drawBlock(b);
    });
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
  const total = ['TOTAL COST', money(sums.wh || null) || 'R', money(sums.sup || null) || 'R',
    money(sums.total || null) || 'R'];
  total.bold = true;
  costRows.push(total);
  s.grid(cols, costRows, { over: [{ t: '', w: w1 }, { t: 'Cost per Category', w: 200 }, { t: '', w: 100 }] });
  s.write('Each row’s total is the category figure where one is recorded, otherwise '
    + 'Warehouse plus Supplier. TOTAL COST is the sum of the rows above.',
    M, s.y - 8, 6.5, fonts.reg, MUTED);
  s.y -= 10;

  // ── people and dates ──────────────────────────────────────────────────────
  s.heading('Responsible Personnel');
  s.field('Project Manager:', d.responsible);
  s.field('Technician / Installer:', f['Technician / Installer']);

  s.heading('Timeline Control');
  s.field('Planned Start Date:', fmtDate(f['Started Project']));
  s.field('Site Visit Date:', fmtDate(f['Site Visit Date']));
  s.field('Actual Installation Date:', fmtDate(f['Actual Installation Date']));
  s.field('Actual Completion Date:', fmtDate(f['Completed Project']));
  s.note('Delay Explanation (if applicable):');
  s.block(f['Delay Explanation'], 2);

  s.heading('Signatures for Approvals');
  s.signature('Requested By:', f['Requested By'], f['Requested By Date']);
  s.signature('Procurement:', f['Procurement Approved By'], f['Procurement Approved Date']);
  s.signature('Operational / Executive Approval:', f['Operational Approved By'], f['Operational Approved Date']);
  s.signature('Financial Oversight Approval:', f['Financial Approved By'], f['Financial Approved Date']);
  s.signature('Final Completion Sign-Off:', f['Final Sign-Off By'], f['Final Sign-Off Date']);

  // ── terms, verbatim, and the client's acceptance ──────────────────────────
  s.terms({
    name: f['Client Acceptance Name'] || d.client,
    company: f['Client Acceptance Company'],
    contact: f['Client Acceptance Contact'],
    email: f['Client Acceptance Email'],
    date: f['Client Acceptance Date'],
  });

  s.footer(ref, d.generatedBy);
  const bytes = await doc.save();
  // Where the section boxes landed, for the test suite. Not part of the PDF.
  Object.defineProperty(bytes, 'boxes', { value: s.boxes, enumerable: false });
  return bytes;
}

/** "JC-OM-2026-0169-MAINT-TE-2026-09-30.pdf" — safe on every filesystem. */
function formFilename(ref) {
  const clean = String(ref || 'job-card').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return 'JC-' + clean + '-' + new Date().toISOString().slice(0, 10) + '.pdf';
}

module.exports = { jobCardFormPdf, formFilename, jobCardSensitivity, TERMS, COST_ROWS, ENTITIES,
  ACTIONS, CLASSES, CONFIRMS, PROJECT_TYPES, projectType, costRow, LOGISTICS, logisticsKeys,
  STAFF_SLOTS, Form, newForm, padTo, CO, A4, M, CW };
