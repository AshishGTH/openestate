-- Data-correctness backfill, not a schema change.
--
-- Before this fix, ReceiptService.recordChequeEvent() flipped a
-- receipt's clearance_status to BOUNCED and correctly reversed its
-- ledger entries (reverseReceiptLedger()), but never set is_reversed.
-- Every collection report, rollup, and the customer portal's own
-- payment history filters on is_reversed = false, so a bounced cheque
-- kept being counted as real collected money indefinitely. The ledger
-- itself was always correct — the reversing entries were posted at the
-- time of the bounce — only this one flag was wrong. This migration
-- corrects the flag only. It does not insert, update, or delete any
-- row in ledger_entries, receipt_allocations, or installments.
--
-- Guard: a receipt can only ever reach clearance_status = 'BOUNCED' via
-- the bounce branch of recordChequeEvent(). The manual-cancel path,
-- reverseReceipt(), explicitly refuses to run against a receipt whose
-- clearance_status is already BOUNCED ("A bounced cheque receipt is
-- already reversed" — see receipt.service.ts). So
-- clearance_status = 'BOUNCED' AND is_reversed = false unambiguously
-- identifies a pre-fix row; no other code path produces that
-- combination, and a receipt already reversed for any other reason
-- already has is_reversed = true and is excluded by that same
-- condition. The join against cheque_status_events is a second,
-- redundant confirmation that the receipt's own latest lifecycle event
-- agrees it bounced — not the primary guard.
WITH latest_event AS (
  SELECT DISTINCT ON (receipt_id)
    receipt_id,
    status,
    reason
  FROM cheque_status_events
  ORDER BY receipt_id, event_date DESC, created_at DESC
)
UPDATE receipts r
SET
  is_reversed = true,
  reversal_reason = COALESCE(r.reversal_reason, le.reason, 'Cheque bounced (' || r.receipt_number || ')')
FROM latest_event le
WHERE
  le.receipt_id = r.id
  AND le.status = 'BOUNCED'
  AND r.clearance_status = 'BOUNCED'
  AND r.is_reversed = false;
