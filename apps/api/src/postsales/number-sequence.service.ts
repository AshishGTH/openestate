import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { financialYearLabel } from '@openestate/shared';

/**
 * Gap-free document-number allocator.
 *
 * `allocate` MUST be called inside the same tenant transaction as the row it
 * numbers (e.g. the receipt insert). It read-and-increments the per-(company,
 * kind, scope) counter with a single atomic upsert that takes a row lock, so
 * concurrent allocations serialize and never collide — and because the
 * increment shares the caller's transaction, a rolled-back caller RELEASES its
 * number, keeping committed numbers strictly contiguous.
 *
 * IMPORTANT: the transaction that allocates a number must not perform external
 * I/O (email, SMS, PDF render, object-storage upload) before it commits — the
 * same rule as `withTenantTx`. Holding the sequence row lock across a network
 * round-trip serialises every other allocation for that company/FY behind it.
 * Do all external I/O after the transaction returns.
 */
@Injectable()
export class NumberSequenceService {
  /** Allocate the next integer for (companyId, kind, scopeLabel). */
  async allocate(
    tx: Prisma.TransactionClient,
    companyId: string,
    kind: string,
    scopeLabel: string,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ allocated: number }[]>`
      INSERT INTO number_sequences (id, company_id, kind, scope_label, next_value, created_at, updated_at)
      VALUES (gen_random_uuid(), ${companyId}::uuid, ${kind}, ${scopeLabel}, 2, now(), now())
      ON CONFLICT (company_id, kind, scope_label)
      DO UPDATE SET next_value = number_sequences.next_value + 1, updated_at = now()
      RETURNING (next_value - 1) AS allocated
    `;
    return Number(rows[0].allocated);
  }

  /** Allocate a number scoped to the financial year of `date`. */
  async allocateForFy(
    tx: Prisma.TransactionClient,
    companyId: string,
    kind: string,
    date: Date,
    fyStartMonth = 4,
  ): Promise<{ seq: number; fyLabel: string }> {
    const fyLabel = financialYearLabel(date, fyStartMonth);
    const seq = await this.allocate(tx, companyId, kind, fyLabel);
    return { seq, fyLabel };
  }
}
