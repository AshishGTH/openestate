/**
 * Postsales reports: applicant-ledger reconciliation to the paise against
 * LedgerService.balance(), sales_exec role-scoping (a booking created by one
 * exec is invisible to another exec's scope), and CSV streaming (asserts the
 * actual HTTP wire behavior — chunked, no Content-Length — never that the
 * body was buffered whole before being sent).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import type { Response } from 'express';
import { NotFoundException } from '@nestjs/common';
import { SYSTEM_CLOCK } from '@openestate/shared';
import { LedgerService } from '../src/postsales/ledger.service';
import { PostsalesReportsService } from '../src/reports/postsales-reports.service';
import { streamCsv } from '../src/reports/csv-stream.util';
import {
  makeClients,
  buildServices,
  seedCompany,
  makeUnit,
  makeApplicant,
  makeUser,
  cleanupCompany,
  type Services,
  type CompanyFixture,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const L = (rupees: number) => BigInt(rupees) * 100n;

describeIf('Postsales reports: reconciliation and role-scoping', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let reports: PostsalesReportsService;
  let fx: CompanyFixture;
  let execAId: string;
  let execBId: string;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    reports = new PostsalesReportsService(systemPrisma, SYSTEM_CLOCK, new LedgerService(tenantPrisma));
    fx = await seedCompany(systemPrisma);
    execAId = await makeUser(systemPrisma, fx.companyId, 'sales_executive_a');
    execBId = await makeUser(systemPrisma, fx.companyId, 'sales_executive_b');
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  async function bookedByExec(price: bigint, createdById: string) {
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
      createdById,
    );
    const plan = await svc.plans.createCustomPlan(
      fx.companyId,
      booking.id,
      { name: 'P', isCustom: true, installments: [{ label: 'I1', dueDate: new Date('2026-06-15'), amountPaise: price }] },
      createdById,
    );
    return { booking, installment: plan.installments[0], applicantId };
  }

  it('applicant ledger report totals match LedgerService.balance() to the paise, for N receipts', async () => {
    const { booking, installment } = await bookedByExec(L(30_00_000), execAId);

    await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId: booking.id, receiptDate: new Date('2026-06-16'), mode: 'NEFT', grossAmountPaise: L(5_00_000), allocations: [{ installmentId: installment.id, amountPaise: L(5_00_000) }], tdsDeductedPaise: 0n },
      execAId,
    );
    await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId: booking.id, receiptDate: new Date('2026-06-20'), mode: 'CHEQUE', grossAmountPaise: L(3_00_000), allocations: [{ installmentId: installment.id, amountPaise: L(3_00_000) }], tdsDeductedPaise: 0n },
      execAId,
    );
    await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId: booking.id, receiptDate: new Date('2026-06-25'), mode: 'NEFT', grossAmountPaise: L(2_00_000), allocations: [{ installmentId: installment.id, amountPaise: L(2_00_000) }], tdsDeductedPaise: 0n },
      execAId,
    );

    const serviceBalance = await svc.ledger.balance(fx.companyId, booking.id);
    const report = await reports.applicantLedger(fx.companyId, booking.id, {});

    expect(report.balancePaise).toBe(serviceBalance.toString());
    expect(BigInt(report.balancePaise)).toBe(L(20_00_000)); // 30L charge - 10L receipted

    // The report's own running total (summed independently from the raw ledger rows)
    // must also agree with the last row's running balance.
    const lastRow = report.entries[report.entries.length - 1];
    expect(lastRow.runningBalancePaise).toBe(report.balancePaise);
  });

  it('collectionSummary excludes a bounced cheque — recordChequeEvent must flip isReversed, not just reverse the ledger', async () => {
    const { booking, installment } = await bookedByExec(L(10_00_000), execAId);

    await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId: booking.id, receiptDate: new Date('2026-06-16'), mode: 'NEFT', grossAmountPaise: L(4_00_000), allocations: [{ installmentId: installment.id, amountPaise: L(4_00_000) }], tdsDeductedPaise: 0n },
      execAId,
    );
    const chequeReceipt = await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId: booking.id, receiptDate: new Date('2026-06-20'), mode: 'CHEQUE', grossAmountPaise: L(6_00_000), allocations: [{ installmentId: installment.id, amountPaise: L(6_00_000) }], tdsDeductedPaise: 0n },
      execAId,
    );

    // collectionSummary sums company-wide (no per-booking scope), and other
    // tests in this file share the same company fixture — assert the delta
    // caused by this bounce, not an absolute total.
    const parsePaise = (formatted: string) => BigInt(formatted.replace(/[₹,]/g, '').replace(/\.\d\d$/, '')) * 100n;

    const before = await reports.collectionSummary(fx.companyId, {});
    const beforePaise = parsePaise(before.totalCollectedFormatted);

    await svc.receipts.recordChequeEvent(fx.companyId, chequeReceipt.id, { status: 'BOUNCED', eventDate: new Date('2026-06-22') }, execAId);

    const after = await reports.collectionSummary(fx.companyId, {});
    const afterPaise = parsePaise(after.totalCollectedFormatted);
    expect(beforePaise - afterPaise).toBe(L(6_00_000)); // bounced cheque excluded

    const raw = await systemPrisma.receipt.findFirst({ where: { id: chequeReceipt.id } });
    expect(raw.isReversed).toBe(true);
  });

  it('a sales_exec cannot see another exec\'s booking in installment-dues or applicant-ledger reports', async () => {
    const { booking } = await bookedByExec(L(10_00_000), execAId);

    const asExecA: string[] = [];
    for await (const row of reports.installmentDues(fx.companyId, { scopeToCreatedById: execAId })) {
      asExecA.push(row[0] as string); // booking number column
    }
    expect(asExecA).toContain(booking.bookingNumber);

    const asExecB: string[] = [];
    for await (const row of reports.installmentDues(fx.companyId, { scopeToCreatedById: execBId })) {
      asExecB.push(row[0] as string);
    }
    expect(asExecB).not.toContain(booking.bookingNumber);

    // Service-level check backs this up beyond the list view: a direct
    // applicant-ledger fetch by booking id 404s outside the exec's scope.
    await expect(
      reports.applicantLedger(fx.companyId, booking.id, { scopeToCreatedById: execBId }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const ownReport = await reports.applicantLedger(fx.companyId, booking.id, { scopeToCreatedById: execAId });
    expect(ownReport.bookingId).toBe(booking.id);
  });
});

// CSV streaming has no DB dependency — streamCsv is a pure function of
// (res, headers, rows) — so this always runs, never skipped, against a real
// http.Server to assert the actual wire behavior rather than a mocked one.
describe('CSV streaming: real HTTP wire behavior', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      // streamCsv only calls res.set(...)/res.write(...)/res.end() — a thin
      // adapter over the raw ServerResponse gives it what it needs without
      // pulling in a real Express app for this test.
      const adapted = Object.assign(res, {
        set(headers: Record<string, string>) {
          for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        },
      }) as unknown as Response;

      async function* rows() {
        for (let i = 0; i < 5; i++) {
          yield [`row${i}`, 'value with, comma', 'plain'];
        }
      }
      void streamCsv(adapted, 'report.csv', ['A', 'B', 'C'], rows());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind to a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('is sent chunked, with no Content-Length header (proves it was not buffered whole before sending)', async () => {
    const response = await fetch(`${baseUrl}/report.csv`);
    expect(response.headers.get('transfer-encoding')).toBe('chunked');
    expect(response.headers.get('content-length')).toBeNull();

    const body = await response.text();
    const lines = body.trim().split('\n');
    expect(lines[0]).toBe('A,B,C');
    expect(lines).toHaveLength(6); // header + 5 rows
    expect(lines[1]).toBe('row0,"value with, comma",plain');
  });
});
