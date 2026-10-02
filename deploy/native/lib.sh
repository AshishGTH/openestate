#!/usr/bin/env bash
# Shared helpers for the deploy/native/*.sh scripts. Sourced, not executed.

log()  { printf '\033[1;32m[openestate]\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[openestate]\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31m[openestate]\033[0m %s\n' "$1" >&2; exit 1; }

rand_secret() {
  # 48 bytes -> 64 base64 chars, url-safe, no padding noise.
  openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-48
}
rand_hex_32() {
  # 32 bytes -> 64 hex chars for AES-256-GCM encryption keys.
  openssl rand -hex 32
}

# wait_for_health URL [max_tries]
wait_for_health() {
  local url="$1" tries=0 max="${2:-60}"
  until node -e "fetch('$url').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge "$max" ]; then
      return 1
    fi
    sleep 2
  done
  return 0
}

# build_release SRC_DIR RELEASES_DIR -> prints the new release dir path on stdout
#
# Builds and stages a release natively: pnpm build in dependency order,
# then `pnpm --filter @openestate/api deploy --prod`, then manually copying
# each workspace package's dist/ back in. That last step is not redundant:
# pnpm deploy's file selection follows git-tracked files, which excludes
# gitignored dist/ output, so every workspace dependency's dist has to be
# copied in by hand or the deployed API boots with missing modules. Also
# builds the two static frontends and regenerates the Prisma client in
# place.
build_release() {
  local src_dir="$1" releases_dir="$2"
  local release_id
  release_id="$(date -u +%Y%m%d%H%M%S)-$(cd "$src_dir" && git rev-parse --short HEAD 2>/dev/null || echo nogit)"
  local release_dir="${releases_dir}/${release_id}"

  # The whole block's stdout is redirected to stderr: build_release()'s
  # return value is the release path, returned via `$(build_release ...)`
  # command substitution — if pnpm/tsc/vite's own progress output went to
  # real stdout here, it would get captured as part of that return value
  # instead of the path, corrupting every later use of $RELEASE_DIR. This
  # keeps the build fully visible in the terminal while keeping stdout
  # clean for the one `printf` below that's the actual return channel.
  (
    cd "$src_dir" || exit 1
    # openestate.env (sourced by the caller before this runs, so the
    # deployed app gets NODE_ENV=production at runtime) must not leak into
    # the build: pnpm treats NODE_ENV=production as "skip devDependencies,"
    # which silently drops typescript/@nestjs/cli/vite — every `tsc`/`nest`
    # build command below then fails with "not found" instead of a clear
    # dependency error. NODE_ENV=production belongs on the *running*
    # service, never on the build that produces it.
    unset NODE_ENV
    log "Installing workspace dependencies..."
    pnpm install --frozen-lockfile

    log "Building packages in dependency order..."
    pnpm --filter @openestate/db generate
    pnpm --filter @openestate/shared build
    pnpm --filter @openestate/db build
    pnpm --filter @openestate/plugin-sdk build
    pnpm --filter @openestate/generic-sales build
    pnpm --filter @openestate/api build

    log "Building frontends (VITE_API_URL empty — same-origin via nginx)..."
    export VITE_API_URL=""
    pnpm --filter @openestate/web build
    pnpm --filter @openestate/portal build

    mkdir -p "$release_dir"

    log "Deploying API as a standalone production tree..."
    pnpm --filter @openestate/api deploy --prod "${release_dir}/api"

    # Workspace packages' built dist/ (gitignored, so pnpm deploy's
    # git-tracked-files selection skips them) copied back in at the same
    # relative path the deployed api's node_modules resolution expects.
    for pkg in packages/db packages/shared packages/plugin-sdk plugins/generic-sales; do
      mkdir -p "${release_dir}/api/${pkg}"
      cp -r "${pkg}/dist" "${release_dir}/api/${pkg}/dist"
      cp "${pkg}/package.json" "${release_dir}/api/${pkg}/package.json"
    done
    cp -r packages/db/prisma "${release_dir}/api/packages/db/prisma"

    # Prisma's generated query-engine client (node_modules/.prisma/, built
    # from schema.prisma) isn't carried over by `pnpm deploy` either — its
    # postinstall tries to auto-generate it but the schema isn't in place
    # in the deploy target yet at that point, so it silently no-ops
    # ("could not find your Prisma schema in the default locations").
    # Rather than copying the already-generated one out of $src_dir's own
    # pnpm store (fragile: it depends on the release's and the source's
    # pnpm virtual-store folder names matching exactly, which isn't
    # guaranteed — this broke in practice), just generate it fresh
    # in-place now that the schema is actually there. Source and release
    # share the same filesystem/pnpm content-addressable store, so this
    # is cheap (no new downloads) and unambiguous — no cross-directory
    # glob-matching required.
    "${release_dir}/api/node_modules/.bin/prisma" generate \
      --schema "${release_dir}/api/packages/db/prisma/schema.prisma"

    cp -r apps/web/dist "${release_dir}/web"
    cp -r apps/portal/dist "${release_dir}/portal"
  ) >&2
  local build_status=$?
  # Explicit check, not reliance on `set -e` propagating through this
  # subshell: build_release() is called as `x=$(build_release ...) || die`,
  # and bash disables errexit for commands whose exit status is itself
  # being tested (POSIX "commands run for their status aren't subject to
  # -e") — that suppression was observed to leak into this subshell too,
  # letting a failed build silently fall through to the `printf` below and
  # report success. Checking $? explicitly here doesn't depend on that.
  if [ "$build_status" -ne 0 ]; then
    return "$build_status"
  fi

  printf '%s' "$release_dir"
}

