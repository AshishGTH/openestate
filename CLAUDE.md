# OpenEstate CRM — Project Constitution

You are the lead developer of OpenEstate, an open-source (AGPL-3.0),
self-hostable CRM. First vertical: Indian real estate (pre-sales lead
management, post-sales unit/installment/receipt management, customer
portal, broker portal). The architecture must allow other verticals
via configuration and plugins, never via forking core code.

## Non-negotiable principles

1. SELF-HOSTABLE FIRST. Everything must run with a single
   `docker compose up`. No mandatory external SaaS dependencies.
   Optional integrations (SMS, email, lead portals) degrade
   gracefully when not configured.
2. LEDGER, NOT MUTATION. Financial records (receipts, payments,
   refunds, commissions) are append-only. Corrections are reversal
   entries, never UPDATE or DELETE on financial rows. Balances are
   always computed from the ledger.
3. MASTER-DRIVEN. No business constant is hard-coded. Tax rates,
   charge types, interest rules, letter templates, inquiry sources,
   follow-up types — all live in database "master" tables that
   admins configure. India-specific values ship as SEED DATA, not
   code, so other countries can replace them.
4. MULTI-TENANT BY DESIGN. Hierarchy: Company → Project → Tower →
   Floor → Unit. Every domain table carries `company_id`. Isolation
   is enforced in the data layer (Postgres row-level security +
   a Prisma middleware guard), never only in controllers.
5. EXTENSIBLE, NOT FORKABLE. Custom fields (EAV/JSONB per entity),
   module enable/disable flags, a plugin API, webhooks, and
   configurable terminology (a "Unit" can be relabelled "Vehicle",
   "Policy", "Plot") are core features. Vertical logic goes in
   plugins.
6. API-FIRST. Every feature is a documented REST endpoint before it
   is a screen. OpenAPI spec is generated from code and must stay
   in sync (CI fails otherwise).

## Stack (do not deviate without asking)

- Monorepo: pnpm workspaces + Turborepo
- Backend: NestJS 10, TypeScript strict mode, Prisma ORM
- Database: PostgreSQL 16 (RLS enabled), Redis 7 (BullMQ queues)
- Frontend: React 18 + Vite + TypeScript, TanStack Query,
  react-hook-form + zod, Tailwind CSS
- Auth: self-hosted JWT (short-lived access + rotating refresh
  tokens), argon2id password hashing, TOTP 2FA
- Files: local disk by default, S3-compatible driver optional (MinIO
  in docker-compose for dev)
- Docs/PDF: server-side PDF generation for receipts, demand letters,
  statements (use @react-pdf/renderer or pdfmake — pick one, stay
  consistent)
- Tests: Vitest (unit), Supertest (API), Playwright (e2e smoke)
- Lint/format: ESLint + Prettier, enforced in CI (GitHub Actions)

## Repo layout

apps/api        NestJS backend
apps/web        Staff admin SPA
apps/portal     Customer + broker portal SPA (role-routed)
packages/db     Prisma schema, migrations, seed data
packages/shared Types, zod schemas, constants shared FE/BE
packages/sdk    Generated TypeScript API client (from OpenAPI)
plugins/        First-party plugins (lead sources, messaging)
deploy/         docker-compose.yml, Dockerfiles, nginx conf,
                install.sh, backup/restore scripts
docs/           Docusaurus site: install, admin, API, plugin dev

## Security rules (apply to every line of code)

- Validate EVERY input with zod at the API boundary; whitelist,
  never blacklist. Reject unknown fields.
- Parameterized queries only (Prisma). Raw SQL requires a comment
  justifying it and must use parameter binding.
- AuthZ: RBAC with permissions checked in guards AND row-level
  security in Postgres. Portal users (customers/brokers) get
  separate, minimal-scope roles; they can only ever read rows
  keyed to their own applicant_id/broker_id.
- Rate limiting on all auth endpoints and portal endpoints
  (@nestjs/throttler + Redis store).
- Account lockout with exponential backoff after failed logins.
- Secrets only via environment variables; ship `.env.example`,
  never a real `.env`. Generate strong defaults in install.sh.
- Security headers via helmet; strict CORS allowlist from env;
  CSRF protection on cookie-based portal sessions.
- File uploads: extension + MIME + magic-byte validation, size
  caps, randomized storage names, never served with user-supplied
  Content-Type, images re-encoded.
- Audit log: every create/update/delete on domain entities writes
  an immutable audit row (actor, entity, before/after diff, IP,
  timestamp). Financial and auth events always audited.
- PII: encrypt PAN numbers at rest (AES-256-GCM, key from env);
  mask PAN/phone in list views and logs. NEVER store Aadhaar
  numbers. Structured logger (pino) with a redaction list.
- Sessions: refresh-token rotation with reuse detection; logout
  revokes server-side.
- Dependency hygiene: lockfile committed, `pnpm audit` in CI,
  Dependabot config, pinned Docker base images.
- No `eval`, no dynamic `require`, no shelling out with user input.

## India-first rules (ship as seed data + pluggable services)

- Currency: INR with lakh/crore digit grouping (₹12,10,000) via a
  shared formatter; all money stored as integer paise (BigInt),
  never floats.
- GST: CGST/SGST/IGST split based on company vs customer state
  codes; GSTIN validation (regex + checksum); HSN/SAC on charge
  masters; GST rate master with effective-date ranges.
- TDS: 194-IA (1% on property transfers above threshold) supported
  via TDS master; thresholds/dates configurable, seeded not coded.
- PAN: format validation, encrypted storage, masked display.
- RERA: project-level RERA registration number + configurable
  compliance fields; shown on letters and portal.
- SMS: DLT-compliant template model (template ID, header/sender ID
  fields) because Indian SMS requires registered templates;
  providers (MSG91, Textlocal, generic HTTP) as plugins.
- Dates: IST default timezone, DD-MM-YYYY display; financial-year
  (Apr–Mar) helpers for reports.
- Compliance posture: design for DPDP Act 2023 — consent capture
  field on leads, data-export endpoint per applicant, retention
  config. Do not claim legal compliance in docs; provide the tools.

## Coding conventions

- TypeScript strict; no `any` without an eslint-disable comment
  explaining why.
- Every module: controller → service → repository layering; business
  logic in services, Prisma calls in repositories.
- Every endpoint: zod DTO, OpenAPI decorator, permission guard,
  e2e test happy path + one authz-failure test.
- Money math only through the shared `Money` utility (paise BigInt).
- Migrations are forward-only; never edit an applied migration.
- Conventional commits. Every phase ends with all tests green and
  `docker compose up` working from scratch.

## Definition of done for any feature

types → zod schema → migration → service + tests → endpoint +
OpenAPI → UI → seed/demo data → docs page stub → audit logging

