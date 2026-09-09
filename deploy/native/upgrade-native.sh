#!/usr/bin/env bash
# Upgrades an existing native install: backup -> build a new versioned
# release -> migrate -> cut over -> healthcheck gate. On a failed
# healthcheck, rolls the `current` symlink back to the previous release and
# restarts — it never attempts to un-apply a migration (migrations are
# forward-only; see CLAUDE.md), so the pre-upgrade backup is the tool for a
# human-decided database rollback if the migration itself is the problem.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

# Belt-and-braces for a MIXED-ownership checkout: this script no longer
# runs git as root (see src_owner() in lib.sh — git now runs as whoever
# owns the checkout), so the common "dubious ownership" case is gone at
# the source. What remains is a checkout whose .git and working tree have
# different owners, which an earlier root-mode upgrade could have left
# behind; git still refuses that for the owning user, and this keeps it
# working. It also stays for the benefit of the admin's own `git` commands
# in a README-style `sudo git clone` checkout.
git config --system --add safe.directory "$SRC_DIR" 2>/dev/null || true

APP_USER="openestate"
APP_GROUP="openestate"
OPT_DIR="/opt/openestate"
RELEASES_DIR="${OPT_DIR}/releases"
CURRENT_LINK="${OPT_DIR}/current"
ENV_FILE="/etc/openestate/openestate.env"
REF=""
NO_BACKUP=0
DB_HOST=""

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --no-backup) NO_BACKUP=1; shift ;;
    --db-host) DB_HOST="$2"; shift 2 ;;
    -h|--help)
      cat <<'USAGE'
Usage: sudo ./upgrade-native.sh [--ref TAG_OR_BRANCH] [--no-backup] [--db-host HOST]
  --ref REF        git ref to build. Resolved against the REMOTE after a
                    fetch: a tag as itself, a branch as origin/BRANCH (so
                    a branch ref actually advances instead of building a
                    stale local branch), or a raw commit sha. The checkout
                    is left detached at that commit.
                    Without --ref, the checkout must already be up to date
                    with its upstream — this script refuses to build a
                    checkout that is behind, rather than "upgrading" to
                    the commit you are already running.
  --no-backup      Skip the automatic pre-upgrade backup (for scripted
                    upgrades that already snapshot elsewhere).
  --db-host HOST   Same meaning as install-native.sh — only needed for a
                    remote database (requires PG_SUPERUSER_PASSWORD).
USAGE
      exit 0
      ;;
    *) die "Unknown argument: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Must be run as root (sudo ./upgrade-native.sh)."
[ -L "$CURRENT_LINK" ] || die "${CURRENT_LINK} is not a symlink — is OpenEstate installed via install-native.sh?"
PREVIOUS_RELEASE="$(readlink -f "$CURRENT_LINK")"

# Everything that touches the source checkout — git here, pnpm and the
# build inside build_release() — runs as the checkout's OWNER, not as
# root. See src_owner() in lib.sh for why it is derived this way.
SRC_OWNER="$(src_owner "$SRC_DIR")"
log "Source checkout ${SRC_DIR} is owned by '${SRC_OWNER}' — git and build steps run as that user."

# ---------------------------------------------------------------------
# Decide WHAT to build, and refuse rather than guess. All of this runs
# before the backup and before any build, so a refusal costs nothing and
# leaves the running install completely untouched.
# ---------------------------------------------------------------------

# A release is only meaningful if we can name the commit it came from, so
# a dirty tree stops the upgrade. This is also the cheapest probe for a
# checkout that an earlier root-mode upgrade already damaged.
#
# Verified, not assumed: this does NOT misfire on the root-owned build
# artifacts a pre-fix upgrade left behind. node_modules/, dist/, .turbo/
# and *.tsbuildinfo are all in the repo's own .gitignore, so `git status
# --porcelain` never lists them, and nothing in build_release() writes a
# TRACKED file. Only real, tracked, uncommitted edits land here.
if ! DIRTY="$(git_as_owner "$SRC_DIR" status --porcelain 2>&1)"; then
  die "Cannot read git state in ${SRC_DIR} as '${SRC_OWNER}':
