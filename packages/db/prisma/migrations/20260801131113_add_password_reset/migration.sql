-- DropForeignKey
ALTER TABLE "applicant_change_requests" DROP CONSTRAINT "applicant_change_requests_applicant_id_fkey";

-- DropForeignKey
ALTER TABLE "applicant_change_requests" DROP CONSTRAINT "applicant_change_requests_requested_by_id_fkey";

-- DropForeignKey
ALTER TABLE "applicant_change_requests" DROP CONSTRAINT "applicant_change_requests_reviewed_by_id_fkey";

-- DropForeignKey
ALTER TABLE "applicant_documents" DROP CONSTRAINT "applicant_documents_document_type_id_fkey";

-- DropForeignKey
ALTER TABLE "applicant_documents" DROP CONSTRAINT "applicant_documents_uploaded_by_id_fkey";

-- DropForeignKey
ALTER TABLE "booking_cost_lines" DROP CONSTRAINT "booking_cost_lines_charge_type_id_fkey";

-- DropForeignKey
ALTER TABLE "booking_cost_lines" DROP CONSTRAINT "booking_cost_lines_gst_rate_id_fkey";

-- DropForeignKey
ALTER TABLE "booking_drafts" DROP CONSTRAINT "booking_drafts_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_broker_id_fkey";

-- DropForeignKey
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_interest_rule_id_fkey";

-- DropForeignKey
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_payment_plan_template_id_fkey";

-- DropForeignKey
ALTER TABLE "broker_booking_commissions" DROP CONSTRAINT "broker_booking_commissions_booking_id_fkey";

-- DropForeignKey
ALTER TABLE "broker_booking_commissions" DROP CONSTRAINT "broker_booking_commissions_rule_id_fkey";

-- DropForeignKey
ALTER TABLE "broker_commission_rules" DROP CONSTRAINT "broker_commission_rules_project_id_fkey";

-- DropForeignKey
ALTER TABLE "broker_nocs" DROP CONSTRAINT "broker_nocs_approved_by_id_fkey";

-- DropForeignKey
ALTER TABLE "broker_nocs" DROP CONSTRAINT "broker_nocs_booking_id_fkey";

-- DropForeignKey
ALTER TABLE "broker_nocs" DROP CONSTRAINT "broker_nocs_broker_id_fkey";

-- DropForeignKey
ALTER TABLE "broker_nocs" DROP CONSTRAINT "broker_nocs_requested_by_id_fkey";

-- DropForeignKey
ALTER TABLE "cancellations" DROP CONSTRAINT "cancellations_cancellation_rule_id_fkey";

-- DropForeignKey
ALTER TABLE "cancellations" DROP CONSTRAINT "cancellations_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "cheque_status_events" DROP CONSTRAINT "cheque_status_events_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "commission_ledger_entries" DROP CONSTRAINT "commission_ledger_entries_booking_id_fkey";

-- DropForeignKey
ALTER TABLE "commission_ledger_entries" DROP CONSTRAINT "commission_ledger_entries_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "commission_ledger_entries" DROP CONSTRAINT "commission_ledger_entries_reversal_of_entry_id_fkey";

-- DropForeignKey
ALTER TABLE "commission_payments" DROP CONSTRAINT "commission_payments_approved_by_id_fkey";

-- DropForeignKey
ALTER TABLE "commission_payments" DROP CONSTRAINT "commission_payments_bank_id_fkey";

-- DropForeignKey
ALTER TABLE "commission_payments" DROP CONSTRAINT "commission_payments_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "construction_updates" DROP CONSTRAINT "construction_updates_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "construction_updates" DROP CONSTRAINT "construction_updates_project_id_fkey";

-- DropForeignKey
ALTER TABLE "document_dispatches" DROP CONSTRAINT "document_dispatches_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "extra_charges" DROP CONSTRAINT "extra_charges_charge_type_id_fkey";

-- DropForeignKey
ALTER TABLE "extra_charges" DROP CONSTRAINT "extra_charges_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "extra_charges" DROP CONSTRAINT "extra_charges_gst_rate_id_fkey";

-- DropForeignKey
ALTER TABLE "generated_documents" DROP CONSTRAINT "generated_documents_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "generated_documents" DROP CONSTRAINT "generated_documents_receipt_id_fkey";

-- DropForeignKey
ALTER TABLE "generated_documents" DROP CONSTRAINT "generated_documents_template_id_fkey";

