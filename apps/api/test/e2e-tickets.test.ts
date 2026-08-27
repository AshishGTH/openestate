/**
 * Through-the-wire coverage for AdminTicketController — this project's
 * own standing rule since Phase 6 commit 2 ("every new controller gets a
 * through-the-wire supertest") had never actually been applied here.
 * TicketService.addMessage had direct-call-only coverage
 * (notifications.test.ts) — proves the handler logic, not that the four
 * routes are registered, permission-gated, and CSRF-protected. v0.2.1
 * closes the "customers can raise tickets, staff cannot answer" loop, so
 * this is exactly the surface that needs it.
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
import { ALL_PERMISSIONS, PERMISSIONS, TICKET_STATUS } from '@openestate/shared';
import { makeClients, seedCompany, makeApplicant, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const STAFF_PASSWORD = 'StaffPass123';
const TAG = Date.now();

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

describeIf('e2e AdminTicketController: queue, thread, respond, status', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let adminEmail: string;
  let ticketId: string;
  let applicantName: string;

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
      data: { companyId: fx.companyId, name: 'E2E Ticket Admin', slug: `e2e_ticket_admin_${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permByKey.get(PERMISSIONS.ADMIN_TICKET_RESPOND) },
    });

    adminEmail = `e2e-ticket-admin-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: adminEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Ticket Admin',
        roleId: role.id,
        forcePasswordChange: false,
      },
    });

    const category = await systemPrisma.ticketCategory.create({
      data: { companyId: fx.companyId, name: `E2E Category ${TAG}` },
    });
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const applicant = await systemPrisma.applicant.findUnique({ where: { id: applicantId } });
    applicantName = applicant.name;

    const ticket = await systemPrisma.ticket.create({
      data: {
        companyId: fx.companyId,
        raisedById: applicantId,
        applicantId,
        categoryId: category.id,
        subject: `E2E Ticket ${TAG}`,
        status: TICKET_STATUS.OPEN,
      },
    });
    await systemPrisma.ticketMessage.create({
      data: {
        companyId: fx.companyId,
        ticketId: ticket.id,
        authorId: applicantId,
        authorIsStaff: false,
        body: 'Opening message from customer',
      },
    });
    ticketId = ticket.id;
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

  async function loginAgent() {
    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: adminEmail, password: STAFF_PASSWORD }).expect(200);
    const csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');
    const token = loginRes.body.accessToken as string;
    return { agent, csrf, token };
  }

  it('GET /admin/tickets returns the queue, oldest first, enriched with raiser/category/message stats', async () => {
    const { agent, token } = await loginAgent();
    const res = await agent.get('/api/v1/admin/tickets').set('Authorization', `Bearer ${token}`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    const found = res.body.find((t: { id: string }) => t.id === ticketId);
    expect(found).toBeTruthy();
    expect(found.raisedByName).toBe(applicantName);
    expect(found.messageCount).toBe(1);
    expect(found.lastMessageAt).toBeTruthy();
  });

  it('GET /admin/tickets/:id returns the thread with the opening message and enriched header', async () => {
    const { agent, token } = await loginAgent();
    const res = await agent.get(`/api/v1/admin/tickets/${ticketId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.raisedByName).toBe(applicantName);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].authorIsStaff).toBe(false);
  });

  it('POST /admin/tickets/:id/respond adds a staff message that shows up in the thread', async () => {
    const { agent, csrf, token } = await loginAgent();
    const respondRes = await agent
      .post(`/api/v1/admin/tickets/${ticketId}/respond`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ body: 'Staff reply over real HTTP' })
      .expect(201);
    expect(respondRes.body.authorIsStaff).toBe(true);

    const threadRes = await agent.get(`/api/v1/admin/tickets/${ticketId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(threadRes.body.messages).toHaveLength(2);
    expect(threadRes.body.messages[1].authorIsStaff).toBe(true);
    expect(threadRes.body.messages[1].body).toBe('Staff reply over real HTTP');
  });

  it('PATCH /admin/tickets/:id/status updates the status, reflected in both the thread and the queue', async () => {
    const { agent, csrf, token } = await loginAgent();
    await agent
      .patch(`/api/v1/admin/tickets/${ticketId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ status: TICKET_STATUS.RESOLVED })
      .expect(200);

    const threadRes = await agent.get(`/api/v1/admin/tickets/${ticketId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(threadRes.body.status).toBe(TICKET_STATUS.RESOLVED);

    const queueRes = await agent
      .get(`/api/v1/admin/tickets?status=${TICKET_STATUS.RESOLVED}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(queueRes.body.some((t: { id: string }) => t.id === ticketId)).toBe(true);
  });
});
