// System specifications out of prose and bills of material.
//
// WHY A SECOND EXTRACTOR
//
// jobcard-parse.js reads FORMS: "Panel Quantity: 164" — a label, a colon, a value. That is the
// right shape for a job card and completely the wrong shape for the two documents that actually
// describe a system:
//
//   an SOW says   "...comprising 15 x JA Solar JAM54S30-545/MR 545W monocrystalline modules"
//   a BOM says    "JA SOLAR 545W MONO PV MODULE | 15 | EA"
//
// Neither has a label to match, so the form parser reads nothing from either. This module finds
// the same facts by recognising the THINGS instead: a manufacturer it knows, a quantity, a model
// code, a power rating.
//
// THE MANUFACTURER LIST IS THE WHOLE TRICK. Knowing "Sungrow" is an inverter brand and "BYD" a
// battery brand is what tells apart three lines that are otherwise identical in shape. It is a
// plain list, kept below, and adding a brand is a one-line change — which is the point: this
// stays inspectable and offline rather than becoming a model that has to be trusted.
//
// EVERYTHING HERE IS A SUGGESTION. Output goes to the same review screen as OCR, ranks below
// anything Airtable already holds, and is never written without a person confirming it.

'use strict';

// Brands seen on South African residential and commercial installations. Order does not matter;
// longer names are matched first so "Canadian Solar" is not read as a stray "Solar".
const BRANDS = {
  pv: ['JA Solar', 'Canadian Solar', 'JinkoSolar', 'Jinko', 'LONGi', 'Longi', 'Trina',
    'Yingli', 'ART Solar', 'Seraphim', 'Risen', 'Astronergy', 'First Solar', 'REC',
    'Q CELLS', 'QCells', 'Hanwha', 'Sunport', 'DAH Solar', 'Leapton'],
  inverter: ['Sungrow', 'GoodWe', 'Goodwe', 'SolarEdge', 'Fronius', 'Huawei', 'SMA', 'Victron',
    'Deye', 'Growatt', 'Solis', 'Kodak', 'Axpert', 'LuxPower', 'Luxpower', 'Sunsynk',
    'Enphase', 'Schneider', 'Must', 'Voltronic', 'RCT', 'Mecer', 'Aelio', 'Solax', 'SolaX'],
  battery: ['BYD', 'Pylontech', 'Freedom Won', 'Hubble', 'Dyness', 'Shoto', 'Greenrich',
    'Revov', 'Blue Nova', 'BlueNova', 'Volta', 'LG Chem', 'Sunsynk', 'Narada', 'Vestwoods',
    'SolarMD', 'Solar MD', 'Ritar', 'Sunwoda', 'Aelio'],
};

// Brand names that are also ordinary English words, or common abbreviations.
//
// "Must" is a real inverter brand. It is also the word in "Any changes must be approved in
// writing by both parties" — which is how a real scope of work ended up proposing Must as the
// inverter manufacturer. These need a rating or a model code beside them before they count.
const AMBIGUOUS = new Set(['Must', 'REC', 'SMA', 'Volta', 'Solis', 'First Solar']);

// Monitoring platforms, which are named rather than measured.
const PLATFORMS = ['SolaX Cloud', 'Solax Cloud', 'iSolarCloud', 'SolarEdge Monitoring', 'mySolarEdge', 'FusionSolar',
  'VRM Portal', 'VRM', 'Sunsynk Connect', 'SEMS Portal', 'SEMS', 'ShinePhone', 'ShineServer',
  'Solis Cloud', 'SolisCloud', 'Enphase Enlighten', 'Enlighten', 'Trannergy', 'Solarman'];

// Words that say what a line is about when no brand is present.
const KIND_WORDS = {
  pv: /\b(pv\s*module|pv\s*panel|solar\s*panel|photovoltaic|module|panel)s?\b/i,
  inverter: /\b(inverter|hybrid\s*inverter)s?\b/i,
  battery: /\b(batter(?:y|ies)|battery[-\s]?box|storage|lithium|bess|lfp|lifepo4)\b/i,
};

