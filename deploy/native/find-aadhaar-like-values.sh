#!/usr/bin/env bash
# Read-only report: where do Aadhaar-like values already sit in custom fields?
#
# Custom-field values are checked for Aadhaar-like numbers when they are
# saved, but data stored BEFORE that check existed is not touched. This lists
# what is there so a human can decide what to do with it. It prints field
# keys and counts, never the values themselves, and changes nothing.
#
# Standalone: not called by, and not part of, install / upgrade / backup /
# restore / uninstall. Run it whenever you like, as root, on the server.
#
# It is a safety net, not a guarantee. About 1 in 10 random 12-digit numbers
# look valid; a number with a typo or written with other separators is not
# found; and it covers custom-field values only, not names, addresses, notes
# or other free text.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

OPT_DIR="/opt/openestate"
CURRENT_LINK="${OPT_DIR}/current"
ENV_FILE="/etc/openestate/openestate.env"
EXTRA_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --show-ids) EXTRA_ARGS+=("--show-ids"); shift ;;
    -h|--help)
      cat <<'USAGE'
Usage: sudo ./find-aadhaar-like-values.sh [options]

Read-only. Reports field keys and row counts, never values.

  --env-file PATH   Default: /etc/openestate/openestate.env
  --show-ids        Also print up to 20 row ids per field (still no values)
USAGE
      exit 0
      ;;
    *) die "Unknown argument: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Must be run as root (sudo ./find-aadhaar-like-values.sh)."
[ -L "$CURRENT_LINK" ] || die "${CURRENT_LINK} is not a symlink — is OpenEstate installed via install-native.sh?"
[ -f "$ENV_FILE" ] || die "Env file not found: ${ENV_FILE}"

RELEASE_DIR="$(readlink -f "$CURRENT_LINK")"
SCRIPT="${RELEASE_DIR}/api/scripts/find-aadhaar-like-values.ts"
[ -f "$SCRIPT" ] || die "${SCRIPT} not found — this release predates the scanner."

DATABASE_URL_SYSTEM="$(grep -m1 '^DATABASE_URL_SYSTEM=' "$ENV_FILE" | cut -d= -f2-)"
[ -n "$DATABASE_URL_SYSTEM" ] || die "Could not read DATABASE_URL_SYSTEM from ${ENV_FILE}."

cd "${RELEASE_DIR}/api"
DATABASE_URL_SYSTEM="$DATABASE_URL_SYSTEM" ./node_modules/.bin/tsx scripts/find-aadhaar-like-values.ts ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