## Decisions log

Append-only. One entry per architectural decision made while building a
phase — what was decided, why, and what it rules out. Keep entries short;
this is a log, not a design doc.

### Phase 0 — scaffold, Docker, CI

- **Global zod validation via `nestjs-zod`, not a hand-rolled pipe.**
  A per-DTO `PipeTransform` can't be registered as a single global pipe
  the way `ValidationPipe` is in a class-validator NestJS app — schemas
  differ per route. `nestjs-zod`'s `createZodDto` + global
  `ZodValidationPipe` gets the "global zod validation pipe" behavior
  the phase spec actually asked for. DTOs must use `.strict()` to get
  the whitelist-unknown-fields behavior CLAUDE.md requires.
- **`@nestjs/config` added even though Phase 0's spec didn't list it.**
  Without it, `.env` is only read by Docker Compose (which injects env
  vars directly); `pnpm dev` outside Docker had no way to load
  `apps/api/.env` at all. `ConfigModule.forRoot({ isGlobal: true })`
  fixes local dev without changing container behavior.
- **`tsconfig.base.json` must not set `"incremental": true`.** It
  silently breaks `nest-cli`'s `start --watch`: the compiler reports
  "Found 0 errors" but never writes `dist/main.js`, and `nest start`
  then crashes with `MODULE_NOT_FOUND`. Root-caused by hand (removed
  the flag, watch mode started working immediately). If a build-speed
  win from incremental compilation is wanted later, apply it only to
  `tsc -p` one-shot build scripts, never to the base config `nest-cli`
  watch mode inherits from.
- **`apps/api/nest-cli.json` sets `"deleteOutDir": false`.** Paired
  with the incremental fix above as a second layer of defense against
  the same watch-mode race (wiping `dist/` on every recompile is a
  known trigger for watchers starting the node process before the
  first write lands). Means stale compiled files can outlive deleted
  source files between full rebuilds — acceptable in dev, irrelevant
  in Docker/CI where the image is built fresh every time.
- **Docker base images pinned by tag (`postgres:16-alpine`, etc.), not
  by sha256 digest**, despite CLAUDE.md's "pinned Docker base images"
  rule. No verified way to confirm real digests without risking a
  fabricated/stale hash in a file meant to gate what actually runs.
  Revisit in Phase 8's security pass once there's a way to pull and
  verify current digests as part of the change, not from memory.
  Dependabot's `docker` ecosystem entry (`/deploy/docker`) is wired up
  so tag bumps at least get proposed automatically in the meantime.
- **LICENSE and CODE_OF_CONDUCT.md are fetched verbatim from their
  canonical sources (gnu.org, contributor-covenant.org), not
  reproduced from memory.** Legal/community-policy text shouldn't risk
  subtle inaccuracies. `CODE_OF_CONDUCT.md` and `SECURITY.md` both
  have `TODO` placeholders for a real contact/disclosure channel —
  left unfilled rather than invented, since "OpenEstate" is a
  placeholder name/org for this project (see the build guide's
  launch-checklist note to verify the name before going public).

### Phase 1 — auth, RBAC, multi-tenancy, masters, custom fields, frontend

- **Three Postgres roles, not one.** `openestate_superuser` (migrations
  only, never in app connection strings), `openestate_system` (BYPASSRLS,
  used by system Prisma client for cross-tenant operations like auth
  lookups), `openestate_app` (RLS-enforced, used by tenant Prisma client
  for all domain operations). Two Prisma clients injected via NestJS DI
  tokens (`TENANT_PRISMA`, `SYSTEM_PRISMA`).
- **RLS via `set_config('app.current_company_id', ...)` + Prisma
  extension**, not middleware. Prisma middleware fires too late for
  `$queryRaw` and can be bypassed by `$executeRaw`. The extension
  approach wraps each tenant transaction with a `SET LOCAL` call.
- **`withTenantTx` scopes a data-access unit of work, not an HTTP
  request.** Wrapping the entire request in one interactive transaction
  would hold a DB connection for the full request lifetime, including
  any I/O to external services. No external I/O (HTTP, SMS, email,
  file storage) inside `withTenantTx`.
- **Refresh tokens: SHA-256 hashed, family-based reuse detection.**
  Raw token in httpOnly cookie, SHA-256 hash in DB. Each token carries
  a `family` UUID; reuse of a revoked token revokes the entire family
  (compromise detection). `isRevoked` boolean, not a `revokedAt`
  datetime — simpler queries, same semantics.
- **httpOnly Secure cookie + double-submit CSRF for both apps/web and
  apps/portal.** Access token in JSON response body (stored in memory,
  not localStorage). CSRF cookie is non-httpOnly so JS can read it
  and send it as `X-CSRF-Token` header.
- **Separate `TOTP_ENCRYPTION_KEY`, not reused from PAN encryption.**
  TOTP secrets encrypted with AES-256-GCM using a dedicated env var.
  If the PAN key is rotated or compromised, TOTP secrets are unaffected
  and vice versa.
- **`admin.user.delete` renamed to `admin.user.deactivate` (soft
  delete, no hard deletes).** Users are deactivated (`isActive = false`),
  never removed from the database. Preserves referential integrity for
  audit logs, bookings, and receipts.
- **Master factory pattern: `createMasterModule(config)` produces a
  NestJS module with ~30 lines of config per table.** 15 of 17 masters
  use the factory; GstRate and TdsRule have specialized services with
  overlapping effective-date validation. The factory returns anonymous
  classes with `Object.defineProperty` to set meaningful names for
  debugging/DI — `private` keyword removed from anonymous class
  properties to avoid TS4094.
- **GstRate stores a single `rate` Decimal + `description` String, not
  separate CGST/SGST/IGST fields.** The CGST/SGST/IGST split is a
  calculation concern (based on inter- vs intra-state), not a storage
  concern. The master rate table stores the total GST rate; the split
  is computed at invoice/receipt generation time.
- **CompanyConfig: single row per company with typed columns, not a
  key-value store.** `labelOverrides` (JSON), `enabledModules` (JSON
  array), `currency`, `timezone`, `fyStartMonth`, `dateFormat`. Avoids
  N+1 queries for config lookups and gives type safety at the DB level.
- **Money as BigInt paise, never floats.** All monetary values stored
  as BigInt paise in the database. Shared `formatInr` helper handles
  lakh/crore digit grouping for display.
- **`@prisma/client` added as direct dependency in `apps/api`.**
  Fixes TS2742 "inferred type cannot be named" errors that occur in
  pnpm monorepos when the Prisma runtime types are only reachable
  through a workspace dependency.
- **Frontend: React 18 + Vite + react-router-dom v7 + TanStack Query
  + react-hook-form + zod.** Auth state managed via React context with
  automatic silent refresh on mount. API client handles transparent
  token refresh (401 → refresh → retry). All admin screens
  (users, roles, masters, custom fields, company config, audit log)
  are permission-gated in the sidebar via `hasPermission` checks.

