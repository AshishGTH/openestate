# Follow-Up Page — Gap Analysis

**Planning only.** No code, no schema, no implementation plan in this
document — it exists to answer one question: what does OpenEstate
already have, compared to `docs/specs/followup-page-spec.md`, and how
honest can we be about the difference. Every row below is backed by a
real file/line, not inference from a feature name.

Spec reference: `docs/specs/followup-page-spec.md` (derived from **SOP:
LeadSync – Lead Follow-up and Disposition Management**). Section numbers
below (`§N`) refer to that document.

---

## 1. Three collisions, checked first

### Collision 1 — Response is the same concept as `LeadStage`. Building it separately would be a real bug, not just duplication.

The spec's Response examples (§9.2): **Contacted, Qualified, Site
Visit/Meeting, Negotiation.** Our `LeadStage` default seed
(`packages/shared/src/presales.ts:346`, `DEFAULT_LEAD_STAGES`): **New,
Contacted, Site Visit Scheduled, Site Visit Done, Negotiation,
Documentation.**

These are not analogous — they are the same list. Both are: a single
current value per lead, ordered, company-configurable, admin-managed
master data, with every transition recorded to an append-only history
table (`InquiryStageHistory`, `packages/db/prisma/schema.prisma:1366`)
carrying from/to/actor/timestamp. `LeadStage.isDefault` — the value a
new lead starts at — is exactly the SOP's implicit "first response."

More importantly, **we already independently built the exact structural
separation the spec insists on in §13** ("Response and Disposition ...
should not be conflated"): `InquiryStatus`
(`schema.prisma:1213` — OPEN/CONTINUED/DUMPED/SUCCESSFUL) is our
Disposition axis; `LeadStage` is our Response axis. The schema comment
on `LeadStage` (`schema.prisma:1220`) states this explicitly: *"Company-
configurable sales-pipeline position — orthogonal to InquiryStatus, not
a replacement for it."* This was written before the spec was seen, for
unrelated reasons (Phase 0 of `feature-completion-plan.md`) — it is
independent confirmation the two-axis model is the right one, not
something borrowed from the spec.

**Verdict: same concept. Do not build a second Response classification.**
A separate `Response` field on `Inquiry` or `FollowUp` would give the
product two competing "where is this lead in the pipeline" answers that
can silently disagree — the exact failure the spec's own §13 warns
against, just self-inflicted instead of inherited.

**Proposed mapping, for whoever picks this work:** `Response → LeadStage`
(already exists). `Sub-response` does **not** exist — `LeadStage` is a
flat list (`id, companyId, name, sortOrder, isActive, isDefault`, no
parent/child column) — so Sub-response would be a genuinely new child
level under it, not a rename of anything. This is a proposal for a later
design pass, not a schema in this document.

**One real gap this mapping does not solve on its own:** logging a
follow-up (`POST /inquiries/:id/follow-ups`) and changing the stage
(`PATCH /inquiries/:id`) are two separate API calls today, from two
separate sections of `InquiryDetail.tsx` (the stage `<select>` at line
184; the follow-up form at line 225). The spec's own workflow (§8, §32
step 9) treats "select a Response" as part of the *same* Save action
that logs the interaction. Mapping Response onto `LeadStage` doesn't by
itself unify those two actions — that composition question is
implementation-plan territory, flagged here so it isn't lost.

