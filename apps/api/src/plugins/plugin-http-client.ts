import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupFunction, Socket } from 'node:net';
import type { HttpRequestOptions, HttpResponse, ScopedHttpClient, SecretHeaderSpec } from '@openestate/plugin-sdk';

const TOTAL_DEADLINE_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_000_000; // 1MB
const MAX_REDIRECTS = 1;

/**
 * ctx.http, present only when a plugin declares the 'outbound-http'
 * capability. SSRF-hardened per CLAUDE.md Phase 7 decisions, addendum
 * A2 — resolve-then-PIN, not resolve-then-reconnect:
 *
 *   1. `dns.lookup(hostname)` is called exactly ONCE per hop.
 *   2. The returned IP is validated against private/loopback/
 *      link-local/reserved ranges (IPv4 + IPv6) BEFORE any connection
 *      is attempted.
 *   3. The actual request is issued with Node's `lookup` option
 *      overridden to return that already-validated IP directly — the
 *      TCP connection is pinned to it. The original hostname is still
 *      used for the `Host` header and TLS `servername` (both default
 *      from `options.host`, which is left untouched — only the
 *      internal resolver is overridden), so virtual-hosted HTTPS
 *      endpoints keep working.
 *
 *   This closes the DNS-rebinding TOCTOU a naive "validate the resolved
 *   IP, then let the HTTP client re-resolve and connect separately"
 *   implementation would leave open (a hostname could resolve to a
 *   public IP at validation time and a private one at connect time).
 *
 * Only http/https schemes are accepted. Redirects are capped at 1 hop
 * and handled manually — the redirect target goes through the SAME
 * resolve-validate-pin sequence from scratch, never trusted blindly.
 * The 10s deadline is a single AbortController covering the original
 * request and its one allowed redirect together, not reset per hop.
 * Response bodies are capped at 1MB.
 */
/** Resolves any `SecretHeaderSpec` values in a header map to their real
 * plaintext — extracted as a standalone, pure function (no network, no
 * closure state) so it's directly unit-testable without a live socket.
 * See CLAUDE.md Phase 7 decisions, addendum A1: the plaintext only ever
 * exists transiently here, inside the plugin-authored `format` callback
 * the runtime invokes — never assigned to a variable in hook code. */
export function resolveSecretHeaders(
  headers: Record<string, string | SecretHeaderSpec> | undefined,
  realSecrets: ReadonlyMap<string, string>,
): Record<string, string> {
  if (!headers) return {};
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      resolved[key] = value;
      continue;
    }
    if (!isSecretHeaderSpec(value)) {
      throw new Error(`ctx.http: header "${key}" is not a string or a value returned by ctx.secretHeader()`);
    }
    const plaintext = realSecrets.get(value.fieldKey);
    if (plaintext === undefined) {
      throw new Error(`ctx.http: no secret configured for field "${value.fieldKey}"`);
    }
    resolved[key] = value.format(plaintext);
  }
  return resolved;
}

export function createScopedHttpClient(pluginId: string, realSecrets: ReadonlyMap<string, string>): ScopedHttpClient {
  async function dispatchOnce(
    target: URL,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer; location: string | undefined }> {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error(`ctx.http[${pluginId}]: unsupported scheme "${target.protocol}" — only http/https are allowed`);
    }

    const { address, family } = await dnsLookup(target.hostname);
    assertPublicAddress(target.hostname, address);

    const requestFn = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (typeof options === 'function') {
        (options as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(null, address, family);
      } else {
        callback(null, address, family);
      }
    };

    return new Promise((resolve, reject) => {
      const req = requestFn(
        {
          protocol: target.protocol,
          hostname: target.hostname, // preserved for Host header + TLS SNI (servername defaults from this)
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method,
          headers,
          lookup: pinnedLookup,
          signal,
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_RESPONSE_BYTES) {
              req.destroy(new Error(`ctx.http[${pluginId}]: response exceeded 1MB cap`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const responseHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === 'string') responseHeaders[k] = v;
              else if (Array.isArray(v)) responseHeaders[k] = v.join(', ');
            }
            resolve({
              status: res.statusCode ?? 0,
              headers: responseHeaders,
              body: Buffer.concat(chunks),
              location: res.headers.location,
            });
          });
        },
      );
      req.on('error', reject);
      // Belt-and-suspenders: also validate on actual socket connect, in
      // case a future Node change makes `lookup`'s returned address
      // advisory rather than authoritative for some code path.
      req.on('socket', (socket: Socket) => {
        socket.once('lookup', (err, resolvedAddress) => {
          if (!err && resolvedAddress && resolvedAddress !== address) {
            req.destroy(new Error(`ctx.http[${pluginId}]: resolved address changed unexpectedly between validation and connect`));
          }
        });
      });
      if (body) req.write(body);
      req.end();
    });
  }

  return {
    async request(options: HttpRequestOptions): Promise<HttpResponse> {
      const method = options.method ?? 'GET';
      const headers = resolveSecretHeaders(options.headers, realSecrets);
      const body = options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      if (body !== undefined && !('content-type' in Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])))) {
        headers['Content-Type'] = 'application/json';
      }

      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(new Error(`ctx.http[${pluginId}]: total deadline of ${TOTAL_DEADLINE_MS}ms exceeded`)), TOTAL_DEADLINE_MS);

      try {
        let target = new URL(options.url);
        let redirects = 0;
        for (;;) {
          const result = await dispatchOnce(target, method, headers, body, controller.signal);
          const isRedirect = result.status >= 300 && result.status < 400 && result.location;
          if (!isRedirect || redirects >= MAX_REDIRECTS) {
            let parsedBody: unknown = result.body.toString('utf8');
            try {
              parsedBody = JSON.parse(parsedBody as string);
            } catch {
              // not JSON — leave as text
            }
            return { status: result.status, headers: result.headers, body: parsedBody };
          }
          redirects++;
          target = new URL(result.location!, target); // resolve relative Location against the current target
        }
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}

function isSecretHeaderSpec(value: unknown): value is SecretHeaderSpec {
  return typeof value === 'object' && value !== null && (value as { __secretHeaderSpec?: unknown }).__secretHeaderSpec === true;
}

/** Rejects loopback/private/link-local/reserved/multicast ranges for
 * both IPv4 and IPv6 — well-known ranges, not an exhaustive IANA table,
 * documented as such. */
function assertPublicAddress(hostname: string, ip: string): void {
  if (!isPublicIp(ip)) {
    throw new Error(`ctx.http: "${hostname}" resolved to ${ip}, which is not a public address — refusing to connect (SSRF guard)`);
  }
}

/** Exported for direct unit testing — the actual SSRF-relevant logic,
 * independent of any network/socket plumbing. */
export function isPublicIp(ip: string): boolean {
  if (ip.includes(':')) return isPublicIpv6(ip);
  return isPublicIpv4(ip);
}

function isPublicIpv4(ip: string): boolean {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return false; // 10.0.0.0/8
  if (a === 127) return false; // 127.0.0.0/8 loopback
  if (a === 0) return false; // 0.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
  if (a === 192 && b === 168) return false; // 192.168.0.0/16
  if (a === 169 && b === 254) return false; // 169.254.0.0/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT
  if (a >= 224) return false; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return true;
}

function isPublicIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return false; // loopback
  if (normalized === '::') return false; // unspecified
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false; // fc00::/7 unique local
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return false; // fe80::/10 link-local
  if (normalized.startsWith('ff')) return false; // ff00::/8 multicast
  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded IPv4 too.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPublicIpv4(mapped[1]);
  return true;
}
