# TAGEX O&M — Application Overview

**Site Visit Scheduler · Tickets · Site Information · Admin**
Deployed on Vercel (static files + Node 24 serverless functions), data in Airtable.
Project: `tagex-merged-om-scheduler`. Trunk branch: `claude/delivery-status-mismatches-hq3pfj`.

This document describes what the application does, how it is built, and the rules it enforces.
For the binding engineering rules see [CLAUDE.md](CLAUDE.md); for setup and environment variables
see [README.md](README.md); for end users see `docs/USER-MANUAL.html` and
`docs/OPERATING-MANUAL.html`.

---

## 1. What it is

The O&M team's working tool for solar and battery sites:

- **Plan site visits** for technicians on a calendar, with conflict detection.
- **Raise and run service tickets** from first contact to closure, including spares and monitoring.
- **Keep a permanent profile of every site** — the system, its equipment, its documents and photos —
  so each job card does not have to ask for the same information again.
- **Print the paperwork** — job card forms, ticket forms, service ticket reports, ticket lists and
  site reports — built on the server from the record, never from what the browser claims.
- **Separate FICA / personal documents** out of scanned site packs and store them in a restricted
  table only two-flag Admins can open.

It shares its identity and permission model with the **TAGEX Delivery Note app**: same users, same
roles, same password, separate sessions (cookies are per-domain).

---

## 2. Modules

The shell (`public/js/shell.js`) owns the top-level switch and starts each module lazily, the first
time its tab is opened. Tabs a role cannot use are hidden — as a courtesy only; the server refuses
regardless.

### 2.1 Scheduler (`public/js/mod-scheduler.js`)

| View | What it does |
|---|---|
| **Calendar** | Month / week / day view of Site Visits. Create, edit and reschedule visits; assign technicians; flags double-booking of a technician across active visits (Scheduled, Confirmed, In Progress) and requires an explicit override. |
| **Dashboard** | Active and upcoming visits, job card list with status chips, owner category, search and sort. |
| **O&M Tickets** | Ticket board and detail pages (see below). |

**Base selection.** The scheduler works in one base at a time — **O&M** or **RES** (residential) —
chosen per browser (`tagex_sched_base` in localStorage). Changing it **reloads the page** so a
record id read in one base can never be written into the other. The server re-checks the base on
every request (`SCHEDULER_BASES` in `api/_lib/tables.js`).

**Visit vocabulary.** Priorities: Low, Normal, High, Urgent. Visit types and statuses are colour
coded; `scripts/verify-selects.js` checks every list against the live Airtable select options.

**Tickets.**

- Statuses: New → Assigned → In Progress → Awaiting Spares / Awaiting Client → Visit Scheduled →
  Second Visit Required / Scheduled → Resolved → Monitoring → Closed (or Cancelled).
- Categories: Inverter Fault, Battery Fault, Grid / Eskom Fault, Solar Production Issue,
  Communication Failure, Monitoring Offline, Preventative Maintenance, Emergency Callout,
  Warranty Claim, General Support.
- Channels: WhatsApp, Email, Phone Call, Site Walk-in, Portal / Monitoring Alarm, Internal.
- **Monitoring**: a ticket under Monitoring carries a flag on its card, its page and in a count
  beside Tickets. Once the end date (South African time, whole day) has passed the flag turns red.
- **Spares**: parts are chosen from the Palladium Stock Master (loaded once, on first use) and can
  be requested on a visit or on a ticket without a visit. Spares already requested on the ticket
  are shown and adopted by the next visit, so they are not ordered twice.
- A job card that was never recorded can be attached to a ticket afterwards.
- Ticket numbering (`Seq` autoNumber → `Ticket Ref` formula) cannot be rewritten; lists order by
  creation.

**Printed forms are made when the record is.** Every job card and ticket raised in the scheduler
gets its printed form immediately (`omAutoForm`): built on the server, filed in Documents against
the job card, and downloaded. A ticket raised by booking a visit is filed but not downloaded.
Reprints from the Print buttons are never filed.

