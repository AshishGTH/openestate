/**
 * Regression test for a real production bug (found via a live native-install
 * exercise, not by review): createMasterSchema's optional `description`
 * field is only backed by a real Prisma column on PaymentPlanTemplate —
 * every other SIMPLE_MASTERS model threw PrismaClientValidationError
 * ("Unknown argument `description`") whenever a caller provided one, since
 * create()/update() spread the whole dto into Prisma's `data`. 18 of 19
 * master types 500'd on any create call that included a description.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { createMasterService } from '../src/masters/master.factory';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

describeIf('master.factory — description field stripping (Unknown argument regression)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('create() with a description does NOT throw for a model with no description column (InquirySource)', async () => {
    const InquirySourceService = createMasterService({
      modelName: 'InquirySource',
      routePath: 'inquiry-sources',
      apiTag: 'Inquiry Sources',
    });
    const service = new InquirySourceService(tenantPrisma, systemPrisma);
    const created = await service.create(fx.companyId, {
      name: 'QA Regression Source',
      description: 'This field does not exist on InquirySource and used to 500',
      isActive: true,
      sortOrder: 0,
    });
    expect(created.id).toBeTruthy();
    expect(created.name).toBe('QA Regression Source');
    expect(created).not.toHaveProperty('description');
  });

  it('update() with a description also does not throw for the same model', async () => {
    const InquirySourceService = createMasterService({
      modelName: 'InquirySource',
      routePath: 'inquiry-sources',
      apiTag: 'Inquiry Sources',
    });
    const service = new InquirySourceService(tenantPrisma, systemPrisma);
    const created = await service.create(fx.companyId, { name: 'QA Update Target', isActive: true, sortOrder: 0 });
    const updated = await service.update(fx.companyId, created.id, {
      name: 'QA Update Target (renamed)',
      description: 'still not a real column',
    });
    expect(updated.name).toBe('QA Update Target (renamed)');
  });

  it('create() with a description DOES persist it for PaymentPlanTemplate, which opts in via supportsDescription', async () => {
    const PaymentPlanTemplateService = createMasterService({
      modelName: 'PaymentPlanTemplate',
      routePath: 'payment-plan-templates',
      apiTag: 'Payment Plan Templates',
      supportsDescription: true,
    });
    const service = new PaymentPlanTemplateService(tenantPrisma, systemPrisma);
    const created = await service.create(fx.companyId, {
      name: 'QA Plan With Description',
      description: 'a real column on this model',
      isActive: true,
      sortOrder: 0,
    });
    expect(created.description).toBe('a real column on this model');
  });
});
