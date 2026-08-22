# OpenEstate — Feature Completion Plan (presales UI, configurable booking form, allotment, unit shifting, head-wise tax)

**Status:** planning input, not yet built. Written for Claude Code to phase and execute.
**Baseline audited:** commit `dc2fa75`, v0.4.0.
**Reference system:** 4QT Real Estate ERP (`kashish03.4qterp.com`), reverse-engineered read-only — see
`../../../crm-reverse-engineering/REPORT.md` for the full 25-section system report and
`../../../crm-reverse-engineering/notes/` for per-module field specs.

---

## 0. How to use this document

Each phase below is independently shippable and ends with a browser-verified walkthrough.
Ordering follows the requester's stated priority (lead management first, booking form second),
with one dependency inversion noted in Phase 4.

**Every phase inherits CLAUDE.md's non-negotiables.** In particular:

- **Browser verification, not curl.** A phase is not done until a human has performed the
  flow in a real browser. This document's acceptance criteria are written as browser actions
  for that reason.
- **Master-driven.** Nothing added here may hard-code a business constant. Every new dropdown
  is a master table with seed data.
- **Ledger, not mutation.** Phase 8 touches financial rows; it adds derived/component rows,
  never mutates or deletes existing ledger entries.
- **Definition of done:** types → zod schema → migration → service + tests → endpoint + OpenAPI
  → UI → seed/demo data → docs page stub → audit logging.

Claims below are tagged where it matters:
**[VERIFIED]** = read in the codebase or observed live in 4QT this session ·
**[INFERRED]** = strongly implied, not directly confirmed ·
**[DECISION NEEDED]** = requires a product call before building.

---

## 1. Baseline — what OpenEstate already has

Confirmed by reading the repo, so no phase below rebuilds working code.

### 1.1 Presales: rich API, almost no UI

**API [VERIFIED]** — `apps/api/src/presales/` and `apps/api/src/leads/`:

| Capability | Endpoint / file | UI exists? |
|---|---|---|
| Inquiry list / detail / create / update | `inquiry.controller.ts` `GET /`, `GET /:id`, `POST /`, `PATCH /:id` | Partial |
| **Assign inquiry** | `inquiry.controller.ts` `PATCH /:id/assign` | **No** |
| **"My day" queue** | `inquiry.controller.ts` `GET /my-day` | **No** |
| **Assignment pool (round-robin)** | `assignment-pool.controller.ts` `GET /`, `PUT /:userId` | **No** |
| Follow-ups | `follow-up.controller.ts` | Partial (detail page) |
| Communication log | `communication.controller.ts` | Partial |
| Escalation engine | `escalation.service.ts` + `.scheduler.ts` + `.processor.ts` | **No** |
| Bulk import (XLSX) | `inquiry-import.controller.ts` | Yes |
| Inbound lead API + keys | `leads/lead-inbound.controller.ts` | Keys page only |
| **Report: daily inquiries** | `reports.controller.ts` `GET /daily-inquiries` | **No** |
| **Report: funnel** | `GET /funnel` | **No** |
| **Report: source-wise** | `GET /source-wise` | **No** |
| **Report: budget-band** | `GET /budget-band` | **No** |
| **Report: ageing** | `GET /ageing` | **No** |
| **Report: staff performance** | `GET /staff-performance` | **No** |
| **Report: manager-wise** | `GET /manager-wise` | **No** |
| Report: CSV export | `GET /inquiries-export` | Yes (button) |

**UI [VERIFIED]** — only two files exist: `apps/web/src/pages/presales/Inquiries.tsx` (405 lines)
and `InquiryDetail.tsx` (241 lines). Routes: `presales/inquiries` and `presales/inquiries/:id`
(`apps/web/src/App.tsx:79-80`). `Inquiries.tsx` is a plain paginated table
(name · phone · project · source · temperature · status · created) with Export CSV, Bulk Import,
and an inline create form. **It has no list filters at all** — the `<select>` elements at
lines 339-355 belong to the create form, not to the list.

**Conclusion:** seven presales report endpoints and the entire assignment/escalation subsystem
are built, tested, and unreachable from the product. Phases 1–3 are overwhelmingly frontend work
against existing APIs — not new backend features.

### 1.2 Post-sales: substantial

122 Prisma models. Relevant ones already present: `Booking`, `BookingCoApplicant`,
`BookingCostLine`, `PaymentPlan`, `Installment`, `LedgerEntry`, `Receipt`, `ReceiptAllocation`,
`ChequeStatusEvent`, `Transfer`, `Cancellation`, `Refund`, `ExtraCharge`, `TdsDeduction`,
`InterestAccrual`, `GeneratedDocument`, `DocumentDispatch`, `Broker` + commission chain,
`ApplicantAddress` (with a `PRESENT | OFFICE | PERMANENT` enum already), `ApplicantDocument`.

