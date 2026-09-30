// OCR text  →  Site Information fields.
//
// WHAT THIS IS AND IS NOT
//
// This is a SUGGESTION ENGINE. Every value it produces is shown to a person for confirmation
// before anything is written to Airtable. That is not politeness — OCR of a scanned, part
// handwritten jobcard is wrong often enough that silently creating records from it would quietly
// corrupt the site register. The parser is therefore biased hard towards returning nothing:
// a label it does not recognise is dropped, a select option that does not match exactly is
// dropped with a warning, an unparseable number is dropped.
//
// WHY DROPPING IS ALSO THE PRIVACY CONTROL
//
// A value is only ever emitted when its LABEL matched an entry in LABELS, and LABELS contains
// only operational fields — there is no synonym for "account number", "ID number" or "bank".
// So a jobcard that happens to carry a banking line cannot produce a field to carry it: the
// module's deny-by-default shape does the work, not a blocklist that has to anticipate wording.
// The raw OCR text is a separate matter and is gated by the classifier in siteinfo-upload.js.

'use strict';

// Airtable field names. Kept literal rather than imported so a rename in the UI module cannot
// silently retarget the parser at a field that does not exist.
const FIELD = {
  name: 'Site Name',
  clientName: 'Client Name',
  jcNumber: 'Job Card Number',
  subSol: 'SUB / SOL Number',
  category: 'Installation Category',
  siteType: 'Site Type',
  address: 'Property Address',
  postal: 'Postal Address',
  contact: 'Site Contact',
  cell: 'Cell Number',
  altNo: 'Alternative Number',
  email: 'Email Address',
  responsible: 'Responsible Person',
  pm: 'Project Manager',
  om: 'Operations Manager',
  lead: 'Team Leader',
  issued: 'Date Issued',
  start: 'Start Date',
  end: 'End Date',
  installed: 'Installation Date',
  contractType: 'Contract Type',
  term: 'Contract Term',
  panelMake: 'Panel Manufacturer',
  panelModel: 'Panel Model',
  panelQty: 'Panel Quantity',
  panelKw: 'Total Panel Capacity (kWp)',
  invMake: 'Inverter Manufacturer',
  invModel: 'Inverter Model',
  invQty: 'Inverter Quantity',
  invKw: 'Total Inverter Capacity (kW)',
  battMake: 'Battery Manufacturer',
  battModel: 'Battery Model',
  battQty: 'Battery Quantity',
  battKw: 'Total Battery Capacity (kWh)',
  monSystem: 'Monitoring System',
  monPlatform: 'Monitoring Platform',
  monRef: 'Monitoring Reference',
  techNotes: 'Technical Notes',
  siteNotes: 'Site Notes',
};

