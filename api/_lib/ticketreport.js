// Build the Service Ticket Report: one PDF covering a ticket's whole life.
//
// WHY THIS IS ON THE SERVER
//
// Two reasons, and the second is the one that matters. The app's Content-Security-Policy is
// `script-src 'self'`, so a PDF library from a CDN cannot load at all. And a report assembled
// in the browser would be assembled from whatever the browser happened to be holding —
// including fields the signed-in role is not allowed to read. Here the data is read through
// the same permission rules as everything else, and the page only receives the finished file.
//
// pdf-lib rather than the hand-rolled writer in sitereport.js: that one sets Helvetica at one
// size and nothing else, which is fine for a list of values and hopeless for tables that have
// to paginate with their headings.

'use strict';

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const A4 = { w: 595.28, h: 841.89 };
const M = 42;                          // page margin
const CW = A4.w - 2 * M;               // content width

const INK = rgb(0.05, 0.06, 0.08);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.78, 0.80, 0.84);
const ACCENT = rgb(0.94, 0.65, 0);
const BAD = rgb(0.84, 0.18, 0.18);

// One place for the company's details. The registration number has not been supplied, so it
// is printed only when it is filled in — never invented, and never shown as a placeholder.
const CO = Object.freeze({
  name: 'TAGEX ENERGY (PTY) Ltd',
  // As the delivery note prints it, which the business confirmed is the correct address. It was
  // "Heidelberg Street, Tulisa Park, Alberton" here, and the forms disagreed with the delivery note.
  addr: '412 Heidelberg Road, Tulisa Park, JHB 2197',
  vat: '4550259271',
  reg: '',
});

const SAST_MS = 2 * 60 * 60 * 1000;

/** A UTC instant as SAST wall clock. Everything printed here is SAST; nothing is browser-local. */
function sast(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return new Date(d.getTime() + SAST_MS);
}

const p2 = (n) => String(n).padStart(2, '0');

function fmtDate(iso) {
  const d = sast(iso);
  return d ? `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}` : '';
}
function fmtTime(iso) {
  const d = sast(iso);
  return d ? `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` : '';
}
function fmtDateTime(iso) {
  const d = sast(iso);
  return d ? `${fmtDate(iso)} ${fmtTime(iso)}` : '';
}
function stamp(iso) {
  const d = sast(iso);
  return d ? `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}` : '';
}

/**
 * Airtable gives back strings, numbers, {name}, arrays of either, and lookups that are arrays
 * of one. Flatten all of it to something printable, and never print "[object Object]".
 */
function str(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(', ');
  if (typeof v === 'object' && v.name) return String(v.name);
  return '';
}

/**
 * Wrap to a width in points. Long text is never truncated — a 400-word description runs on to
 * as many pages as it needs, because a report that quietly drops half a fault description is
 * worse than no report.
 */
function wrap(text, font, size, maxW) {
  const out = [];
  for (const para of String(text == null ? '' : text).split(/\r?\n/)) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(next, size) <= maxW) { line = next; continue; }
      if (line) out.push(line);
      // A single word longer than the line (a long stock code, a URL) is broken by character
      // rather than allowed to run off the page.
      if (font.widthOfTextAtSize(word, size) > maxW) {
        let chunk = '';
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) > maxW) { out.push(chunk); chunk = ch; }
          else chunk += ch;
        }
        line = chunk;
      } else line = word;
    }
    out.push(line);
  }
  return out;
}

// The characters WinAnsi has that Latin-1 does not: the dashes, curly quotes, the ellipsis and
// the bullet. They matter -- the footer, the outstanding banner and half the app's own wording
// use an em dash, and stripping it turned "OUTSTANDING - NOT YET RESOLVED" into two words with
// a gap between them.
const WINANSI_EXTRA = new Set([
  0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x017D, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122,
  0x0161, 0x203A, 0x0153, 0x017E, 0x0178,
]);

/**
 * Drop only what WinAnsi genuinely cannot carry, so one stray character out of Airtable
 * cannot fail a whole report -- and nothing legitimate is quietly mangled on the way.
 */
function safe(v) {
  let out = '';
  for (const ch of String(v == null ? '' : v)) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13) { out += ' '; continue; }
    if (c >= 0x20 && c <= 0x7E) { out += ch; continue; }
    if (c >= 0xA0 && c <= 0xFF) { out += ch; continue; }
    if (WINANSI_EXTRA.has(c)) { out += ch; continue; }
    // Anything else becomes a space rather than vanishing, so words do not run together.
    out += ' ';
  }
  return out;
}

class Sheet {
  // The size is a parameter because the ticket LIST prints landscape: eight columns across a
  // portrait page left the subject two words wide.
  constructor(doc, fonts, size = A4) {
    this.doc = doc;
    this.W = size.w;
    this.H = size.h;
    this.cw = size.w - 2 * M;
    this.f = fonts;
    this.pages = [];
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([this.W, this.H]);
    this.pages.push(this.page);
    this.y = this.H - M;
    return this.page;
  }

  /** Reserve vertical space, starting a page when it will not fit. */
  need(h) {
    if (this.y - h < M + 28) this.newPage();
  }

  text(s, { size = 9, font = this.f.reg, colour = INK, x = M, gap = 2 } = {}) {
    this.need(size + gap);
    this.y -= size;
    this.page.drawText(safe(s), { x, y: this.y, size, font, color: colour });
    this.y -= gap;
  }

  para(s, { size = 9, font = this.f.reg, colour = INK, width = this.cw } = {}) {
    for (const line of wrap(safe(s), font, size, width)) {
      if (line === '') { this.y -= size * 0.6; continue; }
      this.text(line, { size, font, colour });
    }
  }

