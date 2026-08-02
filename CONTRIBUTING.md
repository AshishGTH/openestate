# Contributing to OpenEstate

Thanks for considering a contribution. OpenEstate is early (Phase 0 as of
this writing) — expect the architecture to shift as later phases land.

## Ground rules

- Read [CLAUDE.md](CLAUDE.md) first. It is the project constitution:
  self-hostability, the append-only ledger model, master-driven
  configuration, multi-tenancy, and the security rules are non-negotiable.
- All contributions are licensed under AGPL-3.0-only (see [LICENSE](LICENSE)).
  By submitting a PR you agree your changes are licensed accordingly.
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, ...).

## Getting set up

```bash
pnpm install
pnpm --filter @openestate/db generate
pnpm dev
```

This runs the dev servers (API + both frontends) directly against a local
PostgreSQL/Redis you point `apps/api/.env` at — no Docker required for
day-to-day development. If you'd rather not run Postgres/Redis natively
while iterating, see "Local test infrastructure" below for the Docker
Compose files this repo keeps around specifically for that.

## Before opening a PR

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` needs a real Postgres + Redis — see "Local test
infrastructure" below to bring one up via Docker in under a minute if you
don't already have one running.

Every endpoint needs: a zod DTO, an OpenAPI decorator, a permission guard,
an e2e happy-path test, and one authz-failure test — see "Definition of
done" in CLAUDE.md.

**Auth-related PRs specifically** (`apps/api/src/auth/`,
`apps/api/src/portal-auth/`, `apps/web/src/lib/api.ts`,
`apps/portal/src/lib/api.ts`, or anything touching login/2FA/refresh/
password-reset/CSRF): staff and portal auth are mirrored
implementations by design, not by accident, and a fix or change to one
side has shipped broken on the other side before (see CLAUDE.md's
"Standing rule: staff and portal auth are mirrored implementations").
Before opening the PR, confirm:

- [ ] The equivalent staff-side or portal-side code path was checked
      for the same defect/change, not assumed to be fine.
- [ ] If only one side needed the change, the PR description says
      *why* the other side doesn't (an intentional asymmetry, not an
      oversight).
- [ ] Every session-issuing or token-rotating branch (login, 2FA
      verify, refresh, invite/reset-consume) on the side(s) you
      touched still sets its CSRF cookie — an early return before that
      call is the exact shape both prior incidents took.
- [ ] `apps/web/src/lib/api.ts` and `apps/portal/src/lib/api.ts` were
      diffed against each other if either changed — they're expected
      to stay near-identical.
- [ ] You clicked through the affected flow in a real browser, on
      both staff and portal, before opening the PR — not just ran the
      tests. Every real auth bug found in this codebase so far was
      caught by exercising the flow, none by reading the code or by
      the tests that already existed at the time (see CLAUDE.md's
      "Standing rule: auth changes require a real browser
      click-through before commit").

## Local test infrastructure

**Docker is not part of OpenEstate's production install path** (that's
native/systemd — see `docs/docs/installation.md` and `deploy/native/`).
It's kept in this repo purely as a convenient way to stand up a throwaway
Postgres + Redis for running the test suite locally, and as what CI's
`compose-healthcheck` job uses to prove the production build still
compiles end-to-end. Don't add production-install functionality to these
files — that belongs in `deploy/native/` instead.

```bash
./scripts/test-setup.sh   # brings up deploy/docker-compose.test.yml
                           # (postgres-test:5433, redis-test:6380),
                           # runs migrations, seeds the test DB
pnpm test
```

- `deploy/docker-compose.test.yml` — isolated test-only Postgres/Redis on
  non-default ports, `tmpfs` data dir, never touched by anything outside
  `scripts/test-setup.sh` and CI.
- `deploy/docker-compose.yml` + `deploy/docker/*.Dockerfile` — the
  full production-shaped stack (API, both frontends, nginx, Postgres,
  Redis), no longer documented as a user-facing install method, but kept
  buildable because CI's `compose-healthcheck` job uses it to catch build
  breakage across the whole stack (a class of bug `pnpm build` alone
  won't catch — e.g. a Dockerfile `COPY` list falling out of sync with a
  new workspace package). If you touch anything under `deploy/docker/` or
  `deploy/docker-compose.yml`, that CI job is what will actually verify it
  still works, since there's no other consumer of it left to notice a
  regression.

## Reporting bugs / requesting features

Open a GitHub issue. Security issues are handled separately — see
[SECURITY.md](SECURITY.md), do not open a public issue for a vulnerability.

## Plugin contributions

Once the plugin system lands (Phase 7), see `docs/plugin-development` for
the manifest format and scoped service API. Vertical-specific logic belongs
in a plugin, not in core.
