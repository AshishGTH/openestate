import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  addPaise,
  subtractPaise,
  multiplyPaise,
  roundedDiv,
  percentOf,
  allocate,
  gstComponents,
  gstTotal,
  formatInr,
  rupeesToPaise,
} from '../src/money';

describe('basic arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(addPaise(100n, 250n)).toBe(350n);
    expect(subtractPaise(100n, 250n)).toBe(-150n);
  });

  it('multiplies by integer factor exactly, even beyond 2^53', () => {
    const huge = 90_07_19_92_55_00n; // ~₹9,007 crore in paise, > Number.MAX_SAFE_INTEGER
    expect(multiplyPaise(huge, 3n)).toBe(huge * 3n);
  });
});

describe('roundedDiv (half away from zero)', () => {
  it('rounds halves up in magnitude', () => {
    expect(roundedDiv(7n, 2n)).toBe(4n);
    expect(roundedDiv(5n, 2n)).toBe(3n);
    expect(roundedDiv(4n, 2n)).toBe(2n);
    expect(roundedDiv(-7n, 2n)).toBe(-4n);
    expect(roundedDiv(-5n, 2n)).toBe(-3n);
  });
});

describe('percentOf (basis points, BigInt-exact)', () => {
  it('computes common GST/interest rates', () => {
    expect(percentOf(10_00_000n, 1800)).toBe(1_80_000n); // 18% of ₹10,000
    expect(percentOf(10_00_000n, 100)).toBe(10_000n); // 1%
    expect(percentOf(10_00_000n, 500)).toBe(50_000n); // 5%
  });

  it('rounds half-up at the paise boundary', () => {
    // 1 paise × 50% = 0.5 paise → rounds to 1
    expect(percentOf(1n, 5000)).toBe(1n);
    // 1 paise × 49% = 0.49 → rounds to 0
    expect(percentOf(1n, 4900)).toBe(0n);
  });
});

describe('allocate (largest-remainder, no last-cent loss)', () => {
  it('splits an indivisible amount without losing a paise', () => {
    // ₹100.00 (10000 paise) across 3 equal weights -> 3334/3333/3333
    const shares = allocate(10000n, [1n, 1n, 1n]);
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(10000n);
    expect(shares.sort((a, b) => Number(b - a))).toEqual([3334n, 3333n, 3333n]);
  });

  it('respects weights', () => {
    const shares = allocate(1000n, [3n, 1n]);
    expect(shares).toEqual([750n, 250n]);
  });

  it('handles negative totals (credits) with exact sum', () => {
    const shares = allocate(-10000n, [1n, 1n, 1n]);
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(-10000n);
  });

  it('PROPERTY: allocate always sums to total for random totals & weights', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 9n }), { minLength: 1, maxLength: 30 }),
        (total, weights) => {
          const shares = allocate(total, weights);
          const sum = shares.reduce((a, b) => a + b, 0n);
          expect(sum).toBe(total);
          // No share is negative for a non-negative total.
          for (const s of shares) expect(s >= 0n).toBe(true);
          expect(shares.length).toBe(weights.length);
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe('gstComponents', () => {
  it('intra-state splits into equal CGST/SGST, zero IGST', () => {
    const c = gstComponents(10_00_000n, 1800, true);
    expect(c.cgstPaise).toBe(c.sgstPaise);
    expect(c.cgstPaise).toBe(90_000n);
    expect(c.igstPaise).toBe(0n);
    expect(gstTotal(c)).toBe(1_80_000n);
  });

  it('inter-state is full IGST, zero CGST/SGST', () => {
    const c = gstComponents(10_00_000n, 1800, false);
    expect(c.igstPaise).toBe(1_80_000n);
    expect(c.cgstPaise).toBe(0n);
    expect(c.sgstPaise).toBe(0n);
  });

  it('PROPERTY: |IGST - (CGST+SGST)| <= 1 paise across a base/rate matrix', () => {
    const rates = [100, 250, 500, 750, 1200, 1800, 2800]; // 1%,2.5%,5%,7.5%,12%,18%,28%
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 14n }), fc.constantFrom(...rates), (base, rate) => {
        const intra = gstComponents(base, rate, true);
        const inter = gstComponents(base, rate, false);
        const diff = inter.igstPaise - (intra.cgstPaise + intra.sgstPaise);
        const abs = diff < 0n ? -diff : diff;
        expect(abs <= 1n).toBe(true);
        expect(intra.cgstPaise).toBe(intra.sgstPaise); // halves always equal
      }),
      { numRuns: 2000 },
    );
  });
});

describe('formatInr (lakh/crore grouping)', () => {
  it('formats with Indian digit grouping', () => {
    expect(formatInr(rupeesToPaise(1210000))).toBe('₹12,10,000.00');
    expect(formatInr(1_23_45_678_90n)).toBe('₹1,23,45,678.90');
    expect(formatInr(-50000n)).toBe('-₹500.00');
  });
});