  heading(s) {
    this.need(22);
    this.y -= 14;
    this.page.drawText(safe(s.toUpperCase()), { x: M, y: this.y, size: 9, font: this.f.bold, color: ACCENT });
    this.y -= 5;
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: M + this.cw, y: this.y }, thickness: 0.7, color: RULE });
    this.y -= 8;
  }

  /** A label and its value on one line, the value wrapping under itself. */
  fact(label, value) {
    const v = str(value);
    if (!v) return;                    // an empty row says nothing; leave it out
    const labelW = 120;
    const lines = wrap(safe(v), this.f.reg, 9, this.cw - labelW);
    this.need(lines.length * 11);
    this.y -= 9;
    this.page.drawText(safe(label), { x: M, y: this.y, size: 9, font: this.f.bold, color: MUTED });
    lines.forEach((line, i) => {
      if (i) { this.need(11); this.y -= 11; }
      this.page.drawText(line, { x: M + labelW, y: this.y, size: 9, font: this.f.reg, color: INK });
    });
    this.y -= 3;
  }

  /**
   * A table that repeats its heading on every page it runs onto, and never splits a row
   * across the break.
   */
  table(cols, rows) {
    const widths = cols.map((c) => c.w);
    const drawHead = () => {
      this.need(16);
      this.y -= 10;
      let x = M;
      cols.forEach((c, i) => {
        this.page.drawText(safe(c.head), { x, y: this.y, size: 8, font: this.f.bold, color: MUTED });
        x += widths[i];
      });
      this.y -= 3;
      this.page.drawLine({ start: { x: M, y: this.y }, end: { x: M + this.cw, y: this.y }, thickness: 0.5, color: RULE });
      this.y -= 2;
    };
    drawHead();

    for (const row of rows) {
      const cells = cols.map((c, i) => wrap(safe(str(row[c.key])), this.f.reg, 8, widths[i] - 6));
      const h = Math.max(...cells.map((c) => c.length)) * 10 + 4;
      if (this.y - h < M + 28) { this.newPage(); drawHead(); }
      const top = this.y;
      let x = M;
      cells.forEach((lines, i) => {
        lines.forEach((line, j) => {
          this.page.drawText(line, { x, y: top - 8 - j * 10, size: 8, font: this.f.reg, color: INK });
        });
        x += widths[i];
      });
      this.y = top - h;
      this.page.drawLine({ start: { x: M, y: this.y + 2 }, end: { x: M + this.cw, y: this.y + 2 }, thickness: 0.3, color: RULE });
    }
    this.y -= 4;
  }

  note(s) {
    this.text(s, { size: 8, colour: MUTED, gap: 3 });
  }
}

/** Company line, confidentiality and page numbers on every page, whatever its size. */
function footer(s, fonts) {
  const total = s.pages.length;
  s.pages.forEach((page, i) => {
    page.drawLine({ start: { x: M, y: M + 16 }, end: { x: M + s.cw, y: M + 16 }, thickness: 0.5, color: RULE });
    const left = `VAT: ${CO.vat}` + (CO.reg ? `  ·  Reg: ${CO.reg}` : '');
    page.drawText(safe(left), { x: M, y: M + 5, size: 7, font: fonts.reg, color: MUTED });
    const mid = `${CO.name} — CONFIDENTIAL`;
    const midW = fonts.reg.widthOfTextAtSize(mid, 7);
    page.drawText(safe(mid), { x: M + (s.cw - midW) / 2, y: M + 5, size: 7, font: fonts.reg, color: MUTED });
    const right = `Page ${i + 1} of ${total}`;
    const rightW = fonts.reg.widthOfTextAtSize(right, 7);
    page.drawText(right, { x: M + s.cw - rightW, y: M + 5, size: 7, font: fonts.reg, color: MUTED });
  });
}

/**
 * @param {object} d  { ticket, jobcard, visits[], spares[], activity[], generatedBy, generatedAt,
 *                      activityNote }
 * @returns {Promise<Buffer>}
 */
