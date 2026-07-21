import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { withTenantTx, runWithTenant } from '@openestate/db';
import { LEDGER_ENTRY_TYPE, isIntraStateSupply, type ExtraChargeDto } from '@openestate/shared';
import { TENANT_PRISMA } from '../database/database.module';
import { LedgerService } from './ledger.service';
import { computeCostLineGst } from './gst.util';

@Injectable()
export class ExtraChargeService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    private readonly ledger: LedgerService,
  ) {}

  async add(companyId: string, bookingId: string, dto: ExtraChargeDto, actorId: string | null) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const booking = await tx.booking.findFirst({ where: { id: bookingId, companyId } });
        if (!booking) throw new NotFoundException('Booking not found');
        const config = await tx.companyConfig.findFirst({ where: { companyId } });
        const intraState = isIntraStateSupply(config?.gstStateCode, booking.placeOfSupplyStateCode);

        // GST rate snapshotted at entry-time: explicit gstRateId wins; otherwise
        // the linked ChargeType's current effective GST rate (immutable after).
        let gstRateId = dto.gstRateId ?? null;
        if (!gstRateId && dto.chargeTypeId) {
          const ct = await tx.chargeType.findFirst({ where: { id: dto.chargeTypeId, companyId } });
          gstRateId = ct?.gstRateId ?? null;
        }
        let ratePercent = 0;
        if (gstRateId) {
          const gr = await tx.gstRate.findFirst({ where: { id: gstRateId, companyId } });
          if (!gr) throw new NotFoundException('GST rate not found');
          ratePercent = Number(gr.rate);
        }

        const gst = computeCostLineGst(dto.baseAmountPaise, ratePercent, intraState);
        const effectiveDate = dto.effectiveDate ?? new Date();

        const extra = await tx.extraCharge.create({
          data: {
            companyId,
            bookingId,
            chargeTypeId: dto.chargeTypeId ?? null,
            label: dto.label,
            baseAmountPaise: dto.baseAmountPaise,
            gstRateId,
            gstRatePercentSnapshot: ratePercent,
            cgstPaise: gst.cgstPaise,
            sgstPaise: gst.sgstPaise,
            igstPaise: gst.igstPaise,
            lineTotalPaise: gst.lineTotalPaise,
            createdById: actorId,
          },
        });

        await this.ledger.post(tx, companyId, [
          {
            bookingId,
            entryType: LEDGER_ENTRY_TYPE.EXTRA_CHARGE,
            signedAmountPaise: gst.lineTotalPaise,
            reason: dto.label,
            effectiveDate,
            createdById: actorId,
          },
        ]);

        return extra;
      }),
    );
  }
}