### Phase 1 verification — Docker, packaging, runtime fixes

- **API runtime image is `node:20-slim` (Debian), not Alpine.** The
  `argon2` native module ships glibc prebuilt binaries but not musl;
  Alpine falls through to node-gyp compilation which requires network
  access to download Node.js headers during `docker build`. Never
  switch back to Alpine without verifying all native deps have musl
  prebuilds.
- **Workspace packages use the `exports` field with dual resolution.**
  `"import": "./src/index.ts"` for Vite/bundlers (direct TS
  consumption, no pre-build needed), `"require": "./dist/index.js"`
  for Node.js runtime (compiled CJS). `"main"` stays at `dist/` for
  backwards compatibility. This means Vite builds don't require
  `pnpm --filter @openestate/shared build` first, but NestJS
  production runtime does.
- **Dockerfiles copy selective source paths, not entire directories.**
  `COPY packages/shared packages/shared` overwrites pnpm's
  `node_modules` symlink tree; copying only `src/`, `tsconfig.json`,
  and `prisma/` individually preserves the install step's layout.
  `.dockerignore` excludes `node_modules` from the build context.
- **API Dockerfile uses `pnpm deploy` for the runtime stage.** Creates
  a self-contained directory with a flat `node_modules` that doesn't
  depend on pnpm's symlink store. The generated Prisma client
  (`.prisma/client/`) must be copied separately into the deployed
  `node_modules` because `pnpm deploy` doesn't include it.
- **Runtime stage must install `openssl`.** `node:20-slim` ships
  without OpenSSL libraries; Prisma's query engine binary
  (`debian-openssl-3.0.x`) links against `libssl.so.3` at runtime.
  Without it, Prisma throws "could not locate the Query Engine."
- **Encryption keys are always `openssl rand -hex 32` (64 hex chars =
  32 bytes).** `TOTP_ENCRYPTION_KEY` and `PAN_ENCRYPTION_KEY` validate
  exact length at startup. `install.sh` uses a separate `rand_hex_32`
  helper; CI's `.env` generation uses `rand -hex 32` for these two
  keys and `rand -hex 24` for passwords/secrets.
- **Health endpoint is `@Public()` by design.** The global JWT auth
  guard blocks unauthenticated requests; the health controller must
  opt out via the `@Public()` decorator so Docker healthchecks and
  load-balancer probes work without a token.

### Phase 2 — inventory (projects, towers, floors, units)

- **Unit rate revisions are append-only with monotonic dating.**
  `effectiveFrom` must be `<= today` and `>= latest existing revision`
  for the same unit. Future-dated revisions are rejected at the service
  layer. `@@unique([unitId, effectiveFrom])` prevents duplicate dates.
  `Unit.baseRatePaise` is the current market rate; booking will snapshot
  `agreedRatePaise` in Phase 3.
- **Unit status state machine with actor type.** Transitions carry
  `actorType: 'user' | 'system'`. Reason is mandatory (not optional)
  for `BLOCKED` and `CANCELLED`. Phase 4 will restrict
  `BOOKED → ALLOTTED → REGISTERED → CANCELLED` to `system`-only
  transitions triggered by booking/payment workflows.
- **Upload category is a whitelisted enum, not freeform.**
  `layout_plan | brochure | photo | document` — validated via zod
  before touching any file path. Storage names are `uuid + ext`,
  never derived from user input. Images are re-encoded through `sharp`.
- **sharp verified inside Docker container.** `sharp` 0.35 with
  `vips` 8.18.3 loads and processes images correctly inside the
  `node:20-slim` runtime container. The `pnpm deploy --prod` step
  in the Dockerfile installs platform-specific optional packages
  (`@img/sharp-linux-x64`, `@img/sharp-libvips-linux-x64`)
  automatically. Verified by creating a 10x10 PNG, reading its
  metadata, and confirming correct output inside `docker run`.

### Phase 2 verification

- **Docker Desktop path on this machine.**
  `C:\Users\Ashis\AppData\Local\Programs\DockerDesktop\resources\bin`.
  Not on PATH in Git Bash or PowerShell by default; invoke via full
  path or prepend to `$env:PATH` at session start. Future sessions
  should use this path rather than assuming `docker` is on PATH.
- **Import enumerates skipped rows, never silently skips.** The
  `ImportResult` type includes `skipped: Array<{ row, unitNumber,
  reason }>` alongside `createdCount`. Callers always see which rows
  were already present and why they were skipped.
- **Tower-scoped unit number uniqueness.** `@@unique([floorId, number])`
  enforces floor-level uniqueness at the DB level. Import and
  bulk-generate also validate that unit numbers are unique within the
  entire tower (cross-floor check), reporting violations as row-level
  errors before the transaction commits.
- **All 10 Phase 2 tables are RLS-protected.** `unit_types`,
  `plc_types`, `projects`, `towers`, `floors`, `units`, `unit_plcs`,
  `unit_charges`, `unit_rate_revisions`, `unit_status_changes` added
  to both the migration's RLS loop and `TENANT_SCOPED_MODELS` in the
  tenant Prisma extension. Integration tests prove cross-tenant
  isolation on `units` and `unit_rate_revisions` specifically.

### Phase 3 — pre-sales: inquiries, assignment, follow-ups, funnel reports

- **Round-robin fairness needed a per-project advisory lock in addition
  to `SELECT ... FOR UPDATE SKIP LOCKED`.** SKIP LOCKED alone guarantees
  *no duplicate picks* under concurrency (two transactions can never lock
  the same pool row), but it does **not** guarantee *fair ordering* under
  a true thundering herd — verified by a failing test (50 concurrent
  claims against a pool of 5 produced a max-min spread of 2, not the
  required ≤1). Root cause: nothing serializes the order in which
  concurrent transactions re-queue a row to the back of the line, so
  independently-correct SKIP LOCKED picks can still converge on an uneven
  distribution. Fix: `pg_advisory_xact_lock(hashtext(project_id))` at the
  top of `AssignmentService.autoAssign` serializes the pick-and-claim
  critical section per project (transaction-scoped, auto-released on
  commit/rollback; different projects never contend). SKIP LOCKED stays
  as the row-picking mechanism inside the now-serialized section — it's
  what still lets a truly-empty-of-contention fast path skip locked rows
  cheaply. Also switched `last_assigned_at` to `TIMESTAMP(6)` (from the
  Prisma default `TIMESTAMP(3)`) and the UPDATE to `clock_timestamp()`
  (statement-execution time, not transaction-start time) to eliminate
  millisecond-tie ordering ambiguity as a contributing factor.
