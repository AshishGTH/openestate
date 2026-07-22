# Deferred TODOs

Cross-phase follow-ups that were consciously deferred, with the phase where
they're expected to land. Each entry should say *what*, *why deferred*, and
*what unblocks it*.

## Pre-sales (Phase 3)

- **Escalation: notify the project manager instead of all company managers,
  once a project→manager mapping exists (Phase 5 or 6).** Today
  `EscalationService.runForCompany` notifies every active `sales_manager` in
  the company because no project→manager (or user→manager) reporting-line
  field exists in the schema yet. The same simplification affects the
  "manager-wise interaction" report (reports each manager's own logged
  interactions, not a team roll-up). Unblocked by adding a team-hierarchy /
  project-ownership mapping.

## Financial core / brokers (Phase 5)

- **Encrypt `Applicant.pan*` using the new `PanEncryptionService` (Phase 5).**
  `Applicant.panCiphertext`/`panMasked`/`panKeyVersion` have existed since
  Phase 4, but nothing has ever written or read them —
  `Applicant.panCiphertext` is always null today. Phase 5 builds the first
  AES-256-GCM PAN encrypt/decrypt utility (`PanEncryptionService`, modeled
  on `TotpService`'s identical implementation) but wires it only to the new
  `Broker.panCiphertext`. Retrofitting `Applicant` — an API field on the
  applicant create/update DTOs plus a PAN input on the applicant form — is a
  follow-up, not part of Phase 5's stated scope. Unblocked by nothing; the
  encryption service already exists and is directly reusable.
