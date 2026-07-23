/**
 * Phase 7 commit 1 (plugin-core): ctx.http's SSRF guard + secret-header
 * resolution — pure logic, no Postgres/network needed, same fast tier
 * as plugin-registry.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { createScopedHttpClient, isPublicIp, resolveSecretHeaders } from '../src/plugins/plugin-http-client';

describe('isPublicIp (Phase 7 commit 1, addendum A2)', () => {
  it.each([
    ['127.0.0.1', false, 'IPv4 loopback'],
    ['10.0.0.5', false, '10.0.0.0/8'],
    ['172.16.0.1', false, '172.16.0.0/12'],
    ['172.31.255.255', false, '172.16.0.0/12 upper bound'],
    ['172.32.0.1', true, 'just outside 172.16.0.0/12'],
    ['192.168.1.1', false, '192.168.0.0/16'],
    ['169.254.1.1', false, '169.254.0.0/16 link-local'],
    ['100.64.0.1', false, '100.64.0.0/10 CGNAT'],
    ['0.0.0.0', false, '0.0.0.0/8'],
    ['224.0.0.1', false, 'multicast'],
    ['8.8.8.8', true, 'a real public IPv4'],
    ['1.1.1.1', true, 'a real public IPv4'],
    ['::1', false, 'IPv6 loopback'],
    ['fe80::1', false, 'IPv6 link-local'],
    ['fc00::1', false, 'IPv6 unique local (fc)'],
    ['fd12:3456::1', false, 'IPv6 unique local (fd)'],
    ['ff02::1', false, 'IPv6 multicast'],
    ['::ffff:127.0.0.1', false, 'IPv4-mapped IPv6 loopback'],
    ['::ffff:8.8.8.8', true, 'IPv4-mapped IPv6 public address'],
    ['2001:4860:4860::8888', true, 'a real public IPv6'],
  ])('isPublicIp(%s) === %s (%s)', (ip, expected) => {
    expect(isPublicIp(ip)).toBe(expected);
  });
});

describe('ctx.http SSRF guard end-to-end (Phase 7 commit 1, addendum A2)', () => {
  it('rejects a request to loopback before any connection is attempted', async () => {
    const client = createScopedHttpClient('test-plugin', new Map());
    await expect(client.request({ url: 'http://127.0.0.1:1/' })).rejects.toThrow(/not a public address.*SSRF guard/);
  });

  it('rejects a request to a private-range address', async () => {
    const client = createScopedHttpClient('test-plugin', new Map());
    await expect(client.request({ url: 'http://10.0.0.5:1/' })).rejects.toThrow(/not a public address.*SSRF guard/);
  });

  it('rejects a non-http(s) scheme', async () => {
    const client = createScopedHttpClient('test-plugin', new Map());
    await expect(client.request({ url: 'file:///etc/passwd' })).rejects.toThrow(/unsupported scheme/);
  });
});

describe('resolveSecretHeaders (Phase 7 commit 1, addendum A1)', () => {
  it('passes plain string header values through unchanged', () => {
    const result = resolveSecretHeaders({ 'X-Custom': 'plain-value' }, new Map());
    expect(result).toEqual({ 'X-Custom': 'plain-value' });
  });

  it('resolves a SecretHeaderSpec to the formatted plaintext, without the plugin ever holding the raw value', () => {
    const realSecrets = new Map([['apiKey', 'super-secret-key-123']]);
    const spec = { __secretHeaderSpec: true as const, fieldKey: 'apiKey', format: (v: string) => `Bearer ${v}` };
    const result = resolveSecretHeaders({ Authorization: spec }, realSecrets);
    expect(result).toEqual({ Authorization: 'Bearer super-secret-key-123' });
  });

  it('throws a clear error when the referenced secret field was never configured', () => {
    const spec = { __secretHeaderSpec: true as const, fieldKey: 'missingKey', format: (v: string) => v };
    expect(() => resolveSecretHeaders({ Authorization: spec }, new Map())).toThrow(/no secret configured for field "missingKey"/);
  });

  it('rejects a header value that is neither a string nor a SecretHeaderSpec', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolveSecretHeaders({ 'X-Bad': { not: 'valid' } as any }, new Map()),
    ).toThrow(/is not a string or a value returned by ctx.secretHeader/);
  });
});
