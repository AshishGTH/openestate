import { Logger } from '@nestjs/common';
import type { PluginLogger } from '@openestate/plugin-sdk';

/**
 * Backstop only — the primary defense is that plugin hook code never
 * holds a secret's plaintext at all (see SecretRef/secretHeader in
 * @openestate/plugin-sdk and CLAUDE.md Phase 7 decisions, addendum A1).
 * This scrubber exists for the residual case where a plaintext value
 * leaks into a caught error message or similar incidental path — it
 * does an exact-substring replace against the real secret values for
 * THIS installation, which does NOT catch derived forms (base64,
 * truncated, HMAC output, URL-encoded). That limitation is accepted and
 * documented, not silently assumed away.
 */
export function createScrubbingLogger(pluginId: string, companyId: string, secretValues: ReadonlySet<string>): PluginLogger {
  const base = new Logger(`plugin:${pluginId}`);
  const scrub = (text: string): string => {
    let out = text;
    for (const secret of secretValues) {
      if (secret.length === 0) continue;
      out = out.split(secret).join('[REDACTED]');
    }
    return out;
  };
  const scrubMeta = (meta?: Record<string, unknown>): Record<string, unknown> | undefined => {
    if (!meta) return meta;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      out[k] = typeof v === 'string' ? scrub(v) : v;
    }
    return out;
  };

  return {
    debug: (message, meta) => base.debug({ companyId, ...scrubMeta(meta) }, scrub(message)),
    info: (message, meta) => base.log({ companyId, ...scrubMeta(meta) }, scrub(message)),
    warn: (message, meta) => base.warn({ companyId, ...scrubMeta(meta) }, scrub(message)),
    error: (message, meta) => base.error({ companyId, ...scrubMeta(meta) }, scrub(message)),
  };
}
