# SF-01 fix plan: a structural staff/portal session boundary

Status: **plan for review. Nothing implemented.** Private: this file stays
untracked until the advisory is published.

Inputs: the root-cause analysis (four gaps: one shared token shape with no
type claim, no guard enforcing the surface, staff-side issuance not
excluding portal accounts, portal roles able to hold staff permissions) and
the failing tests in `apps/api/test/e2e-portal-token-boundary.test.ts`
(`dc625fa`, local branch `test/portal-token-boundary`).

Goal: a portal session can never reach a staff route, and a staff session
can never reach a portal route, whatever permissions any role holds. An
unmarked new route is staff-only. The check runs once, in the global guard
chain, not inside handlers.

---

## 1. How a token declares its surface

Recommendation: **(a) a signed `surface` claim (`'staff' | 'portal'`),
checked by one global guard.**

| Option | For | Against |
|---|---|---|
| **(a) signed claim + global guard** | One signer (`TokenService.signAccessToken`) already issues every access token, so the claim is set in one place. No new env vars, no migration, no new strategy. The guard also checks claim consistency (see below). | Everything still depends on one secret; a leaked `JWT_ACCESS_SECRET` forges either kind. That is equally true today. |
| (b) separate secrets per surface | Strongest separation: a staff strategy can't even verify a portal token. | Needs two passport strategies and a per-route choice of strategy, so it needs the same route-surface marking as (a) anyway. It adds a new **boot-required secret** to every existing install. `upgrade-native.sh` adding a boot-required setting is exactly what v0.9.0 exists to prove; making a security patch depend on unproven upgrade plumbing is the wrong order. Worth revisiting as hardening after v0.9.0. |
| (c) `Role.isPortal` | Already in the schema. | The surface belongs to the **user**, not the role: portal-ness is `applicantId`/`brokerId` on the user row, and portal login already keys on that. `isPortal` is set only by the seed (`seed.ts:50`) and defaults to false for any role made in the Roles screen, so it can't be trusted as the identity signal. Checking it per request needs a DB read or another claim. Keep it for defence in depth (§6) only. |

**Where the surface comes from:** one shared helper,
`accountSurface(user) = user.applicantId || user.brokerId ? 'portal' : 'staff'`,
in `apps/api/src/auth/`. It is used by both services when issuing, by
both refresh paths, and by the 2FA verify paths. The user row decides;
nothing trusts the endpoint that was called.

**Changes to token issuance:**
- `JwtPayload` (`packages/shared/src/auth.dto.ts:93`) gains a required
  `surface` field.
- `signAccessToken` and `signTwoFactorPendingToken`
  (`apps/api/src/auth/token.service.ts:27,36`) take the surface as a
  required argument, so no call site can omit it (the compiler enforces
  it).

**Claim-consistency rule the guard enforces:**
- A `portal` token must carry exactly one of `applicantId`/`brokerId`.
- A `staff` token must carry neither.

This closes the "portal-role token with no portal scope" hole from
section 3 of the analysis, because a portal token always drives RLS
scoping.

**A token with no `surface` claim (issued before the upgrade) is rejected
with 401 on every route.** There's no transition rule inferring the
surface from `applicantId`. Nothing needs one: access tokens live 15
minutes, and both frontends already answer a 401 by refreshing and
retrying (`apps/web/src/lib/api.ts`, `apps/portal/src/lib/api.ts`). The
refresh (§4) decides the surface from the user row and mints a token with
the claim. Legitimate users see one silent refresh; nobody gets a bypass
window.

## 2. The guard

**`SessionSurfaceGuard`, a new global guard**, registered in
`app.module.ts` straight after `TwoFactorPendingGuard`. Order becomes:

throttler → `JwtAuthGuard` → `TwoFactorPendingGuard` →
**`SessionSurfaceGuard`** → `CsrfGuard` → `PermissionsGuard`

It runs before CSRF and permissions, so a wrong-surface token is refused
before any permission is considered.

