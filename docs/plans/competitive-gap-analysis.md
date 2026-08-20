# Competitive gap analysis — OpenEstate vs. 4QT Real Estate ERP

Source: `crm-reverse-engineering/REPORT.md` and its `notes/` (reverse-engineering
of a live, mature Indian post-sales real-estate ERP — read-only recon, see that
report's own [OBSERVED]/[INFERRED]/[ASSUMPTION] tags for its confidence levels).

**This is domain research, not a spec.** 4QT's workflows reflect what Indian
developer back-offices actually expect from a system like this; its UI (ASP.NET
WebForms postbacks, native `alert()` validation) is legacy and explicitly not
worth copying — OpenEstate's architecture (RLS multi-tenancy, append-only
ledger, REST+SPA) is already a stronger foundation than what was reverse
engineered. The gaps below are about *capability coverage*, not implementation
quality.

**Method.** Every row is checked against the actual OpenEstate schema
(`packages/db/prisma/schema.prisma`) and service code, not against memory or
the CLAUDE.md decisions log alone. "Have" means a real schema/service/endpoint
exists and was located; "Partial" names exactly what's missing; "Missing"
records that a grep for the concept returned nothing. Evidence cites a real
file/model/line, or states "not found" — never asserted without a citation.

---

## 1. Set Master (company, employees, RBAC, security)

| Capability | Status | Evidence |
|---|---|---|
| Multi-company (legal entity) master | Have | `Company` model, `schema.prisma` |
| Employee master with dept/manager/team hierarchy | Partial | `User.managerId` scalar FK (v0.4) gives manager hierarchy; no separate Department/Team models — org structure is flatter than 4QT's Department/Team/Team-Head/Employee-Tree/Tower-mapping set |
| Login/role assignment | Have | `User.roleId`, `Role` model |
| Role-based permissions | Have — different mechanism | `PERMISSIONS` flat key list (~142 keys, `packages/shared/src/roles.ts`) + `role_permissions` rows, checked in guards. **Not** 4QT's page-registry checkbox tree (464 individually-togglable menu items) — OpenEstate's model is a flat permission-key set, not "show/hide this exact screen for this role." See §8 RBAC below for the full comparison. |
| Document-type master | Have | `DocumentType` model |
| Customised/letter templates | Partial | `LetterTemplate` model + `MERGE_FIELD_REGISTRY`, but only 5 document types are ever generatable (`GENERATED_DOCUMENT_TYPE`: STATEMENT/RECEIPT/ALLOTMENT_LETTER/DEMAND_LETTER/REMINDER_LETTER) plus BROKER_STATEMENT — no BBA/agreement, TPA, RERA-agreement, or free-form Word-upload letter types; the enum is closed, not extensible without a schema change |
| Security: password policy, login history | Have | argon2id, `RefreshToken`, audit log (see below) |
| Security: IP allowlisting | **Missing** | grep for `ipAllowlist`/`ipRestrict` across repo: no matches |
| Audit log (who did what, before/after diff) | Have | `AuditLog` model (Phase 1); CLAUDE.md security rules require it on every domain create/update/delete |
| Print/download audit tracking (who exported what) | **Missing** | No distinct export/print/download audit event type found; `AuditLog`'s action set is create/update/delete-shaped, not print/export |
| DB backup tooling in-admin-UI | Have — ops-level, not in-app | `deploy/native/backup-native.sh`/`restore-native.sh`, not an admin-UI action |

## 2. Set Projects (project/inventory/payment-plan/GST configuration)