- **Bounded retries, never a 500.** `autoAssign` retries the SKIP LOCKED
  select up to 3 times (short random backoff) only for the case where
  every pool row is momentarily locked by other in-flight claims; if
  still empty after retries, or if the pool has zero active members, it
  returns `null` and the caller leaves the inquiry unassigned rather than
  failing inquiry creation. Lead capture must never be blocked by the
  assignment engine.
- **Consent is an append-only ledger (`ApplicantConsent`), not columns on
  `Applicant`.** Every grant/revoke inserts a new row; current consent is
  the latest row per applicant. Nothing is ever updated or deleted, so
  consent state at any past timestamp is reconstructible by filtering the
  ledger — required for DPDP-style audit questions ("was consent valid
  when we sent this message").
- **Applicant merge reassigns `Inquiry.applicantId` only —
  `CommunicationLog.applicantId` is never rewritten.** A merged
  (tombstoned) applicant's send history keeps pointing at that applicant
  permanently, preserving the original recipient's identity for audit.
  The survivor's timeline still surfaces those rows by joining through
  `Applicant.mergedIntoId` (`WHERE applicantId IN (survivorId, ...ids of
  applicants merged into survivorId)`) rather than by data movement.
  `FollowUp` rows are never touched at all during a merge — they key off
  `inquiryId`, which already moved to the survivor, so no follow-up can
  ever be lost or duplicated by the merge operation itself. Already-merged
  applicants (`mergedIntoId != null`) can't be merged again in either
  direction — the API returns 409 pointing at the current survivor.
- **Phone normalization is intentionally narrow.** Only strips Indian
  country/trunk prefixes (`+91`/`91`/`0`) and only normalizes when the
  result is a 10-digit number starting 6–9 (a valid Indian mobile).
  Anything else — NRI numbers, landlines, malformed input — is stored
  trimmed-but-otherwise-untouched and matched by exact string equality.
  Deliberately does not attempt to be a general international phone
  parser; guessing wrong would silently corrupt or falsely merge
  unrelated contacts, which is worse than not normalizing at all.
- **Per-company escalation dispatch, not a single cross-tenant sweep.**
  `EscalationService.dispatchTick()` uses the SYSTEM client only to
  enumerate active companies (`select: { id: true }` — never touches
  inquiry rows), then enqueues one `company-escalation` BullMQ job per
  company. `runForCompany(companyId)` does all inquiry-row access inside
  `runWithTenant` + `withTenantTx` for that one company, so RLS (not just
  the Prisma tenant-filter extension) is what ultimately restricts
  visibility — proven by a test that runs a raw, filter-less
  `SELECT ... FROM inquiries` inside company A's tenant transaction and
  confirms it cannot see company B's rows even though the query has no
  `WHERE company_id` clause at all.
- **Escalation notifies ALL active `sales_manager` users company-wide,
  not a specific manager.** No project→manager reporting-line field
  exists in the schema yet, so "notify the inquiry's manager" isn't
  expressible. **Revisit this once a project→manager (or user→manager)
  mapping is added** — likely in a later phase alongside team hierarchy
  for the "manager-wise interaction" report, which has the same
  simplification (reports each manager's own logged interactions, not a
  team roll-up).
- **`Inquiry.lastEscalatedAt` prevents re-notifying every tick forever.**
  An inquiry is only (re-)escalated when `lastEscalatedAt IS NULL OR
  lastEscalatedAt < nextFollowupAt` — i.e. once per overdue occurrence.
  If the follow-up date is pushed forward and lapses again later, the new
  `nextFollowupAt` is newer than the old `lastEscalatedAt`, so it
  re-qualifies.
- **`FollowUpType` (not `CommunicationType`) is the follow-up "type"
  master.** `FollowUpType`'s seeded values (Phone Call, Site Visit,
  Email, WhatsApp, Meeting, Video Call) are literally the follow-up
  interaction types; `CommunicationType` is reused instead for the
  outbound send-channel log (`CommunicationLog.channel` is a Postgres
  enum, `EMAIL | SMS`, not yet driven by the `CommunicationType` master —
  channel is a small closed set like `UnitStatus`, not an admin-tunable
  business constant). Site visit is not a separate table — it's a
  `FollowUp` row with `type = 'Site Visit'` and `scheduledAt`/`venue`
  populated; everything else on the row stays generic.
- **BullMQ added for Phase 3** (`bullmq` + `@nestjs/bullmq`), two queues
  (`communication`, `escalation`). The dev `ConsoleCommunicationProvider`
  logs instead of calling a real gateway — swappable via the
  `COMMUNICATION_PROVIDER` DI token when real SMS/email plugins land in
  Phase 7. Enqueueing always happens **outside** any `withTenantTx` (it's
  Redis I/O); the `CommunicationLog` row is created and committed first,
  then the job references its ID.
- **Import auto-links duplicates instead of prompting.** Bulk Excel
  import has no interactive UI to show a duplicate warning, so a
  phone/email match auto-links the row to the existing `Applicant`
  instead of creating a new one; the response enumerates every linked row
  (`linked: [{ row, applicantName, applicantId }]`) alongside
  `createdCount`, mirroring Phase 2's "never silently skip" discipline.
  Interactive single-inquiry creation instead surfaces
  `possibleDuplicateApplicantIds` in the response and lets the caller
  decide, since there a human is present to resolve it.
- **All 10 new Phase 3 tables are RLS-protected**: `applicants`,
  `applicant_consents`, `applicant_merges`, `inquiry_temperatures`,
  `inquiries`, `inquiry_assignments`, `project_assignment_pools`,
  `follow_ups`, `sms_templates`, `communication_logs` — added to both
  the migration's RLS loop and `TENANT_SCOPED_MODELS`. Integration tests
  prove isolation on all ten, with extra emphasis on `applicants` and
  `inquiries` (including a raw, filter-less-query variant per table).
- **Advisory-lock key is `hashtext(projectId)` — a single 32-bit hash,
  so it serializes per project but is not collision-proof.** Two
  *unrelated* projects whose UUIDs happen to collide under `hashtext`
  (birthday-bound: non-negligible only across tens of thousands of
  projects) would serialize against each other — a latency footgun, never
  a correctness bug (assignment stays fair and duplicate-free; two pools
  just occasionally wait on each other). Acceptable now. **Do not
  "optimize" the collision away by widening/among-projects-sharding the
  key without switching to the two-key form
  `pg_advisory_xact_lock(hashtext(companyId), hashtext(projectId))`
  (namespaced, halves collision probability per axis) AND adding a
  saturation test that drives two deliberately hash-colliding project IDs
  concurrently and asserts fairness holds for each independently.** A
  naive single-key change risks reintroducing cross-project head-of-line
  blocking under load without anyone noticing.

