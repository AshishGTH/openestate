# Security Policy

OpenEstate handles PII (names, phone numbers, PAN) and financial ledger data
for real-world property transactions. We take security reports seriously and
ask that you report vulnerabilities responsibly.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Instead, report it privately via this repository's **GitHub Security
Advisories** ("Report a vulnerability" under the repo's Security tab).
Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept code/requests if possible)
- The affected version/commit
- Any suggested remediation, if you have one

## What to expect

- Acknowledgement of your report within a reasonable timeframe
- An assessment of severity and an estimated timeline for a fix
- Credit in the release notes, if you'd like it, once a fix ships

## Scope

In scope: the OpenEstate monorepo (`apps/`, `packages/`, `plugins/`,
`deploy/`) as configured by the shipped Docker Compose stack and
`deploy/install.sh`. Vulnerabilities in third-party dependencies should
generally be reported upstream, but we still want to know if they affect
OpenEstate's default configuration.

Out of scope: social engineering, physical attacks, denial-of-service
against shared infrastructure you don't control, and issues that only
manifest with an intentionally weakened or misconfigured self-hosted
deployment (e.g. running with `SWAGGER_ENABLED=true` in production, or a
deliberately open `CORS_ALLOWLIST`).

## Supported versions

v0.1.0 is the first tagged release. Until a v0.2.0 or later release exists,
only `v0.1.0` and the `main` branch are supported — this section will be
expanded with a real version-support table once there is more than one
tagged release to choose between.

## Project security posture

See [CLAUDE.md](CLAUDE.md) for the security rules every change in this repo
must follow: input validation, RBAC + Postgres row-level security,
append-only financial ledgers, PAN encryption at rest, audit logging, and
more. A formal OWASP ASVS L2 self-checklist and a STRIDE threat model per
module live in the docs site: `docs/docs/security/asvs-checklist.md` and
`docs/docs/security/threat-model.md`.
