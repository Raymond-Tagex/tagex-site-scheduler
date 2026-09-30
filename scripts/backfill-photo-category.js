#!/usr/bin/env node
/**
 * Backfill "Photo Category", and correct a Document Type that was never chosen.
 *
 *   node scripts/backfill-photo-category.js            # dry run — reports, writes nothing
 *   node scripts/backfill-photo-category.js --apply
 *   node scripts/backfill-photo-category.js --apply --base OM
 *
 * WHY THIS EXISTS
 *
 * Until now the uploader hard-coded 'Document Type' to "Site Photos" for every file and put the
 * chosen category into the front of the Notes string:
 *
 *     "After — H68 BOERDERYE/Site photos/…pic10.jpeg — Uploaded by raymond@tagexenergy.co.za"
 *
 * So the information is not lost, it is just in the wrong place — and a BOM spreadsheet is
 * currently filed as a photograph. This reads the category back out of Notes and writes it to
 * the field, and re-types the records that are plainly not photographs.
 *
 * WHAT IT WILL NOT DO
 *
 * It never guesses. A record whose Notes do not start with a known category is left alone and
 * reported, because "Other" asserted over an unknown is worse than an empty cell: an empty cell
 * says nobody knows, and "Other" says somebody decided.
 *
 * It never overwrites a Photo Category that is already set — including one a person has just
 * fixed by hand in the app.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASES = { CI: 'appfzAX5YHqg4UXCl', OM: 'app0tq4y9wH10h6Up' };
const DOCS_TABLE = 'tbljdfGLoiHlrdzfs';

const PHOTO_CATEGORIES = ['Site', 'Roof', 'PV Panels', 'Inverter', 'Battery', 'DB',
  'Electrical', 'Meter', 'Equipment', 'Defect', 'Before', 'After', 'Other'];

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ONLY = (args[args.indexOf('--base') + 1] || '').toUpperCase();

function pat() {
  for (const f of ['.env.local', '.env']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, 'utf8').match(/^AIRTABLE_PAT=(.*)$/m);
    if (m && m[1].trim()) return m[1].trim();
  }
  if (process.env.AIRTABLE_PAT) return process.env.AIRTABLE_PAT;
  console.error('No AIRTABLE_PAT found in .env.local, .env or the environment.');
  process.exit(1);
}
const PAT = pat();

async function api(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

/** Every record in a table, following Airtable's pagination. */
async function allRecords(baseId) {
  const out = [];
  let offset = '';
  do {
    const url = `https://api.airtable.com/v0/${baseId}/${DOCS_TABLE}?pageSize=100`
      + (offset ? `&offset=${offset}` : '');
    const page = await api(url);
    out.push(...page.records);
    offset = page.offset || '';
  } while (offset);
  return out;
}

/**
 * The category the uploader wrote into Notes, if it is unambiguously there.
 *
 * The format is "<Category> — <filename> — Uploaded by <email>". Only the first segment is
 * considered, and only when it matches a known category exactly: a Notes field somebody has
 * since typed a sentence into must not be mined for words that look like categories.
 */
function categoryFromNotes(notes) {
  const first = String(notes || '').split('—')[0].trim();
  if (!first) return null;
  return PHOTO_CATEGORIES.find((c) => c.toLowerCase() === first.toLowerCase()) || null;
}

const isImage = (rec) => {
  const f = (rec.fields.File || [])[0];
  return !!f && /^image\//i.test(f.type || '');
};

const hasFile = (rec) => !!(rec.fields.File || []).length;

