# OpenEstate UI/UX audit — inventory and test plan

**Note, 2026-09-29 — read before running this plan.** SF-01, this plan's
own top finding (a portal session reading staff-only broker reports), was
fixed and released in v0.8.1. Section 1.3 step 7 (the SF-01 check) is now
a check that the fix holds, not a search for an open vulnerability. The
plan was written against v0.7.1 (labelled build `155b6e5`); its account
and role sections (§0, §1.5, §5) were written before that fix and should
be re-checked against the current build before running.

Status: **plan for approval. Nothing has been run against the VM yet.**
Target: `http://192.168.1.20`. The VM runs `155b6e5`. Between `155b6e5` and
the master I read (`5072d54`), application code is identical: only version
strings in `package.json` files and one e2e spec changed
(`git diff --stat 155b6e5 5072d54 -- apps packages`). So this static
inventory describes what the VM serves. `/api/v1/health` reports `0.7.1`;
that is a known label issue, not a finding.

Part 1 (inventory) was built by reading the source, with small throwaway
extraction scripts kept outside the repo: a route table from every
`@Controller`/`@Get|Post|...`/`@RequirePermissions` in `apps/api/src`,
matched against every API path literal in `apps/web/src` and
`apps/portal/src`. Every "no caller" item below was then checked by hand
with grep, because URLs built from template variables (e.g.
`` `/admin/plugins/${id}/${enabled ? 'disable' : 'enable'}` ``) defeat a
literal match. Anything I couldn't settle statically is marked
**UNCLEAR**, to be settled in the browser.

---

## Part 1 — Inventory

### 1a. Screens and who can reach them

**What "master" means here:** there's no "master" role. "Master" means a
**master-data table**: an admin-configured lookup list (sources, stages,
GST rates, etc.) that CLAUDE.md principle 3 says replaces hard-coded
business constants. They're managed under Admin → Masters
(`apps/web/src/pages/admin/Masters.tsx`), Admin → Letter Templates and
Admin → Lead Stages, behind the `admin.master.*` permissions. Company-wide
settings are a different thing: `CompanyConfig`, Admin → Company Config.

**Staff app** (`apps/web/src/App.tsx`): 35 routes. Client-side gating is
`RequirePermission` (`apps/web/src/components/RequirePermission.tsx`), and
the nav hides the same links (`apps/web/src/components/AppShell.tsx:29-80`).
`ProtectedRoute` (`apps/web/src/components/ProtectedRoute.tsx`) forces a
password change first when `forcePasswordChange` is set.

| Route | Page file | Gate permission |
|---|---|---|
| `/login`, `/reset-password` | `pages/Login.tsx`, `pages/ResetPassword.tsx` | public |
| `/` | `pages/Dashboard.tsx` | any signed-in user |
| `/settings` | `pages/Settings.tsx` | any signed-in user |
| `/admin/users`, `/admin/users/:id`, `/admin/hierarchy` | `admin/Users.tsx`, `admin/UserForm.tsx`, `admin/Hierarchy.tsx` | `admin.user.read` |
| `/admin/roles`, `/admin/roles/:id` | `admin/Roles.tsx`, `admin/RoleForm.tsx` | `admin.role.read` |
| `/admin/masters`, `/admin/letter-templates`, `/admin/lead-stages` | `admin/Masters.tsx`, `admin/LetterTemplates.tsx`, `admin/LeadStages.tsx` | `admin.master.read` |
| `/admin/custom-fields` | `admin/CustomFields.tsx` | `admin.custom-field.read` |
| `/admin/config` | `admin/CompanyConfig.tsx` | `admin.config.read` |
| `/admin/audit` | `admin/AuditLog.tsx` | `admin.audit.read` |
| `/admin/plugins`, `/admin/plugins/:pluginId` | `admin/Plugins.tsx`, `admin/PluginDetail.tsx` | `admin.plugin.read` |
| `/admin/webhooks` | `admin/Webhooks.tsx` | `admin.webhook.read` |
| `/admin/lead-api-keys` | `admin/LeadApiKeys.tsx` | `admin.lead-api-key.read` |
| `/postsales/bookings/new` | `postsales/BookingWizard.tsx` | `postsales.booking.create` |
| `/postsales/bookings/:bookingId/installments` | `postsales/InstallmentSchedule.tsx` | `postsales.booking.read` |
| `/postsales/receipts/new` | `postsales/ReceiptEntry.tsx` | `postsales.receipt.create` |
| `/postsales/cheques` | `postsales/ChequeQueue.tsx` | `postsales.cheque.verify` |
| `/postsales/dues` | `postsales/DuesDashboard.tsx` | `reports.outstanding.view` |
| `/postsales/applicants/:applicantId` | `postsales/Applicant360.tsx` | `presales.applicant.read` |
| `/postsales/reports` | `postsales/Reports.tsx` | `reports.collection.view` |
| `/postsales/brokers`, `/postsales/brokers/:brokerId` | `postsales/Brokers.tsx`, `postsales/BrokerDetail.tsx` | `admin.broker.read` |
| `/inventory/projects`, `/inventory/projects/:id` | `inventory/Projects.tsx`, `inventory/ProjectDetail.tsx` | `inventory.project.read` |
| `/presales/inquiries`, `/presales/inquiries/:id` | `presales/Inquiries.tsx`, `presales/InquiryDetail.tsx` | `presales.inquiry.read` |
| `/presales/reports` | `presales/Reports.tsx` | `presales.report.view` |
| `/support/tickets`, `/support/tickets/:id` | `support/Tickets.tsx`, `support/TicketDetail.tsx` | `admin.ticket.respond` |

Paths in the page column are under `apps/web/src/pages/`.

Which system role reaches which screen follows from
`packages/shared/src/roles.ts`; the full matrix is in 1e. Summary:
super_admin and company_admin reach everything. sales_manager reaches
presales, inventory (read), booking create/installments, Applicant 360,
postsales reports, brokers (read), users/hierarchy (read), masters (read)
and tickets. sales_executive reaches presales inquiries and reports,
inventory (read) and masters (read). accounts reaches receipts, cheque
queue, dues, postsales reports, installments and masters (read).

**Portal** (`apps/portal/src/App.tsx`, basename `/portal`): 15 routes.
Public: `/login`, `/forgot-password`, `/reset-password`,
`/invite/:inviteId`. Signed in: `/` (redirects by session type),
`/profile`, `/property`, `/account`, `/tickets`, `/tickets/:id`,
`/security` (customer); `/broker/dashboard`, `/broker/nocs`,
`/broker/statement`, `/security` (broker). **No client-side gating by
session type**: the tab bar branches on `user.brokerId`
(`apps/portal/src/components/AppShell.tsx:41`), but the routes themselves
render for either kind of session.

### 1b. Actions per screen and the endpoints they call

The full machine-extracted screen → endpoint map, with the permission each
endpoint requires, is **Appendix A**. It was generated from source, so
treat it as a checklist, not proof: an endpoint listed against a screen
means the literal appears in that file.

**Counts:** 320 route handlers are declared in `apps/api/src`. The generic
master factory (`apps/api/src/masters/master.factory.ts:223-259`, 5
handlers) serves 20 tables, so there are about 415 concrete endpoints.
Frontend callers are in 53 files.

**Backend endpoints with no frontend caller.** Each was checked by grep
after the automated match; false positives are removed. None is by design
except the first group.

- *Intentionally UI-less:* `GET /health`, `POST /leads/inbound` (machine
  API), and `POST /portal/auth/refresh` (called inside
  `apps/portal/src/lib/api.ts:25` with an absolute URL).
- *Auth:* `POST /auth/logout-all` and `POST /portal/auth/logout-all`. There
  is no "sign out everywhere" button (`auth.controller.ts:206`,
  `portal-auth.controller.ts:190`).
- *Presales:*
  - `PATCH /applicants/:id`: applicants can't be edited
    (`presales/applicant.controller.ts:69`).
  - Consent: `GET/POST /applicants/:id/consent`, `GET .../consent/current`
    (`:77-93`). There is no DPDP consent-capture UI.
  - `GET /applicants/:id/communications` and
    `POST /applicants/:applicantId/communications`
    (`applicant.controller.ts:111`, `communication.controller.ts:17`).
  - `GET /applicants/:id/duplicates` and
    `POST /applicants/:survivorId/merge/:mergedId` (`:154`, `:179`).
  - `GET /projects/:projectId/assignment-pool` and
    `PUT .../assignment-pool/:userId`
    (`presales/assignment-pool.controller.ts:17,25`). The round-robin pool
    can't be managed from the UI.
  - `PATCH /inquiries/:inquiryId/follow-ups/:id`: follow-ups can't be edited
    (`follow-up.controller.ts:58`).
