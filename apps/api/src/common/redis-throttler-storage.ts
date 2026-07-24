import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import type { ThrottlerStorage } from '@nestjs/throttler';

// Not re-exported from '@nestjs/throttler''s public index (only the
// throttler-storage.interface module is, which references this type
// internally without re-exporting it) — redeclared structurally here to
// match increment()'s required return shape exactly.
interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Redis-backed ThrottlerStorage (closes the Phase 1/6/7 docs/todo.md gap —
 * @nestjs/throttler's default in-memory store means rate-limit state isn't
 * shared across replicas and resets on restart). Hand-rolled on the
 * existing `ioredis` dependency (already used by queues.module.ts for
 * BullMQ) rather than adding a third-party throttler-storage package —
 * the interface is one method, and this codebase's established preference
 * is small hand-rolled implementations over new dependencies when the
 * surface is small (see Phase 7's SSRF/dot-path-resolver precedent in
 * CLAUDE.md).
 *
 * Atomicity via a single Lua script (EVAL), not separate INCR/EXPIRE
 * calls — replicates @nestjs/throttler's own ThrottlerStorageService
 * semantics (throttler.service.js) exactly: a fixed window per
 * `${throttlerName}:${key}` that resets once expired, a block window that
 * activates once the window's hit count exceeds `limit`, and unblocks
 * (with a fresh single-hit window) once blockExpiresAt has passed. Uses
 * Redis server TIME (not Date.now()) so multiple app replicas agree on a
 * single clock regardless of any individual instance's clock skew — the
 * entire point of moving this out of per-process memory.
 */
const INCREMENT_SCRIPT = `
local key = KEYS[1]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local data = redis.call('HMGET', key, 'hits', 'expiresAt', 'blockExpiresAt', 'isBlocked')
local hits = tonumber(data[1])
local expiresAt = tonumber(data[2])
local blockExpiresAt = tonumber(data[3])
local isBlocked = data[4] == '1'

if hits == nil then
  hits = 0
  expiresAt = now + ttl
  blockExpiresAt = 0
  isBlocked = false
end

if expiresAt <= now then
  expiresAt = now + ttl
end

if not isBlocked then
  hits = hits + 1
end

if hits > limit and not isBlocked then
  isBlocked = true
  blockExpiresAt = now + blockDuration
end

local timeToBlockExpire = 0
if isBlocked then
  timeToBlockExpire = blockExpiresAt - now
  if timeToBlockExpire <= 0 then
    isBlocked = false
    hits = 1
    expiresAt = now + ttl
    blockExpiresAt = 0
    timeToBlockExpire = 0
  end
end

redis.call('HSET', key, 'hits', hits, 'expiresAt', expiresAt, 'blockExpiresAt', blockExpiresAt, 'isBlocked', isBlocked and '1' or '0')
local pttl = math.max(expiresAt - now, blockExpiresAt - now, 1000)
redis.call('PEXPIRE', key, pttl)

local timeToExpireSec = math.ceil((expiresAt - now) / 1000)
local timeToBlockExpireSec = math.ceil(timeToBlockExpire / 1000)

return {hits, timeToExpireSec, isBlocked and 1 or 0, timeToBlockExpireSec}
`;

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly redis: Redis;
  private readonly keyPrefix: string;

  constructor() {
    this.redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    // Empty in every real deployment — the whole point of this class is a
    // SHARED namespace across replicas. Exists only so a test file that
    // needs exact hit-count assertions on a real, narrow bucket (the
    // portal-auth bucket's 5-req/5-min limit, deliberately tight so it's
    // easy to exhaust in a test) can claim its own private key namespace
    // instead of sharing state with whichever other e2e file happens to
    // be running concurrently in a different vitest fork and touches the
    // same IP-keyed bucket — see e2e-portal-throttle.test.ts's own
    // comment on THROTTLE_TEST_KEY_PREFIX for the full story. Redis-backed
    // storage is real, shared, external state; unlike the in-memory
    // default it replaced, concurrently-running test files no longer get
    // free isolation from each other for free.
    this.keyPrefix = process.env.THROTTLE_TEST_KEY_PREFIX ?? '';
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const redisKey = `${this.keyPrefix}throttle:${throttlerName}:${key}`;
    const result = (await this.redis.eval(
      INCREMENT_SCRIPT,
      1,
      redisKey,
      ttl,
      limit,
      blockDuration,
    )) as [number, number, number, number];
    const [totalHits, timeToExpire, isBlockedNum, timeToBlockExpire] = result;
    return { totalHits, timeToExpire, isBlocked: isBlockedNum === 1, timeToBlockExpire };
  }

  onApplicationShutdown() {
    this.redis.disconnect();
  }
}
