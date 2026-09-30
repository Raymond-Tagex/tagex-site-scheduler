# PROMPT — Add a SITE INFORMATION module to the TAGEX O&M Scheduler

**Target application:** `C:\Projects\tagex-merged-om-scheduler`
**Revision date:** 2026-09-10
**Status of this document:** ready to paste to an AI coding agent.

---

## READ THIS FIRST — corrections to the earlier draft

The previous version of this prompt made several assumptions about the application that are
**not true**. They were checked against the live codebase and the live Airtable schema on
2026-09-10. Getting these wrong would send an agent down the wrong path for hours.

| The earlier prompt assumed | The reality |
|---|---|
| There are three bases: C&I, O&M and **Projects** | There is **no Projects base**. The bases are `CI`, `OM`, `IAM` (identity) and `STK` (stock). "Projects" is a **classification on a job card**, not a base — see below. |
| A framework with components, routing and state management | **No framework and no build step.** `package.json` has **zero dependencies**. Plain HTML plus vanilla JS modules under `public/js/`, loaded with `<script>` tags. |
| Run the build / lint | There is **no build and no lint**. The only scripts are `deploy`, `test`, `check`, `users`. `npm test` runs three assertion suites. |
| "Do not expose Airtable keys in browser code" | Already structurally guaranteed. All traffic goes through `POST /api/at`, which holds the only token. The browser **cannot even name** a base, table or field id — raw `app…`/`tbl…`/`fld…` in a request body is rejected **before authentication**. |
| Build a new FICA/financial classifier | A **sensitivity model already exists**: the `Documents` table has `Sensitivity` (Public/Internal/Confidential/Restricted, where **blank is treated as Restricted**), `Record Status` for soft delete, and the permission engine enforces `sensitivity_max` and a separate, tighter `export_sensitivity_max`. Reuse it. |
| Site photos need a new storage decision | `Documents.File` is already an **Airtable attachment** field, and is the existing pattern. |

### "Projects" is a classification, not a base

Read from the live schema:

```
CI  Job Cards . Installation Category :  Project – Direct Purchase | Project – PPA |
                                         Residential – SUBS | Residential – Direct Purchase
OM  Job Cards . Owner Category        :  PPA | SUB-RES | SUB-C&I | DIRECT-PURC
    Job Cards . Job Type              :  Reactive | Preventative | Project | Maintenance |
                                         Repair | Inspection | Testing | Replacement | …
```

This lines up exactly with the **PPA / SUB / DP** box on the Projects whiteboard. So:

- **Do not create a Projects base.**
- **Do not write the same record into several bases.**
- A site belongs to `CI` or `OM`. Whether it is "Projects" or "Residential" is read from
  `Installation Category` / `Owner Category`, and is a **filter**, not a location.

---

## SOURCE DOCUMENTS — what was and was not readable

Two reference PDFs were supplied:

- `Jobcard Coverpage O&M.pdf`
- `Jobcard Template O&M.pdf`

**Both are image-only scans.** They contain 50+ raster images, zero font objects, and
CCITTFax/DCT encoded page data. There is no text layer, and no OCR is available in this
environment, so their contents **could not be read directly**.

The field lists in §4 below are therefore taken from the human transcription supplied with the
original prompt, not from the files. **Before building, confirm the field list against the
actual documents** — if the transcription is incomplete, the data model will be too.

Two whiteboard photographs (10 Sep 2026) *were* readable and are the source for §2.

---

## 1. PRIMARY OBJECTIVE

Add a **SITE INFORMATION** module to the existing application.

A Site Information record is the **persistent profile of a site and its system**. It is
deliberately separate from a job card:

| SITE INFORMATION — persistent | JOB CARD — transactional |
|---|---|
| Client, site, address | Job number, work request |
| Panels, inverters, batteries, monitoring | Scope, technician, visit date |
| Equipment register with serials | Work performed, findings, parts used |
| O&M agreement and status | Outstanding issues, sign-off, job status |
| Photos, document status, site history | One event in time |

