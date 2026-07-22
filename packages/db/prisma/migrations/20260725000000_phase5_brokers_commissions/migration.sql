-- Phase 5: brokers and commissions. Run as the DB owner role
-- (superuser / table creator).
--
-- IMPORTANT: this file is HAND-WRITTEN, not `prisma migrate diff` output
-- verbatim, for the same reason every phase since Phase 4 has been:
-- Booking.brokerId, BrokerBookingCommission.bookingId,
-- CommissionLedgerEntry.bookingId, and BrokerNoc.bookingId/brokerId are
-- all scalar-only (no Prisma relation — see the "Relation policy" note in
-- schema.prisma), so a raw diff would try to DROP pre-existing FK
-- constraints on the immutable ledger-core tables it can't see the
-- relation for. This migration includes ONLY the genuinely new, additive
-- objects. See CLAUDE.md Phase 5 decisions for the full explanation.

-- ============================================================
-- 1. Enums
-- ============================================================

CREATE TYPE "CommissionEntryType" AS ENUM ('ACCRUAL', 'TDS_WITHHELD', 'PAYMENT', 'CLAWBACK_REVERSAL', 'CLAWBACK_RECOVERY', 'CLAWBACK_WRITEOFF');
CREATE TYPE "CommissionPaymentStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PAID', 'REJECTED');
CREATE TYPE "NocStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED');

-- GeneratedDocumentType (Phase 4-UI) gains a value for broker statements.
-- Safe outside a value-use in the same transaction (Postgres 12+ allows
-- ALTER TYPE ... ADD VALUE inside a transaction as long as the new value
-- isn't referenced until a later transaction — nothing below uses it).
ALTER TYPE "GeneratedDocumentType" ADD VALUE 'BROKER_STATEMENT';

-- ============================================================
-- 2. Additive columns on existing (frozen) tables
-- ============================================================

-- Booking.brokerId: scalar-only FK (relation policy), nullable — no
-- existing BookingService behavior changes; populated by a new Phase 5
-- endpoint after the booking already exists.
ALTER TABLE "bookings" ADD COLUMN "broker_id" UUID;

ALTER TABLE "company_configs" ADD COLUMN "commission_accrual_trigger" VARCHAR(30) NOT NULL DEFAULT 'ON_BOOKING';
ALTER TABLE "company_configs" ADD COLUMN "commission_clawback_policy" VARCHAR(20) NOT NULL DEFAULT 'RECOVER';

-- ============================================================
-- 3. Tables
-- ============================================================

CREATE TABLE "brokers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "email" VARCHAR(255),
    "rera_agent_no" VARCHAR(50),
    "pan_ciphertext" TEXT,
    "pan_masked" VARCHAR(15),
    "pan_key_version" SMALLINT NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deactivated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brokers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "broker_bank_details" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "broker_id" UUID NOT NULL,
    "account_holder" VARCHAR(255) NOT NULL,
    "account_number" VARCHAR(30) NOT NULL,
    "ifsc" VARCHAR(11) NOT NULL,
    "bank_name" VARCHAR(255) NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broker_bank_details_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "broker_commission_rules" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "broker_id" UUID NOT NULL,
    "project_id" UUID,
    "commission_type" VARCHAR(20) NOT NULL,
    "flat_percent" DECIMAL(5,2),
    "flat_paise" BIGINT,
    "milestones_json" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broker_commission_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "broker_commission_slabs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "from_paise" BIGINT NOT NULL,
    "to_paise" BIGINT,
    "rate_percent" DECIMAL(5,2) NOT NULL,

    CONSTRAINT "broker_commission_slabs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "broker_booking_commissions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "broker_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "total_commission_paise" BIGINT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broker_booking_commissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "commission_ledger_entries" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "broker_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "entry_type" "CommissionEntryType" NOT NULL,
    "signed_amount_paise" BIGINT NOT NULL,
    "milestone_percent" INTEGER,
    "reversal_of_entry_id" UUID,
    "reason" VARCHAR(500),
    "effective_date" DATE NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_ledger_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "commission_payments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "broker_id" UUID NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "status" "CommissionPaymentStatus" NOT NULL DEFAULT 'REQUESTED',
    "mode" "ReceiptMode",
    "bank_id" UUID,
    "instrument_number" VARCHAR(50),
    "approved_by_id" UUID,
    "approved_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_payments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "broker_nocs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "broker_id" UUID NOT NULL,
    "status" "NocStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" VARCHAR(500),
    "requested_by_id" UUID,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broker_nocs_pkey" PRIMARY KEY ("id")
);

-- ============================================================
-- 4. Unique constraints
-- ============================================================

ALTER TABLE "brokers" ADD CONSTRAINT "brokers_company_id_phone_key" UNIQUE ("company_id", "phone");
ALTER TABLE "broker_commission_slabs" ADD CONSTRAINT "broker_commission_slabs_rule_id_seq_key" UNIQUE ("rule_id", "seq");
ALTER TABLE "broker_booking_commissions" ADD CONSTRAINT "broker_booking_commissions_booking_id_key" UNIQUE ("booking_id");