| Capability | Status | Evidence |
|---|---|---|
| Project → Tower → Floor → Unit hierarchy | Have | `Project`/`Tower`/`Floor`/`Unit` models |
| Non-tower inventory (plots/farmhouses) | Have (Phase A just landed) | `InventoryShape` enum, `InventoryGroup` model, `docs/plans/plotted-farmhouse-inventory.md` — genuinely ahead of 4QT here, which has no equivalent |
| Unit types with area | Have | `UnitType` model |
| PLC / Other-charge / Addon-charge masters, pre-attachable to units | Have | `PlcType`, `ChargeType`, `UnitPlc`, `UnitCharge` (v0.2.0) |
| Payment Plan templates (percent-based milestones) | Have | `PaymentPlanTemplate`/`PaymentPlanMilestone` |
| Payment Plan **types** (Construction/Down-Payment/Flexi/Time/EMI as distinct behaviors) | **Missing** | No `planType` enum anywhere on `PaymentPlanTemplate` — every milestone gets the same treatment: `dueDate = bookingDate + dueOffsetDays` at instantiation (`payment-plan.service.ts:67`). See the correctness-bug writeup (Task 1) — this is the direct cause of that bug, not just a labeling gap. |
| Stage Master (construction milestones, independent of a payment plan) | **Missing** | No model; `ConstructionUpdate` is a photo gallery (`schema.prisma:2465`, own doc comment: "Monthly construction-progress gallery"), not a stage-completion trigger anything reads |
| Demand Raise (stage → due-date-and-amount transition, admin-triggered) | **Missing** | No concept anywhere — due dates are always pre-computed at booking time; there is no "raise this stage" action |
| Rate management with change history | Have | `UnitRateRevision`, append-only, monotonic dating |
| Unit-wise / project-wise rate reports | Partial | Rate revisions are queryable per-unit; no dedicated "rate change report" endpoint found |
| GST engine: date-effective slabs | Have | `GstRate.effectiveFrom`/`effectiveTo` (`schema.prisma:572`) |
| HSN/SAC codes | Partial | Free-text `ChargeType.hsnSac` field (`schema.prisma:558`) — no separate HSN/SAC lookup master with description, unlike 4QT's dedicated table |
| Per-project GSTIN + RERA number | Have | `CompanyConfig.gstStateCode`/`companyGstin` (company-level, not per-project); `Project.reraNumber` |
| Completion Certificate tracking (tower/unit-wise) | **Missing** | No field or model found |
| Booking/receipt/registration-number auto-numbering rules | Have | `NumberSequence` — gap-free, transaction-scoped allocator (Phase 4) |
| Customer classification / tag master | **Missing** | grep for `classification`/`tag` in schema: no matches |

## 3. Broker / channel-partner management

| Capability | Status | Evidence |
|---|---|---|
| Broker onboarding (KYC, bank, GST/PAN) | Have | `Broker`, `BrokerBankDetail`, PAN encryption (Phase 5) |
| Sub-broker hierarchy | **Missing** | grep for `parentBrokerId`/sub-broker anywhere in schema: no matches — `Broker` is a flat model |
| Project-broker mapping (which brokers can sell which projects) | **Missing** | No join table found; brokers attach directly at booking time (`Booking.brokerId`), with no project-eligibility gate |
| Broker TDS (194-H) on commission payouts | Have | `CommissionPaymentService.pay()`, CLAUDE.md Phase 5 decisions — server-computed, settled-not-receivable (correctly asymmetric vs the customer-side 194-IA) |
| Slab-based commission | Have | `BrokerCommissionRule`/`BrokerCommissionSlab`, half-open matched (not marginal) slabs |
| Dedicated brokerage payment ledger | Have | `CommissionLedgerEntry`, `CommissionPayment` |
| Investor/Hold (broker places a temporary hold pre-booking) | Partial | `UnitStatus.HELD` exists as a state, but there's no broker-attributed hold record — a HELD unit doesn't record *which* broker/investor placed the hold |

## 4. Application module — booking through exit

### 4a. Booking & Allotment

