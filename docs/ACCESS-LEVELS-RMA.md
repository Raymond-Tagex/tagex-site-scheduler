# Access levels — Operations Manager / Project Manager split, and RMA Supervisor

**Date:** 2026-10-02
**Sources:** TGX-RMA-P01 Rev 1 (procedure), TGX-RMA-F01 (control form), *RMA & Returns — Process
Flow* Ver 2, Solax RMA Warranty Form, the live Access Levels table in TAGEX – Identity & Access
(`appVrQ4Nuwb9gk6Ip` / `tblkIysBGLDHaiXhI`), and the RMA Staff table in TAGEX – RMA & Returns
Control (`app8xtuNFNLItvpqr` / `tblhP9m28BpM2Yhta`).

---

## 1. Two layers of access

| Layer | Where it lives | What it decides |
|---|---|---|
| **Platform access level** | Identity & Access → Access Levels (one per user) | What a person may see and change in the Scheduler and Delivery apps — job cards, clients, tickets, stock, delivery notes. Enforced by `api/_lib/permissions.js` on every request. |
| **RMA role** | RMA & Returns Control → RMA Staff → Roles (one or more per person) | What a person may do inside the RMA app — which F01 sections they fill and sign. The person must also be an Active user in Identity & Access. |

So "RMA Supervisor" exists in both places:
- **RMA Staff → RMA Supervisor** already exists. It is what lets Maurice open RMAs and sign
  Sections A, D2 and E in the RMA app.
- **Access level → RMA Supervisor** is new. It is what Maurice sees on the platform while doing
  that work. Today he would need Operations / Project Manager, which also gives costing and
  delivery editing.

---

## 2. The levels after the change

| Access level | Record | Change |
|---|---|---|
| Admin / Director | `recnux0y686i1pUZX` | unchanged |
| **Operations Manager** | `recjAVlENZ3OS3wH2` | **renamed** from *Operations / Project Manager*. Same record, same permissions. Everyone who holds it today keeps it. |
| **Project Manager** | `recndoGFlPZPm0pdD` | created from the Operations grant (see §3) |
| **RMA Supervisor** | `rec1Yl8OY1omBv0ZI` | see §4 |
| Technician / Field | `recLBElqoyXofiWCR` | unchanged |
| Warehouse / Stores | `recu56ankV4dDTpAv` | unchanged |
| Driver | `recBm5sxSi40M85WB` | unchanged |
| Site Installer | `recNz94Vvypw5Oe1E` | unchanged |

Renaming the existing record (instead of making two new ones) means nobody loses access
on the day. Afterwards, an admin moves each person who is really a project manager to
*Project Manager* using the Users screen, Access Level drop-down.

No code in either app checks a role by name except the signature roles (Warehouse, Driver,
Site Installer), so the rename does not break anything. `scripts/check-config.js` now expects
all eight levels.

---

## 3. Operations Manager vs Project Manager

V = view, C = create, E = edit, D = delete, X = export, – = no access.

| Module | Operations Manager | Project Manager | Why they differ |
|---|---|---|---|
| job_cards, clients, documents | VCEX | VCEX | |
| picking_slips, picking_slip_items | VCEX | VCEX | |
| delivery_notes, delivery_lines, stock_items | VCEX | VCEX | |
| site_visits, tickets, systems, warranty_register | VCEX | VCEX | |
| site_information | VCEX | VCEX | |
| site_equipment | VCEDX | VCEDX | |
| second_hand_parts, support_requests | VCEX | VCEX | |
| costing | VCEX | VCEX | |
| activity_log | VCE | VCE | |
| signatures | VC | VC | |
| reports, dashboard | VX | VX | |
| people, audit_log (own) | V | V | |
| **contracts, slas, error_criteria** | VCE | **V** | O&M service configuration belongs to the process owner |
| **response_templates** | VE | **V** | same |
| **users, access_levels** | VC (live) | **–** | see §6 — inviting users is Admin-only in the code anyway |
| **restricted_personal** | VC (live) | **–** | the level's own description says "NO access to FICA / personal data" |

Approval Limit stays R 0 on both. Set it on the Operations Manager if advance replacements
(P01 §6) are to be approved in-app against a value.

---

## 4. RMA Supervisor — platform access

The rule from P01 §4 and the Process Flow: the RMA Supervisor **"completes Sections A and B from
system records"** (customer, original project/job, original invoice, picking slip and WT numbers,
issue and installation dates, warranty status), **compiles the Solax form** (end-user name,
phone, email, address; serial numbers, firmware, installation date), and **records the outcome**.
Costing and recovery belong to Finance; approvals belong to the Operations Manager.

