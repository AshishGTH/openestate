#!/usr/bin/env bash
# Shared helpers for the deploy/native/*.sh scripts. Sourced, not executed.

# This file's own absolute path, captured at source time. build_release()
# re-enters this file (`runuser ... bash -c '. "$1"'`) to run the build
# phase as an unprivileged user, so it has to be able to name itself.
LIB_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

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

# src_owner SRC_DIR -> prints the OS user that owns the source checkout.
#
# The single source of truth for "who must the build run as". It is
# DERIVED, never configured: the account we must not lock out of the
# checkout is, by definition, the one that owns it. $SUDO_USER would be
# wrong here — it is unset under a root cron/systemd timer and after a
# plain `su -`, and it names whoever invoked sudo rather than whoever owns
# the files. If the checkout is itself root-owned (the README's own
# `sudo git clone`), this returns "root", every drop-privileges call below
# becomes a no-op, and behaviour is exactly what it was before — while
# being correct for every non-root clone.
src_owner() { stat -c %U "$1"; }

# run_as_src_owner SRC_DIR CMD [ARGS...]
#
# Runs CMD as the checkout's owner, or directly when we already are them —
# so these scripts still work when invoked by a non-root user, and so a
# root-owned checkout costs nothing.
#
# `runuser`, not `sudo -u`: sudo applies /etc/sudoers' `secure_path`, which
# REPLACES PATH for the target command. corepack's `pnpm` shim and a
# NodeSource `node` both live in /usr/bin and would survive that, but an
# admin whose Node came from nvm/fnm/asdf has them outside secure_path and
# the build would die with a bare "pnpm: command not found". runuser
# (util-linux — present on every distro these scripts support) leaves PATH
# alone, and still sets HOME to the target user's, which is what corepack
# and pnpm need for their version cache.
run_as_src_owner() {
  local dir="$1"; shift
  local owner
  owner="$(src_owner "$dir")"
  if [ "$owner" = "$(id -un)" ]; then
    "$@"
  else
    runuser -u "$owner" -- "$@"
  fi
}

# _build_artifact_paths SRC_DIR -> prints each build-output path that exists
#
# The paths build_release() itself writes inside the checkout, and only
# those. Globbed against the same workspace layout pnpm-workspace.yaml
# declares (apps/*, packages/*, plugins/*, docs) rather than a hardcoded
# list of package names, so adding a workspace package cannot silently
# fall out of this list.
#
# Deliberately NOT derived from .gitignore, even though every path here is
# gitignored. The reverse is not true: `git ls-files --others --ignored`
# on this repo also returns apps/*/.env, apps/api/uploads/, .test-env and
# .pnpm-store/ — secrets and user data that have nothing to do with a
# build and must never be swept into an ownership decision about one.
_build_artifact_paths() {
  local src_dir="$1" p
  for p in \
    "$src_dir"/node_modules \
    "$src_dir"/.turbo \
    "$src_dir"/*.tsbuildinfo \
    "$src_dir"/{apps,packages,plugins}/*/node_modules \
    "$src_dir"/{apps,packages,plugins}/*/dist \
    "$src_dir"/{apps,packages,plugins}/*/.turbo \
    "$src_dir"/{apps,packages,plugins}/*/*.tsbuildinfo \
    "$src_dir"/docs/node_modules \
    "$src_dir"/docs/.turbo
  do
    [ -e "$p" ] && printf '%s\n' "$p"
  done
  # Explicit: the loop's last `[ -e ]` failing must not make this function
  # look like it errored to a caller running under `set -e`.
  return 0
}

# assert_build_artifacts_owned SRC_DIR OWNER
#
# Refuses when the checkout already contains build artifacts owned by
# someone other than the user the build will run as. It does NOT fix them:
# repairing ownership means a recursive chown, as root, over paths derived
# from a variable — and the operator running one command deliberately is
# preferable to this script mutating ~83,000 inodes on their behalf. It
# also sidesteps pnpm's hardlink semantics entirely, since chowning the
# virtual store would reach through hardlinks into the global pnpm store
# of whichever user created it.
#
# Why this exists at all: before the ownership fix, install-native.sh and
# upgrade-native.sh ran the build as root, so every install performed that
# way left root-owned node_modules/ and dist/ behind. The build now
# correctly runs as the checkout's owner — who cannot replace those files.
# `pnpm install` does NOT catch it (it is a no-op when the lockfile is
# already satisfied); the first real write does, as a raw
# "EACCES: permission denied, unlink ..." from inside prisma generate.
#
# Compared against OWNER, never against the literal "root": a checkout
# that is itself root-owned (the README's own `sudo git clone`) has
# root-owned artifacts AND builds as root, which is consistent and must
# stay a silent no-op.
#
# KNOWN GAP, stated plainly rather than papered over: this is a SHALLOW
# check — it stats the top directory of each artifact path, not the tree
# beneath it. A root build that wrote INTO an already-owner-owned
# node_modules/ leaves the top directory owner-owned while files below it
# are root-owned; this check passes and the operator still gets the raw
# EACCES. The deep alternative (`find ! -user`) closes that gap but walks
# every one of ~83,000 entries on a clean tree, on every build, to catch a
# case that only arises from mixing build users mid-tree. If the deep
# version is ever wanted, it belongs here, behind the same call sites.
assert_build_artifacts_owned() {
  local src_dir="$1" owner="$2"
  local p p_owner
  local -a offenders=() offender_paths=()

  while IFS= read -r p; do
    p_owner="$(stat -c %U "$p" 2>/dev/null || echo '<unknown>')"
    if [ "$p_owner" != "$owner" ]; then
      offenders+=("  ${p}  (owned by '${p_owner}')")
      offender_paths+=("$p")
    fi
  done < <(_build_artifact_paths "$src_dir")

  [ "${#offender_paths[@]}" -eq 0 ] && return 0

  # One command that fixes every offending path at once — an operator
  # should not have to run this five times.
  local fix="sudo chown -R ${owner}: ${offender_paths[*]}"

  die "Refusing to build: the source checkout contains build artifacts owned by another user.

The build runs as '${owner}' (the owner of ${src_dir}), but these paths are not:
$(printf '%s\n' "${offenders[@]}")

Almost always this means the install was done with an older version of
these scripts, which built as root. The build cannot replace files it does
not own, and would fail part-way through with a bare
\"EACCES: permission denied, unlink ...\" from inside pnpm.

Fix it with one command, then re-run this script:
  ${fix}

(This is NOT the git-metadata refusal, which reports \"Cannot read git
state\" and concerns .git rather than build output. If you hit that one
too, its own message names the command for it.)"
}

# git_as_owner SRC_DIR GIT_ARGS...
#
# Every git command these scripts run against the checkout goes through
# here. Running git under sudo writes root-owned objects into .git and
# rewrites .git/index as root, after which the admin's own plain `git
# fetch` in that checkout fails with EACCES — cumulative damage that
# survives the upgrade, so it is prevented at the source rather than
# cleaned up afterwards.
git_as_owner() {
  local dir="$1"; shift
  run_as_src_owner "$dir" git -C "$dir" "$@"
}

# wait_for_health URL [max_tries]
#
# Polls until the endpoint reports status "ok". HTTP 200 alone is NOT
# enough: /api/v1/health answers 200 with {"status":"degraded"} when its
# database or Redis check fails — see apps/api/src/health/health.controller.ts,
# which has no status-code override — so the old `r.ok` test happily passed
# a release that had cut over but could not reach Redis, and the caller
# printed success over it. Requiring status "ok" means a degraded boot
# times out here and takes the caller's failure path (rollback, for
# upgrade-native.sh) instead of being reported as a successful upgrade.
wait_for_health() {
  local url="$1" tries=0 max="${2:-60}"
  until node -e "fetch('$url').then(r=>r.ok?r.json():Promise.reject(new Error('http '+r.status))).then(b=>process.exit(b.status==='ok'?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
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
# Ownership: every step that reads or writes the SOURCE CHECKOUT — the git
# read that names the release, pnpm install, and every build — runs as the
# checkout's owner, never as root (see src_owner()). Before this split the
# whole build ran under the caller's sudo and left root-owned node_modules/
# and dist/ behind in the checkout, which then broke the admin's own git
# commands there. Only the release directory's creation and its handover
# chown stay privileged, and both live outside the checkout.
build_release() {
  local src_dir="$1" releases_dir="$2"
  local release_id owner
  owner="$(src_owner "$src_dir")"

  # Backstop, so no caller can skip it — install-native.sh reaches this
  # without any check of its own, and its header advertises being safe to
  # re-run, which is exactly how a checkout built by the older root-mode
  # scripts gets here. upgrade-native.sh ALSO calls this directly, much
  # earlier, so that its operator gets the refusal before a backup is
  # taken rather than from inside a command substitution here.
  assert_build_artifacts_owned "$src_dir" "$owner"

  release_id="$(date -u +%Y%m%d%H%M%S)-$(git_as_owner "$src_dir" rev-parse --short HEAD 2>/dev/null || echo nogit)"
  local release_dir="${releases_dir}/${release_id}"

  # Created here, and handed to the build user, because the unprivileged
  # build phase below writes the deployed tree straight into it. The caller
  # chowns it to the app user the moment this returns, exactly as before.
  mkdir -p "$release_dir"
  [ "$owner" = "$(id -un)" ] || chown "$owner" "$release_dir"

  # The whole block's stdout is redirected to stderr: build_release()'s
  # return value is the release path, returned via `$(build_release ...)`
  # command substitution — if pnpm/tsc/vite's own progress output went to
  # real stdout here, it would get captured as part of that return value
  # instead of the path, corrupting every later use of $RELEASE_DIR. This
  # keeps the build fully visible in the terminal while keeping stdout
  # clean for the one `printf` below that's the actual return channel.
  #
  # `|| build_status=$?` rather than `if ! ...; then build_status=$?`, for
  # the reason upgrade-native.sh's sync step documents at length: `!`
  # negates the status before `$?` is read, collapsing every failure to 0.
  #
  # BOTH branches go through a fresh `bash -c`, including the one that does
  # not change user — that is load-bearing, not redundancy. errexit is
  # suppressed for a command whose status is being tested, and `||` here is
  # exactly that, so `set -e` inside _build_in_checkout would NOT fire if it
  # ran in this same shell: a failing `pnpm install` would fall straight
  # through the remaining build steps and report status 0. Verified both
  # ways before relying on it. A separate `bash` process starts with its own
  # shell options, so the suppression cannot cross into it and the first
  # failing step aborts the build with its real status.
  local build_status=0
  if [ "$owner" = "$(id -un)" ]; then
    # shellcheck disable=SC2016  # deliberate: $1/$2/$3 are expanded by the
    # INNER bash from the positional args passed after it, not out here.
    bash -c '. "$1"; _build_in_checkout "$2" "$3"' \
      _ "$LIB_SH" "$src_dir" "$release_dir" >&2 || build_status=$?
  else
    # shellcheck disable=SC2016  # same reason as above.
    runuser -u "$owner" -- bash -c '. "$1"; _build_in_checkout "$2" "$3"' \
      _ "$LIB_SH" "$src_dir" "$release_dir" >&2 || build_status=$?
  fi

  if [ "$build_status" -ne 0 ]; then
    # Only removes it if it is still EMPTY — a partially built release is
    # left in place for inspection, as before. Without this, the mkdir
    # hoisted above would litter an empty, validly-named release directory
    # on every failed build.
    rmdir "$release_dir" 2>/dev/null || true
    return "$build_status"
  fi

  printf '%s' "$release_dir"
}

# _build_in_checkout SRC_DIR RELEASE_DIR
#
# The unprivileged half of build_release(): everything that touches the
# source checkout. Never call this directly — build_release() runs it as
# the checkout's owner. It is a top-level function (rather than an inline
# subshell) only because `runuser ... bash -c` has to re-source this file
# to reach it.
#
# The body is a `( ... )` subshell, so `set -e` and `cd` stay contained:
# errexit is SUPPRESSED in build_release()'s own call context (it is
# invoked as `x=$(build_release ...) || die`, and bash exempts commands
# whose status is being tested), so it is re-armed explicitly here — every
# step below must abort the build on failure rather than falling through
# to a half-built release.
_build_in_checkout() (
    set -e
    local src_dir="$1" release_dir="$2"
    cd "$src_dir"
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
)
