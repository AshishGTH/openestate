import { PrismaClient } from '@prisma/client';
import { tenantExtension } from './tenant.extension';
import { auditExtension } from './audit.extension';

export { PrismaClient } from '@prisma/client';
export { tenantExtension } from './tenant.extension';
export { auditExtension } from './audit.extension';
export { setTenantOnTx, withTenantTx } from './tenant.extension';
export type { WithTenantTxOptions } from './tenant.extension';
export {
  tenantContext,
  tenantTxContext,
  getCurrentCompanyId,
  getCurrentUserId,
  getCurrentIpAddress,
  runWithTenant,
} from './tenant-context';
export type { TenantStore, TenantTxStore } from './tenant-context';

let tenantPrisma: ReturnType<typeof createTenantPrismaClient> | undefined;
let systemPrisma: PrismaClient | undefined;

export function createTenantPrismaClient(url?: string) {
  const base = new PrismaClient(
    url ? { datasources: { db: { url } } } : undefined,
  );
  return base.$extends(tenantExtension()).$extends(auditExtension());
}

export function createSystemPrismaClient(url?: string) {
  return new PrismaClient(
    url ? { datasources: { db: { url } } } : undefined,
  );
}

export function getTenantPrisma() {
  if (!tenantPrisma) {
    tenantPrisma = createTenantPrismaClient();
  }
  return tenantPrisma;
}

export function getSystemPrisma() {
  if (!systemPrisma) {
    systemPrisma = createSystemPrismaClient(
      process.env.DATABASE_URL_SYSTEM ?? process.env.DATABASE_URL,
    );
  }
  return systemPrisma;
}
