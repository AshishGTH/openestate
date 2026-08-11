# Changelog

All notable changes to OpenEstate are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- **Upgrading an existing install left the Super Admin role unable to use
  newly-shipped features.** Since v0.2.0, upgrades correctly added new
  permission *rows* to the database, but never granted them to anyone —
  so on any install created before a given release, the `super_admin`
  role kept exactly the permissions it was first seeded with. In
  practice this meant **PLC and unit-charge pricing (shipped in v0.2.0)
  was unreachable on every upgraded install**, for the most privileged
  role in the product, with no error message explaining why. Found on a
  real v0.1.2 → v0.2.3 upgrade: the `permissions` table held all 142
  rows while `super_admin` held only 140.

  Upgrades now re-grant `super_admin` any permission it is missing.
  This runs automatically as part of `upgrade-native.sh` — no manual
  step. **If you have upgraded before and found a feature missing from
  the UI, this is very likely why**; re-running the upgrade repairs it.

  Only `super_admin` is repaired, deliberately. Its definition *is*
  "every permission that exists", so a missing one is drift rather than
  a choice. `company_admin`, `sales_manager` and any custom role are
  left exactly as configured — an upgrade must never silently widen a
  permission set an admin deliberately narrowed. Grant new permissions
  to those roles through Admin → Roles.

- `packages/db` imported `@openestate/shared` in two shipped scripts
  (`seed.ts`, `sync-permissions.ts`) without declaring it as a
  dependency; it resolved only by package-manager hoisting. Now
  declared explicitly.

- **Correctness fix: a booking's cost lines could silently price at 0%
  GST.** A booking's `BASE` cost line had no GST rate picker anywhere in
  the wizard, and every PLC/charge line without its own rate falls back
  to the base line's — so with no rate ever set on the base line, an
  entire booking (base price, PLC, and any charge type without its own
  configured GST rate) taxed at 0%, with no error and no on-screen
  signal. Unlike the other gaps found on the same pre-pilot walkthrough,
  this one produces a printed document — a demand letter, a statement —
  with the wrong tax amount and nothing to flag it, the same failure
  shape as the bounced-cheque-still-counted-as-collected bug fixed
  earlier this project's history. Fixed at the point of resolution, not
  just in the UI: `BookingService.createBooking` now rejects the whole
  booking (full rollback, no partial row written) if any cost line's GST
  rate can't be resolved through the existing own → charge-type →
  base-line chain, naming the specific line and pointing at the base
  line first since setting it fixes every line that falls back to it.
  `BookingWizard.tsx` gained a GST-rate picker on the base line
  (auto-selected only when exactly one active rate exists — never
  guessed otherwise) so a real admin hits this before submitting, not
  after.

  **Bookings created before this fix are not retroactively corrected.**
  `BookingCostLine` is an immutable snapshot by design (the same
  invariant behind rate-master edits never touching an existing
  booking), and there is no way to know after the fact what the correct
  historical GST rate should have been without a human reviewing each
  affected booking — the same reasoning already applied to the
  `CompanyConfig.gstStateCode` correctness fix. A boot-time log
  (non-fatal, mirrors the existing GST-config-completeness check) and a
  persistent admin banner now surface a count of affected bookings
  instead, linking to a new "Zero-GST bookings" report
  (`Post-sales → Reports`, CSV export included) listing the exact
  booking numbers — **check any already-issued document for these
  bookings before relying on it.**

## [0.2.3]

### Security

- **Custom field values are no longer sent to portal users.** Until this
  release, `GET /portal/profile` returned the customer's whole applicant
  record — including any admin-defined custom field values — to the
  customer themselves **and to their co-applicants**. Custom fields are
  routinely used by staff for internal notes ("negotiation margin",
  "credit risk", "do not call before 11am"), and nothing in the field
  definition marks a field as safe to show a customer, so all of them
  are now withheld from every portal response. Per-field opt-in
  visibility is a deliberate future feature; withholding is the only
  defensible default in the meantime.

  **If your staff have written anything sensitive into a custom field on
  an Applicant, assume portal users could have seen it before
  upgrading.** Values themselves are untouched — only what the portal
  returns has changed.

### Fixed

