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
