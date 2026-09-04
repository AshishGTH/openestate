# Deferred TODOs

Cross-phase follow-ups that were consciously deferred, with the phase where
they're expected to land. Each entry should say *what*, *why deferred*, and
*what unblocks it*.

## `cheque-bounce.spec.ts` — one known E2E flake, observed once, not investigated further

The `e2e-playwright` CI flakiness that used to live here (the rotating
subset overridden three times as a documented exception, tied to the
/login refresh-rotation cascade) is resolved in PR #31 — see CLAUDE.md's
"E2E refresh-rotation cascade" Decisions entry for the fix, its trace
evidence, and its three-consecutive-green proof. The cascade was
MASKING four downstream failures; unmasking them surfaced two more
mechanisms (a default-throttle bucket exhausted under 4-way Playwright
parallelism on the shared runner IP, and one genuine DOM race on
`user-deactivate-reactivate`), both fixed in the same PR.

**The one remaining E2E flake observed but NOT fixed by that PR** — one
occurrence across four consecutive full-suite runs of the same commit
(the three-of-three green bar plus a fourth on the docs-amendment
commit), on the ONLY attempt where any spec required a retry:

- **Spec**: `tests/cheque-bounce.spec.ts:28:5` — "book a unit → record a
  cheque receipt → bounce it → Collection Summary ends up unchanged"
- **Assertion that failed**: `expect(locator).not.toHaveValue(expected)`
  at `tests/cheque-bounce.spec.ts:70:72`
- **Recovery**: Playwright's own `retries: 1` re-ran the test and it
  passed (marked "1 flaky" in the run summary). Also observed on
  attempt 1 of run 33916938865 (the same commit that eventually went
  3-of-3 green) — same assertion, same retry-recovery, still no root
  cause identified.
- **Not touched by PR #31**: this spec has no auth mutations wrapped in
  the fixes above; the failure mode doesn't match the throttle-exhaustion
  or refetch-race classes either
- **Not in the original failing subset**: appeared for the first time on
  attempt 1 of the three-green run; absent on all three attempts of the
  preceding red run and on attempts 2/3 and the follow-up docs run

**This is logged, not diagnosed.** The purpose of the entry is to
prevent the exact reversion the E2E gate just recovered from — a single
observed flake absorbed into a general "E2E is sometimes flaky" belief.
The trace for this failure was uploaded by the artifact rule PR #31 also
added (`playwright-traces` on the failing attempt) and can be pulled via
`gh run download 33292860530 --pattern playwright-traces`. When it
recurs (or if a change touches `apps/web/src/pages/postsales/` and this
starts failing again), read the trace before theorising, exactly the
way PR #31's own diagnosis went.

**Do NOT widen Playwright's `retries: 1` to hide this further.** A
retry-that-passes-once is exactly the shape of signal that took two
sessions to unmask above. The `1 flaky` line in the run summary is the
correct level of visibility — see it, log if it becomes a pattern,
diagnose from the trace if it does. That is now the sole owner of the
E2E gate's noise, and it doesn't get to accumulate silently.

## Nightly property test now takes ~32min at 2000 runs — consider sharding across matrix jobs instead of one long job

The nightly (`schedule`/`workflow_dispatch`) CI run was silently cancelling
during `postsales-property.test.ts`'s 2000-run property test for at least
three runs, unnoticed. Root-caused and fixed in two layers (see the PR that
merged this entry for full detail and real run-ID evidence): a redundant
full re-run of the test inside the "Fail if any test was skipped" step, and
the test's own hardcoded `it()` timeout (30min, sized for the 500-run
PR/push path) firing independently of the job-level timeout. Both are
fixed — a real `workflow_dispatch` run confirmed `integration-tests` green
at full 2000-run strength.

