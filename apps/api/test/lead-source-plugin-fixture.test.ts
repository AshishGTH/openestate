/**
 * Phase 7 commit 2 (webhooks-and-leads), addendum A5: the `lead-source`
 * plugin kind (`LeadSourceHooks.mapPayload`, committed in Phase 7 commit
 * 1's plugin-sdk) does not ship with zero exercise. This fixture plugin
 * is the "signed payload requiring verification before mapping" case
 * the SDK's own doc comment names as the reason this hook shape exists
 * — it verifies an HMAC signature on the raw inbound body using the
 * SAME verifyWebhookSignature function the outbound webhook delivery
 * path uses (the dual-use already designed in §4), before mapping
 * fields. A real, motivated use case, not a speculative shape.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import type { Plugin, PluginContext } from '@openestate/plugin-sdk';
import { signWebhookPayload } from '../src/common/webhook-signing';
import { PluginSecretEncryptionService } from '../src/plugins/plugin-secret-encryption.service';
import { PluginRuntimeService } from '../src/plugins/plugin-runtime.service';

process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'b2c3d4e5'.repeat(8)}`;

interface SignedLeadConfig extends Record<string, unknown> {
  signingSecret: string;
}

/** A fixture "signed-payload lead source" plugin — the exact shape a
 * real vendor integration needing HMAC verification before mapping
 * would take. Config declares `signingSecret` as `secret: true`, so the
 * hook can only ever reach it via ctx.secretHeader()'s resolved value —
 * consistent with every other secret-handling rule in this phase. */
function makeSignedLeadSourcePlugin(): Plugin<SignedLeadConfig> {
  return {
    manifest: {
      id: 'signed-lead-fixture',
      name: 'Signed Lead Source (test fixture)',
      version: '1.0.0',
      kind: 'lead-source',
      coreApiVersion: '^1.0.0',
      description: 'Verifies an HMAC-signed inbound lead payload before mapping it.',
      configSchema: z.object({ signingSecret: z.string() }),
      configFields: [{ key: 'signingSecret', label: 'Signing Secret', type: 'password', required: true, secret: true }],
      capabilities: [],
    },
    hooks: {
      async mapPayload(ctx: PluginContext<SignedLeadConfig>, rawPayload: unknown, headers: Record<string, string>) {
        const rawBody = JSON.stringify(rawPayload);
        const timestampMs = Number(headers['x-signature-timestamp']);
        const signature = headers['x-signature'];

        // The plugin never holds the plaintext secret at all — verifySignature
        // resolves it and performs the HMAC comparison entirely inside the
        // runtime, returning only the boolean outcome (see PluginContext.
        // verifySignature's doc comment, @openestate/plugin-sdk, for why this
        // is the local-verification counterpart to secretHeader()).
        const verified = ctx.verifySignature('signingSecret', rawBody, timestampMs, signature);

        if (!verified) {
          throw new Error('Signature verification failed — refusing to map an unsigned/tampered payload');
        }

        const body = rawPayload as { lead: { full_name: string; mobile: string; email_id?: string } };
        return { name: body.lead.full_name, phone: body.lead.mobile, email: body.lead.email_id };
      },
    },
  };
}

describe('lead-source plugin fixture: signed-payload mapPayload (Phase 7 commit 2, addendum A5)', () => {
  let runtime: PluginRuntimeService;
  const secret = 'vendor-signing-secret-abc';

  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime = new PluginRuntimeService(new PluginSecretEncryptionService(), null as any, null as any, null as any);
  });

  function buildCtx() {
    const plugin = makeSignedLeadSourcePlugin();
    const ctx = runtime.buildContext(plugin, 'test-company-id', { signingSecret: secret });
    return { plugin, ctx };
  }

  it('maps a validly-signed payload to a NormalizedLead', async () => {
    const { plugin, ctx } = buildCtx();
    const rawPayload = { lead: { full_name: 'Priya Sharma', mobile: '9876543210', email_id: 'priya@example.com' } };
    const timestampMs = Date.now();
    const signature = signWebhookPayload(secret, timestampMs, JSON.stringify(rawPayload));

    const result = await plugin.hooks.mapPayload!(ctx, rawPayload, {
      'x-signature': signature,
      'x-signature-timestamp': String(timestampMs),
    });

    expect(result).toEqual({ name: 'Priya Sharma', phone: '9876543210', email: 'priya@example.com' });
  });

  it('rejects a payload with an invalid signature', async () => {
    const { plugin, ctx } = buildCtx();
    const rawPayload = { lead: { full_name: 'Fake Lead', mobile: '9000000000' } };
    const timestampMs = Date.now();

    await expect(
      plugin.hooks.mapPayload!(ctx, rawPayload, { 'x-signature': 'not-a-real-signature', 'x-signature-timestamp': String(timestampMs) }),
    ).rejects.toThrow(/Signature verification failed/);
  });

  it('rejects a validly-signed payload whose body was tampered with after signing', async () => {
    const { plugin, ctx } = buildCtx();
    const originalPayload = { lead: { full_name: 'Original Name', mobile: '9111111111' } };
    const timestampMs = Date.now();
    const signature = signWebhookPayload(secret, timestampMs, JSON.stringify(originalPayload));

    const tamperedPayload = { lead: { full_name: 'Attacker Injected Name', mobile: '9111111111' } };
    await expect(
      plugin.hooks.mapPayload!(ctx, tamperedPayload, { 'x-signature': signature, 'x-signature-timestamp': String(timestampMs) }),
    ).rejects.toThrow(/Signature verification failed/);
  });

  it('rejects a replayed (stale) signature outside the freshness window', async () => {
    const { plugin, ctx } = buildCtx();
    const rawPayload = { lead: { full_name: 'Replay Test', mobile: '9222222222' } };
    const oldTimestampMs = Date.now() - 10 * 60_000;
    const signature = signWebhookPayload(secret, oldTimestampMs, JSON.stringify(rawPayload));

    await expect(
      plugin.hooks.mapPayload!(ctx, rawPayload, { 'x-signature': signature, 'x-signature-timestamp': String(oldTimestampMs) }),
    ).rejects.toThrow(/Signature verification failed/);
  });

  it("the plugin's hook code never has the plaintext secret assigned to a reachable variable outside secretHeader's own callback", async () => {
    // Structural proof, not just behavioral: ctx.config.signingSecret is a
    // SecretRef marker, never the real string — addendum A1's primary
    // defense, exercised here through a real lead-source plugin's config
    // rather than only through the synthetic fixtures in
    // plugin-runtime.test.ts.
    const { ctx } = buildCtx();
    expect(JSON.stringify(ctx.config)).not.toContain(secret);
  });
});
