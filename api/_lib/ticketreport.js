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
  addr: '412 Heidelberg Street, Tulisa Park, Alberton',
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
  s.fact('Client', t.Client && t.Client.length ? jc['Client Name'] || t.Client : jc['Client Name']);
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
  'Resolved', 'Closed', 'Cancelled']);
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

/** Whole days from reported to closed, or to now while it is still open. Blank when unknown. */
function daysOpen(reportedAt, closedAt, now) {
  const from = Date.parse(reportedAt || '');
  if (isNaN(from)) return '';
  const to = closedAt ? Date.parse(closedAt) : Date.parse(now);
  if (isNaN(to) || to < from) return '';
  return String(Math.floor((to - from) / DAY_MS));
}

/**
 * @param {object} d { filter, search, rows[], generatedBy, generatedAt }
 *   rows: { ref, reportedAt, closedAt, client, jc, subject, category, priority, status }
 * @returns {Promise<Buffer>}
 */
async function ticketListPdf(d) {
  const doc = await PDFDocument.create();
  const fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const s = new Sheet(doc, fonts, A4_LANDSCAPE);
  const rows = d.rows || [];
  const label = filterLabel(d.filter);

  s.page.drawText(safe(CO.name), { x: M, y: s.y - 13, size: 13, font: fonts.bold, color: INK });
  s.y -= 17;
  s.page.drawText(safe(CO.addr), { x: M, y: s.y - 9, size: 8, font: fonts.reg, color: MUTED });
  s.y -= 13;
  s.page.drawText(safe('SERVICE TICKETS — ' + label.toUpperCase()), { x: M, y: s.y - 12, size: 12, font: fonts.bold, color: ACCENT });
  const n = `${rows.length} ticket${rows.length === 1 ? '' : 's'}`;
  const nW = fonts.bold.widthOfTextAtSize(n, 12);
  s.page.drawText(n, { x: M + s.cw - nW, y: s.y - 12, size: 12, font: fonts.bold, color: INK });
  s.y -= 17;
  s.page.drawLine({ start: { x: M, y: s.y }, end: { x: M + s.cw, y: s.y }, thickness: 1, color: ACCENT });
  s.y -= 4;
  s.note(`Generated ${fmtDateTime(d.generatedAt)} SAST by ${d.generatedBy || 'unknown'}`);
  s.note('Showing: ' + (d.filter === 'OPEN' ? 'Open tickets (' + OPEN_STATUSES.join(', ') + ')'
    : d.filter === 'ALL' ? 'All tickets, every status' : 'Tickets with status ' + label));
  if (d.search) s.note(`Search: "${d.search}"`);

  // A count per status first, so the page answers "how many" before anyone reads a row.
  s.heading('By status');
  const present = TICKET_STATUSES.filter((st) => rows.some((r) => (str(r.status) || 'New') === st));
  if (!present.length) s.note('No tickets match.');
  else {
    s.table([
      { head: 'Status', key: 'st', w: 160 },
      { head: 'Tickets', key: 'n', w: 60 },
    ], present.map((st) => ({ st, n: String(rows.filter((r) => (str(r.status) || 'New') === st).length) })));
  }

  s.heading('Tickets');
  if (!rows.length) s.note('No tickets match.');
  else {
    const W = { ref: 70, rep: 56, days: 34, cli: 120, jc: 104, cat: 86, pri: 46, st: 82 };
    W.subj = s.cw - Object.values(W).reduce((a, b) => a + b, 0);
    s.table([
      { head: 'Ticket', key: 'ref', w: W.ref },
      { head: 'Reported', key: 'rep', w: W.rep },
      { head: 'Days', key: 'days', w: W.days },
      { head: 'Client', key: 'client', w: W.cli },
      { head: 'Job card', key: 'jc', w: W.jc },
      { head: 'Subject', key: 'subject', w: W.subj },
      { head: 'Category', key: 'category', w: W.cat },
      { head: 'Priority', key: 'priority', w: W.pri },
      { head: 'Status', key: 'status', w: W.st },
    ], rows.map((r) => ({
      ref: r.ref, rep: fmtDate(r.reportedAt), days: daysOpen(r.reportedAt, r.closedAt, d.generatedAt),
      client: r.client, jc: r.jc, subject: r.subject, category: r.category,
      priority: str(r.priority) || 'Normal', status: str(r.status) || 'New',
    })));
    s.note('Days: from reported to closed, or to today while the ticket is still open.');
  }

  footer(s, fonts);
  return Buffer.from(await doc.save());
}

const listFilename = (d) => `Tickets_${filterLabel(d.filter).replace(/[^A-Za-z0-9]+/g, '-')}_${stamp(d.generatedAt)}.pdf`;

const reportFilename = (d) => {
  const ref = String((d.ticket && d.ticket['Ticket Ref']) || 'ticket').replace(/[^A-Za-z0-9-]/g, '');
  return `${ref}_Report_${stamp(d.generatedAt)}.pdf`;
};

module.exports = {
  ticketReportPdf, reportFilename, CO, wrap, fmtDateTime, fmtDate, str,
  ticketListPdf, listFilename, inFilter, daysOpen, filterLabel, TICKET_STATUSES, OPEN_STATUSES,
};
