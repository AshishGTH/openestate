/**
 * Shared harness for Phase 4 financial tests: builds the full service graph
 * from a tenant + system Prisma client, and seeds a company fixture
 * (company, config, admin user, project/tower/floor) for booking tests.
 */
import { createTenantPrismaClient, createSystemPrismaClient } from '@openestate/db';
import type { Clock } from '@openestate/shared';
import { NumberSequenceService } from '../../src/postsales/number-sequence.service';
import { LedgerService } from '../../src/postsales/ledger.service';
import { BookingService } from '../../src/postsales/booking.service';
import { PaymentPlanService } from '../../src/postsales/payment-plan.service';
import { StageRaiseService } from '../../src/postsales/stage-raise.service';
import { ReceiptService } from '../../src/postsales/receipt.service';
import { InterestService } from '../../src/postsales/interest.service';
import { TransferService } from '../../src/postsales/transfer.service';
import { CancellationService } from '../../src/postsales/cancellation.service';
import { RefundService } from '../../src/postsales/refund.service';
import { ExtraChargeService } from '../../src/postsales/extra-charge.service';
import { UnitStateMachineService } from '../../src/inventory/unit-state-machine.service';
import { NotificationService } from '../../src/notifications/notification.service';
import { ConsoleCommunicationProvider, type CommunicationProvider } from '../../src/queues/communication-provider';

export interface Services {
  numbers: NumberSequenceService;
  ledger: LedgerService;
  stateMachine: UnitStateMachineService;
  bookings: BookingService;
  plans: PaymentPlanService;
  stageRaises: StageRaiseService;
  receipts: ReceiptService;
  interest: InterestService;
  transfers: TransferService;
  cancellations: CancellationService;
  refunds: RefundService;
  extraCharges: ExtraChargeService;
}

export function buildServices(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tenantPrisma: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  systemPrisma: any,
  clock: Clock,
  // Defaults to the real dev provider (just logs) — pass a spy
  // (implements CommunicationProvider) from a notification-specific test
  // to assert on what NotificationService actually sent.
  notificationProvider: CommunicationProvider = new ConsoleCommunicationProvider(),
): Services {
  const numbers = new NumberSequenceService();
  const ledger = new LedgerService(tenantPrisma);
  const stateMachine = new UnitStateMachineService(tenantPrisma);
  const notifications = new NotificationService(systemPrisma, notificationProvider);
  return {
    numbers,
    ledger,
    stateMachine,
    bookings: new BookingService(tenantPrisma, systemPrisma, stateMachine, ledger, numbers),
    plans: new PaymentPlanService(tenantPrisma, systemPrisma),
    stageRaises: new StageRaiseService(tenantPrisma, systemPrisma),
    receipts: new ReceiptService(tenantPrisma, systemPrisma, ledger, numbers, notifications),
    interest: new InterestService(tenantPrisma, systemPrisma, clock, ledger),
    transfers: new TransferService(tenantPrisma, stateMachine, ledger, numbers),
    cancellations: new CancellationService(tenantPrisma, stateMachine, ledger),
    refunds: new RefundService(tenantPrisma, ledger),
    extraCharges: new ExtraChargeService(tenantPrisma, ledger),
  };
}

export function makeClients() {
  const tenantPrisma = createTenantPrismaClient(process.env.DATABASE_URL_TEST!);
  const systemPrisma = createSystemPrismaClient(process.env.DATABASE_URL_TEST_SYSTEM!);
  return { tenantPrisma, systemPrisma };
}

export interface CompanyFixture {
  companyId: string;
  userId: string;
  projectId: string;
  towerId: string;
  floorId: string;
  /**
   * A 0%-rate GstRate row, created for every fixture company so existing
   * booking fixtures across this suite (written before the base-line
   * rate picker made a BASE line's gstRateId effectively mandatory) can
   * keep sending the same baseAmountPaise/expected-total numbers they
   * always did — 0% now, same as the old silent-fallback default, just
   * explicit instead of implicit. Tests that care about a real non-zero
   * rate (postsales-statemachine-gst.test.ts) create and use their own.
   */
  defaultGstRateId: string;
}

let seq = 0;
const rnd = () => Math.random().toString(36).slice(2, 8);

