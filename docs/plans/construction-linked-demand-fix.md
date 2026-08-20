# Construction-linked demand fix — plan (revision 2, approved)

**Status: APPROVED, implementation in progress.** Jumps ahead of
plotted-inventory Phase B and the competitive-gap-analysis ranked list, per
explicit instruction — this is a correctness bug, not a feature.

## Revision 2 — two approved clarifications

**1. Prepayment (§2.1) is resolved: disallow at ALLOCATION time, not
receipt time.** A customer transferring money ahead of a milestone is
normal; refusing their receipt is not. `Receipt` creation stays exactly as
it is today — nothing about accepting a receipt changes. What's excluded
is allocating that money AGAINST a specific unraised installment: consumer
#8/#9's filter fix (excluding null-`dueDate` installments from the
allocation/demand-letter pickers) is now understood as an allocation-time
rule, enforced in the frontend picker **and** re-enforced server-side in
whatever validates an allocation's target installment (defense in depth,
matching the pattern already used at consumer #5).

This is deliberately **not a complete answer** — if a booking has zero
raised, unpaid installments left (every remaining one is STAGE_LINKED and
unraised), a receipt has nowhere valid to allocate under today's model,
because `Receipt.bookingId` is mandatory and there's no unmatched-receipt
state to hold the money in. That gap is the suspense-account capability the
competitive-gap-analysis already named as missing. **Not built in this
pass** — but the raise mechanism is deliberately shaped so building it
later is a clean addition, not a redesign:

- Every raise (bulk, or self-raise-at-instantiation) is implemented as a
  per-installment write inside one transaction (§1.6), not a single bulk
  `UPDATE` statement. That per-row loop is the natural hook point for a
  future suspense-sweep: the moment an installment's `dueDate` gets set is
  exactly the moment any suspended, unallocated receipt balance sitting
  against that booking should auto-apply against it.
- Both raise paths (the bulk endpoint and self-raise-at-instantiation) call
  one shared, plain "apply this raise to this installment" primitive
  (§1.6, implementation note) — so a future suspense-sweep step is added
  in exactly one place, not duplicated across two call sites.
- Nothing in this pass writes a special-case bypass (e.g., "allow
  allocation against a null-`dueDate` installment just this once") that a
  future suspense feature would have to detect and unwind.

**2. Custom plans: DATE_LINKED is now set explicitly, not left to the
schema default.** `createCustomPlan`/`editPlan` will literally write
`milestoneType: MILESTONE_TYPE.DATE_LINKED` in the `data` object at both
`tx.installment.create()` call sites, rather than relying on the column's
`@default(DATE_LINKED)` to supply it implicitly by omission. This is
**by design, not decoration**: a human choosing a specific due date on a
custom-plan row IS date-linked semantics — that's a real decision being
made at that call site, and writing it down is what keeps it a decision
instead of an accident. The day someone extends `installmentInputSchema`
to let a custom-plan row carry `STAGE_LINKED` too (the deferred follow-up
named in §1.7), they have to affirmatively touch this explicit line — an
implicit default would have let that change silently reintroduce exactly
the bug this whole fix exists to close, for exactly the rows a schema
default can't tell apart from a deliberate choice.

Everything else in revision 1 is approved unchanged: the separate
`graceDaysAfterRaise` field, `StageRaise` as the single audit-trail shape,
bulk-only raising with self-raise-at-instantiation for late bookings, the
migration position (existing data untouched, `DATE_LINKED` by backfill
default), the seed fix, and keeping `ConstructionUpdate` separate.

## 0. The bug, restated precisely

`PaymentPlanMilestone` has no concept of *what* makes a milestone due. Every
milestone — "On Booking" and "Superstructure" alike — is instantiated the
same way: `dueDate = bookingDate + dueOffsetDays`
([payment-plan.service.ts:67](../../apps/api/src/postsales/payment-plan.service.ts)).
There is no "raise" step, no stage-completion record, nothing that
distinguishes a calendar-driven installment from a construction-driven one.
`Installment.dueDate` is `NOT NULL` — a date is *always* there, whether or
not the real-world event it's supposed to represent has happened.

Consequence: a customer on a construction-linked plan is shown overdue,
accrues delay interest, and can receive a demand letter naming days-past-due
— for a stage the builder hasn't reached. This isn't hypothetical: the
project's own seed data ships a "Construction-Linked Plan" template with
milestones literally named Excavation/Plinth/Superstructure/Finishing, each
due by a hardcoded day-offset from booking date
([seed.ts:274](../../packages/db/prisma/seed.ts)).

---

## 1. The model

### 1.1 New enum

```prisma
enum MilestoneType {
  DATE_LINKED   // due at bookingDate + dueOffsetDays — current, unchanged behaviour
  STAGE_LINKED  // no due date until the stage is raised
}
```

### 1.2 `PaymentPlanMilestone` gains two fields

```prisma
milestoneType        MilestoneType @default(DATE_LINKED) @map("milestone_type")
graceDaysAfterRaise  Int           @default(0) @map("grace_days_after_raise")
```

`dueOffsetDays` keeps its exact current meaning ("days after booking date")
and is only consulted for `DATE_LINKED` milestones. `graceDaysAfterRaise` is
a **new, separately-named** field for the `STAGE_LINKED` case, deliberately
not a reinterpretation of `dueOffsetDays`. I considered reusing
`dueOffsetDays` for both ("days after whichever anchor applies") to avoid
adding a column, and rejected it: the field's name would then lie for half
its uses, and this codebase's own established style (see, e.g., how much
care went into `landAreaEntered`'s two-column design in the plotted-inventory
plan, specifically to avoid one column silently meaning two things) leans
hard against that kind of overload for anything date/money-adjacent. One
extra `NOT NULL DEFAULT 0` column is a small, safe price for a formula that
reads unambiguously:

