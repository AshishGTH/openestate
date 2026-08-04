# Prioritised Release Plan

Planning only — no code in this document. Derived from
`docs/vm-walkthrough-final-report.md` and `docs/todo.md`.

## Confirming the must-ship list

Your read is correct, with one addition:

- **PLC / unit-charge management** — confirmed no API exists at all
  (`UnitPlc`/`UnitCharge` are Prisma models with no controller). This is
  the biggest gap: real Indian residential pricing routinely needs
  floor-rise, corner, park-facing charges.
- **Layout-plan uploads** — confirmed backend-partial: the generic
  `UploadService` already whitelists `layout_plan` as a category, but no
  inventory route calls it. Smaller than it looks.
- **Custom field VALUES** — confirmed zero implementation beyond the
  (now-working) admin definition CRUD. No `CustomFieldValue` model, no
  API, no form renders a definition.
- **Staff ticket replies** — confirmed backend-complete
  (`admin-ticket.controller.ts`), zero frontend.
- **Addition: the `apps/web`/`apps/portal` test-harness gap** (your item
  3) belongs in this same "must" tier, not as a nice-to-have parked for
  later. It's not a shippable feature, so it doesn't get its own release
  number, but it should start in the same work cycle as Release 1 below
  — seeded in the reasoning at the end of this document.

Nothing else from the consolidated report needs to move into "must."
The rest (access-control UX, GSTIN checksum, extra master columns,
Redis-backed throttling, Applicant PAN encryption, escalation routing)
are all real but narrow — none blocks a stranger from running a project,
each is independently fixable later.

## Release sequence

**Revised per explicit direction: the test harness ships first, standalone,
before any feature release — not in parallel with v0.2.0. Feature work
resumes only once it's wired into CI.** Within the feature releases, PLC
moves to first place ahead of the three other "must" items.

### v0.2.0-pre — Playwright test harness (blocks all feature work below)

See "The `apps/web` test-harness gap" section for the full design. Three
scenarios, each mapped to a bug already found and fixed:

1. Login → forced password change → 2FA enrollment → logout → login with
   a TOTP code. *(CSRF cookie, `tempToken`, force-change bugs.)*
2. Create a master with type-specific optional fields → edit it →
   deactivate it. *(The `.strict()` PATCH 400 + the six unreachable
   master types.)*
3. Book a unit → record a cheque receipt → bounce it → assert the
   Collection Summary total is unchanged from before the receipt was
   ever entered. *(The `isReversed` bug — the one with actual financial
   consequence, not just a broken screen.)*

Wired into CI as its own job. Nothing in v0.2.0 onward starts until this
is green and merged.

### v0.2.0 — PLC / unit-charge management (moved first)

| | |
|---|---|
| **Size** | Large (~1 week) |
| **Layer** | Both, backend-heavy |
| **Backend** | ~3–5 days — `UnitPlc`/`UnitCharge` controller + service + DTOs, wired into the booking cost-line calculation (`BookingService` already accepts arbitrary `costLines` by `kind`, so this extends an existing mechanism rather than inventing one) |
| **Frontend** | ~2–3 days — assign PLC/charges to a unit (Project/Unit detail), surface the resulting line items in the booking wizard's cost breakdown |

**Why this now leads, not v0.2.2:** the sequencing was originally
smallest-risk-first, optimizing for a smooth rollout of the release
rhythm itself. That's the wrong axis. The real question is what actually
blocks a builder from using the product — and of the four "must" items,
PLC is the only one with no workaround. A developer running a real
Indian residential project cannot price a unit correctly without
floor-rise/corner/park-facing charges; there is no manual fallback for a
number that has to appear on the booking and every downstream document.
Ticket UI, layout uploads, and custom field values are all real gaps,
but each has a workaround a builder can live with meanwhile: field
support over email/phone instead of the in-app ticket UI, skipping
uploaded layout PDFs, using whatever custom fields already exist instead
of the ones the admin wanted to add. PLC has no such fallback, so it
goes first — the harness (built in v0.2.0-pre) already has scenario 3's
booking → receipt flow scaffolded by the time this starts, which this
item's own tests can extend directly.

### v0.2.1 — Staff ticket management UI

| | |
|---|---|
| **Size** | Small (~3–4 days) |
| **Layer** | Frontend-only |
| **Why here** | Backend is already complete and already tested; zero schema risk; smallest remaining item, and a real workaround (email/phone) exists in the meantime, so it doesn't need to precede PLC. |

Ticket list (filter by status/category), ticket detail with reply
thread, status transitions. No new backend work.

### v0.2.2 — Layout-plan / document uploads for inventory

| | |
|---|---|
| **Size** | Small–medium (~2–3 days) |
| **Layer** | Both, but backend is thin |
| **Backend** | ~1 day — a route on the inventory controller that calls the existing `UploadService` (the category enum and storage/re-encode pipeline already exist; this is wiring, not new infrastructure) |
| **Frontend** | ~1–2 days — an upload widget on Project/Unit detail |

### v0.2.3 — Custom field VALUES

| | |
|---|---|
| **Size** | Large (~1 week) |
| **Layer** | Both |
| **Backend** | ~2–3 days — `CustomFieldValue` model + migration, one generic read/write endpoint (`entityType` + `entityId`) rather than five bespoke ones |
| **Frontend** | ~2–3 days — one reusable "dynamic fields" component (fetch definitions for an entity type, render by field type, submit alongside the parent form), then wire it into Applicant/Unit/Booking/Inquiry/Project — the component is the real cost; each wiring afterward is small |

Last of the four: touches the most existing forms (five), so it
benefits most from however much the harness has grown by the time it
starts (see "Where it fits" below — each release is expected to add its
own scenario).

