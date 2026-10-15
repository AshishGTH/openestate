/**
 * Regression test for the upgrade-path gap Phase 0 of
 * feature-completion-plan.md was deliberately built to avoid: seeding a
 * brand-new master TYPE based on row count alone would resurrect a
 * deliberate deletion the next time the sync runs. syncLeadStages is
 * gated by CompanyConfig.leadStagesSeededAt, a one-time marker, not by
 * "does this company currently have zero LeadStage rows" — this file
 * pins both halves: a genuinely-never-seeded company gets the default
 * pipeline, and a company that already has the marker set (even with
 * zero current rows, simulating an admin who deleted all six) is left
 * alone.
 *
 * Needs DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_LEAD_STAGES } from '@openestate/shared';
import { createSystemPrismaClient } from '../src/index';
import { syncLeadStages } from '../prisma/sync-permissions';

const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = SYSTEM_URL ? describe : describe.skip;

describeIf('syncLeadStages: upgrade-path seeding, gated by a one-time marker', () => {
  let prisma: PrismaClient;
  let neverSeededCompanyId: string;
  let alreadyCustomisedCompanyId: string;
  let deletedAllSixCompanyId: string;

  beforeAll(async () => {
    prisma = createSystemPrismaClient(SYSTEM_URL!) as unknown as PrismaClient;
    const tag = Date.now();

    const neverSeeded = await prisma.company.create({
      data: { name: `SyncStage Never ${tag}`, slug: `syncstage-never-${tag}` },
    });
    neverSeededCompanyId = neverSeeded.id;

    // Already seeded once, on an earlier run, and an admin has since
    // customised the list (renamed one, deactivated another) — must be
    // left completely untouched by a second sync run.
    const customised = await prisma.company.create({
      data: { name: `SyncStage Customised ${tag}`, slug: `syncstage-customised-${tag}` },
    });
    alreadyCustomisedCompanyId = customised.id;
    await prisma.companyConfig.create({
      data: { companyId: customised.id, leadStagesSeededAt: new Date() },
    });
    await prisma.leadStage.create({
      data: { companyId: customised.id, name: 'Only One Left', sortOrder: 0, isDefault: true },
    });

    // The case the marker specifically exists to protect: seeded once,
    // then an admin deleted all six. Zero rows today, but the marker
    // says "not never-seeded" — must NOT be resurrected.
    const deletedAllSix = await prisma.company.create({
      data: { name: `SyncStage DeletedAll ${tag}`, slug: `syncstage-deletedall-${tag}` },
    });
    deletedAllSixCompanyId = deletedAllSix.id;
    await prisma.companyConfig.create({
      data: { companyId: deletedAllSix.id, leadStagesSeededAt: new Date() },
    });
  });

  afterAll(async () => {
    const ids = [neverSeededCompanyId, alreadyCustomisedCompanyId, deletedAllSixCompanyId];
    await prisma.leadStage.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.companyConfig.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it('seeds the default 6-stage pipeline for a never-seeded company, in order, with only the first marked default', async () => {
    // Every call here is scoped to this file's own companies: the upgrade
    // runs it unscoped, but in the shared test database an unscoped call
    // reaches other test files' companies (see the last test below).
    const { seeded, skipped } = await syncLeadStages(prisma, { companyId: neverSeededCompanyId });
    expect(seeded).toBe(1);
    expect(skipped).toBe(0);

    const stages = await prisma.leadStage.findMany({
      where: { companyId: neverSeededCompanyId },
      orderBy: { sortOrder: 'asc' },
    });
    expect(stages.map((s) => s.name)).toEqual([...DEFAULT_LEAD_STAGES]);
    expect(stages.filter((s) => s.isDefault).map((s) => s.name)).toEqual(['New']);

    const config = await prisma.companyConfig.findUnique({ where: { companyId: neverSeededCompanyId } });
    expect(config?.leadStagesSeededAt).not.toBeNull();
  });

  it('is idempotent — a second run seeds nothing for a company already marked', async () => {
    const before = await prisma.leadStage.count({ where: { companyId: neverSeededCompanyId } });
    await syncLeadStages(prisma, { companyId: neverSeededCompanyId });
    const after = await prisma.leadStage.count({ where: { companyId: neverSeededCompanyId } });
    expect(after).toBe(before);
    expect(after).toBe(DEFAULT_LEAD_STAGES.length);
  });

  it('does NOT touch a company that already customised its seeded stages', async () => {
    await syncLeadStages(prisma, { companyId: alreadyCustomisedCompanyId });
    const stages = await prisma.leadStage.findMany({ where: { companyId: alreadyCustomisedCompanyId } });
    expect(stages.map((s) => s.name)).toEqual(['Only One Left']);
  });

  it('does NOT resurrect a company whose admin deleted all six after a real seeding', async () => {
    await syncLeadStages(prisma, { companyId: deletedAllSixCompanyId });
    const stages = await prisma.leadStage.count({ where: { companyId: deletedAllSixCompanyId } });
    expect(stages).toBe(0);
  });

  it('a company that vanishes between listing and writing is skipped, counted, and logged — not thrown', async () => {
    // Deterministic reproduction of the race isForeignKeyViolation's doc
    // comment describes, not a timing-dependent guess: a Proxy deletes
    // the company right before syncLeadStages' own per-company
    // transaction for it runs, guaranteeing the FK violation fires for
    // real. Nothing references this company yet (fresh, no config, no
    // stages), so the delete itself succeeds cleanly — the transaction's
    // own tx.leadStage.create() is what then hits
    // lead_stages_company_id_fkey.
    const tag = Date.now();
    const vanishing = await prisma.company.create({
      data: { name: `SyncStage Vanishes ${tag}`, slug: `syncstage-vanishes-${tag}` },
    });

    let intercepted = false;
    const poisoned = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === '$transaction' && !intercepted) {
          return async (fn: (tx: PrismaClient) => Promise<unknown>) => {
            intercepted = true;
            await target.company.delete({ where: { id: vanishing.id } });
            return target.$transaction(fn);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { skipped } = await syncLeadStages(poisoned as PrismaClient, { companyId: vanishing.id });
      expect(skipped).toBeGreaterThanOrEqual(1);
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes(vanishing.id))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
    // The company was already deleted by the proxy above — nothing left
    // to clean up in afterAll.
  });

  it("a scoped call never touches another test file's company", async () => {
    // The order the 2026-09-23 scheduled CI run logged: another file's cleanup
    // deletes the lead stages it never had, this file's sync seeds that
    // company, the cleanup then deletes its config (and with it the "already
    // seeded" marker), and this file's next sync call meets six stages with
    // no marker. Unscoped, that call fails on the unique (company_id, name)
    // key and every later sync call does too.
    const tag = Date.now();
    const other = await prisma.company.create({
      data: { name: `SyncStage Other ${tag}`, slug: `syncstage-other-${tag}` },
    });
    try {
      await prisma.leadStage.deleteMany({ where: { companyId: other.id } }); // other file's cleanup, step 1
      await syncLeadStages(prisma, { companyId: neverSeededCompanyId }); // this file's sync
      await prisma.companyConfig.deleteMany({ where: { companyId: other.id } }); // other file's cleanup, step 2
      await syncLeadStages(prisma, { companyId: neverSeededCompanyId }); // this file's next sync must not throw
      expect(await prisma.leadStage.count({ where: { companyId: other.id } })).toBe(0);
    } finally {
      await prisma.leadStage.deleteMany({ where: { companyId: other.id } });
      await prisma.companyConfig.deleteMany({ where: { companyId: other.id } });
      await prisma.company.delete({ where: { id: other.id } });
    }
  });
});
