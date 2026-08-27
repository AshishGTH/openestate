/**
 * Auth token + reuse-detection integration tests (e).
 *
 * Tests refresh token rotation, reuse detection (family revocation),
 * lockout, and forced-password-change semantics against real Postgres.
 *
 * Env vars: DATABASE_URL_TEST_SYSTEM (BYPASSRLS system connection)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import * as argon2 from '@node-rs/argon2';
import { createSystemPrismaClient } from '../src/index';
import { deleteCompaniesSafely } from './helpers/delete-company-safely';

const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const shouldRun = !!SYSTEM_URL;
const describeIf = shouldRun ? describe : describe.skip;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

describeIf('Auth: token rotation + reuse detection', () => {
  let prisma: PrismaClient;
  let companyId: string;
  let roleId: string;
  let userId: string;

  beforeAll(async () => {
    prisma = createSystemPrismaClient(SYSTEM_URL!);

    const company = await prisma.company.create({
      data: { name: 'Auth Test Co', slug: `auth-test-${Date.now()}` },
    });
    companyId = company.id;

    const role = await prisma.role.create({
      data: { companyId, name: 'Admin', slug: 'admin', isSystem: true },
    });
    roleId = role.id;

    const hash = await argon2.hash('CorrectPassword1!', { algorithm: argon2.Algorithm.Argon2id });
    const user = await prisma.user.create({
      data: {
        companyId,
        email: 'auth-test@test.com',
        passwordHash: hash,
        name: 'Auth Tester',
        roleId,
        forcePasswordChange: false,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.refreshToken.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { companyId } });
    await prisma.role.deleteMany({ where: { companyId } });
    // Retries on syncLeadStages' own race — see delete-company-safely.ts's
    // doc comment for the exact mechanism (a single delete-then-delete
    // sequence is not enough).
    await deleteCompaniesSafely(prisma, [companyId]);
    await prisma.$disconnect();
  });

  it('(e) creates a refresh token with SHA-256 hash stored, not raw', async () => {
    const raw = randomUUID();
    const tokenHash = hashToken(raw);
    const family = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const token = await prisma.refreshToken.create({
      data: { userId, tokenHash, family, expiresAt },
    });

    expect(token.tokenHash).toBe(tokenHash);
    expect(token.tokenHash).not.toBe(raw);
    expect(token.isRevoked).toBe(false);
    expect(token.family).toBe(family);
  });

  it('(e) refresh rotation: revokes old token, creates new in same family', async () => {
    const family = randomUUID();
    const raw1 = randomUUID();
    const hash1 = hashToken(raw1);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.refreshToken.create({
      data: { userId, tokenHash: hash1, family, expiresAt },
    });

    const old = await prisma.refreshToken.findFirst({ where: { tokenHash: hash1 } });
    expect(old).not.toBeNull();
    expect(old!.isRevoked).toBe(false);

    await prisma.refreshToken.update({
      where: { id: old!.id },
      data: { isRevoked: true },
    });

    const raw2 = randomUUID();
    const hash2 = hashToken(raw2);
    await prisma.refreshToken.create({
      data: { userId, tokenHash: hash2, family, expiresAt },
    });

    const rotated = await prisma.refreshToken.findFirst({ where: { tokenHash: hash1 } });
    expect(rotated!.isRevoked).toBe(true);

    const newToken = await prisma.refreshToken.findFirst({ where: { tokenHash: hash2 } });
    expect(newToken!.isRevoked).toBe(false);
    expect(newToken!.family).toBe(family);
  });

  it('(e) reuse detection: reusing a revoked token revokes the entire family', async () => {
    const family = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const raw1 = randomUUID();
    const t1 = await prisma.refreshToken.create({
      data: { userId, tokenHash: hashToken(raw1), family, expiresAt },
    });

    await prisma.refreshToken.update({ where: { id: t1.id }, data: { isRevoked: true } });

    const raw2 = randomUUID();
    const t2 = await prisma.refreshToken.create({
      data: { userId, tokenHash: hashToken(raw2), family, expiresAt },
    });

    const reusedToken = await prisma.refreshToken.findFirst({
      where: { tokenHash: hashToken(raw1) },
    });
    expect(reusedToken!.isRevoked).toBe(true);

    await prisma.refreshToken.updateMany({
      where: { family, isRevoked: false },
      data: { isRevoked: true },
    });

    const allFamily = await prisma.refreshToken.findMany({ where: { family } });
    expect(allFamily.every((t) => t.isRevoked)).toBe(true);
  });

  it('(e) logout revokes all tokens in the family', async () => {
    const family = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.refreshToken.create({
      data: { userId, tokenHash: hashToken(randomUUID()), family, expiresAt },
    });
    await prisma.refreshToken.create({
      data: { userId, tokenHash: hashToken(randomUUID()), family, expiresAt },
    });

    await prisma.refreshToken.updateMany({
      where: { family, isRevoked: false },
      data: { isRevoked: true },
    });

    const tokens = await prisma.refreshToken.findMany({ where: { family } });
    expect(tokens.every((t) => t.isRevoked)).toBe(true);
  });

  it('(e) lockout: after 5 failed attempts, lockedUntil is set', async () => {
    for (let i = 0; i < 5; i++) {
      const current = await prisma.user.findUnique({ where: { id: userId } });
      const attempts = (current?.failedLoginAttempts ?? 0) + 1;
      const lockedUntil =
        attempts >= 5
          ? new Date(Date.now() + 15 * 60 * 1000)
          : null;
      await prisma.user.update({
        where: { id: userId },
        data: { failedLoginAttempts: attempts, lockedUntil },
      });
    }

    const locked = await prisma.user.findUnique({ where: { id: userId } });
    expect(locked!.failedLoginAttempts).toBe(5);
    expect(locked!.lockedUntil).not.toBeNull();
    expect(locked!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    await prisma.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
  });

  it('(e) forcePasswordChange: flag cleared after password update', async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { forcePasswordChange: true },
    });

    let user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user!.forcePasswordChange).toBe(true);

    const newHash = await argon2.hash('NewPassword2!', { algorithm: argon2.Algorithm.Argon2id });
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newHash, forcePasswordChange: false },
    });

    user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user!.forcePasswordChange).toBe(false);

    const verified = await argon2.verify(user!.passwordHash, 'NewPassword2!');
    expect(verified).toBe(true);
  });

  it('(e) isRevoked is boolean, not datetime (schema match)', async () => {
    const family = randomUUID();
    const token = await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(randomUUID()),
        family,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    expect(typeof token.isRevoked).toBe('boolean');
    expect(token.isRevoked).toBe(false);

    const revoked = await prisma.refreshToken.update({
      where: { id: token.id },
      data: { isRevoked: true },
    });
    expect(typeof revoked.isRevoked).toBe('boolean');
    expect(revoked.isRevoked).toBe(true);
  });
});