- **Integrity fix: custom field values have accepted arbitrary,
  unvalidated data since Phase 3 — your database may already contain
  junk.** `customFields` on Applicant and Inquiry was declared as
  "any object" at the API boundary (`z.record(z.unknown())`), so any
  caller could write any key with any value straight into storage: no
  type checking, no required-field checking, no check that a SELECT
  value was one of its options, and no rejection of keys that were never
  defined as custom fields at all. The validation code to prevent this
  had been written but was never called by anything.

  Validation is now enforced server-side against your active field
  definitions on every write, for Applicant, Inquiry, Unit and Project.
  Unknown keys are **rejected** rather than silently discarded.

  To see whether an existing install has junk values, run this against
  your database — it lists every stored key that has no matching custom
  field definition:

  ```sql
  SELECT 'applicant' AS entity, a.id, k AS unknown_key, a.custom_fields -> k AS value
    FROM applicants a, jsonb_object_keys(a.custom_fields) k
   WHERE a.custom_fields IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM custom_field_definitions d
                      WHERE d.company_id = a.company_id
                        AND d.entity_type = 'APPLICANT' AND d.key = k)
  UNION ALL
  SELECT 'inquiry', i.id, k, i.custom_fields -> k
    FROM inquiries i, jsonb_object_keys(i.custom_fields) k
   WHERE i.custom_fields IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM custom_field_definitions d
                      WHERE d.company_id = i.company_id
                        AND d.entity_type = 'INQUIRY' AND d.key = k);
  ```

  Anything it returns is either junk written before the fix, or one of
  two expected system-written keys (`leadNote` from inbound leads,
  `importNotes` from CSV import). Values belonging to a field you merely
  *deactivated* will **not** appear — that definition still exists, so
  those values are accounted for.

  **Nothing is deleted by upgrading.** Existing values are preserved and
  still shown on detail screens, marked "(inactive)" where no active
  definition covers them, and records carrying such keys stay editable —
  validation rejects unknown keys arriving from a client, but never
  retroactively invalidates what is already stored.

- Deleting a custom field used to be a hard delete, which left its
  values orphaned in the database with nothing left to explain what they
  meant. Delete is now a **deactivate** (values preserved, field stops
  appearing on forms). Permanently destroying values is a separate
  action that requires typing the field's key to confirm, and records
  the affected row count to the audit log.

### Added

- **Custom field values now actually work.** Admins could define custom
  fields since Phase 1, but nothing anywhere captured or displayed a
  *value* — defining a field had no effect elsewhere in the product.
  Values are now captured on real forms, validated, displayed on detail
  screens, and exported. Supported on **Applicant, Inquiry, Unit and
  Project**; a field's definition drives the form with no code change.
- New per-inquiry CSV export (`/reports/presales/inquiries-export`) with
  one column per active custom field.
- `BOOKING` is explicitly marked unsupported in the admin UI (with an
  explanation) and rejected by the API, rather than letting an admin
  define a field there that would silently do nothing. See
  `docs/todo.md`.

## [0.2.2]

### Added

- **Layout plan / brochure / photo uploads.** `UploadService` has
  supported these categories since Phase 2 but no route ever called it
  — this release wires it up. Staff get a **Media** panel on a
  project's detail page (upload, list, download, delete); customers
  see the same files under a new "Layout plans & brochures" section on
  the portal Property page, with real download links.
- **Construction-progress photos actually render now.** The upload
  path for `ConstructionUpdateMedia` has existed since v0.2.1's own
  predecessor, but there was never a serving route on either side —
  the portal only ever showed a photo *count*. Staff and portal both
  gained a download route, and the portal Property page now renders
  the real images inline instead of a bare "N photo(s)" line.
- **Per-project storage cap.** Layout plans, brochures, photos, and
  construction-progress photos all roll up disk usage under one
  project — unbounded uploads on a self-hosted box eventually fill the
  disk, which surfaces as Postgres refusing writes and looks like
  total system failure rather than a storage problem. A configurable
  file-count cap (default 50) and total-size cap (default 500MB) per
  project are enforced before any file touches disk, with a clear
  error naming the limit. Configurable via Company Config
  (`projectMediaMaxFiles`/`projectMediaMaxBytes`).
- IDOR coverage for both new download routes: a customer with a
  booking in one project cannot fetch another project's media by
  guessing an id — proven via the same raw-connection RLS discipline
  as every other portal IDOR test in this codebase, since both
  `project_media`/`construction_update_media`'s portal RLS predicates
  are multi-hop and therefore not mirrored at the JS layer.