// Label synonyms as they appear on the printed jobcard and on the whiteboard sheets.
// Matched longest-first, so "total panel capacity" wins over "capacity".
const LABELS = [
  [FIELD.jcNumber, ['job card number', 'job card no', 'jobcard number', 'jobcard no',
    'jc number', 'jc no', 'job card', 'jobcard', 'work order number', 'work order no']],
  [FIELD.name, ['site name', 'site description', 'name of site', 'project name', 'site']],
  [FIELD.clientName, ['client name', 'customer name', 'client', 'customer', 'account name']],
  [FIELD.subSol, ['sub / sol number', 'sub/sol number', 'sub / sol no', 'sub/sol',
    'sub sol number', 'sol number', 'sub number', 'sol no', 'sub no']],
  [FIELD.address, ['site address', 'property address', 'physical address', 'street address',
    'installation address', 'site location', 'project location', 'location', 'address']],
  [FIELD.postal, ['postal address']],
  [FIELD.contact, ['contact person', 'site contact', 'contact name', 'responsible contact']],
  [FIELD.cell, ['contact number', 'cell number', 'cellphone', 'mobile number', 'telephone',
    'cell', 'mobile', 'tel']],
  [FIELD.altNo, ['alternative number', 'alternate number', 'alt number', 'secondary number']],
  [FIELD.email, ['email address', 'e-mail address', 'email', 'e-mail']],
  [FIELD.responsible, ['responsible person']],
  [FIELD.pm, ['project manager']],
  [FIELD.om, ['operations manager', 'o&m manager']],
  [FIELD.lead, ['team leader', 'team lead', 'site supervisor', 'supervisor']],
  [FIELD.issued, ['date issued', 'issue date', 'issued']],
  [FIELD.start, ['start date', 'commencement date']],
  [FIELD.end, ['end date', 'completion date']],
  [FIELD.installed, ['installation date', 'install date', 'date installed',
    'commissioning date', 'date commissioned']],
  [FIELD.category, ['installation category', 'category']],
  [FIELD.siteType, ['site type', 'type of site']],
  [FIELD.contractType, ['contract type', 'type of contract']],
  [FIELD.term, ['contract term', 'term']],
  [FIELD.panelKw, ['total panel capacity', 'panel capacity', 'total pv capacity',
    'pv capacity', 'system size', 'total kwp', 'kwp']],
  [FIELD.panelQty, ['panel quantity', 'number of panels', 'no of panels', 'no. of panels',
    'panel qty', 'quantity of panels', 'pv modules', 'module quantity']],
  [FIELD.panelMake, ['panel manufacturer', 'panel make', 'module manufacturer', 'module make',
    'pv manufacturer', 'pv make', 'panel brand']],
  [FIELD.panelModel, ['panel model', 'module model', 'pv model', 'panel type']],
  [FIELD.invKw, ['total inverter capacity', 'inverter capacity', 'inverter size']],
  [FIELD.invQty, ['inverter quantity', 'number of inverters', 'no of inverters',
    'no. of inverters', 'inverter qty']],
  [FIELD.invMake, ['inverter manufacturer', 'inverter make', 'inverter brand']],
  [FIELD.invModel, ['inverter model', 'inverter type']],
  [FIELD.battKw, ['total battery capacity', 'battery capacity', 'battery size',
    'storage capacity', 'total kwh']],
  [FIELD.battQty, ['battery quantity', 'number of batteries', 'no of batteries',
    'no. of batteries', 'battery qty']],
  [FIELD.battMake, ['battery manufacturer', 'battery make', 'battery brand']],
  [FIELD.battModel, ['battery model', 'battery type']],
  [FIELD.monPlatform, ['monitoring platform', 'monitoring portal']],
  [FIELD.monRef, ['monitoring reference', 'monitoring ref', 'monitoring id', 'plant id',
    'plant reference', 'portal id']],
  [FIELD.monSystem, ['monitoring system', 'monitoring']],
  [FIELD.techNotes, ['technical notes', 'technical comments']],
  [FIELD.siteNotes, ['site notes', 'general notes', 'comments', 'remarks', 'notes']],
];

// Serial numbers belong to Site Equipment, not to Site Information — the site table has no
// serial field, and one site can carry many inverters. They are collected separately so the
// batch flow can offer to create the equipment rows, and are never forced into a site field.
const SERIALS = [
  ['Meter', ['meter serial number', 'meter serial no', 'meter serial', 'meter number',
    'meter no', 'electricity meter']],
  ['Inverter', ['inverter serial number', 'inverter serial no', 'inverter serial']],
  ['Battery', ['battery serial number', 'battery serial no', 'battery serial']],
  ['PV Module', ['panel serial number', 'module serial number', 'panel serial']],
  ['Monitoring', ['datalogger serial', 'logger serial', 'dongle serial',
    'monitoring serial number', 'monitoring serial']],
];

const SERIAL_LOOKUP = (() => {
  const rows = [];
  for (const [type, syns] of SERIALS) for (const s of syns) rows.push({ type, syn: s });
  rows.sort((a, b) => b.syn.length - a.syn.length);
  return rows;
})();

const NUMBER_FIELDS = [FIELD.panelQty, FIELD.panelKw, FIELD.invQty, FIELD.invKw,
  FIELD.battQty, FIELD.battKw];