-- DropForeignKey
ALTER TABLE "interest_accruals" DROP CONSTRAINT "interest_accruals_installment_id_fkey";

-- DropForeignKey
ALTER TABLE "interest_accruals" DROP CONSTRAINT "interest_accruals_interest_rule_id_fkey";

-- DropForeignKey
ALTER TABLE "interest_accruals" DROP CONSTRAINT "interest_accruals_ledger_entry_id_fkey";

-- DropForeignKey
ALTER TABLE "lead_source_api_keys" DROP CONSTRAINT "lead_source_api_keys_company_id_fkey";

-- DropForeignKey
ALTER TABLE "lead_source_api_keys" DROP CONSTRAINT "lead_source_api_keys_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_installment_id_fkey";

-- DropForeignKey
ALTER TABLE "payment_plans" DROP CONSTRAINT "payment_plans_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "payment_plans" DROP CONSTRAINT "payment_plans_template_id_fkey";

-- DropForeignKey
ALTER TABLE "payment_vouchers" DROP CONSTRAINT "payment_vouchers_bank_id_fkey";

-- DropForeignKey
ALTER TABLE "payment_vouchers" DROP CONSTRAINT "payment_vouchers_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "plugin_installations" DROP CONSTRAINT "plugin_installations_company_id_fkey";

-- DropForeignKey
ALTER TABLE "plugin_installations" DROP CONSTRAINT "plugin_installations_installed_by_id_fkey";

-- DropForeignKey
ALTER TABLE "portal_invites" DROP CONSTRAINT "portal_invites_applicant_id_fkey";

-- DropForeignKey
ALTER TABLE "portal_invites" DROP CONSTRAINT "portal_invites_broker_id_fkey";

-- DropForeignKey
ALTER TABLE "portal_invites" DROP CONSTRAINT "portal_invites_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "portal_password_resets" DROP CONSTRAINT "portal_password_resets_user_id_fkey";

-- DropForeignKey
ALTER TABLE "receipts" DROP CONSTRAINT "receipts_bank_id_fkey";

-- DropForeignKey
ALTER TABLE "receipts" DROP CONSTRAINT "receipts_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "receipts" DROP CONSTRAINT "receipts_receipt_type_id_fkey";

-- DropForeignKey
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_approved_by_id_fkey";

-- DropForeignKey
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "tds_certificates" DROP CONSTRAINT "tds_certificates_adjustment_ledger_entry_id_fkey";

-- DropForeignKey
ALTER TABLE "tds_certificates" DROP CONSTRAINT "tds_certificates_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "tds_deductions" DROP CONSTRAINT "tds_deductions_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "tds_deductions" DROP CONSTRAINT "tds_deductions_receivable_ledger_entry_id_fkey";

-- DropForeignKey
ALTER TABLE "ticket_messages" DROP CONSTRAINT "ticket_messages_author_id_fkey";

-- DropForeignKey
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_applicant_id_fkey";

-- DropForeignKey
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_broker_id_fkey";

-- DropForeignKey
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_category_id_fkey";

-- DropForeignKey
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_raised_by_id_fkey";

-- DropForeignKey
ALTER TABLE "transfers" DROP CONSTRAINT "transfers_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "transfers" DROP CONSTRAINT "transfers_transfer_fee_rule_id_fkey";

-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_applicant_id_fkey";

-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_broker_id_fkey";

-- DropForeignKey
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_company_id_fkey";

-- DropForeignKey
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_webhook_endpoint_id_fkey";

-- DropForeignKey
ALTER TABLE "webhook_delivery_attempts" DROP CONSTRAINT "webhook_delivery_attempts_company_id_fkey";

-- DropForeignKey
ALTER TABLE "webhook_delivery_attempts" DROP CONSTRAINT "webhook_delivery_attempts_webhook_delivery_id_fkey";

-- DropForeignKey
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_company_id_fkey";

-- DropForeignKey
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_created_by_id_fkey";

-- DropIndex
DROP INDEX "generated_documents_company_id_receipt_id_idx";

-- CreateTable
CREATE TABLE "password_resets" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "password_resets_token_hash_idx" ON "password_resets"("token_hash");

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_installations" ADD CONSTRAINT "plugin_installations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_endpoint_id_fkey" FOREIGN KEY ("webhook_endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_webhook_delivery_id_fkey" FOREIGN KEY ("webhook_delivery_id") REFERENCES "webhook_deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_source_api_keys" ADD CONSTRAINT "lead_source_api_keys_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