- Two new e2e Playwright scenarios: staff uploads a layout plan
  through the real UI and the customer downloads it in the portal;
  and a staff-published construction-progress photo renders as a real
  decoded image in the portal (not just a 200 response).

### Still missing

- **Custom field values.** Admins can define custom fields (Applicant,
  Unit, etc.) via Admin → Custom Fields, but no form anywhere in either
  app captures or displays a *value* for one — defining a field has no
  effect elsewhere in the product yet.

## [0.2.1]

### Added

- **Staff can now reply to and resolve customer support tickets.**
  Closes the loop that's been open since the portal shipped: customers
  could raise a ticket and read replies, but no staff screen existed to
  see or answer one — the backend (`AdminTicketController`) had been
  fully built and idle the whole time. New **Support** section
  (top-level nav, not nested under Post-sales — inquiries and brokers
  raise tickets too, not just post-sales) with a queue and a thread
  view: reply, change status, filter by status.
- **Ticket queue enrichment.** The queue now shows who raised each
  ticket (resolved from the linked Applicant/Broker, not a bare ID),
  its category, how many messages it has, and when it was last active
  — the minimum a triaging staff member needs to work a queue, none of
  which the API returned before.
- **Overdue flagging from the existing `slaByAt` field.** The column
  has existed in the schema since Phase 6 with nothing reading it; the
  queue now shows an "Overdue" flag when a ticket's `slaByAt` has
  passed and it isn't resolved/closed. No SLA policy or configuration
  was added — this only renders a field that was already there.
- The e2e harness gained its first scenario that drives **both**
  `apps/web` and `apps/portal` against the same API in one test:
  customer raises a ticket → staff sees it, replies, resolves it →
  customer sees the reply. Every prior scenario exercised one app at a
  time.

### Still missing

Two gaps remain, tracked for future releases, not fixed here:

- **Layout plan / brochure / photo uploads.** The validation and
  storage service (`UploadService`) has existed since Phase 2 and
  already supports these categories, but no route in the Inventory
  module has ever called it — there is no way, staff or customer
  portal, to attach or view a project's layout plan today.
- **Custom field values.** Admins can define custom fields (Applicant,
  Unit, etc.) via Admin → Custom Fields, but no form anywhere in either
  app captures or displays a *value* for one — defining a field has no
  effect elsewhere in the product yet.

## [0.2.0]

**Upgrade note:** `upgrade-native.sh` now syncs new `PERMISSIONS` rows to
existing installs automatically (see the permission-delivery fix below),
but it does not — and should not — grant them to any role for you. After
upgrading, an admin must open **Admin → Roles**, edit each role that
should get the new PLC/charge-management capability, check
`inventory.unit.plc-manage` / `inventory.unit.charge-manage`, and save.
This is a deliberate, permissions-only sync — see the entry below for why
auto-granting them would be its own bug, not a fix.

### Fixed

- **Correctness fix affecting GST charged on bookings and extra charges —
  check your invoices if your company's GST State Code was ever unset.**
  `isIntraStateSupply()` used to silently default to intra-state
  (CGST+SGST) whenever the company's GST state code or a booking's
  place-of-supply state code was missing, instead of raising an error.
  Any company whose Company Config GST fields were never filled in —
  every install created before those columns existed, or any install
  where nobody had visited Company Config yet — has been charging
  CGST+SGST on every booking and extra charge regardless of where the
  property actually is, which is the WRONG tax treatment (IGST) whenever
  the real place of supply is in a different state from the company's
  own. This produced no error and no warning; the only way to notice was
  to already know the correct treatment and check by hand. **If this
  applies to you, review bookings/extra charges made while your GST
  config was incomplete and correct any wrongly-taxed invoices — this
  release does not retroactively fix already-issued invoices.** Going
  forward, `isIntraStateSupply()` now throws instead of guessing — a
  booking or extra charge with incomplete GST config is rejected with a
  clear error naming what to set in Company Config, rather than silently
  taxed wrong. The app also now logs a warning at boot listing any
  company with incomplete GST config, and the staff admin UI shows a
  persistent banner linking to Company Config until it's completed.

