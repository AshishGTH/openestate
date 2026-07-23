-- Phase 7 commit 1 (plugin-core): per-company plugin installation state.
-- HAND-WRITTEN for consistency with every phase since Phase 4 (this repo
-- never uses raw `prisma migrate diff` output directly), even though
-- this particular table is simple enough that a diff would have worked —
-- see CLAUDE.md Phase 7 decisions.

-- ============================================================
-- 1. Table
-- ============================================================

CREATE TABLE "plugin_installations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "plugin_id" VARCHAR(100) NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "config_ciphertext" TEXT,
    "secret_key_version" INTEGER,
    "installed_by_id" UUID,
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plugin_installations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plugin_installations_company_id_plugin_id_key" ON "plugin_installations"("company_id", "plugin_id");

ALTER TABLE "plugin_installations" ADD CONSTRAINT "plugin_installations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plugin_installations" ADD CONSTRAINT "plugin_installations_installed_by_id_fkey" FOREIGN KEY ("installed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- 2. Row-Level Security — standard company-scoped policy, the same
--    shape used by every non-portal table since Phase 1 (this table is
--    staff-only; there is no portal-scoped access path to it).
-- ============================================================

ALTER TABLE "plugin_installations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plugin_installations" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON "plugin_installations"
  FOR ALL
  USING (company_id = current_setting('app.current_company_id', true)::uuid)
  WITH CHECK (company_id = current_setting('app.current_company_id', true)::uuid);

-- ============================================================
-- 3. Grants
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openestate_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openestate_system;
