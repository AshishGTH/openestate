import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { getSystemPrisma } from '@openestate/db';
import type { HealthStatus } from '@openestate/shared';
import { Public } from '../auth/guards/jwt-auth.guard';
import Redis from 'ioredis';

const startedAt = Date.now();

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @Public()
  @ApiOperation({ summary: 'Liveness/readiness check: verifies DB and Redis connectivity.' })
  @ApiOkResponse({ description: 'Health status of the API and its dependencies.' })
  async check(): Promise<HealthStatus> {
    const [db, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);

    return {
      status: db === 'ok' && redis === 'ok' ? 'ok' : 'degraded',
      db,
      redis,
      version: process.env.npm_package_version ?? '0.1.0',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    };
  }

  private async checkDb(): Promise<'ok' | 'down'> {
    try {
      await getSystemPrisma().$queryRaw`SELECT 1`;
      return 'ok';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<'ok' | 'down'> {
    const url = process.env.REDIS_URL;
    if (!url) return 'down';
    const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    client.on('error', () => {
      // Swallow: connect()/ping() below surface the failure via the catch,
      // and without a listener ioredis logs a noisy "Unhandled error event".
    });
    try {
      await client.connect();
      await client.ping();
      return 'ok';
    } catch {
      return 'down';
    } finally {
      client.disconnect();
    }
  }
}
