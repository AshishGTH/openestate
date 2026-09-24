# Uploaded documents + booking custom fields — plan for review

**Status:** revision 5, 2026-09-24. Not built. Housekeeping and owner
decisions only (below); otherwise the design is revision 4's.

**Revision 5 (2026-09-24):**
- **Renumbered.** The release sequence moved when v0.7.0 became the admin
  2FA reset (CLAUDE.md, "Release sequence moved"). Every release in this
  plan moved up one: Aadhaar guard + booking custom fields is now v0.8.0,
  deploy plumbing v0.9.0, documents v1.0.0, the deferred drop v1.1.0.
  Revision notes below were renumbered too, so they read in today's
  numbering, not the numbering in force when they were written.
- **v0.8.0 is two PRs:** PR 1 is the Aadhaar guard only; PR 2 is booking
  custom fields.
- **Layer (a) spelling rule changed by owner decision (2026-09-24):**
  substring match on the stripped string for `aadhaar`, `aadhar`, `आधार`;
  whole-word match only for `adhaar` and `adhar`. NFKC normalisation, plus
  two explicit Devanagari folds (`अा` → `आ`, nukta removed), because NFKC
  alone changes nothing for आधार. `आधार` has a known false positive — it is
  also the Hindi word for "base" (आधार मूल्य, "base price") — and stays
  blocked anyway; the error message suggests rewording.
- **Finding 4 corrected:** the VM's custom field is `aadhaar_number`.
  "Aadhaar (reference only)" is a seeded Document Type master item, not a
  custom field.

**Status (revision 4, 2026-09-15):** Not built. Owner rulings on revision 2's
objections applied (recorded in CLAUDE.md's decisions log, dated the same
day), plus one same-day correction to revision 3's own design. §6 is now a
log of what was ruled and corrected, not a list of open questions — the
one item deliberately left unfixed (§6, item 4 — a `RolesService`
self-escalation gap, reported and tracked in `docs/todo.md`, low severity)
is a security backlog item outside this plan's scope, not something this
plan is waiting on.

Changes in revision 4 (a correction, not an owner ruling — §6):
- **`uid` dropped from the layer (a) definition-name guard.** It would
  have false-positived on ordinary integration field names ("External
  UID", "Partner UID") with no exemption path around it, and it's a weak
  signal for Aadhaar specifically. `aadhaar`/`aadhar`/`आधार` are
  unaffected and have no comparable legitimate-name conflict.

Changes in revision 3:
- **Aadhaar guard redesigned into three layers** (§2h): a zero-false-positive
  definition-name guard, the pattern+Verhoeff value guard from revision 2,
  and a per-field, audited exemption for legitimate 12-digit fields (bank
  accounts). Explicitly documented as deterrence, not prevention.
- **Self-delete rule** (§2d): anyone may delete a file they uploaded
  themselves; deleting someone else's needs the delete permission.
- **`applicant_documents` disposition decided now, not deferred** (§2a):
  drop if empty, rename to `applicant_documents_legacy` if it has rows —
  in the v1.0.0 migration itself. No v1.1.0 step for this table.
- **v1.0.0 formally split into three PRs**, released together (§4).
- **RolesService self-escalation finding reported, not fixed** (§6, item 4):
  only company_admin and super_admin can edit roles on a fresh install —
  low severity — tracked in `docs/todo.md`.

Revision 2's changes (A–F, still in effect): multiple files per document
type (no replace endpoint); fresh-install permission grants; the Verhoeff
checksum requirement; the release sequence v0.8.0/v0.9.0/v1.0.0/v1.1.0;
required documents never block booking creation.

---

## 0. Findings — where the code contradicts the brief

1. `POSTSALES_BOOKING_UPDATE` is **assigned but unused**: sales_manager
   (explicit), company_admin (`postsales.*` prefix), super_admin. No route
   checks it. (Revision 1's investigation report wrongly said "unassigned".)
2. Four more dormant permissions: `POSTSALES_DOCUMENT_READ`/`UPLOAD`
   (held by sales_manager and sales_executive), `POSTSALES_DOCUMENT_DELETE`
   (company_admin via prefix), `PORTAL_DOCUMENT_UPLOAD` (customer). No route
   uses any of them. Cleanup tracked in `docs/todo.md`.
3. There is no "frozen list" in CLAUDE.md. `docs/todo.md` quoted one
   ("don't modify without asking") that appears nowhere; the same misquote
   is in a code comment in `packages/shared/src/custom-field.dto.ts`.
   "Frozen" is only an adjective in decision entries (e.g. Phase 5's "frozen
   `Booking` table").
4. The verification VM has an `aadhaar_number` TEXT custom field on
   Applicant, created deliberately during the admin walkthrough (CLAUDE.md,
   walkthrough issue #5). (Not to be confused with "Aadhaar (reference
   only)", which is a seeded Document Type master item — `seed.ts:166` —
   not a custom field.)
5. Seeded Document Types mix KYC uploads (PAN, Passport) with generated
   outbound letters (Receipt, Demand Letter, NOC), all `entityType:
   'Applicant'`. `entityType` is admin-typed free text read by no code.
6. There is no booking detail page. `InstallmentSchedule` is the only
   booking-keyed page. The accounts role cannot open `Applicant360`
   (no `presales.applicant.read`).
7. Generated PDFs (receipts, letters — PII) are stored **unencrypted**
   under `uploads/document/`. Out of scope; noted only.
8. Existing upload code breaks rules the new code must not copy: file
   writes inside `withTenantTx` (`ProjectMediaService.upload`,
   `DocumentService.store`); image re-encoding fails open
   (`UploadService.processImage` returns the original bytes on a `sharp`
   error); raw user filename interpolated into `Content-Disposition`.
9. CLAUDE.md's stack names an optional S3 driver — none exists. It also
   names a per-applicant data-export endpoint — none exists.
10. A backup bundle stores ciphertext and every key together (`db.sql` +
    `uploads.tar.gz` + `openestate.env`). At-rest encryption protects against
    loss of the uploads directory or disk, not a stolen bundle.
11. `upgrade-native.sh` never adds new env vars. A new boot-required key
    would fail the healthcheck and roll back every upgrade — the gap v0.9.0
    exists to close.
12. `AGENTS.md` is a stale copy of CLAUDE.md (~490 lines behind) with the
    same Aadhaar line.
13. `feature-completion-plan.md` §5.2, its §5 non-goals, and decision 5
    contradict owner decision 1 ("hold CLAUDE.md's line").
14. `BookingDraft` rows never expire; no cleanup job exists.
15. `RolesService.update()` has no "cannot grant a permission you don't
    hold" check. Any role with `admin.role.update` — company_admin, via the
    `admin.*` prefix — can grant itself any permission, including the new
    document permissions (relevant to decision B, §6).
16. UIDAI's own numbering document does not pin the Verhoeff permutation
    table (§2h). Every validator uses the standard tables, but no UIDAI
    document found this session confirms them.

---

## 1. Releases at a glance

| Release | Contents | Migration | Env / deploy scripts |
|---|---|---|---|
| v0.6.0 | Predecessor, not this plan: `feat/admin-generated-reset-links` (head `acf2bb7`), `fix/login-cross-links` (head `26d6fef`) | — | — |
| v0.7.0 | Not this plan: admin-side 2FA reset | — | — |
| v0.8.0 | Aadhaar guard — definition-name guard + value guard (Verhoeff) + per-field exemption — booking custom fields | `bookings.custom_fields`, `custom_field_definitions.allows_twelve_digit_values` | None to install/upgrade/backup/restore. One new standalone read-only script, `deploy/native/find-aadhaar-like-values.sh` (§4) |
| v0.9.0 | Deploy plumbing only: `ensure_env_key`, new key required at boot, key canary, `UploadedDocumentCrypto`, shared key-ring helper, backup/restore changes | None | Yes — the point of the release |
| v1.0.0 | Three PRs, released together (§4): (1) document types + applicant documents + sweep, (2) booking documents, (3) rotation script + CLAUDE.md Aadhaar amendment + docs | `uploaded_documents` + DocumentType columns + `applicant_documents` drop-or-rename | `upgrade-native.sh` logs the drop/rename outcome |
| v1.1.0 | Deferred removal: `document_types.entity_type` only | Drop column | — |

---

## 2. Design answers

### (a) One table, exactly one owner per row

New `uploaded_documents` table. Each row has `applicant_id` or `booking_id`
— both real foreign keys — with `CHECK (num_nonnulls(applicant_id,
booking_id) = 1)`.

- **Why one table:** storage, crypto, sweep, audit, permission and download
  code exist once; "BOTH" types need no cross-table logic; mirrored
  implementations drift (the staff/portal 2FA fixes, twice).
- **Why not `entity_type` + `entity_id`:** no foreign key, so orphan rows,
  no RESTRICT on the owner, and a future portal policy can't rely on real
  relationships.
- **Why not reuse or rename `applicant_documents`:** wrong shape
  (`applicant_id` NOT NULL, stores the user filename, no key version or
  `deleted_at`); a rename leaves names Prisma doesn't generate (drift — the
  `add_password_reset` migration already reconciled drift on this table);
  the name is false for booking documents.
- **Name:** not `documents` — `GET /documents/:id/download` already serves
  generated PDFs, and Applicant360 has "Documents & dispatch history".
  `UploadedDocument` in code, "Uploaded documents" in the UI.

**Columns:** `id` (app-generated, used as encryption AAD), `company_id`,
`document_type_id` (restrict), `applicant_id?`, `booking_id?`, `format`
(`pdf|jpg|png`, server-derived), `size_bytes`, `key_version`,
`uploaded_by_id`, `created_at`, `deleted_at?`, `deleted_by_id?`. No
original filename — `Rahul_Aadhaar_2345….pdf` is a leak path. Indexes on
`(company_id, applicant_id)` and `(company_id, booking_id)`.

**Multiple files (decision A):**
- No partial unique indexes. `document_types.max_files` (default 5, CHECK
  1–10) caps live files per `(entity, document type)`.
- A count limit can't be a unique index, and count-then-insert races (the
  `BrokerBankDetail.isPrimary` class of bug in `docs/todo.md`). Enforced by
  `pg_advisory_xact_lock(hashtext(document_type_id), hashtext(entity_id))`
  — the namespaced two-key form CLAUDE.md's Phase 3 advisory-lock note
  recommends — then recount, then insert. A hash collision only serialises
  two unrelated slots; it never breaks correctness.
