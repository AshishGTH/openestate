/**
 * Phase 7 commit 2 (webhooks-and-leads): the inbound-lead dedup path
 * (InquiryService.createFromLead, extracted per CLAUDE.md Phase 7
 * decisions), ctx.leads capability wiring, LeadApiKeyService secret
 * hashing, and LeadInboundController's field-mapping resolution
 * (malformed-payload → the specific 400 message).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { SYSTEM_CLOCK } from '@openestate/shared';
import { PluginCapabilityError, type Plugin } from '@openestate/plugin-sdk';
import { z } from 'zod';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { InquiryService } from '../src/presales/inquiry.service';
import { CustomFieldsService } from '../src/custom-fields/custom-fields.service';
import { AssignmentService } from '../src/presales/assignment.service';
import { ApplicantService } from '../src/presales/applicant.service';
import { PanEncryptionService } from '../src/common/pan-encryption.service';
import { LeadApiKeyService } from '../src/leads/lead-api-key.service';
import { LeadInboundController } from '../src/leads/lead-inbound.controller';
import { PluginSecretEncryptionService } from '../src/plugins/plugin-secret-encryption.service';
import { PluginRuntimeService } from '../src/plugins/plugin-runtime.service';
import { CompanyService } from '../src/company/company.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'c1d2e3f4'.repeat(8)}`;
process.env.PAN_ENCRYPTION_KEY ??= 'a1b2c3d4'.repeat(8);

// `Date.now() + N` for small N truncates to the SAME leading digits once
// sliced to 10 — every test in this file would collide on the same
// generated phone number. A counter + random suffix guarantees real
// uniqueness within a single run.
let phoneSeq = 0;
function uniquePhone(): string {
  return `9${String(Date.now()).slice(-6)}${String(phoneSeq++).padStart(3, '0')}`.slice(0, 10);
}

describeIf('Inbound lead API (Phase 7 commit 2)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let inquiryService: InquiryService;
  let leadApiKeyService: LeadApiKeyService;
  let inboundController: LeadInboundController;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    const assignmentService = new AssignmentService(tenantPrisma);
    const applicantService = new ApplicantService(tenantPrisma, systemPrisma, new PanEncryptionService(), new CustomFieldsService(tenantPrisma, systemPrisma));
    inquiryService = new InquiryService(tenantPrisma, systemPrisma, SYSTEM_CLOCK, assignmentService, applicantService, new CustomFieldsService(tenantPrisma, systemPrisma));
    leadApiKeyService = new LeadApiKeyService(systemPrisma);
    inboundController = new LeadInboundController(inquiryService);
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  // ── InquiryService.createFromLead: dedup ──────────────────────

  describe('createFromLead dedup', () => {
    it('creates a new applicant when no phone/email match exists', async () => {
      const phone = uniquePhone();
      const result = await inquiryService.createFromLead(fx.companyId, { name: 'New Lead', phone });
      expect(result.duplicateApplicantIds).toHaveLength(0);
      const applicant = await systemPrisma.applicant.findUnique({ where: { id: result.applicantId } });
      expect(applicant.name).toBe('New Lead');
    });

    it('auto-links to an existing applicant on a phone match instead of creating a duplicate', async () => {
      const phone = uniquePhone();
      const first = await inquiryService.createFromLead(fx.companyId, { name: 'First Contact', phone });
      const second = await inquiryService.createFromLead(fx.companyId, { name: 'Same Person Again', phone });

      expect(second.applicantId).toBe(first.applicantId); // linked, not a new applicant
      expect(second.duplicateApplicantIds).toContain(first.applicantId);

      const applicantCount = await systemPrisma.applicant.count({ where: { companyId: fx.companyId, primaryPhone: phone } });
      expect(applicantCount).toBe(1); // never duplicated
    });

    it('creates a real Inquiry row linked to the resolved applicant', async () => {
      const phone = uniquePhone();
      const result = await inquiryService.createFromLead(fx.companyId, { name: 'Inquiry Check', phone, note: 'from a lead source' });
      const inquiry = await systemPrisma.inquiry.findUnique({ where: { id: result.inquiryId } });
      expect(inquiry.applicantId).toBe(result.applicantId);
      expect(inquiry.customFields).toEqual({ leadNote: 'from a lead source' });
    });
  });

  // ── ctx.leads capability wiring (commit 2 completes commit 1's forward reference) ──

  describe('ctx.leads capability', () => {
    let runtime: PluginRuntimeService;

    beforeAll(() => {
      runtime = new PluginRuntimeService(new PluginSecretEncryptionService(), new ApplicantService(tenantPrisma, systemPrisma, new PanEncryptionService(), new CustomFieldsService(tenantPrisma, systemPrisma)), new CompanyService(tenantPrisma, systemPrisma), inquiryService);
    });

    function makePlugin(capabilities: Plugin['manifest']['capabilities']): Plugin {
      return {
        manifest: {
          id: 'lead-capability-test',
          name: 'test',
          version: '1.0.0',
          kind: 'lead-source',
          coreApiVersion: '^1.0.0',
          description: 'test',
          configSchema: z.object({}),
          configFields: [],
          capabilities,
        },
        hooks: {},
      };
    }

    it('accessing ctx.leads without declaring leads.create throws PluginCapabilityError', () => {
      const ctx = runtime.buildContext(makePlugin([]), fx.companyId, {});
      expect(() => ctx.leads).toThrow(PluginCapabilityError);
      expect(() => ctx.leads).toThrow(/leads\.create/);
    });

    it('declaring leads.create makes ctx.leads.create() functional against the real dedup path', async () => {
      const ctx = runtime.buildContext(makePlugin(['leads.create']), fx.companyId, {});
      const phone = uniquePhone();
      const result = await ctx.leads!.create({ name: 'Via Plugin', phone });
      expect(result.applicantId).toBeTruthy();
      const applicant = await systemPrisma.applicant.findUnique({ where: { id: result.applicantId } });
      expect(applicant.name).toBe('Via Plugin');
    });
  });

  // ── LeadApiKeyService ──────────────────────────────────────────

  describe('LeadApiKeyService', () => {
    it('create() returns the raw key exactly once; the stored row never contains it', async () => {
      const created = await leadApiKeyService.create(fx.companyId, { name: 'Test Vendor', fieldMapping: { name: 'lead.name', phone: 'lead.phone' }, rateLimitPerMinute: 60 }, fx.userId);
      expect(created.rawKey).toMatch(/^oe_live_/);

      const row = await systemPrisma.leadSourceApiKey.findUnique({ where: { id: created.id } });
      expect(row.keyHash).not.toBe(created.rawKey);
      expect(JSON.stringify(row)).not.toContain(created.rawKey);
    });

    it('list() never returns keyHash', async () => {
      await leadApiKeyService.create(fx.companyId, { name: 'Test Vendor 2', fieldMapping: { name: 'a', phone: 'b' }, rateLimitPerMinute: 60 }, fx.userId);
      const list = await leadApiKeyService.list(fx.companyId);
      expect(list.every((k) => !('keyHash' in k))).toBe(true);
    });

    it('disable() deactivates the key', async () => {
      const created = await leadApiKeyService.create(fx.companyId, { name: 'ToDisable', fieldMapping: { name: 'a', phone: 'b' }, rateLimitPerMinute: 60 }, fx.userId);
      await leadApiKeyService.disable(fx.companyId, created.id);
      const row = await systemPrisma.leadSourceApiKey.findUnique({ where: { id: created.id } });
      expect(row.isActive).toBe(false);
    });
  });

  // ── LeadInboundController field-mapping resolution (direct call — the
  //    validation logic here is hand-rolled in the controller method
  //    itself, not a zod DTO pipe, so a direct call exercises the real
  //    logic; the through-the-wire proof lives in e2e-webhooks-leads.test.ts. ──

  describe('LeadInboundController field-mapping resolution', () => {
    function makeReq(leadApiKey: { id: string; companyId: string; fieldMapping: Record<string, string>; rateLimitPerMinute: number }) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { leadApiKey } as any;
    }

    it('a well-formed payload matching the field mapping creates a real inquiry', async () => {
      const phone = uniquePhone();
      const req = makeReq({ id: 'k1', companyId: fx.companyId, fieldMapping: { name: 'lead.full_name', phone: 'lead.mobile' }, rateLimitPerMinute: 60 });
      const body = { lead: { full_name: 'Field Mapped Lead', mobile: phone } };

      const result = await inboundController.inbound(body, req);
      expect(result.applicantId).toBeTruthy();
    });

    it('a payload missing the required "phone" path produces the specific 400 message naming the field and path', async () => {
      const req = makeReq({ id: 'k1', companyId: fx.companyId, fieldMapping: { name: 'lead.full_name', phone: 'lead.mobile' }, rateLimitPerMinute: 60 });
      const body = { lead: { full_name: 'No Phone Here' } }; // lead.mobile missing

      await expect(inboundController.inbound(body, req)).rejects.toThrow(BadRequestException);
      await expect(inboundController.inbound(body, req)).rejects.toThrow(/Could not resolve required field 'phone' at path 'lead\.mobile'/);
    });

    it('a payload with an empty-string value at the required path is treated as missing, not a valid empty lead', async () => {
      const req = makeReq({ id: 'k1', companyId: fx.companyId, fieldMapping: { name: 'lead.full_name', phone: 'lead.mobile' }, rateLimitPerMinute: 60 });
      const body = { lead: { full_name: 'Empty Phone', mobile: '' } };
      await expect(inboundController.inbound(body, req)).rejects.toThrow(/Could not resolve required field 'phone'/);
    });

    it('optional fields (email, projectId, note) are included only when present at their mapped path', async () => {
      const phone = uniquePhone();
      const req = makeReq({
        id: 'k1',
        companyId: fx.companyId,
        fieldMapping: { name: 'lead.full_name', phone: 'lead.mobile', email: 'lead.email_id' },
        rateLimitPerMinute: 60,
      });
      const body = { lead: { full_name: 'With Email', mobile: phone, email_id: 'lead@example.com' } };

      const result = await inboundController.inbound(body, req);
      const applicant = await systemPrisma.applicant.findUnique({ where: { id: result.applicantId } });
      expect(applicant.email).toBe('lead@example.com');
    });
  });
});
