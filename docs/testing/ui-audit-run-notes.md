# UI audit run notes (untracked)

Original values are recorded here BEFORE any change, so each can be restored.
No passwords, no personal data.

## Session 1 (Phase 1), start 2026-10-02 22:55 local (17:25 UTC). VM clock offset: -1 s.

Browser: owner's normal Chrome profile (only one profile is connected to the
extension). Signed in as admin@demo-realty.com.

### Original Company Config (before Phase 1 changes)
| Field | Original |
|---|---|
| Company Name | Demo Realty Pvt. Ltd. |
| Terminology (Unit/Project/Tower/Floor/Booking/Inquiry) | defaults (same words) |
| Modules (Presales / Postsales / Accounts) | all ticked |
| GSTIN | 09ABCDE1234F1Z5 |
| GST State Code | 09 |
| Currency | INR |
| Timezone | Asia/Kolkata |
| FY Start Month | 4 (April) |
| Date Format | MM-DD-YYYY |
| Logo URL / Accent colour | empty / empty |
| Max files per project / Max storage per project | 50 / 524288000 bytes |

### Phase 1 setting (starting config for the audit)
Company name `UIAUDIT Builders Pvt. Ltd.`, GSTIN `06AAAPZ9999Z1Z5` (fake, Haryana),
state code `06`, date format `DD-MM-YYYY` (the India default in CLAUDE.md; the VM
was seeded `MM-DD-YYYY`). Phase 3 changes are restored right after each check.

### Created in Phase 1 (all UIAUDIT-, fake data)
- Company Config saved: name `UIAUDIT Builders Pvt. Ltd.`, GSTIN `06AAAPZ9999Z1Z5`, state code `06`, date format `DD-MM-YYYY` (originals above).
- Masters: Inquiry Source `UIAUDIT-Property Portal`; PLC Type `UIAUDIT-Park Facing`; Charge Type `UIAUDIT-Club Membership` (GST 12% option, HSN 9972); Payment Plan Template `UIAUDIT-Plan 20-30-50` (no milestones possible). A GST 5% rate could not be added (overlap rule).
- Project `UIAUDIT-Proj-HR` (code UIAUDIT01, RERA `RC/REP/HARERA/GGM/UIAUDIT/001`, Residential, Gurugram/06, High-rise), Tower `UIAUDIT-Tower A` (UTA), units UA0101, UA0102, UA0201, UA0202, UA0301, UA0302 (2 BHK, 1000 sq ft, rate 5000). UA0101 has PLC UIAUDIT-Park Facing 5% and charge UIAUDIT-Club Membership ₹1,00,000.
- Broker `UIAUDIT-Broker-01` (phone 9000000301, RERA agent UIAUDIT-RERA-001, PAN AAAPZ9999Z), commission SLAB: ₹0-50,00,000 at 1%, ₹50,00,000+ at 1.5%.
- Role `UIAUDIT-Role-Narrow` (`admin.master.read`, `inventory.project.read`, `presales.inquiry.read`).
- Users (emails @example.invalid, phones 90000001xx): uiaudit-mgr (sales_manager); uiaudit-exec-a (existing, manager set to mgr); uiaudit-exec-b (mgr); uiaudit-exec-d (no manager); uiaudit-accounts; uiaudit-narrow; uiaudit-2fa (mgr; 2FA not yet enrolled).
- Deactivated: a legacy owner test admin account (leftover test admin).
- Not yet created: portal customer and portal broker (after a booking exists). Not restored (intentional): company config stays at the Phase 1 values.
End of session 1: about 23:15 local.

## Session 2 (Phase 2a), 2026-10-03
- CONFIG CHANGE (owner approved): Inquiry custom field `abc` (TEXT, required, active, key abc) DEACTIVATED. Original: Active. Cannot be reactivated from the UI (UA-048).
- Created: enquiries UIAUDIT Buyer One (exec-a, 9000000401), three duplicate-test enquiries (Dup Same / Dup Plus91 / Dup Zero), Buyer Two (exec-b, 9000000402); 3 follow-ups + 2 site-visit entries on Buyer One (stage Documentation); lead API key UIAUDIT-Key created then DISABLED; 3 API leads (9000000403 x2, +919000000401).
- Buyer One is the lead to book in Phase 2b.

