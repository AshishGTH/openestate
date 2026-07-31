/**
 * Through-the-wire (real HTTP, real guard pipeline) creation coverage for
 * every master type and every other admin-creatable entity.
 *
 * Standing gap this file closes: every existing master/admin test in this
 * suite either seeds rows directly via Prisma or calls a service method
 * directly, never a real POST through ZodValidationPipe + PermissionsGuard
 * + the actual controller. That gap is exactly why five setup-blocking
 * bugs (18-of-19 masters 500ing on any description field, DocumentType/
 * InterestRule/TransferFeeRule missing required columns, LetterTemplate
 * having no working create path at all) shipped to a tagged release
 * before a manual browser click-through caught them — direct-service
 * tests exercise the same Prisma call the bug was in, so they can't catch
 * a bug that's specifically about the HTTP-to-service boundary (Zod
 * validation shape, `.strict()` rejecting/accepting fields, the factory's
 * config-driven schema extension). See e2e-portal.test.ts's doc comment
 * for the same class of pipeline-ordering gap this mirrors.
 *
 * Requires the compiled dist/ — see e2e-portal.test.ts for why.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from 'argon2';
import { ALL_PERMISSIONS, PERMISSIONS } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const STAFF_PASSWORD = 'StaffPass123';
const TAG = Date.now();

// main.ts patches BigInt.prototype.toJSON so money fields (this file hits
// it via TransferFeeRule.amountPaise/TdsRule.thresholdPaise) serialize
// instead of crashing `JSON.stringify` — but every e2e-*.test.ts file
// bootstraps AppModule directly (see the dist/ comment below), never
// executing main.ts, so without this the two BigInt-bearing master types
// 500 in tests while working fine in the real, main.ts-booted app. Applied
// here for test/production parity, not because it's a real product bug.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function (this: bigint) {
  return this.toString();
};

async function bootstrapApp(): Promise<INestApplication> {
  process.env.DATABASE_URL = APP_URL;
  process.env.DATABASE_URL_SYSTEM = SYSTEM_URL;
  process.env.REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6380';
  process.env.JWT_ACCESS_SECRET ??= 'e2e-test-access-secret-0123456789';
  process.env.JWT_REFRESH_SECRET ??= 'e2e-test-refresh-secret-0123456789';
  process.env.PAN_ENCRYPTION_KEY ??= 'a1b2c3d4'.repeat(8);
  process.env.TOTP_ENCRYPTION_KEY ??= 'e5f6a7b8'.repeat(8);
  process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'c9d8e7f6'.repeat(8)}`;
  process.env.CORS_ALLOWLIST ??= 'http://localhost:5174';
  process.env.SWAGGER_ENABLED = 'false';

  const require = createRequire(import.meta.url);
  const { AppModule } = require('../dist/app.module');

  const nestApp = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  nestApp.use(helmet());
  nestApp.use(cookieParser());
  nestApp.setGlobalPrefix('api/v1');
  nestApp.useGlobalPipes(new ZodValidationPipe());
  await nestApp.init();
  return nestApp;
}

// One master-type case per real route. `payload` deliberately includes
// every optional field the schema accepts (not just the required ones) —
// the bug class this file guards against was never about the required
// fields, which every direct-service test already covered.
interface MasterCase {
  label: string;
  path: string;
  payload: Record<string, unknown>;
  // Extra response-body assertions beyond "has an id and the name matches".
  assertExtra?: (body: Record<string, unknown>) => void;
}

const simpleBase = (extra: Record<string, unknown> = {}) => ({
  name: `E2E ${TAG}`,
  description: 'E2E optional description',
  isActive: true,
  sortOrder: 1,
  ...extra,
});

const MASTER_CASES: MasterCase[] = [
  { label: 'UnitType', path: 'unit-types', payload: simpleBase() },
  { label: 'PlcType', path: 'plc-types', payload: simpleBase() },
  { label: 'InquirySource', path: 'inquiry-sources', payload: simpleBase() },
  { label: 'InquiryType', path: 'inquiry-types', payload: simpleBase() },
  { label: 'InquiryTemperature', path: 'inquiry-temperatures', payload: simpleBase() },
  { label: 'FollowUpType', path: 'follow-up-types', payload: simpleBase() },
  { label: 'CommunicationType', path: 'communication-types', payload: simpleBase() },
  { label: 'ProjectType', path: 'project-types', payload: simpleBase() },
  { label: 'ReceiptType', path: 'receipt-types', payload: simpleBase() },
  { label: 'RegistrationType', path: 'registration-types', payload: simpleBase() },
  { label: 'AreaLocation', path: 'area-locations', payload: simpleBase() },
  {
    label: 'DocumentType',
    path: 'document-types',
    payload: simpleBase({ entityType: 'BOOKING_KYC' }),
    assertExtra: (b) => expect(b.entityType).toBe('BOOKING_KYC'),
  },
  { label: 'Bank', path: 'banks', payload: simpleBase() },
  { label: 'ChargeType', path: 'charge-types', payload: simpleBase() },
  {
    label: 'InterestRule',
    path: 'interest-rules',
    payload: simpleBase({ rateType: 'SIMPLE', ratePercent: 2.5, frequency: 'MONTHLY' }),
    assertExtra: (b) => {
      expect(b.rateType).toBe('SIMPLE');
      expect(b.frequency).toBe('MONTHLY');
    },
  },
  {
    label: 'TransferFeeRule',
    path: 'transfer-fee-rules',
    payload: simpleBase({ feeType: 'FIXED', amountPaise: 50000 }),
    assertExtra: (b) => expect(b.feeType).toBe('FIXED'),
  },
  {
    label: 'PaymentPlanTemplate',
    path: 'payment-plan-templates',
    payload: simpleBase(),
    // The one SIMPLE_MASTERS model whose Prisma model actually has a
    // `description` column — every other case above deliberately sends
    // description too, but only this one should echo it back.
    assertExtra: (b) => expect(b.description).toBe('E2E optional description'),
  },
  { label: 'TicketCategory', path: 'ticket-categories', payload: simpleBase() },
  {
    label: 'GstRate',
    path: 'gst-rates',
    payload: {
      rate: 18,
      description: 'GST 18% — E2E',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31',
      isActive: true,
      sortOrder: 1,
    },
    // Prisma Decimal serializes as a string, same as its BigInt handling.
    assertExtra: (b) => expect(b.rate).toBe('18'),
  },
  {
    label: 'TdsRule',
    path: 'tds-rules',
    payload: {
      section: '194-IA',
      ratePercent: 1,
      thresholdPaise: 5000000,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31',
      description: 'TDS on property — E2E',
      isActive: true,
      sortOrder: 1,
    },
    assertExtra: (b) => expect(b.section).toBe('194-IA'),
  },
  {
    label: 'SmsTemplate',
    path: 'sms-templates',
    payload: {
      name: `E2E SMS ${TAG}`,
      dltTemplateId: '1234567890123456',
      senderId: 'OPNEST',
      headerId: 'HDR001',
      body: 'Your booking is confirmed.',
      isActive: true,
      sortOrder: 1,
    },
    assertExtra: (b) => expect(b.headerId).toBe('HDR001'),
  },
  {
    label: 'LetterTemplate',
    path: 'letter-templates',
    payload: {
      name: `E2E Letter ${TAG}`,
      subject: 'Your Allotment Letter',
      entityType: 'ALLOTMENT_LETTER',
      body: 'Dear {{applicantName}}, your unit under booking {{bookingNumber}} is allotted.',
      isActive: true,
      sortOrder: 1,
    },
    assertExtra: (b) => expect(b.entityType).toBe('ALLOTMENT_LETTER'),
  },
];

describeIf('e2e master/admin-entity creation: real HTTP through the full guard pipeline', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let adminEmail: string;
  let adminRoleId: string;
  let onePermissionId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));
    onePermissionId = permByKey.get(PERMISSIONS.ADMIN_MASTER_READ) as string;

    const role = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Master Admin', slug: `e2e-master-admin-${TAG}`, isSystem: true },
    });
    adminRoleId = role.id;
    await systemPrisma.rolePermission.createMany({
      data: ALL_PERMISSIONS.map((key) => ({ roleId: role.id, permissionId: permByKey.get(key) })),
    });

    adminEmail = `e2e-master-admin-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: adminEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { type: argon2.argon2id }),
        name: 'E2E Master Admin',
        roleId: adminRoleId,
        forcePasswordChange: false,
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  function extractCookie(setCookieHeader: string[] | string | undefined, name: string): string {
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ''];
    for (const h of headers) {
      const match = new RegExp(`${name}=([^;]+)`).exec(h);
      if (match) return match[1];
    }
    throw new Error(`Cookie ${name} not found in Set-Cookie headers`);
  }

  async function loginWithCsrf() {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email: adminEmail, password: STAFF_PASSWORD }).expect(200);
    const csrf = extractCookie(res.headers['set-cookie'], 'openestate_csrf');
    return { agent, token: res.body.accessToken as string, csrf };
  }

  for (const c of MASTER_CASES) {
    it(`POST /masters/${c.path} creates ${c.label} with a realistic payload (incl. optional fields)`, async () => {
      const { agent, token, csrf } = await loginWithCsrf();
      const res = await agent
        .post(`/api/v1/masters/${c.path}`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send(c.payload)
        .expect(201);
      expect(res.body.id).toBeTruthy();
      expect(res.body.name).toBe(c.payload.name);
      c.assertExtra?.(res.body);
    });
  }

  it('POST /users creates a user with the optional phone field', async () => {
    const { agent, token, csrf } = await loginWithCsrf();
    const email = `e2e-created-user-${TAG}@test.com`;
    const res = await agent
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ email, name: 'E2E Created User', password: 'CreatedPass123', roleId: adminRoleId, phone: '9876543210' })
      .expect(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.email).toBe(email);
    expect(res.body.phone).toBe('9876543210');
  });

  it('POST /roles creates a role with a non-empty permissionIds array', async () => {
    const { agent, token, csrf } = await loginWithCsrf();
    const res = await agent
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: 'E2E Created Role', slug: `e2e_created_role_${TAG}`, permissionIds: [onePermissionId] })
      .expect(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('E2E Created Role');
  });

  it('POST /custom-fields creates a SELECT field with options and a default value', async () => {
    const { agent, token, csrf } = await loginWithCsrf();
    const res = await agent
      .post('/api/v1/custom-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({
        entityType: 'INQUIRY',
        key: `e2e_lead_score_${TAG}`,
        label: 'Lead Score',
        fieldType: 'SELECT',
        isRequired: false,
        options: ['Hot', 'Warm', 'Cold'],
        defaultValue: 'Warm',
        sortOrder: 1,
      })
      .expect(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.options).toEqual(['Hot', 'Warm', 'Cold']);
    expect(res.body.defaultValue).toBe('Warm');
  });
});
