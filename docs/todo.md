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
