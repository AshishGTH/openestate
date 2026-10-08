-- Session authorisation version per user (see schema.prisma, User.authzVersion).
-- NOT NULL DEFAULT 0 is a metadata-only change on PostgreSQL 11+: no table rewrite,
-- and the brief ACCESS EXCLUSIVE lock is covered by the upgrade's lock_timeout.
ALTER TABLE "users" ADD COLUMN "authz_version" INTEGER NOT NULL DEFAULT 0;
