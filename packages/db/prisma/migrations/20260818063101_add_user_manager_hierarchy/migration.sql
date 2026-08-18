-- AlterTable
ALTER TABLE "users" ADD COLUMN     "manager_id" UUID;

-- CreateIndex
CREATE INDEX "users_company_id_manager_id_idx" ON "users"("company_id", "manager_id");

-- AddForeignKey
-- Scalar FK, not a Prisma relation (User relation-bloat policy, Phase 4
-- decisions) — DB-level constraint added by hand here, same pattern as
-- every other User-linked FK in this codebase. ON DELETE SET NULL: users
-- are soft-deleted (isActive=false) in the application, never hard-deleted,
-- but a future purge tool should orphan reports rather than cascade-delete
-- them.
ALTER TABLE "users" ADD CONSTRAINT "users_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
