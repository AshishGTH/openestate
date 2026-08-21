/**
 * Through-the-wire coverage for plotted-farmhouse-inventory Phase B's new
 * API surface (plan §11.3): InventoryGroup CRUD, the LAND_BASED unit-create
 * route, the shape-conditional 400s on the existing HIGH_RISE-only
 * endpoints, and — the one that actually protects real money —
 * BookingCostLineVerifier's gate on POST /bookings.
 *
 * Requires the compiled dist/ — see e2e-stage-raise.test.ts for why.
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
import { ALL_PERMISSIONS } from '@openestate/shared';
import { makeClients, seedCompany, makeApplicant, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const STAFF_PASSWORD = 'StaffPass123';
const TAG = Date.now();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function (this: bigint) {
  return this.toString();
};

process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-plotted-inventory-${process.pid}-${Date.now()}-`;

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

function extractCookie(setCookieHeader: string[] | string | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ''];
  for (const h of headers) {
    const match = new RegExp(`${name}=([^;]+)`).exec(h);
    if (match) return match[1];
  }
  throw new Error(`Cookie ${name} not found in Set-Cookie headers`);
}

describeIf('e2e plotted-farmhouse-inventory Phase B', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  // Real staff session: same-cookie-jar agent + the double-submit CSRF
  // header every mutating request needs (POST/PATCH/DELETE all 403
  // without it — a plain Authorization header is not enough).
  let agent: ReturnType<typeof request.agent>;
  let auth: { Authorization: string; 'X-CSRF-Token': string };
  let landProjectId: string;
  let highRiseProjectId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    highRiseProjectId = fx.projectId;

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));
    const role = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Plotted Admin', slug: `e2e-plotted-admin-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: ALL_PERMISSIONS.map((key) => ({ roleId: role.id, permissionId: permByKey.get(key) })),
    });
    const email = `e2e-plotted-admin-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Plotted Admin',
        roleId: role.id,
        forcePasswordChange: false,
      },
    });
    agent = request.agent(app.getHttpServer());
    const login = await agent.post('/api/v1/auth/login').send({ email, password: STAFF_PASSWORD }).expect(200);
    auth = {
      Authorization: `Bearer ${login.body.accessToken as string}`,
      'X-CSRF-Token': extractCookie(login.headers['set-cookie'], 'openestate_csrf'),
    };

    const highRiseProject = await systemPrisma.project.findUniqueOrThrow({ where: { id: highRiseProjectId } });
    const landProject = await systemPrisma.project.create({
      data: {
        companyId: fx.companyId,
        name: `Land Project ${TAG}`,
        code: `LP-${TAG}`,
        shape: 'LAND_BASED',
        areaLocationId: highRiseProject.areaLocationId,
      },
    });
    landProjectId = landProject.id;
  }, 60_000);

  afterAll(async () => {
    if (fx?.companyId) await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await app?.close();
  });

  it('POST /projects/:id/towers refuses on a LAND_BASED project with a legible message', async () => {
    const res = await agent
      .post(`/api/v1/projects/${landProjectId}/towers`)
      .set(auth)
      .send({ name: 'T1', code: `T1-${TAG}`, totalFloors: 1 })
      .expect(400);
    expect(res.body.message).toContain('LAND_BASED');
  });

  it('POST /projects/:id/inventory-groups: happy path, then a cross-project group id 404s from the other project', async () => {
    const create = await agent
      .post(`/api/v1/projects/${landProjectId}/inventory-groups`)
      .set(auth)
      .send({ name: 'Sector 1', code: `S1-${TAG}`, kind: 'Sector' })
      .expect(201);
    expect(create.body.projectId).toBe(landProjectId);

    // Same group id, wrong project — must not be reachable from a project
    // it doesn't belong to.
    await agent
      .get(`/api/v1/projects/${highRiseProjectId}/inventory-groups/${create.body.id}`)
      .set(auth)
      .expect(404);
  });

  it('POST /projects/:id/inventory-groups on a HIGH_RISE project 400s', async () => {
    const res = await agent
      .post(`/api/v1/projects/${highRiseProjectId}/inventory-groups`)
      .set(auth)
      .send({ name: 'Sector X', code: `SX-${TAG}` })
      .expect(400);
    expect(res.body.message).toContain('HIGH_RISE');
  });

  it('POST /projects/:id/units/land-based: happy path, then the same route on a HIGH_RISE project 400s', async () => {
    const create = await agent
      .post(`/api/v1/projects/${landProjectId}/units/land-based`)
      .set(auth)
      .send({
        number: `PLOT-${TAG}`,
        landAreaEntered: 0.372,
        landAreaEnteredUnit: 'ACRE',
        rateUnit: 'ACRE',
        baseRatePaise: '50000000',
      })
      .expect(201);
    expect(create.body.shape).toBe('LAND_BASED');
    expect(create.body.floorId).toBeNull();
    // landAreaSqft derived server-side, not accepted from the client —
    // 0.372 acre * 43,560 sqft/acre = 16,204.32 sqft.
    expect(Number(create.body.landAreaSqft)).toBeCloseTo(16204.32, 2);

    const onHighRise = await agent
      .post(`/api/v1/projects/${highRiseProjectId}/units/land-based`)
      .set(auth)
      .send({
        number: `PLOT-WRONG-${TAG}`,
        landAreaEntered: 1,
        landAreaEnteredUnit: 'ACRE',
        rateUnit: 'ACRE',
        baseRatePaise: '1',
      })
      .expect(400);
    expect(onHighRise.body.message).toContain('HIGH_RISE');
  });

  describe('BookingCostLineVerifier gate on POST /bookings', () => {
    let landUnitId: string;
    let applicantId: string;

    beforeAll(async () => {
      const unit = await agent
        .post(`/api/v1/projects/${landProjectId}/units/land-based`)
        .set(auth)
        .send({
          number: `VERIFY-PLOT-${TAG}`,
          landAreaEntered: 0.5,
          landAreaEnteredUnit: 'ACRE',
          rateUnit: 'ACRE',
          baseRatePaise: '5000000',
        })
        .expect(201);
      landUnitId = unit.body.id;
      applicantId = await makeApplicant(systemPrisma, fx.companyId);
    });

    // Correct: 0.5 acre * 50,00,000 paise/acre = 25,00,000 paise.
    const CORRECT_AMOUNT = '2500000';

    it('rejects a BASE amount off by 1000 paise, naming the line and both amounts', async () => {
      const res = await agent
        .post('/api/v1/bookings')
        .set(auth)
        .send({
          unitId: landUnitId,
          primaryApplicantId: applicantId,
          coApplicantIds: [],
          bookingDate: '2026-06-01',
          costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: String(BigInt(CORRECT_AMOUNT) + 1000n), gstRateId: fx.defaultGstRateId }],
        })
        .expect(400);
      expect(res.body.message).toContain('Base');
      expect(res.body.message).toContain(CORRECT_AMOUNT);
    });

    it('accepts a BASE amount off by exactly 1 paise (the allowed slack)', async () => {
      await agent
        .post('/api/v1/bookings')
        .set(auth)
        .send({
          unitId: landUnitId,
          primaryApplicantId: applicantId,
          coApplicantIds: [],
          bookingDate: '2026-06-01',
          costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: String(BigInt(CORRECT_AMOUNT) + 1n), gstRateId: fx.defaultGstRateId }],
        })
        .expect(201);
    });

    it('accepts the exact computed amount', async () => {
      const unit2 = await agent
        .post(`/api/v1/projects/${landProjectId}/units/land-based`)
        .set(auth)
        .send({
          number: `VERIFY-PLOT-2-${TAG}`,
          landAreaEntered: 0.5,
          landAreaEnteredUnit: 'ACRE',
          rateUnit: 'ACRE',
          baseRatePaise: '5000000',
        })
        .expect(201);
      await agent
        .post('/api/v1/bookings')
        .set(auth)
        .send({
          unitId: unit2.body.id,
          primaryApplicantId: applicantId,
          coApplicantIds: [],
          bookingDate: '2026-06-01',
          costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: CORRECT_AMOUNT, gstRateId: fx.defaultGstRateId }],
        })
        .expect(201);
    });
  });
});
