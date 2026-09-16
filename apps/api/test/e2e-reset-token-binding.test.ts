/**
 * A password-reset token only works on the surface that issued it. A staff
 * token (password_resets) must be rejected by the portal confirm endpoint,
 * and a portal token (portal_password_resets) by the staff one — each
 * endpoint only ever looks in its own table.
 *
 * The rejected attempt must not use the token up or change a password, so
 * each test then redeems the same token on its own surface. That also proves
 * the token was valid, and the 401 was about the surface, not a bad fixture.
 *
 * Throttle budget: both confirm endpoints are public and IP-keyed, 5 per
 * 5 minutes per handler. This file spends 2 on each; the prefix below keeps
 * that budget private to this file.
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
import { ALL_PERMISSIONS, forcePasswordResetResponseSchema } from '@openestate/shared';
import {
  makeClients,
  seedCompany,
  makeApplicant,
  makePortalRole,
  cleanupCompany,
  type CompanyFixture,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const TAG = Date.now();
const ADMIN_PASSWORD = 'AdminPass1111';
const OLD_PASSWORD = 'TargetOldPass111';

process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-reset-binding-${process.pid}-${Date.now()}-`;

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

function extractCookie(setCookieHeader: string[] | string | undefined, name: string): string | undefined {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ''];
  for (const h of headers) {
    const match = new RegExp(`${name}=([^;]+)`).exec(h);
    if (match) return match[1];
  }
  return undefined;
}

describeIf('e2e reset tokens are bound to their own surface', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let adminRoleId: string;
  let customerRoleId: string;
  let adminEmail: string;
  let seq = 0;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms: Array<{ id: string }> = await systemPrisma.permission.findMany();
    const adminRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Reset Binding Admin', slug: `e2e-reset-binding-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: allPerms.map((p) => ({ roleId: adminRole.id, permissionId: p.id })),
    });
    adminRoleId = adminRole.id;
    customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    adminEmail = (await createStaff(ADMIN_PASSWORD)).email;
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  const hash = (password: string) => argon2.hash(password, { algorithm: argon2.Algorithm.Argon2id });

  async function createStaff(password: string) {
    const email = `e2e-reset-binding-${TAG}-${seq++}@test.com`;
    const user = await systemPrisma.user.create({
      data: {
        companyId: fx.companyId, email, passwordHash: await hash(password),
        name: 'E2E Reset Binding Staff', roleId: adminRoleId, forcePasswordChange: false,
      },
    });
    return { id: user.id as string, email };
  }

  async function createPortalApplicant(password: string) {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const a = await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicantId } });
    const user = await systemPrisma.user.create({
      data: {
        companyId: fx.companyId, applicantId, phone: a.primaryPhone, name: a.name,
        passwordHash: await hash(password), roleId: customerRoleId, forcePasswordChange: false,
      },
    });
    return { id: user.id as string, applicantId };
  }

  async function adminPost(path: string, body?: object): Promise<string> {
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post('/api/v1/auth/login').send({ email: adminEmail, password: ADMIN_PASSWORD }).expect(200);
    const res = await agent
      .post(path)
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .set('X-CSRF-Token', extractCookie(login.headers['set-cookie'], 'openestate_csrf')!)
      .send(body)
      .expect(200);
    return forcePasswordResetResponseSchema.parse(res.body).token;
  }

  const staffConfirm = (token: string, newPassword: string) =>
    request(app.getHttpServer()).post('/api/v1/auth/password-reset/confirm').send({ token, newPassword });
  const portalConfirm = (token: string, newPassword: string) =>
    request(app.getHttpServer()).post('/api/v1/portal/auth/password-reset/confirm').send({ token, newPassword });

  async function passwordIs(userId: string, password: string): Promise<boolean> {
    const user = await systemPrisma.user.findUniqueOrThrow({ where: { id: userId } });
    return argon2.verify(user.passwordHash, password);
  }

  it('a staff token is rejected by the portal confirm endpoint, and still works on the staff one', async () => {
    const target = await createStaff(OLD_PASSWORD);
    const token = await adminPost(`/api/v1/users/${target.id}/force-password-reset`);

    await portalConfirm(token, 'CrossSurfacePass1').expect(401);
    expect(await passwordIs(target.id, OLD_PASSWORD)).toBe(true);
    const reset = await systemPrisma.passwordReset.findFirstOrThrow({ where: { userId: target.id } });
    expect(reset.consumedAt).toBeNull();

    await staffConfirm(token, 'SameSurfacePass1').expect(204);
    expect(await passwordIs(target.id, 'SameSurfacePass1')).toBe(true);
  });

  it('a portal token is rejected by the staff confirm endpoint, and still works on the portal one', async () => {
    const target = await createPortalApplicant(OLD_PASSWORD);
    const token = await adminPost('/api/v1/admin/portal-password-resets', { applicantId: target.applicantId });

    await staffConfirm(token, 'CrossSurfacePass1').expect(401);
    expect(await passwordIs(target.id, OLD_PASSWORD)).toBe(true);
    const reset = await systemPrisma.portalPasswordReset.findFirstOrThrow({ where: { userId: target.id } });
    expect(reset.consumedAt).toBeNull();

    await portalConfirm(token, 'SameSurfacePass1').expect(204);
    expect(await passwordIs(target.id, 'SameSurfacePass1')).toBe(true);
  });
});
