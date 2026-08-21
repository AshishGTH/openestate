import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import type {
  CreateInventoryGroupDto,
  UpdateInventoryGroupDto,
  PaginationQuery,
} from '@openestate/shared';

/**
 * LAND_BASED-project analog of TowerService — Sector/Block/Cluster
 * grouping for plots (plotted-farmhouse-inventory.md §8). Every method
 * checks the parent project's shape: a HIGH_RISE project has nothing
 * to group this way, so create/list/edit against one 400s with a
 * legible message rather than silently creating an unreachable group.
 *
 * remove() is a soft deactivate (isActive: false), not a hard delete —
 * unlike TowerService.remove(). Units.inventory_group_id is
 * ON DELETE SET NULL, so a hard delete on a group with real units would
 * silently orphan them into "no group" with no record of what they were
 * grouped under; deactivating preserves that history while hiding the
 * group from active use, matching this codebase's "soft delete, no hard
 * deletes" precedent (masters, users) more than Tower's own hard-delete
 * shape. Matches §8's own wording: "PATCH/DELETE .../:id — edit/deactivate".
 */
@Injectable()
export class InventoryGroupService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  private async assertLandBasedProject(companyId: string, projectId: string) {
    const project = await this.systemPrisma.project.findFirst({ where: { id: projectId, companyId } });
    if (!project) throw new NotFoundException('Project not found');
    if (project.shape !== 'LAND_BASED') {
      throw new BadRequestException(
        'This project is HIGH_RISE. Inventory groups (Sector/Block/Cluster) are for LAND_BASED projects — use towers/floors instead.',
      );
    }
  }

  async findAll(companyId: string, projectId: string, query: PaginationQuery) {
    const { page, limit, search, sortBy, sortOrder } = query;
    const skip = (page - 1) * limit;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { companyId, projectId };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.systemPrisma.inventoryGroup.findMany({
        where,
        skip,
        take: limit,
        orderBy: sortBy ? { [sortBy]: sortOrder } : { code: 'asc' },
        include: { _count: { select: { units: true } } },
      }),
      this.systemPrisma.inventoryGroup.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(companyId: string, projectId: string, id: string) {
    const item = await this.systemPrisma.inventoryGroup.findFirst({
      where: { id, companyId, projectId },
      include: { units: { orderBy: { number: 'asc' } } },
    });
    if (!item) throw new NotFoundException('Inventory group not found');
    return item;
  }

  async create(companyId: string, projectId: string, dto: CreateInventoryGroupDto) {
    await this.assertLandBasedProject(companyId, projectId);
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.inventoryGroup.create({ data: { ...dto, companyId, projectId } }),
      ),
    );
  }

  async update(companyId: string, id: string, dto: UpdateInventoryGroupDto) {
    const existing = await this.systemPrisma.inventoryGroup.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundException('Inventory group not found');
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.inventoryGroup.update({ where: { id }, data: dto }),
      ),
    );
  }

  async remove(companyId: string, id: string) {
    const existing = await this.systemPrisma.inventoryGroup.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundException('Inventory group not found');
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.inventoryGroup.update({ where: { id }, data: { isActive: false } }),
      ),
    );
  }
}
