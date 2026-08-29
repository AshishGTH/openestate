-- Phase 0 of docs/plans/feature-completion-plan.md — lead stage foundation.
--
-- Two new tables:
--   * lead_stages — company-configurable pipeline position, orthogonal to
--     the existing InquiryStatus enum (see LeadStage's own schema doc
--     comment for why this is a second axis, not a replacement).
--   * inquiry_stage_history — one row per transition (including the
--     initial null -> default at creation), append-only, same shape as
--     the existing inquiry_assignments table.
-- Plus inquiries.stage_id (nullable, never cleared on a terminal status
-- transition) and company_configs.lead_stages_seeded_at (a one-time
-- marker — see that column's own doc comment for why row-count alone
-- can't distinguish "never seeded" from "admin deleted them all").
--
-- The partial unique index below (lead_stages_one_default_per_company)
-- is the actual enforcement for "at most one default stage per company"
-- — LeadStageService additionally clears the prior default in the same
-- transaction as setting a new one, but only for single-request UX; the
-- index is what makes a race impossible, not the service code.
--
-- The DropForeignKey/AddForeignKey pairs and the RenameIndex below this
-- comment are NOT part of this change — Prisma's diff reconciling
-- pre-existing drift between schema.prisma and the database, the same
-- "normal catch-up behavior" already documented in CLAUDE.md's Phase 6
-- password-reset migration entry. No semantic change in any of them.

-- DropForeignKey
ALTER TABLE "inventory_groups" DROP CONSTRAINT "inventory_groups_project_id_fkey";

-- DropForeignKey
ALTER TABLE "units" DROP CONSTRAINT "units_floor_id_fkey";

-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_manager_id_fkey";

-- AlterTable
ALTER TABLE "company_configs" ADD COLUMN     "lead_stages_seeded_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "inquiries" ADD COLUMN     "stage_id" UUID;

-- CreateTable
CREATE TABLE "lead_stages" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiry_stage_history" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "inquiry_id" UUID NOT NULL,
    "from_stage_id" UUID,
    "to_stage_id" UUID NOT NULL,
    "changed_by_id" UUID,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inquiry_stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lead_stages_company_id_name_key" ON "lead_stages"("company_id", "name");

-- CreateIndex
CREATE INDEX "inquiry_stage_history_company_id_inquiry_id_changed_at_idx" ON "inquiry_stage_history"("company_id", "inquiry_id", "changed_at");

-- CreateIndex
CREATE INDEX "inquiries_company_id_stage_id_idx" ON "inquiries"("company_id", "stage_id");

-- AddForeignKey
ALTER TABLE "inventory_groups" ADD CONSTRAINT "inventory_groups_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_floor_id_fkey" FOREIGN KEY ("floor_id") REFERENCES "floors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_stages" ADD CONSTRAINT "lead_stages_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "lead_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_stage_history" ADD CONSTRAINT "inquiry_stage_history_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_stage_history" ADD CONSTRAINT "inquiry_stage_history_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "inquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_stage_history" ADD CONSTRAINT "inquiry_stage_history_from_stage_id_fkey" FOREIGN KEY ("from_stage_id") REFERENCES "lead_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_stage_history" ADD CONSTRAINT "inquiry_stage_history_to_stage_id_fkey" FOREIGN KEY ("to_stage_id") REFERENCES "lead_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_stage_history" ADD CONSTRAINT "inquiry_stage_history_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "stage_raises_company_id_project_id_template_id_milestone_s_idx" RENAME TO "stage_raises_company_id_project_id_template_id_milestone_se_idx";

-- ── One default stage per company — the real enforcement, not the
-- service-layer clear-then-set (which is UX only). Prisma's schema DSL
-- has no partial-unique syntax, so this is hand-added. ──────────────
CREATE UNIQUE INDEX "lead_stages_one_default_per_company"
  ON "lead_stages" ("company_id") WHERE "is_default";

-- ── RLS on both new tables (matches every prior tenant table) ───────
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY['lead_stages', 'inquiry_stage_history'])
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
