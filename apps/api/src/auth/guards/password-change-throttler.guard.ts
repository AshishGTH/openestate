import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

export const PASSWORD_CHANGE_THROTTLER = 'password-change';

/**
 * Applied to staff change-password, portal change-password, and the staff
 * password-reset confirm endpoint (mirrors PortalReadThrottlerGuard's
 * shape/tracker). The 'password-change' limit (5 per 300s) is one configured
 * setting, but @nestjs/throttler keys every counter by controller, handler,
 * throttler name and tracker — so each route handler keeps its own counter,
 * per user id when authenticated (change-password) or per IP for the public
 * confirm endpoint. One guard class, not one bucket shared across the routes.
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
