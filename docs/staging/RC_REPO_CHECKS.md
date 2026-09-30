# Repository checks on the release candidate

## dump.rdb is not in the squashed result

The API stack will be squash-merged, so what reaches `master` is the net diff of the final branch against `master`. Run on
`chore/rc-with-deps` (which contains the whole stack), on 2026-09-30:
