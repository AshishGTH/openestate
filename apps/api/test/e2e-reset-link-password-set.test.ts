/**
 * Setting a password by any route other than the reset link itself consumes
 * the user's outstanding reset links, so a stale admin-issued link can't
 * overwrite the password the user just chose. Covers all four places a
 * password is set, staff and portal:
 *  - staff change-password and force-change-password (first login)
 *  - portal change-password and invite consumption (which also reactivates)
 *
 * Each test issues a link, sets a password another way, then shows the old
 * link is refused and the new password still stands.
 *
 * Throttle budget: both confirm endpoints are public and IP-keyed, 5 per
 * 5 minutes per handler. This file spends 2 on each, plus one portal login
 * and one invite consume (separate handlers); the prefix below keeps that
 * budget private to this file.
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
import {
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  SYSTEM_ROLES,
  forcePasswordResetResponseSchema,
} from '@openestate/shared';
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
const NEW_PASSWORD = 'ChosenByUser222';
const STALE_LINK_PASSWORD = 'FromStaleLink333';

process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-reset-password-set-${process.pid}-${Date.now()}-`;

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

describeIf('e2e setting a password consumes outstanding reset links', () => {
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
    const allPerms: Array<{ id: string; key: string }> = await systemPrisma.permission.findMany();
    const adminRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Reset PwdSet Admin', slug: `e2e-reset-pwdset-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: allPerms.map((p) => ({ roleId: adminRole.id, permissionId: p.id })),
    });
    adminRoleId = adminRole.id;

    customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    const customerKeys = new Set<string>(ROLE_PERMISSIONS[SYSTEM_ROLES.CUSTOMER]);
    await systemPrisma.rolePermission.createMany({
      data: allPerms.filter((p) => customerKeys.has(p.key)).map((p) => ({ roleId: customerRoleId, permissionId: p.id })),
    });

    adminEmail = (await createStaff(ADMIN_PASSWORD)).email;
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  const hash = (password: string) => argon2.hash(password, { algorithm: argon2.Algorithm.Argon2id });

  async function createStaff(password: string, forcePasswordChange = false) {
    const email = `e2e-reset-pwdset-${TAG}-${seq++}@test.com`;
    const user = await systemPrisma.user.create({
      data: {
        companyId: fx.companyId, email, passwordHash: await hash(password),
        name: 'E2E Reset PwdSet Staff', roleId: adminRoleId, forcePasswordChange,
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
    return { id: user.id as string, applicantId: applicantId as string, phone: a.primaryPhone as string };
  }

  async function staffSession(email: string, password: string) {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email, password }).expect(200);
    const csrf = extractCookie(res.headers['set-cookie'], 'openestate_csrf')!;
    const post = (path: string, body?: object) =>
      agent.post(path).set('Authorization', `Bearer ${res.body.accessToken}`).set('X-CSRF-Token', csrf).send(body);
    return post;
  }

  async function adminResetToken(path: string, body?: object): Promise<string> {
    const post = await staffSession(adminEmail, ADMIN_PASSWORD);
    const res = await post(path, body).expect(200);
    return forcePasswordResetResponseSchema.parse(res.body).token;
  }

  const staffConfirm = (token: string) =>
    request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token, newPassword: STALE_LINK_PASSWORD });
  const portalConfirm = (token: string) =>
    request(app.getHttpServer())
      .post('/api/v1/portal/auth/password-reset/confirm')
      .send({ token, newPassword: STALE_LINK_PASSWORD });

  async function passwordIs(userId: string, password: string): Promise<boolean> {
    const user = await systemPrisma.user.findUniqueOrThrow({ where: { id: userId } });
    return argon2.verify(user.passwordHash, password);
  }

  it('staff change-password consumes an outstanding reset link', async () => {
    const target = await createStaff(OLD_PASSWORD);
    const link = await adminResetToken(`/api/v1/users/${target.id}/force-password-reset`);

    const post = await staffSession(target.email, OLD_PASSWORD);
    await post('/api/v1/auth/change-password', { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }).expect(204);

    await staffConfirm(link).expect(401);
    expect(await passwordIs(target.id, NEW_PASSWORD)).toBe(true);
  });

  it('staff force-change-password (first login) consumes an outstanding reset link', async () => {
    const target = await createStaff(OLD_PASSWORD, true);
    const link = await adminResetToken(`/api/v1/users/${target.id}/force-password-reset`);

    const post = await staffSession(target.email, OLD_PASSWORD);
    await post('/api/v1/auth/force-change-password', { newPassword: NEW_PASSWORD }).expect(204);

    await staffConfirm(link).expect(401);
    expect(await passwordIs(target.id, NEW_PASSWORD)).toBe(true);
  });

  it('portal change-password consumes an outstanding reset link', async () => {
    const target = await createPortalApplicant(OLD_PASSWORD);
    const link = await adminResetToken('/api/v1/admin/portal-password-resets', { applicantId: target.applicantId });

    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/api/v1/portal/auth/login')
      .send({ identifier: target.phone, password: OLD_PASSWORD })
      .expect(200);
    await agent
      .post('/api/v1/portal/auth/change-password')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .set('X-CSRF-Token', extractCookie(login.headers['set-cookie'], 'openestate_portal_csrf')!)
      .send({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD })
      .expect(204);

    await portalConfirm(link).expect(401);
    expect(await passwordIs(target.id, NEW_PASSWORD)).toBe(true);
  });

  it('portal invite consumption for an existing account consumes an outstanding reset link', async () => {
    const target = await createPortalApplicant(OLD_PASSWORD);
    const link = await adminResetToken('/api/v1/admin/portal-password-resets', { applicantId: target.applicantId });

    const post = await staffSession(adminEmail, ADMIN_PASSWORD);
    const invite = await post('/api/v1/admin/portal-invites', { applicantId: target.applicantId, channel: 'SMS' }).expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/portal/auth/invite/${invite.body.inviteId}/consume`)
      .send({ token: invite.body.token, password: NEW_PASSWORD })
      .expect(200);

    await portalConfirm(link).expect(401);
    expect(await passwordIs(target.id, NEW_PASSWORD)).toBe(true);
  });
});
