-- Narrow the broker branch of the portal RLS policies (access policy only;
-- no table, column, trigger or financial logic changes, no row is written).
--
-- Before: a broker portal session could reach, through portal_can_access_booking(),
-- every generated document and every installment / payment plan / receipt /
-- receipt allocation / ledger row / document dispatch of a booking that broker
-- sourced. Brokers only need their own commission statements (BROKER_STATEMENT
-- rows carrying their own broker_id).
--
-- After: the booking-reachability branch is customer-only (primary applicant or
-- co-applicant, exactly as before), and the broker branch of generated_documents
-- is limited to the broker's own BROKER_STATEMENT rows. Customer access is
-- unchanged. Staff sessions (no portal scope) are unchanged: the first
-- disjunct of every policy.
--
-- ALTER POLICY, never DROP + CREATE: an upgrade runs migrations while the
-- previous release is still serving requests, and ALTER POLICY swaps the
-- expression atomically, so there is no moment without a RESTRICTIVE portal
-- scope. ALTER POLICY keeps each policy's name, its RESTRICTIVE kind, its
-- command (ALL) and its roles (PUBLIC); it cannot change permissive/restrictive,
-- so the block below first proves all seven are already RESTRICTIVE, ALL, PUBLIC
-- (as created in 20260727000000_phase6_portal) and aborts the migration otherwise.

DO $$
BEGIN
  IF (
    SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND (tablename, policyname) IN (
        ('installments', 'installments_portal_scope'),
        ('payment_plans', 'payment_plans_portal_scope'),
        ('receipts', 'receipts_portal_scope'),
        ('ledger_entries', 'ledger_entries_portal_scope'),
        ('receipt_allocations', 'receipt_allocations_portal_scope'),
        ('document_dispatches', 'document_dispatches_portal_scope'),
        ('generated_documents', 'generated_documents_portal_scope')
      )
      AND permissive = 'RESTRICTIVE'
      AND cmd = 'ALL'
      AND roles = '{public}'::name[]
  ) <> 7 THEN
    RAISE EXCEPTION 'portal_document_scope: expected 7 RESTRICTIVE / ALL / PUBLIC portal policies; schema differs, not altering';
  END IF;
END
$$;

ALTER POLICY "installments_portal_scope" ON "installments" USING (
  (portal_applicant() IS NULL AND portal_broker() IS NULL)
  OR (portal_applicant() IS NOT NULL AND portal_broker() IS NULL AND portal_can_access_booking(booking_id))
);

ALTER POLICY "payment_plans_portal_scope" ON "payment_plans" USING (
  (portal_applicant() IS NULL AND portal_broker() IS NULL)
  OR (portal_applicant() IS NOT NULL AND portal_broker() IS NULL AND portal_can_access_booking(booking_id))
);

ALTER POLICY "receipts_portal_scope" ON "receipts" USING (
  (portal_applicant() IS NULL AND portal_broker() IS NULL)
  OR (portal_applicant() IS NOT NULL AND portal_broker() IS NULL AND portal_can_access_booking(booking_id))
);

ALTER POLICY "ledger_entries_portal_scope" ON "ledger_entries" USING (
  (portal_applicant() IS NULL AND portal_broker() IS NULL)
  OR (portal_applicant() IS NOT NULL AND portal_broker() IS NULL AND portal_can_access_booking(booking_id))
);

-- receipt_allocations has no booking_id of its own: via receipts.
ALTER POLICY "receipt_allocations_portal_scope" ON "receipt_allocations" USING (
  (portal_applicant() IS NULL AND portal_broker() IS NULL)
  OR (
    portal_applicant() IS NOT NULL AND portal_broker() IS NULL
    AND receipt_id IN (SELECT id FROM receipts WHERE portal_can_access_booking(booking_id))
  )
);

ALTER POLICY "document_dispatches_portal_scope" ON "document_dispatches" USING (
  (portal_applicant() IS NULL AND portal_broker() IS NULL)
  OR (
    portal_applicant() IS NOT NULL AND portal_broker() IS NULL
    AND (
      applicant_id = portal_applicant()
      OR (booking_id IS NOT NULL AND portal_can_access_booking(booking_id))
    )
  )
);

-- generated_documents: customer = own rows or rows of a booking they can reach
-- (primary or co-applicant), as before; broker = own BROKER_STATEMENT only.
ALTER POLICY "generated_documents_portal_scope" ON "generated_documents" USING (
  (portal_applicant() IS NULL AND portal_broker() IS NULL)
  OR (
    portal_applicant() IS NOT NULL AND portal_broker() IS NULL
    AND (
      applicant_id = portal_applicant()
      OR (booking_id IS NOT NULL AND portal_can_access_booking(booking_id))
    )
  )
  OR (
    portal_broker() IS NOT NULL AND portal_applicant() IS NULL
    AND broker_id = portal_broker()
    AND document_type = 'BROKER_STATEMENT'
  )
);
