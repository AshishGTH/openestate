# UI/UX audit findings (v0.8.2 on the test VM)

Status: **pre-loaded candidates only. Nothing has been confirmed in a browser yet.**
Untracked until reviewed. If anything here turns out to be a security problem it is
removed from this file and reported privately instead.

Format per `ui-audit-run-plan.md` §3. Fields still empty are filled when the item is
run. **Pilot** = would it stop a small builder using OpenEstate for real on one
project? (Stops / Workaround / No.) Severity is provisional until verified.

"Confirmed in code" means I re-read or grepped the v0.8.2 source this week; it still
has to be seen in the browser.

---

## A. Carried in from earlier work

### UA-001  No email or SMS provider is connected
- **Where:** Portal "Forgot password"; Admin → SMS templates (no screen); any notification
- **Check:** On the portal login, use Forgot password with a real portal account;
  note what the user is told. Look for any place that says mail/SMS is off.
- **Should happen:** the user is told clearly that reset-by-email is unavailable and
  who to ask; admins can still issue a reset link.
- **Source / status:** `docs/todo.md`; only a console provider is bound. Confirmed in code; verify the on-screen message.
- **Severity (provisional):** High · **Pilot:** Workaround (admin-issued links) · **Fix:** show the state plainly; document the admin-link route.

### UA-002  Plain-HTTP install gives no warning
- **Where:** every screen; the default native install has no TLS.
- **Check:** is there any banner or setup note on login or Settings about HTTP?
- **Should happen:** a visible warning (or at least an install-time prompt) that
  passwords travel unencrypted without TLS in front.
- **Source / status:** installation docs say to put TLS in front; no in-app warning known. To verify.
- **Severity:** High · **Pilot:** Workaround (put TLS in front) · **Fix:** an admin-only banner when the page is served over HTTP.

### UA-003  No screen to create or manage a second company
- **Where:** Admin menu.
- **Check:** look for any company switcher/creation screen.
- **Source / status:** old plan §1; confirmed no UI. Effect: cross-company isolation can't be exercised in a browser.
- **Severity:** Low · **Pilot:** No (single builder) · **Fix:** document how a second company is created.

### UA-004  Phone numbers are normalised inconsistently
- **Where:** applicants/inquiries vs portal login vs users.
- **Check:** create an applicant with `+91 90000011xx`, `090000011xx`, and plain
  `90000011xx`; see whether duplicate detection and portal login treat them as one.
- **Should happen:** the same number is recognised however it is typed, in every place.
- **Source / status:** from the earlier unlinked-accounts investigation. To verify.
- **Severity:** Medium · **Pilot:** Workaround · **Fix:** one shared normaliser at every entry point.

### UA-005 to UA-010  The six "offered then refused" items (v0.8.2 browser run)
Source: CHECKPOINT 4, **confirmed in a real browser on 2026-10-02**. Each is also in
`docs/todo.md` ("UI offers actions the server then refuses"). Severity Low/Polish ·
Pilot: No · Fix for all: hide or disable the control for users who can't use it.
- **UA-005** Super Admin role page offers Edit, tickboxes and Update Role although its permissions are immutable.
- **UA-006** A user's own record offers the role dropdown (including Super Admin) and only then says "You cannot change your own role."
- **UA-007** The role editor lets a role holder tick permissions they don't hold.
- **UA-008** A non-super admin sees an enabled role dropdown, Update User, Generate reset link on a super_admin's page, and Deactivate on that row.
- **UA-009** "Reset 2FA" is disabled when 2FA is off (right), but that hides the refusal path from a UI test.
- **UA-010** A refused save shows a toast and an inline banner; keep forms consistent.

## B. Suspects from the static review (old plan, re-checked in code at v0.8.2)

### UA-011  Several masters change nothing
- **Where:** Admin → Masters: Project Types, Registration Types, Communication Types, Document Types; SMS Templates have no screen at all; Inquiry Temperatures unclear.
- **Check:** add a value to each, then look for it in the screens/reports/PDFs where a person would expect it.
- **Should happen:** each master either drives something visible or is not shown as configuration.
- **Source / status:** old plan §1d; confirmed in code (no reader). Verify what a user sees.
- **Severity:** Medium · **Pilot:** No (clutter, false promise) · **Fix:** wire them or hide them.

### UA-012  Interest Rules never take effect
- **Where:** Admin → Masters → Interest Rules; booking creation; installment schedule.
- **Check:** create a rule, make a booking, let an installment fall overdue (or use the accrue path), look for interest.
- **Should happen:** a delayed installment accrues interest per the rule.
- **Source / status:** SF-03; confirmed in code: `interestRuleId` is written only on transfer; accrual returns 0 when it is null.
- **Severity:** High · **Pilot:** Workaround (manual charge) or Stops if the builder charges delay interest · **Fix:** let the booking wizard pick the rule.

### UA-013  Cheque-bounce charge and commission settings cannot be set
- **Where:** Admin → Company Config.
- **Check:** look for bounce charge, commission accrual trigger, clawback policy.
- **Should happen:** they can be set (a bounced cheque can carry a charge).
- **Source / status:** SF-07; confirmed in code: not in the config API schema, so stuck at defaults (₹0 bounce charge). Also `presalesCreatorRetainsLead` and `presalesPhoneDedupAutoLink` are settable only by API (no screen).
- **Severity:** Medium · **Pilot:** Workaround · **Fix:** add them to the config screen and schema.

### UA-014  Post-sales screens missing
- **Where:** booking and receipt screens.
- **Check:** try, as accounts/manager/admin: transfer a booking, issue a refund, allot, register, reverse or reprint a receipt, add an extra charge, edit a plan, waive interest, record a TDS certificate, cancel a booking.
- **Should happen:** each can be done from the screen.
- **Source / status:** SF-12; confirmed in code for refund, reverse, extra charge (no caller in the web app); transfer/allot/register/reprint matched only by unrelated strings. To verify each.
- **Severity:** High · **Pilot:** Stops for any builder who needs refunds, cancellations or reprints · **Fix:** build the screens, most-needed first (cancel, refund, reprint).

### UA-015  Pre-sales screens missing
- **Where:** applicant, inquiry, project screens.
- **Check:** edit an applicant, merge two duplicates, record consent, send a communication, edit a follow-up, manage the round-robin pool.
- **Source / status:** SF-13; confirmed in code (no caller for pool, consent, merge, duplicates). Applicant edit and follow-up edit to verify.
- **Severity:** Medium (consent: High for the DPDP posture) · **Pilot:** Workaround; consent capture likely needed · **Fix:** add the screens.