**Which surface a route belongs to:** decided by URL path, using the
existing `PORTAL_PATH_PREFIX` constant (`apps/api/src/auth/csrf-cookie-names.ts`)
that `CsrfGuard` already uses the same way (`csrf.guard.ts:39`).
- Anything under `/api/v1/portal/` is portal; everything else is staff.
- That makes staff the **default**: a new route is staff-only unless its
  path puts it under the portal prefix. Nobody has to add a decorator to
  get protection.
- All 33 current `/portal/*` routes are portal routes. The staff routes
  that manage portal users (`/admin/portal-invites`,
  `/admin/portal-password-resets`, `/admin/portal-2fa-resets`) sit outside
  the prefix and are correctly staff.
- There are no routes meant for both surfaces today.

Rejected alternative: a `@PortalRoute()` decorator. It would work, but
every portal controller would have to remember it. Path prefix is already
the convention for CSRF.

**Guard behaviour:**
- `@Public()` routes: skipped (no session to check). Public routes on
  both surfaces (login, refresh, reset confirm, invite consume) do their
  own account-type checks (§3, §4).
- No `surface` claim: 401.
- Claim inconsistent with `applicantId`/`brokerId` (§1): 401.
- Surface doesn't match the route: **403, with a generic message.** 403
  rather than 401, so the frontends' 401→refresh logic doesn't loop.
- The 2FA-pending token carries a surface too, so `/auth/totp/verify`
  accepts only a staff-pending token and `/portal/auth/totp/verify` only a
  portal-pending one. That closes the todo's cross-surface verify item at
  the guard, in addition to §3.

**Customer vs broker** inside the portal stays with the existing
per-handler checks and RLS scoping. That's no longer a boundary problem:
every portal token now carries its scope claim.

**Route inventory check:** a test enumerates every route Nest registered
at bootstrap (`DiscoveryService` + path metadata, not a hand-kept list)
and asserts each is classified by the prefix rule. It records the
staff/portal split in a snapshot, so a route that moves between surfaces
shows up in review.

## 3. Staff-side issuance: refuse portal accounts

These mirror what `portal-auth.service.ts` already does (`:68` for login,
`:209` for refresh):

- **Staff login** (`auth.service.ts:40`): add
  `applicantId: null, brokerId: null` to the lookup, the exact mirror of
  the portal's `NOT: { applicantId: null, brokerId: null }`. A portal
  account gets the same generic "Invalid credentials" as a wrong password,
  so the response doesn't reveal that it exists. It must not count toward
  that account's lockout; the lookup simply doesn't find it.
- **Staff refresh** (`auth.service.ts:213-240`): refuse when
  `accountSurface(user) !== 'staff'`, and check before rotating (§4).
- **Staff 2FA verify** (`auth.service.ts:98`): refuse a non-staff account.
  The guard (§2) already refuses a portal-pending token here; this is the
  second layer.
- **Portal 2FA verify**: add the mirror check (refuse a staff account).
  Today it relies on the pending token having come from portal login,
  which does exclude staff; after this it doesn't depend on that.

This closes both todo items under "SECURITY-RELEVANT: staff and portal
auth aren't bound to their own users": cross-surface pending-token
acceptance, and "staff login resolves users by email without excluding
portal-linked users".

**End state — auth/ and portal-auth/ symmetric:** each surface's login,
refresh and 2FA verify refuse the other surface's accounts; each issues
tokens with its own `surface`; the guard enforces it on every non-public
route. The standing mirrored-auth rule applies: every change lands on
both sides in the same PR.

## 4. Refresh tokens

**No migration and no surface column on `refresh_tokens`.** A user's
surface is fixed by the user row (users are created as staff through the
Users screen or as portal through invite consume; neither path turns one
into the other), so the account check is enough.

**Check before rotating.** Today staff refresh rotates first and checks
the user afterwards. Presenting a portal refresh token there would consume
it, which would silently end the portal user's own session.

Change: `TokenService.rotateRefreshToken` takes an `expectedSurface`
argument. It resolves the token row's user and, if that user's surface
differs, refuses **without revoking or rotating anything**. It returns
the same `null` as an invalid token, so both controllers keep their
current 401 and cookie-clearing behaviour.