UI: `BookingWizard`, `InstallmentSchedule`, `ReceiptEntry`, `ChequeQueue`, `DuesDashboard`,
`Applicant360`, `Reports`, `Brokers`, `BrokerDetail`.

### 1.3 Masters framework

`apps/api/src/masters/masters.module.ts` has a generic `createMasterModule` factory driven by a
`SIMPLE_MASTERS` array (18 entries, recounted against the actual file — this document originally
said 20: UnitType, PlcType, InquirySource, InquiryType,
InquiryTemperature, FollowUpType, CommunicationType, ProjectType, ReceiptType, RegistrationType,
AreaLocation, DocumentType, Bank, ChargeType, InterestRule, TransferFeeRule, PaymentPlanTemplate,
TicketCategory) plus four bespoke modules (GstRate, TdsRule, SmsTemplate, LetterTemplate).
Adding a new simple master is a one-line array entry plus a Prisma model — cheap. **[VERIFIED]**

`CustomFieldDefinition` already supports per-company EAV fields with `isRequired`, `fieldType`,
`options`, `sortOrder`, `isActive`, keyed by `entityType`. **This covers custom fields only —
it cannot make a built-in field mandatory.** That distinction drives Phase 4.

---

## 2. Gap analysis

### Gap A — There is no lead management page (requester item 5)

`Inquiries.tsx` is a list, not a workspace. Missing: list filters, saved views, bulk selection,
inline status/temperature change, next-follow-up-due surfacing, overdue highlighting, ownership
column, and any path to the assignment or escalation machinery that already exists server-side.

### Gap B — Leads have no real-time status view (requester item 2)

`InquiryStatus` exists on the model and `GET /my-day` exists on the API, but nothing renders a
live board. No kanban, no "due today / overdue / unattended" counters, no auto-refresh.

### Gap C — Lead assignment is unreachable (requester item 3)

`PATCH /inquiries/:id/assign` and the whole `ProjectAssignmentPool` round-robin subsystem have
zero frontend callers. There is also no bulk reassign, and `InquiryAssignment` (the assignment
history table) is never displayed.

### Gap D — No presales reports (requester item 1)

Seven report endpoints, no reports page. `postsales/reports` exists; `presales/reports` does not.

### Gap E — Booking form is materially incomplete (requester item 4)

`BookingWizard.tsx` has five steps — `['Applicant', 'Unit', 'Co-applicants', 'Payment plan', 'Confirm']`
(`BookingWizard.tsx:132`) — and captures roughly **12 fields**: applicant name/phone/PAN, unit,
agreed base price, GST rate, booking date, co-applicant ids/names, plan mode, custom installments,
broker id. **[VERIFIED]**

The 4QT booking form captures **~80 fields** across nine sections. Full field-by-field spec:
`crm-reverse-engineering/notes/booking-form.md`. Delta below in §4.2.

Note the screenshot supplied by the requester shows one field my earlier recon missed: a
**"Power of Attorney Details"** checkbox in the First Applicant block, next to Attach Photo. **[VERIFIED — screenshot]**

### Gap F — Booking-form fields cannot be configured or made mandatory (requester's own framing)

> "booking application have numbers of option that can be modified and made mandatory from masters sections"

Today a field's presence and requiredness are hard-coded in `BookingWizard.tsx` and the zod DTO.
There is no admin surface to say "Passport No. is required for us", "hide Anniversary Date",
"rename RM to Relationship Manager", or "these are the only Professions we accept". This is the
single highest-leverage item in this document: it converts every field added in Phase 5 from a
fixed form into a configurable one, and it is what makes the clone adaptable to companies other
than the one 4QT was configured for.

### Gap G — No allotment workspace or document print tracking

4QT's Search Allotment screen **[VERIFIED — screenshot]** lists bookings with: Registration No,
First/Second Applicant Name, Unit No, Broker Company, Unit Type, Area, Rate, Basic price,
Allotment Date, **Print By**, **Print Date**, **Print Status** (Printed / Not Printed),
**Allotment Letter** link, **Site Map** link — with colour-coded rows (pink/amber banding,
meaning not yet determined **[INFERRED: likely status- or broker-driven]**).

OpenEstate has `Booking.allotmentDate` and `GeneratedDocumentType.ALLOTMENT_LETTER`, but: no
allotment search/list page, no per-document print audit (who printed, when, printed-or-not), and
no site-map/unit-plan attachment concept. `GeneratedDocument` records generation, not printing.

### Gap H — No unit shifting / area change

4QT `UnitShiftingProcess_request.aspx` **[VERIFIED — screenshot]**: a customer moves to a
different unit *or* changes area on the same unit. Fields: Project Unit Type, Tower Name, Floor,
Unit No., **Shifting Date**, **BSP At time of Booking** (read-only reference), **Document Upload**,
**Change Area Type** toggle — *Increase Area* | *Final Area*, **Change Area Basic Price** (new rate
vs. the booking-time rate shown beside it), and **Remarks**.

