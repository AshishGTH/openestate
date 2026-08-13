import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../../database/database.module';
import type {
  CreateGstRateDto,
  UpdateGstRateDto,
  PaginationQuery,
} from '@openestate/shared';

@Injectable()
export class GstRateService {
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
    if (search) {
      where.description = { contains: search, mode: 'insensitive' };
    }

    const [data, total] = await Promise.all([
      this.systemPrisma.gstRate.findMany({
        where,
        skip,
        take: limit,
        orderBy: sortBy ? { [sortBy]: sortOrder } : { sortOrder: 'asc' },
      }),
      this.systemPrisma.gstRate.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(companyId: string, id: string) {
    const item = await this.systemPrisma.gstRate.findFirst({
      where: { id, companyId },
    });
    if (!item) throw new NotFoundException('GST rate not found');
    return item;
  }

  async create(companyId: string, dto: CreateGstRateDto) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const overlap = await this.findOverlap(tx, companyId, dto.effectiveFrom, dto.effectiveTo);
        if (overlap) {
          // The common first-setup footgun: an admin's first (open-ended) GST
          // rate blocks every subsequent one. Auto-close the prior range the
          // day before the new one starts instead of rejecting — safe because
          // GST is snapshotted per cost line at booking time (see
          // booking.service.ts's resolution comment); effectiveFrom/effectiveTo
          // are never used to look up "the rate for a date" anywhere at
          // runtime, only here, to keep ranges unambiguous. Any other overlap
          // (a fixed-range rate, or a new range starting on/before the
          // existing one) is a genuine conflict and still rejected.
          if (overlap.effectiveTo === null && dto.effectiveFrom > overlap.effectiveFrom) {
            const closedTo = new Date(dto.effectiveFrom);
            closedTo.setUTCDate(closedTo.getUTCDate() - 1);
            await tx.gstRate.update({ where: { id: overlap.id }, data: { effectiveTo: closedTo } });
          } else {
            this.throwOverlap(overlap);
          }
        }

        return tx.gstRate.create({ data: { ...dto, companyId } });
      }),
    );
  }

  async update(companyId: string, id: string, dto: UpdateGstRateDto) {
    const existing = await this.findOne(companyId, id);

    const from = dto.effectiveFrom ?? existing.effectiveFrom;
    // `??` would treat an explicit `effectiveTo: null` (clear it) the same
    // as "not provided" (keep existing) — both are nullish. Check key
    // presence instead so a clear is validated against the NEW (open-ended)
    // range, not the stale one.
    const to = 'effectiveTo' in dto ? dto.effectiveTo : existing.effectiveTo;
    const overlap = await this.findOverlap(this.systemPrisma, companyId, from, to, id);
    if (overlap) this.throwOverlap(overlap);

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.gstRate.update({ where: { id }, data: dto }),
      ),
    );
  }

  async remove(companyId: string, id: string) {
    await this.findOne(companyId, id);
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.gstRate.delete({ where: { id } }),
      ),
    );
  }

  private async findOverlap(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: { gstRate: { findFirst: (args: any) => Promise<any> } },
    companyId: string,
    from: Date,
    to: Date | null | undefined,
    excludeId?: string,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
      companyId,
      isActive: true,
      effectiveFrom: { lte: to ?? new Date('9999-12-31') },
      OR: [
        { effectiveTo: null },
        { effectiveTo: { gte: from } },
      ],
    };

    if (excludeId) {
      where.id = { not: excludeId };
    }

    return client.gstRate.findFirst({ where });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private throwOverlap(overlap: any): never {
    const isOpenEnded = overlap.effectiveTo === null;
    throw new BadRequestException(
      `Date range overlaps with existing GST rate "${overlap.description}" (${overlap.effectiveFrom.toISOString().slice(0, 10)} – ${overlap.effectiveTo?.toISOString().slice(0, 10) ?? 'open'})` +
        (isOpenEnded
          ? '. Set an end date on it first, or start this rate\'s range after it.'
          : ''),
    );
  }
}
