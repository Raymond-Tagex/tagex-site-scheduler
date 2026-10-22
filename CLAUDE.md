# TAGEX O&M — Site Visit Scheduler, Tickets and Site Information

Site visits, job cards, tickets, site records and the documents behind them, on Airtable.
Deployed to Vercel as static files plus serverless functions. Node 24.

Shares its identity and permission model with the TAGEX Delivery Note app — same rules, same
shapes, two codebases.

## The rules that are not negotiable

Set by the business and enforced in code. Breaking one is a defect, not a style disagreement.

1. **No Airtable token in the browser, ever.** One PAT, held server-side in `AIRTABLE_PAT`.
   Every read and write goes through `POST /api/at`. A fetch straight to `api.airtable.com`
   from `public/js` is a bug, whatever it is for.
2. **Deny by default.** An unlisted module, table or field is denied. The whitelist lives in
   `api/_lib/tables.js`; permissions in `api/_lib/permissions.js`.
3. **Enforce on the server.** UI permission checks are cosmetic. The proxy re-checks regardless.
4. **The client never names a base or table id** — symbolic keys (`CI`, `OM`), resolved server-side.
5. **Passwords are hashed and never recoverable.** No plaintext in Airtable, logs or email.
6. **FICA and personal data** are Admin-only, double-gated by role *and* a per-user flag, every
   view audit-logged, never in a list view, an export or a URL. POPIA applies.
7. **Audit allowed actions as well as denied ones.**
8. **MFA is mandatory for Admin.**
9. **Generic auth errors.** No user enumeration.
10. **Nothing is ever deleted.** Cancellation is a status.

**Never write a real token into `.env.example`, documentation or app code.**

## Reading documents is guesswork, and is treated as such

`/api/siteinfo-ocr` **writes nothing**. It reads a document, reads Airtable and returns a
*proposal*; creating or updating a site still goes through `/api/at`. OCR guessing stays on a
route that cannot change anything.

Where Airtable and a scan disagree, **Airtable wins** and the disagreement is reported as a
conflict for a person to settle. A scanner misreading a SOL number must never overwrite the
real one.

**Tesseract is a print engine. Handwriting comes back wrong or empty.** Every caller treats
the output as a suggestion. The one place it acts as a control is the FICA classifier, and
there it can only ever make the classifier stricter — text it finds can block a file, never
clear one. An unreadable file reaches REVIEW, never ALLOWED.

**A scanned PDF is not one image per page.** A composited scan separates each page into a text
mask and a background, often in strips — a real 38-page agreement held 609 image objects, about
24 per page. So PDFs are rendered to page pictures in the browser (`public/js/pdfpages.js`,
pdf.js vendored under `public/vendor/`) and the server reads those. Pages are sampled as the
front of the document **plus a spread through the rest**, because a bank statement bound into
the back of a long agreement has to reach the FICA check.

## FICA pages are split out of a scan, not refused with it

Site Information → **Split a PDF** (`public/js/siteinfo-split.js`, `api/fica-docs.js`) renders every
page, asks the server for a verdict per page (FICA / other / unsure), and has a person confirm each
one. **Unsure starts as FICA**: unreadable never clears. Confirmed FICA pages are filed in **FICA
Documents** (`tbl5z9m0gfMV6QPXB`), one record per source PDF and one PDF per page. The other
pages are handed to the existing import flows, which check every file again on the server.

- **One table, in O&M only, for sites in every base** (Raymond, 22 Oct 2026). A site is named
  by Site Base + Site Record ID because Airtable cannot link across bases.
  `restricted_personal` is in `OM_ONLY` in `tables.js`, so RES never mirrors it.
- **Both flags, always.** The endpoint requires the role's and the person's Can View Restricted
  Documents flags whatever the rule's `require_user_flag` says. Anyone else is told that their
  FICA pages will not be uploaded, and they are dropped.
- **classify writes nothing and never returns the text it read.** On an ID page that text is the
  ID number. `open` returns bytes rather than Airtable's link, because that link works for anyone
  holding it for hours. `index` and `open` are both audited as Restricted Document Viewed.

## Layout

```
api/            one file per endpoint; at.js is the Airtable proxy and the
                place permissions are enforced
api/_lib/       tables.js (whitelist), permissions.js, guards.js, audit.js,
                session.js, ocr.js, pdfimages.js, jobcardform.js, tessdata/
public/js/      mod-scheduler (the big one), mod-siteinfo, siteinfo-batch,
                pdfpages, mod-admin; core.js is the shared client
public/vendor/  pdf.js, vendored (Apache-2.0)
test/           verify-*.js in node; *-harness.html in a browser
scripts/        dry-run by default, --apply to write
```

Three operating bases by symbol: **CI** (C&I), **OM** (O&M) and **RES** (residential). Several
tables exist in C&I and O&M with diverging field names — see `FIELD_ALIASES` in `tables.js`.

**RES is a structure-only duplicate of O&M** and keeps O&M's table and field ids, so `tables.js`
derives every RES mapping from O&M's (`mirrorOmToRes`). A table or field added to O&M must be
added to RES too, by hand in Airtable; `test/verify-res-mirror.js` compares the live schemas and
fails when they drift. The browser's list of bases is `TX.OPS_BASES` in `core.js`; the server's is
`OPS_BASES` in `tables.js`.

