#!/usr/bin/env node
// The Service Ticket Report, checked against the bytes it actually produces.
//
//   node test/verify-ticket-report.js
//
// It builds real PDFs and reads the text back out of their content streams, so what is proven
// is what would come off a printer: that a 400-word description survives whole, that a table
// repeats its heading when it runs onto a second page, that an unresolved ticket says so in
// as many words, and that nothing is drawn where the footer goes.

'use strict';

const zlib = require('zlib');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const R = require(path.join(__dirname, '..', 'api', '_lib', 'ticketreport.js'));

let pass = 0, fail = 0;
const failures = [];

function t(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  if (ok) pass++; else { fail++; failures.push(`${label}\n      expected ${e}\n      actual   ${a}`); }
  console.log(`  ${ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}`);
  return ok;
}

// ── reading a PDF back ──────────────────────────────────────────────────────
//
// pdf-lib writes strings as hex — <48656c6c6f> Tj — two hex digits per WinAnsi byte. Streams
// may be Flate-compressed, so try to inflate and fall back to raw.

// Cut each stream at its DECLARED /Length. Scanning ahead for "endstream" works until a
// compressed stream happens to contain those bytes, and then it silently truncates -- which
// is what made a row in the middle of a long table look like it had been dropped.
function streams(buf) {
  const out = [];
  const s = buf.toString('latin1');
  const re = /\/Length\s+(\d+)[^>]*>>\s*stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const len = parseInt(m[1], 10);
    const raw = Buffer.from(s.slice(start, start + len), 'latin1');
    let text;
    try { text = zlib.inflateSync(raw).toString('latin1'); }
    catch (e) { text = raw.toString('latin1'); }
    out.push(text);
    re.lastIndex = start + len;
  }
  return out;
}

/** How many pages the document really has, straight from the document. */
async function pageCount(buf) {
  const doc = await PDFDocument.load(buf);
  return doc.getPageCount();
}

// WinAnsi is Latin-1 EXCEPT for 0x80-0x9F, where it keeps the dashes, curly quotes and the
// rest. Decoding those as Latin-1 turns an em dash into a control character, which is why
// "OUTSTANDING \u2014 NOT YET RESOLVED" appeared to be missing from a page it was printed on.
const WINANSI_HIGH = {
  0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E', 0x85: '\u2026',
  0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02C6', 0x89: '\u2030', 0x8A: '\u0160',
  0x8B: '\u2039', 0x8C: '\u0152', 0x8E: '\u017D', 0x91: '\u2018', 0x92: '\u2019',
  0x93: '\u201C', 0x94: '\u201D', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02DC', 0x99: '\u2122', 0x9A: '\u0161', 0x9B: '\u203A', 0x9C: '\u0153',
  0x9E: '\u017E', 0x9F: '\u0178',
};
const winansi = (byte) => WINANSI_HIGH[byte] || String.fromCharCode(byte);

/** Every string drawn in a content stream, in the order it was drawn. */
function drawn(stream) {
  const out = [];
  const re = /<([0-9A-Fa-f]+)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  let m;
  while ((m = re.exec(stream))) {
    if (m[1]) {
      let s = '';
      for (let i = 0; i + 1 < m[1].length; i += 2) s += winansi(parseInt(m[1].substr(i, 2), 16));
      out.push(s);
    } else {
      out.push(m[2].replace(/\\([()\\])/g, '$1'));
    }
  }
  return out;
}

/** Every Td/Tm y coordinate a piece of text was placed at. */
function yPositions(stream) {
  const out = [];
  const re = /([\d.-]+)\s+([\d.-]+)\s+Td|1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/g;
  let m;
  while ((m = re.exec(stream))) out.push(parseFloat(m[2] !== undefined ? m[2] : m[4]));
  return out;
}

const pagesOf = (buf) => streams(buf).filter((s) => /Tj|re|l\s|m\s/.test(s));

/** The font size a given string was drawn at (each pdf-lib drawText is its own BT ... ET block). */
function fontSizeOfRef(buf, text) {
  const hex = Buffer.from(text, 'latin1').toString('hex').toUpperCase();
  for (const st of streams(buf)) {
    for (const block of st.split('ET')) {
      if (!block.toUpperCase().includes('<' + hex + '>') && !block.includes('(' + text + ')')) continue;
      const m = /([\d.]+)\s+Tf/.exec(block);
      if (m) return parseFloat(m[1]);
    }
  }
  return 0;
}

// ── fixtures ────────────────────────────────────────────────────────────────
const LONG = Array.from({ length: 420 }, (_, i) => 'word' + i).join(' ');

const base = () => ({
  ticket: {
    'Ticket Ref': 'TKT-2026-0042',
    Subject: 'Inverter offline since Tuesday',
    Description: 'Error 0x33 on the display.',
    'Source Channel': 'WhatsApp',
    'Source Detail': 'Oubaas 082 555 1234',
    'Reported By': 'Oubaas',
    'Reported At': '2026-09-24T06:00:00.000Z',
    'Fault Category': 'Inverter Fault',
    'Asset / Inverter': 'INV-2',
    'Error Code': '0x33',
    Priority: 'Urgent',
    Status: 'Awaiting Spares',
  },
  jobcard: {
    'JC Reference': 'OM-2026-0157/INST/TE',
    Title: 'Grootvlei — Site Commissioning',
    'Client Name': ['Grootvlei'],
    'Site / Address': ['Perseel H68, Loskop Noord'],
  },
  visits: [],
  spares: [],
  activity: [],
  activityNote: 'Entries linked to this ticket only. Visit entries recorded against the '
    + 'job card as a whole are not listed here.',
  generatedBy: 'raymond@tagexenergy.co.za',
  generatedAt: '2026-09-24T09:30:00.000Z',
});

