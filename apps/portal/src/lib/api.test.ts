import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mirror of apps/web/src/lib/api.test.ts — same bug, same root cause, same
// fix, in both clients (this project's mirrored-auth standing rule).
// api.ts holds accessToken/refreshPromise as module-scoped `let` state, not
// exported/resettable — vi.resetModules() + a fresh dynamic import per test
// gives each test its own clean instance instead of leaking state across
// tests in this file.
describe('refreshSession — concurrent-call de-dup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown) {
    return { ok: true, json: async () => body } as unknown as Response;
  }

  it('two concurrent calls make exactly one network request and both resolve to the same, consistent state', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ accessToken: 'token-a' }));

    const { refreshSession, getAccessToken } = await import('./api');

    const [first, second] = await Promise.all([refreshSession(), refreshSession()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toBe('token-a');
    expect(second).toBe('token-a');
    expect(getAccessToken()).toBe('token-a');
  });

  it('a call after the first has resolved fires a new request — de-dup is scoped to concurrency, not a permanent cache', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'token-a' }))
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'token-b' }));

    const { refreshSession } = await import('./api');

    const tokenA = await refreshSession();
    const tokenB = await refreshSession();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tokenA).toBe('token-a');
    expect(tokenB).toBe('token-b');
  });

  it('a failed refresh among concurrent callers resolves every caller to null, never a half-set session', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: false } as unknown as Response);

    const { refreshSession, getAccessToken } = await import('./api');

    const [first, second] = await Promise.all([refreshSession(), refreshSession()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(getAccessToken()).toBeNull();
  });
});
