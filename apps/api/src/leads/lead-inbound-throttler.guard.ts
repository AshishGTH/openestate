import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

export const LEAD_INBOUND_THROTTLER = 'lead-inbound';

/**
 * Per-key rate limit (not a global constant) — the named throttler's
 * `limit` is registered in app.module.ts as a resolver function reading
 * `req.leadApiKey.rateLimitPerMinute`, since LeadApiKeyGuard runs first
 * (guards execute in declaration order within one route) and populates
 * it. Same self-filtering pattern as Portal*ThrottlerGuard/
 * DefaultThrottlerGuard (Phase 6/7) — this bucket is registered in the
 * SAME single app.module.ts ThrottlerModule.forRoot([...]) call as every
 * other named throttler, never a second forRoot() call (the exact bug
 * class Phase 6 commit 4 fixed).
 */
@Injectable()
export class LeadInboundThrottlerGuard extends ThrottlerGuard {
  async onModuleInit() {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter((t) => t.name === LEAD_INBOUND_THROTTLER);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.leadApiKey?.id ?? req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }
}