| Module | Access | Field rules | Rule it serves |
|---|---|---|---|
| job_cards | V | Budget, Actual Cost, Project Value, Cost Exposure, Cost Variance %, Total BOM Value, PDF: Financial Summary hidden. **Invoice visible.** | Section A — original project/job and invoice no. |
| clients | V | all visible | Section A, and Solax form "End user information" |
| documents | V | up to *Internal* | original invoice, installation documents |
| picking_slips, picking_slip_items | V | | Section A — original picking slip no. |
| delivery_notes | V | Total Value hidden | Section A — issue date, WT |
| delivery_lines | V | Unit Cost, Line Value hidden and not writable | serial issued on the original sale |
| stock_items | V | Unit Cost hidden and not writable | material codes; whether a spare is in stock (Stage 3A) |
| site_visits | V | | installation date, who was on site |
| site_information | V | | Solax form shipment / site details |
| site_equipment | **VE** | | Section B serial numbers; record the replacement SN on the site after Stage 8 |
| systems | V | | system / model details |
| tickets | **VCE** | Cost Recoverable hidden and not writable | most returns start as an O&M fault ticket |
| warranty_register | **VE** | | Section A warranty status; update after replacement |
| second_hand_parts | V | Sale Price hidden | returned units already held |
| support_requests | V | | the customer's original report |
| activity_log | **VC** | | note the RMA on the job card / ticket |
| people, dashboard | V | | |
| audit_log | V (own) | | |
| costing, reports, contracts, slas, signatures, users, access_levels, restricted_personal | – | | Finance, Ops Manager and Admin duties |

Flags: Default Record Scope **All Records** (the original sale can be on any job card), Can
Export **off**, Can Delete **off**, Can Manage Users **off**, Can Edit Permissions **off**, Can
View Restricted Documents **off**.

The exact JSON is in `docs/access-levels/rma-supervisor.permissions.json`. It is checked by
`test/verify-part-b.js` (section *PROJECT MANAGER AND RMA SUPERVISOR*).

---

## 5. RMA app ruleset by role (from TGX-RMA-P01 and the Process Flow)

D = does the work, S = signs the F01 section, A = approves / decides, • = supports.

| Stage | Ops Manager | RMA Supervisor | Warehouse | Stock Controller | Test Centre | Finance |
|---|---|---|---|---|---|---|
| 1 Log and receive (A, B, C) | A allocates | D (A, B) | D S (C) | D S (C) | – | – |
| 2 Transfer to test centre (D hdr) | – | • | – | D | D | – |
| 3 Test, decide result (D) | – | • | – | • | D S | – |
| 3A Repair and spares (D2) | A scrap / replace | D S | – | D S | D S | – |
| 4 Submit to Solax (E) | – | D S | – | – | • | – |
| 5 Record Solax decision (E) | A escalations | D | – | – | – | • |
| 6 Receive replacement (F) | A advance replacement | • | D | D | – | – |
| 7 Verify replacement (F) | – | – | – | – | D S | – |
| 8 Issue to customer (G) | – | D (Register) | D S | D S | – | – |
| 9 Close-out (H, I) | A S (last) | D S | S | S | S | D S |

What the **RMA Supervisor** may do in the RMA app:
- Open an RMA and issue the next `TGX-RMA-YYYY-###`. Only one open RMA per serial number.
- Complete Sections A and B. Record an existing Solax RMA number in E.
- Section D2: enter every spare in the Spares Database the same day. Raise a PO / Solax spares
  order for anything not in stock. Co-sign D2.
- Section E: compile and submit the Solax form, tick the submission checklist, record the Ticket
  No. Follow up at least weekly and record each date. Record the decision and Solax RMA No.
- If Solax rejects the claim, record the reason and escalate to the Operations Manager within 1
  working day.
- Keep the RMA Register current at every stage. Hand the file to Finance. Close the Register
  entry after Section I.
- Sign Section I.

What the **RMA Supervisor** may *not* do (Operations Manager only):
- Approve advance replacements, scrapping, a replacement used for another customer, an SN-mismatch
  correction, or a dispute / return / quote on a rejected claim.
- Sign Section I last.

The **Operations Manager** row is unchanged by this split. The Project Manager has no RMA role
and should not be given one in RMA Staff.

---

## 6. Open points

1. **The live Operations level has drifted from its spec.** It grants `restricted_personal`
   view+create and `users` / `access_levels` view+create. Its own description, and the Part B
   matrix this repo tests against, say "NO access to FICA / personal data. NO user management."
   The double gate (role flag is off) and the Admin-only invite endpoint stop these grants
   doing much today. They were left as they are on the Operations Manager. Decide whether to
   remove them.
2. **Maurice holds three RMA roles** — RMA Supervisor, Test Centre Manager and Test Technician.
   P01 separates them on purpose: Section D needs a "tested by" and a different "verified by".
   The RMA app should refuse the same person signing both slots of D, and the Operations
   Manager should take the second signature on any RMA Maurice both opens and tests.
3. **The RMA app's own code** (`C:\Projects\tagex_rma`) is not in GitHub, so it could not be
   checked here. Push it to a repo to confirm that its RMA Staff roles enforce §5.
4. `docs/USER-MANUAL.html` still describes the combined *Operations / Project Manager* level.
