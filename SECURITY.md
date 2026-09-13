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

## Security advisories

### Two-factor authentication bypass and guessable 2FA codes — fixed in v0.5.0 (2026-09-14)

**Affected:** every tagged release from v0.1.0 through v0.4.0, and `master`
before commit `1fd0b2c`. Staff and customer/broker portal accounts that
have two-factor authentication (2FA) turned on.

**Fixed in:** v0.5.0.

**Exposure:** none outside the author's own test machines. OpenEstate has
not been installed anywhere else, so no third party ever ran an affected
version and there is nothing to report or rotate. Both problems were found
during pre-launch security review.

**1. A password alone could turn off or take over 2FA.** When 2FA is on,
signing in takes two steps: the password, then a six-digit code from an
authenticator app. After the password step the server hands out a
temporary token that is only meant to be used for entering the code. The
server did not enforce that. The same token was also accepted by the
endpoints that set up, confirm and turn off 2FA, change the password and
sign out every session. So someone who knew a user's password — but not
their code — could turn that user's 2FA off, or register their own
authenticator app in its place, finish signing in, and take the new
recovery codes. The real owner's authenticator would then be rejected. The
temporary token is now refused everywhere except the code-entry step, it
expires after 5 minutes instead of 15, and a normal signed-in session can
no longer use the code-entry step.

**2. 2FA codes on staff accounts could be guessed.** The staff code-entry
step had no rate limit of its own and did not count wrong codes, so
someone who knew a staff user's password could keep trying six-digit codes
until one worked. Code entry now allows 5 attempts per user per 5 minutes
on both staff and portal accounts, however many network addresses the
attempts come from, and 5 wrong codes in a row lock code entry for 5
minutes. This lock is separate from the password lockout, so it can't be
used to lock a user out of their own account.

**What to do:** upgrade to v0.5.0, after reading the upgrade notes in
[CHANGELOG.md](CHANGELOG.md) — this release adds a database migration and
an optional setting, `TOTP_VERIFY_THROTTLE_LIMIT`.

## Project security posture

See [CLAUDE.md](CLAUDE.md) for the security rules every change in this repo
must follow: input validation, RBAC + Postgres row-level security,
append-only financial ledgers, PAN encryption at rest, audit logging, and
more. A formal OWASP ASVS L2 self-checklist and a STRIDE threat model per
module live in the docs site: `docs/docs/security/asvs-checklist.md` and
`docs/docs/security/threat-model.md`.
