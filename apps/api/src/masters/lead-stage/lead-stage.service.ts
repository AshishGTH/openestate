import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../../database/database.module';
import {
  ACTIVE_INQUIRY_STATUSES,
  type CreateLeadStageDto,
  type UpdateLeadStageDto,
  type PaginationQuery,
} from '@openestate/shared';

/**
 * Bespoke module, not master.factory.ts's generic createMasterModule —
 * isDefault carries a side effect (clear the company's prior default)
 * that the factory's extraFields mechanism can't express: extraFields
 * only extends the create/update zod schema, the factory's own
 * create()/update() are a plain validated-payload spread into Prisma
 * with no hook point. See feature-completion-plan.md's Phase 0 §1.
 */
@Injectable()
export class LeadStageService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  async findAll(companyId: string, query: PaginationQuery) {
    const { page, limit, search, sortBy, sortOrder } = query;
    const skip = (page - 1) * limit;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { companyId };
    if (search) where.name = { contains: search, mode: 'insensitive' };

    const [data, total] = await Promise.all([
      this.systemPrisma.leadStage.findMany({
        where,
        skip,
        take: limit,
        orderBy: sortBy ? { [sortBy]: sortOrder } : { sortOrder: 'asc' },
      }),
      this.systemPrisma.leadStage.count({ where }),
    ]);

    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(companyId: string, id: string) {
    const item = await this.systemPrisma.leadStage.findFirst({ where: { id, companyId } });
    if (!item) throw new NotFoundException('Lead stage not found');
    return item;
  }

  /**
   * Only ACTIVE-status (OPEN/CONTINUED) inquiries count — the whole
   * reason this exists is "don't let a stage's leads vanish from
   * Phase 2's board," and the board only ever renders non-terminal
   * inquiries in the first place. A DUMPED/SUCCESSFUL inquiry sitting
   * at this stage historically was never on the board, so it doesn't
   * need reassignment to keep it from "vanishing" from something it
   * was never shown on.
   */
  async occupancy(companyId: string, id: string) {
    await this.findOne(companyId, id);
    const count = await this.systemPrisma.inquiry.count({
      where: { companyId, stageId: id, status: { in: [...ACTIVE_INQUIRY_STATUSES] } },
    });
    return { count };
  }

  async create(companyId: string, dto: CreateLeadStageDto) {
    try {
      return await runWithTenant({ companyId }, () =>
        withTenantTx(this.tenantPrisma, companyId, async (tx) => {
          if (dto.isDefault) {
            await tx.leadStage.updateMany({
              where: { companyId, isDefault: true },
              data: { isDefault: false },
            });
          }
          return tx.leadStage.create({ data: { ...dto, companyId } });
        }),
      );
    } catch (err) {
      throw this.mapDuplicateName(err);
    }
  }

  async update(companyId: string, id: string, dto: UpdateLeadStageDto, actorId: string) {
    const existing = await this.findOne(companyId, id);
    const { reassignToStageId, ...rest } = dto;

    const isDeactivating = rest.isActive === false && existing.isActive === true;

    // Refused outright, never auto-resolved: which stage should inherit
    // "default" is a real decision only an admin can make, and silently
    // picking one (or leaving the company with none) is exactly the kind
    // of guess this codebase keeps getting burned by. The admin must set
    // a different stage as default first (a separate, explicit request),
    // then deactivate this one.
    if (isDeactivating && existing.isDefault) {
      throw new BadRequestException(
        'Cannot deactivate the default lead stage — it would leave new inquiries with no default to fall back on. Set a different stage as the default first, then deactivate this one.',
      );
    }

    try {
      return await runWithTenant({ companyId }, () =>
        withTenantTx(this.tenantPrisma, companyId, async (tx) => {
          if (isDeactivating) {
            await this.reassignOccupants(tx, companyId, id, reassignToStageId, actorId);
          }

          if (rest.isDefault) {
            await tx.leadStage.updateMany({
              where: { companyId, isDefault: true, id: { not: id } },
              data: { isDefault: false },
            });
          }

          return tx.leadStage.update({ where: { id }, data: rest });
        }),
      );
    } catch (err) {
      throw this.mapDuplicateName(err);
    }
  }

  /**
   * Never a silent partial action: if the stage is occupied (by the
   * same ACTIVE-status definition occupancy() uses) and no target was
   * given, this throws naming the exact count — the frontend's
   * confirmation dialog reads that count, same shape as the existing
   * areaLocationId booking-count-confirmation pattern
   * (ProjectService.bookingCount / ProjectDetail.tsx).
   */
  private async reassignOccupants(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any,
    companyId: string,
    stageId: string,
    reassignToStageId: string | undefined,
    actorId: string,
  ) {
    const affected = await tx.inquiry.findMany({
      where: { companyId, stageId, status: { in: [...ACTIVE_INQUIRY_STATUSES] } },
      select: { id: true },
    });
    if (affected.length === 0) return;

    if (!reassignToStageId) {
      throw new BadRequestException(
        `This stage has ${affected.length} active lead(s). Provide reassignToStageId to move them before deactivating.`,
      );
    }
    if (reassignToStageId === stageId) {
      throw new BadRequestException('reassignToStageId must be a different stage');
    }
    const target = await tx.leadStage.findFirst({ where: { id: reassignToStageId, companyId } });
    if (!target) throw new NotFoundException('Target stage not found');

    const ids = affected.map((a: { id: string }) => a.id);
    await tx.inquiry.updateMany({ where: { id: { in: ids } }, data: { stageId: reassignToStageId } });
    // isAdministrative: true — this is a bulk system-driven move (an
    // admin retiring a stage), not a rep advancing a lead through the
    // pipeline. See InquiryStageHistory's schema doc comment: Phase 3's
    // funnel must exclude these by default, or retiring one occupied
    // stage would show every affected lead "reaching" the target stage
    // on one date, often moving backward through the pipeline.
    await tx.inquiryStageHistory.createMany({
      data: ids.map((inquiryId: string) => ({
        companyId,
        inquiryId,
        fromStageId: stageId,
        toStageId: reassignToStageId,
        changedById: actorId,
        isAdministrative: true,
      })),
    });
  }

  // No remove()/hard-delete: it would bypass the occupancy/reassignment
  // safety net above entirely (no confirmation, no history row — the DB's
  // ON DELETE SET NULL would silently orphan every active inquiry's
  // stageId), and inquiry_stage_history.to_stage_id RESTRICTs onto this
  // table anyway, so a hard delete would 500 on any stage that has ever
  // had a single inquiry pass through it. Deactivation (isActive: false,
  // via update()) is the only way to retire a stage — matches the
  // soft-delete convention this codebase already prefers elsewhere.

  private mapDuplicateName(err: unknown): unknown {
    if (err && typeof err === 'object' && (err as { code?: string }).code === 'P2002') {
      return new BadRequestException('Lead stage with this name already exists');
    }
    return err;
  }
}
