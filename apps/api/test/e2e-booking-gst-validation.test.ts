/**
 * Through-the-wire HTTP coverage for the base-line GST rate validation
 * added alongside BookingWizard's rate picker: a cost line whose GST rate
 * can't be resolved (own → charge type → base line, all null) must 400,
 * never silently price at 0%. A direct-service-call test proves the
 * resolution logic; this proves a real POST /bookings request — the one
 * a real browser (or a bypass of the wizard) actually sends — gets
 * rejected with the reworded message pointing at the base-line remedy.
 *
 * Requires the compiled dist/ — see e2e-company-update.test.ts for why.
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
import { ALL_PERMISSIONS, PERMISSIONS } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const STAFF_PASSWORD = 'StaffPass123';
const TAG = Date.now();

// main.ts patches this so BigInt money fields serialize instead of
// crashing JSON.stringify — every e2e-*.test.ts file bootstraps AppModule
// directly and never executes main.ts, so it must be reapplied here too.
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

describeIf('e2e POST /bookings — base-line GST rate validation', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let adminEmail: string;
  let unitId: string;
  let gstRateId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));

    const role = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Booking Admin', slug: `e2e-booking-admin-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: [PERMISSIONS.PRESALES_APPLICANT_CREATE, PERMISSIONS.POSTSALES_BOOKING_CREATE].map((key) => ({
        roleId: role.id,
        permissionId: permByKey.get(key),
      })),
    });

    adminEmail = `e2e-booking-admin-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: adminEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Booking Admin',
        roleId: role.id,
        forcePasswordChange: false,
      },
    });

    const unit = await systemPrisma.unit.create({
      data: { companyId: fx.companyId, floorId: fx.floorId, number: `E2E-GSTVAL-${TAG}`, status: 'AVAILABLE', baseRatePaise: 50_00_000n * 100n },
    });
    unitId = unit.id;

    const gr = await systemPrisma.gstRate.create({
      data: { companyId: fx.companyId, rate: 5, description: `GST 5% ${TAG}`, effectiveFrom: new Date('2019-04-01') },
    });
    gstRateId = gr.id;
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

  async function login() {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email: adminEmail, password: STAFF_PASSWORD }).expect(200);
    return { agent, csrf: extractCookie(res.headers['set-cookie'], 'openestate_csrf'), token: res.body.accessToken as string };
  }

  async function createApplicant(agent: request.Agent, auth: Record<string, string>) {
    const phone = `9${String(TAG).slice(-9)}`;
    const res = await agent
      .post('/api/v1/applicants')
      .set(auth)
      .send({ name: 'E2E GST Validation Applicant', primaryPhone: phone, alternatePhones: [] })
      .expect(201);
    return (res.body.applicant ?? res.body).id as string;
  }

  it('rejects a booking whose base line has no GST rate, with a message pointing at the base line first', async () => {
    const { agent, csrf, token } = await login();
    const auth = { Authorization: `Bearer ${token}`, 'X-CSRF-Token': csrf };
    const applicantId = await createApplicant(agent, auth);

    const res = await agent
      .post('/api/v1/bookings')
      .set(auth)
      .send({
        unitId,
        primaryApplicantId: applicantId,
        coApplicantIds: [],
        bookingDate: '2026-06-01',
        costLines: [{ kind: 'BASE', label: 'Base Sale Price', baseAmountPaise: '5000000000' }],
      })
      .expect(400);

    expect(res.body.message).toMatch(/select a gst rate for the base line/i);
    expect(res.body.message).toMatch(/base sale price/i);

    // No partial booking left behind — full rollback.
    const bookings = await systemPrisma.booking.findMany({ where: { companyId: fx.companyId, unitId } });
    expect(bookings).toHaveLength(0);
  });

  it('accepts the same booking once the base line carries a GST rate', async () => {
    const { agent, csrf, token } = await login();
    const auth = { Authorization: `Bearer ${token}`, 'X-CSRF-Token': csrf };
    const applicantId = await createApplicant(agent, auth);

    const res = await agent
      .post('/api/v1/bookings')
      .set(auth)
      .send({
        unitId,
        primaryApplicantId: applicantId,
        coApplicantIds: [],
        bookingDate: '2026-06-01',
        costLines: [{ kind: 'BASE', label: 'Base Sale Price', baseAmountPaise: '5000000000', gstRateId }],
      })
      .expect(201);

    const lines = await systemPrisma.bookingCostLine.findMany({ where: { bookingId: res.body.id } });
    expect(lines[0].gstRateId).toBe(gstRateId);
  });
});