Also worth naming so it isn't confused with Response: `FollowUp.outcome`
(`FollowUpOutcome` enum — COMPLETED/NO_RESPONSE/RESCHEDULED/
NOT_INTERESTED/CONVERTED, `schema.prisma:1410`) is a **different, third
axis** — the result of one specific contact attempt ("did the call
connect"), not a pipeline position. It has no spec equivalent and isn't
part of this collision.

### Collision 2 — Transfer is already reassignment + `InquiryAssignment` history, and it's stronger than the spec's own recommendation.

Spec §12.2/§14.3 wants: Transfer selects a new owner, preserves the
previous owner (not overwritten), the lead appears in the new owner's
queue, reason is optional.

`InquiryService.assign()` (`apps/api/src/presales/inquiry.service.ts:456`)
does exactly this: writes an `InquiryAssignment` row
(`fromUserId`/`toUserId`/`actorId`/`reason`/`createdAt`,
`schema.prisma:1321`) in the same transaction as updating
`Inquiry.assignedToId`, `fromUserId` is nullable (first-ever assignment
has no prior owner), `reason` is optional (`String? @db.VarChar(500)`)
— matches the spec's own "SOP does not specify whether a transfer
reason is mandatory ... should remain configurable" note exactly.
History is never overwritten; every reassignment is a new row.

**"Appears in the new owner's queue"**: `GET /inquiries` scopes by
`assignedToId` (via `TeamScopeService.getVisibleUserIds`,
`inquiry.service.ts:74`) — the moment `assign()` changes
`assignedToId`, the new owner's own list includes it on their very next
request. No separate "queue" table or sync step needed; ownership *is*
the queue membership.

**Where ours is stronger, not just equivalent:** `assign()` is scoped on
**both ends** — the inquiry being moved and the target user must both be
in the caller's `TeamScopeService` visible set (`inquiry.service.ts:449-476`).
A `sales_manager` can transfer a lead within their own reporting subtree;
they cannot pull one in from outside it or hand one to someone outside
it. The spec's Transfer has no authorization model at all beyond "assign
to a different employee/senior" — it doesn't consider who is allowed to
transfer to whom. This is a real gap in the spec's own recommendation
that our implementation already closes.

**Verdict: ours is stronger. Keep it as-is.** Nothing about the spec's
Transfer shape should be adopted in place of what exists — the one open
question (does "Transfer" need to also be reachable as a *disposition
button* alongside Followups/Successful/Dump in a single follow-up-save
step, per §12/§16) is a UI composition question, not a data-model one,
and belongs in a later implementation pass.

### Collision 3 — Confirmed: we cannot record when an interaction happened, only when it was saved and when the next one is due.

Spec §14.2 is emphatic: `interaction_at` (when the contact happened) and
`next_follow_up_at` (when the next one is due) "should not be stored as
the same field."

`FollowUp` (`schema.prisma:1418`) has: `createdAt` (Prisma
`@default(now())`, i.e. row-insert time — never user-settable),
`nextActionAt` (the next-due field), `scheduledAt`/`venue` (site-visit-
specific, not a general interaction time). **There is no field for "when
did this actually happen."** `createdAt` is the closest thing, and it is
always "now" at save time — Prisma sets it, nothing in
`FollowUpService.create()` (`apps/api/src/presales/follow-up.service.ts:41`)
accepts or forwards an alternate value, and `createFollowUpSchema`
(`packages/shared/src/presales.ts:268`) has no field for it either.

**Confirmed exactly as suspected: a user cannot log a call that happened
yesterday.** Every follow-up is permanently timestamped at whatever
moment the Save button was clicked, even if the interaction itself
happened hours or days earlier and is being logged late (a very normal
real-world case for a busy rep).

One more finding in the same area, found while checking this: the
follow-up form in `InquiryDetail.tsx` (`handleAddFollowUp`, line 95)
does not send `nextActionAt` at all — only `typeId`/`notes`/
`scheduledAt`/`venue`. The **model already has the next-follow-up
field**; the real UI simply never renders an input for it. This is a
distinct gap from the missing `interaction_at` field — see §4 below (it
also makes `isOverdue()`/the escalation logic effectively unreachable
through the actual follow-up-logging workflow, since nothing in the real
UI ever sets the value they read).

---

## 2. Per-concept comparison

| Spec concept | Our equivalent | Verdict |
|---|---|---|
| Lead (§3) | `Inquiry` model | **Stronger** — applicant/project/source/budget/temperature/stage/owner/customFields, RLS, TeamScopeService |
| Follow-Up record (§3, §14.2) | `FollowUp` model | **Weaker** — missing `interaction_at`; see Collision 3 |
| Response (§9.2, §13A) | `LeadStage` + `InquiryStageHistory` | **Equivalent concept, see Collision 1** — same axis, real mapping proposed, not yet unified into the follow-up save flow |
| Sub-response (§9.3) | none | **Missing.** `LeadStage` has no child/parent level |
| Disposition — Followups (§12.1) | `InquiryStatus.OPEN`/`CONTINUED` | **Weaker** — no explicit "continue" action; implicit only via a follow-up carrying `nextActionAt`, which the UI doesn't currently expose (Collision 3) |
| Disposition — Transfer (§12.2) | `InquiryAssignment` + `assign()` | **Stronger, see Collision 2** |
| Disposition — Successful (§12.3, Rule 4) | `InquiryStatus.SUCCESSFUL` | **Weaker** — a single status-button click, zero relationship to `BookingService` (confirmed by grep: `booking.service.ts` never references `Inquiry` in any form). "Mark Successful" and "a real booking exists" are completely disconnected today |
| Disposition — Dump (§12.4, Rule 5) | `InquiryStatus.DUMPED` | **Weaker** — a single status-button click (`InquiryDetail.tsx:171-179`), no reason, no remarks, no confirmation of any kind |
| Dump Reason master (§12.4, §15) | none | **Missing** — no `DumpReason`-shaped master anywhere in `masters.module.ts`'s `SIMPLE_MASTERS` list |
| Communication Type (§9.5) | `FollowUpType` master | **Equivalent/stronger** — real configurable master data (`Phone Call, Site Visit, Email, WhatsApp, Meeting, Video Call` seeded), already wired to `FollowUp.typeId` and rendered in the form. (Note: a *separate* `CommunicationType` master also exists in `SIMPLE_MASTERS` but is unrelated — it's for the outbound SMS/email dispatch subsystem, not follow-up interactions, and isn't actually wired to anything yet per its own schema comment. Don't confuse the two.) |
| Remarks (§9.6) | `FollowUp.notes` | **Equivalent** for the normal follow-up form (present, optional). **Weaker** for Dump specifically — Dump doesn't go through the follow-up form at all today, so nothing captures remarks when a lead is dumped |
| Next Follow-Up Time (§9.4, Rule 2) | `FollowUp.nextActionAt` / `Inquiry.nextFollowupAt` | **Data model present, UI absent** — the field exists and is indexed, but the real follow-up form never renders an input for it (Collision 3) |
| interaction_at (§14.2) | none | **Missing**, see Collision 3 |
| Activity Log (§11, Rule 6) | Follow-ups list only | **Weaker/partial** — follow-ups render as a history list on `InquiryDetail.tsx`; stage transitions (`InquiryStageHistory`) and ownership transitions (`InquiryAssignment`) are both recorded in the database but **neither is rendered anywhere in the UI** — no unified activity feed exists |
| Disposition history (§14.4 `LeadDisposition`) | none | **Missing** — `Inquiry.status` is a plain column overwritten in place; no history row is written when status changes (unlike stage and ownership, which both have dedicated history tables) |
| Lead search/filtering (§6, §7) | none | **Missing**, both layers — `InquiryService.findAll()` destructures only `page/limit/sortBy/sortOrder` from the query (`inquiry.service.ts:69`); the shared `PaginationQuery` type does carry a generic `search` field but it's silently ignored here. `Inquiries.tsx` renders zero filter controls, just a plain paginated table |
| Overdue/due detection (§19) | `InquiryService.isOverdue()` + indexed `nextFollowupAt` | **Backend primitive exists, UI absent** — used today only by `EscalationService` (a manager-notification job), never surfaced as a filter, indicator, or queue ordering anywhere a rep would see it |
| Ownership/queue logic (§20) | `assignedToId` + `TeamScopeService` | **Stronger** — org-chart-aware subtree scoping; spec has no authorization model at all |
| Conversion integration (§21, Rule 4) | none | **Missing** — confirmed no code path connects `Inquiry.status = SUCCESSFUL` to `Booking` in either direction |
| Weekly supervisor review (§23, Rule 14) | none | **Missing** — no report, screen, role, or scheduled job anywhere references "review," "supervisor," or a dumped/transferred-leads worklist |
| Auditability / event types (§24) | Partial | `RESPONSE_CHANGED`≈`InquiryStageHistory`, `OWNER_TRANSFERRED`≈`InquiryAssignment` (both exist, real). `MARKED_SUCCESSFUL`/`MARKED_DUMPED` — **missing** (no history row on status change). `FOLLOW_UP_CREATED` — the `FollowUp` row itself, but `FollowUpService.update()` does a raw in-place `update()` with no prior-version audit trail (`follow-up.service.ts:96-100`), which is the exact case the spec's own §11 Implementation Recommendation warns about |
| API shape (§25) | REST under `/inquiries` | **Roughly equivalent** — `GET /inquiries`, `GET /inquiries/:id`, `GET/POST /inquiries/:id/follow-ups`, `PATCH /inquiries/:id/assign` all already exist matching the spec's own proposed shape. Successful/Dump are not dedicated endpoints (`POST .../successful`, `POST .../dump`) — they're the same generic `PATCH /inquiries/:id { status }` as any other field, which is exactly why they carry none of Rule 4/Rule 5's required validation |
| Transaction behavior (§26) | `withTenantTx` | **Equivalent mechanism** — every mutation already goes through this project's standard transactional wrapper; there's just very little to be atomic about yet for Dump (no reason/remarks/history to write alongside the status flip) |
| Permissions (§27) | Real RBAC + TeamScopeService | **Stronger** — granular permissions (`PRESALES_INQUIRY_*`, `PRESALES_FOLLOW_UP_*`, `PRESALES_INQUIRY_ASSIGN`) plus org-chart scoping, well beyond the spec's four conceptual roles. No distinct "Supervisor" role exists, but that's downstream of the missing review feature itself, not a permissions gap on its own |
| Reporting (§28) | `funnelByStatus`, per-staff dumped/successful counts | **Weaker** — groups by `InquiryStatus` only (no stage/response breakdown yet — a pre-existing, already-tracked follow-up item in `feature-completion-plan.md`), no dump-reason breakdown (can't — no reason field), no transfer-activity report, no due-for-follow-up report |

---

## 3. The gaps, split the way the spec itself splits them

### Mandated by the SOP (the source process actually requires these — §29's numbered rules, or an explicit "the SOP explicitly requires/states" line)

1. **Sub-response.** §8 step 6, §9.3, DoD item 7 — a required field with
   no equivalent today.
2. **Dump requires a reason (from a catalogue) and remarks.** Rule 5,
   §12.4 — explicitly required by the SOP, currently zero enforcement of
   either.
3. **Successful requires a confirmed booking**, not just a status click.
   Rule 4, §12.3 — currently a bare status flip with no relationship to
   `Booking` at all.
4. **Every saved follow-up appears in the lead's activity log.** Rule 6,
   §10, §11 — met for follow-ups themselves, but the SOP's own activity-
   log illustration (§11) shows Response changes as activity-log entries
   too, and those aren't surfaced anywhere.
5. **Next follow-up time, settable, when continuing engagement.** Rule 2,
   §9.4 — the field exists on the model; nothing in the real UI lets a
   user set it.
6. **Transferred leads appear in the new owner's queue.** Rule 7, §20 —
   already met (Collision 2), listed here only for completeness of the
   SOP-mandated set.
7. **Weekly supervisor review of dumped and transferred leads.** Rule 14,
   §2, §23 — no surface of any kind exists.
8. **A standardized Response is used** (not free text). Rule 1, §9.2 —
   met in substance via `LeadStage` (Collision 1), but not yet reachable
   from the follow-up-save action itself.
9. **Lead search/filtering, with a Search action and a result list.** §6
   — the SOP explicitly walks through this as a user workflow
   ("navigate to Followups, set filters, click Search"); nothing like it
   exists today, frontend or backend.
10. **Overdue leads must not remain idle / must be identifiable.** Rule 8
    (status updated after interaction) and the explicit "leads should not
    remain idle beyond the scheduled follow-up time" line in §2 and §9.4
    — the backend primitive (`isOverdue()`) exists but is not reachable
    by a rep anywhere in the product today.

### Implementation Recommendation (the spec author's proposal, not a documented SOP requirement — explicitly marked as such in the source)

- A dedicated normalized `LeadDisposition`/event-history table covering
  *every* disposition type generically (§14.4, §24) — we already have
  two of the three axes covered by dedicated history tables
  (`InquiryStageHistory`, `InquiryAssignment`); only the `InquiryStatus`
  axis itself lacks one. Whether that's solved by a third dedicated
  table, by extending an existing one, or by a single unified table is
  an open design question, not something the SOP specifies.
- Follow-up edits should carry their own audit trail rather than
  overwriting in place (§11) — currently a plain `update()`.
- An overdue *indicator/filter/queue ordering* specifically (§19) — the
  underlying "is this overdue" capability is SOP-adjacent (item 10
  above); the exact UI treatment is explicitly marked Implementation
  Recommendation.
- Additional list filters beyond what the SOP's own two examples
  (Dump, Contacted) require — owner, project, source, sub-response,
  communication type, next-follow-up date (§6).
- A dedicated event-type enum (`FOLLOW_UP_CREATED`, `RESPONSE_CHANGED`,
  etc., §24) as a named, queryable audit log, versus the current
  approach of several separate history tables that collectively cover
  most of the same ground.
- A formal `Supervisor` role distinct from `sales_manager`/
  `company_admin` (§27) — the SOP requires the *review*, not a specific
  named role; our existing RBAC could plausibly gate the review screen
  behind an existing permission instead.
- Reporting KPI formulas / report names (§28) beyond what SOP text
  actually asks (dump-reason breakdown, transfer activity, response-
  stage breakdown) — the underlying data gaps that block these are
  already listed above; the specific report shapes are the spec
  author's own proposal.

---

## 4. Checking the prior

**Your prior:** Sub-response, dump reason as configurable master data
with a required-reason rule, a queryable disposition history, the
weekly supervisor review surface, and the follow-up workspace page
itself.

**All five confirmed real and missing.** One correction and two
additions:

- **Correction on "disposition history":** it isn't fully absent — it's
  absent for exactly one of three axes. `InquiryStageHistory` (stage)
  and `InquiryAssignment` (ownership/transfer) are both real,
  append-only, already-shipped history tables. Only `InquiryStatus`
  itself (Followups/Successful/Dump) has no history — every status
  change is a silent overwrite of one column. Worth being precise about
  this rather than treating "disposition history" as one missing thing,
  since two-thirds of it already exists and is solid.
- **Addition — next-follow-up time is unreachable from the real UI**,
  not just "the workspace page doesn't exist yet." This is bigger than
  a missing page: the *data model* is ready (`FollowUp.nextActionAt`,
  indexed, read by `isOverdue()`) but the actual follow-up form never
  renders a field for it. A future follow-up workspace could ship with
  every other field wired and still inherit this specific hole if
  nobody notices the form/model mismatch.
- **Addition — Successful has no relationship to a real booking.** This
  wasn't in your list but is arguably the sharpest gap in the whole
  analysis: a user can mark a lead Successful with literally zero
  connection to `BookingService`, confirmed by grep (`booking.service.ts`
  never references `Inquiry` in any form). Rule 4 is explicit that
  Successful must mean confirmed booking, not a positive conversation.

One more thing worth flagging, found while tracing the Followups/
continue-engagement path (not asked for, but too specific to leave
out): `FollowUpService.create()`'s own code comment
(`follow-up.service.ts:71-72`) says logging a follow-up "flips
DUMPED/SUCCESSFUL inquiries back to CONTINUED" — but the actual code
(`status: inquiry.status === 'OPEN' ? 'CONTINUED' : inquiry.status`)
only handles the OPEN case; a DUMPED or SUCCESSFUL inquiry's status is
left unchanged by this ternary, contradicting its own comment. Whether
that's a stale comment or a real bug is worth a look independent of this
gap analysis — noted here rather than silently walked past, per this
codebase's own review conventions.

---

## 5. §33 Definition of Done, checked line by line

23 items. Judged against real code/UI evidence, not the feature's name.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Navigate to Follow-Up workspace via Lead/Enquiry flow | **Partial** | Reached via Inquiries list → Inquiry detail; no distinct "Enquiry" sub-level and no dedicated Follow-Ups landing/queue page — it's a section embedded in the inquiry detail page |
| 2 | Search/filter for leads | **Not met** | Confirmed absent at both API (`inquiry.service.ts:69`) and UI (`Inquiries.tsx`) layers |
| 3 | Select a lead | **Met** | `Inquiries.tsx` list links to `InquiryDetail.tsx` |
| 4 | Open the Follow-Up form | **Met** | Inline form, `InquiryDetail.tsx:225-258` |
| 5 | Record customer requirements/interests | **Partial** | Generic `notes` textarea + custom fields cover this loosely; no dedicated structured field |
| 6 | Select a standardized Response | **Not met (on the follow-up save action)** | `LeadStage` exists and is standardized, but it's a separate section/API call, not part of the follow-up form's own Save (Collision 1) |
| 7 | Select a Sub-response | **Not met** | Doesn't exist |
| 8 | Set the next follow-up time | **Not met** | Field exists on the model; the real form never renders it (Collision 3) |
| 9 | Select communication type | **Met** | `FollowUpType` dropdown, wired |
| 10 | Add remarks | **Met** | `notes` field, present |
| 11 | Save the interaction | **Met** | Works end to end |
| 12 | See the interaction in the activity log | **Met (for follow-ups specifically)** | Rendered list on the same page; stage/ownership changes are not shown anywhere, but this item is about the follow-up itself |
| 13 | Continue the lead using Followups | **Partial** | The "continue" code path exists but is gated on `nextActionAt`, which the UI never sends — currently dead in practice through the real workflow |
| 14 | Transfer the lead to another employee/senior | **Met** | Reassign section, `PATCH /inquiries/:id/assign` |
| 15 | See the transferred lead in the new owner's queue | **Met** | `assignedToId` drives `TeamScopeService` visibility directly |
| 16 | Mark a confirmed booking as Successful | **Not met** | No booking-confirmation gate of any kind |
| 17 | Move Successful leads into conversion workflow/list | **Not met** | No integration with `Booking` domain |
| 18 | Dump an invalid lead | **Met (mechanically)** | Single status-button click works |
| 19 | Require a Dump reason and remarks | **Not met** | Zero enforcement |
| 20 | Retrieve dumped leads for review | **Partial** | Technically retrievable by scrolling the unfiltered list and reading the status column; no dedicated retrieval |
| 21 | Identify leads whose follow-up time has passed | **Partial** | Backend primitive exists (used by `EscalationService`); no rep-facing surface |
| 22 | Support supervisor review of dumped/transferred leads | **Not met** | Confirmed absent |
| 23 | Preserve the historical lifecycle of the lead | **Partial** | True for stage and ownership (dedicated history tables); false for status/disposition itself (plain overwrite) |

**Count: 9 fully met, 6 partial, 8 not met — 39 of 92 possible points
if partial counts half (9×2 + 6×1 = 24 / 46 ≈ 52%), but strictly
complete: 9 of 23 (39%).**

**This corrects the "roughly half" prior, not confirms it.** Fully met
is under 40% — noticeably less than half. It only reads as "about half"
if partial credit is counted generously (9 fully-met + 6 partially-met
= 15 of 23 touched in some way, 65%). The honest number to plan against
is the strict one: **9 of 23**, and five of the eight fully-unmet items
are exactly the SOP-mandated gaps already listed in §3 above (Sub-
response, Dump reason+remarks, Successful/booking, search/filter,
supervisor review) — the DoD count and the gap list agree with each
other, which is itself a useful cross-check.

---

## 6. Ranked gap list

Ranked by how load-bearing the gap is to the spec's own stated
priorities (SOP-mandated items first, in the order §29 emphasizes them;
Implementation Recommendations after). One line each on rough size —
size of the gap to close, not an estimate of a specific implementation.

1. **Successful has no relationship to a real booking.** *(Medium)* —
   needs a real integration point between the presales and postsales
   domains that doesn't exist today in either direction.
2. **Dump requires no reason or remarks.** *(Small–Medium)* — a new
   master (Dump Reason) plus a required-when-dumping validation rule;
   conceptually the same shape as work already done for `LeadStage`.
3. **Sub-response doesn't exist.** *(Small–Medium)* — a new child-level
   concept under `LeadStage`, per the Collision 1 mapping.
4. **Next follow-up time is unreachable from the real UI.** *(Small)* —
   the model field already exists; this is a form-field gap, not a
   schema gap.
5. **No lead search/filtering, at either layer.** *(Medium)* — nothing
   to extend; both the query support and the UI need to be built from
   nothing.
6. **No disposition (status) history — the one axis of three without
   one.** *(Small–Medium)* — `InquiryStageHistory`/`InquiryAssignment`
   are the direct precedent to follow; this is filling the third gap in
   an otherwise-consistent pattern, not inventing a new one.
7. **Weekly supervisor review has no surface.** *(Medium)* — needs a
   report/screen and probably a permission; depends on gap 6 (a
   dump/transfer history to review) to be genuinely useful rather than
   just "leads currently in DUMPED status."
8. **Response isn't part of the follow-up save action.** *(Small)* —
   the mapping (Collision 1) already exists; this is a workflow/UI
   composition fix, not new data modeling.
9. **No unified activity log — stage and ownership history are recorded
   but never rendered.** *(Small)* — the data already exists in full;
   this is purely a UI gap.
10. **Follow-up edits have no audit trail.** *(Small, Implementation
    Recommendation)* — currently a plain overwrite; same shape as gap 6
    if it's worth doing at all.
11. **Reporting can't break down by dump reason, transfer activity, or
    response/stage.** *(Small–Medium, Implementation Recommendation)* —
    mostly blocked on gaps 2 and 3 existing first; the response/stage
    breakdown is already a tracked follow-up item independent of this
    spec.
12. **`FollowUpType` vs `CommunicationType` naming confusion.** *(Trivial,
    not really a gap)* — noted only so the eventual work doesn't wire the
    wrong master by mistake; `FollowUpType` is the one actually in use.
