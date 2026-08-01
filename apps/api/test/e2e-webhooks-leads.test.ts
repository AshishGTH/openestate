/**
 * Phase 7 commit 2 (webhooks-and-leads): through-the-wire supertest
 * proof for the four new controllers (standing rule since Phase 6
 * commit 2), plus the inbound lead API's per-key rate limit — which,
 * like every throttle bucket in this codebase, can only be proven over
 * real HTTP (a direct controller call never touches ThrottlerGuard).
 *
 * Requires the compiled dist/ (see e2e-portal.test.ts's doc comment for
 * why — esbuild's transform doesn't emit correct decorator metadata for
 * NestJS DI).
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

async function seedStaffUser(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  systemPrisma: any,
  fx: CompanyFixture,
  email: string,
  permissionKeys: string[],
): Promise<void> {
  for (const key of ALL_PERMISSIONS) {
    await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
  }
  const allPerms = await systemPrisma.permission.findMany();
  const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));

  const role = await systemPrisma.role.create({
    data: { companyId: fx.companyId, name: `E2E ${email}`, slug: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, isSystem: true },
  });
  if (permissionKeys.length > 0) {
    await systemPrisma.rolePermission.createMany({
      data: permissionKeys.map((key) => ({ roleId: role.id, permissionId: permByKey.get(key) })),
    });
  }
  await systemPrisma.user.create({
    data: {
      companyId: fx.companyId,
      email,
      passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
      name: email,
      roleId: role.id,
      forcePasswordChange: false,
    },
  });
}

describeIf('Phase 7 e2e: webhook + lead-api-key admin controllers through the full guard pipeline', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let adminEmail: string;
  let leadApiKeyRaw: string;
  let leadApiKeyMapping: Record<string, string>;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    const tag = Date.now();
    adminEmail = `e2e-webhook-admin-${tag}@test.com`;
    await seedStaffUser(systemPrisma, fx, adminEmail, [
      PERMISSIONS.ADMIN_WEBHOOK_READ,
      PERMISSIONS.ADMIN_WEBHOOK_MANAGE,
      PERMISSIONS.ADMIN_LEAD_API_KEY_READ,
      PERMISSIONS.ADMIN_LEAD_API_KEY_MANAGE,
    ]);
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

  it('POST /admin/webhook-endpoints creates an endpoint with the secret never returned; GET lists it without the secret', async () => {
    const { agent, token, csrf } = await loginWithCsrf();
    const created = await agent
      .post('/api/v1/admin/webhook-endpoints')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: 'E2E Endpoint', url: 'https://example.com/hook', secret: 'e2e-endpoint-signing-secret-1', eventTypes: ['booking.created'] })
      .expect(201);
    expect(created.body).not.toHaveProperty('secretCiphertext');
    expect(JSON.stringify(created.body)).not.toContain('e2e-endpoint-signing-secret-1');

    const list = await request(app.getHttpServer()).get('/api/v1/admin/webhook-endpoints').set('Authorization', `Bearer ${token}`).expect(200);
    const found = (list.body as Array<{ id: string }>).find((e) => e.id === created.body.id);
    expect(found).toBeDefined();
    expect(JSON.stringify(list.body)).not.toContain('e2e-endpoint-signing-secret-1');
  });

  it('GET /admin/webhook-endpoints is rejected 403 without admin.webhook.read', async () => {
    const noPermEmail = `e2e-no-perm-${Date.now()}@test.com`;
    await seedStaffUser(systemPrisma, fx, noPermEmail, []);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: noPermEmail, password: STAFF_PASSWORD }).expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/admin/webhook-endpoints')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(403);
  });

  it('GET /admin/webhook-deliveries?webhookEndpointId= lists deliveries for an endpoint (route registered, guard passes)', async () => {
    const { agent, token, csrf } = await loginWithCsrf();
    const endpoint = await agent
      .post('/api/v1/admin/webhook-endpoints')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Delivery List Endpoint', url: 'https://example.com/hook2', secret: 'e2e-endpoint-signing-secret-2', eventTypes: ['booking.created'] })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/admin/webhook-deliveries?webhookEndpointId=${endpoint.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /admin/webhook-deliveries/:id/retry 404s for a delivery that does not exist', async () => {
    const { agent, token, csrf } = await loginWithCsrf();
    await agent
      .post('/api/v1/admin/webhook-deliveries/00000000-0000-0000-0000-000000000000/retry')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .expect(404);
  });

  it('POST /admin/lead-api-keys creates a key, returns the raw value once; GET list never returns keyHash', async () => {
    const { agent, token, csrf } = await loginWithCsrf();
    const created = await agent
      .post('/api/v1/admin/lead-api-keys')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: 'E2E Vendor', fieldMapping: { name: 'lead.full_name', phone: 'lead.mobile' }, rateLimitPerMinute: 5 })
      .expect(201);
    expect(created.body.rawKey).toMatch(/^oe_live_/);
    leadApiKeyRaw = created.body.rawKey;
    leadApiKeyMapping = { name: 'lead.full_name', phone: 'lead.mobile' };

    const list = await request(app.getHttpServer()).get('/api/v1/admin/lead-api-keys').set('Authorization', `Bearer ${token}`).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(leadApiKeyRaw);
  });

  it('POST /leads/inbound without X-Api-Key is rejected 401', async () => {
    await request(app.getHttpServer()).post('/api/v1/leads/inbound').send({ lead: { full_name: 'X', mobile: '9000000000' } }).expect(401);
  });

  it('POST /leads/inbound with a valid key and a well-formed payload creates a real inquiry', async () => {
    const phone = `9${Date.now()}`.slice(0, 10);
    const res = await request(app.getHttpServer())
      .post('/api/v1/leads/inbound')
      .set('X-Api-Key', leadApiKeyRaw)
      .send({ lead: { full_name: 'E2E Inbound Lead', mobile: phone } })
      .expect(201);
    expect(res.body.applicantId).toBeTruthy();

    const applicant = await systemPrisma.applicant.findUnique({ where: { id: res.body.applicantId } });
    expect(applicant.name).toBe('E2E Inbound Lead');
  });

  it('POST /leads/inbound with a payload missing the required "phone" path returns the specific 400 message', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/leads/inbound')
      .set('X-Api-Key', leadApiKeyRaw)
      .send({ lead: { full_name: 'No Phone' } })
      .expect(400);
    expect(res.body.message).toMatch(/Could not resolve required field 'phone' at path 'lead\.mobile'/);
  });

  it('POST /leads/inbound with an invalid key is rejected 401', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/leads/inbound')
      .set('X-Api-Key', 'oe_live_not_a_real_key')
      .send({ lead: { full_name: 'X', mobile: '9000000001' } })
      .expect(401);
  });
});

describeIf('Phase 7 e2e: inbound lead API per-key rate limit over real HTTP', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let leadApiKeyRaw: string;

  beforeAll(async () => {
    // Own app instance — @nestjs/throttler's default in-memory storage is
    // per-process, so a shared app would let the earlier describe block's
    // requests (or this test's own setup calls) eat into the budget this
    // test needs to measure precisely. Same reasoning as
    // e2e-portal-throttle.test.ts's two-app-instance pattern.
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    const adminEmail = `e2e-throttle-admin-${Date.now()}@test.com`;
    await seedStaffUser(systemPrisma, fx, adminEmail, [PERMISSIONS.ADMIN_LEAD_API_KEY_MANAGE]);
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post('/api/v1/auth/login').send({ email: adminEmail, password: STAFF_PASSWORD }).expect(200);
    const csrfCookie = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('openestate_csrf='))!;
    const csrf = csrfCookie.split('=')[1].split(';')[0];

    const created = await agent
      .post('/api/v1/admin/lead-api-keys')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Throttle Test Vendor', fieldMapping: { name: 'lead.full_name', phone: 'lead.mobile' }, rateLimitPerMinute: 3 })
      .expect(201);
    leadApiKeyRaw = created.body.rawKey;
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  it('the 4th inbound request within a minute from this key returns 429; the first 3 succeed', async () => {
    const attempt = (n: number) =>
      request(app.getHttpServer())
        .post('/api/v1/leads/inbound')
        .set('X-Api-Key', leadApiKeyRaw)
        .send({ lead: { full_name: `Throttle Lead ${n}`, mobile: `9${Date.now()}${n}`.slice(0, 10) } });

    for (let i = 0; i < 3; i++) {
      const res = await attempt(i);
      expect(res.status).toBe(201);
    }
    const fourth = await attempt(3);
    expect(fourth.status).toBe(429);
  });
});
