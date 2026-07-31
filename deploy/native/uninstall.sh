#!/usr/bin/env bash
# Removes the systemd unit, nginx site, and (only with --purge) the
# application's own files: /opt/openestate, /etc/openestate,
# /var/log/openestate, /var/lib/openestate. Never touches the database or
# Redis — those are the admin's, not this project's, to remove. Take a
# backup first (backup-native.sh) if you might want this data back.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

PURGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    -h|--help)
      cat <<'USAGE'
Usage: sudo ./uninstall.sh [--purge]
  --purge   Also delete /opt/openestate, /etc/openestate (including
            openestate.env's live secrets), /var/log/openestate, and
            /var/lib/openestate (including uploaded files). Without
            --purge, only the systemd unit and nginx site are removed —
            all data is left in place.
Does not touch PostgreSQL, Redis, or any data inside them — this project
never manages those, so it never removes them either.
USAGE
      exit 0
      ;;
    *) die "Unknown argument: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Must be run as root (sudo ./uninstall.sh)."

log "Stopping and disabling the service..."
systemctl stop openestate-api 2>/dev/null || true
systemctl disable openestate-api 2>/dev/null || true
rm -f /etc/systemd/system/openestate-api.service
systemctl daemon-reload

log "Removing nginx site..."
rm -f /etc/nginx/sites-enabled/openestate /etc/nginx/sites-available/openestate
if command -v nginx >/dev/null 2>&1 && nginx -t 2>/dev/null; then
  systemctl reload nginx 2>/dev/null || true
fi

if [ "$PURGE" -eq 1 ]; then
  warn "Purging application data: /opt/openestate /etc/openestate /var/log/openestate /var/lib/openestate"
  read -r -p "Type 'purge' to confirm permanent deletion of the above (uploads and openestate.env included): " CONFIRM
  if [ "$CONFIRM" = "purge" ]; then
    rm -rf /opt/openestate /etc/openestate /var/log/openestate /var/lib/openestate
    log "Purged."
  else
    warn "Confirmation did not match — data left in place."
  fi
  if id openestate >/dev/null 2>&1; then
    userdel openestate 2>/dev/null || warn "Could not remove the 'openestate' system user (may still own files)."
  fi
else
  log "Service and nginx site removed. Application files left in place under /opt/openestate, /etc/openestate, /var/log/openestate, /var/lib/openestate — pass --purge to remove them too."
fi

log "PostgreSQL and Redis were never touched — remove the openestate database/roles yourself if you no longer need them."
