import type { z } from 'zod';

export type PluginKind = 'messaging' | 'telephony' | 'lead-source' | 'vertical';

/**
 * Every capability a plugin can declare. `PluginContext` is built as a
 * `Proxy` (apps/api/src/plugins/plugin-runtime.service.ts) that only
 * exposes the field for a capability the manifest actually listed —
 * touching an undeclared one throws `PluginCapabilityError`, not a bare
 * TypeError. See CLAUDE.md Phase 7 decisions §2.
 */
export type PluginCapability =
  | 'outbound-http' // ctx.http becomes available
  | 'messaging.send' // plugin IS a messaging provider (kind: messaging)
  | 'leads.create' // ctx.leads.create() — dedup + Inquiry creation
  | 'applicants.dedup' // ctx.applicants.findDuplicates() — read-only
  | 'company.config'; // ctx.companyConfig — vertical plugins only

/** Same shape as CustomFieldDefinition's admin-facing metadata
 * (apps/api/src/custom-fields/custom-fields.service.ts) — deliberately,
 * so the admin config-form renderer is one component reused for both
 * custom fields and plugin config. */
export interface PluginConfigField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'boolean' | 'select';
  required: boolean;
  /** Encrypted at rest, never returned after save. See §6 — a field
   * marked secret NEVER appears as plaintext in `PluginContext.config`;
   * see `SecretRef` below. */
  secret?: boolean;
  options?: string[]; // 'select' only
  helpText?: string;
}

export interface PluginManifest<TConfig = Record<string, unknown>> {
  /** Globally unique, kebab-case: "msg91". */
  id: string;
  name: string;
  /** The PLUGIN's own semver — independent of coreApiVersion. */
  version: string;
  kind: PluginKind;
  /** Semver RANGE this plugin needs from the running core, e.g. "^1.0.0".
   * Checked once at registry boot via `semver.satisfies()`, never per
   * call — see CLAUDE.md Phase 7 decisions §3. */
  coreApiVersion: string;
  description: string;
  configSchema: z.ZodType<TConfig>;
  configFields: PluginConfigField[];
  capabilities: PluginCapability[];
}

/**
 * Opaque marker standing in for a secret config value — `ctx.config[key]`
 * for any field the manifest marks `secret: true` is one of these, NEVER
 * the plaintext string. A plugin cannot log, JSON.stringify, or otherwise
 * leak a secret it never actually holds. See CLAUDE.md Phase 7 decisions,
 * addendum A1, for the full reasoning (substring-redacting a decrypted
 * value is a backstop only — it misses base64/truncated/HMAC/URL-encoded
 * derived forms; not holding the plaintext at all is the primary
 * defense).
 */
export interface SecretRef {
  readonly __secretRef: true;
  readonly fieldKey: string;
}

export function isSecretRef(value: unknown): value is SecretRef {
  return typeof value === 'object' && value !== null && (value as { __secretRef?: unknown }).__secretRef === true;
}

/**
 * Returned by `ctx.secretHeader()` — plugin code passes this AS a header
 * value to `ctx.http.request()`. The runtime resolves it to the real
 * plaintext immediately before the socket write, inside its own closure;
 * the plaintext only ever exists transiently inside the `format` callback
 * the plugin itself wrote, invoked by the runtime — never assigned to a
 * variable in the hook's main body where an incidental log call could
 * catch it.
 */
export interface SecretHeaderSpec {
  readonly __secretHeaderSpec: true;
  readonly fieldKey: string;
  readonly format: (plaintext: string) => string;
}

export interface HttpRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string | SecretHeaderSpec>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Hard 10s total deadline (covers the one allowed redirect too, not
 * reset per hop), 1MB response cap, http/https only, and an SSRF guard
 * that resolves the hostname once and pins the connection to the
 * validated IP (closing the DNS-rebinding TOCTOU a naive
 * validate-then-reconnect implementation would leave open) — see
 * CLAUDE.md Phase 7 decisions, addendum A2, for the full design. Only
 * present on `ctx` when 'outbound-http' is a declared capability.
 */
export interface ScopedHttpClient {
  request(options: HttpRequestOptions): Promise<HttpResponse>;
}

export interface PluginLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface LeadCreateResult {
  inquiryId: string;
  applicantId: string;
  duplicateApplicantIds: string[];
}

export interface NormalizedLead {
  name: string;
  phone: string;
  email?: string;
  projectId?: string;
  note?: string;
}

