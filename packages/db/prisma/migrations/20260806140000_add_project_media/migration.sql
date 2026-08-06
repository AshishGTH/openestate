-- v0.2.2: layout plan / brochure / photo uploads for a project, plus a
-- shared per-project storage cap (both this table and the pre-existing
-- construction_update_media roll up disk usage under one project).

-- ============================================================
-- 1. New columns on company_configs
-- ============================================================

ALTER TABLE "company_configs" ADD COLUMN "project_media_max_files" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "company_configs" ADD COLUMN "project_media_max_bytes" INTEGER NOT NULL DEFAULT 524288000;

-- ============================================================
-- 2. New table: project_media
-- ============================================================

CREATE TABLE "project_media" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "category" VARCHAR(30) NOT NULL,
    "stored_name" VARCHAR(255) NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_media_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_media_company_id_project_id_idx" ON "project_media"("company_id", "project_id");

ALTER TABLE "project_media" ADD CONSTRAINT "project_media_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_media" ADD CONSTRAINT "project_media_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 3. Row-Level Security — standard company-tenant policy
-- ============================================================

ALTER TABLE "project_media" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_media" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON "project_media"
  FOR ALL
  USING (company_id = current_setting('app.current_company_id', true)::uuid)
  WITH CHECK (company_id = current_setting('app.current_company_id', true)::uuid);

-- Same project-reachability shape as projects_portal_scope /
-- construction_updates_portal_scope (Phase 6): a customer sees a
-- project's media only if they have a booking reaching that project;
-- brokers see everything (existing, unrestricted broker precedent for
-- this same class of read). Multi-hop predicate — deliberately NOT
-- mirrored in tenant.extension.ts's PORTAL_SCOPED_MODELS (Phase 6
-- commit 2 inclusion criterion), same as construction_update_media.
CREATE POLICY project_media_portal_scope ON "project_media" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR portal_broker() IS NOT NULL
    OR (portal_applicant() IS NOT NULL AND project_id IN (
          SELECT t.project_id FROM bookings b
          JOIN units u ON u.id = b.unit_id
          JOIN floors f ON f.id = u.floor_id
          JOIN towers t ON t.id = f.tower_id
          WHERE portal_can_access_booking(b.id)
        ))
  );