**The real timing evidence this fix produced, which is the actual reason
to revisit the sharding question**: at 2000 runs, the job's "Run
integration tests" step alone took the full **32m26s** for the whole job
(property test dominates that). The test's own timeout now has an 80min
ceiling to leave headroom inside the job's 90min budget. **32+ minutes is
a long time for a single test to run before a real ledger regression is
discovered** — it's a large part of why the original cancellation went
unnoticed for three consecutive nightly runs: a single long-running job is
easy to lose track of, and a red run that takes 30+ minutes to fail is
much less likely to get looked at promptly than one that fails in a few
minutes.

**Why not sharded now**: this exact tradeoff was already considered once
and deliberately deferred in favor of the time-based 500/2000 PR-vs-nightly
split (see CLAUDE.md's Phase 4 decisions, "Ledger property test:
nightly-2000 / PR-500 split, not CI-matrix sharding") — the reasoning there
was that a 4-way matrix (400–500/shard) would 4x the runner minutes for the
same total coverage per run (sharding parallelizes wall time, not cost),
plus shard-partitioning complexity for fast-check's seed/skip mechanics,
for no correctness benefit over the simpler split. That reasoning about
*cost* still holds. What's new is the *observability* argument: a 4-way
matrix would turn one 32-minute job into four ~8-minute jobs running in
parallel, at the same total runner-minute cost, but with each individual
job finishing (and therefore failing, if it's going to fail) in a fraction
of the wall-clock time — directly addressing the "unnoticed for three runs
because nobody was watching a 30+ minute job" failure mode, independent of
the runner-cost tradeoff that was the sole consideration last time.

**What would actually decide this**: whether GitHub Actions' own
notification/status visibility for a long-running scheduled job is really
the reason the original cancellation went unnoticed (plausible, but not
directly verified — no one has checked whether a shorter-duration failure
would actually have surfaced faster in practice, e.g. via how failure
notifications are configured for this repo). If so, sharding earns its
complexity cost specifically for faster failure detection, not (per the
Phase 4 reasoning, still valid) for lower total cost. Revisit alongside
that question rather than sharding on wall-clock time alone.

## Two known-timing-sensitive test failures, not re-investigated (contention-class, evidence already in hand)

Found in a real full-`pnpm test` run on the walkthrough VM (2 CPU cores,
live production traffic sharing the box — see CLAUDE.md's `scripts/
test-setup.sh` verification entry for the full context): `e2e-portal-
throttle.test.ts`'s "throttle state survives a fresh app instance" test and
`webhook-delivery.test.ts`'s "N concurrent exhausted deliveries produce
exactly N counted failures" test both failed, once each, in that run only.

**Why not chased further**: both are pre-existing tests whose own names
describe exactly the kind of race/timing assertion this project's history
(Phase 7→8, Phase-0-follow-up) already treats as expected to flake under
real resource contention, not something to re-diagnose from a single
occurrence. The same session's isolated re-runs of three OTHER files that
failed in the same full run (`e2e-master-creation`, `e2e-tickets`,
`presales-reports`) all passed cleanly once contention was removed,
which is the standard diagnostic this project uses to tell "real bug"
from "contention flake" — that evidence was judged sufficient without
repeating it for these two as well.

**What would actually close this**: re-run each of these two files in
isolation (not the full suite) two or three times; if they pass every
time, that confirms contention and this entry can be deleted; if either
fails again in isolation, it is real and needs its own investigation.

## Guard on `scripts/test-setup.sh`'s "differently-named production database" case — verified by direct SQL only, not by full reproduction

The script's shared-cluster guard was strengthened to check for existing
`openestate_app`/`openestate_system` roles (cluster-wide) in addition to a
database literally named `openestate` — closing the gap where a
production install using `deploy/native/setup-database.sh --db
<other-name>` was reachable and undetected. The underlying `pg_roles`
existence queries were verified directly against a real cluster, and the
new check was confirmed not to interfere with the normal (super-role-
already-exists) path via a live re-run.

**What was NOT done**: an actual end-to-end reproduction of "a production
install on a differently-named database, then run test-setup.sh with no
override, confirm it refuses." The only VM available for this session's
verification already uses the default `openestate` name for its real
install, so that exact scenario couldn't be constructed without either a
second cluster or renaming/disrupting the live one. If a second
throwaway Postgres instance is ever available, this is the one thing
left to prove that hasn't been.

## `ci.yml`'s `scripts/test-setup.sh` wiring — not verified by an actual GitHub Actions run

`integration-tests` now calls `scripts/test-setup.sh` (with
`TEST_PG_ADMIN_USER=openestate_super`/`PGPASSWORD` routing it into TCP
mode against the service container) instead of carrying a second,
hand-maintained copy of the same role/migrate/seed SQL. Validated by YAML
parse, step-order inspection, and tracing the exact code path the script
takes in TCP mode against known-good behavior verified elsewhere in the
same session — but not by an actual push. Creating a throwaway
non-`postgres`-named superuser role to structurally rehearse the
container-admin shape locally was blocked by the same system-settings-
adjacent safety boundary that blocked fixing the VM's clock drift in the
same session. **The real proof is the next push's `integration-tests`
run** — if it goes red, read this entry first before assuming a fresh
bug: the most likely failure modes are (a) `openestate_super`'s password
not matching `POSTGRES_PASSWORD` on the service container (verified
identical by direct comparison of both hardcoded values, but worth
re-checking first) or (b) `$GITHUB_ENV` not receiving the three
`DATABASE_URL_TEST*`/`REDIS_TEST_URL` lines from `.test-env` correctly.

## Test-infra flakiness from `syncLeadStages`' unscoped scan — timeboxed, root cause not fixed

**Honest root cause, stated plainly**: `syncLeadStages` (`packages/db/prisma/
sync-permissions.ts`) does a deliberately UNSCOPED whole-database
`company.findMany()` — correct for its real job (an upgrade must reach every
company, not just some). The test suite runs many files in parallel against
ONE SHARED Postgres database. Put those two facts together and any test
fixture's company is fair game for `syncLeadStages` to reach into, any time
`sync-lead-stages.test.ts` happens to be running concurrently — which, under
`pnpm test`'s default parallelism, is most of the time.

Everything built this session in response — the 14-file
`leadStage.deleteMany`/`companyConfig.deleteMany` additions, and
`packages/db/test/helpers/delete-company-safely.ts`'s retry loop — makes
test cleanup TOLERATE that interference. **Neither one stops the
interference itself.** `syncLeadStages` still reaches into every other
test's fixtures on every call; the fixes only make it survivable once it
does. Worth being precise about that distinction so a future session doesn't
mistake "cleanup no longer throws" for "the tests are isolated from each
other," which they aren't.

**The fix is INCOMPLETE, not just imperfect — say so plainly.** The 8
`apps/api/test` files that create a company still only have the simple
`leadStage.deleteMany` + `companyConfig.deleteMany` before their
`company.delete()` — the SAME sequence that was proven insufficient for the
6 `packages/db/test` files (a real, ~40%-of-runs-observed gap between those
deletes and the final company delete, where `syncLeadStages`' already-
in-flight per-company transaction can land and recreate what was just
deleted). None of the 8 apps/api files have the retry helper. **"No failure
observed there yet" is not "fixed" — it means the race is live and simply
hasn't been hit by chance yet**, for the same reason a rarely-taken branch
with no test isn't "verified working." Treat these 8 files as still exposed
until either they get the same retry treatment or the real fix below lands.

**Two real candidate root fixes — recorded, NOT built this session:**

**(a) An optional `companyId` scope on `syncLeadStages`/
`syncSuperAdminPermissions`**, so a test can ask "sync just this one company"
instead of the function always scanning every company in the database.
Directly stops the interference at the source — a scoped call genuinely
cannot reach another test's fixture.
**Tradeoff, stated honestly**: the production call path (`upgrade-native.sh`,
`seed.ts`) needs the UNSCOPED behavior — an upgrade has to reach every
company, not one. A test that only ever calls the scoped form no longer
exercises the exact scan `syncLeadStages` actually runs in production
(`company.findMany()` with no filter, iterating the full result). Any test
that specifically wants to prove the unscoped-scan behavior itself (there is
at least one — the "does NOT resurrect" test relies on iterating past
already-marked companies) would still need the unscoped form, so this
wouldn't be a clean full replacement, only an option most fixtures could
take to stop being reachable.

**(b) Database-per-worker, or a serial (non-parallel) vitest project for
files that call an unscoped sync.** Removes the SHARED half of "shared
database across parallel workers" instead of the unscoped-scan half.
**Tradeoff**: database-per-worker means provisioning N throwaway databases
(migrating and seeding each) instead of one, adding real setup time and
complexity to `scripts/test-setup.sh` and CI; a serial project for the
handful of unscoped-sync-adjacent files is cheaper to build but makes the
full suite slower by however long those files take run-not-in-parallel,
and doesn't help if a NEW file elsewhere in the suite also starts an
unscoped scan without anyone remembering to add it to that project's list —
the same "someone has to remember" fragility as the current per-file
cleanup fixes, just at a different layer.

Neither is built. This entry exists so a future session facing this same
class of flake doesn't have to re-derive the root cause or re-discover
these two options — it can start here and pick one deliberately, or find a
better one, rather than adding a 15th parallel cleanup fix.

**Caveat on this session's own evidence, so it isn't over-trusted later**:
the initial ~40%-of-runs figure and the "second, narrower race" diagnosis
came from a batch run against a freshly-reset database and are reasonably
trustworthy. But a separate data point — a `packages/db/vitest.config.ts`
`maxForks` cap tried, then reverted, mid-investigation — was evaluated
against a database that later turned out to be polluted by this session's
OWN earlier ad hoc debugging (an orphaned company with real `LeadStage`
rows and no marker, confirmed by direct query, left over from before the
cleanup fixes existed). At least one subsequent "still failing" full-suite
run was one of a batch where an EARLIER run in the same batch had been
killed by a 10-minute tool timeout mid-transaction — a hard kill, not a
clean failure, and a plausible independent source of the SAME kind of
pollution. Both were treated in this session's own closing summary as
supporting evidence that the retry helper's fix was reliable. **That
conclusion should be read as UNTESTED, not established** — the maxForks
experiment in particular was never cleanly re-run against a verified-clean
database on its own, so no real conclusion about whether concurrency
capping would help or hurt should be carried forward from it either way.

## `BrokerBankDetail.isPrimary` has a real, still-open race condition

Found while designing `LeadStage.isDefault`'s enforcement (Phase 0 of
feature-completion-plan.md — see CLAUDE.md's decisions entry). Verified
by reading the code directly, not assumed: `BrokerBankDetail.isPrimary`
is enforced only by a transactional clear-then-set (`updateMany` inside
a transaction), with no database constraint backing it. Two concurrent
requests setting a different bank detail as primary for the same broker
can both leave `isPrimary: true` under READ COMMITTED — nothing prevents
it. `LeadStage.isDefault` deliberately did NOT copy this pattern (a
partial unique index instead); `BrokerBankDetail` itself was left
untouched, out of scope for that phase. **What unblocks it**: a
`CREATE UNIQUE INDEX ... WHERE is_primary` partial index on
`broker_bank_details (broker_id)`, same shape as `LeadStage`'s, plus a
migration to resolve any bank detail that's already in the broken state
(more than one primary per broker) before the index can be added. Low
urgency — no financial money-movement reads `isPrimary` directly today
(confirmed by grep before filing this) — but worth fixing before
anything starts trusting it as a hard invariant.

## Built: lead ownership & manager hierarchy (v0.4) — what's still open from that work

`User.managerId` + `TeamScopeService` + the CI guard landed in v0.4 (see
CLAUDE.md's "v0.4 — lead ownership and manager hierarchy" decisions entry
for the full writeup). Three things that entry deliberately left open:

- **`managerWiseInteractions()` (`presales/reports.service.ts`) is now
  unblocked.** It's reported every active sales_manager's own
  directly-logged interactions, not a team roll-up, since Phase 3 —
  explicitly because no manager hierarchy field existed. It exists now.
  Upgrading this to a real team roll-up (each manager's count including
  their subtree, via `TeamScopeService.getVisibleUserIds`) is a natural
  next step, but wasn't part of v0.4's asked-for scope — left as its own
  small follow-up rather than built unprompted.
- **`Booking` core CRUD (`booking.controller.ts`) stays unscoped.** Only
  the Reports module scopes postsales data by owner (Phase 4-UI
  precedent); the booking list/detail endpoints themselves show every
  booking in the company to any staff user with the permission,
  regardless of who created it. v0.4 deliberately didn't touch this —
  Booking wasn't part of the "lead ownership" report's own scope, only
  Inquiry/Applicant/FollowUp/Booking-*reports* were. Likely to come up
  as a real pilot request once a company has enough sales reps that
  "every rep can see every other rep's bookings" starts to matter —
  worth designing for explicitly when it does, not scoped preemptively
  now.
- **Global search** — doesn't exist yet (confirmed by grep, not
  assumed). Must be built with `TeamScopeService` wired in from the
  first commit, not retrofitted after — building it search-first would
  recreate exactly the "forgotten on a new endpoint" risk
  `team-scope-guard.test.ts` exists to prevent.

## Phone as identifier — still approved, not yet built

- **Phone as identifier, without a DB uniqueness constraint.** A hard
  `@@unique` on `primaryPhoneNormalized` is incompatible with real,
  legitimate cases the report named (family members sharing a number,
  brokers on one office line) and would either reject them outright or
  falsely merge a telco-reassigned number onto the wrong historical
  person. Instead: a persisted per-pair "confirmed distinct" decision
  (e.g. `ApplicantDistinctPair(companyId, applicantAId, applicantBId,
  decidedById, decidedAt)`) so a human's "these are different people"
  call, once made, stops the same warning resurfacing for that exact
  pair — composes with the existing `ApplicantMerge` machinery for the
  opposite decision. Automated paths (inbound lead API, bulk import)
  keep auto-link-on-match as the default (unchanged, deliberate Phase 7
  reasoning — no human is present to ask), gaining a per-company
  `CompanyConfig` toggle to always-create-and-flag instead, for a
  company that knows its market has heavy phone-sharing. No
  telco-reassignment detection — this project's own phone-normalization
  precedent (Phase 3) already rejected guessing here: a false "these are
  different people" costs a re-ask later, a wrong auto-merge costs a
  business potentially servicing the wrong person's booking.

## Plotted inventory (plan §14) — three findings from the Phase E walkthrough

Found during Phase E's real-browser LAND_BASED lifecycle walkthrough
(create project → group → plots → book → receipt → generate documents →
cancel) on the verification VM, v0.4.0, commit `d118d89`.

**Allotment letter renders "Tower , Floor ," for a LAND_BASED booking.**
`ALLOTMENT_LETTER`'s `MERGE_FIELD_REGISTRY` entry
(`packages/shared/src/documents.ts`) includes `towerName`/`floorLabel`;
`buildLetterContext()` (`apps/api/src/pdf/document.service.ts`) resolves
both to `''` when the booking's unit has no floor
(`booking.unit.floor?.tower.name ?? ''`) — a plot has no tower/floor by
definition. This is NOT a crash and NOT a literal `{{token}}` leak (both
were explicitly checked, live, against a real generated PDF) — the merge
resolves cleanly to an empty string, exactly as the code is written to
do. But a template phrased the way an admin would naturally write one
("Tower {{towerName}}, Floor {{floorLabel}}") renders with a visible
blank/dangling-comma gap: confirmed live by generating a real Allotment
Letter against a real plot booking and reading the PDF directly.
`DEMAND_LETTER` is unaffected — its own registry entry doesn't include
`towerName`/`floorLabel` at all, so this is specific to
`ALLOTMENT_LETTER`. The real fix is conditional merge-field syntax (a
`{{#if fieldName}}...{{/if}}`-style block that omits a whole
clause/line when its field(s) are empty) in `resolveMergeFields` and
`validateTemplateMergeFields` — a genuine templating feature, not a bug
fix, since the current mechanism is pure string substitution with no
conditional construct at all. Until built, the workaround lives at the
template-authoring layer: a company running both HIGH_RISE and
LAND_BASED projects needs either two separate allotment-letter
templates or one written to avoid tower/floor phrasing entirely.

**No project delete or deactivate UI exists.** `DELETE /projects/:id`
(`ProjectController`/`ProjectService.remove()`, a hard
`tx.project.delete()`) has zero frontend callers anywhere in
`apps/web` — confirmed by grep of `Projects.tsx` and
`ProjectDetail.tsx`, not assumed. There is also no deactivate path:
`Project.isActive` is set at creation but deliberately excluded from
the edit form (see the `Project.isActive has no enforced meaning
anywhere` entry above — it's enforced nowhere in the API either). A
project created by mistake — wrong shape (immutable after creation),
wrong code, wrong company — cannot be removed or even hidden through
the product at all; this session's own walkthrough project
("E2E Land Walkthrough Farms") is now permanently on the demo company's
project list for exactly this reason, once it acquired a booking. Same
class of gap as the project-edit gap already fixed this pass (backend
capability existed, UI never wired it up), and it will bite a real
pilot user during their own first-time setup — creating a throwaway
project to learn the screen, or picking the wrong shape by mistake, is
an entirely ordinary first action. Unblocked by: a Delete Project
button (with a confirmation, reusing the booking-count-confirmation
pattern already built for `areaLocationId` edits) for a project with
zero bookings; for a project with any booking history the button
should be disabled/explained rather than attempted-and-failed, since
the ledger's append-only FK protection will very likely reject a hard
delete once a booking exists (not independently re-verified this
session — no delete control exists to click — but consistent with
every other financial-linkage protection this codebase enforces).

**No letter-template delete (or edit/deactivate) UI exists.**
`apps/web/src/pages/admin/LetterTemplates.tsx` only supports create and
list — confirmed by reading the file directly, during this walkthrough's
own cleanup step, after creating two real templates
("Standard Allotment Letter", "Standard Demand Letter") to generate the
PDFs above and finding no way to remove them afterward. Every other
master table in this codebase gets an Active checkbox + PATCH via the
generic factory pattern (`Masters.tsx`); Letter Templates has its own
dedicated page that never wired the equivalent in. Cosmetic/tidiness
gap, not a correctness or security issue. Unblocked by wiring the same
generic-master PATCH pattern into this page.

## Must-fix-before-pilot (found on the pre-pilot walkthrough)

Three gaps found walking a realistic project through the real product.
All three have since been fixed.

**Fixed: staff construction-update UI.** `ProjectDetail.tsx` now has a
Construction Updates panel (create with title/description/date, attach
photos, list, delete) wired to `ConstructionUpdateAdminController`,
which was already fully built and tested (Phase 6, real IDOR tests,
real Playwright coverage on the portal render side) but had zero
caller anywhere in `apps/web`. See CHANGELOG.md's `[0.3.0]` entry.

<!-- Original finding, kept for context on what "fixed" resolved: -->
- ~~No staff UI to publish a construction update or attach a progress
  photo.~~ `ConstructionUpdateAdminController` is fully built and tested
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

## `Inquiry`'s other optional FK fields aren't validated against the caller's company either

Code review of the Phase 0 lead-stage diff (before it shipped) found and
fixed the missing check for `stageId` — `InquiryService.create()`/
`update()` never confirmed a client-supplied `stageId` belongs to the
caller's own company before persisting it; the DB foreign key only
proves the row exists somewhere in `lead_stages`, not that it's in
scope. Fixed via `LeadStageTransitionService.assertStageBelongsToCompany`.

**Not fixed in the same pass, and this is the gap**: `projectId`,
`sourceId`, `inquiryTypeId`, `preferredUnitTypeId`, and `temperatureId`
on `Inquiry.create()` have the identical shape — none of them are
re-checked against `companyId` before the `tx.inquiry.create()` call
(only `applicantId` is, via an explicit `tx.applicant.findFirst({where:
{id, companyId}})`). A caller who obtains another company's id for any
of these could set a cross-tenant reference the same way `stageId`
used to allow. Scoped out of the `stageId` fix specifically because it
was a targeted review fix, not an invitation to widen the diff into
every sibling field — but the underlying gap is real and the fix
pattern is now established (mirror `assertStageBelongsToCompany`'s
shape for each master/relation). Whoever picks this up should audit
`InquiryService.update()`'s DTO fields too, not just `create()`'s.
explicitly rather than deriving them from `rows[0]`.

## Should logging a follow-up on a closed lead reopen it?

`FollowUpService.create()`'s status-advance ternary
(`status: inquiry.status === 'OPEN' ? 'CONTINUED' : inquiry.status`)
only flips OPEN to CONTINUED — a DUMPED or SUCCESSFUL inquiry's status
is left exactly as-is when a new follow-up with a `nextActionAt` is
logged against it. This has been the actual behavior since item 1 of
the Follow-Up Page spec work landed; a stale comment above it claimed
otherwise for a while (fixed, not the point of this entry).

The open product question: should logging an interaction on a closed
lead reopen it? Current behavior says no — a rep can log a note against
a DUMPED or SUCCESSFUL inquiry (there's no guard against that either)
without it silently coming back to life in the active pipeline. That
seems like the safer default (a closed lead shouldn't resurrect via a
side effect of logging a call), but nobody has actually asked for
either behavior — this is speculative, not SOP-mandated. Whoever
changes it should decide deliberately, not fix it as a "bug."

## `apps/e2e`'s CI job has a real, pre-existing intermittent flakiness under concurrency — found while shipping the pre-sales reporting suite, not caused by it

Building the reporting suite's own Playwright coverage
(`presales-reports.spec.ts`, PR #27) surfaced a genuine, reproducible
problem in the `e2e-playwright` CI job itself: a **rotating subset** of
the suite's heaviest, most login-intensive specs — `team-scope.spec.ts`,
`ticket-reply.spec.ts`, `user-role-edit.spec.ts`,
`successful-to-booking.spec.ts`, `rapid-reload-session.spec.ts` — fails
intermittently, at the exact test-timeout ceiling (30.0-30.1s, not a
partial-progress miss), across otherwise-identical CI runs.

**Proven unrelated to that PR's own changes, not assumed.** After five
different fix attempts each targeting a specific hypothesis (below) left
the same two specs failing every time, `presales-reports.spec.ts` was
removed from the branch ENTIRELY and pushed as a pure diagnostic (run
[33245056896](https://github.com/AshishGTH/openestate/actions/runs/33245056896),
job 99081209383). The job still failed — but with a **different** pair
of specs (`successful-to-booking.spec.ts` + `user-role-edit.spec.ts`)
than the pair that had been failing with the new spec present
(`team-scope.spec.ts` + `user-role-edit.spec.ts` — seen across runs
[33242845925](https://github.com/AshishGTH/openestate/actions/runs/33242845925),
[33243617317](https://github.com/AshishGTH/openestate/actions/runs/33243617317),
[33244004498](https://github.com/AshishGTH/openestate/actions/runs/33244004498),
[33244405582](https://github.com/AshishGTH/openestate/actions/runs/33244405582)).
That rotation — a different pair failing depending on what else is in
the suite, at the same fixed ceiling regardless — is the signature of
real, load-dependent contention, not a specific spec's logic being
wrong. Two "success" runs on `master` from just before this PR
(`33065667370`, `33066407872`, both 35/35 with zero retries) were
initially taken as evidence the branch introduced the problem — that
turned out to be two lucky samples, not proof of master's true
underlying rate; the diagnostic above is the actual evidence.

**Root mechanism, from Playwright's own trace artifacts, not
speculation**: the browser is sitting on `/login` at the exact moment
of failure, mid-test, even though the test code believes it's several
steps past login. `page.goto()` is a real browser navigation (not a
React Router client-side transition) — it remounts the whole SPA and
re-fires `AuthProvider`'s mount-time `/auth/refresh` call. This project
already documents and partially mitigates this exact race
(`REFRESH_REUSE_GRACE_SECONDS`, the "rapid-reload-logout" fix in
CLAUDE.md's Decisions log) — the new finding is that under **real CI
concurrency** (many spec files' own logins and page reloads landing in
the same narrow window, not just React StrictMode's double-effect
pattern the original fix targeted), the existing grace window can still
be exceeded.

**Wrong turns ruled out, in order, so a future session doesn't re-walk
them:**
1. *Fixture contention on the shared `mastersCrud` company's Users list*
   (`Users.tsx` paginates at `limit: 20`; many concurrent specs create
   users against the same company). Plausible-looking, and partially
   true as a contributing factor, but eliminated as the SOLE cause: even
   after moving the affected test onto a fully independent company
   (zero shared rows), the same two specs kept failing identically.
2. *The shared default rate-limit bucket* (100 req/60s, IP-keyed,
   `app.module.ts`) being exhausted by this PR's own added `/auth/login`
   calls. Real and fixed on the **backend** integration-tests job
   (unrelated 429s on `e2e-tickets`/`e2e-plugins` went away after
   consolidating `e2e-presales-reports.test.ts` from 7 logins to 3) —
   but the E2E/Playwright job runs a completely separate API process
   with its own separate budget, and reducing this PR's own Playwright
   login count (down to a single login, then down to zero via the
   diagnostic) never changed the E2E outcome.
3. *Needs more time, not a hang* — raised Playwright's CI timeout from
   30s to 45s. The same two specs failed at 45.0-45.1s instead, exactly
   on the new ceiling rather than somewhere in between — ruling out
   "genuinely slow but progressing" and pointing at a real stuck state
   instead. Reverted.
4. *This PR's own extra page reload* — replaced a `page.goto()` with a
   client-side nav-link click to cut one avoidable `/auth/refresh` call.
   Real and directionally correct (contributes less load), but not
   sufficient on its own — the same failures persisted until the
   zero-spec diagnostic finally isolated the true scope of the problem.

**What would actually close this**: the refresh-rotation race needs to
tolerate real concurrent load, not just React StrictMode's synchronous
double-invoke. Candidate directions: widen
`REFRESH_REUSE_GRACE_SECONDS` (a config change, but see its own
Decisions-log entry for the security trade-off that name already
documents — widening it further isn't free); or make the specific
heaviest specs (`team-scope`, `user-role-edit`, `ticket-reply`,
`successful-to-booking`) reuse an already-authenticated session instead
of each doing several sequential fresh logins in one test, the same
"extend an existing fixture's login, don't add a new one" discipline
this file's own portal-auth-throttle entry already established for a
different bucket. Either way, per CLAUDE.md's standing rule, a real
change to the refresh/auth path needs its own real-browser
click-through on both staff and portal before it ships — a materially
bigger undertaking than this entry, and deliberately not attempted as a
side effect of an unrelated feature PR.

**Standing note, not a licence to wave off E2E failures generally**: a
failure in a spec you just touched, or a NEW failure appearing in a spec
you didn't, is still yours to investigate until proven otherwise — the
rotation described here was established with a real diagnostic (removing
the suspect code and confirming the failure persists unchanged in kind),
not assumed from "E2E is flaky" folklore. This entry documents one
specific, evidenced instance of pre-existing contention; it does not mean
future E2E red is presumed innocent.
