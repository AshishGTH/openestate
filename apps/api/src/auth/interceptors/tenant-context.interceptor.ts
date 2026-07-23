import { Injectable, type NestInterceptor, type ExecutionContext, type CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { runWithTenant, type TenantStore } from '@openestate/db';
import type { JwtPayload } from '@openestate/shared';

/**
 * Replaces the earlier `TenantContextGuard` attempt (removed — see
 * CLAUDE.md Phase 6 commit 2 decisions for the full story).
 *
 * That guard called `enterTenantContext()` (AsyncLocalStorage.enterWith)
 * from a Guard positioned after JwtAuthGuard. It was proven, empirically,
 * NOT to work: a debug trace showed `tenantContext.getStore()` was
 * already `undefined` by the time a query ran inside
 * `prisma.$transaction()`'s callback, even though the guard had called
 * `enterWith()` moments earlier in the same request. Root cause:
 * `enterWith()` mutates the store for the CURRENT execution's
 * continuations, but any async resource that Prisma's `$transaction()`
 * schedules its callback through appears to capture its OWN parent
 * context at a point not chained from the guard's mutation — `.run()`
 * does not have this problem because it explicitly re-establishes the
 * store at the moment the wrapped callback is invoked, and every async
 * resource created synchronously inside that callback (including
 * `prisma.$transaction()` itself) correctly inherits it.
 *
 * This interceptor uses `.run()` instead, via the `runWithTenant`
 * helper, wrapping `next.handle()` — the call that actually triggers
 * pipe validation, the controller method, and everything downstream.
 * Interceptors run after ALL guards (Nest's fixed pipeline order:
 * middleware → guards → interceptors → pipes → handler), so `req.user`
 * (set by JwtAuthGuard) is guaranteed populated here, same guarantee the
 * guard approach relied on.
 *
 * The `next.handle().subscribe(subscriber)` call must happen INSIDE the
 * `runWithTenant` callback, not merely be returned from it — Nest's
 * `next.handle()` synchronously kicks off pipe+handler execution up to
 * its first `await` (it does not lazily defer until an external
 * `.subscribe()` call), so the store must be active at the moment
 * `next.handle()` itself is called for the handler's async resources
 * (Prisma transactions included) to capture it correctly.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtPayload | undefined;

    if (!user?.companyId) {
      return next.handle();
    }

    const store: TenantStore = {
      companyId: user.companyId,
      userId: user.sub,
      ipAddress: request.ip ?? request.socket?.remoteAddress,
      // Explicit, not omitted — see TenantStore's own doc comment. A
      // staff JWT never carries applicantId/brokerId, so these
      // naturally resolve to undefined for staff sessions; a portal
      // JWT carries exactly one.
      portalApplicantId: user.applicantId,
      portalBrokerId: user.brokerId,
    };

    return new Observable((subscriber) => {
      runWithTenant(store, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}