# Prints a plain-English block for any existing staff-surface-shaped problem
# the v0.8.2 trigger does not (and cannot) fix retroactively: users whose role
# is a portal role but who carry no applicant_id/broker_id link. Read-only,
# never fatal. A plain SELECT run by this script rather than a RAISE NOTICE
# in the migration, because nothing guarantees `prisma migrate deploy`
# forwards notices to the admin's terminal.
#
# Uses the same connection choices as upgrade-native.sh's run_as_superuser:
# DB_HOST (+ PG_SUPERUSER / PG_SUPERUSER_PASSWORD) for a remote database,
# otherwise the local `postgres` OS user over the Unix socket.
print_post_migrate_findings() {
  local sql="SELECT u.id, u.name, coalesce(u.email, u.phone, '-'), r.slug, u.is_active
              FROM users u JOIN roles r ON r.id = u.role_id
             WHERE r.is_portal AND u.applicant_id IS NULL AND u.broker_id IS NULL
             ORDER BY u.created_at"
  local rows
  if [ -n "${DB_HOST:-}" ]; then
    rows="$(PGPASSWORD="${PG_SUPERUSER_PASSWORD:-}" psql -h "$DB_HOST" -U "${PG_SUPERUSER:-postgres}" -d openestate -tAF ' | ' -c "$sql" 2>/dev/null)" || rows="__QUERY_FAILED__"
  else
    rows="$(sudo -u postgres psql -d openestate -tAF ' | ' -c "$sql" 2>/dev/null)" || rows="__QUERY_FAILED__"
  fi
  if [ "$rows" = "__QUERY_FAILED__" ]; then
    warn "Could not run the post-migration check for unlinked portal-role accounts (non-fatal). Run it by hand: SELECT u.id, u.email, r.slug FROM users u JOIN roles r ON r.id=u.role_id WHERE r.is_portal AND u.applicant_id IS NULL AND u.broker_id IS NULL;"
    return 0
  fi
  if [ -z "$rows" ]; then
    log "Post-migration check: no unlinked portal-role accounts found."
    return 0
  fi
  warn "================================================================"
  warn "FINDING: these accounts have a customer/broker (portal) role but no"
  warn "applicant or broker link. Before v0.8.2 such an account could sign in"
  warn "to the STAFF app; v0.8.2 refuses that, and the database now rejects"
  warn "creating or editing one. These existing rows were left untouched."
  warn "Review each in Admin -> Users, then deactivate it or give it a staff role."
  warn "  id | name | email-or-phone | role | active"
  printf '%s\n' "$rows" | while IFS= read -r line; do warn "  ${line}"; done
  warn "================================================================"
}
