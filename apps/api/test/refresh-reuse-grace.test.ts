/**
 * Regression coverage for the rapid-reload logout.
 *
 * Diagnosed from captured browser traffic, not guessed: a full page load
 * fires /auth/refresh; navigating again before the response lands ABORTS
 * it client-side, but the server has already consumed the token and issued
 * a replacement the client never receives. The cookie still holds the OLD
 * token, so the next load re-presents it — which pre-fix was treated as
 * token theft and revoked the whole family. Five quick reloads (or a
 * browser restoring several tabs, each firing its own refresh with the
 * same cookie) logged the user out with no explanation.
 *
 * These are direct TokenService tests rather than HTTP ones deliberately:
 * the behaviour under test is the ROTATION rule, and driving it directly
 * lets a test present the same raw token N times — which is exactly what
 * an aborted-response client does and what supertest cannot easily fake,
 * since it always receives (and would therefore apply) every response.
 * The through-the-wire half is covered by the Playwright spec.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createSystemPrismaClient } from '@openestate/db';
import { TokenService } from '../src/auth/token.service';

const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = SYSTEM_URL ? describe : describe.skip;

describeIf('refresh-token rotation: reuse grace window', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let companyId: string;
  let userId: string;

  const makeService = (graceSeconds: number) =>
    new TokenService(
      new JwtService({ secret: 'test-secret-0123456789' }),
      {
        getOrThrow: () => 'test-refresh-secret-0123456789',
        get: (key: string) =>
          key === 'REFRESH_REUSE_GRACE_SECONDS' ? String(graceSeconds) : undefined,
      } as unknown as ConfigService,
      prisma,
    );

  beforeAll(async () => {
    prisma = createSystemPrismaClient(SYSTEM_URL!);
    const tag = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const company = await prisma.company.create({
      data: { name: `Reuse Grace ${tag}`, slug: `reuse-grace-${tag}` },
    });
    companyId = company.id;
    const role = await prisma.role.create({
      data: { companyId, name: 'Admin', slug: `admin-${tag}`, isSystem: false },
    });
    const user = await prisma.user.create({
      data: {
        companyId,
        email: `reuse-grace-${tag}@test.com`,
        passwordHash: 'x',
        name: 'Reuse Grace User',
        roleId: role.id,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.refreshToken.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { companyId } });
    await prisma.role.deleteMany({ where: { companyId } });
    // This fixture never seeds lead stages itself — but under a
    // full-suite run, syncLeadStages' deliberately unscoped
    // company.findMany() (packages/db/prisma/sync-permissions.ts) can
    // race in and seed both a CompanyConfig row and 6 LeadStage rows for
    // this company too, if a sync test happens to run concurrently.
    // Delete both unconditionally so the company delete below never
    // depends on that race.
    await prisma.leadStage.deleteMany({ where: { companyId } });
    await prisma.companyConfig.deleteMany({ where: { companyId } });
    await prisma.company.delete({ where: { id: companyId } });
    await prisma.$disconnect();
  });

  it('survives N sequential re-presentations of the SAME token — the aborted-page-load case', async () => {
    const svc = makeService(30);
    const { raw } = await svc.createRefreshToken(userId);

    // Every iteration presents the ORIGINAL token, exactly as a browser
    // does when each refresh response is aborted before its Set-Cookie
    // can be applied. Pre-fix, iteration 2 revoked the family and every
    // one after it returned null.
    for (let i = 1; i <= 6; i++) {
      const result = await svc.rotateRefreshToken(raw);
      expect(result, `re-presentation #${i} should still yield a session`).not.toBeNull();
      expect(result!.userId).toBe(userId);
    }

    // The family is intact, not revoked-in-bulk.
    const live = await prisma.refreshToken.count({
      where: { userId, isRevoked: false },
    });
    expect(live).toBe(1);
  });

  it('the newest issued token still works after such a burst — the client converges', async () => {
    const svc = makeService(30);
    const { raw } = await svc.createRefreshToken(userId);

    let latest = raw;
    for (let i = 0; i < 3; i++) {
      const r = await svc.rotateRefreshToken(raw); // always the stale one
      latest = r!.newRaw;
    }

    // Whichever response the client finally applied is usable.
    const after = await svc.rotateRefreshToken(latest);
    expect(after).not.toBeNull();
  });

  it('a token replayed AFTER the window still revokes the whole family — theft detection intact', async () => {
    // Zero-length grace is the strict, pre-fix behaviour, and is also what
    // any real replay looks like once the window has elapsed.
    const svc = makeService(0);
    const { raw } = await svc.createRefreshToken(userId);

    const first = await svc.rotateRefreshToken(raw);
    expect(first).not.toBeNull();

    const replay = await svc.rotateRefreshToken(raw);
    expect(replay).toBeNull();

    // ...and the successor is dead too: that is the point of family
    // revocation — a thief must not be able to keep using the chain.
    const second = await svc.rotateRefreshToken(first!.newRaw);
    expect(second).toBeNull();
  });

  it('a token whose family was already revoked is refused even inside the window', async () => {
    const svc = makeService(30);
    const { raw } = await svc.createRefreshToken(userId);
    const first = await svc.rotateRefreshToken(raw);
    expect(first).not.toBeNull();

    // e.g. an explicit logout, or a genuine reuse detected elsewhere.
    await svc.revokeFamily(first!.newRaw);

    // The stale token is recently-revoked, so it is inside the grace
    // window — but its family has no live token, so there is nothing
    // legitimate to converge on and it must be refused.
    const afterRevoke = await svc.rotateRefreshToken(raw);
    expect(afterRevoke).toBeNull();
  });

  it('an unknown token is refused and does not create a session', async () => {
    const svc = makeService(30);
    expect(await svc.rotateRefreshToken('not-a-real-token')).toBeNull();
  });
});