${DIRTY}

This usually means an earlier upgrade ran git as root and left root-owned
files in .git. Repair the ownership, then re-run this script:
  sudo chown -R ${SRC_OWNER}: ${SRC_DIR}"
fi
[ -z "$DIRTY" ] || die "Source checkout has uncommitted changes — refusing to build, because the resulting release would not correspond to any commit. Commit, stash or discard them first:
${DIRTY}"

log "Fetching from origin..."
git_as_owner "$SRC_DIR" fetch --tags --prune origin \
  || die "git fetch failed in ${SRC_DIR} (as '${SRC_OWNER}'). Fix that first — this script will not build a checkout it could not verify."

if [ -n "$REF" ]; then
  # Resolution order matters, and a BRANCH must resolve through
  # origin/<branch>: `git checkout <branch>` moves to the LOCAL branch,
  # which `git fetch` does not fast-forward, so `--ref main` on a checkout
  # whose local main was behind used to build stale code and report
  # success. Tags are immutable and were already correct, so they are
  # tried first and behave exactly as before.
  if TARGET_SHA="$(git_as_owner "$SRC_DIR" rev-parse --verify -q "refs/tags/${REF}^{commit}")"; then
    log "Resolved --ref ${REF} to tag ${REF} (${TARGET_SHA})."
  elif TARGET_SHA="$(git_as_owner "$SRC_DIR" rev-parse --verify -q "refs/remotes/origin/${REF}^{commit}")"; then
    log "Resolved --ref ${REF} to origin/${REF} (${TARGET_SHA}) — the REMOTE branch tip, not the local branch."
  elif TARGET_SHA="$(git_as_owner "$SRC_DIR" rev-parse --verify -q "${REF}^{commit}")"; then
    log "Resolved --ref ${REF} to commit ${TARGET_SHA}."
  else
    die "Could not resolve --ref ${REF} to a tag, an origin/ branch, or a commit in ${SRC_DIR}. Check the spelling, or that the ref exists on the remote."
  fi

  CURRENT_SHA="$(git_as_owner "$SRC_DIR" rev-parse HEAD)"
  if [ "$CURRENT_SHA" = "$TARGET_SHA" ]; then
    log "Checkout is already at ${TARGET_SHA}."
  else
    # Detached deliberately: a deploy checkout parked ON a local branch is
    # exactly what silently drifts behind its upstream, which is the
    # failure this whole block exists to prevent. Detaching at the
    # resolved commit makes the checkout state say precisely what is
    # deployed. The documented `--ref vX.Y.Z` tag flow already detached
    # before this change, so this is not new behaviour there.
    log "Checking out ${TARGET_SHA} (detached, from ${CURRENT_SHA})..."
    git_as_owner "$SRC_DIR" checkout --detach --quiet "$TARGET_SHA" \
      || die "git checkout ${TARGET_SHA} failed in ${SRC_DIR}. Nothing has been changed on the running install."
  fi
else
  # No --ref. This is the case that caused the incident: the script used
  # to build whatever HEAD happened to be, with no fetch and no check, so
  # an operator who forgot to update the checkout "upgraded" to the commit
  # already running and was told it succeeded. A hard failure, not a
  # warning — a warning in a long build log is exactly what got missed.
  TARGET_SHA="$(git_as_owner "$SRC_DIR" rev-parse HEAD)"
  if ! UPSTREAM="$(git_as_owner "$SRC_DIR" rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>/dev/null)"; then
    die "No --ref given, and HEAD is detached or its branch has no upstream — so there is nothing to check 'up to date' against, and this script will not silently rebuild whatever happens to be checked out.

Name the version you intend to deploy:
  sudo ./upgrade-native.sh --ref vX.Y.Z"
  fi
  BEHIND="$(git_as_owner "$SRC_DIR" rev-list --count "HEAD..@{u}")"
  if [ "$BEHIND" -gt 0 ]; then
    die "Refusing to upgrade: the source checkout is ${BEHIND} commit(s) behind ${UPSTREAM}.

Building now would 'upgrade' to the code you are ALREADY running and report success — the exact failure this check exists to stop.

