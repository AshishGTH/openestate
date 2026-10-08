import { Global, Inject, Injectable, Logger, Module, OnModuleDestroy, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaClient } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';

/** Backstop only: every write path updates the cache itself (write-through). */
export const AUTHZ_VERSION_TTL_SECONDS = 60;
export const AUTHZ_REDIS_URL = 'AUTHZ_REDIS_URL';
const KEY = (userId: string) => `authz:v:${userId}`;

/**
 * Sets the key to ARGV[1] only if it is missing or holds a LOWER version, then
 * returns what the key holds. Versions only ever go up, so "keep the max" is
 * always right and two writers racing (a bump and a cache fill from an older
 * database read) can never leave a stale, lower value behind.
 */
const SET_MAX = `
local cur = redis.call('GET', KEYS[1])
if (not cur) or (tonumber(cur) < tonumber(ARGV[1])) then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return ARGV[1]
end
return cur
`;

/**
 * The per-user session authorisation version (users.authz_version), read on
 * every authenticated request by SessionVersionGuard and incremented by every
 * write path that must end existing sessions.
 *
 * Read path: one Redis GET. On a miss, one database read, then a SET_MAX into
 * Redis. If Redis is unreachable, the value is read from the database instead;
 * if the database is unreachable too the call throws, so the request fails
 * rather than being let through. Never fails open.
 *
 * Write path: the database UPDATE (the source of truth), then SET_MAX of the
 * new value into Redis in the same call. The cache is shared by every API
 * instance (no in-process cache), so all of them see the new value on the very
 * next request; the 60 s TTL only bounds staleness if a write to Redis failed.
 */
@Injectable()
export class AuthzVersionService implements OnModuleDestroy {
  private readonly logger = new Logger(AuthzVersionService.name);
  private readonly redis: Redis;

  constructor(
    @Inject(SYSTEM_PRISMA) private readonly prisma: PrismaClient,
    @Optional() @Inject(AUTHZ_REDIS_URL) redisUrl?: string,
  ) {
    this.redis = new Redis(redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6379', {
      // Fail fast instead of queueing commands while Redis is down, so a
      // request falls back to the database at once.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
    });
    this.redis.on('error', () => {
      // Reconnection is automatic; each failed command is logged at its call.
    });
  }

  async onModuleDestroy() {
    this.redis.disconnect();
  }

  /** The user's current version, or null if the user no longer exists. */
  async current(userId: string): Promise<number | null> {
    let cached: string | null = null;
    try {
      cached = await this.redis.get(KEY(userId));
    } catch (err) {
      this.logger.warn(`authz version cache unavailable, reading the database (${(err as Error).message})`);
      return this.readDb(userId);
    }
    if (cached !== null) return Number(cached);

    const fromDb = await this.readDb(userId);
    if (fromDb === null) return null;
    try {
      return Number(await this.redis.eval(SET_MAX, 1, KEY(userId), String(fromDb), String(AUTHZ_VERSION_TTL_SECONDS)));
    } catch {
      return fromDb;
    }
  }

  /** Ends every existing session of these users (their tokens carry the old version). */
  async bumpUsers(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const rows = await this.prisma.$queryRaw<Array<{ id: string; authz_version: number }>>`
      UPDATE users SET authz_version = authz_version + 1
      WHERE id = ANY(${userIds}::uuid[])
      RETURNING id, authz_version`;
    await this.writeThrough(rows);
  }

  /** Ends every existing session of every user holding this role. */
  async bumpRole(roleId: string): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; authz_version: number }>>`
      UPDATE users SET authz_version = authz_version + 1
      WHERE role_id = ${roleId}::uuid
      RETURNING id, authz_version`;
    await this.writeThrough(rows);
  }

  private async readDb(userId: string): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<Array<{ authz_version: number }>>`
      SELECT authz_version FROM users WHERE id = ${userId}::uuid`;
    return rows.length ? rows[0].authz_version : null;
  }

  private async writeThrough(rows: Array<{ id: string; authz_version: number }>): Promise<void> {
    for (const r of rows) {
      try {
        await this.redis.eval(SET_MAX, 1, KEY(r.id), String(r.authz_version), String(AUTHZ_VERSION_TTL_SECONDS));
      } catch (err) {
        // The database already holds the new version. If Redis is down, reads
        // fall back to the database; if it comes back holding the old value,
        // the TTL bounds how long that can last.
        this.logger.warn(`authz version cache write failed for one user (${(err as Error).message})`);
      }
    }
  }
}

/** Global so the guard (registered in AppModule) and every service that ends sessions share one instance. */
@Global()
@Module({ providers: [AuthzVersionService], exports: [AuthzVersionService] })
export class AuthzVersionModule {}
