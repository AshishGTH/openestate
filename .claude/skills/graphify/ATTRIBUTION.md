# Attribution

The files in this folder (`SKILL.md` and `references/*.md`) are copied
verbatim, unmodified, from a third-party open-source project:

- **Project:** [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify)
- **Copyright:** © 2026 Safi Shamsi and the Graphify contributors
- **License:** Apache License, Version 2.0 (`LICENSE`); portions
  originally contributed under the MIT License remain available under
  those terms too (`LICENSE-MIT`), per the project's own `NOTICE` file
- **Version pulled:** the `v8` branch, commit
  `a5957aa6ef51c9be8d054de9783d25046c187f3f`, matching
  `.graphify_version` (`0.9.62`)

Every file was diffed byte-for-byte against the corresponding upstream
path before being committed here (`SKILL.md` against
`graphify/skill-windows.md`; each `references/*.md` against
`graphify/skills/claude/references/*.md`) — all identical, none
modified for this repo.

This is dev tooling for whoever contributes to OpenEstate with Claude
Code (or a compatible assistant); it is not part of OpenEstate's own
product code, and it is not itself licensed AGPL-3.0 — it keeps the
license terms it was distributed under. `LICENSE`, `LICENSE-MIT` and
`NOTICE` are included alongside it, verbatim from upstream, as the
Apache-2.0 license's own redistribution terms require.

To update: re-pull `graphify/skill-windows.md` and
`graphify/skills/claude/references/*.md` from a newer tag of the same
repository, and update the version/commit above.