- *Inventory:*
  - `POST /projects/:projectId/units/:id/transition`: no hold/block/release
    (`inventory/unit.controller.ts:126`).
  - `POST .../units/floors/:floorId` (single unit create) and
    `PATCH .../units/:id` (unit edit) (`:78`, `:102`).
  - Tower `GET/PATCH/DELETE /projects/:projectId/towers/:id`
    (`tower.controller.ts:46,70,83`).
  - `GET .../inventory-groups/:id` and `PATCH /inventory-groups/:id`
    (`inventory-group.controller.ts:38,54`).
  - `DELETE /projects/:id` (`project.controller.ts:74`; already in todo).
- *Postsales:*
  - Booking lifecycle: `POST /bookings/:id/allot`, `/register`,
    `/plan/edit`, `GET /bookings/:id/plan`, `POST /bookings/:id/extra-charge`,
    `/interest/accrue`, `/interest/waive`, `/transfer`, `/noc/request`
    (`postsales/booking.controller.ts:84-188`; NOC request is already in
    todo).
  - Receipts: `POST /receipts/:id/reverse`, `/receipts/:id/reprint`,
    `/receipts/tds/:tdsDeductionId/certificate`
    (`receipt.controller.ts:76-92`), and
    `POST /receipts/:receiptId/pdf/reprint` (`pdf/document.controller.ts:33`).
  - Refunds: all four endpoints (`postsales/refund.controller.ts:18-42`).
  - Booking drafts: `booking-draft.controller.ts:17-49`. `BookingWizard.tsx`
    calls only `GET /booking-drafts` and `PATCH /booking-drafts/:id`, so
    create, get-one and delete have no caller. **UNCLEAR** whether a draft
    can ever come into being from the UI.
  - Dispatch: all four endpoints (`dispatch/dispatch.controller.ts:17-41`).
  - Document lists: `GET /bookings/:bookingId/documents`,
    `/applicants/:applicantId/documents` and `/brokers/:brokerId/documents`
    (`pdf/document.controller.ts:113-129`). Applicant 360 gets its documents
    through its own aggregate endpoint instead.
- *Brokers and commission:*
  - `PATCH /brokers/:id`: brokers can't be edited
    (`brokers/broker.controller.ts:50`).
  - `PATCH` and deactivate on commission rules
    (`broker-commission-rule.controller.ts:34,42`).
  - `POST /commission-payments/:id/reject`
    (`commission/commission-payment.controller.ts:38`).
  - Staff NOC: `POST /nocs/:id/approve`, `/reject`,
    `GET /nocs/booking/:bookingId` (`brokers/noc.controller.ts:17-33`;
    already in todo).
  - Broker reports: `GET /reports/brokers/commission-summary`, `/dues`,
    `/summary`, `/:brokerId/customer-detail`
    (`reports/broker-reports.controller.ts:44-77`).
- *Portal support:*
  - `GET /admin/change-requests` and `POST .../:id/approve|reject`
    (`customer-portal/admin-change-request.controller.ts:17-34`).
    **Customers can submit profile change requests** (portal `Profile.tsx:77`)
    **but no staff screen shows or approves them.**
- *Admin:*
  - Webhooks: `GET/PUT /admin/webhook-endpoints/:id`, so an endpoint can't
    be edited (`webhooks/webhook-endpoint.controller.ts:30,46`).
  - Webhook deliveries: `GET /admin/webhook-deliveries/:id/attempts`,
    `POST .../:id/retry`, `POST /admin/webhook-deliveries/retry`
    (`webhook-delivery.controller.ts:25-41`).
  - `GET /custom-fields/:id` (harmless; the list endpoint covers it).
  - `GET /company/terminology` (`company/company.controller.ts:54`). See
    finding SF-05.

**UI controls that call nothing, or an endpoint that doesn't exist:** none
found statically. Every API literal in both frontends resolves to a real
route; the 35 unmatched literals were all nav/route links, the Masters
page's dynamic `` `/masters/${type}` `` (which resolves for every
registered table), or the dynamic document-generation path. Controls that
*do* call a real endpoint but can fail for a role are covered in SF-02 and
SF-19.

### 1c. Master data and company configuration

**Master tables (25).**
- 20 run through the generic factory (`apps/api/src/masters/masters.module.ts:11-104`):
  unit-types, plc-types, inquiry-sources, dump-reasons, inquiry-types,
  inquiry-temperatures, follow-up-types, communication-types,
  project-types, receipt-types, registration-types, area-locations,
  document-types, banks, charge-types, interest-rules, transfer-fee-rules,
  payment-plan-templates and ticket-categories.
- 5 are specialised modules: gst-rates, tds-rules, sms-templates,
  letter-templates and lead-stages.
- Masters.tsx lists 23 of the 25. Lead stages have their own page.
  **SMS Templates have no page anywhere** (`Masters.tsx:40-90`).

**Other admin-configured entities:** users and manager hierarchy, roles,
custom fields, brokers with their bank details and commission rules,
projects/towers/inventory groups/units with PLCs and charges, plugins,
webhooks, lead API keys.

**CompanyConfig** (`packages/db/prisma/schema.prisma`, `model CompanyConfig`)
has 17 settable columns plus company `name`. The API accepts 14 of them
(`packages/shared/src/company.dto.ts:18-59`), and the UI edits 12
(`apps/web/src/pages/admin/CompanyConfig.tsx`).

### 1d. Where each setting and master is read

WIRED = changing it changes behaviour · DISPLAY-ONLY = saved and shown,
nothing else reads it · PARTIAL = read in some places it should affect but
not others · UNCLEAR = settle in the browser.

**Company config**

| Setting | Class | Evidence / what changes |
|---|---|---|
| `name` | WIRED | Printed on every PDF (`apps/api/src/pdf/document.service.ts:124,173,285,330`) |
| `companyGstin` | PARTIAL | Only feeds the "GST incomplete" banner (`AppShell.tsx:127`) and the boot warning (`company.service.ts:45-51`). Not printed on any PDF (no `gstin` in `apps/api/src/pdf/`) |
| `gstStateCode` | WIRED | CGST/SGST vs IGST split (`booking.service.ts:70`, `extra-charge.service.ts:25`); a missing value blocks bookings |
| `fyStartMonth` | WIRED | Booking, receipt and transfer number FY labels (`booking.service.ts:60`, `receipt.service.ts:77`, `transfer.service.ts:60`). Reports don't read it; UNCLEAR whether any report should |
| `labelOverrides` (terminology) | DISPLAY-ONLY | Only reader is `CompanyService.getTerminology` (`company.service.ts:155-158`), served by `GET /company/terminology`, which nothing calls. No UI label changes |
| `enabledModules` | DISPLAY-ONLY | Nothing reads it to enable or disable any module. Written only by the config form and the plugin install (`plugin-admin.service.ts:158`) |
| `currency` | DISPLAY-ONLY | No reader; `formatInr` is hard-coded (`packages/shared/src/money.ts:23`) |
| `timezone` | DISPLAY-ONLY | No reader in `apps/api/src` or either frontend |
| `dateFormat` | DISPLAY-ONLY | No reader |
| `logoUrl`, `primaryColorHex` | WIRED (portal only) | `portal-branding.controller.ts:29-31` → `apps/portal/src/components/AppShell.tsx:40-48`. The staff app ignores them |
| `projectMediaMaxFiles` / `MaxBytes` | WIRED | `apps/api/src/inventory/project-media-limits.ts:23-24` |
| `presalesCreatorRetainsLead` | WIRED, but no UI | `inquiry.service.ts:276`; absent from `CompanyConfig.tsx`, so it can only be set through the API |
| `presalesPhoneDedupAutoLink` | WIRED, but no UI | `inquiry.service.ts:346`, `inquiry-import.service.ts:139`; same, API only |
| `chequeBounceChargePaise` | WIRED, but unsettable | `receipt.service.ts:282`, `refund.service.ts:137`. Absent from `updateCompanyConfigSchema`, so it stays at the default 0 |
| `commissionAccrualTrigger` | WIRED, but unsettable | `commission.service.ts:38`; not in the DTO |
| `commissionClawbackPolicy` | WIRED, but unsettable | `commission.service.ts:210`; not in the DTO |

**Masters**

