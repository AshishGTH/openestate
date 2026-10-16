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
    # The network probe runs first: it is the outcome that matters, and it
    # must be what fails when the API listens on every address.
    FOUND="$(sudo ss -ltnH 'sport = :3000' | awk '{print $4}' | sort -u | paste -sd' ' -)"
    FOUND="${FOUND:-nothing}"
    echo "Listening on port 3000: ${FOUND}"
    IP="$(hostname -I | awk '{print $1}')"
    if curl -sS --max-time 5 "http://${IP}:3000/api/v1/health" >/dev/null 2>&1; then
      echo "::error::http://${IP}:3000 answered; the API is reachable from the network (it listens on ${FOUND}, expected 127.0.0.1:3000 only)"; exit 1
    fi
    [ "$FOUND" = "127.0.0.1:3000" ] || { echo "::error::API listens on ${FOUND}, expected 127.0.0.1:3000 only"; exit 1; }
    curl -fsS http://127.0.0.1:3000/api/v1/health >/dev/null
    echo "Loopback only: ${IP}:3000 refused, 127.0.0.1:3000 healthy."
    ;;
  roles)
    # Staff system roles (not super_admin, which has its own rule, nor the
    # portal roles, which the upgrade strips by design): held keys and seed
    # baseline, one line each.
    # The baseline table is new in v0.8.4; before that every role has none.
    if [ "$(q "SELECT to_regclass('public.role_seed_baselines') IS NOT NULL")" = "t" ]; then
      BASE="COALESCE((SELECT array_to_string(ARRAY(SELECT unnest(b.permission_keys) ORDER BY 1), ',') FROM role_seed_baselines b WHERE b.role_id = r.id), 'NONE')"
    else
      BASE="'NONE'"
    fi
    q "SELECT r.id || '|' || r.slug || '|' ||
              COALESCE((SELECT string_agg(p.key, ',' ORDER BY p.key) FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = r.id), '') || '|' ||
              ${BASE}
         FROM roles r
        WHERE r.is_system AND r.slug IN ('company_admin','sales_manager','sales_executive','accounts')
        ORDER BY r.id" > "$2"
    [ -s "$2" ] || { echo "::error::role snapshot is empty"; exit 1; }
    ;;
  role-sync)
    # v0.8.4 Part I as an outcome: a role with no baseline before gains
    # nothing; a role with one gains exactly the keys new to its seed since
    # that baseline, and nothing an admin removed comes back.
    node -e '
      const fs = require("fs");
      const read = (f) => new Map(fs.readFileSync(f, "utf8").trim().split("\n").map((l) => {
        const [id, slug, held, base] = l.split("|");
        const set = (s) => (s ? s.split(",") : []);
        return [id, { slug, held: set(held), base: base === "NONE" ? null : set(base) }];
      }));
      const before = read(process.argv[1]), after = read(process.argv[2]);
      let bad = 0;
      for (const [id, b] of before) {
        const a = after.get(id);
        const newKeys = b.base && a.base ? a.base.filter((k) => !b.base.includes(k)) : [];
        const want = [...new Set([...b.held, ...newKeys])].sort().join(",");
        const got = [...a.held].sort().join(",");
        if (want !== got) { bad++; console.log(`::error::${b.slug} (${id}): expected ${want || "(none)"} after the upgrade, got ${got || "(none)"}`); }
        else console.log(`${b.slug}: ${newKeys.length ? "gained " + newKeys.join(", ") : "unchanged"}`);
      }
      process.exit(bad ? 1 : 0);
    ' "$2" "$3"
    ;;
  interest-report)
    # v0.9 ruling (e): no rule is attached on upgrade, and the upgrade output
    # says how many active bookings have none.
    WITH_RULE="$(q "SELECT count(*) FROM bookings WHERE interest_rule_id IS NOT NULL")"
    [ "$WITH_RULE" = "0" ] || { echo "::error::${WITH_RULE} booking(s) have an interest rule after the upgrade; nothing may be attached automatically"; exit 1; }
    NO_RULE="$(q "SELECT count(*) FROM bookings WHERE interest_rule_id IS NULL AND status IN ('BOOKED','ALLOTTED','REGISTERED')")"
    if [ "$NO_RULE" = "0" ]; then
      grep -qF "Delay interest: no active booking is without an interest rule." "$2" \
        || { echo "::error::the upgrade output does not report the interest-rule count (0)"; exit 1; }
    else
      grep -qF "Delay interest: ${NO_RULE} active booking(s) have no interest rule." "$2" \
        || { echo "::error::the upgrade output does not report ${NO_RULE} active booking(s) with no interest rule"; exit 1; }
    fi
    echo "Interest report: ${NO_RULE} active booking(s) with no rule, reported; none attached."
    ;;
  *)
    echo "usage: $0 money FILE | same-money A B | migrations SRC | loopback | roles FILE | role-sync A B | interest-report LOG" >&2
    exit 2
    ;;
esac
