/**
 * Raw `now()` writes into TIMESTAMP (no time zone) columns store the database
 * SESSION's local clock, but the app reads every such column as UTC. On a server
 * whose Postgres time zone is not UTC (the verification VM is Asia/Kolkata) the
 * stored value is off by the zone offset, 5 h 30 min there. Every raw write below
 * now uses `now() AT TIME ZONE 'UTC'` (the pattern the TOTP lockout already uses).
 * The generic audit extension has its own test in packages/db.
 *
 * Each test runs the real service against a database session set to Asia/Kolkata
 * and requires the stored value to land within a minute of real UTC. Mutation
 * check: with a bare now() each one is ~5.5 hours out and fails.
 *
 * Not covered here on purpose: number_sequences.updated_at, a Phase 4 financial
 * file that is left unchanged (it is never displayed or compared).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import { createTenantPrismaClient, createSystemPrismaClient, runWithTenant, withTenantTx } from '@openestate/db';
import { TokenService } from '../src/auth/token.service';
import { TotpService } from '../src/auth/totp.service';
import { AuthService } from '../src/auth/auth.service';
import { PortalAuthService } from '../src/portal-auth/portal-auth.service';
import { AssignmentService } from '../src/presales/assignment.service';
import { PluginSecretEncryptionService } from '../src/plugins/plugin-secret-encryption.service';
import { WebhookDeliveryProcessor, WEBHOOK_DISABLE_THRESHOLD } from '../src/webhooks/webhook-delivery.processor';
import { makeClients, seedCompany, makeApplicant, makePortalRole, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'a3b4c5d6'.repeat(8)}`;

const withZone = (url: string, zone: string) =>
  `${url}${url.includes('?') ? '&' : '?'}options=-c%20TimeZone%3D${encodeURIComponent(zone)}`;

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

/** True when `d` (read back the way the API reads it) is within a minute of real UTC now. */
const nearNow = (d: Date | null | undefined) => !!d && Math.abs(d.getTime() - Date.now()) < 60_000;