const DATE_FIELDS = [FIELD.issued, FIELD.start, FIELD.end, FIELD.installed];
const LONG_FIELDS = [FIELD.techNotes, FIELD.siteNotes, FIELD.address, FIELD.postal];

// Select options, copied from the module's own lists. An OCR value that is not one of these is
// REFUSED rather than guessed at — Airtable select options are case sensitive and typecast is
// off, so a near miss is a failed write, and a confident wrong guess is worse than a blank.
const SELECTS = {
  [FIELD.category]: ['Project - PPA', 'Project - Direct Purchase', 'Residential - SUBS',
    'Residential - Direct Purchase', 'Commercial', 'Other'],
  [FIELD.siteType]: ['Residential', 'Commercial', 'Industrial', 'Agricultural', 'Other'],
  [FIELD.contractType]: ['PPA', 'SUB', 'Direct Purchase', 'Rental', 'Other'],
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Flattened, longest-label-first, so a specific label is never shadowed by a generic one. */
const LOOKUP = (() => {
  const rows = [];
  for (const [field, syns] of LABELS) for (const s of syns) rows.push({ field, syn: s });
  rows.sort((a, b) => b.syn.length - a.syn.length);
  return rows;
})();

/** OCR punctuation and spacing noise, flattened so labels compare reliably. */
function normLabel(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[|¦]/g, '')          // a ruled table border read as a pipe
    .replace(/[^a-z0-9&./ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[ .:]+$/, '');
}

/**
 * Digits that OCR commonly reads as letters. Applied ONLY inside a numeric field, where a letter
 * cannot be legitimate — never to free text, where "SOL" must not become "501".
 */
function digitFix(s) {
  return String(s).replace(/[OoIlSBZ]/g, (c) => (
    { O: '0', o: '0', I: '1', l: '1', S: '5', B: '8', Z: '2' }[c]));
}

/** "73,8 kWp" / "1 234.5" / "164 panels" → a number, or null when there is no number in it. */
function parseNumber(raw) {
  const src = String(raw || '');

  // A numeric field whose value is prose — "TBC", "to be confirmed", "as per drawing" — has no
  // number in it, and must come back blank. Without this guard digitFix turns the o's in
  // "to be confirmed" into zeros and the field is written as 0, which reads on the site record
  // as a real measurement of zero panels rather than as the unanswered question it is.
  if (!/\d/.test(src)) return null;

  // Correct OCR letter-for-digit confusion only inside tokens that already contain a digit, so
  // "SOL-88214" in a neighbouring word is never rewritten to "50L-88214".
  let s = src.replace(/\S+/g, (tok) => (/\d/.test(tok) ? digitFix(tok) : tok))
    .replace(/[^0-9.,\s-]/g, ' ').trim();
  if (!s) return null;
  s = s.split(/\s{2,}/)[0].trim();
  // Thousands separators: a space or a comma with exactly three digits after it.
  s = s.replace(/(\d)[  ](?=\d{3}\b)/g, '$1').replace(/(\d),(?=\d{3}\b)/g, '$1');
  // South African decimal comma.
  s = s.replace(',', '.');
  const m = /-?\d+(\.\d+)?/.exec(s);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * A date in any of the forms a South African jobcard uses, as ISO yyyy-mm-dd.
 * Day-first is assumed for all-numeric forms, because that is the local convention.
 *
 * @returns {{value:string|null, ambiguous:boolean}}
 */
function parseDate(raw) {
  const s = String(raw || '').trim();
  let m;

  // 2026-03-04 or 2026/03/04 — unambiguous, year first.
  m = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(s);
  if (m) {
    const iso = isoOf(+m[1], +m[2], +m[3]);
    return { value: iso, ambiguous: false };
  }

  // 4 March 2026 / March 4, 2026
  m = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b/.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mo >= 0) return { value: isoOf(+m[3], mo + 1, +m[1]), ambiguous: false };
  }
  m = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mo >= 0) return { value: isoOf(+m[3], mo + 1, +m[2]), ambiguous: false };
  }

  // 04/03/2026 or 04-03-26 — day first.
  m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/.exec(s);
  if (m) {
    const d = +m[1];
    const mo = +m[2];
    let y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    const iso = isoOf(y, mo, d);
    // Both halves could be a month, so the reading is a convention, not a fact. Say so.
    return { value: iso, ambiguous: iso != null && d <= 12 && mo <= 12 && d !== mo };
  }

  return { value: null, ambiguous: false };
}

