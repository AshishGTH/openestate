-- Phase 4 UI layer: generated documents (PDFs), dispatch history, booking
-- drafts (wizard resume), and Applicant.dateOfBirth (birthday-list report).
-- Run as the DB owner role (superuser / table creator).
--
-- IMPORTANT: this file is HAND-WRITTEN, not `prisma migrate diff` output
-- verbatim. A raw diff against the live DB tries to DROP 33 pre-existing FK
-- constraints on the immutable Phase 4 ledger-core tables (bookings,
-- ledger_entries, receipts, …) because those FKs are intentionally scalar
-- (no Prisma relation — see the "Relation policy" comment in schema.prisma)
-- and therefore invisible to Prisma's relation-based diff generator. This
-- migration includes ONLY the genuinely new, additive objects and leaves
-- every existing ledger-core constraint untouched. See CLAUDE.md Phase 4
-- decisions for the full explanation.

-- ============================================================
-- 1. Enums
-- ============================================================

CREATE TYPE "GeneratedDocumentType" AS ENUM ('STATEMENT', 'RECEIPT', 'ALLOTMENT_LETTER', 'DEMAND_LETTER', 'REMINDER_LETTER');
CREATE TYPE "DispatchChannel" AS ENUM ('EMAIL', 'SMS');
CREATE TYPE "DispatchStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- ============================================================
-- 2. Applicant.dateOfBirth (birthday-list report)
-- ============================================================

ALTER TABLE "applicants" ADD COLUMN "date_of_birth" DATE;

-- ============================================================
-- 3. Tables
-- ============================================================

CREATE TABLE "generated_documents" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "booking_id" UUID,
    "applicant_id" UUID,
    "receipt_id" UUID,
    "document_type" "GeneratedDocumentType" NOT NULL,
    "template_id" UUID,
    "stored_name" VARCHAR(255) NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "is_duplicate" BOOLEAN NOT NULL DEFAULT false,
    "source_document_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generated_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_dispatches" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "generated_document_id" UUID,
    "booking_id" UUID,
    "applicant_id" UUID,
    "recipient_address" VARCHAR(255) NOT NULL,
    "channel" "DispatchChannel" NOT NULL,
    "template_snapshot" TEXT NOT NULL,
    "status" "DispatchStatus" NOT NULL DEFAULT 'QUEUED',
    "provider_message_id" VARCHAR(255),
    "error_message" TEXT,
    "attempt_of_dispatch_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_dispatches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "booking_drafts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "label" VARCHAR(255),
    "draft_data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_drafts_pkey" PRIMARY KEY ("id")
);

-- ============================================================
-- 4. Indexes
-- ============================================================

CREATE INDEX "generated_documents_company_id_booking_id_idx" ON "generated_documents"("company_id", "booking_id");
CREATE INDEX "generated_documents_company_id_applicant_id_idx" ON "generated_documents"("company_id", "applicant_id");
CREATE INDEX "generated_documents_company_id_receipt_id_idx" ON "generated_documents"("company_id", "receipt_id");
CREATE INDEX "document_dispatches_company_id_booking_id_idx" ON "document_dispatches"("company_id", "booking_id");
CREATE INDEX "document_dispatches_company_id_applicant_id_idx" ON "document_dispatches"("company_id", "applicant_id");
CREATE INDEX "booking_drafts_company_id_created_by_id_idx" ON "booking_drafts"("company_id", "created_by_id");

-- ============================================================
-- 5. Foreign keys — core relations (Prisma-declared)
-- ============================================================

ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "applicants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "generated_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "document_dispatches" ADD CONSTRAINT "document_dispatches_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_dispatches" ADD CONSTRAINT "document_dispatches_generated_document_id_fkey" FOREIGN KEY ("generated_document_id") REFERENCES "generated_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "document_dispatches" ADD CONSTRAINT "document_dispatches_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_dispatches" ADD CONSTRAINT "document_dispatches_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "applicants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_dispatches" ADD CONSTRAINT "document_dispatches_attempt_of_dispatch_id_fkey" FOREIGN KEY ("attempt_of_dispatch_id") REFERENCES "document_dispatches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- 6. Foreign keys — scalar master/user references (hand-authored,
--    same "relation policy" as the Phase 4 ledger core: no Prisma
--    relation declared, but referential integrity still enforced here)
-- ============================================================

ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "letter_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "document_dispatches" ADD CONSTRAINT "document_dispatches_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- 7. Row-Level Security for the 3 new tables
-- ============================================================

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'generated_documents', 'document_dispatches', 'booking_drafts'
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
-- 8. Grants (new tables inherit ALTER DEFAULT PRIVILEGES from Phase 1,
--    but re-assert explicitly for safety, same as prior phase migrations)
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openestate_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openestate_system;
