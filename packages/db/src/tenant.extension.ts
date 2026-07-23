import { Prisma, PrismaClient } from '@prisma/client';
import {
  getCurrentCompanyId,
  getCurrentPortalApplicantId,
  getCurrentPortalBrokerId,
  tenantContext,
  tenantTxContext,
} from './tenant-context';

const TENANT_SCOPED_MODELS = new Set([
  'User',
  'Role',
  'AuditLog',
  'CustomFieldDefinition',
  'CompanyConfig',
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
  'ApplicantAddress',
  'ApplicantDocument',
  'CancellationRule',
  'Booking',
  'BookingCoApplicant',
  'BookingCostLine',
  'PaymentPlan',
  'Installment',
  'LedgerEntry',
  'Receipt',
  'ReceiptAllocation',
  'ChequeStatusEvent',
  'NumberSequence',
  'Transfer',
  'Cancellation',
  'Refund',
  'PaymentVoucher',
  'ExtraCharge',
  'TdsDeduction',
  'TdsCertificate',
  'InterestAccrual',
  'PaymentPlanMilestone',
  'GeneratedDocument',
  'DocumentDispatch',
  'BookingDraft',
  'Broker',
  'BrokerBankDetail',
  'BrokerCommissionRule',
  'BrokerCommissionSlab',
  'BrokerBookingCommission',
  'CommissionLedgerEntry',
  'CommissionPayment',
  'BrokerNoc',
  'PortalInvite',
  'PortalPasswordReset',
  'ApplicantChangeRequest',
  'TicketCategory',
  'Ticket',
  'TicketMessage',
  'ConstructionUpdate',
  'ConstructionUpdateMedia',
  'PluginInstallation',
  'WebhookEndpoint',
  'WebhookDelivery',
  'WebhookDeliveryAttempt',
  'LeadSourceApiKey',
]);

const READ_OPS = new Set([
  'findMany',
  'findFirst',
  'findUnique',
  'findFirstOrThrow',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

const WRITE_FILTER_OPS = new Set([
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phase 6: JS-level portal-scope guard, deliberately scoped to
 * DIRECT-COLUMN models only (see CLAUDE.md Phase 6 decisions) — not
 * attempted for models reachable only via a joined bookingId
 * (Installment, Receipt, PaymentPlan, LedgerEntry, ...), where RLS is
 * the sole DB-adjacent enforcement. This is an additional
 * defense-in-depth narrowing on top of RLS, not a replacement for it.
 *
 * Inclusion criterion (tightened after a real bug — Phase 6 commit 2,
 * see CLAUDE.md Decisions log): a model belongs here ONLY if its portal
 * RLS predicate is a single direct-column equality (or two, one per
 * portal principal type — applicant and broker). Any model whose RLS
 * predicate has a subquery, EXISTS, or multi-hop branch (a co-applicant
 * carve-out, a booking-reachability check, etc.) must NOT be mirrored
 * here — RLS is the sole enforcement for those. Mirroring a complex
 * predicate PARTIALLY (matching only its simple branches) doesn't just
 * under-narrow safely, it actively DENIES access RLS legitimately
 * grants through the branch that got left out — Booking and
 * GeneratedDocument were both removed from this map for exactly that
 * reason, not for the "no unscoped company-wide read" reasoning that
 * still applies to every model still listed below.
 *
 * `brokerIsSelf: true` means the model's OWN `id` is the scope (Broker
 * reading its own row), not a foreign-key field.
 */
const PORTAL_SCOPED_MODELS: Record<string, { applicantField?: string; brokerField?: string; brokerIsSelf?: true }> = {
  CommissionLedgerEntry: { brokerField: 'brokerId' },
  CommissionPayment: { brokerField: 'brokerId' },
  BrokerNoc: { brokerField: 'brokerId' },
  Broker: { brokerIsSelf: true },
  ApplicantChangeRequest: { applicantField: 'applicantId' },
  Ticket: { applicantField: 'applicantId', brokerField: 'brokerId' },
};

/**
 * Prisma client extension enforcing tenant isolation (defence-in-depth).
 *
 * For every query on a tenant-scoped model the extension:
 *  - throws if no companyId is in AsyncLocalStorage (no exemptions)
 *  - injects companyId into where/data clauses
 *
 * This layer operates on top of Postgres RLS. Even if RLS were somehow
 * misconfigured, the Prisma-level filter prevents cross-tenant access.
 *
 * The extension does NOT handle SET LOCAL — that is the responsibility
 * of `withTenantTx`, which wraps the data-access unit of work in a
 * Prisma interactive transaction with set_config().
 */
export function tenantExtension() {
  return Prisma.defineExtension((client) => {
    return client.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (!model || !TENANT_SCOPED_MODELS.has(model)) {
              return query(args);
            }

            const companyId = getCurrentCompanyId();

            if (!companyId) {
              throw new Error(
                `Tenant context required for ${model}.${operation}`,
              );
            }

            if (!UUID_RE.test(companyId)) {
              throw new Error('Invalid company ID format');
            }

            injectCompanyId(operation, args, companyId);
            injectPortalScope(model, operation, args);

            return query(args);
          },
        },
      },
    });
  });
}