function plan(records) {
  const rows = [];
  for (const rec of records) {
    const f = rec.fields;
    const already = f['Photo Category'];
    const type = (f['Document Type'] && f['Document Type'].name) || f['Document Type'] || '';
    const fromNotes = categoryFromNotes(f.Notes);
    const patch = {};
    const why = [];

    // 1. The category, recovered from Notes. Never over an existing value.
    if (!already && isImage(rec) && fromNotes) {
      patch['Photo Category'] = fromNotes;
      why.push(`category "${fromNotes}" from Notes`);
    }

    // 2. A non-image filed as a photograph. This is the BOM-in-the-gallery problem, and the
    //    honest correction is "Other" — the script cannot know it is a SOW rather than a quote.
    if (hasFile(rec) && !isImage(rec) && /Photos$/.test(type)) {
      patch['Document Type'] = 'Other';
      why.push(`not an image, but typed "${type}"`);
    }

    // 3. An image whose recovered category is Before/After but whose type says otherwise.
    if (isImage(rec) && fromNotes === 'Before' && type !== 'Before Photos') {
      patch['Document Type'] = 'Before Photos';
      why.push(`marked Before, typed "${type}"`);
    }
    if (isImage(rec) && fromNotes === 'After' && type !== 'After Photos') {
      patch['Document Type'] = 'After Photos';
      why.push(`marked After, typed "${type}"`);
    }

    if (Object.keys(patch).length) rows.push({ rec, patch, why });
  }
  return rows;
}

function report(label, records, rows) {
  const images = records.filter(isImage).length;
  const unreadable = records.filter((r) => isImage(r) && !r.fields['Photo Category']
    && !categoryFromNotes(r.fields.Notes));

  console.log(`\n=== ${label} ===`);
  console.log(`  ${records.length} document(s), ${images} image(s)`);
  console.log(`  ${records.filter((r) => r.fields['Photo Category']).length} already have a category`);
  console.log(`  ${rows.length} would be changed`);

  const byReason = {};
  for (const r of rows) for (const w of r.why) {
    const key = w.replace(/"[^"]*"/g, '"…"');
    byReason[key] = (byReason[key] || 0) + 1;
  }
  for (const [k, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(n).padStart(4)}  ${k}`);
  }

  console.log(`\n  first few:`);
  for (const r of rows.slice(0, 8)) {
    const name = r.rec.fields['Document Name'] || (r.rec.fields.File || [])[0]?.filename || r.rec.id;
    console.log(`      ${String(name).slice(0, 62)}`);
    console.log(`         ${JSON.stringify(r.patch)}   (${r.why.join('; ')})`);
  }

  if (unreadable.length) {
    console.log(`\n  ${unreadable.length} image(s) LEFT ALONE — no category recoverable from Notes.`);
    console.log('  These need a person. Use Site Information > Photos > "No category yet".');
  }
}

async function write(baseId, rows) {
  for (let i = 0; i < rows.length; i += 10) {
    const batch = rows.slice(i, i + 10);
    await api(`https://api.airtable.com/v0/${baseId}/${DOCS_TABLE}`, {
      method: 'PATCH',
      body: JSON.stringify({
        records: batch.map((r) => ({ id: r.rec.id, fields: r.patch })),
        typecast: false,
      }),
    });
    process.stdout.write(`\r  written ${Math.min(i + 10, rows.length)} of ${rows.length}…`);
  }
  console.log('');
}

module.exports = { categoryFromNotes, plan, PHOTO_CATEGORIES };

// Required as a module by the test suite; only run when invoked directly.
if (require.main !== module) return;

(async () => {
  let total = 0;
  for (const [symbol, baseId] of Object.entries(BASES)) {
    if (ONLY && ONLY !== symbol) continue;
    const records = await allRecords(baseId);
    const rows = plan(records);
    report(`${symbol} (${baseId})`, records, rows);
    total += rows.length;
    if (APPLY && rows.length) {
      console.log(`\n  applying to ${symbol}…`);
      await write(baseId, rows);
    }
  }

  if (!APPLY) {
    console.log(`\n${total} record(s) would change. DRY RUN — nothing was written.`);
    console.log('Re-run with --apply to write.');
  } else {
    console.log(`\nDone. ${total} record(s) updated.`);
  }
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