### 2.2 Site Information (`public/js/mod-siteinfo.js`)

The persistent profile of a site and its system. Detail tabs: **Overview · Client & Site · System ·
Equipment · O&M · Documents · Photos · History.** Documents carry a status of Complete, Missing,
Pending or Not Applicable.

It carries **no financial or FICA data** — by design, not omission. Ways in:

| Route | File | What it does |
|---|---|---|
| New Site form | `mod-siteinfo.js` | Hand entry. |
| **CSV import** | `siteinfo-import.js` | Maps spreadsheet columns to fields, drops anything that looks like FICA/financial data, validates select values before sending, marks duplicates (client+site, job card, SUB/SOL) and skips them unless included. |
| **Build from a folder** | `siteinfo-batch.js` | Drop a site's folder; the job card is read by OCR, Airtable is asked what it already knows, and a complete record is **proposed**. Nothing is written until the review is confirmed; then every file is attached. |
| **Split a PDF** | `siteinfo-split.js` | Renders every page of a scanned pack, gets a FICA / other / unsure verdict per page, and has a person confirm each. FICA pages go to the restricted FICA Documents table; the rest go through the normal import flows. |
| Site Report | `api/siteinfo-report.js` | Compiles a Scope of Work / Site Report PDF from confirmed values; it is then uploaded like any other document. |

**Precedence: Airtable wins.** An existing site is the authority on itself, then its job card, then
its client record, and only then OCR — and only into blank fields. Disagreements are shown as
conflicts for a person to settle.

### 2.3 Admin (`public/js/mod-admin.js`)

Rendered only for a session that can manage users — the markup is never inserted otherwise.

- **Users** — create, invite, disable, change access level.
- **Roles** — permission editor for each access level, module by module.
- **Audit** — audit log viewer.

Lockout invariants (e.g. never removing the last Admin) are enforced server-side in
`api/_lib/guards.js`.

---

## 3. Architecture

```
Browser (static, strict CSP)                  Vercel serverless (Node 24)            Airtable
─────────────────────────────                 ────────────────────────────           ─────────
index.html, core.js (TX.api)   ── cookie ──▶  /api/auth/*   login, MFA, invites ──▶  IAM base
shell.js → mod-scheduler.js                   /api/at       THE proxy          ──▶  CI / OM / RES
         → mod-siteinfo.js                    /api/jobcard-form, /api/ticket-report
         → mod-admin.js                       /api/siteinfo-ocr     (writes nothing)
pdfpages.js (pdf.js, vendored)                /api/siteinfo-upload  (FICA classifier)
                                              /api/siteinfo-report  (writes nothing)
                                              /api/fica-docs        (restricted)
```

### 3.1 Airtable bases

| Symbol | Base | Use |
|---|---|---|
| `CI` | TAGEX – C&I Operations Platform | Commercial & industrial; has its own scheduler |
| `OM` | TAGEX – O&M Platform | Scheduler, tickets, site information, FICA Documents |
| `RES` | Residential | Structure-only duplicate of O&M, same table and field ids (`mirrorOmToRes`) |
| `IAM` | TAGEX – Identity & Access | Users, Access Levels, Sessions, Audit Log |

The client only ever names **symbols** (`OM`, `job_cards`), never raw `app…`/`tbl…`/`fld…` ids.
Tables whitelisted in `api/_lib/tables.js` include: site_visits, tickets, job_cards, clients, people,
documents, site_information, site_equipment, activity_log, costing, stock_items,
restricted_personal (O&M only), plus the delivery-app tables and the IAM tables. Field-name
differences between C&I and O&M are handled by `FIELD_ALIASES`.

### 3.2 API endpoints

