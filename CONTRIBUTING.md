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
PostgreSQL/Redis you point `apps/api/.env` at. There is no Docker
anywhere in this repo — you bring Postgres and Redis, the same way a
real install does.

## Before opening a PR

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` needs a real Postgres + Redis — see "Local test
infrastructure" below for the one script that provisions everything else
against them.

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

**There is no Docker in this repo.** OpenEstate installs natively —
systemd + nginx against a PostgreSQL and Redis you run yourself (see
`docs/docs/installation.md` and `deploy/native/`) — and the test suite
follows the same rule: bring your own PostgreSQL 16 and Redis 7.

One script provisions everything else against them:

```bash
./scripts/test-setup.sh   # creates the openestate_test database and its
                          # roles, applies migrations, seeds
source .test-env          # exports DATABASE_URL_TEST* and REDIS_TEST_URL
pnpm test
```

`./scripts/test-setup.sh teardown` drops the test database again. It
refuses to drop anything whose name doesn't end in `_test`.

- Defaults to Postgres on `localhost:5432` and Redis on `localhost:6379`.
  Override with `TEST_PG_HOST` / `TEST_PG_PORT` / `TEST_REDIS_HOST` /
  `TEST_REDIS_PORT`; the generated `.test-env` carries whatever you chose
  through to both the backend suite and `apps/e2e`.
- Connects as an admin either through `sudo -u postgres` (local peer
  auth, the default) or over TCP if you set `PGPASSWORD`.
- Role creation is delegated to `deploy/native/setup-database.sh` — the
  same script a real install runs — rather than a second copy of the same
  SQL.
- **It refuses to run on a cluster that also holds a database named
  `openestate`.** `openestate_app` and `openestate_system` are
  cluster-wide role names shared with a real install, so provisioning the
  test database there would reset that install's role passwords and break
  it. Use a separate cluster, or set `TEST_ALLOW_SHARED_CLUSTER=1` if that
  `openestate` database is disposable.

Don't add production-install functionality to these files — that belongs
in `deploy/native/`.

## Reporting bugs / requesting features

Open a GitHub issue. Security issues are handled separately — see
[SECURITY.md](SECURITY.md), do not open a public issue for a vulnerability.

## Plugin contributions

Once the plugin system lands (Phase 7), see `docs/plugin-development` for
the manifest format and scoped service API. Vertical-specific logic belongs
in a plugin, not in core.
