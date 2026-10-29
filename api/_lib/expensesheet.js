// TAGEX expense sheet export — fills the official expense sheet, it does not draw a new one.
//
// The template (assets/expense-sheet-template.xlsx) is the blank form the employee signs. Every
// cell it keeps, its styles, the logo, the print area and the named ranges Subtotal and Advances
// stay as they are. This module writes the claim's values into the input cells and nothing else.
//
// One deliberate change to the template's arithmetic: the template's ACTUAL COST formula
// (tblData, column N) leaves out column I, Actual Fuel Cost, which is the main line on a fuel
// claim. Rows 16 and 17 of the sample were typed over by hand to get around it. The export writes
// N = F + G + I + J..M per line so the fuel is counted. Revert with EXPENSE_SHEET_FUEL_IN_TOTAL
// set to false only if the business confirms the omission was intended.

'use strict';

const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');

const TEMPLATE = path.join(__dirname, 'assets', 'expense-sheet-template.xlsx');
const FIRST_LINE_ROW = 16;
const LINE_ROWS = 7; // rows 16..22 are the tblData body; more lines need a row insert (not built yet)
const SHEET = 'xl/worksheets/sheet1.xml';

// Column each category is written to. Anything not listed goes to Misc.
const CATEGORY_COLUMN = Object.freeze({
  Accommodation: 'F',
  Transport: 'G',
  'Fuel': 'I',
  Meals: 'J',
  Phone: 'K',
  Entertainment: 'L',
  Misc: 'M',
});

const FUEL_IN_TOTAL = process.env.EXPENSE_SHEET_FUEL_IN_TOTAL !== 'false';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Excel serial date (1900 system) for a JS date or ISO string. */
function excelDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('excelDate: bad date');
  return Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(1899, 11, 30)) / 86400000);
}

/** Replace the content of one existing cell, keeping its style index. */
function setCell(xml, ref, kind, value) {
  const re = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  const m = xml.match(re);
  if (!m) throw new Error(`expense sheet: cell ${ref} is missing from the template`);
  const attrs = m[1].replace(/\s*t="[^"]*"/, '');
  let body;
  if (kind === 'n') body = `<c r="${ref}"${attrs}><v>${Number(value)}</v></c>`;
  else if (kind === 'f') body = `<c r="${ref}"${attrs}><f>${esc(value)}</f></c>`;
  else if (kind === 's') body = `<c r="${ref}"${attrs} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
  else if (kind === 'blank') body = `<c r="${ref}"${attrs}/>`;
  else throw new Error(`expense sheet: unknown cell kind ${kind}`);
  return xml.replace(m[0], body);
}

/**
 * Build the sheet for one claim.
 * claim:  { ref, employeeName, paymentMethod, claimType, purpose, projectName, claimDate,
 *           kilometres, advances, fundsNote }
 * lines:  [{ date, supplier, description, category, amount }]  (already validated)
 * Returns a Buffer of the .xlsx.
 */
async function buildExpenseSheet(claim, lines) {
  if (!Array.isArray(lines) || lines.length > LINE_ROWS) {
    const err = new Error('too_many_lines');
    err.code = 'too_many_lines';
    err.max = LINE_ROWS;
    throw err;
  }
  const zip = await JSZip.loadAsync(fs.readFileSync(TEMPLATE));
  let xml = await zip.file(SHEET).async('string');

  // Header block. Labels in the template stay; these are the values that go beside them.
  xml = setCell(xml, 'D8', 's', claim.employeeName || '');
  xml = setCell(xml, 'G8', 's', claim.paymentMethod || '');
  xml = setCell(xml, 'L8', 's', `TYPE OF EXPENSE: ${claim.claimType || ''}`);
  xml = setCell(xml, 'D9', 's', claim.purpose || '');
  xml = setCell(xml, 'D10', 's', claim.projectName || '');
  xml = setCell(xml, 'G10', 'n', excelDate(claim.claimDate));
  xml = setCell(xml, 'G11', 's', claim.ref || '');
  if (claim.kilometres != null && claim.kilometres !== '') xml = setCell(xml, 'D12', 'n', claim.kilometres);
  xml = setCell(xml, 'N24', 'n', Number(claim.advances) || 0);
  if (claim.fundsNote) xml = setCell(xml, 'H25', 's', claim.fundsNote);

  // Expense lines, rows 16..22. Each row carries its own total so the table reads line by line.
  for (let i = 0; i < LINE_ROWS; i++) {
    const r = FIRST_LINE_ROW + i;
    const line = lines[i];
    if (line) {
      xml = setCell(xml, `C${r}`, 'n', excelDate(line.date));
      xml = setCell(xml, `D${r}`, 's', line.supplier || '');
      xml = setCell(xml, `E${r}`, 's', line.description || '');
      const col = CATEGORY_COLUMN[line.category] || CATEGORY_COLUMN.Misc;
      for (const c of Object.values(CATEGORY_COLUMN)) {
        if (c === col) xml = setCell(xml, `${c}${r}`, 'n', Number(line.amount) || 0);
        else xml = setCell(xml, `${c}${r}`, 'n', 0);
      }
    }
    const fuelTerm = FUEL_IN_TOTAL ? `I${r},` : '';
    xml = setCell(xml, `N${r}`, 'f', `SUM(F${r}:G${r},${fuelTerm}J${r}:M${r})`);
  }

  zip.file(SHEET, xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** TAGEX_ExpenseClaim_[ClaimNumber].xlsx, with characters unsafe in file names removed. */
function claimFileName(claimRef) {
  const safe = String(claimRef || 'UNNUMBERED').replace(/[^A-Za-z0-9-]/g, '_');
  return `TAGEX_ExpenseClaim_${safe}.xlsx`;
}

module.exports = { buildExpenseSheet, claimFileName, excelDate, CATEGORY_COLUMN, LINE_ROWS };