// A line that is plainly about cabling, mounting or consumables carries ratings that would
// otherwise be misread as system capacity.
const IGNORE = /\b(cable|cabling|conduit|trunking|bracket|rail|mount|clamp|breaker|fuse|isolator|surge|earth|lug|gland|screw|bolt|sleeve|tape|trench|db\s*board|distribution\s*board)\b/i;

const FIELD = {
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
  monPlatform: 'Monitoring Platform',
  monRef: 'Monitoring Reference',
};

const flat = [];
for (const [kind, names] of Object.entries(BRANDS)) {
  for (const n of names) flat.push({ kind, name: n });
}
flat.sort((a, b) => b.name.length - a.name.length);

/**
 * Does this line look like it is describing equipment at all?
 *
 * A brand name on its own proves nothing — prose is full of words that happen to be brands. A
 * rating, a quantity or an equipment noun is the corroboration.
 */
function looksLikeEquipment(line) {
  if (/\d+(?:[.,]\d+)?\s*(kwp|kwh|kva|kw|wp|w)\b/i.test(line)) return true;
  if (/\d{1,4}\s*[xX×]\s*[A-Za-z]/.test(line)) return true;
  return Object.values(KIND_WORDS).some((re) => re.test(line));
}

/** A brand that doubles as an English word needs a rating or a model code right beside it. */
function ambiguousIsReal(line, name) {
  const at = line.toLowerCase().indexOf(name.toLowerCase());
  if (at < 0) return false;
  const after = line.slice(at + name.length, at + name.length + 24);
  const before = line.slice(Math.max(0, at - 12), at);
  if (/\d+(?:[.,]\d+)?\s*(kwp|kwh|kva|kw|wp|w)\b/i.test(after)) return true;
  if (/\s[A-Z0-9]{2,}[-/]?\d/.test(after)) return true;        // a model code
  if (/\d{1,4}\s*[xX×]\s*$/.test(before)) return true;         // "2 x Must"
  return false;
}

/** Every brand named on a line, longest first, with the kind it belongs to. */
function brandsOn(line) {
  const out = [];
  for (const b of flat) {
    const re = new RegExp('(^|[^A-Za-z])' + b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      + '([^A-Za-z]|$)', 'i');
    if (!re.test(line)) continue;
    // An unmistakable brand — Pylontech, Canadian Solar, Sunwoda — is evidence in itself. Only
    // the names that double as English words have to earn their place.
    if (AMBIGUOUS.has(b.name)
      && !(looksLikeEquipment(line) && ambiguousIsReal(line, b.name))) continue;
    out.push(b);
  }
  return out;
}

/**
 * The quantity on a line, and whether any rating beside it is PER UNIT.
 *
 * "2x Aelio 60kW Hybrid Inverters" is two 60kW units — a 120kW system, not a 60kW one. The
 * multiplier form always means per-unit; a bare "Qty" column does not necessarily.
 */
function quantityInfo(line) {
  let m = /(\d{1,4})\s*[xX×]\s*(?=[A-Za-z])/.exec(line);
  if (m) return { qty: Number(m[1]), perUnit: true, at: m.index };
  // Written-out counts. A real scope of work said "Dual 60kW Aelio inverters" in one section
  // and "2x Aelio 60kW" in another; without this the first one won and recorded a 60kW system
  // where 120kW was installed.
  m = /\b(dual|twin|two)\b(?=[^.]{0,40}?\d)/i.exec(line);
  if (m) return { qty: 2, perUnit: true, at: m.index };
  m = /\b(triple|three)\b(?=[^.]{0,40}?\d)/i.exec(line);
  if (m) return { qty: 3, perUnit: true, at: m.index };
  m = /\b(?:qty|quantity)\b[^0-9]{0,6}(\d{1,4})\b/i.exec(line);
  if (m) return { qty: Number(m[1]), perUnit: false, at: m.index };
  m = /\|\s*(\d{1,4})\s*\|\s*(?:ea|each|no|nr|pcs?|units?)\b/i.exec(line);
  if (m) return { qty: Number(m[1]), perUnit: true, at: m.index };
  return { qty: null, perUnit: false, at: -1 };
}