## Phase 2b — EXPECTED VALUES (written BEFORE the booking), 2026-10-03
Assumptions to be confirmed in the UI: unit UA0101 = 1000 sq ft, base rate 5000 (per sq ft?), PLC 5%, club charge Rs 1,00,000 with GST 12% option, company state 06, property Gurugram state 06. All tax treatment "to confirm by CA".
- Base price if per sq ft: 1000 x 5000 = Rs 50,00,000 (exactly the Rs 50 lakh boundary). If 5000 is a flat figure: Rs 5,000 (UA-038).
- PLC 5%: of base = 50,00,000 x 5% = Rs 2,50,000 (earlier screen showed Rs 250 = 5% of 5000, i.e. per sq ft; x1000 sq ft = 2,50,000 if applied per sq ft).
- Club charge: Rs 1,00,000; GST 12% = Rs 12,000, intra-state so CGST 6,000 + SGST 6,000. Base and PLC lines expected untaxed (no base-line rate picker, known gap).
- Total consideration = 50,00,000 + 2,50,000 + 1,00,000 + 12,000 = Rs 53,62,000 (above Rs 50 lakh).
- Place of supply: property state 06 (Haryana), NOT buyer address Delhi (07). Expect CGST+SGST, not IGST.
- Custom plan: 10% = 5,36,200; 40% = 21,44,800; 50% = 26,81,000; sum 53,62,000.
- TDS 194-IA (to confirm by CA): applies since price >= 50 lakh; 1% of each payment if buyer deducts.
- Commission: Rs 50,00,000 base sits on the slab boundary, half-open so higher bracket 1.5% = Rs 75,000 if base price; on total 53,62,000 = Rs 80,430; on 53,50,000 (excl GST) = Rs 80,250.

### Phase 2b step 2 ACTUALS (booking BKG/2026-27/000004 for Buyer One, UA0101)
Wizard behaviour that changed the plan (findings): (1) the agreed-price field pre-fills with 5000 (the per-sq-ft rate, NOT rate x 1000 sq ft); I typed 50,00,000 by hand = 1000 x 5000. (2) The GST picker for the base line only offers the two seeded rates (12% pre-2019, 5% affordable): I chose 5% (to confirm by CA). (3) PLC 5% was applied to the RATE 5000 -> Rs 250.00, not to the price (5% of 50,00,000 = 2,50,000 expected). (4) Wizard created the booking BEFORE the plan; a wrong installment sum (400) left booking 000003 with no plan and no broker, and the UI offered only Cancel (I cancelled it). (5) Confirm screen shows only "Total (excl. GST) 51,00,250.00".
Arithmetic (to confirm by CA): base 50,00,000.00 x 5% = 2,50,000.00 (CGST 1,25,000 + SGST 1,25,000); PLC 250.00 x 5% = 12.50 (6.25 + 6.25); club 1,00,000.00 x 12% = 12,000.00 (6,000 + 6,000). Lines incl. GST: 52,50,000.00 + 262.50 + 1,12,000.00 = 53,62,262.50. MATCHES expected total.
Schedule: 10% = 5,36,226.25; 40% = 21,44,905.00; 50% = 26,81,131.25; sum 53,62,262.50 (10% of 53,62,262.50 = 5,36,226.25 exactly).
Place of supply recorded = 06 (property), intra-state, same as company 06 -> CGST+SGST. Buyer address Delhi could NOT be entered: no applicant address field anywhere in UI or API (finding).
Cancelled booking BKG/2026-27/000003 remains in list (number consumed).

### Phase 2b step 3 EXPECTED (before entering receipts)
(a) cheque Rs 2,00,000.00 on installment 1 (due 5,36,226.25): allocated 2,00,000; inst 1 remaining 3,36,226.25; balance after (if cheque posts at entry) 53,62,262.50 - 2,00,000 = 51,62,262.50.
(b) NEFT Rs 3,36,226.25 clears inst 1; balance 48,26,036.25.
(c) NEFT Rs 22,00,000.00 vs inst 2 due 21,44,905.00: excess 55,095.00 -> expect spill to inst 3 (oldest-dues-first) or rejection; balance 48,26,036.25 - 22,00,000 = 26,26,036.25.
TDS 194-IA (to confirm by CA): consideration >= 50 lakh, 1% = 2,000 on (a), 3,362.26 on (b), 22,000 on (c) IF the buyer deducts; shown as TDS receivable until certificate.

