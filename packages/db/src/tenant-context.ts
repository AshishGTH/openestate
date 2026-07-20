import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';

export interface TenantStore {
  companyId: string;
  userId?: string;
  ipAddress?: string;
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

export function runWithTenant<T>(store: TenantStore, fn: () => T): T {
  return tenantContext.run(store, fn);
}
