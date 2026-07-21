import { Prisma, PrismaClient } from '@prisma/client';
import { getCurrentCompanyId, tenantTxContext } from './tenant-context';

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
 * Sets `app.current_company_id` as a transaction-local variable via
 * Postgres `set_config(name, value, is_local)`. The function form
 * accepts parameterised binding (safe from injection). The third
 * argument `true` makes the setting transaction-scoped, equivalent to
 * SET LOCAL — it resets automatically when the transaction ends.
 */
export async function setTenantOnTx(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<void> {
  if (!UUID_RE.test(companyId)) {
    throw new Error('Invalid company ID format');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (tx as any)
    .$executeRaw`SELECT set_config('app.current_company_id', ${companyId}::text, true)`;
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

  return prisma.$transaction(
    async (tx) => {
      await setTenantOnTx(tx, companyId);
      return tenantTxContext.run({ tx, companyId }, () => fn(tx));
    },
    { timeout: options?.timeout ?? 10_000 },
  );
}
