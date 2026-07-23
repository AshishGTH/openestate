/**
 * Phase 6 commit 4: notification triggers for the five portal events
 * (receipt confirmed, demand letter issued, construction update
 * published, query replied, commission paid) fire through
 * NotificationService's dev provider, and User.notificationPrefs
 * suppresses a channel when set to off. Assertions look for a message
 * addressed to the specific test's portal user rather than asserting on
 * `provider.sent`'s total length/emptiness, because several tests in
 * this file share one company/project (CONSTRUCTION_UPDATE_PUBLISHED's
 * trigger notifies EVERY applicant with a booking under the project,
 * including applicants seeded by earlier tests in this file) — presence
 * of "my message" / absence of "my message" is the property that
 * actually matters, not the raw count.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runWithTenant } from '@openestate/db';
import { SYSTEM_CLOCK, GENERATED_DOCUMENT_TYPE, type NotificationPrefs } from '@openestate/shared';
import {
  makeClients,
  buildServices,
  seedCompany,
  makeUnit,
  makeApplicant,
  makeBroker,
  makePortalRole,
  makeFlatCommissionRule,
  cleanupCompany,
  type Services,
  type CompanyFixture,
} from './helpers/postsales-harness';
import { BrokerCommissionRuleService } from '../src/brokers/broker-commission-rule.service';
import { CommissionService } from '../src/commission/commission.service';
import { CommissionPaymentService } from '../src/commission/commission-payment.service';
import { DocumentService } from '../src/pdf/document.service';
import { PdfService } from '../src/pdf/pdf.service';
import { UploadService } from '../src/inventory/upload.service';
import { LedgerService } from '../src/postsales/ledger.service';
import { ConstructionUpdateService } from '../src/customer-portal/construction-update.service';
import { TicketService } from '../src/customer-portal/ticket.service';
import { NotificationService } from '../src/notifications/notification.service';
import type {
  CommunicationProvider,
  CommunicationMessage,
  CommunicationSendResult,
} from '../src/queues/communication-provider';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const L = (rupees: number) => BigInt(rupees) * 100n;

class RecordingProvider implements CommunicationProvider {
  sent: CommunicationMessage[] = [];
  async send(message: CommunicationMessage): Promise<CommunicationSendResult> {
    this.sent.push(message);
    return { success: true, providerMessageId: 'test-id' };
  }
}

describeIf('Notification triggers (Phase 6 commit 4)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let provider: RecordingProvider;
  let svc: Services;
  let documents: DocumentService;
  let constructionUpdates: ConstructionUpdateService;
  let tickets: TicketService;
  let commission: CommissionService;
  let payments: CommissionPaymentService;
  let customerRoleId: string;
  let brokerRoleId: string;
  let ticketCategoryId: string;
  let userSeq = 0;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    brokerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'broker');

    provider = new RecordingProvider();
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK, provider);
    const notifications = new NotificationService(systemPrisma, provider);
    const ledger = new LedgerService(tenantPrisma);
    documents = new DocumentService(
      tenantPrisma,
      systemPrisma,
      new PdfService(),
      new UploadService(),
      ledger,
      notifications,
    );
    constructionUpdates = new ConstructionUpdateService(tenantPrisma, systemPrisma, new UploadService(), notifications);
    tickets = new TicketService(tenantPrisma, systemPrisma, notifications);
    const rules = new BrokerCommissionRuleService(tenantPrisma, systemPrisma);
    commission = new CommissionService(tenantPrisma, systemPrisma, rules);
    payments = new CommissionPaymentService(tenantPrisma, systemPrisma, commission, notifications);

    const category = await systemPrisma.ticketCategory.create({
      data: { companyId: fx.companyId, name: 'General' },
    });
    ticketCategoryId = category.id;
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  /** A portal `User` row for either an applicant or a broker. `prefs` omitted
   * relies on DEFAULT_NOTIFICATION_PREFS; passing a partial with a channel
   * `false` exercises the opt-out path. */
  async function makePortalUser(owner: { applicantId?: string; brokerId?: string }, prefs?: NotificationPrefs) {
    const tag = `${Date.now()}-${userSeq++}`;
    return systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: `portal-${tag}@test.com`,
        phone: `9${String(100000000 + userSeq).padStart(9, '0')}`,
        passwordHash: 'x',
        name: `Portal User ${tag}`,
        roleId: owner.applicantId ? customerRoleId : brokerRoleId,
        applicantId: owner.applicantId ?? null,
        brokerId: owner.brokerId ?? null,
        notificationPrefs: prefs ?? null,
      },
    });
  }

  function sentTo(after: CommunicationMessage[], address: string) {
    return after.some((m) => m.toAddress === address);
  }

  /**
   * ConstructionUpdateService.create/TicketService.create/addMessage call
   * withTenantTx directly (no internal runWithTenant self-wrap — see their
   * doc comments), relying on TenantContextInterceptor to have established
   * ambient context on a real request. This is the first direct-call test
   * of either service (previously only exercised through e2e-portal's HTTP
   * layer), so the ambient context has to be established here explicitly,
   * same shape as a staff request (no portal scope).
   */
  function asStaff<T>(fn: () => Promise<T>): Promise<T> {
    return runWithTenant({ companyId: fx.companyId }, fn);
  }

  async function bookedApplicant(agreedPricePaise: bigint, bookingNumber: string) {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const unitId = await makeUnit(systemPrisma, fx);
    const booking = await systemPrisma.booking.create({
      data: {
        companyId: fx.companyId,
        unitId,
        primaryApplicantId: applicantId,
        bookingNumber,
        agreedPricePaise,
        bookingDate: new Date('2026-06-01'),
      },
    });
    return { applicantId, bookingId: booking.id as string };
  }

  async function bookedWithBroker(price: bigint, brokerId: string) {
    const unitId = await makeUnit(systemPrisma, fx);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId,
        primaryApplicantId: applicantId,
        coApplicantIds: [],
        bookingDate: new Date('2026-06-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: price }],
      },
      fx.userId,
    );
    await systemPrisma.booking.update({ where: { id: booking.id }, data: { brokerId } });
    return booking.id as string;
  }

  // ── RECEIPT_CONFIRMED ──────────────────────────────────────

  it('RECEIPT_CONFIRMED: createReceipt notifies the primary applicant\'s portal user', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const user = await makePortalUser({ applicantId });
    const unitId = await makeUnit(systemPrisma, fx);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId,
        primaryApplicantId: applicantId,
        coApplicantIds: [],
        bookingDate: new Date('2026-06-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(10_00_000) }],
      },
      fx.userId,
    );
    const plan = await svc.plans.createCustomPlan(
      fx.companyId,
      booking.id,
      { name: 'P', isCustom: true, installments: [{ label: 'I1', dueDate: new Date('2026-06-15'), amountPaise: L(10_00_000) }] },
      fx.userId,
    );

    const before = provider.sent.length;
    await svc.receipts.createReceipt(
      fx.companyId,
      {
        bookingId: booking.id,
        receiptDate: new Date('2026-06-16'),
        mode: 'NEFT',
        grossAmountPaise: L(10_00_000),
        allocations: [{ installmentId: plan.installments[0].id, amountPaise: L(10_00_000) }],
        tdsDeductedPaise: 0n,
      },
      fx.userId,
    );
    const after = provider.sent.slice(before);

    expect(sentTo(after, user.email)).toBe(true);
    expect(sentTo(after, user.phone)).toBe(true); // default RECEIPT_CONFIRMED: { email: true, sms: true }
  });

  it('RECEIPT_CONFIRMED: notificationPrefs off suppresses it', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const user = await makePortalUser({ applicantId }, { RECEIPT_CONFIRMED: { email: false, sms: false } });
    const unitId = await makeUnit(systemPrisma, fx);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId,
        primaryApplicantId: applicantId,
        coApplicantIds: [],
        bookingDate: new Date('2026-06-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(10_00_000) }],
      },
      fx.userId,
    );
    const plan = await svc.plans.createCustomPlan(
      fx.companyId,
      booking.id,
      { name: 'P', isCustom: true, installments: [{ label: 'I1', dueDate: new Date('2026-06-15'), amountPaise: L(10_00_000) }] },
      fx.userId,
    );

    const before = provider.sent.length;
    await svc.receipts.createReceipt(
      fx.companyId,
      {
        bookingId: booking.id,
        receiptDate: new Date('2026-06-16'),
        mode: 'NEFT',
        grossAmountPaise: L(10_00_000),
        allocations: [{ installmentId: plan.installments[0].id, amountPaise: L(10_00_000) }],
        tdsDeductedPaise: 0n,
      },
      fx.userId,
    );
    const after = provider.sent.slice(before);

    expect(sentTo(after, user.email)).toBe(false);
    expect(sentTo(after, user.phone)).toBe(false);
  });

  // ── DEMAND_LETTER_ISSUED ───────────────────────────────────

  it('DEMAND_LETTER_ISSUED: generateLetterPdf(DEMAND_LETTER) notifies the primary applicant\'s portal user', async () => {
    const { applicantId, bookingId } = await bookedApplicant(L(20_00_000), `DL-${Date.now()}`);
    const user = await makePortalUser({ applicantId });
    const plan = await systemPrisma.paymentPlan.create({
      data: { companyId: fx.companyId, bookingId, name: 'P', isCustom: true },
    });
    const installment = await systemPrisma.installment.create({
      data: {
        companyId: fx.companyId,
        bookingId,
        planId: plan.id,
        seq: 1,
        label: 'I1',
        dueDate: new Date('2026-06-01'),
        amountPaise: L(5_00_000),
      },
    });
    const template = await systemPrisma.letterTemplate.create({
      data: {
        companyId: fx.companyId,
        name: `Demand ${Date.now()}`,
        subject: 'Payment due for {{bookingNumber}}',
        body: 'Dear {{applicantName}}, please pay {{dueAmountFormatted}}.',
        entityType: 'BOOKING',
      },
    });

    const before = provider.sent.length;
    await documents.generateLetterPdf(fx.companyId, GENERATED_DOCUMENT_TYPE.DEMAND_LETTER, bookingId, template.id, fx.userId, installment.id);
    const after = provider.sent.slice(before);

    expect(sentTo(after, user.email)).toBe(true);
    expect(sentTo(after, user.phone)).toBe(true); // default DEMAND_LETTER_ISSUED: { email: true, sms: true }
  });

  it('DEMAND_LETTER_ISSUED: notificationPrefs off suppresses it', async () => {
    const { applicantId, bookingId } = await bookedApplicant(L(20_00_000), `DL2-${Date.now()}`);
    const user = await makePortalUser({ applicantId }, { DEMAND_LETTER_ISSUED: { email: false, sms: false } });
    const plan = await systemPrisma.paymentPlan.create({
      data: { companyId: fx.companyId, bookingId, name: 'P', isCustom: true },
    });
    const installment = await systemPrisma.installment.create({
      data: {
        companyId: fx.companyId,
        bookingId,
        planId: plan.id,
        seq: 1,
        label: 'I1',
        dueDate: new Date('2026-06-01'),
        amountPaise: L(5_00_000),
      },
    });
    const template = await systemPrisma.letterTemplate.create({
      data: {
        companyId: fx.companyId,
        name: `Demand ${Date.now()}`,
        subject: 'Payment due for {{bookingNumber}}',
        body: 'Dear {{applicantName}}, please pay {{dueAmountFormatted}}.',
        entityType: 'BOOKING',
      },
    });

    const before = provider.sent.length;
    await documents.generateLetterPdf(fx.companyId, GENERATED_DOCUMENT_TYPE.DEMAND_LETTER, bookingId, template.id, fx.userId, installment.id);
    const after = provider.sent.slice(before);

    expect(sentTo(after, user.email)).toBe(false);
    expect(sentTo(after, user.phone)).toBe(false);
  });

  // ── CONSTRUCTION_UPDATE_PUBLISHED ──────────────────────────

  it('CONSTRUCTION_UPDATE_PUBLISHED: notifies the portal user of every booking under the project', async () => {
    const { applicantId } = await bookedApplicant(L(10_00_000), `CU-${Date.now()}`);
    const user = await makePortalUser({ applicantId });

    const before = provider.sent.length;
    await asStaff(() =>
      constructionUpdates.create(fx.companyId, fx.userId, {
        projectId: fx.projectId,
        title: 'Slab cast',
        description: 'Slab 5 completed',
        publishedAt: new Date('2026-07-01'),
      }),
    );
    const after = provider.sent.slice(before);

    expect(sentTo(after, user.email)).toBe(true); // default CONSTRUCTION_UPDATE_PUBLISHED: { email: true, sms: false }
    expect(sentTo(after, user.phone)).toBe(false);
  });

  it('CONSTRUCTION_UPDATE_PUBLISHED: notificationPrefs off suppresses it', async () => {
    const { applicantId } = await bookedApplicant(L(10_00_000), `CU2-${Date.now()}`);
    const user = await makePortalUser({ applicantId }, { CONSTRUCTION_UPDATE_PUBLISHED: { email: false, sms: false } });

    const before = provider.sent.length;
    await asStaff(() =>
      constructionUpdates.create(fx.companyId, fx.userId, {
        projectId: fx.projectId,
        title: 'Slab cast',
        description: 'Slab 6 completed',
        publishedAt: new Date('2026-07-02'),
      }),
    );
    const after = provider.sent.slice(before);

    expect(sentTo(after, user.email)).toBe(false);
  });

  // ── QUERY_REPLIED ───────────────────────────────────────────

  it('QUERY_REPLIED: a staff reply notifies the ticket raiser\'s portal user', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const user = await makePortalUser({ applicantId });
    const ticket = await asStaff(() =>
      tickets.create(fx.companyId, user.id, { applicantId }, { categoryId: ticketCategoryId, subject: 'Help', body: 'Question body' }),
    );

    const before = provider.sent.length;
    await asStaff(() => tickets.addMessage(fx.companyId, ticket.id, fx.userId, true, 'Staff reply body'));
    const after = provider.sent.slice(before);

    expect(sentTo(after, user.email)).toBe(true);
    expect(sentTo(after, user.phone)).toBe(true); // default QUERY_REPLIED: { email: true, sms: true }
  });

  it('QUERY_REPLIED: a customer\'s own message does NOT notify themselves', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const user = await makePortalUser({ applicantId });
    const ticket = await asStaff(() =>
      tickets.create(fx.companyId, user.id, { applicantId }, { categoryId: ticketCategoryId, subject: 'Help', body: 'Question body' }),
    );

    const before = provider.sent.length;
    await asStaff(() => tickets.addMessage(fx.companyId, ticket.id, user.id, false, 'Follow-up from the customer'));
    const after = provider.sent.slice(before);

    expect(sentTo(after, user.email)).toBe(false);
  });

  it('QUERY_REPLIED: notificationPrefs off suppresses it', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const user = await makePortalUser({ applicantId }, { QUERY_REPLIED: { email: false, sms: false } });
    const ticket = await asStaff(() =>
      tickets.create(fx.companyId, user.id, { applicantId }, { categoryId: ticketCategoryId, subject: 'Help', body: 'Question body' }),
    );

    const before = provider.sent.length;
    await asStaff(() => tickets.addMessage(fx.companyId, ticket.id, fx.userId, true, 'Staff reply body'));
    const after = provider.sent.slice(before);

    expect(sentTo(after, user.email)).toBe(false);
    expect(sentTo(after, user.phone)).toBe(false);
  });

  // ── COMMISSION_PAID ─────────────────────────────────────────

  it('COMMISSION_PAID: pay() notifies the broker\'s portal user', async () => {
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    const user = await makePortalUser({ brokerId });
    await makeFlatCommissionRule(systemPrisma, fx.companyId, brokerId, 2);
    const bookingId = await bookedWithBroker(L(30_00_000), brokerId); // 2% = 60,000 accrual
    await commission.accrueForBooking(fx.companyId, bookingId, fx.userId);

    const request = await payments.request(fx.companyId, { brokerId, amountPaise: L(60_000) }, fx.userId);
    await payments.approve(fx.companyId, request.id, fx.userId);

    const before = provider.sent.length;
    await payments.pay(fx.companyId, request.id, { mode: 'NEFT', paymentDate: new Date('2026-07-01') }, fx.userId);
    const after = provider.sent.slice(before);

    expect(sentTo(after, user.email)).toBe(true);
    expect(sentTo(after, user.phone)).toBe(true); // default COMMISSION_PAID: { email: true, sms: true }
  });

  it('COMMISSION_PAID: notificationPrefs off suppresses it', async () => {
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    const user = await makePortalUser({ brokerId }, { COMMISSION_PAID: { email: false, sms: false } });
    await makeFlatCommissionRule(systemPrisma, fx.companyId, brokerId, 2);
    const bookingId = await bookedWithBroker(L(30_00_000), brokerId);
    await commission.accrueForBooking(fx.companyId, bookingId, fx.userId);

    const request = await payments.request(fx.companyId, { brokerId, amountPaise: L(60_000) }, fx.userId);
    await payments.approve(fx.companyId, request.id, fx.userId);

    const before = provider.sent.length;
    await payments.pay(fx.companyId, request.id, { mode: 'NEFT', paymentDate: new Date('2026-07-01') }, fx.userId);
    const after = provider.sent.slice(before);

    expect(sentTo(after, user.email)).toBe(false);
    expect(sentTo(after, user.phone)).toBe(false);
  });
});
