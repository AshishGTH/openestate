-- Second-factor lockout counter and lock, kept apart from the password
-- lockout (failed_login_attempts / locked_until). That lock gates the
-- PASSWORD step, so letting wrong 2FA codes set it would let anyone who
-- holds a password lock the account's owner out on demand. See
-- apps/api/src/auth/totp-lockout.ts.
--
-- `users` is a hot table (read on essentially every authenticated request),
-- so this still takes a brief ACCESS EXCLUSIVE lock. It is safe anyway: a NOT
-- NULL column with a constant DEFAULT and a nullable column with no default
-- are both metadata-only on Postgres 11+ (no table rewrite, no scan), and
-- both are added in ONE statement so the lock is taken once.
-- upgrade-native.sh caps the wait for that lock at MIGRATION_LOCK_TIMEOUT
-- (15s by default), so a busy table fails the upgrade fast with the previous
-- release still serving rather than queueing every request behind it. The
-- previous release is unaffected by the new columns either way.
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "failed_totp_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totp_locked_until" TIMESTAMP(3);
