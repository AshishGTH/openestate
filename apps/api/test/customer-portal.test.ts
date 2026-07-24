/**
 * Phase 6 commit 2 (customer-portal): TOCTOU-safe change-request approval,
 * the portal-cannot-write-Applicant bypass audit, co-applicant profile
 * visibility, and stored-artifact PDF downloads (content-hash stable).
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import { runWithTenant } from '@openestate/db';
import { PERMISSIONS, SYSTEM_ROLES, ROLE_PERMISSIONS, GENERATED_DOCUMENT_TYPE } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { PermissionsGuard } from '../src/auth/guards/permissions.guard';
import { ApplicantChangeRequestService } from '../src/customer-portal/applicant-change-request.service';
import { PortalProfileService } from '../src/customer-portal/portal-profile.service';
import { ApplicantService } from '../src/presales/applicant.service';
import { PanEncryptionService } from '../src/common/pan-encryption.service';
import { DocumentService } from '../src/pdf/document.service';
import { PdfService } from '../src/pdf/pdf.service';
import { UploadService } from '../src/inventory/upload.service';
import { LedgerService } from '../src/postsales/ledger.service';
import { NotificationService } from '../src/notifications/notification.service';
import { ConsoleCommunicationProvider } from '../src/queues/communication-provider';
import {
  makeClients,
  seedCompany,
  makeUnit,
  makeApplicant,
  makePortalRole,
  cleanupCompany,
  type CompanyFixture,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

process.env.PAN_ENCRYPTION_KEY ??= 'e5f6a7b8'.repeat(8);

describeIf('Phase 6 customer-portal (commit 2)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let changeRequests: ApplicantChangeRequestService;
  let profileService: PortalProfileService;
  let applicantService: ApplicantService;
  let documents: DocumentService;

  /**
   * These portal-facing service methods deliberately do NOT self-wrap
   * runWithTenant (see applicant-change-request.service.ts's doc comment)
   * — in production TenantContextInterceptor establishes the ambient
   * scope before the call; here the test must establish it explicitly,
   * same as portal-rls.test.ts.
   *
   * NOTE: calling the service directly like this proves the service's OWN
   * logic is correct GIVEN a correctly-populated ambient context — it does
   * NOT prove the context actually gets populated on a real request, nor
   * that it survives into a real prisma.$transaction() call the way it
   * would in production. Both were real gaps that shipped undetected
   * through commit 1's tests: first the middleware-before-guards ordering
   * bug (req.user didn't exist yet), then — after that fix — a second bug
   * where a Guard's AsyncLocalStorage.enterWith() call was empirically
   * proven NOT to survive across prisma.$transaction()'s internal async
   * boundary (see CLAUDE.md Phase 6 commit 2 decisions for both). The
   * through-the-wire proof lives in test/e2e-portal.test.ts (real
   * supertest HTTP requests against the fully bootstrapped app, real
   * guards, real interceptors, real Prisma transactions).
   */
  function asPortalApplicant<T>(applicantId: string, fn: () => Promise<T>): Promise<T> {
    return runWithTenant({ companyId: fx.companyId, portalApplicantId: applicantId }, fn);
  }

  async function makeBooking(applicantId: string, unitId: string, bookingNumber: string) {
    const b = await systemPrisma.booking.create({
      data: {
        companyId: fx.companyId,
        unitId,
        primaryApplicantId: applicantId,
        bookingNumber,
        agreedPricePaise: BigInt(20_00_000_00),
        bookingDate: new Date('2026-06-01'),
      },
    });
    return b.id as string;
  }

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    await makePortalRole(systemPrisma, fx.companyId, 'customer');
    await makePortalRole(systemPrisma, fx.companyId, 'broker');

    changeRequests = new ApplicantChangeRequestService(tenantPrisma, systemPrisma);
    profileService = new PortalProfileService(tenantPrisma);
    applicantService = new ApplicantService(tenantPrisma, systemPrisma, new PanEncryptionService());
    const ledger = new LedgerService(tenantPrisma);
    documents = new DocumentService(
      tenantPrisma,
      systemPrisma,
      new PdfService(),
      new UploadService(),
      ledger,
      new NotificationService(systemPrisma, new ConsoleCommunicationProvider()),
    );
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  // ── TOCTOU ──────────────────────────────────────────────────

  it('TOCTOU: approving a stale change request 409s and leaves the staff edit intact — races the three writes in real sequence', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    await systemPrisma.applicant.update({ where: { id: applicantId }, data: { email: 'a@test.com' } });

    // Step 1: customer submits a real change request A -> B.
    const request = await asPortalApplicant(applicantId, () =>
      changeRequests.submit(fx.companyId, applicantId, fx.userId, { email: 'b@test.com' }),
    );
    expect(request.status).toBe('PENDING');

    // Step 2: staff makes a REAL, independent edit through the actual
    // staff-facing ApplicantService (the same code path apps/web calls),
    // moving the field to C — genuinely racing ahead of the pending request.
    await applicantService.update(fx.companyId, applicantId, { email: 'c@test.com' });
    const afterStaffEdit = await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicantId } });
    expect(afterStaffEdit.email).toBe('c@test.com');

    // Step 3: staff then approves the now-stale A -> B request.
    let conflictBody: unknown;
    try {
      await changeRequests.approve(fx.companyId, request.id, fx.userId);
      throw new Error('expected approve() to reject with a conflict');
    } catch (err) {
      conflictBody = (err as { getResponse?: () => unknown }).getResponse?.() ?? err;
    }
    expect(JSON.stringify(conflictBody)).toContain('submittedAt');
    expect(JSON.stringify(conflictBody)).toContain(new Date(request.createdAt).toISOString().slice(0, 10));

    // Nothing was applied — the applicant still holds the staff's C, not B.
    const final = await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicantId } });
    expect(final.email).toBe('c@test.com');

    const finalRequest = await systemPrisma.applicantChangeRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(finalRequest.status).toBe('PENDING'); // still pending — the conflicting approve() never committed
  });

  it('change-request approval flow: approve applies the field, reject leaves it untouched', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    await systemPrisma.applicant.update({ where: { id: applicantId }, data: { alternatePhones: ['9990001111'] } });

    const approveReq = await asPortalApplicant(applicantId, () =>
      changeRequests.submit(fx.companyId, applicantId, fx.userId, { alternatePhones: ['9990002222'] }),
    );
    await changeRequests.approve(fx.companyId, approveReq.id, fx.userId);
    const afterApprove = await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicantId } });
    expect(afterApprove.alternatePhones).toEqual(['9990002222']);

    const rejectReq = await asPortalApplicant(applicantId, () =>
      changeRequests.submit(fx.companyId, applicantId, fx.userId, { alternatePhones: ['9990003333'] }),
    );
    await changeRequests.reject(fx.companyId, rejectReq.id, fx.userId, 'Could not verify the new number');
    const afterReject = await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicantId } });
    expect(afterReject.alternatePhones).toEqual(['9990002222']); // unchanged — reject never applies
  });

  // ── Bypass audit ────────────────────────────────────────────

  const APPLICANT_WRITE_ROUTES: Array<{ route: string; permission: string }> = [
    { route: 'POST /applicants', permission: PERMISSIONS.PRESALES_APPLICANT_CREATE },
    { route: 'PATCH /applicants/:id', permission: PERMISSIONS.PRESALES_APPLICANT_UPDATE },
    { route: 'POST /applicants/:id/consent', permission: PERMISSIONS.PRESALES_APPLICANT_UPDATE },
    { route: 'POST /applicants/:survivorId/merge/:mergedId', permission: PERMISSIONS.PRESALES_APPLICANT_MERGE },
    { route: 'POST /inquiries (creates/links an Applicant)', permission: PERMISSIONS.PRESALES_INQUIRY_CREATE },
    { route: 'POST /inquiries/import (creates/links Applicants)', permission: PERMISSIONS.PRESALES_INQUIRY_IMPORT },
  ];

  function makeGuardContext(user: JwtPayload, requiredPerms: string[]) {
    const reflector = new Reflector();
    const guard = new PermissionsGuard(reflector);
    reflector.getAllAndOverride = () => requiredPerms as never;
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => ({}),
      getClass: () => ({}),
    };
    return { guard, context: context as never };
  }

  it.each(APPLICANT_WRITE_ROUTES)(
    'bypass audit: $route rejects both portal roles (customer, broker)',
    ({ permission }) => {
      for (const roleSlug of [SYSTEM_ROLES.CUSTOMER, SYSTEM_ROLES.BROKER] as const) {
        const portalUser: JwtPayload = {
          sub: 'portal-user',
          companyId: fx.companyId,
          email: null,
          roleSlug,
          permissions: [...ROLE_PERMISSIONS[roleSlug]],
        };
        const { guard, context } = makeGuardContext(portalUser, [permission]);
        expect(() => guard.canActivate(context)).toThrow();
      }
    },
  );

  it('bypass audit: neither portal role\'s permission set contains any Applicant-writing permission at all', () => {
    const writePerms = new Set(APPLICANT_WRITE_ROUTES.map((r) => r.permission));
    for (const roleSlug of [SYSTEM_ROLES.CUSTOMER, SYSTEM_ROLES.BROKER] as const) {
      const overlap = ROLE_PERMISSIONS[roleSlug].filter((p) => writePerms.has(p));
      expect(overlap).toEqual([]);
    }
  });

  // ── Co-applicant visibility ─────────────────────────────────

  it('co-applicant visibility: a customer sees the co-applicant on their shared booking, and vice versa', async () => {
    const primaryId = await makeApplicant(systemPrisma, fx.companyId);
    const coApplicantId = await makeApplicant(systemPrisma, fx.companyId);
    const unitId = await makeUnit(systemPrisma, fx);
    const bookingId = await makeBooking(primaryId, unitId, `CP-${Date.now()}`);
    await systemPrisma.bookingCoApplicant.create({
      data: { companyId: fx.companyId, bookingId, applicantId: coApplicantId },
    });

    const primaryView = await asPortalApplicant(primaryId, () => profileService.getProfile(fx.companyId, primaryId));
    expect(primaryView.self.id).toBe(primaryId);
    expect(primaryView.coApplicants.map((a: { id: string }) => a.id)).toEqual([coApplicantId]);

    const coApplicantView = await asPortalApplicant(coApplicantId, () => profileService.getProfile(fx.companyId, coApplicantId));
    expect(coApplicantView.self.id).toBe(coApplicantId);
    expect(coApplicantView.coApplicants.map((a: { id: string }) => a.id)).toEqual([primaryId]);
  });

  it('co-applicant visibility (GeneratedDocument twin): a co-applicant can download a shared booking\'s document — regression for the PORTAL_SCOPED_MODELS under-fetch bug', async () => {
    const primaryId = await makeApplicant(systemPrisma, fx.companyId);
    const coApplicantId = await makeApplicant(systemPrisma, fx.companyId);
    const unitId = await makeUnit(systemPrisma, fx);
    const bookingId = await makeBooking(primaryId, unitId, `CPD-${Date.now()}`);
    await systemPrisma.bookingCoApplicant.create({
      data: { companyId: fx.companyId, bookingId, applicantId: coApplicantId },
    });

    // The document's applicantId is the PRIMARY's (document.service.ts's
    // real behaviour — see buildReceiptContext/generateStatementPdf), not
    // the co-applicant's. RLS still grants the co-applicant access via
    // generated_documents_portal_scope's booking_id-reachable branch;
    // PORTAL_SCOPED_MODELS must not re-deny it (Phase 6 decisions).
    const doc = await documents.generateStatementPdf(fx.companyId, bookingId, fx.userId);
    expect(doc.applicantId).toBe(primaryId);

    const downloaded = await asPortalApplicant(coApplicantId, () =>
      documents.getDocumentBytesForPortal(fx.companyId, doc.id),
    );
    expect(downloaded.buffer.length).toBeGreaterThan(0);
  });

  // ── Stored-artifact PDF downloads ───────────────────────────

  it('stored-artifact PDF download: two downloads of the same document are byte-identical (never regenerated)', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const unitId = await makeUnit(systemPrisma, fx);
    const bookingId = await makeBooking(applicantId, unitId, `PDF-${Date.now()}`);

    const doc = await documents.generateStatementPdf(fx.companyId, bookingId, fx.userId);

    const first = await asPortalApplicant(applicantId, () => documents.getDocumentBytesForPortal(fx.companyId, doc.id));
    const second = await asPortalApplicant(applicantId, () => documents.getDocumentBytesForPortal(fx.companyId, doc.id));

    const hash1 = createHash('sha256').update(first.buffer).digest('hex');
    const hash2 = createHash('sha256').update(second.buffer).digest('hex');
    expect(hash1).toBe(hash2);
    expect(first.buffer.equals(second.buffer)).toBe(true);
  });

  it('stored-artifact PDF download: content hash is unchanged by an intervening LetterTemplate edit — proves the download serves stored bytes, never a live re-render', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const unitId = await makeUnit(systemPrisma, fx);
    const bookingId = await makeBooking(applicantId, unitId, `DL-${Date.now()}`);

    const plan = await systemPrisma.paymentPlan.create({
      data: { companyId: fx.companyId, bookingId, name: 'Test Plan', isCustom: true },
    });
    const installment = await systemPrisma.installment.create({
      data: {
        companyId: fx.companyId,
        bookingId,
        planId: plan.id,
        seq: 1,
        label: 'Installment 1',
        dueDate: new Date('2026-01-01'),
        amountPaise: BigInt(5_00_000_00),
      },
    });
    const template = await systemPrisma.letterTemplate.create({
      data: {
        companyId: fx.companyId,
        name: `Demand Letter ${Date.now()}`,
        subject: 'Payment due for {{bookingNumber}}',
        body: 'Dear {{applicantName}}, please pay {{dueAmountFormatted}}.',
        entityType: 'BOOKING',
      },
    });

    const doc = await documents.generateLetterPdf(
      fx.companyId,
      GENERATED_DOCUMENT_TYPE.DEMAND_LETTER,
      bookingId,
      template.id,
      fx.userId,
      installment.id,
    );

    const first = await asPortalApplicant(applicantId, () => documents.getDocumentBytesForPortal(fx.companyId, doc.id));
    const hashBefore = createHash('sha256').update(first.buffer).digest('hex');

    // Master data edit AFTER generation — if the portal endpoint ever
    // re-rendered on read instead of serving the stored artifact, this
    // would change the second download's content.
    await systemPrisma.letterTemplate.update({
      where: { id: template.id },
      data: { subject: 'COMPLETELY DIFFERENT SUBJECT', body: 'This body was edited after generation.' },
    });

    const second = await asPortalApplicant(applicantId, () => documents.getDocumentBytesForPortal(fx.companyId, doc.id));
    const hashAfter = createHash('sha256').update(second.buffer).digest('hex');

    expect(hashAfter).toBe(hashBefore);
    expect(second.buffer.equals(first.buffer)).toBe(true);
  });

  // ── Whitelist enforcement (.strict() zod, not a post-parse loop) ──

  it('whitelist: a change-request payload containing pan is rejected by submitChangeRequestSchema at the validation boundary, not silently dropped', async () => {
    const { submitChangeRequestSchema } = await import('@openestate/shared');
    const result = submitChangeRequestSchema.safeParse({
      email: 'new@test.com',
      pan: 'ABCDE1234F',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // .strict() rejects the whole payload for an unrecognized key —
      // proves this is boundary rejection (400), not silent field-drop.
      expect(JSON.stringify(result.error.issues)).toContain('unrecognized_keys');
    }
  });
});
