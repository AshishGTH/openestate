import { Module } from '@nestjs/common';
import { z } from 'zod';
import { INTEREST_RATE_TYPE } from '@openestate/shared';
import { createMasterModule } from './master.factory';
import { GstRateModule } from './gst-rate/gst-rate.module';
import { TdsRuleModule } from './tds-rule/tds-rule.module';
import { SmsTemplateModule } from './sms-template/sms-template.module';
import { LetterTemplateModule } from './letter-template/letter-template.module';

const SIMPLE_MASTERS = [
  { modelName: 'UnitType', routePath: 'unit-types', apiTag: 'Unit Types' },
  { modelName: 'PlcType', routePath: 'plc-types', apiTag: 'PLC Types' },
  { modelName: 'InquirySource', routePath: 'inquiry-sources', apiTag: 'Inquiry Sources' },
  { modelName: 'InquiryType', routePath: 'inquiry-types', apiTag: 'Inquiry Types' },
  { modelName: 'InquiryTemperature', routePath: 'inquiry-temperatures', apiTag: 'Inquiry Temperatures' },
  { modelName: 'FollowUpType', routePath: 'follow-up-types', apiTag: 'Follow-Up Types' },
  { modelName: 'CommunicationType', routePath: 'communication-types', apiTag: 'Communication Types' },
  { modelName: 'ProjectType', routePath: 'project-types', apiTag: 'Project Types' },
  { modelName: 'ReceiptType', routePath: 'receipt-types', apiTag: 'Receipt Types' },
  { modelName: 'RegistrationType', routePath: 'registration-types', apiTag: 'Registration Types' },
  { modelName: 'AreaLocation', routePath: 'area-locations', apiTag: 'Area Locations' },
  // DocumentType.entityType is a required Prisma column (free-text label,
  // not read by any business logic — confirmed by grep — so no enum to
  // validate against beyond "non-empty").
  { modelName: 'DocumentType', routePath: 'document-types', apiTag: 'Document Types', extraFields: { entityType: z.string().min(1).max(50) } },
  { modelName: 'Bank', routePath: 'banks', apiTag: 'Banks' },
  // gstRateId/hsnSac are real Prisma columns the generic schema never
  // exposed (docs/todo.md). GST genuinely varies by charge type (IFMS,
  // legal charges, and statutory pass-throughs don't all follow the base
  // sale rate) — see booking.service.ts's cost-line loop for how an unset
  // gstRateId here falls back to the booking's base line, never silently
  // zero-rates.
  {
    modelName: 'ChargeType', routePath: 'charge-types', apiTag: 'Charge Types',
    extraFields: {
      gstRateId: z.string().uuid().optional(),
      hsnSac: z.string().max(20).optional(),
    },
  },
  // InterestRule.rateType/ratePercent/frequency are all required, non-
  // nullable Prisma columns createMasterSchema never had. rateType
  // reuses InterestService's own INTEREST_RATE_TYPE enum (SIMPLE/
  // COMPOUND) so this can never drift from what the accrual engine
  // actually understands.
  {
    modelName: 'InterestRule', routePath: 'interest-rules', apiTag: 'Interest Rules',
    extraFields: {
      rateType: z.nativeEnum(INTEREST_RATE_TYPE),
      ratePercent: z.coerce.number().min(0).max(100),
      frequency: z.enum(['DAILY', 'MONTHLY', 'YEARLY']),
    },
  },
  // TransferFeeRule.feeType is required; TransferService reads the
  // literal 'FIXED' to decide between amountPaise/percentage.
  {
    modelName: 'TransferFeeRule', routePath: 'transfer-fee-rules', apiTag: 'Transfer Fee Rules',
    extraFields: {
      feeType: z.enum(['FIXED', 'PERCENTAGE']),
      amountPaise: z.coerce.bigint().min(0n).optional(),
      percentage: z.coerce.number().min(0).max(100).optional(),
    },
  },
  // The only SIMPLE_MASTERS model whose Prisma model actually has a
  // `description` column — see MasterModuleConfig.supportsDescription.
  { modelName: 'PaymentPlanTemplate', routePath: 'payment-plan-templates', apiTag: 'Payment Plan Templates', supportsDescription: true },
  { modelName: 'TicketCategory', routePath: 'ticket-categories', apiTag: 'Ticket Categories' },
  // LetterTemplate is NOT here — its Prisma model requires subject/body/
  // entityType with merge-field validation (not just "field present"),
  // which the generic extraFields mechanism above doesn't cover; it has
  // its own dedicated module (mirroring SmsTemplateModule's existing
  // precedent).
] as const;

const simpleMasterModules = SIMPLE_MASTERS.map((config) =>
  createMasterModule(config),
);

@Module({
  imports: [...simpleMasterModules, GstRateModule, TdsRuleModule, SmsTemplateModule, LetterTemplateModule],
})
export class MastersModule {}
