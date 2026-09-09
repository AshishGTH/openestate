import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

export const PORTAL_AUTH_THROTTLER = 'portal-auth';
export const PORTAL_READ_THROTTLER = 'portal-read';

/**
 * Both named buckets are registered in the root AppModule's single,
 * application-wide ThrottlerModule.forRootAsync call — NOT here.
 * PortalAuthModule used to call ThrottlerModule.forRoot() itself, which
 * was a real bug: ThrottlerModule is @Global(), so a second registration
 * competed with AppModule's own and which one a given consumer resolved
 * was compile-order-dependent (see DefaultThrottlerGuard's doc comment
 * and portal-auth.module.ts's). Because that one registration is shared,
 * `this.throttlers` after onModuleInit() contains EVERY bucket in the
 * app, so each guard below filters itself down to just its own named
 * entry rather than relying on @SkipThrottle() decorators scattered
 * across every route — attach the guard, get exactly one bucket
 * enforced, regardless of what else is registered alongside it.
 *
 * Scoped locally (not an APP_GUARD) so staff routes are never touched by
 * these limits — see CLAUDE.md Phase 6 decisions on why this isn't wired
 * globally.
 */
@Injectable()
export class PortalAuthThrottlerGuard extends ThrottlerGuard {
  async onModuleInit() {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter((t) => t.name === PORTAL_AUTH_THROTTLER);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }
}

@Injectable()
export class PortalReadThrottlerGuard extends ThrottlerGuard {
  async onModuleInit() {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter((t) => t.name === PORTAL_READ_THROTTLER);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.user?.sub ?? req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }
}
