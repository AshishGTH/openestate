---
id: threat-model
title: STRIDE Threat Model
sidebar_position: 2
---

# STRIDE Threat Model

A per-module STRIDE (Spoofing, Tampering, Repudiation, Information
Disclosure, Denial of Service, Elevation of Privilege) analysis, written
alongside the [ASVS checklist](./asvs-checklist.md) as this project's
formal security self-assessment for its first tagged release. Same
honesty rule applies: this cites real, existing controls (with file
pointers), and states real, currently-accepted residual risk rather than
implying a guarantee the architecture doesn't make.

## Auth / Session

| Threat | Mitigation | Residual risk |
|---|---|---|
| **Spoofing** — stolen/forged JWT | Short-lived access tokens (15m default), HMAC-signed, `JWT_ACCESS_SECRET` never logged | A stolen access token is valid until expiry; no server-side access-token revocation list (by design — that's what the short lifetime is for) |
| **Tampering** — refresh-token replay after rotation | Family-based reuse detection: replaying an already-rotated refresh token revokes the WHOLE family, not just that token | None significant — this is the standard mitigation for the threat class |
| **Repudiation** — disputed login/action | Audit log on every create/update/delete with actor, before/after diff, IP, timestamp (`packages/db/src/audit.extension.ts`) | Audit log itself is append-managed by app code, not DB-trigger-enforced like financial ledger rows — a compromised app-level credential could in theory suppress a specific audit write. Financial actions are separately protected by the ledger's own DB-trigger immutability. |
| **Information Disclosure** — password/secret in logs | Pino redaction list scrubs known-sensitive field paths before emission | A NEW sensitive field added to a DTO without also being added to the redaction list would leak until caught — process risk, not a structural guarantee |
| **DoS** — credential-stuffing / brute force | Account lockout with exponential backoff; `default` and future `portal-auth` throttler buckets, now Redis-backed so this applies across replicas (Phase 8) | None significant for a single-tenant-attacker scenario; a distributed attack across many IPs against the unauthenticated login endpoint is a generic DoS concern shared by any public login form |
| **Elevation of Privilege** — role/permission tampering | Permissions are a server-side allowlist per route (`PermissionsGuard`), never trusted from client-supplied JWT claims beyond what the server itself signed | None significant |

## Multi-tenancy / RLS

| Threat | Mitigation | Residual risk |
|---|---|---|
| **Spoofing** — cross-company request pretending to be same-company | Every domain table carries `company_id`; RLS keys off `app.current_company_id`, set via `SET LOCAL` inside the request's own transaction, never trusted from a client-supplied value | None significant |
| **Tampering** — a query missing a `WHERE company_id` clause | RLS is the backstop specifically for this: proven by tests that run a raw, filter-less `SELECT` inside a tenant transaction and confirm cross-company rows are invisible regardless of the query's own `WHERE` clause | None — this is exactly the scenario RLS exists to close |
| **Information Disclosure** — cross-tenant data leak via a JS-level filter bug | RLS is the PRIMARY enforcement, not the Prisma tenant-extension's JS-level mirror (which is defense-in-depth only) | A JS-level convenience filter can be buggy (and was, historically — Phase 6 commit 2's `PORTAL_SCOPED_MODELS` gap) without becoming a real leak, because RLS still holds underneath |
| **Elevation of Privilege** — `SYSTEM_PRISMA` (RLS-bypassing) misuse | System client is used only for genuinely cross-tenant operations (auth lookups, admin enumeration) — never exposed to a request handler that also accepts tenant-scoped user input without an explicit `company_id` filter | Relies on code review discipline at each new `SYSTEM_PRISMA` call site; no structural guardrail currently prevents a future misuse the way the portal-scope guardrail does for `runWithTenant` |

## Pre-sales (inquiries, assignment)

