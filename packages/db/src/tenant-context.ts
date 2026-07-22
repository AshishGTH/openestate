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
