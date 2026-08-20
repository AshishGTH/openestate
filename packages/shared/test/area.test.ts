import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  AREA_UNITS,
  AREA_SCALE,
  computeBaseAmountPaise,
  convertToSqftScaled,
  fromAreaScaled,
  toAreaScaled,
  type AreaUnit,
} from '../src/area';

/**
 * These are the exactness tests the reviewer named in plan revision 3.
 * The header comments say what each guards; the assertions read as the
 * arithmetic did in the plan document.
 */

describe('AreaUnit — round-trip and exactness', () => {
  it('perAcreRoundsTripsExactly — the load-bearing regression test', () => {
    // A 0.372-acre plot at ₹5,00,000/acre. The exact answer is
    // ₹1,86,000.00 = 18_600_000 paise. A reintroduced sqft
    // intermediate makes the result 18,586,355 paise, which fails this
    // assertion — no hardcoded gap constant is needed.
    const ratePaise = 50_000_000n; // ₹5,00,000 per acre in paise
    const landAreaEnteredScaled = toAreaScaled('0.372');
    const result = computeBaseAmountPaise({
      ratePaise,
      rateUnit: 'ACRE',
      landAreaEnteredScaled,
      landAreaEnteredUnit: 'ACRE',
    });
    expect(result).toBe(18_600_000n);

    // Invert: recovered rate should equal the stored rate exactly.
    // recoveredPaisePerAcre = result / landAreaEntered
    //                       = result / (scaled / AREA_SCALE)
    //                       = result * AREA_SCALE / scaled
    const recoveredRatePaise = (result * AREA_SCALE) / landAreaEnteredScaled;
    expect(recoveredRatePaise).toBe(ratePaise);
  });

  it('perAcreMatchesQuote — whole-integer acre counts multiply exactly', () => {
    const ratePaise = 50_000_000n; // ₹5,00,000 per acre
    for (const acres of [1n, 5n, 10n, 200n]) {
      const result = computeBaseAmountPaise({
        ratePaise,
        rateUnit: 'ACRE',
        landAreaEnteredScaled: acres * AREA_SCALE,
        landAreaEnteredUnit: 'ACRE',
      });
      expect(result).toBe(ratePaise * acres);
    }
  });

  it('perSqmExactWhenMatched — sqm avoids the irrational factor entirely when matched', () => {
    // Revision 2's design routed area through a sqft canonical, which
    // rounded here. Design (a) does not: matched units cancel the sqft
    // factor entirely.
    const result = computeBaseAmountPaise({
      ratePaise: 300_000n, // ₹3,000/sqm
      rateUnit: 'SQM',
      landAreaEnteredScaled: toAreaScaled('500'),
      landAreaEnteredUnit: 'SQM',
    });
    expect(result).toBe(150_000_000n);
  });

  it('crossUnitIntegerFactorsExact — sqyd → acre stays exact', () => {
    // 4840 sqyd is exactly 1 acre; the 9/43560 ratio must resolve
    // without rounding.
    const result = computeBaseAmountPaise({
      ratePaise: 50_000_000n,
      rateUnit: 'ACRE',
      landAreaEnteredScaled: toAreaScaled('4840'),
      landAreaEnteredUnit: 'SQYD',
    });
    expect(result).toBe(50_000_000n);
  });

  it('crossUnitGuntaAcreExact — 40 gunta = 1 acre', () => {
    // Gunta is 1/40 of an acre in most of India (1089 sqft, and
    // 40 × 1089 = 43,560 sqft = 1 acre).
    const result = computeBaseAmountPaise({
      ratePaise: 100_000_000n, // ₹10L/acre
      rateUnit: 'ACRE',
      landAreaEnteredScaled: toAreaScaled('40'),
      landAreaEnteredUnit: 'GUNTA',
    });
    expect(result).toBe(100_000_000n);
  });

  it('halfUpRounding — half a paise rounds up, not down', () => {
    // Contrive a case where the true result is X.5 paise.
    // Say ratePaise=1, enteredUnit=SQFT, rateUnit=SQFT,
    // landAreaEntered = 0.0000005 → scaled = 0.5, rounds to 1.
    // Simpler: 1 paise per sqft × 0.5 sqft = 0.5 paise → 1 paise.
    const result = computeBaseAmountPaise({
      ratePaise: 1n,
      rateUnit: 'SQFT',
      landAreaEnteredScaled: toAreaScaled('0.5'),
      landAreaEnteredUnit: 'SQFT',
    });
    expect(result).toBe(1n);
  });
});

