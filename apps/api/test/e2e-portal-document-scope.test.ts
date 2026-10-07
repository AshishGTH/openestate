/**
 * Portal document download scope (mirrored for both portal principals),
 * through the real guard pipeline over HTTP.
 *
 * Refusals (every one is mutation-checked against the pre-fix code):
 *  - broker -> a customer document of a booking that broker sourced = 404 on
 *    BOTH download routes, for every document type;
 *  - customer -> a broker statement = 404 on BOTH routes;
 *  - customer -> a document type the portal list hides = 404.
 * Positive controls: every customer path that existed before (account,
 * schedule/receipt history, profile, property, documents list, each allowed
 * type's download, co-applicant access) and the broker's own statements.
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
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { makeClients, seedCompany, makePortalRole, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { buildDocScopeFixture, type DocScopeFixture } from './helpers/portal-doc-scope-fixture';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

// Private throttle keyspace for this file (see e2e-broker-portal.test.ts).
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-portal-doc-scope-${process.pid}-${Date.now()}-`;

const PASSWORD = 'PortalPass123';

// main.ts patches this globally for the real server; the test bootstrap does
// not run main.ts, and /portal/account returns money fields as BigInt.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function (this: bigint) {
  return this.toString();
};

type DocKey = 'receipt' | 'statement' | 'demand' | 'allotment' | 'reminder';

function binary(r: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  r.on('data', (c: Buffer) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
}

describeIf('Portal document download scope over HTTP', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  let fx: CompanyFixture;
  let f: DocScopeFixture;
  const phones: Record<string, string> = {};

  beforeAll(async () => {
    process.env.DATABASE_URL = APP_URL;
    process.env.DATABASE_URL_SYSTEM = SYSTEM_URL;
    process.env.REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';
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
    app = nestApp;

    ({ systemPrisma, tenantPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const permByKey = new Map<string, string>(
      (await systemPrisma.permission.findMany()).map((p: { key: string; id: string }) => [p.key, p.id]),
    );
    async function portalRole(slug: 'customer' | 'broker', sys: keyof typeof ROLE_PERMISSIONS) {
      const roleId = await makePortalRole(systemPrisma, fx.companyId, slug);
      const ids = ROLE_PERMISSIONS[sys].map((k) => permByKey.get(k)).filter((id): id is string => !!id);
      await systemPrisma.rolePermission.createMany({ data: ids.map((permissionId) => ({ roleId, permissionId })) });
      return roleId;
    }
    const customerRoleId = await portalRole('customer', SYSTEM_ROLES.CUSTOMER);
    const brokerRoleId = await portalRole('broker', SYSTEM_ROLES.BROKER);

    f = await buildDocScopeFixture(tenantPrisma, systemPrisma, fx);

    const hash = await argon2.hash(PASSWORD, { algorithm: argon2.Algorithm.Argon2id });
    const accounts: Array<[string, string | null, string | null, string]> = [
      ['customer', f.applicantId, null, customerRoleId],
      ['coApplicant', f.coApplicantId, null, customerRoleId],
      ['brokerA', null, f.brokerAId, brokerRoleId],
      ['brokerB', null, f.brokerBId, brokerRoleId],
    ];
    for (const [key, applicantId, brokerId, roleId] of accounts) {
      const row = applicantId
        ? await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicantId } })
        : await systemPrisma.broker.findUniqueOrThrow({ where: { id: brokerId } });
      phones[key] = row.primaryPhone ?? row.phone;
      await systemPrisma.user.create({
        data: {
          companyId: fx.companyId,
          applicantId: applicantId ?? undefined,
          brokerId: brokerId ?? undefined,
          phone: phones[key],
          name: row.name,
          passwordHash: hash,
          roleId,
          forcePasswordChange: false,
        },
      });
    }
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  // Logins are cached: the portal-auth bucket is 5 per 5 minutes per IP.
  const tokens = new Map<string, string>();
  async function token(who: string): Promise<string> {
    const cached = tokens.get(who);
    if (cached) return cached;
    const res = await request(app.getHttpServer())
      .post('/api/v1/portal/auth/login')
      .send({ identifier: phones[who], password: PASSWORD })
      .expect(200);
    tokens.set(who, res.body.accessToken as string);
    return res.body.accessToken as string;
  }
  const get = async (who: string, path: string) =>
    request(app.getHttpServer()).get(`/api/v1/portal${path}`).set('Authorization', `Bearer ${await token(who)}`);
  const pdf = async (who: string, path: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/portal${path}`)
      .set('Authorization', `Bearer ${await token(who)}`)
      .buffer(true)
      .parse(binary);
  const customerDl = (id: string) => `/account/documents/${id}/download`;
  const brokerDl = (id: string) => `/broker/documents/${id}/download`;

  // ---------- refusals ----------

  it('broker -> every customer document of a booking that broker sourced = 404 on BOTH download routes', async () => {
    // Precondition: the booking really is broker A's, otherwise this proves nothing.
    const booking = await systemPrisma.booking.findUniqueOrThrow({ where: { id: f.bookingId } });
    expect(booking.brokerId).toBe(f.brokerAId);
    for (const key of ['receipt', 'statement', 'demand', 'allotment', 'reminder'] as DocKey[]) {
      const id = f.docs[key];
      expect((await get('brokerA', customerDl(id))).status, `customer route, ${key}`).toBe(404);
      expect((await get('brokerA', brokerDl(id))).status, `broker route, ${key}`).toBe(404);
    }
  });

  it('broker -> another broker statement = 404 on both routes', async () => {
    expect((await get('brokerA', brokerDl(f.docs.brokerBStatement))).status).toBe(404);
    expect((await get('brokerA', customerDl(f.docs.brokerBStatement))).status).toBe(404);
  });

  it('customer -> a broker statement = 404 on BOTH routes (the broker route is broker-only)', async () => {
    expect((await get('customer', brokerDl(f.docs.brokerAStatement))).status).toBe(404);
    expect((await get('customer', customerDl(f.docs.brokerAStatement))).status).toBe(404);
  });

  it('customer -> the hidden types (allotment, reminder letters) = 404, though they are theirs and the list hides them', async () => {
    for (const key of f.customerHidden as DocKey[]) {
      const row = await systemPrisma.generatedDocument.findUniqueOrThrow({ where: { id: f.docs[key] } });
      expect(row.applicantId).toBe(f.applicantId);
      expect((await get('customer', customerDl(f.docs[key]))).status, key).toBe(404);
    }
    const list = await get('customer', '/account/documents');
    const listed = (list.body as Array<{ id: string }>).map((d) => d.id);
    for (const key of f.customerHidden as DocKey[]) expect(listed).not.toContain(f.docs[key]);
  });

  it('co-applicant is held to the same allow-list and cannot fetch another booking document', async () => {
    expect((await get('coApplicant', customerDl(f.docs.allotment))).status).toBe(404);
    expect((await get('coApplicant', customerDl(f.docs.otherCustomerStatement))).status).toBe(404);
  });

  // ---------- positive controls ----------

  it('customer: account, schedule, receipt history, profile and property still load', async () => {
    const account = await get('customer', '/account');
    expect(account.status).toBe(200);
    const bookings = account.body as Array<{
      bookingId: string;
      paymentSchedule: Array<{ label: string }>;
      paymentHistory: Array<{ grossAmountPaise: string }>;
      nextDue: unknown;
    }>;
    expect(bookings).toHaveLength(1);
    expect(bookings[0].bookingId).toBe(f.bookingId);
    expect(bookings[0].paymentSchedule.map((i) => i.label)).toEqual(['I1']); // the schedule is there
    expect(bookings[0].paymentHistory).toHaveLength(1); // payment history is there
    expect(bookings[0].paymentHistory[0].grossAmountPaise).toBe('50000000');
    expect(bookings[0].nextDue).toBeTruthy();
    expect((await get('customer', '/profile')).status).toBe(200);
    expect((await get('customer', '/property')).status).toBe(200);
  });

  it('customer: the documents list shows exactly the three allowed types and each one downloads as a PDF', async () => {
    const list = await get('customer', '/account/documents');
    expect(list.status).toBe(200);
    const listed = list.body as Array<{ id: string; documentType: string }>;
    expect(new Set(listed.map((d) => d.documentType))).toEqual(new Set(['RECEIPT', 'STATEMENT', 'DEMAND_LETTER']));
    for (const key of f.customerVisible as DocKey[]) {
      expect(listed.map((d) => d.id)).toContain(f.docs[key]);
      const res = await pdf('customer', customerDl(f.docs[key]));
      expect(res.status, key).toBe(200);
      expect((res.body as Buffer).subarray(0, 4).toString(), key).toBe('%PDF');
    }
  });

  it('co-applicant: account loads and the three allowed documents of the booking download', async () => {
    expect((await get('coApplicant', '/account')).status).toBe(200);
    for (const key of f.customerVisible as DocKey[]) {
      expect((await get('coApplicant', customerDl(f.docs[key]))).status, key).toBe(200);
    }
  });

  it('broker: own statement lists and downloads as a PDF; dashboard and NOC list still load', async () => {
    const list = await get('brokerA', '/broker/documents');
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: string }>).map((d) => d.id)).toEqual([f.docs.brokerAStatement]);
    const res = await pdf('brokerA', brokerDl(f.docs.brokerAStatement));
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const dash = await get('brokerA', '/broker/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body.soldUnitsCount).toBe(1);
    expect((await get('brokerA', '/broker/nocs')).status).toBe(200);
  });
});
