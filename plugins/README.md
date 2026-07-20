# OpenEstate Plugins

First-party plugins live here as npm workspace packages (`plugins/<name>`).
The plugin architecture (manifest, config schema, lifecycle hooks, scoped
service API) ships in Phase 7 — see the project `CLAUDE.md` for the
extensibility principles this design must satisfy.

Planned first-party plugins:

- Lead-source mappers (99Acres, MagicBricks, Housing.com, generic webhook)
- Messaging providers (SMTP, MSG91, Textlocal, generic HTTP SMS, WhatsApp Cloud API)
- Telephony call-log webhook adapters
- `generic-sales` — proves the platform can relabel itself for a
  non-real-estate vertical using terminology overrides + custom fields +
  module flags, without forking core.

Until Phase 7 lands, this directory is intentionally empty of packages.
