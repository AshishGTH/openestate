# UI/UX audit: execution plan for v0.8.2

Status: **plan only. Nothing has been run and no data has been created.**
Untracked on purpose. It supersedes the run order in `ui-audit-plan.md` (kept as
the inventory, its Appendix A and its screen/endpoint map are still the reference).

Target: `http://192.168.1.20`, running v0.8.2 (health reports `0.8.2`).
Findings go to `docs/testing/ui-audit-findings.md` (untracked until reviewed).

---

## 0. What changed since the old plan, and ground rules

**Changed since the plan was written (v0.7.1):**
- SF-01 (portal session reading staff broker reports) was fixed in v0.8.1. Phase 5
  checks that the fix holds in the browser; it is no longer a search.
- v0.8.2 added admin-authorisation rules: nobody changes their own role, only a
  super_admin acts on a super_admin, you can only grant what you hold, the
  super_admin role can't be edited. Phase 5 re-checks the role screens against
  these, and the six UX items from the v0.8.2 browser run are carried over.
- The audit is driven through **Claude in Chrome on the owner's own Chrome**, not
  Playwright scripts with saved sessions. So: no `apps/e2e/audit/` suite and no
  `storageState` files. The only script is for the inbound lead API (Phase 2),
  which needs a signed HTTP request.
- I re-grepped the static suspects at v0.8.2 before writing this (summary in the
  findings file). Most still hold. They are marked "confirmed in code" and still
  need the browser to confirm what a person sees.

**Rules (unchanged, restated):**
1. **The owner types every password and clicks every "Create user" / "Create
   account"** button. I fill the other fields, then stop. I never type, read, store
   or repeat a password, and never put one in a file or message.
2. Fake data only, on this VM only: names/titles start `UIAUDIT-`, phones
   `90000001xx`, emails `uiaudit-<n>@example.invalid`, PAN `AAAPZ9999Z`-style, small
   round money (₹1,00,000 units, ₹10,000 receipts). **No Aadhaar-like 12-digit
   numbers anywhere.**
3. No sudo, no SSH from me. The owner runs anything that needs them.
4. The owner takes the VMware snapshot "v0.8.2 clean, before UI audit" first.
   Data this audit creates mostly can't be removed (ledger rows are append-only, no
   project delete, bookings are cancelled not deleted), so the snapshot is the only
   clean undo.
5. Clock check at the start of every session and before any 2FA or date-based
   step: VM `Date` header vs a trusted source, tolerance 10 s (the VM once lost a
   week on suspend).
6. **SECURITY RULE.** If anything looks like a security problem (data visible to
   the wrong role, a permission bypass, a cross-company leak, a forbidden write
   that succeeds): **stop that thread at once, tell the architect in chat only,
   and write nothing about it in any file** (the findings file becomes public).
   It then follows the private advisory process.
7. Tooling notes learned in the last run: a native browser `confirm()` dialog can
   freeze screenshots (the page still works; read state with JS); click by element,
   not by guessed coordinates; confirm an element is enabled before calling a
   missing refusal "a bug".

---

## 1. Phases (each ends in a checkpoint report)

### Phase 1: Setup
Goal: a company configured the way a small builder would, with the accounts to test.
1. Clock check. Read each system role in Admin → Roles (VM roles may differ from
   `roles.ts`; sync only adds permissions to super_admin).
2. Admin → Company Config: company name, GSTIN, GST state code, FY start month,
   logo URL and colour. Record every field the screen offers and any it should.
3. Masters: walk all 23 master screens + Lead Stages + Letter Templates; record
   what's seeded, what can be added/edited/deactivated. Create the UIAUDIT-
   master rows later phases need (inquiry source, charge type, PLC type, payment
   plan template, document type, ticket category).
4. Project data: `UIAUDIT-Proj-HR` (high-rise, area location with a state code),
   a tower, 6 units bulk-generated, one PLC and one charge; and `UIAUDIT-Proj-Plot`
   (LAND_BASED, an inventory group, 2 plots). Set a RERA number on each.
5. Test accounts (section 2), in the stated order, minus the portal accounts.
6. Custom fields: one required applicant field, one optional inquiry field, a
   SELECT field (tests SF-02 later).
**Checkpoint 1:** setup findings, accounts list, anything that blocked setup.

