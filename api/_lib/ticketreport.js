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

  para(s, { size = 9, font = this.f.reg, colour = INK, width = CW } = {}) {
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
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: M + CW, y: this.y }, thickness: 0.7, color: RULE });
    this.y -= 8;
  }

  /** A label and its value on one line, the value wrapping under itself. */
  fact(label, value) {
    const v = str(value);
    if (!v) return;                    // an empty row says nothing; leave it out
    const labelW = 120;
    const lines = wrap(safe(v), this.f.reg, 9, CW - labelW);
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
      this.page.drawLine({ start: { x: M, y: this.y }, end: { x: M + CW, y: this.y }, thickness: 0.5, color: RULE });
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
      this.page.drawLine({ start: { x: M, y: this.y + 2 }, end: { x: M + CW, y: this.y + 2 }, thickness: 0.3, color: RULE });
    }
    this.y -= 4;
  }

  note(s) {
    this.text(s, { size: 8, colour: MUTED, gap: 3 });
  }
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

  // ── footer on every page ─────────────────────────────────────────────────
  const total = s.pages.length;
  s.pages.forEach((page, i) => {
    page.drawLine({ start: { x: M, y: M + 16 }, end: { x: M + CW, y: M + 16 }, thickness: 0.5, color: RULE });
    const left = `VAT: ${CO.vat}` + (CO.reg ? `  ·  Reg: ${CO.reg}` : '');
    page.drawText(safe(left), { x: M, y: M + 5, size: 7, font: fonts.reg, color: MUTED });
    const mid = `${CO.name} — CONFIDENTIAL`;
    const midW = fonts.reg.widthOfTextAtSize(mid, 7);
    page.drawText(safe(mid), { x: M + (CW - midW) / 2, y: M + 5, size: 7, font: fonts.reg, color: MUTED });
    const right = `Page ${i + 1} of ${total}`;
    const rightW = fonts.reg.widthOfTextAtSize(right, 7);
    page.drawText(right, { x: M + CW - rightW, y: M + 5, size: 7, font: fonts.reg, color: MUTED });
  });

  return Buffer.from(await doc.save());
}

const reportFilename = (d) => {
  const ref = String((d.ticket && d.ticket['Ticket Ref']) || 'ticket').replace(/[^A-Za-z0-9-]/g, '');
  return `${ref}_Report_${stamp(d.generatedAt)}.pdf`;
};

module.exports = { ticketReportPdf, reportFilename, CO, wrap, fmtDateTime, fmtDate, str };
