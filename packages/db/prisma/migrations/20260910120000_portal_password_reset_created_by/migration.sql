-- PortalPasswordReset.createdById: which admin issued a reset link through
-- POST /admin/portal-password-resets. NULL means self-service — the portal
-- user requested the reset themselves (PortalPasswordResetProcessor) and no
-- admin was involved. Deliberately not backfilled: no existing row has a
-- known creator, and inventing one would falsify the trail.
--
-- Scalar + DB-level FK, no Prisma relation — same shape and ON DELETE SET NULL
-- as portal_invites.created_by_id. No RLS change: the table's only policy is
-- the company_id tenant_isolation_policy, which a new column doesn't affect.
-- Not a hot table (touched only when a reset is issued or confirmed), and a
-- nullable column with no default is a metadata-only ADD COLUMN; lock_timeout
-- comes from upgrade-native.sh's connection, not from this file.
ALTER TABLE "portal_password_resets" ADD COLUMN "created_by_id" UUID;

ALTER TABLE "portal_password_resets" ADD CONSTRAINT "portal_password_resets_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
