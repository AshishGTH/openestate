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
import * as argon2 from '@node-rs/argon2';
import { ALL_PERMISSIONS, PERMISSIONS, SEED_GST_RATES, SEED_TDS_RULES } from '@openestate/shared';
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
  // stateCode is the GST place-of-supply source for projects in this
  // location. Before it was exposed here, an admin-created AreaLocation
  // always had it NULL, and since v0.2.0's fail-loud place-of-supply
  // check that made every booking on those projects impossible — with
  // the error telling the admin to set a field the UI had no input for.
  {
    label: 'AreaLocation',
    path: 'area-locations',
    payload: simpleBase({ stateCode: '09', city: 'Noida', state: 'Uttar Pradesh', pincode: '201301' }),
    assertExtra: (b) => {
      expect(b.stateCode).toBe('09');
      expect(b.city).toBe('Noida');
      expect(b.state).toBe('Uttar Pradesh');
      expect(b.pincode).toBe('201301');
    },
  },
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
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
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

  it('POST /roles accepts a hyphenated slug (RoleForm.tsx\'s own hint text promises hyphens)', async () => {
    const { agent, token, csrf } = await loginWithCsrf();
    const res = await agent
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: 'E2E Hyphen Role', slug: `e2e-hyphen-role-${TAG}`, permissionIds: [onePermissionId] })
      .expect(201);
    expect(res.body.id).toBeTruthy();
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

  // Regression for the "first GST rate blocks every subsequent one" footgun:
  // a company's first-ever (open-ended) GST rate used to make every later
  // POST /masters/gst-rates 400 with an overlap error, through this exact
  // real HTTP path, not just at the service layer.
  it('POST /masters/gst-rates auto-closes a prior open-ended rate instead of rejecting the second one', async () => {
    const { agent, token, csrf } = await loginWithCsrf();
    const first = await agent
      .post('/api/v1/masters/gst-rates')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ rate: 18, description: `First GST rate ${TAG}`, effectiveFrom: '2030-01-01', isActive: true, sortOrder: 1 })
      .expect(201);
    expect(first.body.effectiveTo).toBeNull();

    const second = await agent
      .post('/api/v1/masters/gst-rates')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ rate: 12, description: `Second GST rate ${TAG}`, effectiveFrom: '2030-06-01', isActive: true, sortOrder: 2 })
      .expect(201);
    expect(second.body.effectiveTo).toBeNull();

    const refetched = await agent
      .get(`/api/v1/masters/gst-rates/${first.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(refetched.body.effectiveTo?.slice(0, 10)).toBe('2030-05-31');

    // A genuinely ambiguous overlap (starts on/before the still-open range
    // above) must still be rejected with an actionable message, not silently
    // auto-closed.
    const conflict = await agent
      .post('/api/v1/masters/gst-rates')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ rate: 5, description: `Conflicting GST rate ${TAG}`, effectiveFrom: '2030-06-01', isActive: true, sortOrder: 3 })
      .expect(400);
    expect(conflict.body.message).toContain('Set an end date on it first');
  });

  // Regression for the null-coercion-to-epoch bug: `PATCH .../gst-rates/:id`
  // with `effectiveTo: null` used to silently become 1970-01-01 instead of
  // clearing the column, because z.coerce.date() ran `new Date(null)`
  // (a "valid" epoch Date) before any null-check. Also covers the sibling
  // fix in TdsRule and the `??`-vs-`'key' in dto` bug in both services'
  // update() overlap re-validation.
  it('PATCH .../gst-rates/:id with effectiveTo: null clears the column instead of coercing to epoch', async () => {
    const { agent, token, csrf } = await loginWithCsrf();
    const created = await agent
      .post('/api/v1/masters/gst-rates')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ rate: 9, description: `Clearable GST rate ${TAG}`, effectiveFrom: '2031-01-01', effectiveTo: '2031-12-31', isActive: true, sortOrder: 4 })
      .expect(201);
    expect(created.body.effectiveTo?.slice(0, 10)).toBe('2031-12-31');

    const cleared = await agent
      .patch(`/api/v1/masters/gst-rates/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ effectiveTo: null })
      .expect(200);
    expect(cleared.body.effectiveTo).toBeNull();

    // Omitting the key entirely (a PATCH that touches only `rate`) must
    // leave the now-cleared effectiveTo untouched — not re-apply some
    // stale default via `??`.
    const untouched = await agent
      .patch(`/api/v1/masters/gst-rates/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ rate: 10 })
      .expect(200);
    expect(untouched.body.effectiveTo).toBeNull();
    expect(untouched.body.rate).toBe('10');
  });

  it('PATCH .../tds-rules/:id with effectiveTo: null clears the column instead of coercing to epoch', async () => {
    const { agent, token, csrf } = await loginWithCsrf();
    const created = await agent
      .post('/api/v1/masters/tds-rules')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({
        section: `194-${TAG % 1000000}`,
        ratePercent: 1,
        thresholdPaise: '5000000',
        effectiveFrom: '2031-01-01',
        effectiveTo: '2031-12-31',
        isActive: true,
        sortOrder: 4,
      })
      .expect(201);
    expect(created.body.effectiveTo?.slice(0, 10)).toBe('2031-12-31');

    const cleared = await agent
      .patch(`/api/v1/masters/tds-rules/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ effectiveTo: null })
      .expect(200);
    expect(cleared.body.effectiveTo).toBeNull();
  });

  // Regression for "the seed ships master data the API's own validation
  // rejects": packages/db/prisma/seed.ts inserts SEED_GST_RATES/
  // SEED_TDS_RULES directly via Prisma, bypassing GstRateService/
  // TdsRuleService entirely — so nothing before this test ever proved a
  // FRESH INSTALL's seeded rows could survive a real admin touching them
  // through the validated endpoint. Posts the exact same shared data
  // (packages/shared/src/seed-data.ts, the one seed.ts itself reads) in
  // the exact order seed.ts inserts it, through the real HTTP pipeline —
  // if this ever 400s, a fresh install starts with invalid master data.
  it('seeded GST/TDS rate data round-trips through the real create validation, in seed order', async () => {
    // Deliberately its OWN company, not this file's shared `fx` — an
    // open-ended GstRate (SEED_GST_RATES' current-rate entry) collides
    // with the overlap check against ANY other active rate the company
    // already has, regardless of that rate's own dates (open-ended means
    // "extends indefinitely"), and `fx` accumulates GST rates from every
    // other test case/describe block in this file. A real fresh install
    // has none of that baggage — this test's isolation is what makes it
    // an honest proxy for one.
    const rtCompany = await seedCompany(systemPrisma);
    const rtRole = await systemPrisma.role.create({
      data: { companyId: rtCompany.companyId, name: 'RT Admin', slug: `rt-admin-${TAG}`, isSystem: true },
    });
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));
    await systemPrisma.rolePermission.createMany({
      data: ALL_PERMISSIONS.map((key) => ({ roleId: rtRole.id, permissionId: permByKey.get(key) })),
    });
    const rtEmail = `rt-admin-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: rtCompany.companyId,
        email: rtEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'RT Admin',
        roleId: rtRole.id,
        forcePasswordChange: false,
      },
    });

    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: rtEmail, password: STAFF_PASSWORD }).expect(200);
    const token = loginRes.body.accessToken;
    const csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');

    // rtCompany's own default GST rate (seedCompany's fixed 2019-04-01–
    // 2019-04-02 test-default row) is open-ended-adjacent enough to
    // collide with SEED_GST_RATES' 2019-04-01-onward entry — same
    // reasoning as above, deactivate it since nothing else uses this
    // isolated company.
    await agent
      .patch(`/api/v1/masters/gst-rates/${rtCompany.defaultGstRateId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ isActive: false })
      .expect(200);

    for (const rate of SEED_GST_RATES) {
      const res = await agent
        .post('/api/v1/masters/gst-rates')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send({
          rate: rate.rate,
          description: rate.description,
          effectiveFrom: rate.effectiveFrom.toISOString().slice(0, 10),
          ...(rate.effectiveTo ? { effectiveTo: rate.effectiveTo.toISOString().slice(0, 10) } : {}),
          sortOrder: rate.sortOrder,
        });
      expect(res.status, `POST gst-rates failed for "${rate.description}": ${JSON.stringify(res.body)}`).toBe(201);
    }

    for (const rule of SEED_TDS_RULES) {
      const res = await agent
        .post('/api/v1/masters/tds-rules')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send({
          section: rule.section,
          ratePercent: rule.ratePercent,
          thresholdPaise: rule.thresholdPaise.toString(),
          effectiveFrom: rule.effectiveFrom.toISOString().slice(0, 10),
          ...(rule.effectiveTo ? { effectiveTo: rule.effectiveTo.toISOString().slice(0, 10) } : {}),
          description: rule.description,
          sortOrder: rule.sortOrder,
        });
      expect(res.status, `POST tds-rules failed for "${rule.section}": ${JSON.stringify(res.body)}`).toBe(201);
    }

    await cleanupCompany(systemPrisma, rtCompany.companyId);
  });
});
