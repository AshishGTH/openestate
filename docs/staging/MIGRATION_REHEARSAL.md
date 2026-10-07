# Site-visit migration rehearsal (staging copy)

Migration: `packages/db/prisma/migrations/20260930120000_follow_up_type_is_site_visit`. It adds
`follow_up_types.is_site_visit boolean NOT NULL DEFAULT false`, then sets it to `true` where
`lower(btrim(name)) = 'site visit'`. It changes no other row and no follow-up.

**Never run this on production data.** Work on a restored copy, on the staging host. Every result cell below is
**NOT TESTED** until you fill it in. The report script has been run on the staging host against test data (2026-10-07, section 5);
it has not been run against a real copy.

## 1. Make the copy

```bash
# on the staging host, as the postgres OS user
sudo -u postgres createdb openestate_rehearsal
sudo -u postgres pg_restore --no-owner -d openestate_rehearsal /path/to/backup.dump   # or psql -f for a plain dump
# openestate_app / openestate_system / openestate_super must exist (deploy/native/setup-database.sh creates them)
export STAGING_DB_URL="postgresql://postgres@/openestate_rehearsal"   # local peer auth; no password needed
```

If you are rehearsing on the real staging database rather than a separate one, take `backup-native.sh` first and
accept that the migration is applied for real there.

## 2. Report BEFORE

```bash
psql "$STAGING_DB_URL" -f docs/staging/site-visit-backfill-report.sql | tee before.txt
```

The column does not exist yet, so the report shows what the rule **will** flag (sections 1-6). It writes nothing.

## 3. Apply the migration

Either run the upgrade (see `DEPLOY.md`), or only the migration against the copy:

```bash
cd packages/db && DATABASE_URL="$STAGING_DB_URL" npx prisma migrate deploy
```

## 4. Report AFTER

```bash
psql "$STAGING_DB_URL" -v after=true -f docs/staging/site-visit-backfill-report.sql | tee after.txt
```

Section 8 must show `rule_matches_not_flagged_should_be_0 = 0`, and section 10 must show `rows_now_site_visit` equal to
the `rows_become_site_visit` total from section 5b (before the migration).

## 5. Record the result

**Test-data rehearsal only.** Staging run 2026-10-07: staging VM 192.168.1.20 (Ubuntu 24.04.5, nginx 1.24.0, Node 20.20.2, PostgreSQL 16.15, Redis 7.0.15), self-signed cert, test data only; upgraded v0.8.2 (`d337a73`) -> `chore/rc-with-deps` (`bf29620`). The VM held no real data (1 company, 16 users, 14 inquiries before the seed), so this was rehearsed on the staging database itself after `backup-native.sh`, with the four name variants inserted as fixtures. **Real-data rehearsal (a restored production backup): NOT TESTED.**

| Item | Value |
|---|---|
| Companies | 3 (1 existing test company + 2 created by the compat seed) |
| Follow-up types in total | 12 (6 existing, 2 from the seed, 4 variant fixtures) |
| Existing "Site Visit"-like types (rule matches, before) | 5 |
| Auto-flagged (`flagged_total`, after) | 5 (all by rule; section 8 `rule_matches_not_flagged` = 0) |
| Left unclassified (`left_unclassified`) | 7 |
| Unclassified types that are really site visits (needs a manual flag) | 0 (`Site Visit Follow-up` is the only look-alike, unflagged on purpose) |
| Follow-up rows that become site visits (`rows_become_site_visit`, section 5b) | 85; after the migration `rows_now_site_visit` = 85 (match) |
| of which the old report already counted (`rows_in_legacy_report`) | 85 |
| of which only the app will show (`rows_app_only`) | 0 |
| Follow-up rows that stay unclassified (`rows_stay_unclassified`) | 23 |

Variants that must behave exactly like this (section 4 shows whether they exist in your data; create them on the copy if
not, and re-run the migration test path by inserting them before step 3):

| Name | Expected | Result |
|---|---|---|
| `Site Visit` | flagged | PASS (2 types) |
| `site visit` | flagged | PASS |
| `SITE VISIT` | flagged | PASS |
| `Site Visit ` (trailing space) | flagged | PASS |
| `Site Visit Follow-up` | **not** flagged | PASS (unflagged) |

## 6. Reports and screens after the migration

With the new API running against the copy, compare with a run on the old API against the same data:

| Check | Result |
|---|---|
| Pre-sales "Site visit" report (Reports menu) returns the same rows as before | NOT TESTED |
| Other pre-sales reports (funnel, source-wise, staff performance) unchanged | Funnel: PASS (compat test, v0.8.2 and RC identical). Source-wise, staff performance: NOT TESTED |
| `GET /api/v1/site-visits` returns the visits of flagged types and none of the unflagged | PASS: 83 of 83 seeded visits, all of the flagged type; the 20 `Phone Call` follow-ups excluded |
| Web app inquiry detail and follow-up screens load | NOT TESTED (no browser run) |

Known and expected: the pre-sales **report** still matches the exact name `Site Visit` (report section 6 in the script
shows the difference). A type named `site visit` is flagged for the app but is not counted by that report until the report is
switched to the flag (documented follow-up).

## 7. If something is wrong

The migration is forward-only. On the copy, drop the database and restore again. On a real install, the pre-upgrade
backup made by `upgrade-native.sh` is the rollback tool, decided by a person.
