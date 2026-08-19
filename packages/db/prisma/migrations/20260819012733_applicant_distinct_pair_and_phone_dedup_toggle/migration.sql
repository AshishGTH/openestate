-- Item 7: phone-as-universal-identifier follow-up.
--
-- NOTE: this migration deliberately omits the "DropForeignKey ... users_manager_id_fkey"
-- statement that `prisma migrate diff` produces against the live dev database. That FK
-- was added by hand via a prior migration (v0.4 manager hierarchy) matching this
-- project's established "scalar FK + DB-level constraint, not a Prisma relation" pattern
-- (see schema.prisma's own comment on User.managerId, and CLAUDE.md's Phase 4 decisions
-- entry on createdById/approvedById). Because managerId has no Prisma `@relation`, `prisma
-- migrate diff` can't see the constraint as schema-declared and proposes dropping it — a
-- false positive, not a real change this migration should make.

-- AlterTable
ALTER TABLE "company_configs" ADD COLUMN     "presales_phone_dedup_auto_link" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "applicant_distinct_pairs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "applicant_a_id" UUID NOT NULL,
    "applicant_b_id" UUID NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applicant_distinct_pairs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "applicant_distinct_pairs_company_id_applicant_a_id_applican_key" ON "applicant_distinct_pairs"("company_id", "applicant_a_id", "applicant_b_id");

-- AddForeignKey
ALTER TABLE "applicant_distinct_pairs" ADD CONSTRAINT "applicant_distinct_pairs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applicant_distinct_pairs" ADD CONSTRAINT "applicant_distinct_pairs_applicant_a_id_fkey" FOREIGN KEY ("applicant_a_id") REFERENCES "applicants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applicant_distinct_pairs" ADD CONSTRAINT "applicant_distinct_pairs_applicant_b_id_fkey" FOREIGN KEY ("applicant_b_id") REFERENCES "applicants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applicant_distinct_pairs" ADD CONSTRAINT "applicant_distinct_pairs_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- Row-Level Security for applicant_distinct_pairs (matches the
-- Phase 3 presales RLS pattern exactly)
-- ============================================================

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'applicant_distinct_pairs'
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
