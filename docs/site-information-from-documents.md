# Building a site from its documents

**Site Information → From Documents**

Drop the folder you already keep for a site. The app reads the job card, asks Airtable what it
already knows about that site, proposes a complete Site Information record for you to confirm,
and then attaches every file in the folder to it.

---

## What it does, in order

1. **You choose the files.** A dropped folder is walked recursively. `Thumbs.db`, `.DS_Store`
   and anything that is not a document or an image are dropped silently.
2. **You pick the job card** — the page with the site details on it. The app guesses: a file
   named "job card" wins, otherwise the first readable file. Change it if the guess is wrong.
3. **It reads the job card.** Photographs are downscaled in your browser first (2400px on the
   long edge), then read by OCR on the server. Nothing is sent to any third party.
4. **It searches Airtable** — both C&I and O&M — for a matching site, the job card number, and
   the client.
5. **It proposes a record.** You review and correct every value.
6. **You confirm.** The site is created or updated, equipment rows are added, and every file in
   the folder is uploaded and linked.

Nothing is written until step 6.

---

## Two ways in

| Button | Start from | Documents are filed against | Use it when |
|---|---|---|---|
| **From Job Card** | an existing job card | the **job card** | everyday work — the job exists in Airtable |
| **From Documents** | a folder of files | the **site** | back-filling a historic site with no job card |

### From Job Card

1. **Search and choose the job card** — by reference, title, client or address.
2. It reads that job card from Airtable. The record already names the client, carries the site
   address and links to its own Site Information record, so **nothing about which site this is
   gets inferred from a scan**. A card that already has a site shows *has a site*.
3. **Drop the files.** A job-card scan is optional here; the record is the better source. You can
   continue with no files at all and just build the site record.
4. **Review** the proposed site fields, then confirm.

Each document is linked to the job card through `Documents.Job Card`, and the site is linked to
the job card through `Site Information.Job Cards`. Airtable maintains the reverse links, so a
file appears **once** — under the job card — not twice.

The site link is written from the site's side deliberately: that needs `site_information:edit`,
which anyone using this screen already has, rather than `job_cards:edit`, which they may not.

---

## Which source wins

Airtable outranks the scan, always:

| Rank | Source | Fills |
|---|---|---|
| 1 | The existing **Site Information** record | everything it has |
| 2 | The linked **Job Card** | fields still blank |
| 3 | The **Client** record | fields still blank |
| 4 | **OCR** from the scan | fields still blank |

Where the scan disagrees with a stored value, **the stored value stands** and the disagreement
is listed at the top of the review screen for you to settle. A scanner misreading `SOL-88214` as
`S0L-8B214` can never overwrite the real number.

Each row of the review table says where its value came from. Rows read from the scan are marked
in amber, because those are the ones worth checking.

---

## What OCR can and cannot read

| | |
|---|---|
| **Printed text** | Reads well — typically above 90% confidence. |
| **Handwriting** | **Does not read.** Tesseract is a print engine. Hand-filled entries come back blank or wrong. |
| **Scans compressed as JPEG** | Read normally (phone scanners, Adobe Scan, most MFPs). |
| **Fax-compressed scans (CCITT Group 3/4)** | Read normally. This is what an office MFP produces in its default black-and-white text mode, and it is what the first real customer document used throughout. |
| **Mixed Raster Content scans** | Read normally. These split each page into a background layer and the bilevel masks that carry the text; the text layer is the one read. |
| **Scans compressed as JPX (JPEG 2000) or JBIG2** | Not read. You are told which, and asked to re-save the PDF. |
| **PDFs with a real text layer** | Read directly, no OCR needed. |

The review screen shows the confidence figure and the number of lines matched. Below about 70%,
check every value.

**A blank is deliberate.** A value that could not be read cleanly is left empty rather than
guessed:

- A select option that is not an exact match is refused — Airtable select options are case
  sensitive, so a near miss would fail the write anyway, and a confident wrong guess is worse
  than a blank.
- `TBC`, `N/A` or prose in a number field produces a blank, not `0`. A site showing 0 panels
  reads as a measurement; a blank reads as an unanswered question.