```
DATE_LINKED:  dueDate = bookingDate + dueOffsetDays
STAGE_LINKED: dueDate = stageCompletedOn + graceDaysAfterRaise   // only set once raised
```

### 1.3 `Installment` gains three fields; `dueDate` becomes nullable

```prisma
milestoneType MilestoneType @default(DATE_LINKED) @map("milestone_type")
dueDate       DateTime?     @map("due_date") @db.Date              // was NOT NULL
stageRaiseId  String?       @map("stage_raise_id") @db.Uuid
```

`milestoneType` is copied down from the template milestone at instantiation
time — the exact same pattern `milestonePercent` already uses (a template
field, snapshotted onto the instantiated row, never re-read from the
template later). This is deliberate, not incidental: it means a later edit
to a *template's* milestone type can never retroactively change what an
already-instantiated installment is, matching this codebase's existing
snapshot discipline for financial data (commission rules, GST rates on cost
lines, rate revisions — CLAUDE.md's Phase 4/5 decisions all follow this
shape).

New CHECK constraint, `installments_due_date_by_type_chk`:

```sql
(milestone_type = 'DATE_LINKED' AND due_date IS NOT NULL) OR (milestone_type = 'STAGE_LINKED')
```

This is the DB-level guarantee that DATE_LINKED behaviour can never silently
regress to a null date — mirrors the `units_shape_hierarchy_chk` pattern
from this session's plotted-inventory Phase A work: an invariant worth
enforcing at the row level, not just trusted to application code.

### 1.4 New model: `StageRaise`

```prisma
model StageRaise {
  id               String    @id @default(uuid()) @db.Uuid
  companyId        String    @map("company_id") @db.Uuid
  projectId        String    @map("project_id") @db.Uuid
  templateId       String?   @map("template_id") @db.Uuid   // null only if a future single-installment raise path is added for custom plans
  milestoneSeq     Int?      @map("milestone_seq")
  label            String    @db.VarChar(255)                // copied at raise time, for display without a join
  stageCompletedOn DateTime  @map("stage_completed_on") @db.Date
  raisedById       String?   @map("raised_by_id") @db.Uuid
  raisedAt         DateTime  @default(now()) @map("raised_at")

  company      Company        @relation(fields: [companyId], references: [id])
  project      Project        @relation(fields: [projectId], references: [id])
  installments Installment[]

  @@index([companyId, projectId, templateId, milestoneSeq])
  @@map("stage_raises")
}
```

**Every raise, bulk or otherwise, creates exactly one `StageRaise` row** —
one audit-trail shape for "who raised this, when, and what real-world date
it represents," regardless of how many installments it touched. A bulk
raise across 40 bookings on one project stage produces one `StageRaise` row
referenced by 40 `Installment` rows; that's the whole design, no special
casing needed for "was this a bulk action."