Either name the version explicitly:
  sudo ./upgrade-native.sh --ref vX.Y.Z
or fast-forward the checkout yourself first, as ${SRC_OWNER} and NOT as root:
  git -C ${SRC_DIR} merge --ff-only ${UPSTREAM}"
  fi
  log "No --ref given; HEAD (${TARGET_SHA}) is up to date with ${UPSTREAM}."
fi

if [ "$NO_BACKUP" -eq 1 ]; then
  warn "Skipping pre-upgrade backup (--no-backup)."
else
  log "Taking a pre-upgrade backup..."
  "${SCRIPT_DIR}/backup-native.sh" --env-file "$ENV_FILE"
fi

log "Building new release..."
RELEASE_DIR="$(build_release "$SRC_DIR" "$RELEASES_DIR")" || die "Build failed — see output above. Previous release (${PREVIOUS_RELEASE}) is untouched and still running."

# Outcome assertion, deliberately BEFORE any migration or cutover: the
# release just built must be the commit that was resolved above.
# build_release() names the release <timestamp>-<short sha of HEAD at
# build time>, so this compares what was ACTUALLY built against what was
# asked for. A mismatch means the checkout moved underneath the build, or
# the resolution above was wrong — either way, stop here, while the
# database is still untouched and the previous release is still serving.
TARGET_SHORT="$(git_as_owner "$SRC_DIR" rev-parse --short "$TARGET_SHA")"
BUILT_SHORT="${RELEASE_DIR##*-}"
[ "$BUILT_SHORT" = "$TARGET_SHORT" ] || die "Built release ${RELEASE_DIR} is at commit ${BUILT_SHORT}, but the requested target is ${TARGET_SHORT}. No migration has run and no cutover has happened; the previous release (${PREVIOUS_RELEASE}) is untouched and still running."
log "Verified: built release is at ${BUILT_SHORT}, matching the requested target."

chown -R "${APP_USER}:${APP_GROUP}" "$RELEASE_DIR"
chmod -R o+rX "$RELEASE_DIR"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Migrations here run BEFORE cutover, deliberately — the previous release
# keeps serving against the new, backward-compatible schema until the
# symlink swaps. That means every DDL statement contends with a LIVE app.
#
# `ALTER TABLE ... ADD COLUMN` needs ACCESS EXCLUSIVE, which conflicts with
# the ACCESS SHARE that an ordinary SELECT holds — so a single in-flight
# read on the table is enough to block it, and with no timeout it waits
# FOREVER. Worse, a blocked DDL statement queues ahead of later lock
# requests, so every subsequent query on that table piles up behind it and
# the app freezes rather than the migration merely being slow. Verified
# empirically against a real Postgres, not assumed: an open read
# transaction on `refresh_tokens` blocks `ADD COLUMN` indefinitely, and
# `refresh_tokens` is read on essentially every authenticated request.
#
# lock_timeout turns that unbounded hang into a fast, legible failure —
# upgrade-native.sh then aborts with the previous release still running and
# untouched, which is exactly the intended failure mode. Set via the
# connection string's `options` parameter, NOT PGOPTIONS: Prisma uses its
# own Rust driver rather than libpq and does not read libpq env vars
# (confirmed by testing both).
: "${MIGRATION_LOCK_TIMEOUT:=15s}"
PG_STARTUP_OPTIONS="-c%20lock_timeout%3D${MIGRATION_LOCK_TIMEOUT}"

run_as_superuser() {
  # See install-native.sh: run from RELEASE_DIR (already o+rX), not this
  # script's own cwd — Prisma 6.19+'s cwd-relative prisma.config.*
  # auto-discovery lstat()s and gets EACCES, not ENOENT, when an ancestor
  # of the checkout isn't traversable by the `postgres` OS user, which
  # aborts the migrate step entirely.
  (
    cd "$RELEASE_DIR" || exit 1
    if [ -n "$DB_HOST" ]; then
      PGPASSWORD="${PG_SUPERUSER_PASSWORD:?Set PG_SUPERUSER_PASSWORD when using --db-host}" \
        env DATABASE_URL="postgresql://${PG_SUPERUSER:-postgres}:${PG_SUPERUSER_PASSWORD}@${DB_HOST}:5432/openestate?options=${PG_STARTUP_OPTIONS}" "$@"
    else
      sudo -u postgres env DATABASE_URL="postgresql://postgres@localhost/openestate?host=/var/run/postgresql&options=${PG_STARTUP_OPTIONS}" "$@"
    fi
  )
}

