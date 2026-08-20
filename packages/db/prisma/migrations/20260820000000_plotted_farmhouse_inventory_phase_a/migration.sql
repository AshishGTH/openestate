-- Phase A of docs/plans/plotted-farmhouse-inventory.md — schema only.
--
-- Adds the two-shape (HIGH_RISE / LAND_BASED) inventory model:
--   * InventoryShape + AreaUnit enums
--   * Project.shape + Project.land_area_default_unit
--   * new inventory_groups table (RLS-protected, tenant_isolation_policy)
--   * new Unit columns: project_id, shape, inventory_group_id,
--     land_area_entered/_unit/_sqft, land_record_ref, facing,
--     length_feet, breadth_feet, rate_unit, built_up_rate_paise
--   * new UnitRateRevision.rate_unit
--   * CHECK constraint units_shape_hierarchy_chk enforcing the exact
--     per-shape hierarchy: HIGH_RISE ⇒ floor_id NOT NULL, inventory_group_id
--     NULL; LAND_BASED ⇒ floor_id NULL (grouping via inventory_group_id
--     is optional)
--
-- Ordering per §5.5 of the plan document, chosen so an ALTER never runs
-- against a table with a violating row. Both Unit.project_id and
-- Unit.shape are added nullable, backfilled from the existing HIGH_RISE
-- floor→tower→project walk, then flipped NOT NULL. Unit.floor_id is
-- widened to nullable in the same statement block; existing rows keep
-- their floor_id, and only future LAND_BASED inserts will carry NULL.
--
-- No unit rows change price or ledger behaviour: baseRatePaise stays as
-- it was (rate_unit defaults to SQFT, which is the same interpretation
-- HIGH_RISE always used), UnitRateRevision.rate_paise stays, and there
-- is no touch of bookings/ledger_entries/receipts.

-- ── Enums ───────────────────────────────────────────────────────────
CREATE TYPE "InventoryShape" AS ENUM ('HIGH_RISE', 'LAND_BASED');
CREATE TYPE "AreaUnit" AS ENUM ('SQFT', 'SQYD', 'SQM', 'ACRE', 'GUNTA');

-- ── Project: shape + default LAND_BASED entry unit ──────────────────
ALTER TABLE "projects"
  ADD COLUMN "shape" "InventoryShape" NOT NULL DEFAULT 'HIGH_RISE',
  ADD COLUMN "land_area_default_unit" "AreaUnit";

-- ── inventory_groups (LAND_BASED grouping; optional) ────────────────
CREATE TABLE "inventory_groups" (
  "id"          UUID NOT NULL,
  "company_id"  UUID NOT NULL,
  "project_id"  UUID NOT NULL,
  "name"        VARCHAR(255) NOT NULL,
  "code"        VARCHAR(50) NOT NULL,
  "kind"        VARCHAR(50),
  "is_active"   BOOLEAN NOT NULL DEFAULT true,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inventory_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_groups_project_id_code_key"
  ON "inventory_groups"("project_id", "code");
CREATE INDEX "inventory_groups_project_id_is_active_idx"
  ON "inventory_groups"("project_id", "is_active");
ALTER TABLE "inventory_groups"
  ADD CONSTRAINT "inventory_groups_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_groups"
  ADD CONSTRAINT "inventory_groups_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Units: add new columns (all nullable for the backfill window) ───
ALTER TABLE "units"
  ADD COLUMN "project_id"              UUID,
  ADD COLUMN "shape"                   "InventoryShape",
  ADD COLUMN "inventory_group_id"      UUID,
  ADD COLUMN "land_area_entered"       DECIMAL(20,6),
  ADD COLUMN "land_area_entered_unit"  "AreaUnit",
  ADD COLUMN "land_area_sqft"          DECIMAL(20,6),
  ADD COLUMN "land_record_ref"         VARCHAR(100),
  ADD COLUMN "facing"                  VARCHAR(20),
  ADD COLUMN "length_feet"             DECIMAL(10,2),
  ADD COLUMN "breadth_feet"            DECIMAL(10,2),
  ADD COLUMN "rate_unit"               "AreaUnit" NOT NULL DEFAULT 'SQFT',
  ADD COLUMN "built_up_rate_paise"     BIGINT;

-- Backfill: every existing unit is HIGH_RISE and reaches its project
-- through floor→tower. This is the whole reason project_id and shape
-- were added nullable in the ALTER above.
UPDATE "units" u
SET "project_id" = t."project_id",
    "shape"      = 'HIGH_RISE'
FROM "floors" f
JOIN "towers" t ON t."id" = f."tower_id"
WHERE u."floor_id" = f."id";

-- Sanity check: after the backfill, no unit may still carry NULL in
-- either column. If this fires, the migration aborts loudly rather
-- than flipping NOT NULL against a violating row.
DO $$
DECLARE
  bad_count INT;
BEGIN
  SELECT COUNT(*) INTO bad_count
    FROM "units"
   WHERE "project_id" IS NULL OR "shape" IS NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Backfill left % unit row(s) with NULL project_id/shape', bad_count;
  END IF;
END
$$;

-- Flip NOT NULL now that the backfill is complete, and widen floor_id
-- to nullable (LAND_BASED units have no floor).
ALTER TABLE "units"
  ALTER COLUMN "project_id" SET NOT NULL,
  ALTER COLUMN "shape"      SET NOT NULL,
  ALTER COLUMN "floor_id"   DROP NOT NULL;

-- Foreign keys.
ALTER TABLE "units"
  ADD CONSTRAINT "units_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "units"
  ADD CONSTRAINT "units_inventory_group_id_fkey"
  FOREIGN KEY ("inventory_group_id") REFERENCES "inventory_groups"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CHECK constraint: exact per-shape hierarchy. HIGH_RISE units must
-- have a floor and must not have an inventory group; LAND_BASED units
-- must not have a floor (inventory_group_id stays optional). Enforced
-- at the row level, not deferred to the service layer, because a row
-- that violated this would silently render wrong in every list view
-- that filters by shape.
ALTER TABLE "units"
  ADD CONSTRAINT "units_shape_hierarchy_chk"
  CHECK (
    ("shape" = 'HIGH_RISE'  AND "floor_id" IS NOT NULL AND "inventory_group_id" IS NULL)
    OR
    ("shape" = 'LAND_BASED' AND "floor_id" IS NULL)
  );

-- Indexes to serve list views. floor+number uniqueness is unchanged.
CREATE INDEX "units_project_id_status_idx" ON "units"("project_id", "status");
CREATE INDEX "units_inventory_group_id_status_idx" ON "units"("inventory_group_id", "status");

-- ── UnitRateRevision: rate_unit (default SQFT is a no-op for existing rows) ──
ALTER TABLE "unit_rate_revisions"
  ADD COLUMN "rate_unit" "AreaUnit" NOT NULL DEFAULT 'SQFT';

-- ── RLS on inventory_groups (matches every prior tenant table) ──────
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY['inventory_groups'])
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