async function ticketReportPdf(d) {
  const doc = await PDFDocument.create();
  const fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const s = new Sheet(doc, fonts);
  const t = d.ticket || {};
  const jc = d.jobcard || {};
  const ref = str(t['Ticket Ref']) || '(no reference)';

  // ── header ───────────────────────────────────────────────────────────────
  s.page.drawText(safe(CO.name), { x: M, y: s.y - 13, size: 13, font: fonts.bold, color: INK });
  s.y -= 17;
  s.page.drawText(safe(CO.addr), { x: M, y: s.y - 9, size: 8, font: fonts.reg, color: MUTED });
  s.y -= 13;
  s.page.drawText('SERVICE TICKET REPORT', { x: M, y: s.y - 12, size: 12, font: fonts.bold, color: ACCENT });
  const refW = fonts.bold.widthOfTextAtSize(ref, 12);
  s.page.drawText(safe(ref), { x: M + CW - refW, y: s.y - 12, size: 12, font: fonts.bold, color: INK });
  s.y -= 17;
  s.page.drawLine({ start: { x: M, y: s.y }, end: { x: M + CW, y: s.y }, thickness: 1, color: ACCENT });
  s.y -= 4;
  s.note(`Generated ${fmtDateTime(d.generatedAt)} SAST by ${d.generatedBy || 'unknown'}`);

  // ── the ticket ───────────────────────────────────────────────────────────
  s.heading('Ticket');
  s.fact('Job card', jc['JC Reference']);
  s.fact('Job card title', jc.Title);
  // The ticket's Client link holds record ids, never a name: printed raw it read "rec…". A
  // ticket with no job card yet gets the name the endpoint looked up for it.
  s.fact('Client', str(jc['Client Name']) || d.clientName);
  s.fact('Site', jc['Site / Address']);
  s.fact('Reported via', t['Source Channel']);
  s.fact('Source detail', t['Source Detail']);
  s.fact('Reported by', t['Reported By']);
  s.fact('Reported at', t['Reported At'] ? fmtDateTime(t['Reported At']) + ' SAST' : '');
  s.fact('Fault category', t['Fault Category']);
  s.fact('Asset / inverter', t['Asset / Inverter']);
  s.fact('Error code', t['Error Code']);
  s.fact('Priority', t.Priority);
  s.fact('Status', t.Status);
  s.fact('Monitored by', t['Monitored By']);
  s.fact('Monitoring ends', t['Monitoring Ends']);
  // Only if the reader is allowed it: the caller strips what the role may not read, so its
  // absence here means exactly that.
  if ('Cost Recoverable' in t) s.fact('Cost recoverable', t['Cost Recoverable']);

  if (str(t.Subject)) {
    s.heading('Subject');
    s.para(t.Subject, { font: fonts.bold });
  }
  if (str(t.Description)) {
    s.heading('Description');
    s.para(t.Description);
  }

  // ── visits ───────────────────────────────────────────────────────────────
  s.heading('Site visits');
  const visits = d.visits || [];
  if (!visits.length) {
    s.note('No site visits have been booked against this ticket.');
  } else {
    s.table([
      { head: 'Date', key: 'date', w: 62 },
      { head: 'Time', key: 'time', w: 74 },
      { head: 'Type', key: 'type', w: 96 },
      { head: 'Technician', key: 'tech', w: 92 },
      { head: 'Status', key: 'status', w: 66 },
      { head: 'Notes', key: 'notes', w: CW - 62 - 74 - 96 - 92 - 66 },
    ], visits.map((v) => ({
      date: fmtDate(v.start),
      time: v.start ? `${fmtTime(v.start)}–${fmtTime(v.end) || '?'}` : '',
      type: v.type, tech: v.tech, status: v.status, notes: v.notes,
    })));
  }

  // ── spares ───────────────────────────────────────────────────────────────
  const spares = d.spares || [];
  if (spares.length) {
    s.heading('Spares');
    s.table([
      { head: 'Code', key: 'code', w: 110 },
      { head: 'Description', key: 'desc', w: CW - 110 - 54 - 54 - 76 },
      { head: 'Required', key: 'req', w: 54 },
      { head: 'Issued', key: 'issued', w: 54 },
      { head: 'Status', key: 'status', w: 76 },
    ], spares.map((x) => ({
      code: x.code, desc: x.desc,
      req: x.req == null ? '' : String(x.req),
      issued: x.issued == null ? '' : String(x.issued),
      status: x.status,
    })));
  }

  // ── activity ─────────────────────────────────────────────────────────────
  s.heading('Activity');
  const acts = d.activity || [];
  if (!acts.length) {
    s.note('Nothing has been logged against this ticket.');
  } else {
    for (const a of acts) {
      s.need(24);
      s.y -= 10;
      s.page.drawText(safe(`${fmtDateTime(a.at)}  ${str(a.type)}`), {
        x: M, y: s.y, size: 8, font: fonts.bold, color: MUTED,
      });
      s.y -= 2;
      s.para(a.note, { size: 8 });
      s.y -= 2;
    }
  }
  if (d.activityNote) s.note(d.activityNote);

  // ── resolution ───────────────────────────────────────────────────────────
  s.heading('Resolution');
  if (str(t['Resolution Summary'])) {
    s.para(t['Resolution Summary']);
    if (t['Closed At']) s.note(`Closed ${fmtDateTime(t['Closed At'])} SAST`);
  } else {
    s.need(20);
    s.y -= 14;
    s.page.drawText(safe('OUTSTANDING — NOT YET RESOLVED'), {
      x: M, y: s.y, size: 11, font: fonts.bold, color: BAD,
    });
    s.y -= 4;
  }

  // ── signatures ───────────────────────────────────────────────────────────
  s.heading('Sign-off');
  const cols = ['Technician', 'Client representative', 'Date'];
  const colW = CW / 3;
  s.need(46);
  s.y -= 34;
  cols.forEach((c, i) => {
    const x = M + i * colW;
    s.page.drawLine({ start: { x, y: s.y }, end: { x: x + colW - 16, y: s.y }, thickness: 0.7, color: RULE });
    s.page.drawText(safe(c), { x, y: s.y - 10, size: 8, font: fonts.reg, color: MUTED });
  });
  s.y -= 16;

  footer(s, fonts);

  return Buffer.from(await doc.save());
}

// ── the ticket LIST ─────────────────────────────────────────────────────────
//
// What the Tickets screen shows under one status chip, on paper. The statuses are the screen's
// own, copied here because the server decides what is printed: a list built from whatever the
// browser claimed was "Open" could be made to print anything. A test holds the two copies equal.

const TICKET_STATUSES = Object.freeze(['New', 'Assigned', 'In Progress', 'Awaiting Spares',
  'Awaiting Client', 'Visit Scheduled', 'Second Visit Required', 'Second Visit Scheduled',
  'Resolved', 'Monitoring', 'Closed', 'Cancelled']);
const OPEN_STATUSES = Object.freeze(TICKET_STATUSES.slice(0, 8));

const A4_LANDSCAPE = { w: A4.h, h: A4.w };
const DAY_MS = 24 * 60 * 60 * 1000;

