import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import * as semver from 'semver';
import { CORE_PLUGIN_API_VERSION, type Plugin } from '@openestate/plugin-sdk';

export const PLUGIN_REGISTRATIONS = 'PLUGIN_REGISTRATIONS';

export type PluginStatus = 'active' | 'version-mismatch' | 'not-found';

export interface VersionMismatchInfo {
  pluginId: string;
  requiredRange: string;
  runningCoreVersion: string;
}

/**
 * The single source of truth every dispatch path (webhook/messaging/
 * telephony/lead-source/admin-enable) must check before invoking a
 * plugin's hooks — `getActive()` returns `undefined` for anything not
 * currently loadable, covering BOTH an orphaned installation (a
 * `PluginInstallation` row referencing a `pluginId` no longer present in
 * `PLUGIN_REGISTRATIONS` — e.g. the package was removed) and a
 * version-gate failure (present, but its declared `coreApiVersion`
 * range no longer satisfies the running `CORE_PLUGIN_API_VERSION`)
 * IDENTICALLY, so there is exactly one place this "is this plugin
 * currently usable" logic can drift, not several scattered checks. See
 * CLAUDE.md Phase 7 decisions, addendum A6.
 *
 * Plugins register by being explicitly provided via the
 * `PLUGIN_REGISTRATIONS` DI token (an array — see PluginsModule) rather
 * than by scanning the `plugins/*` directory at runtime: explicit
 * imports are what actually ships in a compiled build, are trivial to
 * substitute in tests, and avoid dynamic `import()` / filesystem
 * globbing complicating bundling. This is an implementation detail, not
 * a contract change — `plugins/*` packages still each own their own
 * manifest+hooks; only how they get handed to the running app differs
 * from "scan the directory."
 */
@Injectable()
export class PluginRegistryService implements OnModuleInit {
  private readonly logger = new Logger(PluginRegistryService.name);
  private readonly active = new Map<string, Plugin>();
  private readonly versionFailures = new Map<string, VersionMismatchInfo>();

  constructor(
    @Optional()
    @Inject(PLUGIN_REGISTRATIONS)
    private readonly registrations: Plugin[] = [],
  ) {}

  onModuleInit(): void {
    const seenIds = new Set<string>();
    for (const plugin of this.registrations) {
      const { id, coreApiVersion } = plugin.manifest;
      if (seenIds.has(id)) {
        throw new Error(`Duplicate plugin id "${id}" in PLUGIN_REGISTRATIONS — plugin ids must be globally unique.`);
      }
      seenIds.add(id);

      if (semver.satisfies(CORE_PLUGIN_API_VERSION, coreApiVersion)) {
        this.active.set(id, plugin);
      } else {
        const info: VersionMismatchInfo = {
          pluginId: id,
          requiredRange: coreApiVersion,
          runningCoreVersion: CORE_PLUGIN_API_VERSION,
        };
        this.versionFailures.set(id, info);
        this.logger.warn(
          `Plugin "${id}" requires core API ${coreApiVersion} but this install is on ${CORE_PLUGIN_API_VERSION} — ` +
            'not registered. Any existing enabled installation for it will be treated as unavailable until the ' +
            'core is upgraded or an older plugin version is installed.',
        );
      }
    }
  }

  /** The one check every dispatch path uses. `undefined` = do not
   * invoke this plugin's hooks, for any reason. */
  getActive(pluginId: string): Plugin | undefined {
    return this.active.get(pluginId);
  }

  getStatus(pluginId: string): PluginStatus {
    if (this.active.has(pluginId)) return 'active';
    if (this.versionFailures.has(pluginId)) return 'version-mismatch';
    return 'not-found';
  }

  getVersionMismatchInfo(pluginId: string): VersionMismatchInfo | undefined {
    return this.versionFailures.get(pluginId);
  }

  /** Every plugin the running build actually ships, active or not —
   * for the admin "available plugins" list (commit 3's UI reads this to
   * show install candidates plus incompatible-but-present ones). */
  listAll(): Plugin[] {
    return [...this.registrations];
  }
}