- **Correctness fix affecting reported collection figures — upgrade and
  let the migration run before trusting any collection report.** A prior
  bug (see the REPORTS-phase entry in `CLAUDE.md`) left bounced-cheque
  receipts still marked as collected (`is_reversed = false`) in every
  collection report, rollup, and the customer portal's own payment
  history — the code fix stops this going forward, but does nothing for
  receipts that already bounced before you upgrade. Migration
  `20260804120000_backfill_bounced_receipt_is_reversed` corrects those
  existing rows on your next `prisma migrate deploy` (part of the normal
  upgrade path — no manual step needed). It only touches the
  `is_reversed`/`reversal_reason` flag on affected receipts; it does not
  alter any ledger entry, allocation, or installment. If your reported
  collection totals looked too high before upgrading, they'll drop by
  the sum of any previously-bounced cheques once this runs.

- **A release that adds a `PERMISSIONS` constant never reached an
  existing install — only a fresh one.** `seed.ts`'s permission-upsert
  loop ran unconditionally, but the early-return gate right after it
  (`if (existingCompany) return`) meant no other seeded content, and
  critically no *later* permission addition, was ever re-applied to a
  company created in an earlier release. `upgrade-native.sh` now runs a
  dedicated `sync-permissions.ts` step (idempotent, permissions-table
  only) on every upgrade, so new permission rows reach existing installs
  the same way they reach fresh ones. Deliberately does NOT extend to
  masters or roles — see the upgrade note above and `CLAUDE.md` for why
  that's a different (and mostly correct-as-is) problem.
- **A system role (`super_admin`, `company_admin`, etc.) could never be
  granted a newly-added permission through the UI, at all.**
  `RolesService.update()` rejected any change to a system role, not just
  a rename — so even with the fix above delivering the permission *row*,
  there was no way to actually grant it to a role. Scoped the guard to
  an actual name change only; a system role's permission set is now
  freely editable (its name and existence stay protected, as before).

### Added

