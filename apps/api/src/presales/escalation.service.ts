import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { isEscalationEligible, type Clock } from '@openestate/shared';
import { CLOCK } from '../common/clock.provider';
import { ESCALATION_QUEUE } from '../queues/queues.module';
import {
  COMMUNICATION_PROVIDER,
  type CommunicationProvider,
} from '../queues/communication-provider';

export interface EscalationResult {
  escalatedInquiryIds: string[];
  notifiedUserIds: string[];
}

@Injectable()
export class EscalationService {
  private readonly logger = new Logger(EscalationService.name);

  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    @Inject(CLOCK)
    private readonly clock: Clock,
    @Inject(COMMUNICATION_PROVIDER)
    private readonly provider: CommunicationProvider,
    @InjectQueue(ESCALATION_QUEUE)
    private readonly escalationQueue: Queue,
  ) {}

  /**
   * Enumerates active companies via the SYSTEM client (minimal id-only
   * projection — never touches inquiry rows) and dispatches one
   * per-company job per company. The system client is used ONLY here, for
   * enumeration; all inquiry-row access happens in `runForCompany`, scoped
   * by `runWithTenant` for that specific company.
   */
  async dispatchTick(): Promise<string[]> {
    const companies = await this.systemPrisma.company.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    for (const company of companies) {
      await this.escalationQueue.add('company-escalation', { companyId: company.id });
    }

    return companies.map((c: { id: string }) => c.id);
  }

  /**
   * Finds overdue, not-yet-(re-)escalated inquiries for ONE company via the
   * tenant-scoped client, marks them escalated, and notifies that
   * company's active sales_manager users. No cross-tenant query — every
   * read/write here happens inside `withTenantTx` for `companyId`, so RLS
   * (not just the Prisma tenant filter) restricts rows to this company
   * even if a query inside this method omitted an explicit company_id
   * clause.
   */
  async runForCompany(companyId: string): Promise<EscalationResult> {
    const now = this.clock.now();

    const { escalatedInquiryIds, managers } = await runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const candidates = await tx.inquiry.findMany({
          where: {
            companyId,
            status: { in: ['OPEN', 'CONTINUED'] },
            nextFollowupAt: { not: null, lt: now },
          },
          select: { id: true, nextFollowupAt: true, lastEscalatedAt: true },
        });

        const eligible = candidates.filter((c: { nextFollowupAt: Date | null; lastEscalatedAt: Date | null }) =>
          isEscalationEligible(c.nextFollowupAt, c.lastEscalatedAt, now),
        );

        if (eligible.length === 0) {
          return { escalatedInquiryIds: [] as string[], managers: [] as Array<{ id: string; email: string | null; name: string }> };
        }

        for (const inquiry of eligible) {
          await tx.inquiry.update({
            where: { id: inquiry.id },
            data: { lastEscalatedAt: now },
          });
        }

        // Company-wide manager notification — no project→manager mapping
        // exists yet. Revisit once one does (see CLAUDE.md Phase 3 decisions).
        const managerUsers = await tx.user.findMany({
          where: { companyId, isActive: true, role: { slug: 'sales_manager' } },
          select: { id: true, email: true, name: true },
        });

        return {
          escalatedInquiryIds: eligible.map((e: { id: string }) => e.id),
          managers: managerUsers,
        };
      }),
    );

    // Notification I/O happens outside the transaction. Staff accounts
    // always have email today (Phase 6 nullability targets portal-only
    // users), but the column is nullable at the type level, so skip
    // defensively rather than send to a null address.
    for (const manager of managers) {
      if (!manager.email) continue;
      try {
        await this.provider.send({
          channel: 'EMAIL',
          toAddress: manager.email,
          subject: 'Overdue follow-ups need attention',
          body: `${escalatedInquiryIds.length} inquiry follow-up(s) are overdue in your team's pipeline.`,
        });
      } catch (err) {
        this.logger.warn(`Escalation notification failed for ${manager.id}: ${String(err)}`);
      }
    }

    return {
      escalatedInquiryIds,
      notifiedUserIds: managers.map((m: { id: string }) => m.id),
    };
  }
}
