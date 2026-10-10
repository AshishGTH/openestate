import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { TRUST_PROXY, apiBindHost } from './network';

// The same express the app runs on (through @nestjs/platform-express).
const express = createRequire(require.resolve('@nestjs/platform-express'))('express');

/** req.ip and req.secure as Express computes them for this peer and these headers. */
function seen(peer: string, headers: Record<string, string> = {}) {
  const app = express();
  app.set('trust proxy', TRUST_PROXY);
  const req = Object.create(app.request);
  req.app = app;
  req.headers = headers;
  req.connection = req.socket = { remoteAddress: peer, encrypted: false };
  return { ip: req.ip as string, secure: req.secure as boolean };
}

describe('v0.8.4 Part M: forwarded headers are believed only from loopback', () => {
  it('a client on the network cannot choose its address or claim https', () => {
    expect(seen('203.0.113.9', { 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' })).toEqual({
      ip: '203.0.113.9',
      secure: false,
    });
  });

  it('a client on the network that puts loopback addresses in X-Forwarded-For still resolves to itself', () => {
    expect(seen('203.0.113.9', { 'x-forwarded-for': '127.0.0.1' }).ip).toBe('203.0.113.9');
    expect(seen('203.0.113.9', { 'x-forwarded-for': '::1' }).ip).toBe('203.0.113.9');
    expect(seen('203.0.113.9', { 'x-forwarded-for': '198.51.100.1, 127.0.0.1, ::1' }).ip).toBe('203.0.113.9');
  });

  it('behind the local nginx, the real client is used and its own forged entries are ignored', () => {
    // nginx appends the client's address to whatever the client sent.
    expect(seen('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 198.51.100.7', 'x-forwarded-proto': 'https' })).toEqual({
      ip: '198.51.100.7',
      secure: true,
    });
    expect(seen('::1', { 'x-forwarded-for': '198.51.100.7' }).ip).toBe('198.51.100.7');
    expect(seen('::ffff:127.0.0.1', { 'x-forwarded-for': '198.51.100.7' }).ip).toBe('198.51.100.7');
  });

  it('a forged loopback entry behind nginx does not hide the real client', () => {
    expect(seen('127.0.0.1', { 'x-forwarded-for': '127.0.0.1, 198.51.100.7' }).ip).toBe('198.51.100.7');
  });

  it('a local tunnel in front of nginx (two loopback hops) still yields the client', () => {
    expect(seen('127.0.0.1', { 'x-forwarded-for': '203.0.113.50, 127.0.0.1' }).ip).toBe('203.0.113.50');
  });
});

describe('v0.8.4 Part M: bind address', () => {
  it('defaults to loopback, including when HOST is empty', () => {
    expect(apiBindHost({})).toBe('127.0.0.1');
    expect(apiBindHost({ HOST: '  ' })).toBe('127.0.0.1');
  });

  it('uses HOST when set', () => {
    expect(apiBindHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });
});
