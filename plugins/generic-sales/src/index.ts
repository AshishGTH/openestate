import { z } from 'zod';
import type { Plugin } from '@openestate/plugin-sdk';

/**
 * The vertical-proof plugin (CLAUDE.md Phase 7 decisions §7) — relabels
 * OpenEstate for a generic (non-real-estate) sales vertical using ONLY
 * mechanisms that already existed before Phase 7: terminology overrides
 * (`CompanyConfig.labelOverrides`), module flags
 * (`CompanyConfig.enabledModules`), and custom fields
 * (`CustomFieldDefinition`). No new database tables, no new HTTP routes,
 * no schema columns — this plugin's hooks are purely declarative data
 * that `PluginAdminService.install()` applies through the SAME
 * `CompanyService.updateConfig()`/`CustomFieldsService.create()` calls a
 * staff admin would make by hand. `capabilities: []` because nothing
 * here needs a runtime `ctx` method — see plugin-sdk's `VerticalHooks`
 * doc comment for why these three fields are plain data, not functions.
 *
 * Honest boundary, stated here and in CLAUDE.md: the transactional core
 * (Booking → ledger → Receipt, append-only, money-in-paise) is
 * unchanged underneath the relabeling — a "sale" still books through
 * the same tables. India-specific GST/TDS UI is NOT hidden by this
 * plugin (stays visible-but-optional); this proves terminology +
 * optional-field adaptability, not full i18n or tax-logic removal.
 */
const configSchema = z.object({}).strict();

export const plugin: Plugin<Record<string, never>> = {
  manifest: {
    id: 'generic-sales',
    name: 'Generic Sales (non-real-estate vertical)',
    version: '1.0.0',
    kind: 'vertical',
    coreApiVersion: '^1.0.0',
    description:
      'Relabels OpenEstate for a generic product-sales vertical: Unit → Product, Project → Catalog, Booking → Order, Inquiry → Lead. Adds a warranty-period custom field to applicants. No schema or route changes.',
    configSchema,
    configFields: [],
    capabilities: [],
  },
  hooks: {
    terminologyOverrides: {
      unit: 'Product',
      project: 'Catalog',
      booking: 'Order',
      inquiry: 'Lead',
    },
    enabledModules: ['presales', 'postsales', 'accounts'],
    customFieldSeeds: [
      {
        entityType: 'APPLICANT',
        key: 'warranty_period_months',
        label: 'Warranty Period (months)',
        fieldType: 'NUMBER',
        isRequired: false,
      },
    ],
  },
};

export default plugin;
