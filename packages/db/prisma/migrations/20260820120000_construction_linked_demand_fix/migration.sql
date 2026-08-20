-- Construction-linked demand fix — see docs/plans/construction-linked-demand-fix.md.
--
-- Adds a milestone_type (DATE_LINKED / STAGE_LINKED) distinction that
-- previously didn't exist: every payment-plan milestone used to behave as
-- DATE_LINKED (due at bookingDate + dueOffsetDays), whether or not it was
-- actually meant to represent a construction stage. This is what let a
-- customer be shown overdue, and accrue delay interest, against a stage
-- the builder had never reached — the project's own seed data (a
-- "Construction-Linked Plan" template) demonstrated it.
--
-- Migration position (see plan §4, argued against the identical-shaped
-- GST-state-code precedent already in this project's history): existing
-- rows are backfilled to DATE_LINKED, which is exactly what they already
-- behaviourally were — zero change for any existing installment, zero
-- rows in ledger_entries/interest_accruals/receipt_allocations/receipts
-- touched. Reversing interest already accrued against an unreached stage
-- is a business decision, not something this migration can or should make
-- on anyone's behalf — see CHANGELOG.md for how to identify affected rows.

-- ── Enum ─────────────────────────────────────────────────────────────
CREATE TYPE "MilestoneType" AS ENUM ('DATE_LINKED', 'STAGE_LINKED');

-- ── payment_plan_milestones: type + the new grace-days field ──────────
-- dueOffsetDays keeps its exact original meaning (days after booking
-- date) and is only consulted for DATE_LINKED milestones. graceDaysAfterRaise
-- is a separate field for the STAGE_LINKED case — not a reinterpretation
-- of dueOffsetDays, deliberately (see the plan's §1.2 reasoning).
ALTER TABLE "payment_plan_milestones"
  ADD COLUMN "milestone_type"        "MilestoneType" NOT NULL DEFAULT 'DATE_LINKED',
  ADD COLUMN "grace_days_after_raise" INTEGER        NOT NULL DEFAULT 0;

-- ── stage_raises: one row per raise action, bulk or single ────────────
CREATE TABLE "stage_raises" (
  "id"                 UUID NOT NULL,
  "company_id"         UUID NOT NULL,
  "project_id"         UUID NOT NULL,
  "template_id"        UUID NOT NULL,
  "milestone_seq"      INTEGER NOT NULL,
  "label"              VARCHAR(255) NOT NULL,
  "stage_completed_on" DATE NOT NULL,
  "raised_by_id"       UUID,
  "raised_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stage_raises_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "stage_raises_company_id_project_id_template_id_milestone_s_idx"
  ON "stage_raises"("company_id", "project_id", "template_id", "milestone_seq");
ALTER TABLE "stage_raises"
  ADD CONSTRAINT "stage_raises_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stage_raises"
  ADD CONSTRAINT "stage_raises_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── installments: type, nullable due_date, stage_raise linkage ────────
-- milestone_seq: which PaymentPlanMilestone.seq (within the plan's
-- templateId) this installment was instantiated from. NULL for
-- custom-plan installments. This is what a bulk stage raise matches on —
-- see the model doc comment on Installment.milestoneSeq for why percent
-- or label alone would be the wrong key.
ALTER TABLE "installments"
  ADD COLUMN "milestone_type" "MilestoneType" NOT NULL DEFAULT 'DATE_LINKED',
  ADD COLUMN "milestone_seq" INTEGER,
  ADD COLUMN "stage_raise_id" UUID;

-- Every existing installment is backfilled to DATE_LINKED above (the
-- column default). Because of that, the NOT NULL → nullable widening of
-- due_date below cannot actually null out any existing row — the column
-- is nullable only for FUTURE STAGE_LINKED inserts.
ALTER TABLE "installments" ALTER COLUMN "due_date" DROP NOT NULL;

-- Sanity check mirroring the plotted-inventory Phase A migration's own
-- pattern: abort loudly rather than silently proceed if the backfill
-- somehow left a DATE_LINKED row without a date.
DO $$
DECLARE
  bad_count INT;
BEGIN
  SELECT COUNT(*) INTO bad_count
    FROM "installments"
   WHERE "milestone_type" = 'DATE_LINKED' AND "due_date" IS NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Backfill left % DATE_LINKED installment(s) with a NULL due_date', bad_count;
  END IF;
END
$$;

-- CHECK constraint: DATE_LINKED must always have a due date. STAGE_LINKED
-- may be either (null before raise, set after) — enforced at the row
-- level so this invariant can never silently regress, same discipline as
-- units_shape_hierarchy_chk from the plotted-inventory work.
ALTER TABLE "installments"
  ADD CONSTRAINT "installments_due_date_by_type_chk"
  CHECK (
    ("milestone_type" = 'STAGE_LINKED')
    OR ("milestone_type" = 'DATE_LINKED' AND "due_date" IS NOT NULL)
  );

ALTER TABLE "installments"
  ADD CONSTRAINT "installments_stage_raise_id_fkey"
  FOREIGN KEY ("stage_raise_id") REFERENCES "stage_raises"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── RLS on stage_raises (matches every prior tenant table) ─────────────
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY['stage_raises'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_policy ON %I
         FOR ALL
         USING (company_id = current_setting(''app.current_company_id'', true)::uuid)
         WITH CHECK (company_id = current_setting(''app.current_company_id'', true)::uuid)',
      tbl
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO openestate_app', tbl);
  END LOOP;
END
$$;
