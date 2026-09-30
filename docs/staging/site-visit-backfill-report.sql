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
\echo '== 5. Per follow-up type: how many follow-up rows change classification'
-- Follow-up rows themselves are never modified. What changes is how the app classifies them: a row whose type gets
-- flagged starts to count as a site visit (GET /site-visits, dashboard counts). rows_become_site_visit is that number.
-- rows_in_legacy_report is what the existing pre-sales "Site visit" report counts today (exact name 'Site Visit');
-- rows_app_only is the difference: visits the app will show that the old report does not.
-- Types with no rows and no rule match are omitted.
SELECT t.company_id,
       '[' || t.name || ']'                                                            AS type_name,
       count(f.*)                                                                      AS follow_up_rows,
       count(f.*) FILTER (WHERE lower(btrim(t.name)) = 'site visit')                   AS rows_become_site_visit,
       count(f.*) FILTER (WHERE t.name = 'Site Visit')                                 AS rows_in_legacy_report,
       count(f.*) FILTER (WHERE lower(btrim(t.name)) = 'site visit' AND t.name <> 'Site Visit') AS rows_app_only
  FROM follow_up_types t
  LEFT JOIN follow_ups f ON f.follow_up_type_id = t.id
 GROUP BY t.company_id, t.name
HAVING count(f.*) > 0 OR lower(btrim(t.name)) = 'site visit'
 ORDER BY t.company_id, t.name;

\echo
\echo '== 5b. Totals of the above'
SELECT count(f.*) FILTER (WHERE lower(btrim(t.name)) = 'site visit')                   AS rows_become_site_visit,
       count(f.*) FILTER (WHERE t.name = 'Site Visit')                                 AS rows_in_legacy_report,
       count(f.*) FILTER (WHERE lower(btrim(t.name)) = 'site visit' AND t.name <> 'Site Visit') AS rows_app_only,
       count(f.*) FILTER (WHERE lower(btrim(t.name)) <> 'site visit')                  AS rows_stay_unclassified
  FROM follow_ups f JOIN follow_up_types t ON t.id = f.follow_up_type_id;

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

\echo
\echo '== 10. AFTER: follow-up rows by flag (must equal rows_become_site_visit from section 5b)'
SELECT count(f.*) FILTER (WHERE t.is_site_visit)     AS rows_now_site_visit,
       count(f.*) FILTER (WHERE NOT t.is_site_visit) AS rows_not_site_visit
  FROM follow_ups f JOIN follow_up_types t ON t.id = f.follow_up_type_id;
\endif