- An ambiguous date (`04/03/2026`) is read day-first, South African convention, and flagged.

---

## Equipment

Serial numbers do not belong on the site record — one site has many inverters — so they become
**Site Equipment** rows. The review screen proposes a row for each of PV modules, inverters,
batteries, a meter and a datalogger where the job card gave a make, a model or a serial. Untick
any you do not want.

A bare quantity with no make proposes nothing: "2 inverters" is not a record anyone can act on.

---

## Limits

| | |
|---|---|
| File size for **reading** | 3 MB. Photographs are downscaled automatically; an oversized PDF is refused with a message. |
| Pages read per job card | 2 — a job card carries its details at the front |
| Pages read for the FICA check | 6, **sampled across the whole document** rather than its first pages |
| Files per upload | No limit, but each is uploaded one at a time and each is classified on the server. |

---

## What is refused

Every uploaded file is classified on the server. This module holds **no** FICA, identity,
banking or financial data, and the refusal is enforced where the browser cannot reach it.

Since OCR was added, that check also reads **scans and photographs**. A photographed bank
statement named `site photo 4.jpg` is now blocked; before, it was cleared on sight because it
was an image.

It also samples **across** a document rather than reading its front. This matters more than it
sounds: a real 26-page subscription pack put ten pages of contract terms in front of three pages
of bank statements, so reading the first two pages returned boilerplate and a clean verdict.
That file is now blocked.

**A whole pack is judged as one file.** If any sampled page is financial, the entire PDF is
refused — it is not split apart, and there is no way to accept "just the operational pages" of a
mixed document. Extract the pages you actually want (the CoC, the job card, the layout drawing)
into their own file and upload that.

**Identity rules fire on data, not on form labels.** A statutory Certificate of Compliance
prints an "ID No:" field for the registered electrician, so matching that label alone refused
every CoC ever issued — in a module that has an "Electrical CoC" document status and expects
them. "ID No" and "Passport No" now block only when a plausible number follows. An actual
identity number still blocks; a blank printed field does not. The trade is that an ID number
which fails to OCR is no longer caught by that rule — one more reason REVIEW means a person
must look.

## An administrator may decide for themselves

The automatic check is a filter, not a judge. An administrator can classify any file the check
did not clear:

| Choice | Who may make it | Effect |
|---|---|---|
| **FICA / financial — do not upload** | anyone the control is shown to | The file is never uploaded, whatever the automatic check concluded. Keeping material out never needs a privilege. |
| **Operational — upload it** | administrators only | Uploads the file even if the check refused it. |

"Administrator" is not a role *name*. It is the same double gate the module already uses for
restricted personal data: the role carries **Can View Restricted Documents** and the individual
user carries the same flag. Both, or the override is refused. A role renamed "Admin" without the
flags cannot do it; the server re-checks from the session and ignores anything the browser claims.

**Every override is recorded twice** — as its own audit entry naming the person, the file and the
verdict that was overruled, and in the Notes on the document itself, so someone reading that
record months later can see a person overruled the classifier. The site's history line says so too.

Where it appears:

- **Photos tab** — a per-file choice on the upload queue, on anything not already cleared.
- **From Documents** — files the server refused are listed after the run under *Refused — look at
  these yourself*, with a tick box each. A REVIEW file can be confirmed by anyone; a BLOCKED one
  shows *admin only* to everyone else.

OCR only ever makes the verdict stricter. A document that reads clean is **not** promoted to
"allowed" — "nothing alarming was found" is usually just evidence that the handwriting did not
read. Files the server cannot classify are listed at the end of the run and are **not**
uploaded; being in the folder is not evidence that a file is operational.

---

## Testing the screen

```bash
npm run harness
```

Then open <http://localhost:4321/test/batch-harness.html>. It loads the real modules with a
stubbed network, so the screen can be driven in a browser without Airtable or a session.
Static files only — it runs no API handlers and holds no credentials.

The server-side pieces — the parser, the PDF image extractor, the precedence rule and the FICA
classifier against real rendered documents — are asserted in `npm test`.