- **PLC and unit-charge management.** Unit-level PLCs (park-facing,
  corner, etc.) and extra charges (IFMS, legal, etc.) can now be
  assigned per unit from the Inventory → Project → Pricing panel, and
  flow into a booking's cost breakup and the confirm step's total
  automatically. PLC amounts are snapshotted in paise at assignment time
  (from a percentage of the unit's rate, or a flat amount) and never
  retroactively change if the base rate is revised later.
- **Per-charge-type GST rates.** Charge Types now carry their own
  optional GST rate and HSN/SAC code (Masters → Charge Types). A cost
  line's GST resolves in order: its own rate, then its charge type's
  rate, then the booking's base-line rate — never silently zero-rated.
  A PLC line has no charge type, so it always inherits the base line's
  rate; this is stated explicitly rather than left implicit.

### Changed

- Replaced the `argon2` password-hashing dependency with
  `@node-rs/argon2` (pure Rust via napi-rs). `argon2` had caused two
  separate deployment failures on two different platforms (an
  Alpine/musl prebuild issue, and a still-unexplained SIGSEGV
  crash-loop on GitHub's `ubuntu-latest` CI runners — see `CLAUDE.md`
  for the full, ultimately-inconclusive investigation); the replacement
  ships prebuilt binaries for every platform this project targets and
  never falls back to compiling from source. Existing stored password
  hashes remain verifiable — both libraries use the same standard PHC
  string format, confirmed by directly cross-verifying a real hash
  between the two before switching. No action needed on upgrade, no
  password resets.

## [0.1.2]

**Upgrade from v0.1.1 as soon as practical.** Two bugs in that release
are severe enough on their own to justify this one:

- **Any account with 2FA enabled was permanently locked out of login**,
  with no way back in — not even via a recovery code. The login
  response's 2FA-pending branch never set the CSRF cookie `totp/verify`
  requires, so every `totp/verify` call (including recovery-code
  attempts) 403'd with "CSRF token mismatch," unconditionally, for
  every account. **If you're running v0.1.1 and have 2FA enabled on
  any staff account, upgrade before enrolling further users** — those
  accounts have been unable to log in since enabling it, and existing
  locked-out accounts will need a staff admin to disable 2FA for them
  (`POST /auth/totp/disable`, or directly via the database) after
  upgrading, since the fix doesn't retroactively unlock an in-progress
  login attempt.
- **A genuinely fresh install failed immediately** on the exact command
  the docs tell you to run. Every `deploy/native/*.sh` script an admin
  runs directly was git-tracked without the executable bit; `sudo
  ./install-native.sh` right after `git clone` died at "Permission
  denied" trying to exec `setup-database.sh`. Anyone who successfully
  installed v0.1.1 did so from a checkout that had picked up a local,
  uncommitted `chmod +x` somewhere along the way (e.g. copying files
  instead of cloning) — a literal fresh clone was never viable.

### Fixed

- The 2FA lockout above also had a second, independent bug: the
  code-verification schema only accepted 6 digits, rejecting every
  recovery code's `XXXXX-XXXXX` format before it reached the
  already-correct recovery-code check. Both fixed together; verified
  live end-to-end (enroll, login-requires-code, wrong code rejected,
  recovery code works once and is rejected on reuse).
- Company config had no way to set `companyGstin`/`gstStateCode` after
  the initial seed, despite the frozen booking service already reading
  `gstStateCode` to decide CGST+SGST vs IGST. Added, with GSTIN format
  validation (checksum digit deferred — see `docs/todo.md`) and a
  Company Config UI section.
- Health endpoint's `version` field was hardcoded `0.1.0` in every real
  deployment (`npm_package_version` is only set by `pnpm run`, never by
  systemd's/Docker's direct `node dist/main.js`). Now reads
  `package.json` directly.
- 18 of 19 generic master types (unit types, inquiry sources, charge
  types, etc.) 500'd on any create/update call that included a
  description — `createMasterSchema`'s optional `description` field is
  only backed by a real column on `PaymentPlanTemplate`; the shared
  factory blindly spread the whole dto into Prisma's `data`. Fixed once,
  at the root, in the factory.
- `DocumentType`, `InterestRule`, and `TransferFeeRule` couldn't be
  created via the API at all — each has its own required, non-nullable
  columns (`entityType`; `rateType`/`ratePercent`/`frequency`;
  `feeType`) that the generic master schema never had, so every attempt
  500'd on a Prisma "Argument missing" error instead of failing
  validation cleanly. The shared factory now supports a per-model
  `extraFields` schema extension.
- `LetterTemplate` had no working create path at all — zero templates
  could ever exist, blocking demand/allotment/reminder letter generation
  entirely. It was routed through the generic master factory (whose
  schema has no `subject`/`entityType`/`body`) instead of a dedicated
  module; given one, mirroring the existing `SmsTemplateModule`
  precedent, with merge-field validation at save time.
- Duplicate master names (any of the 18+ shared-factory types) returned
  a raw 500 instead of a clean "already exists" 400 — nothing in this
  codebase had ever caught Prisma's P2002 unique-constraint error for
  these dynamically-keyed services (unlike `RolesService`/`UsersService`,
  which pre-check via `findFirst`). Mapped once, in the factory.
- `install-native.sh`/`upgrade-native.sh`'s database migration step
  failed on any host where the git checkout lives under a directory
  tree the `postgres` OS user can't traverse (e.g. GitHub Actions
  runners: `/home/runner` is mode `0750`) — Prisma 6.19+ auto-discovers
  a `prisma.config.*` file in the current working directory before
  running any command, and that lookup's `lstat()` fails `EACCES` (not
  `ENOENT`) in that case, which Prisma treats as a hard failure rather
  than "no config file, proceed." `run_as_superuser()` now runs from
  the already-world-traversable release directory instead of the
  checkout.
- `install-native.sh`'s final `systemctl reload nginx` failed outright
  ("nginx.service is not active, cannot reload") on any host where apt
  installed nginx without starting it — the script only ever checked
  that the `nginx` binary was present, never that the service was
  running. Now `enable`s and `reload-or-restart`s it, correct whether
  nginx was already running or not.
- `CustomFieldDefinition.defaultValue` — accepted by the create/update
  schema since it was written, but no backing column ever existed, so
  any real caller sending it 500'd. Added the missing column.
- `POST /users` never returned the `phone` it had just saved — a
  `select` allowlist copy/paste gap (present in `update()`, missing
  from `create()`) left an admin with no way to confirm the phone
  number was stored.