### Phase 2b ACTUALS, receipts / bounce / commission (booking BKG/2026-27/000004)
| Step | Expected | Actual | Match |
|---|---|---|---|
| Total consideration | 53,62,262.50 | 53,62,262.50 (agreedPrice 536226250 paise) | yes (club GST 12%, base/PLC 5%, to confirm by CA) |
| Schedule | 5,36,226.25 / 21,44,905.00 / 26,81,131.25 | same | yes |
| Place of supply | 06 intra-state | 06 | yes (buyer Delhi address could not be entered) |
| (a) cheque 2,00,000 | balance 51,62,262.50; inst 1 due 3,36,226.25 | same; cheque still RECEIVED (uncleared) already reduced balance | yes, but counts uncleared cheque |
| (b) clear inst 1 exactly 3,36,226.25 | inst 1 PAID | IMPOSSIBLE: amount field accepts whole rupees only (browser: nearest valid 336226/336227). Paid 3,36,226 -> inst 1 left Rs 0.25 due | NO |
| (c) 22,00,000 vs inst 2 21,44,905 | spill 55,095 to inst 3 | auto-fill proposed 0.25 + 21,44,905 + 55,094.75, but the form rejected its own paise values; entered 0 / 21,44,905 / 55,095; inst 3 got 55,095 | spill works, paise broken |
| Balance after (a)(b)(c) | 26,26,036.25 expected (b as 3,36,226.25) | 26,26,036.50 (0.25 short-paid + 25 paise rounding) = charges 53,62,262.50 - receipts 27,36,226.00 | consistent |
| Bounce of (a) | reversal +2,00,000; charge only if configured | BOUNCE_REVERSAL +2,00,000.00 and BOUNCE_CHARGE +500.00 (default, no settings screen); balance 28,26,536.50 | yes |
| Schedule "Total due" vs ledger balance | equal | 28,26,036.50 vs 28,26,536.50 (the Rs 500 bounce charge is in the ledger, not in the schedule) | NO |
| Commission accrual | 75,000 (price) / 80,430 / 80,250 | 80,433.94 = 1.5% x 53,62,262.50 (GST-INCLUSIVE total) | base = full price incl. GST |
| Commission accrual trigger | automatic on booking | only after clicking "Accrue Broker Commission" | manual |
| Commission payment 50,000 | TDS 194-H shown | request > approve > pay NEFT worked; outstanding 30,433.94 (gross 50,000 deducted); TDS withheld amount NOT visible on the broker screen; statement PDF download stuck (automation quirk), unread | TDS not visible |
Receipt PDF (RCP/2026-27/000001) read visually: company name, "PAYMENT RECEIPT", receipt no, date 2026-10-03 (ISO), booking no, received from, mode CHEQUE (000123), applied towards line, total. MISSING: GSTIN, place of supply, RERA no., amount in words, GST split, unit/project, company/buyer address, PAN, bank name, "subject to realisation". Receipts 2 and 3 not opened individually (same generator).
No TDS 194-IA input exists on the receipt form (to confirm by CA), so the TDS receivable path could not be exercised from the UI.

### Phase 2b end state
Booking BKG/2026-27/000004 (Buyer One, UA0101, broker UIAUDIT-Broker-01): receipts RCP/2026-27/000001 (cheque 2,00,000 BOUNCED), 000002 (NEFT 3,36,226), 000003 (NEFT 22,00,000); ledger balance 28,26,536.50; commission accrued 80,433.94, paid 50,000 gross (TDS 2,500, net 47,500), outstanding 30,433.94. Booking BKG/2026-27/000003 CANCELLED (ghost). Portal accounts created: customer (Buyer One) and broker (UIAUDIT-Broker-01); owner set both passwords. Lead API key UIAUDIT-Key disabled. Inquiry custom field abc deactivated.

