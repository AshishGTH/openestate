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
`deploy/`) as configured by the native install path
(`deploy/native/install-native.sh`) — the supported production
deployment. Vulnerabilities in third-party dependencies should generally
be reported upstream, but we still want to know if they affect
OpenEstate's default configuration.

Out of scope: social engineering, physical attacks, denial-of-service
against shared infrastructure you don't control, and issues that only
manifest with an intentionally weakened or misconfigured self-hosted
deployment (e.g. running with `SWAGGER_ENABLED=true` in production, or a
deliberately open `CORS_ALLOWLIST`).

## Supported versions

Only the latest tagged release and the `master` branch are supported.
OpenEstate is pre-1.0 and does not yet maintain parallel patch branches
for older minor releases — see the [releases page](https://github.com/AshishGTH/openestate/releases)
for the current version and [CHANGELOG.md](CHANGELOG.md) for what changed
since the one before it. If you're running an older tagged release,
upgrade to the latest before reporting — we'll ask you to reproduce there
first unless the report itself explains why that isn't possible.

## Project security posture

See [CLAUDE.md](CLAUDE.md) for the security rules every change in this repo
must follow: input validation, RBAC + Postgres row-level security,
append-only financial ledgers, PAN encryption at rest, audit logging, and
more. A formal OWASP ASVS L2 self-checklist and a STRIDE threat model per
module live in the docs site: `docs/docs/security/asvs-checklist.md` and
`docs/docs/security/threat-model.md`.
