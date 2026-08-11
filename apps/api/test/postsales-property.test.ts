/**
 * Property-based ledger correctness (fast-check).
 *
 * For thousands of random operation sequences (receipts, receipt reversals,
 * extra charges, interest waivers) on a booking, assert after EVERY step:
 *   1. service balance === reference model balance  (balance == Σ signed)
 *   2. append-only: the ledger entry count never decreases
 *   3. Σ receipt allocations === receipt gross (enforced by the service)
 *
 * numRuns: CI default 2000, local dev 500, overridable via PROPERTY_NUM_RUNS.
 * A run below the CI default of 2000 while CI=true and no explicit override
 * fails loudly. Reproducibility: fast-check prints the failing seed + counter-
 * example path; pin it with FC_SEED to replay.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import { SYSTEM_CLOCK } from '@openestate/shared';
import {
  makeClients,
  buildServices,
  seedCompany,
  makeUnit,
  makeApplicant,
  cleanupCompany,
  type Services,
  type CompanyFixture,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const CI_DEFAULT = 2000;
const LOCAL_DEFAULT = 500;

function resolveNumRuns(): number {
  const override = process.env.PROPERTY_NUM_RUNS;
  if (override) return Number(override);
  const inCi = !!process.env.CI;
  return inCi ? CI_DEFAULT : LOCAL_DEFAULT;
}

type Cmd =
  | { t: 'extra'; rupees: number }
  | { t: 'receipt'; pct: number }
  | { t: 'reverse' }
  | { t: 'waive'; rupees: number };

describeIf('Ledger property: balance == Σ(ledger) for random sequences', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let fx: CompanyFixture;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    fx = await seedCompany(systemPrisma);
  });

  afterAll(async () => {
    // This 300s timeout is TEARDOWN-ONLY, not a signal about ledger runtime
    // performance: cleanupCompany bulk-deletes every booking (and its cost
    // lines, installments, ledger entries, receipts, …) created across every
    // property-test run in one GUC-scoped transaction. At the CI-floor 2000
    // runs that's ~2000 bookings' worth of rows to delete, which alone can
    // approach vitest's default 10s afterAll hook timeout — the ledger
    // WRITES during the test itself stay fast throughout (each run posts a
    // handful of entries in well under a second; see the per-test durations
    // in CI output). Do not read this timeout as "the ledger is slow."
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  }, 300_000);

  // Timeout is 1_800_000 (30min), not the old 600_000 — raised as part of
  // the Phase 7 CI-reliability fix (CLAUDE.md's Decisions log). The old
  // 600s timeout was tight enough that CPU/IO contention under the FULL
  // concurrent suite (not this test in isolation, which finishes in ~96s
  // at 500 runs) could push a real, still-succeeding run past it. Vitest's
  // it(fn, timeout) only stops AWAITING on timeout — it does not cancel
  // the in-flight fast-check loop, which kept issuing real Postgres writes
  // concurrently with afterAll's cleanupCompany() delete sweep, producing
  // a genuine 40P01 deadlock (confirmed via the Postgres server's own
  // log, not just the client-side error). Raising the timeout removes the
  // false-positive trigger for that self-race rather than papering over
  // the race itself; the vitest maxForks cap (vitest.config.ts)
  // additionally reduces the contention that made 600s too tight in the
  // first place. GitHub Actions' own job timeout (360min default, unset
  // in ci.yml) is the real backstop against a genuine hang.
  it(`holds across ${resolveNumRuns()} random sequences`, async () => {
    const numRuns = resolveNumRuns();
    // Explicit, unconditional log — not just the test title above. A test
    // NAME is invisible to some reporters (the JSON reporter CI uses for
    // its "fail if any test was skipped" check only surfaces pass/fail
    // counts, not names) and easy to skim past in a long log. This line
    // is how the turbo strict-envMode bug that stripped PROPERTY_NUM_RUNS
    // in both local and real CI runs (CLAUDE.md's Phase 7→8 gate decision)
    // got caught in the first place — printing the RAW env value alongside
    // the resolved one means a future divergence between "what was
    // intended" and "what the process actually saw" is visible in every
    // CI log, not something you have to go instrument for again.
    console.log(
      `[postsales-property] effective numRuns=${numRuns} ` +
        `(PROPERTY_NUM_RUNS=${process.env.PROPERTY_NUM_RUNS ?? '<unset>'}, ` +
        `CI=${process.env.CI ?? '<unset>'}, ` +
        `FC_SEED=${process.env.FC_SEED ?? '<unset>'})`,
    );
    if (!process.env.PROPERTY_NUM_RUNS && process.env.CI && numRuns < CI_DEFAULT) {
      throw new Error(
        `Property test numRuns (${numRuns}) is below the CI floor of ${CI_DEFAULT}. ` +
          `Set PROPERTY_NUM_RUNS explicitly to override.`,
      );
    }

    const cmd = fc.oneof(
      fc.record({ t: fc.constant('extra' as const), rupees: fc.integer({ min: 1, max: 100000 }) }),
      fc.record({ t: fc.constant('receipt' as const), pct: fc.integer({ min: 1, max: 100 }) }),
      fc.record({ t: fc.constant('reverse' as const) }),
      fc.record({ t: fc.constant('waive' as const), rupees: fc.integer({ min: 1, max: 50000 }) }),
    );

    await fc.assert(
      fc.asyncProperty(fc.array(cmd, { minLength: 1, maxLength: 7 }), async (cmds: Cmd[]) => {
        const unitId = await makeUnit(systemPrisma, fx);
        const applicantId = await makeApplicant(systemPrisma, fx.companyId);

        // Booking: base ₹30,00,000 (no GST) → balance opens at ₹30,00,000.
        const booking = await svc.bookings.createBooking(
          fx.companyId,
          {
            unitId,
            primaryApplicantId: applicantId,
            coApplicantIds: [],
            bookingDate: new Date('2026-06-01'),
            costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 30_00_000n * 100n , gstRateId: fx.defaultGstRateId }],
          },
          fx.userId,
        );
        const plan = await svc.plans.createCustomPlan(
          fx.companyId,
          booking.id,
          {
            name: 'P',
            isCustom: true,
            installments: [
              { label: 'I1', dueDate: new Date('2026-06-15'), amountPaise: 10_00_000n * 100n },
              { label: 'I2', dueDate: new Date('2026-07-15'), amountPaise: 10_00_000n * 100n },
              { label: 'I3', dueDate: new Date('2026-08-15'), amountPaise: 10_00_000n * 100n },
            ],
          },
          fx.userId,
        );

        // Reference model.
        let expected = 30_00_000n * 100n;
        const remaining = new Map<string, bigint>(
          plan.installments.map((i: { id: string; amountPaise: bigint }) => [i.id, i.amountPaise]),
        );
        const liveReceipts: { id: string; cash: bigint; allocs: { installmentId: string; amountPaise: bigint }[] }[] = [];
        let lastCount = await entryCount(booking.id);

        expect(await svc.ledger.balance(fx.companyId, booking.id)).toBe(expected);

        for (const c of cmds) {
          if (c.t === 'extra') {
            const base = BigInt(c.rupees) * 100n;
            await svc.extraCharges.add(fx.companyId, booking.id, { label: 'X', baseAmountPaise: base }, fx.userId);
            expected += base;
          } else if (c.t === 'receipt') {
            const ids = plan.installments.map((i: { id: string }) => i.id);
            const totalLeft = ids.reduce((s: bigint, id: string) => s + (remaining.get(id) ?? 0n), 0n);
            if (totalLeft === 0n) continue;
            let amount = (totalLeft * BigInt(c.pct)) / 100n;
            if (amount === 0n) amount = 1n;
            if (amount > totalLeft) amount = totalLeft;
            // Greedy allocation across installments with remaining.
            const allocations: { installmentId: string; amountPaise: bigint }[] = [];
            let toAllocate = amount;
            for (const id of ids) {
              if (toAllocate === 0n) break;
              const left = remaining.get(id) ?? 0n;
              if (left === 0n) continue;
              const take = left < toAllocate ? left : toAllocate;
              allocations.push({ installmentId: id, amountPaise: take });
              remaining.set(id, left - take);
              toAllocate -= take;
            }
            const receipt = await svc.receipts.createReceipt(
              fx.companyId,
              {
                bookingId: booking.id,
                receiptDate: new Date('2026-06-20'),
                mode: 'NEFT',
                grossAmountPaise: amount,
                allocations,
                tdsDeductedPaise: 0n,
              },
              fx.userId,
            );
            liveReceipts.push({ id: receipt.id, cash: amount, allocs: allocations });
            expected -= amount;
          } else if (c.t === 'reverse') {
            const r = liveReceipts.pop();
            if (!r) continue;
            await svc.receipts.reverseReceipt(fx.companyId, r.id, 'test reversal', fx.userId);
            expected += r.cash;
            // Restore exactly the installment allocations that receipt made.
            for (const a of r.allocs) {
              remaining.set(a.installmentId, (remaining.get(a.installmentId) ?? 0n) + a.amountPaise);
            }
          } else if (c.t === 'waive') {
            const amt = BigInt(c.rupees) * 100n;
            await svc.interest.waiveInterest(fx.companyId, booking.id, { amountPaise: amt, reason: 'goodwill' }, fx.userId);
            expected -= amt;
          }

          const bal = await svc.ledger.balance(fx.companyId, booking.id);
          expect(bal).toBe(expected);
          const cnt = await entryCount(booking.id);
          expect(cnt).toBeGreaterThanOrEqual(lastCount); // append-only: never shrinks
          lastCount = cnt;
        }
      }),
      { numRuns, seed: process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined },
    );
  }, 1_800_000);

  async function entryCount(bookingId: string): Promise<number> {
    return systemPrisma.ledgerEntry.count({ where: { companyId: fx.companyId, bookingId } });
  }
});
