# Deferred TODOs

Cross-phase follow-ups that were consciously deferred, with the phase where
they're expected to land. Each entry should say *what*, *why deferred*, and
*what unblocks it*.

## Must-fix-before-pilot (found on the pre-pilot walkthrough)

Three gaps found walking a realistic project through the real product.
Two have since been fixed; the remaining one stays deliberately sized
here rather than fixed inline — it's a real, standalone UI/feature
build, not a wiring fix:

- **No staff UI to publish a construction update or attach a progress
  photo.** `ConstructionUpdateAdminController` is fully built and tested
  (Phase 6, real IDOR tests, real Playwright coverage on the portal
  render side) but has zero caller anywhere in `apps/web`. A customer's
  portal "construction progress" section will only ever show something
  if a developer hand-crafts one via the raw API — confirmed by grep,
  not assumption. Needs a list+create+photo-attach screen, comparable in
  size to the Letter Templates admin page built for v0.2's PDF gap.

**Fixed: project edit.** `ProjectDetail.tsx` now has an Edit Project
form wired to the pre-existing `PATCH /projects/:id` endpoint (the
backend already accepted partial updates; only the UI was missing).
`code` is excluded from the update schema — it's used to match projects
during bulk inquiry CSV import, so it's immutable rather than
error-handled. Changing `areaLocationId` on a project with existing
bookings shows a confirmation naming the booking count first (existing
bookings' GST is a one-time snapshot and is never retroactively
altered). See CHANGELOG.md's `[Unreleased]` entry.

**Fixed: the base-line GST rate picker.** A booking's cost-line GST
resolution (`booking.service.ts`) falls back through: the line's own
rate → its charge type's rate → the booking's `BASE` line's rate — and
with no rate ever settable on the base line, this was reprioritised
ahead of the other two gaps above because it fails *silently* (a wrong
number on a printed document, no error) where the other two fail loud
or merely create friction. `BookingService.createBooking` now rejects
the whole booking if any line's rate can't be resolved, and
`BookingWizard.tsx` has a real rate picker on the base line
(auto-selected only when exactly one active rate exists). See
CHANGELOG.md's `[Unreleased]` entry for the full writeup, including how
already-created zero-GST bookings are surfaced (boot-time log + admin
banner + a "Zero-GST bookings" CSV report) rather than silently altered.

## `Project.isActive` has no enforced meaning anywhere