I deliberately did **not** try to prevent re-raising the same
`(projectId, templateId, milestoneSeq)` with a DB uniqueness constraint.
Idempotency is enforced at the service layer instead (§1.6) — matching this
codebase's own precedent (commission-slab contiguity is validated at
save-time in the service, not by a DB constraint, per the Phase 5 decisions
log) for a rule that's about business idempotency, not row-shape integrity.

Registered in `TENANT_SCOPED_MODELS`
([tenant.extension.ts](../../packages/db/src/tenant.extension.ts)) with the
standard `tenant_isolation_policy` RLS policy — same treatment every other
new tenant model in this project's history gets, no exception.

### 1.5 Bulk-per-project-stage, or per-booking? — **bulk, for the case that matters; no per-booking UI needed at all**

Worked through both, and the answer split cleanly along **plan origin**:

- **Template-instantiated plans** (the only case in scope — see §1.7): a
  construction stage is a *physical, project-wide fact* — the slab gets
  poured once, for the whole tower, and every customer on that stage owes
  money at the same real-world moment. 4QT's bulk-raise-by-stage exists
  because that's what the underlying event actually looks like. Modeling
  it as 40 separate manual actions (once per booking) would be true to
  nothing about how construction actually happens, and would be a genuine
  operational burden on a real accounts team.
- Because `PaymentPlanMilestone` is **template-scoped, not project-scoped**
  (a `PaymentPlanTemplate` has no `projectId` — it's reusable company-wide,
  `@@unique([companyId, name])`), the "stage identity" a bulk raise matches
  against is `(projectId, templateId, milestoneSeq)`: raise milestone #3 of
  template X, but only for bookings whose unit belongs to project Y. This is
  a structural difference from 4QT's project-owned Stage Master, but the
  bulk semantics come out the same.

**I am not building a manual single-installment raise UI in this pass**,
and here's why that isn't a gap: the one scenario that would need it — a
booking added to a project *after* its stage was already raised — is
handled by **self-raise-at-instantiation** instead (§1.7.1). Once that's in
place, there is no remaining real scenario where an admin needs to raise
exactly one installment by hand. The schema (`Installment.stageRaiseId`
allowing a null `templateId`/`milestoneSeq` on `StageRaise`) leaves room for
a future ad hoc single-raise action without a schema change, but nothing is
built for it now — no code for a feature nothing currently needs.

**Endpoint:** `POST /projects/:projectId/stage-raises`, body
`{ templateId, milestoneSeq, stageCompletedOn }`. New permission
(`POSTSALES_STAGE_RAISE`, naming to match the existing `POSTSALES_PLAN_READ`
convention) — automatically picked up by `syncSuperAdminPermissions()` on
upgrade, no special handling needed given that existing infrastructure.

### 1.6 What "raise" actually writes

Inside one transaction:

1. Look up (or create, if none exists yet) the `StageRaise` row for
   `(companyId, projectId, templateId, milestoneSeq)`.
   - If one already exists: reuse it (its original `stageCompletedOn` is
     authoritative — see §1.6.1 on corrections). This is what makes a
     second call for an already-raised stage a safe no-op.
2. Find every **active, currently-unraised** installment matching that
   stage: `milestoneType = 'STAGE_LINKED' AND dueDate IS NULL AND
   isActive = true`, joined through `plan → booking → unit → project =
   projectId`, and `milestoneSeq` (copied onto the installment — see
   §1.3) `= milestoneSeq`.
3. For each: `dueDate = stageCompletedOn + graceDaysAfterRaise` (the
   milestone's own `graceDaysAfterRaise`, read from the template at raise
   time — not re-derived per booking), `stageRaiseId = <the StageRaise
   row's id>`.
4. Return `{ stageRaiseId, raisedCount }`.

No ledger entry is posted by this action. Raising only sets a date — it's
inert until either time passes (interest reads it) or a receipt is later
allocated against it. This is worth stating explicitly because it's what
makes bulk-raising low-risk: it never touches the frozen financial core,
only `Installment.dueDate`/`milestoneType`-adjacent columns.

#### 1.6.1 Correcting a `stageCompletedOn` mistake — explicitly out of scope