/** "15 x", "15 ×", "Qty 15", or a bare integer cell in a BOM row. */
function quantityOn(line) {
  let m = /(\d{1,4})\s*[xX×]\s*(?=[A-Za-z])/.exec(line);
  if (m) return Number(m[1]);
  m = /\b(?:qty|quantity)\b[^0-9]{0,6}(\d{1,4})\b/i.exec(line);
  if (m) return Number(m[1]);
  // A bill of materials row: "... | 15 | EA"
  m = /\|\s*(\d{1,4})\s*\|\s*(?:ea|each|no|nr|pcs?|units?)\b/i.exec(line);
  if (m) return Number(m[1]);
  return null;
}

/**
 * Power ratings on a line, by unit.
 * Returns { kWp, kWh, kW, W } with whatever was stated.
 */
function ratingsOn(line) {
  const out = {};
  for (const m of line.matchAll(/(\d+(?:[.,]\d+)?)\s*(kwp|kwh|kva|kw|wp|w)\b/gi)) {
    const n = Number(String(m[1]).replace(',', '.'));
    if (!Number.isFinite(n)) continue;
    const unit = m[2].toLowerCase();
    const key = unit === 'wp' ? 'W' : (unit === 'kva' ? 'kW' : unit.replace('kwp', 'kWp')
      .replace('kwh', 'kWh').replace('kw', 'kW').replace('w', 'W'));
    // Keep the LARGEST of each unit on a line: "5.1 kWh units providing 10.2 kWh" should read
    // the system total, not one module.
    if (out[key] == null || n > out[key]) out[key] = n;
  }
  return out;
}

/**
 * The largest rating of one unit on a line, with where it sits and whether the wording says it
 * is already a TOTAL.
 *
 * Multiplying a per-item rating by the quantity is right for "Dual 60kW inverters" and wrong for
 * "2 x BYD 5.1 units providing 10.2 kWh" — the second already states the system figure. Two
 * signals separate them: a total is usually written BEFORE the count ("a 8.2 kWp system
 * comprising 15 x ...") or introduced by a word like "providing" or "total".
 */
function bestRating(text, unit) {
  let best = null;
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*(kwp|kwh|kva|kw|wp|w)\b/gi)) {
    const raw = m[2].toLowerCase();
    const key = raw === 'wp' ? 'W' : (raw === 'kva' ? 'kW' : raw.replace('kwp', 'kWp')
      .replace('kwh', 'kWh').replace('kw', 'kW').replace('w', 'W'));
    if (key !== unit) continue;
    const value = Number(String(m[1]).replace(',', '.'));
    if (!Number.isFinite(value)) continue;
    if (!best || value > best.value) best = { value, at: m.index };
  }
  if (!best) return null;
  const before = text.slice(Math.max(0, best.at - 28), best.at);
  best.stated = /\b(total|totall?ing|combined|aggregate|providing|provides|giving|delivering|usable|capacity\s+of)\b/i
    .test(before);
  return best;
}

/**
 * A model code: a token with both letters and digits that is not the brand or a bare rating.
 * "JAM54S30-545/MR", "SH8.0RT", "DTSU666".
 */
