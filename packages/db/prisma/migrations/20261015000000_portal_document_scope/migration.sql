-- Narrow the broker branch of the portal RLS policies (access policy only;
-- no table, column, trigger or financial logic changes, no row is written).
--
-- Before: a broker portal session could reach, through portal_can_access_booking(),
-- every generated document and every installment / payment plan / receipt /
-- receipt allocation / ledger row / document dispatch of a booking that broker
-- sourced. Brokers only need their own commission statements (BROKER_STATEMENT
-- rows carrying their own broker_id), which the generated_documents policy
-- already grants through its direct broker_id branch.
--
-- After: the booking-reachability branch is customer-only (primary applicant or
-- co-applicant, exactly as before), and the broker branch of generated_documents
-- is limited to the broker's own BROKER_STATEMENT rows. Customer access is
-- unchanged. Staff sessions (no portal scope) are unchanged: the first
-- disjunct of every policy.
--
-- Each policy keeps its name; DROP + CREATE is the only way to change a policy
-- expression that preserves RESTRICTIVE semantics.

-- ALLOW-DROP: replaced below by the same-named policy with the broker branch removed
DROP POLICY IF EXISTS "installments_portal_scope" ON "installments";
CREATE POLICY "installments_portal_scope" ON "installments" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR (portal_applicant() IS NOT NULL AND portal_broker() IS NULL AND portal_can_access_booking(booking_id))
  );

-- ALLOW-DROP: replaced below by the same-named policy with the broker branch removed
DROP POLICY IF EXISTS "payment_plans_portal_scope" ON "payment_plans";
CREATE POLICY "payment_plans_portal_scope" ON "payment_plans" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR (portal_applicant() IS NOT NULL AND portal_broker() IS NULL AND portal_can_access_booking(booking_id))
  );

-- ALLOW-DROP: replaced below by the same-named policy with the broker branch removed
DROP POLICY IF EXISTS "receipts_portal_scope" ON "receipts";
CREATE POLICY "receipts_portal_scope" ON "receipts" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR (portal_applicant() IS NOT NULL AND portal_broker() IS NULL AND portal_can_access_booking(booking_id))
  );

-- ALLOW-DROP: replaced below by the same-named policy with the broker branch removed
DROP POLICY IF EXISTS "ledger_entries_portal_scope" ON "ledger_entries";
CREATE POLICY "ledger_entries_portal_scope" ON "ledger_entries" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR (portal_applicant() IS NOT NULL AND portal_broker() IS NULL AND portal_can_access_booking(booking_id))
  );

-- receipt_allocations has no booking_id of its own: via receipts.
-- ALLOW-DROP: replaced below by the same-named policy with the broker branch removed
DROP POLICY IF EXISTS "receipt_allocations_portal_scope" ON "receipt_allocations";
CREATE POLICY "receipt_allocations_portal_scope" ON "receipt_allocations" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR (
      portal_applicant() IS NOT NULL AND portal_broker() IS NULL
      AND receipt_id IN (SELECT id FROM receipts WHERE portal_can_access_booking(booking_id))
    )
  );

-- ALLOW-DROP: replaced below by the same-named policy with the broker branch removed
DROP POLICY IF EXISTS "document_dispatches_portal_scope" ON "document_dispatches";
CREATE POLICY "document_dispatches_portal_scope" ON "document_dispatches" AS RESTRICTIVE
  USING (
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
-- ALLOW-DROP: replaced below by the same-named policy with the broker branch narrowed
DROP POLICY IF EXISTS "generated_documents_portal_scope" ON "generated_documents";
CREATE POLICY "generated_documents_portal_scope" ON "generated_documents" AS RESTRICTIVE
  USING (
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
