-- Site-visit backfill report. READ-ONLY: contains no INSERT/UPDATE/DELETE/DDL.
-- Run it twice against the staging COPY of the database, never production:
--
--   BEFORE the upgrade (the column is_site_visit does not exist yet):
--     psql "$STAGING_DB_URL" -f docs/staging/site-visit-backfill-report.sql
--   AFTER the upgrade has applied 20260930120000_follow_up_type_is_site_visit:
--     psql "$STAGING_DB_URL" -v after=true -f docs/staging/site-visit-backfill-report.sql
--
-- Connect as a role that can read every company (openestate_system, or the
-- postgres superuser). openestate_app is subject to row-level security and
-- will show nothing without a tenant session.
--
-- Output uses type names and counts only, no customer data.

\set ON_ERROR_STOP on
\pset null '(null)'
\if :{?after}
\else
  \set after false
\endif
\echo '== After the migration?' :after
\echo
\echo '== 1. Totals'
SELECT count(*)                                                           AS follow_up_types,
       count(DISTINCT company_id)                                         AS companies,
       count(*) FILTER (WHERE lower(btrim(name)) = 'site visit')          AS match_backfill_rule
  FROM follow_up_types;

\echo
\echo '== 2. Types the backfill rule will flag / has flagged (lower(btrim(name)) = ''site visit'')'
SELECT company_id, name,
       '[' || name || ']'         AS name_bracketed,   -- shows leading/trailing spaces
       length(name) - length(btrim(name)) AS extra_spaces,
       is_active
  FROM follow_up_types
 WHERE lower(btrim(name)) = 'site visit'
 ORDER BY company_id, name;

\echo
\echo '== 3. Types the rule does NOT match but that look like site visits (review by a person)'
-- These stay unflagged on purpose; an admin flags them by hand.
SELECT company_id, name, is_active
  FROM follow_up_types
 WHERE lower(btrim(name)) <> 'site visit'
   AND (name ILIKE '%site%' OR name ILIKE '%visit%' OR name ILIKE '%tour%' OR name ILIKE '%walk%')
 ORDER BY company_id, name;

\echo
\echo '== 4. The five variants to check by hand (present in this database?)'
SELECT '[' || v.variant || ']' AS variant,
       count(t.*) AS types_with_this_exact_name,
       (lower(btrim(v.variant)) = 'site visit') AS rule_matches
  FROM (VALUES ('Site Visit'), ('site visit'), ('SITE VISIT'), ('Site Visit '), ('Site Visit Follow-up')) AS v(variant)
  LEFT JOIN follow_up_types t ON t.name = v.variant
 GROUP BY v.variant
 ORDER BY v.variant;

\echo
\echo '== 5. Follow-ups per type the site-visit report and list depend on'
-- Existing follow-up rows are not modified by the migration; only the type flag is set.
SELECT t.company_id, t.name, count(f.*) AS follow_ups
  FROM follow_up_types t
  LEFT JOIN follow_ups f ON f.follow_up_type_id = t.id
 WHERE lower(btrim(t.name)) = 'site visit' OR t.name ILIKE '%site%'
 GROUP BY t.company_id, t.name
 ORDER BY t.company_id, t.name;

\echo
\echo '== 6. Existing pre-sales "Site visit" report input: exact-name matches (the report matches name = ''Site Visit'')'
-- The report still matches on the exact name (a documented follow-up), so a type named
-- "site visit" is flagged by the migration but NOT counted by that report.
SELECT count(*) AS follow_ups_counted_by_report
  FROM follow_ups f JOIN follow_up_types t ON t.id = f.follow_up_type_id
 WHERE t.name = 'Site Visit';
SELECT count(*) AS follow_ups_of_flag_candidates
  FROM follow_ups f JOIN follow_up_types t ON t.id = f.follow_up_type_id
 WHERE lower(btrim(t.name)) = 'site visit';

\if :after
\echo
\echo '== 7. AFTER: flag state (is_site_visit) per type'
SELECT company_id, name, is_site_visit, is_active
  FROM follow_up_types
 WHERE is_site_visit OR lower(btrim(name)) = 'site visit'
 ORDER BY company_id, name;

\echo
\echo '== 8. AFTER: counts (record these in MIGRATION_REHEARSAL.md)'
SELECT count(*) FILTER (WHERE is_site_visit)                                   AS flagged_total,
       count(*) FILTER (WHERE is_site_visit AND lower(btrim(name)) = 'site visit') AS flagged_by_rule,
       count(*) FILTER (WHERE is_site_visit AND lower(btrim(name)) <> 'site visit') AS flagged_other_reason,
       count(*) FILTER (WHERE NOT is_site_visit)                               AS left_unclassified,
       count(*) FILTER (WHERE NOT is_site_visit AND lower(btrim(name)) = 'site visit') AS rule_matches_not_flagged_SHOULD_BE_0
  FROM follow_up_types;

\echo
\echo '== 9. AFTER: unclassified types (names only) - anything that is really a site visit needs a manual flag'
SELECT company_id, name, is_active
  FROM follow_up_types
 WHERE NOT is_site_visit
 ORDER BY company_id, name;
\endif