| Threat | Mitigation | Residual risk |
|---|---|---|
| **Tampering** — duplicate/unfair lead assignment under concurrency | Per-project advisory lock (`pg_advisory_xact_lock`) serializes the pick-and-claim critical section; proven fair under 50-concurrent-claim load by a dedicated test | Advisory-lock key is a 32-bit hash of `projectId` alone — a rare cross-project hash collision would serialize two unrelated projects against each other (a latency footgun, never a correctness bug — see CLAUDE.md's Phase 3 decisions for why this is accepted, not fixed, at current scale) |
| **Repudiation** — disputed consent for outbound communication | `ApplicantConsent` is an append-only ledger, not a mutable flag — consent state at any past timestamp is reconstructible | None significant |
| **Information Disclosure** — inbound lead API key compromise | Keys are SHA-256 hashed at rest (never stored/logged in plaintext), scoped per-key rate limits, `@Public()` route has no other privileged surface reachable | A leaked API key can create leads (and consume that key's dedicated rate-limit budget) until revoked — no automatic anomaly detection on unusual submission volume yet |

## Post-sales / financial ledger

| Threat | Mitigation | Residual risk |
|---|---|---|
| **Tampering** — direct UPDATE/DELETE on a financial row | DB trigger (`forbid_financial_mutation`) blocks it at the database level, not just app-level discipline — the one deliberate escape hatch (`app.allow_financial_mutation` GUC, admin purges/test teardown only) is never set by normal app code | A superuser role bypassing the trigger entirely is always theoretically possible for whoever controls the database directly — out of scope for an application-level threat model |
| **Repudiation** — disputed balance/receipt | Balance is *computed*, not stored (`SUM(ledger_entries.signed_amount_paise)`) — there is no mutable "balance" field that could silently drift from the ledger's own history | None significant |
| **Information Disclosure** — cross-company financial data leak | Same RLS + `SYSTEM_PRISMA` discipline as the multi-tenancy section above, applied to the highest-value data in the system | Same residual risk as multi-tenancy above |
| **DoS** — property-test / reconciliation logic exploited to corrupt real balances | N/A as an external threat — the property test is a development-time correctness proof (fast-check, 500-2000 random operation sequences per CI run), not a runtime-reachable surface | None |

## Customer + Broker Portal

| Threat | Mitigation | Residual risk |
|---|---|---|
| **Spoofing** — one portal user acting as another | RLS keyed on `app.portal_applicant_id`/`app.portal_broker_id`, not just `company_id` — the primary defense for this principal, per Phase 5's explicit reframing ("a portal user is a different threat model: the client is untrusted by construction") | None significant, given the extensive IDOR test battery (raw-connection cross-applicant/cross-broker reads) this reframing produced |
| **Tampering** — a self-wrapped `runWithTenant` silently dropping ambient portal scope | Structural guardrail: `runWithTenant` throws if a same-company call would replace an active portal scope, closing the exact bug class that caused a real fail-open IDOR in `NocService` (Phase 6 commit 4) | Guardrail covers same-company scope-drop specifically; a genuinely new composition bug in an unanticipated shape is still possible — this is defense-in-depth, not a proof of absence of all such bugs |
| **Information Disclosure** — portal session token leak | httpOnly Secure cookies, CSRF double-submit, short-lived portal refresh tokens (24h, shorter than staff's 7d) | None significant |
| **DoS** — portal-auth login endpoint brute force | `portal-auth` bucket: 5 requests/5 minutes, IP-keyed, now Redis-backed (Phase 8) so it holds across replicas/restarts | None significant |

## Plugins

| Threat | Mitigation | Residual risk (stated plainly, not hidden) |
|---|---|---|
| **Tampering** — a plugin reaching outside its declared capabilities | Capability-gated `Proxy` context throws `PluginCapabilityError` on any undeclared-capability access; package-boundary isolation means a plugin has no `@openestate/db` import path at all, so `runWithTenant`/raw Prisma are unreachable **syntactically**, not just by convention | None for the specific bug class this defends against (composition/scope misuse, the Phase 6 lesson) |
| **Tampering** — a plugin's outbound HTTP call targeting internal infrastructure (SSRF) | `ScopedHttpClient`: resolve-then-pin DNS resolution (closes the rebinding TOCTOU), private/loopback/link-local/CGNAT range rejection, 1MB response cap, 1-redirect cap with per-hop re-validation | None significant for the SSRF threat specifically |
| **Information Disclosure** — a plugin logging its own decrypted secret | `SecretRef`/`SecretHeaderSpec` opaque-handle design means a `secret: true` config value is never plaintext in `ctx.config` at all; substring-redaction on the logger is a backstop, not the primary defense | **Explicitly accepted**: a plugin author who deliberately writes `format: v => { console.log(v); return v; }` can still leak it. This is a real limit of the trusted-first-party-code model, not a claim of protection against a malicious plugin author. |
| **Denial of Service** — a plugin hook that never returns | `invoke()`'s `Promise.race` timeout (30s for queue-worker hooks, 10s for inline admin-action hooks) converts a hang into a structured failure the caller handles normally | **Explicitly accepted, the single largest stated limit in this whole document**: a genuine synchronous infinite loop (`while(true)`, not an unresolved Promise) blocks the single Node event loop and cannot be preempted by `Promise.race` — there is no worker-thread or process isolation. First-party plugins ship as reviewed npm workspace packages in this repo, the same review bar as any other module — this is a blast-radius boundary against accidental misbehavior and the Phase 6 composition-bug class, **not a sandbox against a deliberately hostile plugin author**. If this project ever accepts untrusted third-party plugins, real isolation (worker_threads or a separate process per invocation) is required before that trust boundary can move — tracked in `docs/todo.md`, not silently assumed solved. |
| **Elevation of Privilege** — a plugin's declared `coreApiVersion` mismatching the running core in a way that changes contract semantics | `PluginRegistryService` version-gates at load time (`semver.satisfies`) — a mismatched plugin is never registered, never installable, never enabled | None significant |

## Webhooks / Inbound Leads

| Threat | Mitigation | Residual risk |
|---|---|---|
| **Spoofing** — forged inbound webhook delivery (someone else's data claiming to be a real event) | Outbound deliveries are HMAC-SHA256 signed (`X-OpenEstate-Signature`); the signature covers `timestamp + body`, not body alone, closing the "captured-signature replay after the window closes" gap | Signature verification is the RECEIVING system's responsibility once OpenEstate delivers a webhook outward — this project controls the signing side, not what a third-party receiver does with it |
| **Tampering** — replay of a previously-valid inbound lead payload | `verifyWebhookSignature`'s replay window (default 5 minutes) rejects a validly-signed-but-stale payload; used both for outbound delivery verification and the one exercised inbound `lead-source` plugin fixture (Phase 7 commit 2) | Generic inbound leads (99acres/MagicBricks/webhook, no plugin) authenticate via API key, not payload signing — replay protection there is the per-key rate limit, not a timestamp window, since those vendors don't sign payloads |
| **Denial of Service** — oversized or repeated-retry payload amplification | 256KB payload cap enforced at write time (before a `WebhookDelivery` row is even created); bounded retries (6 attempts, exponential backoff, ~33min total spread) | None significant |
| **Elevation of Privilege** — an exhausted/disabled webhook endpoint's failure state being racy under concurrent deliveries | Atomic `consecutiveFailures` update via a single parameterized `UPDATE ... CASE WHEN` (same technique as the Phase 6 invite-attempt cap), success-path reset can never resurrect a disabled endpoint | None significant — proven by a concurrency test firing N simultaneous exhausted deliveries |

## What this document does not cover

Physical security, hosting-provider security, and the self-hoster's own
operational practices (patching the host OS, securing the Docker daemon,
network segmentation) are out of scope — this is an *application*-level
threat model for the software this project ships, not a deployment
security guide for any specific environment it might run in.
