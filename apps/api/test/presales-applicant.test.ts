/**
 * Applicant dedup, consent ledger, and merge integration tests.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTenantPrismaClient, createSystemPrismaClient, runWithTenant, withTenantTx } from '@openestate/db';
import { ApplicantService } from '../src/presales/applicant.service';
import { CustomFieldsService } from '../src/custom-fields/custom-fields.service';
import { PanEncryptionService } from '../src/common/pan-encryption.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const shouldRun = !!(APP_URL && SYSTEM_URL);
const describeIf = shouldRun ? describe : describe.skip;

process.env.PAN_ENCRYPTION_KEY ??= 'f6a7b8c9'.repeat(8);

describeIf('Applicant dedup, consent, merge', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let applicantService: ApplicantService;
  let companyId: string;
  let userId: string;

  beforeAll(async () => {
    tenantPrisma = createTenantPrismaClient(APP_URL!);
    systemPrisma = createSystemPrismaClient(SYSTEM_URL!);
    applicantService = new ApplicantService(tenantPrisma, systemPrisma, new PanEncryptionService(), new CustomFieldsService(tenantPrisma, systemPrisma));

    const company = await systemPrisma.company.create({
      data: { name: 'Applicant Test Co', slug: `applicant-test-${Date.now()}` },
    });
    companyId = company.id;
    const role = await systemPrisma.role.create({
      data: { companyId, name: 'Admin', slug: 'admin', isSystem: true },
    });
    const user = await systemPrisma.user.create({
      data: { companyId, email: `applicant-test-${Date.now()}@test`, passwordHash: 'x', name: 'Actor', roleId: role.id },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await systemPrisma.$executeRaw`DELETE FROM audit_logs WHERE company_id = ${companyId}::uuid`;
    await systemPrisma.communicationLog.deleteMany({ where: { companyId } });
    await systemPrisma.inquiry.deleteMany({ where: { companyId } });
    await systemPrisma.applicantConsent.deleteMany({ where: { companyId } });
    await systemPrisma.applicantMerge.deleteMany({ where: { companyId } });
    await systemPrisma.applicant.deleteMany({ where: { companyId } });
    await systemPrisma.user.deleteMany({ where: { companyId } });
    await systemPrisma.role.deleteMany({ where: { companyId } });
    await systemPrisma.company.delete({ where: { id: companyId } });
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('flags a possible duplicate by exact normalized phone match', async () => {
    const first = await applicantService.create(companyId, {
      name: 'Rahul Sharma',
      primaryPhone: '+91 98765 10001',
      alternatePhones: [],
    });
    expect(first.possibleDuplicateApplicantIds).toEqual([]);

    const second = await applicantService.create(companyId, {
      name: 'Rahul S.',
      primaryPhone: '9876510001',
      alternatePhones: [],
    });
    expect(second.possibleDuplicateApplicantIds).toContain(first.id);
  });

  it('flags a possible duplicate by exact normalized email match', async () => {
    const first = await applicantService.create(companyId, {
      name: 'Priya Patel',
      primaryPhone: '9876510010',
      alternatePhones: [],
      email: 'Priya.Patel@Example.com',
    });
    const second = await applicantService.create(companyId, {
      name: 'Priya P',
      primaryPhone: '9876510011',
      alternatePhones: [],
      email: 'priya.patel@example.com',
    });
    expect(second.possibleDuplicateApplicantIds).toContain(first.id);
  });

  it('does not corrupt or false-match an NRI-style phone number', async () => {
    const nri = await applicantService.create(companyId, {
      name: 'NRI Applicant',
      primaryPhone: '+14155551234',
      alternatePhones: [],
    });
    expect(nri.primaryPhoneNormalized).toBe('+14155551234');

    const unrelatedIndian = await applicantService.create(companyId, {
      name: 'Unrelated Indian',
      primaryPhone: '9876510099',
      alternatePhones: [],
    });
    expect(unrelatedIndian.possibleDuplicateApplicantIds).toEqual([]);
  });

  describe('PAN encryption (Phase 8 retrofit — Broker already had this, Applicant never did)', () => {
    it('encrypts pan at rest, masks for display, and round-trips on decrypt', async () => {
      const applicant = await applicantService.create(companyId, {
        name: 'PAN Test',
        primaryPhone: '9876510060',
        alternatePhones: [],
        pan: 'ABCDE1234F',
      });

      const raw = await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicant.id } });
      expect(raw.panCiphertext).toBeTruthy();
      expect(raw.panCiphertext).not.toContain('ABCDE1234F');
      expect(raw.panMasked).toBe('XXXXX1234F');

      const panEncryption = new PanEncryptionService();
      expect(panEncryption.decrypt(raw.panCiphertext)).toBe('ABCDE1234F');
    });

    it('findOne()/findAll() never return the ciphertext — only panMasked (real bug: the API response included the raw encrypted blob, found via a live exercise)', async () => {
      const applicant = await applicantService.create(companyId, {
        name: 'PAN Response Test',
        primaryPhone: '9876510061',
        alternatePhones: [],
        pan: 'ABCDE1234F',
      });

      const one = await applicantService.findOne(companyId, applicant.id);
      expect(one).not.toHaveProperty('panCiphertext');
      expect(one).not.toHaveProperty('panKeyVersion');
      expect(one.panMasked).toBe('XXXXX1234F');

      const all = await applicantService.findAll(companyId, { page: 1, limit: 50 });
      const listed = all.data.find((a) => a.id === applicant.id);
      expect(listed).not.toHaveProperty('panCiphertext');
      expect(listed).not.toHaveProperty('panKeyVersion');
    });

    it('update() re-encrypts a changed PAN', async () => {
      const applicant = await applicantService.create(companyId, {
        name: 'PAN Update Test',
        primaryPhone: '9876510062',
        alternatePhones: [],
        pan: 'ABCDE1234F',
      });

      await applicantService.update(companyId, applicant.id, { pan: 'PQRST5678G' });

      const raw = await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicant.id } });
      expect(raw.panMasked).toBe('XXXXX5678G');
      const panEncryption = new PanEncryptionService();
      expect(panEncryption.decrypt(raw.panCiphertext)).toBe('PQRST5678G');
    });
  });

  describe('consent ledger', () => {
    it('revoking then re-granting preserves both events', async () => {
      const applicant = await applicantService.create(companyId, {
        name: 'Consent Test',
        primaryPhone: '9876510020',
        alternatePhones: [],
      });

      await applicantService.recordConsent(companyId, applicant.id, userId, true, 'signup form');
      await applicantService.recordConsent(companyId, applicant.id, userId, false, 'user request');
      await applicantService.recordConsent(companyId, applicant.id, userId, true, 're-opt-in');

      const history = await applicantService.getConsentHistory(companyId, applicant.id);
      expect(history).toHaveLength(3);
      expect(history.map((h: { given: boolean }) => h.given)).toEqual([true, false, true]);

      const current = await applicantService.getCurrentConsent(companyId, applicant.id);
      expect(current.given).toBe(true);
    });

    it('consent state at any past timestamp is reconstructible', async () => {
      const applicant = await applicantService.create(companyId, {
        name: 'Timeline Consent',
        primaryPhone: '9876510021',
        alternatePhones: [],
      });

      const grant = await applicantService.recordConsent(companyId, applicant.id, userId, true, 'a');
      await new Promise((r) => setTimeout(r, 5));
      const revoke = await applicantService.recordConsent(companyId, applicant.id, userId, false, 'b');
      await new Promise((r) => setTimeout(r, 5));
      await applicantService.recordConsent(companyId, applicant.id, userId, true, 'c');

      const history = await applicantService.getConsentHistory(companyId, applicant.id);
      // Reconstruct "as of" a moment strictly between grant and revoke.
      const asOfBetweenGrantAndRevoke = new Date(
        (grant.createdAt.getTime() + revoke.createdAt.getTime()) / 2,
      );
      const stateAtThatTime = history
        .filter((h: { createdAt: Date }) => h.createdAt.getTime() <= asOfBetweenGrantAndRevoke.getTime())
        .sort((a: { createdAt: Date }, b: { createdAt: Date }) => b.createdAt.getTime() - a.createdAt.getTime())[0];

      expect(stateAtThatTime.given).toBe(true);
      expect(stateAtThatTime.source).toBe('a');
    });
  });

  describe('merge', () => {
    it('preserves all follow-up history via the inquiry, never touching FollowUp rows directly', async () => {
      const survivor = await applicantService.create(companyId, {
        name: 'Survivor',
        primaryPhone: '9876510030',
        alternatePhones: [],
      });
      const dup = await applicantService.create(companyId, {
        name: 'Duplicate',
        primaryPhone: '9876510030', // same phone -> flagged duplicate
        alternatePhones: [],
      });

      const inquiry = await runWithTenant({ companyId }, () =>
        withTenantTx(tenantPrisma, companyId, (tx: any) =>
          tx.inquiry.create({ data: { companyId, applicantId: dup.id } }),
        ),
      );
      await runWithTenant({ companyId }, () =>
        withTenantTx(tenantPrisma, companyId, (tx: any) =>
          tx.followUp.create({ data: { companyId, inquiryId: inquiry.id, notes: 'call 1', createdById: userId } }),
        ),
      );
      await runWithTenant({ companyId }, () =>
        withTenantTx(tenantPrisma, companyId, (tx: any) =>
          tx.followUp.create({ data: { companyId, inquiryId: inquiry.id, notes: 'call 2', createdById: userId } }),
        ),
      );

      await applicantService.merge(companyId, survivor.id, dup.id, userId);

      const inquiryAfter = await systemPrisma.inquiry.findUnique({ where: { id: inquiry.id } });
      expect(inquiryAfter.applicantId).toBe(survivor.id);

      const followUps = await systemPrisma.followUp.findMany({ where: { inquiryId: inquiry.id } });
      expect(followUps).toHaveLength(2);
      expect(followUps.map((f: { notes: string }) => f.notes).sort()).toEqual(['call 1', 'call 2']);
    });

    it('does NOT reassign CommunicationLog.applicantId — original recipient identity is preserved, but the survivor timeline still surfaces it', async () => {
      const survivor = await applicantService.create(companyId, {
        name: 'Survivor 2',
        primaryPhone: '9876510040',
        alternatePhones: [],
      });
      const dup = await applicantService.create(companyId, {
        name: 'Duplicate 2',
        primaryPhone: '9876510041',
        alternatePhones: [],
      });

      const commLog = await runWithTenant({ companyId }, () =>
        withTenantTx(tenantPrisma, companyId, (tx: any) =>
          tx.communicationLog.create({
            data: {
              companyId,
              applicantId: dup.id,
              channel: 'EMAIL',
              toAddress: 'dup@test.com',
              body: 'hi',
              status: 'SENT',
            },
          }),
        ),
      );

      await applicantService.merge(companyId, survivor.id, dup.id, userId);

      const logAfter = await systemPrisma.communicationLog.findUnique({ where: { id: commLog.id } });
      expect(logAfter.applicantId).toBe(dup.id); // NOT reassigned — original recipient preserved

      const timeline = await applicantService.getCommunicationTimeline(companyId, survivor.id);
      expect(timeline.map((l: { id: string }) => l.id)).toContain(commLog.id);
    });

    it('rejects merging into an already-merged applicant', async () => {
      const a = await applicantService.create(companyId, { name: 'A', primaryPhone: '9876510050', alternatePhones: [] });
      const b = await applicantService.create(companyId, { name: 'B', primaryPhone: '9876510051', alternatePhones: [] });
      const c = await applicantService.create(companyId, { name: 'C', primaryPhone: '9876510052', alternatePhones: [] });

      await applicantService.merge(companyId, a.id, b.id, userId);
      await expect(applicantService.merge(companyId, c.id, b.id, userId)).rejects.toThrow();
    });
  });
});
