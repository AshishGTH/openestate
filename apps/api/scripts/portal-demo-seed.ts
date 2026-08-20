/**
 * Provisions a known-state customer + broker portal fixture in ONE
 * command, against the demo company created by `pnpm seed`
 * (packages/db/prisma/seed.ts, company slug "demo-realty"). Every run
 * resets and recreates the same fixed rows (fixed phone numbers, fixed
 * booking numbers, fixed project code) rather than growing new ones, so
 * a manual click-through always starts from the same state — no more
 * hand-building fixtures with a dozen curl calls before every session.
 *
 * Usage (from apps/api, with DATABASE_URL / DATABASE_URL_SYSTEM pointed
 * at the target Postgres — see README.md's "Local development" section):
 *
 *   pnpm --filter @openestate/api run seed:portal-demo
 *
 * Reuses the real service classes (BookingService, PaymentPlanService,
 * ReceiptService, DocumentService, CommissionService, NocService, …)
 * rather than hand-writing raw rows — the same "exercise real invariants,
 * don't reimplement them" discipline every fixture-builder in this
 * repo's test suite already follows (see apps/api/test/helpers/
 * postsales-harness.ts and CLAUDE.md's Phase 6 commit 4 decisions on the
 * throwaway click-through fixture this script replaces).
 */
import * as argon2 from '@node-rs/argon2';
import { createSystemPrismaClient, createTenantPrismaClient, runWithTenant, withTenantTx } from '@openestate/db';
import { SYSTEM_CLOCK } from '@openestate/shared';
import { BookingService } from '../src/postsales/booking.service';
import { PaymentPlanService } from '../src/postsales/payment-plan.service';
import { ReceiptService } from '../src/postsales/receipt.service';
import { LedgerService } from '../src/postsales/ledger.service';
import { NumberSequenceService } from '../src/postsales/number-sequence.service';
import { UnitStateMachineService } from '../src/inventory/unit-state-machine.service';
import { DocumentService } from '../src/pdf/document.service';
import { PdfService } from '../src/pdf/pdf.service';
import { UploadService } from '../src/inventory/upload.service';
import { NotificationService } from '../src/notifications/notification.service';
import { ConsoleCommunicationProvider } from '../src/queues/communication-provider';
import { BrokerCommissionRuleService } from '../src/brokers/broker-commission-rule.service';
import { CommissionService } from '../src/commission/commission.service';
import { NocService } from '../src/brokers/noc.service';

const L = (rupees: number) => BigInt(rupees) * 100n;

// Fixed identifiers — reused (and reset) on every run.
const PROJECT_CODE = 'PORTAL-DEMO';
const AREA_NAME = 'Portal Demo Area';
const CUSTOMER_PHONE = '9999900001';
const CUSTOMER_EMAIL = 'portal-demo-customer@example.com';
const CUSTOMER_BOOKING_NUMBER = 'PORTAL-DEMO-CUSTOMER';
const BROKER_PHONE = '9999900002';
const BROKER_CUSTOMER_PHONE = '9999900003';
const BROKER_BOOKING_NUMBER = 'PORTAL-DEMO-BROKER';
const CUSTOMER_PASSWORD = 'PortalDemo123';
const BROKER_PASSWORD = 'PortalDemo123';

