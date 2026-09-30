// Text out of a .docx or .xlsx, with no dependency.
//
// WHY THIS EXISTS
//
// The SOW is a Word file and the bill of materials is a spreadsheet, and until this existed both
// were completely opaque: readDocument() answered "Not an image or a PDF" and the FICA classifier
// saw an empty string. So no site data could ever be read out of them — and, worse, a quotation
// in Word or an invoice in Excel walked past the financial check unexamined, because the check
// can only judge text it can see.
//
// An Office file is a ZIP of XML. Node ships zlib, so the whole job is a small ZIP reader and
// some tag stripping — no library, nothing sent anywhere, consistent with the rest of this
// codebase taking exactly one dependency for something (OCR) that genuinely needed it.
//
// WHAT IS NOT SUPPORTED: the old binary .doc and .xls formats, which are not ZIPs at all, and
// encrypted Office files. Both return '' and are reported as unreadable rather than as clean.

'use strict';

const zlib = require('zlib');

const MAX_ENTRIES = 2000;          // a spreadsheet has dozens; this stops a zip bomb's index
const MAX_TEXT = 400000;           // enough for a long SOW, bounded for a function's memory
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;

/**
 * Read a ZIP central directory and return { name -> Buffer } for the entries a caller asks for.
 *
 * Only the entries whose names `want` accepts are inflated, so opening a 40MB spreadsheet to
 * read one small XML part does not cost 40MB of inflation.
 *
 * @param {Buffer} buf
 * @param {(name:string) => boolean} want
 */
function unzip(buf, want) {
  const out = new Map();
  if (buf.length < 22) return out;

  // End of central directory: signature 0x06054b50, within the last 64KB + 22 bytes.
  let eocd = -1;
  const from = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;

  let count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) count = MAX_ENTRIES;

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (!want(name)) continue;
    if (compSize > MAX_ENTRY_BYTES) continue;

    // The local header repeats the name and extra with its OWN lengths, which often differ from
    // the central directory's. Reading the data at the central directory's offsets is a classic
    // way to get shifted garbage.
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const end = start + compSize;
    if (end > buf.length) continue;

    const raw = buf.slice(start, end);
    try {
      if (method === 0) out.set(name, raw);
      else if (method === 8) out.set(name, zlib.inflateRawSync(raw));
    } catch (e) { /* a damaged entry is skipped, not fatal */ }
  }
  return out;
}

/** XML entities that appear in Office parts. */
function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * Plain text from a Word document.
 *
 * Paragraph and row boundaries become newlines. That matters more than it sounds: the field
 * parser works line by line, so losing paragraph breaks would run an entire SOW into one line
 * and nothing would ever match.
 */
function docxText(buf) {
  const files = unzip(buf, (n) => n === 'word/document.xml'
    || /^word\/(header|footer)\d*\.xml$/.test(n));
  if (!files.size) return '';

  const order = ['word/document.xml', ...[...files.keys()].filter((k) => k !== 'word/document.xml')];
  let out = '';
  for (const name of order) {
    const part = files.get(name);
    if (!part) continue;
    let xml = part.toString('utf8');
    xml = xml
      .replace(/<w:tab\b[^>]*\/?>/g, '\t')
      .replace(/<w:br\b[^>]*\/?>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<\/w:tc>/g, '\t');
    // Keep only the runs of literal text.
    const text = [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|(\n|\t)/g)]
      .map((m) => (m[1] != null ? unescapeXml(m[1]) : m[2]))
      .join('');
    out += text + '\n';
    if (out.length > MAX_TEXT) break;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').slice(0, MAX_TEXT);
}

/**
 * Plain text from a spreadsheet, one line per row, cells separated by " | ".
 *
 * A visible separator rather than a tab, because the field parser splits a label from a value on
 * a run of whitespace and a lone tab would not read as one.
 */
function xlsxText(buf) {
  const files = unzip(buf, (n) => n === 'xl/sharedStrings.xml'
    || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  if (!files.size) return '';

  // Shared strings: most cell text lives here and is referenced by index.
  const shared = [];
  const ss = files.get('xl/sharedStrings.xml');
  if (ss) {
    for (const m of ss.toString('utf8').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      const parts = [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unescapeXml(x[1]));
      shared.push(parts.join(''));
    }
  }

  const sheets = [...files.keys()].filter((k) => k.startsWith('xl/worksheets/')).sort();
  let out = '';
  for (const name of sheets) {
    const xml = files.get(name).toString('utf8');
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = c[1];
        const body = c[2];
        const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1] || 'n';
        let value = '';
        if (type === 's') {
          const idx = Number((/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1]);
          value = shared[idx] != null ? shared[idx] : '';
        } else if (type === 'inlineStr') {
          value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
            .map((x) => unescapeXml(x[1])).join('');
        } else {
          value = unescapeXml((/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1] || '');
        }
        if (value !== '') cells.push(value.trim());
      }
      if (cells.length) out += cells.join(' | ') + '\n';
      if (out.length > MAX_TEXT) return out.slice(0, MAX_TEXT);
    }
  }
  return out.slice(0, MAX_TEXT);
}

/** True for the formats this module can open. */
function isOffice(filename, contentType) {
  return /\.(docx|xlsx)$/i.test(filename || '')
    || /wordprocessingml|spreadsheetml/i.test(contentType || '');
}

/**
 * Text from whichever Office format this is, or '' when it is neither or cannot be opened.
 * @returns {{text:string, kind:string, note:string}}
 */
function officeText(buf, filename, contentType) {
  const isDoc = /\.docx$/i.test(filename || '') || /wordprocessingml/i.test(contentType || '');
  const isSheet = /\.xlsx$/i.test(filename || '') || /spreadsheetml/i.test(contentType || '');

  // The legacy binary formats are not ZIPs, so say so rather than returning a clean blank.
  if (/\.(doc|xls)$/i.test(filename || '')) {
    return {
      text: '', kind: 'legacy',
      note: 'This is an older binary Office file, which cannot be read here. Save it as .docx '
        + 'or .xlsx and upload that.',
    };
  }
  if (!isDoc && !isSheet) return { text: '', kind: '', note: '' };
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    return { text: '', kind: isDoc ? 'docx' : 'xlsx', note: 'The file is not a readable Office document.' };
  }

  try {
    const text = isDoc ? docxText(buf) : xlsxText(buf);
    return {
      text,
      kind: isDoc ? 'docx' : 'xlsx',
      note: text.trim() ? '' : 'The document opened but held no readable text.',
    };
  } catch (e) {
    return { text: '', kind: isDoc ? 'docx' : 'xlsx', note: 'The document could not be opened.' };
  }
}

module.exports = { officeText, docxText, xlsxText, unzip, isOffice, unescapeXml };