If an admin raises a stage with the wrong date, this plan does **not**
provide a correction path. Fixing it after installments have already been
raised (and possibly already have interest accrued, or receipts allocated)
is a genuinely harder problem than this fix needs to solve, and I'd rather
name that limitation than quietly hand-wave a "just edit it" story that
doesn't actually hold once money has moved. If this comes up in practice,
it needs its own design pass — flagging it here rather than deciding
silently either way.

### 1.7 Scope decision: template-instantiated plans only, not custom plans

`createCustomPlan`/`editPlan` take caller-supplied `InstallmentInput[]` with
a **required** `dueDate`
([finance.ts:224](../../packages/shared/src/finance.ts):
`dueDate: isoDate()`, no `.optional()`) and no `milestoneId` linkage at
all — a custom plan is bespoke per booking by construction, with no shared
"stage" to bulk-match against in the first place.

**Recommendation: ship `STAGE_LINKED` for template-instantiated plans only
in this pass.** Reasoning:

- The demonstrated bug and the seed-data proof both live entirely in
  `instantiateFromTemplate`. Custom plans were never shown broken.
- An admin building a custom plan already controls each installment's due
  date directly. If a line genuinely needs to wait for a construction
  event, the practical workaround (leave it out of the initial custom
  plan, add it later via `editPlan` once the stage completes) is a real,
  if manual, option — the custom-plan path already supports adding
  installments after the fact.
- Narrowing scope keeps `installmentInputSchema`, `BookingWizard.tsx`'s
  custom-plan builder, and `createCustomPlan`/`editPlan`'s signatures
  **completely untouched** — zero risk to the custom-plan path, smaller
  diff, tighter review surface.

If you want custom plans to support `STAGE_LINKED` too, that's a real,
separate follow-up (`installmentInputSchema.dueDate` → optional +
`.refine()` gating on a new `milestoneType` field, plus a UI toggle per row
in `BookingWizard.tsx`) — flagging it as a deferred decision, not silently
dropping it.

#### 1.7.1 Self-raise-at-instantiation (required, not optional)

A new booking created against a template whose `STAGE_LINKED` milestone
*already has* a `StageRaise` for that project (i.e., the stage was already
completed and raised for everyone else) must **not** sit stuck unraised
forever — nothing else would ever come back and fix it, since a second
manual raise call for that stage finds nothing left to raise (by design,
§1.6). So `PaymentPlanService.instantiateFromTemplate` gains one lookup: for
each `STAGE_LINKED` milestone, check whether a `StageRaise` already exists
for `(projectId, templateId, milestoneSeq)`; if so, populate `dueDate`
immediately (`stageCompletedOn + graceDaysAfterRaise`) and set
`stageRaiseId`, exactly as if it had been raised in the original bulk
action. If not, leave `dueDate` null as normal.

This is what makes the "no manual single-raise UI" decision in §1.5 correct
rather than a gap: the one case that would need it is handled automatically
here.

---

## 2. `dueDate` becoming nullable — every consumer, enumerated

Grepped `\.dueDate\b` across `apps/api/src`, `apps/web/src`, and
`apps/portal/src` — 11 real call sites, not the 3 named in the Task 1
report (which only covered the sites needed to prove the bug existed, not
every reader). Each one below, with what happens today and what it needs to
become:

| # | Site | Today | With a null `dueDate` |
|---|---|---|---|
| 1 | [`interest.service.ts:83`](../../apps/api/src/postsales/interest.service.ts) — `installment.findMany({ where: { dueDate: { lt: asOf } } } )` | Reads every overdue installment | **No change needed.** Postgres `NULL < x` evaluates to NULL, which `WHERE` treats as false — a null `dueDate` is excluded from the result set by existing SQL semantics alone. Confirmed by reading the whole method; there is no other date `InterestService` ever derives from. Still gets an explicit regression test (§7) — I'm not shipping "it happens to work" as the only proof. |
| 2 | [`interest.service.ts:97`](../../apps/api/src/postsales/interest.service.ts) — `cursor = ... : inst.dueDate` | Seeds the accrual window from the due date | Unreachable for a null row, since #1 already excludes it from the loop. No change. |
| 3 | [`postsales-reports.service.ts:39-79`](../../apps/api/src/reports/postsales-reports.service.ts) — `installmentDues()`, the Dues Dashboard/CSV | `WHERE status != 'PAID'`, **no `dueDate` filter at all**; `orderBy: dueDate asc`; `.getTime()` on line 57 | **Must fix.** Postgres `ORDER BY ... ASC` puts `NULL` **first** by default — an unraised installment would sort to the very top of the dues list, then `inst.dueDate.getTime()` throws. Add `dueDate: { not: null }` to the `WHERE`. |
| 4 | [`postsales-reports.service.ts:307-329`](../../apps/api/src/reports/postsales-reports.service.ts) — `duesAgeing()` | Already filters `dueDate: { lt: now }` | **No change needed** — same NULL-comparison safety as #1. Gets its own explicit test too. |
| 5 | [`document.service.ts:333-352`](../../apps/api/src/pdf/document.service.ts) — `buildLetterContext` for DEMAND_LETTER/REMINDER_LETTER | `overdueDays` computed via `.getTime()` on `installment.dueDate`, no guard | **Must fix**, defense-in-depth even though the frontend picker (#8) should prevent reaching this with a null in practice. Add an explicit check: `installment.dueDate === null` → `BadRequestException('This installment has not been raised — nothing is due against it yet')`. An API caller bypassing the UI must get a clean 400, not a 500. |
| 6 | [`portal-account.service.ts:30-56`](../../apps/api/src/customer-portal/portal-account.service.ts) — the customer portal's "next due" banner | `.sort((a,b) => a.dueDate.getTime() - b.dueDate.getTime())[0]` picks the next-due installment from all unpaid ones | **Must fix.** An unraised installment is definitionally never "next due" — filter it out of the candidate array before the sort, not just sort it correctly. |
| 7 | [`payment-plan.service.ts:106,166`](../../apps/api/src/postsales/payment-plan.service.ts) — `createCustomPlan`/`editPlan` | Writes `dueDate: inst.dueDate` from a required DTO field | **No change**, per the §1.7 scope decision — custom plans stay exactly as they are. |
| 8 | [`ReceiptEntry.tsx:79-85`](../../apps/web/src/pages/postsales/ReceiptEntry.tsx) — `dueInstallments`, oldest-first receipt allocation | Filters only on outstanding amount; `.sort((a,b) => a.dueDate.localeCompare(b.dueDate))` | **Must fix.** Add `i.dueDate !== null &&` to the filter. This isn't just avoiding a crash — an unraised installment must be **allocation-ineligible**: nothing is due, so a receipt cannot be applied "against" it. (See the open question in §2.1 on prepayment.) |
| 9 | [`Applicant360.tsx:119-121`](../../apps/web/src/pages/postsales/Applicant360.tsx) — `dueInstallments`, the demand/reminder-letter installment picker | Same shape as #8, same missing filter | **Must fix**, same reason — an unraised installment shouldn't be offered as a target for a demand letter at all. |
| 10 | [`InstallmentSchedule.tsx:79`](../../apps/web/src/pages/postsales/InstallmentSchedule.tsx) — the schedule VIEW | `new Date(i.dueDate).toLocaleDateString('en-IN')` | **Must fix — and this is the nastiest one.** `new Date(null)` in JavaScript does **not** throw — it silently evaluates to `1970-01-01`. Without a fix, the schedule view would render every unraised installment as due on Jan 1 1970: no crash, no error, just wrong data on screen. Needs an explicit branch: `i.dueDate ? new Date(i.dueDate).toLocaleDateString(...) : 'Not yet due'`. This is the one place a null should be *displayed*, not excluded — see §6. |
| 11 | [`Account.tsx:79,106`](../../apps/portal/src/pages/Account.tsx) — portal schedule + next-due banner | `nextDue` (line 79) is fed by #6, needs no portal-side change once that's fixed server-side. Line 106's schedule list render has the **identical `new Date(null)` → 1970 risk as #10**. | **Must fix line 106** with the same "Not yet due" fallback as #10, mirrored on the portal per this project's own standing rule that staff/portal surfaces are implemented twice and a fix to one is a question about the other, not an assumption it doesn't apply. |

Two files (`ReceiptEntry.tsx` and `Applicant360.tsx`) each independently
derive their own `dueInstallments` from the same shared, deliberately
unfiltered `GET /bookings/:id/plan-history` endpoint
([plan-history.controller.ts](../../apps/api/src/postsales/plan-history.controller.ts))
— that endpoint is correct to stay unfiltered (it's also what feeds the
schedule view, which needs to see everything), so both fixes belong in each
consumer's own filter predicate, not in the shared endpoint.

**Mechanical safety net, not just a grep promise:** flipping
`Installment.dueDate` to `Date | null` in the Prisma schema changes the
generated TypeScript type everywhere it's read. `tsc --noEmit` — already a
CI gate across every workspace — will hard-fail at every `.dueDate` access
that doesn't null-check, in every package, the moment the schema changes.
The 11 sites above are what a careful grep found; a green `pnpm -r
typecheck` after the schema change is what actually *proves* the list is
exhaustive, the same way the plotted-inventory Phase A migration used a
full monorepo typecheck to catch every `Unit.floor` access when `floorId`
went nullable. I'll run that as a concrete gate, not just cite it as a
reason to feel confident.

### 2.1 Open question: can a customer prepay an unraised installment?

Excluding unraised installments from receipt-allocation eligibility (#8)
means a customer literally cannot pay toward "Superstructure" before it's
raised, even if they want to pay early out of goodwill or convenience. I
lean toward **no** — until raised, the installment isn't a fixed financial
obligation yet (its amount could still be affected by a template edit,
though frozen-vs-unpaid rules already protect paid installments from that;
more fundamentally, there's no `dueDate` to file the payment "against" in
the ledger's "on account of" sense) — but this is a real product judgment
call, not something I should decide silently. Flagging it for you rather
than picking a default.

---

## 3. Interest interaction — confirmed, not assumed

Read the entirety of `InterestService.accrueInTx` (the only place interest
computation happens). It has exactly one path to a date for computing the
accrual window: `inst.dueDate` (as the `WHERE` filter, and as the cursor
seed when no prior accrual exists). There is no reference anywhere in that
file to `booking.bookingDate`, no fallback path, nothing else a date could
come from. Once `dueDate` is null, `WHERE dueDate: { lt: asOf }` removes
the row from the query result before the cursor-seed line is ever reached
— confirmed by reading the method top to bottom, not inferred from the
schema alone.

This means: **interest accrues from the RAISED due date and nothing else**,
by construction — there is no second code path to audit or guard, because
there's only ever been the one.

---

## 4. Existing data — migration position

**Agree with your lean, and here's the argument for it, grounded in this
project's own precedent, not just "seems reasonable":**

- Ledger entries are append-only by design (CLAUDE.md principle 2,
  enforced by the `forbid_financial_mutation` DB trigger). Reversing
  already-posted interest is a business/legal decision about a specific
  customer relationship, not a data-migration decision a schema change
  should make on anyone's behalf.
- This project has already faced the *identical shape* of problem and
  landed on exactly this answer: the GST-state-code fix (CLAUDE.md,
  "Seed-only-reachable-data audit" entry) found that companies had been
  silently charged the wrong GST split since Phase 4, and explicitly
  chose **not** to retroactively correct already-issued invoices —
  "this release does not retroactively correct GST already charged
  wrong before upgrading, only prevents it going forward... there's no
  way to know after the fact what the correct historical treatment
  should have been without a human reviewing each affected booking." The
  wrongly-accrued-interest case is the same problem wearing different
  numbers: a silently-wrong money calculation with no mechanically
  correct way to retroactively fix it.
- The REPORTS-phase `is_reversed` backfill (also CLAUDE.md) is the
  precedent for what a migration in this codebase *is* allowed to touch:
  it corrected exactly one boolean flag on `Receipt`, narrowly scoped by
  a `WHERE` clause that unambiguously identified pre-fix rows, and never
  touched `ledger_entries` — because the DB trigger wouldn't allow it
  even if it tried. This fix follows the identical shape: touch schema
  and defaults only, never a ledger row.

### 4.1 Migration mechanics

1. Add `MilestoneType` enum.
2. `payment_plan_milestones.milestone_type` — `NOT NULL DEFAULT
   'DATE_LINKED'`. Every existing template milestone becomes DATE_LINKED,
   which is exactly what it already behaviorally was.
3. `installments.milestone_type` — same, `NOT NULL DEFAULT 'DATE_LINKED'`.
4. Widen `installments.due_date` to nullable. Because every existing row
   just got backfilled to `DATE_LINKED`, and the new CHECK constraint
   requires DATE_LINKED rows to have a non-null date, **no existing row
   can ever actually end up null** — the column is nullable only for
   future STAGE_LINKED inserts. This is the literal mechanism behind "mark
   existing milestone-linked installments as DATE_LINKED so nothing
   changes for them" — it isn't a separate step, it falls out of the
   default.
5. Add `stage_raises` table, `installments.stage_raise_id` nullable FK,
   RLS + `TENANT_SCOPED_MODELS` registration.
6. Add `payment_plan_milestones.grace_days_after_raise`,
   `NOT NULL DEFAULT 0`.
7. **Zero rows in `ledger_entries`, `interest_accruals`,
   `receipt_allocations`, or `receipts` are touched.** Verified the way
   this session's plotted-inventory Phase A migration was verified: md5
   snapshot of those tables before and after applying the migration
   against a populated test database, asserting byte-identity.

### 4.2 CHANGELOG.md — stated plainly, per your instruction

A draft of what the `[Unreleased]` entry should say, following the GST-fix
entry's own tone (name the risk, don't minimize it, give a way to check):

> **Fixed a correctness bug: construction-linked payment plans could show
> customers overdue, and accrue delay interest, against stages the builder
> had not reached.** Every payment-plan milestone previously got a due
> date at booking time regardless of type; installments are now either
> DATE_LINKED (unchanged) or STAGE_LINKED (no due date until a staff user
> marks the construction stage complete). **This release does not
> retroactively reverse interest already accrued, or correct demand
> letters already issued, against a stage that may never have actually
> been reached** — those are ledger entries, and reversing them is a
> business decision only a human reviewing the specific booking can make,
> not something a migration should decide for you. To find potentially
> affected rows: every `interest_accrual` whose `installment` has a
> non-null `milestone_percent` and whose booking's payment plan came from
> a template — cross-reference `payment_plan_milestones.label` for
> construction-suggestive names (stage/slab/plinth/excavation/
> superstructure/finishing/structure). This is a **label-text heuristic,
> not an exact identification** — the pre-fix schema never captured
> milestone intent, so there is no precise query; a human still has to
> look at the actual milestone names.

---

## 5. Seed fix

Current `Construction-Linked Plan` milestones
([seed.ts:274-281](../../packages/db/prisma/seed.ts)):

```
On Booking     10%  offset 0    → stays DATE_LINKED (correct as-is)
Excavation     15%  offset 90   → becomes STAGE_LINKED
Plinth         15%  offset 180  → becomes STAGE_LINKED
Superstructure 30%  offset 360  → becomes STAGE_LINKED
Finishing      20%  offset 540  → becomes STAGE_LINKED
On Possession  10%  offset 720  → becomes STAGE_LINKED (possession is itself
                                   a real-world handover event, not a
                                   calendar date — treated as its own
                                   distinct stage, not folded into Finishing)
```

Each `STAGE_LINKED` milestone gets a small `graceDaysAfterRaise` (proposing
15, matching a realistic Indian-developer demand-notice window) instead of
its current large `dueOffsetDays`, which stops meaning anything once the
milestone no longer anchors to booking date.

This makes the seed **demonstrate the fix**, not just stop demonstrating
the bug: a fresh install's demo data now shows a real unraised construction
schedule out of the box, which is also useful as a manual-click-through
fixture (§7).

---

## 6. UI

### 6.1 Raising a stage

New panel on `ProjectDetail.tsx`, following the same interaction shape this
codebase already established for the "Pricing" panel (v0.2.0 decisions —
one expandable panel, not per-row inline). Call it "Construction Stages":
lists the distinct `STAGE_LINKED` milestones currently unraised somewhere
in this project (derived by grouping active, `dueDate IS NULL` installments
by `(templateId, milestoneSeq, label)`), each row showing how many bookings
are waiting on it, with a "Mark stage complete" action that opens a small
form (a date field, `stageCompletedOn`, defaulting to today) and calls
`POST /projects/:projectId/stage-raises`. On success, show a plain result:
"14 installments raised across 14 bookings, due 15 Jul 2026" (or whatever
`stageCompletedOn + graceDaysAfterRaise` resolves to).

### 6.2 The schedule view

`InstallmentSchedule.tsx`'s due-date column, for a row where `dueDate` is
null: render **"Not yet due"** (or similar copy — happy to take a
suggestion) instead of attempting to format a date, per the fix at
consumer #10. I'd give it a distinct, muted visual treatment (not the same
styling as `UNPAID`, which correctly still applies as the row's `status` —
no money has been received, which remains true) so a staff user can tell
"nothing due yet" apart from "due and unpaid" at a glance. I'm not
proposing a new `InstallmentStatus` value for this — `status` stays exactly
`UNPAID`/`PART_PAID`/`PAID`, and "not yet due" is purely a `dueDate === null`
render-time distinction, which is simpler and doesn't touch the existing
status state machine at all.

### 6.3 Receipt Entry / demand letters

No new UI needed beyond the filter fixes in §2 (#8, #9) — an unraised
installment simply won't appear in either picker. That absence *is* the
correct UI; nothing further to design.

---

## 7. Tests

- **Never overdue, never accrues, however much time passes.** Create a
  STAGE_LINKED installment (unraised), advance the clock arbitrarily far
  past what its `dueOffsetDays`-equivalent would have been, run
  `accrueForBooking` → assert zero accruals, zero ledger entries. Also
  assert it never appears in `installmentDues()` or `duesAgeing()` output
  regardless of `asOf`.
- **Raising sets the due date; interest accrues only from that date
  forward.** Raise the stage with a specific `stageCompletedOn` → assert
  `dueDate = stageCompletedOn + graceDaysAfterRaise` exactly. Run
  `accrueForBooking` with `asOf` before that date → zero accrual. Run with
  `asOf` after → a hand-computed fixture (matching this codebase's
  existing golden-master style for interest tests) proving the accrual
  window anchors to the *raised* due date, not `bookingDate` or
  `raisedAt`.
- **Idempotent re-raise.** Raise the same `(projectId, templateId,
  milestoneSeq)` twice → the second call raises zero installments (all
  already raised) and reuses the existing `StageRaise` row rather than
  creating a second one.
- **Self-raise on late booking.** Raise a stage for a project, *then*
  create a new booking against the same template → assert the new
  installment is instantiated with `dueDate` already populated (proving
  §1.7.1), without a second manual raise call.
- **DATE_LINKED byte-identity.** The existing `instantiateFromTemplate`
  test suite runs unchanged, with zero fixture edits, and produces
  identical `dueDate` values to today — this is the acceptance bar itself,
  not a new test to write from scratch, since nothing about DATE_LINKED
  behaviour changes.
- **Migration byte-identity.** Same discipline as the plotted-inventory
  Phase A migration: md5 snapshot of `ledger_entries`/`bookings`/`receipts`
  before and after applying this migration against a populated test
  database, asserting no change. Confirm every pre-existing installment
  backfills to `DATE_LINKED` with its `dueDate` untouched.
- **Full-monorepo typecheck as the consumer-completeness gate.** `pnpm -r
  typecheck` green after the schema change is the actual proof the 11
  sites in §2 are exhaustive — not just a review checklist item.
- **A real browser (Playwright), not just server-side tests** — per this
  project's own standing rule that request-construction and rendering
  bugs are structurally invisible to supertest. Using the fixed seed's
  Construction-Linked Plan: book a unit against it → confirm the schedule
  shows "Not yet due" for Excavation/Plinth/etc. (proving consumer #10's
  fix, which a server-side test can't see) → confirm Receipt Entry's
  oldest-first allocator does not offer those installments → confirm the
  demand-letter picker doesn't offer them either → raise Excavation via
  the new UI panel → confirm the schedule now shows a real date and
  Receipt Entry now offers it.

---

## Note: `ConstructionUpdate` (the photo gallery) stays separate

Agree with your lean, and it's not close. Read the model in full
([schema.prisma:2465](../../packages/db/prisma/schema.prisma)):
`title`, `description`, `publishedAt`, a media gallery — freeform,
customer-portal-facing content (`apps/api/src/customer-portal/
construction-update.service.ts`), with no `stageKey`, no `templateId`, no
structured link to a specific milestone at all. It exists to let a
developer post "here's what the site looks like this month" to buyers; a
staff member publishing a photo update is not asserting "milestone #3 of
payment plan template X is complete, start charging everyone" — those are
different claims made by different people for different reasons, and
conflating them would mean a marketing post accidentally triggering a
financial event, or a real stage-completion silently requiring a photo
that may not exist yet. Keeping them separate costs nothing (no shared
code either wants to reuse) and avoids that coupling entirely.

---

Waiting for approval before any code.
