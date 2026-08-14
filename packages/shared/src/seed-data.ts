// Single source of truth for the GST/TDS master rows packages/db's
// prisma/seed.ts inserts, so a test in apps/api can drive the SAME data
// through the real, validated GstRateService/TdsRuleService and prove
// it doesn't 400 — without this file, that test would need its own
// hand-copied duplicate of these values, exactly the class of drift
// that let a stale copy of buildValidationSchema slip past this
// codebase before (see CLAUDE.md's v0.2.3 decisions entry). seed.ts
// inserts these directly via Prisma (no HTTP round trip at install
// time — see that file's own `if (existingCompany) return` early-out),
// so nothing enforces this data staying valid except this shared list
// plus the test that exercises it.
//
// Lives in packages/shared (not packages/db) because both consumers
// already depend on it — packages/db/prisma/seed.ts imports
// ROLE_PERMISSIONS etc. from here already, and apps/api obviously does
// too — rather than adding a new packages/db → apps/api dependency
// direction, which the monorepo's layering doesn't allow.
//
// Order matters for GstRate: GstRateService.create()'s overlap check
// runs per row, in insertion order, against whatever's already been
// inserted — these must be insertable in the order listed here.

export interface SeedGstRate {
  rate: number;
  description: string;
  effectiveFrom: Date;
  effectiveTo?: Date;
  sortOrder: number;
}

export interface SeedTdsRule {
  section: string;
  ratePercent: number;
  thresholdPaise: bigint;
  effectiveFrom: Date;
  effectiveTo?: Date;
  description: string;
  sortOrder: number;
}

// Dates are real, not invented: GST rolled out nationally 1 July 2017;
// CBIC Notification 03/2019-Central Tax (Rate), effective 1 April 2019,
// replaced the old with-ITC real-estate scheme with the current
// without-ITC one. The pre-2019 rate is seeded CLOSED (superseded); the
// current rate is the only one left open-ended — GstRateService's
// overlap check has no notion of "category," so two simultaneously
// open-ended rates for the same company (the original shape here) is a
// state the API itself rejects.
export const SEED_GST_RATES: SeedGstRate[] = [
  {
    rate: 12,
    description: 'GST 12% (Non-Affordable, HSN 9972 — pre-Apr-2019 scheme)',
    effectiveFrom: new Date('2017-07-01'),
    effectiveTo: new Date('2019-03-31'),
    sortOrder: 0,
  },
  {
    rate: 5,
    description: 'GST 5% (Affordable Housing, HSN 9972)',
    effectiveFrom: new Date('2019-04-01'),
    sortOrder: 1,
  },
];

// TdsRule's overlap check is scoped by `section` (194-IA vs 194-H are
// different sections), so these never collide with each other even
// though both are open-ended from the same date — no fix needed here,
// included so the round-trip test covers the whole class, not just GstRate.
export const SEED_TDS_RULES: SeedTdsRule[] = [
  {
    section: '194-IA',
    ratePercent: 1,
    thresholdPaise: BigInt(50_00_000_00),
    effectiveFrom: new Date('2019-09-01'),
    description: 'TDS on transfer of immovable property',
    sortOrder: 0,
  },
  {
    section: '194-H',
    ratePercent: 5,
    thresholdPaise: BigInt(15_000_00),
    effectiveFrom: new Date('2019-09-01'),
    description: 'TDS on commission or brokerage (Phase 5)',
    sortOrder: 1,
  },
];
