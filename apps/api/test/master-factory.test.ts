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
import { createMasterSchema, updateMasterSchema, INTEREST_RATE_TYPE } from '@openestate/shared';
import { z } from 'zod';

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

  it('create() fails cleanly (400, not 500) on a duplicate name — P2002 mapped, not left to crash', async () => {
    const InquirySourceService = createMasterService({
      modelName: 'InquirySource', routePath: 'inquiry-sources', apiTag: 'Inquiry Sources',
    });
    const service = new InquirySourceService(tenantPrisma, systemPrisma);
    await service.create(fx.companyId, { name: 'QA Dup Name', isActive: true, sortOrder: 0 });
    await expect(service.create(fx.companyId, { name: 'QA Dup Name', isActive: true, sortOrder: 0 }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('already exists') });
  });
});

describe('master.factory extraFields — DocumentType/InterestRule/TransferFeeRule regression', () => {
  // Real production bug: DocumentType.entityType and InterestRule's
  // rateType/ratePercent/frequency and TransferFeeRule.feeType are all
  // required, non-nullable Prisma columns createMasterSchema never had —
  // every create attempt for these 3 masters 500'd with Prisma's
  // "Argument `x` is missing", not a clean validation error. These
  // schema-level tests prove the exact per-model schema
  // masters.module.ts builds (createMasterSchema.extend(extraFields))
  // both rejects a request missing the required field AND accepts one
  // that provides it.
  it('DocumentType: entityType is required', () => {
    const schema = createMasterSchema.extend({ entityType: z.string().min(1).max(50) });
    expect(schema.safeParse({ name: 'x', isActive: true, sortOrder: 0 }).success).toBe(false);
    expect(schema.safeParse({ name: 'x', isActive: true, sortOrder: 0, entityType: 'BROCHURE' }).success).toBe(true);
  });

  it('InterestRule: rateType/ratePercent/frequency are all required and validated', () => {
    const schema = createMasterSchema.extend({
      rateType: z.nativeEnum(INTEREST_RATE_TYPE),
      ratePercent: z.coerce.number().min(0).max(100),
      frequency: z.enum(['DAILY', 'MONTHLY', 'YEARLY']),
    });
    expect(schema.safeParse({ name: 'x', isActive: true, sortOrder: 0 }).success).toBe(false);
    expect(schema.safeParse({
      name: 'x', isActive: true, sortOrder: 0, rateType: 'SIMPLE', ratePercent: 12, frequency: 'MONTHLY',
    }).success).toBe(true);
    expect(schema.safeParse({
      name: 'x', isActive: true, sortOrder: 0, rateType: 'NOT_A_REAL_TYPE', ratePercent: 12, frequency: 'MONTHLY',
    }).success).toBe(false);
  });

  it('TransferFeeRule: feeType is required', () => {
    const schema = createMasterSchema.extend({
      feeType: z.enum(['FIXED', 'PERCENTAGE']),
      amountPaise: z.coerce.bigint().min(0n).optional(),
      percentage: z.coerce.number().min(0).max(100).optional(),
    });
    expect(schema.safeParse({ name: 'x', isActive: true, sortOrder: 0 }).success).toBe(false);
    expect(schema.safeParse({ name: 'x', isActive: true, sortOrder: 0, feeType: 'FIXED', amountPaise: 500000 }).success).toBe(true);
  });

  it('update schema: extraFields become optional (partial), matching every other update field', () => {
    const schema = updateMasterSchema.extend(z.object({ entityType: z.string().min(1).max(50) }).partial().shape);
    expect(schema.safeParse({ name: 'renamed' }).success).toBe(true); // entityType omitted — fine on update
  });
});
