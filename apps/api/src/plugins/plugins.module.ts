import { Module } from '@nestjs/common';
import type { Plugin } from '@openestate/plugin-sdk';
import { plugin as genericSalesPlugin } from '@openestate/generic-sales';
import { PresalesModule } from '../presales/presales.module';
import { CompanyModule } from '../company/company.module';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { PluginRegistryService, PLUGIN_REGISTRATIONS } from './plugin-registry.service';
import { PluginRuntimeService } from './plugin-runtime.service';
import { PluginSecretEncryptionService } from './plugin-secret-encryption.service';
import { PluginAdminService } from './plugin-admin.service';
import { PluginAdminController } from './plugin-admin.controller';

/**
 * `PLUGIN_REGISTRATIONS` was an empty array in commit 1 (plugin-core) —
 * no first-party plugin existed yet. `plugins/generic-sales` (commit 3,
 * the vertical-proof plugin, CLAUDE.md Phase 7 decisions §7) is the
 * first real entry, added by explicit import — see
 * PluginRegistryService's doc comment for why explicit imports were
 * chosen over scanning the `plugins/*` directory at runtime.
 */
const FIRST_PARTY_PLUGINS: Plugin[] = [genericSalesPlugin as Plugin];

@Module({
  imports: [PresalesModule, CompanyModule, CustomFieldsModule],
  controllers: [PluginAdminController],
  providers: [
    { provide: PLUGIN_REGISTRATIONS, useValue: FIRST_PARTY_PLUGINS },
    PluginRegistryService,
    PluginRuntimeService,
    PluginSecretEncryptionService,
    PluginAdminService,
  ],
  exports: [PluginRegistryService, PluginRuntimeService, PluginSecretEncryptionService],
})
export class PluginsModule {}