function isoOf(y, m, d) {
  if (!(y >= 1990 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;   // 31 February
  return dt.toISOString().slice(0, 10);
}

/** Exact select option, matched case-insensitively but stored with the option's own casing. */
function matchSelect(field, raw) {
  const opts = SELECTS[field];
  if (!opts) return null;
  const want = normLabel(raw);
  for (const o of opts) if (normLabel(o) === want) return o;
  // "PPA Project" must NOT become "Project - PPA". Only a whole-string match counts.
  return null;
}

/** Strip the OCR debris a ruled form leaves around a value. */
function cleanValue(s) {
  return String(s || '')
    .replace(/[|¦]+/g, ' ')
    .replace(/[_]{2,}/g, ' ')          // the blank writing line on a printed form
    .replace(/\.{3,}/g, ' ')           // leader dots
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-–—:.]+/, '')
    .replace(/[-–—:.]+$/, '')
    .trim();
}

/**
 * Split one OCR line into label and value.
 * A colon is the reliable separator; failing that, a run of two or more spaces is how a ruled
 * form separates its columns. A single space is NOT treated as a separator, because "Site Name"
 * would split into "Site" and "Name".
 */
function splitLine(line) {
  const s = String(line || '').replace(/\s+$/, '');
  if (!s.trim()) return null;

  const colon = s.indexOf(':');
  if (colon > 0 && colon < 60) {
    return { label: s.slice(0, colon), value: s.slice(colon + 1) };
  }
  const gap = /\s{2,}/.exec(s);
  if (gap && gap.index > 0 && gap.index < 60) {
    return { label: s.slice(0, gap.index), value: s.slice(gap.index) };
  }
  return null;
}

/** The field a label refers to, or null. Requires the WHOLE label to match a synonym. */
function fieldFor(label) {
  const n = normLabel(label);
  if (!n) return null;
  for (const row of LOOKUP) if (n === row.syn) return row.field;
  return null;
}

/** The equipment type whose serial a label refers to, or null. */
function serialFor(label) {
  const n = normLabel(label);
  if (!n) return null;
  for (const row of SERIAL_LOOKUP) if (n === row.syn) return row.type;
  return null;
}

/**
 * Candidate Site Equipment rows implied by the parsed site fields and serials.
 *
 * A row is only proposed when there is something substantive to put in it — a make, a model or a
 * serial. A bare quantity produces nothing, because "2 inverters" with no make is not a record
 * anyone can act on, and creating empty equipment rows would make the register look populated
 * when it is not.
 *
 * @returns {Array<{Equipment Type:string, Manufacturer?:string, Model?:string,
 *                  'Serial Number'?:string, Quantity?:number}>}
 */
function equipmentFrom(fields, serials) {
  const f = fields || {};
  const s = serials || {};
  const rows = [];

  const add = (type, make, model, qty) => {
    const row = { 'Equipment Type': type };
    if (make) row.Manufacturer = make;
    if (model) row.Model = model;
    if (s[type]) row['Serial Number'] = s[type];
    if (qty != null) row.Quantity = qty;
    if (row.Manufacturer || row.Model || row['Serial Number']) rows.push(row);
  };

  add('PV Module', f[FIELD.panelMake], f[FIELD.panelModel], f[FIELD.panelQty]);
  add('Inverter', f[FIELD.invMake], f[FIELD.invModel], f[FIELD.invQty]);
  add('Battery', f[FIELD.battMake], f[FIELD.battModel], f[FIELD.battQty]);

  // A meter and a datalogger are never described by a site field — the monitoring platform and
  // reference live on the site record itself — so these rows exist only if a serial was read.
  if (s.Meter) rows.push({ 'Equipment Type': 'Meter', 'Serial Number': s.Meter });
  if (s.Monitoring) {
    const row = { 'Equipment Type': 'Monitoring', 'Serial Number': s.Monitoring };
    if (f[FIELD.monPlatform]) row.Manufacturer = f[FIELD.monPlatform];
    rows.push(row);
  }

  return rows;
}

