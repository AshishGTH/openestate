-- Phase 6: customer portal and broker portal. Run as the DB owner role
-- (superuser / table creator). HAND-WRITTEN, not a raw `prisma migrate
-- diff` — same reason as every phase since Phase 4: several FKs below
-- are scalar-only (Relation policy), and this migration also creates
-- SQL functions + RESTRICTIVE RLS policies `prisma migrate diff` has no
-- concept of. See CLAUDE.md Phase 6 decisions for the full rationale.

-- ============================================================
-- 1. Additive/altered columns on existing (frozen-ish) tables
-- ============================================================

-- User.email nullable: a phone-only portal invite creates a User with
-- email = null, never a synthesized placeholder address. Staff
-- creation is unaffected — it always supplies email.
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;

-- Portal identity — scalar-only FKs (Relation policy), exactly one set
-- per portal User, both null for every staff User.
ALTER TABLE "users" ADD COLUMN "applicant_id" UUID;
ALTER TABLE "users" ADD COLUMN "broker_id" UUID;
ALTER TABLE "users" ADD COLUMN "notification_prefs" JSONB;

CREATE INDEX "users_company_id_phone_idx" ON "users"("company_id", "phone");

ALTER TABLE "company_configs" ADD COLUMN "logo_url" VARCHAR(500);
ALTER TABLE "company_configs" ADD COLUMN "primary_color_hex" VARCHAR(7);

-- ============================================================
-- 2. Tables
-- ============================================================

CREATE TABLE "portal_invites" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "applicant_id" UUID,
    "broker_id" UUID,
    "channel" VARCHAR(10) NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "wrong_attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "invalidated_reason" VARCHAR(50),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_invites_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "portal_password_resets" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_password_resets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "applicant_change_requests" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "applicant_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "field_changes" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "review_note" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applicant_change_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ticket_categories" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ticket_categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tickets" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "raised_by_id" UUID NOT NULL,
    "applicant_id" UUID,
    "broker_id" UUID,
    "category_id" UUID NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "sla_by_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ticket_messages" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "author_is_staff" BOOLEAN NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "construction_updates" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "published_at" TIMESTAMP(3) NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_updates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "construction_update_media" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "construction_update_id" UUID NOT NULL,
    "stored_name" VARCHAR(255) NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_update_media_pkey" PRIMARY KEY ("id")
);

-- ============================================================
-- 3. Indexes
-- ============================================================

CREATE INDEX "portal_invites_token_hash_idx" ON "portal_invites"("token_hash");
CREATE INDEX "portal_password_resets_token_hash_idx" ON "portal_password_resets"("token_hash");
CREATE INDEX "applicant_change_requests_company_id_applicant_id_status_idx" ON "applicant_change_requests"("company_id", "applicant_id", "status");
CREATE INDEX "tickets_company_id_applicant_id_idx" ON "tickets"("company_id", "applicant_id");
CREATE INDEX "tickets_company_id_broker_id_idx" ON "tickets"("company_id", "broker_id");
CREATE INDEX "construction_updates_company_id_project_id_idx" ON "construction_updates"("company_id", "project_id");

-- ============================================================
-- 4. Foreign keys — core relations (Prisma-declared)
-- ============================================================

ALTER TABLE "portal_invites" ADD CONSTRAINT "portal_invites_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "portal_password_resets" ADD CONSTRAINT "portal_password_resets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "applicant_change_requests" ADD CONSTRAINT "applicant_change_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ticket_categories" ADD CONSTRAINT "ticket_categories_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "construction_updates" ADD CONSTRAINT "construction_updates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "construction_update_media" ADD CONSTRAINT "construction_update_media_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "construction_update_media" ADD CONSTRAINT "construction_update_media_construction_update_id_fkey" FOREIGN KEY ("construction_update_id") REFERENCES "construction_updates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 5. Foreign keys — scalar user/applicant/broker/master references
--    (hand-authored, same relation policy as the Phase 4/5 ledger core)
-- ============================================================

ALTER TABLE "users" ADD CONSTRAINT "users_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "applicants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "portal_invites" ADD CONSTRAINT "portal_invites_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "applicants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "portal_invites" ADD CONSTRAINT "portal_invites_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "portal_invites" ADD CONSTRAINT "portal_invites_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "portal_password_resets" ADD CONSTRAINT "portal_password_resets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "applicant_change_requests" ADD CONSTRAINT "applicant_change_requests_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "applicants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "applicant_change_requests" ADD CONSTRAINT "applicant_change_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "applicant_change_requests" ADD CONSTRAINT "applicant_change_requests_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tickets" ADD CONSTRAINT "tickets_raised_by_id_fkey" FOREIGN KEY ("raised_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "applicants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "ticket_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "construction_updates" ADD CONSTRAINT "construction_updates_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "construction_updates" ADD CONSTRAINT "construction_updates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- 6. Row-Level Security — standard company-tenant policy for the 8
--    new tables (unchanged shape, reuses the established loop pattern)
-- ============================================================

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'portal_invites', 'portal_password_resets', 'applicant_change_requests',
      'ticket_categories', 'tickets', 'ticket_messages',
      'construction_updates', 'construction_update_media'
    ])
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
  END LOOP;
