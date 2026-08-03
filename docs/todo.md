# Deferred TODOs

Cross-phase follow-ups that were consciously deferred, with the phase where
they're expected to land. Each entry should say *what*, *why deferred*, and
*what unblocks it*.

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

## AreaLocation/Bank/ChargeType have real optional columns the API never exposes

`AreaLocation.city/state/stateCode/pincode`, `Bank.ifscPrefix`, and
`ChargeType.hsnSac/gstRateId` all exist as real, optional Prisma columns,
but `createMasterSchema` (the generic factory schema all three use) only
has `name`/`description`/`isActive`/`sortOrder` — there is no way to set
any of these via the API today, so every row created through the admin
UI/API has them permanently null. Lower priority than the required-field
gaps already fixed this pass (nothing 500s — creation just silently
can't populate these fields), but `AreaLocation.stateCode` specifically
feeds the same CGST/SGST-vs-IGST place-of-supply logic as
`CompanyConfig.gstStateCode` (Phase 4), so it's a real gap for a company
with projects in multiple states. Same `extraFields` mechanism
(`master.factory.ts`) would fix all three in one pass.

## Custom field definitions have no value-capture anywhere

`CustomFieldDefinition` (admin CRUD at `/admin/custom-fields`) lets an
admin define a field on Applicant/Unit/Booking/Inquiry/Project, but
that's the entire feature — there is no `CustomFieldValue` model, no
API for setting/reading a value against a real entity, and none of the
Applicant/Unit/Booking/Inquiry/Project forms fetch or render the
definitions at all. Defining a field today has zero effect anywhere
else in the product. Unblocked by: a `CustomFieldValue` table
(entityId + definitionId + value), an endpoint per entity to read/write
values, and wiring each of the five forms to fetch definitions for
their entity type and render+submit them dynamically.