/**
 * Parse OCR text into Airtable fields.
 *
 * @param {string} text
 * @returns {{fields:object, warnings:string[], matched:number, lines:number}}
 */
function parseJobCard(text) {
  const lines = String(text || '').split(/\r?\n/);
  const fields = {};
  const serials = {};
  const warnings = [];
  let matched = 0;

  for (const line of lines) {
    const parts = splitLine(line);
    if (!parts) continue;

    const serialType = serialFor(parts.label);
    if (serialType) {
      const sv = cleanValue(parts.value);
      if (sv && !Object.prototype.hasOwnProperty.call(serials, serialType)) {
        serials[serialType] = sv.slice(0, 100);
        matched++;
      }
      continue;
    }

    const field = fieldFor(parts.label);
    if (!field) continue;

    const raw = cleanValue(parts.value);
    if (!raw) continue;

    // First reading wins. A jobcard repeats its header on later pages, and the first page is
    // the one with the filled-in block.
    if (Object.prototype.hasOwnProperty.call(fields, field)) continue;
    matched++;

    if (NUMBER_FIELDS.indexOf(field) >= 0) {
      // A DURATION IS NOT A COUNT. "PV modules: 12-year product + 25-year performance warranty"
      // reads as a labelled panel quantity of 12 — a warranty clause silently becoming a
      // measurement of the system. Seen in a real scope of work.
      if (/\b\d+\s*-?\s*(year|yr|month|week|day)s?\b/i.test(raw)
        || /\b(warrant|guarantee)/i.test(raw)) {
        warnings.push('"' + field + '": "' + raw.slice(0, 60)
          + '" looks like a warranty or a duration, not a quantity, so it was left blank.');
        continue;
      }
      const n = parseNumber(raw);
      if (n == null) { warnings.push('"' + field + '": could not read a number from "' + raw + '".'); continue; }
      fields[field] = n;
      continue;
    }

    if (DATE_FIELDS.indexOf(field) >= 0) {
      const d = parseDate(raw);
      if (!d.value) { warnings.push('"' + field + '": could not read a date from "' + raw + '".'); continue; }
      fields[field] = d.value;
      if (d.ambiguous) {
        warnings.push('"' + field + '": "' + raw + '" was read day-first as ' + d.value
          + '. Check it if the jobcard uses month-first dates.');
      }
      continue;
    }

    if (SELECTS[field]) {
      const opt = matchSelect(field, raw);
      if (!opt) {
        warnings.push('"' + field + '": "' + raw + '" is not one of the allowed options, so it '
          + 'was left blank. Choose it yourself.');
        continue;
      }
      fields[field] = opt;
      continue;
    }

    // The contractor's own contact block is not the site's. A TAGEX address in a TAGEX document
    // is us, and filing it as the site contact would put our own switchboard on the site record.
    if (field === FIELD.email && /@tagexenergy\.co\.za\s*$/i.test(raw)) continue;

    const cap = LONG_FIELDS.indexOf(field) >= 0 ? 2000 : 200;
    fields[field] = raw.slice(0, cap);
  }

  return { fields, serials, equipment: equipmentFrom(fields, serials), warnings, matched,
    lines: lines.filter((l) => l.trim()).length };
}

module.exports = {
  parseJobCard, parseNumber, parseDate, matchSelect, splitLine, fieldFor, serialFor,
  equipmentFrom, normLabel, cleanValue, digitFix,
  FIELD, SELECTS, LABELS, SERIALS, NUMBER_FIELDS, DATE_FIELDS,
};
