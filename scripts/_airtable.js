// Shared by the client-register scripts: the token, a rate-limited call, paging and batching.
// Server code goes through api/_lib/airtable.js; these scripts run on a desk, as the token.

'use strict';

const fs = require('fs');
const path = require('path');

function pat() {
  if (process.env.AIRTABLE_PAT) return process.env.AIRTABLE_PAT;
  const f = path.join(__dirname, '..', '.env.local');
  const m = fs.existsSync(f) && /^AIRTABLE_PAT=(.*)$/m.exec(fs.readFileSync(f, 'utf8'));
  if (!m) throw new Error('AIRTABLE_PAT is not set');
  return m[1].trim().replace(/^"|"$/g, '');
}

let H = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, body) {
  H = H || { Authorization: 'Bearer ' + pat(), 'Content-Type': 'application/json' };
  for (let i = 0; ; i++) {
    const r = await fetch('https://api.airtable.com/v0/' + url, { method, headers: H, body: body && JSON.stringify(body) });
    if (r.status === 429 && i < 5) { await sleep(1000 * (i + 1)); continue; }
    const j = await r.json();
    if (!r.ok) throw new Error(method + ' ' + url + ' -> ' + r.status + ' ' + JSON.stringify(j));
    await sleep(220);                        // five requests a second per base
    return j;
  }
}

async function all(base, table) {
  const out = []; let off = '';
  do {
    const j = await call('GET', base + '/' + table + '?pageSize=100' + (off ? '&offset=' + off : ''));
    out.push(...j.records); off = j.offset || '';
  } while (off);
  return out;
}

/** Create (POST) or update (PATCH) any number of records, ten to a request. */
async function inTens(method, base, table, records) {
  const out = [];
  for (let i = 0; i < records.length; i += 10) {
    const j = await call(method, base + '/' + table, { records: records.slice(i, i + 10), typecast: false });
    out.push(...j.records);
  }
  return out;
}

module.exports = { pat, call, all, inTens, sleep };