export async function seedCompany(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  systemPrisma: any,
  opts: { gstStateCode?: string; placeStateCode?: string; bounceChargePaise?: bigint } = {},
): Promise<CompanyFixture> {
  const tag = `${Date.now()}-${seq++}-${rnd()}`;
  const company = await systemPrisma.company.create({ data: { name: `Fin ${tag}`, slug: `fin-${tag}` } });
  await systemPrisma.companyConfig.create({
    data: {
      companyId: company.id,
      gstStateCode: opts.gstStateCode ?? '09',
      companyGstin: '09ABCDE1234F1Z5',
      chequeBounceChargePaise: opts.bounceChargePaise ?? BigInt(500_00),
      fyStartMonth: 4,
    },
  });
  const role = await systemPrisma.role.create({
    data: { companyId: company.id, name: 'Admin', slug: 'admin', isSystem: true },
  });
  const user = await systemPrisma.user.create({
    data: { companyId: company.id, email: `fin-${tag}@test`, passwordHash: 'x', name: 'Fin', roleId: role.id },
  });
  const area = await systemPrisma.areaLocation.create({
    data: { companyId: company.id, name: `Area ${tag}`, stateCode: opts.placeStateCode ?? '09' },
  });
  const project = await systemPrisma.project.create({
    data: { companyId: company.id, name: `Project ${tag}`, code: `P-${tag}`, areaLocationId: area.id },
  });
  const tower = await systemPrisma.tower.create({
    data: { companyId: company.id, projectId: project.id, name: 'T1', code: 'T1' },
  });
  const floor = await systemPrisma.floor.create({
    data: { companyId: company.id, towerId: tower.id, name: 'F1', floorNumber: 1 },
  });
  // A CLOSED, clearly-historical date range — not open-ended. GstRateService
  // .create()'s overlap check treats an effectiveTo: null row as overlapping
  // ANY future date range unconditionally (found the hard way:
  // e2e-master-creation.test.ts's real POST /masters/gst-rates for
  // 2026-01-01..2026-12-31 400'd against an open-ended default here). Every
  // real booking fixture in this suite uses a 2026 bookingDate, so a range
  // safely in the past never collides with anything a test creates for real.
  const gstRate = await systemPrisma.gstRate.create({
    data: {
      companyId: company.id,
      rate: 0,
      description: 'No GST (test default)',
      effectiveFrom: new Date('2019-04-01'),
      effectiveTo: new Date('2019-04-02'),
    },
  });
  return {
    companyId: company.id,
    userId: user.id,
    projectId: project.id,
    towerId: tower.id,
    floorId: floor.id,
    defaultGstRateId: gstRate.id,
  };
}

let unitSeq = 0;
export async function makeUnit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  systemPrisma: any,
  fx: CompanyFixture,
): Promise<string> {
  const u = await systemPrisma.unit.create({
    data: {
      companyId: fx.companyId,
      projectId: fx.projectId,
      shape: 'HIGH_RISE',
      floorId: fx.floorId,
      number: `U-${Date.now()}-${unitSeq++}-${rnd()}`,
      status: 'AVAILABLE',
    },
  });
  return u.id;
}

/** A second user in the same company, e.g. a colleague exec for role-scoping tests. */
export async function makeUser(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  systemPrisma: any,
  companyId: string,
  roleSlug: string,
): Promise<string> {
  const tag = `${Date.now()}-${seq++}-${rnd()}`;
  const role = await systemPrisma.role.create({
    data: { companyId, name: roleSlug, slug: `${roleSlug}-${tag}`, isSystem: true },
  });
  const user = await systemPrisma.user.create({
    data: { companyId, email: `${roleSlug}-${tag}@test`, passwordHash: 'x', name: roleSlug, roleId: role.id },
  });
  return user.id;
}

