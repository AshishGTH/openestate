/**
 * Tenant isolation integration tests (a–d).
 *
 * Require a live Postgres with the Phase 1 migration applied and both
 * application roles configured. Set env vars:
 *
 *   DATABASE_URL_TEST        — openestate_app connection (RLS enforced)
 *   DATABASE_URL_TEST_SYSTEM — openestate_system connection (BYPASSRLS)
 *
 * Skipped automatically when the env vars are absent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  createTenantPrismaClient,
  createSystemPrismaClient,
  withTenantTx,
  runWithTenant,
} from '../src/index';
import { deleteCompaniesSafely } from './helpers/delete-company-safely';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;

const shouldRun = !!(APP_URL && SYSTEM_URL);
const describeIf = shouldRun ? describe : describe.skip;

describeIf('Tenant isolation (RLS)', () => {
  let systemPrisma: PrismaClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  let rawAppPrisma: PrismaClient;

  let companyAId: string;
  let companyBId: string;
  let roleAId: string;
  let roleBId: string;

  beforeAll(async () => {
    systemPrisma = createSystemPrismaClient(SYSTEM_URL!);
    tenantPrisma = createTenantPrismaClient(APP_URL!);
    rawAppPrisma = new PrismaClient({
      datasources: { db: { url: APP_URL! } },
    });

    const companyA = await systemPrisma.company.create({
      data: { name: 'Company A', slug: `test-a-${Date.now()}` },
    });
    const companyB = await systemPrisma.company.create({
      data: { name: 'Company B', slug: `test-b-${Date.now()}` },
    });
    companyAId = companyA.id;
    companyBId = companyB.id;

    const roleA = await systemPrisma.role.create({
      data: { companyId: companyAId, name: 'Admin A', slug: 'admin', isSystem: true },
    });
    const roleB = await systemPrisma.role.create({
      data: { companyId: companyBId, name: 'Admin B', slug: 'admin', isSystem: true },
    });
    roleAId = roleA.id;
    roleBId = roleB.id;

    await systemPrisma.user.create({
      data: {
        companyId: companyAId,
        email: 'alice@a.test',
        passwordHash: 'not-a-real-hash',
        name: 'Alice',
        roleId: roleAId,
      },
    });
    await systemPrisma.user.create({
      data: {
        companyId: companyBId,
        email: 'bob@b.test',
        passwordHash: 'not-a-real-hash',
        name: 'Bob',
        roleId: roleBId,
      },
    });
  });

  afterAll(async () => {
    await systemPrisma.user.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.role.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.$executeRaw`
      DELETE FROM audit_logs WHERE company_id IN (${companyAId}::uuid, ${companyBId}::uuid)
        OR (company_id IS NULL AND entity_type IN ('Company','Test'))
    `;
    // Retries on syncLeadStages' own race — see delete-company-safely.ts's
    // doc comment for the exact mechanism (a single delete-then-delete
    // sequence is not enough).
    await deleteCompaniesSafely(systemPrisma, [companyAId, companyBId]);
    await systemPrisma.$disconnect();
    await (tenantPrisma as PrismaClient).$disconnect();
    await rawAppPrisma.$disconnect();
  });

  // ── (a) Fail-closed: no session variable → zero rows ──────────

  it('(a) raw app-role connection returns zero rows without SET LOCAL', async () => {
    const rows = await rawAppPrisma.$queryRaw<{ id: string }[]>`SELECT id FROM users`;
    expect(rows).toHaveLength(0);
  });

  it('(a) raw app-role connection returns zero companies without SET LOCAL', async () => {
    const rows = await rawAppPrisma.$queryRaw<{ id: string }[]>`SELECT id FROM roles`;
    expect(rows).toHaveLength(0);
  });

  // ── (b) Setting-applied: withTenantTx returns tenant's rows ──

  it('(b) withTenantTx(A) returns only company A users', async () => {
    const users = await runWithTenant({ companyId: companyAId }, () =>
      withTenantTx(tenantPrisma, companyAId, (tx) => tx.user.findMany()),
    );
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe('alice@a.test');
  });

  it('(b) withTenantTx(B) returns only company B users', async () => {
    const users = await runWithTenant({ companyId: companyBId }, () =>
      withTenantTx(tenantPrisma, companyBId, (tx) => tx.user.findMany()),
    );
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe('bob@b.test');
  });

  it('(b) company A context cannot read company B rows via raw query', async () => {
    const count = await runWithTenant({ companyId: companyAId }, () =>
      withTenantTx(tenantPrisma, companyAId, async (tx) => {
        const rows = await (tx as PrismaClient).$queryRaw<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM users WHERE company_id = ${companyBId}::uuid
        `;
        return Number(rows[0].n);
      }),
    );
    expect(count).toBe(0);
  });

  // ── (c) Nested transaction behaviour ─────────────────────────

  it('(c) nested withTenantTx with same company reuses outer tx', async () => {
    let outerRef: unknown;
    let innerRef: unknown;

    await runWithTenant({ companyId: companyAId }, () =>
      withTenantTx(tenantPrisma, companyAId, async (outerTx) => {
        outerRef = outerTx;
        await withTenantTx(tenantPrisma, companyAId, async (innerTx) => {
          innerRef = innerTx;
        });
      }),
    );
    expect(innerRef).toBe(outerRef);
  });

  it('(c) nested withTenantTx with different company throws', async () => {
    await expect(
      runWithTenant({ companyId: companyAId }, () =>
        withTenantTx(tenantPrisma, companyAId, async () => {
          await withTenantTx(tenantPrisma, companyBId, async () => {
            /* should not reach here */
          });
        }),
      ),
    ).rejects.toThrow('Cannot nest withTenantTx with different company');
  });

  // ── (d) System client vs tenant client ───────────────────────

  it('(d) system client can create a company', async () => {
    const c = await systemPrisma.company.create({
      data: { name: 'Temp Co', slug: `temp-${Date.now()}` },
    });
    expect(c.id).toBeDefined();
    await systemPrisma.company.delete({ where: { id: c.id } });
  });

  it('(d) system client can write a null-company audit row', async () => {
    await systemPrisma.$executeRaw`
      INSERT INTO audit_logs (id, company_id, user_id, entity_type, entity_id, action, created_at)
      VALUES (gen_random_uuid(), NULL, NULL, 'Test', 'system-audit-test', 'CREATE', NOW())
    `;
    const rows = await systemPrisma.$queryRaw<{ company_id: string | null }[]>`
      SELECT company_id FROM audit_logs WHERE entity_id = 'system-audit-test'
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].company_id).toBeNull();
    await systemPrisma.$executeRaw`DELETE FROM audit_logs WHERE entity_id = 'system-audit-test'`;
  });

  it('(d) tenant client cannot insert a null-company audit row (RLS WITH CHECK)', async () => {
    await expect(
      runWithTenant({ companyId: companyAId }, () =>
        withTenantTx(tenantPrisma, companyAId, async (tx) => {
          await (tx as PrismaClient).$executeRaw`
            INSERT INTO audit_logs (id, company_id, user_id, entity_type, entity_id, action, created_at)
            VALUES (gen_random_uuid(), NULL, NULL, 'Test', 'tenant-null-test', 'CREATE', NOW())
          `;
        }),
      ),
    ).rejects.toThrow();
  });

  it('(d) tenant extension throws when accessing AuditLog without tenant context', async () => {
    await expect(tenantPrisma.auditLog.findMany()).rejects.toThrow(
      'Tenant context required for AuditLog',
    );
  });
});