Found while building the project-edit form: `isActive` is set at
creation (default `true`), shown as a read-only Yes/No column on the
Projects list — and never read anywhere else. Grepped the whole API for
any query filtering on it (booking's available-unit lookup, reports,
the portal's `getMyProperties`) — zero hits. Deliberately left out of
the edit form rather than shipping a toggle whose effect is unclear:
flipping it today would look like it does something and do nothing.
Before adding it to the edit form, decide and implement what it should
actually gate — the obvious candidates are hiding an inactive project
from new-booking unit selection and/or from the portal — and update
this note once it has a real, tested effect.

## UNIT custom field values have no frontend capture or display path

## Pre-sales (Phase 3)

- **Escalation: notify the project manager instead of all company managers,
  once a project→manager mapping exists (Phase 5 or 6).** Today
  `EscalationService.runForCompany` notifies every active `sales_manager` in
  the company because no project→manager (or user→manager) reporting-line
  field exists in the schema yet. The same simplification affects the
  "manager-wise interaction" report (reports each manager's own logged
  interactions, not a team roll-up). Unblocked by adding a team-hierarchy /
  project-ownership mapping.

## Financial core / brokers (Phase 5)

- **Encrypt `Applicant.pan*` using the new `PanEncryptionService` (Phase 5).**
  `Applicant.panCiphertext`/`panMasked`/`panKeyVersion` have existed since
  Phase 4, but nothing has ever written or read them —
  `Applicant.panCiphertext` is always null today. Phase 5 builds the first
  AES-256-GCM PAN encrypt/decrypt utility (`PanEncryptionService`, modeled
  on `TotpService`'s identical implementation) but wires it only to the new
  `Broker.panCiphertext`. Retrofitting `Applicant` — an API field on the
  applicant create/update DTOs plus a PAN input on the applicant form — is a
  follow-up, not part of Phase 5's stated scope. Unblocked by nothing; the
  encryption service already exists and is directly reusable.

## Auth / rate limiting (Phase 1, widened in Phase 6)

- **Redis-backed `ThrottlerStorage` for the default/`portal-auth`/
  `portal-read` buckets.** CLAUDE.md's security rules call for
  `@nestjs/throttler` + a Redis store; `app.module.ts`'s single
  `ThrottlerModule.forRoot([...])` call (all three named buckets, see the
  Phase 6 commit 4 decisions log entry for why there is now exactly ONE
  call, not two) has used the package's default in-memory storage since
  Phase 1 — fine for a single-instance deploy, but it means rate-limit
  state isn't shared across replicas and resets on restart. Fixing this
  needs a new dependency (`@nestjs/throttler-storage-redis` or
  equivalent) plus touching the frozen Phase 1 `ThrottlerModule.forRoot`
  call — out of Phase 6's approved scope. Unblocked by adding that
  dependency and wiring one shared Redis-backed storage instance for the
  single throttler registration.

## Portal (Phase 6)

- **Staff services' self-wrapped `runWithTenant({companyId})` calls are
  redundant with `TenantContextInterceptor`'s ambient context for call
  sites that are genuinely staff-only — but "harmless" was the wrong word
  for the general case, and Phase 6 commit 4's decisions log entry
  supersedes the earlier note below.** Before Phase 6 commit 2, staff
  services (`ApplicantService`, `CommissionService`, `NocService`,
  `BookingService`, etc.) each wrapped their own tenant context from the
  controller's `req.user.companyId`, independently of any ambient
  middleware/guard context — this pattern is *why* the
  middleware-before-guards bug (and later the Guard-`enterWith` bug) went
  undetected for every staff route across five prior phases: staff
  services never depended on ambient context at all, only portal services
  (added in Phase 6) were exposed. What Phase 6 commit 2 got wrong: it
  concluded self-wrapping was *therefore* harmless in general. Phase 6
  commit 4 found a real counter-example — `NocService.approve()`/
  `reject()` became BOTH staff- and broker-portal-facing in commit 3, and
  the self-wrap silently stripped the ambient `portalBrokerId`, producing
  a fail-OPEN IDOR (a portal session briefly got staff-level DB
  visibility, not just narrower access). The property "this self-wrap is
  harmless" depends on which controllers call the method — today AND in
  any future phase — which can't be verified by reading one file in
  isolation. Two structural fixes now make this the runtime's job instead
  of the reviewer's: `runWithTenant()` throws if a same-company call
  would replace an active portal scope, and `runScoped()` (promoted to
  `packages/db`, was private to `NocService`) is the blessed helper for
  any future dual-purpose service. See CLAUDE.md Phase 6 commit 4
  decisions for the full audit of every currently portal-reachable
  service (all clean, only `NocService` needed the fix) and the
  guardrail's test coverage.

  Removing ~50+ staff-only call sites' self-wrap in favor of pure ambient
  context remains a separate, not-yet-done cleanup — still low-risk now
  that the guardrail exists as a backstop, but still requires a
  through-the-wire supertest per touched controller before merging (the
  Phase 6 commit 2 standing rule) to catch any that turn out to be
  portal-reachable after all.

- **`makeApplicant()`'s phone counter (`appSeq`,
  `apps/api/test/helpers/postsales-harness.ts`) is per-process, not
  globally unique, and `PortalAuthService.login()`'s identifier lookup is
  deliberately company-unscoped.** Two e2e test files that both call
  `makeApplicant()` early can generate the identical phone number for
  their first applicant; under `pnpm test`'s default forked parallelism,
  a login in one file can occasionally resolve to another file's user row
  and then 500 when that row is deleted by the other file's `afterAll`
  cleanup mid-test. Confirmed as the cause of a flake in
  `e2e-portal-throttle.test.ts` (Phase 6 commit 4) that only reproduced
  running the full e2e trio together, never in isolation — see CLAUDE.md
  Phase 6 commit 4 decisions. Worked around locally in that one file
  (high-entropy phone numbers instead of `makeApplicant()`); the harness
  helper itself and `PortalAuthService.login`'s cross-company lookup are
  unchanged. Unblocked by either seeding `appSeq` from
  `process.hrtime.bigint()`/a random offset instead of `0`, or scoping
  test login lookups by a company-specific identifier prefix — whichever
  is chosen should also close the identical gap
  `e2e-portal.test.ts`'s own comment already flagged for id-based
  assertions.

## Plugins (Phase 7)

- **Plugin execution has no worker-thread/process isolation — a genuine
  synchronous infinite loop in a plugin hook blocks the single Node event
  loop and cannot be preempted by `PluginRuntimeService.invoke()`'s
  `Promise.race` timeout.** Stated plainly in CLAUDE.md Phase 7 decisions
  and in the plan's Trust Model section: first-party plugins ship as
  reviewed npm workspace packages inside this repo, not untrusted code in
  a marketplace, so the isolation boundary (package-boundary — no
  `@openestate/db` dependency at all; capability-gated `Proxy` context;
  timeout+catch-all `invoke()` wrapper) defends against the Phase 6-style
  *composition* bug class and against accidental misbehavior, not against
  deliberately hostile code. If this project ever accepts untrusted
  third-party plugins, real isolation (a `worker_threads` sandbox or a
  separate process per plugin invocation, with message-passing instead of
  direct object references for `PluginContext`) is required before that
  trust boundary can move. Unblocked by: a decision to support untrusted
  plugins at all, which has real design cost (message-passing context,
  serialization limits on what `ctx.http`/`ctx.leads` can return, a new
  process-lifecycle story) — not attempted speculatively here.
- **Redis-backed `ThrottlerStorage` gap (see the Phase 1/6 entry above)
  will also apply to the `lead-inbound` named throttler once it's added
  in commit 2** — same single `ThrottlerModule.forRoot([...])` call,
  same in-memory-storage limitation, no new gap introduced, just noting
  the surface area grows by one more bucket.

## GSTIN checksum digit not verified (format regex only)

`updateCompanyConfigSchema.companyGstin` (packages/shared/src/company.dto.ts)
validates the 15-char GSTIN structure via regex but does not verify the
final check-digit (a mod-36 algorithm). Deferred rather than risking a
subtly wrong implementation that silently rejects real, valid GSTINs —
worse than no check at all for an admin trying to onboard their real
company. Add real checksum verification once validated against a set of
known-correct GSTIN/check-digit pairs (not from memory).

## AreaLocation/Bank have real optional columns the API never exposes

`AreaLocation.city/state/stateCode/pincode` and `Bank.ifscPrefix` exist as
real, optional Prisma columns, but `createMasterSchema` (the generic
factory schema both use) only has `name`/`description`/`isActive`/
`sortOrder` — there is no way to set either via the API today, so every
row created through the admin UI/API has them permanently null. Lower
priority than the required-field gaps already fixed this pass (nothing
500s — creation just silently can't populate these fields), but
`AreaLocation.stateCode` specifically feeds the same CGST/SGST-vs-IGST
place-of-supply logic as `CompanyConfig.gstStateCode` (Phase 4), so it's
a real gap for a company with projects in multiple states. Same
`extraFields` mechanism (`master.factory.ts`) would fix both in one pass
— exactly what v0.2.0 (PLC/unit-charge management) already did for the
third model in this originally-three-way gap,
`ChargeType.hsnSac/gstRateId`, once a wrong or missing GST rate on a
charge type became a real money-correctness risk, not just a cosmetic
one.

## UNIT custom field values have no frontend capture or display path

The backend fully supports UNIT custom field values (validation, storage,
portal-strip) since v0.2.3 — the gap is entirely in `apps/web`. APPLICANT
and INQUIRY get values captured inline on the "Add Inquiry" form
(`Inquiries.tsx`); PROJECT gets them on the "Add Project" form
(`Projects.tsx`, added on the pre-pilot walkthrough). UNIT has neither: a
unit is only ever created via Bulk-Generate (one shared set of parameters
applied to many units at once — the wrong shape for a per-unit value like
"facing direction") or CSV import, and there is no single-unit edit screen
to hang a form on at all. Building one is a real, standalone UI addition
(a new "Edit Unit" affordance), not a small wiring fix like the other
three — sized alongside the project-edit gap below, not built opportunistically.
Confirmed by a real pre-pilot walkthrough: defining a UNIT field through
the admin Custom Fields page has zero effect anywhere else in the product,
exactly the same failure shape the original v0.2.3 gap analysis wanted to
close for every entity.

## Custom field values on BOOKING need a frozen-service exception

**Resolved for three of the four supported entity types' frontend, all
four on the backend, as of the pre-pilot walkthrough** — APPLICANT,
INQUIRY and PROJECT capture, validate, store, display and export custom
field values through the real UI; UNIT's backend support is complete but
has no frontend (see the entry above). See CLAUDE.md's v0.2.3 decisions
entry for why storage is inline JSONB rather than EAV.

`BOOKING` is the one remaining gap, deliberately. Giving it values
means adding a `custom_fields` column to `bookings` and accepting the
field in `BookingService.createBooking`, and that service is on
CLAUDE.md's frozen list ("don't modify without asking"). Adding a
nullable JSONB column does not affect ledger math, so this is a small
change — but it crosses a line that is documented as requiring an
explicit decision, so it waits until someone actually asks for it
rather than being slipped in.

Until then the gap is **visible rather than silent**: the API rejects
a definition created for BOOKING (`supportsCustomFieldValues()` in
`packages/shared/src/custom-field.dto.ts` is the single source of
truth) and the admin UI marks the BOOKING tab "(unsupported)" with an
explanation and a disabled Add Field button. When it is enabled, add
`'BOOKING'` to `CUSTOM_FIELD_VALUE_ENTITIES`, add the column +
migration, and wire `resolveValuesForWrite` into the booking
create/update path exactly as the other four do.

## Legacy system-written keys inside `custom_fields`

`InquiryService.createFromLead` writes `{ leadNote }` and
`InquiryImportService` writes `{ importNotes }` directly into
`Inquiry.custom_fields`. These are server-generated, not client input,
so they are not a validation hole — but they are undefined keys living
in a column that is otherwise admin-defined, and they show up in the
"orphaned value" UI as `(inactive)`.

They are preserved rather than rejected (v0.2.3's
`resolveValuesForWrite` carries unknown STORED keys through untouched,
so an imported inquiry stays editable), which is correct behaviour but
not a clean design. The tidy-up is a real `notes` column on `Inquiry`
and a migration moving those two keys onto it. Low priority; noted so
the next person to see `leadNote` in a custom-fields display knows it
is expected, not corruption.

## `toCsv` emits nothing at all for an empty result set

`apps/api/src/presales/csv.util.ts`'s `toCsv` returns `''` when
`rows.length === 0` — so a report with no rows downloads as a
completely blank file, with no header row to show what the columns
would have been. Pre-existing, affects all seven presales reports
equally (not specific to the v0.2.3 custom-field columns, which are
derived from the rows). Fixing it means passing the expected headers in
explicitly rather than deriving them from `rows[0]`.
