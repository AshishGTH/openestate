-- v0.8.4 Part I: the seeded permissions each system role was last synced to.
--
-- The upgrade adds a permission to a system role (company_admin,
-- sales_manager, sales_executive, accounts, customer, broker) only when it is
-- new to that role's seed since this baseline. A permission in the baseline
-- that the role no longer holds was removed by an admin and is never added
-- back. No baseline yet (every install before v0.8.4): the first upgrade
-- records one and adds nothing. super_admin keeps its own rule (every
-- permission). One row per role; it goes when the role goes.
CREATE TABLE "role_seed_baselines" (
    "role_id" UUID NOT NULL,
    "permission_keys" TEXT[] NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_seed_baselines_pkey" PRIMARY KEY ("role_id")
);

ALTER TABLE "role_seed_baselines"
  ADD CONSTRAINT "role_seed_baselines_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
