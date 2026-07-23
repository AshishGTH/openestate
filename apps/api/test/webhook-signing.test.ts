/**
 * Phase 7 commit 2 (webhooks-and-leads): HMAC-SHA256 signing + replay
 * protection — pure functions, no I/O, same fast DB-independent tier as
 * plugin-registry.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { signWebhookPayload, verifyWebhookSignature } from '../src/common/webhook-signing';

describe('webhook-signing (Phase 7 commit 2)', () => {
  const secret = 'super-secret-signing-key';
  const body = JSON.stringify({ event: 'booking.created', bookingId: 'abc-123' });

  it('verifyWebhookSignature accepts a signature produced by signWebhookPayload for the same inputs', () => {
    const timestampMs = Date.now();
    const signature = signWebhookPayload(secret, timestampMs, body);
    expect(verifyWebhookSignature(secret, timestampMs, body, signature)).toBe(true);
  });

  it('rejects a signature computed with a different secret', () => {
    const timestampMs = Date.now();
    const signature = signWebhookPayload('a-different-secret', timestampMs, body);
    expect(verifyWebhookSignature(secret, timestampMs, body, signature)).toBe(false);
  });

  it('rejects a signature computed against a different body (payload tampering)', () => {
    const timestampMs = Date.now();
    const signature = signWebhookPayload(secret, timestampMs, body);
    const tamperedBody = JSON.stringify({ event: 'booking.created', bookingId: 'attacker-controlled' });
    expect(verifyWebhookSignature(secret, timestampMs, tamperedBody, signature)).toBe(false);
  });

  it('replay protection: rejects a validly-signed payload once the timestamp is outside the max-age window', () => {
    const oldTimestampMs = Date.now() - 10 * 60_000; // 10 minutes ago
    const signature = signWebhookPayload(secret, oldTimestampMs, body);
    expect(verifyWebhookSignature(secret, oldTimestampMs, body, signature, 5 * 60_000)).toBe(false);
  });

  it('replay protection: accepts a timestamp within the max-age window', () => {
    const recentTimestampMs = Date.now() - 60_000; // 1 minute ago
    const signature = signWebhookPayload(secret, recentTimestampMs, body);
    expect(verifyWebhookSignature(secret, recentTimestampMs, body, signature, 5 * 60_000)).toBe(true);
  });

  it('rejects a timestamp from the future beyond the max-age window (clock-skew abuse, not just past replay)', () => {
    const futureTimestampMs = Date.now() + 10 * 60_000;
    const signature = signWebhookPayload(secret, futureTimestampMs, body);
    expect(verifyWebhookSignature(secret, futureTimestampMs, body, signature, 5 * 60_000)).toBe(false);
  });

  it('the signature covers timestamp + body together, not the body alone — the same body signed at two different timestamps produces different signatures', () => {
    const t1 = Date.now();
    const t2 = t1 + 1000;
    expect(signWebhookPayload(secret, t1, body)).not.toBe(signWebhookPayload(secret, t2, body));
  });

  it('rejects a non-finite/garbage timestamp rather than throwing', () => {
    expect(verifyWebhookSignature(secret, NaN, body, 'deadbeef')).toBe(false);
  });
});
