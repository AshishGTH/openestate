import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import {
  BOOKING_STATUS,
  LEDGER_ENTRY_TYPE,
  isIntraStateSupply,
  formatBookingNumber,
  type CreateBookingDto,
  type CostLineKindValue,
} from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { UnitStateMachineService } from '../inventory/unit-state-machine.service';
import { LedgerService } from './ledger.service';
import { NumberSequenceService } from './number-sequence.service';
import { computeCostLineGst } from './gst.util';

const BOOKABLE_FROM = new Set(['AVAILABLE', 'HELD']);

@Injectable()
export class BookingService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    private readonly stateMachine: UnitStateMachineService,
    private readonly ledger: LedgerService,
    private readonly numbers: NumberSequenceService,
  ) {}

  async createBooking(companyId: string, dto: CreateBookingDto, actorId: string | null) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const unit = await tx.unit.findFirst({
          where: { id: dto.unitId, companyId },
          include: { floor: { include: { tower: { include: { project: { include: { areaLocation: true } } } } } } },
        });
        if (!unit) throw new NotFoundException('Unit not found');
        if (!BOOKABLE_FROM.has(unit.status)) {
          throw new BadRequestException(
            `Unit ${unit.number} is ${unit.status}; only AVAILABLE or HELD units can be booked`,
          );
        }

        const applicant = await tx.applicant.findFirst({
          where: { id: dto.primaryApplicantId, companyId },
        });
        if (!applicant) throw new NotFoundException('Primary applicant not found');
        if (applicant.mergedIntoId) {
          throw new BadRequestException('Primary applicant has been merged into another applicant');
        }

        const config = await tx.companyConfig.findFirst({ where: { companyId } });
        const fyStartMonth = config?.fyStartMonth ?? 4;

        // Place of supply: explicit override, else the property's area-location
        // state code (IGST Act §12(3)(a) — location of the immovable property).
        const placeOfSupplyStateCode =
          dto.placeOfSupplyStateCode ??
          unit.floor.tower.project.areaLocation?.stateCode ??
          null;
        const intraState = isIntraStateSupply(config?.gstStateCode, placeOfSupplyStateCode);

        // Compute the cost breakup with GST snapshots.
        const costLines: Array<{
          kind: CostLineKindValue;
          chargeTypeId: string | null;
          label: string;
          baseAmountPaise: bigint;
          gstRateId: string | null;
          gstRatePercentSnapshot: number;
          cgstPaise: bigint;
          sgstPaise: bigint;
          igstPaise: bigint;
          lineTotalPaise: bigint;
          sortOrder: number;
        }> = [];

        for (let i = 0; i < dto.costLines.length; i++) {
          const line = dto.costLines[i];
          let ratePercent = 0;
          if (line.gstRateId) {
            const gr = await tx.gstRate.findFirst({ where: { id: line.gstRateId, companyId } });
            if (!gr) throw new NotFoundException(`GST rate ${line.gstRateId} not found`);
            ratePercent = Number(gr.rate);
          }
          const gst = computeCostLineGst(line.baseAmountPaise, ratePercent, intraState);
          costLines.push({
            kind: line.kind,
            chargeTypeId: line.chargeTypeId ?? null,
            label: line.label,
            baseAmountPaise: line.baseAmountPaise,
            gstRateId: line.gstRateId ?? null,
            gstRatePercentSnapshot: ratePercent,
            cgstPaise: gst.cgstPaise,
            sgstPaise: gst.sgstPaise,
            igstPaise: gst.igstPaise,
            lineTotalPaise: gst.lineTotalPaise,
            sortOrder: i,
          });
        }

        const agreedPricePaise = costLines.reduce((s, l) => s + l.lineTotalPaise, 0n);

        const { seq, fyLabel } = await this.numbers.allocateForFy(
          tx,
          companyId,
          'BOOKING',
          dto.bookingDate,
          fyStartMonth,
        );
        const bookingNumber = formatBookingNumber(fyLabel, seq);

        const booking = await tx.booking.create({
          data: {
            companyId,
            unitId: dto.unitId,
            primaryApplicantId: dto.primaryApplicantId,
            bookingNumber,
            status: BOOKING_STATUS.BOOKED,
            agreedPricePaise,
            placeOfSupplyStateCode,
            paymentPlanTemplateId: dto.paymentPlanTemplateId ?? null,
            bookingDate: dto.bookingDate,
            createdById: actorId,
          },
        });

        // Co-applicants.
        for (let i = 0; i < dto.coApplicantIds.length; i++) {
          await tx.bookingCoApplicant.create({
            data: {
              companyId,
              bookingId: booking.id,
              applicantId: dto.coApplicantIds[i],
              ordinal: i + 2,
            },
          });
        }

        // Cost-line snapshot rows.
        for (const l of costLines) {
          await tx.bookingCostLine.create({ data: { companyId, bookingId: booking.id, ...l } });
        }

        // Ledger: post the cost breakup as CHARGE debits. Σ == agreed price,
        // so the booking balance opens at the full consideration owed.
        await this.ledger.post(
          tx,
          companyId,
          costLines.map((l) => ({
            bookingId: booking.id,
            entryType: LEDGER_ENTRY_TYPE.CHARGE,
            signedAmountPaise: l.lineTotalPaise,
            reason: l.label,
            effectiveDate: dto.bookingDate,
            createdById: actorId,
          })),
        );

        // Move the unit to BOOKED via the state machine (system actor). Reuses
        // this transaction (same company), so it's atomic with the booking.
        await this.stateMachine.transition(
          companyId,
          dto.unitId,
          'BOOKED',
          'system',
          actorId,
          `Booking ${bookingNumber}`,
        );

        return booking;
      }),
    );
  }

  async allot(companyId: string, bookingId: string, allotmentDate: Date, actorId: string | null) {
    return this.advance(companyId, bookingId, 'ALLOTTED', allotmentDate, actorId);
  }

  async register(companyId: string, bookingId: string, registrationDate: Date, actorId: string | null) {
    return this.advance(companyId, bookingId, 'REGISTERED', registrationDate, actorId);
  }

  private async advance(
    companyId: string,
    bookingId: string,
    to: 'ALLOTTED' | 'REGISTERED',
    date: Date,
    actorId: string | null,
  ) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const booking = await tx.booking.findFirst({ where: { id: bookingId, companyId } });
        if (!booking) throw new NotFoundException('Booking not found');

        const expectedFrom = to === 'ALLOTTED' ? BOOKING_STATUS.BOOKED : BOOKING_STATUS.ALLOTTED;
        if (booking.status !== expectedFrom) {
          throw new BadRequestException(
            `Booking is ${booking.status}; expected ${expectedFrom} before ${to}`,
          );
        }

        await tx.booking.update({
          where: { id: bookingId },
          data: {
            status: to,
            ...(to === 'ALLOTTED' ? { allotmentDate: date } : { registrationDate: date }),
          },
        });

        await this.stateMachine.transition(companyId, booking.unitId, to, 'system', actorId, `Booking ${booking.bookingNumber}`);

        return { bookingId, status: to };
      }),
    );
  }

  async findOne(companyId: string, id: string) {
    const booking = await this.systemPrisma.booking.findFirst({
      where: { id, companyId },
      include: {
        unit: true,
        primaryApplicant: true,
        coApplicants: { include: { applicant: true } },
        costLines: { orderBy: { sortOrder: 'asc' } },
        paymentPlans: { where: { isActive: true }, include: { installments: { orderBy: { seq: 'asc' } } } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    const balancePaise = await this.ledger.balance(companyId, id);
    return { ...booking, balancePaise: balancePaise.toString() };
  }
}
