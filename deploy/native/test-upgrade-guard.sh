#!/usr/bin/env bash
# Tests the v0.8.4 Part N downgrade guard in deploy/native/lib.sh
# (version_is_older, guard_upgrade) against throwaway folders. Needs bash and
# node. The end-to-end refusal on a real install is in CI's upgrade job.
#
#   bash deploy/native/test-upgrade-guard.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); printf 'ok   - %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL - %s\n' "$1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

# shellcheck source=lib.sh
source "$HERE/lib.sh"

older() { if version_is_older "$1" "$2"; then echo older; else echo not; fi; }
check "0.8.3 is older than 0.8.4" "$(older 0.8.3 0.8.4)" older
check "0.8.4 is not older than 0.8.4" "$(older 0.8.4 0.8.4)" not
check "0.8.10 is not older than 0.8.9 (numeric, not text)" "$(older 0.8.10 0.8.9)" not
check "0.10.0 is not older than 0.9.0 (numeric, not text)" "$(older 0.10.0 0.9.0)" not
check "0.9.0-rc1 is older than 0.9.0" "$(older 0.9.0-rc1 0.9.0)" older
check "0.9.0 is not older than 0.9.0-rc1" "$(older 0.9.0 0.9.0-rc1)" not
check "1.0.0 is not older than 0.9.9" "$(older 1.0.0 0.9.9)" not

# A checkout (src) and a running release, each with a version.
make_src() { # make_src DIR VERSION MIGRATION...
  local dir="$1" version="$2"; shift 2
  mkdir -p "$dir/apps/api" "$dir/packages/db/prisma/migrations"
  printf '{"version":"%s"}\n' "$version" > "$dir/apps/api/package.json"
  local m; for m in "$@"; do mkdir -p "$dir/packages/db/prisma/migrations/$m"; done
}
make_running() { mkdir -p "$1/api"; printf '{"version":"%s"}\n' "$2" > "$1/api/package.json"; }

APPLIED=$'20260720000000_phase1_core\n20261015000000_portal_document_scope'
run_guard() { OUT="$(guard_upgrade "$1" "$2" "$3" 2>&1)"; RC=$?; }

make_running "$TMP/running" 0.8.4

make_src "$TMP/same" 0.8.4 20260720000000_phase1_core 20261015000000_portal_document_scope
run_guard "$TMP/same" "$TMP/running" "$APPLIED"
check "same version, same migrations: allowed" "$RC" 0

make_src "$TMP/newer" 0.8.5 20260720000000_phase1_core 20261015000000_portal_document_scope 20261101000000_next
run_guard "$TMP/newer" "$TMP/running" "$APPLIED"
check "newer version with an extra migration of its own: allowed" "$RC" 0

make_src "$TMP/older" 0.8.3 20260720000000_phase1_core 20261015000000_portal_document_scope
run_guard "$TMP/older" "$TMP/running" "$APPLIED"
check "older version: refused" "$RC" 1
case "$OUT" in *"would install version 0.8.3, but this server runs 0.8.4"*"cannot go back"*"restore-native.sh"*) ok "older version: plain message naming both versions";; *) bad "older version: message (got: $OUT)";; esac

make_src "$TMP/behind" 0.8.4 20260720000000_phase1_core
run_guard "$TMP/behind" "$TMP/running" "$APPLIED"
check "database one migration ahead of the checkout: refused" "$RC" 1
case "$OUT" in *"does not contain:"*"20261015000000_portal_document_scope"*"older code against a newer database"*) ok "database ahead: names the migration";; *) bad "database ahead: message (got: $OUT)";; esac

# The staging VM's case: a migration from an unmerged branch, same version number.
run_guard "$TMP/same" "$TMP/running" "$APPLIED"$'\n20260930120000_follow_up_type_is_site_visit'
check "unmerged-branch migration in the database: refused" "$RC" 1
case "$OUT" in *"20260930120000_follow_up_type_is_site_visit"*) ok "unmerged-branch migration: named";; *) bad "unmerged-branch migration: message (got: $OUT)";; esac

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
