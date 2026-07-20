import { describe, expect, it } from 'vitest';

const baseUrl = process.env.API_BASE_URL;

describe.skipIf(!baseUrl)('GET /api/v1/health (against a running stack)', () => {
  it('returns 200 with db/redis both ok', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.db).toBe('ok');
    expect(body.redis).toBe('ok');
  });
});
