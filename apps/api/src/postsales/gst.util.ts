import { gstComponents, type GstComponents } from '@openestate/shared';

/** GST rate percent (e.g. 5, 12, 18) → basis points (500, 1200, 1800). */
export function percentToBasisPoints(ratePercent: number): number {
  return Math.round(ratePercent * 100);
}

export interface CostLineGst extends GstComponents {
  rateBasisPoints: number;
  taxTotalPaise: bigint;
  lineTotalPaise: bigint;
}

/**
 * Compute a cost line's GST split and line total.
 *
 * CGST and SGST are equal by construction; IGST is the full rate. Because the
 * halves are rounded independently of the full amount, (CGST + SGST) can differ
 * from IGST by at most 1 paise per line on odd bases — intrinsic to the
 * halves-equal rule (see CLAUDE.md Phase 4 decisions).
 */
export function computeCostLineGst(
  basePaise: bigint,
  ratePercent: number,
  intraState: boolean,
): CostLineGst {
  const rateBasisPoints = percentToBasisPoints(ratePercent);
  const c = gstComponents(basePaise, rateBasisPoints, intraState);
  const taxTotalPaise = c.cgstPaise + c.sgstPaise + c.igstPaise;
  return {
    ...c,
    rateBasisPoints,
    taxTotalPaise,
    lineTotalPaise: basePaise + taxTotalPaise,
  };
}
