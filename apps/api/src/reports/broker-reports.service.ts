import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@openestate/db';
import { formatInr, COMMISSION_ENTRY_TYPE, COMMISSION_CLAWBACK_ENTRY_TYPES } from '@openestate/shared';
import { SYSTEM_PRISMA } from '../database/database.module';

interface CommissionTotals {
  accruedPaise: bigint;
  paidPaise: bigint;
  tdsPaise: bigint;
  clawedBackPaise: bigint;
  outstandingPaise: bigint;
}

/**
 * Broker reports, mirroring PostsalesReportsService's shape (generators for
 * CSV-streamable row sets, plain objects for single-shot summaries) —
 * SYSTEM_PRISMA (RLS-bypassing) with an explicit companyId filter on every
 * query, same as the Phase 4 postsales reports module. All figures are
 * derived from CommissionLedgerEntry sums, never a stored balance.
 */
@Injectable()
export class BrokerReportsService {
  constructor(
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  private async commissionTotalsByBroker(companyId: string): Promise<Map<string, CommissionTotals>> {
    const grouped = await this.systemPrisma.commissionLedgerEntry.groupBy({
      by: ['brokerId', 'entryType'],
      where: { companyId },
      _sum: { signedAmountPaise: true },
    });
    const totals = new Map<string, CommissionTotals>();
    for (const g of grouped as Array<{ brokerId: string; entryType: string; _sum: { signedAmountPaise: bigint | null } }>) {
      const cur = totals.get(g.brokerId) ?? {
        accruedPaise: 0n,
        paidPaise: 0n,
        tdsPaise: 0n,
        clawedBackPaise: 0n,
        outstandingPaise: 0n,
      };
      const sum = g._sum.signedAmountPaise ?? 0n;
      cur.outstandingPaise += sum;
      if (g.entryType === COMMISSION_ENTRY_TYPE.ACCRUAL) cur.accruedPaise += sum;
      else if (g.entryType === COMMISSION_ENTRY_TYPE.PAYMENT) cur.paidPaise += -sum;
      else if (g.entryType === COMMISSION_ENTRY_TYPE.TDS_WITHHELD) cur.tdsPaise += -sum;
      else if ((COMMISSION_CLAWBACK_ENTRY_TYPES as readonly string[]).includes(g.entryType)) cur.clawedBackPaise += -sum;
      totals.set(g.brokerId, cur);
    }
    return totals;
  }

  // ── Broker-wise sold units ──────────────────────────────────

  async *soldUnits(companyId: string, brokerId?: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { companyId, brokerId: { not: null } };
    if (brokerId) where.brokerId = brokerId;
    const bookings = await this.systemPrisma.booking.findMany({
      where,
      include: { primaryApplicant: true, unit: true },
      orderBy: { createdAt: 'asc' },
    });
    const brokerIds = [...new Set(bookings.map((b: { brokerId: string | null }) => b.brokerId).filter((id: string | null): id is string => id !== null))];
    const brokers = await this.systemPrisma.broker.findMany({ where: { companyId, id: { in: brokerIds } } });
    const brokerNames = new Map(brokers.map((b: { id: string; name: string }) => [b.id, b.name]));

    for (const b of bookings) {
      yield [
        brokerNames.get(b.brokerId as string) ?? b.brokerId,
        b.bookingNumber,
        b.primaryApplicant.name,
        b.unit.number,
        formatInr(b.agreedPricePaise),
        b.status,
      ];
    }
  }

  // ── Commission summary (one row per broker) ─────────────────

  async *commissionSummary(companyId: string) {
    const totals = await this.commissionTotalsByBroker(companyId);
    const brokers = await this.systemPrisma.broker.findMany({ where: { companyId, id: { in: [...totals.keys()] } } });
    for (const broker of brokers) {
      const t = totals.get(broker.id)!;
      yield [
        broker.name,
        formatInr(t.accruedPaise),
        formatInr(t.paidPaise),
        formatInr(t.tdsPaise),
        formatInr(t.clawedBackPaise),
        formatInr(t.outstandingPaise),
      ];
    }
  }

  // ── Dues (brokers with outstanding > 0) ─────────────────────

  async *dues(companyId: string) {
    const totals = await this.commissionTotalsByBroker(companyId);
    const dueBrokerIds = [...totals.entries()].filter(([, t]) => t.outstandingPaise > 0n).map(([id]) => id);
    if (dueBrokerIds.length === 0) return;
    const brokers = await this.systemPrisma.broker.findMany({ where: { companyId, id: { in: dueBrokerIds } } });
    for (const broker of brokers) {
      yield [broker.name, broker.phone, formatInr(totals.get(broker.id)!.outstandingPaise)];
    }
  }

  // ── Customer-wise detail for one broker ─────────────────────

  async *customerDetail(companyId: string, brokerId: string) {
    const broker = await this.systemPrisma.broker.findFirst({ where: { id: brokerId, companyId } });
    if (!broker) throw new NotFoundException('Broker not found');

    const bookings = await this.systemPrisma.booking.findMany({
      where: { companyId, brokerId },
      include: { primaryApplicant: true, unit: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const b of bookings) {
      const entries = await this.systemPrisma.commissionLedgerEntry.findMany({ where: { companyId, brokerId, bookingId: b.id } });
      let accrued = 0n;
      let paid = 0n;
      for (const e of entries as Array<{ entryType: string; signedAmountPaise: bigint }>) {
        if (e.entryType === COMMISSION_ENTRY_TYPE.ACCRUAL) accrued += e.signedAmountPaise;
        if (e.entryType === COMMISSION_ENTRY_TYPE.PAYMENT) paid += -e.signedAmountPaise;
      }
      const outstanding = entries.reduce((s: bigint, e: { signedAmountPaise: bigint }) => s + e.signedAmountPaise, 0n);
      yield [
        b.primaryApplicant.name,
        b.bookingNumber,
        b.unit.number,
        formatInr(b.agreedPricePaise),
        formatInr(accrued),
        formatInr(paid),
        formatInr(outstanding),
      ];
    }
  }

  // ── Summary sold-unit rollup (company-wide) ─────────────────

  async summary(companyId: string) {
    const [brokerCount, soldViaBroker, totals] = await Promise.all([
      this.systemPrisma.broker.count({ where: { companyId, isActive: true } }),
      this.systemPrisma.booking.count({ where: { companyId, brokerId: { not: null } } }),
      this.commissionTotalsByBroker(companyId),
    ]);
    let accrued = 0n;
    let paid = 0n;
    let outstanding = 0n;
    for (const t of totals.values()) {
      accrued += t.accruedPaise;
      paid += t.paidPaise;
      outstanding += t.outstandingPaise;
    }
    return {
      activeBrokers: brokerCount,
      unitsSoldViaBroker: soldViaBroker,
      totalCommissionAccruedFormatted: formatInr(accrued),
      totalCommissionPaidFormatted: formatInr(paid),
      totalCommissionOutstandingFormatted: formatInr(outstanding),
    };
  }
}