### UA-016  Staff cannot approve a customer's profile-change request
- **Where:** nowhere in the staff app; the portal submits them.
- **Check:** submit one as a customer, then look for it as admin.
- **Should happen:** staff see, approve or reject it.
- **Source / status:** SF-04; confirmed in code (portal submits; no staff caller).
- **Severity:** High · **Pilot:** Stops the customer self-service profile feature · **Fix:** an Admin screen.

### UA-017  28 permissions are offered but checked nowhere
- **Where:** Admin → Roles → permission picker.
- **Check:** recompute the list from source; tick one on a custom role and confirm nothing changes for that user.
- **Source / status:** SF-16 (list in old plan §1e); to recompute at v0.8.2.
- **Severity:** Low · **Pilot:** No (misleading) · **Fix:** remove or implement them.

### UA-018  Portal pages are not restricted by account type
- **Where:** Portal URLs `/portal/broker/dashboard` etc.
- **Check:** as a customer open broker URLs; as a broker open customer URLs.
- **Should happen:** a clean "not available for your account" page.
- **Source / status:** SF-17. To verify what renders (the API answers 400 "Not a broker portal session").
- **Severity:** Low · **Pilot:** No · **Fix:** route gating by session type.

## C. Other candidates from the old plan, still open

- **UA-019** Sales roles may not see custom fields (the lookup needs an admin permission); a *required* custom field could then block every inquiry a sales user creates (SF-02). Source: confirmed in code (`GET /custom-fields` needs `admin.custom-field.read`). Provisional **High · Stops** (if a required field exists).
- **UA-020** Terminology overrides and "enabled modules" change nothing on screen (SF-05/06). Confirmed in code. Medium · No.
- **UA-021** Currency, timezone and date format settings change nothing (SF-09). Confirmed in code. Low · No.
- **UA-022** GSTIN, project RERA number and company address are missing from printed letters (SF-10). To verify on the PDFs. Medium · Workaround (India-first rule).
- **UA-023** No hold/block/release for a unit although sales roles hold the permission (SF-11). To verify. Medium · Workaround.
- **UA-024** Sales executives may get empty dropdowns or errors where a screen calls the users list they cannot read (SF-18). UNCLEAR; verify. Medium.
- **UA-025** Inquiry Types are not offered on Add Inquiry; Receipt Types are never sent from Receipt Entry. Confirmed in code (no caller). Low · No.
- **UA-026** Admin edits missing: webhook edit and retry, broker edit, commission rule edit, tower edit/delete, single unit create/edit, "sign out everywhere" (SF-14). Low · No.
- **UA-027** Letter templates have no edit/delete; Project.isActive does nothing (`docs/todo.md`). Low · No.
- **UA-028** A native confirm dialog (Deactivate) can freeze automated screenshots; check it is a normal dialog for people and consider an in-page confirmation. Tooling note, Polish · No.

---

## D. New findings from this audit

