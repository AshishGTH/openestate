-- Phase 5 (commit 3): link GeneratedDocument to a Broker for the broker
-- statement PDF (GeneratedDocumentType.BROKER_STATEMENT, added in the
-- Phase 5 schema migration). Forward-only addition to an already-applied
-- table — mirrors GeneratedDocument's existing booking_id/applicant_id
-- shape (nullable scalar FK + a real Prisma relation, ON DELETE CASCADE)
-- rather than the frozen-core "scalar-only, no relation" policy, since
-- GeneratedDocument is unfrozen Phase 4-UI, not ledger core.

ALTER TABLE "generated_documents" ADD COLUMN "broker_id" UUID;

CREATE INDEX "generated_documents_company_id_broker_id_idx" ON "generated_documents"("company_id", "broker_id");

ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
