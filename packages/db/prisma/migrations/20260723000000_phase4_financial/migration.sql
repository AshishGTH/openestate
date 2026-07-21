-- Phase 4: Financial core — bookings, ledger, receipts, GST/TDS, interest, transfer, cancellation.
-- Run as the DB owner role (superuser / table creator).

-- CreateEnum
CREATE TYPE "AddressType" AS ENUM ('OFFICE', 'PERMANENT', 'PRESENT');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('APPLICATION', 'BOOKED', 'ALLOTTED', 'REGISTERED', 'CANCELLED', 'SURRENDERED', 'TRANSFERRED_OUT');

-- CreateEnum
CREATE TYPE "CostLineKind" AS ENUM ('BASE', 'PLC', 'PARKING', 'CLUB', 'MAINTENANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "InstallmentStatus" AS ENUM ('UNPAID', 'PART_PAID', 'PAID');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('CHARGE', 'EXTRA_CHARGE', 'RECEIPT_ALLOC', 'INTEREST', 'INTEREST_WAIVER', 'BOUNCE_REVERSAL', 'BOUNCE_CHARGE', 'REFUND_APPROVED', 'REFUND_BOUNCE_REVERSAL', 'TRANSFER_CARRY_OUT', 'TRANSFER_CARRY_IN', 'TRANSFER_FEE', 'CANCELLATION_SETTLEMENT', 'CANCELLATION_DEDUCTION', 'TDS_RECEIVABLE', 'TDS_CERT_ADJUSTMENT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "ReceiptMode" AS ENUM ('CASH', 'CHEQUE', 'DD', 'NEFT', 'RTGS', 'UPI', 'CARD');

-- CreateEnum
CREATE TYPE "ChequeClearanceStatus" AS ENUM ('NOT_APPLICABLE', 'RECEIVED', 'DEPOSITED', 'CLEARED', 'BOUNCED');

-- CreateEnum
CREATE TYPE "TransferType" AS ENUM ('UNIT', 'APPLICANT');

-- CreateEnum
CREATE TYPE "CancellationType" AS ENUM ('CANCEL', 'SURRENDER');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PAID', 'REJECTED');

-- CreateEnum
CREATE TYPE "VoucherStatus" AS ENUM ('ISSUED', 'CLEARED', 'BOUNCED');

-- AlterTable
ALTER TABLE "applicants" ADD COLUMN     "pan_ciphertext" TEXT,
ADD COLUMN     "pan_key_version" SMALLINT NOT NULL DEFAULT 1,
ADD COLUMN     "pan_masked" VARCHAR(15);

-- AlterTable
ALTER TABLE "area_locations" ADD COLUMN     "state_code" VARCHAR(2);

-- AlterTable
ALTER TABLE "company_configs" ADD COLUMN     "cheque_bounce_charge_paise" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "company_gstin" VARCHAR(15),
ADD COLUMN     "gst_state_code" VARCHAR(2);

-- CreateTable
CREATE TABLE "payment_plan_milestones" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "percent" DECIMAL(6,3) NOT NULL,
    "due_offset_days" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_plan_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applicant_addresses" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "applicant_id" UUID NOT NULL,
    "address_type" "AddressType" NOT NULL,
    "line1" VARCHAR(255) NOT NULL,
    "line2" VARCHAR(255),
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "state_code" VARCHAR(2),
    "pincode" VARCHAR(10),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applicant_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applicant_documents" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "applicant_id" UUID NOT NULL,
    "document_type_id" UUID,
    "stored_name" VARCHAR(255) NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applicant_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancellation_rules" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "deduction_type" VARCHAR(20) NOT NULL,
    "deduction_percent" DECIMAL(5,2),
    "deduction_amount_paise" BIGINT,
    "forfeit_booking_amount" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cancellation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "primary_applicant_id" UUID NOT NULL,
    "booking_number" VARCHAR(40) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'APPLICATION',
    "agreed_price_paise" BIGINT NOT NULL,
    "place_of_supply_state_code" VARCHAR(2),
    "payment_plan_template_id" UUID,
    "interest_rule_id" UUID,
    "booking_date" DATE NOT NULL,
    "allotment_date" DATE,
    "registration_date" DATE,
    "cancelled_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_co_applicants" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "applicant_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL DEFAULT 2,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_co_applicants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_cost_lines" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "kind" "CostLineKind" NOT NULL,
    "charge_type_id" UUID,
    "label" VARCHAR(255) NOT NULL,
    "base_amount_paise" BIGINT NOT NULL,
    "gst_rate_id" UUID,
    "gst_rate_percent_snapshot" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cgst_paise" BIGINT NOT NULL DEFAULT 0,
    "sgst_paise" BIGINT NOT NULL DEFAULT 0,
    "igst_paise" BIGINT NOT NULL DEFAULT 0,
    "line_total_paise" BIGINT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_cost_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_plans" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "template_id" UUID,
    "name" VARCHAR(255) NOT NULL,
    "is_custom" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "due_date" DATE NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "milestone_percent" DECIMAL(6,3),
    "allocated_paise" BIGINT NOT NULL DEFAULT 0,
    "status" "InstallmentStatus" NOT NULL DEFAULT 'UNPAID',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "entry_type" "LedgerEntryType" NOT NULL,
    "signed_amount_paise" BIGINT NOT NULL,
    "installment_id" UUID,
    "receipt_id" UUID,
    "reversal_of_entry_id" UUID,
    "reason" VARCHAR(500),
    "effective_date" DATE NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "receipt_number" VARCHAR(40) NOT NULL,
    "fy_label" VARCHAR(9) NOT NULL,
    "seq_value" INTEGER NOT NULL,
    "receipt_date" DATE NOT NULL,
    "mode" "ReceiptMode" NOT NULL,
    "gross_amount_paise" BIGINT NOT NULL,
    "receipt_type_id" UUID,
    "bank_id" UUID,
    "instrument_number" VARCHAR(50),
    "instrument_date" DATE,
    "utr" VARCHAR(50),
    "clearance_status" "ChequeClearanceStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "is_reversed" BOOLEAN NOT NULL DEFAULT false,
    "reversal_reason" VARCHAR(500),
    "reprint_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_allocations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "installment_id" UUID NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cheque_status_events" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "status" "ChequeClearanceStatus" NOT NULL,
    "event_date" DATE NOT NULL,
    "reason" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cheque_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_sequences" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "scope_label" VARCHAR(20) NOT NULL,
    "next_value" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "number_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "from_booking_id" UUID NOT NULL,
    "to_booking_id" UUID,
    "transfer_type" "TransferType" NOT NULL,
    "transfer_fee_rule_id" UUID,
    "transfer_fee_paise" BIGINT NOT NULL DEFAULT 0,
    "carry_forward_paise" BIGINT NOT NULL,
    "reason" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancellations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "cancellation_type" "CancellationType" NOT NULL,
    "cancellation_rule_id" UUID,
    "deduction_type_snapshot" VARCHAR(20) NOT NULL,
    "deduction_paise" BIGINT NOT NULL,
    "refundable_paise" BIGINT NOT NULL,
    "reason" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cancellations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "cancellation_id" UUID,
    "amount_paise" BIGINT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "mode" "ReceiptMode",
    "approved_by_id" UUID,
    "approved_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_vouchers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "refund_id" UUID,
    "amount_paise" BIGINT NOT NULL,
    "mode" "ReceiptMode" NOT NULL,
    "bank_id" UUID,
    "instrument_number" VARCHAR(50),
    "instrument_date" DATE,
    "status" "VoucherStatus" NOT NULL DEFAULT 'ISSUED',
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extra_charges" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "charge_type_id" UUID,
    "label" VARCHAR(255) NOT NULL,
    "base_amount_paise" BIGINT NOT NULL,
    "gst_rate_id" UUID,
    "gst_rate_percent_snapshot" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cgst_paise" BIGINT NOT NULL DEFAULT 0,
    "sgst_paise" BIGINT NOT NULL DEFAULT 0,
    "igst_paise" BIGINT NOT NULL DEFAULT 0,
    "line_total_paise" BIGINT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extra_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tds_deductions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "receipt_id" UUID,
    "section_snapshot" VARCHAR(20) NOT NULL,
    "rate_percent_snapshot" DECIMAL(5,2) NOT NULL,
    "deducted_paise" BIGINT NOT NULL,
    "receivable_ledger_entry_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tds_deductions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tds_certificates" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "tds_deduction_id" UUID NOT NULL,
    "certificate_number" VARCHAR(50) NOT NULL,
    "certificate_date" DATE NOT NULL,
    "adjustment_ledger_entry_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tds_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interest_accruals" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "installment_id" UUID,
    "interest_rule_id" UUID,
    "rate_type" VARCHAR(20) NOT NULL,
    "rate_percent_snapshot" DECIMAL(5,2) NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "principal_paise" BIGINT NOT NULL,
    "accrued_paise" BIGINT NOT NULL,
    "ledger_entry_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interest_accruals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_plan_milestones_template_id_seq_key" ON "payment_plan_milestones"("template_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "applicant_addresses_applicant_id_address_type_key" ON "applicant_addresses"("applicant_id", "address_type");

-- CreateIndex
CREATE INDEX "applicant_documents_company_id_applicant_id_idx" ON "applicant_documents"("company_id", "applicant_id");

-- CreateIndex
CREATE UNIQUE INDEX "cancellation_rules_company_id_name_key" ON "cancellation_rules"("company_id", "name");

-- CreateIndex
CREATE INDEX "bookings_company_id_status_idx" ON "bookings"("company_id", "status");

-- CreateIndex
CREATE INDEX "bookings_company_id_unit_id_idx" ON "bookings"("company_id", "unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_company_id_booking_number_key" ON "bookings"("company_id", "booking_number");

-- CreateIndex
CREATE UNIQUE INDEX "booking_co_applicants_booking_id_applicant_id_key" ON "booking_co_applicants"("booking_id", "applicant_id");

-- CreateIndex
CREATE INDEX "booking_cost_lines_company_id_booking_id_idx" ON "booking_cost_lines"("company_id", "booking_id");

-- CreateIndex
CREATE INDEX "payment_plans_company_id_booking_id_idx" ON "payment_plans"("company_id", "booking_id");

-- CreateIndex
CREATE INDEX "installments_company_id_booking_id_idx" ON "installments"("company_id", "booking_id");

-- CreateIndex
CREATE INDEX "installments_company_id_due_date_idx" ON "installments"("company_id", "due_date");

-- CreateIndex
CREATE INDEX "ledger_entries_company_id_booking_id_idx" ON "ledger_entries"("company_id", "booking_id");

-- CreateIndex
CREATE INDEX "ledger_entries_company_id_entry_type_idx" ON "ledger_entries"("company_id", "entry_type");

-- CreateIndex
CREATE INDEX "receipts_company_id_booking_id_idx" ON "receipts"("company_id", "booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_company_id_receipt_number_key" ON "receipts"("company_id", "receipt_number");

-- CreateIndex
CREATE INDEX "receipt_allocations_company_id_installment_id_idx" ON "receipt_allocations"("company_id", "installment_id");

-- CreateIndex
CREATE INDEX "cheque_status_events_company_id_receipt_id_created_at_idx" ON "cheque_status_events"("company_id", "receipt_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "number_sequences_company_id_kind_scope_label_key" ON "number_sequences"("company_id", "kind", "scope_label");

-- CreateIndex
CREATE INDEX "transfers_company_id_from_booking_id_idx" ON "transfers"("company_id", "from_booking_id");

-- CreateIndex
CREATE INDEX "cancellations_company_id_booking_id_idx" ON "cancellations"("company_id", "booking_id");

-- CreateIndex
CREATE INDEX "refunds_company_id_booking_id_idx" ON "refunds"("company_id", "booking_id");

-- CreateIndex
CREATE INDEX "payment_vouchers_company_id_booking_id_idx" ON "payment_vouchers"("company_id", "booking_id");

-- CreateIndex
CREATE INDEX "extra_charges_company_id_booking_id_idx" ON "extra_charges"("company_id", "booking_id");

-- CreateIndex
CREATE INDEX "tds_deductions_company_id_booking_id_idx" ON "tds_deductions"("company_id", "booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "tds_certificates_tds_deduction_id_key" ON "tds_certificates"("tds_deduction_id");

-- CreateIndex
CREATE INDEX "interest_accruals_company_id_booking_id_idx" ON "interest_accruals"("company_id", "booking_id");

-- CreateIndex
CREATE INDEX "interest_accruals_company_id_installment_id_period_end_idx" ON "interest_accruals"("company_id", "installment_id", "period_end");

-- AddForeignKey
ALTER TABLE "payment_plan_milestones" ADD CONSTRAINT "payment_plan_milestones_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_plan_milestones" ADD CONSTRAINT "payment_plan_milestones_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "payment_plan_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applicant_addresses" ADD CONSTRAINT "applicant_addresses_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applicant_addresses" ADD CONSTRAINT "applicant_addresses_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "applicants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applicant_documents" ADD CONSTRAINT "applicant_documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applicant_documents" ADD CONSTRAINT "applicant_documents_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "applicants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellation_rules" ADD CONSTRAINT "cancellation_rules_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_primary_applicant_id_fkey" FOREIGN KEY ("primary_applicant_id") REFERENCES "applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_co_applicants" ADD CONSTRAINT "booking_co_applicants_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_co_applicants" ADD CONSTRAINT "booking_co_applicants_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_co_applicants" ADD CONSTRAINT "booking_co_applicants_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_cost_lines" ADD CONSTRAINT "booking_cost_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_cost_lines" ADD CONSTRAINT "booking_cost_lines_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installments" ADD CONSTRAINT "installments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installments" ADD CONSTRAINT "installments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installments" ADD CONSTRAINT "installments_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "payment_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_reversal_of_entry_id_fkey" FOREIGN KEY ("reversal_of_entry_id") REFERENCES "ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_installment_id_fkey" FOREIGN KEY ("installment_id") REFERENCES "installments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cheque_status_events" ADD CONSTRAINT "cheque_status_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cheque_status_events" ADD CONSTRAINT "cheque_status_events_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_from_booking_id_fkey" FOREIGN KEY ("from_booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_to_booking_id_fkey" FOREIGN KEY ("to_booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_cancellation_id_fkey" FOREIGN KEY ("cancellation_id") REFERENCES "cancellations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_vouchers" ADD CONSTRAINT "payment_vouchers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_vouchers" ADD CONSTRAINT "payment_vouchers_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_vouchers" ADD CONSTRAINT "payment_vouchers_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extra_charges" ADD CONSTRAINT "extra_charges_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extra_charges" ADD CONSTRAINT "extra_charges_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tds_deductions" ADD CONSTRAINT "tds_deductions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tds_deductions" ADD CONSTRAINT "tds_deductions_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tds_deductions" ADD CONSTRAINT "tds_deductions_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tds_certificates" ADD CONSTRAINT "tds_certificates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tds_certificates" ADD CONSTRAINT "tds_certificates_tds_deduction_id_fkey" FOREIGN KEY ("tds_deduction_id") REFERENCES "tds_deductions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interest_accruals" ADD CONSTRAINT "interest_accruals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interest_accruals" ADD CONSTRAINT "interest_accruals_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- Phase 4 augmentation (hand-written): DB-level FKs for scalar
-- master/user references, append-only triggers, and RLS.
-- ============================================================

-- ── DB-level FK constraints for scalar references ───────────
-- These columns are plain UUID scalars in the Prisma schema (no Prisma
-- relation, to keep User and the master models free of dozens of
-- back-relations); their referential integrity is enforced here instead.
-- All ON DELETE SET NULL — users are soft-deleted and masters rarely
-- removed, so these never orphan in practice.

-- → users(id)
ALTER TABLE "applicant_documents" ADD CONSTRAINT "applicant_documents_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cheque_status_events" ADD CONSTRAINT "cheque_status_events_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_vouchers" ADD CONSTRAINT "payment_vouchers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "extra_charges" ADD CONSTRAINT "extra_charges_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tds_deductions" ADD CONSTRAINT "tds_deductions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tds_certificates" ADD CONSTRAINT "tds_certificates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- → master tables
ALTER TABLE "applicant_documents" ADD CONSTRAINT "applicant_documents_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_payment_plan_template_id_fkey" FOREIGN KEY ("payment_plan_template_id") REFERENCES "payment_plan_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "booking_cost_lines" ADD CONSTRAINT "booking_cost_lines_charge_type_id_fkey" FOREIGN KEY ("charge_type_id") REFERENCES "charge_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "booking_cost_lines" ADD CONSTRAINT "booking_cost_lines_gst_rate_id_fkey" FOREIGN KEY ("gst_rate_id") REFERENCES "gst_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "payment_plan_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_receipt_type_id_fkey" FOREIGN KEY ("receipt_type_id") REFERENCES "receipt_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_transfer_fee_rule_id_fkey" FOREIGN KEY ("transfer_fee_rule_id") REFERENCES "transfer_fee_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_cancellation_rule_id_fkey" FOREIGN KEY ("cancellation_rule_id") REFERENCES "cancellation_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_vouchers" ADD CONSTRAINT "payment_vouchers_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "extra_charges" ADD CONSTRAINT "extra_charges_charge_type_id_fkey" FOREIGN KEY ("charge_type_id") REFERENCES "charge_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "extra_charges" ADD CONSTRAINT "extra_charges_gst_rate_id_fkey" FOREIGN KEY ("gst_rate_id") REFERENCES "gst_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "interest_accruals" ADD CONSTRAINT "interest_accruals_interest_rule_id_fkey" FOREIGN KEY ("interest_rule_id") REFERENCES "interest_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_interest_rule_id_fkey" FOREIGN KEY ("interest_rule_id") REFERENCES "interest_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- → ledger_entries(id) / installments(id) (provenance links)
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_installment_id_fkey" FOREIGN KEY ("installment_id") REFERENCES "installments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tds_deductions" ADD CONSTRAINT "tds_deductions_receivable_ledger_entry_id_fkey" FOREIGN KEY ("receivable_ledger_entry_id") REFERENCES "ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tds_certificates" ADD CONSTRAINT "tds_certificates_adjustment_ledger_entry_id_fkey" FOREIGN KEY ("adjustment_ledger_entry_id") REFERENCES "ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "interest_accruals" ADD CONSTRAINT "interest_accruals_installment_id_fkey" FOREIGN KEY ("installment_id") REFERENCES "installments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "interest_accruals" ADD CONSTRAINT "interest_accruals_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Append-only enforcement (defense-in-depth) ──────────────
-- Financial ledger tables reject UPDATE and DELETE at the database level,
-- independent of the application. A deliberate maintenance escape hatch:
-- when the transaction-local GUC app.allow_financial_mutation = 'on', the
-- operation is permitted (used only by admin purges and test teardown —
-- never by normal application code). See CLAUDE.md Phase 4 decisions.

CREATE OR REPLACE FUNCTION forbid_financial_mutation() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_financial_mutation', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Table % is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING HINT = 'Financial rows are immutable; post a reversal entry instead.';
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'ledger_entries', 'receipt_allocations', 'cheque_status_events',
      'interest_accruals', 'tds_deductions', 'tds_certificates'
    ])
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %1$s_no_update BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION forbid_financial_mutation()',
      tbl
    );
    EXECUTE format(
      'CREATE TRIGGER %1$s_no_delete BEFORE DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION forbid_financial_mutation()',
      tbl
    );
  END LOOP;
END
$$;

-- ── Row-Level Security for all Phase 4 tenant-scoped tables ──

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'applicant_addresses', 'applicant_documents', 'cancellation_rules',
      'bookings', 'booking_co_applicants', 'booking_cost_lines',
      'payment_plans', 'installments', 'ledger_entries', 'receipts',
      'receipt_allocations', 'cheque_status_events', 'number_sequences',
      'transfers', 'cancellations', 'refunds', 'payment_vouchers',
      'extra_charges', 'tds_deductions', 'tds_certificates',
      'interest_accruals', 'payment_plan_milestones'
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

-- ── Grants for application roles on the new tables ──────────
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openestate_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openestate_system;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO openestate_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO openestate_system;