function injectCompanyId(
  operation: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>,
  companyId: string,
): void {
  if (READ_OPS.has(operation) || WRITE_FILTER_OPS.has(operation)) {
    args.where = { ...args.where, companyId };
  }

  if (operation === 'create') {
    args.data = { ...args.data, companyId };
  }

  if (operation === 'createMany') {
    if (Array.isArray(args.data)) {
      args.data = args.data.map((d: Record<string, unknown>) => ({
        ...d,
        companyId,
      }));
    } else {
      args.data = { ...args.data, companyId };
    }
  }

  if (operation === 'upsert') {
    args.where = { ...args.where, companyId };
    args.create = { ...args.create, companyId };
  }
}

/**
 * Phase 6 defense-in-depth: for the DIRECT-COLUMN models in
 * PORTAL_SCOPED_MODELS, narrows READ_OPS/WRITE_FILTER_OPS's `where`
 * with an additional AND'd condition when a portal scope is active. A
 * no-op for every other model, and a no-op entirely when no portal
 * scope is set (staff/system queries are unaffected). See the
 * PORTAL_SCOPED_MODELS doc comment for why this intentionally does NOT
 * replicate RLS's co-applicant carve-out.
 *
 * Merges the scope clause as an ADDITIONAL top-level `AND` key (spreading
 * the rest of `args.where` unchanged) rather than wrapping the whole
 * `where` inside a fresh `{ AND: [originalWhere, scopeClause] }` — the
 * latter buries any top-level unique field (e.g. `id`) one level deep
 * inside `AND[0]`, and Prisma's `update()`/`delete()` require at least
 * one unique field to be a TOP-LEVEL key of `where`, not nested inside
 * an `AND` array. This was a real bug (a `PrismaClientValidationError`,
 * not a silent bypass — caught immediately, but only because
 * NocService.approve()/reject() were the first WRITE_FILTER_OPS call on
 * a PORTAL_SCOPED_MODELS entry ever exercised with an ACTIVE portal
 * scope — every prior portal-facing write in Phase 6 commit 2 happened
 * to run through non-unique `updateMany`-shaped services or with no
 * portal scope active at all, so the bug shipped undetected until
 * broker-portal.test.ts's IDOR test forced the real code path). Spreads
 * `...args.where` first so `id`/`companyId` (already injected by
 * injectCompanyId above) stay top-level; any pre-existing `AND` array on
 * the caller's own where is preserved and extended, never overwritten.
 */
function injectPortalScope(
  model: string | undefined,
  operation: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>,
): void {
  if (!model || !(READ_OPS.has(operation) || WRITE_FILTER_OPS.has(operation))) return;

  const config = PORTAL_SCOPED_MODELS[model];
  if (!config) return;

  const portalApplicantId = getCurrentPortalApplicantId();
  const portalBrokerId = getCurrentPortalBrokerId();
  if (!portalApplicantId && !portalBrokerId) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scopeClauses: Record<string, any>[] = [];
  if (portalApplicantId && config.applicantField) {
    scopeClauses.push({ [config.applicantField]: portalApplicantId });
  }
  if (portalBrokerId && config.brokerField) {
    scopeClauses.push({ [config.brokerField]: portalBrokerId });
  }
  if (portalBrokerId && config.brokerIsSelf) {
    scopeClauses.push({ id: portalBrokerId });
  }
  if (scopeClauses.length === 0) return;

  const existingWhere = args.where ?? {};
  const existingAnd = existingWhere.AND;
  const existingAndArray = existingAnd ? (Array.isArray(existingAnd) ? existingAnd : [existingAnd]) : [];

  args.where = {
    ...existingWhere,
    AND: [...existingAndArray, { OR: scopeClauses }],
  };
}

