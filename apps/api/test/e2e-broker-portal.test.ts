/**
 * Phase 6 commit 3 (broker-portal): through-the-wire supertest coverage
 * for every new controller (dashboard, NOCs, documents), per the standing
 * rule from Phase 6 commit 2's decisions — direct-call tests (see
 * broker-portal.test.ts) cannot prove pipeline behavior. Mirrors
 * test/e2e-portal.test.ts's bootstrap exactly (real Express, real
 * APP_GUARD chain, real TenantContextInterceptor, real Postgres/Redis)
 * but is a SEPARATE file rather than added to e2e-portal.test.ts because
 * the fixtures are broker-shaped, not customer-shaped, and the two would
 * otherwise share nothing but boilerplate.
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
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES, COMMISSION_ENTRY_TYPE } from '@openestate/shared';
import {
  makeClients,
  seedCompany,
  makeUnit,
  makeApplicant,
  makeBroker,
  makePortalRole,
  cleanupCompany,
  type CompanyFixture,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const shouldRun = !!(APP_URL && SYSTEM_URL);
const describeIf = shouldRun ? describe : describe.skip;

// portal-auth's rate limit (5 req/5min per IP, Redis-backed) is shared
// globally across test files unless isolated — see e2e-portal-throttle
// .test.ts's doc comment for the original precedent. This file's own
// real portal logins were intermittently 429'd by e2e-portal.test.ts's
// concurrent logins sharing the same default namespace (confirmed by a
// full-suite run, not hypothetical). Same fix, same reasoning.
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-broker-portal-${process.pid}-${Date.now()}-`;

const BROKER_PASSWORD = 'BrokerPass123';
const STAFF_PASSWORD = 'StaffPass123';

describeIf('Phase 6 e2e: broker portal through the full guard pipeline', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;

  let staffEmail: string;
  let brokerAPhone: string;
  let brokerBPhone: string;
  let brokerAId: string;
  let bookingAId: string;
  let nocAId: string;

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

    // Requires COMPILED dist/ — see e2e-portal.test.ts's identical comment
    // for why (vitest/esbuild can't emit correct decorator metadata).
    const require = createRequire(import.meta.url);
    const { AppModule } = require('../dist/app.module');

    const nestApp = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
    nestApp.use(helmet());
    nestApp.use(cookieParser());
    nestApp.setGlobalPrefix('api/v1');
    nestApp.useGlobalPipes(new ZodValidationPipe());
    await nestApp.init();
    app = nestApp;

    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));

    const brokerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'broker');
    const brokerPermIds = ROLE_PERMISSIONS[SYSTEM_ROLES.BROKER]
      .map((key) => permByKey.get(key))
      .filter((id): id is string => !!id);
    await systemPrisma.rolePermission.createMany({
      data: brokerPermIds.map((permissionId) => ({ roleId: brokerRoleId, permissionId })),
    });

    const staffRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Broker Admin', slug: `e2e-broker-admin-${Date.now()}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: ALL_PERMISSIONS.map((key) => ({ roleId: staffRole.id, permissionId: permByKey.get(key) })),
    });
    const tag = Date.now();
    staffEmail = `e2e-broker-staff-${tag}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: staffEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Broker Staff',
        roleId: staffRole.id,
        forcePasswordChange: false,
      },
    });
    brokerAId = await makeBroker(systemPrisma, fx.companyId);
    const brokerBId = await makeBroker(systemPrisma, fx.companyId);
    const brokerA = await systemPrisma.broker.findUniqueOrThrow({ where: { id: brokerAId } });
    const brokerB = await systemPrisma.broker.findUniqueOrThrow({ where: { id: brokerBId } });
    brokerAPhone = brokerA.phone;
    brokerBPhone = brokerB.phone;

    for (const [brokerId, phone, name] of [
      [brokerAId, brokerA.phone, brokerA.name],
      [brokerBId, brokerB.phone, brokerB.name],
    ] as const) {
      await systemPrisma.user.create({
        data: {
          companyId: fx.companyId,
          brokerId,
          phone,
          name,
          passwordHash: await argon2.hash(BROKER_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
          roleId: brokerRoleId,
          forcePasswordChange: false,
        },
      });
    }

    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const unitId = await makeUnit(systemPrisma, fx);
    const bookingA = await systemPrisma.booking.create({
      data: {
        companyId: fx.companyId,
        unitId,
        primaryApplicantId: applicantId,
        bookingNumber: `E2EB-${tag}`,
        agreedPricePaise: BigInt(20_00_000_00),
        bookingDate: new Date('2026-06-01'),
        brokerId: brokerAId,
      },
    });
    bookingAId = bookingA.id;

    await systemPrisma.commissionLedgerEntry.create({
      data: {
        companyId: fx.companyId,
        brokerId: brokerAId,
        bookingId: bookingAId,
        entryType: COMMISSION_ENTRY_TYPE.ACCRUAL,
        signedAmountPaise: BigInt(50_000_00),
        effectiveDate: new Date('2026-06-15'),
      },
    });

    const noc = await systemPrisma.brokerNoc.create({
      data: { companyId: fx.companyId, bookingId: bookingAId, brokerId: brokerAId, status: 'REQUESTED' },
    });
    nocAId = noc.id;
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  // Cached per identity (agent + token + CSRF cookie value), same
  // rate-limit-budget and CSRF-capture reasoning as e2e-portal.test.ts's
  // portalSession() — the portal-auth bucket is a real
  // 5-requests/5-minutes-per-IP control, every request in this file
  // shares supertest's loopback IP, and a portal POST needs the CSRF
  // cookie/header pair or CsrfGuard 403s it before PermissionsGuard or
  // the controller ever run.
  const sessions = new Map<string, { agent: ReturnType<typeof request.agent>; token: string; csrf: string }>();
  async function brokerSession(identifier: string) {
    const cached = sessions.get(identifier);
    if (cached) return cached;
    const agent = request.agent(app.getHttpServer());
    const res = await agent
      .post('/api/v1/portal/auth/login')
      .send({ identifier, password: BROKER_PASSWORD })
      .expect(200);
    const csrf = extractCookie(res.headers['set-cookie'], 'openestate_portal_csrf');
    const session = { agent, token: res.body.accessToken as string, csrf };
    sessions.set(identifier, session);
    return session;
  }

  it('broker dashboard over HTTP: login then GET /portal/broker/dashboard returns this broker\'s own commission figures', async () => {
    const { token } = await brokerSession(brokerAPhone);

    const res = await request(app.getHttpServer())
      .get('/api/v1/portal/broker/dashboard')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.commission.accruedFormatted).toContain('50,000');
    expect(res.body.soldUnitsCount).toBe(1);
    expect(res.body.pendingNocCount).toBe(1);
  });

  it('broker NOCs over HTTP: a broker sees and approves their own NOC; an unrelated broker gets 404 approving it', async () => {
    const sessionA = await brokerSession(brokerAPhone);

    const list = await request(app.getHttpServer())
      .get('/api/v1/portal/broker/nocs')
      .set('Authorization', `Bearer ${sessionA.token}`)
      .expect(200);
    expect((list.body as Array<{ id: string }>).map((n) => n.id)).toContain(nocAId);

    const sessionB = await brokerSession(brokerBPhone);
    await sessionB.agent
      .post(`/api/v1/portal/broker/nocs/${nocAId}/approve`)
      .set('Authorization', `Bearer ${sessionB.token}`)
      .set('X-CSRF-Token', sessionB.csrf)
      .expect(404);

    const approved = await sessionA.agent
      .post(`/api/v1/portal/broker/nocs/${nocAId}/approve`)
      .set('Authorization', `Bearer ${sessionA.token}`)
      .set('X-CSRF-Token', sessionA.csrf)
      .expect(201);
    expect(approved.body.status).toBe('APPROVED');
  });

  it('broker documents over HTTP: a broker can list and download their own statement; an unrelated broker cannot download it', async () => {
    const { token: tokenA } = await brokerSession(brokerAPhone);
    const { token: tokenB } = await brokerSession(brokerBPhone);

    // Generate via the staff HTTP route so this is a real end-to-end
    // artifact, not a direct service call.
    const { agent, token: staffToken, csrf } = await staffLoginWithCsrf();
    const doc = await agent
      .post(`/api/v1/brokers/${brokerAId}/documents/statement`)
      .set('Authorization', `Bearer ${staffToken}`)
      .set('X-CSRF-Token', csrf)
      .expect(201);
    const documentId = doc.body.id as string;

    const list = await request(app.getHttpServer())
      .get('/api/v1/portal/broker/documents')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect((list.body as Array<{ id: string }>).map((d) => d.id)).toContain(documentId);

    await request(app.getHttpServer())
      .get(`/api/v1/portal/broker/documents/${documentId}/download`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/v1/portal/broker/documents/${documentId}/download`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);
  });

  function extractCookie(setCookieHeader: string[] | string | undefined, name: string): string {
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ''];
    for (const h of headers) {
      const match = new RegExp(`${name}=([^;]+)`).exec(h);
      if (match) return match[1];
    }
    throw new Error(`Cookie ${name} not found in Set-Cookie headers`);
  }

  /** Same double-submit-CSRF-capture pattern as e2e-portal.test.ts's
   * staffLoginWithCsrf — staff mutations need both the Bearer token and
   * the CSRF cookie/header pair. */
  async function staffLoginWithCsrf() {
    const agent = request.agent(app.getHttpServer());
    const res = await agent
      .post('/api/v1/auth/login')
      .send({ email: staffEmail, password: STAFF_PASSWORD })
      .expect(200);
    const csrf = extractCookie(res.headers['set-cookie'], 'openestate_csrf');
    return { agent, token: res.body.accessToken as string, csrf };
  }
});
