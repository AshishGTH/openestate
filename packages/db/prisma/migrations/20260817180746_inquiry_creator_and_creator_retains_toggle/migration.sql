-- AlterTable
ALTER TABLE "company_configs" ADD COLUMN     "presales_creator_retains_lead" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "inquiries" ADD COLUMN     "created_by_id" UUID;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
