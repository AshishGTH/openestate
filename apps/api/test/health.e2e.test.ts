/**
 * Health endpoint e2e test.
 *
 * Uses NestJS Test module to bootstrap the app in-process.
 * Requires DATABASE_URL_TEST_SYSTEM (Postgres) and REDIS_URL (Redis).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { HealthController } from '../src/health/health.controller';

const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';

const shouldRun = !!SYSTEM_URL;

describe.skipIf(!shouldRun)('GET /api/v1/health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL_SYSTEM = SYSTEM_URL;
    process.env.REDIS_URL = REDIS_URL;

    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns health status with db and redis both ok', async () => {
    const controller = app.get(HealthController);
    const result = await controller.check();

    expect(result.status).toBe('ok');
    expect(result.db).toBe('ok');
    expect(result.redis).toBe('ok');
    expect(result.version).toBeDefined();
    expect(typeof result.uptimeSeconds).toBe('number');
  });
});