### v0.3.0 — Hardening batch (independent, any order, any subset)

None of these block real usage; bundle as convenient or ship
individually as each is finished.

| Item | Size | Layer |
|---|---|---|
| `<RequirePermission>` route guard (access-denied instead of empty-looking page) | ~1 day | Frontend-only |
| GSTIN checksum digit verification | ~0.5 day | Backend-only |
| Expose `AreaLocation`/`Bank`/`ChargeType`'s existing optional columns via the master API | ~2 days | Both |
| Redis-backed `ThrottlerStorage` | ~1–2 days | Backend/infra-only |
| Retrofit `PanEncryptionService` to `Applicant.pan*` | ~1.5 days | Both, frontend is one field |
| Escalation: route to the owning project's manager, not every company manager | ~2.5 days | Both, frontend is one admin field |

**Total: ~1 week for the harness (v0.2.0-pre) + ~3–3.5 weeks for the four
feature releases (v0.2.0 through v0.2.3), run sequentially, not in
parallel** — roughly a month of focused, codebase-familiar work end to
end. The feature-release estimate is unchanged from the original
per-item sizing; only the harness now sits in front of it as a
precondition instead of overlapping the first release.

## The `apps/web` test-harness gap

### The finding

Of the 19 bugs fixed this walkthrough, the large majority were frontend
defects invisible to every existing test, because `apps/web` and
`apps/portal` have zero test files between them. Two of the worst —
the Secure-cookie-over-HTTP bug and the portal router `basename` bug —
are not just untested, they are **structurally uncatchable** by the kind
of test suite most projects reach for first.

### Why component tests are the wrong first layer here

The instinct is usually "add React Testing Library + mocked `fetch`."
That would catch some of this session's bugs (request-body construction
errors like the Masters `id`-leak 400, or the invented Bank fields) —
but a mock is written by the same person who wrote the bug, so it tends
to encode the same wrong assumption. Concretely, it would **not** have
caught:

- **The Secure-cookie bug** — this is real browser cookie-storage
  behavior over a real HTTP connection. No mock can reproduce "the
  browser silently refused to store this cookie."
- **The portal router `basename` bug** — only reproduces on a fresh
  full-page navigation to a deep link served by nginx's `/portal/`
  alias. A component test renders the router in-memory and never makes
  a real navigation; it can't see this class of bug.
- **The Roles-list / role-dropdown bare-array-vs-`{data,meta}` bugs** —
  a component test's mock would need to already know the real backend
  shape to catch this; if the test author's mental model of the shape
  was wrong (which is exactly what happened), the mock just inherits
  the same wrong assumption.
- **The missing-navigation-link bugs** (`Applicant360` unreachable) —
  a component test renders the target page directly, so it can never
  reveal that nothing links to it. Only a test that starts at the
  Dashboard and clicks through like a real user would surface this.

### Built: a small Playwright suite against the real dev stack

Reuse what already exists rather than add a parallel mocking layer:
this project already runs a disposable test Postgres
(`scripts/test-setup.sh` / `deploy/docker-compose.test.yml`) and a
culture of real through-the-wire backend tests. The harness is
**Playwright driving the real `apps/web` Vite dev server against that
same test Postgres and the real NestJS API, served over plain HTTP** —
deliberately not HTTPS, so it reproduces the VM's actual default and
catches a Secure-cookie regression on the very first run. One new
dependency (`@playwright/test`, plus `otpauth` for generating valid TOTP
codes in the test itself — already a dependency of `apps/api`, reused
at the same version rather than a second implementation); everything
else is reused, including a small fixture-seed script modeled directly
on `packages/db/prisma/seed.ts` and
`apps/api/test/helpers/postsales-harness.ts`.

**Shipped first, exactly three scenarios — each maps directly to a bug
this walkthrough found, chosen for reach over breadth:**

1. Login → forced password change → 2FA enrollment → logout → login
   with a TOTP code. *(Covers the CSRF cookie, `tempToken`, and
   force-change bugs — including the Secure-cookie bug, the single worst
   finding, since it's the only thing in this list a mocked test could
   never reproduce.)*
2. Create a master with type-specific optional fields → edit it →
   deactivate it. *(The `.strict()` PATCH 400 bug + the six previously
   unreachable master types.)*
3. Book a unit → record a cheque receipt → bounce it → assert Collection
   Summary is unchanged from before the receipt existed. *(The
   `isReversed` bug — this walkthrough's one finding with direct
   financial consequence, not just a broken screen.)*

**Deliberately deferred from the original six-scenario proposal** (the
portal deep-link/router-basename check, the Roles-list/dropdown check,
the standalone custom-field-definition check, the dashboard-to-ledger
click-through): still real, still worth adding, just not required to
unblock feature work resuming. Add one per subsequent release as new UI
ships — v0.2.0 (PLC) is a natural place to extend scenario 3 with a
PLC-priced unit, for instance — rather than trying to backfill full
coverage in one pass.

**Sizing:** initial setup (Playwright config, the fixture-seed script,
a CI job modeled on the existing `integration-tests` job) ≈ 2–3 days;
each of the three scenarios ≈ 0.5–1.5 days (scenario 3 is the most
involved — it drives the booking wizard, receipt entry, and the cheque
queue in sequence). ≈ 1 week total, entirely before v0.2.0 starts.

**Honest limit:** this harness catches regressions and shape/logic bugs
in things that already exist. It would not have caught "Inventory has
zero UI" or "no button anywhere sends a portal invite" — those are
missing-feature gaps, not defects in built code, and no test suite
substitutes for the kind of deliberate, module-by-module walkthrough
this report is built from. Keep both: the harness prevents regressions
in what's built; a walkthrough like this one is still the right tool
for finding what was never built at all.
