---
id: intro
title: Introduction
slug: /
---

# OpenEstate

OpenEstate is an open-source (AGPL-3.0), self-hostable CRM for real estate —
pre-sales lead management, post-sales unit/installment/receipt management, a
customer portal, and a broker portal. Its plugin system lets other verticals
adapt it without forking core code.

As of v0.7.0, the core sales funnel — auth/RBAC, multi-tenancy, inventory
(unit-based and plotted/farmhouse land sales), a configurable lead-stage
pipeline, manager-hierarchy-scoped lead visibility, pre-sales (including an
expanded reporting suite), the post-sales ledger, brokers/commissions, both
portals, plugins, webhooks, and custom fields — is built and exercised end
to end. v0.7.0 lets an admin clear a user's two-factor authentication —
staff, portal, or a locked-out sole admin via the break-glass CLI; v0.6.1
fixes recovery-code sign-in on the staff two-factor screen; v0.6.0 added
admin-issued, one-time password-reset links for staff and portal users (no
mail server needed); v0.5.0 was a security release that closed a
two-factor-authentication bypass and made 2FA codes resistant to
guessing — see
[SECURITY.md](https://github.com/AshishGTH/openestate/blob/master/SECURITY.md)
if you're upgrading from a version before that. See the
[known gaps](./features-and-usage.md#known-gaps-before-you-run-a-real-project-on-this)
before relying on it for a real pilot.

- **Install** — [native install SOP: prerequisites, first-login checklist, backups, upgrades](./installation.md)
- **Admin guide** — [feature walkthrough by module, including the customer and broker portals](./features-and-usage.md)
- **API reference** — live, generated from the OpenAPI spec: `/api/v1/docs` on your own running instance (not a static page here)
- **Customization guide** — custom fields, terminology, and module flags are covered in the
  [Admin guide's Customization section](./features-and-usage.md#7-customization--this-isnt-just-for-real-estate)
- **Plugin development** — not yet written as a standalone guide; the
  [`generic-sales`](https://github.com/AshishGTH/openestate/tree/master/plugins/generic-sales)
  plugin is the closest thing to one today — read it alongside
  `packages/plugin-sdk` for the capability-gated `PluginContext` API
- **Security** — [ASVS L2 self-assessment](./security/asvs-checklist.md)
  and [STRIDE threat model](./security/threat-model.md);
  disclosure policy in the repo's [SECURITY.md](https://github.com/AshishGTH/openestate/blob/master/SECURITY.md)