describe('AreaUnit — enter/format round-trip (the property test)', () => {
  it('matchedUnitPricing is always ratePaise × landAreaEntered exactly (half-up on the paise fraction)', () => {
    // The core exactness property: when rateUnit === enteredUnit, the
    // sqft factor cancels and the pipeline reduces to
    // round(ratePaise × landAreaEntered). This is what makes SQM safe
    // in the common case and what unblocks per-acre pricing.
    fc.assert(
      fc.property(
        fc.constantFrom(...AREA_UNITS),
        fc.bigInt({ min: 1n, max: 1_000_000_000_000n }), // 1 paise .. ₹100 crore
        fc.bigInt({ min: 1n, max: 1_000_000_000_000n }), // entered scaled, up to 10^12
        (unit, ratePaise, enteredScaled) => {
          const result = computeBaseAmountPaise({
            ratePaise,
            rateUnit: unit,
            landAreaEnteredScaled: enteredScaled,
            landAreaEnteredUnit: unit,
          });
          // Expected = round-half-up( ratePaise × enteredScaled / AREA_SCALE ).
          const numerator = ratePaise * enteredScaled;
          const quotient = numerator / AREA_SCALE;
          const remainder = numerator % AREA_SCALE;
          const expected = remainder * 2n >= AREA_SCALE ? quotient + 1n : quotient;
          expect(result).toBe(expected);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('toAreaScaled → fromAreaScaled round-trips a fixed-6-digit decimal exactly', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999_999_999_999 }),
        (scaledValue) => {
          const entered = BigInt(scaledValue);
          const decimalStr = fromAreaScaled(entered);
          const reScaled = toAreaScaled(decimalStr);
          expect(reScaled).toBe(entered);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('AreaUnit — canonical sqft (derived column) invariant', () => {
  it('convertToSqftScaled matches the integer factor exactly', () => {
    // These are the numbers the migration invariant checks:
    //   landAreaSqft === convertToSqft(landAreaEntered, landAreaEnteredUnit)
    // for the five supported units.
    const cases: Array<{ entered: string; unit: AreaUnit; expectedSqft: string }> = [
      { entered: '1', unit: 'ACRE', expectedSqft: '43560' },
      { entered: '0.5', unit: 'ACRE', expectedSqft: '21780' },
      { entered: '0.372', unit: 'ACRE', expectedSqft: '16204.32' },
      { entered: '40', unit: 'GUNTA', expectedSqft: '43560' },
      { entered: '4840', unit: 'SQYD', expectedSqft: '43560' },
      { entered: '1000', unit: 'SQFT', expectedSqft: '1000' },
    ];
    for (const c of cases) {
      const enteredScaled = toAreaScaled(c.entered);
      const sqftScaled = convertToSqftScaled(enteredScaled, c.unit);
      const expected = toAreaScaled(c.expectedSqft);
      expect(sqftScaled).toBe(expected);
    }
  });

  it('SQM sqft conversion documented as rounding — 1 sqm = 10.7639104167 sqft', () => {
    // 1 sqm scaled = 1_000_000. Times SQFT_PER_UNIT_SCALED[SQM] = 107_639_104_167.
    // Divided by SQFT_SCALE = 10^10 with half-up:
    //   1_000_000 × 107_639_104_167 = 107_639_104_167_000_000
    //   ÷ 10^10 = 10_763_910.4167  → rounded to nearest sqft-in-scaled-units.
    //   scaled result: 10_763_910n (half-up: 4167 < 5000 → down).
    //   So sqft displayed as ~10.76391 (to 5 dp) for 1 sqm — accepted.
    const sqftScaled = convertToSqftScaled(toAreaScaled('1'), 'SQM');
    // Value is scaled by AREA_SCALE, so 1 sqm ≈ 10.763910 sqft →
    // scaled value should be ~10_763_910.
    expect(sqftScaled).toBeGreaterThan(10_763_909n);
    expect(sqftScaled).toBeLessThan(10_763_912n);
  });
});

describe('AreaUnit — enum is exhaustive', () => {
  it('every AreaUnit value has a sqft factor', () => {
    // Regression guard: adding a new AreaUnit without a factor would
    // make convertToSqftScaled return undefined-multiplied silently.
    for (const unit of AREA_UNITS) {
      const scaled = convertToSqftScaled(toAreaScaled('1'), unit);
      expect(scaled).toBeGreaterThan(0n);
    }
  });
});