// Phone numbers double as portal login identifiers (users.phone), and
// portal/auth/login resolves an identifier without knowing the caller's
// company up front — a phone collision across two DIFFERENT companies'
// applicants/brokers can log a test in as the WRONG user, not just fail to
// find one (docs/todo.md's "makeApplicant's phone counter" entry; the flake
// this caused in e2e-portal-throttle.test.ts is documented in CLAUDE.md's
// Phase 6 commit 4 decisions).
//
// Vitest's forked pool re-instantiates this module fresh per test FILE
// (each file gets its own `let appSeq = 0`), so the ORIGINAL scheme
// (`process.pid % 100` mixed in, appSeq starting at 0) collided whenever
// two CONCURRENT files happened to share a pid bucket: birthday paradox
// over 4 draws (this project's maxForks) from 100 buckets ≈ 5.9% per
// full suite run, and a shared bucket meant an EXACT collision on each
// file's first applicant.
//
// This went through three designs before landing, each one falsified by
// actually running it, not by further reasoning about it — kept here,
// briefly, because the failure of each is what justifies the final shape:
//
// 1. Random per-process offset over a 99,000,000-wide range. Measured
//    ~0.05% collision probability via simulation — much better, but still
//    a probability, in a fix whose whole point is removing a flake.
// 2. STRUCTURAL blocks keyed on `VITEST_POOL_ID` (tinypool's pool-slot
//    index, confirmed via probe test files to be bounded to
//    [1, maxForks] and reused by a NEW process once an old slot-occupant
//    exits) — one disjoint 1,000,000-wide block per slot, so two
//    CONCURRENT files can't collide. Correct for concurrency, but this
//    project's Vitest config has no explicit `isolate` setting, so it
//    runs on Vitest's own default, `isolate: true` (confirmed by reading
//    node_modules/vitest's own default config), which — combined with
//    the probe evidence (a later probe got a FRESH PID but the SAME
//    VITEST_POOL_ID an earlier one had used) — means every file
//    dispatched to a slot, not just one after a crash, restarts this
//    module from scratch with `appSeq` back at 0. Keying the seed on
//    VITEST_POOL_ID alone meant the SECOND file ever dispatched to a
//    slot re-emitted the FIRST file's entire sequence — a certainty, not
//    a probability, for any two files sharing a slot (most files, under
//    maxForks:4 and ~88 apps/api test files).
// 3. Added a "monotonic" sub-offset nested in the block, derived from
//    wall-clock time quantized to a 100ms grid
//    (`Math.floor(Date.now() / 100)`), reasoned to differ between
//    sequential same-slot dispatches because bootstrapping a real NestJS
//    app takes tens of milliseconds at least. EMPIRICALLY FALSIFIED: the
//    probe methodology below (mocking systemPrisma so no real DB is
//    needed) has no bootstrap cost at all, and 10 such probes under real
//    `maxForks:4` measured PER-FILE DURATIONS OF 3–27ms — well under a
//    100ms window — and a live run reproduced the exact duplicate-phone
//    failure being fixed, on the first verification attempt. A slower
//    window would only push the same failure further out, not remove
//    it: nothing guarantees a minimum inter-dispatch gap, and nothing
//    stops a future lightweight file from dispatching that fast for real.
//
// FINAL FIX: `VITEST_WORKER_ID` (`ctx.workerId`, set in vitest's own
// worker.js — a DIFFERENT thing from tinypool's `workerId` despite the
// name, confirmed by reading both) is a single counter for the ENTIRE
// run, confirmed strictly increasing across every file regardless of
// which pool slot handled it (probe evidence: 6 files read worker ids
// 1..6, in dispatch order, never repeating). That single property — a
// number that is NEVER reused by any two files in one Vitest invocation,
// whether they run concurrently or sequentially reuse the same slot —
// already gives every file a globally unique identity, which is a
// STRONGER guarantee than the two-tier pool-id-block-plus-sub-offset
// design above was reaching for, and needs no separate concurrency tier
// at all: `VITEST_POOL_ID` is now unused. (An earlier attempt used
// `workerId - 1` directly as a sub-offset WITHIN a pool-id block, which
// has a real arithmetic bug caught by the same probe re-run: consecutive
// worker ids differ by exactly 1, not by the per-file reservation width,
// so consecutive files' 5,000-wide reserved ranges overlapped almost
// entirely. The fix is the same insight taken one step further — since
// `VITEST_WORKER_ID` is unique per file GLOBALLY, not just within a
// slot, there is no need to confine it to a slot's block at all; multiply
// it by the reservation width directly, over the FULL suffix range.)
//
// `PHONE_SEED = (VITEST_WORKER_ID - 1) × PER_FILE_HEADROOM`. Two files
// can never receive the same `VITEST_WORKER_ID`, so their reserved
// [seed, seed+PER_FILE_HEADROOM) ranges can never overlap, regardless of
// concurrency or slot reuse — not a probability, a property of how
// Vitest assigns that counter.
//
// Per-file call allowance: PER_FILE_HEADROOM = 5,000 — ~2.5x
// postsales-property.test.ts's real worst case (exactly ONE makeApplicant
// call per fast-check iteration, PROPERTY_NUM_RUNS up to 2000 by default;
// re-checked directly in that file rather than assumed, since an earlier
// draft of this comment overstated it as ~4000 from a wrong "2 calls per
// iteration" reading). `nextPhoneSuffix` throws if a file's own sequence
// would exceed it.
//
// How many files can share a run before ranges exhaust: MAX_FILES_PER_RUN
// = PHONE_SUFFIX_MODULUS / PER_FILE_HEADROOM = 100,000,000 / 5,000 =
// 20,000 — the total number of `VITEST_WORKER_ID` values (i.e. total test
// files) this scheme can place without two reservations overlapping.
// This project's apps/api/test has ~88 files today, ~227x under that
// ceiling. AT that boundary (a single Vitest invocation running ≥20,000
// files — not a realistic scenario for any test suite, this or
// otherwise), `computePhoneSeed` THROWS immediately at module load naming
// the exact `VITEST_WORKER_ID` that crossed it, rather than silently
// wrapping into a range an earlier file in the same run already used.
//
// The random-offset path (Math.random(), not process.hrtime.bigint() —
// V8 seeds Math.random() from OS entropy independently per isolate, i.e.
// per process, so it needs no argument about scheduler jitter or clock
// resolution the way reasoning about two forks' hrtime reads would; this
// file's own `rnd()` helper above already leans on the same property) is
// kept as a fallback for when VITEST_WORKER_ID is absent — a direct
// caller (e.g. a standalone tsx script) outside any Vitest run. Nothing
// in this codebase calls makeApplicant/makeBroker that way today
// (grepped), so this path is currently unexercised defensive coverage,
// not a live concurrency need. It draws from the FULL
// PHONE_SUFFIX_MODULUS-wide range and is bound by the same
// PER_FILE_HEADROOM ceiling, so it can't wrap into a phone that exceeds
// the 8-digit suffix budget — but it has no structural guarantee against
// colliding with a concurrently-running Vitest worker's reservation,
// same limitation every earlier random-offset attempt had, acceptable
// only because this path has no current caller to actually collide.
const PHONE_SUFFIX_DIGITS = 8;
const PHONE_SUFFIX_MODULUS = 10 ** PHONE_SUFFIX_DIGITS; // 100,000,000
const PER_FILE_HEADROOM = 5_000; // per-file call ceiling — ~2.5x the observed worst case (2000)
const MAX_FILES_PER_RUN = Math.floor(PHONE_SUFFIX_MODULUS / PER_FILE_HEADROOM); // 20,000

