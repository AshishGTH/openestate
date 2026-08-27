/**
 * Through-the-wire HTTP coverage for the two new unit-scoped controllers
 * (UnitPricingService's PLC/charge CRUD, v0.2.0) plus the snapshot
 * invariant: a percentage-derived PLC amount must NOT change if the
 * unit's base rate changes afterward — it was computed once, at
 * assignment time, same convention as rate revisions and cost-line GST
 * snapshots elsewhere in this codebase.
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

// main.ts patches this so BigInt money fields (amountPaise here) serialize
// instead of crashing JSON.stringify — every e2e-*.test.ts file bootstraps
// AppModule directly and never executes main.ts, so it must be reapplied
// here too. See e2e-master-creation.test.ts's identical comment.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function (this: bigint) {
  return this.toString();
};

async function bootstrapApp(): Promise<INestApplication> {
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
  return nestApp;
}

describeIf('e2e /projects/:projectId/units/:id/{plcs,charges}', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let adminEmail: string;
  let unitId: string;
  let plcTypeId: string;
  let chargeTypeId: string;

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
      data: { companyId: fx.companyId, name: 'E2E Pricing Admin', slug: `e2e-pricing-admin-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: [
        PERMISSIONS.INVENTORY_UNIT_READ,
        PERMISSIONS.INVENTORY_UNIT_PLC_MANAGE,
        PERMISSIONS.INVENTORY_UNIT_CHARGE_MANAGE,
        PERMISSIONS.INVENTORY_RATE_CHANGE,
      ].map((key) => ({ roleId: role.id, permissionId: permByKey.get(key) })),
    });

    adminEmail = `e2e-pricing-admin-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: adminEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Pricing Admin',
        roleId: role.id,
        forcePasswordChange: false,
      },
    });

    // Direct create (not the makeUnit() helper) — this test needs a
    // meaningful, known base rate to exercise the percentage snapshot,
    // and makeUnit() defaults baseRatePaise to 0.
    const unit = await systemPrisma.unit.create({
      data: { companyId: fx.companyId, projectId: fx.projectId, shape: 'HIGH_RISE', floorId: fx.floorId, number: `E2E-PRICE-${TAG}`, status: 'AVAILABLE', baseRatePaise: 50_00_000n * 100n },
    });
    unitId = unit.id;

    const plcType = await systemPrisma.plcType.create({ data: { companyId: fx.companyId, name: `Park Facing ${TAG}` } });
    plcTypeId = plcType.id;
    const chargeType = await systemPrisma.chargeType.create({ data: { companyId: fx.companyId, name: `Car Parking ${TAG}` } });
    chargeTypeId = chargeType.id;
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

  it('assigns a percentage-based PLC (snapshotting amountPaise from the unit\'s CURRENT base rate), lists, then removes it', async () => {
    const { agent, csrf, token } = await login();
    const auth = { Authorization: `Bearer ${token}`, 'X-CSRF-Token': csrf };

    // 2% of ₹50,00,000 = ₹1,00,000 = 1_00_000_00 paise.
    const createRes = await agent
      .post(`/api/v1/projects/${fx.projectId}/units/${unitId}/plcs`)
      .set(auth)
      .send({ plcTypeId, percentage: 2 })
      .expect(201);
    expect(createRes.body.amountPaise).toBe('10000000');

    const listRes = await agent.get(`/api/v1/projects/${fx.projectId}/units/${unitId}/plcs`).set(auth).expect(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].plcType.id).toBe(plcTypeId);

    // Snapshot invariant: changing the unit's base rate afterward must
    // NOT retroactively change the already-assigned PLC amount.
    await agent
      .post(`/api/v1/projects/${fx.projectId}/units/change-rate`)
      .set(auth)
      .send({ unitIds: [unitId], ratePaise: '10000000000', effectiveFrom: '2026-06-01', reason: 'e2e rate bump' })
      .expect(201);
    const afterRateChange = await agent.get(`/api/v1/projects/${fx.projectId}/units/${unitId}/plcs`).set(auth).expect(200);
    expect(afterRateChange.body[0].amountPaise).toBe('10000000'); // unchanged

    await agent
      .delete(`/api/v1/projects/${fx.projectId}/units/${unitId}/plcs/${createRes.body.id}`)
      .set(auth)
      .expect(200);
    const afterDelete = await agent.get(`/api/v1/projects/${fx.projectId}/units/${unitId}/plcs`).set(auth).expect(200);
    expect(afterDelete.body).toHaveLength(0);
  });

  it('assigns a flat-amount charge, lists, then removes it', async () => {
    const { agent, csrf, token } = await login();
    const auth = { Authorization: `Bearer ${token}`, 'X-CSRF-Token': csrf };

    const createRes = await agent
      .post(`/api/v1/projects/${fx.projectId}/units/${unitId}/charges`)
      .set(auth)
      .send({ chargeTypeId, amountPaise: '15000000' })
      .expect(201);
    expect(createRes.body.amountPaise).toBe('15000000');

    const listRes = await agent.get(`/api/v1/projects/${fx.projectId}/units/${unitId}/charges`).set(auth).expect(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].chargeType.id).toBe(chargeTypeId);

    await agent
      .delete(`/api/v1/projects/${fx.projectId}/units/${unitId}/charges/${createRes.body.id}`)
      .set(auth)
      .expect(200);
    const afterDelete = await agent.get(`/api/v1/projects/${fx.projectId}/units/${unitId}/charges`).set(auth).expect(200);
    expect(afterDelete.body).toHaveLength(0);
  });
});