| Master | Class | Evidence |
|---|---|---|
| Area Locations | WIRED | `stateCode` → place of supply → GST split (`project.service.ts`, `booking.service.ts`) |
| GST Rates | WIRED | `booking.service.ts`, `extra-charge.service.ts`; picked in `BookingWizard.tsx` |
| TDS Rules | WIRED | 194-IA on receipts (`receipt.service.ts`), 194-H on commission (`commission-payment.service.ts`) |
| Charge Types | WIRED | `unit-pricing.service.ts`, GST fallback in `booking.service.ts` |
| Unit Types, PLC Types | WIRED | `unit.service.ts`, `unit-pricing.service.ts`; dropdowns in `ProjectDetail.tsx` |
| Payment Plan Templates | WIRED | `payment-plan.service.ts`; `BookingWizard.tsx` |
| Lead Stages | WIRED | `lead-stage-transition.service.ts`, `inquiry.service.ts`, reports |
| Dump Reasons | WIRED | `inquiry-disposition-transition.service.ts`; `InquiryDetail.tsx` |
| Inquiry Sources | WIRED | `inquiry.service.ts`, import, reports; `Inquiries.tsx` |
| Follow-Up Types | WIRED | `FollowUp.typeId` (schema); `InquiryDetail.tsx`; site visit = a follow-up of type "Site Visit" |
| Letter Templates | WIRED | `document.service.ts`; `Applicant360.tsx`. The page has no edit or delete (already in todo) |
| Ticket Categories | WIRED | `ticket.service.ts`; portal `Tickets.tsx:31` |
| Banks | WIRED (reference) | Stored on receipts, refunds and commission payments; `ReceiptEntry.tsx` |
| Project Types | DISPLAY-ONLY | Stored on the project and shown in its form; no backend logic reads `projectTypeId` |
| Inquiry Temperatures | UNCLEAR | Stored (`inquiry.service.ts`); check whether any filter or report uses it |
| Inquiry Types | PARTIAL | Read by import and reports (`inquiry-import.service.ts`, `reports.service.ts`), but not offered on the Add Inquiry form (no `/masters/inquiry-types` caller outside Masters.tsx) |
| Receipt Types | PARTIAL | Receipt DTO accepts `receiptTypeId` (`receipt.service.ts:159`), but `ReceiptEntry.tsx` never sends it |
| Interest Rules | PARTIAL, dead in practice | `interest.service.ts:75` accrues only when `booking.interestRuleId` is set. **Nothing sets it**: the only write is the copy on transfer (`transfer.service.ts:116`). See SF-03 |
| Transfer Fee Rules | PARTIAL | Read by `transfer.service.ts`, but the transfer endpoint has no UI |
| Registration Types | DISPLAY-ONLY | Its only reference is the model and relation (`schema.prisma:35,493`) |
| Communication Types | DISPLAY-ONLY | No reader. `CommunicationLog.channel` is an enum, and presales reports use FollowUpType explicitly (`presales/reports.service.ts:932`) |
| Document Types | DISPLAY-ONLY | `entityType` "not read by any business logic" (its own comment, `masters.module.ts:51-53`) |
| SMS Templates | DISPLAY-ONLY, unreachable | No UI page; referenced only by its own service |

`Project.isActive` is DISPLAY-ONLY; that's already in todo.

### 1e. Roles and permissions

**Roles (7, `packages/shared/src/roles.ts`):** super_admin (all
permissions), company_admin (`admin.*`, `inventory.*`, `presales.*`,
`postsales.*`, `accounts.*`, `reports.*`), sales_manager, sales_executive,
accounts, customer (portal), broker (portal). Admins can create custom
roles in Admin → Roles.

**Permissions:** 147 constants (`packages/shared/src/permissions.ts`).
**28 are checked by no route**, so granting them does nothing, yet the
Roles picker lists all of them:

- `inventory.unit.book`, `.block`, `.allot`, `.register`, `.cancel`, `.release`
- `presales.inquiry.delete`
- `presales.site-visit.read`, `.create`, `.update`
- `postsales.booking.update`
- `postsales.unit.read`, `.update`
- `postsales.demand.read`
- `postsales.tds.read`
- `postsales.transfer.read`, `.approve`
- `postsales.document.read`, `.upload`, `.delete`
- `accounts.receipt.verify`, `accounts.payment.read`, `.create`
- `reports.gst.view`, `reports.custom.create`
- `portal.booking.read`, `portal.receipt.read`, `portal.document.upload`

The four document permissions are already in todo.

**How enforcement works:**
- Global guard order (`apps/api/src/app.module.ts:174-182`): throttler →
  `JwtAuthGuard` → `TwoFactorPendingGuard` → `CsrfGuard` → `PermissionsGuard`.
- `PermissionsGuard` (`apps/api/src/auth/guards/permissions.guard.ts`)
  returns `true` for any route with no `@RequirePermissions`.
- `JwtStrategy.validate` (`apps/api/src/auth/strategies/jwt.strategy.ts`)
  accepts any token signed with the shared secret. It doesn't check which
  surface (staff or portal) the token came from.

**Routes default-allow leaves open (17), all needing a valid token:**
- Staff: `GET /auth/me`, `POST /auth/totp/setup|confirm|disable`,
  `/auth/logout`, `/auth/logout-all`, `/auth/change-password`,
  `/auth/force-change-password`
  (`auth.controller.ts:137-243`).
- Portal: `GET /portal/auth/me`, `POST /portal/auth/totp/setup|confirm|disable`,
  `/logout`, `/logout-all`, `/change-password`
  (`portal-auth.controller.ts:131-199`).
- Also: `GET /company/terminology` (`company.controller.ts:54`) and
  `GET /portal/branding` (`portal-branding.controller.ts:23`).

All of these act on the caller's own account, or return non-sensitive
labels and branding. None returns business data. The todo counted 19; the
difference is the two `totp/verify` routes, which now carry
`@RequirePermissions(TWO_FACTOR_PENDING_PERMISSION)`. **The real exposure
isn't default-allow; it's SF-01.**

---

## Preliminary static findings

These are **suspected**; each is to be confirmed or refuted in the browser
(or with the same token the browser holds). Severity is provisional.

| # | Sev. | Finding | Evidence | In todo? |
|---|---|---|---|---|
| SF-01 | **Critical** | A **broker portal session can read staff-only, company-wide broker reports**: every broker's commission accrued/paid/outstanding (`/reports/brokers/commission-summary`, `/dues`, `/summary`), any broker's customer list (`/reports/brokers/:brokerId/customer-detail`), and sold units for all brokers (`/sold-units`). The seeded `broker` role holds `reports.broker.view` (`roles.ts`, broker list), which is exactly what those staff routes require (`reports/broker-reports.controller.ts:33-77`). The service uses the RLS-bypassing client (`broker-reports.service.ts:24`), and nothing rejects a portal token on a staff route (`jwt.strategy.ts`). No test covers it. | cited | No. The todo's "staff and portal auth aren't bound" entry covers `totp/verify` only |
| SF-02 | High | **Sales roles can't load custom-field definitions.** `CustomFieldInputs.tsx:25` calls `GET /custom-fields`, which requires `admin.custom-field.read` (`custom-fields.controller.ts:35-36`), held only by company_admin and super_admin. So on Add Inquiry, Inquiry Detail and the project forms, sales_manager and sales_executive see no custom fields; a **required** applicant/inquiry field would make every inquiry they create fail validation, with no field to fill in. | cited | No |
| SF-03 | High | **Interest Rules have no effect.** `Booking.interestRuleId` is written nowhere except the transfer copy (`transfer.service.ts:116`), and `interest.service.ts:75` returns 0 when it's null, so delay interest never accrues on a booking made through the UI. | cited | No |
| SF-04 | High | **Customer profile change requests go nowhere.** The portal submits them (`apps/portal/src/pages/Profile.tsx:77`), but `admin-change-request.controller.ts` has no staff UI caller. | cited | No |
| SF-05 | Medium | Terminology (`labelOverrides`) is DISPLAY-ONLY: nothing calls `/company/terminology`. CLAUDE.md principle 5 ("configurable terminology") isn't delivered in the UI. | 1d | No |
| SF-06 | Medium | `enabledModules` is DISPLAY-ONLY: turning off "postsales" hides nothing. | 1d | No |
| SF-07 | Medium | `chequeBounceChargePaise`, `commissionAccrualTrigger` and `commissionClawbackPolicy` can't be set by API or UI, so the bounce charge is stuck at ₹0. | `company.dto.ts:18-59` | No |
| SF-08 | Low | `presalesCreatorRetainsLead` and `presalesPhoneDedupAutoLink` have no UI control. | `CompanyConfig.tsx` | No |
| SF-09 | Low | `currency`, `timezone` and `dateFormat` are DISPLAY-ONLY. | 1d | No |
| SF-10 | Medium | The project RERA number isn't on letters or the portal (CLAUDE.md India-first rule). `companyAddress` merge field is always `''` (`document.service.ts:285`). The GSTIN isn't printed on any PDF. | 1d | Address partly in CLAUDE.md; RERA and GSTIN no |
| SF-11 | Medium | No UI to hold, block or release a unit. `inventory.unit.hold` is granted to sales roles but reachable only through the API. | `unit.controller.ts:126` | No |
| SF-12 | Medium | Postsales lifecycle has backend but no UI: allot, register, plan edit, extra charge, interest accrue/waive, transfer, refunds, receipt reverse/reprint, TDS certificate, dispatch. | 1b list | NOC request only |
| SF-13 | Medium | Presales has backend but no UI: applicant edit, duplicate merge, DPDP consent capture, communications send/log, follow-up edit, **assignment-pool management**. UNCLEAR whether an empty pool leaves inbound-API/import leads unassigned. | 1b list | No |
| SF-14 | Low | Admin edits missing: webhook edit and delivery retry, broker edit, commission-rule edit/deactivate, commission-payment reject, tower edit/delete, single unit create/edit, and no "sign out everywhere". | 1b list | Project delete and letter-template edit only |
| SF-15 | Low | Masters that do nothing: Registration Types, Communication Types, Document Types, SMS Templates (no page) and Project Types. PARTIAL: Receipt Types, Inquiry Types, Transfer Fee Rules. | 1d | No |
| SF-16 | Low | 28 permissions are checked by no route but offered in the Roles picker (1e). | `permissions.ts` | 4 of 28 |
| SF-17 | Low / UX | Portal routes aren't gated by session type: a customer can open `/portal/broker/dashboard`, whose API answers 400 "Not a broker portal session". Check what renders. | `apps/portal/src/App.tsx` | No |
| SF-18 | UNCLEAR | `Inquiries.tsx:104`, `InquiryDetail.tsx:106` and `presales/Reports.tsx:65` call `GET /users`, which needs `admin.user.read`; sales_executive doesn't hold it. Check whether filters and dropdowns silently go empty or show an error. | cited | No |
| SF-19 | Low | `Project.isActive` is DISPLAY-ONLY; no project delete. | todo | Yes |

