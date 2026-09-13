import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

export const TOTP_VERIFY_THROTTLER = 'totp-verify';

/**
 * Caps second-factor attempts on BOTH totp/verify endpoints (staff and
 * portal), per user. Same shape as PasswordChangeThrottlerGuard.
 *
 * Keyed by the tempToken's `sub`, not the client IP: route guards run after
 * the global JwtAuthGuard, so req.user is the verified token, and its `sub`
 * can't be forged. A per-user key means rotating IPs buys an attacker
 * nothing, and colleagues behind one office NAT address don't share a
 * budget. The IP fallback is unreachable on verify (never @Public) and only
 * there so the guard can't throw.
 *
 * A recovery code goes to the same endpoint, so it spends from the same
 * budget — one request, one guess, whichever kind of code it is.
 */
@Injectable()
export class TotpVerifyThrottlerGuard extends ThrottlerGuard {
  async onModuleInit() {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter((t) => t.name === TOTP_VERIFY_THROTTLER);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.user?.sub ?? req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }
}