**The scheduler and tickets work in one base at a time: O&M or RES** (`SCHEDULER_BASES`; C&I has
its own scheduler). The choice is per browser (`tagex_sched_base` in localStorage) and **changing
it reloads the page**, so nothing cached from one base can be written into the other. Every call in
`mod-scheduler.js` names `SCHED_BASE`, never a literal; `/api/jobcard-form` and `/api/ticket-report`
take `base` and refuse anything but O&M or RES (none named = O&M).

## Printed forms are made when the record is

Every job card and every ticket raised in the scheduler gets its printed form straight away
(`omAutoForm` in `mod-scheduler.js`): built on the server, **filed in Documents against the job
card** (`api/_lib/formfile.js`) and downloaded. A ticket raised by booking a visit is filed but not
downloaded. Reprints from the Print buttons are never filed.

- The job card form (`_lib/jobcardform.js`) reproduces *TAGEX JOB CARD TEMPLATE SEP2026.docx*; the
  ticket form (`_lib/ticketform.js`) is the same format for a ticket. Change the paper, change
  `test/verify-jobcard-form.js` first.
- Building a form is the **export** right; filing a copy is **documents:create**, checked
  separately, with the copy's Sensitivity (Confidential once it carries costs) inside the role's
  cap. Technician / Field and RMA Supervisor can raise tickets but hold neither, so their tickets
  get no form until IAM says otherwise.
- One filed copy per name ("Job Card form — REF", "Ticket form — TKT-…"); a failed upload is
  retired with Record Status = Deleted, never deleted. Document Type is "Other" because the
  select has no "Job Card" choice and the API cannot add one.
- Both forms open with the TAGEX logo, laid out as the delivery note's head
  (`api/_lib/assets/tagex-logo.png`, copied from tagex-delivery). It is read from disk, so
  `vercel.json` ships it with `jobcard-form.js` and `ticket-report.js` via `includeFiles` — a
  new function that prints a form needs the same entry.

## A hidden field cannot be searched on

A list or get whose `filterByFormula` or `sort` names a field the role may not read -- its `deny_read`,
or the never-return list -- is refused as `filter_on_denied_field` (`P.deniedReferences`, the same code
as the delivery app). Stripping the field from the answer is not enough: a filter on it tells the value
by halving. Whoever may edit supplier quotes is held to MFA with Admin (`mfaRole`); building a TAGEX
BOM alone is not, since project managers do that on phones with the costs hidden from them.

## Job card money is for four people

Since 20 Oct 2026 every role's `job_cards` rule denies reading and writing Budget, Actual Cost, Project
Value, Cost Exposure, Cost Variance %, Total BOM Value and PDF: Financial Summary. Only Chane, Janette,
Gus and Raymond see those figures, on the delivery app's Costing tab (`project_costing`, a key off on
the roles and on in their Permission Overrides). A scheduler screen that wants them gets them stripped,
and a filter or sort on them is refused. Do not lift the deny on a role: override denies cannot be
lifted per person, so it would open them to everyone on that role. The Costing table (labour on the
printed job card) is unchanged.

## Why things are vendored

`vercel.json` sets `script-src 'self'`, so no CDN scripts. The OCR language data and pdf.js are
both committed for the same two reasons: the CSP forbids fetching them, and a page that depends
on a third party being up stops working for reasons nobody here can fix. Keep it that way.

## Testing

```bash
npm test                       # nine node suites; verify-part-c needs AIRTABLE_PAT
node scripts/ui-harness.js     # then http://localhost:4321/test/<name>.html
```

`test/pdfpages-harness.html` needs a PDF served to it — pass `?pdf=<url>`. Without one it
**says SKIPPED**; a skipped section must never read as a passing one. It also needs the browser
window actually drawing: pdf.js renders nothing in a hidden or backgrounded tab.

**A test that passes for the wrong reason is worse than no test.** Put the bug back and check
the test fails.

## One trunk: `claude/delivery-status-mismatches-hq3pfj`

**This repository is worked by several Claude sessions at once**, and each branches off
whatever it last saw. That is how work gets dropped and how a decision gets quietly reversed by
somebody acting in good faith.

- **Start from `claude/delivery-status-mismatches-hq3pfj`.** It is the default branch and the
  trunk, whatever its name suggests. Fetch before you branch — it has usually moved.
- **Finish by merging back into it,** through a pull request. That is what has been happening
  here (#1, #2, #3) and it is why this repository has not lost anything; the sister repository,
  tagex-delivery, merged straight onto its trunk and did.
- **A branch that is pushed and left is a branch that is not deployed.** `vercel --prod` ships
  the local working directory, so anything only on a side branch is invisible to the next
  release.
- **Read before you rewrite.** A function carrying a comment that explains a decision had that
  decision made on purpose, and usually measured. Changing it is fine; reversing it without
  noticing is not. Say so in the commit message when you do.
- **Leave the reason in the code, not in the chat.** A convention agreed in conversation is
  invisible to the next session. This file is the one place every session reads.

## Working here

- **Verify against live Airtable before changing code.** Field names, select choices and record
  counts are knowable. The API cannot add a select choice or change a field type, but it can
  create fields.
- **`Seq` on Tickets is an autoNumber and `Ticket Ref` is a formula over it.** Ticket numbering
  cannot be rewritten; order by creation instead.
- **Say why in the comments, not what** — and keep them true. A comment claiming a fix that was
  measured not to work is worse than silence.
- `public/js/mod-scheduler.js` is large. Patch it with a script that writes to a temp file and
  renames, never in place: an encoding error mid-write once truncated it to nothing.
- Vercel refuses a request body over ~4.5 MB; base64 costs a third on top.
- Deploy with `vercel --prod`. **Ask first.**
- Confirm any schema change or new base before making it.