### Phase 4 — financial core: bookings, ledger, receipts, GST/TDS, interest, transfer, cancellation

- **The booking balance IS `SUM(ledger_entries.signed_amount_paise)`.**
  There is no stored balance field to drift. Positive = debit (customer
  owes), negative = credit. Every financial event appends immutable rows;
  corrections append negating rows referencing `reversalOfEntryId` — never
  an UPDATE/DELETE. Booking opens by posting the cost breakup as `CHARGE`
  debits (Σ = agreed price). Proven by a fast-check property suite (below).
- **Append-only is enforced at the DATABASE, not just the app.** A trigger
  (`forbid_financial_mutation`) blocks UPDATE/DELETE on `ledger_entries`,
  `receipt_allocations`, `cheque_status_events`, `interest_accruals`,
  `tds_deductions`, `tds_certificates`. A deliberate maintenance escape
  hatch — the transaction-local GUC `app.allow_financial_mutation='on'` —
  lets admin purges and test teardown delete; normal app code never sets
  it. (Because booking→ledger FKs are `ON DELETE CASCADE`, a booking can
  only be hard-deleted under that GUC; in production bookings are cancelled,
  never deleted.)
- **Relation policy: master/config and user FKs are scalar `@db.Uuid`
  columns with DB-level FK constraints, not Prisma relations.** The core
  financial graph (Booking/Installment/LedgerEntry/Receipt/…) uses Prisma
  relations; but `createdById`/`approvedById`, `chargeTypeId`, `gstRateId`,
  `interestRuleId`, etc. are plain scalars whose FKs are added in the
  migration. This keeps `User` and the master models from accumulating
  ~30 back-relations. Trade-off: no `include:` for those links (look them
  up by id) — fine for provenance fields.
- **GST place of supply = the PROPERTY location, snapshotted at booking
  (`Booking.placeOfSupplyStateCode`), immutable after.** IGST Act §12(3)(a):
  services in relation to immovable property are supplied where the property
  is — NOT the customer's residential state. Defaulted from the project's
  area-location `stateCode`, overridable only at creation. Intra-state
  (supplier `CompanyConfig.gstStateCode` == place of supply) → CGST+SGST;
  else → IGST. A code comment cites §12(3)(a) so nobody "fixes" it to follow
  the applicant's address.
- **CGST/SGST rounding: the halves are equal by construction, so
  `(CGST + SGST)` may differ from `IGST` by ≤1 paise per line.**
  `cgst = sgst = roundHalfUp(base·rate/2)`, `igst = roundHalfUp(base·rate)`,
  all BigInt. A test matrix asserts `|IGST − (CGST+SGST)| ≤ 1` across bases
  and rates. GST rates are snapshotted per cost line (and per `ExtraCharge`,
  captured from the linked ChargeType's effective rate at entry) — re-pricing
  a rate master never changes an existing booking.
- **TDS (194-IA) leaves no dangling receivable.** A receipt credits the
  GROSS installment amount and, in the SAME transaction, posts a
  `TDS_RECEIVABLE` debit for the withheld portion — so the booking balance
  keeps showing the TDS as outstanding until a certificate is recorded, at
  which point a `TDS_CERT_ADJUSTMENT` credit zeroes it. Certificate receipt
  is a separate append-only `TdsCertificate` row (not a mutable flag).
  Sub-threshold bookings (agreed price < effective threshold) post no TDS
  receivable and reject any TDS-deducted receipt.
- **Refund is a two-phase ledger event.** `REFUND_APPROVED` (debit) posts
  when the refund is approved — the obligation is recognised in the customer
  sub-ledger then, moving the balance toward zero. Payment records a
  `PaymentVoucher` (cash outflow) and posts NO further ledger entry (that
  would double-count the obligation). A refund cheque that bounces re-opens
  the obligation with a `REFUND_BOUNCE_REVERSAL` credit + a `BOUNCE_CHARGE`
  debit — exactly like a receipt cheque bounce. The sub-ledger tracks
  obligations; the voucher tracks settlement.
- **Installment freeze has one source of truth: `allocatedPaise > 0`.**
  There is no `isFrozen` column. A plan edit regenerates only strictly-unpaid
  installments (deleting them — they carry no ledger impact) and requires the
  new ones to cover exactly the residual (agreed price − Σ frozen amounts),
  so the schedule always still sums to the agreed price. Paid/part-paid
  installments are never touched.
- **Cancellation drives the balance to exactly `−refundable`.**
  `refundable = netReceived − deduction` where `netReceived` is cash actually
  collected (non-reversed, cleared/immediate receipts minus TDS) and the
  deduction comes from a `CancellationRule` master (PERCENT/FLAT, optional
  booking-amount forfeit), snapshotted. Two typed entries post:
  `CANCELLATION_DEDUCTION` (the company-retained levy) and
  `CANCELLATION_SETTLEMENT` = `−refundable − currentBalance − deduction`
  (drives the balance to `−refundable` regardless of what the balance
  contained). Emits the typed `bookingCancelled` event for Phase 5's
  commission clawback (no commission logic yet — stable contract only).
- **Transfer conserves total money via a carry pair.** The old booking is
  closed with `TRANSFER_CARRY_OUT` = `−balance` (→ 0); the new booking opens
  with `TRANSFER_CARRY_IN` = `+balance`. `Σ balances excluding company levies`
  (`TRANSFER_FEE`, `CANCELLATION_DEDUCTION`, `BOUNCE_CHARGE` — enumerated in
  `COMPANY_LEVY_ENTRY_TYPES`) is invariant across the transfer. UNIT transfer
  releases the old unit (→ AVAILABLE) and books the new one; APPLICANT
  transfer keeps the same booked unit. All unit moves are system-only.
- **Booking-lifecycle unit statuses are now SYSTEM-ONLY** (implements the
  Phase 2 note). `BOOKED/ALLOTTED/REGISTERED/CANCELLED` can be reached only
  via `BookingService` (actorType `'system'`); the manual
  `POST /units/:id/transition` (actorType `'user'`) rejects them and handles
  only holds/blocks. Enforced in `UnitStateMachineService` via
  `isSystemOnlyTarget`.
- **Gap-free receipt/booking numbers via an in-transaction upsert-allocator.**
  `NumberSequence(company, kind, scope)` is incremented with a single
  `INSERT … ON CONFLICT DO UPDATE … RETURNING` inside the same transaction as
  the row it numbers, so a rolled-back transaction releases its number and
  committed numbers stay strictly contiguous per (company, FY). **The
  number-allocating transaction must do no external I/O (email/SMS/PDF/S3)
  before commit** — it holds the sequence row lock; same rule as
  `withTenantTx`. Documented on the service.
- **Interest accrual: per-installment cursor, declining balance, idempotent.**
  Each run advances a cursor from the installment's due date (or the last
  accrual's `periodEnd`) to `asOf`, accruing on the current outstanding for
  the window's days — so a partial payment lowers the principal for future
  windows. SIMPLE = `outstanding·rate·days/365`; COMPOUND adds prior accrued
  interest to the base (interest-on-interest at the run cadence). Re-running
  at the same `asOf` posts nothing (cursor already there). Waivers are
  audited `INTEREST_WAIVER` credits (never edit the accrual). Time comes from
  the injected `Clock`, so tests drive it against hand-computed fixtures. The
  daily job dispatches per-company (system client enumerates companies; each
  company accrues inside its own tenant transaction), mirroring Phase 3
  escalation.
- **Money is BigInt-exact.** `percentOf` uses integer basis points
  (`(paise·bps + 5000)/10000`, half-up); `multiplyPaise` now takes an integer
  factor (the old `number`-based version was lossy above 2^53 paise);
  `allocate` uses the largest-remainder method so distributed shares always
  sum to the total with no last-cent loss (property-tested, 2000 runs).
- **Property-based ledger test (`fast-check`).** Random sequences of
  receipts / receipt reversals / extra charges / interest waivers assert,
  after every step: `service balance === reference model balance`, the ledger
  entry count never decreases (append-only), and Σ allocations === receipt
  gross. `numRuns` = CI default 2000, local dev 500, overridable via
  `PROPERTY_NUM_RUNS`; a sub-2000 run under CI without an explicit override
  fails loudly. Reproduce a failure by pinning `FC_SEED`.
- **`AreaLocation.stateCode` and payment-plan template milestones added.**
  Area locations carry a GST state code (property-location default for place
  of supply). `PaymentPlanMilestone` gives templates their percent/offset
  lines, instantiated per booking into an `Installment` schedule via
  `allocate` (no rounding loss).
- **Ledger property test: nightly-2000 / PR-500 split, not CI-matrix
  sharding.** At the CI floor of 2000 runs the property test alone takes
  ~6 minutes (each run creates a booking, plan, and several ledger-affecting
  operations against real Postgres). Chose a time-based split over
  sharding across parallel matrix jobs: `.github/workflows/ci.yml` now has
  a `schedule: cron "0 3 * * *"` trigger, and the `integration-tests` job
  sets `PROPERTY_NUM_RUNS=2000` only when `github.event_name == 'schedule'`,
  else `500`. Every PR/push still exercises the invariant meaningfully
  (500 runs, ~1.5 min) without paying the full 6-minute cost on every push;
  the full 2000-run floor still runs unattended every night. Rejected
  4-way matrix sharding (400–500/shard) because it would 4x the runner
  minutes for the SAME total coverage per run (sharding parallelizes wall
  time, not cost) and adds shard-partitioning complexity to fast-check's
  seed/skip mechanics for no correctness benefit over the simpler
  time-based split. The existing `PROPERTY_NUM_RUNS` env override and its
  sub-2000-under-CI-without-override guard (in
  `apps/api/test/postsales-property.test.ts`) needed no changes — CI now
  always sets the var explicitly, so the guard's "no override" branch never
  fires there; it still protects a stray local `CI=true` run.

### Phase 4-UI — PDF/letters, dispatch, booking/receipt UI, reports

- **PDF library: `pdfmake`, not `@react-pdf/renderer`.** Table-heavy,
  mostly-static documents (receipts, statements, demand letters) map
  directly onto pdfmake's declarative `docDefinition` (content arrays,
  `table`/`columns` layout primitives) without needing JSX/React just to
  describe a page. `@react-pdf/renderer` earns its keep for
  component-composition-heavy documents; none of Phase 4's five document
  types need that. Stays consistent: every generated PDF (receipt,
  statement, allotment/demand/reminder letter) goes through the single
  `PdfService.render(docDefinition)` in `apps/api/src/pdf/pdf.service.ts`.
