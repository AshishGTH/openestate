#!/usr/bin/env bash
# v0.8.4 Part O: checks for the "upgrade from the previous release" CI job.
# Runs on the CI runner against the native install's database (local
# PostgreSQL, as the postgres OS user). Each command exits non-zero with a
# GitHub ::error:: line when its check fails.
#
#   upgrade-checks.sh money FILE          write the money snapshot to FILE
#   upgrade-checks.sh same-money A B      the two snapshots are identical
#   upgrade-checks.sh migrations SRC      recorded migrations == SRC's folders
#   upgrade-checks.sh loopback            the API answers on 127.0.0.1:3000 only
set -euo pipefail

q() { (cd / && sudo -u postgres psql -d openestate -AtX -v ON_ERROR_STOP=1 -c "$1"); }

case "${1:-}" in
  money)
    # Per-booking ledger balance and receipts total, plus row counts: a
    # changed amount, a lost row or an extra row all change this text.
    q "SELECT 'booking ' || booking_id || ' ' || sum(signed_amount_paise) || ' ' || count(*) FROM ledger_entries GROUP BY booking_id ORDER BY booking_id" > "$2"
    q "SELECT 'receipts ' || count(*) || ' ' || COALESCE(sum(gross_amount_paise), 0) || ' reversed ' || count(*) FILTER (WHERE is_reversed) FROM receipts" >> "$2"
    q "SELECT 'allocations ' || count(*) || ' ' || COALESCE(sum(amount_paise), 0) FROM receipt_allocations" >> "$2"
    [ -s "$2" ] && grep -q '^booking ' "$2" || { echo "::error::money snapshot has no bookings; the seed did not run"; exit 1; }
    ;;
  same-money)
    if ! diff -u "$2" "$3"; then echo "::error::money totals changed across the upgrade (diff above)"; exit 1; fi
    echo "Money totals identical ($(grep -c '^booking ' "$2") bookings)."
    ;;
  migrations)
    q "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1" > /tmp/applied.txt
    (cd "$2/packages/db/prisma/migrations" && ls -d */ | tr -d / | sort) > /tmp/expected.txt
    if ! diff -u /tmp/expected.txt /tmp/applied.txt; then echo "::error::recorded migrations differ from the checkout's migration folders (diff above)"; exit 1; fi
    echo "Recorded migrations equal the checkout's $(wc -l < /tmp/expected.txt) folders."
    ;;
  loopback)
    sudo ss -ltnH 'sport = :3000' | awk '{print $4}' > /tmp/ss-3000.txt
    cat /tmp/ss-3000.txt
    grep -qx '127.0.0.1:3000' /tmp/ss-3000.txt || { echo "::error::API is not listening on 127.0.0.1:3000"; exit 1; }
    if grep -vqx '127.0.0.1:3000' /tmp/ss-3000.txt; then echo "::error::API also listens on another address"; exit 1; fi
    IP="$(hostname -I | awk '{print $1}')"
    if curl -sS --max-time 5 "http://${IP}:3000/api/v1/health" >/dev/null 2>&1; then
      echo "::error::http://${IP}:3000 answered; the API is reachable from the network"; exit 1
    fi
    curl -fsS http://127.0.0.1:3000/api/v1/health >/dev/null
    echo "Loopback only: ${IP}:3000 refused, 127.0.0.1:3000 healthy."
    ;;
  *)
    echo "usage: $0 money FILE | same-money A B | migrations SRC | loopback" >&2
    exit 2
    ;;
esac
