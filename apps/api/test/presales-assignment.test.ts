/**
 * Round-robin auto-assignment concurrency tests.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTenantPrismaClient, createSystemPrismaClient, runWithTenant, withTenantTx } from '@openestate/db';
import { AssignmentService } from '../src/presales/assignment.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const shouldRun = !!(APP_URL && SYSTEM_URL);
const describeIf = shouldRun ? describe : describe.skip;

describeIf('Round-robin auto-assignment (SKIP LOCKED fairness)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let assignmentService: AssignmentService;
  let companyId: string;

  beforeAll(async () => {
    tenantPrisma = createTenantPrismaClient(APP_URL!);
    systemPrisma = createSystemPrismaClient(SYSTEM_URL!);
    assignmentService = new AssignmentService(tenantPrisma);

    const company = await systemPrisma.company.create({
      data: { name: 'Assignment Test Co', slug: `assign-test-${Date.now()}` },
    });
    companyId = company.id;
  });

  /** Each test gets its own project so pool membership never leaks across tests. */
  async function createProject(): Promise<string> {
    const project = await systemPrisma.project.create({
      data: { companyId, name: 'Test Project', code: `TP-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    });
    return project.id;
  }

  afterAll(async () => {
    await systemPrisma.projectAssignmentPool.deleteMany({ where: { companyId } });
    await systemPrisma.project.deleteMany({ where: { companyId } });
    await systemPrisma.user.deleteMany({ where: { companyId } });
    await systemPrisma.role.deleteMany({ where: { companyId } });
    // This fixture never seeds lead stages itself — but under a
    // full-suite run, syncLeadStages' deliberately unscoped
    // company.findMany() (packages/db/prisma/sync-permissions.ts) can
    // race in and seed both a CompanyConfig row and 6 LeadStage rows for
    // this company too, if a sync test happens to run concurrently.
    // Delete both unconditionally so the company delete below never
    // depends on that race.
    await systemPrisma.leadStage.deleteMany({ where: { companyId } });
    await systemPrisma.companyConfig.deleteMany({ where: { companyId } });
    await systemPrisma.company.delete({ where: { id: companyId } });
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  async function createPoolUsers(projectId: string, count: number, prefix: string): Promise<string[]> {
    const role = await systemPrisma.role.create({
      data: { companyId, name: `Role ${prefix}`, slug: `role-${prefix}-${Date.now()}`, isSystem: true },
    });
    const users: string[] = [];
    for (let i = 0; i < count; i++) {
      const user = await systemPrisma.user.create({
        data: {
          companyId,
          email: `${prefix}-${i}-${Date.now()}@test`,
          passwordHash: 'x',
          name: `${prefix} ${i}`,
          roleId: role.id,
        },
      });
      users.push(user.id);
      await systemPrisma.projectAssignmentPool.create({
        data: { companyId, projectId, userId: user.id, isActive: true, sortOrder: i },
      });
    }
    return users;
  }

  async function claimOne(projectId: string): Promise<string | null> {
    return runWithTenant({ companyId }, () =>
      withTenantTx(tenantPrisma, companyId, (tx) => assignmentService.autoAssign(tx, companyId, projectId)),
    );
  }

  it('returns null immediately for an empty pool', async () => {
    const emptyProjectId = await createProject();
    const result = await runWithTenant({ companyId }, () =>
      withTenantTx(tenantPrisma, companyId, (tx) =>
        assignmentService.autoAssign(tx, companyId, emptyProjectId),
      ),
    );
    expect(result).toBeNull();
  });

  it('a wave of N concurrent claims against a pool of N all land on distinct users (no duplicate within a rotation)', async () => {
    const projectId = await createProject();
    const users = await createPoolUsers(projectId, 5, 'wave');

    const rotation1 = await Promise.all(Array.from({ length: 5 }, () => claimOne(projectId)));
    expect(rotation1.every((u) => u !== null)).toBe(true);
    expect(new Set(rotation1).size).toBe(5);
    expect([...rotation1].sort()).toEqual([...users].sort());

    const rotation2 = await Promise.all(Array.from({ length: 5 }, () => claimOne(projectId)));
    expect(rotation2.every((u) => u !== null)).toBe(true);
    expect(new Set(rotation2).size).toBe(5);

    // Across 2 full rotations, every user was picked exactly twice.
    const all = [...rotation1, ...rotation2];
    const counts = new Map<string, number>();
    for (const u of all) counts.set(u as string, (counts.get(u as string) ?? 0) + 1);
    for (const userId of users) {
      expect(counts.get(userId)).toBe(2);
    }
  });

  it('50 concurrent claims against a pool of 5 distribute exactly evenly (±1) across 10 rotations', async () => {
    const projectId = await createProject();
    const users = await createPoolUsers(projectId, 5, 'sat');

    const results = await Promise.all(Array.from({ length: 50 }, () => claimOne(projectId)));
    expect(results.every((u) => u !== null)).toBe(true);

    const counts = new Map<string, number>();
    for (const u of results) counts.set(u as string, (counts.get(u as string) ?? 0) + 1);

    expect(counts.size).toBe(5);
    const values = users.map((u) => counts.get(u) ?? 0);
    const max = Math.max(...values);
    const min = Math.min(...values);
    expect(max - min).toBeLessThanOrEqual(1);
    // 50 claims / 5 users divides evenly -> exactly 10 each.
    for (const v of values) expect(v).toBe(10);
  });

  it('100 concurrent claims against a pool of 10 distribute evenly (±1)', async () => {
    const projectId = await createProject();
    const users = await createPoolUsers(projectId, 10, 'bulk');

    const results = await Promise.all(Array.from({ length: 100 }, () => claimOne(projectId)));
    expect(results.every((u) => u !== null)).toBe(true);

    const counts = new Map<string, number>();
    for (const u of results) counts.set(u as string, (counts.get(u as string) ?? 0) + 1);

    const values = users.map((u) => counts.get(u) ?? 0);
    const max = Math.max(...values);
    const min = Math.min(...values);
    expect(max - min).toBeLessThanOrEqual(1);
    expect(values.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('excludes paused (isActive=false) members from the pool', async () => {
    const projectId = await createProject();
    const users = await createPoolUsers(projectId, 3, 'pause');
    // pause the second user
    await systemPrisma.projectAssignmentPool.updateMany({
      where: { companyId, projectId, userId: users[1] },
      data: { isActive: false, pausedReason: 'leave' },
    });

    const results = await Promise.all(Array.from({ length: 6 }, () => claimOne(projectId)));
    expect(results).not.toContain(users[1]);
    expect(new Set(results.filter((r) => r !== null))).toEqual(new Set([users[0], users[2]]));
  });
});
