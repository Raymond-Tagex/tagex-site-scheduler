# O&M Site Visit Scheduler — access control inventory

**Status:** Gate document. Nothing changed yet.
**Date:** 2026-08-31
**Read in full:** `index.html` (1,916 lines), `vercel.json`, `.gitignore`, `.vercelignore`,
`.vercel/project.json`, `.env.local`.

---

## 1. What this application is

**TAGEX O&M · Site Visit Scheduler** — a single 1,916-line `index.html`, no server code at all.
`vercel.json` serves it statically and rewrites everything to `/index.html`.

Two modules share one file and one token:

| Module | Lines | Purpose |
|---|---|---|
| Scheduler | ~510–1370 | Month / week / day calendar of site visits, create and reschedule |
| O&M Tickets | ~1375–end | Job card ticket list, embedded in the scheduler shell |

Tabs: `dashboard`, `calendar`, `omtickets`.

Deployed as its **own Vercel project** — `tagex-merged-om-scheduler`
(`prj_KPrXOEJssDbQebQp1DNEF9R6FMX5`), same org as the delivery app.

---

## 2. Every place the browser talks to Airtable

Seven call sites, all in `index.html`, all sending the user's PAT as
`Authorization: Bearer ${PAT}`.

| # | Line | Function | Op | Table | Purpose |
|---|---|---|---|---|---|
| 1 | 597 | `atGet` | GET list | any of `T.*` | Paged read, all four scheduler tables |
| 2 | 611 | `atCreate` | POST | `T.visits` / `T.activity` | Create a site visit, write an activity entry |
| 3 | 619 | `atUpdate` | PATCH | `T.visits` | Reschedule / cancel a visit |
| 4 | 1411 | `omCreate` | POST | `OM_T.*` | Tickets module create |
| 5 | 1416 | `omPatch` | PATCH | `OM_T.*` | Tickets module update |
| 6 | 1425 | `omList` (filtered) | GET list | `OM_T.*` | Ticket list with filter/ids |
| 7 | 1435 | `omList` (paged) | GET list | `OM_T.*` | Ticket list, full page walk |

### Bases and tables

**One base only** — `app0tq4y9wH10h6Up` (TAGEX – O&M Platform), declared twice: `BASE`
(line 517) and `OM_BASE` (line 1379).

| Table | ID | Used by | Ops |
|---|---|---|---|
| Site Visits | `tblny4UUKq8OIHQlw` | Scheduler | list, create, update |
| Job Cards | `tbl2wqnfM0eDa8M7P` | Both | list |
| Activity Log | `tblWSJlbiGWlZ6yGL` | Both | list, create |
| People | `tblYXKBqfN4zituh1` | Scheduler | list |
| Clients | `tblljzSDboKGUJAXg` | Tickets | list |

The tickets module refers to People as `PPL: 'People'` — a table **name**, not an id. Airtable
accepts either; the proxy's symbol whitelist makes the distinction moot.

**All five tables and the base are already in the delivery app's whitelist**
(`api/_lib/tables.js`). No new Airtable infrastructure is required for this migration.

---

## 3. Current authentication

The same model the delivery app has just retired:

- A gate screen takes a pasted Airtable PAT (`doConnect`, line ~1342).
- Stored in `localStorage` as **`tagex_pat`** when "remember" is ticked; auto-connects on
  next load (line 1338).
- **Identity is a `prompt()` box.** On first connect the app asks "Your name" and stores the
  answer in `localStorage` as **`tagex_user`** (line 1350). That free-text string is written to
  `Created By` on every site visit and quoted in activity log entries.
- "Disconnect" clears `tagex_pat` and reloads.

So the record of who scheduled a visit is whatever the person typed into a JavaScript prompt,
on a device anyone can use. It is not an identity, and it cannot be relied on.

---

## 4. Blocker — the app addresses fields by ID, not by name

**This is the finding that most affects the work.**

Every read requests `returnFieldsByFieldId=true` (5 occurrences), and the code hard-codes
**39 distinct field IDs**:

```js
const F = {
  subject:"fldl6AeZcPmO9gVj9", jobcard:"fldgtKHwY1VcJHT0s",
  start:"fldDB3DUqHvADw0op", tech:"fld7pIfI0kICxP61v", …
};
```

So Airtable returns `{ "fldDB3DUqHvADw0op": "2026-06-10T08:00Z" }`, not
`{ "Start DateTime": "…" }`.

