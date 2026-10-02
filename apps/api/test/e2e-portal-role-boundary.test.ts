/**
 * v0.8.2 Part C: an account whose ROLE is a portal role (isPortal) can never
 * hold a staff session, whether or not it carries an applicant/broker link,
 * and the database refuses to store an unlinked portal-role account at all.
 *
 * A pre-existing unlinked portal-role row can't be created through the
 * normal client any more (that's the point of the trigger), so those rows are
 * planted over a superuser connection with triggers off for that session —
 * the same state an install can already be carrying from before v0.8.1.
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
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@openestate/db';
import { makeClients, seedCompany, makeApplicant, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const SUPER_URL = process.env.DATABASE_URL_TEST_SUPER ?? 'postgresql://openestate_super:test_super_pass@localhost:5432/openestate_test';
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const PW = 'StaffPass12345';
const TAG = Date.now();

describeIf('v0.8.2 portal-role boundary', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let superPrisma: PrismaClient;
  let fx: CompanyFixture;
  let hash: string;
  let portalRoleId: string;
  let staffRoleId: string;

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
    process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-portal-role-boundary-${process.pid}-${Date.now()}-`;

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
    superPrisma = new PrismaClient({ datasourceUrl: SUPER_URL });
    fx = await seedCompany(systemPrisma);
    hash = await argon2.hash(PW, { algorithm: argon2.Algorithm.Argon2id });
    portalRoleId = (
      await systemPrisma.role.create({
        data: { companyId: fx.companyId, name: 'p', slug: `e2e-prb-portal-${TAG}`, isPortal: true },
      })
    ).id;
    staffRoleId = (
      await systemPrisma.role.create({ data: { companyId: fx.companyId, name: 's', slug: `e2e-prb-staff-${TAG}` } })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    if (fx) await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma?.$disconnect();
    await superPrisma?.$disconnect();
  });

  /** Plants a user with the trigger bypassed for this one transaction. */
  async function plantUnlinkedPortalUser(email: string): Promise<string> {
    const id = randomUUID();
    await superPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await tx.$executeRawUnsafe(
        `INSERT INTO users (id, company_id, email, password_hash, name, role_id, is_active, force_password_change, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'planted', $5::uuid, true, false, now())`,
        id,
        fx.companyId,
        email,
        hash,
        portalRoleId,
      );
    });
    return id;
  }

  it('staff login refuses an UNLINKED portal-role account with the generic 401', async () => {
    const email = `e2e-prb-${TAG}-a@test.com`;
    await plantUnlinkedPortalUser(email);
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: PW });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
  });

  it('staff refresh refuses an unlinked portal-role account that already holds a refresh token', async () => {
    const email = `e2e-prb-${TAG}-b@test.com`;
    const userId = await plantUnlinkedPortalUser(email);
    // A refresh token minted before the fix: login can't produce one now, so insert via login as a
    // staff-role account then flip the role over the superuser connection.
    const staff = await systemPrisma.user.create({
      data: { companyId: fx.companyId, email: `e2e-prb-${TAG}-b2@test.com`, passwordHash: hash, name: 'b2', roleId: staffRoleId, forcePasswordChange: false },
    });
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/v1/auth/login').send({ email: staff.email, password: PW }).expect(200);
    await superPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await tx.$executeRawUnsafe(`UPDATE users SET role_id = $1::uuid WHERE id = $2::uuid`, portalRoleId, staff.id);
    });
    await agent.post('/api/v1/auth/refresh').expect(401);
    expect(userId).toBeTruthy();
  });

  it('control: a linked portal account still cannot use the STAFF login, and a staff account still can', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const linkedEmail = `e2e-prb-${TAG}-linked@test.com`;
    await systemPrisma.user.create({
      data: { companyId: fx.companyId, applicantId, email: linkedEmail, passwordHash: hash, name: 'linked', roleId: portalRoleId },
    });
    expect(
      (await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: linkedEmail, password: PW })).status,
    ).toBe(401);

    const staff = await systemPrisma.user.create({
      data: { companyId: fx.companyId, email: `e2e-prb-${TAG}-ok@test.com`, passwordHash: hash, name: 'ok', roleId: staffRoleId, forcePasswordChange: false },
    });
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: staff.email, password: PW }).expect(200);
  });

  describe('database trigger forbid_unlinked_portal_role', () => {
    it('rejects INSERT of a portal-role user with no applicant/broker link', async () => {
      await expect(
        systemPrisma.user.create({
          data: { companyId: fx.companyId, email: `e2e-prb-${TAG}-t1@test.com`, passwordHash: hash, name: 't', roleId: portalRoleId },
        }),
      ).rejects.toThrow(/portal role requires an applicant_id or broker_id/);
    });

    it('rejects an UPDATE that moves a staff user onto a portal role with no link', async () => {
      const u = await systemPrisma.user.create({
        data: { companyId: fx.companyId, email: `e2e-prb-${TAG}-t2@test.com`, passwordHash: hash, name: 't', roleId: staffRoleId },
      });
      await expect(systemPrisma.user.update({ where: { id: u.id }, data: { roleId: portalRoleId } })).rejects.toThrow(
        /portal role requires/,
      );
    });

    it('rejects an UPDATE that strips the link from a portal user', async () => {
      const applicantId = await makeApplicant(systemPrisma, fx.companyId);
      const u = await systemPrisma.user.create({
        data: { companyId: fx.companyId, applicantId, phone: `6${String(TAG).slice(-8)}1`, passwordHash: hash, name: 't', roleId: portalRoleId },
      });
      await expect(systemPrisma.user.update({ where: { id: u.id }, data: { applicantId: null } })).rejects.toThrow(
        /portal role requires/,
      );
    });

    it('does NOT fire on ordinary updates, so a pre-existing bad row stays usable by its own owner', async () => {
      const id = await plantUnlinkedPortalUser(`e2e-prb-${TAG}-t3@test.com`);
      await expect(systemPrisma.user.update({ where: { id }, data: { name: 'renamed', lastLoginAt: new Date() } })).resolves.toBeTruthy();
    });

    it('fails CLOSED on an unresolvable role_id (rejected, not silently allowed)', async () => {
      // FK would normally catch this first; replica mode skips FKs, leaving only the trigger's own check — so
      // run it with triggers ON (default) by deferring nothing: the FK error or the trigger error both reject.
      await expect(
        superPrisma.$executeRawUnsafe(
          `INSERT INTO users (id, company_id, email, password_hash, name, role_id, is_active, force_password_change, updated_at)
           VALUES (gen_random_uuid(), '${fx.companyId}'::uuid, 'e2e-prb-${TAG}-t4@test.com', 'x', 'x', gen_random_uuid(), true, false, now())`,
        ),
      ).rejects.toThrow();
    });

    it('SECURITY DEFINER: still resolves the role when the session has hostile RLS/tenant context', async () => {
      // openestate_test_app is RLS-enforced and has set no tenant context here: it can't SELECT roles itself,
      // yet the trigger must still see the role row (and so reject) rather than fail open.
      const appPrisma = new PrismaClient({ datasourceUrl: APP_URL });
      try {
        await expect(
          appPrisma.$executeRawUnsafe(
            `INSERT INTO users (id, company_id, email, password_hash, name, role_id, is_active, force_password_change, updated_at)
             VALUES (gen_random_uuid(), '${fx.companyId}'::uuid, 'e2e-prb-${TAG}-t5@test.com', 'x', 'x', '${portalRoleId}'::uuid, true, false, now())`,
          ),
        ).rejects.toThrow();
        expect(await systemPrisma.user.count({ where: { email: `e2e-prb-${TAG}-t5@test.com` } })).toBe(0);
      } finally {
        await appPrisma.$disconnect();
      }
    });
  });
});