log "Running database migrations (before cutover — old release keeps running against the new, backward-compatible schema until it's swapped)..."
# See install-native.sh: pnpm's .bin shims are shell scripts, not JS —
# invoked directly, never wrapped in `node`.
#
# Output is captured (via `tee`, not just redirected — the admin still
# sees it live) so a lock-timeout failure can be told apart from any
# other migration failure and given its OWN actionable guidance instead
# of the generic message: this specific failure is EXPECTED occasionally
# on a busy install (see this file's own CLAUDE.md "any migration
# touching a hot table" entry for the mechanism) and has a real remedy —
# retry, or raise the timeout — where a generic migration error usually
# does not. `set -o pipefail` (top of this script) is load-bearing here:
# without it, `cmd | tee file`'s checked exit status would be `tee`'s
# (always 0), the exact bug this project's own CI once shipped silently.
MIGRATE_LOG="$(mktemp)"
if ! run_as_superuser "${RELEASE_DIR}/api/node_modules/.bin/prisma" migrate deploy \
  --schema "${RELEASE_DIR}/api/packages/db/prisma/schema.prisma" 2>&1 | tee "$MIGRATE_LOG"; then
  if grep -qi "lock timeout" "$MIGRATE_LOG"; then
    rm -f "$MIGRATE_LOG"
    die "Migration timed out waiting for a table lock (current limit: ${MIGRATION_LOCK_TIMEOUT}). This means another process — almost always the PREVIOUS release, still serving live traffic — held a conflicting lock on a table this migration needs to change for longer than the timeout. Previous release (${PREVIOUS_RELEASE}) is untouched and still running; nothing is broken. What to do: retry this upgrade during a quieter traffic period, or raise the limit for one run: MIGRATION_LOCK_TIMEOUT=60s sudo ./upgrade-native.sh"
  fi
  rm -f "$MIGRATE_LOG"
  die "Migration failed. Previous release (${PREVIOUS_RELEASE}) is untouched and still running. Inspect the backup taken above before retrying."
fi
rm -f "$MIGRATE_LOG"

# Schema migrations don't cover PERMISSIONS constants — those are
# application-level rows, not a Prisma model change. seed.ts's own
# permission-upsert loop never reaches an existing install (it returns
# early the moment any company exists, which is every install after its
# first boot) — so without this, a release that adds a permission and a
# UI gated on it would upgrade clean and heal nothing: no role could
# ever be granted a permission row that was never inserted. This step
# also syncs any brand-new master TYPE gated by its own one-time
# CompanyConfig marker (currently: LeadStage, via
# CompanyConfig.leadStagesSeededAt) — deliberately NOT extended to
# rows within an EXISTING master's list, nor to roles: both are
# per-company data an admin may have already customised (see
# sync-permissions.ts's own comments for the full reasoning on each).
log "Syncing permission rows and any newly-added seeded master types..."
# Same tee-to-a-log discipline as the migration step above, and for the
# same reason: capture the output so a specific, known outcome can be
# told apart from a generic failure and handled differently, without
# losing live visibility in the terminal. `set -o pipefail` (top of this
# script) is what makes `$?` right after the pipe reflect sync-
# permissions.ts's own exit code rather than tee's.
#
# sync-permissions.ts's CLI entrypoint uses THREE exit codes (see its
# own comment at the require.main===module block): 0 clean, 1 hard
# failure, 2 completed-but-skipped-something. Only 1 is treated as fatal
# here — a skip (2) is a narrow, near-impossible-in-production,
# single-company edge case (see sync-permissions.ts's
# isForeignKeyViolation doc comment), and this step is NOT the last one
# in this script: cutover and the healthcheck both still run after it.
# Dying here on a skip would abort the ENTIRE upgrade, for every
# company, before cutover, over one company's edge case — worse than the
# skip itself. Instead: let the rest of the sequence proceed, and report
# it in an unmissable block at the very end of a successful run (below),
# with a non-zero final exit so scripted/monitored upgrades still see a
# signal — without leaving a half-applied upgrade stuck mid-sequence.
SYNC_LOG="$(mktemp)"
SYNC_STATUS=0
# `SYNC_STATUS=$?` on the right of `||`, NOT `if ! pipeline; then
# SYNC_STATUS=$?; fi` — verified directly (not assumed) that the `!`
# form does NOT work for this: `!` negates the pipeline's status before
# the `if` sees it, and `$?` inside that `then` block reflects the
# ALREADY-NEGATED value (always 0 for any failure), not the real exit
# code — which would have silently collapsed every SYNC_STATUS to 0,
# defeating the whole point of distinguishing exit codes 1 vs 2 here.
# The `||` form's right-hand side only runs on real failure and captures
# the real, un-negated `$?` — confirmed under `set -e`+`pipefail` before
# relying on it.
run_as_superuser "${RELEASE_DIR}/api/node_modules/.bin/tsx" "${RELEASE_DIR}/api/packages/db/prisma/sync-permissions.ts" \
  2>&1 | tee "$SYNC_LOG" || SYNC_STATUS=$?
