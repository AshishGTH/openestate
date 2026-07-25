# Changelog

All notable changes to OpenEstate are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