/** The chip as a person would say it. */
const filterLabel = (f) => (f === 'OPEN' ? 'Open' : f === 'ALL' ? 'All' : f);

/** Whether a ticket belongs under a chip. A ticket with no status is New, as on screen. */
function inFilter(status, filter) {
  const st = str(status) || 'New';
  if (filter === 'ALL') return true;
  if (filter === 'OPEN') return OPEN_STATUSES.includes(st);
  return st === filter;
}

/**
 * How the printed list may be ordered, and how each order is described on the sheet.
 *
 * No sort named = ticket number, newest first: what the list printed before it could be sorted,
 * and the order the Tickets screen shows. Anything that cannot be ordered -- no reported date, no
 * technician -- goes to the END in both directions, so "ascending" never opens with a page of
 * blanks. Ties keep newest ticket first, so a technician's own tickets read latest at the top.
 */
const LIST_SORTS = Object.freeze({
  ref: { label: 'Ticket no.', asc: 'oldest first', desc: 'newest first' },
  date: { label: 'Date reported', asc: 'oldest first', desc: 'newest first' },
  tech: { label: 'Technician', asc: 'A–Z', desc: 'Z–A' },
  // The sheet is already split by region; sorting on it orders the sections themselves.
  region: { label: 'Region', asc: 'A–Z', desc: 'Z–A' },
});
const LIST_DIRS = Object.freeze(['asc', 'desc']);

/** The number in a ticket ref, for ordering: TKT-2026-0100 after TKT-2026-0099, and after 9999. */
const refKey = (ref) => (str(ref).match(/\d+/g) || []).map((n) => n.padStart(10, '0')).join('-');

/** A copy of rows in the order asked for. Rows are as listReport builds them, with tech. */
function sortRows(rows, sort, dir) {
  const by = LIST_SORTS[sort] ? sort : 'ref';
  const sign = dir === 'asc' ? 1 : -1;
  const newestFirst = (a, b) => refKey(b.ref).localeCompare(refKey(a.ref));
  const key = {
    ref: (r) => refKey(r.ref),
    date: (r) => { const t = Date.parse(r.reportedAt || ''); return isNaN(t) ? '' : String(t).padStart(15, '0'); },
    tech: (r) => str(r.tech).toLowerCase(),
    region: (r) => str(r.region).toLowerCase(),
  }[by];
  return rows.slice().sort((a, b) => {
    const ka = key(a); const kb = key(b);
    if (!ka !== !kb) return ka ? -1 : 1;           // the blank one last, whichever the direction
    const c = ka.localeCompare(kb);
    return c ? sign * c : newestFirst(a, b);
  });
}

/** "Sorted by: Technician, A–Z" -- printed under the title so the order of the sheet is not a guess. */
const sortLabel = (sort, dir) => {
  const s = LIST_SORTS[sort] || LIST_SORTS.ref;
  return `Sorted by: ${s.label}, ${dir === 'asc' ? s.asc : s.desc}`;
};

/** Whole days from reported to closed, or to now while it is still open. Blank when unknown. */
function daysOpen(reportedAt, closedAt, now) {
  const from = Date.parse(reportedAt || '');
  if (isNaN(from)) return '';
  const to = closedAt ? Date.parse(closedAt) : Date.parse(now);
  if (isNaN(to) || to < from) return '';
  return String(Math.floor((to - from) / DAY_MS));
}

/**
 * The ticket list ALWAYS prints on ONE landscape page: the text is set as large as the page allows
 * (up to MAX_PT) and shrinks only as far as the number of tickets forces it to. The print date is
 * large at the top right, so a sheet on a wall says at a glance how old it is.
 *
 * The tickets print in one section per region -- Gauteng, then Eastern Cape, then any whose job card
 * has no region yet -- each headed with its count and, when km are shown, how far was driven.
 *
 * @param {object} d { filter, search, sort?, dir?, rows[], showKm?, regions?, generatedBy, generatedAt }
 *   regions: the Region field's choices from Airtable, which set the order of the sections.
 *   rows: { ref, reportedAt, closedAt, client, jc, tech, subject, category, priority, status,
 *   region, km }, already in the order to print (sortRows); sort and dir only label it.
 *   km: the ticket's kilometres, the sum of its visits' (cancelled ones not counted); null if none.
 *   showKm: draw the Km column and the totals. It replaced Cost (Raymond, 29 Oct 2026). Off for a
 *   role that may not read site visits, so the column is not there at all rather than there and empty.
 * @returns {Promise<Buffer>}
 */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Thu 08 Oct 2026" in SAST: the month in words so nobody reads 08/10 as August. */
