import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { ACTIVE_INQUIRY_STATUSES, type CreateFollowUpDto, type UpdateFollowUpDto, type SiteVisitListQuery, type SiteVisitState, type Clock } from '@openestate/shared';
import { CLOCK } from '../common/clock.provider';
import { InquiryService, type InquiryScope } from './inquiry.service';

@Injectable()
export class FollowUpService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    @Inject(CLOCK)
    private readonly clock: Clock,
    private readonly inquiryService: InquiryService,
  ) {}

  /**
   * Security fix: this class used to check only `companyId` — a
   * sales_executive could list/create/update follow-ups on ANY colleague's
   * inquiry by id, completely bypassing Inquiry's own scoping. Every
   * method now confirms the parent inquiry is in the caller's visible set
   * FIRST, via the same check `InquiryService.findOne` uses, before doing
   * anything else.
   */
  async findAllForInquiry(companyId: string, inquiryId: string, scope: InquiryScope) {
    await this.inquiryService.assertInScope(companyId, inquiryId, scope);
    return this.systemPrisma.followUp.findMany({
      where: { companyId, inquiryId },
      include: {
        type: true,
        // A bare `createdBy: true` returns every scalar column on User —
        // passwordHash/totpSecret/recoveryCodes included — over the wire.
        // Scoped to exactly what the follow-up log needs to display.
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Site visits the caller may see: follow-ups whose type is flagged
   * `isSiteVisit` (never matched by name) and which have a `scheduledAt`,
   * whose parent inquiry is in the caller's visible set. Same scope and
   * `assignedTo` semantics as the inquiry list, via InquiryService.scopedWhere.
   */
  async listSiteVisits(companyId: string, query: SiteVisitListQuery, scope: InquiryScope, actorId: string) {
    const now = this.clock.now();
    const inquiry = await this.inquiryService.scopedWhere(companyId, scope, actorId, query.assignedTo);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scheduledAt: any = { not: null };
    if (query.from) scheduledAt.gte = query.from;
    if (query.to) scheduledAt.lt = query.to;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { companyId, type: { isSiteVisit: true }, scheduledAt, inquiry: { is: inquiry } };
    if (query.state === 'outcome_recorded') where.outcome = { not: null };
    else if (query.state) {
      where.outcome = null;
      // `scheduledAt` already holds the from/to bounds: AND the state bound instead of overwriting them.
      where.AND = [{ scheduledAt: query.state === 'scheduled' ? { gte: now } : { lt: now } }];
    }
    const [rows, total] = await Promise.all([
      this.systemPrisma.followUp.findMany({
        where,
        orderBy: [{ scheduledAt: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true, inquiryId: true, scheduledAt: true, venue: true, notes: true, outcome: true, interactionAt: true,
          type: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true } },
          inquiry: {
            select: {
              id: true, status: true,
              applicant: { select: { id: true, name: true, primaryPhone: true } },
              project: { select: { id: true, name: true } },
              assignedTo: { select: { id: true, name: true } },
            },
          },
        },
      }),
      this.systemPrisma.followUp.count({ where }),
    ]);
    const data = rows.map((r) => ({ ...r, state: siteVisitState(r.outcome, r.scheduledAt as Date, now) }));
    return { data, meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
  }

  async create(
    companyId: string,
    inquiryId: string,
    dto: CreateFollowUpDto,
    createdById: string | null,
    scope: InquiryScope,
  ) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const inquiryWhere: any = { id: inquiryId, companyId };
        if (scope.visibleUserIds) inquiryWhere.assignedToId = { in: scope.visibleUserIds };
        const inquiry = await tx.inquiry.findFirst({ where: inquiryWhere });
        if (!inquiry) throw new NotFoundException('Inquiry not found');

        // SOP rule 2: "if the lead remains in Followups, a next
        // follow-up time should normally be required." A lead is still
        // in the active follow-up workflow whenever its status is
        // OPEN/CONTINUED — refuse rather than silently letting it go
        // idle with no scheduled next action.
        if ((ACTIVE_INQUIRY_STATUSES as readonly string[]).includes(inquiry.status) && !dto.nextActionAt) {
          throw new BadRequestException(
            'A next follow-up time is required while this lead is active. Set one, or change the lead\'s disposition first.',
          );
        }

        const followUp = await tx.followUp.create({
          data: {
            companyId,
            inquiryId,
            typeId: dto.typeId,
            notes: dto.notes,
            outcome: dto.outcome,
            interactionAt: dto.interactionAt ?? this.clock.now(),
            nextActionAt: dto.nextActionAt,
            scheduledAt: dto.scheduledAt,
            venue: dto.venue,
            createdById,
          },
        });

        // Advance the inquiry's own next-followup cursor when this
        // follow-up carries a next action date. Only OPEN flips to
        // CONTINUED here — a DUMPED/SUCCESSFUL inquiry's status is left
        // untouched (this ternary's `: inquiry.status` branch), a logged
        // interaction never reopens a closed lead. See docs/todo.md for
        // the open product question this raises.
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

  async update(companyId: string, id: string, dto: UpdateFollowUpDto, scope: InquiryScope) {
    const existing = await this.systemPrisma.followUp.findFirst({
      where: { id, companyId },
      select: { id: true, inquiryId: true },
    });
    if (!existing) throw new NotFoundException('Follow-up not found');
    await this.inquiryService.assertInScope(companyId, existing.inquiryId, scope);

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.followUp.update({ where: { id }, data: dto }),
      ),
    );
  }
}

export function siteVisitState(outcome: string | null, scheduledAt: Date, now: Date): SiteVisitState {
  if (outcome) return 'outcome_recorded';
  return scheduledAt.getTime() >= now.getTime() ? 'scheduled' : 'awaiting_outcome';
}
