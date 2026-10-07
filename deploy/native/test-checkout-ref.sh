#!/usr/bin/env bash
# Tests checkout_ref() (deploy/native/lib.sh), the fetch step of upgrade-native.sh,
# against throwaway local git repositories. Needs only git and bash.
#
#   bash deploy/native/test-checkout-ref.sh
#
# The central case is a DIVERGED TAG: the clone holds tag vX at one commit and
# origin has moved vX to another (what a clone made before the history rewrite
# looks like). The old fetch line (`git fetch --tags && git checkout`) fails on
# it, which this script proves first, so the tests below are known to be able to
# fail. Set CHECKOUT_REF_IMPL=old to run the new-behaviour cases against the old
# line instead (they must then fail; used to mutation-check this test).
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

# The old line from upgrade-native.sh, kept only so the test can show it fails.
old_checkout() { (cd "$1" && git fetch --tags && git checkout "$2"); }

# run_checkout SRC REF: runs the implementation under test in a subshell
# (die() exits) and prints its combined output; the exit code is in $RC.
run_checkout() {
  if [ "${CHECKOUT_REF_IMPL:-new}" = "old" ]; then
    OUT="$(old_checkout "$1" "$2" 2>&1)"; RC=$?
  else
    OUT="$(bash -c 'source "$1/lib.sh"; checkout_ref "$2" "$3"' _ "$HERE" "$1" "$2" 2>&1)"; RC=$?
  fi
}

# --- fixtures: origin with commit c1 tagged vX, a clone, then origin moves vX to c2
ORIGIN="$TMP/origin.git"
G init -q --bare "$ORIGIN"
SEED="$TMP/seed"
G clone -q "$ORIGIN" "$SEED" 2>/dev/null
echo one > "$SEED/f"; G -C "$SEED" add f; G -C "$SEED" commit -q -m c1
C1="$(G -C "$SEED" rev-parse HEAD)"
G -C "$SEED" tag vX; G -C "$SEED" push -q origin HEAD:main vX 2>/dev/null
WORK="$TMP/work"
G clone -q "$ORIGIN" "$WORK" 2>/dev/null
echo two > "$SEED/f"; G -C "$SEED" commit -q -am c2
C2="$(G -C "$SEED" rev-parse HEAD)"
G -C "$SEED" tag -f vX >/dev/null; G -C "$SEED" tag vNEW
G -C "$SEED" push -q --force origin HEAD:main vX vNEW 2>/dev/null
G -C "$SEED" checkout -q -b topic; echo three > "$SEED/f"; G -C "$SEED" commit -q -am c3
C3="$(G -C "$SEED" rev-parse HEAD)"
G -C "$SEED" push -q origin topic 2>/dev/null

# 0. The scenario really reproduces the bug: the old line fails on a diverged tag.
OLD_OUT="$( (cd "$WORK" && git fetch --tags 2>&1) )"; OLD_RC=$?
check "old line 'git fetch --tags' fails on the diverged tag" "$OLD_RC" "1"
case "$OLD_OUT" in *"would clobber existing tag"*) ok "old line fails with 'would clobber existing tag'";; *) bad "old line did not report the clobber error";; esac
check "local tag vX still at c1 before the fix runs" "$(G -C "$WORK" rev-parse vX^{commit})" "$C1"
# The failed old fetch still downloaded the other new tag; remove it so case 2 is meaningful.
G -C "$WORK" tag -d vNEW >/dev/null 2>&1

# 1. Diverged tag: the requested ref is fetched forced and checked out.
run_checkout "$WORK" vX
check "diverged tag: exit status 0" "$RC" "0"
check "diverged tag: checked out the NEW commit c2" "$(G -C "$WORK" rev-parse HEAD)" "$C2"
check "diverged tag: the local tag was moved to c2" "$(G -C "$WORK" rev-parse vX^{commit})" "$C2"

# 2. Only the requested ref is fetched: another new upstream tag is NOT pulled in.
G -C "$WORK" rev-parse -q --verify refs/tags/vNEW >/dev/null 2>&1; HAS_NEW=$?
check "only the requested ref is fetched (unrelated new tag vNEW not downloaded)" "$HAS_NEW" "1"

# 3. A branch works.
run_checkout "$WORK" topic
check "branch: exit status 0" "$RC" "0"
check "branch: checked out the tip c3" "$(G -C "$WORK" rev-parse HEAD)" "$C3"

# 4. A ref that does not exist stops with a plain message and changes nothing.
BEFORE="$(G -C "$WORK" rev-parse HEAD)"
run_checkout "$WORK" v9.9.9-does-not-exist
check "unknown ref: non-zero exit" "$([ "$RC" -ne 0 ] && echo nonzero || echo zero)" "nonzero"
case "$OUT" in *"Could not download 'v9.9.9-does-not-exist'"*"previous release is still running"*) ok "unknown ref: plain-English error naming the ref";; *) bad "unknown ref: message missing (got: $OUT)";; esac
check "unknown ref: checkout unchanged" "$(G -C "$WORK" rev-parse HEAD)" "$BEFORE"

# 5. Origin unreachable: same, clear failure, nothing changed.
G -C "$WORK" remote set-url origin "$TMP/does-not-exist.git"
run_checkout "$WORK" vX
check "unreachable origin: non-zero exit" "$([ "$RC" -ne 0 ] && echo nonzero || echo zero)" "nonzero"
case "$OUT" in *"Could not download 'vX'"*"Nothing was changed"*) ok "unreachable origin: plain-English error";; *) bad "unreachable origin: message missing (got: $OUT)";; esac
check "unreachable origin: checkout unchanged" "$(G -C "$WORK" rev-parse HEAD)" "$BEFORE"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
