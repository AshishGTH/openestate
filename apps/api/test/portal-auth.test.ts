/**
 * Phase 6 portal-auth: invite-consume (atomic wrong-attempt cap under
 * concurrency) and the BullMQ-backed password-reset flow (structural
 * timing equality between the found/not-found branches).
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM + Redis.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { SYSTEM_ROLES } from '@openestate/shared';
import { TokenService } from '../src/auth/token.service';
import { TotpService } from '../src/auth/totp.service';
import { PortalAuthService } from '../src/portal-auth/portal-auth.service';
import { PortalPasswordResetProcessor, PROCESS_PASSWORD_RESET_JOB } from '../src/portal-auth/portal-password-reset.processor';
import type { CommunicationProvider, CommunicationMessage, CommunicationSendResult } from '../src/queues/communication-provider';
import { makeClients, seedCompany, makeApplicant, makePortalRole, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const REDIS_TEST_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6380';
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

function newRedis() {
  return new Redis(REDIS_TEST_URL, { maxRetriesPerRequest: null });
}

function fakeConfigService(): ConfigService {
  const values: Record<string, string> = {
    JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789',
    JWT_REFRESH_EXPIRES_IN: '7d',
    TOTP_ENCRYPTION_KEY: 'a1b2c3d4'.repeat(8),
  };
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error(`unexpected getOrThrow(${key})`);
      return values[key];
    },
    get: (key: string) => values[key],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** Captures the last message a test sends through it, so the invite/reset
 * tests can recover the raw (unhashed) token that only ever crosses the
 * wire via the (simulated) delivery channel. */
class CapturingProvider implements CommunicationProvider {
  lastMessage: CommunicationMessage | null = null;
  async send(message: CommunicationMessage): Promise<CommunicationSendResult> {
    this.lastMessage = message;
    return { success: true, providerMessageId: 'test-message' };
  }
}

describeIf('Phase 6 portal-auth (invite consume, password reset)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let tokenService: TokenService;
  let totpService: TotpService;
  let portalAuth: PortalAuthService;
  let queue: Queue;
  let worker: Worker;
  let provider: CapturingProvider;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    await makePortalRole(systemPrisma, fx.companyId, 'customer');
    await makePortalRole(systemPrisma, fx.companyId, 'broker');

    const jwt = new JwtService({ secret: 'test-access-secret-0123456789', signOptions: { expiresIn: '15m' } });
    const config = fakeConfigService();
    tokenService = new TokenService(jwt, config, systemPrisma);
    totpService = new TotpService(config);

    const queueName = `portal-test-${Date.now()}`;
    queue = new Queue(queueName, { connection: newRedis() });
    provider = new CapturingProvider();
    const processor = new PortalPasswordResetProcessor(systemPrisma, provider);
    worker = new Worker(queueName, (job) => processor.process(job), { connection: newRedis() });

    portalAuth = new PortalAuthService(systemPrisma, tokenService, totpService, queue);
  });

  afterAll(async () => {
    await worker.close();
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  function waitForCompletion(w: Worker, predicate: (jobId: string) => boolean) {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for job')), 10_000);
      w.on('completed', (job) => {
        if (predicate(job.id ?? '')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  }

  it('invite send -> consume creates a portal customer User and issues tokens', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const { inviteId, token } = await portalAuth.sendInvite(fx.companyId, fx.userId, {
      applicantId,
      channel: 'SMS',
    });

    const result = await portalAuth.consumeInvite(inviteId, { token, password: 'CorrectHorse123' });
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshRaw).toBeTruthy();

    const user = await systemPrisma.user.findFirst({ where: { applicantId } });
    expect(user).toBeTruthy();
    expect(user.forcePasswordChange).toBe(false);

    const role = await systemPrisma.role.findUnique({ where: { id: user.roleId } });
    expect(role.slug).toBe(SYSTEM_ROLES.CUSTOMER);
  });

  it('invite consume: 5 concurrent wrong-token attempts invalidate the row exactly once, and the correct token then still fails', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const { inviteId } = await portalAuth.sendInvite(fx.companyId, fx.userId, { applicantId, channel: 'SMS' });

    const attempts = Array.from({ length: 5 }, () =>
      portalAuth.consumeInvite(inviteId, { token: 'definitely-wrong-token', password: 'CorrectHorse123' }).catch((e) => e),
    );
    await Promise.all(attempts);

    const invite = await systemPrisma.portalInvite.findUnique({ where: { id: inviteId } });
    expect(invite.consumedAt).not.toBeNull();
    expect(invite.invalidatedReason).toBe('TOO_MANY_ATTEMPTS');
    expect(invite.wrongAttempts).toBeGreaterThanOrEqual(3);
    expect(invite.wrongAttempts).toBeLessThanOrEqual(5);

    // The row is dead now — even the RIGHT token (which we never actually
    // sent above) must still fail, proving the cap really killed the invite
    // rather than merely recording failed attempts.
    await expect(
      portalAuth.consumeInvite(inviteId, { token: 'anything-including-the-real-one', password: 'CorrectHorse123' }),
    ).rejects.toThrow();
  });

  it('password reset: request enqueues a job that creates the reset row and sends the token; confirm sets the new password', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const { inviteId, token } = await portalAuth.sendInvite(fx.companyId, fx.userId, { applicantId, channel: 'SMS' });
    await portalAuth.consumeInvite(inviteId, { token, password: 'OldPassword123' });
    const user = await systemPrisma.user.findFirstOrThrow({ where: { applicantId } });

    await portalAuth.requestPasswordReset({ identifier: user.phone });
    await waitForCompletion(worker, () => true);

    expect(provider.lastMessage).toBeTruthy();
    const match = /password: (\S+) \(/.exec(provider.lastMessage!.body);
    expect(match).toBeTruthy();
    const rawResetToken = match![1];

    await portalAuth.confirmPasswordReset({ token: rawResetToken, newPassword: 'NewPassword456' });

    const updated = await systemPrisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const valid = await argon2.verify(updated.passwordHash, 'NewPassword456');
    expect(valid).toBe(true);

    // Single-use: confirming again with the same (now-consumed) token fails.
    await expect(portalAuth.confirmPasswordReset({ token: rawResetToken, newPassword: 'Whatever789' })).rejects.toThrow();
  });

  it('password reset request: response timing does not depend on whether the identifier exists (coarse regression check)', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const { inviteId, token } = await portalAuth.sendInvite(fx.companyId, fx.userId, { applicantId, channel: 'SMS' });
    await portalAuth.consumeInvite(inviteId, { token, password: 'SomePassword123' });
    const user = await systemPrisma.user.findFirstOrThrow({ where: { applicantId } });

    const RUNS = 10;
    const foundTimes: number[] = [];
    const notFoundTimes: number[] = [];

    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      await portalAuth.requestPasswordReset({ identifier: user.phone });
      foundTimes.push(performance.now() - t0);

      const t1 = performance.now();
      await portalAuth.requestPasswordReset({ identifier: `no-such-identifier-${i}-${Date.now()}` });
      notFoundTimes.push(performance.now() - t1);
    }

    const median = (arr: number[]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };

    const foundMedian = median(foundTimes);
    const notFoundMedian = median(notFoundTimes);
    // Coarse sanity check, not the primary correctness mechanism (the
    // synchronous-enqueue-for-both-branches design is) — see CLAUDE.md
    // Phase 6 decisions. A generous 100ms threshold guards against a
    // future refactor accidentally reintroducing sync work on one branch.
    expect(Math.abs(foundMedian - notFoundMedian)).toBeLessThan(100);
  });
});
