-- v0.2.3: custom field VALUES for Unit and Project.
--
-- Applicant.custom_fields and Inquiry.custom_fields already exist (added
-- in 20260722000000_phase3_presales) — they were written to but never
-- validated and never read back. This migration brings the other two
-- in-scope entity types up to the same storage shape so an admin can no
-- longer define a field for an entity that silently has nowhere to put a
-- value.
--
-- BOOKING is deliberately NOT included: it would require touching
-- BookingService, which CLAUDE.md freezes. See docs/todo.md.
--
-- Nullable with no default, exactly like the two existing columns — an
-- entity with no custom fields defined stores NULL, not an empty object,
-- so "never had values" and "had values, all cleared" stay
-- distinguishable.

ALTER TABLE "units" ADD COLUMN "custom_fields" JSONB;
ALTER TABLE "projects" ADD COLUMN "custom_fields" JSONB;

-- No RLS changes needed: both tables already have
-- tenant_isolation_policy and are already registered in
-- TENANT_SCOPED_MODELS. A JSONB column inherits the host row's
-- protection entirely — that isolation-surface argument is precisely
-- why this release stores values inline rather than in a separate EAV
-- table (which would have needed its own policy, its own registration,
-- and its own portal-scope analysis).
