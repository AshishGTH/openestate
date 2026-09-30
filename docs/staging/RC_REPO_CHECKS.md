# Repository checks on the release candidate

## dump.rdb is not in the squashed result

The API stack will be squash-merged, so what reaches `master` is the net diff of the final branch against `master`. Run on
`chore/rc-with-deps` (which contains the whole stack), on 2026-09-30:

```
$ git diff --name-only origin/master HEAD | grep -cE '\.rdb$'
0
(exit 1)
$ git diff --stat origin/master HEAD -- dump.rdb '*.rdb' | wc -l
0
(exit 0)
$ git ls-tree -r HEAD --name-only | grep -cE '\.rdb$'
0
(exit 1)
$ git check-ignore -v dump.rdb apps/api/dump.rdb
.gitignore:44:dump.rdb	dump.rdb
.gitignore:44:dump.rdb	apps/api/dump.rdb
(exit 0)
$ git diff --shortstat origin/master HEAD
 46 files changed, 3765 insertions(+), 264 deletions(-)
(exit 0)
$ git log --oneline origin/master..HEAD -- dump.rdb
a698d02 chore: remove dump.rdb accidentally added by an earlier commit on this branch
6564801 feat(api): status filter and sortBy whitelist for GET /inquiries; 400 for malformed ids
c5843a3 feat(api): apply GET /inquiries search across name, email, project and phone
(exit 0)
```

Reading the output:

- The first three commands print `0`: the net diff of the branch against `master` has no `*.rdb` file, and neither does the
  branch's tree. (`grep -c` exits 1 when the count is 0; that is the expected result, not an error.) A squash merge of this
  branch therefore cannot bring `dump.rdb` into `master`.
- The last command lists the three commits that touched the file **in history** (added, modified, then removed by `a698d02`).
  A squash merge discards them. They stay reachable from the branches until those are deleted, which is why the post-merge
  step in `docs/security/dump-rdb-incident.md` section 5 is needed.
- `.gitignore` line 44 ignores `dump.rdb` at any depth.
- This checks the branch as of the commit that added this file. Repeat it on the final commit before merging.
