#!/usr/bin/env bash
# Lists every foreign key the database has not validated, with the number of
# rows that point at a row that no longer exists ("orphans"). Read-only: the
# session is opened read-only and the query only counts. Safe to run at any
# time on a live install.
#
# Since v0.8.4 a foreign key whose existing rows include orphans is kept
# NOT VALID instead of blocking the upgrade (new and changed rows are still
# checked). upgrade-native.sh prints the same list after migrating.
#
# Usage:
#   sudo ./check-foreign-keys.sh                 # local database, as the postgres OS user
#   DB_HOST=db.example PG_SUPERUSER=postgres PG_SUPERUSER_PASSWORD=... ./check-foreign-keys.sh
#
# Exit status: 0 all validated, 2 some not validated, 1 the check could not run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

case "${1:-}" in
  -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
esac

command -v psql >/dev/null 2>&1 || die "psql not found. Install the PostgreSQL client package."

export PGOPTIONS="-c default_transaction_read_only=on"
status=0
print_unvalidated_foreign_keys || status=$?
exit "$status"
