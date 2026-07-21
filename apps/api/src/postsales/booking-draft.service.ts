import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import type { SaveBookingDraftDto } from '@openestate/shared';
import type { Prisma } from '@prisma/client';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';

/**
 * Scratch state for the booking wizard so a partially-filled form survives a
 * lost tab / next-day return. Ephemeral by design — not part of the ledger
 * or audit trail (excluded from AUDITED_MODELS), hard-deleted on discard or
 * once the real booking is created. Always owned by a real authenticated
 * user — unlike the financial-core rows, there's no system-actor case.
 */
@Injectable()
export class BookingDraftService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  async create(companyId: string, dto: SaveBookingDraftDto, actorId: string) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.bookingDraft.create({
          data: {
            companyId,
            label: dto.label ?? null,
            draftData: dto.draftData as Prisma.InputJsonValue,
            createdById: actorId,
          },
        }),
      ),
    );
  }

  async update(companyId: string, id: string, dto: SaveBookingDraftDto, actorId: string) {
    const existing = await this.systemPrisma.bookingDraft.findFirst({ where: { id, companyId, createdById: actorId } });
    if (!existing) throw new NotFoundException('Draft not found');

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.bookingDraft.update({
          where: { id },
          data: { label: dto.label ?? existing.label, draftData: dto.draftData as Prisma.InputJsonValue },
        }),
      ),
    );
  }

  /** My own drafts, most recently updated first — the wizard offers to resume the latest one. */
  async listMine(companyId: string, actorId: string) {
    return this.systemPrisma.bookingDraft.findMany({
      where: { companyId, createdById: actorId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findOne(companyId: string, id: string, actorId: string) {
    const draft = await this.systemPrisma.bookingDraft.findFirst({ where: { id, companyId, createdById: actorId } });
    if (!draft) throw new NotFoundException('Draft not found');
    return draft;
  }

  async discard(companyId: string, id: string, actorId: string) {
    const existing = await this.systemPrisma.bookingDraft.findFirst({ where: { id, companyId, createdById: actorId } });
    if (!existing) throw new NotFoundException('Draft not found');

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) => tx.bookingDraft.delete({ where: { id } })),
    );
  }
}