The point: when a technician raises `JC2026-XXXX`, the job card **links to** the site profile
instead of asking again for the panels, inverters, batteries and monitoring platform.

---

## 2. OPERATIONAL CONTEXT (from the whiteboards)

This is new context the earlier prompt did not carry. It should shape the module, and it
explains where Site Information sits.

**The Projects flow:**

```
CLIENT ──(call / email / WhatsApp)──> TICKET ──> JOB CARD ──> REPORT
                                        │                       │
                            PPA / SUB / DP              WARRANTY / RMA /
                                                        NEW WORK / SERVICE
                                                              │
                                                          APPROVAL ──> EXECUTION ──> COMPLETION REPORT
```

**Intake is by named person and channel** (Residential board):

| Person | Channels |
|---|---|
| Melanie, Bonita | Job card, Ticket |
| Stephan | Ticket, WhatsApp |
| Maurice | Ticket, Email, WhatsApp |
| Geoff | Ticket, WhatsApp |

Two consequences for this build:

1. **A ticket precedes a job card.** `tickets` is already a reserved module key in the
   permission matrix (currently `403 module_not_provisioned` — declared but with no table).
   **Do not build tickets in this module**, but do not design in a way that blocks them: a Site
   Information record must be reachable from a job card, and later from a ticket.
2. **Work type matters** — Warranty / RMA / New Work / Service. `warranty_register` is likewise
   a reserved module key. Where Site Information records warranty *status*, keep it a status
   field; do not build a warranty register here.

---

## 3. DATA PRIVACY RULE — reuse what exists

**Prohibited in this module:** FICA/identity documents (ID, passport, driver's licence, proof of
residence, KYC, identity verification) and financial documents (bank statements, proof of
payment, invoices, quotations, financial statements, credit applications, account or card
numbers, pricing schedules, purchase orders whose purpose is commercial).

**Do not write a new classifier.** The application already has the machinery:

- `Documents.Sensitivity` — `Public | Internal | Confidential | Restricted`, and **blank is
  treated as Restricted** by the engine. Unclassified is invisible, not public.
- `sensitivity_max` and `export_sensitivity_max` per role, already enforced server-side.
- `restricted_personal` — an Admin-only module covering the five FICA tables in the C&I base,
  double-gated by role **and** a per-user flag, never list-viewable, every read audited.

What to add on top:

1. **A blocklist check before upload**, on filename, MIME type and — where practical — extracted
   text. Classify each file `ALLOWED` / `BLOCKED` / `REVIEW REQUIRED`.
2. `REVIEW REQUIRED` **must not upload automatically.** Ask the user to remove the file or
   confirm it contains only operational information.
3. On block, show: *"This file appears to contain FICA or financial information and cannot be
   uploaded to the Site Information module."*
4. A permanent notice by the upload control: *"Do not upload FICA, personal identity documents,
   banking information or financial documents."*
5. **State the limit honestly in the UI.** Detection is heuristic. Do not imply it is complete.

**The reference template lists "Invoice / Proforma" under Documents on File. Do not implement
that field here.**

---

## 4. FIELDS

> Confirm this list against the scanned PDFs before building — see "Source documents" above.

**Identification:** Site ID · Job Card Number · SUB/SOL Number · Client · Site Name · Base
(`CI`/`OM`) · Installation Category · Site Type

**Responsibility:** Responsible Person · Project Manager · Operations Manager · Team Leader

**Dates:** Date Issued · Start · End · Installation · O&M Start · Contract Start · Last Updated

**Client & site:** Client Name · Property Address · Postal Address · Site Contact · Cell ·
Alternative Number · Email · Contract Type · Contract Signed Date · Contract Term ·
Buyout / Transfer Information

**System:** Panel make/model/qty/total capacity · Inverter make/model/qty/total capacity ·
Battery make/model/qty/total capacity · Monitoring System · Monitoring Platform ·
Monitoring Reference