/**
 * Sets `app.current_company_id`, `app.portal_applicant_id`, and
 * `app.portal_broker_id` as transaction-local variables via Postgres
 * `set_config(name, value, is_local)`. The function form accepts
 * parameterised binding (safe from injection). The third argument
 * `true` makes each setting transaction-scoped, equivalent to SET
 * LOCAL — it resets automatically when the transaction ends.
 *
 * GUC hygiene is unconditional (Phase 6 decisions): all three are
 * ALWAYS written, every call, never conditionally skipped — a staff
 * session passes `undefined` for the portal args, which is written as
 * `''`, not "left unset". `NULLIF(current_setting(...), '')` on the RLS
 * side treats "never set" and "explicitly cleared to ''" identically,
 * so this is safe by construction: there is no code path where a stale
 * portal scope from a previous transaction on a pooled connection could
 * silently persist into one that doesn't explicitly pass it.
 */
export async function setTenantOnTx(
  tx: Prisma.TransactionClient,
  companyId: string,
  portalApplicantId?: string,
  portalBrokerId?: string,
): Promise<void> {
  if (!UUID_RE.test(companyId)) {
    throw new Error('Invalid company ID format');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (tx as any).$executeRaw`
    SELECT set_config('app.current_company_id', ${companyId}::text, true),
           set_config('app.portal_applicant_id', ${portalApplicantId ?? ''}::text, true),
           set_config('app.portal_broker_id', ${portalBrokerId ?? ''}::text, true)
  `;
}

export interface WithTenantTxOptions {
  /** Prisma interactive-transaction timeout in ms (default 10 000). */
  timeout?: number;
}

/**
 * Wraps a unit of data-access work in a Prisma interactive transaction
 * with the tenant session variable set. Guarantees SET LOCAL and all
 * queries share the same pooled Postgres connection.
 *
 * **Nesting behaviour:**
 *  - Same companyId → reuses the outer transaction (no new connection).
 *  - Different companyId → throws immediately.
 *
 * **Important:** Do NOT perform external I/O (HTTP calls, SMS, email,
 * file-storage writes) inside the callback. The interactive transaction
 * holds a connection from the pool for its entire duration; blocking on
 * network I/O starves the pool. Move external calls outside
 * `withTenantTx` and pass their results in.
 */
export async function withTenantTx<T>(
  prisma: PrismaClient,
  companyId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: WithTenantTxOptions,
): Promise<T> {
  if (!UUID_RE.test(companyId)) {
    throw new Error('Invalid company ID format');
  }

  const existing = tenantTxContext.getStore();

  if (existing) {
    if (existing.companyId !== companyId) {
      throw new Error(
        `Cannot nest withTenantTx with different company IDs ` +
          `(outer=${existing.companyId}, inner=${companyId})`,
      );
    }
    return fn(existing.tx);
  }

  // Picks up the ambient portal scope (if any) from the ENCLOSING
  // runWithTenant call automatically — no changes needed at any of
  // this function's ~50+ existing call sites across the codebase. A
  // staff request's TenantStore always has both fields explicitly
  // undefined (see tenant-context.ts), so this resolves to "write
  // empty string" for staff, matching setTenantOnTx's unconditional
  // hygiene contract.
  const ambientStore = tenantContext.getStore();

  return prisma.$transaction(
    async (tx) => {
      await setTenantOnTx(tx, companyId, ambientStore?.portalApplicantId, ambientStore?.portalBrokerId);
      return tenantTxContext.run({ tx, companyId }, () => fn(tx));
    },
    { timeout: options?.timeout ?? 10_000 },
  );
}
