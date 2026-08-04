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

Four "must" items, sequenced smallest/lowest-risk first so each ships
alone and the test harness (started alongside Release 1) has something
real to exercise before the largest, riskiest item (PLC) lands.

### v0.2.0 — Staff ticket management UI

| | |
|---|---|
| **Size** | Small (~3–4 days) |
| **Layer** | Frontend-only |
| **Why first** | Backend is already complete and already tested; zero schema risk; smallest possible slice to prove the new release rhythm and give the test harness its first real target. |

Ticket list (filter by status/category), ticket detail with reply
thread, status transitions. No new backend work.

### v0.2.1 — Layout-plan / document uploads for inventory

| | |
|---|---|
| **Size** | Small–medium (~2–3 days) |
| **Layer** | Both, but backend is thin |
| **Backend** | ~1 day — a route on the inventory controller that calls the existing `UploadService` (the category enum and storage/re-encode pipeline already exist; this is wiring, not new infrastructure) |
| **Frontend** | ~1–2 days — an upload widget on Project/Unit detail |

### v0.2.2 — PLC / unit-charge management

| | |
|---|---|
| **Size** | Large (~1 week) |
| **Layer** | Both, backend-heavy |
| **Backend** | ~3–5 days — `UnitPlc`/`UnitCharge` controller + service + DTOs, wired into the booking cost-line calculation (`BookingService` already accepts arbitrary `costLines` by `kind`, so this extends an existing mechanism rather than inventing one) |
| **Frontend** | ~2–3 days — assign PLC/charges to a unit (Project/Unit detail), surface the resulting line items in the booking wizard's cost breakdown |

Largest and most valuable item. Doing it third means the harness
(started in v0.2.0) already has login/navigation/form-submission
scaffolding in place before tackling the riskiest surface.

### v0.2.3 — Custom field VALUES

| | |
|---|---|
| **Size** | Large (~1 week) |
| **Layer** | Both |
| **Backend** | ~2–3 days — `CustomFieldValue` model + migration, one generic read/write endpoint (`entityType` + `entityId`) rather than five bespoke ones |
| **Frontend** | ~2–3 days — one reusable "dynamic fields" component (fetch definitions for an entity type, render by field type, submit alongside the parent form), then wire it into Applicant/Unit/Booking/Inquiry/Project — the component is the real cost; each wiring afterward is small |

Last of the four: touches the most existing forms (five), so it
benefits most from however much of the test harness exists by the time
it starts.

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

**Total to close every "must" item: ~3–3.5 weeks** of focused, codebase-familiar work (v0.2.0 through v0.2.3). This is a more careful, item-by-item number than the walkthrough report's original "1–2 weeks" rough estimate — that estimate undercounted the PLC and custom-field-values backend work.

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

### Proposal: a small Playwright suite against the real dev stack

Reuse what already exists rather than add a parallel mocking layer:
this project already runs a disposable test Postgres
(`scripts/test-setup.sh` / `deploy/docker-compose.test.yml`) and a
culture of real through-the-wire backend tests. The smallest useful
harness is **Playwright driving the real Vite dev servers
(`apps/web` + `apps/portal`) against that same test Postgres and the
real NestJS API, served over plain HTTP** — deliberately not HTTPS, so
it reproduces the VM's actual default and would catch a Secure-cookie
regression on the very first run. One new dependency
(`@playwright/test`); everything else is reused.

**First six scenarios, in priority order — each one maps directly to a
bug this walkthrough found:**

1. Login → submit a CSRF-protected mutation, over plain HTTP. *(Would
   have caught the Secure-cookie bug — the single worst finding.)*
2. Direct browser navigation to a portal invite-consume URL (not a
   client-side link click). *(Router `basename` bug.)*
3. Create a role, select it in the Add-User dropdown, log in as the new
   user. *(Roles-list + dropdown bare-array bugs.)*
4. Create and edit one "generic" master and one "specialized" master
   (e.g. Letter Template). *(Masters `id`-leak 400 + the 6 unreachable
   types.)*
5. Create a custom field definition. *(`fieldName`/`key` mismatch.)*
6. Starting from the Dashboard, click through booking → receipt →
   applicant ledger. *(The missing-navigation-link class of bug.)*

**Sizing:** initial setup (Playwright config, fixtures that reuse
`scripts/test-setup.sh`, a CI job modeled on the existing native-install
job) ≈ 2–3 days; each scenario ≈ 0.5–1 day once scaffolding exists. The
first six ≈ 1 week total, runnable alongside v0.2.0 rather than as a
separate blocking phase.

**Where it fits:** start it in the same cycle as v0.2.0 (ticket UI) —
write scenarios 1–5 immediately, since they're regression coverage for
fixes that already shipped this walkthrough. Add scenario 6 and one new
scenario per subsequent release as new UI lands, rather than attempting
to backfill full coverage in one pass.

**Honest limit:** this harness catches regressions and shape/logic bugs
in things that already exist. It would not have caught "Inventory has
zero UI" or "no button anywhere sends a portal invite" — those are
missing-feature gaps, not defects in built code, and no test suite
substitutes for the kind of deliberate, module-by-module walkthrough
this report is built from. Keep both: the harness prevents regressions
in what's built; a walkthrough like this one is still the right tool
for finding what was never built at all.