function modelOn(line, brand) {
  // Only what follows the brand is considered.
  //
  // A bill of materials row begins with the STOCK CODE — "PV-JA-545 | JA SOLAR 545W MONO PV
  // MODULE" — and taking the first token that looks like a model records your own warehouse
  // code as the manufacturer's model. Reading only after the brand finds "JAM54S30-545/MR" in
  // the SOW and, correctly, finds nothing in a BOM row that never names a model. A blank is
  // better than a confident wrong answer.
  let rest = line;
  if (brand) {
    const at = line.toLowerCase().indexOf(brand.toLowerCase());
    if (at < 0) return '';
    rest = line.slice(at + brand.length);
  }

  const tokens = rest.split(/[\s|,;()]+/);
  for (const tRaw of tokens) {
    const t = tRaw.replace(/[.,;]+$/, '');
    if (t.length < 4 || t.length > 28) continue;
    // Two letters at least: "180x" is a quantity and "3-phase" is a description, and both were
    // proposed as models by the first version of this.
    if ((t.match(/[A-Za-z]/g) || []).length < 2 || !/\d/.test(t)) continue;
    if (/^\d+\s*[xX×]$/.test(t)) continue;
    if (/^\d+-?(phase|pole|core|way|wire|year|yr|week|month|day)s?$/i.test(t)) continue;
    if (/^\d+(?:[.,]\d+)?(kwp|kwh|kva|kw|wp|w|v|a|mm|m)$/i.test(t)) continue;  // a rating
    if (/^(19|20)\d{2}$/.test(t)) continue;                                    // a year
    return t;
  }
  return '';
}

/**
 * Split a line into one segment per brand named on it.
 *
 * One SOW sentence routinely describes two products — "1 x Sungrow SH8.0RT inverter coupled to
 * 2 x BYD Battery-Box 5.1 providing 10.2 kWh" — and attributing the whole line to whichever
 * brand matched first loses the other one entirely. Each brand gets the text from its own name
 * up to the next brand.
 */
function segmentsOf(line) {
  const hits = [];
  for (const b of flat) {
    const re = new RegExp('(^|[^A-Za-z])(' + b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      + ')([^A-Za-z]|$)', 'i');
    const m = re.exec(line);
    if (!m) continue;
    if (AMBIGUOUS.has(b.name)
      && !(looksLikeEquipment(line) && ambiguousIsReal(line, b.name))) continue;
    const at = m.index + m[1].length;
    // A longer brand already claimed this position (Canadian Solar before Solar).
    if (hits.some((h) => at >= h.at && at < h.at + h.name.length)) continue;
    hits.push({ at, name: b.name, kind: b.kind });
  }
  if (!hits.length) return [];
  hits.sort((a, b) => a.at - b.at);

  return hits.map((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].at : line.length;
    // Take a little of what precedes the brand too: the quantity lives there ("2 x BYD").
    const from = i === 0 ? 0 : Math.max(hits[i - 1].at, h.at - 24);
    return { kind: h.kind, brand: h.name, text: line.slice(from, end) };
  });
}

/** The first platform named anywhere in the text. */
function platformIn(text) {
  const sorted = PLATFORMS.slice().sort((a, b) => b.length - a.length);
  for (const p of sorted) {
    const re = new RegExp('(^|[^A-Za-z])' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      + '([^A-Za-z]|$)', 'i');
    if (re.test(text)) return p;
  }
  return '';
}

/**
 * Read system specifications out of an SOW, a bill of materials, or any other prose.
 *
 * @param {string} text
 * @returns {{fields:object, equipment:Array, warnings:string[], evidence:Array}}
 */
