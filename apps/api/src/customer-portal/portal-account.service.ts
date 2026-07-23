import { Inject, Injectable } from '@nestjs/common';
import { withTenantTx } from '@openestate/db';
import { TENANT_PRISMA } from '../database/database.module';
import { LedgerService } from '../postsales/ledger.service';

@Injectable()
export class PortalAccountService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    private readonly ledger: LedgerService,
  ) {}

  async getAccount(companyId: string, applicantId: string) {
    return withTenantTx(this.tenantPrisma, companyId, async (tx) => {
      const bookings = await tx.booking.findMany({
        where: {
          OR: [{ primaryApplicantId: applicantId }, { coApplicants: { some: { applicantId } } }],
        },
        orderBy: { createdAt: 'desc' },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return Promise.all((bookings as any[]).map(async (b) => {
        const [costLines, installments, receipts, balance] = await Promise.all([
          tx.bookingCostLine.findMany({ where: { bookingId: b.id }, orderBy: { sortOrder: 'asc' } }),
          tx.installment.findMany({ where: { bookingId: b.id, isActive: true }, orderBy: { seq: 'asc' } }),
          tx.receipt.findMany({
            where: { bookingId: b.id, isReversed: false },
            orderBy: { receiptDate: 'desc' },
          }),
          this.ledger.balanceInTx(tx, companyId, b.id),
        ]);

        const nextDue = installments
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((i: any) => i.status !== 'PAID')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .sort((a: any, b2: any) => a.dueDate.getTime() - b2.dueDate.getTime())[0];

        return {
          bookingId: b.id,
          bookingNumber: b.bookingNumber,
          agreedPricePaise: b.agreedPricePaise.toString(),
          balancePaise: balance.toString(),
          costLines,
          paymentSchedule: installments,
          paymentHistory: receipts,
          nextDue: nextDue
            ? {
                installmentId: nextDue.id,
                label: nextDue.label,
                dueDate: nextDue.dueDate,
                amountPaise: (nextDue.amountPaise - nextDue.allocatedPaise).toString(),
              }
            : null,
        };
      }));
    });
  }
}
