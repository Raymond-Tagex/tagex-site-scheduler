// Build a Scope of Work / Site Report from everything read out of a site's folder.
//
// WHY GENERATE A DOCUMENT AT ALL
//
// The extractors read a folder and produce a set of field values. Those go onto the Site
// Information record — but the record does not say WHERE any of it came from, and six months
// later "Total Panel Capacity 113.4" is a number nobody can check. This writes the working out
// down: every value, the file it came from, every figure that was derived rather than stated,
// and every document that was read but yielded nothing.
//
// It is a RECORD OF WHAT WAS READ, not a professional scope of work. It says so on its face.
// Nobody should hand this to a client as an engineering document — it is the audit trail for how
// the site record came to hold what it holds, and it is uploaded alongside the source files so
// the two can always be compared.
//
// The PDF is written by hand. A text-only PDF is a few hundred bytes of structure plus the
// strings, and the alternative was a rendering library for something that only ever sets
// Helvetica at one size.

'use strict';

const PAGE_W = 595;          // A4 at 72dpi
const PAGE_H = 842;
const MARGIN = 52;
const LEAD = 14;             // line height
const SIZE = 10;
const TITLE_SIZE = 15;
const WRAP = 88;             // characters per line at 10pt Helvetica within the margins

/** PDF literal string escaping. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    // A PDF literal is bytes; anything outside Latin-1 cannot be written in the base font.
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
}

/** Break a long line on word boundaries so nothing runs off the page. */
function wrap(text, width) {
  const out = [];
  for (const raw of String(text == null ? '' : text).split('\n')) {
    let line = raw;
    if (!line.trim()) { out.push(''); continue; }
    while (line.length > width) {
      let cut = line.lastIndexOf(' ', width);
      if (cut <= 0) cut = width;
      out.push(line.slice(0, cut));
      line = line.slice(cut).replace(/^\s+/, '');
    }
    out.push(line);
  }
  return out;
}

/**
 * A minimal text PDF.
 *
 * @param {string} title
 * @param {Array<{text:string, bold?:boolean, size?:number, gap?:number}>} blocks
 */
function simplePdf(title, blocks) {
  // ── lay the text out into pages ────────────────────────────────────────────
  const pages = [];
  let current = [];
  let y = PAGE_H - MARGIN;

  const push = (text, font, size) => {
    if (y < MARGIN + LEAD) { pages.push(current); current = []; y = PAGE_H - MARGIN; }
    current.push({ text, font, size, y });
    y -= size >= TITLE_SIZE ? size + 8 : LEAD;
  };

  for (const b of blocks) {
    const size = b.size || SIZE;
    const font = b.bold ? '/F2' : '/F1';
    const width = Math.floor(WRAP * (SIZE / size));
    for (const line of wrap(b.text, width)) push(line, font, size);
    if (b.gap) y -= b.gap;
  }
  if (current.length) pages.push(current);
  if (!pages.length) pages.push([]);

  // ── assemble the file ─────────────────────────────────────────────────────
  const chunks = [];
  let len = 0;
  const offsets = [];
  const put = (b) => {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1');
    chunks.push(buf);
    len += buf.length;
  };
  const obj = (n, body, stream) => {
    offsets[n] = len;
    put(n + ' 0 obj\n' + body + '\n');
    if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); }
    put('endobj\n');
  };

  const pageIds = pages.map((_, i) => 5 + i * 2);
  const contentIds = pages.map((_, i) => 6 + i * 2);

  put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [' + pageIds.map((i) => i + ' 0 R').join(' ')
    + '] /Count ' + pages.length + ' >>');
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  pages.forEach((lines, i) => {
    obj(pageIds[i], '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + ']'
      + ' /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents '
      + contentIds[i] + ' 0 R >>');
    const body = lines.map((l) => 'BT ' + l.font + ' ' + l.size + ' Tf '
      + MARGIN + ' ' + l.y + ' Td (' + esc(l.text) + ') Tj ET').join('\n') + '\n';
    obj(contentIds[i], '<< /Length ' + body.length + ' >>', Buffer.from(body, 'latin1'));
  });

  const maxId = 4 + pages.length * 2;
  const xref = len;
  let x = 'xref\n0 ' + (maxId + 1) + '\n0000000000 65535 f \n';
  for (let i = 1; i <= maxId; i++) x += String(offsets[i] || 0).padStart(10, '0') + ' 00000 n \n';
  put(x);
  put('trailer\n<< /Size ' + (maxId + 1) + ' /Root 1 0 R /Info << /Title ('
    + esc(title) + ') >> >>\nstartxref\n' + xref + '\n%%EOF\n');

  return Buffer.concat(chunks);
}

