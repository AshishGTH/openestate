-- Phase 7 commit 2 (webhooks-and-leads): webhook endpoints/deliveries/
-- attempts, and the inbound lead API key table. HAND-WRITTEN, matching
-- every phase since Phase 4 — see CLAUDE.md Phase 7 decisions.

-- ============================================================
-- 1. Tables
-- ============================================================

CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "secret_key_version" INTEGER NOT NULL,
    "event_types" TEXT[] NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "disabled_at" TIMESTAMP(3),
    "disabled_reason" VARCHAR(255),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "webhook_endpoint_id" UUID NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "webhook_delivery_attempts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "webhook_delivery_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "response_status" INTEGER,
    "response_snippet" VARCHAR(1000),
    "error_message" VARCHAR(500),
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_delivery_attempts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "lead_source_api_keys" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "key_prefix" VARCHAR(12) NOT NULL,
    "key_hash" VARCHAR(64) NOT NULL,
    "scopes" TEXT[] NOT NULL,
    "field_mapping" JSONB NOT NULL,
    "rate_limit_per_minute" INTEGER NOT NULL DEFAULT 60,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_source_api_keys_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_endpoints_company_id_idx" ON "webhook_endpoints"("company_id");
CREATE INDEX "webhook_deliveries_company_id_webhook_endpoint_id_idx" ON "webhook_deliveries"("company_id", "webhook_endpoint_id");
CREATE INDEX "webhook_deliveries_company_id_status_idx" ON "webhook_deliveries"("company_id", "status");
CREATE INDEX "webhook_delivery_attempts_company_id_webhook_delivery_id_idx" ON "webhook_delivery_attempts"("company_id", "webhook_delivery_id");
CREATE INDEX "lead_source_api_keys_key_hash_idx" ON "lead_source_api_keys"("key_hash");
CREATE INDEX "lead_source_api_keys_company_id_idx" ON "lead_source_api_keys"("company_id");

ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_endpoint_id_fkey" FOREIGN KEY ("webhook_endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_webhook_delivery_id_fkey" FOREIGN KEY ("webhook_delivery_id") REFERENCES "webhook_deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lead_source_api_keys" ADD CONSTRAINT "lead_source_api_keys_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_source_api_keys" ADD CONSTRAINT "lead_source_api_keys_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- 2. Row-Level Security — standard company-scoped policy for all four
--    tables (staff-only; no portal-scoped access path to any of them).
-- ============================================================

ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_endpoints" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON "webhook_endpoints"
  FOR ALL
  USING (company_id = current_setting('app.current_company_id', true)::uuid)
  WITH CHECK (company_id = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON "webhook_deliveries"
  FOR ALL
  USING (company_id = current_setting('app.current_company_id', true)::uuid)
  WITH CHECK (company_id = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "webhook_delivery_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_delivery_attempts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON "webhook_delivery_attempts"
  FOR ALL
  USING (company_id = current_setting('app.current_company_id', true)::uuid)
  WITH CHECK (company_id = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "lead_source_api_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_source_api_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON "lead_source_api_keys"
  FOR ALL
  USING (company_id = current_setting('app.current_company_id', true)::uuid)
  WITH CHECK (company_id = current_setting('app.current_company_id', true)::uuid);

-- ============================================================
-- 3. Grants
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openestate_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openestate_system;
