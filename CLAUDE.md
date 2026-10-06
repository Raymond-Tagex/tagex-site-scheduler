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

Two operating bases by symbol: **CI** (C&I) and **OM** (O&M). Several tables exist in both
with diverging field names — see `FIELD_ALIASES` in `tables.js`.

## Why things are vendored

`vercel.json` sets `script-src 'self'`, so no CDN scripts. The OCR language data and pdf.js are
both committed for the same two reasons: the CSP forbids fetching them, and a page that depends
on a third party being up stops working for reasons nobody here can fix. Keep it that way.

## Testing

```bash
npm test                       # six node suites, ~1,730 assertions
node scripts/ui-harness.js     # then http://localhost:4321/test/<name>.html
```

`test/pdfpages-harness.html` needs a PDF served to it — pass `?pdf=<url>`. Without one it
**says SKIPPED**; a skipped section must never read as a passing one. It also needs the browser
window actually drawing: pdf.js renders nothing in a hidden or backgrounded tab.

**A test that passes for the wrong reason is worse than no test.** Put the bug back and check
the test fails.

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