/**
 * companyId is fixed at construction time and read-only — a plugin hook
 * has no way to widen or switch it. There is no `runWithTenant` or raw
 * Prisma reference anywhere on this object or reachable from it; a
 * plugin package has no dependency on @openestate/db at all, so there is
 * no import path to those primitives in the first place. See CLAUDE.md
 * Phase 7 decisions §2.
 */
export interface PluginContext<TConfig = Record<string, unknown>> {
  readonly companyId: string;
  /** Non-secret fields hold their real value; fields marked `secret: true`
   * in configFields hold a `SecretRef`, never plaintext. */
  readonly config: TConfig;
  readonly logger: PluginLogger;
  readonly http?: ScopedHttpClient;
  readonly leads?: { create(input: NormalizedLead): Promise<LeadCreateResult> };
  readonly applicants?: { findDuplicates(phone: string, email?: string): Promise<{ id: string; name: string }[]> };
  readonly companyConfig?: { getTerminology(): Promise<Record<string, string>> };
  /** Only valid for a fieldKey declared `secret: true` in configFields —
   * throws PluginCapabilityError otherwise. See SecretHeaderSpec. */
  secretHeader(fieldKey: string, format: (plaintext: string) => string): SecretHeaderSpec;
}

export interface PluginLifecycle<TConfig = Record<string, unknown>> {
  onInstall?(ctx: PluginContext<TConfig>): Promise<void>;
  onEnable?(ctx: PluginContext<TConfig>): Promise<void>;
  onDisable?(ctx: PluginContext<TConfig>): Promise<void>;
  onConfigChange?(ctx: PluginContext<TConfig>, previousConfig: TConfig): Promise<void>;
  onUninstall?(ctx: PluginContext<TConfig>): Promise<void>;
}

export interface OutboundMessage {
  channel: 'EMAIL' | 'SMS';
  toAddress: string;
  subject?: string;
  body: string;
}
export interface MessageSendResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
}
export interface MessagingHooks<TConfig> extends PluginLifecycle<TConfig> {
  send(ctx: PluginContext<TConfig>, message: OutboundMessage): Promise<MessageSendResult>;
}

export interface CallLogEvent {
  direction: 'INBOUND' | 'OUTBOUND';
  fromNumber: string;
  toNumber: string;
  startedAt: Date;
  durationSeconds: number;
  recordingUrl?: string;
}
export interface TelephonyHooks<TConfig> extends PluginLifecycle<TConfig> {
  parseWebhook(ctx: PluginContext<TConfig>, rawBody: unknown, headers: Record<string, string>): Promise<CallLogEvent | null>;
}

export interface LeadSourceHooks<TConfig> extends PluginLifecycle<TConfig> {
  /** Only needed when the generic field-mapping (core, not a plugin —
   * see the inbound lead API) can't express the source's payload, e.g. a
   * signed payload requiring verification before mapping. The common
   * case (99acres/MagicBricks/a generic webhook) needs no plugin at
   * all. */
  mapPayload(ctx: PluginContext<TConfig>, rawPayload: unknown, headers: Record<string, string>): Promise<NormalizedLead>;
}

export interface CustomFieldSeed {
  entityType: string;
  key: string;
  label: string;
  fieldType: string;
  isRequired: boolean;
  options?: string[];
}
export interface VerticalHooks<TConfig> extends PluginLifecycle<TConfig> {
  terminologyOverrides?: Record<string, string>;
  enabledModules?: string[];
  customFieldSeeds?: CustomFieldSeed[];
}

export interface Plugin<TConfig = Record<string, unknown>> {
  manifest: PluginManifest<TConfig>;
  hooks: PluginLifecycle<TConfig> &
    Partial<MessagingHooks<TConfig>> &
    Partial<TelephonyHooks<TConfig>> &
    Partial<LeadSourceHooks<TConfig>> &
    Partial<VerticalHooks<TConfig>>;
}

/** Thrown when plugin hook code accesses a `PluginContext` field for a
 * capability its manifest didn't declare. */
export class PluginCapabilityError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly capability: PluginCapability | string,
  ) {
    super(`plugin '${pluginId}' attempted to use '${capability}' without declaring it in capabilities`);
    this.name = 'PluginCapabilityError';
  }
}

/** What every plugin hook throw/timeout is converted to before it
 * reaches a caller — a plugin can never crash the request or the queue
 * worker that invoked it. See CLAUDE.md Phase 7 decisions §2. */
export class PluginExecutionError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly hook: string,
    public readonly companyId: string,
    message: string,
  ) {
    super(message);
    this.name = 'PluginExecutionError';
  }
}
