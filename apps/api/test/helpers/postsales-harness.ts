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
  return { companyId: company.id, userId: user.id, projectId: project.id, towerId: tower.id, floorId: floor.id };
}

let unitSeq = 0;
export async function makeUnit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  systemPrisma: any,
  fx: CompanyFixture,
): Promise<string> {
  const u = await systemPrisma.unit.create({
    data: { companyId: fx.companyId, floorId: fx.floorId, number: `U-${Date.now()}-${unitSeq++}-${rnd()}`, status: 'AVAILABLE' },
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

let appSeq = 0;
export async function makeApplicant(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  systemPrisma: any,
  companyId: string,
): Promise<string> {
  const phone = `98765${String(10000 + appSeq++).slice(-5)}`;
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
  const phone = `90000${String(10000 + brokerSeq++).slice(-5)}`;
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
    'portal_password_resets', 'portal_invites', 'construction_update_media', 'construction_updates',
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
    'units', 'floors', 'towers', 'projects',
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
    'communication_logs', 'follow_ups', 'inquiry_assignments', 'inquiries',
    // inquiry_sources is a master referenced by inquiries.source_id, so it
    // must be deleted after inquiries above, not with the other masters
    // section — never previously exercised by this harness (same
    // never-caught-until-first-use gap as inquiries/custom_field_definitions
    // above), surfaced by the master-factory regression test being the
    // first to create an InquirySource row here.
    'inquiry_sources',
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
