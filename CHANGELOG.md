# Changelog

All notable changes to OpenEstate are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

Found by a full production-readiness pass — driving a freshly-installed
native deployment through real HTTP calls across every module with
realistic demo data, not by review:

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
- `deploy/native/install-native.sh` (and every other native deploy
  script an admin is documented to run directly — `upgrade-native.sh`,
  `backup-native.sh`, `restore-native.sh`, `uninstall.sh`,
  `setup-database.sh`) was git-tracked without the executable bit.
  A genuinely fresh `git clone` followed by the documented `sudo
  ./install-native.sh` failed immediately with "Permission denied"
  (exit 126) trying to exec `setup-database.sh`. Never caught by hand
  verification because that checkout had a local, uncommitted `chmod
  +x`. Now tracked as mode `755`; the `native-install` CI job invokes
  the script exactly as documented (no `bash` prefix) so this class of
  regression fails CI instead of being silently bypassed.
- `install-native.sh`/`upgrade-native.sh`'s database migration step
  failed on any host where the git checkout lives under a directory
  tree the `postgres` OS user can't traverse (e.g. GitHub Actions
  runners: `/home/runner` is mode `0750`) — Prisma 6.19+ auto-discovers
  a `prisma.config.*` file in the current working directory before
  running any command, and that lookup's `lstat()` fails `EACCES` (not
  `ENOENT`) in that case, which Prisma treats as a hard failure rather
  than "no config file, proceed." `run_as_superuser()` now runs from
  the already-world-traversable `RELEASE_DIR` instead of the checkout.
- `CustomFieldDefinition.defaultValue` — accepted by the create/update
  schema since it was written, but no backing column ever existed, so
  any real caller sending it 500'd. Added the missing column.
- `POST /users` never returned the `phone` it had just saved — a
  `select` allowlist copy/paste gap (present in `update()`, missing
  from `create()`) left an admin with no way to confirm the phone
  number was stored.

The latter two found by a new through-the-wire creation test for every
master type and admin-creatable entity (users, roles, custom fields) —
the existing suite seeded rows directly, which is exactly why these
and the bugs above survived to a tagged release.

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
