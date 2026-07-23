import { Module } from '@nestjs/common';
import type { Plugin } from '@openestate/plugin-sdk';
import { PresalesModule } from '../presales/presales.module';
import { CompanyModule } from '../company/company.module';
import { PluginRegistryService, PLUGIN_REGISTRATIONS } from './plugin-registry.service';
import { PluginRuntimeService } from './plugin-runtime.service';
import { PluginSecretEncryptionService } from './plugin-secret-encryption.service';
import { PluginAdminService } from './plugin-admin.service';
import { PluginAdminController } from './plugin-admin.controller';

/**
 * `PLUGIN_REGISTRATIONS` is an empty array in commit 1 (plugin-core) —
 * no first-party plugin exists yet. `plugins/generic-sales` (commit 3)
 * registers itself here by being explicitly imported and added to this
 * array; see PluginRegistryService's doc comment for why explicit
 * imports were chosen over scanning the `plugins/*` directory at
 * runtime.
 */
const FIRST_PARTY_PLUGINS: Plugin[] = [];

@Module({
  imports: [PresalesModule, CompanyModule],
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
