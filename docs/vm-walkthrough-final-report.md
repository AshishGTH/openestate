# Systematic VM Admin Walkthrough — Final Report

Eleven modules walked start-to-finish in a real browser against the live VM
(10.10.10.46, native systemd+nginx install, no Docker): Setup/Auth, Company,
Masters, Custom Fields, Roles & Users, Inventory, Pre-Sales, Post-Sales,
Brokers, Portals, Reports. Every fix below was redeployed to the VM and
re-verified live before moving to the next module — see CLAUDE.md's Decisions
log for the full narrative on each. This report consolidates the findings.

## Headline finding

Every prior "VM verified" claim in this project's history used `curl`/`wget`,
which does not enforce browser cookie rules. The VM's cookies were marked
`Secure` over plain HTTP — silently never stored by any real browser — so
**no browser mutation had ever succeeded on the VM before this walkthrough**,
regardless of how many times the API had been curl-tested. That single gap
is why ~20 bugs, several of them "this button has never worked, ever,"
survived undetected across many prior sessions. This is now CLAUDE.md's
primary standing rule: a feature isn't done until a human has run it in a
real browser.

## Issues found, by severity

### Critical — blocked entire flows, security, or financial correctness

| # | Module | Issue | Status |
|---|--------|-------|--------|
| 1 | Setup/Auth | `Secure` cookies set over plain HTTP — CSRF and refresh cookies silently never stored by any real browser; no staff or portal mutation could ever succeed, no session survived a reload | **Fixed** — `secure` now keyed off `req.secure` via trusted proxy, not `NODE_ENV` |
| 2 | Setup/Auth | Forced first-login password change never enforced — built, dead, never wired; any new user could skip it forever | **Fixed** — flag added to JWT, `ProtectedRoute` blocks until changed |
| 3 | Roles & Users | Roles list always rendered zero rows (bare-array endpoint read as `{data,meta}`); Add-User role dropdown had the same bug — a role could never be assigned to a user through the UI | **Fixed** |
| 4 | Masters | Every master edit, of any type, ever submitted, 400'd (`id` leaking into a `.strict()` PATCH body) | **Fixed** |
| 5 | Masters | 6 of 17 master types (Document Types, Interest Rules, Transfer Fee Rules, GST Rates, TDS Rules, Letter Templates) had no working create path — 3 had no Add button at all | **Fixed** |
| 6 | Custom Fields | Admin page could never create a field, ever (`fieldName` vs schema's `key`) | **Fixed** |
| 7 | Inventory + Pre-Sales | **Zero frontend UI existed for either module, for any role** — a company could never log an inquiry or set up a project's units through the real product, despite both backends being complete | **Fixed** — minimal UI built for both, per explicit user decision to build rather than defer |
| 8 | Portals | Portal SPA's router had no `basename` — every direct-loaded portal URL (including every invite link ever sent) blank-paged with "No routes matched" | **Fixed** |
| 9 | Reports | Bounced cheques stayed counted as collected money in every collection report, every rollup, and the customer's own portal payment history — a real financial-correctness bug, not a display glitch | **Fixed**, with a companion fix to the Cheque Queue's BOUNCED tab to avoid regressing it |

### High — a whole feature path had no entry point, or crashed

| # | Module | Issue | Status |
|---|--------|-------|--------|
| 10 | Roles & Users | Role-creation regex rejected hyphens despite the UI's own hint text promising them | **Fixed** |
| 11 | Inventory | `ProjectDetail.tsx` crashed on load (`.map()` on a `{data,meta}` wrapper) | **Fixed** |
| 12 | Pre-Sales | Inquiries list never refreshed after creating an inquiry (missing cache invalidation) | **Fixed** |
| 13 | Brokers | Broker statement PDF download stuck — client built an unsanitized filename with a raw space instead of using the server's name | **Fixed** |
| 14 | Post-Sales | `Applicant360` (the applicant ledger view) had no navigation path from anywhere in the app | **Fixed** — added a "View ledger" link |
| 15 | Brokers | No UI existed to attach a sourcing broker to a booking or to accrue commission — the entire commission lifecycle had no entry point | **Fixed** |
| 16 | Post-Sales + Brokers | No UI existed anywhere to send a portal invite to an applicant or broker — portal accounts were uncreatable through the real product | **Fixed** |

### Medium

| # | Module | Issue | Status |
|---|--------|-------|--------|
| 17 | Company | Config page had no field for the company's own name (separate `PATCH /company` endpoint, never wired) | **Fixed** |
| 18 | Masters | Bank fields (`branch`/`ifsc`/`accountNumber`) were invented from dead code that didn't match the real Prisma model | **Fixed** — dead schema deleted |
| 19 | Post-Sales | Applicant-search label promised phone/booking-number search; the endpoint only searches name/phone/email | **Fixed** — label corrected |

### Low / deferred (logged, not built)

| # | Module | Issue | Status |
|---|--------|-------|--------|
| 20 | Roles & Users | A low-permission user hitting an admin URL directly sees the page shell instead of an access-denied state (backend correctly 403s; no data leak) | **Deferred** — needs a `<RequirePermission>` route wrapper |
| 21 | Portals | Staff-side support-ticket management (view/reply) has a complete backend and zero frontend | **Deferred** — explicit scope decision, same size class as the Inventory/Pre-Sales gap |
| 22 | Portals | "Maintenance" ticket category simply never seeded | **Fixed trivially** via the Masters UI (data gap, not a bug) |
| 23 | *(pre-existing, docs/todo.md)* | GSTIN checksum digit not verified (format regex only) | **Deferred** |
| 24 | *(pre-existing, docs/todo.md)* | `AreaLocation`/`Bank`/`ChargeType` real optional columns never exposed by the generic master API | **Deferred** |
| 25 | *(pre-existing, docs/todo.md)* | Rate-limit storage is in-memory only, not Redis-backed (single-instance limitation) | **Deferred** |
| 26 | *(pre-existing, docs/todo.md)* | `Applicant.pan*` encryption fields wired for Broker, never retrofitted to Applicant | **Deferred** |
| 27 | *(pre-existing, docs/todo.md)* | Escalations notify every company manager, not the owning project's manager (no project→manager mapping) | **Deferred** |
| — | Brokers/Portals/Reports | Stuck `*.crdownload` file downloads observed repeatedly | **Not a product bug** — server-side 200 confirmed via network log each time; isolated to the browser-automation harness |

**Fixed this walkthrough: 19. Deferred/logged: 8.**

## Backend functionality with NO frontend at all

- **PLC / unit-charge management** — `UnitPlc`/`UnitCharge` are Prisma models with **no controller at all**. This isn't a missing-UI gap, it's a missing-API gap; nothing to wire a form to yet.
- **Layout-plan / brochure / photo uploads for inventory** — the generic `UploadService` exists and already whitelists `layout_plan` as a category, but no inventory route ever calls it. Backend primitive exists; the inventory-specific wiring doesn't.
- **Custom field VALUES** — the admin CRUD for *defining* a custom field works (fixed this walkthrough), but there is no `CustomFieldValue` model, no per-entity read/write API, and none of the Applicant/Unit/Booking/Inquiry/Project forms fetch or render definitions. Defining a field today has zero effect anywhere else in the product.
- **Staff-side support ticket management** — `admin-ticket.controller.ts` is a complete backend; zero frontend (item #21 above).

## Honest estimate: what's left for a stranger to install this and run a real project

**Install path itself is solid.** `deploy/native/install-native.sh` +
`upgrade-native.sh` have been exercised end-to-end many times this session
(20 real deploys) plus a dedicated CI job; the systemd+nginx recipe works.
A stranger following `README.md`/`deploy/native/` could stand up the app.

**What would break their first real project, in rough priority order:**

1. **PLC charges and layout-plan uploads are unbuildable** — no API for
   the first, no route for the second. A real Indian real-estate project
   without PLC (floor-rise/view charges) is unusual; this is a multi-day
   backend+frontend build (schema is already there for PLC; the upload
   wiring is smaller).
2. **Custom fields are a dead end** — an admin can define one, save it,
   and it will never appear again. Either finish it (`CustomFieldValue`
   table + 5 forms) or hide the admin page until it's real, so it stops
   silently wasting a real admin's time.
3. **No ticket-reply UI** — a customer can raise a support ticket through
   the portal and no staff member can ever answer it through the product.
4. **No component/unit test harness in `apps/web`** (zero test files) —
   every frontend bug this walkthrough found (roughly 12 of the 19 fixed
   issues) was a frontend-only defect that a real browser click-through
   caught and nothing else would have. Without that harness, regressions
   in `apps/web`/`apps/portal` will keep depending on manual walkthroughs
   like this one to surface.
5. **Access-control UX gap** (#20) and the several smaller deferred items
   (GSTIN checksum, AreaLocation/Bank/ChargeType columns, Redis-backed
   rate limiting, Applicant PAN encryption) are all real but narrow —
   each is a contained, single-area fix, not a blocker to running a
   project.

**Bottom line:** the core sales funnel — inquiry → inventory → booking →
receipts → broker commission → portal access → reports — now works
end-to-end through the real UI, verified live on the VM, which it did not
at the start of this walkthrough. A company could run a real project on
this today **if** that project doesn't need PLC/view charges, doesn't need
to attach layout plans in-app, and staff are willing to handle support
requests outside the ticket UI (email/phone) for now. Closing items 1–3
above is realistically **1–2 weeks** of focused work for someone who knows
this codebase; item 4 (a real frontend test harness) is the one piece of
debt that will keep costing a full manual walkthrough's worth of time on
every future frontend change until it exists.
