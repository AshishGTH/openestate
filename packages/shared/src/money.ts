/**
 * Money utilities. All monetary values are integer paise stored as BigInt.
 * Every operation here is BigInt-exact — never route money through the JS
 * `number` type, which loses precision above 2^53 paise (~₹90,07,19,92,55).
 *
 * Rates are expressed in BASIS POINTS (1 bp = 0.01%) as integers, so
 * percentages never touch floating point either. E.g. 18% = 1800 bp,
 * 2.5% = 250 bp, 1% = 100 bp.
 */

const PAISE_PER_RUPEE = 100n;

// ── Conversions & formatting ────────────────────────────────

export function rupeesToPaise(rupees: number): bigint {
  return BigInt(Math.round(rupees * 100));
}

export function paiseToRupees(paise: bigint): number {
  return Number(paise) / 100;
}

export function formatInr(paise: bigint): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const rupees = abs / PAISE_PER_RUPEE;
  const remainder = abs % PAISE_PER_RUPEE;

  const rupeePart = formatWithLakhCrore(rupees);
  const paisePart = remainder.toString().padStart(2, '0');

  return `${negative ? '-' : ''}₹${rupeePart}.${paisePart}`;
}

function formatWithLakhCrore(n: bigint): string {
  const s = n.toString();
  if (s.length <= 3) return s;

  const last3 = s.slice(-3);
  let rest = s.slice(0, -3);
  const groups: string[] = [last3];

  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) {
    groups.unshift(rest);
  }

  return groups.join(',');
}

// ── Arithmetic ──────────────────────────────────────────────

export function addPaise(a: bigint, b: bigint): bigint {
  return a + b;
}

export function subtractPaise(a: bigint, b: bigint): bigint {
  return a - b;
}

/** Multiply paise by an INTEGER factor. Exact. */
export function multiplyPaise(paise: bigint, factor: bigint): bigint {
  return paise * factor;
}

/**
 * Round half-up division of two BigInts (non-negative or negative safe).
 * `roundedDiv(7n, 2n)` = 4n, `roundedDiv(-7n, 2n)` = -4n (round half away
 * from zero, matching how currency amounts are conventionally rounded).
 */
export function roundedDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator < 0n) {
    return roundedDiv(-numerator, -denominator);
  }
  if (numerator >= 0n) {
    return (numerator + denominator / 2n) / denominator;
  }
  return -((-numerator + denominator / 2n) / denominator);
}

/**
 * `paise × (bp / 10000)`, rounded half-up, entirely in BigInt.
 * Example: percentOf(1_000_000n, 1800) = 180_000n (18% of ₹10,000).
 */
export function percentOf(paise: bigint, basisPoints: number): bigint {
  return roundedDiv(paise * BigInt(basisPoints), 10_000n);
}

/**
 * Distribute `total` paise across buckets weighted by `weights`, with NO
 * last-cent loss: the returned shares always sum to exactly `total`.
 *
 * Uses the largest-remainder method — floor every share, then hand out the
 * leftover paise one at a time to the buckets with the largest fractional
 * remainders (ties broken by index, lowest first, for determinism).
 *
 * Requires total >= 0 and at least one strictly-positive weight.
 */
export function allocate(total: bigint, weights: bigint[]): bigint[] {
  if (weights.length === 0) {
    throw new Error('allocate: weights must be non-empty');
  }
  if (total < 0n) {
    // Allocate the magnitude and flip signs — preserves exact sum for
    // negative totals (e.g. distributing a credit).
    return allocate(-total, weights).map((s) => -s);
  }

  const weightSum = weights.reduce((a, b) => a + b, 0n);
  if (weightSum <= 0n) {
    throw new Error('allocate: sum of weights must be positive');
  }

  const shares: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let allocated = 0n;

  for (let i = 0; i < weights.length; i++) {
    const numerator = total * weights[i];
    const floorShare = numerator / weightSum;
    const remainder = numerator % weightSum;
    shares.push(floorShare);
    remainders.push({ index: i, remainder });
    allocated += floorShare;
  }

  let leftover = total - allocated;
  // Largest remainder first; stable tie-break by original index.
  remainders.sort((a, b) => {
    if (b.remainder > a.remainder) return 1;
    if (b.remainder < a.remainder) return -1;
    return a.index - b.index;
  });

  for (let i = 0; i < remainders.length && leftover > 0n; i++) {
    shares[remainders[i].index] += 1n;
    leftover -= 1n;
  }

  return shares;
}

// ── GST components ──────────────────────────────────────────

export interface GstComponents {
  /** Central GST — populated for intra-state supply. */
  cgstPaise: bigint;
  /** State/UT GST — equals cgstPaise by construction for intra-state. */
  sgstPaise: bigint;
  /** Integrated GST — populated for inter-state supply. */
  igstPaise: bigint;
}

/**
 * Compute all three GST components for a taxable base at a given rate.
 *
 * CGST and SGST are each half the rate and are EQUAL BY CONSTRUCTION
 * (same formula), so an intra-state invoice never shows a lopsided split.
 * IGST is the full rate computed independently.
 *
 * Because CGST=SGST=round(base·rate/2) while IGST=round(base·rate), the
 * identity (CGST + SGST) === IGST can be off by at most 1 paise per line
 * on bases where base·rate/2 lands on a half-paise. This is intrinsic to
 * the halves-equal rule and is asserted (≤1 paise) by the GST test matrix.
 * See CLAUDE.md Phase 4 decisions.
 *
 * `intraState` selects which pair is non-zero on the returned object; both
 * the intra pair and the inter value are always computed so callers/tests
 * can compare them.
 */
export function gstComponents(
  basePaise: bigint,
  rateBasisPoints: number,
  intraState: boolean,
): GstComponents {
  const half = percentOf(basePaise, rateBasisPoints / 2);
  const full = percentOf(basePaise, rateBasisPoints);

  if (intraState) {
    return { cgstPaise: half, sgstPaise: half, igstPaise: 0n };
  }
  return { cgstPaise: 0n, sgstPaise: 0n, igstPaise: full };
}

/** Total tax across whichever components are populated. */
export function gstTotal(c: GstComponents): bigint {
  return c.cgstPaise + c.sgstPaise + c.igstPaise;
}
