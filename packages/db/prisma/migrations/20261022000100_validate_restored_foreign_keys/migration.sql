-- v0.8.4 Part A (2 of 2): validate each restored foreign key that has no
-- orphan rows (rows whose pointer refers to a row that no longer exists).
-- A link with orphans is skipped and stays NOT VALID; nothing is changed or
-- deleted. upgrade-native.sh and deploy/native/check-foreign-keys.sh list
-- every foreign key still NOT VALID with its orphan count. (A RAISE NOTICE
-- here would not reach the operator: prisma migrate deploy does not show it.)
--
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on the child table and
-- ROW SHARE on the parent: reads and writes carry on while it scans. New rows
-- are already checked by the NOT VALID constraint, so no orphan can appear
-- between the count and the VALIDATE.

DO $$
DECLARE
  fk record;
  orphans bigint;
BEGIN
  FOR fk IN
    SELECT c.conname, c.conrelid::regclass AS child, a.attname AS col,
           c.confrelid::regclass AS parent, pa.attname AS pcol
      FROM pg_constraint c
      JOIN pg_attribute a  ON a.attrelid  = c.conrelid  AND a.attnum  = c.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
     WHERE c.contype = 'f' AND NOT c.convalidated
       AND c.conname IN ('applicant_change_requests_applicant_id_fkey',
         'applicant_change_requests_requested_by_id_fkey',
         'applicant_change_requests_reviewed_by_id_fkey',
         'applicant_documents_document_type_id_fkey',
         'applicant_documents_uploaded_by_id_fkey',
         'booking_cost_lines_charge_type_id_fkey',
         'booking_cost_lines_gst_rate_id_fkey',
         'booking_drafts_created_by_id_fkey',
         'bookings_broker_id_fkey',
         'bookings_created_by_id_fkey',
         'bookings_interest_rule_id_fkey',
         'bookings_payment_plan_template_id_fkey',
         'broker_booking_commissions_booking_id_fkey',
         'broker_booking_commissions_rule_id_fkey',
         'broker_commission_rules_project_id_fkey',
         'broker_nocs_approved_by_id_fkey',
         'broker_nocs_booking_id_fkey',
         'broker_nocs_broker_id_fkey',
         'broker_nocs_requested_by_id_fkey',
         'cancellations_cancellation_rule_id_fkey',
         'cancellations_created_by_id_fkey',
         'cheque_status_events_created_by_id_fkey',
         'commission_ledger_entries_booking_id_fkey',
         'commission_ledger_entries_created_by_id_fkey',
         'commission_ledger_entries_reversal_of_entry_id_fkey',
         'commission_payments_approved_by_id_fkey',
         'commission_payments_bank_id_fkey',
         'commission_payments_created_by_id_fkey',
         'construction_updates_created_by_id_fkey',
         'document_dispatches_created_by_id_fkey',
         'extra_charges_charge_type_id_fkey',
         'extra_charges_created_by_id_fkey',
         'extra_charges_gst_rate_id_fkey',
         'generated_documents_created_by_id_fkey',
         'generated_documents_receipt_id_fkey',
         'generated_documents_template_id_fkey',
         'interest_accruals_installment_id_fkey',
         'interest_accruals_interest_rule_id_fkey',
         'interest_accruals_ledger_entry_id_fkey',
         'lead_source_api_keys_created_by_id_fkey',
         'ledger_entries_created_by_id_fkey',
         'ledger_entries_installment_id_fkey',
         'payment_plans_created_by_id_fkey',
         'payment_plans_template_id_fkey',
         'payment_vouchers_bank_id_fkey',
         'payment_vouchers_created_by_id_fkey',
         'plugin_installations_installed_by_id_fkey',
         'portal_invites_applicant_id_fkey',
         'portal_invites_broker_id_fkey',
         'portal_invites_created_by_id_fkey',
         'portal_password_resets_user_id_fkey',
         'receipts_bank_id_fkey',
         'receipts_created_by_id_fkey',
         'receipts_receipt_type_id_fkey',
         'refunds_approved_by_id_fkey',
         'refunds_created_by_id_fkey',
         'tds_certificates_adjustment_ledger_entry_id_fkey',
         'tds_certificates_created_by_id_fkey',
         'tds_deductions_created_by_id_fkey',
         'tds_deductions_receivable_ledger_entry_id_fkey',
         'ticket_messages_author_id_fkey',
         'tickets_applicant_id_fkey',
         'tickets_broker_id_fkey',
         'tickets_category_id_fkey',
         'tickets_raised_by_id_fkey',
         'transfers_created_by_id_fkey',
         'transfers_transfer_fee_rule_id_fkey',
         'users_applicant_id_fkey',
         'users_broker_id_fkey',
         'users_manager_id_fkey',
         'webhook_endpoints_created_by_id_fkey')
     ORDER BY c.conname
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %s x WHERE x.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM %s p WHERE p.%I = x.%I)',
      fk.child, fk.col, fk.parent, fk.pcol, fk.col)
      INTO orphans;
    IF orphans = 0 THEN
      EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', fk.child, fk.conname);
    END IF;
  END LOOP;
END
$$;
