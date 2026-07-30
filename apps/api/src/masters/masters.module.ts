import { Module } from '@nestjs/common';
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
  { modelName: 'DocumentType', routePath: 'document-types', apiTag: 'Document Types' },
  { modelName: 'LetterTemplate', routePath: 'letter-templates', apiTag: 'Letter Templates' },
  { modelName: 'Bank', routePath: 'banks', apiTag: 'Banks' },
  { modelName: 'ChargeType', routePath: 'charge-types', apiTag: 'Charge Types' },
  { modelName: 'InterestRule', routePath: 'interest-rules', apiTag: 'Interest Rules' },
  { modelName: 'TransferFeeRule', routePath: 'transfer-fee-rules', apiTag: 'Transfer Fee Rules' },
  // The only SIMPLE_MASTERS model whose Prisma model actually has a
  // `description` column — see MasterModuleConfig.supportsDescription.
  { modelName: 'PaymentPlanTemplate', routePath: 'payment-plan-templates', apiTag: 'Payment Plan Templates', supportsDescription: true },
  { modelName: 'TicketCategory', routePath: 'ticket-categories', apiTag: 'Ticket Categories' },
  // LetterTemplate is NOT here — its Prisma model requires subject/body/
  // entityType, which createMasterSchema doesn't provide at all (a 500,
  // not a validation error, for every create attempt); it has its own
  // module (mirroring SmsTemplateModule's existing precedent for masters
  // that need fields beyond name/description/isActive/sortOrder).
] as const;

const simpleMasterModules = SIMPLE_MASTERS.map((config) =>
  createMasterModule(config),
);

@Module({
  imports: [...simpleMasterModules, GstRateModule, TdsRuleModule, SmsTemplateModule, LetterTemplateModule],
})
export class MastersModule {}