- Upload order: cheap count pre-check (reject before encrypting 10MB) →
  write file → transaction (lock, recount, insert). Over the limit inside
  the transaction → roll back and unlink the file (the sweep is the
  backstop).
- Lowering `max_files` below the current count keeps every existing file;
  uploads are refused until the count drops ("3 of 2 — limit reached").
- **Required** = at least one live file (`deleted_at IS NULL`) for that type.

**`applicant_documents` — resolved by ruling, decided in the v1.0.0
migration itself (supersedes decision D's "defer to v1.1.0"):**
- The migration counts rows in `applicant_documents`. **Zero rows → `DROP
  TABLE`.** **One or more rows → `ALTER TABLE ... RENAME TO
  applicant_documents_legacy`** — data kept, but the table is removed from
  `schema.prisma` in the same release, so nothing in the app can reach it
  by either name afterward. Never aborts the upgrade; never destroys data
  that exists.
- Constraint and index names don't follow a rename in Postgres (they keep
  their `applicant_documents_*` prefix regardless of which branch fires) —
  cosmetic only, not touched.
- The RLS policy on the table is attached to its OID, not its name, so a
  rename doesn't need the policy recreated. It becomes moot either way:
  nothing queries the table under either name once the Prisma model is
  removed.
- **Logged loudly either way, and not by relying on `prisma migrate
  deploy` surfacing a SQL `RAISE WARNING`/`NOTICE`** (unverified whether it
  does — assume it doesn't reach the script's own output). Instead
  `upgrade-native.sh` runs an explicit post-migration check: does
  `applicant_documents_legacy` exist? If yes, `warn` with its row count
  ("applicant_documents had N row(s) — renamed to
  applicant_documents_legacy, not dropped; review and archive manually").
  If no, `log` one line confirming the clean drop ("applicant_documents
  removed — no legacy data").
- `ApplicantDocument`'s `TENANT_SCOPED_MODELS`/`AUDITED_MODELS` entries,
  its RLS policies, and its harness cleanup entry are all removed in this
  same release (the model is gone from `schema.prisma`), not left until a
  later one.

**Locks (v1.0.0 migration):** `CREATE TABLE` with these foreign keys takes
SHARE ROW EXCLUSIVE on `companies`, `applicants`, `bookings`,
`document_types` — briefly blocks writes, not reads. `DROP TABLE` (or
`ALTER TABLE ... RENAME`) on `applicant_documents` takes ACCESS EXCLUSIVE
on that one table and drops its own triggers/policies with it — no lock on
`applicants` itself. All covered by `upgrade-native.sh`'s 15s
`lock_timeout`.

### (b) Upload timing — upload only after the owner exists; no staging

- **Applicant documents:** no timing problem. The wizard creates the
  applicant inline (`POST /applicants`) at step 0; Applicant360 is keyed by
  an existing applicant.
- **Booking documents:** after `POST /bookings` succeeds, the wizard shows
  a final **Documents** step bound to the real booking id. It accepts
  several files per type and can be skipped.
- **Why not staging:** rows with no owner break the one-owner rule; drafts
  can be resumed days later and never expire, so staged files — unowned
  Aadhaar scans — would live indefinitely; claiming them inside booking
  creation extends the transaction holding the booking-number lock.
- **Decision F:** required documents never block booking creation. "Required"
  is a visible missing state — badge and count on Applicant360 and the
  booking page. A hard gate at allotment or registration stays open for
  later (it could be a controller precondition, like
  `BookingCostLineVerifier`).
- **Browser dies before Confirm:** nothing uploaded; the existing draft
  autosave restores the form. Nothing to clean up.
- **Browser dies after the booking is created:** the booking exists — the
  same as today, where plan, broker and source-inquiry are separate
  requests. Missing documents show on the booking page. An interrupted
  upload never reaches the handler.
- **Server crash windows** (all file I/O outside `withTenantTx`): validate →
  re-encode images (fail closed) → encrypt → temp file → atomic rename →
  transaction (lock, recount, insert) → commit. A crash before commit
  leaves a file with no row.
- **Delete:** marks one row deleted (kept as a tombstone for audit) and
  unlinks its bytes right after commit — a wrong customer's Aadhaar scan
  must actually go. Other files of the same type are untouched. A crash
  after commit leaves a deleted row whose file still exists.
- **Cleanup sweep:** daily BullMQ repeat job (`escalation.scheduler.ts`
  pattern), per company directory. Deletes `*.tmp` older than 1h, files
  older than 24h with no row, and files whose row is deleted.
- **Safety breaker:** if a company's no-row orphans exceed max(20, 5% of its
  rows), delete nothing and log ERROR — that many orphans means the database
  and the uploads directory disagree (e.g. a partial restore), not crashes.
  `ponytail:` comment on the threshold.
- **Backup window:** a delete between `pg_dump` and `tar` restores as a row
  whose file is missing ("file missing" in the UI).

### (c) Encryption mechanics

- **Env var:** `UPLOADED_DOCUMENT_ENCRYPTION_KEYS`, `1:<64hex>[,2:<64hex>]`,
  same format as `PLUGIN_SECRET_ENCRYPTION_KEYS`. Not `DOCUMENT_…`:
  generated PDFs aren't encrypted.
- **Code:** extract the key-list parser from `PluginSecretEncryptionService`
  into one shared helper (plugin behaviour identical, covered by existing
  plugin tests). `UploadedDocumentCrypto` works on Buffers. Not
  `PanEncryptionService` (string/base64, single key, rotation never wired).
- **File format:** `[1B format ver][2B key ver][12B IV][16B tag][ciphertext]`.
  AAD = `companyId:documentId`, so a file can't be swapped onto another row
  or tenant. The header carries the key version so a crash mid-rotation
  leaves a self-describing file; `key_version` in the database tracks
  rotation progress.
- **Location:** `${UPLOADS_DIR}/uploaded-documents/<companyId>/<documentId>`.
  Must stay under `UPLOADS_DIR` (systemd `ReadWritePaths`). Not
  `uploads/document/` (generated PDFs).
- **Key canary (v0.9.0):** `${UPLOADS_DIR}/uploaded-documents/.key-check`
  holds a fixed plaintext encrypted with AAD `key-check`.
  - Boot: absent → create under the current key. Present → decrypt using
    the header's key version. Failure, or that version missing from the env
    → **refuse to boot** with a message naming the likely cause (env
    regenerated, or restored without `--restore-env`).
  - A mismatch cannot come from an upgrade: `ensure_env_key` never
    overwrites. Refusing boot stops new documents being written under a
    second, unrelated key.
  - v1.0.0 additionally decrypts one real document per referenced key
    version at boot (logs ERROR; doesn't refuse boot), because an operator
    can delete the canary.
- **Download:** read the whole file, decrypt, verify the tag, then send. Not
  streamed — streaming AES-GCM releases plaintext before the tag is checked.
  Bounded by the 10MB per-file ceiling (`ponytail:` note: switch to chunked
  AEAD if files above ~25MB are ever needed). Headers: Content-Type from the
  server's format enum; `Content-Disposition` with a server-built ASCII name
  `<type-slug>-<booking-number-or-applicant-ref>-<yyyymmdd-hhmmss>.<ext>`
  (unique now that one type holds several files); `Cache-Control:
  no-store`; `Content-Security-Policy: sandbox`. One audit row per view or
  download.
- **Frontend:** "View" opens the decrypted blob in a new tab; "Download" uses
  `downloadFile` (which has no retry after a 401 — known existing gap).
- **Key loss:** every uploaded document is permanently unreadable; nothing
  else breaks. Downloads return an explicit 422 "cannot decrypt with the
  configured key". A missing env var refuses boot (same as PAN/TOTP/plugin).
- **Deploy changes (all v0.9.0):**
  - `openestate.env.example` — new entry with a key-loss warning.
  - `lib.sh` — `ensure_env_key NAME VALUE`: append if absent, never overwrite.
  - `install-native.sh` — generate on a fresh env; `ensure_env_key` when the
    env already exists. When the env is **absent** but a key canary exists
    → die ("uploads were encrypted with a previous key — restore the old
    `openestate.env` from backup, or remove `uploaded-documents/`
    knowingly"). Its current message invites deleting the env to
    regenerate secrets, which would otherwise make every document
    unreadable.
  - `upgrade-native.sh` — `ensure_env_key` immediately before cutover, so a
    failed build or migration leaves the env untouched. Loud "back this key
    up now": the pre-upgrade backup taken at the start doesn't contain it.
  - `backup-native.sh` — data already covered (tars all of `UPLOADS_DIR`,
    copies the env). Comment and log text name the new key. Optional
    `--keys-output DIR` writes the env outside the bundle; default unchanged.
  - `restore-native.sh` — after extracting uploads and before starting the
    API, run `apps/api/scripts/check-document-key.ts` (exit 0 ok, 1
    mismatch, 2 no canary). On mismatch: stop, don't start the API, print
    "re-run with `--restore-env`, or put the original key back".
  - `uninstall.sh` — message text only.
  - systemd unit — no change.
  - `docs/docs/installation.md` §7 — the key, what losing it means, the
    separate-keys option, the restore check, the canary.
  - CI — see v0.9.0 in §4.
  - `apps/e2e/playwright.config.ts`, the ci.yml e2e env, and the api test
    `??=` fallback all get the key.

### (d) Permissions (decision B)

| Permission | Gates | Fresh install |
|---|---|---|
| `admin.document-type.manage` (new) | create/update/delete document types; read stays `ADMIN_MASTER_READ` | super_admin, company_admin |
| `postsales.uploaded-document.read` (new) | list, view, download | super_admin, company_admin, sales_manager, sales_executive, accounts |
| `postsales.uploaded-document.upload` (new) | add a file; delete a file **you uploaded yourself** | super_admin, company_admin, sales_manager, sales_executive |
| `postsales.uploaded-document.delete` (new) | delete **anyone's** file | super_admin, company_admin, sales_manager |
| `POSTSALES_BOOKING_UPDATE` (existing) | edit booking custom fields | already super_admin, company_admin, sales_manager |

**Self-delete rule (resolved by ruling):** the DELETE route's guard checks
`postsales.uploaded-document.read` only (so it can be reached at all); the
service then allows the delete when EITHER the caller holds
`postsales.uploaded-document.delete`, OR the row's `uploaded_by_id` equals
the caller's own id AND the caller holds `.upload` (proof they're a genuine
uploader, not merely a reader). No time window — a self-upload can be
removed at any point in its life, same as anyone else's under the delete
permission. Both paths write the same audit row (actor, `documentId`,
before/after); the audit diff doesn't distinguish self-delete from
delete-permission delete, and doesn't need to — the actor id already says
who did it. A sales_executive who can upload but not delete therefore can
always undo their own mistake; deleting a colleague's file still needs a
manager or admin.

- **Routes nest under the entity**, so guards stay static AND:
  `/applicants/:id/uploaded-documents/...` needs `presales.applicant.read`
  plus the document permission; `/bookings/:id/uploaded-documents/...` needs
  `postsales.booking.read` plus it. Accounts therefore sees booking
  documents only.
- **Customer and broker:** none (portal deferred, (e)).
- **Existing installs:** only super_admin auto-receives (the
  `syncSuperAdminPermissions` exception). Every other role is granted
  deliberately through Roles. Consequence: company_admin loses
  document-type editing until granted — CHANGELOG callout. Caveat: finding
  15 — company_admin can grant these to itself, so "deliberately" is a UI
  step, not a privilege boundary.
- **`POSTSALES_BOOKING_UPDATE`:** used. Activating it only lets roles that
  can already create, allot and cancel bookings edit non-financial metadata.
- **`POSTSALES_DOCUMENT_*` / `PORTAL_DOCUMENT_UPLOAD`:** not reused —
  activating them would silently give every existing sales_executive and
  customer KYC-scan access on upgrade. Cleanup in `docs/todo.md`.
- **Scope:** documents are company-wide for anyone holding read (Applicant and
  Booking are unscoped by the v0.4 decision).
- **Installation-docs note (v1.0.0):** tell operators, after upgrading, to
  open Admin → Roles and review exactly which roles hold
  `postsales.uploaded-document.read` — anyone holding it can download KYC
  scans (PAN, Aadhaar if enabled) for every applicant in the company.

### (e) Portal — deferred

- Upload means untrusted internet files opened on staff screens, with no
  malware scanning.
- View needs co-applicant rules (booking documents via
  `portal_can_access_booking`; applicant documents only to that applicant) —
  the policy set that hit the 42P17 recursion bug, where the rule is "no
  second SECURITY DEFINER helper".
- Activating the dormant `PORTAL_DOCUMENT_UPLOAD` widens the customer role
  on upgrade.
- **Ships anyway in v1.0.0:** a RESTRICTIVE policy on `uploaded_documents`
  denying all portal sessions (`portal_applicant() IS NULL AND
  portal_broker() IS NULL`), plus a raw-connection test proving a portal
  session sees zero rows.

### (f) Booking non-file custom fields — JSONB column

- **Migration:** `ALTER TABLE bookings ADD COLUMN custom_fields JSONB` —
  nullable, no default, catalog-only.
- **`BookingService` is not edited.** `createBooking` lists its insert fields
  explicitly (no spread), so the column is null. `BookingController.create`
  extends the DTO locally (`createBookingSchema.extend({customFields})`,
  still strict), validates with `resolveValuesForWrite('BOOKING')`
  **before** opening a transaction, then opens an outer `withTenantTx`, calls
  `createBooking` (which joins it — the nesting `cancel()` already relies
  on), then `tx.booking.update({customFields})`. No I/O inside, so the
  booking-number lock rule holds.
- **Confirmed:** no ledger, GST, cost-line, number-sequence or status-machine
  code changes.
- **Edits:** `PATCH /bookings/:id/custom-fields` (`POSTSALES_BOOKING_UPDATE`)
  in a small new service.
- **Recorded as owner-approved exceptions (2026-09-14):** a column on the
  "frozen `Booking` table" (precedent: `brokerId`, `sourceInquiryId`).
- **Still an owner decision:** `TransferService` (frozen) won't copy custom
  fields or documents to the new booking. Recommendation: don't copy.
- **Portal:** `portal-account` and `portal-property` load full booking rows
  but return explicitly mapped fields; a regression test asserts
  `customFields` never appears in either response.
- **Asymmetry, deliberate and intended behaviour (F) — exact UI wording:**
  - A required TYPED field left empty: a red inline validation message
    directly under the input, "This field is required." Confirm/Save is
    disabled until it's filled — the existing `CustomFieldInputs` behaviour,
    unchanged.
  - A required DOCUMENT type with zero live files: an amber (not red)
    status badge next to that type's Add button, reading "Required — no
    files yet". It is never wired to any disable/block logic; Confirm/Save
    stays clickable. The wizard's Documents step carries one line of
    standing copy above the type list: "Required documents can be added
    now or later — they won't stop you from saving." The same badge and
    copy appear on Applicant360's panel. Colour (amber vs. red) and the
    presence vs. absence of a disabled button are what make the two states
    visually distinct at a glance, not just the wording.

### (g) What must be stripped from exports

- `GET /reports/presales/inquiries-export` emits every active
  APPLICANT/INQUIRY custom field as a column. Old Aadhaar values would
  export; each cell goes through the shared redactor (v0.8.0).
- `CustomFieldDisplay` shows old values on staff screens; same masking.
- Uploaded documents never appear in any CSV, report, merge field, plugin
  context or webhook. No report queries the table; webhook `dispatchEvent`
  has zero callers today; the plugin applicant lookup returns only id and
  name.
- Booking custom fields are not added to any export or letter merge field.
- Audit log: document rows hold metadata only, no filename. Aadhaar values
  already written into old custom-field audit diffs stay — reported, not
  scrubbed.
- pino-http doesn't log request bodies or files; no redaction change.
- Backups hold keys and files together — see (c).

### (h) The Aadhaar guard — three layers (redesigned by ruling)

**Framing, stated once and meant to govern all three layers: this guard is
deterrence, not prevention.** Every layer below has a measured residual
false-positive or false-negative rate. Nobody building on top of this
should assume "the guard passed" means "no Aadhaar number is present," or
that "the guard fired" means "this really was one." Both layers 2 and 3
are pattern-based; layer 1 is the only zero-false-positive layer, and it
only catches a field's *name*, not what gets typed into it.

#### Layer (a) — definition-name guard (new; no known false positive on its target class)

**Rule:** reject **creating** a custom field, or **renaming** one (the only
mutable identifying text — `key` is immutable after creation and already
regex-locked to lowercase snake_case), when its `key` or `label`, after
normalization, contains `aadhaar`, `aadhar`, or `आधार` as a substring.

**`uid` was in this rule in revision 3 and is dropped here (revision 4,
correction, see §6):** it would have false-positived on ordinary,
plausible integration field names ("External UID", "Partner UID"), the
layer (c) exemption deliberately can't reach layer (a) to work around that,
and "UID" is a weak, generic signal for Aadhaar specifically — layer (b)'s
pattern+Verhoeff check is what actually has to catch a determined or
mistaken 12-digit entry, keyword or not. `aadhaar`/`aadhar`/`आधार` have no
such legitimate-field-name conflict and stay.

**Normalization (applied to `key` and `label` independently):** lowercase,
then strip every character that isn't `[a-z0-9]` or Devanagari (`ऀ–ॿ`), then
test `includes()` for `aadhaar`, `aadhar`, or `आधार`. This catches
`aadhar_no`, `Aadhaar-Number`, `AADHAAR NO`, `आधार संख्या` — anything using
those words with different casing, spacing, punctuation or a leading/
trailing modifier. `key` never technically needs the Devanagari branch
(the existing key regex, `^[a-z][a-z0-9_]*$`, already forbids it), but the
check runs on both fields through one function regardless, so there's one
code path to test, not two.

**What this would wrongly catch (corrected in revision 5):** `आधार` is
also the ordinary Hindi word for "base" or "foundation" (आधार मूल्य, "base
price"), so a Hindi label using it is refused — accepted by owner decision,
and the error message suggests rewording. The short spellings `adhaar` and
`adhar` are matched as whole words only; as substrings of the stripped
string they caught "Via Dharavi", "Adhartal locality", "Road hardware",
"Lead Hardness" and "Radharani Nagar".

**Interaction with the existing `aadhaar_number` custom field** already
created on the verification VM (finding 4): this guard only fires
on create/rename. That field was neither created nor renamed under this
guard, so it is **not** retroactively affected — it keeps existing exactly
as it is until someone renames it, at which point the new label is
checked like any other rename.

**Migration:** none by itself — this is service-layer logic only, no new
column. (The exemption column below is the only schema change layer (a)
and (c) together require.)

**Error message:** "Field names and keys can't reference Aadhaar
(matched: \"aadhaar\"). See CLAUDE.md's Aadhaar policy." — names the
matched keyword so an admin isn't left guessing why the field was
rejected.

#### Layer (b) — value guard (as revision 2, unchanged)

**Rule:** reject a custom-field value containing a 12-digit sequence —
digits optionally separated by single spaces or hyphens in 4-4-4 groups,
not part of a longer digit run — whose first digit is 2–9 **and** whose
Verhoeff checksum is valid. Applied to incoming TEXT and NUMBER values
only (not the merged stored record, which would make old records
uneditable), and to definition `options`/`defaultValue`. Machine-written
notes (`leadNote`, `importNotes`) are redacted with the same test, never
rejected. **Skipped entirely for a field with the layer (c) exemption set**
(below) — every other field is checked regardless of its name, including
one that passed layer (a) precisely because its name gave no hint.

**Source verification (done this session, not from memory):**
- Verhoeff tables `d` (D5 multiplication), `p` (permutation, 8 rows) and
  `inv` copied from the Wikipedia *Verhoeff algorithm* article, which cites
  Verhoeff, J. (1969), *Error Detecting Decimal Codes*, Mathematical Centre
  Tract 29. Its worked examples check: `236` → check digit `3`; `2363`
  validates. Reproduced in a throwaway script, which also checks the tables
  weren't mistranscribed: `d` is associative with `inv` as inverses, and
  every row of `p` is row 1 applied to the previous row (period 8).
- **Aadhaar's use of Verhoeff:** Kanakia, Nadhamuni & Sarma, *A UID Numbering
  Scheme*, UIDAI, May 2010 (cited as UIDAI 2012c in arXiv:1806.04410; the
  uidai.gov.in URL now 404s — a mirror was read). It recommends "12 digits
  (11 + 1 check sum)" and "the Verhoeff Scheme".
- **Gap 1:** the same document says "Verhoeff defines a permutation such as
  (0)(14)(23)(56789). Other permutations can also be used." — so it does not
  pin the permutation. The standard table is `(0 1 5 8 9 4 2 7)(3 6)`.
  Every third-party validator uses the standard tables; no UIDAI document
  found confirms them, and UIDAI issues test Aadhaar numbers only on
  request. If production Aadhaar used a different permutation, real numbers
  would fail the checksum and the guard would **never fire** — silently.
  **Pre-ship verification gate, kept (see the exact procedure below).**
- **Gap 2:** the first-digit rule comes from the same 2010 document: "0-
  numbers … TBD", "1- numbers … could be reserved for entities", "We could
  use 2-9 numbers … right away." A design recommendation, not a regulation.
  Kept, because it cuts false positives by a fifth.

**Residual false positives after the checksum** (measured over 200,000
random samples each):
- Any 12-digit number starting 2–9: **9.93%** still pass. That covers 12-digit
  bank account numbers and order, reference and invoice numbers.
- Indian mobiles written with a contiguous country code
  (`91` + `[6-9]` + 9 digits): **10.04%** still pass — about 1 in 10.
  `919876543210` itself does **not** pass. Written with a space
  (`+91 98765 43210`) they never match, because the grouping isn't 4-4-4.
- 16-digit numbers written in 4-4-4-4 groups (card numbers, 16-digit
  references): **15.22%** flagged, via the 12-digit windows at groups 1–3
  or 2–4.
- Where it bites: the dedicated phone columns (`primaryPhone`,
  `alternatePhones`) are not custom fields and are **not guarded**. Hits
  come from phones typed into custom TEXT fields, and from inbound lead
  notes, where about 1 in 10 contiguous-`91` phones would be redacted.

**False negatives:** any Aadhaar number with a single mistyped digit fails
the checksum (**0.00%** of single-digit typos pass), so the guard never
fires and it is stored. Also evaded by other separators (`2345.6789.0124`).
The guard is against accidental storage, not deliberate evasion. Layer (a)
does not help here either: a field that legitimately holds Aadhaar-like
values under an innocuous name (e.g. renamed to dodge layer (a)) is exactly
what layer (b) alone has to catch, and layer (b)'s own false-negative rate
above still applies to it.

**Error message:** "This looks like an Aadhaar number. Aadhaar numbers can't
be stored in custom fields — upload the card as a document instead."
(Until v1.0.0 ships document upload: "…can't be stored in custom fields.")

#### Layer (c) — per-field exemption (new)

**Column:** `custom_field_definitions.allows_twelve_digit_values BOOLEAN NOT
NULL DEFAULT false`.

**Effect:** when `true`, layer (b) is skipped for values written to that
one field. Nothing else changes — layer (a) still runs on every create and
rename regardless of this flag, so **a field cannot be named or renamed to
reference Aadhaar and then have the checksum guard turned off for it**;
the two layers are enforced independently, and setting the exemption
never grants an exception from the name check. This exists so a
legitimate 12-digit value — a bank account number is the example given —
isn't permanently blocked by layer (b)'s false-positive rate (§ above:
~10% of real 12-digit numbers).

**Who can set it, and what happens when they do:**
- Settable only via `PATCH` on the definition, alongside `label`,
  `isRequired`, etc. — one more field on the existing update DTO, not a
  separate endpoint.
- **Audited for free:** `CustomFieldDefinition` is already in
  `AUDITED_MODELS` (`packages/db/src/audit.extension.ts`), so the
  before/after diff extension already logs this flag flipping — no new
  audit code needed, just confirmed coverage.
- **Visible in the admin UI, not just in the audit log:** the definition's
  edit form gets a checkbox, "Allow 12-digit values (bypasses the Aadhaar
  safety check)", with inline warning text directly under it: "Only enable
  this for a field that legitimately holds a 12-digit number, such as a
  bank account number. This field will no longer be checked for
  accidentally-stored Aadhaar numbers." The admin list of custom fields
  also shows a small warning badge ("⚠ 12-digit check disabled") on any row
  where the flag is set, so it stays discoverable after the fact, not only
  at the moment of editing.
- Turning it back off re-enables the check for every future write; it is
  never applied retroactively to values already stored while it was on.

**Permission: rides on the existing `admin.custom-field.update`
permission — recommended, no new permission.** Reasoning: on a fresh
install, `admin.custom-field.update` is already held by exactly
super_admin and company_admin (the same two roles that hold
`admin.role.update` — see the RolesService finding, §6 item 4). Anyone
who can already retype a field's `fieldType`, empty and refill its
`options`, or delete and recreate it under a different validation shape
already has full control over what that field will accept; a checkbox
that disables one specific check is strictly narrower than the
capabilities `admin.custom-field.update` already grants. A dedicated
permission would only matter if some future role held
`admin.custom-field.update` without also being trusted with the
company's PII policy generally — not the case for any role in this
codebase today, and if it ever becomes the case, the fix is to reconsider
that role's grant of `admin.custom-field.update` itself, not to carve out
a second permission for one flag on it.

**Migration:** the same v0.8.0 migration as `bookings.custom_fields` — one
more nullable-with-default column, additive, catalog-only.

#### Pre-ship verification gate (kept from revision 2, procedure specified exactly)

Before v0.8.0 ships, a human with lawful access to at least two real
Aadhaar numbers (their own, and/or a consenting family member's, with
consent) verifies layer (b)'s implementation against them, following
these steps exactly — designed so no digit is ever written to disk,
logged, or transmitted:

1. Start a plain Node REPL with its history file disabled for the
   session: `NODE_REPL_HISTORY= node` (an unset or empty
   `NODE_REPL_HISTORY` tells Node's REPL not to persist history to
   `~/.node_repl_history` — verify this behaviour against the running
   Node version before relying on it, since it is not being independently
   re-confirmed in this planning session).
2. Paste the guard's Verhoeff-validation function, copied directly from
   `packages/shared/src/aadhaar-guard.ts`'s source — evaluated inline at
   the prompt, never saved to a new file.
3. At the prompt, call the function directly with the real number as a
   literal argument: `isValidVerhoeff('<12 digits>')`. Read only the
   boolean result. Do not assign it to a REPL variable that might get
   echoed back by a later command, and do not paste the number into any
   other tool, message, ticket, or terminal tab.
4. Repeat for the second number.
5. Exit the REPL (`.exit`).
6. Record **only the outcome** in CLAUDE.md's decisions log: "Verified the
   Verhoeff implementation against 2 real Aadhaar numbers on
   <date>: both passed." Never a digit, never a masked or partial digit,
   never a hash of the number — hashing a 12-digit space this small is not
   a meaningful protection and would only invite treating it as one.
7. As a best-effort (not a real control, since terminal scrollback isn't
   normally written to disk, but worth doing anyway): close the terminal
   tab or clear scrollback afterward.

If either number fails, do not ship layer (b) as designed — treat gap 1
above as confirmed and escalate before this guard reaches any real
install.

---

## 3. CLAUDE.md amendment (exact wording — lands in v1.0.0)

**Replace** (line 118):
```
- PII: encrypt PAN numbers at rest (AES-256-GCM, key from env);
  mask PAN/phone in list views and logs. NEVER store Aadhaar
  numbers. Structured logger (pino) with a redaction list.
```
**With:**
```
- PII: encrypt PAN numbers at rest (AES-256-GCM, key from env);
  mask PAN/phone in list views and logs. An Aadhaar card MAY be
  collected as a scanned document — an uploaded file, encrypted at
  rest under its own key — only when the operator enables that
  document type. An Aadhaar NUMBER is NEVER stored in any
  structured, searchable, or exportable field: no column, no
  custom-field value, no report or export column, no log line, and
  no OCR or text extraction from the scan. Values matching an
  Aadhaar number (12 digits, first digit 2–9, valid Verhoeff
  checksum) are rejected on write to custom fields. Structured
  logger (pino) with a redaction list.
```

Ships in v1.0.0, when scanned-Aadhaar collection becomes real, so the docs
are true at every release. v0.8.0's guard is consistent with both wordings.
Same release: a decisions-log entry, the same edit to `AGENTS.md` line 118,
ASVS checklist V8.1 (Aadhaar sentence) and V8.3 (new key), and
`feature-completion-plan.md` §5.2, §5 non-goals and decision 5 marked
resolved.

---

## 4. Releases in detail

### v0.6.0 — predecessor (not this plan)

`feat/admin-generated-reset-links` and `fix/login-cross-links`, both
finished. Nothing below depends on them.

### v0.8.0 — Aadhaar guard (3 layers) + booking custom fields

**Constraint check — "no new env vars, no deploy-script changes":** true for
env vars and for every install/upgrade/backup/restore/uninstall script.
Nothing in either feature reads configuration.
`deploy/native/find-aadhaar-like-values.sh` (ruling: stays in
`deploy/native/`, precedent `find-stage-suspect-interest.sh`) is a new file
under that directory, but it changes no existing script, isn't called by
any of them, and needs no new setting — it doesn't touch the install or
upgrade path. The one migration runs through the unchanged upgrade path.
No new permission constants, so the permission sync is a no-op.

**Changes — guard, all three layers (§2h):**
- Shared pure functions: `containsAadhaarKeyword` (layer a), Aadhaar-number
  detection with Verhoeff and redaction (layer b).
- `CustomFieldsService.create`/`update` call `containsAadhaarKeyword` on
  `key` and (when present) `label`; reject with the layer-(a) message.
- `custom_field_definitions.allows_twelve_digit_values` column; the
  update DTO gains the field; `resolveValuesForWrite` skips layer (b) when
  the definition carries it.
- `resolveValuesForWrite` rejects layer-(b) matches in incoming values
  only, for fields without the exemption.
- `createFromLead` and the importer redact (layer b's test, never layer a
  — machine-written notes aren't field names).
- The inquiries export and `CustomFieldDisplay` mask (layer b's test).
- `CustomFieldInputs` shows the layer-(b) error inline; the definition
  admin form shows the layer-(a) error inline and the layer-(c) checkbox
  with its warning text and list badge.
- The detection script prints definition keys and entity ids with counts,
  never values.

**Changes — booking custom fields:**
- `BOOKING` added to `CUSTOM_FIELD_VALUE_ENTITIES` (the admin tab stops
  showing "(unsupported)").
- `VALUE_TABLES.BOOKING`.
- Controller-level create path and new `PATCH` (§2f).
- Wizard Confirm step renders `CustomFieldInputs`.
- InstallmentSchedule shows `CustomFieldDisplay` and an edit form.

**Files:**
- `packages/shared/src/aadhaar-guard.ts` (+ export, + tests against the
  Wikipedia worked examples, the table-inverse property, and
  `containsAadhaarKeyword`'s own cases: `aadhar_no`, `Aadhaar-Number`,
  `आधार`, and a non-match confirming `external_uid`/`Partner UID` are
  accepted — a name test proving the dropped "uid" check stays dropped, not
  just its absence)
- `packages/shared/src/custom-field.dto.ts` (also fix its "frozen list"
  misquote, and its "See docs/todo.md" pointer — that todo entry was
  removed on 2026-09-14 when this plan absorbed it)
- `apps/api/src/custom-fields/custom-fields.service.ts`
- `apps/api/src/presales/inquiry.service.ts`,
  `apps/api/src/presales/inquiry-import.service.ts`,
  `apps/api/src/presales/reports.service.ts`
- `apps/api/src/postsales/booking.controller.ts`, new
  `apps/api/src/postsales/booking-custom-fields.service.ts`
- `apps/web/src/components/CustomFieldInputs.tsx`,
  `apps/web/src/pages/admin/CustomFields.tsx` (exemption checkbox + badge),
  `apps/web/src/pages/postsales/BookingWizard.tsx`,
  `apps/web/src/pages/postsales/InstallmentSchedule.tsx`
- `schema.prisma`; SDK/OpenAPI regeneration
- `deploy/native/find-aadhaar-like-values.sh`
- supertests per new route; portal response regression test
- `CHANGELOG.md`; CLAUDE.md decisions entry (guard + conformance-gate result)

**Migration:** `…_booking_custom_fields_and_aadhaar_exemption` — two
nullable/defaulted columns, `bookings.custom_fields` and
`custom_field_definitions.allows_twelve_digit_values`. Both ACCESS
EXCLUSIVE, catalog-only; covered by `lock_timeout`.

**Playwright:**
1. Admin tries to create a field keyed `aadhaar_number` → rejected inline
   and by `page.request` (layer a). Tries `external_uid` → accepted (the
   "uid" check was dropped from layer a, revision 4 — this scenario proves
   it stays dropped). Tries `bank_account_number` → accepted.
2. On Add Inquiry, a checksum-valid test value in the bank-account field
   shows an inline error (layer b); `page.request` with the same value
   gets a 400.
3. A checksum-invalid 12-digit value and `+91 98765 43210` are accepted in
   the same field.
4. Admin sets `allows_twelve_digit_values` on the bank-account field
   (warning text visible in the form; badge appears on the list) → the
   same checksum-valid value from step 2 now saves. The audit log shows
   the flag change. Admin tries to rename the *same* field to "Aadhaar
   Account" → still rejected by layer (a), proving the exemption doesn't
   bypass it.
5. On a project fixture seeded with an old Aadhaar-shaped value, editing
   another field through Edit Project still saves, and the old value shows
   masked.
6. The inquiries CSV export has that value masked.
7. Define a required SELECT and optional TEXT field for BOOKING; the wizard
   blocks Confirm until the SELECT is chosen; `page.request` without it
   gets a 400.
8. Book; values show on the booking page after reload.
9. Sales_manager edits them; sales_executive sees no edit control and gets
   a 403 on a direct PATCH.
10. Ledger balance and cost lines match an identical booking with no fields.

Test values are computed with the standard Verhoeff tables in the test
itself — never a real Aadhaar number.

**What could go wrong:**
- The permutation-conformance gate fails, or is skipped (§2h).
- Residual false positives on layer (b) (§2h).
- Redaction removing a phone number from a lead note.
- The exemption checkbox is set on a field for a reason other than the
  stated one (a real bank-account field), quietly reopening a bypass —
  the admin-list badge is the only ongoing signal once the moment of
  setting it has passed.
- A required booking field added later forces every edit of an old booking
  to supply it (same as other entities).
- Bookings created by transfer carry no values.

### v0.9.0 — deploy plumbing only

**Purpose:** prove `upgrade-native.sh` can add a boot-required setting to an
existing install without failing the healthcheck (finding 11). No document
feature, no tables, no migration.

**Changes:**
- `ensure_env_key` in `lib.sh`; `install-native.sh` and `upgrade-native.sh`
  per §2c.
- `UPLOADED_DOCUMENT_ENCRYPTION_KEYS` generated and required at boot.
- Shared key-ring helper extracted from `PluginSecretEncryptionService`.
- `UploadedDocumentCrypto`.
- Key canary created and checked at boot (§2c).
- `apps/api/scripts/check-document-key.ts`.
- `backup-native.sh` `--keys-output`; `restore-native.sh` pre-start key check.
- Installation docs §7.

**Files:**
- `deploy/native/lib.sh`, `install-native.sh`, `upgrade-native.sh`,
  `backup-native.sh`, `restore-native.sh`, `uninstall.sh`,
  `openestate.env.example`
- new `apps/api/src/uploaded-documents/uploaded-document-crypto.ts` +
  canary boot hook
- shared key-ring helper; `plugin-secret-encryption.service.ts` refactored
  onto it
- `apps/api/scripts/check-document-key.ts`
- `.github/workflows/ci.yml` (`native-install`,
  `native-upgrade-from-populated`, e2e env)
- `apps/e2e/playwright.config.ts`; api test `??=` fallback
- `docs/docs/installation.md` — phrased truthfully for this release: the key
  exists and is checked; nothing but the canary is encrypted with it yet
- `CHANGELOG.md`

**Verification — this release is not meaningfully browser-verifiable**
(there is no UI). The real-browser equivalent is a real install and upgrade;
every native-install bug in CLAUDE.md's history was found that way. The full
Playwright suite runs as a regression check only.

- **CI `native-install`** (outcomes, not file contents):
  1. The key is present and well-formed (read as root).
  2. The canary exists and does not contain its plaintext.
  3. `check-document-key.ts` exits 0.
  4. The API is healthy.
  5. `systemctl restart` → healthy again: the second boot **decrypted** a
     canary the first boot **encrypted** — the round trip, through the
     deployed binary and the real env.
  6. Re-run `install-native.sh` → the key is byte-identical (idempotent).
  7. **Negative:** replace the key with a fresh one → restart → API not
     healthy, and the journal contains the mismatch message → restore the
     key → healthy. Without this, a check that does nothing would pass
     steps 1–6.
- **CI `native-upgrade-from-populated`:**
  1. The baseline env has no key.
  2. Upgrade → healthy.
  3. The env differs from the pre-upgrade copy by exactly the appended key
     lines; every existing line is byte-identical.
  4. Canary created; restart healthy; the negative check as above.
  5. Existing assertions still pass.
- **Backup/restore** (CI step in `native-install` if runtime allows,
  otherwise a VM run recorded in the decisions log):
  1. Backup.
  2. Swap the key.
  3. Restore without `--restore-env` → the check reports a mismatch and the
     API is not started.
  4. Restore with `--restore-env` → healthy.
  5. With `--keys-output`: the bundle has no env file; restore with
     `--env-file` from the keys directory works.

**Cannot be meaningfully verified without the feature, and how it's
verified anyway:**
1. *Boot check against real documents* — none exist. Replaced by the canary,
   which is meaningful now (it catches a restore with the wrong key today).
   The per-document check is added in v1.0.0.
2. *Backup/restore keeps documents decryptable* — the canary lives in the
   same directory under the same key, so it proves the mechanism, not the
   feature. v1.0.0's Playwright re-proves it with a real file.
3. *Download-time behaviour on key mismatch (422)* — needs documents.
   v0.9.0 unit-tests only the crypto error type.
4. *10MB encrypt/decrypt memory behaviour* — a unit test with a 10MB buffer;
   concurrent-upload load waits for v1.0.0.
5. *AAD binding* — a unit test (decrypt with a different document id fails).
6. *Cleanup sweep, rotation, operator-facing messages on document pages* —
   they don't exist until v1.0.0.

**What could go wrong:**
- An env managed by configuration management gets rewritten without the
  key → the next upgrade generates a new one → canary mismatch → boot
  refuses → rollback. Loud and correct, but surprising.
- The key-ring helper extraction regresses plugin secrets (covered by the
  existing plugin tests).
- An operator deletes the env to regenerate secrets — now refused while a
  canary exists (§2c).
- Pre-existing and unchanged: regenerating the env already loses PAN, TOTP
  and plugin secrets silently today.

### v1.0.0 — the document feature

Largest release. Split into three PRs, merged in order, released together as
one version bump (no PR ships to users on its own) — accepted per ruling.
The split points, exactly:

- **PR 1 — foundation: document types, applicant documents, the sweep.**
  Everything under "DocumentType columns," "Masters," "Seed," the
  `uploaded_documents` table and its migration (including the
  `applicant_documents` drop-or-rename), the applicant-side controller and
  service, the cleanup sweep, the Applicant360 panel, and PR 1's own
  Playwright scenarios below. This PR is functionally complete on its own —
  an admin can configure a document type and staff can upload, view,
  download and delete applicant documents — so it's the natural place to
  stop and get review before booking documents build on the same service.
- **PR 2 — booking documents.** The booking controller/routes (reusing PR
  1's `UploadedDocumentService` unchanged), the InstallmentSchedule panel,
  the wizard's post-save Documents step, and PR 2's Playwright scenarios.
  Depends on PR 1 merging first (same service, same table). Adds no schema.
- **PR 3 — rotation, the Aadhaar amendment, and docs.** The rotation
  script, the CLAUDE.md/AGENTS.md/ASVS/`feature-completion-plan.md`
  edits (§3), the installation-docs roles-review note, and the docs page
  stub. Depends on PR 1 (rotates real documents) but not on PR 2.

Each PR gets its own review and its own green CI; the release itself only
happens once all three are merged, so `v1.0.0`'s CHANGELOG entry and the
CI/Playwright gates described below span the merged result of all three,
not any one PR in isolation.

**Changes:**
- **DocumentType columns:**
  - `applies_to` (`APPLICANT|BOOKING|BOTH`, NOT NULL, default APPLICANT;
    backfilled from `entity_type` where it reads booking or both)
  - `accepted_formats text[]` default `{}` — **empty means not offered for
    upload**
  - `max_size_bytes` (≤ 10MB)
  - `max_files` (default 5, CHECK 1–10)
  - `is_required`
  - `entity_type` becomes nullable and unused; dropped in v1.1.0 (the
    previous release still writes it during the upgrade window and after a
    rollback)
- **Masters:** document types stay in the generic factory, gaining a
  per-config write-permission override, a "row still referenced" delete
  error (P2003) mapped to 409 "in use — deactivate instead" (all masters),
  and a checkbox-group field in `Masters.tsx`.
- **Seed (fresh installs only):** PAN Card, Passport, Voter ID configured for
  APPLICANT (pdf/jpg/png). "Agreement Copy" → BOOKING/pdf. "Aadhaar
  (reference only)" renamed "Aadhaar Card (scanned copy)", seeded
  **inactive**. Existing installs untouched: empty formats, nothing offered
  until an admin configures it.
- **Storage and API:**
  - `uploaded_documents` table; `UploadedDocumentService` (advisory-locked
    `max_files`)
  - applicant and booking controllers: list, add (POST), content, delete —
    **no PUT**
  - cleanup sweep; per-document boot check
- **Merged applicants:** the survivor lists documents from records merged
  into it (via `mergedIntoId`) separately; uploads to a merged record return
  409.
- **UI:**
  - Applicant360: Uploaded documents panel — per type: file list, "n of
    max", Add, View, Download, Delete
  - InstallmentSchedule: booking panel plus read-only views of the primary
    and co-applicants' applicant documents
  - wizard post-save Documents step
- **Ops:** `upgrade-native.sh` logs the `applicant_documents` drop-or-rename
  outcome loudly either way (§2a); rotation script
  `apps/api/scripts/rotate-uploaded-document-keys.ts` (temp → atomic rename
  → `key_version`; re-encrypts the canary; reports "old key safe to remove"
  only at zero rows on the old version).
- **Docs:** the CLAUDE.md amendment set (§3); installation-docs roles-review
  note (§2d); rotation runbook; docs page stub; CHANGELOG.

**Files:**
- `schema.prisma` + migration
- `packages/db/src/tenant.extension.ts`, `packages/db/src/audit.extension.ts`
- `packages/shared` (roles, permissions, document-type DTO, formats)
- `apps/api/src/masters/master.factory.ts`,
  `apps/api/src/masters/masters.module.ts`
- `apps/api/src/uploaded-documents/*`
- `apps/api/src/queues/queues.module.ts`
- `apps/api/scripts/rotate-uploaded-document-keys.ts`
- `apps/web`: `pages/admin/Masters.tsx`, `pages/postsales/Applicant360.tsx`,
  `pages/postsales/InstallmentSchedule.tsx`,
  `pages/postsales/BookingWizard.tsx`, `lib/api.ts`
- `packages/db/prisma/seed.ts`
- `deploy/native/upgrade-native.sh` (post-migration drop/rename check + log)
- `postsales-harness.ts` (add `uploaded_documents`; **remove** the
  `applicant_documents` cleanup entry — the table no longer exists under
  that name after this migration, whichever branch fires), `postsales-rls.
  test.ts` (add the new table; remove the `applicant_documents` row), a new
  test asserting the drop-or-rename migration logic against both a
  zero-row and a populated `applicant_documents` fixture, portal-deny RLS
  test, supertests
- CLAUDE.md, AGENTS.md, ASVS checklist, `feature-completion-plan.md`,
  `docs/docs/installation.md`, CHANGELOG

**Migration:** `…_uploaded_documents` — DocumentType columns + backfill +
`entity_type` DROP NOT NULL; new table, CHECK, indexes, RLS enable/force,
tenant policy, portal deny policy, grants; **the `applicant_documents`
drop-or-rename** (§2a) in the same migration file.

**Playwright — applicant documents** (one login per role, per the e2e
flakiness entry):
1. Admin configures PAN Card: required, pdf+jpg, 2MB, `max_files` 2.
2. Applicant360 shows "Required — missing".
3. Upload a fixture PDF (`setInputFiles`) → "1 of 2", requirement met.
4. The test reads the file on disk: it doesn't start with `%PDF`.
5. Download → bytes identical to the fixture.
6. Upload a second file (JPG) → "2 of 2"; Add is disabled; `page.request`
   for a third → 409.
7. Delete the first as manager → the second is still listed, still
   downloads correctly, still on disk; the deleted file is gone from disk;
   the requirement is still met.
8. Delete the second → "Required — missing" again.
9. **Self-delete:** log in as sales_executive A (upload permission, no
   delete permission). Upload a file. Confirm A can immediately delete
   their own just-uploaded file — the Delete control is visible for it
   specifically, `page.request` DELETE succeeds, and the audit log records
   A as the actor. A uploads a second file, then logs out; sales_executive
   B (also upload-only, no delete permission) logs in and confirms Delete
   is **not** offered on A's file and a direct `page.request` DELETE for it
   returns 403. Manager logs in and deletes A's remaining file
   successfully (delete permission, not self-upload) — the audit log shows
   the manager, not A, as this action's actor.
10. A `.png` renamed `.pdf` → rejected (magic bytes); a 3MB file → rejected
    (size).
11. Sales_executive: Add visible, Delete absent on someone else's file (per
    9); direct DELETE on someone else's file → 403.
12. The seeded inactive Aadhaar type shows no slot until an admin activates
    it.
13. The audit log shows the downloads.

**Playwright — booking documents:**
1. Configure Signed Agreement (BOOKING, required, `max_files` 3) and Cheque
   Copy (BOTH).
2. Book via the wizard; after Confirm the Documents step appears.
3. Upload two agreement pages → the booking page shows both, requirement met.
4. Manager deletes one → the other survives and downloads identical bytes.
5. Accounts: sees and downloads booking documents; no Add/Delete.
6. A Cheque Copy uploaded on Applicant360 doesn't appear in the booking's
   Cheque Copy list, and vice versa.
7. A second booking: close the page right after creation → reopen → "Required
   — missing", and no stray file on disk.

**Playwright — rotation:** a dedicated project whose webServer starts with
keys `1,2`. globalSetup seeds a v1-encrypted document and runs the script;
the spec downloads through the UI (identical bytes), and the file header and
canary both read version 2.

**Not Playwright:** portal session sees zero rows (raw-connection test);
lowering `max_files` below the count (supertest); concurrent uploads never
exceed `max_files` (integration test, N parallel requests).

**What could go wrong:**
- Size: three PRs' worth in one release, and the e2e login budget.
- Company_admin loses document-type editing on existing installs until
  granted.
- Lock on hot tables while creating the FKs.
- `sharp` rejecting unusual JPEGs (fails closed — the user sees an error).
- Memory: up to 10MB per concurrent upload.
- The sweep after a partial restore (the breaker guards this).
- The self-delete rule (§2d) is a service-layer branch, not a permission —
  easy to get backwards in review (checking `uploadedById` against the
  wrong id, or checking it before confirming `.upload` is actually held);
  needs the dedicated test in scenario 9 above, not just code review.

### v1.1.0 — deferred removal

- `document_types.entity_type`: drop the column (nothing reads it since
  v1.0.0; the previous release still writes it during the upgrade window
  and after a rollback, which is why it isn't dropped in the same release
  that stops reading it).
- `applicant_documents` no longer has a step here — resolved in v1.0.0's
  own migration (§2a, drop if empty / rename to `applicant_documents_legacy`
  if it has rows).

---

## 5. Not planned / open items

- Portal view or upload (§2e).
- Hard gate on required documents at allotment or registration (F).
- Transfer carrying custom fields or documents (§2f).
- Encrypting generated PDFs (finding 7). S3 storage (finding 9).
- Deleting the dormant `POSTSALES_DOCUMENT_*` and `PORTAL_DOCUMENT_UPLOAD`
  constants (`docs/todo.md`).
- A document review/verification state ("uploaded" vs "verified").
  Required is satisfied by any file, even an illegible one.

---

## 6. Owner rulings on revision 2's objections (2026-09-15)

Revision 2's numbering, kept for traceability. Items 1, 2, 3, 5, 6, 7, 8 are
resolved and reflected in §§2, 4 above. Item 4 is reported here and left
unbuilt, by explicit instruction.

1 & 2. **(C) Checksum false positives/negatives — accepted as a known
   residual, and the guard was redesigned rather than tuned further.**
   Redesigned into three layers (§2h): a definition-name guard (layer a),
   the pattern+Verhoeff value guard from revision 2 unchanged (layer b,
   ~10% residual false positive rate, 0% of single-digit typos caught), and
   a per-field, audited exemption for legitimate 12-digit fields (layer c).
   None of revision 2's three named options (accept both / exempt
   `91[6-9]…` / keyword-only) were taken as-is — the layered design
   supersedes that framing entirely, and the plan now states the residual
   rates as deterrence, not prevention, rather than presenting the guard as
   solved.

   **Correction, revision 4, same day — reversing revision 3's own layer
   (a) design, not an owner ruling:** revision 3 had layer (a) also reject
   a bare `uid` token. This was my own objection to raise, not something
   asked for, so it's recorded as a correction rather than a ruling: `uid`
   is a weak, generic signal for Aadhaar specifically (unlike
   `aadhaar`/`aadhar`/`आधार`, which have no other legitimate use as a field
   name), it would have blocked ordinary integration field names ("External
   UID", "Partner UID"), and the layer (c) exemption can't reach layer (a)
   to work around it — so there would have been no way to keep such a
   field. Dropped. `aadhaar`/`aadhar`/`आधार` are unaffected; layer (b) is
   what actually has to catch a determined or accidental 12-digit entry,
   keyword or not.

3. **(A+B) Staff can't take back their own mistaken upload — resolved,
   ruled in the requester's favour.** Anyone may delete a file they
   uploaded themselves, no time window, regardless of the delete
   permission; deleting someone else's file still needs it. Both paths
   audited identically by actor id. §2d, and the Playwright scenario at
   v1.0.0 PR 1, step 9.

4. **(B) `RolesService.update()` lets a role grant itself any permission it
   doesn't already check the grantor holds — reported, not fixed, by
   explicit instruction. Answered directly: on a fresh install, only
   `company_admin` (via the `admin.*` prefix filter in
   `packages/shared/src/roles.ts`) and `super_admin` (via `Object.values(P)`,
   every permission) hold `admin.role.update`.** Grepped
   `packages/shared/src/roles.ts` directly: `sales_manager`,
   `sales_executive`, `accounts`, `customer` and `broker` list no
   `ADMIN_ROLE_*` permission, explicitly or via any prefix filter they use.
   So on a fresh install, no role below company_admin can reach
   `RolesService.update()` at all — there is no privilege-escalation path
   from a lesser role today. **Low severity**, for that reason: the gap
   only lets a role that can already edit any role's permission set
   (company_admin, super_admin — the two roles the whole permission system
   already trusts completely) also grant itself something it doesn't yet
   hold, which is not an escalation across a trust boundary this system
   currently defines. This does NOT cover a custom role an admin has
   already, deliberately, granted `admin.role.update` to — that role would
   inherit the same self-grant ability, but only because an equally
   privileged actor chose to hand it that permission in the first place.
   **Tracked as a security item in `docs/todo.md`** ("RolesService has no
   check that the grantor already holds a permission before granting it"),
   not fixed in this plan or this session.

5. **(D) Deferred drop — resolved, decided now.** In the v1.0.0 migration
   itself: `DROP TABLE applicant_documents` if it has zero rows,
   `ALTER TABLE ... RENAME TO applicant_documents_legacy` if it has any.
   Never aborts the upgrade; never destroys data that exists. Logged
   loudly either way by `upgrade-native.sh`'s own post-migration check,
   not by relying on a SQL-level `NOTICE`/`WARNING` reaching its output.
   §2a. No v1.1.0 step remains for this table.

6. **(E) v0.9.0 refuses to boot on a key mismatch before any document
   exists — kept as designed, by explicit instruction.** An operator who
   regenerates `openestate.env` by hand (rather than through
   `ensure_env_key`) will hit this. `install-native.sh`'s messaging
   explains it (§2c).

7. **(E) v0.8.0's one non-application file — confirmed to stay.**
   `find-aadhaar-like-values.sh` stays under `deploy/native/`, per explicit
   instruction; it is a standalone, read-only tool that doesn't touch the
   install or upgrade path, so "no deploy-script changes" for v0.8.0 holds
   for every script that path actually depends on.

8. **(E) v1.0.0 size — accepted, three PRs, released together.** Split
   points defined explicitly in §4's v1.0.0 section: PR 1 (foundation:
   document types + applicant documents + sweep, functionally complete on
   its own), PR 2 (booking documents, depends on PR 1), PR 3 (rotation +
   Aadhaar amendment + docs, depends on PR 1). One version bump only once
   all three merge.

---

## 7. Assumptions

1. **Multiple files per document type per entity** (decision A): up to
   `max_files` (default 5, hard ceiling 10) live files, no replace. A second
   upload always adds; a correction is upload-then-delete. Replaces
   revision 1's "one current file per slot".
2. Formats limited to pdf, jpg, png — the ones with magic-byte validators.
   No HEIC or WEBP; iPhone HEIC photos are rejected.
3. 10MB hard ceiling per file; admin limits can only be lower. nginx already
   allows 25MB. Worst case 100MB per type per entity.
4. There is no replace permission. Deleting your own upload needs only the
   upload permission (self-delete, §2d, ruling); deleting anyone else's
   file needs `postsales.uploaded-document.delete`.
5. Sales_executive gets company-wide read and upload on KYC documents (B;
   Applicant is unscoped).
6. "Required" = at least one live file. Visible, never blocking (F).
7. Booking documents and booking custom fields live on InstallmentSchedule
   (no booking detail page; accounts can't open Applicant360).
8. Transfers carry neither custom fields nor documents.
9. Viewing and downloading documents is audited.
10. Existing installs see no document slots until an admin sets accepted
    formats; fresh installs seed Aadhaar inactive.
11. Uploaded filenames are never stored; download names are server-built.
12. The Aadhaar guard's first-digit rule (2–9) and the standard Verhoeff
    tables are used pending the conformance gate (§2h).
13. The layer (c) exemption rides on the existing `admin.custom-field.update`
    permission rather than a new one — a recommendation made in this plan
    (§2h), not something the owner ruled on directly.
14. ~~The layer (a) `uid` token match has no exemption path~~ — removed;
    the `uid` check itself was dropped from layer (a) in revision 4 (§6).
