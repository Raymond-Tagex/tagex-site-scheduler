// A small .xlsx writer: sheets of rows, with a bold frozen header, filter arrows, real dates and
// real numbers. Enough for an export somebody sorts and filters in Excel, and nothing more.
//
// Written here rather than pulled in because the formats are few and fixed, and a library that
// reads and writes every spreadsheet feature is a lot of code to ship for a table. jszip (already a
// dependency, see expensesheet.js) does the zipping.

'use strict';

const JSZip = require('jszip');

// The OOXML parts every workbook needs. Styles: 0 plain, 1 bold header, 2 date and time,
// 3 date, 4 a number with one decimal at most.
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<numFmts count="3"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/>'
  + '<numFmt numFmtId="165" formatCode="dd/mm/yyyy"/><numFmt numFmtId="166" formatCode="#,##0.0"/></numFmts>'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF6E0"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="5">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';
const STYLE = { head: 1, datetime: 2, date: 3, number: 4 };

/** XML text: escaped, and without the control characters XML 1.0 cannot carry at all. */
const xml = (s) => String(s == null ? '' : s)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A1-style column letters: 0 -> A, 25 -> Z, 26 -> AA. */
function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// South Africa keeps no daylight saving, so SAST is UTC+2 all year.
const SAST_MS = 2 * 3600 * 1000;
/**
 * An ISO date-time as an Excel serial in SAST (days since 30 Dec 1899, time as the fraction), so
 * it sorts and filters as a date. null when it is not a date.
 */
function serial(iso, dateOnly) {
  const t = Date.parse(iso || '');
  if (isNaN(t)) return null;
  const days = (t + SAST_MS - Date.UTC(1899, 11, 30)) / 86400000;
  return dateOnly ? Math.floor(days) : Math.round(days * 86400) / 86400;
}

/**
 * One cell. A value that is not what its column says it is goes in as text rather than being
 * dropped: an export that loses data quietly is worse than one that looks untidy.
 */
function cell(ref, value, type) {
  if (value == null || value === '') return '';
  if (type === 'number' && typeof value === 'number' && isFinite(value)) {
    return `<c r="${ref}" s="${STYLE.number}"><v>${value}</v></c>`;
  }
  if (type === 'int' && typeof value === 'number' && isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  // A number in a text column (the About sheet's values) is still a number.
  if ((!type || type === 'text') && typeof value === 'number' && isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  if (type === 'datetime' || type === 'date') {
    const v = serial(value, type === 'date');
    if (v != null) return `<c r="${ref}" s="${STYLE[type]}"><v>${v}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function sheetXml(sh) {
  const cols = sh.columns;
  const last = colName(cols.length - 1);
  const head = '<row r="1">' + cols.map((c, i) =>
    `<c r="${colName(i)}1" t="inlineStr" s="${STYLE.head}"><is><t xml:space="preserve">${xml(c.head)}</t></is></c>`).join('') + '</row>';
  const body = sh.rows.map((row, ri) => {
    const r = ri + 2;
    return `<row r="${r}">` + cols.map((c, ci) => cell(colName(ci) + r, row[c.key], c.type)).join('') + '</row>';
  }).join('');
  const widths = '<cols>' + cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join('') + '</cols>';
  const freeze = sh.freeze === false ? '' : '<sheetViews><sheetView workbookViewId="0">'
    + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
  const filter = sh.filter === false ? '' : `<autoFilter ref="A1:${last}${Math.max(1, sh.rows.length + 1)}"/>`;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + freeze + widths + '<sheetData>' + head + body + '</sheetData>' + filter + '</worksheet>';
}

/** A sheet name Excel will accept: 31 characters, none of []:*?/\ */
const sheetName = (s) => String(s || 'Sheet').replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet';

/**
 * @param {Array<{name:string, columns:Array<{head,key,type?,width?}>, rows:object[], freeze?, filter?}>} sheets
 *   type: 'text' (default), 'number' (one decimal), 'int', 'datetime' or 'date' (ISO in, SAST out).
 * @returns {Promise<Buffer>}
 */
async function workbook(sheets) {
  const zip = new JSZip();
  const n = sheets.length;
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '</Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>');
  zip.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
    + sheets.map((s, i) => `<sheet name="${xml(sheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + '</sheets>'
    + (sheets.some((s) => s.filter !== false) ? '<definedNames>' + sheets.map((s, i) => (s.filter === false ? ''
      : `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xml(sheetName(s.name)).replace(/'/g, "''")}'!$A$1:$${colName(s.columns.length - 1)}$${Math.max(1, s.rows.length + 1)}</definedName>`)).join('') + '</definedNames>' : '')
    + '</workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + '</Relationships>');
  zip.file('xl/styles.xml', STYLES);
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

module.exports = { workbook, colName, serial, XLSX_TYPE };
