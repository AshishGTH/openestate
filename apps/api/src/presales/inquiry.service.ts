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
import { ApplicantService } from './applicant.service';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';

export interface InquiryScope {
  /** When set, results are restricted to inquiries assigned to this user (sales_executive). */
  scopeToUserId?: string;
}

export interface LeadInput {
  name: string;
  phone: string;
  email?: string;
  projectId?: string;
  note?: string;
}

export interface LeadCreateResult {
  inquiryId: string;
  applicantId: string;
  duplicateApplicantIds: string[];
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
    private readonly applicantService: ApplicantService,
    private readonly customFields: CustomFieldsService,
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
        include: {
          applicant: { omit: { panCiphertext: true, panKeyVersion: true } },
          project: true,
          temperature: true,
          // Real leak, found while wiring follow-up attribution display:
          // a bare `assignedTo: true` returns every scalar column on
          // User, passwordHash/totpSecret/recoveryCodes included, over
          // the wire on every inquiry list response.
          assignedTo: { select: { id: true, name: true, email: true } },
        },
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
        applicant: { omit: { panCiphertext: true, panKeyVersion: true } },
        project: true,
        source: true,
        inquiryType: true,
        preferredUnitType: true,
        temperature: true,
        assignedTo: { select: { id: true, name: true, email: true } },
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
      include: { applicant: { omit: { panCiphertext: true, panKeyVersion: true } }, project: true, temperature: true },
      orderBy: { nextFollowupAt: 'asc' },
    });
  }

  /**
   * `createdById` is the interactively-authenticated caller (always set —
   * InquiryController.create() is behind JwtAuthGuard). Machine-driven
   * intake (createFromLead, bulk import) has no human creator and never
   * passes one, which is exactly the signal the creator-retains policy
   * below keys off.
   */
  async create(companyId: string, dto: CreateInquiryDto, createdById: string) {
    // Resolved BEFORE the transaction opens: validation reads the
    // definitions table, and there's no reason to hold a pooled
    // connection open across those reads.
    const inquiryCustomFields = await this.customFields.resolveValuesForWrite(
      companyId,
      'INQUIRY',
      dto.customFields,
    );
    const applicantCustomFields = dto.applicant
      ? await this.customFields.resolveValuesForWrite(
          companyId,
          'APPLICANT',
          dto.applicant.customFields,
        )
      : undefined;

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
              customFields: applicantCustomFields as any,
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
            createdById,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            customFields: inquiryCustomFields as any,
          },
        });

        // Creator-retains-lead policy (default on): a rep's own inquiry
        // must never silently move to someone else via round-robin.
        // Round-robin only ever runs for machine-driven intake — this
        // method always has a human createdById, so when the toggle is on
        // the creator simply keeps it, full stop, regardless of project
        // pool membership.
        const config = await tx.companyConfig.findFirst({ where: { companyId } });
        const creatorRetains = config?.presalesCreatorRetainsLead ?? true;

        let assignedToId: string | null = null;
        let assignmentType: 'creator' | 'auto' | null = null;
        if (creatorRetains) {
          assignedToId = createdById;
          assignmentType = 'creator';
        } else if (dto.projectId) {
          assignedToId = await this.assignmentService.autoAssign(
            tx,
            companyId,
            dto.projectId,
          );
          assignmentType = 'auto';
        }

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
              assignmentType: assignmentType as string,
              actorId: assignmentType === 'creator' ? createdById : null,
            },
          });
        }

        return { ...inquiry, assignedToId, possibleDuplicateApplicantIds };
      }),
    );
  }

  /**
   * Machine-driven lead intake (inbound lead API, §5) — auto-links to an
   * existing applicant on a phone/email match instead of prompting a
   * human (there isn't one), same "never silently skip a possible
   * duplicate" discipline as the bulk-import path (Phase 3 decisions),
   * NOT the interactive create()'s "always create new + surface
   * possibleDuplicateApplicantIds for a human to resolve" behavior —
   * those are deliberately different flows for deliberately different
   * callers. What IS shared with every other dedup call site (create(),
   * ApplicantService.create(), the plugin runtime's ctx.applicants) is
   * the underlying duplicate lookup: ApplicantService.findDuplicates().
   * Returns the shape @openestate/plugin-sdk's LeadCreateResult already
   * committed to in Phase 7 commit 1.
   */
  async createFromLead(companyId: string, lead: LeadInput): Promise<LeadCreateResult> {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const primaryPhoneNormalized = normalizePhone(lead.phone);
        const emailNormalized = lead.email ? normalizeEmail(lead.email) : null;

        const duplicates = await this.applicantService.findDuplicates(companyId, primaryPhoneNormalized, emailNormalized);
        const duplicateApplicantIds = duplicates.map((d: { id: string }) => d.id);

        let applicantId: string;
        if (duplicates.length > 0) {
          applicantId = duplicates[0].id;
        } else {
          const created = await tx.applicant.create({
            data: {
              companyId,
              name: lead.name,
              primaryPhone: lead.phone.trim(),
              primaryPhoneNormalized,
              email: lead.email,
              emailNormalized,
            },
          });
          applicantId = created.id;
        }

        const inquiry = await tx.inquiry.create({
          data: {
            companyId,
            applicantId,
            projectId: lead.projectId,
            customFields: lead.note ? { leadNote: lead.note } : undefined,
          },
        });

        if (lead.projectId) {
          const assignedToId = await this.assignmentService.autoAssign(tx, companyId, lead.projectId);
          if (assignedToId) {
            await tx.inquiry.update({ where: { id: inquiry.id }, data: { assignedToId } });
            await tx.inquiryAssignment.create({
              data: { companyId, inquiryId: inquiry.id, toUserId: assignedToId, assignmentType: 'auto', actorId: null },
            });
          }
        }

        return { inquiryId: inquiry.id, applicantId, duplicateApplicantIds };
      }),
    );
  }

  async update(companyId: string, id: string, dto: UpdateInquiryDto, scope: InquiryScope) {
    const existing = await this.findOne(companyId, id, scope);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = { ...dto };
    if (dto.customFields !== undefined) {
      data.customFields = await this.customFields.resolveValuesForWrite(
        companyId,
        'INQUIRY',
        dto.customFields,
        (existing as { customFields?: Record<string, unknown> | null }).customFields ?? null,
      );
    }
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.inquiry.update({ where: { id }, data }),
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