(async () => {

console.log('\n\x1b[1mA TICKET WITH NOTHING ON IT YET\x1b[0m\n');
{
  const pdf = await R.ticketReportPdf(base());
  const text = pagesOf(pdf).map(drawn).flat().join('\n');

  t('it is a PDF', pdf.slice(0, 5).toString(), '%PDF-');
  t('the reference is on it', text.includes('TKT-2026-0042'), true);
  t('so is the company', text.includes('TAGEX ENERGY (PTY) Ltd'), true);
  t('and the address', text.includes('412 Heidelberg Road, Tulisa Park, JHB 2197'), true);
  t('and the VAT number', /VAT: 4550259271/.test(text), true);
  // The registration number has never been supplied. It must not be invented, and an empty
  // "Reg:" label is its own kind of lie.
  t('the registration number is not printed at all', /Reg:/.test(text), false);
  t('the job card is named', text.includes('OM-2026-0157/INST/TE'), true);
  t('the client is named', text.includes('Grootvlei'), true);
  t('reported-at is printed in SAST, not UTC', text.includes('24/09/2026 08:00'), true);
  t('an unresolved ticket says so, in as many words',
    text.includes('OUTSTANDING — NOT YET RESOLVED'), true);
  t('with no visits, it says so rather than showing an empty table',
    /No site visits have been booked/.test(text), true);
  t('the spares section is left out entirely when there are none',
    /Required\s*Issued/.test(text) || text.includes('SPARES'), false);
  t('there is somewhere to sign', text.includes('Client representative'), true);
  // Resolution Summary is empty on this ticket; its label must not appear at all.
  t('a field with nothing in it leaves no label behind', /Cost recoverable/i.test(text), false);
  const blank = base();
  delete blank.ticket['Error Code'];
  delete blank.ticket['Source Detail'];
  const blankText = pagesOf(await R.ticketReportPdf(blank)).map(drawn).flat().join('\n');
  t('and neither do the others', /Error code|Source detail/.test(blankText), false);
  t('while the ones that do have values are still there', /Asset \/ inverter/.test(blankText), true);
  t('and it is one page', /Page 1 of 1/.test(text), true);
}

console.log('\n\x1b[1mA FULL TICKET\x1b[0m\n');
{
  const d = base();
  d.visits = Array.from({ length: 3 }, (_, i) => ({
    start: `2026-09-2${i + 1}T06:00:00.000Z`, end: `2026-09-2${i + 1}T08:00:00.000Z`,
    type: i === 0 ? 'Fault Investigation' : 'Return Visit',
    tech: 'Evan Mokoena', status: 'Completed',
    notes: 'Checked the DC strings and the isolator.',
  }));
  d.spares = Array.from({ length: 12 }, (_, i) => ({
    code: 'KC3E-' + (100 + i), desc: 'A part with a reasonably long description ' + i,
    req: i + 1, issued: 0, status: 'Requested',
  }));
  d.activity = Array.from({ length: 4 }, (_, i) => ({
    at: `2026-09-2${i + 1}T06:05:00.000Z`, type: 'Ticket Status Change',
    note: 'Status moved along, step ' + i,
  }));
  const pdf = await R.ticketReportPdf(d);
  const pages = pagesOf(pdf);
  const text = pages.map(drawn).flat().join('\n');

  t('every visit is listed', d.visits.every((v) => text.includes(v.type)), true);
  t('every spare is listed', d.spares.every((x) => text.includes(x.code)), true);
  t('with its quantity', text.includes('12'), true);
  t('the activity is listed', /step 3/.test(text), true);
  t('and it says which entries it is showing',
    /Entries linked to this ticket only/.test(text), true);
  const n = await pageCount(pdf);
  t('it runs to more than one page', n > 1, true);
  t('every page is numbered, and the total is right',
    Array.from({ length: n }, (_, i) => text.includes(`Page ${i + 1} of ${n}`)).every(Boolean), true);
  t('there is no page number beyond the last', text.includes(`Page ${n + 1} of `), false);
  t('the footer appears once per page',
    (text.match(/VAT: 4550259271/g) || []).length, n);
  t('and so does the confidentiality line',
    (text.match(/CONFIDENTIAL/g) || []).length, n);
  // safe() runs over this string. If the WinAnsi extras were dropped the dash would become a
  // space and nobody would notice until a printed report looked wrong.
  t('and the dash in it survives encoding',
    text.includes('TAGEX ENERGY (PTY) Ltd — CONFIDENTIAL'), true);
}

console.log('\n\x1b[1mLONG TEXT IS NOT TRUNCATED\x1b[0m\n');
{
  const d = base();
  d.ticket.Description = LONG;
  const pdf = await R.ticketReportPdf(d);
  const pages = pagesOf(pdf);
  const text = pages.map(drawn).flat().join(' ');

  t('it runs onto more than one page', pages.length > 1, true);
  t('the first word survives', /\bword0\b/.test(text), true);
  t('the last word survives', /\bword419\b/.test(text), true);
  const missing = [];
  for (let i = 0; i < 420; i++) if (!new RegExp('\\bword' + i + '\\b').test(text)) missing.push(i);
  t('and so does every word in between', missing, []);
  t('nothing is marked as cut off', /…$/.test(text.trim()), false);
}

console.log('\n\x1b[1mA TABLE THAT RUNS OVER KEEPS ITS HEADING\x1b[0m\n');
{
  const d = base();
  d.spares = Array.from({ length: 90 }, (_, i) => ({
    code: 'CODE-' + i, desc: 'A part called number ' + i, req: 1, issued: 0, status: 'Requested',
  }));
  const pdf = await R.ticketReportPdf(d);
  const pages = pagesOf(pdf);
  const text = pages.map(drawn).flat().join(' ');
  const n = await pageCount(pdf);
  t('the spares run onto several pages', n > 1, true);
  // "Description" now appears only as the column heading, so counting it counts headings.
  const headings = (text.match(/Description/g) || []).length;
  t('and the heading is drawn once per page the table touches', headings, n);
  // With no page breaks at all the rows would simply run off the bottom.
  const off = [];
  pages.forEach((p, i) => yPositions(p).forEach((y) => { if (y < 47) off.push(`p${i + 1} y=${y}`); }));
  t('and no row is drawn below the footer', off.slice(0, 5), []);
  t('with no row lost', (() => {
    for (let i = 0; i < 90; i++) if (!text.includes('CODE-' + i)) return 'CODE-' + i + ' missing';
    return true;
  })(), true);
}

console.log('\n\x1b[1mNOTHING IS DRAWN OFF THE PAGE\x1b[0m\n');
{
  const d = base();
  d.ticket.Description = LONG;
  d.spares = Array.from({ length: 40 }, (_, i) => ({
    code: 'X-' + i, desc: 'Another part ' + i, req: 2, issued: 1, status: 'Requested',
  }));
  d.activity = Array.from({ length: 20 }, (_, i) => ({
    at: '2026-09-24T06:00:00.000Z', type: 'Comment', note: 'A note that is reasonably long ' + i,
  }));
  const pdf = await R.ticketReportPdf(d);
  const pages = pagesOf(pdf);
  // The footer rule sits at y = 58. Body text below that would print over the footer.
  const offPage = [];
  pages.forEach((p, i) => {
    yPositions(p).forEach((y) => {
      if (y < 47 || y > 800) offPage.push(`page ${i + 1} @ y=${y}`);
    });
  });
  t('no text is placed over the footer or past the top', offPage.slice(0, 5), []);

  // The point of pulling a job card's history onto a ticket is that the report carries it. A
  // report that silently stops at the foot of a page would make the whole thing pointless --
  // which is exactly what the delivery note was doing.
  const all = pages.map(drawn).flat().join(' ').replace(/\s+/g, ' ');
  const missing = d.activity.map((a) => a.note).filter((n) => !all.includes(n));
  t('every activity entry reaches the paper, however many pages it takes', missing, []);
  t('and so does every spare', d.spares.filter((x) => !all.includes(x.desc)).map((x) => x.desc), []);
}

console.log('\n\x1b[1mA RESOLVED TICKET\x1b[0m\n');
{
  const d = base();
  d.ticket.Status = 'Resolved';
  d.ticket['Resolution Summary'] = 'Replaced the DC isolator and restarted the inverter.';
  d.ticket['Closed At'] = '2026-09-25T14:00:00.000Z';
  const pdf = await R.ticketReportPdf(d);
  const text = pagesOf(pdf).map(drawn).flat().join('\n');
  t('the resolution is printed', text.includes('Replaced the DC isolator'), true);
  t('with the date it was closed, in SAST', text.includes('25/09/2026 16:00'), true);
  t('and the outstanding banner is gone', /OUTSTANDING/.test(text), false);
}

console.log('\n\x1b[1mWHAT THE READER MAY NOT SEE IS NOT PRINTED\x1b[0m\n');
{
  const d = base();
  const pdf = await R.ticketReportPdf(d);
  const text = pagesOf(pdf).map(drawn).flat().join('\n');
  // The endpoint strips denied fields before the layout sees them, so their absence from the
  // payload must mean absence from the page — not a blank row inviting a question.
  t('a field that was stripped leaves no row behind', /Cost recoverable/i.test(text), false);

  const d2 = base();
  d2.ticket['Cost Recoverable'] = true;
  const text2 = pagesOf(await R.ticketReportPdf(d2)).map(drawn).flat().join('\n');
  t('and a field that was allowed is printed', /Cost recoverable/i.test(text2), true);
}

console.log('\n\x1b[1mTHE FILENAME\x1b[0m\n');
{
  const d = base();
  t('is the reference and the date', R.reportFilename(d), 'TKT-2026-0042_Report_20260924.pdf');
  const d2 = base();
  d2.ticket['Ticket Ref'] = '';
  t('and survives a ticket with no reference', /^ticket_Report_\d{8}\.pdf$/.test(R.reportFilename(d2)), true);
}

console.log('\n\x1b[1mTHE TICKET LIST\x1b[0m\n');
{
  // The server's statuses are a copy of the screen's. If one drifts, the printout disagrees
  // with the chip it was printed from -- so they are compared, not trusted.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'mod-scheduler.js'), 'utf8');
  const arr = (name) => JSON.parse('[' + new RegExp('const ' + name + '\\s*=\\s*\\[([^\\]]*)\\]').exec(src)[1]
    .replace(/'/g, '"').replace(/\s+/g, ' ').replace(/,\s*$/, '') + ']');
  t('the statuses are the screen’s', R.TICKET_STATUSES.slice(), arr('TICKET_STATUSES'));
  t('and Open means what the Open chip means', R.OPEN_STATUSES.slice(), arr('OM_TKT_OPEN'));

  t('Open takes an open status', R.inFilter('Awaiting Spares', 'OPEN'), true);
  t('and not a closed one', R.inFilter('Closed', 'OPEN'), false);
  t('a ticket with no status is New, as on screen', R.inFilter(undefined, 'New'), true);
  t('and so it is Open', R.inFilter('', 'OPEN'), true);
  t('a status chip takes only its status', R.inFilter('Resolved', 'Closed'), false);
  t('All takes everything', R.inFilter('Cancelled', 'ALL'), true);
  t('a select comes back as {name} and still matches', R.inFilter({ name: 'Closed' }, 'Closed'), true);

  t('days open run to today while open', R.daysOpen('2026-09-01T08:00:00Z', null, '2026-09-11T07:00:00Z'), '9');
  t('and stop when it closed', R.daysOpen('2026-09-01T08:00:00Z', '2026-09-03T09:00:00Z', '2026-10-01T00:00:00Z'), '2');
  t('and are blank with no reported date', R.daysOpen(null, null, '2026-10-01T00:00:00Z'), '');

  const row = (i, status) => ({
    ref: 'TKT-2026-' + String(1000 - i).padStart(4, '0'), reportedAt: '2026-09-20T08:00:00Z', closedAt: null,
    client: 'Grootvlei', jc: 'OM-2026-0157/INST/TE', subject: 'Inverter offline ' + i,
    category: 'Inverter Fault', priority: 'High', status,
  });
  const many = Array.from({ length: 70 }, (_, i) => row(i, i % 3 ? 'Visit Scheduled' : 'New'));
  const pdf = await R.ticketListPdf({ filter: 'OPEN', search: '', rows: many,
    generatedBy: 'raymond@tagexenergy.co.za', generatedAt: '2026-10-08T09:30:00.000Z' });
  const doc = await PDFDocument.load(pdf);
  const { width, height } = doc.getPage(0).getSize();
  t('a page is A4 either way round', [Math.round(width), Math.round(height)].sort().join('x'), '595x842');
  // Streams that draw no text (fonts, the odd empty one) are not pages.
  const pages = pagesOf(pdf).map(drawn).filter((p) => p.length);
  t('the reader finds as many pages as the document has', pages.length, doc.getPageCount());
  const text = pages.flat().join('\n');
  t('the title names the chip', /SERVICE TICKETS — OPEN/.test(text), true);
  t('and the count', text.includes('70 tickets'), true);
  t('and what Open means', text.includes('Open tickets (New, Assigned'), true);
  t('a count per status', /Visit Scheduled\n46/.test(text) && /New\n24/.test(text), true);
  t('every ticket is on it', many.every((r) => text.includes(r.ref)), true);
  t('70 tickets still print on ONE page', doc.getPageCount(), 1);
  t('with the column headings', text.includes('Ticket') && text.includes('Subject'), true);
  t('and numbered as the only page', text.includes('Page 1 of 1'), true);
  t('the print date is on it, large', text.includes('PRINTED') && text.includes('Thu 08 Oct 2026'), true);
  t('the days column counts from reported', text.includes('\n18\n'), true);

  const one = await R.ticketListPdf({ filter: 'Closed', search: 'groot', rows: [],
    generatedBy: 'x@y.z', generatedAt: '2026-10-08T09:30:00.000Z' });
  const t1 = pagesOf(one).map(drawn).flat().join('\n');
  t('an empty chip says so rather than printing a blank page', t1.includes('No tickets match.'), true);
  const few = await R.ticketListPdf({ filter: 'OPEN', search: '', rows: many.slice(0, 5),
    generatedBy: 'x@y.z', generatedAt: '2026-10-08T09:30:00.000Z' });
  const huge = await R.ticketListPdf({ filter: 'ALL', search: '', rows: Array.from({ length: 400 }, (_, i) => row(i, 'Closed')),
    generatedBy: 'x@y.z', generatedAt: '2026-10-08T09:30:00.000Z' });
  t('a short list prints larger than a long one', fontSizeOfRef(few, many[0].ref) > fontSizeOfRef(pdf, many[0].ref), true);
  t('a short list prints at least 10 pt', fontSizeOfRef(few, many[0].ref) >= 10, true);
  { const pg = (await PDFDocument.load(few)).getPage(0).getSize(); t('and landscape, so the subject has room', pg.width > pg.height, true); }
  t('even 400 tickets stay on one page', (await PDFDocument.load(huge)).getPageCount(), 1);
  t('and a search is printed with it', t1.includes('Search: "groot"'), true);
  t('the filename names the chip and the day',
    R.listFilename({ filter: 'Awaiting Spares', generatedAt: '2026-10-08T09:30:00.000Z' }),
    'Tickets_Awaiting-Spares_20261008.pdf');
}

console.log('\n\x1b[1mTHE TICKET LIST, SORTED\x1b[0m\n');
{
  const r = (ref, reportedAt, tech) => ({ ref, reportedAt, tech });
  const rows = [
    r('TKT-2026-0099', '2026-10-05T08:00:00Z', 'Zola Mthembu'),
    r('TKT-2026-0100', '2026-09-01T08:00:00Z', ''),
    r('TKT-2026-0012', null, 'anna Botha'),
    r('TKT-2026-0050', '2026-09-15T08:00:00Z', 'Bongani Dlamini'),
    r('TKT-2026-0051', '2026-09-15T08:00:00Z', 'Bongani Dlamini'),
  ];
  const refs = (sort, dir) => R.sortRows(rows, sort, dir).map((x) => x.ref.slice(-4));
  t('nothing named is ticket number, newest first, as before', refs(undefined, undefined), ['0100', '0099', '0051', '0050', '0012']);
  t('ticket number ascending', refs('ref', 'asc'), ['0012', '0050', '0051', '0099', '0100']);
  t('0100 is after 0099, not before it', refs('ref', 'desc')[0], '0100');
  t('date ascending, the undated one last', refs('date', 'asc'), ['0100', '0051', '0050', '0099', '0012']);
  t('date descending, the undated one still last', refs('date', 'desc'), ['0099', '0051', '0050', '0100', '0012']);
  t('technician A–Z, ignoring case, the unassigned one last', refs('tech', 'asc'), ['0012', '0051', '0050', '0099', '0100']);
  t('technician Z–A, the unassigned one still last', refs('tech', 'desc'), ['0099', '0051', '0050', '0012', '0100']);
  t('a technician’s own tickets read newest first either way', [refs('tech', 'asc').slice(1, 3), refs('tech', 'desc').slice(1, 3)], [['0051', '0050'], ['0051', '0050']]);
  t('the rows given are not reordered in place', rows.map((x) => x.ref.slice(-4)), ['0099', '0100', '0012', '0050', '0051']);
  t('the sheet says how it is sorted', R.sortLabel('tech', 'asc'), 'Sorted by: Technician, A–Z');
  t('region sorts A–Z with the blank one last', R.sortRows([{ ref: 'A', region: 'Gauteng' }, { ref: 'B', region: '' }, { ref: 'C', region: 'Eastern Cape' }], 'region', 'asc').map((x) => x.ref), ['C', 'A', 'B']);
  {
    const html = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const offered = [...html.matchAll(/<select[^>]*id="tktPrintSort"[\s\S]*?<\/select>/g)].flatMap((m) => [...m[0].matchAll(/value="(\w+)"/g)].map((x) => x[1]));
    t('the screen offers exactly the sorts the server takes', offered.sort(), Object.keys(R.LIST_SORTS).sort());
  }
  t('and the default says so too', R.sortLabel(undefined, undefined), 'Sorted by: Ticket no., newest first');

  const pdf = await R.ticketListPdf({ filter: 'OPEN', search: '', sort: 'date', dir: 'asc',
    rows: R.sortRows(rows.map((x) => ({ ...x, status: 'New', subject: 's', client: 'c', jc: 'j' })), 'date', 'asc'),
    generatedBy: 'x@y.z', generatedAt: '2026-10-08T09:30:00.000Z' });
  const text = pagesOf(pdf).map(drawn).flat().join('\n');
  t('the printout has a Technician column', text.includes('Technician'), true);
  // a name may wrap in its column, so it is matched across the line break
  t('with the technician on it', /Zola\s+Mthembu/.test(text), true);
  t('and the order printed under the title', text.includes('Sorted by: Date reported, oldest first'), true);
  const at = (ref) => text.indexOf(ref);
  t('rows are printed in the order given', at('TKT-2026-0100') < at('TKT-2026-0050') && at('TKT-2026-0099') < at('TKT-2026-0012'), true);
}

console.log('\n\x1b[1mTHE TICKET LIST, THROUGH THE ENDPOINT\x1b[0m\n');
{
  process.env.AUTH_MODE = 'session';
  const api = (m) => path.join(__dirname, '..', 'api', m);
  const TICKETS = 'tbln5V2ynpBY9sIOc', JOBCARDS = 'tbl2wqnfM0eDa8M7P';
  const VISITS = 'tblny4UUKq8OIHQlw', PEOPLE = 'tblYXKBqfN4zituh1';
  const tk = (id, ref, status, extra) => ({ id, createdTime: '2026-09-01T00:00:00.000Z',
    fields: Object.assign({ 'Ticket Ref': ref, Subject: 'Fault ' + ref, Status: status,
      'Job Card': ['recJC000000000001'], 'Reported At': '2026-09-20T08:00:00Z' }, extra) });
  const ROWS = {
    [TICKETS]: [
      // 0001's latest visit is a cancelled one with Anna: Zola, on the visit before it, is working it.
      tk('recTKOPEN00000001', 'TKT-2026-0001', 'New',
        { 'Reported At': '2026-09-25T08:00:00Z', 'Site Visits': ['recVIS00000000001', 'recVIS00000000002'] }),
      tk('recTKOPEN00000002', 'TKT-2026-0002', 'Visit Scheduled',
        { 'Reported At': '2026-09-10T08:00:00Z', 'Site Visits': ['recVIS00000000003'] }),
      tk('recTKCLOSED000003', 'TKT-2026-0003', 'Closed'),
      tk('recTKNOSTATUS0004', 'TKT-2026-0004', undefined, { 'Reported At': undefined }),
    ],
    [JOBCARDS]: [{ id: 'recJC000000000001', fields: { 'JC Reference': 'OM-2026-0174/MAINT/TE', 'Client Name': ['Grootvlei'] } }],
    [VISITS]: [
      { id: 'recVIS00000000001', fields: { 'Start DateTime': '2026-09-21T06:00:00Z', Status: 'Completed', 'Assigned Technician': ['recPPL00000000001'] } },
      { id: 'recVIS00000000002', fields: { 'Start DateTime': '2026-09-28T06:00:00Z', Status: 'Cancelled', 'Assigned Technician': ['recPPL00000000002'] } },
      { id: 'recVIS00000000003', fields: { 'Start DateTime': '2026-09-22T06:00:00Z', Status: 'Scheduled', 'Assigned Technician': ['recPPL00000000003'] } },
    ],
    [PEOPLE]: [
      { id: 'recPPL00000000001', fields: { Name: 'Zola Mthembu' } },
      { id: 'recPPL00000000002', fields: { Name: 'Anna Botha' } },
      { id: 'recPPL00000000003', fields: { Name: 'Bongani Dlamini' } },
    ],
  };
  const AUDIT = [];
  const stub = (file, exports) => {
    const id = require.resolve(api(file));
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  // RES is a duplicate of O&M with the same table ids, so only the BASE id tells the two apart.
  // Each read records which base it hit, and RES serves rows of its own.
  const T = require(api('_lib/tables.js'));
  const RES_ROWS = {
    [TICKETS]: [tk('recTKRES000000001', 'TKT-2026-0901', 'New', { 'Job Card': [] })],
  };
  const BASES_READ = [];
  stub('_lib/airtable.js', {
    async list(baseId, tableId) {
      BASES_READ.push(baseId);
      return JSON.parse(JSON.stringify((baseId === T.BASES.RES ? RES_ROWS : ROWS)[tableId] || []));
    },
    async fieldMaps() { return { idToName: {}, nameToId: {} }; },
  });
  let WHO = null;
  stub('_lib/session.js', {
    async authenticate() { return WHO; }, clientIp: () => '127.0.0.1', userAgent: () => 'verify',
  });
  stub('_lib/audit.js', { audit: (e) => AUDIT.push(e), auditNow: async (e) => { AUDIT.push(e); } });
  const P = require(api('_lib/permissions.js'));
  const handler = require(api('ticket-report.js'));
  const who = (perms) => ({ ok: true, email: 'ops@tagexenergy.co.za', userRecordId: 'recUSER0000000000',
    sid: 'sid-' + Math.random(), perms: P.effectivePermissions(JSON.stringify(perms), null) });
  const ALL = { view: true, create: true, edit: true, delete: false, export: true };
  const ops = who({ tickets: ALL, job_cards: ALL });
  const call = async (as, body) => {
    WHO = as;
    const res = { code: 0, body: null, headers: {},
      setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; },
      send(b) { this.body = JSON.parse(b); return this; } };
    await handler({ method: 'POST', body, headers: {}, url: '/api/ticket-report' }, res);
    return res;
  };
  const printed = (res) => pagesOf(Buffer.from(res.body.content, 'base64')).map(drawn).flat().join('\n');

  let r = await call(ops, { list: { status: 'OPEN' } });
  t('Open prints', r.code, 200);
  let text = printed(r);
  t('the open tickets, including one with no status', ['0001', '0002', '0004'].every((n) => text.includes('TKT-2026-' + n)), true);
  t('and not the closed one', text.includes('TKT-2026-0003'), false);
  t('with the job card and client from the job card', text.includes('OM-2026-0174/MAINT/TE') && text.includes('Grootvlei'), true);
  t('and says how many', r.body.count, 3);
  t('it is audited as an export', AUDIT.some((a) => a.action === 'Export' && a.result === 'Allowed' && /Open, 3 ticket/.test(a.newValue)), true);

  r = await call(ops, { list: { status: 'Closed' } });
  t('a single status prints only that status', [r.body.count, printed(r).includes('TKT-2026-0003')], [1, true]);

  // The ids from a search only narrow. A closed ticket's id sent under Open is not printed:
  // the chip is applied here, whatever the browser sent.
  r = await call(ops, { list: { status: 'OPEN', search: 'fault', ids: ['recTKOPEN00000002', 'recTKCLOSED000003'] } });
  text = printed(r);
  t('a search prints only the tickets it found', text.includes('TKT-2026-0002') && !text.includes('TKT-2026-0001'), true);
  t('and never one outside the chip', text.includes('TKT-2026-0003'), false);

  r = await call(ops, { list: { status: 'Everything' } });
  t('a chip that does not exist is refused', r.code, 400);
  r = await call(ops, { list: { status: 'OPEN', ids: ['not-a-record'] } });
  t('and so is a list of ids that are not record ids', r.code, 400);

  const noExport = who({ tickets: { view: true, create: true, edit: true, delete: false, export: false } });
  AUDIT.length = 0;
  r = await call(noExport, { list: { status: 'OPEN' } });
  t('a role without tickets:export is refused', r.code, 403);
  t('and the refusal is audited', AUDIT.some((a) => a.result === 'Denied'), true);

  r = await call(who({ tickets: ALL }), { list: { status: 'ALL' } });
  t('a role that cannot read job cards still gets its list', [r.code, r.body.count], [200, 4]);

  // ── sorted ──
  const opsT = who({ tickets: ALL, job_cards: ALL, site_visits: ALL, people: ALL });
  const order = (res) => { const tx = printed(res); return ['0001', '0002', '0004'].map((n) => [n, tx.indexOf('TKT-2026-' + n)]).sort((a, b) => a[1] - b[1]).map((x) => x[0]); };
  r = await call(opsT, { list: { status: 'OPEN' } });
  t('no sort named prints ticket number, newest first, as before', order(r), ['0004', '0002', '0001']);
  text = printed(r);
  t('the technician is the one on the latest visit that was not cancelled', /Zola\s+Mthembu/.test(text) && !/Anna/.test(text), true);
  r = await call(opsT, { list: { status: 'OPEN', sort: 'tech', dir: 'asc' } });
  t('by technician A–Z, the ticket with no visit last', order(r), ['0002', '0001', '0004']);
  r = await call(opsT, { list: { status: 'OPEN', sort: 'tech', dir: 'desc' } });
  t('by technician Z–A, the ticket with no visit still last', order(r), ['0001', '0002', '0004']);
  r = await call(opsT, { list: { status: 'OPEN', sort: 'date', dir: 'asc' } });
  t('by date reported, oldest first, the undated one last', order(r), ['0002', '0001', '0004']);
  t('and the sheet says so', printed(r).includes('Sorted by: Date reported, oldest first'), true);
  t('the audit records the order', AUDIT.some((a) => /sorted by: date reported, oldest first/.test(a.newValue || '')), true);
  r = await call(opsT, { list: { status: 'OPEN', sort: 'ref', dir: 'asc' } });
  t('by ticket number ascending', order(r), ['0001', '0002', '0004']);
  for (const bad of [{ sort: 'subject' }, { sort: 'tech', dir: 'up' }, { sort: '__proto__' }, { sort: 'constructor' }]) {
    r = await call(opsT, { list: { status: 'OPEN', ...bad } });
    t(`a sort of ${JSON.stringify(bad)} is refused`, r.code, 400);
  }
  // Deny by default: with no rule for site visits or people, readAll would hand over every field.
  r = await call(ops, { list: { status: 'OPEN', sort: 'tech', dir: 'asc' } });
  text = printed(r);
  t('a role that may not view site visits gets no technician names', [r.code, /Zola|Bongani|Anna/.test(text)], [200, false]);
  r = await call(who({ tickets: ALL, job_cards: ALL, site_visits: ALL }), { list: { status: 'OPEN' } });
  t('nor one that may not view people', /Zola|Bongani|Anna/.test(printed(r)), false);

  // ── region sections and the cost column ──
  {
    const keep = JSON.stringify(ROWS);
    ROWS[JOBCARDS].push({ id: 'recJC000000000002', fields: { 'JC Reference': 'OM-2026-0200/MAINT/TE', 'Client Name': ['Cradock Farm'], Region: 'Eastern Cape' } });
    ROWS[JOBCARDS][0].fields.Region = 'Gauteng';
    ROWS[TICKETS][0].fields['Ticket Cost'] = 1250.5;
    ROWS[TICKETS][1].fields['Job Card'] = ['recJC000000000002'];
    ROWS[TICKETS][1].fields['Ticket Cost'] = 12000;
    ROWS[TICKETS][3].fields['Job Card'] = [];
    r = await call(ops, { list: { status: 'OPEN' } });
    text = printed(r);
    const at = (s) => text.indexOf(s);
    t('the list is split Gauteng, then Eastern Cape, then Region not set',
      at('GAUTENG') >= 0 && at('GAUTENG') < at('EASTERN CAPE') && at('EASTERN CAPE') < at('REGION NOT SET'), true);
    t('each ticket under its job card\'s region',
      at('GAUTENG') < at('TKT-2026-0001') && at('TKT-2026-0001') < at('EASTERN CAPE')
      && at('EASTERN CAPE') < at('TKT-2026-0002') && at('TKT-2026-0002') < at('REGION NOT SET')
      && at('REGION NOT SET') < at('TKT-2026-0004'), true);
    t('with a Region column', /\nRegion\n/.test(text) && text.includes('Eastern Cape'), true);
    t('a Cost column, last', /\nStatus\nCost\n/.test(text), true);
    t('with each ticket\'s cost', text.includes('R 1 250.50') && text.includes('R 12 000.00'), true);
    t('each section headed with its count and cost', /1 ticket\s+·\s+R 1 250.50/.test(text) && /1 ticket\s+·\s+R 12 000.00/.test(text), true);
    t('and the total under the title', text.includes('Total cost: R 13 250.50'), true);

    r = await call(ops, { list: { status: 'OPEN', sort: 'region', dir: 'asc' } });
    text = printed(r);
    t('sorted by region A–Z, Eastern Cape prints first', [r.code, text.indexOf('EASTERN CAPE') < text.indexOf('GAUTENG')], [200, true]);
    t('and the sheet says so', text.includes('Sorted by: Region, A–Z'), true);
    r = await call(ops, { list: { status: 'OPEN', sort: 'region', dir: 'desc' } });
    text = printed(r);
    t('Z–A, Gauteng first, Region not set still last',
      text.indexOf('GAUTENG') < text.indexOf('EASTERN CAPE') && text.indexOf('EASTERN CAPE') < text.indexOf('REGION NOT SET'), true);

    // A role kept from Cost Recoverable is kept from Ticket Cost too (permissions.js COUPLED_DENIES),
    // and gets no Cost column at all -- not an empty one.
    const tech = who({ tickets: { ...ALL, fields: { deny_read: ['Cost Recoverable'], deny_write: ['Cost Recoverable'] } }, job_cards: ALL });
    t('a role denied Cost Recoverable is denied Ticket Cost', tech.perms.tickets.fields.deny_read.includes('Ticket Cost')
      && tech.perms.tickets.fields.deny_write.includes('Ticket Cost'), true);
    r = await call(tech, { list: { status: 'OPEN' } });
    text = printed(r);
    t('and its printout has no costs on it', [r.code, /\nCost\n/.test(text), /R \d/.test(text), text.includes('Total cost')], [200, false, false, false]);
    t('but is still split by region', text.includes('GAUTENG') && text.includes('EASTERN CAPE'), true);
    for (const k of Object.keys(ROWS)) ROWS[k] = JSON.parse(keep)[k];
  }

  // ── which base ──
  BASES_READ.length = 0;
  r = await call(ops, { list: { status: 'ALL' } });
  t('no base named reads O&M only, as before RES existed',
    [r.code, BASES_READ.length > 0 && BASES_READ.every((b) => b === T.BASES.OM)], [200, true]);
  BASES_READ.length = 0;
  r = await call(ops, { base: 'RES', list: { status: 'ALL' } });
  text = printed(r);
  t('base RES reads RES only', BASES_READ.length > 0 && BASES_READ.every((b) => b === T.BASES.RES), true);
  t('and prints RES tickets, not O&M ones', [r.body.count, text.includes('TKT-2026-0901'), text.includes('TKT-2026-0001')], [1, true, false]);
  r = await call(ops, { base: 'RES', ticketId: 'recTKOPEN00000001' });
  t('an O&M ticket asked for under RES is not found there', r.code, 404);
  r = await call(ops, { base: 'RES', ticketId: 'recTKRES000000001' });
  t('a RES ticket prints under RES', r.code, 200);
  for (const bad of ['CI', 'IAM', 'app0tq4y9wH10h6Up', 'om']) {
    BASES_READ.length = 0;
    r = await call(ops, { base: bad, list: { status: 'ALL' } });
    t(`base "${bad}" is refused before anything is read`, [r.code, BASES_READ.length], [400, 0]);
  }
}

console.log('\n\x1b[1mTHE BROWSER HARNESSES PARSE\x1b[0m\n');
{
  // A harness page whose script does not parse does not FAIL -- it never starts, never posts
  // back, and the runner waits on it forever. A redeclared name in the ticket harness's Print
  // section did exactly that, and it read as a slow test rather than a broken one. Compiling
  // every inline script here turns that into a failure in the node suite, in a second.
  const fs = require('fs');
  const vm = require('vm');
  const dir = __dirname;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort()) {
    const html = fs.readFileSync(path.join(dir, file), 'utf8');
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    blocks.forEach((code, i) => {
      let err = null;
      try { new vm.Script(code, { filename: file + '#' + (i + 1) }); } catch (e) { err = e.message; }
      t(file + ' inline script ' + (i + 1) + ' parses', err, null);
    });
  }
}

console.log('\n' + '='.repeat(70));
if (fail === 0) console.log(`\x1b[32m\x1b[1m  ALL ${pass} ASSERTIONS PASSED\x1b[0m`);
else {
  console.log(`\x1b[31m\x1b[1m  ${fail} FAILED\x1b[0m, ${pass} passed\n`);
  failures.forEach((f) => console.log('  \x1b[31m*\x1b[0m ' + f));
}
console.log('='.repeat(70) + '\n');
process.exit(fail === 0 ? 0 : 1);

})().catch((e) => { console.error('\x1b[31mSuite crashed:\x1b[0m', e); process.exit(1); });
