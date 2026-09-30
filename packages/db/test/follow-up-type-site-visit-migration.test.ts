/**
 * The is_site_visit backfill: existing installs identified a site visit only
 * by the seeded name 'Site Visit', so the migration flags exactly that name and
 * nothing else. Runs the shipped UPDATE statement from the real migration.sql.
 *
 * Needs DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createSystemPrismaClient } from '../src/index';
import { deleteCompaniesSafely } from './helpers/delete-company-safely';

const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = SYSTEM_URL ? describe : describe.skip;

describeIf('follow_up_types.is_site_visit backfill', () => {
  let prisma: PrismaClient;
  let companyId: string;

  beforeAll(async () => {
    prisma = createSystemPrismaClient(SYSTEM_URL!) as unknown as PrismaClient;
    const tag = Date.now();
    companyId = (await prisma.company.create({ data: { name: `SV Mig ${tag}`, slug: `sv-mig-${tag}` } })).id;
    for (const name of ['Site Visit', 'Phone Call', 'Site Visit Follow-up']) {
      await prisma.followUpType.create({ data: { companyId, name } });
    }
  });

  afterAll(async () => {
    await prisma.followUpType.deleteMany({ where: { companyId } });
    await deleteCompaniesSafely(prisma, [companyId]);
    await prisma.$disconnect();
  });

  it('defaults to false and the backfill flags exactly the type named "Site Visit"', async () => {
    const before = await prisma.followUpType.findMany({ where: { companyId } });
    expect(before.every((t) => t.isSiteVisit === false)).toBe(true);

    const sql = readFileSync(join(__dirname, '../prisma/migrations/20260930120000_follow_up_type_is_site_visit/migration.sql'), 'utf8');
    const update = sql.split(';').map((s) => s.trim()).find((s) => /^UPDATE\s+"follow_up_types"/m.test(s.replace(/^--.*$/gm, '').trim()));
    expect(update).toBeDefined();
    // Restricted to this test's company so parallel test files' rows are untouched.
    await prisma.$executeRawUnsafe(`${update!.replace(/^(--.*\n)+/, '')} AND "company_id" = '${companyId}'::uuid`);

    const after = Object.fromEntries((await prisma.followUpType.findMany({ where: { companyId } })).map((t) => [t.name, t.isSiteVisit]));
    expect(after).toEqual({ 'Site Visit': true, 'Phone Call': false, 'Site Visit Follow-up': false });
  });
});