### Phase 2: Lead lifecycle, end to end
One thread, one booking, followed all the way to a printed receipt:
enquiry (exec) → duplicate warning → bulk import + inbound API lead → reassign →
follow-ups (call, Site Visit with venue) → each lead stage → dump (with and
without a reason) / successful → New Booking from the lead (primary + co-applicant,
unit, GST rate, payment plan from a template and a custom one, broker) → installment
schedule → receipts as accounts (cash, cheque, NEFT, a bounce) → GST split
(intra vs inter-state, both place-of-supply cases) → TDS 194-IA receipt → statement,
demand letter, receipt PDF printed and **read as a file** (merge fields resolved,
company name, amounts in lakh/crore grouping, FY numbering).
Money checks use hand-computed expected values written down before the step.
Team scope: manager sees reports' leads, exec D does not; direct URL to a hidden
lead is handled cleanly. Presales and postsales reports each opened per role.
**Checkpoint 2a (lead to booking)** and **2b (payments, GST/TDS, documents)**.

### Phase 3: Does configuration drive behaviour?
For every setting and master: change it, then go and look where it should show its
effect. One table in the findings file (setting → expected effect → where I
looked → observed). Start with the ones the code says are wired; give the
display-only ones one honest look each, not a long hunt.
- Company config: name (PDFs), GSTIN (PDFs, banner), GST state code (split),
  FY start month (document numbers; do reports follow it?), terminology overrides,
  enabled modules, currency, timezone, date format, logo and colour (staff vs portal).
- Masters: each row's role in a screen, report, PDF or rule (e.g. area-location
  state code → GST split; lead stage → funnel; dump reason; ticket category).
- Settings with no UI (creator-retains-lead, phone-dedup, cheque bounce charge,
  commission trigger/clawback): record that the screen offers no control.
Revert config at the end (it is audited), or note why not.
**Checkpoint 3.**

### Phase 4: Missing screens
For each task a real user would expect, try to do it from the UI and record
"possible / not possible / hard to find". Statically traced already, so each is a
short look at the relevant screen and nav, not an investigation:
- Postsales: transfer, refund, allot, register, receipt reverse/reprint, extra
  charge, plan edit, interest waive, TDS certificate, dispatch, cancel a booking.
- Presales: edit applicant, merge duplicates, DPDP consent, send/log communication,
  edit a follow-up, manage the round-robin pool.
- Inventory: hold/block/release a unit, edit a unit/tower, create a single unit.
- Admin: approve a customer's profile-change request, edit a webhook, edit a
  broker, commission rule edit, "sign out everywhere", SMS templates.
**Checkpoint 4.**

### Phase 5: Roles and portals
- Staff: log in as each of super_admin, company_admin, sales_manager,
  sales_executive A/B/D, accounts, narrow, the 2FA account. For each: the menu,
  and the direct URL of every screen, against the permissions that role holds.
  Expect: hidden when not allowed, and a clean "no access" state when typed in.
  Record each screen shown that then fails to load data (SF-18: `GET /users` for
  sales roles).
- **The 28 permissions no route checks**: recompute the list from source first,
  then confirm the Roles picker offers them and that granting one changes nothing.
- Portals: customer and broker, from invites. Each page and nav against account
  type; a customer opening broker URLs and the reverse (SF-17); change request
  submit; ticket raise/reply; documents; forgot-password (no mail provider);
  2FA enrol/verify.
- v0.8.1/0.8.2 fixes in the browser: broker cannot read staff broker reports;
  portal session on a staff URL; the six UX items.
**Checkpoint 5a (staff)** and **5b (portals)**.

### Phase 6: Findings report
Consolidate, de-duplicate, assign severity and **pilot impact** to every finding,
screenshots referenced. Ends with a ranked **"fix before pilot"** list, then
"fix soon", then "later". Includes what was NOT tested and why.
**Checkpoint 6 (final report).**

---

## 2. Test accounts and order of creation

Existing on the VM now: `admin@demo-realty.com` (super_admin), `UIAUDIT Company
Admin` (`uiaudit-admin@example.invalid`, company_admin), `UIAUDIT Sales Exec`
(`uiaudit-exec-a@example.invalid`, sales_executive, **no manager yet**), two legacy owner test accounts (an admin that was 2FA-enabled, and a broker portal login),
`UIAUDIT Test Broker 1790588117` (inactive). The two legacy owner test accounts are inactive.

Created by the owner (me filling the form), signed in as `admin@demo-realty.com` or
the company admin. Order matters because later accounts point at earlier ones:

| # | Account | Role | Manager | Why |
|---|---|---|---|---|
| 1 | `uiaudit-mgr@example.invalid` | sales_manager | none | the manager |
| 2 | `uiaudit-exec-a@example.invalid` (existing) | sales_executive | **edit: set to uiaudit-mgr** | first report |
| 3 | `uiaudit-exec-b@example.invalid` | sales_executive | uiaudit-mgr | second report (reassign target) |
| 4 | `uiaudit-exec-d@example.invalid` | sales_executive | **none** | team-scope negative |
| 5 | `uiaudit-accounts@example.invalid` | accounts | none | receipts, cheques |
| 6 | role `UIAUDIT-Role-Narrow`, then `uiaudit-narrow@example.invalid` | custom, 3 permissions: `presales.inquiry.read`, `inventory.project.read`, `admin.master.read` | none | minimal-access checks |
| 7 | `uiaudit-2fa@example.invalid` | sales_executive | uiaudit-mgr | the 2FA staff account; the owner enrols an authenticator in Settings. (Alternative: reuse a legacy owner test account if its password and authenticator still exist.) |
| 8 | portal **customer** | customer | n/a | **only after a booking exists**: Send Portal Invite from the applicant's page; the owner opens the link and sets the password |
| 9 | portal **broker** | broker | n/a | **only after a booking with that broker exists**: create `UIAUDIT-Broker-01`, attach it to a booking, send the invite; the owner sets the password |

No second company exists and there is no UI to create one, so cross-company checks
are not possible in a browser (recorded as a finding, not skipped silently).

### Keeping the test passwords private
- Use a **separate Chrome profile just for the audit** and let **Chrome's password
  manager** generate and save a strong unique password for each account (the
  "Suggest strong password" prompt on the Add User form). The owner then never has
  to invent or remember one, and nothing is written in a file.
- At each login I fill only the email and stop; the owner picks the saved
  credential and presses Sign in. I never see the value.
- Never reuse a real password. These are throwaway accounts on a test VM, but a
  reused password would not be.
- After the audit: delete the profile, or at minimum the saved entries for
  `192.168.1.20`.

---

## 3. Findings format

File `docs/testing/ui-audit-findings.md`, one entry per finding, written for a
non-developer:

- **ID** (`UA-###`) and **title** (plain words)
- **Where** (screen and menu path)
- **Steps to reproduce** (numbered, as a person would click)
- **What happened vs what should happen** (messages quoted)
- **Severity:** Blocker for pilot / High / Medium / Low / Polish
- **Pilot impact:** *Stops a builder using it for real on one project* / *Has a
  workaround* / *Does not affect a pilot*
- **Suggested fix** (one or two lines, not implemented)
- **Screenshot** (file name; files kept outside the repo in
  `C:\Users\Ashis\.openestate-uiaudit\shots\`, never showing a password value or an
  Aadhaar-like value)
- **Source and status** (for pre-loaded candidates: where it came from, and
  `confirmed` / `to verify in browser`)

Severity: Blocker = a core journey cannot be completed or money/data is wrong; High
= core journey hindered, data loss risk; Medium = missing or wrong with a workaround;
Low = minor; Polish = wording/layout.

---

## 4. Size and shortcuts

Estimate: **about 8 working sessions, 8 checkpoints** (1, 2a, 2b, 3, 4, 5a, 5b, 6),
roughly 2 to 3 hours each with the owner present for passwords.

Can be **shortened** (already traced in code; the browser only confirms what a
person sees): Phase 4 (about half a session; one look per missing screen), the
display-only masters and settings in Phase 3, the 28 unchecked permissions (the
list is recomputed in a minute), SF-17 portal route gating, the six carried-over UX
items.

Must stay **full length**: Phase 2 (money correctness, GST/TDS, printed documents),
Phase 5 role-by-role (many combinations), and anything marked UNCLEAR (empty
round-robin pool, custom-field loading for sales roles, 403 handling on shared
lookups).

---

## 5. Open questions for the architect

1. The 2FA staff account: new `uiaudit-2fa`, or reuse a legacy owner test account?
2. Broker: create a fresh `UIAUDIT-Broker-01`, or reactivate the inactive
   `UIAUDIT Test Broker 1790588117`? (I suggest fresh: cleaner history.)
3. Phase 3 changes company config values (GST state, FY start, terminology). OK to
   change and then restore them, given every change is audited?
4. OK to read the PDFs the browser downloads from the owner's Downloads folder to
   check merge fields and amounts?
5. Screenshots outside the repo (path above) and referenced by file name: agreed?
6. The findings file is meant to become public. Is it acceptable that it names
   "no TLS by default" and "no mail provider" as findings (both already documented
   as by-design limits)?
7. Anything in scope that should be skipped for the pilot lens (e.g. plugins,
   webhooks, lead API) or added (e.g. data export, backup)?
