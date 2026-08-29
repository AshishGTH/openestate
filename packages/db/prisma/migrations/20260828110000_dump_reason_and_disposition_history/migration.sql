-- Follow-Up Page spec gap #2 (docs/plans/followup-spec-gap-analysis.md,
-- SOP rule 5): Dump required no reason or remarks. Two new tables:
--   * dump_reasons — configurable master data, seeded with ZERO default
--     rows (the SOP gives no canonical reason list to seed from, unlike
--     LeadStage's real example Response values).
--   * inquiry_disposition_history — closes the one axis of three
--     (stage/ownership/status) that had no dedicated history table;
--     written on every InquiryStatus transition, not just DUMPED.
--     reason_id/remarks are nullable and populated only for DUMPED.

-- CreateTable
CREATE TABLE "dump_reasons" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dump_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiry_disposition_history" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "inquiry_id" UUID NOT NULL,
    "from_status" "InquiryStatus",
    "to_status" "InquiryStatus" NOT NULL,
    "reason_id" UUID,
    "remarks" TEXT,
    "changed_by_id" UUID,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inquiry_disposition_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dump_reasons_company_id_name_key" ON "dump_reasons"("company_id", "name");

-- CreateIndex
CREATE INDEX "inquiry_disposition_history_company_id_inquiry_id_changed__idx" ON "inquiry_disposition_history"("company_id", "inquiry_id", "changed_at");

-- AddForeignKey
ALTER TABLE "dump_reasons" ADD CONSTRAINT "dump_reasons_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_disposition_history" ADD CONSTRAINT "inquiry_disposition_history_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_disposition_history" ADD CONSTRAINT "inquiry_disposition_history_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "inquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_disposition_history" ADD CONSTRAINT "inquiry_disposition_history_reason_id_fkey" FOREIGN KEY ("reason_id") REFERENCES "dump_reasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_disposition_history" ADD CONSTRAINT "inquiry_disposition_history_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── RLS on both new tables (matches every prior tenant table) ───────
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY['dump_reasons', 'inquiry_disposition_history'])
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
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO openestate_app', tbl);
  END LOOP;
END
$$;