Both staff and portal refresh pass their surface, so the check is
symmetric by construction, in the one function both already share.

## 5. Existing sessions on upgrade

| Session | After upgrade | Acceptable because |
|---|---|---|
| Access token, staff or portal (no `surface` claim) | 401 on first use | Frontends refresh transparently; tokens are at most 15 minutes old anyway |
| Staff refresh token, staff user | Works; mints a claimed token | Account check passes |
| Portal refresh token, portal user | Works on portal refresh; refused at staff refresh without being consumed | Account check |
| Any staff-shaped token previously minted for a portal user via the gaps in §3 | Dies at once (no claim), and can't be re-minted | Closes the window completely |
| Pending 2FA tokens (5-minute lifetime) | 401; the user signs in again | Rare, short, harmless |

**No forced re-login is needed for legitimate users, and there's no bypass
window.** I considered revoking every refresh token on upgrade as a belt
and braces, and don't recommend it: it logs everyone out for no added
protection, because no pre-upgrade refresh token can produce a
wrong-surface token once §4 is in place.

## 6. Defence in depth (secondary; the boundary holds without it)

1. **Seeded roles:**
   - Remove `REPORTS_BROKER_VIEW` from `ROLE_PERMISSIONS.broker`
     (`packages/shared/src/roles.ts:166`).
   - `/portal/broker/dashboard` needs it today
     (`portal-broker-dashboard.controller.ts:17`), so it moves to a new
     portal permission, `portal.broker.dashboard.read`, granted to the
     broker role.
   - After this, every seeded portal-role permission starts with
     `portal.`.
2. **Roles screen refuses staff permissions on portal roles:**
   - In `RolesService.create`/`update`, reject any `permissionIds` whose
     key doesn't start with `portal.` when the role is a portal role
     (400 with a clear message).
   - "Portal role" is decided the same way on every path: `isPortal`, or
     the seeded portal slugs, so an install where `isPortal` was never set
     is still covered.
   - `RoleForm.tsx` lists only `portal.*` permissions for a portal role.
     This is a UI-side filter only; the service is the enforcement.
3. **Existing installs get the corrected broker role through a forward-only
   migration, not the seed.** The seed never touches an existing company's
   roles (the `existingCompany` early return), and `sync-permissions`
   deliberately leaves role composition alone except for super_admin
   (CLAUDE.md, "Seed-only-reachable-data audit").

   The migration:
   - inserts the `portal.broker.dashboard.read` permission row if absent.
     It has to, because migrations run before `sync-permissions` in
     `upgrade-native.sh`;
   - sets `is_portal = true` on system roles with slug `customer` or
     `broker` (in case an older install never had it set);
   - grants the new permission to every broker role;
   - deletes every `role_permissions` row on a portal role whose
     permission key isn't `portal.*`.

   Deleting grants an admin chose is deliberate: after this fix that
   state is invalid and has no effect. `upgrade-native.sh` prints the
   number of rows removed; the CHANGELOG says so. Role-permission changes
   write no audit row today (todo), so the upgrade log is the record.

   `native-upgrade` CI gets an **outcome** assertion, per the standing
   rule: after upgrade, a broker portal token gets 403 on
   `/reports/brokers/summary` and 200 on `/portal/broker/dashboard`. It
   doesn't just check that the permission row changed.

## 7. Frozen core and approvals

**No Phase-4 financial file changes.** Booking, ledger, receipt, GST, TDS,
interest, transfer and cancellation code is untouched; the broker report
service isn't modified either — it simply becomes unreachable to portal
tokens.

Files touched:
- `apps/api/src/auth/` (token service, auth service, new guard)
- `apps/api/src/portal-auth/portal-auth.service.ts`
- `apps/api/src/app.module.ts` (guard registration)
- `apps/api/src/roles/roles.service.ts`
- `portal-broker-dashboard.controller.ts`
- `packages/shared/src/auth.dto.ts`, `permissions.ts`, `roles.ts`
- one migration
- `apps/web/src/pages/admin/RoleForm.tsx`