**O&M:** O&M Agreement · O&M Contact · Current System Status · Last Service · Next Service

**Document status:** Client/Site Information · Installation Documents · Electrical CoC ·
System Handover · Warranty Documents · Site Photos · Previous Service Reports · SLD ·
Electrical Drawings · Datasheets · Commissioning Documents · Technical Reports ·
Maintenance Reports

**Notes:** Operational Requirements · Technical Notes · O&M Notes · Site Notes

**Audit:** Created Date/By · Modified Date/By

**System status options:** Operational · Operational – Monitoring Issue · Partially Operational ·
Offline · Under Maintenance · Awaiting Parts · Awaiting Client · Awaiting Insurance ·
Decommissioned · Unknown

**No financial or banking fields anywhere in this module.**

---

## 5. UI

A workspace, not a digital paper form. Tabs, not one long scroll:

```
SITE INFORMATION
[Overview] [Client & Site] [System] [Equipment] [O&M] [Documents] [Photos] [History]
```

**Overview** is a snapshot for management and technicians:

```
SITE: TAQA OLIVEDALE      CLIENT: TAQA      JOB CARD: 2026-0010      SUB/SOL: XXXXX

SYSTEM   PV 73.8 kWp · Inverter 60 kW · Battery 200 kWh
O&M      Active · next service XX/XX/XXXX
DOCS     CoC ✓   SLD ✓   Warranty ✓   Site Photos ✓   Service Report ⚠
STATUS   ● Operational

[View Job Card] [Add Photo] [Add Equipment] [Upload Document]
```

**List view** — Client · Site · Job Card · SUB/SOL · Site Type · System · O&M · Status ·
Last Updated · Responsible Person, with actions View / Edit / Photos / Documents / Activity.
Search across client, site, job card, SUB/SOL, serial number, monitoring reference. Filter by
Installation Category (this is where "Projects" vs "Residential" lives), site type, system
status, O&M status, responsible person.

**Equipment tab** — a register supporting multiple records per type, not one model per site:
Equipment Type · Manufacturer · Model · Serial · Qty · Installation Date · Warranty Expiry ·
Status · Notes.

**Photos tab** — multi-select and drag-drop upload, camera capture on mobile, responsive
gallery, larger viewer on click. Per image: category (Site · Roof · PV · Inverter · Battery ·
DB · Electrical · Meter · Equipment · Defect · Before · After · Other), description, date,
uploaded by, related equipment, related job card.

**Mobile matters** — technicians use this on a phone. Cards rather than wide tables, large
targets, collapsible sections, no horizontal scrolling.

**Use the existing design system.** The app is a dark theme with an amber accent
(`--bg:#0e0f11`, `--amber:#f0a500`), IBM Plex Sans/Mono, and existing `.ps-*` component classes.
Do not introduce a new visual language.

---

## 6. HOW THIS APPLICATION IS BUILT — constraints that will bite

**No framework, no build.** Add a `public/js/mod-siteinfo.js` alongside `mod-scheduler.js`,
loaded by a `<script>` tag. Follow the existing module shape: an IIFE that exposes
`TX.siteinfo = { start, reload }`.

**The CSP forbids inline script and inline handlers** (`script-src 'self'`). Use the existing
declarative dispatcher: `data-act="…"` attributes routed through an `ACTIONS` map. Note that the
dispatcher honours `data-on` — `click` is the default; a control that should fire on typing must
declare `data-on="input"`.

**Data access.** Use `TX.list / TX.get / TX.create / TX.update` with **symbolic** base and table
names (`'CI'`, `'OM'`, `'site_information'`). Never a raw id — the proxy rejects those pre-auth.

**Deny by default — this will silently block everything if missed.** A new module is invisible
to every role, *including Admin*, until all four of these are done:

1. Add the table to `TABLES` in `api/_lib/tables.js` for each base it exists in.
2. Add scope fields to `SCOPE_FIELDS` if the module needs record-level scoping.
3. Add the module key with its operations to **every role's `Permissions` JSON** in the
   `Access Levels` table of the `IAM` base.
