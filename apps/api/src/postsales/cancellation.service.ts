import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { withTenantTx, runWithTenant } from '@openestate/db';
import {
  BOOKING_STATUS,
  CANCELLATION_TYPE,
  LEDGER_ENTRY_TYPE,
  percentOf,
  type CancellationDto,
  type BookingCancelledEvent,
} from '@openestate/shared';
import { TENANT_PRISMA } from '../database/database.module';
import { UnitStateMachineService } from '../inventory/unit-state-machine.service';
import { LedgerService } from './ledger.service';

const CANCELLABLE_FROM = new Set<string>([BOOKING_STATUS.BOOKED, BOOKING_STATUS.ALLOTTED, BOOKING_STATUS.REGISTERED]);

@Injectable()
export class CancellationService {
  private readonly logger = new Logger(CancellationService.name);

  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    private readonly stateMachine: UnitStateMachineService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Cancel or surrender a booking. Computes deduction from the master rule,
   * posts CANCELLATION_DEDUCTION (retained by the company) + CANCELLATION_
   * SETTLEMENT so the booking balance becomes −refundable (company owes the
   * customer `refundable = netReceived − deduction`). Returns the typed
   * bookingCancelled event Phase 5's commission engine will consume.
   */
  async cancel(companyId: string, bookingId: string, dto: CancellationDto, actorId: string | null) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const booking = await tx.booking.findFirst({ where: { id: bookingId, companyId } });
        if (!booking) throw new NotFoundException('Booking not found');
        if (!CANCELLABLE_FROM.has(booking.status)) {
          throw new BadRequestException(`Booking is ${booking.status} and cannot be cancelled`);
        }

        // Cash actually collected: non-reversed receipts that are immediate
        // (NOT_APPLICABLE) or CLEARED, minus any TDS withheld (never our cash).
        const receipts = await tx.receipt.findMany({
          where: {
            companyId,
            bookingId,
            isReversed: false,
            clearanceStatus: { in: ['NOT_APPLICABLE', 'CLEARED'] },
          },
          include: { tdsDeductions: true },
        });
        let netReceived = 0n;
        for (const r of receipts) {
          const tds = r.tdsDeductions.reduce((s: bigint, d: { deductedPaise: bigint }) => s + d.deductedPaise, 0n);
          netReceived += r.grossAmountPaise - tds;
        }

        // Deduction from the master rule.
        let deductionType = 'NONE';
        let deduction = 0n;
        if (dto.cancellationRuleId) {
          const rule = await tx.cancellationRule.findFirst({ where: { id: dto.cancellationRuleId, companyId } });
          if (!rule) throw new NotFoundException('Cancellation rule not found');
          deductionType = rule.deductionType;
          deduction =
            rule.deductionType === 'FLAT'
              ? (rule.deductionAmountPaise ?? 0n)
              : percentOf(booking.agreedPricePaise, Math.round(Number(rule.deductionPercent ?? 0) * 100));
          if (rule.forfeitBookingAmount) {
            const firstInst = await tx.installment.findFirst({
              where: { companyId, bookingId, isActive: true },
              orderBy: { seq: 'asc' },
            });
            if (firstInst) deduction += firstInst.amountPaise;
          }
        }

        const refundable = netReceived - deduction > 0n ? netReceived - deduction : 0n;

        const currentBalance = await this.ledger.balanceInTx(tx, companyId, bookingId);
        // Post the deduction (company levy) and a settlement that drives the
        // booking balance to exactly −refundable.
        const settlement = -refundable - currentBalance - deduction;
        await this.ledger.post(tx, companyId, [
          {
            bookingId,
            entryType: LEDGER_ENTRY_TYPE.CANCELLATION_DEDUCTION,
            signedAmountPaise: deduction,
            reason: `Cancellation deduction (${deductionType})`,
            effectiveDate: new Date(),
            createdById: actorId,
          },
          {
            bookingId,
            entryType: LEDGER_ENTRY_TYPE.CANCELLATION_SETTLEMENT,
            signedAmountPaise: settlement,
            reason: 'Cancellation settlement',
            effectiveDate: new Date(),
            createdById: actorId,
          },
        ]);

        const cancelledAt = new Date();
        const newStatus =
          dto.cancellationType === CANCELLATION_TYPE.SURRENDER
            ? BOOKING_STATUS.SURRENDERED
            : BOOKING_STATUS.CANCELLED;
        await tx.booking.update({ where: { id: bookingId }, data: { status: newStatus, cancelledAt } });

        const cancellation = await tx.cancellation.create({
          data: {
            companyId,
            bookingId,
            cancellationType: dto.cancellationType,
            cancellationRuleId: dto.cancellationRuleId ?? null,
            deductionTypeSnapshot: deductionType,
            deductionPaise: deduction,
            refundablePaise: refundable,
            reason: dto.reason ?? null,
            createdById: actorId,
          },
        });

        // Return the unit to available (system): current → CANCELLED → AVAILABLE.
        const unit = await tx.unit.findFirst({ where: { id: booking.unitId, companyId } });
        if (unit && unit.status !== 'AVAILABLE') {
          if (unit.status !== 'CANCELLED') {
            await this.stateMachine.transition(companyId, booking.unitId, 'CANCELLED', 'system', actorId, `Cancellation ${booking.bookingNumber}`);
          }
          await this.stateMachine.transition(companyId, booking.unitId, 'AVAILABLE', 'system', actorId, `Cancellation ${booking.bookingNumber}`);
        }

        // Phase 5 hand-off: typed event for the commission-clawback engine.
        const event: BookingCancelledEvent = {
          type: 'bookingCancelled',
          companyId,
          bookingId,
          cancellationType: dto.cancellationType,
          cancelledAt: cancelledAt.toISOString(),
          brokerId: null,
        };
        this.logger.log(`bookingCancelled event: ${JSON.stringify(event)}`);

        return {
          cancellation,
          refundablePaise: refundable.toString(),
          deductionPaise: deduction.toString(),
          netReceivedPaise: netReceived.toString(),
          event,
        };
      }),
    );
  }
}
