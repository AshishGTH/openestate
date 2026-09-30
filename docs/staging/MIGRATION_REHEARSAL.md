# Site-visit migration rehearsal (staging copy)

Migration: `packages/db/prisma/migrations/20260930120000_follow_up_type_is_site_visit`. It adds
`follow_up_types.is_site_visit boolean NOT NULL DEFAULT false`, then sets it to `true` where
`lower(btrim(name)) = 'site visit'`. It changes no other row and no follow-up.

**Never run this on production data.** Work on a restored copy, on the staging host. Every result cell below is
**NOT TESTED** until you fill it in. The report script was run only against a small synthetic database (to check the SQL
itself); it has not been run against a real copy.

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

Section 8 must show `rule_matches_not_flagged_should_be_0 = 0`.

## 5. Record the result

| Item | Value |
|---|---|
| Companies | NOT TESTED |
| Follow-up types in total | NOT TESTED |
| Existing "Site Visit"-like types (rule matches, before) | NOT TESTED |
| Auto-flagged (`flagged_total`, after) | NOT TESTED |
| Left unclassified (`left_unclassified`) | NOT TESTED |
| Unclassified types that are really site visits (needs a manual flag) | NOT TESTED |

Variants that must behave exactly like this (section 4 shows whether they exist in your data; create them on the copy if
not, and re-run the migration test path by inserting them before step 3):

| Name | Expected | Result |
|---|---|---|
| `Site Visit` | flagged | NOT TESTED |
| `site visit` | flagged | NOT TESTED |
| `SITE VISIT` | flagged | NOT TESTED |
| `Site Visit ` (trailing space) | flagged | NOT TESTED |
| `Site Visit Follow-up` | **not** flagged | NOT TESTED |

## 6. Reports and screens after the migration

With the new API running against the copy, compare with a run on the old API against the same data:

| Check | Result |
|---|---|
| Pre-sales "Site visit" report (Reports menu) returns the same rows as before | NOT TESTED |
| Other pre-sales reports (funnel, source-wise, staff performance) unchanged | NOT TESTED |
| `GET /api/v1/site-visits` returns the visits of flagged types and none of the unflagged | NOT TESTED |
| Web app inquiry detail and follow-up screens load | NOT TESTED |

Known and expected: the pre-sales **report** still matches the exact name `Site Visit` (report section 6 in the script
shows the difference). A type named `site visit` is flagged for the app but is not counted by that report until the report is
switched to the flag (documented follow-up).

## 7. If something is wrong

The migration is forward-only. On the copy, drop the database and restore again. On a real install, the pre-upgrade
backup made by `upgrade-native.sh` is the rollback tool, decided by a person.
