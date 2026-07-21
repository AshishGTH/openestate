import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import type { CreateFollowUpDto, UpdateFollowUpDto } from '@openestate/shared';

@Injectable()
export class FollowUpService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  async findAllForInquiry(companyId: string, inquiryId: string) {
    return this.systemPrisma.followUp.findMany({
      where: { companyId, inquiryId },
      include: { type: true, createdBy: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(
    companyId: string,
    inquiryId: string,
    dto: CreateFollowUpDto,
    createdById: string | null,
  ) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const inquiry = await tx.inquiry.findFirst({ where: { id: inquiryId, companyId } });
        if (!inquiry) throw new NotFoundException('Inquiry not found');

        const followUp = await tx.followUp.create({
          data: {
            companyId,
            inquiryId,
            typeId: dto.typeId,
            notes: dto.notes,
            outcome: dto.outcome,
            nextActionAt: dto.nextActionAt,
            scheduledAt: dto.scheduledAt,
            venue: dto.venue,
            createdById,
          },
        });

        // Advance the inquiry's own next-followup cursor when this
        // follow-up carries a next action date; also flips DUMPED/SUCCESSFUL
        // inquiries back to CONTINUED when a new follow-up is logged.
        if (dto.nextActionAt) {
          await tx.inquiry.update({
            where: { id: inquiryId },
            data: {
              nextFollowupAt: dto.nextActionAt,
              status: inquiry.status === 'OPEN' ? 'CONTINUED' : inquiry.status,
            },
          });
        }

        return followUp;
      }),
    );
  }

  async update(companyId: string, id: string, dto: UpdateFollowUpDto) {
    const existing = await this.systemPrisma.followUp.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundException('Follow-up not found');

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.followUp.update({ where: { id }, data: dto }),
      ),
    );
  }
}