function bigDate(iso) {
  const t = Date.parse(iso || '');
  if (isNaN(t)) return '';
  const d = new Date(t + SAST_MS);
  return `${DAYS[d.getUTCDay()]} ${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Where a region-less ticket prints, and the order the sections print in. */
const NO_REGION = 'Region not set';
// Used only when the caller does not pass the Region field's choices from Airtable.
const REGIONS = Object.freeze(['Gauteng', 'Eastern Cape']);

/**
 * The row indices of each section, in print order: one per region that has tickets, in the order
 * the Region field lists its choices in Airtable -- or A–Z / Z–A when the list is sorted by region.
 * A region on a ticket that is not (or no longer) a choice still gets its section, after the
 * choices. "Region not set" is last either way, as a blank is in every other sort.
 *
 * @param {string[]} [choices] the Region field's options, as Airtable orders them
 */
function regionSections(rows, sort, dir, choices) {
  const known = (choices && choices.length ? choices : REGIONS).map(str);
  const seen = [...new Set(rows.map((r) => str(r.region)).filter(Boolean))];
  let names = known.concat(seen.filter((n) => !known.includes(n))).filter((n) => seen.includes(n));
  if (sort === 'region') names = names.slice().sort((a, b) => (dir === 'asc' ? 1 : -1) * a.localeCompare(b));
  const out = names.map((name) => ({ name, idx: [] }));
  const none = { name: NO_REGION, idx: [] };
  rows.forEach((r, i) => {
    const s = out.find((x) => x.name === str(r.region));
    (s || none).idx.push(i);
  });
  return none.idx.length ? out.concat([none]) : out;
}

/** "R 12 345.60" -- spaces between thousands. Blank when unknown. */
function fmtRand(n) {
  if (n == null || n === '' || !isFinite(Number(n))) return '';
  const [whole, cents] = Math.abs(Number(n)).toFixed(2).split('.');
  return (Number(n) < 0 ? '-R ' : 'R ') + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + '.' + cents;
}
/** "1 234.5" -- one decimal at most, spaces between thousands. Blank when unknown. */
function fmtKm(n) {
  if (n == null || n === '' || !isFinite(Number(n))) return '';
  const v = Math.round(Number(n) * 10) / 10;
  const [whole, dec] = Math.abs(v).toFixed(1).split('.');
  return (v < 0 ? '-' : '') + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (dec === '0' ? '' : '.' + dec);
}
const kmOf = (r) => (r.km == null || r.km === '' || !isFinite(Number(r.km)) ? 0 : Number(r.km));
const sumKm = (rows) => Math.round(rows.reduce((a, r) => a + kmOf(r), 0) * 10) / 10;

async function ticketListPdf(d) {
  const doc = await PDFDocument.create();
  const fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const LM = 28;                                   // tighter margin than the ticket report: one page has to hold it all
  const HEADER = 66;                               // company, title and the big date, down to the orange rule
  let W; let H; let cw; let page;                  // set once the orientation is chosen (see "fit")
  const rows = d.rows || [];
  const label = filterLabel(d.filter);
  const put = (t, x, y, size, font = fonts.reg, color = INK) => page.drawText(safe(t), { x, y, size, font, color });
  const right = (t, y, size, font = fonts.reg, color = INK) => put(t, LM + cw - font.widthOfTextAtSize(safe(t), size), y, size, font, color);

  const totalKm = d.showKm ? '    Total km: ' + fmtKm(sumKm(rows)) : '';
  const showing = 'Showing: ' + (d.filter === 'OPEN' ? 'Open tickets (' + OPEN_STATUSES.join(', ') + ')'
    : d.filter === 'ALL' ? 'All tickets, every status' : 'Tickets with status ' + label) + (d.search ? `    Search: "${d.search}"` : '')
    + '    ' + sortLabel(d.sort, d.dir) + totalKm;
  const present = TICKET_STATUSES.filter((st) => rows.some((r) => (str(r.status) || 'New') === st));
  const counts = present.map((st) => [st, String(rows.filter((r) => (str(r.status) || 'New') === st).length)]);

  // fixed: sized to their longest value so a ticket or job card number is never split; the rest wrap
  // and share what is left (p = share).
  const COLS = [
    { head: 'Ticket', key: 'ref', fixed: true, bold: true }, { head: 'Reported', key: 'rep', fixed: true }, { head: 'Days', key: 'days', fixed: true },
    { head: 'Client', key: 'client', p: 16 }, { head: 'Job card', key: 'jc', fixed: true },
    { head: 'Region', key: 'region', fixed: true }, { head: 'Technician', key: 'tech', p: 13 },
    { head: 'Subject', key: 'subject', p: 33 },
    { head: 'Category', key: 'category', p: 14 }, { head: 'Priority', key: 'priority', fixed: true }, { head: 'Status', key: 'status', p: 13 },
  ].concat(d.showKm ? [{ head: 'Km', key: 'km', fixed: true, right: true }] : []);
  const data = rows.map((r) => ({
    ref: r.ref, rep: fmtDate(r.reportedAt), days: daysOpen(r.reportedAt, r.closedAt, d.generatedAt),
    client: r.client, jc: r.jc, tech: str(r.tech) || '—', subject: r.subject, category: r.category,
    priority: str(r.priority) || 'Normal', status: str(r.status) || 'New',
    region: str(r.region) || '—', km: fmtKm(r.km) || '—',
  }));
  const sections = regionSections(rows, d.sort, d.dir, d.regions);
  // "GAUTENG  14 tickets  ·  412.5 km" over each section
  const sectionHead = (s) => {
    const n = `${s.idx.length} ticket${s.idx.length === 1 ? '' : 's'}`;
    return { name: s.name.toUpperCase(), rest: n + (d.showKm ? '  ·  ' + fmtKm(sumKm(s.idx.map((i) => rows[i]))) + ' km' : '') };
  };

  // status counts as chips, wrapped onto as many lines as they need at size sp
  const chipLines = (sp) => {
    const out = [[]]; let x = 0;
    for (const [st, c] of counts) {
      const w = fonts.reg.widthOfTextAtSize(safe(st), sp) + 4 + fonts.bold.widthOfTextAtSize(c, sp);
      if (x && x + w > cw) { out.push([]); x = 0; }
      out[out.length - 1].push([st, c]); x += w + sp * 2;
    }
    return counts.length ? out : [];
  };

  // ── fit: the largest size at which everything (summary, headings, every row) fits above the footer ──
  const bottom = LM + 26;                          // the footer line sits below this
  const MAX_PT = 12;
  const PAD = 7;
  const widthsAt = (pt) => {
    const fixed = COLS.map((c) => (c.fixed ? Math.max(fonts.bold.widthOfTextAtSize(c.head, pt),
      ...data.map((r) => (c.bold ? fonts.bold : fonts.reg).widthOfTextAtSize(safe(str(r[c.key])), pt))) + PAD : 0));
    const left = cw - fixed.reduce((a, b) => a + b, 0);
    const shares = COLS.reduce((a, c) => a + (c.p || 0), 0);
    return { ok: left >= cw * 0.4, w: COLS.map((c, i) => (c.fixed ? fixed[i] : (c.p / shares) * left)) };
  };
  let widths = null;
  const layout = (pt, oneLine) => {
    const lh = pt * 1.22;
    const fit = widthsAt(pt);
    if (!fit.ok) return { need: Infinity };      // numbers would crowd out the subject: go smaller
    widths = fit.w;
    // A name or status that has to be broken mid-word ("Mthemb / u") reads worse than smaller
    // text, so a size that would do that is passed over -- down to 6 pt, below which wrapping wins.
    if (!oneLine && pt > 6 && data.some((row) => COLS.some((c, i) => !c.fixed
      && safe(str(row[c.key])).split(/\s+/).some((w) => (c.bold ? fonts.bold : fonts.reg).widthOfTextAtSize(w, pt) > widths[i] - 5)))) {
      return { need: Infinity };
    }
    const cells = data.map((row) => COLS.map((c, i) => {
      const lines = wrap(safe(str(row[c.key])), c.bold ? fonts.bold : fonts.reg, pt, widths[i] - 5);
      if (!oneLine || lines.length <= 1) return lines;
      // last resort for very long lists: one line per ticket, the overflow cut with an ellipsis
      let t = lines[0];
      while (t && fonts.reg.widthOfTextAtSize(t + '…', pt) > widths[i] - 5) t = t.slice(0, -1);
      return [t + '…'];
    }));
    const rowH = cells.map((cs) => Math.max(1, ...cs.map((l) => l.length)) * lh + pt * 0.45);
    const sumPt = Math.min(pt, 11);
    const head = sumPt * 1.5 + chipLines(sumPt).length * sumPt * 1.5 + sumPt * 0.4;
    const perSection = pt * 2.1 + pt * 1.7;       // the region heading, then that section's column headings
    const body = data.length
      ? sections.reduce((a, s) => a + perSection + (s.idx.length ? s.idx.reduce((b, i) => b + rowH[i], 0) : pt * 1.6), 0)
      : pt * 1.7 + pt * 2;
    const need = head + body + 12;
    return { pt, lh, cells, rowH, sumPt, need, oneLine };
  };
  const search = () => {
    const avail = H - LM - HEADER - bottom;
    for (let pt = MAX_PT; pt >= 6; pt -= 0.25) { const t = layout(pt, false); if (t.need <= avail) return t; }
    for (let pt = 7; pt >= 2.5; pt -= 0.25) { const t = layout(pt, true); if (t.need <= avail || pt <= 2.5) return t; }
    return null;
  };
  // Landscape gives the subject room; a long list gets more rows down a portrait page. Take whichever
  // allows the larger text (landscape on a tie).
  let best = null;
  for (const size of [A4_LANDSCAPE, A4]) {
    W = size.w; H = size.h; cw = W - 2 * LM;
    const t = search();
    if (!best || t.pt > best.L.pt) best = { size, L: t };
  }
  W = best.size.w; H = best.size.h; cw = W - 2 * LM;
  const L = layout(best.L.pt, best.L.oneLine);     // leaves widths set for the size and page chosen
  page = doc.addPage([W, H]);

  // ── header: company and title on the left, the BIG print date on the right ──
  let y = H - LM;
  put(CO.name, LM, y - 15, 15, fonts.bold);
  put(CO.addr, LM, y - 28, 9, fonts.reg, MUTED);
  const title = 'SERVICE TICKETS — ' + label.toUpperCase();
  const n = `${rows.length} ticket${rows.length === 1 ? '' : 's'}`;
  const dateW = fonts.bold.widthOfTextAtSize(bigDate(d.generatedAt), 30);
  // the title gives way to the date on a narrow (portrait) page, never the other way round
  const ts = Math.min(17, 17 * (cw - dateW - 20) / fonts.bold.widthOfTextAtSize(safe(title + '    ' + n), 17));
  put(title, LM, y - 50, ts, fonts.bold, ACCENT);
  put(n, LM + fonts.bold.widthOfTextAtSize(safe(title), ts) + ts * 0.8, y - 50, ts, fonts.bold);
  right('PRINTED', y - 9, 9, fonts.bold, MUTED);
  right(bigDate(d.generatedAt), y - 40, 30, fonts.bold);
  right(`${fmtTime(d.generatedAt)} SAST  ·  ${d.generatedBy || 'unknown'}`, y - 54, 9, fonts.reg, MUTED);
  y -= 62;
  page.drawLine({ start: { x: LM, y }, end: { x: LM + cw, y }, thickness: 1.2, color: ACCENT });
  y -= 4;


  // ── summary: what is shown, and a count per status ──
  const sp = L.sumPt;
  y -= sp * 1.2;
  put(showing, LM, y, Math.min(sp, sp * cw / fonts.reg.widthOfTextAtSize(safe(showing), sp)), fonts.reg, MUTED);
  y -= sp * 0.3;
  for (const line of chipLines(sp)) {
    y -= sp * 1.5;
    let cx = LM;
    for (const [st, c] of line) {
      const w1 = fonts.reg.widthOfTextAtSize(safe(st), sp);
      put(st, cx, y, sp, fonts.reg, INK); put(c, cx + w1 + 4, y, sp, fonts.bold, ACCENT);
      cx += w1 + 4 + fonts.bold.widthOfTextAtSize(c, sp) + sp * 2;
    }
  }
  y -= sp * 0.4;

  // ── the table: one section per region, each with its own headings ──
  const pt = L.pt;
  const colHeads = () => {
    y -= pt * 1.3;
    let x = LM;
    COLS.forEach((c, i) => {
      if (c.right) put(c.head, x + widths[i] - 3 - fonts.bold.widthOfTextAtSize(c.head, pt), y, pt, fonts.bold, MUTED);
      else put(c.head, x, y, pt, fonts.bold, MUTED);
      x += widths[i];
    });
    y -= pt * 0.4;
    page.drawLine({ start: { x: LM, y }, end: { x: LM + cw, y }, thickness: 0.6, color: RULE });
  };
  const drawRow = (r) => {
    const top = y;
    let x = LM;
    L.cells[r].forEach((lines, i) => {
      const font = COLS[i].bold ? fonts.bold : fonts.reg;
      lines.forEach((line, j) => {
        const ly = top - pt * 1.05 - j * L.lh;
        if (COLS[i].right) put(line, x + widths[i] - 3 - font.widthOfTextAtSize(safe(line), pt), ly, pt, font);
        else put(line, x, ly, pt, font);
      });
      x += widths[i];
    });
    y = top - L.rowH[r];
    page.drawLine({ start: { x: LM, y: y + 1 }, end: { x: LM + cw, y: y + 1 }, thickness: 0.3, color: RULE });
  };
  if (!data.length) {
    colHeads();
    put('No tickets match.', LM, y - pt * 1.4, pt, fonts.reg, MUTED);
  } else {
    for (const s of sections) {
      const h = sectionHead(s);
      y -= pt * 2.1;
      const hs = pt * 1.15;
      put(h.name, LM, y + pt * 0.3, hs, fonts.bold, ACCENT);
      put(h.rest, LM + fonts.bold.widthOfTextAtSize(safe(h.name), hs) + hs, y + pt * 0.3, hs, fonts.bold, INK);
      colHeads();
      if (!s.idx.length) { y -= pt * 1.6; put('No tickets.', LM, y + pt * 0.45, pt, fonts.reg, MUTED); }
      s.idx.forEach(drawRow);
    }
  }

  // ── footer ──
  page.drawLine({ start: { x: LM, y: LM + 14 }, end: { x: LM + cw, y: LM + 14 }, thickness: 0.5, color: RULE });
  put('Days: from reported to closed, or to today while the ticket is still open.'
    + '  Region: from the ticket\'s job card; "' + NO_REGION + '" until one is chosen there.', LM, LM + 18, 7, fonts.reg, MUTED);
  put(`VAT: ${CO.vat}` + (CO.reg ? `  ·  Reg: ${CO.reg}` : ''), LM, LM + 4, 7, fonts.reg, MUTED);
  const mid = `${CO.name} — CONFIDENTIAL`;
  put(mid, LM + (cw - fonts.reg.widthOfTextAtSize(mid, 7)) / 2, LM + 4, 7, fonts.reg, MUTED);
  right('Page 1 of 1', LM + 4, 7, fonts.reg, MUTED);

  return Buffer.from(await doc.save());
}

const listFilename = (d) => `Tickets_${filterLabel(d.filter).replace(/[^A-Za-z0-9]+/g, '-')}_${stamp(d.generatedAt)}.pdf`;

/**
 * The same list as ticketListPdf, as an Excel workbook (Raymond, 29 Oct 2026: "export as excel
 * based on selection criteria"). The same rows, in the same order, under the same status, search
 * and sort, so the sheet and the printout never disagree. Dates are real dates and Days / Km real
 * numbers, so they sort and filter in Excel. A second sheet says what was selected, as the PDF's
 * header does. The Km column is there only when the PDF's is (showKm).
 *
 * The workbook carries more than the page can (Raymond, 29 Oct 2026: "who created ticket, when,
 * how, any notes or activity logs"): who raised each ticket and when, how it was reported, the
 * description, resolution, monitoring and contract; an Activity sheet with every log entry against
 * the tickets exported, and a Visits sheet with every visit. Each extra sheet is there only when
 * the caller sends it (d.activity, d.visits): the server leaves it out for a role that may not read
 * the activity log or site visits. Costs stay out, as on the printout.
 *
 * @param {object} d the payload ticketListPdf takes, plus activity[] and visits[] (or null)
 * @returns {Promise<Buffer>}
 */
async function ticketListXlsx(d) {
  const X = require('./xlsxwrite.js');
  const rows = d.rows || [];
  const showActivity = Array.isArray(d.activity);
  const columns = [
    { head: 'Ticket', key: 'ref', width: 16 }, { head: 'Reported', key: 'reportedAt', type: 'datetime', width: 17 },
    { head: 'Days open', key: 'days', type: 'int', width: 10 }, { head: 'Client', key: 'client', width: 28 },
    { head: 'Job card', key: 'jc', width: 24 }, { head: 'Region', key: 'region', width: 14 },
    { head: 'Technician', key: 'tech', width: 20 }, { head: 'Subject', key: 'subject', width: 48 },
    { head: 'Category', key: 'category', width: 22 }, { head: 'Priority', key: 'priority', width: 10 },
    { head: 'Status', key: 'status', width: 22 }, { head: 'Closed', key: 'closedAt', type: 'datetime', width: 17 },
  ].concat(d.showKm ? [{ head: 'Km', key: 'km', type: 'number', width: 9 }] : [])
    .concat([
      { head: 'Created', key: 'createdAt', type: 'datetime', width: 17 }, { head: 'Created by', key: 'createdBy', width: 28 },
      { head: 'Reported via', key: 'channel', width: 16 }, { head: 'Source detail', key: 'channelDetail', width: 24 },
      { head: 'Reported by', key: 'reportedBy', width: 22 }, { head: 'Asset / inverter', key: 'asset', width: 20 },
      { head: 'Error code', key: 'errorCode', width: 14 }, { head: 'Description', key: 'description', width: 60 },
      { head: 'Resolution', key: 'resolution', width: 60 }, { head: 'Monitored by', key: 'monBy', width: 18 },
      { head: 'Monitoring ends', key: 'monEnds', type: 'date', width: 14 }, { head: 'Contract', key: 'contract', width: 14 },
      { head: 'Visits', key: 'visitCount', type: 'int', width: 8 },
    ])
    .concat(showActivity ? [
      { head: 'Activity entries', key: 'activityCount', type: 'int', width: 10 },
      { head: 'Last activity', key: 'lastActivity', type: 'datetime', width: 17 },
    ] : []);
  const data = rows.map((r) => {
    const days = daysOpen(r.reportedAt, r.closedAt, d.generatedAt);
    return {
      ref: str(r.ref), reportedAt: r.reportedAt || '', days: days === '' ? '' : Number(days),
      client: str(r.client), jc: str(r.jc), region: str(r.region), tech: str(r.tech), subject: str(r.subject),
      category: str(r.category), priority: str(r.priority) || 'Normal', status: str(r.status) || 'New',
      closedAt: r.closedAt || '', km: r.km == null || r.km === '' ? '' : Number(r.km),
      createdAt: r.createdAt || '', createdBy: str(r.createdBy), channel: str(r.channel), channelDetail: str(r.channelDetail),
      reportedBy: str(r.reportedBy), asset: str(r.asset), errorCode: str(r.errorCode), description: str(r.description),
      resolution: str(r.resolution), monBy: str(r.monBy), monEnds: r.monEnds || '', contract: str(r.contract),
      visitCount: typeof r.visitCount === 'number' ? r.visitCount : '',
      activityCount: typeof r.activityCount === 'number' ? r.activityCount : '', lastActivity: r.lastActivity || '',
    };
  });
  const extra = [];
  if (showActivity) {
    extra.push({ name: 'Activity', columns: [
      { head: 'Ticket', key: 'ref', width: 16 }, { head: 'When', key: 'at', type: 'datetime', width: 17 },
      { head: 'Type', key: 'type', width: 24 }, { head: 'By', key: 'by', width: 24 }, { head: 'Entry', key: 'note', width: 100 },
    ], rows: d.activity.map((a) => ({ ref: str(a.ref), at: a.at || '', type: str(a.type), by: str(a.by), note: str(a.note) })) });
  }
  if (Array.isArray(d.visits)) {
    extra.push({ name: 'Visits', columns: [
      { head: 'Ticket', key: 'ref', width: 16 }, { head: 'Visit', key: 'visitId', width: 16 },
      { head: 'Start', key: 'start', type: 'datetime', width: 17 }, { head: 'End', key: 'end', type: 'datetime', width: 17 },
      { head: 'Type', key: 'type', width: 20 }, { head: 'Status', key: 'status', width: 14 },
      { head: 'Technician', key: 'tech', width: 22 },
    ].concat(d.showKm ? [{ head: 'Km', key: 'km', type: 'number', width: 9 }] : [])
      .concat([{ head: 'Notes', key: 'notes', width: 60 }, { head: 'Booked by', key: 'createdBy', width: 26 }]),
    rows: d.visits.map((v) => ({ ...v, km: v.km == null ? '' : v.km })) });
  }
  const about = [
    ['Showing', d.filter === 'OPEN' ? 'Open tickets (' + OPEN_STATUSES.join(', ') + ')'
      : d.filter === 'ALL' ? 'All tickets, every status' : 'Tickets with status ' + filterLabel(d.filter)],
    ['Search', d.search ? d.search : '(none)'],
    ['Sorted by', sortLabel(d.sort, d.dir).replace(/^Sorted by:\s*/, '')],
    ['Tickets', rows.length],
  ].concat(d.showKm ? [['Total km', sumKm(rows)]] : [])
    .concat([['Exported', fmtDateTime(d.generatedAt) + ' SAST'], ['Exported by', str(d.generatedBy)]]);
  return X.workbook([
    { name: 'Tickets', columns, rows: data },
    ...extra,
    { name: 'About', columns: [{ head: 'Selection', key: 'k', width: 16 }, { head: 'Value', key: 'v', width: 90 }],
      rows: about.map(([k, v]) => ({ k, v })), filter: false },
  ]);
}
const listXlsxFilename = (d) => listFilename(d).replace(/\.pdf$/, '.xlsx');

const reportFilename = (d) => {
  const ref = String((d.ticket && d.ticket['Ticket Ref']) || 'ticket').replace(/[^A-Za-z0-9-]/g, '');
  return `${ref}_Report_${stamp(d.generatedAt)}.pdf`;
};

module.exports = {
  ticketReportPdf, reportFilename, CO, wrap, fmtDateTime, fmtDate, str, safe,
  ticketListPdf, listFilename, ticketListXlsx, listXlsxFilename, inFilter, daysOpen, filterLabel, TICKET_STATUSES, OPEN_STATUSES,
  LIST_SORTS, LIST_DIRS, sortRows, sortLabel, regionSections, fmtRand, fmtKm, NO_REGION,
};
