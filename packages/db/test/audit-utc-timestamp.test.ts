/**
 * Audit rows written by the generic audit extension carry a UTC created_at
 * even when the database session's time zone is not UTC.
 *
 * audit_logs.created_at is TIMESTAMP (no time zone) and the app reads every such
 * column as UTC. The extension's raw INSERT used a bare NOW(), which stores the
 * SESSION's local clock: on a server whose Postgres time zone is Asia/Kolkata
 * (the verification VM) every generic CREATE/UPDATE/DELETE row was stamped
 * 5 h 30 min in the future. Existing rows are not touched by the fix.
 *
 * The tenant client here runs with TimeZone=Asia/Kolkata, as that VM does.
 * Mutation check: with a bare NOW() the row lands ~5.5 hours out and the first
 * test fails.
 *
 * Requires DATABASE_URL_TEST / DATABASE_URL_TEST_SYSTEM; skipped otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTenantPrismaClient, createSystemPrismaClient, withTenantTx, runWithTenant } from '../src/index';
import { deleteCompaniesSafely } from './helpers/delete-company-safely';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const withZone = (url: string, zone: string) =>
  `${url}${url.includes('?') ? '&' : '?'}options=-c%20TimeZone%3D${encodeURIComponent(zone)}`;

describeIf('audit extension: created_at is UTC under a non-UTC database session', () => {
  let systemPrisma: PrismaClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let istTenant: any;
  let companyId: string;
  const tag = Date.now();
  let seq = 0;

  beforeAll(async () => {
    systemPrisma = createSystemPrismaClient(SYSTEM_URL!);
    istTenant = createTenantPrismaClient(withZone(APP_URL!, 'Asia/Kolkata'));
    companyId = (await systemPrisma.company.create({ data: { name: `AuditUtc ${tag}`, slug: `audit-utc-${tag}` } })).id;
  });

  afterAll(async () => {
    await systemPrisma.auditLog.deleteMany({ where: { companyId } });
    await systemPrisma.customFieldDefinition.deleteMany({ where: { companyId } });
    await deleteCompaniesSafely(systemPrisma, [companyId]);
    await systemPrisma.$disconnect();
    await istTenant.$disconnect();
  });

  const create = () =>
    runWithTenant({ companyId }, () =>
      withTenantTx(istTenant, companyId, async (tx) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tx as any).customFieldDefinition.create({
          data: { companyId, entityType: 'APPLICANT', key: `utc_${tag}_${seq++}`, label: 'L', fieldType: 'TEXT' },
        }),
      ),
    );

  it('control: the session really is Asia/Kolkata (so a bare NOW() would be wrong)', async () => {
    const rows = await runWithTenant({ companyId }, () =>
      withTenantTx(istTenant, companyId, async (tx) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tx as any).$queryRaw`SELECT current_setting('TimeZone') AS tz, (now() AT TIME ZONE 'UTC') <> now()::timestamp AS differs`,
      ),
    );
    expect(rows[0].tz).toBe('Asia/Kolkata');
    expect(rows[0].differs).toBe(true);
  });

  it('a generic CREATE audit row lands within a minute of real UTC time', async () => {
    const before = Date.now();
    const created = await create();
    const after = Date.now();
    const row = await systemPrisma.auditLog.findFirstOrThrow({ where: { entityId: created.id, action: 'CREATE' } });
    // Prisma reads the TIMESTAMP column as UTC, exactly as the API does.
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before - 60_000);
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(after + 60_000);
  });

  it('UPDATE and DELETE rows are stamped the same way, and rows sort in the order the writes happened', async () => {
    const created = await create();
    await runWithTenant({ companyId }, () =>
      withTenantTx(istTenant, companyId, async (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (tx as any).customFieldDefinition.update({ where: { id: created.id }, data: { label: 'Changed' } });
      }),
    );
    await runWithTenant({ companyId }, () =>
      withTenantTx(istTenant, companyId, async (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (tx as any).customFieldDefinition.delete({ where: { id: created.id } });
      }),
    );
    const rows = await systemPrisma.auditLog.findMany({ where: { entityId: created.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE', 'DELETE']);
    for (const r of rows) {
      expect(Math.abs(r.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    }
  });
});
