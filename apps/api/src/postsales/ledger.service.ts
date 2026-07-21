import { Injectable, Inject } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { withTenantTx, runWithTenant } from '@openestate/db';
import type { LedgerEntryTypeValue } from '@openestate/shared';
import { TENANT_PRISMA } from '../database/database.module';

export interface LedgerEntryInput {
  bookingId: string;
  entryType: LedgerEntryTypeValue;
  /** Positive = debit (customer owes); negative = credit (customer paid/credited). */
  signedAmountPaise: bigint;
  installmentId?: string | null;
  receiptId?: string | null;
  reversalOfEntryId?: string | null;
  reason?: string | null;
  effectiveDate: Date;
  createdById?: string | null;
}

/**
 * The append-only ledger. A booking's balance is DEFINED as the sum of its
 * signed ledger amounts — there is no stored balance to drift. Every financial
 * event appends rows here; corrections append negating rows referencing
 * `reversalOfEntryId`. The database also enforces append-only via triggers.
 */
@Injectable()
export class LedgerService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
  ) {}

  /** Append entries within an existing tenant transaction. Returns created ids. */
  async post(
    tx: Prisma.TransactionClient,
    companyId: string,
    entries: LedgerEntryInput[],
  ): Promise<{ id: string; entryType: string; signedAmountPaise: bigint }[]> {
    const created: { id: string; entryType: string; signedAmountPaise: bigint }[] = [];
    for (const e of entries) {
      const row = await tx.ledgerEntry.create({
        data: {
          companyId,
          bookingId: e.bookingId,
          entryType: e.entryType,
          signedAmountPaise: e.signedAmountPaise,
          installmentId: e.installmentId ?? null,
          receiptId: e.receiptId ?? null,
          reversalOfEntryId: e.reversalOfEntryId ?? null,
          reason: e.reason ?? null,
          effectiveDate: e.effectiveDate,
          createdById: e.createdById ?? null,
        },
        select: { id: true, entryType: true, signedAmountPaise: true },
      });
      created.push(row);
    }
    return created;
  }

  /** Booking balance = Σ signed amounts, computed inside an existing tx. */
  async balanceInTx(
    tx: Prisma.TransactionClient,
    companyId: string,
    bookingId: string,
  ): Promise<bigint> {
    const agg = await tx.ledgerEntry.aggregate({
      where: { companyId, bookingId },
      _sum: { signedAmountPaise: true },
    });
    return agg._sum.signedAmountPaise ?? 0n;
  }

  /** Booking balance from outside a transaction (opens its own tenant tx). */
  async balance(companyId: string, bookingId: string): Promise<bigint> {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        this.balanceInTx(tx, companyId, bookingId),
      ),
    );
  }

  /** Sum of signed amounts across a set of entry types (for reporting/tests). */
  async sumByTypesInTx(
    tx: Prisma.TransactionClient,
    companyId: string,
    bookingId: string,
    entryTypes: LedgerEntryTypeValue[],
  ): Promise<bigint> {
    const agg = await tx.ledgerEntry.aggregate({
      where: { companyId, bookingId, entryType: { in: entryTypes } },
      _sum: { signedAmountPaise: true },
    });
    return agg._sum.signedAmountPaise ?? 0n;
  }
}
