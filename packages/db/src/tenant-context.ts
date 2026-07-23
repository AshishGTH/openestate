import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';

export interface TenantStore {
  companyId: string;
  userId?: string;
  ipAddress?: string;
  // Phase 6: set only for a customer/broker portal session — never
  // both, never alongside a staff session. TenantMiddleware explicitly
  // passes both as undefined for staff requests (not omitted) so a
  // future refactor of the store-building code can't accidentally
  // start forwarding a stale value.
  portalApplicantId?: string;
  portalBrokerId?: string;
}

export interface TenantTxStore {
  tx: Prisma.TransactionClient;
  companyId: string;
}

export const tenantContext = new AsyncLocalStorage<TenantStore>();
export const tenantTxContext = new AsyncLocalStorage<TenantTxStore>();

export function getCurrentCompanyId(): string | undefined {
  return tenantContext.getStore()?.companyId;
}

export function getCurrentUserId(): string | undefined {
  return tenantContext.getStore()?.userId;
}

export function getCurrentIpAddress(): string | undefined {
  return tenantContext.getStore()?.ipAddress;
}

export function getCurrentPortalApplicantId(): string | undefined {
  return tenantContext.getStore()?.portalApplicantId;
}

export function getCurrentPortalBrokerId(): string | undefined {
  return tenantContext.getStore()?.portalBrokerId;
}

/**
 * Structural guardrail (Phase 6 commit 4, after a real fail-open IDOR in
 * NocService.approve()/reject(): a bare self-wrapped `runWithTenant({
 * companyId })` silently SHADOWED the ambient portalBrokerId, and the
 * resulting empty portal GUCs hit the RLS policy's staff-passthrough
 * branch — a portal session briefly got staff-level visibility, not
 * merely narrower access. This falsifies Phase 6 commit 2's "staff
 * self-wrapping is harmless redundancy" note: it is harmless ONLY when
 * the call site is never reachable from a portal-authenticated request.
 * There is no way to verify that property by reading one service in
 * isolation — it depends on which controllers happen to call it, today
 * and in the future. So `runWithTenant` itself now refuses the specific
 * shape of call that caused the bug: replacing an active portal scope
 * for the SAME company with anything other than that exact scope.
 * Cross-company re-wrapping (system jobs enumerating companies) is
 * unaffected — the check only fires when `store.companyId` matches the
 * ambient store's, which a genuine cross-tenant job never does.
 */
export function runWithTenant<T>(store: TenantStore, fn: () => T): T {
  const existing = tenantContext.getStore();
  if (
    existing &&
    existing.companyId === store.companyId &&
    (existing.portalApplicantId || existing.portalBrokerId) &&
    (existing.portalApplicantId !== store.portalApplicantId || existing.portalBrokerId !== store.portalBrokerId)
  ) {
    throw new Error(
      'runWithTenant: refusing to widen an active portal scope — ' +
        `ambient store for company ${existing.companyId} carries ` +
        `portalApplicantId=${existing.portalApplicantId ?? 'none'} portalBrokerId=${existing.portalBrokerId ?? 'none'}, ` +
        `the new store would replace it with ` +
        `portalApplicantId=${store.portalApplicantId ?? 'none'} portalBrokerId=${store.portalBrokerId ?? 'none'}. ` +
        'Use runScoped() to reuse the ambient context, or explicitly preserve ' +
        'portalApplicantId/portalBrokerId in the new store.',
    );
  }
  return tenantContext.run(store, fn);
}

/**
 * The blessed helper for any service method that is reachable from BOTH
 * a staff call site (which has historically self-wrapped its own
 * `runWithTenant({ companyId })` for direct-call-test convenience) AND a
 * portal-facing call site — reuses the ambient tenant context when one
 * is already active for this companyId instead of unconditionally
 * shadowing it. Promoted here from NocService (Phase 6 commit 3, the
 * first real bug this pattern caused) so every future dual-purpose
 * service reuses one implementation instead of reinventing it — see
 * CLAUDE.md Phase 6 commit 4 decisions.
 *
 * Falls back to `runWithTenant({ companyId })` only when there is no
 * ambient context for this companyId at all (e.g. a direct
 * `new XxxService(...)` call in a test with no enclosing
 * `runWithTenant`), preserving that existing test-call contract
 * unchanged.
 */
export function runScoped<T>(companyId: string, fn: () => T): T {
  if (getCurrentCompanyId() === companyId) return fn();
  return runWithTenant({ companyId }, fn);
}

/**
 * Establishes the tenant store for the REST of the current async chain,
 * without wrapping it in a callback — for use from a NestJS Guard, which
 * only returns a boolean and has no callback to wrap around the
 * downstream interceptors/pipes/controller.
 *
 * Uses AsyncLocalStorage.enterWith rather than .run(): `run()` needs a
 * function to wrap, so the store would only be visible for the duration
 * of that synchronous call and then be gone. `enterWith()` instead
 * mutates the CURRENT execution's async context in place — Node's
 * documented pattern for exactly this "framework code runs before the
 * handler it doesn't control" case. Because each incoming HTTP request
 * starts its own async execution chain, this only ever affects that one
 * request's continuations, never other concurrent requests on the same
 * process (see TenantContextGuard in apps/api for the call site and the
 * bug this replaced — CLAUDE.md Phase 6 commit 2 decisions).
 */
export function enterTenantContext(store: TenantStore): void {
  tenantContext.enterWith(store);
}