OpenEstate's `Transfer` model has `transferType: UNIT | APPLICANT` with `carryForwardPaise` and a
fee rule — so unit-to-unit transfer is modelled. **Area change on the same unit is not**: there is
no path to revise a booking's area and re-price it while preserving the original BSP for audit.
4QT also treats these as one workflow with one approval trail, which OpenEstate splits.

### Gap I — Installments have no per-head, per-tax-component decomposition

This is the most structurally significant finding, from the supplied
`tax calculation reference file.pdf` (4QT's *Customer Head Wise Installment Detail*). **[VERIFIED — rendered live]**

That report is a three-dimensional matrix:

- **Rows:** every (Installment × Charge Head) pair — e.g. installment 4 "On Completion of Basement
  Slab" splits into four rows: *Basic Price* 790,272 · *PLC* 42,875 · *Club Membership* 25,000 ·
  *EDC/IDC* 143,631.
- **Column groups:** Total | Paid | Balance.
- **Sub-columns within each group:** Amount · Service Tax · CGST · SGST · Total Amount.
- Plus per-row **Installment Date** and **Invoice Date**.

Two observed rows show why this cannot be derived from what OpenEstate stores today:

- Installment 10 "On Completion of 15th Floor Slab" — Total: Amount 526,848, ST 2,017, CGST 11,780,
  SGST 11,780. **Paid: Amount 55,635, ST 2,017, CGST 0, SGST 0.** Balance: Amount 471,213, ST 0,
  CGST 11,780, SGST 11,780. A partial payment settled the service tax component *in full* while
  leaving principal and GST outstanding — i.e. **payment allocation has a component-level waterfall.**
- Installment 11 "On Completion of Final Floor Slab" — CGST 13,171 + SGST 13,171 on a base of
  526,848 = **5.0% total (2.5% + 2.5%)**, the post-April-2019 residential rate; installment 10 carries
  a *different* effective rate plus legacy Service Tax. **Tax rate is resolved per installment against
  its own date**, not once per booking.

OpenEstate today: `BookingCostLine` holds per-head base + CGST/SGST/IGST **at booking level only**;
`Installment.amountPaise` is a **single scalar**; `ReceiptAllocation` is
`(receiptId, installmentId, amountPaise)` — **a single amount, with no head and no tax-component
split**. **[VERIFIED]** The head-wise report is therefore not renderable from current data at any
level of query cleverness — it needs new tables. See §4.4.

---

## 3. Phased plan

Dependency graph: Phase 4 → Phase 5 (field config must exist before the big form is built, or
the form gets built twice). Phases 1–3 are independent of 4–5 and of each other in principle, but
share components; build in order. Phases 6–8 are independent of 1–5.

---

### Phase 1 — Lead Management workspace

**Closes:** Gap A. **Mostly frontend.**

**Build**

1. New page `apps/web/src/pages/presales/LeadManagement.tsx`, route `presales/leads`, permission
   `PRESALES_INQUIRY_READ`. Keep `presales/inquiries` working (redirect or leave as the simple list).
2. Filter bar backed by the existing `GET /inquiries` query params — audit that controller first and
   **add only the query params it lacks**: status, assignedToId, sourceId, inquiryTypeId,
   temperatureId, projectId, createdAt range, nextFollowupAt range, unassigned-only,
   overdue-follow-up-only, free-text (name/phone/email).
3. Result table columns: Applicant · Phone (masked per PII rules) · Project · Source · Type ·
   Temperature · Status · **Owner** · **Next follow-up** (with overdue styling) · Last activity · Created.
4. Row selection with a bulk action bar (bulk actions themselves land in Phase 2).
5. Saved views: persist filter sets per user. **[DECISION NEEDED]** — new `SavedView` table
   (`companyId, userId, entityType, name, filtersJson, isShared`) vs. localStorage. Recommend the
   table: shared team views are the actually-useful version, and localStorage loses them on
   device change.
6. Inline edit of Status and Temperature from the row, via existing `PATCH /inquiries/:id`.
7. Wire `TeamScopeService` from the first commit — per `docs/todo.md`, retrofitting scope onto a
   new list endpoint is exactly the failure mode `team-scope-guard.test.ts` exists to prevent.

**Acceptance (browser)**
Log in as a sales rep → open Leads → filter to "assigned to me, follow-up overdue" → confirm the
count matches a manual DB count → save the view → reload the page → view persists → change one
lead's temperature inline → confirm it persists after refresh → log in as a *different* rep and
confirm team scoping hides the first rep's leads.

---

### Phase 2 — Lead assignment + real-time status board

**Closes:** Gaps B and C. **Frontend + thin backend.**

**Build**

1. **Single assign** — assignee picker on the lead row and on `InquiryDetail.tsx`, calling the
   existing `PATCH /inquiries/:id/assign`.
2. **Bulk assign** — new `PATCH /inquiries/bulk-assign` taking `{ inquiryIds[], assignedToId, reason? }`.
   Must be transactional, must write one `InquiryAssignment` history row per inquiry, must respect
   team scope, and must cap batch size (suggest 200) to stay inside a sane transaction.
3. **Assignment pool admin UI** — new page for `GET /assignment-pool` + `PUT /assignment-pool/:userId`:
   per-project round-robin membership, weight/active toggle, and a plain-language explanation of
   `presalesCreatorRetainsLead` (already in `CompanyConfig`) so admins understand why interactively
   created leads bypass the pool.
4. **Assignment history** — render `InquiryAssignment` as a timeline on `InquiryDetail.tsx`
   (from → to → by → when → reason).
5. **Status board** — new `presales/leads/board`: kanban columns from `InquiryStatus`, cards
   draggable between columns (drag = `PATCH /inquiries/:id`), column counts, and a header strip of
   live counters: Due today · Overdue · Unassigned · New today · Converted this month.
   Use TanStack Query `refetchInterval` (30–60 s) plus refetch-on-focus.
   **Do not add websockets for this** — polling is sufficient at this data volume and keeps the
   self-hostable-first constraint clean.
6. **Escalation visibility** — surface `lastEscalatedAt` and the escalation rule that fired, as a
   badge on the card and a filter on the list. The engine already runs; it is currently invisible.

**Acceptance (browser)**
Select 5 leads → bulk assign to another rep → confirm all 5 move, each shows a history row, and the
previous owner no longer sees them → drag a card from Open to Successful on the board → confirm
`convertedAt` is set (not just `updatedAt`) → leave the board open 60 s and confirm counters refresh
without a manual reload.

---

### Phase 3 — Presales reports UI

**Closes:** Gap D. **Pure frontend against seven existing endpoints.**

**Build**

New page `apps/web/src/pages/presales/Reports.tsx`, route `presales/reports`, tabbed to mirror
`postsales/Reports.tsx` conventions (reuse its filter-bar and export components rather than writing
new ones):

| Tab | Endpoint | Presentation |
|---|---|---|
| Daily inquiries | `GET /reports/presales/daily-inquiries` | Line/bar by day + table |
| Funnel | `GET /reports/presales/funnel` | Stage funnel with conversion % between stages |
| Source-wise | `GET /reports/presales/source-wise` | Table + share chart, count and conversion per source |
| Budget band | `GET /reports/presales/budget-band` | Histogram across budget bands |
| Ageing | `GET /reports/presales/ageing` | Buckets (0-7 / 8-15 / 16-30 / 31-60 / 60+ days) |
| Staff performance | `GET /reports/presales/staff-performance` | Per-rep: assigned, contacted, converted, conversion % |
| Manager-wise | `GET /reports/presales/manager-wise` | Per-manager roll-up |

Every tab: date-range + project filter, CSV export, and print-friendly layout.

**Two known backend caveats to handle, not paper over:**

- `managerWiseInteractions()` currently reports each manager's **own** logged interactions, not a
  team roll-up (`docs/todo.md` — deliberate, from before `User.managerId` existed). `TeamScopeService.getVisibleUserIds`
  now makes the roll-up possible. **[DECISION NEEDED]** — upgrade it in this phase, or ship the
  report with an explicit on-screen note that it is individual-only. Do not ship it silently
  mislabelled as a team figure.
- Charts need a library. **[DECISION NEEDED]** — pick one (Recharts is the conventional fit for this
  stack) and record it in CLAUDE.md's decisions log; do not let two chart libraries enter the repo.

**Acceptance (browser)**
Open each of the seven tabs against seeded demo data → cross-check at least two figures per tab
against a direct DB query → export one tab to CSV and open it → confirm a rep (non-manager) sees
only their own scope.

---

### Phase 4 — Field Configuration master  ⚠️ *build before Phase 5*

**Closes:** Gap F. **The foundational phase of this document.**

This is the "modified and made mandatory from masters sections" requirement, generalised. Building
Phase 5's ~80-field form *first* and retrofitting configurability afterwards means writing the form twice.

**Build**

1. **New model `FormFieldConfig`:**

   ```prisma
   model FormFieldConfig {
     id           String   @id @default(uuid()) @db.Uuid
     companyId    String   @map("company_id") @db.Uuid
     formKey      String   @map("form_key") @db.VarChar(60)   // BOOKING_APPLICANT, BOOKING_UNIT, INQUIRY, BROKER…
     fieldKey     String   @map("field_key") @db.VarChar(80)  // salutation, passportNo, anniversaryDate…
     isVisible    Boolean  @default(true)  @map("is_visible")
     isRequired   Boolean  @default(false) @map("is_required")
     labelOverride String? @map("label_override") @db.VarChar(120)
     helpText     String?  @map("help_text") @db.VarChar(300)
     sortOrder    Int      @default(0) @map("sort_order")
     createdAt    DateTime @default(now()) @map("created_at")
     updatedAt    DateTime @updatedAt @map("updated_at")

     company Company @relation(fields: [companyId], references: [id])
     @@unique([companyId, formKey, fieldKey])
     @@map("form_field_configs")
   }
   ```

2. **A code-side field registry** (`packages/shared/src/form-fields.ts`) declaring every configurable
   built-in field per form: key, default label, data type, whether it is
   **structurally mandatory** (can never be switched off — e.g. unit, base price, booking date), and
   which master feeds it if it is a dropdown. `FormFieldConfig` rows may only reference registry
   keys; a config row for an unknown key is rejected. This mirrors the existing
   `MERGE_FIELD_REGISTRY` pattern in `packages/shared/src/documents.ts` — follow it.

3. **Server-side enforcement.** Requiredness must be enforced in the service layer against
   `FormFieldConfig`, **not only in the React form.** A zod DTO cannot express per-tenant
   requiredness statically, so validate the base DTO with zod, then run a
   `FormFieldConfigService.assertRequiredPresent(formKey, payload)` pass before persisting.
   Structurally-mandatory fields stay in the static zod schema as well.

4. **Admin UI** — `admin/field-config`, one tab per form, table of fields with Visible / Required /
   Label / Order controls, live preview, and a hard block on un-requiring a structurally-mandatory field.

5. **New masters** feeding the Phase 5 dropdowns. All are `SIMPLE_MASTERS` one-liners plus a Prisma
   model, seeded India-first per CLAUDE.md:
   - `Salutation` — Mr., Ms., Mrs., M/S., Dr., Major, Colonel, Brig., Captain, Advocate, Lt. Col.,
     Group Captain (4QT's real list — it serves a defence-heavy customer base)
   - `RelationType` — S/o, W/o, D/o, C/o, A/s
   - `Nationality` — Resident, PIO, NRI, OCI
   - `MaritalStatus` — Married, Unmarried, Not Specified
   - `Profession` — Businessman, Businesswoman, Doctor, Engineer, Government Employee, Lawyer,
     Teacher, Journalist, Actor, Other
   - `CustomerClassification` — seeded empty; company-defined
   - `CommunicationMode` — Courier, Email, SMS, By Hand, No Communication
   - `FundingType` — Self, Loan
   Gender stays a code enum (Male / Female / Transgender) — it is referenced by salutation defaulting
   logic and is not a business-configurable list.

**Acceptance (browser)**
In Field Config, mark Passport No. required and hide Anniversary Date → open the booking form →
Anniversary Date is gone, Passport No. blocks submit when empty → submit via API with Passport No.
omitted → **server rejects it** (proving enforcement is not client-only) → attempt to un-require
Booking Date → UI refuses and API rejects.

---

### Phase 5 — Booking form completion

**Closes:** Gap E. Depends on Phase 4.

Every field below is rendered through the Phase 4 registry, so each is per-company
visible/required/relabelable. Sections mirror 4QT so staff migrating between systems recognise the
layout. Full source spec: `crm-reverse-engineering/notes/booking-form.md`.

**5.1 Unit Information**
Add to the existing Unit step: Customer Classification · Broker | Direct toggle · **Main Broker**
(sub-broker chain — `Broker` self-reference may need adding) · **Normal Booking | Hold Unit** ·
Form No. (external/manual reference, distinct from `bookingNumber`) · **Registration No.**
(**[DECISION NEEDED]** — 4QT has both a Form No. and a Registration No. separate from the internal id;
decide whether OpenEstate's `bookingNumber` covers this or a second user-facing number is needed) ·
buyer **GSTIN** (validate with the existing GSTIN regex+checksum utility).

**5.2 Applicant identity — the largest delta**
Extend `Applicant` (and mirror onto `BookingCoApplicant` where per-booking): salutation · first /
middle / last name split (**keep the existing `name` column as the computed display value** so no
existing query breaks) · relation type + relation-person name · anniversary date · nationality ·
marital status · gender · number of children · passport no. · second email · profession ·
designation · company/firm · photo upload · **Power of Attorney details** (checkbox + detail block).

> **Deliberate deviation — Aadhaar.** 4QT captures an Aadhaar number and an Aadhaar document upload.
> CLAUDE.md states **"NEVER store Aadhaar numbers."** Do not add an Aadhaar field. If a pilot
> customer demands Aadhaar-based KYC, the supported path is an `ApplicantDocument` of a
> KYC document type holding a scanned proof, with the number itself never keyed into a column.
> Raise this explicitly with the customer rather than silently diverging in either direction.

**5.3 Applicant bank details**
Account name · account number · IFSC · bank (existing `Bank` master) · branch. Used for refunds and
interest payouts. New `ApplicantBankDetail` table (mirror the existing `BrokerBankDetail` shape).

**5.4 Addresses**
`ApplicantAddress` and its `PRESENT | OFFICE | PERMANENT` enum already exist and are unused by the
wizard. Wire all three, plus the "Fill office address / Fill permanent address" copy-from-present
shortcuts, a mailing-address selector (which of the three is used for correspondence), and preferred
communication mode.

**5.5 Discounts**
New `BookingDiscount` rows, `kind: COMPANY | BROKER`. 4QT accepts a discount as flat rupees,
per-sq-ft, or percentage and interconverts them.
**Implementation rule:** store the **entered form + entered value** *and* the resolved
`amountPaise`; do not store only the derived amount, and do not recompute historical discounts when
area or rate is later revised. Money math through the shared `Money` utility only.

**5.6 Sales attribution**
Sales Employee (required in 4QT) · RM · Remarks. Both are `User` references, distinct from the
`Broker` chain and from `createdById`.

**5.7 Other Costs**
Six toggles, each revealing a sub-form: PLC · Other Charge · Alteration/Scheme · IFMS/Fire Fighting ·
Extra Addon Charges · Extra Charge. These map onto existing `BookingCostLine.kind` /
`ChargeType` / `UnitPlc` machinery — this is mostly UI plus a `CostLineKind` review, not new financial
modelling. **[INFERRED — 4QT's sub-forms were gated behind project selection and not captured; treat
the existing OpenEstate charge model as authoritative and only add kinds that are genuinely missing.]**

**5.8 Finance / loan**
Funding type (Self | Loan) · financing bank · sanctioned amount · sanction date · loan account no. ·
disbursement tracking. 4QT keeps loan disbursements as a distinct payment-contribution stream from
own-contribution (visible on the Applicant File as a "Payment Contribution" table) — preserve that
distinction in the ledger so "Own Contribution vs Loan" is reportable.

**5.9 Nominee**
Nominee name · relation · DOB · address · share %. New `BookingNominee` table.

**Acceptance (browser)**
Complete a booking end-to-end with every section filled → reopen it and confirm every value round-trips →
generate an allotment letter and confirm the new merge fields resolve → hide three sections in Field
Config and confirm the wizard adapts without dead steps → confirm an existing pre-Phase-5 booking
still opens, still prints, and its ledger is byte-identical.

---

### Phase 6 — Allotment workspace + document print tracking

**Closes:** Gap G.

**Build**

1. **Allotment search page** `postsales/allotments` — filter bar (project · registration no · applicant
   name · unit no · allotment-date range) over existing booking data, with the 4QT column set:
   Registration No · First Applicant · Second Applicant · Unit No · Broker Company · Unit Type · Area ·
   Rate · Basic Price · Allotment Date · Print By · Print Date · Print Status · Allotment Letter ·
   Site Map.
2. **Print/download audit.** Extend `GeneratedDocument` (or add `DocumentPrintEvent`) with
   `printedById`, `printedAt`, and a derived Printed / Not Printed status. 4QT's equivalent
   (`UserWisePrintDownloadReport`) exists partly as a compliance control — pair this with the
   existing audit-log requirement rather than treating it as cosmetic.
3. **Site Map / unit plan.** Per-unit or per-unit-type floor-plan attachment, surfaced as a link
   from the allotment row and the customer portal. `ProjectMedia` exists and may extend to cover this —
   check before adding a table.
4. **Row status colouring.** 4QT colour-bands rows; the encoding was not determined **[INFERRED]**.
   Define an explicit, legended scheme (e.g. amber = allotment letter pending, pink = overdue on
   first installment) rather than copying colours whose meaning is unknown.

**Acceptance (browser)**
Filter allotments by project → generate an allotment letter for one → its row flips to Printed with
your name and timestamp → a second user sees the same status → export the list.

---

### Phase 7 — Unit shifting & area change

**Closes:** Gap H.

**Build**

1. **Unit shift request** — from a booking: choose target Unit Type / Tower / Floor / Unit, shifting
   date, remarks, supporting document upload. Reuse `Transfer` with `transferType: UNIT` and its
   existing `carryForwardPaise` + `transferFeeRuleId` machinery; do not build a parallel ledger path.
2. **Area change on the same unit** — the genuinely missing capability. `Change Area Type:
   Increase Area | Final Area`, new area, new basic price, with **BSP at time of booking retained
   and displayed** beside the revised figure. `UnitRateRevision` exists and is the right precedent —
   extend it or mirror it at booking level.
3. **Re-pricing and re-scheduling.** Changing area or unit changes agreed price, which changes every
   downstream installment. **[DECISION NEEDED]** — the policy for already-raised, already-partly-paid
   installments. Options: (a) revise only future installments, (b) revise all and post a
   differential debit/credit, (c) require the change to route through cancellation + rebooking above
   a threshold. This is a real business-rule decision; 4QT's own behaviour here was **not observed**
   (the write path was out of read-only scope) so it must be decided with the customer, not guessed.
   Whatever is chosen, the ledger stays append-only: adjustments are new entries.
4. **Approval trail** — request → approve/reject → applied, with actor and timestamp at each step.

**Acceptance (browser)**
Shift a booking to a new unit → old unit returns to available, new unit becomes booked → ledger shows
carry-forward and fee as new entries with nothing mutated → increase area on another booking →
installments re-plan per the chosen policy → original BSP still visible on the booking history.

---

### Phase 8 — Head-wise installment & tax ledger

**Closes:** Gap I. **Largest schema change here; sequence it last and migrate carefully.**

**Build**

1. **New `InstallmentComponent`** — decomposes each installment by charge head with its own tax:

   ```prisma
   model InstallmentComponent {
     id                     String   @id @default(uuid()) @db.Uuid
     companyId              String   @map("company_id") @db.Uuid
     installmentId          String   @map("installment_id") @db.Uuid
     costLineId             String?  @map("cost_line_id") @db.Uuid  // → BookingCostLine
     headLabel              String   @map("head_label") @db.VarChar(255)
     baseAmountPaise        BigInt   @map("base_amount_paise")
     serviceTaxPaise        BigInt   @default(0) @map("service_tax_paise")   // legacy pre-GST
     cgstPaise              BigInt   @default(0) @map("cgst_paise")
     sgstPaise              BigInt   @default(0) @map("sgst_paise")
     igstPaise              BigInt   @default(0) @map("igst_paise")
     gstRatePercentSnapshot Decimal  @default(0) @map("gst_rate_percent_snapshot") @db.Decimal(5,2)
     totalPaise             BigInt   @map("total_paise")
     invoiceDate            DateTime? @map("invoice_date") @db.Date
     sortOrder              Int      @default(0) @map("sort_order")
     @@index([companyId, installmentId])
     @@map("installment_components")
   }
   ```

2. **Extend `ReceiptAllocation` to component granularity.** Today it is
   `(receiptId, installmentId, amountPaise)`. It needs a component reference and a component-wise
   split — principal / service tax / CGST / SGST — because the reference data proves a partial payment
   can settle one tax component fully while leaving others open.
   **Migration is the risk here:** existing allocations have no component. Backfill them onto a
   synthetic single "Basic Price" component per installment so historical bookings keep balancing
   exactly, and **verify byte-identical ledger totals before and after** — the same discipline the
   plotted-inventory Phase A migration used.

3. **Allocation waterfall — [DECISION NEEDED].** The reference data shows Service Tax settled in full
   before principal and GST on a partial payment, but a single observation is not a specification.
   Define the waterfall explicitly, make it configurable in `CompanyConfig` if the customer's
   accountants disagree with the default, document it, and unit-test it with the exact observed row
   (base 526,848 / ST 2,017 / CGST 11,780 / SGST 11,780, payment 57,651 → expect Amount 55,635 +
   ST 2,017 fully, GST nil) as a golden-master fixture.

4. **Date-resolved tax rates.** Installment 11's 2.5% + 2.5% versus installment 10's mixed legacy
   Service Tax + GST confirms the rate is resolved per installment against its own date. `GstRate`
   already carries effective-date ranges — ensure component tax is computed by resolving the rate
   **as at the installment/invoice date**, never once at booking.

5. **The report** — `Customer Head Wise Installment Detail`: rows = installment × head, column groups
   Total / Paid / Balance, sub-columns Amount · Service Tax · CGST · SGST · Total, per-installment
   subtotal rows and a grand total. Header carries Name · Unit No · Booking Date · Plan · Print
   date/by (matching the reference layout). PDF + CSV export.

**Acceptance (browser)**
Regenerate the head-wise report for a fully-paid legacy booking → every Balance is zero and Total
equals Paid → make a partial payment against a mixed-tax installment → components settle per the
documented waterfall → totals still reconcile to `LedgerEntry` → confirm no pre-existing booking's
outstanding balance changed by even one paisa after the migration.

---

## 4. Consolidated schema delta

New models: `FormFieldConfig`, `SavedView` (Phase 1, pending decision), `Salutation`, `RelationType`,
`Nationality`, `MaritalStatus`, `Profession`, `CustomerClassification`, `CommunicationMode`,
`FundingType`, `ApplicantBankDetail`, `BookingDiscount`, `BookingNominee`, `BookingFinance`,
`InstallmentComponent`, `DocumentPrintEvent` (or `GeneratedDocument` extension).

Extended models: `Applicant` (identity fields, name split), `Booking` (classification, hold flag,
form/registration numbers, GSTIN, sales employee, RM, remarks), `Broker` (main-broker self-reference),
`ReceiptAllocation` (component granularity), `Transfer` (area-change support).

Migration risk ranked: **Phase 8 highest** (touches settled financial rows), Phase 5 medium
(`Applicant.name` split — keep the original column as computed), Phases 1–4, 6–7 low (additive).

---

## 5. Explicit non-goals

Do **not** clone these 4QT behaviours:

- **Native `alert()` validation.** 4QT uses blocking browser alerts for required-field errors —
  confirmed live, and it froze automated tooling twice during recon. Use inline field-level messages.
- **Aadhaar number storage.** See §5.2.
- **Unexplained row colouring.** Define a legended scheme; don't copy colours of unknown meaning.
- **Postback-style navigation.** OpenEstate is API-first; keep it that way.

## 6. Open decisions — resolved before building (audited against commit `dc2fa75`, decisions 6/7 answered by the requester)

1. **Saved views: DB table**, not localStorage. A shared "assigned to me, overdue" view is a team
   asset — localStorage loses it on device change and can't be shared. `SavedView(companyId, userId,
   entityType, name, filtersJson, isShared)`.
2. **`managerWiseInteractions`: upgrade to a real team roll-up now**, not shipped individual-only.
   `TeamScopeService.getVisibleUserIds` already exists to unblock exactly this — shipping a report on
   top of a number known to be mislabelled repeats a failure class this project has already been
   burned by.
3. **Chart library: Recharts.** Confirmed no chart library exists anywhere in the repo yet — this is a
   green-field pick, not a second-library risk. Record in CLAUDE.md's decisions log when Phase 3 lands.
4. **Registration No.: no second generated sequence.** `Booking.bookingNumber` stays the one
   system-generated identifier. `Booking.registrationDate` already exists with no paired number —
   add a plain user-entered nullable `registrationNumber` (the real government-registry document
   number, assigned later than booking) alongside it, plus a free-text `formNumber` for the external/
   manual reference. Neither needs `NumberSequence` machinery — both are externally sourced, not
   internally generated.
5. **Aadhaar: hold CLAUDE.md's line, raise with the pilot customer if/when it comes up.** Not a call
   this document or Claude Code makes either way.

6. **Re-pricing policy for already-raised/part-paid installments on area or unit change (Phase 7) —
   RESOLVED, requester decision, 2026-08-22:**

   Never regenerate a settled or already-raised installment — same discipline
   `PaymentPlanService` already uses for plan edits, just never applied to a re-pricing trigger before.
   The change is expressed as a **differential**, not a schedule re-spread:

   - `delta = (newArea − oldArea) × rate`, where `rate` **defaults to the booking-time BSP but is
     operator-overridable** — mirrors 4QT's "Change Area Basic Price" (editable) shown beside a
     read-only "BSP At time of Booking". **Both values are stored permanently**; the original BSP
     must remain visible forever, never overwritten.
   - Where the delta lands depends on schedule state, all three cases required:
     - **Unpaid installments remain** → post the differential to a named installment (default:
       the possession/final one) **or** spread across the unpaid tail — **a `CompanyConfig` toggle**,
       not a hard-coded choice.
     - **Fully paid + positive delta** → raise a standalone `ExtraCharge` demand (existing model,
       no new financial primitive).
     - **Negative delta (area reduced)** → post a credit; if no future dues exist to net against,
       route through the existing `Refund` path.
   - **Never cancel+rebook, at any threshold.** It re-dates the booking, which shifts which `GstRate`
     resolves against it — a silent tax-regime change, not a neutral operational shortcut.
   - The area-change record stores the **measured variance %** as a first-class field (not just the
     new area, computed ad hoc later) and gates on the **RERA §14 threshold**: buyer consent required
     above it; a reduction beyond it **must** refund the excess **with interest**, not merely credit it.

7. **Payment allocation waterfall across principal and tax components (Phase 8) — RESOLVED, requester
   decision, 2026-08-22:**

   **Pro-rata** across components (the existing `allocate()` largest-remainder helper), with two
   qualifications that are load-bearing, not optional refinements:

   1. **Allocate only across components already invoiced/raised as of the receipt date.** Before
      trusting the one observed 4QT row (Service Tax settled in full ahead of principal/GST) as
      evidence of a deliberate priority, **check that installment's own Invoice Date column** — the
      far more likely explanation is that CGST/SGST simply hadn't been invoiced yet when that
      payment landed, which pro-rata-over-invoiced-components already reproduces without needing a
      tax-first rule at all.
   2. **Never recompute component balances for migrated/legacy data.** Import legacy part-paid
      component balances **verbatim**; the pro-rata waterfall governs **new receipts only**. This is
      how migration achieves parity without silently adopting whatever produced the legacy ordering.

   **Explicitly rejected reasoning, recorded so it isn't re-litigated later:** "tax-first prevents
   under-remitting" is not correct — GST liability crystallises on the earlier of invoice date or
   payment date (CGST Act §13), so once a demand is invoiced the remittance obligation is already
   fixed regardless of how a partial receipt is internally split. Allocation choice affects customer
   statements, the delay-interest base, and TDS 194-IA's ex-GST consideration figure — **not** the
   company's tax remittance obligation itself. Golden-master fixture for the observed row (base
   526,848 / ST 2,017 / CGST 11,780 / SGST 11,780, payment 57,651) must be built **after** confirming
   its Invoice Date, not assumed to validate a tax-first rule.
