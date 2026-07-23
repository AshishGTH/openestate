import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * The root `APP_GUARD` throttler, filtered to only the unnamed/'default'
 * bucket (AppModule's own `ThrottlerModule.forRoot([{ ttl, limit }])`, no
 * `name`, which the base class normalizes to `'default'` in its own
 * `onModuleInit()`).
 *
 * Real bug this fixes (Phase 6 commit 4, caught by the portal-read
 * rate-limit test, not by review): `@nestjs/throttler`'s `ThrottlerModule`
 * is decorated `@Global()` — every `ThrottlerModule.forRoot(...)` call
 * anywhere in the module graph (this app has two: AppModule's own default
 * bucket, and PortalAuthModule's `portal-auth`/`portal-read` buckets)
 * contributes to the SAME global `THROTTLER_OPTIONS` provider set. The
 * plain `ThrottlerGuard` used directly as the root `APP_GUARD` never
 * filters `this.throttlers` (unlike `PortalAuthThrottlerGuard`/
 * `PortalReadThrottlerGuard`, which each filter themselves to one named
 * entry) — so it ended up iterating ALL THREE registered throttlers
 * (`default`, `portal-auth`, `portal-read`) on EVERY route in the entire
 * application, including staff routes. In practice this meant the tiny
 * `portal-auth` bucket (5 requests/5 minutes) was being enforced
 * globally, e.g. blocking a portal-read route (`GET /portal/profile`,
 * meant to be governed only by the 60/minute `portal-read` bucket) after
 * only a handful of requests — the exact opposite of "staff/other-portal
 * routes are structurally unreachable by either narrow bucket" that
 * CLAUDE.md's Phase 6 commit 1 decisions claimed. Filtering this guard to
 * `'default'` only, mirroring the pattern the portal guards already use,
 * makes that claim actually true regardless of the `@Global()`
 * cross-module collision under the hood.
 */
@Injectable()
export class DefaultThrottlerGuard extends ThrottlerGuard {
  async onModuleInit() {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter((t) => t.name === 'default');
  }
}
