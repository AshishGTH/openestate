/**
 * v0.8.4 Part B: every foreign key in packages/db/constraint-manifest.json
 * refuses a pointer to a row that does not exist. The list comes from the
 * manifest, so a foreign key added later is covered without editing this file.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@openestate/db';
import { makeClients, seedCompany, cleanupCompany, TEST_SUPER_URL, type CompanyFixture } from './helpers/postsales-harness';
import { insertFillers, deleteFillers, probeForeignKeys, type FkLink, type Fillers } from './helpers/fk-probe';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;

const manifest = JSON.parse(
  readFileSync(path.join(__dirname, '../../../packages/db/constraint-manifest.json'), 'utf8'),
) as { constraints: Array<{ table: string; name: string; type: string; definition: string }> };

const LINKS: FkLink[] = manifest.constraints
  .filter((c) => c.type === 'foreign key')
  .map((c) => {
    const m = /^FOREIGN KEY \((\w+)\) REFERENCES/.exec(c.definition);
    if (!m) throw new Error(`Unexpected foreign key definition (not one column): ${c.name}: ${c.definition}`);
    // units_shape_hierarchy_chk: only a LAND_BASED unit (no floor) may have an inventory group.
    const alsoSet = c.name === 'units_inventory_group_id_fkey' ? `shape = 'LAND_BASED', floor_id = NULL` : undefined;
    return { name: c.name, table: c.table, column: m[1], alsoSet };
  });

describeIf('v0.8.4 Part B: every foreign key in the manifest is enforced', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let sup: PrismaClient;
  let fx: CompanyFixture;
  let fillers: Fillers | undefined;

  beforeAll(async () => {
    const clients = makeClients();
    systemPrisma = clients.systemPrisma;
    await clients.tenantPrisma.$disconnect();
    fx = await seedCompany(systemPrisma);
    sup = new PrismaClient({ datasourceUrl: TEST_SUPER_URL });
    const staffRoleId = (await systemPrisma.user.findUniqueOrThrow({ where: { id: fx.userId } })).roleId as string;
    fillers = await insertFillers(sup, new Set(LINKS.map((l) => l.table)), (table, cols) => {
      const o: Record<string, string> = {};
      if (cols.has('company_id')) o.company_id = fx.companyId;
      if (table === 'users') o.role_id = staffRoleId;
      // The two CHECK constraints: a HIGH_RISE unit needs a floor, a
      // DATE_LINKED installment needs a due date.
      if (table === 'units') o.floor_id = randomUUID();
      if (table === 'installments') o.due_date = '2026-01-01';
      return o;
    });
  }, 120_000);

  afterAll(async () => {
    if (sup && fillers) await deleteFillers(sup, fillers);
    if (fx) await cleanupCompany(systemPrisma, fx.companyId);
    await Promise.all([sup?.$disconnect(), systemPrisma?.$disconnect()]);
  });

  it('the manifest lists the foreign keys', () => {
    expect(LINKS.length).toBeGreaterThanOrEqual(282);
  });

  it('each one refuses a pointer to a row that does not exist', async () => {
    const notRejected = await probeForeignKeys(sup, LINKS, fillers!);
    expect(notRejected).toEqual([]);
  }, 120_000);
});
