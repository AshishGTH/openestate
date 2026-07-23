import { Injectable, Logger } from '@nestjs/common';
import { normalizeEmail, normalizePhone } from '@openestate/shared';
import {
  PluginCapabilityError,
  PluginExecutionError,
  type Plugin,
  type PluginContext,
  type SecretHeaderSpec,
  type SecretRef,
} from '@openestate/plugin-sdk';
import { ApplicantService } from '../presales/applicant.service';
import { CompanyService } from '../company/company.service';
import { PluginSecretEncryptionService } from './plugin-secret-encryption.service';
import { createScopedHttpClient } from './plugin-http-client';
import { createScrubbingLogger } from './plugin-logger';

/** Which `PluginContext` field a given capability gates — the Proxy's
 * `get` trap throws `PluginCapabilityError` naming the capability when
 * an undeclared one is touched, rather than returning `undefined`
 * silently. See CLAUDE.md Phase 7 decisions §2. */
const CAPABILITY_BY_FIELD: Record<string, string> = {
  http: 'outbound-http',
  leads: 'leads.create',
  applicants: 'applicants.dedup',
  companyConfig: 'company.config',
};

export type InvokeResult<T> = { ok: true; value: T } | { ok: false; error: PluginExecutionError };

/**
 * The only code that constructs a `PluginContext` — captures `companyId`
 * as a closure variable, so no hook can widen or switch it (there is no
 * `runWithTenant`/Prisma reference reachable from the context at all;
 * see CLAUDE.md Phase 7 decisions §2 for why this is a stronger
 * guarantee than Phase 6's reactive `runWithTenant` guardrail). Also
 * owns `invoke()`, the timeout+catch-all wrapper every hook call goes
 * through, so a plugin can never crash the request or queue worker that
 * called it.
 */
@Injectable()
export class PluginRuntimeService {
  private readonly logger = new Logger(PluginRuntimeService.name);

  constructor(
    private readonly secretEncryption: PluginSecretEncryptionService,
    private readonly applicantService: ApplicantService,
    private readonly companyService: CompanyService,
  ) {}

  /** Decrypts a stored installation's config and builds its context in
   * one step — the normal entry point for real dispatch paths. */
  buildContextForInstallation<TConfig extends Record<string, unknown>>(
    plugin: Plugin<TConfig>,
    companyId: string,
    installation: { configCiphertext: string | null; secretKeyVersion: number | null },
  ): PluginContext<TConfig> {
    const rawConfig = installation.configCiphertext
      ? (JSON.parse(this.secretEncryption.decrypt(installation.configCiphertext, installation.secretKeyVersion!)) as TConfig)
      : ({} as TConfig);
    return this.buildContext(plugin, companyId, rawConfig);
  }

  /** Builds a context from an already-decrypted config object — used
   * directly by tests and by the admin controller's "test config before
   * save" flow. */
  buildContext<TConfig extends Record<string, unknown>>(plugin: Plugin<TConfig>, companyId: string, rawConfig: TConfig): PluginContext<TConfig> {
    const pluginId = plugin.manifest.id;
    const secretFieldKeys = new Set(plugin.manifest.configFields.filter((f) => f.secret).map((f) => f.key));
    const realSecrets = new Map<string, string>();
    const publicConfig: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawConfig)) {
      if (secretFieldKeys.has(key) && value !== undefined && value !== null) {
        realSecrets.set(key, String(value));
        publicConfig[key] = { __secretRef: true, fieldKey: key } satisfies SecretRef;
      } else {
        publicConfig[key] = value;
      }
    }

    const capabilities = new Set(plugin.manifest.capabilities);
    const logger = createScrubbingLogger(pluginId, companyId, new Set(realSecrets.values()));

    const target: Record<string, unknown> = {
      companyId,
      config: publicConfig,
      logger,
      secretHeader: (fieldKey: string, format: (plaintext: string) => string): SecretHeaderSpec => {
        if (!secretFieldKeys.has(fieldKey)) {
          throw new PluginCapabilityError(pluginId, `secretHeader:${fieldKey}`);
        }
        return { __secretHeaderSpec: true, fieldKey, format };
      },
    };

    if (capabilities.has('outbound-http')) {
      target.http = createScopedHttpClient(pluginId, realSecrets);
    }
    if (capabilities.has('applicants.dedup')) {
      target.applicants = {
        findDuplicates: async (phone: string, email?: string) => {
          const rows = await this.applicantService.findDuplicates(companyId, normalizePhone(phone), email ? normalizeEmail(email) : null);
          return rows.map((r: { id: string; name: string }) => ({ id: r.id, name: r.name }));
        },
      };
    }
    if (capabilities.has('company.config')) {
      target.companyConfig = { getTerminology: () => this.companyService.getTerminology(companyId) };
    }
    // 'leads.create' (ctx.leads) is wired in commit 2, alongside
    // InquiryService.createFromLead's extraction — see CLAUDE.md Phase 7
    // decisions. Declaring it in a manifest before then would leave
    // ctx.leads throwing PluginCapabilityError same as an undeclared
    // capability would; no real plugin declares it yet.

    return new Proxy(target, {
      get(obj, prop) {
        if (typeof prop === 'string' && prop in obj) return obj[prop];
        if (typeof prop === 'string' && prop in CAPABILITY_BY_FIELD) {
          throw new PluginCapabilityError(pluginId, CAPABILITY_BY_FIELD[prop]);
        }
        return undefined;
      },
    }) as unknown as PluginContext<TConfig>;
  }

  /**
   * Every hook call goes through this. `Promise.race`s the hook against
   * a hard deadline and catches any throw (including a non-Error
   * throw) — neither propagates past this method. Honest limit: a
   * genuine synchronous infinite loop blocks the single Node event loop
   * and cannot be preempted by Promise.race (no worker-thread/process
   * isolation — see CLAUDE.md Phase 7 decisions, Trust model). Budget
   * guidance: 30_000ms for messaging/telephony hooks (run inside a
   * BullMQ worker job, never inline in an HTTP request), 10_000ms for
   * vertical lifecycle hooks (rare, staff-only, admin-triggered).
   */
  async invoke<T>(pluginId: string, hook: string, companyId: string, budgetMs: number, fn: () => Promise<T>): Promise<InvokeResult<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`plugin timeout after ${budgetMs}ms`)), budgetMs);
    });
    try {
      const value = await Promise.race([fn(), timeout]);
      return { ok: true, value };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Plugin "${pluginId}" hook "${hook}" failed for company ${companyId}: ${message}`);
      return { ok: false, error: new PluginExecutionError(pluginId, hook, companyId, message) };
    } finally {
      clearTimeout(timer);
    }
  }
}