Everything above except the two headline bugs was found by a full
production-readiness pass and a new through-the-wire creation test for
every master type and admin-creatable entity (users, roles, custom
fields) — the existing suite seeded rows directly, which is exactly why
these bugs survived to a tagged release. Also added: real-HTTP creation
coverage for all 22 master types plus users/roles/custom fields, and a
`native-install` CI job that runs the full native install on a real
`ubuntu-latest` runner on every push. That CI job is not yet green — a
separate, CI-runner-specific issue (the deployed app crash-looping with
SIGSEGV, isolated to argon2's native module, confirmed not to reproduce
on a real server) is still open and tracked in `CLAUDE.md`; it does not
affect real installs, only that one job's own coverage.

## [0.1.1]

### Added

- **Native install path** (`deploy/native/`): `install-native.sh` sets up
  OpenEstate as a systemd service behind nginx, talking to a PostgreSQL
  and Redis you already run — no Docker involved in production. Also
  ships `setup-database.sh` (standalone DB/role setup for a DBA-managed
  Postgres), `upgrade-native.sh` (backup → build → migrate → cutover,
  with automatic rollback on a failed healthcheck), `backup-native.sh` /
  `restore-native.sh`, and `uninstall.sh`. Docker Compose is unaffected
  and still fully supported — it's now positioned as a contributor tool
  for the test suite rather than the primary production path; see
  `docs/docs/installation.md` and `CONTRIBUTING.md`.
- A CI job (`native-install` in `.github/workflows/ci.yml`) runs the full
  native install on a real `ubuntu-latest` runner — installs PostgreSQL,
  Redis, Node 20, nginx, and a build toolchain, runs `install-native.sh`,
  and asserts the health endpoint responds and a login succeeds over real
  HTTP — so the native path is verified on every push, not just once by
  hand.
