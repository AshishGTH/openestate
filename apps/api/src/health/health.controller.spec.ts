import { describe, expect, it, vi } from 'vitest';

vi.mock('@openestate/db', () => ({
  getPrismaClient: () => ({
    $queryRaw: () => Promise.reject(new Error('no db configured in unit test')),
  }),
}));

vi.mock('ioredis', () => ({
  default: class {
    connect() {
      return Promise.reject(new Error('no redis configured in unit test'));
    }
    ping() {
      return Promise.resolve('PONG');
    }
    disconnect() {}
  },
}));

import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports degraded status when dependencies are unreachable', async () => {
    const controller = new HealthController();
    const result = await controller.check();

    expect(result.status).toBe('degraded');
    expect(result.db).toBe('down');
    expect(result.redis).toBe('down');
    expect(typeof result.uptimeSeconds).toBe('number');
  });
});