| Capability | Status | Evidence |
|---|---|---|
| Multi-applicant booking (primary + co-applicants) | Have | `Booking`/`BookingCoApplicant` |
| Applicant type toggle (Individual/Multiple/Company) | **Missing** | No `Applicant.type` or company-applicant fields (GSTIN-for-a-corporate-buyer, etc.) found |
| Company-funded discount | **Missing** | grep for `discount` across the entire schema: **zero matches**. No discount field on `Booking`, `BookingCostLine`, or anywhere else. |
| Broker-funded discount (tracked separately from company discount) | **Missing** | Same — no discount concept of any kind exists to separate by funding source |
| Allotment as a distinct record (own date, e-stamp ref, penalty, possession pre-scheduling) | Partial | Only `Booking.allotmentDate` (`schema.prisma:1455`) + an `ALLOTMENT_LETTER` document type. No e-stamp reference field, no allotment-level penalty tracking, no possession pre-scheduling record. |
| KYC document upload + tracking | Partial | `ApplicantDocument` stores uploaded files with a `documentTypeId`; no "required vs uploaded" checklist state — can't distinguish "nothing pending" from "nothing configured," since there's no per-booking required-document list to diff against |

### 4b. Demand, GST invoicing, receipts

| Capability | Status | Evidence |
|---|---|---|
| Installment generation from a payment plan | Have (but see the correctness bug) | `PaymentPlanService.instantiateFromTemplate`/`createCustomPlan` |
| Demand Raise as a distinct, admin-triggered step | **Missing** | See §2 above — this is the root of the Task-1 correctness bug |
| GST tax invoicing (invoice number sequence, invoice as a document with status) | **Missing** | grep for `Invoice`/`invoice` across the whole schema: **zero matches**. GST is computed and snapshotted per cost line (`cgstPaise`/`sgstPaise`/`igstPaise`, `schema.prisma:1526-1528`) — real tax math exists — but there is no `Invoice` entity, no invoice numbering, no invoice status (issued/cancelled), and therefore nothing to reverse or credit/debit-note against as a *document*. What exists is tax-correct receipts and ledger entries, not GST-compliant invoicing. |
| Invoice reversal / credit note / debit note | **Missing** | Follows directly from the above — no invoice document to reverse. Ledger corrections exist (`reversalOfEntryId`) but that's a bookkeeping reversal, not a GST-compliant credit/debit note with its own number and legal status. |
| Multi-mode receipts (Cash/Cheque/Draft/Online/Adjust/TDS-Challan/Card) | Partial | `ReceiptMode` enum exists but not confirmed to cover all 7 4QT modes (TDS-Challan and Adjust specifically need checking against the actual enum values — not verified this pass) |
| Receipt "on account of" earmarking to a specific installment | Have | `ReceiptAllocation` |
| Suspense account (unallocated/unidentified receipt held until matched) | **Missing** | `Receipt.bookingId` is `NOT NULL` at the schema level (`schema.prisma:1667`) — a receipt cannot exist without an assigned booking. There is no way to record "money came in, we don't yet know whose it is." |
| Receipt edit/reset (mutate a posted receipt) | **N/A by design — architecturally stronger** | OpenEstate's ledger is append-only (CLAUDE.md Phase 4: `forbid_financial_mutation` DB trigger); corrections are reversal entries, never edits. 4QT's "Edit/Reset Receipt" is the kind of mutable-financial-record pattern this project deliberately rejects. Not a gap — a different, more audit-safe design. Recorded here so the ranking below doesn't miscount it as missing functionality. |
| Cheque lifecycle: Pending → Deposited → Cleared/Bounced | Have | `ChequeClearanceStatus` enum (`NOT_APPLICABLE/RECEIVED/DEPOSITED/CLEARED/BOUNCED`), `ChequeStatusEvent`, `Receipt.recordChequeEvent()` |
| Batch cheque deposit (select N pending cheques → deposit together to one bank account) | **Missing** | `recordChequeEvent` operates on one receipt at a time (`receipt.service.ts:223`); no batch-select-and-deposit endpoint found |
| Cheque bounce → re-presentation loop | Partial | Bounce correctly reverses ledger allocation and flips `isReversed` (REPORTS-phase fix, CLAUDE.md) — but no "re-present the same instrument" transition found; a bounced cheque appears to require a brand-new receipt, not a re-presentation of the same one |

### 4c. Interest, Transfer, Cancellation, Registry

