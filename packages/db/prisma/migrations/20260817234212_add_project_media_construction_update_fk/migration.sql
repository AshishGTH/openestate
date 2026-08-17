-- AddForeignKey
ALTER TABLE "construction_updates" ADD CONSTRAINT "construction_updates_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
