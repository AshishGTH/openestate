import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import {
  normalizePhone,
  normalizeEmail,
  isFollowUpOverdue,
  type Clock,
} from '@openestate/shared';
import type {
  CreateInquiryDto,
  UpdateInquiryDto,
  PaginationQuery,
} from '@openestate/shared';
import { CLOCK } from '../common/clock.provider';
import { AssignmentService } from './assignment.service';

export interface InquiryScope {
  /** When set, results are restricted to inquiries assigned to this user (sales_executive). */
  scopeToUserId?: string;
}

@Injectable()
export class InquiryService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    @Inject(CLOCK)
    private readonly clock: Clock,
    private readonly assignmentService: AssignmentService,
  ) {}

  async findAll(companyId: string, query: PaginationQuery, scope: InquiryScope) {
    const { page, limit, sortBy, sortOrder } = query;
    const skip = (page - 1) * limit;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { companyId };
    if (scope.scopeToUserId) where.assignedToId = scope.scopeToUserId;

    const [data, total] = await Promise.all([
      this.systemPrisma.inquiry.findMany({
        where,
        skip,
        take: limit,
        orderBy: sortBy ? { [sortBy]: sortOrder } : { createdAt: 'desc' },
        include: { applicant: true, project: true, temperature: true, assignedTo: true },
      }),
      this.systemPrisma.inquiry.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(companyId: string, id: string, scope: InquiryScope) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { id, companyId };
    if (scope.scopeToUserId) where.assignedToId = scope.scopeToUserId;

    const item = await this.systemPrisma.inquiry.findFirst({
      where,
      include: {
        applicant: true,
        project: true,
        source: true,
        inquiryType: true,
        preferredUnitType: true,
        temperature: true,
        assignedTo: true,
        followUps: { orderBy: { createdAt: 'desc' } },
        assignments: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!item) throw new NotFoundException('Inquiry not found');
    return item;
  }

  /** Assigned to me, still open, and today's-or-overdue next follow-up. */
  async myDay(companyId: string, userId: string) {
    const now = this.clock.now();
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);

    return this.systemPrisma.inquiry.findMany({
      where: {
        companyId,
        assignedToId: userId,
        status: { in: ['OPEN', 'CONTINUED'] },
        nextFollowupAt: { lte: endOfToday },
      },
      include: { applicant: true, project: true, temperature: true },
      orderBy: { nextFollowupAt: 'asc' },
    });
  }

  async create(companyId: string, dto: CreateInquiryDto) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        let applicantId = dto.applicantId;
        let possibleDuplicateApplicantIds: string[] = [];

        if (!applicantId && dto.applicant) {
          const primaryPhoneNormalized = normalizePhone(dto.applicant.primaryPhone);
          const emailNormalized = dto.applicant.email
            ? normalizeEmail(dto.applicant.email)
            : null;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const or: any[] = [{ primaryPhoneNormalized }];
          if (emailNormalized) or.push({ emailNormalized });
          const duplicates = await tx.applicant.findMany({
            where: { companyId, mergedIntoId: null, OR: or },
          });
          possibleDuplicateApplicantIds = duplicates.map((d: { id: string }) => d.id);

          const created = await tx.applicant.create({
            data: {
              companyId,
              name: dto.applicant.name,
              primaryPhone: dto.applicant.primaryPhone.trim(),
              primaryPhoneNormalized,
              alternatePhones: dto.applicant.alternatePhones ?? [],
              email: dto.applicant.email,
              emailNormalized,
              addressLine1: dto.applicant.addressLine1,
              city: dto.applicant.city,
              state: dto.applicant.state,
              pincode: dto.applicant.pincode,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              customFields: dto.applicant.customFields as any,
            },
          });
          applicantId = created.id;
        } else if (applicantId) {
          const existing = await tx.applicant.findFirst({
            where: { id: applicantId, companyId },
          });
          if (!existing) throw new NotFoundException('Applicant not found');
          if (existing.mergedIntoId) {
            throw new ConflictException(
              `Applicant has been merged into ${existing.mergedIntoId}`,
            );
          }
        }

        const inquiry = await tx.inquiry.create({
          data: {
            companyId,
            applicantId: applicantId as string,
            projectId: dto.projectId,
            sourceId: dto.sourceId,
            inquiryTypeId: dto.inquiryTypeId,
            budgetMinPaise: dto.budgetMinPaise,
            budgetMaxPaise: dto.budgetMaxPaise,
            preferredUnitTypeId: dto.preferredUnitTypeId,
            temperatureId: dto.temperatureId,
            nextFollowupAt: dto.nextFollowupAt,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            customFields: dto.customFields as any,
          },
        });

        let assignedToId: string | null = null;
        if (dto.projectId) {
          assignedToId = await this.assignmentService.autoAssign(
            tx,
            companyId,
            dto.projectId,
          );
          if (assignedToId) {
            await tx.inquiry.update({
              where: { id: inquiry.id },
              data: { assignedToId },
            });
            await tx.inquiryAssignment.create({
              data: {
                companyId,
                inquiryId: inquiry.id,
                toUserId: assignedToId,
                assignmentType: 'auto',
                actorId: null,
              },
            });
          }
        }

        return { ...inquiry, assignedToId, possibleDuplicateApplicantIds };
      }),
    );
  }

  async update(companyId: string, id: string, dto: UpdateInquiryDto, scope: InquiryScope) {
    await this.findOne(companyId, id, scope);
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.inquiry.update({ where: { id }, data: dto as any }),
      ),
    );
  }

  async assign(
    companyId: string,
    inquiryId: string,
    toUserId: string,
    actorId: string,
    reason: string | undefined,
  ) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const inquiry = await tx.inquiry.findFirst({
          where: { id: inquiryId, companyId },
        });
        if (!inquiry) throw new NotFoundException('Inquiry not found');

        const fromUserId = inquiry.assignedToId;
        await tx.inquiry.update({
          where: { id: inquiryId },
          data: { assignedToId: toUserId },
        });

        return tx.inquiryAssignment.create({
          data: {
            companyId,
            inquiryId,
            fromUserId,
            toUserId,
            assignmentType: 'manual',
            actorId,
            reason,
          },
        });
      }),
    );
  }

  isOverdue(nextFollowupAt: Date | null): boolean {
    return isFollowUpOverdue(nextFollowupAt, this.clock.now());
  }
}