describeIf('raw now() writes store UTC under a non-UTC database session', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let normalSystem: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let normalTenant: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let istSystem: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let istTenant: any;
  let fx: CompanyFixture;
  let tokenService: TokenService;
  let totpService: TotpService;
  let portalAuth: PortalAuthService;
  let staffAuth: AuthService;
  let server: http.Server;
  let serverUrl: string;

  beforeAll(async () => {
    ({ systemPrisma: normalSystem, tenantPrisma: normalTenant } = makeClients());
    istSystem = createSystemPrismaClient(withZone(SYSTEM_URL!, 'Asia/Kolkata'));
    istTenant = createTenantPrismaClient(withZone(APP_URL!, 'Asia/Kolkata'));
    fx = await seedCompany(normalSystem);
    await makePortalRole(normalSystem, fx.companyId, 'customer');

    const jwt = new JwtService({ secret: 'test-access-secret-0123456789', signOptions: { expiresIn: '15m' } });
    const config = fakeConfigService();
    tokenService = new TokenService(jwt, config, istSystem);
    totpService = new TotpService(config);
    // The queue is only used by requestPasswordReset, which these tests do not call.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    portalAuth = new PortalAuthService(istSystem, tokenService, totpService, {} as any);
    staffAuth = new AuthService(istSystem, tokenService, totpService);

    server = http.createServer((_req, res) => {
      res.writeHead(500).end('server error');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    serverUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await normalSystem.projectAssignmentPool.deleteMany({ where: { companyId: fx.companyId } });
    await cleanupCompany(normalSystem, fx.companyId);
    await Promise.all([normalSystem.$disconnect(), normalTenant.$disconnect(), istSystem.$disconnect(), istTenant.$disconnect()]);
  });

  it('control: the session really is Asia/Kolkata (a bare now() would be wrong by 5 h 30 min)', async () => {
    const rows = await istSystem.$queryRaw`SELECT current_setting('TimeZone') AS tz, (now() AT TIME ZONE 'UTC') <> now()::timestamp AS differs`;
    expect(rows[0].tz).toBe('Asia/Kolkata');
    expect(rows[0].differs).toBe(true);
  });

  it('staff password reset: consumed_at is UTC', async () => {
    const raw = `reset-token-${Date.now()}`;
    const reset = await normalSystem.passwordReset.create({
      data: {
        companyId: fx.companyId,
        userId: fx.userId,
        tokenHash: createHash('sha256').update(raw).digest('hex'),
        expiresAt: new Date(Date.now() + 30 * 60_000),
        createdById: fx.userId,
      },
    });
    await staffAuth.confirmPasswordReset({ token: raw, newPassword: 'CorrectHorse123' });
    const row = await normalSystem.passwordReset.findUniqueOrThrow({ where: { id: reset.id } });
    expect(nearNow(row.consumedAt), `consumed_at=${row.consumedAt?.toISOString()}`).toBe(true);
  });

  it('portal invite consumed: consumed_at is UTC', async () => {
    const applicantId = await makeApplicant(normalSystem, fx.companyId);
    const { inviteId, token } = await portalAuth.sendInvite(fx.companyId, fx.userId, { applicantId, channel: 'SMS' });
    await portalAuth.consumeInvite(inviteId, { token, password: 'CorrectHorse123' });
    const row = await normalSystem.portalInvite.findUniqueOrThrow({ where: { id: inviteId } });
    expect(nearNow(row.consumedAt), `consumed_at=${row.consumedAt?.toISOString()}`).toBe(true);
  });

  it('portal invite burned by too many wrong attempts: consumed_at is UTC', async () => {
    const applicantId = await makeApplicant(normalSystem, fx.companyId);
    const { inviteId } = await portalAuth.sendInvite(fx.companyId, fx.userId, { applicantId, channel: 'SMS' });
    for (let i = 0; i < 5; i++) {
      await portalAuth.consumeInvite(inviteId, { token: 'definitely-wrong-token', password: 'CorrectHorse123' }).catch(() => undefined);
    }
    const row = await normalSystem.portalInvite.findUniqueOrThrow({ where: { id: inviteId } });
    expect(row.invalidatedReason).toBe('TOO_MANY_ATTEMPTS');
    expect(nearNow(row.consumedAt), `consumed_at=${row.consumedAt?.toISOString()}`).toBe(true);
  });

  it('portal password reset: consumed_at is UTC', async () => {
    const applicantId = await makeApplicant(normalSystem, fx.companyId);
    const { inviteId, token } = await portalAuth.sendInvite(fx.companyId, fx.userId, { applicantId, channel: 'SMS' });
    await portalAuth.consumeInvite(inviteId, { token, password: 'OldPassword123' });
    const { token: resetToken } = await portalAuth.issueAdminPasswordReset(fx.companyId, fx.userId, { applicantId });
    await portalAuth.confirmPasswordReset({ token: resetToken, newPassword: 'NewPassword456' });
    const row = await normalSystem.portalPasswordReset.findFirstOrThrow({
      where: { companyId: fx.companyId, tokenHash: createHash('sha256').update(resetToken).digest('hex') },
    });
    expect(nearNow(row.consumedAt), `consumed_at=${row.consumedAt?.toISOString()}`).toBe(true);
  });

  it('round-robin assignment: last_assigned_at is UTC', async () => {
    const project = await normalSystem.project.create({
      data: { companyId: fx.companyId, name: 'UTC Project', code: `UTC-${Date.now()}` },
    });
    await normalSystem.projectAssignmentPool.create({
      data: { companyId: fx.companyId, projectId: project.id, userId: fx.userId },
    });
    const assignment = new AssignmentService(istTenant);
    const picked = await runWithTenant({ companyId: fx.companyId }, () =>
      withTenantTx(istTenant, fx.companyId, (tx) => assignment.autoAssign(tx, fx.companyId, project.id)),
    );
    expect(picked).toBe(fx.userId);
    const row = await normalSystem.projectAssignmentPool.findFirstOrThrow({ where: { projectId: project.id } });
    expect(nearNow(row.lastAssignedAt), `last_assigned_at=${row.lastAssignedAt?.toISOString()}`).toBe(true);
  });

  it('webhook endpoint auto-disabled: disabled_at is UTC', async () => {
    const secretEncryption = new PluginSecretEncryptionService();
    const processor = new WebhookDeliveryProcessor(istSystem, secretEncryption);
    const { ciphertext, keyVersion } = secretEncryption.encrypt('endpoint-signing-secret');
    const endpoint = await normalSystem.webhookEndpoint.create({
      data: {
        companyId: fx.companyId,
        name: 'UTC Endpoint',
        url: serverUrl,
        secretCiphertext: ciphertext,
        secretKeyVersion: keyVersion,
        eventTypes: ['booking.created'],
        consecutiveFailures: WEBHOOK_DISABLE_THRESHOLD - 1,
        isActive: true,
      },
    });
    const delivery = await normalSystem.webhookDelivery.create({
      data: { companyId: fx.companyId, webhookEndpointId: endpoint.id, eventType: 'booking.created', payload: { hello: 'world' }, status: 'PENDING' },
    });
    // The last attempt of a delivery that exhausts its retries against a failing endpoint.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const job: any = { name: 'deliver', data: { companyId: fx.companyId, webhookDeliveryId: delivery.id }, attemptsMade: 5, opts: { attempts: 6 } };
    await processor.process(job);
    const row = await normalSystem.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(row.isActive).toBe(false);
    expect(nearNow(row.disabledAt), `disabled_at=${row.disabledAt?.toISOString()}`).toBe(true);
  });
});