| Endpoint | Purpose | Writes? |
|---|---|---|
| `POST /api/at` | The only route to Airtable for ordinary reads/writes. | Yes, permission-checked |
| `/api/auth/<action>` | login, logout, me, invite, accept-invite, set/reset/forgot/change-password, mfa — one function, handlers in `api/_auth/`. | Identity only |
| `POST /api/jobcard-form` | Printed TAGEX job card from a record id; optionally files a copy. | Optional filing |
| `POST /api/ticket-report` | Service Ticket Report, the ticket list as PDF, or the ticket form. | Optional filing |
| `POST /api/siteinfo-ocr` | Reads a document + Airtable, returns a **proposal**. | **No** |
| `POST /api/siteinfo-upload` | Attaches a photo/document to a site after the FICA classifier. | Yes |
| `POST /api/siteinfo-report` | Compiles the site report PDF. | **No** |
| `POST /api/fica-docs` | `classify` (writes nothing, returns no text), `create`, `attach`, `index`, `open`. | Restricted |

Underscored folders (`api/_lib`, `api/_auth`) are plain modules, not functions — the Hobby plan caps a
deployment at twelve functions, which is why several outputs share one endpoint.

### 3.3 `/api/at` enforcement order

0. Reject any raw `app…`/`tbl…`/`fld…` id in the body (before auth, so it is not an oracle).
1. Verify the session cookie — signature, absolute expiry, idle timeout.
2. Load user and role; Status must be Active.
3. Resolve base/table symbols against the whitelist (deny by default).
4. Check module + operation against the role's Permissions, then per-user Overrides.
5. Reads: AND-in the record scope, strip `deny_read` and over-sensitivity fields; refuse a filter or
   sort on a hidden field (`filter_on_denied_field`).
6. Writes: reject `deny_write`, unknown and computed fields by name; validate against the schema.
7. Deletes: soft-delete only (nothing is ever deleted — cancellation is a status).
8. Execute with the service PAT.
9. Audit — allowed **and** denied, with old → new on updates.

---

## 4. Access levels

| Access level | Summary |
|---|---|
| Admin / Director | Everything; MFA mandatory; FICA only with the per-user flag as well |
| Operations Manager | Full operational access across scheduler, tickets, site information |
| Project Manager | As Operations Manager, narrower on costing/delivery editing |
| RMA Supervisor | Ticket and RMA-related work without costing or delivery editing |
| Technician / Field | Own visits and job cards (scope injected server-side); can raise tickets |
| Warehouse / Stores | No scheduler access — sees a plain "no access" panel |
| Driver, Site Installer | Delivery-app signature roles |

**Job card money is for four people.** Every role's `job_cards` rule denies Budget, Actual Cost,
Project Value, Cost Exposure, Cost Variance %, Total BOM Value and PDF: Financial Summary. Only the
named individuals see them, through a per-person override on the delivery app's Costing tab.

Details: `docs/ACCESS-LEVELS-RMA.md`, `docs/access-levels/*.permissions.json`,
`ACCESS-CONTROL-INVENTORY.md`.

---

## 5. Security and privacy rules

1. **No Airtable token in the browser.** One PAT, server-side in `AIRTABLE_PAT`; the browser holds an
   HttpOnly session cookie only.
2. **Deny by default** — unlisted modules, tables and fields are refused.
3. **Enforced on the server** — UI checks are cosmetic.
4. **Passwords are hashed**, never recoverable, never in Airtable, logs or email.
5. **FICA / personal data (POPIA)** — Admin-only, gated by role *and* per-user flag, every view
   audited, never in a list, export or URL. Sessions that read it drop to a 15-minute idle timeout.
6. **MFA mandatory for Admin**; generic auth errors (no user enumeration); account lockout after 5
   attempts for 15 minutes.
7. **Strict CSP** (`script-src 'self'`), HSTS, `frame-ancestors 'none'`, no-store on `/api/*`. That
   is why pdf.js and the Tesseract language data are vendored rather than loaded from a CDN.

### Document reading is treated as guesswork

