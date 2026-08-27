---
id: asvs-checklist
title: OWASP ASVS L2 Self-Assessment
sidebar_position: 1
---

# OWASP ASVS L2 Self-Assessment

A self-assessment against the [OWASP Application Security Verification
Standard](https://owasp.org/www-project-application-security-verification-standard/)
Level 2, written and maintained by the project itself (not an independent
audit — see [Scope and honesty](#scope-and-honesty) below). Each control is
marked **Implemented**, **Partial**, or **N/A**, with a pointer to the
actual mechanism. This is synthesis of the architectural decisions already
recorded in `CLAUDE.md`'s Decisions log across every phase, not new design
work — read that file for the full reasoning behind any entry here.

## V1 — Architecture, Design and Threat Modeling

- **V1.2 Authentication architecture** — Implemented. Self-hosted JWT
  (short-lived access + rotating refresh tokens with reuse detection),
  argon2id password hashing, TOTP 2FA. Separate, narrower auth flow for
  portal users (customer/broker) vs staff. `apps/api/src/auth/`,
  `apps/api/src/portal-auth/`.
- **V1.4 Access control architecture** — Implemented. RBAC (permissions
  checked in guards) **and** Postgres row-level security as an independent
  second layer — CLAUDE.md's non-negotiable rule #4. RLS is the *primary*
  defense for portal (customer/broker) principals specifically, since that
  is the first genuinely untrusted-client boundary in this codebase (see
  the [threat model](./threat-model.md)'s Portal section).
- **V1.5 Input/output architecture** — Implemented. Every DTO is a `.strict()`
  zod schema (`nestjs-zod` + a global `ZodValidationPipe`), rejecting
  unknown fields, not just validating known ones.
- **V1.9 Communications architecture** — Implemented for the plugin/webhook
  surface specifically: `ScopedHttpClient`'s resolve-then-pin SSRF guard
  (`apps/api/src/plugins/`) and HMAC-signed, replay-protected webhook
  delivery (`packages/shared` webhook-signing — see Phase 7 commit 2
  decisions for its exact home). General outbound comms (SMS/email) are
  provider-abstracted (`CommunicationProvider`) with no built-in provider
  shipped yet — dev builds log to console only.
- **V1.11 Business logic architecture** — Implemented for the financial
  core specifically: ledger entries are immutable (DB trigger, not just
  app-level discipline — see V14 below), and money is BigInt paise
  end-to-end, never floating point.

## V2 — Authentication

- **V2.1 Password security** — Implemented. argon2id hashing
  (`apps/api/src/auth/`), no maximum-length truncation, no composition
  rules beyond a minimum length (avoids the well-documented pitfalls of
  forced complexity rules). Account lockout with exponential backoff
  after repeated failed logins.
- **V2.2 General authenticator security** — Implemented for the credential
  most likely to be attacked in the open: this phase replaced the
  seed script's hardcoded initial admin password
  (`admin@demo-realty.com`/`Admin@123`, shipped identically to every
  self-hosted install) with a randomly generated one, printed once
  (`packages/db/prisma/seed.ts`).
- **V2.5 Credential recovery** — Implemented. Password reset via a
  single-use, time-limited token dispatched through the async queue
  (`BullMQ`) — never a synchronous email-send in the request path.
- **V2.8 One-time verifier (2FA)** — Implemented. TOTP (RFC 6238),
  encrypted-at-rest secret (`TOTP_ENCRYPTION_KEY`, AES-256-GCM, its own
  key — never reused from PAN's, Phase 1 decision).

## V3 — Session Management

- **V3.2 Session binding** — Implemented. Refresh tokens are SHA-256
  hashed at rest (raw token never stored), family-scoped for reuse
  detection — a replayed, already-rotated token revokes the entire
  family, not just itself.
- **V3.3 Session logout and timeout** — Implemented. Logout revokes
  server-side (not just client-side token deletion); access tokens are
  short-lived (15m default) specifically so a stolen access token alone
  has a small blast-radius window.
- **V3.4 Cookie-based session management** — Implemented. httpOnly, Secure
  cookies for refresh tokens; double-submit CSRF cookie is the one
  non-httpOnly cookie, by design, so JS can read and echo it as a header.

## V4 — Access Control

- **V4.1 General access control design** — Implemented, fail-closed by
  construction in two independent places, not just convention: RLS
  policies (deny by default, `RESTRICTIVE` policies additively narrow —
  never widen — visibility) and `PermissionsGuard` checking an explicit
  allowlist per route.
- **V4.2 Operation-level access control** — Implemented for the portal's
  specific IDOR risk: `PORTAL_SCOPED_MODELS`' JS-level guard only mirrors
  RLS predicates that are a single direct-column equality — anything with
  a subquery/`EXISTS`/multi-hop branch is deliberately excluded from that
  mirror (a real bug, `Booking`/`GeneratedDocument`, was caught and fixed
  this way in Phase 6 commit 2 — see that entry for the full story of why
  a *partial* JS mirror is worse than none).
- **V4.3 Other access control considerations** — Implemented: a runtime
  guardrail (`runWithTenant`'s same-company portal-scope-drop check,
  `packages/db/src/tenant-context.ts`) makes the exact bug class that
  caused a real fail-open IDOR in Phase 6 (`NocService`'s bare
  `runWithTenant({companyId})` silently shadowing an ambient portal scope)
  structurally impossible to reintroduce silently — it throws instead.

## V5 — Validation, Sanitization and Encoding

- **V5.1 Input validation** — Implemented. Every endpoint: zod DTO,
  whitelist not blacklist, `.strict()`. Parameterized queries only
  (Prisma); any raw SQL requires an inline comment justifying it and uses
  parameter binding — grep `$queryRawUnsafe`/`$executeRawUnsafe` in
  `apps/api/src` to audit every instance directly.
- **V5.2 Sanitization and sandboxing** — Implemented for the plugin
  surface specifically (the one place this codebase executes
  less-trusted-than-core code): package-boundary isolation (no
  `@openestate/db` import path from plugin code at all), a capability-gated
  `Proxy` context, and the SSRF-hardened `ScopedHttpClient`. See the
  [threat model](./threat-model.md)'s Plugins section for the honest
  limit (no worker-thread isolation against a deliberately malicious
  first-party plugin).
- **V5.3 Output encoding and injection prevention** — Implemented via
  framework defaults (React/Vite escape by default; no `dangerouslySetInnerHTML`
  usage in staff/portal frontends) plus `helmet` security headers
  (CSP, `X-Content-Type-Options`, etc.) on every response.

## V7 — Error Handling and Logging

- **V7.1 Log content** — Implemented. Structured logging (`pino`) with an
  explicit redaction list (`apps/api/src/common/logger/redaction.ts`) —
  PAN, passwords, tokens, and (this phase) plugin/webhook secret paths
  are redacted before a log line is ever emitted, not after.
- **V7.4 Error handling** — Implemented. Nest's global exception handling
  returns structured, non-leaking error responses; stack traces never
  reach the client in production (`NODE_ENV=production` gates verbose
  error output).

## V8 — Data Protection

- **V8.1 General data protection** — Implemented for the two PII classes
  this codebase specifically handles: PAN (AES-256-GCM at rest, masked in
  list views/logs — as of this phase, both `Broker.pan*` **and**
  `Applicant.pan*`, closing a retrofit gap open since Phase 5) and phone
  numbers (masked in list views). Aadhaar numbers are never collected at
  all, by explicit design rule.
- **V8.3 Sensitive private data** — Implemented for encryption-at-rest key
  hygiene specifically: PAN, TOTP, and plugin-secret encryption each use
  their **own** key (never reused across domains — Phase 1's stated
  reasoning: rotating or compromising one must not affect another).
  Key rotation is a real, wired-up runbook for plugin secrets
  (`apps/api/scripts/rotate-plugin-secrets.ts`) — **Partial** for PAN
  specifically: `panKeyVersion` exists on the column but rotation was
  never wired up for it (a known, honestly-documented gap since Phase 4).

## V9 — Communications

- **V9.1 Client communications security** — **Partial, honestly scoped**:
  the native install's own nginx config (`deploy/native/nginx/`)
  deliberately does NOT terminate TLS out of the box — its own doc
  comment tells the self-hoster to put a real TLS-terminating proxy in
  front for production use, rather than this project managing
  ACME/Let's Encrypt for every possible domain setup. `req.secure`
  correctly reflects the real client-facing scheme via `X-Forwarded-Proto`
  once that proxy is in place (see CLAUDE.md's "Secure cookies over
  plain HTTP" walkthrough entry for the bug this fixed and why
  `NODE_ENV === 'production'` was never a safe proxy for "this
  connection is HTTPS"). No built-in HSTS-preload guidance yet —
  documented as a gap, not silently assumed solved.

## V11 — Business Logic

- **V11.1 Business logic security** — Implemented for the two areas with
  the highest fraud/correctness stakes: the financial ledger (append-only,
  DB-trigger-enforced, property-tested against 500+ random operation
  sequences per CI run) and round-robin lead assignment (advisory-lock
  serialized, SKIP LOCKED, proven fair under concurrency by a dedicated
  test). See CLAUDE.md's Phase 3 and Phase 4 decisions for the concurrency
  bugs these caught during development.

## V12 — Files and Resources

- **V12.1 File upload** — Implemented. Extension + MIME + magic-byte
  validation, size caps, randomized storage names (never derived from
  user input), images re-encoded through `sharp` (strips any embedded
  exploit payload riding in image metadata/pixel data), never served with
  a user-supplied `Content-Type`.

## V13 — API and Web Service

- **V13.1 Generic web service security** — Implemented. Every endpoint
  documented via OpenAPI (generated from code, CI fails if it drifts),
  zod validation at the boundary, permission guard, RLS backstop.
- **V13.2 RESTful web service** — Implemented for the one machine-to-machine
  endpoint in this codebase (`POST /leads/inbound`): SHA-256-hashed API
  key auth (`LeadApiKeyGuard`), per-key rate limiting (not a global
  constant), `@Public()` + explicit guard chain rather than accidentally
  inheriting the staff JWT guard.

## V14 — Configuration

- **V14.1 Build and deployment** — Implemented. `sudo ./install-native.sh`
  (`deploy/native/`) from scratch is the only supported production
  install path (self-hostable-first, CLAUDE.md rule #1) — a systemd
  service behind nginx, talking to a PostgreSQL/Redis the self-hoster
  already runs. There is no container path anywhere in this project: the
  Compose files and Dockerfiles were deleted outright, so nothing here
  builds, ships, or runs an image whose base-image patch level could go
  stale — the test suite included, which runs against a PostgreSQL and
  Redis the contributor provides.
- **V14.2 Dependency management** — Implemented. Lockfile committed,
  `pnpm audit` runs in CI (non-blocking — `continue-on-error: true`,
  a deliberate choice recorded in `ci.yml` rather than a silent gap),
  Dependabot configured for the npm and github-actions ecosystems (the
  docker ecosystem was removed along with the images it tracked).
- **V14.3 Unintended security disclosure** — Implemented. `SWAGGER_ENABLED`
  defaults false in production; the health endpoint is the only
  intentionally `@Public()` route.
- **V14.4 HTTP security headers** — Implemented via `helmet` on every
  response, plus the double-submit CSRF cookie pattern for both staff and
  portal cookie-based sessions.
- **V14.5 Validate HTTP request header** — Implemented. CORS allowlist is
  explicit and read from environment config, never a wildcard in the
  shipped defaults.

## Explicitly N/A

- **V6 (Stored Cryptography)** general password-storage sub-controls are
  covered under V2 above; this project has no separate "stored crypto"
  surface beyond what's already covered in V8.
- **V10 (Malicious Code)** — supply-chain/backdoor-detection controls are
  out of scope for a project-level self-assessment; covered instead by
  the ordinary hygiene in V14.2 (lockfile, audit, Dependabot).

## Scope and honesty

This checklist is written by the project's own maintainers/tooling, not an
independent third-party auditor — treat "Implemented" as "this project's
own good-faith assessment of its own architecture," not a certification.
Every entry above points at a real file or a real `CLAUDE.md` decisions-log
entry that can be checked directly; nothing here should be taken on faith
where the underlying code is public. See the [threat model](./threat-model.md)
for the honest, explicitly-accepted residual risks this checklist doesn't
fully capture (plugin trust model, TLS setup automation).
