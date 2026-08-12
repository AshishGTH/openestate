/**
 * Project-edit backend tests (PATCH /projects/:id via ProjectService.update).
 * Three things this endpoint must never do, each proven against real
 * Postgres, not assumed from reading the code:
 * (1) editing a project's areaLocationId must never retroactively alter an
 *     existing booking's snapshotted placeOfSupplyStateCode (CLAUDE.md:
 *     GST place of supply is a one-time snapshot, immutable after booking).
 * (2) editing a project must never touch its towers/floors/units/rate
 *     revisions — nothing in ProjectService.update() should reach them, but
 *     this is the first time a project WITH inventory has ever been mutated
 *     by a test, so "assert the outcome" applies (CLAUDE.md standing rule).
 * (3) a project belongs to its own company — findOne's companyId scoping
 *     must 404, not leak, when a different company edits it.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { SYSTEM_CLOCK } from '@openestate/shared';
import { ProjectService } from '../src/inventory/project.service';
import { CustomFieldsService } from '../src/custom-fields/custom-fields.service';
import {
  makeClients,
  buildServices,
  seedCompany,
  makeUnit,
  makeApplicant,
  cleanupCompany,
  type Services,
  type CompanyFixture,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

describeIf('Project edit (PATCH /projects/:id)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let projects: ProjectService;
  let fx: CompanyFixture;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    const customFields = new CustomFieldsService(tenantPrisma, systemPrisma);
    projects = new ProjectService(tenantPrisma, systemPrisma, customFields);
    fx = await seedCompany(systemPrisma, { gstStateCode: '09', placeStateCode: '09' });
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it("editing areaLocationId does not alter an existing booking's snapshotted placeOfSupplyStateCode", async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const unitId = await makeUnit(systemPrisma, fx);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId,
        primaryApplicantId: applicantId,
        coApplicantIds: [],
        bookingDate: new Date('2026-06-01'),
        costLines: [
          { kind: 'BASE', label: 'Base', baseAmountPaise: 10_00_000n * 100n, gstRateId: fx.defaultGstRateId },
        ],
      },
      fx.userId,
    );
    expect(booking.placeOfSupplyStateCode).toBe('09');

    const newArea = await systemPrisma.areaLocation.create({
      data: { companyId: fx.companyId, name: `New Area ${Date.now()}`, stateCode: '27' },
    });
    await projects.update(fx.companyId, fx.projectId, { areaLocationId: newArea.id });

    const bookingAfter = await systemPrisma.booking.findFirst({ where: { id: booking.id } });
    expect(bookingAfter.placeOfSupplyStateCode).toBe('09');
  });

  it('editing a project leaves its towers, floors, units, and rate revisions untouched', async () => {
    const unitId = await makeUnit(systemPrisma, fx);
    await systemPrisma.unitRateRevision.create({
      data: { companyId: fx.companyId, unitId, ratePaise: 12_00_000n * 100n, effectiveFrom: new Date('2019-04-01') },
    });

    const towerBefore = await systemPrisma.tower.findFirst({ where: { id: fx.towerId } });
    const floorBefore = await systemPrisma.floor.findFirst({ where: { id: fx.floorId } });
    const unitBefore = await systemPrisma.unit.findFirst({ where: { id: unitId } });
    const revisionsBefore = await systemPrisma.unitRateRevision.findMany({ where: { unitId } });

    await projects.update(fx.companyId, fx.projectId, {
      name: `Renamed ${Date.now()}`,
      address: '221B Baker Street',
    });

    const towerAfter = await systemPrisma.tower.findFirst({ where: { id: fx.towerId } });
    const floorAfter = await systemPrisma.floor.findFirst({ where: { id: fx.floorId } });
    const unitAfter = await systemPrisma.unit.findFirst({ where: { id: unitId } });
    const revisionsAfter = await systemPrisma.unitRateRevision.findMany({ where: { unitId } });

    expect(towerAfter).toEqual(towerBefore);
    expect(floorAfter).toEqual(floorBefore);
    expect(unitAfter).toEqual(unitBefore);
    expect(revisionsAfter).toEqual(revisionsBefore);
  });

  it('a project belongs to its own company — editing it from a different company 404s, not leaks', async () => {
    const otherFx = await seedCompany(systemPrisma);
    await expect(projects.update(otherFx.companyId, fx.projectId, { name: 'Hijacked' })).rejects.toThrow(
      NotFoundException,
    );

    const project = await systemPrisma.project.findFirst({ where: { id: fx.projectId } });
    expect(project.name).not.toBe('Hijacked');

    await cleanupCompany(systemPrisma, otherFx.companyId);
  });
});
