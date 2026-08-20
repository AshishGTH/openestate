import {
  BadRequestException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import type { ChangeRateDto, PaginationQuery } from '@openestate/shared';

@Injectable()
export class RateRevisionService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  async changeRate(companyId: string, projectId: string, dto: ChangeRateDto, userId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const effectiveFrom = new Date(dto.effectiveFrom);
    effectiveFrom.setHours(0, 0, 0, 0);

    if (effectiveFrom > today) {
      throw new BadRequestException('effectiveFrom must not be in the future');
    }

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const units = await tx.unit.findMany({
          where: {
            id: { in: dto.unitIds },
            companyId,
            // Unit.projectId (Phase A scalar) — the old floor.tower.projectId
            // traversal matched zero LAND_BASED units, so a bulk rate change
            // against them always 400'd as "not found in project," a false
            // error. See plotted-farmhouse-inventory.md §13.1.
            projectId,
          },
          include: {
            rateRevisions: {
              orderBy: { effectiveFrom: 'desc' as const },
              take: 1,
            },
          },
        });

        if (units.length !== dto.unitIds.length) {
          const foundIds = new Set(units.map((u: { id: string }) => u.id));
          const missing = dto.unitIds.filter((id) => !foundIds.has(id));
          throw new BadRequestException(`Units not found in project: ${missing.join(', ')}`);
        }

        const frozenStatuses = ['BOOKED', 'ALLOTTED', 'REGISTERED'];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const frozen = units.filter((u: any) => frozenStatuses.includes(u.status));
        if (frozen.length > 0) {
          throw new BadRequestException(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            `Cannot change rate for units in frozen status: ${frozen.map((u: any) => u.number).join(', ')}`,
          );
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const unit of units as any[]) {
          const latestRevision = unit.rateRevisions[0];
          if (latestRevision) {
            const latestDate = new Date(latestRevision.effectiveFrom);
            latestDate.setHours(0, 0, 0, 0);
            if (effectiveFrom < latestDate) {
              throw new BadRequestException(
                `effectiveFrom (${effectiveFrom.toISOString().slice(0, 10)}) must be >= latest revision date (${latestDate.toISOString().slice(0, 10)}) for unit ${unit.number}`,
              );
            }
          }
        }

        for (const unit of units) {
          await tx.unitRateRevision.create({
            data: {
              companyId,
              unitId: unit.id,
              ratePaise: dto.ratePaise,
              effectiveFrom: dto.effectiveFrom,
              reason: dto.reason,
              createdById: userId,
            },
          });

          await tx.unit.update({
            where: { id: unit.id },
            data: { baseRatePaise: dto.ratePaise },
          });
        }

        return { updatedCount: units.length };
      }),
    );
  }

  async getRateHistory(companyId: string, unitId: string, query: PaginationQuery) {
    const { page, limit } = query;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.systemPrisma.unitRateRevision.findMany({
        where: { unitId, companyId },
        skip,
        take: limit,
        orderBy: { effectiveFrom: 'desc' },
        include: { createdBy: { select: { id: true, name: true, email: true } } },
      }),
      this.systemPrisma.unitRateRevision.count({ where: { unitId, companyId } }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
