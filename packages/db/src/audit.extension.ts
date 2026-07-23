import { Prisma } from '@prisma/client';
import {
  tenantTxContext,
  getCurrentCompanyId,
  getCurrentUserId,
  getCurrentIpAddress,
} from './tenant-context';

const AUDITED_MODELS = new Set([
  'User',
  'Role',
  'RolePermission',
  'Company',
  'CompanyConfig',
  'CustomFieldDefinition',
  'InquirySource',
  'InquiryType',
  'FollowUpType',
  'CommunicationType',
  'AreaLocation',
  'ProjectType',
  'DocumentType',
  'LetterTemplate',
  'Bank',
  'ReceiptType',
  'RegistrationType',
  'ChargeType',
  'GstRate',
  'TdsRule',
  'InterestRule',
  'TransferFeeRule',
  'PaymentPlanTemplate',
  'UnitType',
  'PlcType',
  'Project',
  'Tower',
  'Floor',
  'Unit',
  'UnitPlc',
  'UnitCharge',
  'UnitRateRevision',
  'UnitStatusChange',
  'Applicant',
  'ApplicantConsent',
  'ApplicantMerge',
  'InquiryTemperature',
  'Inquiry',
  'InquiryAssignment',
  'ProjectAssignmentPool',
  'FollowUp',
  'SmsTemplate',
  'CommunicationLog',
  // Phase 4: audit the high-level financial ENTITIES. The low-level ledger
  // mechanism rows (LedgerEntry, ReceiptAllocation, BookingCostLine,
  // InterestAccrual, ChequeStatusEvent, TdsDeduction, NumberSequence) are
  // intentionally NOT audited here — they ARE the append-only financial
  // record (DB-trigger-enforced), so mirroring each into audit_logs is pure
  // noise and would balloon under the property tests.
  'CancellationRule',
  'ApplicantAddress',
  'ApplicantDocument',
  'Booking',
  'BookingCoApplicant',
  'PaymentPlan',
  'Receipt',
  'Transfer',
  'Cancellation',
  'Refund',
  'PaymentVoucher',
  'ExtraCharge',
  'TdsCertificate',
  'PaymentPlanMilestone',
  'GeneratedDocument',
  'DocumentDispatch',
  // Phase 5: audit the high-level broker/commission ENTITIES (same split
  // as Phase 4's ledger mechanism vs. entity distinction above).
  // CommissionLedgerEntry is NOT audited — it IS the append-only
  // financial record (DB-trigger-enforced), mirroring it would be pure
  // noise, same reasoning as LedgerEntry. BrokerBookingCommission is NOT
  // audited either — it's a system-computed snapshot (mechanism, like
  // NumberSequence), never edited by a human.
  'Broker',
  'BrokerBankDetail',
  'BrokerCommissionRule',
  'BrokerCommissionSlab',
  'CommissionPayment',
  'BrokerNoc',
  // Phase 6: audit the staff-accountable portal ENTITIES. TicketMessage
  // is NOT audited — same "it already IS the record of itself" reasoning
  // as ledger/message-thread mechanism rows elsewhere. PortalPasswordReset
  // is NOT audited — created by an async worker, not a staff/portal
  // action, and its tokenHash is security-sensitive metadata, not a
  // business fact.
  'ApplicantChangeRequest',
  'TicketCategory',
  'Ticket',
  'ConstructionUpdate',
  'ConstructionUpdateMedia',
  'PortalInvite',
  // Phase 7: plugin installation lifecycle is a staff-accountable
  // action, audited like any other admin config change. configCiphertext
  // is redacted below, same treatment as panCiphertext/tokenHash.
  'PluginInstallation',
]);

const SENSITIVE_FIELDS = new Set([
  'passwordHash',
  'password_hash',
  'totpSecret',
  'totp_secret',
  'recoveryCodes',
  'recovery_codes',
  // Phase 5: never let a broker's encrypted PAN land in an audit diff,
  // even in ciphertext form.
  'panCiphertext',
  'pan_ciphertext',
  // Phase 6: PortalInvite is audited (see AUDITED_MODELS) but its
  // tokenHash must never land in the diff, same reasoning as
  // passwordHash/totpSecret above.
  'tokenHash',
  'token_hash',
  // Phase 7: plugin config secrets (and, in a later commit, webhook
  // signing secrets and lead API key hashes) — same reasoning as
  // panCiphertext/tokenHash above: the encrypted blob itself is
  // redundant-but-safe to redact from audit diffs, keeps rows small and
  // honest.
  'configCiphertext',
  'config_ciphertext',
]);

function sanitize(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    out[k] = SENSITIVE_FIELDS.has(k) ? '[REDACTED]' : v;
  }
  return out;
}

function extractId(result: unknown): string {
  if (result && typeof result === 'object' && 'id' in result) {
    return String((result as Record<string, unknown>).id);
  }
  return 'unknown';
}

async function writeAuditRow(
  entityType: string,
  entityId: string,
  action: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  const store = tenantTxContext.getStore();
  if (!store?.tx) return;

  const companyId = getCurrentCompanyId() ?? null;
  const userId = getCurrentUserId() ?? null;
  const ipAddress = getCurrentIpAddress() ?? null;
  const beforeJson = before ? JSON.stringify(before) : null;
  const afterJson = after ? JSON.stringify(after) : null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (store.tx as any).$executeRaw`
    INSERT INTO audit_logs (id, company_id, user_id, entity_type, entity_id, action, before, after, ip_address, created_at)
    VALUES (
      gen_random_uuid(),
      ${companyId}::uuid,
      ${userId}::uuid,
      ${entityType},
      ${entityId},
      ${action},
      ${beforeJson}::jsonb,
      ${afterJson}::jsonb,
      ${ipAddress},
      NOW()
    )`;
}

/**
 * Prisma extension that writes an immutable audit row for every
 * create/update/delete on audited domain models.
 *
 * Audit rows are written via the same transaction client stored in
 * `tenantTxContext` — guaranteeing atomicity with the original
 * operation and inheriting the RLS session variable. If no tenant
 * transaction is active (e.g. system operations via the unscoped
 * client), the audit write is skipped here; system services are
 * responsible for writing their own audit rows via the system client.
 */
export function auditExtension() {
  return Prisma.defineExtension({
    query: {
      $allModels: {
        async create({ model, args, query }) {
          const result = await query(args);
          if (model && AUDITED_MODELS.has(model)) {
            try {
              await writeAuditRow(
                model,
                extractId(result),
                'CREATE',
                null,
                sanitize(result),
              );
            } catch {
              // audit failure must not break the main operation
            }
          }
          return result;
        },

        async update({ model, args, query }) {
          const result = await query(args);
          if (model && AUDITED_MODELS.has(model)) {
            try {
              await writeAuditRow(
                model,
                extractId(result),
                'UPDATE',
                null,
                sanitize(args.data),
              );
            } catch {
              // audit failure must not break the main operation
            }
          }
          return result;
        },

        async delete({ model, args, query }) {
          const result = await query(args);
          if (model && AUDITED_MODELS.has(model)) {
            try {
              await writeAuditRow(
                model,
                extractId(result),
                'DELETE',
                sanitize(result),
                null,
              );
            } catch {
              // audit failure must not break the main operation
            }
          }
          return result;
        },
      },
    },
  });
}
