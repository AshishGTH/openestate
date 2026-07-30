/**
 * Regression coverage for the new LetterTemplateService/Controller — this
 * master previously had no working create path at all: it was routed
 * through the generic master factory, whose schema doesn't have
 * subject/entityType/body (LetterTemplate's actual required Prisma
 * columns), so every create attempt 500'd with "Argument `subject` is
 * missing" (or, once description was fixed, would have failed on
 * `entityType`/`body` too). Zero letter templates could ever exist,
 * blocking demand/allotment/reminder letter generation entirely.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { LetterTemplateService } from '../src/masters/letter-template/letter-template.service';
import { createLetterTemplateSchema } from '@openestate/shared';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

describe('createLetterTemplateSchema — merge-field validation', () => {
  it('accepts a body whose {{tokens}} are all in the DEMAND_LETTER registry', () => {
    const result = createLetterTemplateSchema.safeParse({
      name: 'Demand', subject: 'Payment due', entityType: 'DEMAND_LETTER',
      body: 'Dear {{applicantName}}, {{dueAmountFormatted}} is due {{dueDate}}.',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a body with a token not in the registry for that entityType', () => {
    const result = createLetterTemplateSchema.safeParse({
      name: 'Bad', subject: 'x', entityType: 'DEMAND_LETTER',
      body: 'Hello {{totallyMadeUpField}}',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a token valid for a DIFFERENT document type (registries are per-type, not global)', () => {
    // brokerName is only in the BROKER_STATEMENT registry, not DEMAND_LETTER.
    const result = createLetterTemplateSchema.safeParse({
      name: 'Cross-type', subject: 'x', entityType: 'DEMAND_LETTER',
      body: 'Hello {{brokerName}}',
    });
    expect(result.success).toBe(false);
  });
});

describeIf('LetterTemplateService (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let service: LetterTemplateService;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    service = new LetterTemplateService(tenantPrisma, systemPrisma);
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('create() persists name/subject/entityType/body — the fields the Prisma model actually requires', async () => {
    const created = await service.create(fx.companyId, {
      name: 'QA Demand Letter',
      subject: 'Payment due for {{bookingNumber}}',
      entityType: 'DEMAND_LETTER',
      body: 'Dear {{applicantName}}, please pay {{dueAmountFormatted}}.',
      isActive: true,
      sortOrder: 0,
    });
    expect(created.id).toBeTruthy();
    expect(created.subject).toBe('Payment due for {{bookingNumber}}');
    expect(created.entityType).toBe('DEMAND_LETTER');
  });
});
