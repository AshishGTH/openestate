-- A real conversion timestamp, so the dashboard's "closed this month"
-- figure stops moving when someone edits an old lead.
--
-- Previously that figure was `status = SUCCESSFUL AND updated_at >= <start
-- of month>`, because no conversion date existed. updated_at is bumped by
-- ANY edit, so re-opening a note on a lead closed last year silently
-- counted it as this month's conversion and changed a manager's
-- team-performance number with nothing to explain it.
ALTER TABLE "inquiries" ADD COLUMN "converted_at" TIMESTAMP(3);

-- Backfill: existing SUCCESSFUL rows get updated_at, which is the best
-- available approximation and is exactly what the old figure already used
-- — so no historical number CHANGES as a result of this migration; they
-- simply stop drifting from here on. Rows closed and later edited already
-- carried a misleading date and still do; that is unknowable after the
-- fact and is called out in CHANGELOG.md rather than silently "corrected"
-- to a guess. Only SUCCESSFUL rows are touched: anything else has no
-- conversion to date.
UPDATE "inquiries" SET "converted_at" = "updated_at" WHERE "status" = 'SUCCESSFUL';

-- Serves the dashboard's per-scope "converted in this window" counts,
-- which run once for the caller and once per team on every load.
CREATE INDEX "inquiries_company_id_converted_at_idx" ON "inquiries"("company_id", "converted_at");