**Owner approval needed (flagged):**
- The migration deletes existing role grants (§6.3).
- Staff login and refresh start refusing portal accounts — a behaviour
  change a portal user with an email might notice if they had been using
  the staff login.
- `JwtPayload` changes shape (both frontends decode it; an added field is
  harmless: `apps/web/src/lib/auth.tsx:34`).

## 8. Proof: tests that must pass before release

Everything runs through the real HTTP pipeline (Supertest,
`NestFactory` + `dist/app.module`), as the standing rule for auth
requires.

| # | Test | Red now? |
|---|---|---|
| 1 | `e2e-portal-token-boundary.test.ts` (`dc625fa`): five broker-report routes reject a broker portal token; staff and portal controls pass | **Red** (5/7 failing) |
| 2 | **Staff-route sweep, permanent:** every non-public route **not** under the portal prefix, enumerated from Nest's route registry at runtime (all methods, minimal body), called with a broker token and a customer token. Only 401/403 passes; any 2xx/400/404/409/500 fails with route, method and status. Two variants: seeded portal roles, and portal roles granted **every** permission (the real measure of the boundary) | **Red** (at least the five SF-01 routes; the all-permissions variant broadly) |
| 3 | **Portal-route sweep, permanent:** every non-public `/portal/*` route called with a super_admin staff token (holds every permission). Only 401/403 passes | **Red** (the 10 handler-checked routes return 400; the unchecked download/ticket routes get past authorization) |
| 4 | Token claims: tokens signed with the test secret, crafted to be (a) missing `surface`, (b) `portal` with no `applicantId`/`brokerId`, (c) `staff` with `brokerId`, (d) `portal` with both ids. Each → 401 on a staff and a portal route | **Red** (all accepted today where permissions allow) |
| 5 | Staff login with a portal account's email → 401 "Invalid credentials", no lockout counter change on that account | **Red** |
| 6 | A portal refresh cookie presented to `/auth/refresh` → 401, **and** the same portal session still refreshes on `/portal/auth/refresh` afterwards (not consumed). Mirror: a staff refresh cookie on `/portal/auth/refresh` → 401 and still valid on staff | **Red** (staff side); portal side green now, kept as regression |
| 7 | Cross-surface 2FA: a portal-pending token on `/auth/totp/verify` → 401/403; a staff-pending token on `/portal/auth/totp/verify` → 401/403 | **Red** |
| 8 | Upgrade continuity: a token without `surface` gets 401; the following refresh returns a claimed token that works on its own surface | **Red** (unclaimed tokens are accepted today) |
| 9 | Roles: through HTTP, granting a staff permission to the broker/customer role → 400; granting a `portal.*` permission → OK | **Red** |
| 10 | Migration: fabricate the pre-fix state (broker role holding `reports.broker.view` plus one more staff permission; a custom staff role holding the same), run the shipped `migration.sql`, assert the portal role lost both and gained `portal.broker.dashboard.read`, and the staff role is untouched | **Red** (migration doesn't exist) |
| 11 | Broker dashboard: 200 for a broker with the new permission; 403 for a customer | **Red** until the permission exists |
| 12 | Route-classification snapshot (§2) | **Red** (doesn't exist) |
| 13 | Full `apps/api`, `packages/db`, `packages/shared` suites green; no existing portal/staff e2e file regresses | green today; must stay green |
| 14 | Full Playwright suite, including `auth-2fa`, `portal-2fa`, `rapid-reload-session` and the portal specs. Satisfies the auth real-browser rule on both surfaces (CLAUDE.md: automated real-browser verification counts) | green today; must stay green |
| 15 | `native-upgrade` CI outcome assertion (§6.3) | **Red** |

## 9. Release shape: v0.8.1 security patch

Released **before** the browser audit and the v0.9.0 work, so the audit
runs against fixed code.

**Where the work happens:** in the advisory's temporary private fork.
Assumption to confirm first: GitHub Actions don't run in advisory private
forks. If so, each PR's evidence is the full local run (items 13 and 14)
against the local test containers, pasted into the PR, and CI runs for
the first time on merge.

**PRs, in order:**
1. **Session surface** (§1–§5): claim, guard, issuance exclusion, refresh
   check, tests 1–8 and 12. One PR, because a partial boundary breaks
   sign-in on one surface or the other. `dc625fa` is cherry-picked in, so
   its tests flip to green in this PR.
2. **Portal roles** (§6): permission change, Roles refusal, migration,
   `RoleForm.tsx` filter, tests 9–11 and the `native-upgrade` assertion
   (15).
3. **Release**: version 0.8.1 in all 11 `package.json` files, CHANGELOG,
   release notes, CLAUDE.md decisions entry, todo updates (close the two
   auth-binding items; keep `PermissionsGuard` default-allow open), ASVS
   checklist update.

All three merge together from the advisory; tag `v0.8.1` immediately.

**Disclosure, at the moment the advisory is published** (merging makes
the diff public anyway, so publish, merge and tag together):
- **Affected:** all releases through v0.8.0. The seeded broker role has
  held `reports.broker.view` since the broker portal shipped (Phase 6);
  confirm the first release while writing the advisory.
- **Impact:** a signed-in broker portal user could read company-wide
  broker reports, including other brokers' commission figures and contact
  details and the customer-level detail of other brokers' bookings. Other
  paths existed for a portal user to obtain a session accepted by staff
  routes and portal downloads.
- **Fix and upgrade:** run `upgrade-native.sh`. Sessions re-authenticate
  silently. The migration removes non-portal permissions from portal
  roles and logs the count.
- **Detection, said plainly:** reads aren't audited, and the access token
  isn't in nginx logs, so an install can't reliably tell whether this was
  used.
- **Credit and CVE:** request a CVE through the advisory.

Until publication, commits in the fork use neutral messages and the
public CHANGELOG gets nothing.

**Out of scope, kept open:** `PermissionsGuard` default-allow (a separate
todo). After this fix it only affects same-surface routes. Separate
signing secrets per surface (§1b) are worth considering after v0.9.0
proves the boot-required-setting upgrade path.

---

## Piece 3 detail: defence in depth (plan, not implemented)

Pieces 1 (`a4715a4`) and 2 (`49e4ab9`) are committed and hold the boundary
on their own. Piece 3 makes portal roles unable to *hold* staff
permissions, so the boundary no longer rests on one layer.

### What the seeded portal roles hold today (`packages/shared/src/roles.ts`)

| Role | Permissions | Not `portal.*` |
|---|---|---|
| customer (10) | `portal.booking.read`, `portal.receipt.read`, `portal.document.read`, `portal.document.upload`, `portal.payment-schedule.read`, `portal.profile.update`, `portal.change-request.create`, `portal.ticket.create`, `portal.ticket.read`, `portal.construction-update.read` | none |
| broker (9) | `portal.booking.read`, `portal.receipt.read`, `portal.document.read`, `portal.payment-schedule.read`, `portal.profile.update`, `portal.ticket.create`, `portal.ticket.read`, `portal.noc.action`, **`reports.broker.view`** | **`reports.broker.view`** |

`reports.broker.view` is the only one. It gates six routes:
- `GET /portal/broker/dashboard` (`portal-broker-dashboard.controller.ts:17`),
  the broker's own dashboard, and the only reason the broker role holds it;
- the five staff routes in `broker-reports.controller.ts`
  (`/reports/brokers/sold-units`, `/commission-summary`, `/dues`,
  `/summary`, `/:brokerId/customer-detail`), the SF-01 leak. Piece 1
  already blocks these for portal tokens.

The portal frontend never checks permissions (`hasPermission` is defined in
`apps/portal/src/lib/auth.tsx` but no page calls it), so no portal UI
change.

### A) Broker dashboard off the staff permission

- `packages/shared/src/permissions.ts`: add
  `PORTAL_BROKER_DASHBOARD_READ: 'portal.broker.dashboard.read'`.
- `portal-broker-dashboard.controller.ts:17`: require it instead of
  `REPORTS_BROKER_VIEW`. The handler's own `brokerId` check stays.
- `roles.ts:166`: broker gets `P.PORTAL_BROKER_DASHBOARD_READ` and loses
  `P.REPORTS_BROKER_VIEW`. After this every seeded portal permission is
  `portal.*`.
- `broker-reports.controller.ts` is not touched.

**Transient on upgrade:** a broker signed in during the upgrade holds an
access token listing the old permissions, so their dashboard returns 403
until that token is refreshed (a page reload, or at most 15 minutes).
Accepting both permissions during a transition was considered and
rejected: it keeps `reports.broker.view` meaningful on the portal, which is
the thing being removed. The release notes say "brokers may need to reload
once".

### B) Roles API refuses staff permissions on portal roles

**How `isPortal` gets set on existing installs.** Only `seed.ts:50` sets
it, when it creates the company's roles (`slug === customer || broker`).
It has done so since Phase 6 commit 1, before v0.1.0, and the seed is the
only code that creates a company, so every released install's two portal
roles already have `is_portal = true`. No migration has ever backfilled
it. The migration below sets it anyway (a no-op on every real install) so
the service can rely on `isPortal` alone, with no slug fallback.

**Where the check goes.** `RolesService.update()` only, after
`findOne` (line 95) and before the transaction (line 100).
- `create()` (line 70) can't make a portal role: `createRoleSchema` has no
  `isPortal` field and `create()` never sets it, so every API-created role
  is staff. No check needed there.
- `remove()` (line 146) deletes grants for a role being deleted, and
  refuses system roles, which both portal roles are. No check needed.
- `update()`'s replace (lines 110–112) is the one path that adds grants to
  an existing role.

**The check:** if `role.isPortal`, look up the keys of `permissionIds`
(`permission.findMany({ where: { id: { in } } })`, since the API takes ids)
and refuse any key not starting with `portal.`:

> 400 `Portal roles can only hold portal permissions. Not allowed: reports.broker.view, admin.user.read`

(keys sorted, comma-separated). Check-then-write without a lock is fine:
`isPortal` can't change through the API and permission keys never change.

**Roles screen today** (`apps/web/src/pages/admin/RoleForm.tsx`): an admin
can open and edit the Customer and Broker roles like any system role: name
locked, every one of the ~142 permissions offered as a checkbox. The
screen already shows a failed save's message inline (`onSubmit` catch →
`setError`) and as a toast (`MutationCache`), so the 400 is visible without
changes. **Recommended UI change anyway, small:** when the loaded role has
`isPortal`, list only `portal.*` permissions, with one line saying portal
roles can only hold portal permissions. Otherwise the screen offers ~130
checkboxes that will all be refused. The API returns `isPortal` already
(`findOne` returns every column); only the `Role` interface needs the
field. The filter is convenience; the service is the enforcement.

**Gap found, outside A–C (needs your decision):** `PATCH /users/:id`
(`UsersService.update`, line 245) writes `roleId` straight through, with no
check. An admin can move a broker's portal user onto `company_admin` or any
custom staff role, which gives a portal account staff permissions without
touching the Roles API, so B doesn't cover it. Pieces 1 and 2 still stop
that token at every staff route. A mirror check (a portal user may only get
a portal role, a staff user only a staff role; 400 otherwise) is about ten
lines plus two HTTP tests. My recommendation: include it in piece 3 as part
D, since it's the same invariant. Otherwise log it in `docs/todo.md`.

### C) Existing installs: migration plus a counted strip

**Can a SQL migration print the count?** Not reliably. A `RAISE NOTICE`
may or may not reach `prisma migrate deploy`'s output; CLAUDE.md already
records this as unverified, and nothing here depends on it.

**Proposal: split by what has to run once versus what's an invariant.**

1. **Migration**
   `packages/db/prisma/migrations/20260927120000_portal_broker_dashboard_permission/migration.sql`
   (14-digit timestamp in the existing style, later than
   `20260924120000`; exact value picked at implementation). One-time steps
   only:
   ```sql
   -- Permission row: migrations run before sync-permissions, so it must exist here.
   INSERT INTO permissions (id, key)
     VALUES (gen_random_uuid(), 'portal.broker.dashboard.read')
     ON CONFLICT (key) DO NOTHING;
   -- No-op on every released install (seed.ts has set this since Phase 6).
   UPDATE roles SET is_portal = true
     WHERE is_system AND slug IN ('customer', 'broker') AND NOT is_portal;
   -- Brokers keep their dashboard.
   INSERT INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id FROM roles r, permissions p
     WHERE r.is_portal AND r.slug = 'broker' AND p.key = 'portal.broker.dashboard.read'
     ON CONFLICT DO NOTHING;
   ```
   `permissions.id` has no database default (Prisma generates it), hence
   `gen_random_uuid()`. The grant has to be one-time: repeated on every
   upgrade, it would restore the permission after an admin had removed it
   on purpose. It goes to every broker role, including one where an admin
   had removed `reports.broker.view` to hide the dashboard; that edge is
   accepted.

2. **The removal goes in `sync-permissions.ts`**, as a new
   `stripStaffPermissionsFromPortalRoles()` run on every upgrade after the
   migration. It deletes every `role_permissions` row on an `is_portal` role
   whose key isn't `portal.*`, including grants an admin made (approved),
   and prints each company and role affected, the keys removed, and the
   total. Any removal is printed as a bordered block like the existing skip
   block. `upgrade-native.sh` already tees this step to the terminal, so the
   count shows in the upgrade output with no script change. Exit code stays
   0: a removal isn't a failure.

   Why here and not in the migration: TypeScript can count and print, and
   the step also re-applies the invariant each upgrade (0 rows once the
   Roles API refuses new grants). This is the second narrow exception to
   "sync never touches role composition", on the same grounds as the
   super_admin one: a portal role's definition is "portal permissions
   only", so a staff grant is drift, not a customisation. The CLAUDE.md
   entry has to say so.

   Rejected alternative: have `upgrade-native.sh` count the rows with
   `psql` before `migrate deploy`. That puts the delete predicate in two
   languages that can drift apart, and leaves permanent script code for a
   one-time event.

**Fresh installs:** `seed.ts` builds roles from `ROLE_PERMISSIONS`, so
changing `roles.ts` is enough; no seed code change. Order is migrate →
seed: the migration inserts the permission row against zero roles, and
the seed's `permission.upsert` by key tolerates the existing row.

**Locking:** row-level `INSERT`/`DELETE` on `role_permissions` and one
`UPDATE` on `roles`. No `ALTER TABLE`, so no ACCESS EXCLUSIVE lock and
nothing the `lock_timeout` rule is about.

**`native-upgrade` CI** (outcome, per the standing rule): after upgrading
from the baseline, a broker portal user (created over HTTP: broker, then
invite, then consume) gets 200 on `/portal/broker/dashboard`. Also, as
super_admin, `GET /roles` shows the broker role holding only `portal.*`
keys, including the new one. The HTTP broker is the real outcome; the role
check alone would be the precondition style the rule warns against.

### Tests (each red before the change, green after)

| # | Test | Where | Red now because |
|---|---|---|---|
| 1 | `ROLE_PERMISSIONS.broker` has `portal.broker.dashboard.read`, not `reports.broker.view`; every customer and broker key starts with `portal.` | `apps/api/test/broker-reports.test.ts` (existing no-DB block) | broker holds `reports.broker.view` |
| 2 | Broker dashboard over HTTP: a broker whose role is exactly the new `ROLE_PERMISSIONS.broker` gets **200**; a broker holding `reports.broker.view` but not the new permission gets **403**; a customer gets **403** (control) | new `apps/api/test/e2e-portal-broker-dashboard-permission.test.ts` | the route still requires `reports.broker.view` (first two fail) |
| 3 | `PATCH /roles/:brokerRoleId` with a staff permission → **400**, message contains `Portal roles can only hold portal permissions` **and** names the key; the role's grants are unchanged afterwards | new `apps/api/test/e2e-roles-portal-guard.test.ts` | returns 200 and writes |
| 4 | Same endpoint with only `portal.*` → 200 (control) | same file | green now; kept |
| 5 | A staff role given staff and `portal.*` permissions → 200 (control: rule applies to portal roles only) | same file | green now; kept |
| 6 | Upgrade path: build the pre-fix state (broker role with `reports.broker.view` plus one more staff permission, customer role with one staff permission, a custom staff role with the same staff permissions), run the shipped `migration.sql` then `stripStaffPermissionsFromPortalRoles()`. Both portal roles hold only `portal.*`; broker gained the new permission, customer didn't; staff role unchanged; returned count equals the rows planted; second run removes 0 | new `packages/db/test/portal-role-permission-strip.test.ts` (shape of `backfill-is-reversed-migration.test.ts`) | migration and function don't exist |
| 7 | *(if part D is approved)* `PATCH /users/:id` giving a portal user a staff role → 400; giving a staff user a portal role → 400; staff to staff → 200 | new e2e file | writes today |
| 8 | Regression: `e2e-staff-route-sweep`, `e2e-portal-token-boundary`, `e2e-staff-side-portal-exclusion` stay green. They grant permissions with direct `systemPrisma` writes, not the Roles API, so B doesn't change their setup. | existing | green |
| 9 | Full `apps/api`, `packages/db`, `packages/shared` suites green | existing | green |

`broker-portal.test.ts:228`'s customer-overlap check should list the new
permission too (it passes either way).

### Other questions

- **Phase-4 financial core:** not touched. The files are
  `permissions.ts`, `roles.ts`, `portal-broker-dashboard.controller.ts`,
  `roles.service.ts`, `RoleForm.tsx`, `sync-permissions.ts`, one
  migration, and `users.service.ts` if D is approved. The broker report
  service is unchanged.
- **Audit rows.** B adds no write path; it refuses writes. A refused
  request writes nothing, like every other 400 in the codebase, so the
  v0.7.1 rule ("a new write path to an audited model needs an HTTP test of
  its audit row") isn't triggered. The existing grant path is unchanged:
  `RolesService.update` uses `deleteMany`/`createMany`, which still write
  no audit row. That's the open `docs/todo.md` item, not fixed here.

  The strip in C *is* a new write path. It runs as the system client in
  the upgrade script, with no request, actor or audit extension, so the
  extension-based rule doesn't apply. But it removes permissions an admin
  granted, and the terminal is the only record. **Recommendation:** write
  one explicit `audit_logs` row per affected role in that step:
  `user_id NULL`, entity `Role`, action `PORTAL_PERMS_REMOVED` (20
  characters, the `VarChar(20)` limit), `before` the removed keys, `after`
  `{ surface: 'upgrade' }`. Same pattern as `reset-admin-password.sh`'s CLI
  audit row. Test 6 asserts it if you approve. This doesn't touch the
  general createMany/deleteMany gap.
- **Playwright:** yes for the `RoleForm.tsx` filter, since it changes which
  `permissionIds` the screen can send. Extend `role-permission-edit.spec.ts`
  (staff login only, so no portal-login budget): open the Broker role, only
  `portal.*` permissions are offered, a save persists. The fixture company
  must have seeded portal roles; add them if it doesn't. It's red now
  (every permission is listed). The broker dashboard needs no new browser
  spec: its frontend request doesn't change, only the permission the server
  checks, and test 2 covers that over HTTP. A browser check of the
  dashboard would be a nice extra, not required.

### Decisions for you

1. The split in C: migration for the one-time steps, `sync-permissions`
   for the counted removal. The alternative is migration-only, with no
   printed count.
2. Part D (`PATCH /users/:id` role/surface check): now, or todo?
3. Audit rows for the upgrade strip: yes or no?
4. `RoleForm.tsx` filter: include (recommended), or rely on the API error
   only?
