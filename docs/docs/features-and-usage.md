---
id: features-and-usage
title: Features & Usage Guide
sidebar_position: 2
---

# OpenEstate — Features & Usage Guide

## What OpenEstate is

OpenEstate is a free, open-source, self-hosted CRM built specifically for
real-estate developers in India — covering the full lifecycle from a
website lead to a registered, paid-off unit, plus dedicated portals for
customers and brokers. It's distributed the way Zabbix and Wazuh are:
download it, run it on your own server, own your data, pay nothing for
the software itself.

**Who it's for:** real-estate developers and channel-sales teams who
currently manage leads in spreadsheets, track collections manually, or pay
recurring license fees to a closed-source CRM for features this covers
natively — GST/TDS-aware receipts, RERA fields, broker commission ledgers,
and Indian payment-plan conventions.

---

## The core idea: one system, three audiences

| Audience | What they use |
|---|---|
| **Your staff** (sales, accounts, admin) | The main web admin app — leads, bookings, receipts, reports |
| **Your customers** | A mobile-friendly customer portal — their unit, dues, documents, support tickets |
| **Your brokers** | A mobile-friendly broker portal — their sales, commission ledger, NOC actions |

All three read from and write to the same underlying data, in real time,
with role-based access so each audience sees only what they should.

---

## Module walkthrough

### 1. Pre-sales — turning inquiries into bookings
- Capture leads from walk-ins, phone calls, your website, or property
  portals (99acres, MagicBricks, etc. via the inbound lead API).
- Automatic duplicate detection — a lead with a phone number already in
  the system links to the existing person instead of creating a
  duplicate.
- Round-robin auto-assignment across your sales team, or manual
  reassignment.
- A follow-up timeline per lead (calls, site visits, emails) with an
  overdue-follow-up queue so nothing falls through.
- Funnel, source-conversion, and staff-performance reports.

### 2. Post-sales — the part other CRMs don't get right
This is OpenEstate's core differentiator. Once a lead converts:
- **Booking wizard**: applicant + co-applicants, unit selection, a
  cost breakup (base price + preferential-location charges + parking +
  club + maintenance + GST), and a payment plan (down-payment,
  construction-linked, or custom).
- **Auto-generated installment schedule** from the payment plan.
- **Receipt entry** — fast, keyboard-first, with automatic oldest-dues-first
  allocation across installments, cheque lifecycle tracking (received →
  deposited → cleared/bounced), and correct GST split (CGST+SGST for
  in-state, IGST for inter-state, based on where the property is located
  — not where the buyer lives, per Indian tax law).
- **TDS tracking** (Section 194-IA) on payments above threshold, with a
  certificate-received flag and report.
- **Interest on delayed payments**, simple or compound, computed
  automatically.
- **Transfers** (re-selling a booking to a new buyer, or swapping units)
  and **cancellations/surrenders** with configurable deduction rules and a
  refund workflow — every rupee is traceable through an append-only
  ledger that always reconciles.
- **Documents**: allotment letters, demand letters, payment receipts, and
  account statements — auto-generated PDFs, using your own letterhead and
  templates.

### 3. Broker management
- Broker registry with RERA agent numbers, bank details, and commission
  rules (flat percentage or slab-based, e.g. 1% up to ₹50L, 1.5% up to
  ₹1Cr, 2% above).
- Commission accrues automatically on booking confirmation or on
  collection milestones — your choice.
- TDS on commission (Section 194-H) computed automatically.
- Cancellation clawback: if a broker's booking is later cancelled, unpaid
  commission is reversed and paid commission can be recovered or written
  off per your company policy.
- An NOC (no-objection) workflow — a broker can be required to
  acknowledge a cancellation before it proceeds.
- Broker statements as downloadable PDFs.

### 4. Customer portal
Your buyers log in from their phone to see:
- Their unit details, layout plans, and monthly construction-progress
  photos you publish.
- Their full cost breakup, payment schedule, and payment history.
- Self-service downloads: account statement, past receipts, current
  demand letter.
- A way to request updates to their phone/email (routed to your staff for
  approval — nothing changes on your records without your sign-off).
- A support ticket system.

### 5. Broker portal
Your channel partners log in to see:
- Every unit they've sold and its status.
- Their commission — due, received, outstanding — in real time.
- Live unit availability across your projects.
- The ability to approve/reject an NOC request from your team.
- Their commission statement, downloadable.

### 6. Reports
Dues by project/tower/floor/applicant with ageing buckets, daily/monthly
collection summaries, applicant ledgers, unit-sold vs available, broker
commission summaries, and more — every report exports to CSV.

### 7. Customization — this isn't just for real estate
- **Custom fields** on any entity, admin-configurable, no code required.
- **Terminology overrides** — rename "Unit" to "Product," "Booking" to
  "Order," and the whole app relabels itself. A proof-of-concept
  `generic-sales` plugin ships showing exactly how far this goes.
- **Module flags** — hide entire sections (e.g. turn off post-sales if
  you only need lead management).
- **Plugin system** — messaging providers, telephony integrations, and
  lead sources are all pluggable; a webhook system lets you connect
  OpenEstate to anything else in your stack.

---

## What OpenEstate deliberately does not do (yet)

Honesty matters more than a feature list. As of v0.1.0:
- No native mobile app (the portals are mobile-web, not App Store apps).
- No built-in accounting/GL beyond the receivables ledger — it's not a
  full accounting system; export to your accountant's tool.
- Tax logic (GST/TDS/RERA) is India-specific. The platform architecture
  is country-agnostic (currency, terminology, and tax masters are all
  configurable), but non-Indian tax rules haven't been built — that's
  configuration/extension work for a future contributor, not a turnkey
  feature today.
- The plugin system trusts first-party, in-repo plugins (reviewed code),
  not arbitrary third-party uploads — it is not yet a sandboxed
  marketplace.

---

## A typical week, module by module

**Monday:** Sales reviews weekend leads from the website (auto-captured
via the inbound lead API), the round-robin assigns them, follow-ups get
scheduled. **Wednesday:** A site visit converts — booking wizard, payment
plan selected, first receipt recorded, allotment letter auto-generated and
emailed. **Friday:** Accounts runs the collection report, verifies two
cheques in the queue, and processes a broker commission payment. Ongoing:
a customer checks their dues on their phone before making a bank transfer;
a broker checks a live availability grid before bringing a client to site.

---

## Getting started

See the [Installation Guide](./installation.md) for setup. Once running,
walk through the "First login and initial setup SOP" section, then the
"dry-run booking" step before inviting real customers.
