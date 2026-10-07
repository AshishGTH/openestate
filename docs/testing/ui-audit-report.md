# OpenEstate v0.8.2: UI/UX audit report

Untracked draft for the owner. Audit run on the test VM (http://192.168.1.20),
2026-10-02 to 2026-10-07, phases 1, 2a, 2b, 3, 4, 5a, 5b and 7. Full detail of every
item is in `ui-audit-findings.md`; the day-by-day log is in `ui-audit-run-notes.md`.
Tax and legal items describe what the product does, not what the law requires: each
needs a Chartered Accountant (CA) to confirm.

---

## 1. Executive summary

**Is OpenEstate ready for a real builder today? Not yet, but the gap is mostly
around the edges, not in the foundation.**

What is solid:
- **Money is never lost or rewritten.** Every payment, charge and correction is
  recorded permanently, and the balance always equals what was charged minus what
  was paid. I checked this by hand at every step and it never failed. Nothing
  financial can be edited from a screen; mistakes are corrected with a reversal.
- **People only see what they should.** Sales executives see only their own leads,
  managers see their team, customers see only their own booking, brokers see only
  their own figures. Attempts to reach someone else's data were refused.
- **Backup and restore work.** A full backup was taken, the system was changed, and
  the restore brought back every record, password, encryption key and file exactly.

What stops a pilot today (detail in section 4):
1. **Some prices come out wrong.** A 5% preferred-location charge (PLC) is
   calculated on the per-square-foot rate instead of the price: on a Rs 50 lakh flat
   it came out as Rs 250 instead of Rs 2.5 lakh, so the customer's whole payment
   schedule was Rs 2.62 lakh too low.
2. **The booking screen makes errors easy.** It suggests the per-sq-ft rate as the
   agreed price, never shows the GST or final payable amount, and if the payment
   plan fails it still leaves a half-made booking behind.
3. **Payments cannot be recorded to the paisa**, so some instalments can never be
   marked fully paid.
4. **GST choices are limited and out of date.** Only two old seeded rates are
   offered, there is no "no GST" option, and adding a correct rate is blocked by an
   overlap rule.
5. **The receipt PDF is too thin to hand to a customer** (no GSTIN, RERA number,
   amount in words, GST split or addresses), and a bounced cheque's receipt can
   still be downloaded as if it were valid.
6. **Important screens are missing although the server already supports them:**
   refunds, cancellation follow-up, transfers, receipt reprint, TDS entry, a list
   of all bookings, and approving a customer's profile change. **Late-payment
   interest is different:** no route can attach an interest rule to a booking, so
   interest never accrues. That needs backend work, not just a screen.
7. **Custom fields block the sales team.** If an admin makes a custom field
   "required", sales staff cannot create any lead at all, because they are never
   shown the field.
8. **Several settings do nothing** (date format, renaming a term such as
   "Inquiry" to "Lead" (the one tested; the saved setting is never read for any
   term), switching modules off, financial-year start), which misleads the admin
   who sets them.
9. **Audit log times are wrong by 5 h 30 min** for most entries, so the history
   is out of order.

**Recommendation:** ship the security and integrity release (v0.8.3) first, then a
"pilot readiness" release (v0.9) that fixes the money and booking problems and adds
the missing screens. Before a real customer goes live: a CA review of GST and TDS,
a restore drill on a fresh server, TLS (https) set up, and a decision on email/SMS.

---

## 2. What works well

- **Ledger:** append-only, balances reconcile on every step, bounces and
  cancellations post clean reversals, excess payment spills to the next instalment.
- **Team visibility:** executive / manager / no-manager scoping behaved exactly as
  designed; the manager dashboard and "My Day" overdue follow-ups worked.
- **Duplicate detection:** the same phone number is recognised whether typed plain,
  with +91 or with a leading 0, and "Confirm distinct" is offered.
- **Portals:** the customer and broker portals show only that person's data, refuse
  staff pages and each other's pages, and fit a phone screen (390 px) with no
  sideways scrolling.
- **Staff roles:** the server refuses every action a role does not hold; v0.8.2's
  "you cannot act beyond what you hold" rule held in the browser.
- **Masters that are used:** inquiry sources, banks, unit/project/PLC/charge types,
  locations, follow-up types and lead stages appear where they should.
- **Letters:** names, unit, floor, project and lakh-formatted amounts fill
  correctly.
- **Backup and restore:** same-server rollback restored the data byte-for-byte
  (record counts, password and 2FA secrets, encrypted PAN, ledger balances,
  receipt numbers, files and keys all matched).

---

## 3. Post-sales assessment

The ledger engine is sound. Every figure is append-only, the booking balance always
equals charges minus receipts plus reversals, nothing financial can be edited from
the screens, and bounce, cancellation, overpayment spill-over and commission/TDS
postings all behaved consistently.

The defects sit **around** the engine, not inside it:
- **Pricing inputs:** price default (UA-069), PLC maths (UA-070), GST rate choice
  and no-GST option (UA-072, UA-082, UA-030, UA-031).
- **The booking wizard:** half-made bookings (UA-067), no GST or payable preview
  (UA-071).
- **Precision:** whole-rupee receipt fields against paisa schedules (UA-068).
- **Documents:** thin receipt (UA-073), bounced receipt still downloadable (UA-083),
  no buyer address anywhere (UA-066).
- **Missing operations:** refunds, transfers, reprints, plan edit, TDS entry
  (UA-103, UA-076). Interest cannot be attached to a booking at all, so it never
  accrues (UA-091; needs backend work).

Worked example (one test flat, recomputed by hand): base Rs 50,00,000 + 5% PLC +
Rs 1,00,000 club charge, GST as configured. Expected total **Rs 56,24,500.00**;
the product produced **Rs 53,62,262.50**, short by Rs 2,62,237.50, all of it the
PLC defect. Every instalment was short by 4.66%.

Broker commission: the base is currently always the GST-inclusive price. That is
not wrong as such; the right base depends on each builder's broker agreement, so
it should be a setting on the commission rule (UA-077). Accrual is a manual button.

Which fixes touch the frozen Phase 4 financial core: CLAUDE.md has no written
list of frozen files. I treated the Phase 4 services in `apps/api/src/postsales/`
(booking, payment-plan, receipt, ledger, interest, cancellation, transfer, refund,
extra-charge, `gst.util.ts`) and the shared money utilities as frozen, and
controllers, UI, inventory, masters and documents as not frozen. Per fix, read from
the code, in the table in section 4.

---

## 4. Fix before pilot (ranked, blockers first)

Size: S = days, M = about a week, L = several weeks. "UI only" means the server
already supports it; per the project's own rule each still needs a real-browser
check, because that server code has never been used through a screen.

### Blockers (stop a pilot)

"Frozen core?" is a factual reading of the code (file named); the definition is in
section 3.

| # | ID | Problem | Size | Where | Frozen core? |
|---|---|---|---|---|---|
| 1 | UA-070 | PLC % applied to rate, not price (wrong money) | S | Backend (`inventory/unit-pricing.service.ts`, `addPlc` multiplies the per-sq-ft rate); the wizard only forwards the stored amount | **No** (inventory service, not a postsales file) |
| 2 | UA-069 | Agreed price defaults to the per-sq-ft rate | S | UI (`BookingWizard.tsx`) | **No** |
| 3 | UA-068 | Money in whole rupees only against paise schedules | S-M | **Design decision, see below** | (a) No; (b) yes, see below |
| 4 | UA-067 | Failed plan leaves a half-made booking | M | Backend: one endpoint that creates booking + plan in one outer transaction (the Phase 5 pattern) | **No** if done in `booking.controller.ts` (unfrozen since Phase 5); `BookingService.createBooking` and `PaymentPlanService` stay untouched |
| 5 | UA-082 | No "no GST" option: the base line must carry a GST rate | M | Backend + UI | **Yes** (`postsales/booking.service.ts`, base-line rate resolution, fail-loud since commit 235fd59) |
| 5 | UA-072, UA-031 | Stale seeded GST rates; picker offers only those | S | Seed data (`packages/db/prisma/seed.ts`) + wizard picker | **No** |
| 5 | UA-030 | GST rates cannot overlap, even when different | S-M | Backend (`masters/gst-rate/gst-rate.service.ts`, Phase 1) | **No** |
| 6 | UA-071 | Confirm screen shows no GST or payable total | S | UI (`BookingWizard.tsx`) | **No** |
| 7 | UA-073, UA-066, UA-034, UA-022 | Receipt/letters lack GSTIN, RERA, words, GST split, addresses; no buyer or company address fields | M | Backend (schema + PDF/document code) + UI | **No** (document/PDF code is Phase 4-UI, not a ledger service) |
| 8 | UA-083 | Bounced cheque's receipt downloadable as valid | S | Backend (receipt PDF + portal document list) | **No** |
| 9 | UA-076 | No screen to record TDS 194-IA or certificates | M | UI only (`receipt.service.ts` already accepts `tdsDeductedPaise`) | **No** |
| 10 | UA-091, UA-012 | No route attaches an interest rule to a booking; interest never accrues | M | Backend + UI | **Likely (booking).** `Booking.interestRuleId` exists and `interest.service.ts` reads it; nothing writes it. No frozen file needs editing if a controller call sets it (like `POST /bookings/:id/broker`, Phase 5 precedent); **yes** (`booking.service.ts`) if it is set at creation |
| 11 | UA-103, UA-014 | No refund, transfer, reprint, plan edit, extra charge, receipt reversal screens | L | UI only (APIs exist) | **No** |
| 12 | UA-047, UA-019, UA-115 | Required custom field blocks all lead creation by sales staff | M | Backend (permissions) + UI | **No** |
| 13 | UA-097, UA-016 | Customer profile-change requests can never be approved | S | UI only | **No** |
| 14 | UA-105 | Accounts role cannot pay broker commission | S | Backend (role) + UI; existing installs need UA-106 | **No** |
| 15 | UA-029 | Payment plan templates cannot hold milestones | M | Backend + UI | **No** (templates are masters; `PaymentPlanService` already reads milestones) |
| 16 | UA-110 | Audit log times 5 h 30 min wrong, order broken | S | Backend (`packages/db/src/audit.extension.ts`) | **No** |

#### UA-068: a design decision, two options

Today the receipt field (`ReceiptEntry.tsx`) is a number box with no decimal step,
so the browser refuses paise. The server accepts paise, and the plan generator
produces them.
- **(a) Receipts accept paise.** UI only (the field and the "auto-fill" amount).
  **Not frozen** (`apps/web`). Simple and always exact, but staff and customers
  then deal in paise.
- **(b) Payment schedules are generated in whole rupees**, with the rounding
  remainder on the last instalment (common in Indian property billing). The
  generator is `allocate` in `postsales/payment-plan.service.ts` (template and
  custom plans) with `packages/shared/src/money.ts`: **yes, frozen** (Phase 4)
  if done there. The wizard could round its own custom amounts without touching
  the service, but template plans would not follow.
- **Recommendation: (b)**, subject to CA input, because it matches how builders
  actually bill. If frozen-core approval for (b) is not given, do (a) first: it is
  safe and still needed for any amount that has paise.

### High, with a workaround

| ID | Problem | Size | Where | Frozen core? |
|---|---|---|---|---|
| UA-100 | No list of all bookings, no bookings/ledger CSV | M | Backend + UI | No |
| UA-104, UA-015 | No edit applicant, merge duplicates, consent capture | M | UI only | No |
| UA-098 | No document upload (KYC) | L | Backend + UI (already planned: documents plan) | No |
| UA-001 | No email/SMS provider; users not told | S + decision | UI + decision | No |
| UA-002 | Plain HTTP with no warning | S | UI | No |

### Medium: configuration that does nothing, and other gaps

| ID | Problem | Size | Where |
|---|---|---|---|
| UA-086, UA-033, UA-052, UA-021 | Date format/currency/timezone settings ignored; US dates on screen | M | UI + PDFs |
| UA-087, UA-020 | Renaming a term ("Inquiry" was tested; the setting is never read for any term) never shows anywhere | M | UI + PDFs |
| UA-088 | Module on/off switches do nothing | M | UI + backend |
| UA-089 | FY start month does not affect numbering (CA to confirm policy) | S | Backend |
| UA-090, UA-011, UA-025 | Masters that nothing reads | S | Hide or wire |
| UA-092, UA-013 | Bounce charge, commission policy, lead ownership have no settings screen | S | UI |
| UA-114, UA-017 | 28 permissions that change nothing | S | Remove or wire |
| UA-074 | Uncleared cheque reduces the balance at entry | M | Backend, **frozen** (`postsales/receipt.service.ts`, `ledger.service.ts`) if the policy changes |
| UA-075 | Bounce charge: no setting, no GST, schedule shows a different total from the ledger | M | Settings screen: not frozen. "Total due" is computed in `InstallmentSchedule.tsx` (UI): not frozen. Changing what is posted (GST on the charge): **frozen** (`receipt.service.ts`) |
| UA-077, UA-078, UA-084 | Commission base not configurable; TDS withheld not shown to staff; broker sees totals only | M | Backend (commission, not frozen) |
| UA-111 | Audit log cannot answer "who did what to whom" | M | UI + backend |
| UA-121, UA-122, UA-124 | Backups on the same disk; restore drops the DB before checking the dump; reused numbers after rollback | S-M | Scripts + docs |
| UA-046, UA-064 | No first-day setup guidance; every install is "Demo Realty" | M | Installer + UI |

All remaining Medium, Low and Polish items are in the index (section 7).

---

## 5. Roadmap

### v0.8.3: security and integrity hardening (ship first). Size: Medium

| Part | What | Size |
|---|---|---|
| Part S | A portal hardening item tracked privately; ships first | S |
| A | Restore the 71 database foreign keys | M |
| B | CI guards so such keys can't be dropped silently again | S-M |
| G | Harden the append-only escape hatch | S |
| — | Upgrade-script fix: tag fetch fails on clones made before the history rewrite | S |
| — | UA-110 audit timestamps (write UTC; decide on existing rows) | S |
| H | UA-116 end a session when a user is deactivated or their role changes | S-M |
| I | UA-106 safe sync of seeded system-role permissions on upgrade | M |
| — | Remove the SessionSurfaceGuard fallback for old tokens | S |

### v0.9: pilot readiness. Size: Large (split into 3-4 PRs)

Ordered so that work that does **not** depend on the CA comes first. The GST,
receipt and TDS work starts only after the CA review (section 6, item 2).

**Part 1: no CA dependency (start immediately)**
1. **Booking wizard and pricing (S-M each):** UA-070, UA-069, UA-068 (decision
   above), UA-067, UA-071, UA-083 (mark bounced receipts).
2. **Missing screens (L):** UA-103 (refund, transfer, reprint, plan edit, extra
   charges), UA-097 (change requests), UA-100 (bookings list), UA-105 (accounts
   commission), UA-029 (plan templates). Interest (UA-091, UA-012) needs backend
   work (M; frozen-core question in the table above).
3. **Custom fields that work for sales staff (M):** UA-115 items 1-3 and 6
   (UA-047, UA-048, UA-096).
4. **Config that does nothing (M):** wire or hide UA-086, UA-087, UA-088, UA-090,
   UA-092, UA-114 (UA-089 FY numbering waits for the CA).
5. **Presales: phone identity + applicant edit/merge/consent (M-L).** Item 7 of
   the owner's approved list, agreed before this audit and **not built**: a phone
   number as the universal identifier (one normaliser at every entry point, a
   saved "confirmed distinct" decision per pair, and a per-company strictness
   setting for automated entry). Evidence from this audit: UA-004 (phone
   normalisation inconsistent), UA-050 (duplicates are warned about but never
   prevented or merged; the test data has **4 applicants for one phone**, UA-079)
   and UA-104 (no applicant edit, merge or consent screens). The consent screen
   needs the lawyer check in section 6.

**Part 2: after the CA review**
6. **GST (M; frozen-core approval needed for UA-082):** UA-072, UA-031, UA-030,
   UA-082, UA-074/UA-075 policy, UA-089 numbering.
7. **Receipt and letter compliance (M):** UA-073, UA-066, UA-034, UA-022, UA-093
   (company and buyer addresses, GSTIN, RERA, amount in words, GST split,
   DD-MM-YYYY).
8. **TDS screens (M):** UA-076.

Later: document upload (UA-098, already planned), booking custom fields, a
second-company screen (UA-101), polish items.

---

## 6. Non-code pilot prerequisites

1. **Secure a pilot builder.** This is the highest-value activity: their real needs
   should shape the v0.9 priorities, and several open questions below are theirs
   to answer (GST yes/no, commission base, plan style).
2. **CA review of GST and TDS (start now).** Place of supply, rates per charge
   type, whether a given builder charges GST at all, TDS 194-IA on receipts and
   194-H on commission, commission base, receipt numbering by financial year,
   whole-rupee schedules (UA-068). Its answers are an input to the v0.9
   GST/receipt/TDS work (Part 2), which should not start before them (UA-061).
3. **Lawyer check of DPDP Act consent requirements.** What consent capture, wording
   and retention the consent screen (UA-104) must provide. The product supplies
   tools; it does not claim compliance.
4. **Restore drill on a NEW server** (UA-126): fresh install, then restore with the
   original keys (`--restore-env`) so encrypted PAN and 2FA data still open. Only a
   same-server rollback has been drilled so far. Also decide where backups are
   copied off the server (UA-121) and the policy for receipt numbers created after
   the last backup (UA-124).
5. **TLS (https) in front of the install.** Without it passwords travel in plain text
   (UA-002).
6. **Email/SMS provider decision** (UA-001). Until then password resets go through
   admin-generated links.
7. **Rotate all test-VM passwords after the audit.** Several accounts' passwords
   were handled during testing.
8. **Owner browser check after the restore drill (~2 min), still PENDING:**
   1. Staff: sign in as the admin; the dashboard loads.
   2. Customer portal: sign in as UIAUDIT Buyer One; Account shows booking
      BKG/2026-27/000004.
   3. 2FA: the 2FA test user has 2FA off since Phase 5a; enrol in Settings, sign
      out, sign in with a code.
   4. Broker PAN: admin, Brokers, UIAUDIT-Broker-01, Reveal; the PAN shows.
   5. Receipt: admin, Applicant 360 of UIAUDIT Buyer One, download RCP/2026-27/000001;
      it opens and the number is unchanged.
9. **Remove the test data** listed in the run notes before any real use of this VM,
   or start the pilot on a fresh install.

---

## 7. Findings index

Severity as last rated (architect re-ratings applied). "CA" = to confirm by a
Chartered Accountant.

| ID | Title | Severity |
|---|---|---|
| UA-001 | No email or SMS provider connected | High |
| UA-002 | Plain-HTTP install gives no warning | High |
| UA-003 | No screen for a second company | Low |
| UA-004 | Phone numbers normalised inconsistently | Medium |
| UA-005 | Super Admin role page offers edits that are refused | Low |
| UA-006 | Own user record offers role change, then refuses | Low |
| UA-007 | Role editor lets you tick permissions you don't hold | Low |
| UA-008 | Non-super admin sees enabled controls on a super admin's page | Low |
| UA-009 | "Reset 2FA" disabled when 2FA is off hides the refusal path | Low |
| UA-010 | Refused save shows both toast and banner | Polish |
| UA-011 | Several masters change nothing | Medium |
| UA-012 | Interest rules never take effect | High |
| UA-013 | Bounce charge and commission settings cannot be set | Medium |
| UA-014 | Post-sales screens missing | High |
| UA-015 | Pre-sales screens missing (consent: High) | Medium |
| UA-016 | Staff cannot approve a profile-change request | High |
| UA-017 | 28 permissions checked nowhere | Low |
| UA-018 | Portal pages not restricted by account type | Low |
| UA-019 | Sales roles cannot see custom fields | High (see UA-047) |
| UA-020 | Terminology and enabled modules change nothing | Medium |
| UA-021 | Currency, timezone, date format change nothing | Low |
| UA-022 | GSTIN, RERA, address missing from letters | Medium |
| UA-023 | No hold/block/release for a unit | Medium |
| UA-024 | Sales execs may get empty user dropdowns | Medium |
| UA-025 | Inquiry Types and Receipt Types never used | Low |
| UA-026 | Several admin edits missing | Low |
| UA-027 | Letter templates have no edit/delete; Project active flag does nothing | Low |
| UA-028 | Native confirm dialog freezes automated screenshots | Polish |
| UA-029 | Payment plan templates cannot hold milestones | High |
| UA-030 | GST rates cannot overlap even when different (CA) | High |
| UA-031 | Seeded GST rates out of date (CA) | High |
| UA-032 | GSTIN checked for format only | Low |
| UA-033 | US date format seeded; setting changes nothing | Medium |
| UA-034 | No place for company address, PAN, registration numbers | Medium |
| UA-035 | Developer wording on screens | Polish |
| UA-036 | Saving gives no clear confirmation | Medium |
| UA-037 | Tower shows "0 floors" | Low |
| UA-038 | Base Rate has no unit; PLC looks wrong | Medium (see UA-070) |
| UA-039 | Pricing panel opens at page bottom | Polish |
| UA-040 | Area/Location asks for state twice | Low |
| UA-041 | GST place of supply hidden behind Area/Location | Medium |
| UA-042 | Masters lists show too little | Low |
| UA-043 | Users list has no manager column | Low |
| UA-044 | Org chart lists portal accounts as staff | Low |
| UA-045 | Leftover test admin and demo data on the install | Medium |
| UA-046 | No first-day guidance for a new builder | Medium |
| UA-047 | Required custom field blocks all lead creation | High |
| UA-048 | Custom field cannot be made optional or reactivated | Medium |
| UA-049 | Add Inquiry form collects too little (no email, notes, consent) | Medium |
| UA-050 | Duplicates warned but no merge (corrected in Phase 4) | Medium |
| UA-052 | Follow-up dates in US style | Medium |
| UA-053 | No mark-done/reschedule for follow-ups | Medium |
| UA-054 | Stage changes show no history or message | Medium |
| UA-055 | Logging a follow-up silently changes status | Low |
| UA-056 | Enquiry list lacks assigned-to, stage, next follow-up | Medium |
| UA-057 | Enquiry list too wide on a phone | Low |
| UA-058 | CSV export: no BOM, raw headers, shown to refused roles | Medium |
| UA-059 | Inaccessible lead shows "Loading…" forever | Low |
| UA-060 | Inbound API creates a second enquiry for the same phone | Low |
| UA-061 | PILOT PREREQUISITE: CA review of GST and TDS | Required |
| UA-062 | Sales sidebar shows admin pages (server refuses) | Low |
| UA-063 | Leftover test enquiries | Low |
| UA-064 | Every install starts as "Demo Realty" | Medium |
| UA-065 | Installer wrongly says the admin password is in the journal | Low |
| UA-066 | No applicant correspondence address | High |
| UA-067 | Failed plan leaves a half-made booking | High |
| UA-068 | Receipt fields whole-rupee only | High |
| UA-069 | Agreed price defaults to per-sq-ft rate | High |
| UA-070 | PLC % applied to rate, not price | High |
| UA-071 | Confirm screen shows no GST or payable total | High |
| UA-072 | GST picker offers only stale rates (CA) | High |
| UA-073 | Receipt PDF lacks statutory content (CA/RERA) | High |
| UA-074 | Uncleared cheque already reduces balance | Medium |
| UA-075 | Bounce charge: no setting, no GST, two different balances | Medium |
| UA-076 | No TDS 194-IA screens (backend exists) | High |
| UA-077 | Commission base not configurable; manual accrual | Medium |
| UA-078 | TDS 194-H not shown on staff broker screen | Medium |
| UA-079 | Cancelled booking offered in Receipt Entry | Medium |
| UA-080 | Ledger hidden until a row is clicked; no GST detail | Low |
| UA-081 | Developer wording in master names | Low |
| UA-082 | No way to charge no GST (CA) | High |
| UA-083 | Bounced receipt downloadable; cancelled booking shown in portal | High |
| UA-084 | Broker portal shows totals only | Medium |
| UA-085 | Invite expiry shown in minutes | Polish |
| UA-086 | Date Format setting changes nothing | Medium |
| UA-087 | Terminology overrides never used | Medium |
| UA-088 | Module toggles do nothing | Medium |
| UA-089 | FY start month does not affect numbering | Medium |
| UA-090 | Masters nothing reads | Medium |
| UA-091 | Interest rules cannot be attached to a booking (no route sets it; backend needed) | High |
| UA-092 | Bounce charge and policies have no settings UI | Medium |
| UA-093 | Letter templates: blank fields, no RERA/GSTIN, ISO dates | Medium |
| UA-094 | Lead stage decimal sort order fails silently | Low |
| UA-095 | Every Generate stores another letter copy | Low |
| UA-096 | Unit custom field values cannot be captured | Medium |
| UA-097 | Profile change requests have no staff screen | High |
| UA-098 | No document upload | High |
| UA-099 | Change request allows email only | Low |
| UA-100 | No bookings list | High |
| UA-101 | No way to create a second company | Medium |
| UA-102 | Assign To lists every user; bare 404 on refusal | Medium |
| UA-103 | Booking lifecycle screens missing | High |
| UA-104 | Presales screens missing (edit, merge, consent, pool); DPDP consent requirements to be confirmed by a lawyer | High |
| UA-105 | Accounts cannot pay broker commission | High |
| UA-106 | Upgrades don't sync seeded role permissions | Medium |
| UA-107 | Read-only roles see write controls | Low |
| UA-108 | Lead can be assigned to a portal account | Medium |
| UA-109 | 2FA error wording; raw throttle message | Low |
| UA-110 | Audit log timestamps 5 h 30 min off | High |
| UA-111 | Audit log cannot answer who did what to whom | Medium |
| UA-112 | Dues Dashboard project filter empty for accounts | Low |
| UA-113 | One session per browser | Low |
| UA-114 | 28 permissions that change nothing | Medium |
| UA-115 | Custom fields don't serve builders' data entry | High |
| UA-116 | Deactivation does not end an active session (15 min) | v0.8.3 part H |
| UA-117 | Wrong-account portal pages render empty shells | Low |
| UA-118 | Broker support page has no menu tab | Low |
| UA-119 | Invite/reset pages don't check the link on load | Low |
| UA-120 | Small tap targets on portal Account page | Polish |
| UA-121 | Backups written to the same disk | Medium |
| UA-122 | Restore drops the database before checking the dump | Medium |
| UA-123 | Redis not backed up | Low |
| UA-124 | Numbers reissued after a rollback restore | Medium |
| UA-125 | Backup bundles carry no checksums | Low |
| UA-126 | PILOT PREREQUISITE: new-server restore never drilled | High |
| UA-127 | Service account home = uploads dir; dotfiles end up in backups; set a separate home (nginx does not serve this folder; API only) | Low |

(UA-051 was not used.)