- Tesseract reads print, not handwriting; output is always a suggestion.
- The FICA classifier returns **BLOCKED**, **REVIEW** or **ALLOWED**. OCR can only make it stricter;
  an unreadable file reaches REVIEW, never ALLOWED. REVIEW needs explicit confirmation.
- Scanned PDFs are rendered to page images in the browser (`pdfpages.js`) and sampled as the front
  of the document plus a spread through the rest, so a bank statement at the back still gets checked.
- Request bodies are capped by Vercel at ~4.5 MB; photographs are downscaled in the browser
  (2400 px long edge) and FICA pages are attached one page per request.

---

## 6. Printed documents

| Document | Built by | Notes |
|---|---|---|
| Job card form | `api/_lib/jobcardform.js` | Reproduces *TAGEX JOB CARD TEMPLATE SEP2026.docx*; TAGEX logo header |
| Ticket form | `api/_lib/ticketform.js` | Same format as the job card, for a ticket |
| Service Ticket Report | `api/_lib/ticketreport.js` | Per ticket |
| Ticket list | `api/ticket-report.js` | Filter by status/ids/search; sort by ref, date or technician |
| Site report | `api/_lib/sitereport.js` | Scope of Work / Site Report |

Building a form needs the **export** right; filing a copy needs **documents:create**, checked
separately, within the role's sensitivity cap (Confidential once a copy carries costs). One filed copy
per name; a failed upload is retired with Record Status = Deleted. The logo is shipped to the
functions through `includeFiles` in `vercel.json`.

---

## 7. Repository layout

```
api/              one file per endpoint
  _auth/          auth action handlers (bundled into api/auth.js)
  _lib/           tables.js (whitelist), permissions.js, guards.js, audit.js, session.js,
                  crypto.js, ocr.js, pdfimages.js, formfile.js, *form.js / *report.js,
                  assets/ (logo), tessdata/ (OCR language data)
public/           index.html, css/, js/, vendor/ (pdf.js), PWA manifest + service worker
  js/             core.js (shared client, TX.api), login.js, boot.js, shell.js, pick.js
                  (type-to-search pickers), mod-scheduler.js, mod-siteinfo.js,
                  siteinfo-batch.js, siteinfo-import.js, siteinfo-split.js, pdfpages.js,
                  pdfwrite.js, mod-admin.js
scripts/          dev-server, ui-harness, check-config, user management, provisioning and
                  backfill scripts — dry-run by default, --apply to write
test/             verify-*.js (node) and *-harness.html (browser); roles.fixture.json
docs/             user and operating manuals, access-level specs, design notes
legacy/           pre-security original — never deploy (excluded by .vercelignore)
```

---

## 8. Running, testing, deploying

```bash
node scripts/check-config.js        # validate environment and live configuration
node scripts/dev-server.js 3210     # local server on http://localhost:3210 (reads .env.local)
npm test                            # ten node suites; verify-part-c needs AIRTABLE_PAT
node scripts/ui-harness.js          # browser harnesses at http://localhost:4321/test/<name>.html
vercel --prod                       # deploy — ask first
```

Environment variables: `AIRTABLE_PAT`, `JWT_SECRET` (different from the delivery app's),
`APP_ORIGIN`, `AUTH_MODE=session`, `SESSION_TTL_HOURS`, `IDLE_TIMEOUT_MINUTES`,
`REQUIRE_ADMIN_MFA`, `FROM_EMAIL`, `RESEND_API_KEY` (optional). See `.env.example` for
placeholders — never put a real value there.

`test/verify-res-mirror.js` compares the live O&M and RES schemas and fails when they drift; a table
or field added to O&M must be added to RES by hand in Airtable.

---

## 9. Users and roles in one place

Users are created and disabled in the delivery app's **Admin → Users** screen, this app's Admin
module, or `node scripts/manage-users.js`. A change in one takes effect in both apps, because both
read the same Identity & Access base.
