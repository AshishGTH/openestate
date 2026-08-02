import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

export const PASSWORD_CHANGE_THROTTLER = 'password-change';

/**
 * Shared across staff change-password, portal change-password, and the
 * staff password-reset confirm endpoint (mirrors PortalReadThrottlerGuard's
 * shape/tracker). Tracked by user id when authenticated (change-password),
 * falling back to IP for the public, unauthenticated confirm endpoint —
 * one bucket, one guard, reused by all three rather than a guard per route.
 */
@Injectable()
export class PasswordChangeThrottlerGuard extends ThrottlerGuard {
  async onModuleInit() {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter((t) => t.name === PASSWORD_CHANGE_THROTTLER);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.user?.sub ?? req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }
}