function computePhoneSeed(): number {
  const workerId = Number(process.env.VITEST_WORKER_ID);
  if (Number.isInteger(workerId) && workerId >= 1) {
    const index = workerId - 1;
    if (index >= MAX_FILES_PER_RUN) {
      throw new Error(
        `VITEST_WORKER_ID=${workerId} exceeds this phone-numbering scheme's ${MAX_FILES_PER_RUN}-file ` +
          `capacity (postsales-harness.ts: PER_FILE_HEADROOM=${PER_FILE_HEADROOM} over a ` +
          `${PHONE_SUFFIX_MODULUS}-wide suffix space). This means over ${MAX_FILES_PER_RUN} test files ` +
          `ran in a single Vitest invocation — widen PHONE_SUFFIX_DIGITS or shrink PER_FILE_HEADROOM to ` +
          `add headroom rather than letting this wrap into a range an earlier file already used.`,
      );
    }
    return index * PER_FILE_HEADROOM;
  }
  return Math.floor(Math.random() * (PHONE_SUFFIX_MODULUS - PER_FILE_HEADROOM));
}
const PHONE_SEED = computePhoneSeed();

function nextPhoneSuffix(seq: number): string {
  if (seq >= PER_FILE_HEADROOM) {
    throw new Error(
      `makeApplicant/makeBroker's phone counter exceeded its reserved headroom of ` +
        `${PER_FILE_HEADROOM} calls in one test file. Widen PER_FILE_HEADROOM in ` +
        `postsales-harness.ts (and re-check the collision-probability comment above it) ` +
        `if a test genuinely needs this many.`,
    );
  }
  return String(PHONE_SEED + seq).padStart(PHONE_SUFFIX_DIGITS, '0');
}

let appSeq = 0;
export async function makeApplicant(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  systemPrisma: any,
  companyId: string,
): Promise<string> {
  const phone = `98${nextPhoneSuffix(appSeq++)}`;
  const a = await systemPrisma.applicant.create({
    data: { companyId, name: `Applicant ${appSeq}`, primaryPhone: phone, primaryPhoneNormalized: phone },
  });
  return a.id;
}

