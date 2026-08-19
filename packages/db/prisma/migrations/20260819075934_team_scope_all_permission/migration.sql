-- TeamScopeService now decides "sees the whole company" from the
-- admin.team-scope.all PERMISSION instead of the role slug being literally
-- company_admin/super_admin, so a company's own full-permission
-- "Administrator" role behaves like an admin instead of being silently
-- scoped to its own subtree.
--
-- That switch is only safe if EXISTING installs actually receive the new
-- permission. A fresh install gets it from ROLE_PERMISSIONS (company_admin
-- takes every admin.* key; super_admin takes everything), and
-- sync-permissions.ts inserts the row and grants it to super_admin on
-- upgrade — but it deliberately never touches role_permissions for any
-- OTHER seeded role, because an admin may have narrowed them. Without the
-- backfill below, every existing company_admin would lose company-wide
-- scope on upgrade and see only their own subtree, with no error to
-- explain it. That is precisely the "assert the OUTCOME, not the
-- mechanism" failure this project already had once with the v0.2.0
-- permissions.
--
-- Scope of the backfill is deliberately narrow: the two seeded roles that
-- have always had company-wide visibility, restoring the behaviour they
-- already had. It grants nothing to sales_manager, accounts, or any custom
-- role — widening a permission set on upgrade is a privilege-escalation
-- bug, not a fix.
INSERT INTO "permissions" ("id", "key")
SELECT gen_random_uuid(), 'admin.team-scope.all'
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "key" = 'admin.team-scope.all');

-- role_permissions is a composite-PK join table with no id column.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE p."key" = 'admin.team-scope.all'
  AND r."slug" IN ('company_admin', 'super_admin')
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
  );
