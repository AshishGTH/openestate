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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('reports the real deployed package version, not a hardcoded fallback', async () => {
    // Regression test: process.env.npm_package_version is only set when
    // launched via `pnpm run`, never by systemd's/Docker's direct
    // `node dist/main.js` — a hardcoded fallback silently lied about the
    // running version in every real deployment.
    const controller = new HealthController();
    const result = await controller.check();
    const { version } = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));

    expect(result.version).toBe(version);
    expect(result.version).not.toBe('unknown');
  });
});
