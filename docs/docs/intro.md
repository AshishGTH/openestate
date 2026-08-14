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

As of v0.3.0, the core sales funnel — auth/RBAC, multi-tenancy, inventory,
pre-sales, the post-sales ledger, brokers/commissions, both portals, plugins,
webhooks, and custom fields — is built and exercised end to end. See the
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