END
$$;

-- ============================================================
-- 7. Portal RLS helper functions (required change #1 from plan review)
--
-- STABLE so the planner treats a call as a constant subexpression
-- within a statement instead of re-parsing/re-casting the GUC string
-- (or re-running the bookings subquery) once per row scanned — verified
-- via EXPLAIN (ANALYZE, VERBOSE) during implementation; see CLAUDE.md
-- Phase 6 decisions for the observed plan shape. NULLIF(..., '') turns
-- both "GUC never set" and "GUC explicitly cleared to ''" (the
-- unconditional-hygiene write from setTenantOnTx) into the same NULL,
-- so callers never need to care which case they're in.
-- ============================================================

CREATE FUNCTION portal_applicant() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.portal_applicant_id', true), '')::uuid
$$;

CREATE FUNCTION portal_broker() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.portal_broker_id', true), '')::uuid
$$;

-- Shared "can this portal session reach this booking" check, reused by
-- every booking_id-only-bearing table's policy below instead of
-- duplicating the same three-branch subquery per table. Runs under the
-- CALLING role's privileges (not SECURITY DEFINER), so its own internal
-- SELECTs are themselves subject to bookings'/booking_co_applicants'
-- RLS — a booking invisible to this session can't be "seen" from
-- inside the function either, which is the correct, consistent
-- behaviour, not a bug.
CREATE FUNCTION portal_can_access_booking(p_booking_id uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.id = p_booking_id
      AND (
        (portal_applicant() IS NOT NULL AND b.primary_applicant_id = portal_applicant())
        OR (portal_broker() IS NOT NULL AND b.broker_id = portal_broker())
        OR (portal_applicant() IS NOT NULL AND EXISTS (
              SELECT 1 FROM booking_co_applicants bc
              WHERE bc.booking_id = b.id AND bc.applicant_id = portal_applicant()
            ))
      )
  )
$$;

-- SECURITY DEFINER, narrow single-purpose helper. EXISTS ONLY to break the
-- bookings <-> booking_co_applicants RLS recursion cycle (confirmed by a
-- failing test before this fix: Postgres error 42P17, infinite recursion
-- detected in policy for relation "bookings") — bookings_portal_scope's
-- co-applicant branch needs to check booking_co_applicants, and
-- booking_co_applicants_portal_scope needs to check bookings back; without
-- a bypass on ONE of those two edges, evaluating either policy forces
-- evaluating the other, forever. This function is that one bypass edge:
-- a single parameterized existence check on booking_co_applicants, nothing
-- else — no dynamic SQL, no other table touched. Do NOT extend this
-- function's scope and do NOT add a second SECURITY DEFINER helper to
-- patch some other RLS gap later; any future recursion in this policy set
-- needs the RLS design re-audited, not another ad hoc bypass.
CREATE FUNCTION booking_has_co_applicant(p_booking_id uuid, p_applicant_id uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM booking_co_applicants
    WHERE booking_id = p_booking_id AND applicant_id = p_applicant_id
  )
$$;

REVOKE ALL ON FUNCTION booking_has_co_applicant(uuid, uuid) FROM PUBLIC;

-- ============================================================
-- 8. Portal RESTRICTIVE policies — ANDed with each table's existing
--    tenant_isolation_policy, so this can only ever NARROW access,
--    never grant access the tenant policy wouldn't already allow. A
--    staff session (both portal_applicant()/portal_broker() NULL)
--    always takes the first branch and is completely unaffected.
-- ============================================================

-- bookings: direct primary_applicant_id/broker_id + co-applicant
-- carve-out. The co-applicant check goes through booking_has_co_applicant()
-- (SECURITY DEFINER — see its doc comment) rather than a normal EXISTS
-- subquery on booking_co_applicants, specifically so evaluating this
-- policy never triggers booking_co_applicants_portal_scope, which itself
-- queries bookings — that mutual reference is what caused 42P17 before
-- this fix. Deliberately not calling portal_can_access_booking either,
-- which itself queries bookings, to avoid any self-referential shape.
CREATE POLICY bookings_portal_scope ON "bookings" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR (portal_applicant() IS NOT NULL AND primary_applicant_id = portal_applicant())
    OR (portal_broker() IS NOT NULL AND broker_id = portal_broker())
    OR (portal_applicant() IS NOT NULL AND booking_has_co_applicant(bookings.id, portal_applicant()))
  );

