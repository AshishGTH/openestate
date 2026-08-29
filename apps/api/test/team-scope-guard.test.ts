import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Durable guard against the exact bug this codebase used to have: three
 * independent controllers each hand-rolled
 * `if (roleSlug === SALES_EXECUTIVE) scope to self, else see everything` —
 * which meant every OTHER role (sales_manager included) saw the whole
 * company, not their own team. `TeamScopeService.getVisibleUserIds` is now
 * the single place that decision gets made.
 *
 * Two independent regex checks, each verified against the real codebase to
 * have zero false positives:
 *
 * 1. `SYSTEM_ROLES.SALES_EXECUTIVE` — appeared in exactly the three
 *    now-replaced `scopeFor()` functions and nowhere else.
 * 2. A bare (non-`{in:...}`) `where.assignedToId =` / `where.createdById =`
 *    scalar assignment — the OLD, wrong shape
 *    (`where.assignedToId = scope.scopeToUserId`). The lookahead
 *    `(?!\s*\{)` deliberately ALLOWS the correct post-fix shape
 *    (`where.assignedToId = { in: scope.visibleUserIds }`), which three
 *    legitimate call sites use today (inquiry.service.ts,
 *    postsales-reports.service.ts via `bookingWhere`/`inquiryWhere`) —
 *    only a bare scalar assignment is the anti-pattern this catches.
 *    Every legitimate write (`data: { assignedToId }`) and every
 *    legitimate single-user filter (`myDay`'s object-literal
 *    `where: { assignedToId: userId }`) uses a different shape entirely
 *    and doesn't match either pattern.
 *
 * If a future endpoint needs owner-based scoping, it must call
 * `TeamScopeService.getVisibleUserIds()` and filter with
 * `{ in: visibleUserIds }` — not reinvent either pattern.
 *
 * 3. `role:\s*{\s*slug\s*:` — a Prisma relation filter narrowing a query
 *    by role slug (`role: { slug: 'sales_manager' }` and equivalents,
 *    e.g. `role: { slug: { in: [...] } }`). This is the exact shape
 *    `managerWiseInteractions()` used instead of TeamScopeService (real
 *    violation, found by code review, not caught by either check above
 *    since it's neither the SALES_EXECUTIVE identifier nor an
 *    assignedToId/createdById assignment). Textually identical to one
 *    OTHER, legitimate usage in this codebase —
 *    `escalation.service.ts`'s company-wide "notify every active
 *    sales_manager" query, which is enumerating recipients for a system
 *    job, not scoping a caller's own visibility — so that file is
 *    allowlisted below by name, with this comment as the reason, the
 *    same way `team-scope.service.ts` itself is. Verified: grepping the
 *    whole of `apps/api/src` for this pattern before adding the check
 *    found exactly these two occurrences, nothing else — zero other
 *    false positives to account for.
 */

const SRC_ROOT = join(__dirname, '..', 'src');
const ALLOWED_BASENAMES = new Set([
  'team-scope.service.ts',
  // Company-wide "notify every active sales_manager" recipient lookup —
  // enumerating who to notify, not scoping the caller's own visibility.
  // See check 3's comment above for the full reasoning.
  'escalation.service.ts',
  // managerWiseInteractions() selects WHICH users a report row exists
  // for (the axis), not what data counts — the actual per-manager team
  // roll-up is computed via TeamScopeService.getVisibleUserIds(), called
  // per manager. Same category as escalation.service.ts above.
  'reports.service.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(): string[] {
  return walk(SRC_ROOT).filter((f) => !ALLOWED_BASENAMES.has(f.split(/[\\/]/).pop()!));
}

describe('team-scope guard: no ad hoc owner-scoping filter outside TeamScopeService', () => {
  it('SYSTEM_ROLES.SALES_EXECUTIVE is never used to gate a scope filter outside TeamScopeService', () => {
    const pattern = /SYSTEM_ROLES\.SALES_EXECUTIVE/;
    const offenders = sourceFiles().filter((f) => pattern.test(readFileSync(f, 'utf8')));
    expect(
      offenders,
      `Found a hand-rolled role check outside TeamScopeService — this is the exact bug class ` +
        `that let every role but sales_executive see the whole company. Use ` +
        `TeamScopeService.getVisibleUserIds() instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('no bare (non-`{in:...}`) `where.assignedToId =` / `where.createdById =` scalar filter outside TeamScopeService', () => {
    const pattern = /where\.(assignedToId|createdById)\s*=(?!\s*\{)/;
    const offenders = sourceFiles().filter((f) => pattern.test(readFileSync(f, 'utf8')));
    expect(
      offenders,
      `Found an ad hoc scalar ownership filter outside TeamScopeService — the correct shape is ` +
        `\`where.assignedToId = { in: visibleUserIds }\` from TeamScopeService.getVisibleUserIds(), ` +
        `never a bare scalar assignment:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('no ad hoc `role: { slug: ... }` query filter outside TeamScopeService', () => {
    const pattern = /role:\s*{\s*slug\s*:/;
    const offenders = sourceFiles().filter((f) => pattern.test(readFileSync(f, 'utf8')));
    expect(
      offenders,
      `Found a Prisma role-slug filter outside TeamScopeService — this is the exact shape ` +
        `managerWiseInteractions() used instead of TeamScopeService.getVisibleUserIds(). If this ` +
        `is a real caller's-own-visibility scoping filter, replace it. If it's a system job ` +
        `enumerating recipients by role (like escalation.service.ts's company-wide manager ` +
        `notification), add the file to ALLOWED_BASENAMES with a comment explaining why it isn't ` +
        `visibility scoping:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
