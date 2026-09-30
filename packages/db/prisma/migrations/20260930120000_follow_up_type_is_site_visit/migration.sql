-- Stable site-visit marker on follow-up types. Additive: NOT NULL with a
-- constant default is metadata-only on PostgreSQL 11+, and the previous
-- release simply ignores the column during the upgrade window.
ALTER TABLE "follow_up_types" ADD COLUMN "is_site_visit" BOOLEAN NOT NULL DEFAULT false;

-- Existing installs: the seeded name was the only signal until now.
UPDATE "follow_up_types" SET "is_site_visit" = true WHERE "name" = 'Site Visit';
