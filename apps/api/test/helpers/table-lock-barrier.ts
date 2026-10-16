/**
 * Forces an interleaving (CLAUDE.md: "a concurrency test must force its
 * interleaving"): a superuser connection holds an ACCESS EXCLUSIVE lock on
 * one table, the requests under test are started, and the lock is released
 * only once `expectedBlocked` backends are waiting on it, directly or behind
 * one another (pg_blocking_pids, followed transitively). Every request
 * therefore reaches its first read of `table` before any of them can
 * continue.
 *
 * Table-wide lock: only for *.serial.test.ts files (vitest.serial.config.ts),
 * which run after every other suite has finished.
 */
import { PrismaClient } from '@openestate/db';
import { TEST_SUPER_URL } from './postsales-harness';

/* eslint-disable @typescript-eslint/no-explicit-any -- raw Prisma transaction client */

const BLOCKED_BEHIND = `
  WITH RECURSIVE b(pid) AS (
    SELECT a.pid FROM pg_stat_activity a WHERE $1::int = ANY (pg_blocking_pids(a.pid))
    UNION
    SELECT a.pid FROM pg_stat_activity a JOIN b ON b.pid = ANY (pg_blocking_pids(a.pid))
  )
  SELECT count(*)::int AS n FROM b`;

export async function behindTableLock<T>(
  table: string,
  expectedBlocked: number,
  start: () => Array<Promise<T>>,
): Promise<Array<PromiseSettledResult<T>>> {
  const holder = new PrismaClient({ datasourceUrl: TEST_SUPER_URL });
  const observer = new PrismaClient({ datasourceUrl: TEST_SUPER_URL });
  let started: Array<Promise<T>> = [];
  try {
    await holder.$transaction(
      async (tx: any) => {
        const [{ pid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
        await tx.$executeRawUnsafe(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
        started = start();
        // Keep a rejection from surfacing as unhandled before allSettled below.
        started.forEach((p) => p.catch(() => undefined));
        const deadline = Date.now() + 15_000;
        for (;;) {
          const [{ n }] = (await observer.$queryRawUnsafe(BLOCKED_BEHIND, pid)) as Array<{ n: number }>;
          if (n >= expectedBlocked) break;
          if (Date.now() > deadline) {
            throw new Error(`barrier: only ${n} of ${expectedBlocked} requests blocked behind the ${table} lock`);
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    return await Promise.allSettled(started);
  } finally {
    await holder.$disconnect();
    await observer.$disconnect();
  }
}