- **pdfmake's Node `PdfPrinter` needed its real constructor args, not the
  1-arg call that "worked" until first render.** `require('pdfmake/js/Printer')`
  has no published types (`@types/pdfmake` only types the browser bundle),
  so the initial ambient `.d.ts` was hand-guessed from usage patterns found
  online — wrong on two counts, both root-caused by reading
  `pdfmake@0.3.11/js/Printer.js` directly: (1) `createPdfKitDocument` is
  `async` (it internally awaits `resolveUrls()`), so callers must `await`
  it rather than treating the return value as a stream; (2) `resolveUrls()`
  unconditionally calls `this.urlResolver.resolve(...)` for every font
  variant, so a `new PdfPrinter(fonts)` call with only the first of 4
  constructor params leaves `urlResolver` undefined and crashes on the
  first render. Fixed by passing pdfmake's own shipped
  `pdfmake/js/URLResolver` + `pdfmake/js/virtual-fs` (they only do real
  network I/O for `http(s)://` URLs — a no-op for our local font paths and
  fully-local template content) as the 2nd–3rd constructor args, and
  correcting the ambient `.d.ts` to match. `apps/api/test/postsales-pdf.test.ts`
  is DB-independent (pure `docDefinition → Buffer`) specifically so this
  class of bug gets caught by the fast, always-run test tier, not only by
  a slower integration test that happens to exercise PDF generation.
- **"Never regenerated on read" applies per document type, not globally.**
  RECEIPT PDFs are idempotent-lookup-or-create (`DocumentService.generateReceiptPdf`
  reuses the stored artifact); a reprint is a **new**, separately-stored,
  watermarked (`DUPLICATE`) artifact via `reprintReceiptPdf`, never an
  overwrite. STATEMENT and the three letter types are always-fresh-snapshot
  (`generateStatementPdf`/`generateLetterPdf` always render+store a new
  row) because their content (running balance, current dues) is only
  correct as of generation time — treating them as idempotent would let a
  stale statement silently keep being served.
- **Merge-field registry (`packages/shared/src/documents.ts`) fails at
  test-time, not render-time.** `MERGE_FIELD_REGISTRY` is the single
  source of truth per `GeneratedDocumentType`; `validateTemplateMergeFields`
  walks a template body for `{{token}}` placeholders and throws on any
  token not in that type's registry entry — callable from a master-data
  admin screen or a unit test on template content, without needing a real
  booking/applicant to render against.
- **Dispatch rows reuse the append-only *discipline*, not the DB-level
  append-only *trigger*.** Unlike `ledger_entries` et al.,
  `document_dispatches` has no `forbid_financial_mutation`-style trigger —
  `DispatchProcessor` legitimately `UPDATE`s a row's status QUEUED→SENT|FAILED.
  What's append-only is the retry path: `DispatchService.retry()` always
  inserts a **new** row with `attemptOfDispatchId` pointing at the original
  rather than resetting the original back to QUEUED, so the full attempt
  history stays visible. Enforced at the service layer (a FAILED-only
  guard raises `ConflictException` otherwise), not the database.
