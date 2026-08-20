-- Real bug found while writing the through-the-wire test for the
-- portal-property.service.ts crash fix (plotted-farmhouse-inventory
-- Phase B, §13.1): the four portal RLS policies below reach a project
-- ONLY via towers -> floors -> units (JOIN floors f ON f.id = u.floor_id).
-- For a LAND_BASED unit (Unit.floor_id IS NULL, Phase A), that join
-- matches zero rows — so a customer whose booking is against a
-- floorless unit could not see their OWN project, construction
-- updates, construction-update media, or project media at the
-- database level, no matter what the application code did. This is
-- deeper than the app-layer null-unsafe read fixed alongside this
-- migration: even a perfectly null-safe read would have received an
-- empty/RLS-filtered result, not the customer's real data.
--
-- Fix: every one of these four policies is rewritten to reach the
-- project via units.project_id directly (Phase A's scalar), which is
-- populated for every unit regardless of shape. This also simplifies
-- each policy — the floors/towers joins are no longer needed at all,
-- since project_id was always the thing being derived through them.
-- floors_portal_scope / towers_portal_scope / units_portal_scope are
-- untouched: a LAND_BASED unit genuinely has no floor/tower row to
-- reach, so those policies have nothing to fix.

DROP POLICY IF EXISTS "projects_portal_scope" ON "projects";
CREATE POLICY "projects_portal_scope" ON "projects" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR portal_broker() IS NOT NULL
    OR (portal_applicant() IS NOT NULL AND id IN (
          SELECT u.project_id FROM units u
          JOIN bookings b ON b.unit_id = u.id
          WHERE portal_can_access_booking(b.id)
        ))
  );

DROP POLICY IF EXISTS "construction_updates_portal_scope" ON "construction_updates";
CREATE POLICY "construction_updates_portal_scope" ON "construction_updates" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR portal_broker() IS NOT NULL
    OR (portal_applicant() IS NOT NULL AND project_id IN (
          SELECT u.project_id FROM bookings b
          JOIN units u ON u.id = b.unit_id
          WHERE portal_can_access_booking(b.id)
        ))
  );

DROP POLICY IF EXISTS "construction_update_media_portal_scope" ON "construction_update_media";
CREATE POLICY "construction_update_media_portal_scope" ON "construction_update_media" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR portal_broker() IS NOT NULL
    OR (portal_applicant() IS NOT NULL AND construction_update_id IN (
          SELECT cu.id FROM construction_updates cu
          WHERE cu.project_id IN (
            SELECT u.project_id FROM bookings b
            JOIN units u ON u.id = b.unit_id
            WHERE portal_can_access_booking(b.id)
          )
        ))
  );

DROP POLICY IF EXISTS "project_media_portal_scope" ON "project_media";
CREATE POLICY "project_media_portal_scope" ON "project_media" AS RESTRICTIVE
  USING (
    (portal_applicant() IS NULL AND portal_broker() IS NULL)
    OR portal_broker() IS NOT NULL
    OR (portal_applicant() IS NOT NULL AND project_id IN (
          SELECT u.project_id FROM bookings b
          JOIN units u ON u.id = b.unit_id
          WHERE portal_can_access_booking(b.id)
        ))
  );
