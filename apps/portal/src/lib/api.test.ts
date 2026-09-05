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

// Mirrors apps/web/src/lib/api.test.ts's _authCache suite exactly (different
// storage key `_authCachePortal` — see api.ts's block on why the two apps use
// distinct keys). Same "prove the mechanism, not the CI cascade" caveat: a
// full Playwright run under real concurrent load is what proves the cascade
// fix; these tests prove the cache primitives themselves round-trip, expire,
// clear, and survive tampering without crashing.
describe('_authCache — sessionStorage cooldown bridge', () => {
  function encodeSegment(obj: unknown): string {
    return btoa(JSON.stringify(obj)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  }
  function fakeJwt(payload: Record<string, unknown>): string {
    return `${encodeSegment({ alg: 'HS256', typ: 'JWT' })}.${encodeSegment(payload)}.sig`;
  }

  // vitest defaults to the `node` environment (no DOM) — install a minimal
  // sessionStorage instead of pulling jsdom/happy-dom in as a dev dependency
  // just for these tests. Matches the Storage interface for the subset the
  // cache uses.
  function stubSessionStorage() {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      get length() { return store.size; },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
    });
  }

  beforeEach(() => {
    vi.resetModules();
    stubSessionStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('write then read round-trips the decoded payload; the raw token never enters storage', async () => {
    const { writeAuthCache, readAuthCache } = await import('./api');
    const token = fakeJwt({ sub: 'u1', permissions: ['x'], companyId: 'c1' });

    writeAuthCache(token);

    const cached = readAuthCache();
    expect(cached).not.toBeNull();
    expect(cached!.payload.sub).toBe('u1');
    expect(cached!.payload.permissions).toEqual(['x']);

    const raw = sessionStorage.getItem('_authCachePortal') ?? '';
    expect(raw).not.toContain(token);
    expect(raw).not.toContain('sig');
  });

  it('returns null once the cooldown window has elapsed', async () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const { writeAuthCache, readAuthCache, AUTH_COOLDOWN_MS } = await import('./api');
    writeAuthCache(fakeJwt({ sub: 'u1', permissions: [] }));

    expect(readAuthCache()).not.toBeNull();
    vi.setSystemTime(now + AUTH_COOLDOWN_MS + 1);
    expect(readAuthCache()).toBeNull();

    vi.useRealTimers();
  });

  it('returns null and does not throw on tampered/malformed storage', async () => {
    const { readAuthCache } = await import('./api');
    sessionStorage.setItem('_authCachePortal', 'not-json');
    expect(readAuthCache()).toBeNull();

    sessionStorage.setItem('_authCachePortal', '{"garbage":true}');
    expect(readAuthCache()).toBeNull();
  });

  it('clearAuthCache removes the entry', async () => {
    const { writeAuthCache, readAuthCache, clearAuthCache } = await import('./api');
    writeAuthCache(fakeJwt({ sub: 'u1', permissions: [] }));
    expect(readAuthCache()).not.toBeNull();

    clearAuthCache();
    expect(readAuthCache()).toBeNull();
  });
});
