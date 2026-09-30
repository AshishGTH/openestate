-- Stable site-visit marker on follow-up types. Additive: NOT NULL with a
-- constant default is metadata-only on PostgreSQL 11+, and the previous
-- release simply ignores the column during the upgrade window.
ALTER TABLE "follow_up_types" ADD COLUMN "is_site_visit" BOOLEAN NOT NULL DEFAULT false;

-- Existing installs: the seeded name was the only signal until now. Match it ignoring case and
-- surrounding spaces ("Site visit", "Site Visit "), which are the same type to the people who typed them; a
-- false negative silently empties the site-visit list, a false positive is one admin toggle. Names that merely
-- CONTAIN it ("Site Visit Follow-up") are not matched.
UPDATE "follow_up_types" SET "is_site_visit" = true WHERE lower(btrim("name")) = 'site visit';
