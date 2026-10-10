-- v0.8.4 Part A (1 of 2): restore the 71 foreign keys that migration
-- 20260801131113_add_password_reset (70) and 20260822074906_lead_stage_foundation
-- (users.manager_id) dropped. `prisma migrate dev` generated those drops because
-- schema.prisma declares these links as plain columns (the Phase 4 "scalar FK,
-- no Prisma relation" policy), so it saw the hand-written constraints as drift.
-- Item B (constraint manifest + drop lint) stops that from happening again.
--
-- Every constraint is added NOT VALID: new and changed rows are checked from
-- now on, existing rows are not read. That takes a brief SHARE ROW EXCLUSIVE
-- lock on each child table and its parent and needs no table scan. The next
-- migration validates every link that has no orphan rows; a link that has
-- orphans stays NOT VALID and is reported by upgrade-native.sh and
-- deploy/native/check-foreign-keys.sh. No row is changed or deleted.
--
-- This whole file is one transaction, so a lock taken here is held until it
-- commits. The 35 links that lock users (as parent or as child) come last, so the lock
-- on users, which every sign-in writes to, is held for as short a time as
-- possible. No retry loop: retrying a lock wait inside this transaction would
-- keep the locks already taken (including on users) for longer. A lock wait
-- longer than lock_timeout (15s under upgrade-native.sh) fails the file,
-- nothing is applied, and the previous release keeps running.
--
-- ON DELETE is what each link had before it was dropped, except three that are
-- now RESTRICT (they were SET NULL): ledger_entries.installment_id,
-- interest_accruals.installment_id and interest_accruals.interest_rule_id.
-- SET NULL would have to UPDATE an append-only row, which the
-- forbid_financial_mutation trigger refuses anyway; RESTRICT refuses the
-- delete up front, and the API turns that into a plain message. ON UPDATE
-- CASCADE matches the originals (primary keys never change).
ALTER TABLE "applicant_change_requests" ADD CONSTRAINT "applicant_change_requests_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "applicants"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "applicant_documents" ADD CONSTRAINT "applicant_documents_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_types"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "booking_cost_lines" ADD CONSTRAINT "booking_cost_lines_charge_type_id_fkey" FOREIGN KEY ("charge_type_id") REFERENCES "charge_types"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "booking_cost_lines" ADD CONSTRAINT "booking_cost_lines_gst_rate_id_fkey" FOREIGN KEY ("gst_rate_id") REFERENCES "gst_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_interest_rule_id_fkey" FOREIGN KEY ("interest_rule_id") REFERENCES "interest_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_payment_plan_template_id_fkey" FOREIGN KEY ("payment_plan_template_id") REFERENCES "payment_plan_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "broker_booking_commissions" ADD CONSTRAINT "broker_booking_commissions_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "broker_booking_commissions" ADD CONSTRAINT "broker_booking_commissions_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "broker_commission_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "broker_commission_rules" ADD CONSTRAINT "broker_commission_rules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "broker_nocs" ADD CONSTRAINT "broker_nocs_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "broker_nocs" ADD CONSTRAINT "broker_nocs_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_cancellation_rule_id_fkey" FOREIGN KEY ("cancellation_rule_id") REFERENCES "cancellation_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "commission_ledger_entries" ADD CONSTRAINT "commission_ledger_entries_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "commission_ledger_entries" ADD CONSTRAINT "commission_ledger_entries_reversal_of_entry_id_fkey" FOREIGN KEY ("reversal_of_entry_id") REFERENCES "commission_ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "commission_payments" ADD CONSTRAINT "commission_payments_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "extra_charges" ADD CONSTRAINT "extra_charges_charge_type_id_fkey" FOREIGN KEY ("charge_type_id") REFERENCES "charge_types"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "extra_charges" ADD CONSTRAINT "extra_charges_gst_rate_id_fkey" FOREIGN KEY ("gst_rate_id") REFERENCES "gst_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "letter_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "interest_accruals" ADD CONSTRAINT "interest_accruals_installment_id_fkey" FOREIGN KEY ("installment_id") REFERENCES "installments"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "interest_accruals" ADD CONSTRAINT "interest_accruals_interest_rule_id_fkey" FOREIGN KEY ("interest_rule_id") REFERENCES "interest_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "interest_accruals" ADD CONSTRAINT "interest_accruals_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_installment_id_fkey" FOREIGN KEY ("installment_id") REFERENCES "installments"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "payment_plan_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "payment_vouchers" ADD CONSTRAINT "payment_vouchers_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "portal_invites" ADD CONSTRAINT "portal_invites_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "applicants"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "portal_invites" ADD CONSTRAINT "portal_invites_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_receipt_type_id_fkey" FOREIGN KEY ("receipt_type_id") REFERENCES "receipt_types"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "tds_certificates" ADD CONSTRAINT "tds_certificates_adjustment_ledger_entry_id_fkey" FOREIGN KEY ("adjustment_ledger_entry_id") REFERENCES "ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "tds_deductions" ADD CONSTRAINT "tds_deductions_receivable_ledger_entry_id_fkey" FOREIGN KEY ("receivable_ledger_entry_id") REFERENCES "ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "applicants"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "ticket_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_transfer_fee_rule_id_fkey" FOREIGN KEY ("transfer_fee_rule_id") REFERENCES "transfer_fee_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "users" ADD CONSTRAINT "users_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "applicants"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "users" ADD CONSTRAINT "users_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "applicant_change_requests" ADD CONSTRAINT "applicant_change_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "applicant_change_requests" ADD CONSTRAINT "applicant_change_requests_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "applicant_documents" ADD CONSTRAINT "applicant_documents_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "broker_nocs" ADD CONSTRAINT "broker_nocs_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "broker_nocs" ADD CONSTRAINT "broker_nocs_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "cheque_status_events" ADD CONSTRAINT "cheque_status_events_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "commission_ledger_entries" ADD CONSTRAINT "commission_ledger_entries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "commission_payments" ADD CONSTRAINT "commission_payments_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "commission_payments" ADD CONSTRAINT "commission_payments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "construction_updates" ADD CONSTRAINT "construction_updates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "document_dispatches" ADD CONSTRAINT "document_dispatches_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "extra_charges" ADD CONSTRAINT "extra_charges_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "lead_source_api_keys" ADD CONSTRAINT "lead_source_api_keys_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "payment_vouchers" ADD CONSTRAINT "payment_vouchers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "plugin_installations" ADD CONSTRAINT "plugin_installations_installed_by_id_fkey" FOREIGN KEY ("installed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "portal_invites" ADD CONSTRAINT "portal_invites_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "portal_password_resets" ADD CONSTRAINT "portal_password_resets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "tds_certificates" ADD CONSTRAINT "tds_certificates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "tds_deductions" ADD CONSTRAINT "tds_deductions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_raised_by_id_fkey" FOREIGN KEY ("raised_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "users" ADD CONSTRAINT "users_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
