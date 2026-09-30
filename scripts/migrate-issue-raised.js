#!/usr/bin/env node
/**
 * Bring the tickets raised through the OLD form across into the Tickets table.
 *
 *   node scripts/migrate-issue-raised.js            # dry run, writes nothing
 *   node scripts/migrate-issue-raised.js --apply
 *
 * WHAT THIS IS
 *
 * Before Tickets existed, the "+ New Ticket" form wrote nothing but an Activity Log entry of
 * type "Issue Raised", with the category, priority, subject, description, asset, error code
 * and reporter concatenated into one note. Those are the only record of seven real faults.
 *
 * WHAT IT WILL NOT TOUCH
 *
 * There are 68 "Issue Raised" entries and only seven came from that form. The rest are
 * ordinary Airtable-side notes — "Residential Install", "Record change… Title: Inst" — and
 * they are not tickets. This takes only entries that carry BOTH the "[Category] [Priority]"
 * opening AND the form's own footer, because either one alone would sweep in notes somebody
 * happened to type in that shape.
 *
 * WHAT CANNOT BE RECOVERED, AND IS NOT INVENTED
 *
 *   Job card       — the old form asked for one and then did not save it. Every one of these
 *                    entries has an empty link. Where the note names a reference in its text
 *                    and exactly one job card matches, it is linked; otherwise it is left
 *                    blank for a person to attach.
 *   Source channel — the field did not exist. Left blank rather than guessed.
 *   Status         — these are months old and presumably long dealt with, so they come in as
 *                    Closed. A migration that filled the Open list with historic faults would
 *                    make the one number on the Tickets tab meaningless.
 *
 * THE ORIGINAL ENTRY IS KEPT. Rather than writing a new "migrated" note, the existing Activity
 * Log row is pointed at the new ticket, so the ticket opens showing the words that were
 * actually written at the time. Nothing is deleted and no note is rewritten.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = 'app0tq4y9wH10h6Up';          // TAGEX – O&M Platform
const T_ACT = 'tblWSJlbiGWlZ6yGL';
const T_TKT = 'tbln5V2ynpBY9sIOc';
const T_JC = 'tbl2wqnfM0eDa8M7P';

const APPLY = process.argv.includes('--apply');

// The ten the form offered, which are the ten the Fault Category select still holds.
const CATEGORIES = new Set(['Inverter Fault', 'Battery Fault', 'Grid / Eskom Fault',
  'Solar Production Issue', 'Communication Failure', 'Monitoring Offline',
  'Preventative Maintenance', 'Emergency Callout', 'Warranty Claim', 'General Support']);
const PRIORITIES = new Set(['Low', 'Normal', 'High', 'Urgent']);

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
  const body = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : {};
}

/** Every record in a table. A page that fails is an error, never a short list. */
async function all(tableId, params = {}) {
  const out = [];
  let offset = null;
  do {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/${tableId}`);
    u.searchParams.set('pageSize', '100');
    for (const [k, v] of Object.entries(params)) {
      // Airtable wants fields as repeated fields[] parameters; a single "fields" string is a
      // 422 with no explanation of which parameter it disliked.
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k + '[]', x));
      else u.searchParams.set(k, v);
    }
    if (offset) u.searchParams.set('offset', offset);
    const d = await api(u);
    out.push(...d.records);
    offset = d.offset || null;
  } while (offset);
  return out;
}

const sel = (v) => (v && typeof v === 'object' && v.name ? v.name : String(v || ''));

/**
 * Pull a ticket out of one of the old notes.
 *
 * The form wrote: "[Category] [Priority] Subject", then optional Description / Asset / Error /
 * Reported by lines, then its own footer. Two variants of the field labels exist because the
 * wording changed at some point; both are read.
 */
function parseNote(text) {
  const t = String(text || '');
  const head = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*([^\n]*)/.exec(t);
  if (!head) return null;

  const line = (labels) => {
    for (const label of labels) {
      const m = new RegExp('^\\s*' + label + '\\s*:\\s*(.+)$', 'mi').exec(t);
      if (m) return m[1].trim();
    }
    return '';
  };

  return {
    category: head[1].trim(),
    priority: head[2].trim(),
    subject: head[3].trim(),
    description: line(['Description']),
    asset: line(['Asset', 'Asset / Inverter']),
    errorCode: line(['Error', 'Error Code']),
    reportedBy: line(['Reported by', 'Reported By']),
  };
}

/** A job card reference mentioned in the text, when exactly one real card matches it. */
function jobCardFrom(text, byRef) {
  const found = new Set();
  const re = /\b(OM|JC)[-\s]?\d{4}[-/][^\s,;|]*/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const key = m[0].trim().toUpperCase().replace(/[.,;:]+$/, '');
    if (byRef[key]) found.add(byRef[key]);
  }
  return found.size === 1 ? [...found][0] : null;
}

(async () => {
  const [acts, tickets, jobcards] = await Promise.all([
    all(T_ACT, { filterByFormula: '{Action Type}="Issue Raised"' }),
    all(T_TKT),
    all(T_JC, { fields: ['JC Reference'] }),
  ]);

  const byRef = {};
  for (const jc of jobcards) {
    const ref = String(jc.fields['JC Reference'] || '').trim().toUpperCase();
    if (ref) byRef[ref] = jc.id;
  }

  // Both marks required: the bracketed head AND the form's footer.
  const FOOTER = /TAGEX O&M Ticket System/i;
  const fromForm = acts.filter((r) => {
    const n = r.fields.Update || '';
    return /^\[[^\]]+\]\s*\[[^\]]+\]/.test(n) && FOOTER.test(n);
  });

  console.log(`${acts.length} "Issue Raised" entries; ${fromForm.length} came from the ticket form.\n`);

  // Anything already linked to a ticket has been migrated. Re-running is safe.
  const existingSubjects = new Set(tickets.map((t) => (
    String(t.fields.Subject || '').trim().toLowerCase() + '|' + String(t.fields['Reported At'] || '').slice(0, 10)
  )));

  let made = 0;
  let linked = 0;
  const skipped = [];

  for (const rec of fromForm) {
    const note = rec.fields.Update || '';
    const p = parseNote(note);
    if (!p) { skipped.push(`${rec.id}: could not be read`); continue; }

    if ((rec.fields.Ticket || []).length) {
      skipped.push(`${rec.id}: already points at a ticket`);
      continue;
    }
    const key = p.subject.toLowerCase() + '|' + rec.createdTime.slice(0, 10);
    if (existingSubjects.has(key)) { skipped.push(`${rec.id}: a ticket already exists for it`); continue; }

    if (!CATEGORIES.has(p.category)) { skipped.push(`${rec.id}: unknown category "${p.category}"`); continue; }
    if (!PRIORITIES.has(p.priority)) { skipped.push(`${rec.id}: unknown priority "${p.priority}"`); continue; }
    if (!p.subject) { skipped.push(`${rec.id}: no subject`); continue; }

    const jcId = (rec.fields['Job Card'] || [])[0] || jobCardFrom(note, byRef);

    // Provenance on the record itself, in the words a reader needs: this did not come in
    // through the current form, and two of its fields were never captured.
    const provenance = 'Migrated from the O&M Activity Log (Issue Raised, '
      + rec.createdTime.slice(0, 10) + '). The form that created it did not record a source '
      + 'channel' + (jcId ? '' : ' or a job card') + '.';

    const fields = {
      'Fault Category': p.category,
      Priority: p.priority,
      Subject: p.subject,
      Description: (p.description ? p.description + '\n\n' : '') + provenance,
      Status: 'Closed',
      'Reported At': rec.createdTime,
      'Closed At': rec.createdTime,
      'Created By': 'migrated',
    };
    if (p.asset) fields['Asset / Inverter'] = p.asset;
    if (p.errorCode) fields['Error Code'] = p.errorCode;
    if (p.reportedBy) fields['Reported By'] = p.reportedBy;
    if (jcId) fields['Job Card'] = [jcId];

    const jcLabel = jcId
      ? Object.keys(byRef).find((k) => byRef[k] === jcId)
      : '\x1b[33mnone — attach one by hand\x1b[0m';
    console.log(`  ${rec.createdTime.slice(0, 10)}  [${p.category}] [${p.priority}] ${p.subject.slice(0, 60)}`);
    console.log(`      job card: ${jcLabel}`);

    made++;
    if (APPLY) {
      const created = await api(`https://api.airtable.com/v0/${BASE}/${T_TKT}`, {
        method: 'POST',
        body: JSON.stringify({ fields }),
      });
      const id = created.id;
      // The original note becomes the ticket's first activity entry. Nothing is rewritten:
      // the row gains a link and keeps every word it had.
      await api(`https://api.airtable.com/v0/${BASE}/${T_ACT}/${rec.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields: { Ticket: [id] } }),
      });
      linked++;
      console.log(`      -> ${created.fields['Ticket Ref'] || id}`);
    }
  }

  console.log('');
  if (skipped.length) {
    console.log('Left alone:');
    skipped.forEach((s) => console.log('   ' + s));
    console.log('');
  }
  if (!APPLY) {
    console.log(`${made} ticket(s) would be created, each linked back to the entry it came from.`);
    console.log('DRY RUN — nothing was written. Re-run with --apply.');
  } else {
    console.log(`Done. ${made} ticket(s) created, ${linked} original entries pointed at them.`);
  }
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