rm -f "$SYNC_LOG"

SYNC_HAD_SKIPS=0
if [ "$SYNC_STATUS" -eq 2 ]; then
  warn "Permission sync completed but skipped one or more entities that vanished mid-sync — see the SYNC COMPLETED WITH ... block above. Continuing to cutover (this is a narrow, near-impossible-in-production edge case, not a reason to hold back the release) — this will be reported again, prominently, at the end of this run."
  SYNC_HAD_SKIPS=1
elif [ "$SYNC_STATUS" -ne 0 ]; then
  die "Permission sync failed. Previous release (${PREVIOUS_RELEASE}) is untouched and still running. Inspect the backup taken above before retrying."
fi

log "Cutting over to the new release..."
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
chown -h "${APP_USER}:${APP_GROUP}" "$CURRENT_LINK"

# Outcome assertion, before the restart rather than after: if the symlink
# did not actually move, restarting would simply bring the OLD release
# back up, the healthcheck below would pass against it, and this script
# would print "Upgrade complete" over a cutover that never happened.
LINKED="$(readlink -f "$CURRENT_LINK")"
[ "$LINKED" = "$(readlink -f "$RELEASE_DIR")" ] || die "Cutover did not take: ${CURRENT_LINK} points at ${LINKED}, expected ${RELEASE_DIR}. The service has NOT been restarted and is still running the previous release."

systemctl restart openestate-api

log "Waiting for the API to become healthy..."
if wait_for_health "http://127.0.0.1:3000/api/v1/health" 60; then
  log "Upgrade complete: ${RELEASE_DIR}"
else
  warn "Healthcheck failed after cutover — rolling code back to ${PREVIOUS_RELEASE}."
  ln -sfn "$PREVIOUS_RELEASE" "$CURRENT_LINK"
  chown -h "${APP_USER}:${APP_GROUP}" "$CURRENT_LINK"
  systemctl restart openestate-api
  die "Rolled back to ${PREVIOUS_RELEASE}. The database schema migration was NOT rolled back (migrations are forward-only) — if you suspect the migration itself broke something, inspect the pre-upgrade backup and involve a human before doing anything destructive. Check: journalctl -u openestate-api -n 200"
fi

if [ "$SYNC_HAD_SKIPS" -eq 1 ]; then
  warn ""
  warn "================================================================"
  warn "UPGRADE SUCCEEDED, but the permission/lead-stage sync earlier in"
  warn "this run skipped one or more companies — see the warnings above."
  warn "This should be near-impossible in production (it means a company"
  warn "vanished mid-sync). Investigate, then simply re-run this script —"
  warn "every step here, including the sync, is safe to run again."
  warn "================================================================"
  warn ""
  exit 1
fi
