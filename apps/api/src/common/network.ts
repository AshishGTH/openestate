/**
 * v0.8.4 Part M: where the API listens, and whose forwarded headers it believes.
 *
 * The API sits behind nginx on the same machine, so by default it listens on
 * loopback only: nothing on the network can reach :3000 and skip nginx. Set
 * HOST (for example 0.0.0.0) only when the reverse proxy runs elsewhere, or
 * inside a container.
 *
 * `trust proxy` is 'loopback': X-Forwarded-For / X-Forwarded-Proto are believed
 * only for hops on 127.0.0.0/8 or ::1. Express reads the forwarded chain from
 * the right and stops at the first address that is not loopback, which behind
 * nginx is the real client (nginx appends it). A client's own forwarded
 * entries sit further left and are never reached, and a client connecting
 * directly from the network is not trusted at all, even with HOST=0.0.0.0. The
 * previous setting, 1, trusted whatever peer was connected, so anyone reaching
 * :3000 directly could choose req.ip (rate limits, audit IP) and req.secure.
 */
export const TRUST_PROXY = 'loopback';

export function apiBindHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOST?.trim() || '127.0.0.1';
}