---

## Part 2 — Test plan

### 0. Preconditions (owner, before anything runs)

1. **Backup.** `deploy/native/backup-native.sh` exists (with
   `restore-native.sh`), but it needs root on the VM. The audit's rules
   forbid SSH for me, so **the owner runs it before the audit starts**.
   There's no backup/restore through the web UI or API. This matters
   because much of what the audit creates **can't be removed** afterwards:
   ledger rows are append-only (DB trigger), there's no project delete in
   the UI, and bookings are cancelled, not deleted. Without a backup, the
   UIAUDIT- data stays on the VM for good.
2. **Accounts.** Per the rules I operate under, I don't create accounts
   or type passwords on a non-local host (192.168.1.20 isn't localhost).
   The owner therefore:
   - creates the accounts in the staff UI (list in §5);
   - signs in to each once through a helper script
     (`apps/e2e/audit/login-helper.ts`, headed browser). The owner types
     the password and 2FA code; the script saves only the resulting
     cookie session (Playwright `storageState`) to the local file in §5.
   - My audit scripts load those saved sessions and never see or type a
     password. Staff refresh cookies last 7 days and portal ones 24 hours,
     so the portal logins are redone on the day of the portal journey.
3. **Journeys that need a password typed** are marked **[OWNER]** below:
   forced password change, password reset confirm, invite consume,
   change password, 2FA enrol and verify, and any login-screen check. I
   drive up to the password field, the owner types, and I verify what
   happens after.
4. Approving this plan counts as approval for the audit's form
   submissions **with fake UIAUDIT- data only**, on this VM only. Anything
   irreversible beyond that (e.g. cancelling a non-UIAUDIT booking) I'll
   ask about first.

### 1. Journey tests

Each step: *action → expected outcome*. After each journey, check the
audit log (1.6). Note every console error and every failed network
request as I go.

#### 1.1 Lead lifecycle

1. As sales_executive A, on Inquiries → Add Inquiry, create
   `UIAUDIT-Lead-01` with a new applicant, a fake phone and email, source,
   temperature and project → 201. The lead appears in A's list, assigned
   to A (`presalesCreatorRetainsLead`=true), in the default stage.
   **Custom fields show on the form (SF-02).**
2. Create a second inquiry with the same phone → the duplicate warning
   banner appears, naming the existing applicant.
3. As sales_manager M, download the import template, fill 3 rows
   (UIAUDIT- names, one duplicate phone, one row with a bad project name),
   and upload → a per-row result shows 2 created (1 linked to the existing
   applicant) and 1 error, with the error text naming the bad field. The
   new leads are assigned round-robin; check who gets them and whether the
   pool is empty (SF-13).
4. Inbound lead API: as company_admin, create a lead API key
   `UIAUDIT-Key` with a field mapping, then send one signed request from
   the audit script → 201 with inquiryId/applicantId. The lead is visible
   in the list and assigned (or not: record which).
   - Include an Aadhaar-like value in a mapped note → it's redacted (1.7).
   - Disable the key, send again → 401.
5. Reassign `UIAUDIT-Lead-01` from A to B as M → B sees it and A doesn't
   (team scope). A reassign attempt by A is refused, or the control is
   hidden.
6. Move the lead through every active stage in order, via the stage
   picker → each change persists after reload, and stage history shows
   each move.
7. Dispose: mark DUMPED with a dump reason and remarks → the status
   changes; with no dump reason it's refused, and the message says so.
   Then use a second lead for SUCCESSFUL.
8. Follow-ups:
   - Log a phone-call follow-up with a next-action date → it appears
     attributed to the author, and OPEN changes to CONTINUED.
   - Log a Site Visit (type "Site Visit", with scheduled date and venue)
     → it appears with the venue.
   - Try to edit a follow-up → no UI (SF-13; record it).
9. Notes: record where free-text notes live (follow-up notes, remarks).
10. Search and filter the inquiry list by stage, source, assignee, date
    and text → the results match. Empty filter result → a sensible empty
    state.
11. Team scope: executive D, outside M's tree, can't see A's lead. Open
    the URL directly (`/presales/inquiries/<id>`) → 404/403 handled
    cleanly, no data shown.
12. Presales reports: open each report in `reportCatalogue.ts` as M and
    as A → numbers include the UIAUDIT leads, and A sees only their own.
    Export and print are hidden or refused for A.

#### 1.2 Booking

1. As company_admin, create project `UIAUDIT-Proj-HR` (high-rise, area
   location with state code), a tower, and bulk-generate 6 units. Add a
   PLC and a charge on one unit. Also a LAND_BASED project
   `UIAUDIT-Proj-Plot` with a group and 2 plots.
2. Unit hold/block → confirm there's no UI (SF-11).
3. From a SUCCESSFUL lead, as M: New Booking → pick the unit (it shows
   AVAILABLE), primary applicant plus co-applicant, base GST rate, payment
   plan (template, and a second booking with a custom plan), and a broker
   → confirm. Expected:
   - booking number `BKG/<FY>/…`;
   - the unit shows BOOKED;
   - the cost breakup matches the PLC and charge;
   - the installment schedule sums to the agreed price;
   - IGST vs CGST/SGST is right for the state codes.
4. Receipts, as accounts:
   - cash receipt → a receipt PDF downloads, the installment is PART_PAID
     or PAID, and the receipt number follows FY numbering;
   - cheque receipt → it appears in the Cheque Queue; clear one, bounce
     another;
   - after the bounce, the ledger reverses, collection reports drop by the
     amount, and the bounce charge is ₹0 (SF-07).
5. Applicant 360: the ledger and balance match Dues; generate a
   statement, an allotment letter, and demand/reminder letters with a
   UIAUDIT letter template → the PDFs contain no raw `{{token}}`, and
   look for RERA, GSTIN and address (SF-10).
6. Broker: accrue commission → request → approve → pay; try reject (no
   UI, SF-14).
7. Cancellation: cancel the broker-sourced booking → blocked until the
   NOC is approved (NOC request has no UI, a known gap; record, don't work
   around). Cancel a booking with no broker → the balance goes to
   −refundable and the unit returns to AVAILABLE.
8. Allot, register, transfer, refund and extra charge → confirm there's
   no UI (SF-12).
9. Interest: confirm there's no way to attach an interest rule (SF-03).
10. Dues Dashboard and postsales reports reflect all of the above.

#### 1.3 Customer portal

1. As company_admin, Applicant 360 → Send Portal Invite → a link is
   shown with a Copy button → **[OWNER]** open it in a fresh context and
   set a password → it lands on `/portal/profile`.
2. Profile, Property, Account and Support tabs show the UIAUDIT booking:
   unit, cost breakup, payment plan, receipts and the bounced receipt's
   treatment. Only statement, receipt and demand-letter documents are
   listed, and they download.
3. Submit a profile change request → it succeeds in the portal; confirm
   no staff screen shows it (SF-04).
4. Raise ticket `UIAUDIT-Ticket` → as M, Support → Tickets → reply →
   the customer sees the reply.
5. Forgot password: on the portal → a request message appears (it
   doesn't reveal whether the account exists). The token only reaches the
   server log (known), so use the admin-issued portal reset link instead
   → **[OWNER]** sets the password → sign-in works, the old password
   fails, and the link is single-use.
6. The broker portal: invite a UIAUDIT broker → dashboard figures match
   staff BrokerDetail; NOC approve/reject; statement PDF.
7. SF-01 check: with the broker's own session, request
   `/api/v1/reports/brokers/commission-summary` → **expected 403**; a 200
   with other brokers' data is **Critical**.
8. SF-17: the customer session opens `/portal/broker/dashboard` and vice
   versa → record what renders.
9. At 375 px width: no horizontal scroll, tabs usable.

#### 1.4 Master and config

For each setting: record the original value → change it → check the
effect where 1d says it should appear → restore the original → check the
restore persisted.

| Setting | Change | Where to look |
|---|---|---|
| Company name | `UIAUDIT-Co` | A newly generated PDF header |
| Terminology `unit` → `UIAUDIT-Plot` | save | Nav, forms, portal (expected: nothing changes, SF-05) |
| Enabled modules: untick postsales | save | Postsales nav (SF-06) |
| Currency / timezone / date format | change | Any money or date display (SF-09) |
| FY start month | 1 | The next receipt number's FY label, then restore |
| GSTIN / state code | clear the state code | Banner appears, booking refused with a clear message; restore |
| Logo / accent colour | UIAUDIT values | Portal header |
| Media caps | files = 1 | A second project media upload is refused with a clear message |

Each master: create `UIAUDIT-<master>` → it appears in the dropdown that
1d names → edit → deactivate → it disappears from new-record dropdowns
while existing records keep it. Delete where offered (the native
`confirm()` is handled with a Playwright `dialog` handler). The masters
marked DISPLAY-ONLY get a create/edit check plus a note that nothing
consumes them.

Lead stages: add a stage, reorder it, deactivate an occupied stage
(reassignment dialog), try to deactivate the default (refused with its
message).

Custom fields: see 1.7 and SF-02.

#### 1.5 Roles

For each account in §5, walk every nav section and try the direct URL of
every screen in 1a.
- **CAN**: the screens and actions `roles.ts` grants work end to end.
- **CANNOT**: forbidden screens show "Access denied", and forbidden
  actions are hidden. For each forbidden write I also send **one** request
  with that role's own session (the same token the browser uses) to prove
  the backend refuses it with 403. **A forbidden action succeeding is
  Critical.**

Specific cases:
- sales_executive: assign, import, export reports, bookings.
- accounts: presales.
- sales_manager: admin writes.
- Custom narrow role (`UIAUDIT-Role-Narrow`, 3 permissions): everything
  else.
- Portal customer and broker tokens against a sample of staff endpoints
  (SF-01).
- Role edit: company_admin granting a permission it holds, plus the known
  self-grant gap (todo) — observe only.

#### 1.6 Audit

After each journey: Admin → Audit Log, filtered to the journey's time
window.
- Every create/update/delete from the journey appears, with the right
  actor name and a non-empty IP (the LAN IP of this machine, as nginx
  sees it).
- Also check the auth/2FA/reset rows from [OWNER] steps.
- Known and not re-reported: UPDATE rows have before = null; `*Many`
  writes and role-permission edits have no row; non-CREATE/UPDATE actions
  show in red.
- Any **missing row for a single-record write** is a finding.

#### 1.7 Aadhaar guard

Rules as in the header of this plan: the synthetic value is generated in
memory, never printed, and never put in a filename. In the report it is
only ever "a synthetic Verhoeff-valid 12-digit value".

1. Field name: create custom fields keyed or labelled `aadhaar`,
   `Aadhar no`, `आधार`, and `adhaar` as a whole word → each refused, with
   the documented message text. `Dharavi` and `UIAUDIT-UID` → allowed.
2. Value: on a TEXT custom field, enter the synthetic value plain, spaced
   4-4-4 and hyphenated 4-4-4 → each refused with the Aadhaar message,
   nothing saved. The same value with its check digit altered → accepted.
3. Exemption: on a field with "allows twelve-digit values" → the
   synthetic value is accepted, and the inline warning and list badge
   show. Trying to exempt a field named after Aadhaar → refused.
4. Masked display: after the exempt save, detail views show only the last
   four digits masked form; CSV export is masked.
5. CSV import and inbound API: a note containing the value → stored as
   `[Aadhaar-like number removed]`, and the lead is still created.
6. No request, response body, console line or screenshot the audit keeps
   may contain the value. Screenshots of steps 2–4 are taken only after
   the value is out of the input, or skipped.

#### 1.8 General UX (throughout, and a final sweep)

- Empty states on every list: a message, not a blank table or crash.
- Validation: submit each form empty and with bad formats (phone, email,
  GSTIN, PAN, pincode, state code, hex colour). Record the **exact
  message text**; "Validation failed" or a raw field path counts as a
  finding.
- Loading and error: throttle the network (Playwright route delay) on
  3 pages. Make a mutation fail (bad data) → a toast with a useful
  message.
- Mobile: 375×812 for every staff and portal screen. Record horizontal
  overflow (`scrollWidth > innerWidth`) and unusable controls.
- Broken links: crawl every nav link and every in-page link; record
  non-200 responses and SPA "not found" states.
- Console: record every `console.error` and every failed request per
  page.
- Slow pages: record time to network idle per page; flag anything over
  3 s on the LAN.

### 2. Recording findings

One entry per finding in `docs/testing/ui-audit-report.md` (written
during execution, on the audit branch). Fields:
- ID (`UA-###`); severity (Critical / High / Medium / Low / UX-polish);
  area; role and session used;
- steps to reproduce (numbered);
- expected vs actual, with the actual message text quoted;
- screenshot path, under `apps/e2e/audit/artifacts/<ID>-<slug>.png`.
  Screenshots are git-ignored and never show a password field's value or
  an Aadhaar-like value;
- suspected cause with `file:line`;
- suggested fix, one or two lines, **not implemented**;
- whether it's already in `docs/todo.md` (quote the heading), or a
  confirmed SF-##.

Severity guide:
- Critical: data exposure across users, companies or portal/staff; a
  forbidden write succeeds; money is wrong.
- High: a core journey is blocked, or data is lost.
- Medium: a feature is missing or wrong but has a workaround.
- Low: a minor defect.
- UX-polish: wording, layout.

### 3. Test data rules

- Every name, title, code and subject starts with `UIAUDIT-` (codes:
  `UIAUDIT01`… where a format forbids hyphens; these are listed in the
  report).
- Phones: `+91 9000000xxx` style numbers from a reserved-looking block,
  e.g. `9000000101`. Emails: `uiaudit+<n>@example.invalid` (`.invalid` is
  reserved and can never deliver).
- PAN, where a form demands one: a format-valid fake like `AAAPZ9999Z`,
  listed in the report.
- No real names, addresses or IDs. No Aadhaar-format digits anywhere
  (see 1.7).
- Money: small round amounts (₹1,00,000 units, ₹10,000 receipts) so
  arithmetic is easy to check.

### 4. VM clock check (no SSH)

Before any time-dependent step (2FA, receipts, FY numbering, interest,
audit timestamps, reports by date):

1. Check this machine's own clock against a trusted source: `Date` header
   of `https://www.google.com`, compared with local `Date.now()`.
2. Compare the VM's clock: the `Date` header from nginx on
   `http://192.168.1.20/api/v1/health`, against the corrected local time.
3. Tolerance: 10 s. More than that → stop and report it. TOTP allows only
   about ±30 s, and the VM has a history of losing a week on suspend
   (`docs/handoff.md`).

Repeat at the start of each session and before any [OWNER] 2FA step.

### 5. Accounts and credentials

Account names (the owner creates them; passwords are never written
anywhere I read, and never in git):

| Account | Role | Purpose |
|---|---|---|
| `uiaudit-admin` | company_admin | Setup, config, masters |
| `uiaudit-super` | super_admin (or the existing demo super admin) | Admin-only checks |
| `uiaudit-mgr` | sales_manager | Manager of the two execs below |
| `uiaudit-exec-a`, `uiaudit-exec-b` | sales_executive | Report to `uiaudit-mgr` |
| `uiaudit-exec-d` | sales_executive | No manager (team-scope negative) |
| `uiaudit-accounts` | accounts | Receipts, cheques, commission |
| `uiaudit-narrow` | custom `UIAUDIT-Role-Narrow` | 3 permissions only |
| Portal customer | customer | Invited from a UIAUDIT applicant |
| Portal broker | broker | Invited from a UIAUDIT broker |
| One 2FA-enabled staff account | any | Only if 2FA journeys are in scope |

Where sessions live:
- `C:\Users\Ashis\.openestate-uiaudit\` (outside the repo), set via env
  var `UIAUDIT_STATE_DIR`.
- It holds only the Playwright `storageState` JSON per account (cookies),
  written by the owner-run login helper.
- If the owner prefers scripted logins instead, a `credentials.json` in
  the same folder, read only by the helper, never logged, and never
  passed to any trace.
- Playwright **tracing and video are off** for the audit config, because
  traces record typed text.

### 6. Where the audit scripts live

- `apps/e2e/audit/`: specs, the login helper, and `artifacts/`
  (git-ignored).
- `apps/e2e/playwright.audit.config.ts`: its own config, with
  `testDir: './audit'` and base URL from `UIAUDIT_BASE_URL`.
- The config **refuses to run** if `CI` is set or `UIAUDIT_BASE_URL` is
  missing.
- CI runs `npx playwright test` with the default config
  (`.github/workflows/ci.yml:404`, `testDir: './tests'`), so the audit
  never runs in CI.
- This reuses the Playwright already installed in `apps/e2e`: no new
  package and no new dependency.
- Branch `test/ui-audit` with a PR, kept as a reusable suite as you
  prefer. The PR carries the scripts and the report, no app changes.
- Runs are sequential, one worker, because the VM has 2 cores and serves
  real use. Not run while any build or test suite is running on this
  machine.

### 7. Backup and restore

- `deploy/native/backup-native.sh` and `restore-native.sh` exist (a
  `pg_dump` via `DATABASE_URL_SYSTEM` plus files, into
  `/var/backups/openestate/`).
- Both need root on the VM, so the owner runs them.
- There's no backup through the web UI or API.
- Recommendation: owner runs a backup immediately before the audit, and
  decides afterwards whether to restore it (which wipes the UIAUDIT data
  and anything else created in between).

### What I could not determine statically

- Whether `sync-permissions` has already given the VM's roles the
  permissions `roles.ts` lists. Custom edits on the VM would change 1.5's
  expectations. I'll read each role in Admin → Roles first.
- Whether an empty round-robin pool leaves imported and inbound leads
  unassigned (SF-13), and what the round-robin actually does on the VM.
- Whether booking drafts can ever be created from the UI.
- Inquiry Temperatures: whether any filter or report reads them.
- What each role's UI does on a 403 from a shared lookup (SF-18).
- Which accounts, companies and data already exist on the VM, and whether
  a second company exists for a cross-tenant check. There's no UI to
  create a company, so if there's no second company that check is
  skipped and said so.
- Per-screen action lists in Appendix A are machine-extracted; a
  multi-line call built from variables could be missing. The browser
  walk is the real check.

---

## Appendix A — Screen → endpoint map (machine-extracted)

Format: `VERB path [required permission]`. `NONE` = no decorator
(default-allow); `PUBLIC` = `@Public()`.

**portal/src/lib/auth.tsx**
- POST /portal/auth/login [PUBLIC]
- POST /portal/auth/logout [NONE]
- POST /portal/auth/totp/verify [TWO_FACTOR_PENDING_PERMISSION] (portal-auth.controller.ts:111)

**portal/src/lib/branding.ts**
- GET /portal/branding [NONE]

**portal/src/pages/Account.tsx**
- GET /portal/account [PORTAL_PAYMENT_SCHEDULE_READ]
- GET /portal/account/documents [PORTAL_DOCUMENT_READ]
- GET /portal/account/documents/:id/download [PORTAL_DOCUMENT_READ]

**portal/src/pages/BrokerDashboard.tsx**
- GET /portal/broker/dashboard [REPORTS_BROKER_VIEW]

**portal/src/pages/BrokerNocs.tsx**
- GET /portal/broker/nocs [PORTAL_NOC_ACTION]
- POST /portal/broker/nocs/:id/approve [PORTAL_NOC_ACTION]
- POST /portal/broker/nocs/:id/reject [PORTAL_NOC_ACTION]

**portal/src/pages/BrokerStatement.tsx**
- GET /portal/broker/documents [PORTAL_DOCUMENT_READ]
- GET /portal/broker/documents/:id/download [PORTAL_DOCUMENT_READ]

**portal/src/pages/ForgotPassword.tsx**
- POST /portal/auth/password-reset/request [PUBLIC]

**portal/src/pages/InviteConsume.tsx**
- POST /portal/auth/invite/:inviteId/consume [PUBLIC]

**portal/src/pages/Profile.tsx**
- GET /portal/profile [PORTAL_PROFILE_UPDATE]
- POST /portal/profile/change-requests [PORTAL_CHANGE_REQUEST_CREATE]

**portal/src/pages/Property.tsx**
- GET /portal/property [PORTAL_CONSTRUCTION_UPDATE_READ]
- GET /portal/property/construction-media/:mediaId/download [PORTAL_CONSTRUCTION_UPDATE_READ]
- GET /portal/property/media/:mediaId/download [PORTAL_CONSTRUCTION_UPDATE_READ]

**portal/src/pages/ResetPassword.tsx**
- POST /portal/auth/password-reset/confirm [PUBLIC]

**portal/src/pages/Security.tsx**
- GET /portal/auth/me [NONE]
- POST /portal/auth/change-password [NONE]
- POST /portal/auth/totp/confirm [NONE]
- POST /portal/auth/totp/disable [NONE]
- POST /portal/auth/totp/setup [NONE]

**portal/src/pages/TicketDetail.tsx**
- GET /portal/tickets/:id [PORTAL_TICKET_READ]
- POST /portal/tickets/:id/messages [PORTAL_TICKET_CREATE]

**portal/src/pages/Tickets.tsx**
- GET /portal/tickets [PORTAL_TICKET_READ]
- GET /portal/tickets/:id [PORTAL_TICKET_READ]
- GET /portal/tickets/categories [PORTAL_TICKET_CREATE]
- POST /portal/tickets [PORTAL_TICKET_CREATE]

**web/src/components/AppShell.tsx**
- GET /admin/lead-api-keys [ADMIN_LEAD_API_KEY_READ]
- GET /admin/plugins [ADMIN_PLUGIN_READ]
- GET /company/config [ADMIN_CONFIG_READ]
- GET /reports/postsales/zero-gst-bookings-count [REPORTS_SALES_VIEW]

**web/src/components/CustomFieldInputs.tsx**
- GET /custom-fields [ADMIN_CUSTOM_FIELD_READ]

**web/src/components/PortalTwoFactorReset.tsx**
- POST /admin/portal-2fa-resets [ADMIN_USER_UPDATE]

**web/src/lib/auth.tsx**
- POST /auth/login [PUBLIC]
- POST /auth/logout [NONE]
- POST /auth/refresh [PUBLIC]
- POST /auth/totp/verify [TWO_FACTOR_PENDING_PERMISSION]

**web/src/pages/Dashboard.tsx**
- GET /dashboard [PRESALES_INQUIRY_READ]
- GET /inquiries/:id [PRESALES_INQUIRY_READ]
- GET /inquiries/my-day [PRESALES_INQUIRY_READ]

**web/src/pages/ForceChangePassword.tsx**
- POST /auth/force-change-password [NONE]

**web/src/pages/ResetPassword.tsx**
- POST /auth/password-reset/confirm [PUBLIC]

**web/src/pages/Settings.tsx**
- GET /auth/me [NONE]
- POST /auth/change-password [NONE]
- POST /auth/totp/confirm [NONE]
- POST /auth/totp/disable [NONE]
- POST /auth/totp/setup [NONE]

**web/src/pages/admin/AuditLog.tsx**
- GET /audit [ADMIN_AUDIT_READ]

**web/src/pages/admin/CompanyConfig.tsx**
- GET /company [ADMIN_COMPANY_READ]
- GET /company/config [ADMIN_CONFIG_READ]
- PATCH /company [ADMIN_COMPANY_UPDATE]
- PATCH /company/config [ADMIN_CONFIG_UPDATE]

**web/src/pages/admin/CustomFields.tsx**
- DELETE /custom-fields/:id [ADMIN_CUSTOM_FIELD_DELETE]
- GET /custom-fields [ADMIN_CUSTOM_FIELD_READ]
- GET /custom-fields/:id/value-count [ADMIN_CUSTOM_FIELD_READ]
- PATCH /custom-fields/:id [ADMIN_CUSTOM_FIELD_UPDATE]
- POST /custom-fields [ADMIN_CUSTOM_FIELD_CREATE]
- POST /custom-fields/:id/purge [ADMIN_CUSTOM_FIELD_DELETE]

**web/src/pages/admin/Hierarchy.tsx**
- GET /users/:id [ADMIN_USER_READ]
- GET /users/hierarchy [ADMIN_USER_READ]

**web/src/pages/admin/LeadApiKeys.tsx**
- DELETE /admin/lead-api-keys/:id [ADMIN_LEAD_API_KEY_MANAGE]
- GET /admin/lead-api-keys [ADMIN_LEAD_API_KEY_READ]
- POST /admin/lead-api-keys [ADMIN_LEAD_API_KEY_MANAGE]
- POST /admin/lead-api-keys/:id/disable [ADMIN_LEAD_API_KEY_MANAGE]

**web/src/pages/admin/LeadStages.tsx**
- GET /masters/lead-stages [ADMIN_MASTER_READ]
- GET /masters/lead-stages/:id/occupancy [ADMIN_MASTER_READ]
- PATCH /masters/lead-stages/:id [ADMIN_MASTER_UPDATE]
- POST /masters/lead-stages [ADMIN_MASTER_CREATE]

**web/src/pages/admin/LetterTemplates.tsx**
- POST /masters/letter-templates [ADMIN_MASTER_CREATE]

**web/src/pages/admin/Masters.tsx**
- GET /masters/gst-rates [ADMIN_MASTER_READ]

**web/src/pages/admin/PluginDetail.tsx**
- GET /admin/plugins [ADMIN_PLUGIN_READ]
- GET /admin/plugins/:pluginId [ADMIN_PLUGIN_READ]
- PUT /admin/plugins/:pluginId/config [ADMIN_PLUGIN_MANAGE]

**web/src/pages/admin/Plugins.tsx**
- DELETE /admin/plugins/:pluginId [ADMIN_PLUGIN_MANAGE]
- GET /admin/plugins [ADMIN_PLUGIN_READ]
- GET /admin/plugins/:pluginId [ADMIN_PLUGIN_READ]
- POST /admin/plugins/:pluginId/install [ADMIN_PLUGIN_MANAGE]

**web/src/pages/admin/RoleForm.tsx**
- GET /roles/:id [ADMIN_ROLE_READ]
- GET /roles/permissions [ADMIN_ROLE_READ]
- PATCH /roles/:id [ADMIN_ROLE_UPDATE]
- POST /roles [ADMIN_ROLE_CREATE]

**web/src/pages/admin/Roles.tsx**
- DELETE /roles/:id [ADMIN_ROLE_DELETE]
- GET /roles [ADMIN_ROLE_READ]

**web/src/pages/admin/UserForm.tsx**
- GET /roles [ADMIN_ROLE_READ]
- GET /users [ADMIN_USER_READ]
- GET /users/:id [ADMIN_USER_READ]
- PATCH /users/:id [ADMIN_USER_UPDATE]
- POST /users [ADMIN_USER_CREATE]
- POST /users/:id/force-password-reset [ADMIN_USER_UPDATE]
- POST /users/:id/reset-2fa [ADMIN_USER_UPDATE]

**web/src/pages/admin/Users.tsx**
- GET /users [ADMIN_USER_READ]
- POST /users/:id/deactivate [ADMIN_USER_DEACTIVATE]
- POST /users/:id/reactivate [ADMIN_USER_UPDATE]

**web/src/pages/admin/Webhooks.tsx**
- DELETE /admin/webhook-endpoints/:id [ADMIN_WEBHOOK_MANAGE]
- GET /admin/webhook-deliveries [ADMIN_WEBHOOK_READ]
- GET /admin/webhook-endpoints [ADMIN_WEBHOOK_READ]
- POST /admin/webhook-endpoints [ADMIN_WEBHOOK_MANAGE]
- POST /admin/webhook-endpoints/:id/test [ADMIN_WEBHOOK_MANAGE]

**web/src/pages/inventory/ProjectDetail.tsx**
- DELETE /admin/construction-updates/:id [ADMIN_CONSTRUCTION_UPDATE_MANAGE]
- DELETE /inventory-groups/:id [INVENTORY_INVENTORY_GROUP_MANAGE]
- DELETE /projects/:projectId/media/:mediaId [INVENTORY_UPLOAD_DELETE]
- DELETE /projects/:projectId/units/:id/charges/:chargeId [INVENTORY_UNIT_CHARGE_MANAGE]
- DELETE /projects/:projectId/units/:id/plcs/:plcId [INVENTORY_UNIT_PLC_MANAGE]
- GET /admin/construction-updates [ADMIN_CONSTRUCTION_UPDATE_MANAGE]
- GET /admin/construction-updates/media/:mediaId/download [ADMIN_CONSTRUCTION_UPDATE_MANAGE]
- GET /masters/area-locations [ADMIN_MASTER_READ]
- GET /masters/charge-types [ADMIN_MASTER_READ]
- GET /masters/plc-types [ADMIN_MASTER_READ]
- GET /masters/project-types [ADMIN_MASTER_READ]
- GET /masters/unit-types [ADMIN_MASTER_READ]
- GET /projects/:id [INVENTORY_PROJECT_READ]
- GET /projects/:id/booking-count [INVENTORY_PROJECT_READ]
- GET /projects/:projectId/inventory-groups [INVENTORY_INVENTORY_GROUP_MANAGE]
- GET /projects/:projectId/media [INVENTORY_UPLOAD_READ]
- GET /projects/:projectId/media/:mediaId/download [INVENTORY_UPLOAD_READ]
- GET /projects/:projectId/stage-raises/pending [POSTSALES_DEMAND_RAISE]
- GET /projects/:projectId/towers [INVENTORY_TOWER_READ]
- GET /projects/:projectId/units [INVENTORY_UNIT_READ]
- GET /projects/:projectId/units/:id [INVENTORY_UNIT_READ]
- GET /projects/:projectId/units/:id/charges [INVENTORY_UNIT_READ]
- GET /projects/:projectId/units/:id/plcs [INVENTORY_UNIT_READ]
- GET /projects/:projectId/units/:id/rate-history [INVENTORY_RATE_READ]
- GET /projects/:projectId/units/export [INVENTORY_UNIT_EXPORT]
- GET /projects/:projectId/units/import-template [INVENTORY_UNIT_IMPORT]
- PATCH /projects/:id [INVENTORY_PROJECT_UPDATE]
- POST /admin/construction-updates [ADMIN_CONSTRUCTION_UPDATE_MANAGE]
- POST /admin/construction-updates/:id/media [ADMIN_CONSTRUCTION_UPDATE_MANAGE]
- POST /projects/:projectId/inventory-groups [INVENTORY_INVENTORY_GROUP_MANAGE]
- POST /projects/:projectId/media [INVENTORY_UPLOAD_CREATE]
- POST /projects/:projectId/stage-raises [POSTSALES_DEMAND_RAISE]
- POST /projects/:projectId/towers [INVENTORY_TOWER_CREATE]
- POST /projects/:projectId/units/:id/charges [INVENTORY_UNIT_CHARGE_MANAGE]
- POST /projects/:projectId/units/:id/plcs [INVENTORY_UNIT_PLC_MANAGE]
- POST /projects/:projectId/units/bulk-generate [INVENTORY_UNIT_BULK_GENERATE]
- POST /projects/:projectId/units/change-rate [INVENTORY_RATE_CHANGE]
- POST /projects/:projectId/units/import [INVENTORY_UNIT_IMPORT]
- POST /projects/:projectId/units/land-based [INVENTORY_UNIT_CREATE]

**web/src/pages/inventory/Projects.tsx**
- GET /masters/project-types [ADMIN_MASTER_READ]
- GET /projects [INVENTORY_PROJECT_READ]
- POST /masters/area-locations [ADMIN_MASTER_CREATE]
- POST /projects [INVENTORY_PROJECT_CREATE]

**web/src/pages/postsales/Applicant360.tsx**
- GET /applicants/:id/360 [PRESALES_APPLICANT_READ]
- GET /bookings/:id/plan-history [POSTSALES_PLAN_READ]
- GET /documents/:id/download [POSTSALES_LETTER_READ]
- GET /masters/letter-templates [ADMIN_MASTER_READ]
- GET /reports/postsales/applicant-ledger/:bookingId [REPORTS_APPLICANT_LEDGER_VIEW]
- POST /admin/portal-invites [ADMIN_PORTAL_INVITE_SEND]
- POST /admin/portal-password-resets [ADMIN_PORTAL_INVITE_SEND]

**web/src/pages/postsales/BookingWizard.tsx**
- GET /applicants [PRESALES_APPLICANT_READ]
- GET /applicants/:id [PRESALES_APPLICANT_READ]
- GET /brokers [ADMIN_BROKER_READ]
- GET /masters/gst-rates [ADMIN_MASTER_READ]
- GET /masters/payment-plan-templates [ADMIN_MASTER_READ]
- GET /projects [INVENTORY_PROJECT_READ]
- GET /projects/:projectId/inventory-groups [INVENTORY_INVENTORY_GROUP_MANAGE]
- GET /projects/:projectId/units/:id/charges [INVENTORY_UNIT_READ]
- GET /projects/:projectId/units/:id/plcs [INVENTORY_UNIT_READ]
- POST /applicants [PRESALES_APPLICANT_CREATE]
- POST /bookings [POSTSALES_BOOKING_CREATE]
- POST /bookings/:id/broker [POSTSALES_BOOKING_CREATE]
- POST /bookings/:id/plan/custom [POSTSALES_PLAN_EDIT]
- POST /bookings/:id/plan/from-template [POSTSALES_PLAN_EDIT]
- POST /bookings/:id/source-inquiry [POSTSALES_BOOKING_CREATE]

**web/src/pages/postsales/BrokerDetail.tsx**
- GET /brokers/:brokerId/commission-rules [ADMIN_BROKER_READ]
- GET /brokers/:id [ADMIN_BROKER_READ]
- GET /brokers/:id/pan [ADMIN_BROKER_UPDATE]
- GET /commission-payments/brokers/:brokerId [ACCOUNTS_COMMISSION_READ]
- GET /commission-payments/brokers/:brokerId/balance [ACCOUNTS_COMMISSION_READ]
- GET /documents/:id/download [POSTSALES_LETTER_READ]
- GET /reports/brokers/sold-units [REPORTS_BROKER_VIEW]
- POST /admin/portal-invites [ADMIN_PORTAL_INVITE_SEND]
- POST /admin/portal-password-resets [ADMIN_PORTAL_INVITE_SEND]
- POST /brokers/:brokerId/commission-rules [ADMIN_BROKER_UPDATE]
- POST /brokers/:brokerId/documents/statement [ACCOUNTS_COMMISSION_READ]
- POST /brokers/:id/bank-details [ADMIN_BROKER_UPDATE]
- POST /commission-payments [ACCOUNTS_COMMISSION_CREATE]
- POST /commission-payments/:id/approve [ACCOUNTS_COMMISSION_APPROVE]
- POST /commission-payments/:id/pay [ACCOUNTS_COMMISSION_PAY]

**web/src/pages/postsales/Brokers.tsx**
- POST /brokers [ADMIN_BROKER_CREATE]
- POST /brokers/:id/deactivate [ADMIN_BROKER_UPDATE]
- POST /brokers/:id/reactivate [ADMIN_BROKER_UPDATE]

**web/src/pages/postsales/ChequeQueue.tsx**
- POST /receipts/:id/cheque-event [POSTSALES_CHEQUE_VERIFY]

**web/src/pages/postsales/DuesDashboard.tsx**
- GET /projects [INVENTORY_PROJECT_READ]

**web/src/pages/postsales/InstallmentSchedule.tsx**
- GET /bookings/:id [POSTSALES_BOOKING_READ]
- GET /bookings/:id/plan-history [POSTSALES_PLAN_READ]
- POST /bookings/:id/cancel [POSTSALES_BOOKING_CANCEL]
- POST /bookings/:id/commission/accrue [POSTSALES_BOOKING_CREATE]

**web/src/pages/postsales/ReceiptEntry.tsx**
- GET /applicants [PRESALES_APPLICANT_READ]
- GET /applicants/:id/360 [PRESALES_APPLICANT_READ]
- GET /bookings/:id/plan-history [POSTSALES_PLAN_READ]
- GET /documents/:id/download [POSTSALES_LETTER_READ]
- GET /masters/banks [ADMIN_MASTER_READ]
- POST /receipts [POSTSALES_RECEIPT_CREATE]
- POST /receipts/:receiptId/pdf [POSTSALES_RECEIPT_READ]

**web/src/pages/postsales/Reports.tsx**
- GET /reports/postsales/birthday-list [REPORTS_BIRTHDAY_VIEW]
- GET /reports/postsales/bookings/status-rollup [REPORTS_SALES_VIEW]
- GET /reports/postsales/collection/daily [REPORTS_COLLECTION_VIEW]
- GET /reports/postsales/collection/detail [REPORTS_COLLECTION_VIEW]
- GET /reports/postsales/collection/monthly [REPORTS_COLLECTION_VIEW]
- GET /reports/postsales/collection/summary [REPORTS_COLLECTION_VIEW]
- GET /reports/postsales/company-rollup [REPORTS_SALES_VIEW]
- GET /reports/postsales/project-rollup [REPORTS_SALES_VIEW]
- GET /reports/postsales/units/status-rollup [REPORTS_SALES_VIEW]
- GET /reports/postsales/zero-gst-bookings [REPORTS_SALES_VIEW]

**web/src/pages/presales/Inquiries.tsx**
- GET /inquiries [PRESALES_INQUIRY_READ]
- GET /inquiries/:id [PRESALES_INQUIRY_READ]
- GET /inquiries/import-template [PRESALES_INQUIRY_IMPORT]
- GET /masters/inquiry-sources [ADMIN_MASTER_READ]
- GET /masters/inquiry-temperatures [ADMIN_MASTER_READ]
- GET /projects [INVENTORY_PROJECT_READ]
- GET /reports/presales/inquiries-export [PRESALES_REPORT_VIEW]
- GET /users [ADMIN_USER_READ]
- POST /applicants/:id/confirm-distinct [PRESALES_APPLICANT_MERGE]
- POST /inquiries [PRESALES_INQUIRY_CREATE]
- POST /inquiries/import [PRESALES_INQUIRY_IMPORT]

**web/src/pages/presales/InquiryDetail.tsx**
- GET /inquiries/:id [PRESALES_INQUIRY_READ]
- GET /inquiries/:inquiryId/follow-ups [PRESALES_FOLLOW_UP_READ]
- GET /masters/dump-reasons [ADMIN_MASTER_READ]
- GET /masters/follow-up-types [ADMIN_MASTER_READ]
- GET /masters/lead-stages [ADMIN_MASTER_READ]
- GET /users [ADMIN_USER_READ]
- PATCH /inquiries/:id [PRESALES_INQUIRY_UPDATE]
- PATCH /inquiries/:id/assign [PRESALES_INQUIRY_ASSIGN]
- POST /inquiries/:inquiryId/follow-ups [PRESALES_FOLLOW_UP_CREATE]

**web/src/pages/presales/Reports.tsx**
- GET /projects [INVENTORY_PROJECT_READ]
- GET /users [ADMIN_USER_READ]
- POST /reports/presales/audit-action [PRESALES_REPORT_PRINT]

**web/src/pages/presales/reportCatalogue.ts**
- GET /reports/presales/ageing [PRESALES_REPORT_VIEW]
- GET /reports/presales/budget-band [PRESALES_REPORT_VIEW]
- GET /reports/presales/communication-type [PRESALES_REPORT_VIEW]
- GET /reports/presales/daily-inquiries [PRESALES_REPORT_VIEW]
- GET /reports/presales/daily-work [PRESALES_REPORT_VIEW]
- GET /reports/presales/dump-report [PRESALES_REPORT_VIEW]
- GET /reports/presales/enquiry-type [PRESALES_REPORT_VIEW]
- GET /reports/presales/follow-up-delay [PRESALES_REPORT_VIEW]
- GET /reports/presales/follow-up-overdue [PRESALES_REPORT_VIEW]
- GET /reports/presales/funnel [PRESALES_REPORT_VIEW]
- GET /reports/presales/inquiries-export [PRESALES_REPORT_VIEW]
- GET /reports/presales/leads-by-stage [PRESALES_REPORT_VIEW]
- GET /reports/presales/manager-wise [PRESALES_REPORT_VIEW]
- GET /reports/presales/site-visit [PRESALES_REPORT_VIEW]
- GET /reports/presales/source-wise [PRESALES_REPORT_VIEW]
- GET /reports/presales/staff-performance [PRESALES_REPORT_VIEW]
- GET /reports/presales/stage-transitions [PRESALES_REPORT_VIEW]
- GET /reports/presales/stage-velocity [PRESALES_REPORT_VIEW]
- GET /reports/presales/supervisor-review-queue [PRESALES_REPORT_VIEW]

**web/src/pages/support/TicketDetail.tsx**
- GET /admin/tickets/:id [ADMIN_TICKET_RESPOND]
- PATCH /admin/tickets/:id/status [ADMIN_TICKET_RESPOND]
- POST /admin/tickets/:id/respond [ADMIN_TICKET_RESPOND]