## Phase 3 (2026-10-03)
Config changed and restored (verified by reload): Date Format DD-MM-YYYY -> YYYY-MM-DD -> DD-MM-YYYY; Inquiry label Inquiry -> UIAUDIT-Lead -> Inquiry; Accounts module on -> off -> on; FY Start Month 4 -> 1 -> 4.
Left behind (UIAUDIT-): letter templates UIAUDIT-Allotment and UIAUDIT-Demand; masters UIAUDIT-Bank and UIAUDIT-Receipt Type; lead stage UIAUDIT-Stage (deactivated, cannot be deleted); receipt RCP/2026-27/000004 of Rs 1 against booking 000004 (FY test, allocated to installment 3); several generated allotment/demand documents. Unit custom field created and permanently deleted.
Method note: PDF text read by decoding the PDF in the page (fonts' ToUnicode maps); automation downloads stay stuck as .crdownload.

## Phase 4 (2026-10-03)
Created: construction update on UIAUDIT-Proj-HR; customer change request (email); ticket (resolved); applicant+enquiry "UIAUDIT Dup Test" (9000000401). Reassigned UIAUDIT Buyer Two exec-b -> exec-a (manager). Lead API key still disabled.

## Phase 5a (2026-10-03) — partial, stopped at usage limit
Role results so far (menu after expanding groups; direct-URL probe of 20 pages):
- sales_manager: menu Dashboard, Inquiries, Reports, Projects, New Booking, Brokers, Post-Sales Reports, Tickets, Users, Hierarchy, Masters, Letter Templates, Lead Stages, Settings; direct URL to Receipt Entry, Cheques, Dues, Roles, Custom Fields, Config, Audit, Plugins, Webhooks, Lead API Keys = Access denied. Users/Brokers/Masters/Projects show write buttons; Deactivate exec-b refused 403 with toast.
- super_admin: all 24 menu items, all 20 pages ok.
- exec-a: menu Dashboard, Inquiries, Reports, Projects, Masters, Letter Templates, Lead Stages, Settings; all other pages Access denied (a parallel-iframe probe once showed Receipt Entry "ok" with 401 = session refresh race in the probe; direct check = Access denied). Add Project refused 403 + toast. GET /api/v1/custom-fields returns 403 for sales_executive (confirms UA-047 cause).
- accounts: menu Dashboard, Receipt Entry, Cheque Queue, Dues Dashboard, Post-Sales Reports, Settings; Masters DENIED although seed gives accounts admin.master.read (to verify on the VM role); Brokers DENIED although accounts holds commission approve/pay (cannot reach the screen where commission is paid -> likely finding); Dues page has a 403 sub-call.
- Logout then browser Back: lands on /login, no data shown.
Not yet done: accounts write attempt, narrow, 2FA user (enrol/correct/wrong/lockout/admin reset), exec-d probe + deactivate-while-logged-in, company_admin lead-assign-to-portal check (a), audit log check (f), the 28-permission table write-up (list computed: see perms.mjs output in session), findings and checkpoint P5a.
Browser state: signed in as uiaudit-accounts. No config changed in Phase 5a.

### Phase 5a resumed (2026-10-03, ~12:30-12:50 IST)
- accounts: no UI path to any out-of-role write (all such pages Access denied); commission screens unreachable; Masters denied because the VM Accounts role lacks admin.master.read (33 perms).
- narrow: inquiry create, project create, master create all refused 403.
- uiaudit-2fa: enrolled by owner, correct code works, wrong codes -> "Invalid TOTP code" x4 then 429 throttle text; company_admin Reset 2FA allowed (POST 200 wasEnabled:true). 2FA LEFT OFF on uiaudit-2fa (not re-enrolled). TOTP throttle bucket expires by itself.
- exec-d: probe = same as exec-a. Deactivated by company_admin, then REACTIVATED (restored). Leftover enquiry "UIAUDIT DeactivatedTry" (9000000498).
- check (a): UIAUDIT Dup Same assigned to portal customer UIAUDIT Buyer One (PATCH 200), then restored to UIAUDIT Sales Exec.
- Audit log reviewed (UA-110, UA-111).
- A second Chrome tab signed in as uiaudit-admin was left outside the automation group; owner can close it.

### Phase 5b (2026-10-03)
Cross-account isolation tests used records belonging to other test accounts (identifiers omitted from this file). Plan updated: docs/testing/v0.8.3-plan.md parts H (UA-116) and I (UA-106 prerequisite).

## Phase 7 (2026-10-07) — run autonomously over SSH (temporary NOPASSWD sudo), no browser, no passwords
- Snapshot "pre-P7" confirmed (vmrun listSnapshots; created 2026-10-07 14:54 by the owner).
- Script ~/uiaudit/p7-backup-restore.sh (copy in the session scratchpad); column names checked against schema.prisma (fixed number_sequences.scope_label).
- pre OK -> backup OK (bundle /var/backups/openestate/20261007-095127, fingerprint fp-pre) -> marker OK (inquiry_sources row 'UIAUDIT P7 marker' for the UIAUDIT company + uploads/uiaudit-p7-marker.txt, inserted as postgres; rollback drill only) -> restore OK (database-name prompt answered by piping the name on stdin; no --restore-env) -> post PASS (fp-post identical to fp-pre; markers gone). Services active, 0 API journal errors, uploads ownership intact, /login and /portal/login 200.
- PENDING owner browser check (~2 min), after the drill:
  1. Staff: sign in as admin@demo-realty.com -> dashboard loads.
  2. Portal: sign in as UIAUDIT Buyer One (9000000401) -> Account shows BKG/2026-27/000004 balance Rs 28,26,535.50.
  3. 2FA: uiaudit-2fa has 2FA OFF since P5a (reset); to test 2FA after restore, enrol in Settings, sign out, sign in with a code.
  4. Broker PAN: admin -> Brokers -> UIAUDIT-Broker-01 -> Reveal (audited) -> shows AAAPZ9999Z.
  5. Receipt: admin -> Applicant 360 of UIAUDIT Buyer One -> download RCP/2026-27/000001 -> opens, number unchanged.
  (Data equality already proven by the fingerprint: same password hashes, TOTP secrets, PAN ciphertext and env keys.)
- Backup bundle 20261007-095127 left on the VM (holds live secrets; delete after review or keep with the other three bundles).
