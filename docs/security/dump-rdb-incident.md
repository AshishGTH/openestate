# Incident record: `dump.rdb` committed to the G1-G7 API branches

Status of the whole record: **the owner has not yet confirmed the origin of the data (section 4). Risk is LOW only if the
answer there is yes.**

## 1. What happened

A Redis snapshot, `dump.rdb`, was committed by accident with `git add -A` while Redis was running with the repository as its
working directory. The file was later deleted, but it stays in git history.

| Commit | Added / changed | Size | Branches containing it (all public on GitHub) |
|---|---|---|---|
| `c5843a3` | added | 2,939 bytes | `feat/api-inquiry-search`, `feat/api-inquiry-filters`, `feat/api-followups`, `feat/api-site-visits`, `feat/api-activity`, `chore/api-release-readiness` (**all six**) |
| `6564801` | modified | 5,353 bytes | the same list **except** `feat/api-inquiry-search` (five branches) |

`chore/rc-with-deps` is created from `chore/api-release-readiness`, so it contains both commits as well. It is not on
`master`. The mobile repository never had one.

## 2. What is in it (decoded properly)

An earlier check searched the raw bytes for patterns. Redis compresses string values with LZF, so that check could not see
inside them. This record is from decoding the files as Redis 7.0.15 RDB version 10 (LZF strings, listpack hashes and sorted
sets, stream listpacks), key by key, with a purpose-written parser. The first file decodes to 26 keys and the second to 32; the parser
reached the end-of-file marker in both. The RDB CRC64 checksum was not verified.

Value types: strings, hashes (plain and listpack), sorted sets (listpack) and streams. No lists, sets or consumer groups.

Key families (counts are for the second file):

| Family | Keys | What it holds |
|---|---|---|
| `bull:<queue>:meta`, `:id`, `:stalled-check`, `:events`, `:delayed`, `:repeat` | 22 | BullMQ queue plumbing: queue names, version, job-id counters, repeatable-job schedules, the event stream |
| `bull:escalation:4`, `:5`, `:6`, `:completed` | 4 | three finished `company-escalation` jobs and their index |
| `throttle:default:<64 hex>` | 3 (2 in the first file) | request-rate counters: fields `hits`, `expiresAt`, `blockExpiresAt`, `isBlocked`; expiring within a minute of the snapshot |

Findings that the earlier scan missed:

1. **Three company UUIDs, in the second file only.** They appear as `{"companyId": "..."}` in the payloads of the three
   `company-escalation` jobs (and again in the escalation event stream and the repeat record). They are not test fixtures
   stored in the repository. Their values are deliberately not repeated here. The first file has none.
2. **Three `@nestjs/throttler` keys** (two in the first file, three in the second, two of them shared). Each key is a SHA-256
   over controller, handler, throttler name and the tracker (a user id or a client IP). Nothing else in the entry names the
   tracker. The prefix strings are public in the source, so an attacker can test guesses; an IPv4 tracker is within reach of
   brute force, a user UUID is not. **Recovery was not attempted for this record.** The counters were time-limited.

Not found, checked in every decoded value: JWTs, email addresses, phone numbers (10-digit), password hashes (`$argon2`),
IPv4 addresses, and any key or value containing password, secret, token, bearer or refresh. The escalation results
(`notifiedUserIds`, `escalatedInquiryIds`) are empty arrays in all three jobs.

## 3. Risk

Contents are queue bookkeeping, three company identifiers, and three short-lived rate-limit counters. A company UUID is an
identifier, not a credential (every row is also protected by row-level security and authentication), but it is still a real
tenant identifier if it belongs to a real customer. **Risk: LOW, on the condition in section 4.**

## 4. REQUIRES APPROVAL

- **Owner to confirm whether the Redis instance that produced `dump.rdb` was connected only to a local seed database. Risk stays
  LOW only if yes.** If the three company IDs belong to a real installation, treat them as a disclosure of tenant
  identifiers: keep the post-merge purge in section 5 mandatory, and consider them known to an observer of the repository.
  Status: **NOT CONFIRMED.**

## 5. Plan (not carried out in this session: nothing has been deleted and no history rewritten)

1. Merge the API stack into `master` with **squash** merges, so `master` never receives either commit.
2. After the merge, **delete the seven feature branches from `origin`**: the six stacked branches above and
   `chore/rc-with-deps`. Until that is done the blobs remain reachable from GitHub.
3. If the company IDs are real, **ask GitHub Support to purge the cached commits** (deleting a branch does not remove cached
   views or objects reachable by SHA). Give them `c5843a3` and `6564801`.
4. Prevention already in place: `*.rdb` and `dump.rdb` are in `.gitignore` (verified with `git check-ignore`), and Redis is run
   with its data directory outside the working tree.

## 6. Check that the squashed result is clean

See the command and its output recorded in `docs/staging/RC_REPO_CHECKS.md`.
