#!/usr/bin/env bash
# Tests previous_release_tag() (deploy/native/lib.sh), which CI's
# upgrade-from-previous-release job uses to pick the release to start from,
# against throwaway local git repositories. Needs bash, git and node.
#
#   bash deploy/native/test-previous-release.sh
#
# Set PREVIOUS_RELEASE_IMPL=old to run the cases against the old selection
# ("newest tag that isn't HEAD"); the first case must then fail. Used to
# mutation-check this test.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
G() { git -c user.name=test -c user.email=test@example.invalid -c init.defaultBranch=main "$@"; }

ok()   { PASS=$((PASS + 1)); printf 'ok   - %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL - %s\n' "$1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

# shellcheck source=lib.sh
source "$HERE/lib.sh"

if [ "${PREVIOUS_RELEASE_IMPL:-}" = "old" ]; then
  # The selection CI used until v0.8.4, kept only to show this test catches it.
  previous_release_tag() {
    local head t
    head="$(cd "$1" && git rev-parse HEAD)"
    for t in $(cd "$1" && git tag -l 'v*' --sort=-v:refname); do
      if [ "$(cd "$1" && git rev-list -n1 "$t")" != "$head" ]; then echo "$t"; return 0; fi
    done
    return 1
  }
fi

# commit REPO VERSION [TAG]: a commit whose root package.json has VERSION.
commit() {
  printf '{"version":"%s"}\n' "$2" > "$1/package.json"
  G -C "$1" add package.json && G -C "$1" commit -q --allow-empty -m "v$2" && { [ -z "${3:-}" ] || G -C "$1" tag "$3"; }
}
repo() { local d="$TMP/$1"; mkdir -p "$d" && G -C "$d" init -q && echo "$d"; }
pick() { OUT="$(previous_release_tag "$1" 2>&1)"; RC=$?; }

R="$(repo after-release)"
commit "$R" 0.8.3 v0.8.3; commit "$R" 0.8.4 v0.8.4; commit "$R" 0.8.4
pick "$R"; check "HEAD 0.8.4 after the v0.8.4 tag (not tagged itself): v0.8.3" "$OUT" v0.8.3

R="$(repo at-tag)"
commit "$R" 0.8.3 v0.8.3; commit "$R" 0.8.4 v0.8.4
pick "$R"; check "HEAD 0.8.4 at the v0.8.4 tag commit: v0.8.3" "$OUT" v0.8.3

R="$(repo next-patch)"
commit "$R" 0.8.3 v0.8.3; commit "$R" 0.8.4 v0.8.4; commit "$R" 0.8.5
pick "$R"; check "HEAD 0.8.5: v0.8.4" "$OUT" v0.8.4

R="$(repo rc)"
commit "$R" 0.8.4 v0.8.4; commit "$R" 0.9.0-rc.0 v0.9.0-rc.0; commit "$R" 0.9.0-rc.1
pick "$R"; check "HEAD 0.9.0-rc.1 with v0.8.4 and v0.9.0-rc.0: v0.9.0-rc.0" "$OUT" v0.9.0-rc.0

R="$(repo none-lower)"
commit "$R" 0.8.3 v0.8.3
pick "$R"; check "HEAD 0.8.3 with only v0.8.3: fails" "$RC" 1
case "$OUT" in *"No release tag has a version lower than 0.8.3"*) ok "no lower tag: says why";; *) bad "no lower tag: message (got: $OUT)";; esac

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