-- Queries bookings directly (normal, RLS-enforced) — safe now that
-- bookings_portal_scope no longer queries booking_co_applicants as a
-- normal table read (see booking_has_co_applicant's doc comment); this
-- edge of the former cycle is the one left un-bypassed.
CREATE POLICY booking_co_applicants_portal_scope ON "booking_co_applicants" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR (portal_applicant() IS NOT NULL AND applicant_id = portal_applicant())
    OR (portal_applicant() IS NOT NULL AND booking_id IN (
          SELECT id FROM bookings WHERE primary_applicant_id = portal_applicant()
        ))
    OR (portal_broker() IS NOT NULL AND booking_id IN (
          SELECT id FROM bookings WHERE broker_id = portal_broker()
        ))
  );

-- booking_id-only tables: reuse portal_can_access_booking().
CREATE POLICY installments_portal_scope ON "installments" AS RESTRICTIVE
  USING ((portal_applicant() IS NULL AND portal_broker() IS NULL) OR portal_can_access_booking(booking_id));

CREATE POLICY payment_plans_portal_scope ON "payment_plans" AS RESTRICTIVE
  USING ((portal_applicant() IS NULL AND portal_broker() IS NULL) OR portal_can_access_booking(booking_id));

CREATE POLICY receipts_portal_scope ON "receipts" AS RESTRICTIVE
  USING ((portal_applicant() IS NULL AND portal_broker() IS NULL) OR portal_can_access_booking(booking_id));

CREATE POLICY ledger_entries_portal_scope ON "ledger_entries" AS RESTRICTIVE
  USING ((portal_applicant() IS NULL AND portal_broker() IS NULL) OR portal_can_access_booking(booking_id));

-- receipt_allocations has no booking_id of its own — go via receipts.
CREATE POLICY receipt_allocations_portal_scope ON "receipt_allocations" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR receipt_id IN (SELECT id FROM receipts WHERE portal_can_access_booking(booking_id))
  );

-- Direct applicant_id/broker_id columns.
CREATE POLICY generated_documents_portal_scope ON "generated_documents" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR (portal_applicant() IS NOT NULL AND applicant_id = portal_applicant())
    OR (portal_broker() IS NOT NULL AND broker_id = portal_broker())
    OR (booking_id IS NOT NULL AND portal_can_access_booking(booking_id))
  );

CREATE POLICY document_dispatches_portal_scope ON "document_dispatches" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR (portal_applicant() IS NOT NULL AND applicant_id = portal_applicant())
    OR (booking_id IS NOT NULL AND portal_can_access_booking(booking_id))
  );

CREATE POLICY applicant_documents_portal_scope ON "applicant_documents" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR (portal_applicant() IS NOT NULL AND applicant_id = portal_applicant())
  );

CREATE POLICY applicant_addresses_portal_scope ON "applicant_addresses" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR (portal_applicant() IS NOT NULL AND applicant_id = portal_applicant())
  );

-- applicants: self, co-applicant carve-out (both directions), and a
-- sourcing broker's own customers.
CREATE POLICY applicants_portal_scope ON "applicants" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR (portal_applicant() IS NOT NULL AND id = portal_applicant())
    OR (portal_applicant() IS NOT NULL AND EXISTS (
          SELECT 1 FROM bookings b
          JOIN booking_co_applicants bc ON bc.booking_id = b.id
          WHERE (b.primary_applicant_id = portal_applicant() AND bc.applicant_id = applicants.id)
             OR (bc.applicant_id = portal_applicant() AND b.primary_applicant_id = applicants.id)
        ))
    OR (portal_broker() IS NOT NULL AND EXISTS (
          SELECT 1 FROM bookings b
          WHERE b.broker_id = portal_broker()
            AND (b.primary_applicant_id = applicants.id OR EXISTS (
                  SELECT 1 FROM booking_co_applicants bc2
                  WHERE bc2.booking_id = b.id AND bc2.applicant_id = applicants.id
                ))
        ))
  );

CREATE POLICY commission_ledger_entries_portal_scope ON "commission_ledger_entries" AS RESTRICTIVE
  USING ((portal_applicant() IS NULL AND portal_broker() IS NULL) OR (portal_broker() IS NOT NULL AND broker_id = portal_broker()));