async function reset(systemPrisma: ReturnType<typeof createSystemPrismaClient>, companyId: string) {
  await (systemPrisma as unknown as { $transaction: (fn: (tx: unknown) => Promise<void>) => Promise<void> }).$transaction(
    async (tx) => {
      const t = tx as { $executeRawUnsafe: (q: string, ...args: unknown[]) => Promise<unknown> };
      await t.$executeRawUnsafe(`SET LOCAL app.allow_financial_mutation = 'on'`);

      const bookingNumbers = [CUSTOMER_BOOKING_NUMBER, BROKER_BOOKING_NUMBER];
      const phones = [CUSTOMER_PHONE, BROKER_PHONE];

      await t.$executeRawUnsafe(
        `DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE company_id = $1::uuid AND raised_by_id IN (SELECT id FROM users WHERE company_id = $1::uuid AND phone = ANY($2::text[])))`,
        companyId, phones,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM tickets WHERE company_id = $1::uuid AND raised_by_id IN (SELECT id FROM users WHERE company_id = $1::uuid AND phone = ANY($2::text[]))`,
        companyId, phones,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM generated_documents WHERE company_id = $1::uuid AND (booking_id IN (SELECT id FROM bookings WHERE company_id = $1::uuid AND booking_number = ANY($2::text[])) OR broker_id IN (SELECT id FROM brokers WHERE company_id = $1::uuid AND phone = $3::text))`,
        companyId, bookingNumbers, BROKER_PHONE,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM commission_ledger_entries WHERE company_id = $1::uuid AND broker_id IN (SELECT id FROM brokers WHERE company_id = $1::uuid AND phone = $2::text)`,
        companyId, BROKER_PHONE,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM broker_nocs WHERE company_id = $1::uuid AND broker_id IN (SELECT id FROM brokers WHERE company_id = $1::uuid AND phone = $2::text)`,
        companyId, BROKER_PHONE,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM commission_payments WHERE company_id = $1::uuid AND broker_id IN (SELECT id FROM brokers WHERE company_id = $1::uuid AND phone = $2::text)`,
        companyId, BROKER_PHONE,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM receipt_allocations WHERE company_id = $1::uuid AND receipt_id IN (SELECT id FROM receipts WHERE company_id = $1::uuid AND booking_id IN (SELECT id FROM bookings WHERE company_id = $1::uuid AND booking_number = ANY($2::text[])))`,
        companyId, bookingNumbers,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM ledger_entries WHERE company_id = $1::uuid AND booking_id IN (SELECT id FROM bookings WHERE company_id = $1::uuid AND booking_number = ANY($2::text[]))`,
        companyId, bookingNumbers,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM receipts WHERE company_id = $1::uuid AND booking_id IN (SELECT id FROM bookings WHERE company_id = $1::uuid AND booking_number = ANY($2::text[]))`,
        companyId, bookingNumbers,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM installments WHERE company_id = $1::uuid AND booking_id IN (SELECT id FROM bookings WHERE company_id = $1::uuid AND booking_number = ANY($2::text[]))`,
        companyId, bookingNumbers,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM payment_plans WHERE company_id = $1::uuid AND booking_id IN (SELECT id FROM bookings WHERE company_id = $1::uuid AND booking_number = ANY($2::text[]))`,
        companyId, bookingNumbers,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM booking_cost_lines WHERE company_id = $1::uuid AND booking_id IN (SELECT id FROM bookings WHERE company_id = $1::uuid AND booking_number = ANY($2::text[]))`,
        companyId, bookingNumbers,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM booking_co_applicants WHERE company_id = $1::uuid AND booking_id IN (SELECT id FROM bookings WHERE company_id = $1::uuid AND booking_number = ANY($2::text[]))`,
        companyId, bookingNumbers,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM bookings WHERE company_id = $1::uuid AND booking_number = ANY($2::text[])`,
        companyId, bookingNumbers,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM broker_commission_rules WHERE company_id = $1::uuid AND broker_id IN (SELECT id FROM brokers WHERE company_id = $1::uuid AND phone = $2::text)`,
        companyId, BROKER_PHONE,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM users WHERE company_id = $1::uuid AND phone = ANY($2::text[])`,
        companyId, phones,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM applicants WHERE company_id = $1::uuid AND primary_phone = ANY($2::text[])`,
        companyId, [CUSTOMER_PHONE, BROKER_CUSTOMER_PHONE],
      );
      await t.$executeRawUnsafe(
        `DELETE FROM brokers WHERE company_id = $1::uuid AND phone = $2::text`,
        companyId, BROKER_PHONE,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM units WHERE company_id = $1::uuid AND floor_id IN (SELECT id FROM floors WHERE company_id = $1::uuid AND tower_id IN (SELECT id FROM towers WHERE company_id = $1::uuid AND project_id IN (SELECT id FROM projects WHERE company_id = $1::uuid AND code = $2::text)))`,
        companyId, PROJECT_CODE,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM floors WHERE company_id = $1::uuid AND tower_id IN (SELECT id FROM towers WHERE company_id = $1::uuid AND project_id IN (SELECT id FROM projects WHERE company_id = $1::uuid AND code = $2::text))`,
        companyId, PROJECT_CODE,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM towers WHERE company_id = $1::uuid AND project_id IN (SELECT id FROM projects WHERE company_id = $1::uuid AND code = $2::text)`,
        companyId, PROJECT_CODE,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM projects WHERE company_id = $1::uuid AND code = $2::text`,
        companyId, PROJECT_CODE,
      );
      await t.$executeRawUnsafe(
        `DELETE FROM area_locations WHERE company_id = $1::uuid AND name = $2::text`,
        companyId, AREA_NAME,
      );
    },
  );
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const systemUrl = process.env.DATABASE_URL_SYSTEM;
  if (!dbUrl || !systemUrl) {
    throw new Error('DATABASE_URL and DATABASE_URL_SYSTEM must be set (see README.md — Local development).');
  }

  const tenantPrisma = createTenantPrismaClient(dbUrl);
  const systemPrisma = createSystemPrismaClient(systemUrl);

  const company = await systemPrisma.company.findFirst({ where: { slug: 'demo-realty' } });
  if (!company) {
    throw new Error('Demo company not found — run `pnpm seed` first to create it.');
  }
  const companyId = company.id;

  const customerRole = await systemPrisma.role.findFirstOrThrow({ where: { companyId, slug: 'customer' } });
  const brokerRole = await systemPrisma.role.findFirstOrThrow({ where: { companyId, slug: 'broker' } });
  const admin = await systemPrisma.user.findFirstOrThrow({ where: { companyId, email: 'admin@demo-realty.com' } });

  console.log('Resetting any previous portal-demo fixture…');
  await reset(systemPrisma, companyId);

  console.log('Creating fresh portal-demo fixture…');
  const area = await systemPrisma.areaLocation.create({ data: { companyId, name: AREA_NAME, stateCode: '09' } });
  const project = await systemPrisma.project.create({ data: { companyId, name: 'Portal Demo Heights', code: PROJECT_CODE, areaLocationId: area.id } });
  const tower = await systemPrisma.tower.create({ data: { companyId, projectId: project.id, name: 'T1', code: 'T1' } });
  const floor = await systemPrisma.floor.create({ data: { companyId, towerId: tower.id, name: 'F1', floorNumber: 1 } });
  const unit = await systemPrisma.unit.create({ data: { companyId, projectId: project.id, shape: 'HIGH_RISE', floorId: floor.id, number: 'PD-101', status: 'AVAILABLE' } });
  const brokerUnit = await systemPrisma.unit.create({ data: { companyId, projectId: project.id, shape: 'HIGH_RISE', floorId: floor.id, number: 'PD-102', status: 'AVAILABLE' } });

  let category = await systemPrisma.ticketCategory.findFirst({ where: { companyId, name: 'General Query' } });
  if (!category) {
    category = await systemPrisma.ticketCategory.create({ data: { companyId, name: 'Portal Demo' } });
  }

  // packages/db/prisma/seed.ts already seeds real GST rates for demo-realty
  // (5%/12%) — reused here rather than creating a throwaway one, since a
  // booking's base line now needs a real gstRateId to be created at all.
  const gstRate = await systemPrisma.gstRate.findFirstOrThrow({ where: { companyId } });

  const notifications = new NotificationService(systemPrisma, new ConsoleCommunicationProvider());
  const ledger = new LedgerService(tenantPrisma);
  const numbers = new NumberSequenceService();
  const stateMachine = new UnitStateMachineService(tenantPrisma);
  const bookings = new BookingService(tenantPrisma, systemPrisma, stateMachine, ledger, numbers);
  const plans = new PaymentPlanService(tenantPrisma, systemPrisma);
  const receipts = new ReceiptService(tenantPrisma, systemPrisma, ledger, numbers, notifications);
  const documents = new DocumentService(tenantPrisma, systemPrisma, new PdfService(), new UploadService(), ledger, notifications);
  const rules = new BrokerCommissionRuleService(tenantPrisma, systemPrisma);
  const commission = new CommissionService(tenantPrisma, systemPrisma, rules);
  const noc = new NocService(tenantPrisma, systemPrisma);

  // ── Customer: booking + plan + receipt + documents + ticket ──
  const customer = await systemPrisma.applicant.create({
    data: { companyId, name: 'Portal Demo Customer', primaryPhone: CUSTOMER_PHONE, primaryPhoneNormalized: CUSTOMER_PHONE, email: CUSTOMER_EMAIL },
  });
  const booking = await bookings.createBooking(
    companyId,
    { unitId: unit.id, primaryApplicantId: customer.id, coApplicantIds: [], bookingDate: SYSTEM_CLOCK.now(), costLines: [{ kind: 'BASE', label: 'Base Price', baseAmountPaise: L(30_00_000), gstRateId: gstRate.id }] },
    admin.id,
  );
  await systemPrisma.booking.update({ where: { id: booking.id }, data: { bookingNumber: CUSTOMER_BOOKING_NUMBER } });
  const plan = await plans.createCustomPlan(
    companyId, booking.id,
    { name: 'Standard', isCustom: true, installments: [
      { label: 'Booking Amount', dueDate: SYSTEM_CLOCK.now(), amountPaise: L(10_00_000) },
      { label: 'Installment 2', dueDate: new Date(SYSTEM_CLOCK.now().getTime() + 90 * 86_400_000), amountPaise: L(20_00_000) },
    ] },
    admin.id,
  );
  await receipts.createReceipt(
    companyId,
    { bookingId: booking.id, receiptDate: SYSTEM_CLOCK.now(), mode: 'NEFT', grossAmountPaise: L(10_00_000), allocations: [{ installmentId: plan.installments[0].id, amountPaise: L(10_00_000) }], tdsDeductedPaise: 0n },
    admin.id,
  );
  const receipt = await systemPrisma.receipt.findFirstOrThrow({ where: { bookingId: booking.id } });
  await documents.generateReceiptPdf(companyId, receipt.id, admin.id);
  await documents.generateStatementPdf(companyId, booking.id, admin.id);

  const customerUser = await systemPrisma.user.create({
    data: { companyId, applicantId: customer.id, phone: CUSTOMER_PHONE, name: customer.name, passwordHash: await argon2.hash(CUSTOMER_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }), roleId: customerRole.id, forcePasswordChange: false },
  });
  const ticket = await runWithTenant({ companyId }, () =>
    withTenantTx(tenantPrisma, companyId, (tx) =>
      tx.ticket.create({ data: { companyId, raisedById: customerUser.id, applicantId: customer.id, categoryId: category!.id, subject: 'Portal demo ticket', status: 'OPEN' } }),
    ),
  );
  await systemPrisma.ticketMessage.create({
    data: { companyId, ticketId: ticket.id, authorId: customerUser.id, authorIsStaff: false, body: 'This is a seeded demo ticket — reply as staff to see the QUERY_REPLIED notification fire.' },
  });

  // ── Broker: rule + booking + accrual + pending NOC + statement ──
  const broker = await systemPrisma.broker.create({ data: { companyId, name: 'Portal Demo Broker', phone: BROKER_PHONE } });
  await rules.create(companyId, { brokerId: broker.id, commissionType: 'FLAT_PERCENT', flatPercent: 2 });
  const brokerCustomer = await systemPrisma.applicant.create({
    data: { companyId, name: 'Portal Demo Broker Customer', primaryPhone: BROKER_CUSTOMER_PHONE, primaryPhoneNormalized: BROKER_CUSTOMER_PHONE },
  });
  const brokerBooking = await bookings.createBooking(
    companyId,
    { unitId: brokerUnit.id, primaryApplicantId: brokerCustomer.id, coApplicantIds: [], bookingDate: SYSTEM_CLOCK.now(), costLines: [{ kind: 'BASE', label: 'Base Price', baseAmountPaise: L(40_00_000), gstRateId: gstRate.id }] },
    admin.id,
  );
  await systemPrisma.booking.update({ where: { id: brokerBooking.id }, data: { bookingNumber: BROKER_BOOKING_NUMBER, brokerId: broker.id } });
  await commission.accrueForBooking(companyId, brokerBooking.id, admin.id);
  await noc.request(companyId, brokerBooking.id, {}, admin.id);
  await documents.generateBrokerStatementPdf(companyId, broker.id, admin.id);

  const brokerUser = await systemPrisma.user.create({
    data: { companyId, brokerId: broker.id, phone: BROKER_PHONE, name: broker.name, passwordHash: await argon2.hash(BROKER_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }), roleId: brokerRole.id, forcePasswordChange: false },
  });

  console.log(
    '\n===== Portal demo fixture ready =====\n' +
      `Customer login:  identifier=${customerUser.phone}  password=${CUSTOMER_PASSWORD}\n` +
      `  → booking ${CUSTOMER_BOOKING_NUMBER}, 1 receipt + 1 statement PDF, 1 open ticket\n` +
      `Broker login:    identifier=${brokerUser.phone}  password=${BROKER_PASSWORD}\n` +
      `  → booking ${BROKER_BOOKING_NUMBER}, 1 REQUESTED NOC, 1 commission statement PDF\n` +
      '======================================\n',
  );

  await systemPrisma.$disconnect();
  await tenantPrisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