4. Add the key to `MODULES` in `public/js/mod-admin.js`, or it cannot be managed from the admin
   grid. There is a test asserting the grid and the server list agree — it will fail otherwise.

**Field-level rules** are expressed per role as `deny_read` / `deny_write` / `allow_write`, and
`allow_write` is preferred for narrow roles: a deny-list leaves every field nobody thought of
writable.

**Writes are validated against the live schema** — `typecast` is off. An unknown field or an
invalid select option fails with a named field rather than being silently coerced. Select
options are **case-sensitive**.

**Airtable has no transactions and no unique index**, and `filterByFormula` is eventually
consistent — a record created milliseconds ago may not be findable yet. Fetch by record id where
it matters.

---

## 7. AIRTABLE

Create a `Site Information` table in **`CI` and `OM` only**. Reuse existing relationships rather
than duplicating data — link to `Job Cards`, `Clients`, `Documents`, `Site Visits` where those
already exist. Display looked-up values in the UI, but do not copy them into new fields.

Photos and documents: reuse `Documents.File` (Airtable attachment) and its `Document Type`,
`Sensitivity` and `Record Status` fields, linking each to the Site Information record. Do not
introduce a second storage mechanism.

**Duplicate prevention:** before creating, check `Client + Site`, `Job Card Number`,
`SUB/SOL Number`. On a likely match show *"This site may already exist"* with
`[Open Existing]` / `[Create Anyway]`. Never silently create a duplicate.

---

## 8. HOW TO WORK

1. **Inspect first.** Read `api/_lib/tables.js`, `api/_lib/permissions.js`, `api/at.js`,
   `public/js/core.js`, `public/js/mod-scheduler.js`, `public/js/mod-admin.js`, `vercel.json`,
   and the live Airtable schema. Report what you found before changing anything.
2. **Confirm before creating any Airtable table or field**, and before any change that is hard
   to reverse. Describe what you intend to create and why.
3. Implement in small steps, running `npm test` as you go. The suites are the regression net:
   they cover the permission matrix, field rules, record scope, and the admin grid.
4. **Do not break what works.** After implementation verify: the Scheduler still loads, job
   cards still open, sign-in still works, the admin panel still saves roles, and `npm test`
   is green.
5. Say plainly when the brief conflicts with what the data supports, and what you did instead.
   Do not quietly narrow the scope.

---

## 9. ACCEPTANCE

The work is complete when all of these pass:

1. Create a Site Information record; it lands in the correct base (`CI` or `OM`).
2. Open it from the list; edit it; view system information.
3. Add, edit and delete equipment records, with multiple items per type.
4. Upload permitted site photographs; view them in the gallery; open the larger viewer.
5. Attempt to upload an ID document → **BLOCKED**.
6. Attempt to upload a bank statement → **BLOCKED**.
7. Upload a technical PDF → allowed.
8. A file the classifier is unsure about → **REVIEW REQUIRED**, not uploaded.
9. From a job card, reach its Site Information; from Site Information, reach the job card.
10. Filter the list by Installation Category and see Projects and Residential sites separate.
11. A role without the new module key is refused by the **proxy**, not just the UI — prove it
    with a direct request carrying that role's session cookie, and show the audit entry.
12. The admin grid shows the new module and saving a role does not drop it.
13. The UI is usable at mobile width.
14. `npm test` green; Scheduler, job cards, sign-in and admin all still work.

---

## 10. DELIVERABLE

Report: files created and modified · routes added · Airtable tables, fields and relationships
required · which of those you created and which TAGEX must create manually · upload security and
FICA/financial blocking implemented · job card integration · how `CI`/`OM` selection works ·
tests run and their results · any environment variables required.

**Do not stop at a mock UI.** It must be connected to the real proxy and the real Airtable
tables. Where an Airtable change cannot be made from the application, name the exact base, table
and fields that must be created by hand.
