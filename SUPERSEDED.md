# This branch is superseded and must not be merged

`chore/deps-security-patches` is replaced by `chore/rc-with-deps` (AshishGTH/openestate).

- It is built from `master` and does not contain the G1-G7 branches, so it is not what will ship.
- The test numbers first reported for it ("122 files / 892 tests, web 81, portal 215") were wrong: they were never measured
  on this branch. See the corrected section 6 of `docs/DEPENDENCY_SECURITY.md`.
- The verified results (clean install, typecheck, lint, build, all suites, audit) are on `chore/rc-with-deps`.

It is kept only until the owner decides to delete it after the release-candidate merge.
