/**
 * The broker dashboard is gated by its own portal permission, not by the
 * staff report permission. A broker whose role holds only portal.*
 * permissions loads it; a broker holding only the old staff permission is
 * refused; a customer is refused.
 *
 * Needs the compiled dist/ and the local test database.
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
import {
  makeClients,
  seedCompany,
  makeBroker,
  makeApplicant,
  cleanupCompany,
  type CompanyFixture,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-broker-dash-perm-${process.pid}-${Date.now()}-`;

const DASHBOARD_PERM = 'portal.broker.dashboard.read';
const PW = 'PortalPass12345';
const TAG = Date.now();

describeIf('Broker dashboard: own portal permission, not the staff report permission', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let newBrokerPhone: string;
  let oldBrokerPhone: string;
  let customerPhone: string;

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

    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of [...ALL_PERMISSIONS, DASHBOARD_PERM]) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map<string, string>(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));
    const portalRole = async (slug: string, keys: string[]) => {
      const role = await systemPrisma.role.create({
        data: { companyId: fx.companyId, name: slug, slug, isSystem: false, isPortal: true },
      });
      await systemPrisma.rolePermission.createMany({
        data: keys.map((key) => ({ roleId: role.id, permissionId: permByKey.get(key) })),
      });
      return role.id as string;
    };

    // The post-change broker role: portal permissions only.
    const newBrokerRoleId = await portalRole(`e2e-bdp-new-${TAG}`, [
      PERMISSIONS.PORTAL_BOOKING_READ,
      PERMISSIONS.PORTAL_NOC_ACTION,
      DASHBOARD_PERM,
    ]);
    // The pre-change broker role: the staff report permission, not the new one.
    const oldBrokerRoleId = await portalRole(`e2e-bdp-old-${TAG}`, [
      PERMISSIONS.PORTAL_BOOKING_READ,
      PERMISSIONS.PORTAL_NOC_ACTION,
      PERMISSIONS.REPORTS_BROKER_VIEW,
    ]);
    const customerRoleId = await portalRole(`e2e-bdp-cust-${TAG}`, [PERMISSIONS.PORTAL_BOOKING_READ]);

    const hash = await argon2.hash(PW, { algorithm: argon2.Algorithm.Argon2id });
    const brokerUser = async (roleId: string) => {
      const brokerId = await makeBroker(systemPrisma, fx.companyId);
      const broker = await systemPrisma.broker.findUniqueOrThrow({ where: { id: brokerId } });
      await systemPrisma.user.create({
        data: { companyId: fx.companyId, brokerId, phone: broker.phone, name: broker.name, passwordHash: hash, roleId, forcePasswordChange: false },
      });
      return broker.phone as string;
    };
    newBrokerPhone = await brokerUser(newBrokerRoleId);
    oldBrokerPhone = await brokerUser(oldBrokerRoleId);

    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    customerPhone = `7${String(TAG).slice(-9)}`;
    await systemPrisma.user.create({
      data: { companyId: fx.companyId, applicantId, phone: customerPhone, name: 'E2E BDP Customer', passwordHash: hash, roleId: customerRoleId, forcePasswordChange: false },
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    if (fx) await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma?.$disconnect();
  });

  async function dashboardStatus(identifier: string): Promise<number> {
    const login = await request(app.getHttpServer())
      .post('/api/v1/portal/auth/login')
      .send({ identifier, password: PW })
      .expect(200);
    const res = await request(app.getHttpServer())
      .get('/api/v1/portal/broker/dashboard')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    return res.status;
  }

  it('a broker whose role holds only portal permissions loads their dashboard (200)', async () => {
    expect(await dashboardStatus(newBrokerPhone)).toBe(200);
  });

  it('a broker holding the staff report permission but not the portal one is refused (403)', async () => {
    expect(await dashboardStatus(oldBrokerPhone)).toBe(403);
  });

  it('control: a customer is refused (403)', async () => {
    expect(await dashboardStatus(customerPhone)).toBe(403);
  });
});