- **Postsales reports use `SYSTEM_PRISMA` (RLS-bypassing), same as the
  Phase 3 reports module — sales_exec role-scoping is a service-level
  filter (`ReportScope.scopeToCreatedById`), not RLS.** RLS still draws the
  hard company-tenant boundary (every report query includes an explicit
  `companyId` filter); scoping *within* one company by who created the
  booking is a business rule about visibility, not tenant isolation, and
  belongs at the service layer where the ownership semantics actually
  live. `postsales-reports.test.ts` proves both layers independently: a
  cross-exec fetch is filtered out of list endpoints and 404s on direct
  fetch-by-id.
- **CSV export streams via chunked transfer encoding by construction, not
  by a special code path.** `streamCsv` (`apps/api/src/reports/csv-stream.util.ts`)
  never sets `Content-Length` and writes each row with its own `res.write()`
  call — Node's HTTP layer emits `Transfer-Encoding: chunked` automatically
  once those two conditions hold, so there's no separate "streaming mode"
  to fall out of sync with the buffered path. Verified against a real
  `http.Server` (not a mocked `res`) in `postsales-reports.test.ts`,
  asserting the actual response headers rather than the util's internal
  call pattern.

### Phase 5 — brokers and commissions

- **`Booking.brokerId` is a new nullable scalar column on the frozen
  `Booking` table (Decision A), not a separate join table.** Mirrors
  `Booking.interestRuleId`'s existing shape exactly (Phase 4: nullable
  scalar FK to an optional master, no Prisma relation, populated by a
  controller-layer call after the booking exists — `BookingService.createBooking`
  itself never writes it). Chosen over a `BrokerBookingSourcing` join table
  because it's the shape `BookingCancelledEvent`'s own doc comment already
  anticipated ("Broker attribution is added in Phase 5 when bookings carry
  a `brokerId`") and keeps every broker-attribution query a single join.
  Populated via `POST /bookings/:id/broker` (new, on the unfrozen
  `BookingController`), the same two-step pattern as
  `POST /bookings/:id/plan/from-template`.
- **First-ever PAN encryption service, scoped to `Broker` only.**
  `Applicant.panCiphertext`/`panMasked`/`panKeyVersion` have existed since
  Phase 4 but no encryption service was ever built for them — the columns
  are, and remain, always null. `PanEncryptionService`
  (`apps/api/src/common/pan-encryption.service.ts`) is modeled directly on
  `TotpService`'s identical AES-256-GCM implementation
  (`apps/api/src/auth/totp.service.ts`) and keyed on the already-declared
  `PAN_ENCRYPTION_KEY` env var, but wired only to the new
  `Broker.panCiphertext` — retrofitting `Applicant` is `docs/todo.md`, not
  silent scope creep. Reads the key directly from `process.env` rather
  than Nest's `ConfigService`, deliberately: every Phase 4/5 service in
  this codebase is constructed directly in integration tests
  (`new XxxService(...)`, no DI container), and this keeps
  `PanEncryptionService` constructible the same zero-argument way.
- **Commission slab matching: half-open `[fromPaise, toPaise)`, matched
  (not marginal).** A value landing exactly on a boundary always matches
  the HIGHER bracket — one rule, applied uniformly, rather than a
  case-by-case "which bracket owns the boundary" judgment call. The whole
  basis amount is charged at ONE matched slab's rate (real-estate
  brokerage convention), never split across brackets like income tax.
  Slabs must be contiguous and gapless with exactly one unbounded
  (`toPaise = null`) top slab — validated at rule-save time
  (`validateSlabContiguity`, `packages/shared/src/commission.ts`), not a
  DB constraint, so the rejection message can name the exact gap.
- **`BrokerBookingCommission` snapshots the total commission ONCE per
  booking, at first accrual — never re-read from the rule after.** Chosen
  over the two alternatives considered (a second column on `Booking`, or a
  field on the first ledger entry): a dedicated table avoids a *second*
  migration touch to the frozen `Booking` table beyond the
  already-approved `brokerId`, and avoids conflating a ledger row's
  `signedAmountPaise` (a movement) with an unrelated "total basis" fact.
  This is *why* `BrokerCommissionRule`/`BrokerCommissionSlab` deliberately
  have **no effective-dating** (unlike `GstRate`/`TdsRule`) — a rule edit
  applies to future accruals only because the snapshot already protects
  every in-flight booking's math from it; effective-dating would solve a
  problem the snapshot solves more directly. Milestone breakpoints
  (`BrokerCommissionRule.milestonesJson`) are read live at each accrual
  call, not frozen — editing the breakpoint list mid-stream is a
  deliberate, benign exception to the "never re-read the rule" rule, since
  only the dollar-amount computation needed freezing.
- **`CommissionPayment` is a `REQUESTED → APPROVED → PAID | REJECTED`
  state machine (mirrors `RefundStatus`'s shape), but ledger entries post
  ONLY at `pay()`, not at `approve()` — the opposite of `RefundService`.**
  A refund's obligation is *newly recognized* at approval (nothing in the
  customer ledger reflected it before); a broker's commission was already
  accrued earlier via `CommissionService.accrueForBooking`, so
  `request()`/`approve()` on a payment are pure dispute/authorization
  sign-off with no ledger effect — the ledger only moves when cash
  actually leaves, which is also the only point TDS can be withheld
  (there's nothing to withhold from a payment that hasn't happened yet).
  Three permissions, not two: `ACCOUNTS_COMMISSION_CREATE` ≠
  `ACCOUNTS_COMMISSION_APPROVE` ≠ `ACCOUNTS_COMMISSION_PAY`, matching the
  refund dual-control precedent.
- **Commission TDS (194-H) is a settled deduction, final at `pay()` — no
  receivable, no certificate step. This is the OPPOSITE shape from 194-IA
  on the customer side, and it's a real asymmetry, not an oversight.**
  For 194-IA (`ReceiptService`, frozen — not touched by this phase), the
  **company is the deductee**: a buyer withholds tax *from* the company,
  so the company is owed a certificate (Form 16B) before it can claim
  credit — hence `TDS_RECEIVABLE` stays outstanding until a
  `TdsCertificate` zeroes it via `TDS_CERT_ADJUSTMENT`. For 194-H, the
  **company is the deductor**: it withholds tax *from the broker* and
  later files its own return and issues Form 16A *to* the broker: from
  the broker's ledger (`CommissionLedgerEntry`), there is nothing to
  receive or certify — the moment `pay()` runs, gross minus TDS is a
  completed, known fact, hence `TDS_WITHHELD` (not `TDS_RECEIVABLE`).
  Also unlike 194-IA's client-supplied `dto.tdsDeductedPaise` (the buyer
  self-reports what they withheld), 194-H's amount is **server-computed**
  (`percentOf(amountPaise, rule.ratePercent)` against a `TdsRule` where
  `section = '194-H'`) — the company controls the payment, so it computes
  its own deduction. This paragraph is intentionally duplicated as a code
  comment on `CommissionPaymentService.pay()`, so a maintainer who only
  ever reads `ReceiptService`'s TDS code still finds out why the two
  treatments differ.