let brokerSeq = 0;
export async function makeBroker(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  systemPrisma: any,
  companyId: string,
): Promise<string> {
  const phone = `90${nextPhoneSuffix(brokerSeq++)}`;
  const b = await systemPrisma.broker.create({
    data: { companyId, name: `Broker ${brokerSeq}`, phone },
  });
  return b.id;
}

/**
 * Phase 6: the `customer`/`broker` system role for a fixture company.
 * `seedCompany` only creates a generic 'admin' role, so portal tests need
 * this separately — `PortalAuthService` looks the role up by
 * `(companyId, slug)`, and no permission rows are needed since these tests
 * exercise services/raw connections directly, never `PermissionsGuard`.
 */
export async function makePortalRole(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  systemPrisma: any,
  companyId: string,
  roleSlug: 'customer' | 'broker',
): Promise<string> {
  const role = await systemPrisma.role.create({
    data: { companyId, name: roleSlug, slug: roleSlug, isSystem: true, isPortal: true },
  });
  return role.id;
}

/** Flat-percent commission rule (company-wide, no project override) — the common case in tests. */
export async function makeFlatCommissionRule(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  systemPrisma: any,
  companyId: string,
  brokerId: string,
  flatPercent: number,
  milestones?: number[],
): Promise<string> {
  const rule = await systemPrisma.brokerCommissionRule.create({
    data: {
      companyId,
      brokerId,
      commissionType: 'FLAT_PERCENT',
      flatPercent,
      milestonesJson: milestones ?? null,
    },
  });
  return rule.id;
}

