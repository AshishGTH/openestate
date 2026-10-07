# Compatibility rerun: released API vs the release candidate, on staging data

What it proves: for the same requests the existing web app makes, the release-candidate API returns every field the released
API returned, with the same values, and only adds fields. It is `apps/staff/test-integration/compat.test.ts` in the mobile
repo, **22 tests**. In this cloud session it passed against the release candidate on a development machine: `Tests 22 passed (22)`, released API
= **v0.8.2, commit `d337a73`** (the current release, containing the GHSA-6qrx-8q6w-hvgj security fixes), new API =
`chore/rc-with-deps` at merge commit `7096686`, test database; the whole real-API integration run was 6 files / 101 tests
passed (auth 10, compat 22, dashboard 20, errors 17, leads 14, schedule 18). An earlier run used `af9ff7a` (v0.8.1+1) as the
baseline; that baseline is **obsolete**. That is not a staging result.

## Where the "released" API comes from

The API version that **production runs today**, not a moving branch. As of this writing the current release is **v0.8.2 (`d337a73`)**; if production is still on an older tag, use that tag for the "released" side, because that is the build the upgrade replaces. Find its commit on the production or staging host:

```bash
readlink -f /opt/openestate/current            # the running release directory
git -C /opt/openestate-src describe --tags --always     # only if the source checkout is at that release
```

Then build exactly that commit in a separate directory, next to (not over) the release-candidate build:

```bash
git clone https://github.com/AshishGTH/openestate /opt/openestate-released
cd /opt/openestate-released && git checkout <the released tag or commit>
pnpm install --frozen-lockfile && pnpm build
```

The released build then runs against the **same staging database copy that already has the new migration applied**. That is
the point: the previous release must keep working against the new schema during an upgrade.

## Commands

Use the staging **copy** of the database (never production). The seed creates one new company and a few users in it; it
deletes nothing.

```bash
# 1. Mobile repo checkout on any machine that can reach the staging host over the network
git clone https://github.com/AshishGTH/openestate-mobile && cd openestate-mobile
git checkout chore/release-candidate && pnpm install --frozen-lockfile

# 2. Seed (run on the staging host, in the RC API checkout, pointed at the copy's DATABASE_URL_TEST / _SYSTEM)
cp /path/to/openestate-mobile/tools/integration/seed-real-api.test.ts apps/api/test/_seed-real-api.test.ts
cd apps/api && SEED_OUT=/tmp/seed.json npx vitest run test/_seed-real-api.test.ts && rm test/_seed-real-api.test.ts

# 3. Start the released API on port 3997 against the same database (same env as the RC API; the RC API is already running)
cd /opt/openestate-released/apps/api
env $(sudo cat /etc/openestate/openestate.env | grep -v '^#' | xargs) PORT=3997 node dist/main.js &

# 4. Run only the compatibility file (from the mobile repo; copy /tmp/seed.json to that machine if it is a different host)
cd /path/to/openestate-mobile/apps/staff
REAL_API_URL=https://staging.example.com \
REAL_API_BASELINE_URL=http://<staging-host>:3997 \
REAL_API_SEED=/tmp/seed.json \
  npx vitest run --config vitest.integration.config.mts compat
```

Notes: port 3997 must be reachable from where you run the tests (use an SSH tunnel; do not open it to the internet). Step 2
needs the API repo's test dependencies on the host. The simplest alternative is to run everything on the staging host with
`tools/integration/run-real-api.sh`, which starts both APIs itself, but it uses the API repo's `.test-env` database: point
`DATABASE_URL_TEST` and `DATABASE_URL_TEST_SYSTEM` at the staging copy first. Do not use production credentials.

## What counts as PASS

- `Test Files 1 passed (1)` and `Tests 22 passed (22)`; **0 failed, 0 skipped**. A skipped file means
  `REAL_API_BASELINE_URL` or `REAL_API_SEED` was not set, which is not a pass.
- Any failure is reported as a compatibility problem with the path printed by the test (for example
  `$.data[0].status: "OPEN" -> "open"` or `field removed`). Do not edit the test to make it pass.
- Anything new in the response is allowed; a removed field, a changed type or value, or a different array length is a fail.

## Result table

Staging run 2026-10-07: staging VM 192.168.1.20 (Ubuntu 24.04.5, nginx 1.24.0, Node 20.20.2, PostgreSQL 16.15, Redis 7.0.15), self-signed cert, test data only; upgraded v0.8.2 (`d337a73`) -> `chore/rc-with-deps` (`bf29620`).

| Item | Result |
|---|---|
| Released commit/tag identified on the host | PASS: `/opt/openestate/current` -> `releases/20261002170052-d337a736`, source at `v0.8.2` (`d337a73`) |
| Released API built and running on 3997 against the migrated staging copy | PASS: `/opt/openestate-released` at `d337a73`, run as the service user with the service env; 3997 reachable only through an SSH tunnel (iptables drop, removed afterwards) |
| Seed created on the staging copy | PASS, with two adaptations: `SEED_BULK=0` (the seed's own switch), and the two follow-up types inserted without `isSiteVisit` because that column does not exist before the migration (the migration then flagged `Site Visit`). The seed creates **two** companies, not one |
| `compat` file: 22 tests passed, 0 failed, 0 skipped | PASS: `Tests 22 passed (22)`, RC over HTTPS vs v0.8.2 on 3997. Setup check before the upgrade (v0.8.2 on both sides): 18 passed, 4 failed, exactly the RC-only assertions |
| Web app screens (inquiries, follow-ups, reports) load against the RC API | NOT TESTED (no browser run in this session) |