| Capability | Status | Evidence |
|---|---|---|
| Delay-interest engine (SIMPLE/COMPOUND, per-installment) | Have | `InterestService.accrueInTx()`, declining-balance, cursor-based, idempotent |
| Interest overrides at 3 levels (project → installment → customer) | **Missing** | `InterestRule` (`schema.prisma:607`) has exactly one scope: attached once via `Booking.interestRuleId`. No installment-level or customer-level override table exists. |
| Grace period (days before interest starts) | **Missing** | grep for `gracePeriod`/`grace_period` across the whole repo: **zero matches**. Interest accrues from `dueDate` with no configurable buffer. |
| Interest waiver | Have | `INTEREST_WAIVER` ledger entry type (audited credit, never edits the accrual) — CLAUDE.md Phase 4 |
| Addon-charge-specific interest configuration | **Missing** | Interest only ever runs against `Installment` rows; `ExtraCharge` has no interest linkage found |
| GST on interest charged | **Missing** | `INTEREST` ledger entries post the raw interest amount; no GST computation on top of it was found (4QT's "GST On Interest Due" line item has no OpenEstate equivalent) |
| Transfer (ownership change) | Have | `Transfer` model, carry-forward balance conservation (Phase 4) |
| Transfer fee, pre- vs post-registry distinct rules | Partial | `TransferFeeRule` master exists; `Transfer` has no `isAfterRegistry`-equivalent flag or distinct fee/flow branching by registry status (`schema.prisma:1760` — no such field) |
| Cancellation (deduction + settlement) | Have | `Cancellation` model, two-phase settlement, CancellationRule master (Phase 4) |
| Cancellation restore (soft-cancel → restore, and a separate "final" restore) | **Missing** | `cancellation.service.ts` has no restore-related code at all (grep confirms). OpenEstate's cancellation is one-way/terminal — once cancelled, there is no reinstatement path. |
| Registry as a workflow (Pending/Approved/Rejected states, deed no., sub-registrar office, stamp duty) | **Missing** | Only `Booking.registrationDate` (`schema.prisma:1456`) and a `REGISTERED` unit/booking status exist. No deed number, no sub-registrar office field, no stamp-duty tracking, no approval state machine — registry in OpenEstate is a single date stamp, not a record with its own lifecycle. |

### 4d. Loan / finance tracking

| Capability | Status | Evidence |
|---|---|---|
| Buyer home-loan/finance details (lender, sanctioned amount, disbursal schedule) | **Missing** | grep for `loan`/`finance detail`/`mortgage` in schema: zero matches |
| Loan disbursal report | **Missing** | Follows from the above — nothing to report on |

## 5. Possession

| Capability | Status | Evidence |
|---|---|---|
| Planned vs. actual possession date tracking | **Missing** | grep for `possessionDate`/`Possession` model across the whole schema: zero matches. `ConstructionUpdate` is a photo gallery, not a possession-date record. |
| Possession-ready report | **Missing** | Nothing to query — no possession data model exists |

## 6. Reports and dashboards

| Capability | Status | Evidence |
|---|---|---|
| Collection Summary (payment-mode × count breakdown) | Have | `postsales-reports.service.ts:collectionSummary()`, correctly excludes bounced (`isReversed`) receipts |
| Dues report (5-way pivot: Project/Tower/UnitType/Plan/Broker) | Partial | `duesAgeing()` exists (`postsales-reports.service.ts:307`); full 5-axis pivot parity not verified this pass — likely narrower than 4QT's combine-report |
| Project-wise / company-wide sales & collection rollups | Have | Confirmed via CLAUDE.md v0.2.0-era decisions (`BrokerReportsService`, postsales reports module) |
| Inventory reports (sold/available, unit-cost, PLC breakdown) | Have | Unit status counts + PLC/charge data exist and are queryable; dedicated report endpoints for this shape not individually re-verified this pass |
| Ad-hoc Report Builder (user-defined columns/filters) | **Missing** | No such capability found or referenced anywhere in the API surface |
| CSV/Excel export on report screens | Have | `streamCsv` util, chunked transfer encoding (Phase 4-UI) |
| Birthday / anniversary report | Have | Named explicitly in the REPORTS-phase walkthrough (CLAUDE.md) as one of the 9 report types checked |

## 7. Communications (Email/SMS/WhatsApp)

| Capability | Status | Evidence |
|---|---|---|
| Templated Email | Have | `NotificationService`, `CommunicationLog`, SMTP-based dev provider (Phase 3/6) |
| Templated SMS | Have (pluggable) | `COMMUNICATION_PROVIDER` DI token; MSG91/Textlocal/generic-HTTP as plugins per CLAUDE.md's India-first rules |
| WhatsApp (templated, multi-provider) | **Missing** | grep for `whatsapp` across `apps/api/src`: zero matches |
| Shared merge-field templating | Have | `MERGE_FIELD_REGISTRY` (`packages/shared/src/documents.ts`) |
| Delivery tracking/history per channel | Have | `CommunicationLog` |
| 2-tier reminder cadence (demand + 2 reminders, tracked sent/unsent) | Partial | `DEMAND_LETTER`/`REMINDER_LETTER` document types exist and can be generated; a dashboard widget explicitly tracking Unsent/Sent counts per reminder tier (4QT's Home Dashboard widget) was not found |
| Bulk/marketing messaging (Address Book, Excel import, scheduled bulk send) | **Missing** | No `AddressBook` or bulk-messaging model/service found — everything communications-related is transactional/per-entity |

## 8. RBAC — mechanism comparison, not a simple have/missing

4QT: two-layer — coarse Add/Edit/Delete/RightClick flags **plus** a 464-item
checkbox tree that independently shows/hides every single navigable page per
role. OpenEstate: a flat set of ~142 permission keys
(`packages/shared/src/roles.ts`), checked by NestJS guards **and** enforced a
second time by Postgres RLS (CLAUDE.md: "RBAC with permissions checked in
guards AND row-level security... never only in controllers"). This is a
different and arguably more defensible security model — a permission key maps
to an actual authorization boundary (can this role call this endpoint /
mutate this row), not merely to whether a menu item renders. But it does not
give an admin 4QT's exact operator experience of "hide screen X from role Y"
for screens that have no independent permission key of their own (e.g. every
authenticated staff user who can reach `/admin/masters` sees ALL 17 master
types — there's no per-master-type visibility toggle). Recorded as a design
difference, not scored as have/missing in the ranking below.

---

## Ranked gaps

Ranked by: **(1) compliance requirement for an Indian developer, (2)
correctness issue, (3) operational convenience.** Within each tier, roughly
most-to-least severe.

### Tier 1 — compliance

1. **GST tax invoicing is entirely absent** (no `Invoice` entity, no invoice
   numbering, no reversal/credit-debit-note concept). GST *tax calculation*
   is correct and already shipping (CGST/SGST/IGST snapshotted per cost
   line, place-of-supply rules, effective-dated rate slabs) — what's missing
   is the *document*: an Indian developer is legally required to issue a
   proper GST invoice per demand, with a compliant invoice number sequence,
   and to issue credit/debit notes for corrections rather than silently
   editing a receipt. This is the single largest compliance gap found.
2. **No GST-on-interest.** 4QT charges GST on delay interest as its own
   line item; OpenEstate's `INTEREST` ledger entries carry no tax
   component. If GST is legally due on penal interest under a
   developer's actual tax treatment, this understates every invoice
   that includes overdue-installment interest.
3. **No HSN/SAC lookup master** — only a free-text field on `ChargeType`.
   Functionally works today, but has no description/validation and can't
   be centrally maintained or reported on the way a real HSN/SAC master
   would be.

### Tier 2 — correctness

4. **The construction-linked payment-plan bug from Task 1** (every
   milestone gets a due date at booking time regardless of whether it's
   a time-based or construction-stage milestone; OpenEstate's own seed
   data ships a "Construction-Linked Plan" template with stage-named
   milestones — Excavation/Plinth/Superstructure/Finishing — that are
   due purely by day-offset). This produces false "overdue" states and
   real, wrongly-charged delay interest against customers on stages the
   builder hasn't reached. See the separate Task 1 report for full
   detail; this needs its own design pass before touching installment
   generation or the interest engine, per your own instruction not to
   fix it in this pass.
5. **No grace period on interest.** Every legitimate scenario 4QT's
   grace-period master exists for (a few days' float before penal
   interest starts, standard in Indian real-estate collections) has no
   equivalent — interest technically starts accruing the instant a
   `dueDate` passes, which, combined with gap #4, compounds the false-
   overdue problem.
6. **Single-level interest configuration** (booking-level `interestRuleId`
   only) vs. 4QT's project → installment → customer override cascade.
   Not wrong by itself, but it means there's no way to grant one
   customer a negotiated rate, or override one specific installment's
   rate, without editing the booking's one rule for everything.
7. **Registry has no workflow** — a single `registrationDate` field with
   no deed number, sub-registrar office, stamp duty, or approval state.
   Not a correctness bug today (nothing currently reads or depends on a
   richer registry model), but any report or process that assumes
   "REGISTERED means legally registered with recorded details" would be
   assuming data that doesn't exist.
8. **Cancellation has no restore path.** 4QT's soft-cancel-then-restore
   pattern exists because cancellations are sometimes entered in error
   or reversed by negotiation; OpenEstate's cancellation is one-way. If
   that happens today, the only recovery is a brand-new booking, which
   breaks booking-number continuity and loses the original ledger
   history's continuity with the "same" sale.

### Tier 3 — operational convenience

9. **No suspense account for unallocated receipts.** `Receipt.bookingId`
   is mandatory — money can't be recorded before it's matched to a
   booking. In practice, cash and NEFT payments sometimes arrive before
   the accounts team knows which booking they belong to; today that
   forces either a delay in recording or a guess.
10. **No company-vs-broker-funded discount model at all.** Zero discount
    concept anywhere in the schema. If any real deal involves a
    price reduction (common), it currently has to be absorbed into a
    lower `agreedPricePaise` with no record of what the "list price"
    or the discount's funding source was — no audit trail for why a
    sale priced below rate card, and no way to separately track
    broker-funded vs. company-funded rebates for commission-basis
    purposes.
11. **No possession tracking** (planned vs. actual date). Currently
    nothing records this at all; low correctness risk since nothing
    else depends on it yet, but it's a named milestone every developer
    tracks and currently has to live outside the system.
12. **No loan/finance tracking** for buyer home loans — purely an
    operational data-capture gap, no downstream calculation depends
    on it today.
13. **No batch cheque deposit.** Cheque status changes one receipt at a
    time; an accounts team depositing 20 cheques in one bank run has no
    single action to do that.
14. **No sub-broker hierarchy or project-broker eligibility mapping.**
    Matters for larger channel-partner operations; a flat broker list
    with no gating is a real limitation once a developer works with
    broker networks rather than individual brokers.
15. **No WhatsApp channel**, no bulk/marketing Address Book messaging
    subsystem, no ad-hoc Report Builder, no IP allowlisting, no
    completion-certificate tracking, no customer classification/tag
    master. All named gaps, all genuinely missing, all lower-severity
    than the above — pure feature-parity items with no correctness or
    compliance exposure on their own.

### Explicitly not a gap (design decisions worth keeping)

- **Append-only ledger vs. 4QT's edit/reset receipt.** OpenEstate's
  "corrections are reversals, never mutation" design (CLAUDE.md
  principle 2) is a strictly better audit posture than 4QT's mutable
  receipt-edit pattern. Do not "fix" this toward parity.
- **RLS + guard-level RBAC vs. a page-registry checkbox tree.**
  Different mechanism, arguably stronger security boundary (a
  permission key gates the actual write, not just menu visibility).
  Worth a targeted "per-screen granularity" pass if a future pilot
  customer specifically asks for it, but not a straightforward parity
  gap.