/** Delete all financial + inventory rows for a company (append-only override). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function cleanupCompany(systemPrisma: any, companyId: string): Promise<void> {
  const tables = [
    // Phase 6: portal rows — several RESTRICT onto users (raised_by_id,
    // requested_by_id) and onto companies directly, so must go before both
    // 'users' and the final companies delete below. ticket_messages/
    // construction_update_media are CASCADE from their parents but listed
    // explicitly anyway; tickets before ticket_categories because
    // tickets_category_id_fkey is RESTRICT.
    'ticket_messages', 'tickets', 'ticket_categories', 'applicant_change_requests',
    // password_resets: admin-triggered staff-target resets (see
    // UsersService.forcePasswordReset) — same RESTRICT-onto-companies
    // shape as portal_password_resets right above.
    'password_resets', 'portal_password_resets', 'portal_invites', 'construction_update_media', 'construction_updates',
    // Phase 7 rows — same never-caught-until-first-use gap as several
    // tables below: their companies_id_fkey was CASCADE in the migration
    // that first created them but schema.prisma never specified
    // onDelete: Cascade, a drift that a later migration (unrelated to
    // Phase 7) reconciled to match schema.prisma's real RESTRICT default,
    // surfacing this harness's implicit reliance on the old CASCADE
    // behavior. Delivery attempts/deliveries before their own parents;
    // applicant_documents before both 'document_types' (masters section
    // below) and 'applicants' (near the end) since it RESTRICTs onto both.
    'webhook_delivery_attempts', 'webhook_deliveries', 'webhook_endpoints',
    'lead_source_api_keys', 'plugin_installations', 'applicant_documents',
    // Phase 5: broker/commission rows — reference bookings/brokers/projects,
    // so must go before those are deleted below. Nothing references these.
    'commission_ledger_entries', 'broker_nocs', 'broker_booking_commissions', 'commission_payments',
    'broker_commission_slabs', 'broker_commission_rules', 'broker_bank_details', 'brokers',
    // UI-layer rows first — they reference bookings/applicants/receipts.
    'document_dispatches', 'generated_documents', 'booking_drafts',
    // Financial rows next (incl. append-only tables) so master deletes below
    // never fire a SET-NULL cascade onto an already-deleted append-only table.
    'tds_certificates', 'tds_deductions', 'interest_accruals', 'cheque_status_events',
    'receipt_allocations', 'ledger_entries', 'payment_vouchers', 'refunds', 'cancellations',
    'transfers', 'extra_charges', 'receipts', 'installments', 'payment_plans',
    'booking_cost_lines', 'booking_co_applicants', 'bookings', 'unit_status_changes',
    // stage_raises RESTRICTs directly onto both projects and companies,
    // so it must go before the projects delete right below (installments
    // referencing it are already gone from the delete two lines up —
    // ON DELETE SET NULL would have covered it anyway, but ordering it
    // here is what actually matters for the projects/companies RESTRICT).
    'stage_raises',
    // v0.2.2: layout plan/brochure/photo rows — CASCADE from projects but
    // listed explicitly anyway, same discipline as construction_update_media.
    // inventory_groups.project_id RESTRICTs onto projects, so it must be
    // deleted before the projects delete below — must also come after
    // 'units' since Unit.inventoryGroupId references it. Never previously
    // exercised by this harness (same never-caught-until-first-use gap as
    // the presales/custom-field tables above), surfaced by
    // e2e-plotted-inventory.test.ts being the first test using this
    // helper to create a LAND_BASED project with an InventoryGroup.
    'units', 'inventory_groups', 'floors', 'towers', 'project_media', 'projects',
    // Masters referenced by the financial rows above.
    'cancellation_rules', 'interest_rules', 'gst_rates', 'tds_rules', 'transfer_fee_rules',
    'payment_plan_milestones', 'payment_plan_templates', 'area_locations',
    // Remaining SIMPLE_MASTERS/dedicated-module masters with no other
    // table referencing them (or, for unit_types, only from 'units',
    // already deleted above) — never previously exercised by this
    // harness, same never-caught-until-first-use gap as inquiry_sources
    // above, surfaced by the through-the-wire master-creation e2e test
    // being the first to create rows here via the real HTTP API.
    'unit_types', 'plc_types', 'inquiry_types', 'inquiry_temperatures', 'follow_up_types',
    'communication_types', 'project_types', 'receipt_types', 'registration_types',
    'document_types', 'banks', 'charge_types', 'sms_templates',
    // Phase 3 presales rows — reference applicants/inquiries, so must go
    // before 'applicants' below. Exposed by Phase 7's lead-inbound tests
    // being the first to combine this (financial-harness) cleanup with
    // real Inquiry rows — 'inquiries' was previously never populated by
    // any test using this helper, so its absence here was never caught.
    // inquiry_stage_history.inquiry_id cascades from inquiries, but its
    // to_stage_id is RESTRICT onto lead_stages (never delete audit history
    // for a stage that's still referenced) — must be deleted explicitly,
    // and before lead_stages below, or that delete would fail.
    // inquiry_disposition_history.inquiry_id also cascades from inquiries
    // (its reason_id is SET NULL onto dump_reasons, not RESTRICT, but
    // listed explicitly anyway, same discipline as inquiry_stage_history).
    'communication_logs', 'follow_ups', 'inquiry_assignments', 'inquiry_stage_history', 'inquiry_disposition_history', 'inquiries',
    // inquiry_sources/lead_stages/dump_reasons are masters referenced by
    // inquiries' source_id/stage_id (dump_reasons only via disposition
    // history, already gone by this point) — deleted after inquiries
    // above, not with the other masters section — never previously
    // exercised by this harness (same never-caught-until-first-use gap
    // as inquiries/custom_field_definitions above), surfaced by the
    // master-factory regression test being the first to create an
    // InquirySource row here.
    'inquiry_sources', 'lead_stages', 'dump_reasons',
    // Item 7: applicant_a_id/applicant_b_id are ON DELETE CASCADE from
    // applicants, so this would clean up on its own — listed explicitly
    // anyway, before 'applicants', matching this file's own discipline.
    'applicant_distinct_pairs',
    'applicant_consents', 'applicant_merges',
    // Phase 1 — no child rows reference custom_field_definitions (values
    // live inline as JSON on each entity), so it just needs to go before
    // 'companies'. Same "never previously exercised by this harness" gap
    // as the presales tables above, surfaced by Phase 7's generic-sales
    // plugin test (the first to create a CustomFieldDefinition here).
    'custom_field_definitions',
    'letter_templates', 'applicants', 'number_sequences', 'company_configs', 'users', 'roles',
  ];
  // Single transaction so the maintenance GUC (which lets us bypass the
  // append-only triggers) and every DELETE share one connection. Generous
  // timeout because the property test leaves thousands of bookings' rows.
  await systemPrisma.$transaction(
    async (tx: { $executeRawUnsafe: (q: string, ...a: unknown[]) => Promise<unknown> }) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.allow_financial_mutation = 'on'`);
      for (const t of tables) {
        await tx.$executeRawUnsafe(`DELETE FROM ${t} WHERE company_id = $1::uuid`, companyId);
      }
      await tx.$executeRawUnsafe(`DELETE FROM audit_logs WHERE company_id = $1::uuid`, companyId);
      await tx.$executeRawUnsafe(`DELETE FROM companies WHERE id = $1::uuid`, companyId);
    },
    { maxWait: 120_000, timeout: 300_000 },
  );
}
