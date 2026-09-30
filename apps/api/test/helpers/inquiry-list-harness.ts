/**
 * Shared through-the-wire harness for the inquiry list / follow-up / activity
 * endpoints the mobile app consumes. Real Nest app, real HTTP, real guard and
 * JWT pipeline, so authorization and validation are proven end to end.
 * Requires the compiled dist/ (see e2e-inquiry-assignment.test.ts for why).
 */
import { describe } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from '@node-rs/argon2';
import { ALL_PERMISSIONS, normalizeEmail, normalizePhone } from '@openestate/shared';

export const STAFF_PASSWORD = 'StaffPass123';
export const TAG = Date.now();

// main.ts serialises BigInt as a string; e2e files boot AppModule directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function (this: bigint) {
  return this.toString();
};

export const dbUrls = () => ({ app: process.env.DATABASE_URL_TEST, system: process.env.DATABASE_URL_TEST_SYSTEM });
export const describeIfDb = dbUrls().app && dbUrls().system ? describe : describe.skip;

export async function bootstrapApp(): Promise<INestApplication> {
  const { app, system } = dbUrls();
  process.env.DATABASE_URL = app;
  process.env.DATABASE_URL_SYSTEM = system;
  process.env.REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';
  process.env.JWT_ACCESS_SECRET ??= 'e2e-test-access-secret-0123456789';
  process.env.JWT_REFRESH_SECRET ??= 'e2e-test-refresh-secret-0123456789';
  process.env.PAN_ENCRYPTION_KEY ??= 'a1b2c3d4'.repeat(8);
  process.env.TOTP_ENCRYPTION_KEY ??= 'e5f6a7b8'.repeat(8);
  process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'c9d8e7f6'.repeat(8)}`;
  process.env.CORS_ALLOWLIST ??= 'http://localhost:5174';
  process.env.SWAGGER_ENABLED = 'false';
  const require = createRequire(import.meta.url);
  const { AppModule } = require('../../dist/app.module');
  const nestApp = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  nestApp.use(helmet());
  nestApp.use(cookieParser());
  nestApp.setGlobalPrefix('api/v1');
  nestApp.useGlobalPipes(new ZodValidationPipe());
  await nestApp.init();
  return nestApp;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Prisma = any;

export async function ensurePermissions(systemPrisma: Prisma) {
  for (const key of ALL_PERMISSIONS) await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
  const all = await systemPrisma.permission.findMany();
  return new Map<string, string>(all.map((p: { key: string; id: string }) => [p.key, p.id]));
}

export async function makeRole(systemPrisma: Prisma, companyId: string, slug: string, keys: string[], permByKey: Map<string, string>) {
  const role = await systemPrisma.role.create({ data: { companyId, name: slug, slug: `${slug}-${TAG}`, isSystem: false } });
  await systemPrisma.rolePermission.createMany({ data: keys.map((k) => ({ roleId: role.id, permissionId: permByKey.get(k) })) });
  return role;
}

export async function makeUser(systemPrisma: Prisma, companyId: string, roleId: string, name: string, opts: { managerId?: string; hash?: string } = {}) {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${TAG}-${Math.random().toString(36).slice(2, 6)}@test.com`;
  const hash = opts.hash ?? (await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }));
  const user = await systemPrisma.user.create({ data: { companyId, email, passwordHash: hash, name, roleId, forcePasswordChange: false, managerId: opts.managerId ?? null } });
  return { id: user.id as string, email, name };
}

function extractCookie(setCookie: string[] | string | undefined, name: string): string {
  for (const h of Array.isArray(setCookie) ? setCookie : [setCookie ?? '']) {
    const m = new RegExp(`${name}=([^;]+)`).exec(h);
    if (m) return m[1];
  }
  throw new Error(`Cookie ${name} not found`);
}

export interface Session {
  get: (path: string) => request.Test;
  patch: (path: string, body?: object) => request.Test;
  post: (path: string, body?: object) => request.Test;
}

export async function loginStaff(app: INestApplication, email: string): Promise<Session> {
  const agent = request.agent(app.getHttpServer());
  const res = await agent.post('/api/v1/auth/login').send({ email, password: STAFF_PASSWORD }).expect(200);
  const csrf = extractCookie(res.headers['set-cookie'], 'openestate_csrf');
  const token = res.body.accessToken as string;
  const auth = (t: request.Test) => t.set('Authorization', `Bearer ${token}`);
  return {
    get: (p) => auth(agent.get(`/api/v1${p}`)),
    patch: (p, b) => auth(agent.patch(`/api/v1${p}`)).set('X-CSRF-Token', csrf).send(b ?? {}),
    post: (p, b) => auth(agent.post(`/api/v1${p}`)).set('X-CSRF-Token', csrf).send(b ?? {}),
  };
}

export interface LeadSpec {
  companyId: string;
  assignedToId: string | null;
  name: string;
  phone: string;
  email?: string | null;
  projectId?: string | null;
  status?: 'OPEN' | 'CONTINUED' | 'SUCCESSFUL' | 'DUMPED';
  nextFollowupAt?: Date | null;
  createdAt?: Date;
}

export async function makeLead(systemPrisma: Prisma, spec: LeadSpec) {
  const applicant = await systemPrisma.applicant.create({
    data: {
      companyId: spec.companyId,
      name: spec.name,
      primaryPhone: spec.phone,
      primaryPhoneNormalized: normalizePhone(spec.phone),
      email: spec.email ?? null,
      emailNormalized: spec.email ? normalizeEmail(spec.email) : null,
    },
  });
  const inquiry = await systemPrisma.inquiry.create({
    data: {
      companyId: spec.companyId,
      applicantId: applicant.id,
      projectId: spec.projectId ?? null,
      assignedToId: spec.assignedToId,
      status: spec.status ?? 'OPEN',
      nextFollowupAt: spec.nextFollowupAt ?? null,
      ...(spec.createdAt ? { createdAt: spec.createdAt, updatedAt: spec.createdAt } : {}),
    },
  });
  return { inquiryId: inquiry.id as string, applicantId: applicant.id as string };
}

export async function cleanupLeads(systemPrisma: Prisma, companyId: string) {
  await systemPrisma.followUp.deleteMany({ where: { companyId } });
  await systemPrisma.inquiryStageHistory?.deleteMany({ where: { companyId } });
  await systemPrisma.inquiry.deleteMany({ where: { companyId } });
  await systemPrisma.applicant.deleteMany({ where: { companyId } });
}
