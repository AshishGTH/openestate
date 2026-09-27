-- The broker portal dashboard gets its own portal permission, so portal
-- roles never need a staff permission. One-time steps only; removing
-- non-portal grants from portal roles is done by sync-permissions.ts,
-- which runs after migrations on every upgrade and prints what it removed.

-- Migrations run before sync-permissions, so the permission row must exist
-- here. permissions.id has no database default (Prisma generates it).
INSERT INTO "permissions" ("id", "key")
  VALUES (gen_random_uuid(), 'portal.broker.dashboard.read')
  ON CONFLICT ("key") DO NOTHING;

-- seed.ts has set this on the seeded customer/broker roles since Phase 6,
-- so this is a no-op on released installs; it makes is_portal reliable.
UPDATE "roles" SET "is_portal" = true
  WHERE "is_system" AND "slug" IN ('customer', 'broker') AND NOT "is_portal";

-- Brokers keep their dashboard. One-time: repeating it on every upgrade
-- would restore the permission after an admin removed it on purpose.
INSERT INTO "role_permissions" ("role_id", "permission_id")
  SELECT r."id", p."id" FROM "roles" r, "permissions" p
  WHERE r."is_portal" AND r."slug" = 'broker' AND p."key" = 'portal.broker.dashboard.read'
  ON CONFLICT DO NOTHING;
