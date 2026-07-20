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

Or run the full stack with Docker: `cd deploy && ./install.sh`.

## Before opening a PR

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Every endpoint needs: a zod DTO, an OpenAPI decorator, a permission guard,
an e2e happy-path test, and one authz-failure test — see "Definition of
done" in CLAUDE.md.

## Reporting bugs / requesting features

Open a GitHub issue. Security issues are handled separately — see
[SECURITY.md](SECURITY.md), do not open a public issue for a vulnerability.

## Plugin contributions

Once the plugin system lands (Phase 7), see `docs/plugin-development` for
the manifest format and scoped service API. Vertical-specific logic belongs
in a plugin, not in core.
