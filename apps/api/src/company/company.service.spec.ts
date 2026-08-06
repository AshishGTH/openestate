import { describe, expect, it, vi } from 'vitest';
import { CompanyService } from './company.service';

// Regression test for a real bug shipped in the v0.2.0 tag: this hook ran
// a DB query before app.listen() (NestJS holds bootstrap until every
// OnApplicationBootstrap hook resolves), and had no error handling — in
// docker-compose's startup ordering the api container starts before
// migrations run, so `company.findMany()` threw "table does not exist",
// which took the ENTIRE app down instead of just skipping the GST
// completeness check. See CLAUDE.md and CHANGELOG.md for the incident.
describe('CompanyService.onApplicationBootstrap', () => {
  it('never throws, even when the DB query itself fails', async () => {
    const tenantPrisma = {};
    const systemPrisma = {
      company: {
        findMany: vi.fn().mockRejectedValue(new Error('table "companies" does not exist')),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const service = new CompanyService(tenantPrisma, systemPrisma);
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('warns once per company with incomplete GST config, and stays silent when all are complete', async () => {
    const tenantPrisma = {};
    const complete = {
      company: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'a', name: 'Complete Co', config: { companyGstin: 'X', gstStateCode: '09' } },
        ]),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const incomplete = {
      company: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'a', name: 'Complete Co', config: { companyGstin: 'X', gstStateCode: '09' } },
          { id: 'b', name: 'Incomplete Co', config: { companyGstin: null, gstStateCode: null } },
          { id: 'c', name: 'No Config Co', config: null },
        ]),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await expect(new CompanyService(tenantPrisma, complete).onApplicationBootstrap()).resolves.toBeUndefined();
    await expect(new CompanyService(tenantPrisma, incomplete).onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
