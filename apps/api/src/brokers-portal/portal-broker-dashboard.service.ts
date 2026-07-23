import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { withTenantTx } from '@openestate/db';
import { formatInr, COMMISSION_ENTRY_TYPE, COMMISSION_CLAWBACK_ENTRY_TYPES, NOC_STATUS } from '@openestate/shared';
import { TENANT_PRISMA } from '../database/database.module';

/**
 * Deliberately independent of BrokerReportsService (Phase 5), which is
 * SYSTEM_PRISMA-based (RLS-bypassing) and only two of its five methods take
 * a brokerId scoping parameter — reusing it as-is here would either leak
 * every broker's commission data (commissionSummary/dues/summary) or need
 * a wrapper that trusts the caller-supplied brokerId with no independent
 * enforcement. This service goes through TENANT_PRISMA/withTenantTx
 * instead, with brokerId passed explicitly into every where clause (same
 * "belt and suspenders" style as PortalPropertyService.getMyProperties'
 * applicantId filter) AND left to RLS/PORTAL_SCOPED_MODELS as backstop —
 * CommissionLedgerEntry and BrokerNoc are both direct-column
 * PORTAL_SCOPED_MODELS entries (Phase 6 commit 1), Booking relies on RLS's
 * broker branch alone (same as Booking everywhere else in the portal,
 * Phase 6 commit 2 decisions).
 */
@Injectable()
export class PortalBrokerDashboardService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
  ) {}

  async getDashboard(companyId: string, brokerId: string) {
    return withTenantTx(this.tenantPrisma, companyId, async (tx) => {
      const broker = await tx.broker.findFirst({ where: { id: brokerId } });
      if (!broker) throw new NotFoundException('Broker not found');

      const grouped = await tx.commissionLedgerEntry.groupBy({
        by: ['entryType'],
        where: { brokerId },
        _sum: { signedAmountPaise: true },
      });

      let accrued = 0n;
      let paid = 0n;
      let tds = 0n;
      let clawedBack = 0n;
      let outstanding = 0n;
      for (const g of grouped as Array<{ entryType: string; _sum: { signedAmountPaise: bigint | null } }>) {
        const sum = g._sum.signedAmountPaise ?? 0n;
        outstanding += sum;
        if (g.entryType === COMMISSION_ENTRY_TYPE.ACCRUAL) accrued += sum;
        else if (g.entryType === COMMISSION_ENTRY_TYPE.PAYMENT) paid += -sum;
        else if (g.entryType === COMMISSION_ENTRY_TYPE.TDS_WITHHELD) tds += -sum;
        else if ((COMMISSION_CLAWBACK_ENTRY_TYPES as readonly string[]).includes(g.entryType)) clawedBack += -sum;
      }

      const [soldUnitsCount, pendingNocCount] = await Promise.all([
        tx.booking.count({ where: { brokerId } }),
        tx.brokerNoc.count({ where: { brokerId, status: NOC_STATUS.REQUESTED } }),
      ]);

      return {
        brokerName: broker.name,
        commission: {
          accruedFormatted: formatInr(accrued),
          paidFormatted: formatInr(paid),
          tdsFormatted: formatInr(tds),
          clawedBackFormatted: formatInr(clawedBack),
          outstandingFormatted: formatInr(outstanding),
        },
        soldUnitsCount,
        pendingNocCount,
      };
    });
  }
}
