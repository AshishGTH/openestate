/**
 * Deletes LeadStage + CompanyConfig + Company rows for the given company
 * id(s), retrying the whole sequence a few times on a specific, already-
 * diagnosed race: syncLeadStages (prisma/sync-permissions.ts) snapshots
 * every company missing CompanyConfig.leadStagesSeededAt ONCE, then writes
 * per company moments later. If sync-lead-stages.test.ts's own call is
 * mid-loop for a company at the exact moment this function's first two
 * deletes clear that company's (then-nonexistent) rows, syncLeadStages'
 * already-in-flight transaction can commit a FRESH CompanyConfig/LeadStage
 * pair immediately afterward — landing in the gap between this function's
 * own deletes and its final company delete. A single delete-then-delete
 * sequence cannot close this window; only a retry can, because
 * syncLeadStages commits AT MOST ONCE per company per call, so a second
 * attempt (which re-clears whatever just reappeared) succeeds once that
 * one in-flight write has landed. Observed directly, not hypothetical —
 * see CLAUDE.md's Phase 0 decisions entry for the real failure this
 * closes (inventory-isolation.test.ts / presales-isolation.test.ts both
 * failed this way under real full-suite runs).
 *
 * This is a narrow, targeted fix for a race that is actively failing
 * tests today — NOT a substitute for the larger deferred fix (routing
 * every hand-rolled company fixture through a shared cleanup harness
 * instead of parallel per-file lists, see docs/todo.md's "14 hand-rolled
 * test-cleanup fixes" entry). That stays deferred; this closes the one
 * part of it that cannot wait.
 */
export async function deleteCompaniesSafely(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any,
  companyIds: string[],
  attempts = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await prisma.leadStage.deleteMany({ where: { companyId: { in: companyIds } } });
    await prisma.companyConfig.deleteMany({ where: { companyId: { in: companyIds } } });
    try {
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
      return;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      const isLastAttempt = attempt === attempts;
      if (code !== 'P2003' || isLastAttempt) throw err;
      // Retry from the top — see doc comment above.
    }
  }
}
