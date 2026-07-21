-- Phase 2: Inventory tables (projects, towers, floors, units, pricing)
-- Run as the DB owner role (superuser / table creator).

-- ============================================================
-- 1. Enum
-- ============================================================

CREATE TYPE "UnitStatus" AS ENUM ('AVAILABLE', 'HELD', 'BLOCKED', 'BOOKED', 'ALLOTTED', 'REGISTERED', 'CANCELLED');

-- ============================================================
-- 2. Tables
-- ============================================================

-- CreateTable
CREATE TABLE "unit_types" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unit_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plc_types" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plc_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "project_type_id" UUID,
    "rera_number" VARCHAR(100),
    "area_location_id" UUID,
    "address" TEXT,
    "description" TEXT,
    "start_date" DATE,
    "expected_end_date" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "towers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "total_floors" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "towers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "floors" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "tower_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "floor_number" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "floors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "floor_id" UUID NOT NULL,
    "unit_type_id" UUID,
    "number" VARCHAR(50) NOT NULL,
    "status" "UnitStatus" NOT NULL DEFAULT 'AVAILABLE',
    "carpet_area_sqft" DECIMAL(10,2),
    "built_up_area_sqft" DECIMAL(10,2),
    "super_built_up_sqft" DECIMAL(10,2),
    "base_rate_paise" BIGINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_plcs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "plc_type_id" UUID NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "percentage" DECIMAL(5,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unit_plcs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_charges" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "charge_type_id" UUID NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unit_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_rate_revisions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "rate_paise" BIGINT NOT NULL,
    "effective_from" DATE NOT NULL,
    "reason" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_rate_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_status_changes" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "from_status" "UnitStatus" NOT NULL,
    "to_status" "UnitStatus" NOT NULL,
    "reason" VARCHAR(500),
    "actor_type" VARCHAR(20) NOT NULL,
    "actor_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_status_changes_pkey" PRIMARY KEY ("id")
);

-- ============================================================
-- 3. Indexes
-- ============================================================

CREATE UNIQUE INDEX "unit_types_company_id_name_key" ON "unit_types"("company_id", "name");
CREATE UNIQUE INDEX "plc_types_company_id_name_key" ON "plc_types"("company_id", "name");
CREATE UNIQUE INDEX "projects_company_id_code_key" ON "projects"("company_id", "code");
CREATE UNIQUE INDEX "towers_project_id_code_key" ON "towers"("project_id", "code");
CREATE UNIQUE INDEX "floors_tower_id_floor_number_key" ON "floors"("tower_id", "floor_number");
CREATE UNIQUE INDEX "units_floor_id_number_key" ON "units"("floor_id", "number");
CREATE UNIQUE INDEX "unit_plcs_unit_id_plc_type_id_key" ON "unit_plcs"("unit_id", "plc_type_id");
CREATE UNIQUE INDEX "unit_charges_unit_id_charge_type_id_key" ON "unit_charges"("unit_id", "charge_type_id");
CREATE UNIQUE INDEX "unit_rate_revisions_unit_id_effective_from_key" ON "unit_rate_revisions"("unit_id", "effective_from");
CREATE INDEX "unit_status_changes_unit_id_created_at_idx" ON "unit_status_changes"("unit_id", "created_at");

-- ============================================================
-- 4. Foreign keys
-- ============================================================

ALTER TABLE "unit_types" ADD CONSTRAINT "unit_types_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "plc_types" ADD CONSTRAINT "plc_types_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "projects_project_type_id_fkey" FOREIGN KEY ("project_type_id") REFERENCES "project_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "projects_area_location_id_fkey" FOREIGN KEY ("area_location_id") REFERENCES "area_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "towers" ADD CONSTRAINT "towers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "towers" ADD CONSTRAINT "towers_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "floors" ADD CONSTRAINT "floors_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "floors" ADD CONSTRAINT "floors_tower_id_fkey" FOREIGN KEY ("tower_id") REFERENCES "towers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "units" ADD CONSTRAINT "units_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "units" ADD CONSTRAINT "units_floor_id_fkey" FOREIGN KEY ("floor_id") REFERENCES "floors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "units" ADD CONSTRAINT "units_unit_type_id_fkey" FOREIGN KEY ("unit_type_id") REFERENCES "unit_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "unit_plcs" ADD CONSTRAINT "unit_plcs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unit_plcs" ADD CONSTRAINT "unit_plcs_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "unit_plcs" ADD CONSTRAINT "unit_plcs_plc_type_id_fkey" FOREIGN KEY ("plc_type_id") REFERENCES "plc_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unit_charges" ADD CONSTRAINT "unit_charges_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unit_charges" ADD CONSTRAINT "unit_charges_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "unit_charges" ADD CONSTRAINT "unit_charges_charge_type_id_fkey" FOREIGN KEY ("charge_type_id") REFERENCES "charge_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unit_rate_revisions" ADD CONSTRAINT "unit_rate_revisions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unit_rate_revisions" ADD CONSTRAINT "unit_rate_revisions_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "unit_rate_revisions" ADD CONSTRAINT "unit_rate_revisions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "unit_status_changes" ADD CONSTRAINT "unit_status_changes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unit_status_changes" ADD CONSTRAINT "unit_status_changes_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "unit_status_changes" ADD CONSTRAINT "unit_status_changes_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- 5. Row-Level Security for Phase 2 tables
-- ============================================================

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'unit_types', 'plc_types', 'projects', 'towers', 'floors',
      'units', 'unit_plcs', 'unit_charges', 'unit_rate_revisions',
      'unit_status_changes'
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