- Consistent, user-visible toasts on failed mutations across both
  `apps/web` and `apps/portal` (`lib/toast.tsx` + a `MutationCache`-based
  global handler in each app's `main.tsx`), replacing a mix of silent
  failures, inline-only banners, and unhandled promise rejections found
  during an audit of ~15+ call sites.

### Fixed

- **Login failed on every fresh Docker Compose install with "Cannot POST
  /api/api/v1/auth/login".** `VITE_API_URL` defaulted to `/api`
  (`deploy/.env.example`, `deploy/docker-compose.yml`,
  `deploy/docker/{web,portal}.Dockerfile`), but `apps/web`/`apps/portal`'s
  own API client already hardcodes `/api/v1/...` on top of it, and
  nginx's `/api/` location already forwards that prefix through unchanged
  — doubling it. Since Vite bakes this value into the built JS bundle at
  image-build time, existing installs need `git pull` +
  `docker compose up -d --build` (not just a restart) to pick up the fix.
- **Every validation error (400) showed the generic toast "Validation
  failed" instead of saying what was actually wrong**, across both apps
  — nestjs-zod's default exception hardcodes that message regardless of
  which field failed. The API now returns the real per-field reason
  (e.g. `"url: Invalid url; secret: String must contain at least 16
  character(s)"`).
- A handful of mutations (webhook endpoint creation in `apps/web`, three
  non-mutation-hook webhook actions, PDF downloads in both apps) failed
  silently or inline-only, with no toast — fixed as part of the same
  audit.
- Eight real bugs in the native-install scripts, found only by running
  `install-native.sh` end-to-end on a genuinely clean VM — none caught by
  shellcheck, `nginx -t`, or a careful read of the scripts: a missing
  build-toolchain prerequisite check (`argon2` needs `make`/`g++`/
  `python3`); a build failure silently swallowed by a `set -e`
  propagation gap; `NODE_ENV=production` leaking into the build and
  dropping devDependencies; the build's own stdout corrupting a command
  substitution; `node <script>` failing on pnpm's shell-script `.bin`
  shims; a fragile cross-store Prisma client copy replaced with
  regenerating the client in place; `backup-native.sh` failing under RLS
  by dumping via the wrong role; and `restore-native.sh` failing to drop
  a database still held open by the running service. Full detail in
  `CLAUDE.md`'s decisions log.

### Verified

- Ubuntu 24.04 LTS with PostgreSQL 16, and Ubuntu 25.10 with PostgreSQL
  17 — both confirmed end-to-end: fresh install, safe re-install, real
  HTTP login and role creation, upgrade with rollback, backup/restore,
  and both uninstall modes. The scripts check for `psql` presence, not
  an exact major version, so this isn't expected to be an exhaustive
  platform list — just what's actually been run.

## [0.1.0] — first tagged release

The first tagged release of OpenEstate: a self-hostable, open-source
(AGPL-3.0) CRM for real estate, built for the Indian market first with a
plugin system designed for other verticals to adapt it without forking
core code.

### Core domain

- **Pre-sales**: inquiry capture and dedup, round-robin/manual lead
  assignment (fair under concurrency, advisory-lock serialized), follow-up
  and site-visit tracking, escalation on overdue follow-ups, applicant
  merge with a consent audit ledger, funnel/ageing/source reports.
- **Post-sales / financial core**: append-only ledger (balances are always
  computed, never stored), booking → payment plan → receipt → cheque
  lifecycle, GST (CGST/SGST/IGST) and TDS (194-IA) handling, interest
  accrual, unit transfer, cancellation with configurable deduction rules,
  two-phase refunds, gap-free receipt/booking numbering, PDF generation
  (receipts, statements, demand/allotment/reminder letters) with dispatch
  and delivery tracking. Correctness proven by a property-based test suite
  (fast-check) run against every CI build.
- **Brokers and commissions**: slab-based commission rules, accrual with
  point-in-time snapshotting, a request → approve → pay → reject payment
  workflow, TDS (194-H) withholding, and clawback on booking cancellation.
- **Customer and broker portals**: separate, minimal-scope authentication
  and rate-limit buckets from staff; row-level security is the primary
  isolation mechanism for these untrusted clients, not just a
  defense-in-depth backstop.
- **Custom fields, terminology, and module flags**: every entity supports
  admin-defined custom fields; labels ("Unit" → "Product", etc.) and
  enabled modules are configurable per company, not hard-coded — the
  mechanism the `generic-sales` plugin (below) proves out for a
  non-real-estate vertical.

### Plugins, webhooks, and integrations

- A plugin SDK (`@openestate/plugin-sdk`) with capability-gated context
  access, package-boundary isolation (no database access path from
  plugin code at all), SSRF-hardened outbound HTTP, and a first-party
  `generic-sales` reference plugin.
- Outbound webhooks: HMAC-signed, replay-protected, retried with
  exponential backoff, auto-disabled after sustained failure.
- Inbound lead API: per-key authentication and rate limits, a
  generic field-mapping config so common vendor integrations (99acres,
  MagicBricks, a generic webhook) need zero plugin code.

### Security

- RBAC permission guards **and** independent Postgres row-level security
  on every tenant-scoped table — not RLS as an afterthought.
- Argon2id password hashing, TOTP 2FA, rotating refresh tokens with
  reuse-family revocation, account lockout with exponential backoff.
- PAN encryption at rest (AES-256-GCM, per-domain keys, never reused
  across PAN/TOTP/plugin-secret rotation domains) for both brokers and
  applicants; phone/PAN masking in list views and logs.
- Immutable financial ledger enforced at the database level (a trigger
  blocks UPDATE/DELETE, not just application discipline).
- Redis-backed rate limiting shared across replicas and surviving
  restarts.
- Docker images pinned to verified sha256 digests; a randomly generated,
  single-use initial admin credential (never a shared default).
- A formal [OWASP ASVS L2 self-assessment](docs/docs/security/asvs-checklist.md)
  and [STRIDE threat model](docs/docs/security/threat-model.md) per
  module, stating accepted residual risk plainly rather than implying
  guarantees the architecture doesn't make.

### Known limitations (see `docs/todo.md` for the full list)

- Rate-limit storage is now Redis-backed, but no other component of the
  first-party plugin trust model provides worker-thread/process
  isolation against a deliberately malicious plugin — first-party
  plugins ship as reviewed npm workspace packages in this repository,
  the same review bar as any other module, not as untrusted third-party
  code.
- No automated TLS/certificate setup in `install.sh` — self-hosters
  bring their own reverse-proxy TLS termination.
- Some staff-service call sites still self-wrap tenant context
  redundantly with the ambient interceptor (low-risk cleanup, a runtime
  guardrail already backstops the one bug class this pattern caused
  historically).