- **A `CommissionPayment` can settle accrual across several bookings at
  once (a broker paid periodically), so `pay()` allocates the gross amount
  oldest-outstanding-booking-first** (same idea as the receipt-entry UI's
  oldest-dues-first allocation) **and splits TDS proportionally across
  those per-booking allocations via `allocate`** (largest-remainder — no
  last-paise loss), posting one `PAYMENT` + `TDS_WITHHELD` pair per
  affected booking. This was tightened during implementation: an initial
  version attributed the whole payment to "the broker's single
  most-recently-accrued booking," which silently corrupted
  `handleBookingCancelled`'s per-booking outstanding calculation for any
  broker paid across more than one booking in a single `CommissionPayment`
  — caught by hand-tracing the numbers before writing the reconciliation
  test, not by the test itself.
- **Clawback on cancellation always reverses whatever's still
  unpaid-accrued for the booking FIRST, then separately handles whatever
  was already disbursed per the `commissionClawbackPolicy` — two
  independent steps, not one branch on the booking's current sign.** The
  plan approved before implementation branched on
  `outstandingForBooking`'s sign alone (`> 0` → reverse; `<= 0` → apply
  policy), which is correct for the two cases it was worked through by
  hand (fully unpaid, or fully paid) but silently under-claws-back any
  **partially paid** booking — the exact scenario the required
  reconciliation test (`accrue → partial pay → cancel`) exercises: if
  ₹57,000 of a ₹100,000 accrual was already disbursed and ₹40,000 is still
  outstanding-unpaid, the sign-based branch would reverse the ₹40,000 and
  stop, leaving the broker holding the ₹57,000 already paid even under
  `RECOVER` policy. Corrected to: (1) if `outstandingForBooking != 0`,
  always post `CLAWBACK_REVERSAL = -outstandingForBooking` (unearned
  commission is never owed after cancellation, regardless of policy); (2)
  if anything was actually disbursed (`netPaid > 0`, computed as
  `-SUM(PAYMENT entries)` for that booking), separately post either
  `CLAWBACK_RECOVERY = -netPaid` (`RECOVER`) or a **zero-amount**
  `CLAWBACK_WRITEOFF` with a mandatory `reason` (`WRITE_OFF` — a pure
  audit marker; the money stays with the broker, nothing is posted to
  move it). `CLAWBACK_WRITEOFF` with no `reason` is rejected at the
  service level — a zero-amount entry with no explanation is
  indistinguishable from a bug.
- **Transactional atomicity between NOC-gating, the frozen
  `CancellationService.cancel()`, and `CommissionService.handleBookingCancelled()`
  needs zero changes to any frozen service.** `withTenantTx`
  (`packages/db/src/tenant.extension.ts`) already detects, via
  `AsyncLocalStorage`, when it's called while an outer `withTenantTx` for
  the *same* `companyId` is already open, and reuses that transaction
  instead of opening a new one. `BookingController.cancel()` (commit 2)
  wraps NOC-gating + the cancellation call + the clawback call in one
  outer `withTenantTx`; because `CancellationService.cancel()` and
  `CommissionService.handleBookingCancelled()` both open their own
  `withTenantTx` internally with the same `companyId`, they transparently
  join the controller's transaction — if clawback throws, the
  cancellation (including its unit-status transition) rolls back too.
  This mechanism already existed for Phase 4; Phase 5 is its first
  cross-service consumer.
- **Three real bugs were caught only by the manual browser click-through
  before commit 3, not by any automated test** — recorded here because
  they reveal a real gap in the test suite's shape, not just three
  one-off typos. (1) `POST /bookings/:id/commission/accrue` — the plan's
  own required endpoint — was never actually wired to a controller route;
  `CommissionService.accrueForBooking` existed and was unit/integration
  tested via direct calls, but nothing exercised it through HTTP, so a
  missing route slipped past every test. Fixed by adding the endpoint
  (mirrors `POST :id/interest/accrue`); regression-tested by calling
  `BookingController.accrueCommission()` directly (`noc-cancellation.test.ts`),
  which is the same "construct the controller, call the method" pattern
  used everywhere else in this codebase for controller tests — a
  reminder that this pattern verifies a route *handler* works, not that
  the route is *registered*; only manual/e2e HTTP calls or a live server
  catch a missing `@Post()`. (2) `BrokerReportsController.soldUnits`
  400'd on `?brokerId=` — mixing a whole-object `@Query() dto` bound to
  `.strict()` `reportDateRangeSchema` with a same-endpoint
  `@Query('brokerId')` fails Zod's unrecognized-key check, because both
  decorators validate against the SAME incoming query object. Fixed by
  extending the schema (`soldUnitsQuerySchema`, exported from the
  controller) instead of layering a second `@Query()` binding.
  Regression-tested at the schema level (`commission-pure.test.ts`) —
  deliberately NOT by calling the controller method directly, since
  Nest's `ZodValidationPipe` runs before the method body and calling the
  method directly bypasses it entirely, so only a schema-level
  `.safeParse()` test (or a real HTTP round trip) actually reproduces
  this bug. (3) `BrokerDetail.tsx`'s "Pay" button 400'd — `useApiMutation`
  JSON-stringifies its whole `TBody` as the POST body, but `pay()`'s DTO
  (`payCommissionPaymentSchema`) is `.strict()` and has no `id` field
  (`id` is a URL param, not a body field); the existing `{id, ...}`-body
  convention this hook uses elsewhere works only because those other
  endpoints (`approve()`, `deactivate()`, etc.) have no `@Body()` DTO at
  all, so the extra `id` key is silently ignored rather than rejected.
  Fixed by calling `api()` directly for `pay()` with a body that omits
  `id`, rather than changing the shared hook's contract (which other
  pages rely on as-is). No frontend test suite exists in this repo to
  regression-test against, so this class of bug — a strict backend DTO
  vs. a generic frontend body-shape assumption — remains something only
  the manual click-through step catches; noted here rather than silently
  patched. **General lesson for future phases:** a new HTTP endpoint or
  query/body shape needs at least one test that goes through the actual
  validation pipe (an HTTP-level test, or a schema-level `.safeParse()`
  test) — a controller-method-direct-call test alone proves the handler
  logic is right but not that the route exists or that the DTO accepts
  what the frontend actually sends.