-- ============================================================
-- 5. Indexes
-- ============================================================

CREATE INDEX "broker_bank_details_company_id_broker_id_idx" ON "broker_bank_details"("company_id", "broker_id");
CREATE INDEX "broker_commission_rules_company_id_broker_id_project_id_idx" ON "broker_commission_rules"("company_id", "broker_id", "project_id");
CREATE INDEX "commission_ledger_entries_company_id_broker_id_idx" ON "commission_ledger_entries"("company_id", "broker_id");
CREATE INDEX "commission_ledger_entries_company_id_booking_id_idx" ON "commission_ledger_entries"("company_id", "booking_id");
CREATE INDEX "commission_payments_company_id_broker_id_idx" ON "commission_payments"("company_id", "broker_id");
CREATE INDEX "broker_nocs_company_id_booking_id_idx" ON "broker_nocs"("company_id", "booking_id");

-- ============================================================
-- 6. Foreign keys — core relations (Prisma-declared)
-- ============================================================

ALTER TABLE "brokers" ADD CONSTRAINT "brokers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "broker_bank_details" ADD CONSTRAINT "broker_bank_details_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "broker_bank_details" ADD CONSTRAINT "broker_bank_details_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "broker_commission_rules" ADD CONSTRAINT "broker_commission_rules_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "broker_commission_rules" ADD CONSTRAINT "broker_commission_rules_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "broker_commission_slabs" ADD CONSTRAINT "broker_commission_slabs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "broker_commission_slabs" ADD CONSTRAINT "broker_commission_slabs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "broker_commission_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "broker_booking_commissions" ADD CONSTRAINT "broker_booking_commissions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "broker_booking_commissions" ADD CONSTRAINT "broker_booking_commissions_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "commission_ledger_entries" ADD CONSTRAINT "commission_ledger_entries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commission_ledger_entries" ADD CONSTRAINT "commission_ledger_entries_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "commission_payments" ADD CONSTRAINT "commission_payments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commission_payments" ADD CONSTRAINT "commission_payments_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "broker_nocs" ADD CONSTRAINT "broker_nocs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- 7. Foreign keys — scalar master/booking/user references
--    (hand-authored, same "relation policy" as the Phase 4 ledger core:
--    no Prisma relation declared, but referential integrity still
--    enforced here)
-- ============================================================

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "broker_commission_rules" ADD CONSTRAINT "broker_commission_rules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "broker_booking_commissions" ADD CONSTRAINT "broker_booking_commissions_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "broker_booking_commissions" ADD CONSTRAINT "broker_booking_commissions_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "broker_commission_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "commission_ledger_entries" ADD CONSTRAINT "commission_ledger_entries_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "commission_ledger_entries" ADD CONSTRAINT "commission_ledger_entries_reversal_of_entry_id_fkey" FOREIGN KEY ("reversal_of_entry_id") REFERENCES "commission_ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "commission_ledger_entries" ADD CONSTRAINT "commission_ledger_entries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "commission_payments" ADD CONSTRAINT "commission_payments_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "commission_payments" ADD CONSTRAINT "commission_payments_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "commission_payments" ADD CONSTRAINT "commission_payments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "broker_nocs" ADD CONSTRAINT "broker_nocs_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "broker_nocs" ADD CONSTRAINT "broker_nocs_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "broker_nocs" ADD CONSTRAINT "broker_nocs_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "broker_nocs" ADD CONSTRAINT "broker_nocs_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- 8. Append-only enforcement for commission_ledger_entries
--    (reuses the EXISTING forbid_financial_mutation() function created in
--    the Phase 4 migration — not redefined here)
-- ============================================================

CREATE TRIGGER commission_ledger_entries_no_update BEFORE UPDATE ON "commission_ledger_entries" FOR EACH ROW EXECUTE FUNCTION forbid_financial_mutation();
CREATE TRIGGER commission_ledger_entries_no_delete BEFORE DELETE ON "commission_ledger_entries" FOR EACH ROW EXECUTE FUNCTION forbid_financial_mutation();

-- ============================================================
-- 9. Row-Level Security for the 8 new tables
-- ============================================================

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'brokers', 'broker_bank_details', 'broker_commission_rules',
      'broker_commission_slabs', 'broker_booking_commissions',
      'commission_ledger_entries', 'commission_payments', 'broker_nocs'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_policy ON %I
         FOR ALL
         USING (company_id = current_setting(''app.current_company_id'', true)::uuid)
         WITH CHECK (company_id = current_setting(''app.current_company_id'', true)::uuid)',
      tbl
    );
  END LOOP;
END
$$;

-- ============================================================
-- 10. Grants
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openestate_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openestate_system;