The permission engine denies fields **by name** — `deny_read: ["Unit Cost"]`. Pointed at a
field-ID response it would match nothing and **strip nothing**, silently. A role denied a field
would receive it anyway, and the failure would be invisible.

Three ways out:

| Option | Cost | Verdict |
|---|---|---|
| **A. Teach the proxy field IDs** — resolve id ↔ name from the cached schema, apply rules to both forms | ~half a day, touches `at.js` and `permissions.js` in the delivery app | **Recommended.** Fixes it for every future app, and the schema cache already exists |
| B. Reject `returnFieldsByFieldId` at the proxy and rewrite the app to use names | Large refactor of 39 constants and all consuming code | High risk of behavioural regression for no security gain |
| C. Ignore it | — | Not an option. It defeats field-level permissions entirely |

Option A is a change to the **delivery app's shared code**, which is production-bound. It needs
sign-off before starting.

---

## 5. Other findings

**`typecast` on writes.** `atCreate` and `atUpdate` take a `typecast` flag and `saveVisit`
passes `true` (line 1011). The proxy does not support typecast — writes are validated against
the live schema instead. Expect writes that previously succeeded by silent coercion to start
failing with a named field. That is the intended behaviour, but it will look like a regression
during testing.

**Auto-refresh polling.** `startAutoRefresh` (line 666) runs a `setInterval` that re-reads
every table. Two consequences: it multiplies audit volume, and it can approach the proxy's
120 requests/minute per-session rate limit with several tabs open. The tiered audit design
already handles the first; the polling interval should be checked against the second.

**CSP surface is larger than the delivery app's.** 46 inline `on*=` handlers (the delivery app
had 24), one inline `<script>`, one inline `<style>`. A strict `script-src` requires removing
all of them. External origins are just `fonts.googleapis.com` — no CDN scripts, so that side is
simpler.

**`.env.local`** holds one variable, `VERCEL_OIDC_TOKEN`, a Vercel development JWT that
**expired 2026-08-20** (11 days ago). No Airtable token, no secrets. `.gitignore` covers
`.env*`. Nothing to rotate.

**No serverless functions exist.** `vercel.json` is static-only. Adding `api/` introduces
functions for the first time; the architecture needs 5, against the Hobby plan's limit of 12.

**Identity written to data.** `Created By` on Site Visits (`fldNj9om7JzeyY1Uy`) currently holds
the `tagex_user` free-text string. After migration it should hold the session email. Historic
records keep whatever was typed.

---

## 6. Proposed whitelist

No new entries needed — the delivery app's map already covers all of it:

```js
job_cards:    { CI: 'tbl2wqnfM0eDa8M7P', OM: 'tbl2wqnfM0eDa8M7P' },   // ✓ already present
activity_log: { CI: 'tblWSJlbiGWlZ6yGL', OM: 'tblWSJlbiGWlZ6yGL' },   // ✓
people:       { CI: 'tblYXKBqfN4zituh1', OM: 'tblYXKBqfN4zituh1' },   // ✓
clients:      { CI: 'tblljzSDboKGUJAXg', OM: 'tblljzSDboKGUJAXg' },   // ✓
site_visits:  { CI: 'tblXDw1aHzkItZEV3', OM: 'tblny4UUKq8OIHQlw' },   // ✓
```

Existing role permissions already cover the operations this app performs:

| Module | Op needed | Admin | Ops/PM | Technician | Warehouse |
|---|---|---|---|---|---|
| `site_visits` | list, create, update | ✓ | ✓ | ✓ own | **denied** |
| `job_cards` | list | ✓ | ✓ | ✓ assigned | ✓ |
| `activity_log` | list, create | ✓ | ✓ | ✓ own | ✓ |
| `people` | list | ✓ | ✓ | ✓ | ✓ name only |
| `clients` | list | ✓ | ✓ | ✓ contact only | ✓ name+site |

A Warehouse user signing in would get the app shell with no calendar — `site_visits` is denied
for that role. That is correct, but it should be a clear message rather than an empty screen.

---

## 7. Decisions required before any work starts

1. **Merge into the delivery app, or keep separate?** (see the two options discussed with the
   request)
2. **Approve the field-ID work in the shared proxy code** (§4 option A).
3. **Confirm no new Airtable bases, tables or fields** are to be created — the inventory says
   none are needed.
