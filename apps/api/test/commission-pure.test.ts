/**
 * Pure, DB-independent tests for the shared commission slab-matching /
 * milestone-validation utilities (packages/shared/src/commission.ts) —
 * always runs, never skipped, same rationale as postsales-pdf.test.ts:
 * this class of bug (a boundary-matching or validation-ordering mistake)
 * should be caught by the fast, always-run tier, not only by a slower
 * integration test that happens to exercise commission accrual.
 */
import { describe, it, expect } from 'vitest';
import {
  matchCommissionSlab,
  computeCommissionPaise,
  validateSlabContiguity,
  commissionMilestonesSchema,
  COMMISSION_TYPE,
  type CommissionSlabLike,
} from '@openestate/shared';

const L = (rupees: number) => BigInt(rupees) * 100n;

// Half-open [fromPaise, toPaise) fixture: ₹0–50L at 1.0%, ₹50L–1Cr at
// 1.5%, ₹1Cr+ at 2.0% — matches CLAUDE.md's Phase 5 worked example.
const SLABS: CommissionSlabLike[] = [
  { seq: 1, fromPaise: 0n, toPaise: L(50_00_000), ratePercent: 1.0 },
  { seq: 2, fromPaise: L(50_00_000), toPaise: L(1_00_00_000), ratePercent: 1.5 },
  { seq: 3, fromPaise: L(1_00_00_000), toPaise: null, ratePercent: 2.0 },
];

describe('Commission slab matching: half-open [from, to), boundary lands in the HIGHER bracket', () => {
  it.each([
    [L(1), 1],
    [L(49_99_999), 1],
    [L(50_00_000), 2], // exact boundary -> higher bracket
    [L(99_99_999), 2],
    [L(1_00_00_000), 3], // exact boundary -> higher bracket
    [L(5_00_00_000), 3],
  ])('basis %s paise matches slab seq=%i', (basisPaise, expectedSeq) => {
    const matched = matchCommissionSlab(basisPaise, SLABS);
    expect(matched.seq).toBe(expectedSeq);
  });

  it('computes commission at the matched slab rate on the WHOLE amount (matched, not marginal)', () => {
    // Exactly at the 50L boundary: matches slab 2 (1.5%), not slab 1.
    const rule = { commissionType: COMMISSION_TYPE.SLAB };
    expect(computeCommissionPaise(L(50_00_000), rule, SLABS)).toBe(L(75_000)); // 1.5% * 50,00,000 = 75,000

    // Exactly at the 1Cr boundary: matches slab 3 (2.0%).
    expect(computeCommissionPaise(L(1_00_00_000), rule, SLABS)).toBe(L(2_00_000)); // 2.0% * 1,00,00,000 = 2,00,000

    // Mid-bracket, slab 1.
    expect(computeCommissionPaise(L(10_00_000), rule, SLABS)).toBe(L(10_000)); // 1.0% * 10,00,000 = 10,000
  });

  it('flat percent and flat amount ignore slabs entirely', () => {
    expect(computeCommissionPaise(L(50_00_000), { commissionType: COMMISSION_TYPE.FLAT_PERCENT, flatPercent: 2 })).toBe(L(1_00_000));
    expect(computeCommissionPaise(L(50_00_000), { commissionType: COMMISSION_TYPE.FLAT_AMOUNT, flatPaise: L(25_000) })).toBe(L(25_000));
  });

  it('throws for a basis with no matching slab (e.g. slabs missing an unbounded top)', () => {
    const incomplete: CommissionSlabLike[] = [{ seq: 1, fromPaise: 0n, toPaise: L(10_00_000), ratePercent: 1 }];
    expect(() => matchCommissionSlab(L(20_00_000), incomplete)).toThrow(/No matching commission slab/);
  });
});

describe('validateSlabContiguity', () => {
  const valid = [
    { seq: 1, fromPaise: 0n, toPaise: L(50_00_000), ratePercent: 1 },
    { seq: 2, fromPaise: L(50_00_000), toPaise: undefined, ratePercent: 1.5 },
  ];

  it('accepts contiguous, gapless slabs ending unbounded', () => {
    expect(validateSlabContiguity(valid)).toEqual({ valid: true });
  });

  it('rejects a gap between slabs', () => {
    const gapped = [
      { seq: 1, fromPaise: 0n, toPaise: L(40_00_000), ratePercent: 1 },
      { seq: 2, fromPaise: L(50_00_000), toPaise: undefined, ratePercent: 1.5 }, // gap 40L-50L
    ];
    const result = validateSlabContiguity(gapped);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/contiguous/);
  });

  it('rejects a first slab that does not start at 0', () => {
    const bad = [{ seq: 1, fromPaise: L(1), toPaise: undefined, ratePercent: 1 }];
    const result = validateSlabContiguity(bad);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/start at 0/);
  });

  it('rejects a rule with no unbounded top slab', () => {
    const bad = [{ seq: 1, fromPaise: 0n, toPaise: L(50_00_000), ratePercent: 1 }];
    const result = validateSlabContiguity(bad);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/unbounded/);
  });

  it('rejects an empty slab list', () => {
    expect(validateSlabContiguity([]).valid).toBe(false);
  });
});

describe('commissionMilestonesSchema (required change #6b)', () => {
  it('accepts strictly ascending integers in (0, 100]', () => {
    expect(commissionMilestonesSchema.safeParse([25, 50, 100]).success).toBe(true);
    expect(commissionMilestonesSchema.safeParse([100]).success).toBe(true);
  });

  it('rejects duplicates', () => {
    expect(commissionMilestonesSchema.safeParse([25, 25, 100]).success).toBe(false);
  });

  it('rejects out-of-order (non-ascending) breakpoints', () => {
    expect(commissionMilestonesSchema.safeParse([50, 25, 100]).success).toBe(false);
  });

  it('rejects 0 and values over 100', () => {
    expect(commissionMilestonesSchema.safeParse([0, 50, 100]).success).toBe(false);
    expect(commissionMilestonesSchema.safeParse([25, 50, 101]).success).toBe(false);
  });

  it('rejects an empty array', () => {
    expect(commissionMilestonesSchema.safeParse([]).success).toBe(false);
  });
});
