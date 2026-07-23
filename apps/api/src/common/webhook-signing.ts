import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA256 signing + replay protection for webhook delivery
 * (CLAUDE.md Phase 7 decisions §4). Pure functions, no I/O — reused in
 * both directions: signing OUTBOUND deliveries (WebhookDeliveryProcessor),
 * and available to the inbound lead API (§5, addendum A5) for a
 * signed-payload lead-source plugin to verify a vendor's webhook before
 * mapping it.
 *
 * Lives in apps/api, not packages/shared: packages/shared is imported by
 * apps/web and apps/portal's Vite builds via its `"import"` export
 * condition (raw TS source, no pre-build step — see CLAUDE.md Phase 1
 * decisions), and Node's `crypto` module has no browser-safe equivalent
 * there. Both real consumers (the delivery processor, the inbound lead
 * guard/fixture plugin) are apps/api-only, so there's no actual FE/BE
 * sharing need this file would serve by living in packages/shared.
 *
 * The signature covers `timestamp + '.' + body`, not the body alone, so
 * a captured signed payload cannot be replayed after the window closes.
 */
export function signWebhookPayload(secret: string, timestampMs: number, rawBody: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(`${timestampMs}.${rawBody}`);
  return hmac.digest('hex');
}

const DEFAULT_MAX_AGE_MS = 5 * 60_000;

export function verifyWebhookSignature(
  secret: string,
  timestampMs: number,
  rawBody: string,
  signature: string,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): boolean {
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > maxAgeMs) return false;
  const expected = signWebhookPayload(secret, timestampMs, rawBody);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
