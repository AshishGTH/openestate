import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@openestate/db';
import type { Plugin, PluginConfigField } from '@openestate/plugin-sdk';
import { SYSTEM_PRISMA } from '../database/database.module';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginRuntimeService } from './plugin-runtime.service';
import { PluginSecretEncryptionService } from './plugin-secret-encryption.service';

const LIFECYCLE_BUDGET_MS = 10_000; // admin-triggered, staff-only, not a hot path — see CLAUDE.md Phase 7 decisions §2

export interface PluginSummary {
  pluginId: string;
  name: string;
  kind: string;
  version: string;
  description: string;
  status: 'active' | 'version-mismatch' | 'not-found';
  installed: boolean;
  isEnabled: boolean;
}

@Injectable()
export class PluginAdminService {
  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: PrismaClient,
    private readonly registry: PluginRegistryService,
    private readonly runtime: PluginRuntimeService,
    private readonly secretEncryption: PluginSecretEncryptionService,
  ) {}

  /** Includes orphaned installations too (addendum A6) — a company can
   * have an isEnabled row for a pluginId the registry has never heard of
   * (core downgrade, package removed), and admin GET must surface that
   * as "unavailable" rather than silently omitting it from the list. */
  async list(companyId: string): Promise<PluginSummary[]> {
    const installations = await this.systemPrisma.pluginInstallation.findMany({ where: { companyId } });
    const byPluginId = new Map(installations.map((i) => [i.pluginId, i]));

    const known = this.registry.listAll().map((plugin) => {
      const installation = byPluginId.get(plugin.manifest.id);
      return {
        pluginId: plugin.manifest.id,
        name: plugin.manifest.name,
        kind: plugin.manifest.kind,
        version: plugin.manifest.version,
        description: plugin.manifest.description,
        status: this.registry.getStatus(plugin.manifest.id),
        installed: !!installation,
        isEnabled: installation?.isEnabled ?? false,
      } satisfies PluginSummary;
    });

    const knownIds = new Set(known.map((p) => p.pluginId));
    const orphaned = installations
      .filter((i) => !knownIds.has(i.pluginId))
      .map((i) => this.orphanedSummary(i.pluginId, i.isEnabled));

    return [...known, ...orphaned];
  }

  /** Manifest + config-field metadata + the caller's own non-secret
   * config values (never the secret ones — see §6). Also handles
   * addendum A6's orphaned case: an installed-but-unregistered pluginId
   * still returns a (degraded) detail response instead of 404ing, since
   * a 404 would read as "you never installed this" rather than "this
   * build can't run it right now." */
  async getDetail(companyId: string, pluginId: string) {
    const plugin = this.findKnownPlugin(pluginId);
    const installation = await this.systemPrisma.pluginInstallation.findUnique({
      where: { companyId_pluginId: { companyId, pluginId } },
    });

    if (!plugin) {
      if (!installation) throw new NotFoundException(`Unknown plugin "${pluginId}"`);
      return { ...this.orphanedSummary(pluginId, installation.isEnabled), configFields: [], versionMismatch: null, config: null };
    }

    let config: Record<string, unknown> | null = null;
    if (installation?.configCiphertext) {
      const decrypted = JSON.parse(this.secretEncryption.decrypt(installation.configCiphertext, installation.secretKeyVersion!)) as Record<string, unknown>;
      config = this.stripSecretFields(plugin.manifest.configFields, decrypted);
    }

    return {
      pluginId: plugin.manifest.id,
      name: plugin.manifest.name,
      kind: plugin.manifest.kind,
      version: plugin.manifest.version,
      description: plugin.manifest.description,
      configFields: plugin.manifest.configFields,
      status: this.registry.getStatus(pluginId),
      versionMismatch: this.registry.getVersionMismatchInfo(pluginId) ?? null,
      installed: !!installation,
      isEnabled: installation?.isEnabled ?? false,
      config,
    };
  }

  async install(companyId: string, pluginId: string, actorId: string | null) {
    const plugin = this.requireActivePlugin(pluginId);
    const existing = await this.systemPrisma.pluginInstallation.findUnique({ where: { companyId_pluginId: { companyId, pluginId } } });
    if (existing) throw new ConflictException(`Plugin "${pluginId}" is already installed`);

    const installation = await this.systemPrisma.pluginInstallation.create({
      data: { companyId, pluginId, isEnabled: false, installedById: actorId },
    });

    if (plugin.hooks.onInstall) {
      const ctx = this.runtime.buildContextForInstallation(plugin, companyId, installation);
      await this.runtime.invoke(pluginId, 'onInstall', companyId, LIFECYCLE_BUDGET_MS, () => plugin.hooks.onInstall!(ctx));
    }
    return installation;
  }

  /** Validates against the plugin's own configSchema, encrypts, saves.
   * `onConfigChange` fires only when a config already existed. */
  async setConfig(companyId: string, pluginId: string, rawBody: Record<string, unknown>) {
    const plugin = this.requireKnownPlugin(pluginId);
    const installation = await this.systemPrisma.pluginInstallation.findUnique({ where: { companyId_pluginId: { companyId, pluginId } } });
    if (!installation) throw new NotFoundException(`Plugin "${pluginId}" is not installed`);

    const parsed = plugin.manifest.configSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException({ message: 'Invalid plugin config', issues: parsed.error.issues });
    }

    const previousConfig = installation.configCiphertext
      ? (JSON.parse(this.secretEncryption.decrypt(installation.configCiphertext, installation.secretKeyVersion!)) as Record<string, unknown>)
      : null;

    const { ciphertext, keyVersion } = this.secretEncryption.encrypt(JSON.stringify(parsed.data));
    const updated = await this.systemPrisma.pluginInstallation.update({
      where: { id: installation.id },
      data: { configCiphertext: ciphertext, secretKeyVersion: keyVersion },
    });

    if (previousConfig && plugin.hooks.onConfigChange && this.registry.getActive(pluginId)) {
      const ctx = this.runtime.buildContextForInstallation(plugin, companyId, updated);
      await this.runtime.invoke(pluginId, 'onConfigChange', companyId, LIFECYCLE_BUDGET_MS, () =>
        plugin.hooks.onConfigChange!(ctx, previousConfig as never),
      );
    }
    return { pluginId };
  }

  async enable(companyId: string, pluginId: string) {
    const plugin = this.requireActivePlugin(pluginId);
    const installation = await this.systemPrisma.pluginInstallation.findUnique({ where: { companyId_pluginId: { companyId, pluginId } } });
    if (!installation) throw new NotFoundException(`Plugin "${pluginId}" is not installed`);

    const updated = await this.systemPrisma.pluginInstallation.update({ where: { id: installation.id }, data: { isEnabled: true } });
    if (plugin.hooks.onEnable) {
      const ctx = this.runtime.buildContextForInstallation(plugin, companyId, updated);
      await this.runtime.invoke(pluginId, 'onEnable', companyId, LIFECYCLE_BUDGET_MS, () => plugin.hooks.onEnable!(ctx));
    }
    return { pluginId, isEnabled: true };
  }

  /** Deliberately does NOT require the plugin to be known (addendum A6)
   * — an orphaned installation must stay disable-able even though its
   * hooks can never fire (`plugin` is undefined, so the hook-invocation
   * branch below is simply skipped). */
  async disable(companyId: string, pluginId: string) {
    const plugin = this.findKnownPlugin(pluginId);
    const installation = await this.systemPrisma.pluginInstallation.findUnique({ where: { companyId_pluginId: { companyId, pluginId } } });
    if (!installation) throw new NotFoundException(`Plugin "${pluginId}" is not installed`);

    const updated = await this.systemPrisma.pluginInstallation.update({ where: { id: installation.id }, data: { isEnabled: false } });
    if (plugin?.hooks.onDisable && this.registry.getActive(pluginId)) {
      const ctx = this.runtime.buildContextForInstallation(plugin, companyId, updated);
      await this.runtime.invoke(pluginId, 'onDisable', companyId, LIFECYCLE_BUDGET_MS, () => plugin.hooks.onDisable!(ctx));
    }
    return { pluginId, isEnabled: false };
  }

  /** Also deliberately tolerant of an orphaned pluginId — see disable()
   * above; an admin must be able to remove a broken installation's row
   * even though no onUninstall hook can run for it. */
  async uninstall(companyId: string, pluginId: string) {
    const plugin = this.findKnownPlugin(pluginId);
    const installation = await this.systemPrisma.pluginInstallation.findUnique({ where: { companyId_pluginId: { companyId, pluginId } } });
    if (!installation) throw new NotFoundException(`Plugin "${pluginId}" is not installed`);

    if (plugin?.hooks.onUninstall && this.registry.getActive(pluginId)) {
      const ctx = this.runtime.buildContextForInstallation(plugin, companyId, installation);
      await this.runtime.invoke(pluginId, 'onUninstall', companyId, LIFECYCLE_BUDGET_MS, () => plugin.hooks.onUninstall!(ctx));
    }
    await this.systemPrisma.pluginInstallation.delete({ where: { id: installation.id } });
    return { pluginId, uninstalled: true };
  }

  private requireKnownPlugin(pluginId: string): Plugin {
    const plugin = this.findKnownPlugin(pluginId);
    if (!plugin) throw new NotFoundException(`Unknown plugin "${pluginId}"`);
    return plugin;
  }

  private findKnownPlugin(pluginId: string): Plugin | undefined {
    return this.registry.listAll().find((p) => p.manifest.id === pluginId);
  }

  /** The degraded summary shape for a pluginId the registry has never
   * heard of — no manifest exists, so name/kind/version/description are
   * placeholders rather than fabricated real-looking values. */
  private orphanedSummary(pluginId: string, isEnabled: boolean): PluginSummary {
    return {
      pluginId,
      name: pluginId,
      kind: 'unknown',
      version: 'unknown',
      description: 'Not available in this build.',
      status: 'not-found',
      installed: true,
      isEnabled,
    };
  }

  /** Throws the specific, actionable 409 addendum A6 requires — same
   * message shape for "never registered" and "version gate failed",
   * since both mean "cannot enable/install right now" from the admin's
   * point of view, distinguished only by which detail is available. */
  private requireActivePlugin(pluginId: string): Plugin {
    const active = this.registry.getActive(pluginId);
    if (active) return active;

    const mismatch = this.registry.getVersionMismatchInfo(pluginId);
    if (mismatch) {
      throw new ConflictException(
        `Plugin "${pluginId}" requires core API ${mismatch.requiredRange} but this install is on ${mismatch.runningCoreVersion} — incompatible with this version.`,
      );
    }
    throw new ConflictException(`Plugin "${pluginId}" is not available in this build.`);
  }

  private stripSecretFields(fields: PluginConfigField[], config: Record<string, unknown>): Record<string, unknown> {
    const secretKeys = new Set(fields.filter((f) => f.secret).map((f) => f.key));
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (secretKeys.has(key)) continue; // absent, not masked/null — see CLAUDE.md Phase 7 decisions §6
      out[key] = value;
    }
    return out;
  }
}
