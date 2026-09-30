# Compatibility rerun: released API vs the release candidate, on staging data

What it proves: for the same requests the existing web app makes, the release-candidate API returns every field the released
API returned, with the same values, and only adds fields. It is `apps/staff/test-integration/compat.test.ts` in the mobile
repo, **22 tests**. In this cloud session it passed against the release candidate on a development machine (`Tests 22
passed (22)`, released API = `master` at `af9ff7a`, test database). That is not a staging result.

## Where the "released" API comes from

The API version that **production runs today**, not a moving branch. Find its commit on the production or staging host:

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

| Item | Result |
|---|---|
| Released commit/tag identified on the host | NOT TESTED |
| Released API built and running on 3997 against the migrated staging copy | NOT TESTED |
| Seed created on the staging copy | NOT TESTED |
| `compat` file: 22 tests passed, 0 failed, 0 skipped | NOT TESTED |
| Web app screens (inquiries, follow-ups, reports) load against the RC API | NOT TESTED |
