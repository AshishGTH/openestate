import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@openestate/db';
import { COST_LINE_KIND, computeBaseAmountPaise, toAreaScaled, type AreaUnit, type BookingCostLineInput } from '@openestate/shared';
import { SYSTEM_PRISMA } from '../database/database.module';

// 1 paise: the same largest-remainder allocation slack already accepted
// elsewhere in this codebase's Money utility. See
// plotted-farmhouse-inventory.md §7.4.
const ALLOWED_SLACK_PAISE = 1n;

/**
 * Upstream of BookingService — precondition validation on the DTO, not
 * part of ledger production. Recomputes each BASE cost line's
 * baseAmountPaise from the Unit's own stored rate/area and rejects the
 * request if the client's submitted amount differs by more than 1 paise.
 * Defends against a LAND_BASED booking trusting client-side JS math on
 * Decimal areas and per-acre rates in the tens of millions of paise
 * (plotted-farmhouse-inventory.md §7.4).
 *
 * HIGH_RISE BASE lines are deliberately NOT verified. The plan's own
 * premise for this service assumed Unit.baseRatePaise was already
 * "paise/sqft x area" for HIGH_RISE — grepping the whole codebase found
 * no such multiplication anywhere; it is, and always has been, the
 * unit's listed price, which staff routinely negotiate a different
 * agreed price against in the booking wizard (a manually-editable
 * field, never a computed one). A strict verifier there would reject
 * legitimate negotiated pricing, not catch a bug. Confirmed with the
 * user before narrowing scope to LAND_BASED only.
 *
 * PLC/PARKING/CLUB/MAINTENANCE/OTHER lines are pass-through for BOTH
 * shapes, matching §7.4's own stated scope ("ad-hoc and not derivable
 * from the Unit"). This includes a farmhouse's built-up-structure line
 * (kind OTHER) — §7.5 floated recomputing it too, but that contradicts
 * §7.4's own explicit "OTHER: pass-through" and isn't the arithmetic
 * risk this service exists for (Decimal land areas / per-acre rates),
 * so it stays out of scope here.
 */
@Injectable()
export class BookingCostLineVerifier {
  constructor(
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  async verifyForCreate(companyId: string, unitId: string, costLines: BookingCostLineInput[]): Promise<void> {
    const unit = await this.systemPrisma.unit.findFirst({ where: { id: unitId, companyId } });
    if (!unit || unit.shape !== 'LAND_BASED') return;
    if (unit.landAreaEntered === null || unit.landAreaEnteredUnit === null) return;

    const landAreaEnteredScaled = toAreaScaled(unit.landAreaEntered.toString());
    for (const line of costLines) {
      if (line.kind !== COST_LINE_KIND.BASE) continue;
      const expected = computeBaseAmountPaise({
        ratePaise: unit.baseRatePaise,
        rateUnit: unit.rateUnit as AreaUnit,
        landAreaEnteredScaled,
        landAreaEnteredUnit: unit.landAreaEnteredUnit as AreaUnit,
      });
      const diff = expected > line.baseAmountPaise ? expected - line.baseAmountPaise : line.baseAmountPaise - expected;
      if (diff > ALLOWED_SLACK_PAISE) {
        throw new BadRequestException(
          `Cost line "${line.label}": submitted amount ${line.baseAmountPaise} paise does not match the unit's rate x area (expected ${expected} paise).`,
        );
      }
    }
  }
}
