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

export function runWithTenant<T>(store: TenantStore, fn: () => T): T {
  return tenantContext.run(store, fn);
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