function extractSpecs(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const found = { pv: null, inverter: null, battery: null };
  const evidence = [];
  const warnings = [];

  for (const line of lines) {
    // A row of cable or brackets carries ratings that would be misread as system capacity —
    // but a prose sentence that merely MENTIONS brackets is still describing the system. So the
    // consumables rule only applies where no manufacturer is named. Applying it to every line
    // threw away the one sentence in the SOW that described the panels.
    const segments = segmentsOf(line);
    if (!segments.length && IGNORE.test(line)) continue;

    // A bill of materials states a rating PER ITEM; prose states the system total. A pipe
    // means this came out of a spreadsheet row.
    const isRow = line.indexOf('|') >= 0;

    const parts = segments.length
      ? segments
      : (() => {
        const k = Object.keys(KIND_WORDS).find((x) => KIND_WORDS[x].test(line));
        return k ? [{ kind: k, brand: '', text: line }] : [];
      })();

    for (const part of parts) {
      const kind = part.kind;
      const qi = quantityInfo(part.text).qty != null ? quantityInfo(part.text) : quantityInfo(line);
      const qty = qi.qty;
      const rate = ratingsOn(part.text);

      const entry = found[kind] || { make: '', model: '', qty: null, kw: null, line };
      if (part.brand && !entry.make) entry.make = part.brand;
      if (!entry.model) {
        const mdl = modelOn(part.text, part.brand);
        if (mdl) entry.model = mdl;
      }
      if (qty != null && entry.qty == null) entry.qty = qty;

      if (entry.kw == null) {
        const unit = kind === 'pv' ? 'kWp' : (kind === 'battery' ? 'kWh' : 'kW');
        const r = bestRating(part.text, unit);
        if (r) {
          let v = r.value;
          // Multiply only when the figure really is per item: a spreadsheet row, or a count
          // written before the rating and not introduced as a total.
          const perItem = isRow
            || (qi.perUnit && qi.at >= 0 && r.at > qi.at && !r.stated);
          if (perItem && entry.qty && entry.qty > 1) {
            const total = Math.round(v * entry.qty * 10) / 10;
            warnings.push('"' + line.slice(0, 60) + '" states ' + v + ' ' + unit
              + ' per item, read as ' + total + ' ' + unit + ' for ' + entry.qty + '. Check it.');
            v = total;
          }
          entry.kw = v;
        }
      }
      // A per-module wattage is not a system size, but with a quantity it implies one.
      if (kind === 'pv' && entry.kw == null && rate.W != null && entry.qty) {
        entry.kw = Math.round((rate.W * entry.qty) / 100) / 10;
        warnings.push('Panel capacity was not stated, so ' + entry.qty + ' x ' + rate.W
          + 'W was read as ' + entry.kw + ' kWp. Check it.');
      }

      found[kind] = entry;
      evidence.push({ kind, line: line.slice(0, 180) });
    }
  }

  const fields = {};
  const put = (k, v) => { if (v !== '' && v != null) fields[k] = v; };

  if (found.pv) {
    put(FIELD.panelMake, found.pv.make);
    put(FIELD.panelModel, found.pv.model);
    put(FIELD.panelQty, found.pv.qty);
    put(FIELD.panelKw, found.pv.kw);
  }
  if (found.inverter) {
    put(FIELD.invMake, found.inverter.make);
    put(FIELD.invModel, found.inverter.model);
    put(FIELD.invQty, found.inverter.qty);
    put(FIELD.invKw, found.inverter.kw);
  }
  if (found.battery) {
    put(FIELD.battMake, found.battery.make);
    put(FIELD.battModel, found.battery.model);
    put(FIELD.battQty, found.battery.qty);
    put(FIELD.battKw, found.battery.kw);
  }

  const platform = platformIn(text);
  if (platform) put(FIELD.monPlatform, platform);

  // A monitoring reference is one of the few things these documents do label.
  const ref = /\bmonitoring\s+(?:reference|ref|id)\b\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9/-]{3,30})/i
    .exec(text)
    || /\b(?:plant|portal)\s+(?:id|reference)\b\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9/-]{3,30})/i.exec(text);
  if (ref) put(FIELD.monRef, ref[1]);

  // Equipment rows, on the same rule the job card parser uses: something substantive, or nothing.
  const equipment = [];
  const addEquip = (type, e) => {
    if (!e) return;
    if (!e.make && !e.model) return;
    const row = { 'Equipment Type': type };
    if (e.make) row.Manufacturer = e.make;
    if (e.model) row.Model = e.model;
    if (e.qty != null) row.Quantity = e.qty;
    equipment.push(row);
  };
  addEquip('PV Module', found.pv);
  addEquip('Inverter', found.inverter);
  addEquip('Battery', found.battery);

  return { fields, equipment, warnings, evidence };
}

module.exports = { extractSpecs, brandsOn, quantityOn, quantityInfo, ratingsOn, modelOn,
  platformIn, looksLikeEquipment, bestRating, AMBIGUOUS,
  segmentsOf,
  BRANDS, PLATFORMS, FIELD, IGNORE };