// The order fields are reported in, grouped the way the site screen groups them.
const SECTIONS = [
  ['Site', ['Site Name', 'Client Name', 'Property Address', 'Postal Address', 'Site Type',
    'Installation Category', 'Site Contact', 'Cell Number', 'Alternative Number',
    'Email Address']],
  ['Job card', ['Job Card Number', 'SUB / SOL Number', 'Responsible Person', 'Project Manager',
    'Operations Manager', 'Team Leader', 'Date Issued', 'Start Date', 'End Date',
    'Installation Date']],
  ['System', ['Panel Manufacturer', 'Panel Model', 'Panel Quantity',
    'Total Panel Capacity (kWp)', 'Inverter Manufacturer', 'Inverter Model', 'Inverter Quantity',
    'Total Inverter Capacity (kW)', 'Battery Manufacturer', 'Battery Model', 'Battery Quantity',
    'Total Battery Capacity (kWh)']],
  ['Monitoring', ['Monitoring System', 'Monitoring Platform', 'Monitoring Reference']],
  ['Contract and O&M', ['Contract Type', 'Contract Term', 'O&M Agreement', 'O&M Contact',
    'Current System Status', 'Last Service Date', 'Next Service Date']],
  ['Notes', ['Technical Notes', 'O&M Notes', 'Site Notes', 'Operational Requirements']],
];

const SOURCE_WORDS = {
  site: 'already on the site record',
  jobcard: 'from the job card in Airtable',
  client: 'from the client record',
  ocr: 'read from a document',
  folder: 'from the folder name',
};

/**
 * The report body, as blocks.
 *
 * @param {object} r
 * @param {object} r.fields        field -> value, as confirmed
 * @param {object} r.provenance    field -> where it came from
 * @param {object} [r.origin]      field -> the filename it was read from
 * @param {Array}  [r.equipment]
 * @param {Array}  [r.sources]     [{ name, read:boolean, chars:number, note:string }]
 * @param {Array}  [r.warnings]
 * @param {string} [r.author]
 */
function reportBlocks(r) {
  const fields = r.fields || {};
  const prov = r.provenance || {};
  const origin = r.origin || {};
  const sources = r.sources || [];
  const warnings = r.warnings || [];
  const equipment = r.equipment || [];
  const name = fields['Site Name'] || 'Unnamed site';
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const blocks = [];
  const B = (text, opts) => blocks.push(Object.assign({ text }, opts || {}));

  B('SCOPE OF WORK / SITE REPORT', { bold: true, size: TITLE_SIZE });
  B(name, { bold: true, size: 12, gap: 6 });
  B('Compiled ' + now + (r.author ? ' by ' + r.author : '') + '.', {});
  B('Assembled automatically from the documents listed at the end of this report. It records '
    + 'what was read and where each value came from. It is not an engineering document and has '
    + 'not been checked by an engineer.', { gap: 10 });

  let reported = 0;
  for (const [section, keys] of SECTIONS) {
    const rows = keys.filter((k) => fields[k] !== undefined && fields[k] !== '');
    if (!rows.length) continue;
    B(section.toUpperCase(), { bold: true, gap: 2 });
    for (const k of rows) {
      reported++;
      const from = origin[k] || SOURCE_WORDS[prov[k]] || '';
      B('  ' + k + ': ' + fields[k] + (from ? '   [' + from + ']' : ''), {});
    }
    B('', { gap: 4 });
  }

  // What is still missing matters as much as what was found.
  const missing = [];
  for (const [, keys] of SECTIONS) {
    for (const k of keys) if (fields[k] === undefined || fields[k] === '') missing.push(k);
  }
  if (missing.length) {
    B('NOT FOUND IN ANY DOCUMENT (' + missing.length + ')', { bold: true, gap: 2 });
    B('  ' + missing.join(', '), { gap: 8 });
  }

  if (equipment.length) {
    B('EQUIPMENT', { bold: true, gap: 2 });
    for (const e of equipment) {
      const bits = [e.Manufacturer, e.Model, e['Serial Number']].filter(Boolean).join(' ');
      B('  ' + e['Equipment Type'] + ': ' + (bits || '(no detail)')
        + (e.Quantity != null ? '  x' + e.Quantity : ''), {});
    }
    B('', { gap: 4 });
  }

  if (warnings.length) {
    B('VALUES THAT WERE DERIVED OR COULD NOT BE READ', { bold: true, gap: 2 });
    for (const w of warnings) B('  - ' + w, {});
    B('', { gap: 4 });
  }

  B('DOCUMENTS READ', { bold: true, gap: 2 });
  if (!sources.length) B('  (none)', {});
  for (const s of sources) {
    B('  ' + (s.read ? '[read]' : '[not read]') + ' ' + s.name
      + (s.chars ? '  ' + s.chars + ' characters' : '')
      + (s.note ? '  - ' + s.note : ''), {});
  }
  B('', { gap: 6 });
  B(reported + ' field(s) populated, ' + missing.length + ' still empty, '
    + sources.filter((s) => s.read).length + ' of ' + sources.length + ' document(s) readable.',
  { bold: true });

  return blocks;
}

/** The report as plain text, for the Notes field and for tests. */
function reportText(r) {
  return reportBlocks(r).map((b) => b.text).join('\n');
}

/** The report as a PDF. */
function reportPdf(r) {
  const name = (r.fields && r.fields['Site Name']) || 'Site';
  return simplePdf('Scope of Work / Site Report - ' + name, reportBlocks(r));
}

/** A filename that sorts and reads well. */
function reportFilename(r) {
  const name = String((r.fields && r.fields['Site Name']) || 'site')
    .replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, ' ')
    .slice(0, 60) || 'site';
  return name + ' - SOW and Site Report ' + new Date().toISOString().slice(0, 10) + '.pdf';
}

module.exports = { reportBlocks, reportText, reportPdf, reportFilename, simplePdf, wrap, SECTIONS };
