import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@openestate/db';
import { PERMISSIONS } from '@openestate/shared';
import { SYSTEM_PRISMA } from '../database/database.module';

/**
 * Single source of truth for "which users can this caller see the
 * leads/bookings/reports of." Replaces the old, hand-rolled
 * `if (roleSlug === SALES_EXECUTIVE) scope to self, else see everything`
 * pattern that used to live independently in three different controllers.
 *
 * A CI guard (team-scope-guard.test.ts) fails the build if that pattern
 * — or a raw `where.assignedToId =` / `where.createdById =` filter — is
 * reintroduced anywhere outside this file.
 */
@Injectable()
export class TeamScopeService {
  constructor(
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  /**
   * Returns the caller plus their full reporting subtree (not just direct
   * reports — a direct-reports-only version would silently hide a senior
   * manager's sub-subordinates' leads, a worse failure than showing "too
   * much"). `null` means "no filter" — granted by the
   * ADMIN_TEAM_SCOPE_ALL permission, whose holders see the whole company
   * regardless of where they sit (or don't sit) in the org chart. Every
   * other caller, whether or not they currently have any reports, gets a
   * real (possibly single-element, just themselves) visible set computed
   * live from `users.manager_id` — never cached, so a manager change takes
   * effect on the very next request.
   *
   * Keyed off a PERMISSION, not the role slug. The original slug check
   * (`company_admin`/`super_admin` literally) meant a company that built
   * its own "Administrator" role holding every permission was still scoped
   * to its own subtree — its dashboard and reports silently showed a
   * fraction of the company with nothing to explain why. Permissions are
   * what the rest of this codebase authorises on; identity-by-slug was the
   * odd one out.
   *
   * Service-layer, not RLS and not an ambient/AsyncLocalStorage filter —
   * deliberately a plain function called explicitly at the top of each
   * handler (see docs/todo.md's "Approved, not yet built" entry for the
   * full reasoning: this exact ambient-injection mechanism produced two
   * real IDOR bugs in Phase 6).
   *
   * The recursive CTE assumes an acyclic graph — `UsersService`'s
   * `assertValidManager` is what keeps that assumption true on every
   * write. `depth < 50` is defense-in-depth against a stored cycle only
   * (stops a runaway query rather than an application bug becoming a
   * database hang); it is not the primary cycle guard.
   */
  async getVisibleUserIds(
    companyId: string,
    userId: string,
    permissions: readonly string[],
  ): Promise<string[] | null> {
    if (permissions.includes(PERMISSIONS.ADMIN_TEAM_SCOPE_ALL)) return null;

    const rows = await this.systemPrisma.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE subtree AS (
        SELECT id, 1 AS depth
        FROM users
        WHERE id = ${userId}::uuid AND company_id = ${companyId}::uuid
        UNION ALL
        SELECT u.id, s.depth + 1
        FROM users u
        INNER JOIN subtree s ON u.manager_id = s.id
        WHERE u.company_id = ${companyId}::uuid AND s.depth < 50
      )
      SELECT id FROM subtree
    `;
    return rows.map((r) => r.id);
  }
}