Phase 1 (setup / a builder's first day), 2026-10-02. Screenshots for these are
pending: Chrome was in the background for most of the session, so captures timed
out; they are retaken when each screen is revisited. Everything below was seen in
the real browser (read from the page and the network panel).

### UA-029  Payment plan templates cannot hold their milestones
- **Where:** Admin → Masters → Payment Plan Templates → Add Item / Edit
- **Steps:** open the master; click Edit on "Construction-Linked Plan" (or Add Item).
- **Happened:** the form has only Name, Description, Sort Order, Active. A new
  template is created (201) with no way to enter the stages (booking %, slab %,
  possession %, due dates).
- **Should:** the template screen lets you list the stages and percentages.
- **Severity:** High · **Pilot:** Workaround (build a custom plan on each booking); stops a builder who wants standard plans.
- **Fix:** add a milestones editor to the template form. (Whether the four seeded templates carry milestones is checked in Phase 2.)

### UA-030  GST rates cannot overlap, even when they are different rates
- **Where:** Admin → Masters → GST Rates → Add Item
- **Steps:** add "5%" effective 2019-04-01 with no end date.
- **Happened:** refused: `Date range overlaps with existing GST rate "GST 5% (Affordable Housing, HSN 9972)" (2019-04-01 – open). Set an end date on it first…`
- **Should:** two different rates can be live at once (a builder with an affordable project at 1% and another at 5%).
- **Severity:** High · **Pilot:** Stops a builder with more than one GST scheme; the message is clear, the rule is the problem.
- **Fix:** apply the overlap check per rate "category", or drop it and let each project/booking pick its rate.

### UA-031  The seeded GST rates are out of date
- **Where:** GST Rates master; Charge Type "GST Rate" dropdown.
- **Happened:** only two rates exist: "GST 12% (Non-Affordable … pre-Apr-2019 scheme)" and "GST 5% (Affordable Housing, HSN 9972)" effective from 2019-04-01. The current residential rates (5% without input credit, 1% affordable) are not there, and the expired 12% is still offered in pickers.
- **Should:** correct current rates are seeded, and expired rates are not offered for new items.
- **Severity:** High · **Pilot:** Stops until the builder fixes the rates; combined with UA-030 they cannot add the right ones without first end-dating the existing 5%.
- **Fix:** reseed with current rates and hide rates whose end date has passed.

### UA-032  GSTIN is checked for format only
- **Where:** Admin → Company Config → GSTIN.
- **Steps:** enter `06AAAPZ9999Z1` (too short): "Invalid GSTIN format". Enter `06AAAPZ9999Z1Z5` (made up, wrong check character): accepted and saved.
- **Should:** also validate the check character, or say plainly that only the shape is checked.
- **Severity:** Low · **Pilot:** No.

### UA-033  The seeded date format is the US one and the setting changes nothing visible
- **Where:** Admin → Company Config → Date Format.
- **Happened:** the demo company was set to `MM-DD-YYYY` (the India default is DD-MM-YYYY). I changed it to DD-MM-YYYY; nothing on screen is known to follow it (see UA-021).
- **Severity:** Medium · **Pilot:** No (but wrong first impression).

### UA-034  No place for the company address, PAN or registration numbers
- **Where:** Admin → Company Config → Company Details.
- **Happened:** only the company name; no address, PAN, CIN, phone, email. Letters merge `companyAddress` from nowhere (empty). GSTIN has a field but is not printed (UA-022).
- **Severity:** Medium · **Pilot:** Workaround (type the address into each letter template).

### UA-035  Developer wording leaks into screens
- **Where:** "(apps/portal)" under Portal Branding; "leave blank for ON_BOOKING mode" and "Slabs (half-open [from, to)) — boundary matches the higher bracket" on the broker commission form; the TDS master "TDS on commission or brokerage (Phase 5)"; "Max Storage per Project (bytes)".
- **Should:** plain words ("per upload limit in MB", "pay when booked").
- **Severity:** Polish · **Pilot:** No.

### UA-036  Saving does not clearly say it saved
- **Where:** Company Config Save; Masters Create; Project, Tower, Broker, Role Create; user Update.
- **Happened:** after Save or Create the request succeeds (200/201) and the list updates, but no success message was seen within ~1.5 s of the click. After a failed save (bad GSTIN) the Save button just greys out.
- **Should:** a short "Saved" message; an invalid form says why Save is disabled next to the button.
- **Severity:** Medium · **Pilot:** No (confusing, not blocking). **To confirm** with a screenshot taken immediately after the click.

### UA-037  A tower shows "0 floors" after floors were entered and units generated
- **Where:** Inventory → project → Towers.
- **Steps:** Add Tower with Total Floors = 4; bulk-generate units for floors 1–3.
- **Happened:** the row still reads "UIAUDIT-Tower A (UTA) — 0 floors".
- **Severity:** Low · **Pilot:** No.

### UA-038  The unit "Base Rate" has no unit, and the PLC amount looks wrong
- **Where:** Bulk-Generate Units → "Base Rate (₹)"; unit Pricing → PLC.
- **Steps:** carpet area 1000, base rate 5000; add a PLC of 5% "of base rate".
- **Happened:** the PLC line reads "₹250 (5%)" (5% of 5,000), i.e. the rate is treated as a flat figure, not per sq ft × area. Unit list shows "RATE ₹5,000" and "CARPET AREA 1000" (no units).
- **Should:** say "per sq ft"; the PLC on a 1,000 sq ft unit at ₹5,000/sq ft is ₹2,50,000.
- **Severity:** Medium (money) · **Pilot:** to be settled in Phase 2 by the booking cost breakup. **To verify.**

### UA-039  The unit pricing panel opens at the bottom of the page
- **Where:** Inventory → project → unit → Pricing.
- **Happened:** the panel appears below the Bulk import and Media sections, far from the unit; nothing says it opened.
- **Severity:** Polish · **Pilot:** No.

### UA-040  Area/Location asks for state twice
- **Where:** Admin → Masters → Area/Locations → Edit.
- **Happened:** "GST State Code (2 digits…)" plus free-text City, State and Pincode. Only the code drives tax; the list does not show the code. Free-text State can disagree with it.
- **Severity:** Low · **Pilot:** No.

### UA-041  The GST place of supply is hidden behind "Area/Location"
- **Where:** project form (no GST/state field); booking tax split.
- **Happened:** the project form never mentions GST; the tax split silently follows the project's Area/Location master (here Gurugram = 06). A builder who picks the wrong location, or leaves it empty, gets the wrong split or a blocked booking.
- **Should:** the project form says "GST state: Haryana (06), from the location".
- **Severity:** Medium · **Pilot:** Workaround. **To verify** when a booking is made.

### UA-042  Masters lists show too little to pick from
- **Where:** Admin → Masters (GST Rates, TDS Rules, Charge Types, Interest Rules…).
- **Happened:** every list shows only Name / Active / Sort order. A GST rate's percentage and dates, a charge type's HSN, a TDS threshold are visible only inside Edit (or only if typed into the name).
- **Severity:** Low · **Pilot:** No.

### UA-043  The users list has no manager column
- **Where:** Admin → Users.
- **Happened:** manager is visible only in a user's edit page or the read-only Hierarchy page.
- **Severity:** Low · **Pilot:** No.

### UA-044  The org chart lists portal accounts as staff
- **Where:** Admin → Hierarchy.
- **Happened:** a legacy owner test broker portal login appears among the 10 people, role Broker, and the page is a flat alphabetical list with a "n direct reports" count rather than a tree.
- **Severity:** Low · **Pilot:** No.

### UA-045  A leftover test admin and demo data were found on the install
- **Where:** Admin → Users, Projects, Brokers.
- **Happened:** an active company_admin legacy owner test account with 2FA enabled (deactivated during this audit), a legacy owner test broker portal login, and projects "NOC Test Project" and "testing project" were already present; the seeded admin is called "System Admin".
- **Should:** a clean install has none; the first-day checklist includes "remove the demo accounts and projects".
- **Severity:** Medium (hygiene; an extra admin is a real risk) · **Pilot:** Workaround (delete/deactivate by hand).

### UA-046  Nothing tells a new builder what to do first
- **Where:** after the first sign-in (Dashboard).
- **Happened:** the app lands on a dashboard of lead counts with no setup checklist. The order that works (Company Config → GST rates → Masters → Area/Location → Project → Units → Broker → Users → first booking) is learned from the screens' side effects (a booking fails without a GST state; a plan template is empty; rates are stale).
- **Should:** a short "Set up your company" list with links, ticked as done.
- **Severity:** Medium · **Pilot:** Workaround (hand-holding) · **Fix:** a setup checklist and "not set up yet" hints on the screens that depend on it.

### Phase 1 observation, not a finding
Setup, including seven accounts typed by the owner, took about 20 minutes of wall-clock
time (22:55 to 23:15), most of it the per-account password step; the screens
themselves were quick. Not counted: slow/failed screenshots (a tooling issue).

## E. Phase 2a (presales, as sales roles) — 2026-10-03

Re-ratings from architect review: UA-029 stays High but scoped: no screen or API route adds milestones to a template (checked web + API); time-based plans can be built per booking in the wizard (workaround), construction-linked (STAGE_LINKED) billing cannot be templated at all. UA-030, UA-031 and all tax items are "tax rules to be confirmed by a Chartered Accountant" — description only, not statements of law.

| ID | Title | Severity | Pilot impact |
|---|---|---|---|
| UA-047 | A required custom field with no input on the Add Inquiry form blocks ALL enquiry creation ("customFields.abc: Required"); found as a leftover field on the VM | High | Stops (any required Inquiry custom field = sales cannot log leads) |
| UA-048 | A custom field cannot be edited to optional, and a deactivated field cannot be reactivated (only "Delete permanently") | Medium | Workaround |
| UA-049 | Add Inquiry form collects only name, phone, project, source, temperature: no email, notes, budget, unit type, or consent | Medium | Workaround |
| UA-050 | Duplicate phone is detected in all formats (same, +91, leading 0) but only warns: duplicates are created anyway, shown as typed, and the banner mentions "confirm it" with no button | Medium | Workaround |
| UA-052 | Follow-up/visit dates show US style "10/3/2026, 8:15:00 AM", ignoring the DD-MM-YYYY company setting (extends UA-033) | Medium | No |
| UA-053 | No mark-done / reschedule on a follow-up or site visit; "completing" a visit means logging another entry; stage is not linked to visits | Medium | Workaround |
| UA-054 | Stage changes show no history on the lead and no success message; there is no "ready to book" stage (Documentation used) | Medium | Workaround |
| UA-055 | Logging a follow-up silently flips status OPEN to CONTINUED | Low | No |
| UA-056 | Enquiry list has no Assigned-to, Stage or Next-follow-up column; a manager cannot tell whose lead is whose | Medium | Workaround |
| UA-057 | Phone width (390px): sidebar becomes a hamburger and lead detail is fine, but the list table is 583px wide (Status off-screen), controls are 36px tall | Low | No |
| UA-058 | Export CSV: button shown to roles that get 403; file has no UTF-8 BOM (Hindi names garble in Excel), no Stage/follow-up columns, raw header "applicant.Reference check", CSV only (no Excel) | Medium | Workaround |
| UA-059 | Opening a lead you cannot access (direct link) shows "Loading…" forever, no "not found / no access" message | Low | No |
| UA-060 | Inbound API: same phone twice reuses the applicant but creates a second enquiry; no project mapped by default; auth is X-Api-Key only (no payload signature) | Low | To decide |
| UA-061 | PILOT PREREQUISITE: CA review of GST place-of-supply, rates, and TDS 194-IA / 194-H handling | n/a | Required before pilot |
| UA-062 | Sales-exec sidebar shows Masters, Letter Templates, Lead Stages, Settings (access not tested; to verify) | Low | To verify |
| UA-063 | Leftover test enquiries (abcd, guard test, Test Lead A x2) mixed with real lists (extends UA-045) | Low | Workaround |

Worked as expected: exec-a enquiry created; exec-b sees none of exec-a's; manager sees all five of both reports plus team dashboard; exec-d (no manager) sees none; overdue follow-up showed on exec-a Dashboard "My Day"; follow-up and site visit logged with venue; stages moved to Documentation and persisted.

## F. Phase 2b — public findings added by architect review (2026-10-03)
| ID | Title | Severity | Pilot impact |
|---|---|---|---|
| UA-064 | Every install's first company is "Demo Realty Pvt. Ltd." with fixed admin email admin@demo-realty.com; the installer should ask for company name and admin email (onboarding) | Medium | Workaround (rename in Company Config; email stays) |
| UA-065 | Installer says the one-time admin password is "also in journalctl -u openestate-api". False: the seed runs as a separate foreground process before the service unit exists, output goes only to the terminal. An operator who lost the output finds nothing there. (Recovery exists: reset-admin-password.sh.) | Low | No |

UA-062 RESULT (tested as exec-a): Masters edit (PATCH), Lead Stages create (POST), Letter Templates create (POST) all refused with 403 "Insufficient permissions". Settings is the user's own account page (own password/2FA), no shared config. No permission breach. UX finding stands: pages open and show Add/Edit/Delete buttons to a role that cannot use them, and no visible error message appeared after the refused save. Severity Low.

## G. Phase 2b findings (booking, money) — 2026-10-03
Tax items are "to confirm by a Chartered Accountant"; they describe product behaviour, not law.
| ID | Title | Severity | Pilot impact |
|---|---|---|---|
| UA-066 | No applicant correspondence address anywhere (no UI, no API); letters/receipts cannot show a buyer address and place-of-supply-vs-buyer-address cannot be tested | High | Workaround (none for letters) |
| UA-067 | Booking wizard creates the booking BEFORE the payment plan; if the plan fails (amounts not summing) a booking is left with no plan and no broker, and the only action offered is Cancel Booking (cancels in one click) | High | Stops (ghost bookings, consumed numbers) |
| UA-068 | Receipt amount fields accept whole rupees only, but installments produce paise (10% of 53,62,262.50 = 5,36,226.25): an installment can never be cleared exactly; auto-fill proposes paise the form then rejects | High | Stops exact settlement |
| UA-069 | Agreed price pre-fills with the per-sq-ft rate (5000) not rate x area; the builder must retype the real price (UA-038 confirmed) | High | Workaround |
| UA-070 | PLC percentage is applied to the rate, not the price: 5% PLC = Rs 250.00 instead of Rs 2,50,000 | High | Stops (wrong money) |
| UA-071 | Wizard Confirm shows only "Total (excl. GST)"; no GST amounts, no CGST/SGST split, no payable total; custom installments must be typed to the paise-exact GST-inclusive total the screen never shows | High | Workaround |
| UA-072 | GST picker offers only the two stale seeded rates (extends UA-031); base-line rate is mandatory so the choice is forced | High (to confirm by CA) | Stops until rates refreshed |
| UA-073 | Receipt PDF lacks statutory content: no GSTIN, place of supply, RERA number, amount in words, GST split, unit/project, addresses, bank, date in ISO not DD-MM-YYYY (to confirm by CA/RERA) | High | Stops |
| UA-074 | Uncleared cheque (RECEIVED) already reduces the booking balance and marks the installment part-paid | Medium | Workaround (to confirm policy) |
| UA-075 | Cheque bounce adds a Rs 500 BOUNCE_CHARGE (default) with no settings screen, no GST, and it appears in the ledger but not in the schedule's "Total due" (two different balances on two screens) | Medium | Workaround |
| UA-076 | No TDS 194-IA field on the receipt form; the TDS receivable path cannot be used from the UI (to confirm by CA) | High (to confirm by CA) | Stops |
| UA-077 | Broker commission slab base is the GST-INCLUSIVE total price (80,433.94 = 1.5% x 53,62,262.50); accrual is manual (button), not automatic at booking | Medium (to confirm by CA/policy) | Workaround |
| UA-078 | Broker commission payment: TDS 194-H withheld amount not shown on the broker screen after Pay; outstanding drops by the gross (to confirm by CA) | Medium | Workaround |
| UA-079 | Cancelled booking still offered in the Receipt Entry booking dropdown; applicant search lists the same buyer 4 times (duplicates from UA-050) | Medium | No |
| UA-080 | Ledger on Applicant 360 is empty until a booking row is clicked; ledger lines show no CGST/SGST detail; dates in the schedule are DD/MM/YYYY while presales dates are US style (extends UA-052) | Low | No |
| UA-081 | Master names show developer wording ("TDS on commission or brokerage (Phase 5)"); TDS rule list shows no rate/section/threshold (extends UA-035, UA-042) | Low | No |
| UA-082 | No way to charge no GST: the booking wizard forces a base-line GST rate and offers only 12%/5%; no "GST not applicable / exempt" option, and a 0% master rate probably hits the overlap rule (UA-030). Owner request: add an option to disable GST per company/project/booking. Whether GST applies to a given builder is for the CA. | High (to confirm by CA) | Stops for any builder not charging GST |
| UA-083 | Customer portal shows the CANCELLED booking with its full cost breakup (Rs 53,62,262.50) and an empty plan; the bounced cheque's receipt is still downloadable (3 receipt documents vs "2 receipts" in history); balance includes the Rs 500 bounce charge with no explanation | Medium | No |
| UA-084 | Broker portal shows only totals (accrued, paid, TDS withheld, outstanding, units sold): no list of the broker's own sales or per-booking commission; TDS withheld (Rs 2,500 = 5% of 50,000, to confirm by CA) is visible to the broker but not to staff on the broker screen (UA-078) | Medium | Workaround |
| UA-085 | Portal invite expiry shown as "10080 minutes from now" instead of days | Polish | No |

Phase 2b checks that passed: customer portal shows only that buyer's bookings, schedule, receipts and documents and fits 390px with no overflow; broker portal shows only the broker's own figures, 390px no overflow; ledger balance equals charges minus receipts plus bounce items on every step (26,26,036.50 and 28,26,536.50 reconciled by hand); no ledger row or receipt could be edited from the UI (only reversal by bounce or cancel).

## H. Architect corrections after P2b (2026-10-03)

### H1. P2b expected column recomputed independently (as a builder would expect, not from product behaviour)
Inputs: base Rs 50,00,000.00 (1000 sq ft x 5000); PLC 5% of the agreed base price; club charge Rs 1,00,000; GST on every line, to confirm by CA: base 5%, PLC at the base rate 5%, club 12%.
Base 50,00,000.00 + GST 2,50,000.00 = 52,50,000.00. PLC 2,50,000.00 + GST 12,500.00 = 2,62,500.00. Club 1,00,000.00 + GST 12,000.00 = 1,12,000.00.
**Expected total = 52,50,000.00 + 2,62,500.00 + 1,12,000.00 = Rs 56,24,500.00. Actual Rs 53,62,262.50. Shortfall Rs 2,62,237.50 (all of it the PLC defect, UA-070: 2,62,500.00 expected vs 262.50 actual).**
| Row | Expected (independent) | Actual | Match |
|---|---|---|---|
| Total consideration | 56,24,500.00 | 53,62,262.50 | NO (-2,62,237.50) |
| Installment 1 (10%) | 5,62,450.00 | 5,36,226.25 | NO (-26,223.75) |
| Installment 2 (40%) | 22,49,800.00 | 21,44,905.00 | NO (-1,04,895.00) |
| Installment 3 (50%) | 28,12,250.00 | 26,81,131.25 | NO (-1,31,118.75) |
| Place of supply / tax type | 06, CGST+SGST | 06 | yes |
| Club charge GST | 12,000.00 (6,000+6,000) | 12,000.00 | yes |
| Agreed-price default | 50,00,000.00 | 5,000 | NO (UA-069) |
| PLC | 2,50,000.00 (+12,500 GST) | 250.00 (+12.50) | NO (UA-070) |
| (a) cheque 2,00,000.00 | inst 1 part-paid, due 3,62,450.00; balance 54,24,500.00 | different base; behaviour (balance reduced at entry) as expected except uncleared cheque (UA-074) | n/a (principle: yes, with UA-074) |
| (b) clear inst 1 | pay 3,62,450.00 (whole rupees) -> PAID | cannot be compared; with the correct price there is no paise here, but the field is still whole-rupee-only (UA-068 still applies to any price giving paise, e.g. an 8% stage) | NO (UA-068) |
| (c) overpay inst 2 | excess spills to inst 3 or is refused | spilled | yes |
| Bounce of (a) | reversal of 2,00,000.00 and a configured charge | 2,00,000.00 + Rs 500 default | yes (UA-075 on the charge) |
| Schedule vs ledger balance | equal | differ by Rs 500 | NO (UA-075) |
| Commission | 1.5% x 50,00,000.00 (base price excl. GST, boundary rule) = 75,000.00 [policy to confirm: base excl. or incl. GST] | 80,433.94 (1.5% x GST-incl. buggy total) | NO (UA-077); on the correct total 56,24,500.00 it would be 84,367.50 |
| TDS 194-H on 50,000 | rate per master (to confirm by CA) | 2,500.00 (5%) | yes if rule is 5% |
(Earlier "match" marks in section G / the P2b notes compared against the buggy total and are superseded by this table.)

UA-070 money impact: the PLC is understated by Rs 2,62,237.50 on this one unit (total consideration and every installment under-stated by 4.66%: Rs 26,223.75 on installment 1, Rs 1,04,895.00 on installment 2, Rs 1,31,118.75 on installment 3). Cause: percentage applied to the rate 5000 (per sq ft) not the agreed price.

### H2. UA-076 re-rated
TDS 194-IA is NOT missing from the product: the API accepts `tdsDeductedPaise` on a receipt and has `POST tds/:id/certificate`, and a TDS rule master exists. NO web screen records a TDS deduction or certificate (grep of apps/web: only the master list). Re-rated: **High, UI-only gap** (backend complete; fix touches the receipt form and a certificate screen, not the ledger engine). Workaround exists only via direct API calls, which a builder cannot use. Tax treatment itself: to confirm by CA.

### H3. UA-083 raised to HIGH
A customer can download the receipt for a bounced cheque as an ordinary receipt (the PDF and the portal list do not mark it bounced or invalid). It can be misused as proof of payment, e.g. with a lender. Expected: BOUNCED / NOT VALID shown on the PDF and in the portal, or the document withheld. Severity High, pilot impact: stops (document integrity). Fix is document/portal-listing only.

### H4. Post-sales assessment (plain words)
The ledger engine is sound: every figure is append-only, the booking balance equals charges minus receipts plus reversals at every step I checked, nothing financial can be edited from the screens (a bounce or cancel posts a reversal), and the cheque bounce, cancellation, spill-over of excess payments and commission/TDS posting all behaved consistently. The defects cluster around the engine, not inside it: pricing inputs (UA-069 price default, UA-070 PLC maths, UA-072/UA-082 GST rate choices), the booking wizard (UA-067 ghost booking, UA-071 no GST/payable preview), rounding and field precision (UA-068 whole-rupee receipt fields against paise schedules), and document outputs (UA-073 thin receipt, UA-083 bounced receipt downloadable).
Which fixes touch the FROZEN Phase 4 financial core (explicit approval needed later), to confirm by reading the code before work starts:
- Likely frozen-core (BookingService cost-line/GST resolution, ledger/receipt services): UA-082 (no-GST option / exempt rate), UA-072 if rate resolution changes, UA-075 if the bounce charge or schedule total logic changes, UA-074 if cheque-clearing policy changes.
- Outside the frozen core but financial (Phase 5 commission code, needs care): UA-077 commission base and manual accrual, UA-078.
- UI/document-only (no engine change): UA-066 address field (needs schema/UI), UA-067 (wizard/controller ordering; atomic booking+plan), UA-068 (accept paise in the form), UA-069 (default price = rate x area), UA-070 (PLC calculation lives in the pricing service added in v0.2.0, not the ledger), UA-071 (Confirm screen), UA-073 (receipt PDF content), UA-076 (TDS screens), UA-079, UA-083 (portal list and PDF marking), UA-084.

## I. Phase 3 — does configuration drive behaviour? (2026-10-03)
Update to UA-047: the likely cause is that exec-a lacks permission to read custom field definitions, so the Add Inquiry form never loaded the required field `abc` and could not render an input; any role without that read permission is dead-ended by a required field. UA-036 confirmed again: every config save returned PATCH 200 with no visible message.
| ID | Title | Severity | Pilot impact |
|---|---|---|---|
| UA-086 | Date Format setting changes nothing: screens stay D/M/Y or US style, PDFs, ledger and CSV stay ISO (extends UA-033/UA-052) | Medium | No |
| UA-087 | Terminology overrides (Unit, Project, Inquiry...) are saved but never read: no staff screen, portal page or PDF changes (setting is only used by the config editor and plugin install) | Medium | Depends on customer (plot/farmland builders) |
| UA-088 | Module toggles (Presales/Postsales/Accounts) do nothing: with Accounts off, menu, Brokers route and its API all still work | Medium | No (but admins believe they restricted something) |
| UA-089 | FY Start Month does not affect numbering: with January chosen the receipt was still RCP/2026-27/000004 (to confirm numbering policy with CA) | Medium | Workaround |
| UA-090 | Masters nothing in the UI reads: Inquiry Types, Communication Types, Receipt Types, Registration Types, Document Types (and Interest, TDS, Transfer-fee and Cancellation rules are used only by server code; Ticket Categories only by the portal). A new Receipt Type appeared nowhere | Medium | No |
| UA-091 | Interest Rules cannot be attached to any booking (Phase 4 check: NO route sets a booking's interest rule, so this needs backend work, not only a screen) (no field in the wizard or any booking screen): interest never accrues and the Dues Dashboard "Accrued interest" is always Rs 0.00. A past-due test booking was therefore not worth creating | High | Stops (interest on late payment) |
| UA-092 | Cheque bounce charge, commission accrual/clawback policy and "creator retains lead" have no settings UI. The Rs 500 bounce charge comes from the seed script (schema default is 0), so a company created any other way charges Rs 0 | Medium | Workaround |
| UA-093 | Letter templates: only 3 types; Allotment date and Company address merge fields print blank (no allotment date or address exists); no RERA or GSTIN merge field; dates print ISO; names, unit, floor, project and amounts (lakh format) fill correctly | Medium | Workaround |
| UA-094 | Lead stage Sort Order 1.5 fails silently (no message); ordering is a number only, no drag-and-drop | Low | No |
| UA-095 | Every Generate click stores another copy of the letter (5 allotment letters for one booking); no replace or confirmation | Low | No |
| UA-096 | Custom field values cannot be captured for units (confirmed: optional UNIT field appeared on no screen) | Medium | Workaround |
Phase 3 positives: Inquiry Sources, Banks, PLC/Charge/Unit/Project Types, Area/Locations, Follow-up Types and Lead Stages appear in the screens that use them; a new stage appears in the lead's stage dropdown at its sort position.

## J. Architect correction (2026-10-03): commission base wording
UA-077 re-worded: the commission slab base is NOT "wrong". Today the base is fixed to the booking's GST-inclusive total price. The right base depends on each builder's broker agreement, so it should be configurable per commission rule (base price / agreement value / including GST). Rating: Medium, "needs configuration option". Accrual is also a manual button (kept from UA-077). The commission row is REMOVED from the P2b mismatch count (table H1 row "Commission" is informational, not a mismatch). Whether commission applies on GST is a policy question, to confirm with the builder and CA.

## K. Phase 4 — missing screens (2026-10-03)
Correction to UA-050: the duplicate banner DOES offer a "Confirm distinct" button per candidate (my first check ran after the banner had closed). What is missing is any way to MERGE duplicates (see UA-104).
Phase 4 test data added: one more duplicate applicant/enquiry "UIAUDIT Dup Test" (9000000401); change request (email uiaudit-buyer1@example.invalid); a ticket "UIAUDIT test query" (resolved); a construction update "UIAUDIT Foundation complete"; Buyer Two reassigned from exec-b to exec-a.
| ID | Title | Severity | Pilot impact |
|---|---|---|---|
| UA-097 | Customer profile change requests (portal) have no staff screen: the API (admin-change-request approve/reject) exists, nothing in the web app lists or approves them; the customer is told "We'll review it" and nothing ever happens | High | Stops (customer data change loop) |
| UA-098 | No document upload for customers (no portal upload route, no input anywhere) and no staff view of uploaded documents; KYC papers cannot be collected through the product | High | Workaround (offline) |
| UA-099 | Profile change request only allows a new email address (no name, phone, address) | Low | No |
| UA-100 | No bookings list screen anywhere (only wizard, schedule and Applicant 360) and no bookings or ledger CSV; CSV exists for only 5 of 10 postsales reports; no API list route for bookings | High | Workaround |
| UA-101 | No way to create a second company (no route, no screen); tenant creation is seed/DB only | Medium | Depends on hosting plan |
| UA-102 | Manager's "Assign To" list shows every user incl. portal customer and broker accounts and admins; reassigning outside the team is refused with a bare 404 and nothing on screen | Medium | No |
| UA-103 | Booking lifecycle screens missing although the API exists: transfer, refund (request/approve/pay/voucher), allotment, registration, receipt reversal, receipt reprint button, extra charges, plan edit (also the only recovery for UA-067), interest waive | High | Stops (money corrections, cancellation refunds) |
| UA-104 | Presales screens missing although the API exists: edit applicant, merge duplicates, record consent (DPDP tool; DPDP consent requirements to be confirmed by a lawyer), round-robin pool setup | High | Workaround (consent: stops compliance posture) |

Note on the 15 "UI only" items (architect, 2026-10-03): their backend code has NEVER been exercised through a real screen. "UI only" describes where the work is, not how safe it is: each needs its own real-browser verification when built ("correct components, wrong composition", the dominant bug class in this project's history). None of them is trivial.

## L. Phase 5a — staff roles (2026-10-03)
UA-047 cause CONFIRMED live: GET /api/v1/custom-fields returns 403 for sales_executive, so execs can never see or fill any custom field.
| ID | Title | Severity | Pilot impact |
|---|---|---|---|
| UA-105 | Accounts cannot pay (or request/approve) broker commission anywhere: the only screen is the broker page, gated by admin.broker.read, which accounts does not hold although it holds commission approve/pay | High | Stops (dual control falls back to admins) |
| UA-106 | Existing installs keep their original system-role permissions: on the VM the Accounts role has 33 permissions and lacks admin.master.read, which a fresh install gives it (34), so Masters is denied there. By design (upgrades don't touch non-super_admin roles) but undocumented for admins | Low | No |
| UA-107 | Read-only roles see write controls they cannot use (manager: Add/Edit/Deactivate on Users, Add Broker, Add Project, master Add/Edit; narrow: Add Inquiry/Add Project/Add Item). Server refuses with 403 (toast on most; none on the inquiry form). Extends UA-062 | Low | No |
| UA-108 | A lead can be assigned to a portal customer or broker account: the "Assign To" list offers them and the API accepts it (PATCH 200). The portal user can never see it (no portal enquiry route, no staff login), so the lead silently leaves every staff queue | Medium | Workaround |
| UA-109 | Wrong 2FA code shows "Invalid TOTP code" (jargon); after the limit the raw "ThrottlerException: Too Many Requests" is shown instead of a lockout message; every failed verify also fires a pointless /auth/refresh (401) | Low | No |
| UA-110 | Audit log timestamps: rows written by the generic audit extension (CREATE/UPDATE) are stamped ~5h30 in the future (deactivation at 12:44 IST shows 6:14:57 pm) while explicitly written rows (TOTP_RESET_BY_ADMIN, PASSWORD_CHANGED) are correct; the list is ordered by the wrong value, so the timeline is out of order | High | Stops (audit trail unreliable for investigations) |
| UA-111 | Audit log screen cannot answer "who did X to whom": details show only the changed fields (e.g. {"isActive": false}) with no target name or id; the only filter is entity type; no actor/action/date filter; sign-ins and failed 2FA attempts are not recorded | Medium | Workaround |
| UA-112 | Dues Dashboard calls GET /projects, which accounts may not read (403), so its project filter is empty for the role that uses the screen | Low | No |
| UA-113 | One session per browser: signing in as another user in a second tab replaces the first tab's session (shared cookie); the old tab keeps working until its access token expires | Low | No |
| UA-114 | 28 permissions are checked by no route and used by no screen (table M): admins who tick or untick them believe they change access, but nothing changes | Medium | No (misleading) |

## M. The 28 permissions that do nothing (v0.8.2)
Roles-editor label = the key without its module prefix, under an upper-case module heading (e.g. INVENTORY > "unit.book"); there is no description.
| Group | Keys (label) | What an admin would assume | Actual effect | Recommendation |
|---|---|---|---|---|
| Unit lifecycle | inventory.unit.book, .block, .allot, .register, .cancel, .release | controls who can book/block/allot/register/cancel/release a unit | none: booking, allotment, registration and cancellation are gated by postsales.booking.*; holds by inventory.unit.hold | REMOVE (duplicates postsales.booking.*); merge .block into unit.hold or wire it to the block transition |
| Site visits | presales.site-visit.read, .create, .update | controls site-visit scheduling | none: a site visit is a follow-up, gated by presales.follow-up.* | REMOVE (or wire only if site visits become their own flow) |
| Enquiry delete | presales.inquiry.delete | can delete enquiries | none: no delete route exists | REMOVE (or wire with a soft-delete) |
| Booking edit | postsales.booking.update | can edit bookings | none today | WIRE (already planned for booking custom fields) |
| Post-sales unit | postsales.unit.read, .update | view/edit units after sale | none; duplicates inventory.unit.* | REMOVE |
| Demands / TDS / transfer read | postsales.demand.read, postsales.tds.read, postsales.transfer.read, postsales.transfer.approve | view demands, TDS, transfers; approve transfers | none (demand.generate/raise, tds.certificate, transfer.create are the live keys; no transfer approval step exists) | WIRE when the UA-076/UA-103 screens are built (transfer.approve = maker-checker), else REMOVE |
| Documents | postsales.document.read, .upload, .delete | manage booking documents | none (no document upload exists) | REMOVE; the documents plan deliberately uses new keys because these are granted widely |
| Accounts duplicates | accounts.receipt.verify, accounts.payment.read, accounts.payment.create | verify receipts; manage payments | none: cheque verification uses postsales.cheque.verify; refunds use postsales.refund.* | MERGE receipt.verify into postsales.cheque.verify; REMOVE payment.* |
| Reports | reports.gst.view, reports.custom.create | GST report; build custom reports | none: no GST report, no report builder | WIRE gst.view with a GST report (CA need); REMOVE custom.create |
| Portal | portal.booking.read, portal.receipt.read, portal.document.upload | unticking hides bookings/receipts from customers; allows uploads | none: portal reads are enforced by surface + RLS, not these keys; no upload route | WIRE booking/receipt.read as real gates (defence in depth) or REMOVE; REMOVE document.upload until uploads exist |

## N. Architect review of P5a (2026-10-03)
| ID | Title | Severity | Pilot impact |
|---|---|---|---|
| UA-116 | Deactivation does not end an active session for up to the access-token lifetime (15 min); reads and writes continue (seen: deactivated exec created an enquiry, 201). Documented "Session lifetime" trade-off, not a hidden flaw. Assigned to v0.8.3 (plan part H): check isActive/role on every request via a short-TTL Redis cache invalidated on deactivate/role change. v0.8.2 admin actions already load the caller fresh | Medium | Workaround (rotate quickly / wait 15 min) |
UA-106 RAISED to Medium: upgrades never sync non-super_admin system-role permissions, so any fix to a seeded role (e.g. the broker access accounts needs for UA-105) will not reach existing installs. Added to v0.8.3 as prerequisite part I (add-only sync; design question: telling "admin removed it" from "never had it").

UA-110 ROOT CAUSE (read-only): `audit_logs.created_at` is `TIMESTAMP(3)` WITHOUT time zone, and the app treats every such column as UTC. Rows created through Prisma (explicit rows such as TOTP_RESET_BY_ADMIN, PASSWORD_CHANGED) get a UTC value from the client and are correct. The generic audit extension (`packages/db/src/audit.extension.ts`, raw `INSERT ... created_at = NOW()`, since v0.7.1) lets Postgres fill the value: `NOW()` cast to a timestamp-without-time-zone column stores the SESSION's local wall clock, and the VM's Postgres session timezone is Asia/Kolkata, so the row holds IST time; the UI reads it as UTC and adds 5h30 again. Same raw-`now()` pattern, same skew, elsewhere: `password_resets` / `portal_password_resets` / `portal_invites` `consumed_at`, `number_sequences` created/updated_at, round-robin `last_assigned_at`, webhook `disabled_at`. None of these is compared against a UTC value (expiry checks run in app code; `consumed_at` is only tested for null; round-robin only orders by its own column), so the impact is wrong display/ordering, not access or money. Financial tables (ledger_entries, receipts, bookings, installments) are written through Prisma and are NOT affected. Fix: write `now() AT TIME ZONE 'UTC'` (the pattern the TOTP lockout already uses) or let Prisma supply the value; correcting existing audit rows needs a judgement call (they are append-only and the offset depends on each server's timezone).

## O. UA-115 — Custom fields: builder flexibility (intent vs current state)
Owner's intent: builders add their own fields (customer profession, location, income range, anything they need). Links: UA-047, UA-048, UA-096.
Current state (read-only, code + browser):
- Entities: definitions can be created for INQUIRY, APPLICANT, PROJECT, UNIT and BOOKING; values are accepted by the API for INQUIRY, APPLICANT, PROJECT, UNIT; BOOKING is marked "unsupported" in the admin screen. Screens that capture values: Add Inquiry (inquiry + applicant fields) and the project screens. No screen captures UNIT values (UA-096) or edits APPLICANT values later.
- Types: TEXT, NUMBER, DATE, BOOLEAN (yes/no), SELECT, MULTI_SELECT.
- Lists / filters / exports / reports: not shown as columns in any list; the API filters by exact match only and no screen offers a filter; the enquiry CSV export includes one column per active field but with raw headers such as "applicant.Reference check" (UA-058); no report uses them.
- Who can see/fill: field definitions are readable only with admin.custom-field.read (admins). Managers and executives get 403 on GET /custom-fields, so they never see the fields and cannot fill them (UA-047). Portal users never see values (withheld by design).
- Required: enforced on the server even where the form cannot show the field, which dead-ends every non-admin (UA-047). The required flag cannot be edited after creation and a deactivated field cannot be reactivated (UA-048).
- No "sensitive" flag; no link to consent.
Gaps against the intent / requirements to recommend:
1. Fields visible and fillable by anyone who can create or edit that record (definitions readable with the record's own read permission, not admin.custom-field.read).
2. "Required" enforced only where the field is actually shown to that user.
3. Required toggle editable; deactivated fields can be reactivated.
4. Applicant-level fields for person data (profession, income range), entered once per buyer and editable on the applicant (needs the applicant edit screen, UA-104).
5. A "sensitive" flag restricting visibility to managers/admins, tied to the consent screen (DPDP), and masked in exports for others.
6. Fields available as list columns, list filters and CSV export with readable headers (the field label).
7. UNIT and BOOKING value capture (UA-096; booking needs the frozen-core decision already noted in the documents plan).
Severity: High (the feature exists but cannot serve its main purpose for the people who enter data). Pilot impact: Workaround (admins enter values themselves).

## P. Phase 5b — portals (2026-10-03)
Passed: SF-01 regression (customer and broker sessions get 403 "This session type may not access this route" on every staff API tried: inquiries, users, bookings/:id, brokers, applicants, roles, company config, cheque queue, commission balance, staff document download); account-type APIs refused (customer -> broker routes 403/400; broker -> customer routes 400/403); another broker's statement and NOC, the customer's ticket as broker, and both broker statements as the customer return 404; used invite and bad reset token refused with clear messages; all portal pages fit 390px.
| ID | Title | Severity | Pilot impact |
|---|---|---|---|
| UA-117 | Portal pages of the other account type render empty shells with misleading text ("Could not load your profile", "No property found on your account yet", broker headings for a customer) instead of a redirect or "not available for your account" | Low | No |
| UA-118 | Broker can reach a working "Raise query" support page by URL, but the broker menu has no Support tab (broker holds ticket create/read) | Low | No |
| UA-119 | Invite and reset pages do not check the link on load: a used/expired link is only refused after the user has typed a new password | Low | No |
| UA-120 | Portal Account page has 6 tap targets under 32px (document download links) | Polish | No |
Not testable from the UI: an expired invite (7-day expiry; would need waiting or a DB edit). PAN masking in the portal not judged: the test buyer has no PAN on file.

## Q. Phase 7 — backup and restore drill (same VM, 2026-10-07)
Result: PASS. Bundle /var/backups/openestate/20261007-095127 (1 MB). Fingerprint taken at backup time (row counts of 18 tables, users digest incl. password hashes and TOTP secrets, PAN ciphertext digest, role_permissions digest, ledger balance per booking, latest receipt number, number sequences, env-file sha256, newest PDF sha256, whole uploads-tree digest) matched exactly after restore; both after-backup markers (an inquiry_sources row and an uploads file) were gone; services active, no API errors, health ok. Browser checks pending the owner (see run notes).
| ID | Title | Severity | Pilot impact |
|---|---|---|---|
| UA-121 | Backups are written to the same disk (/var/backups/openestate) by default; the docs do not instruct an off-box copy, so a dead server takes the backups with it | Medium | Workaround (manual copy) |
| UA-122 | restore-native.sh stops the API and drops the database BEFORE it knows the dump loads; a bad dump means downtime with no automatic way back. Restore into a temporary database first, then swap | Medium | Workaround (VM snapshot) |
| UA-123 | Redis is not backed up: sessions, rate-limit counters and queued jobs (pending notifications, webhook retries) are lost on restore | Low | No |
| UA-124 | Numbers are reissued after a rollback restore: receipts/bookings created after the backup vanish and their numbers are issued again, so a receipt already given to a customer can collide with a new one. Needs a documented policy (e.g. note the last number before restoring, void the gap) | Medium | Policy/docs |
| UA-125 | Backup bundles carry no checksums; nothing verifies a bundle before restore (the drill script added sha256 itself) | Low | No |
| UA-126 | PILOT PREREQUISITE: restore onto a NEW server (fresh install, different keys) has never been drilled; it needs install-native.sh first, then restore with --restore-env so PAN/2FA ciphertext decrypts. Must be drilled before pilot go-live and the env-first order documented | High | Required before pilot |
| UA-127 | Service account home = uploads dir (`openestate` user, nologin shell, home `/var/lib/openestate/uploads`); its shell dotfiles (e.g. `.bash_logout`) end up in every backup. nginx does not serve the folder (only `/api/` proxy, `/portal/` and `/` static from `/opt/openestate/current`); files reach users only through authenticated API routes. Fix: set a separate home | Low | No |