CREATE POLICY commission_payments_portal_scope ON "commission_payments" AS RESTRICTIVE
  USING ((portal_applicant() IS NULL AND portal_broker() IS NULL) OR (portal_broker() IS NOT NULL AND broker_id = portal_broker()));

CREATE POLICY broker_nocs_portal_scope ON "broker_nocs" AS RESTRICTIVE
  USING ((portal_applicant() IS NULL AND portal_broker() IS NULL) OR (portal_broker() IS NOT NULL AND broker_id = portal_broker()));

CREATE POLICY brokers_portal_scope ON "brokers" AS RESTRICTIVE
  USING ((portal_applicant() IS NULL AND portal_broker() IS NULL) OR (portal_broker() IS NOT NULL AND id = portal_broker()));

CREATE POLICY applicant_change_requests_portal_scope ON "applicant_change_requests" AS RESTRICTIVE
  USING ((portal_applicant() IS NULL AND portal_broker() IS NULL) OR (portal_applicant() IS NOT NULL AND applicant_id = portal_applicant()));

CREATE POLICY tickets_portal_scope ON "tickets" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR (portal_applicant() IS NOT NULL AND applicant_id = portal_applicant())
    OR (portal_broker() IS NOT NULL AND broker_id = portal_broker())
  );

-- units/floors/towers/projects: asymmetric — a broker's "live
-- availability view" means portal_broker() IS NOT NULL alone passes
-- (no unit-level restriction); a customer's branch restricts through
-- their own bookings, cascaded up the floor/tower/project hierarchy.
CREATE POLICY units_portal_scope ON "units" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR portal_broker() IS NOT NULL
    OR (portal_applicant() IS NOT NULL AND id IN (
          SELECT unit_id FROM bookings b WHERE portal_can_access_booking(b.id)
        ))
  );

CREATE POLICY floors_portal_scope ON "floors" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR portal_broker() IS NOT NULL
    OR (portal_applicant() IS NOT NULL AND id IN (
          SELECT u.floor_id FROM units u
          JOIN bookings b ON b.unit_id = u.id
          WHERE portal_can_access_booking(b.id)
        ))
  );

CREATE POLICY towers_portal_scope ON "towers" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR portal_broker() IS NOT NULL
    OR (portal_applicant() IS NOT NULL AND id IN (
          SELECT f.tower_id FROM floors f
          JOIN units u ON u.floor_id = f.id
          JOIN bookings b ON b.unit_id = u.id
          WHERE portal_can_access_booking(b.id)
        ))
  );

CREATE POLICY projects_portal_scope ON "projects" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR portal_broker() IS NOT NULL
    OR (portal_applicant() IS NOT NULL AND id IN (
          SELECT t.project_id FROM towers t
          JOIN floors f ON f.tower_id = t.id
          JOIN units u ON u.floor_id = f.id
          JOIN bookings b ON b.unit_id = u.id
          WHERE portal_can_access_booking(b.id)
        ))
  );

-- construction_updates/media: same project-reachability shape as
-- projects_portal_scope above.
CREATE POLICY construction_updates_portal_scope ON "construction_updates" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR portal_broker() IS NOT NULL
    OR (portal_applicant() IS NOT NULL AND project_id IN (
          SELECT t.project_id FROM bookings b
          JOIN units u ON u.id = b.unit_id
          JOIN floors f ON f.id = u.floor_id
          JOIN towers t ON t.id = f.tower_id
          WHERE portal_can_access_booking(b.id)
        ))
  );

CREATE POLICY construction_update_media_portal_scope ON "construction_update_media" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR portal_broker() IS NOT NULL
    OR (portal_applicant() IS NOT NULL AND construction_update_id IN (
          SELECT cu.id FROM construction_updates cu
          WHERE cu.project_id IN (
            SELECT t.project_id FROM bookings b
            JOIN units u ON u.id = b.unit_id
            JOIN floors f ON f.id = u.floor_id
            JOIN towers t ON t.id = f.tower_id
            WHERE portal_can_access_booking(b.id)
          )
        ))
  );

-- ============================================================
-- 9. Grants
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openestate_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openestate_system;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO openestate_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO openestate_system;
GRANT EXECUTE ON FUNCTION portal_applicant() TO openestate_app, openestate_system;
GRANT EXECUTE ON FUNCTION portal_broker() TO openestate_app, openestate_system;
GRANT EXECUTE ON FUNCTION portal_can_access_booking(uuid) TO openestate_app, openestate_system;
-- openestate_system already bypasses RLS directly; it has no need for a
-- function whose sole purpose is bypassing RLS on booking_co_applicants.
GRANT EXECUTE ON FUNCTION booking_has_co_applicant(uuid, uuid) TO openestate_app;
