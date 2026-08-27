/**
 * Phase 0 of feature-completion-plan.md — lead stage foundation.
 *
 * Covers what the standalone e2e/master-creation and presales-inquiry
 * suites don't: RLS isolation on both new tables (proven through a raw
 * connection, not asserted — same discipline as
 * custom-field-values-isolation.test.ts), the partial unique index
 * actually firing under real concurrency (not just the service's
 * clear-then-set logic in isolation), stage-history rows written on
 * every transition with the correct from/to/actor, stageId surviving a
 * terminal status transition unchanged, and the occupancy/reassign flow
 * on deactivating an occupied stage.
 *
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runWithTenant, withTenantTx } from '@openestate/db';
import { SYSTEM_CLOCK } from '@openestate/shared';
import { makeClients, seedCompany, makeApplicant, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { InquiryService } from '../src/presales/inquiry.service';
import { AssignmentService } from '../src/presales/assignment.service';
import { CustomFieldsService } from '../src/custom-fields/custom-fields.service';
import { LeadStageTransitionService } from '../src/presales/lead-stage-transition.service';
import { LeadStageService } from '../src/masters/lead-stage/lead-stage.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

interface CountRow {
  n: bigint;
}

describeIf('Lead stage foundation (Phase 0)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let companyA: CompanyFixture;
  let companyB: CompanyFixture;
  let inquiryService: InquiryService;
  let leadStageService: LeadStageService;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    companyA = await seedCompany(systemPrisma);
    companyB = await seedCompany(systemPrisma);

    const assignmentService = new AssignmentService(tenantPrisma);
    inquiryService = new InquiryService(
      tenantPrisma,
      systemPrisma,
      SYSTEM_CLOCK,
      assignmentService,
      undefined as never,
      new CustomFieldsService(tenantPrisma, systemPrisma),
      new LeadStageTransitionService(),
    );
    leadStageService = new LeadStageService(tenantPrisma, systemPrisma);
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, companyA.companyId);
    await cleanupCompany(systemPrisma, companyB.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  async function countAs(companyId: string, sql: string): Promise<number> {
    return runWithTenant({ companyId }, () =>
      withTenantTx(tenantPrisma, companyId, async (tx) => {
        const rows = await (tx as { $queryRawUnsafe: (q: string) => Promise<CountRow[]> }).$queryRawUnsafe(sql);
        return Number(rows[0].n);
      }),
    );
  }

  describe('RLS isolation', () => {
    it("company B cannot see company A's lead_stages, even via a raw filter-less query", async () => {
      await leadStageService.create(companyA.companyId, { name: 'RLS Probe Stage', sortOrder: 0, isActive: true, isDefault: false });

      const own = await countAs(companyA.companyId, `SELECT count(*)::bigint AS n FROM lead_stages WHERE name = 'RLS Probe Stage'`);
      expect(own).toBe(1);

      const other = await countAs(companyB.companyId, `SELECT count(*)::bigint AS n FROM lead_stages WHERE name = 'RLS Probe Stage'`);
      expect(other).toBe(0);
    });

    it("company B cannot see company A's inquiry_stage_history, even via a raw filter-less query", async () => {
      const applicantId = await makeApplicant(systemPrisma, companyA.companyId);
      const stage = await leadStageService.create(companyA.companyId, { name: 'RLS History Stage', sortOrder: 1, isActive: true, isDefault: false });
      const inquiry = await inquiryService.create(companyA.companyId, { applicantId, stageId: stage.id }, companyA.userId);

      const own = await countAs(companyA.companyId, `SELECT count(*)::bigint AS n FROM inquiry_stage_history WHERE inquiry_id = '${inquiry.id}'`);
      expect(own).toBe(1);

      const other = await countAs(companyB.companyId, `SELECT count(*)::bigint AS n FROM inquiry_stage_history WHERE inquiry_id = '${inquiry.id}'`);
      expect(other).toBe(0);
    });
  });

  describe('lead_stages_one_default_per_company — the real enforcement, under real concurrency', () => {
    it('rejects a second concurrent isDefault:true row for the same company, at the DB layer, bypassing the service clear-then-set entirely', async () => {
      // Deliberately raw tx.leadStage.create() calls, not
      // LeadStageService.create() — the point of this test is proving the
      // INDEX is what's authoritative, not the service's own
      // clear-then-set UX step (covered separately below).
      const results = await Promise.allSettled([
        runWithTenant({ companyId: companyA.companyId }, () =>
          withTenantTx(tenantPrisma, companyA.companyId, (tx) =>
            tx.leadStage.create({ data: { companyId: companyA.companyId, name: 'Concurrent A', sortOrder: 90, isDefault: true } }),
          ),
        ),
        runWithTenant({ companyId: companyA.companyId }, () =>
          withTenantTx(tenantPrisma, companyA.companyId, (tx) =>
            tx.leadStage.create({ data: { companyId: companyA.companyId, name: 'Concurrent B', sortOrder: 91, isDefault: true } }),
          ),
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const defaults = await systemPrisma.leadStage.count({ where: { companyId: companyA.companyId, isDefault: true, name: { in: ['Concurrent A', 'Concurrent B'] } } });
      expect(defaults).toBe(1);
    });
  });

  describe('LeadStageService.create/update — service-level clear-then-set UX', () => {
    it('setting a new default flips the prior one off, in the same request', async () => {
      const first = await leadStageService.create(companyB.companyId, { name: 'First Default', sortOrder: 0, isActive: true, isDefault: true });
      const second = await leadStageService.create(companyB.companyId, { name: 'Second Default', sortOrder: 1, isActive: true, isDefault: true });

      const refreshedFirst = await systemPrisma.leadStage.findUnique({ where: { id: first.id } });
      expect(refreshedFirst.isDefault).toBe(false);
      expect(second.isDefault).toBe(true);
    });
  });

  describe('Stage transition history — written on every real transition', () => {
    it('create() writes the initial null -> default row', async () => {
      const stage = await leadStageService.create(companyB.companyId, { name: 'Initial Stage', sortOrder: 5, isActive: true, isDefault: false });
      const applicantId = await makeApplicant(systemPrisma, companyB.companyId);
      const inquiry = await inquiryService.create(companyB.companyId, { applicantId, stageId: stage.id }, companyB.userId);

      const history = await systemPrisma.inquiryStageHistory.findMany({ where: { inquiryId: inquiry.id } });
      expect(history).toHaveLength(1);
      expect(history[0].fromStageId).toBeNull();
      expect(history[0].toStageId).toBe(stage.id);
      expect(history[0].changedById).toBe(companyB.userId);
      expect(history[0].isAdministrative).toBe(false);
    });

    it('update() writes a from -> to row only when stageId actually changes', async () => {
      const stageA = await leadStageService.create(companyB.companyId, { name: 'Move From', sortOrder: 6, isActive: true, isDefault: false });
      const stageB = await leadStageService.create(companyB.companyId, { name: 'Move To', sortOrder: 7, isActive: true, isDefault: false });
      const applicantId = await makeApplicant(systemPrisma, companyB.companyId);
      const inquiry = await inquiryService.create(companyB.companyId, { applicantId, stageId: stageA.id }, companyB.userId);

      // A save that doesn't touch stageId — must NOT add a history row.
      await inquiryService.update(companyB.companyId, inquiry.id, { nextFollowupAt: new Date() }, { visibleUserIds: null }, companyB.userId);
      expect(await systemPrisma.inquiryStageHistory.count({ where: { inquiryId: inquiry.id } })).toBe(1);

      await inquiryService.update(companyB.companyId, inquiry.id, { stageId: stageB.id }, { visibleUserIds: null }, companyB.userId);
      const history = await systemPrisma.inquiryStageHistory.findMany({ where: { inquiryId: inquiry.id }, orderBy: { changedAt: 'asc' } });
      expect(history).toHaveLength(2);
      expect(history[1].fromStageId).toBe(stageA.id);
      expect(history[1].toStageId).toBe(stageB.id);
      expect(history[1].isAdministrative).toBe(false);
    });

    it('stageId is never cleared by a transition to a terminal status', async () => {
      const stage = await leadStageService.create(companyB.companyId, { name: 'Terminal Check Stage', sortOrder: 8, isActive: true, isDefault: false });
      const applicantId = await makeApplicant(systemPrisma, companyB.companyId);
      const inquiry = await inquiryService.create(companyB.companyId, { applicantId, stageId: stage.id }, companyB.userId);

      await inquiryService.update(companyB.companyId, inquiry.id, { status: 'DUMPED' }, { visibleUserIds: null }, companyB.userId);

      const after = await systemPrisma.inquiry.findUnique({ where: { id: inquiry.id } });
      expect(after.status).toBe('DUMPED');
      expect(after.stageId).toBe(stage.id);
    });
  });

  describe('LeadStageService.update — occupancy and reassign-on-deactivate', () => {
    it('refuses to deactivate an occupied stage without reassignToStageId, naming the exact count', async () => {
      const stage = await leadStageService.create(companyA.companyId, { name: 'Occupied Stage', sortOrder: 20, isActive: true, isDefault: false });
      const applicantId = await makeApplicant(systemPrisma, companyA.companyId);
      await inquiryService.create(companyA.companyId, { applicantId, stageId: stage.id }, companyA.userId);

      await expect(
        leadStageService.update(companyA.companyId, stage.id, { isActive: false }, companyA.userId),
      ).rejects.toThrow(/1 active lead/);
    });

    it('reassigns occupants and writes an isAdministrative history row per inquiry when a target is provided', async () => {
      const from = await leadStageService.create(companyA.companyId, { name: 'Reassign From', sortOrder: 21, isActive: true, isDefault: false });
      const to = await leadStageService.create(companyA.companyId, { name: 'Reassign To', sortOrder: 22, isActive: true, isDefault: false });
      const applicantId = await makeApplicant(systemPrisma, companyA.companyId);
      const inquiry = await inquiryService.create(companyA.companyId, { applicantId, stageId: from.id }, companyA.userId);

      await leadStageService.update(companyA.companyId, from.id, { isActive: false, reassignToStageId: to.id }, companyA.userId);

      const movedInquiry = await systemPrisma.inquiry.findUnique({ where: { id: inquiry.id } });
      expect(movedInquiry.stageId).toBe(to.id);

      const deactivatedStage = await systemPrisma.leadStage.findUnique({ where: { id: from.id } });
      expect(deactivatedStage.isActive).toBe(false);

      const history = await systemPrisma.inquiryStageHistory.findMany({ where: { inquiryId: inquiry.id }, orderBy: { changedAt: 'asc' } });
      expect(history).toHaveLength(2); // initial null->from, then from->to
      expect(history[0].isAdministrative).toBe(false); // the initial creation-time assignment is a real event
      expect(history[1].fromStageId).toBe(from.id);
      expect(history[1].toStageId).toBe(to.id);
      expect(history[1].changedById).toBe(companyA.userId);
      // The reassign-on-deactivate row is a bulk system move, not a rep
      // advancing the lead — must be flagged so Phase 3's funnel can
      // exclude it by default (see InquiryStageHistory's schema doc
      // comment). This is the assertion that actually pins the feature.
      expect(history[1].isAdministrative).toBe(true);
    });

    it('occupancy() only counts ACTIVE-status inquiries, not terminal ones', async () => {
      const stage = await leadStageService.create(companyA.companyId, { name: 'Occupancy Active-Only', sortOrder: 23, isActive: true, isDefault: false });
      const applicantId = await makeApplicant(systemPrisma, companyA.companyId);
      const inquiry = await inquiryService.create(companyA.companyId, { applicantId, stageId: stage.id }, companyA.userId);
      await inquiryService.update(companyA.companyId, inquiry.id, { status: 'SUCCESSFUL' }, { visibleUserIds: null }, companyA.userId);

      const { count } = await leadStageService.occupancy(companyA.companyId, stage.id);
      expect(count).toBe(0);
    });
  });
});
