# nginx.conf: what was checked in a cloud sandbox, and what was not

Environment: nginx 1.24.0 (Ubuntu package `nginx-light`, with `http_ssl` and `http_v2`), a throwaway self-signed certificate
for `staging.test`, a stub Python upstream on `127.0.0.1:3000` that echoes the headers it receives. 2026-09-30. This is not
your staging host.

## Found and fixed

`http2 on;` (my first version) is an **unknown directive on nginx 1.24** (it exists from 1.25.1). `nginx -t` said:
`unknown directive "http2" ... site.conf:43`. Replaced by `listen 443 ssl http2;`, which works on every version. Ubuntu
22.04 ships nginx 1.18 and 24.04 ships 1.24, so the original would have failed on both.

## Output after the fix

```text
$ nginx -t -c nginx-test.conf          # site file included inside an http { } block
nginx: the configuration file /tmp/claude-0/ngx/nginx-test.conf syntax is ok
nginx: configuration file /tmp/claude-0/ngx/nginx-test.conf test is successful

$ curl -I http://127.0.0.1/some/path -H 'Host: staging.test'
HTTP/1.1 301 Moved Permanently
Location: https://staging.test/some/path

$ curl -D - -X POST https://staging.test/api/v1/auth/refresh -H 'Cookie: openestate_refresh=xyz; openestate_csrf=c1' -H 'X-CSRF-Token: c1'
HTTP/2 200
set-cookie: openestate_refresh=abc; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict      (passed through untouched)
cache-control: no-store
strict-transport-security: max-age=31536000
upstream saw: {"path": "/api/v1/auth/refresh", "xfp": "https", "cookie": "openestate_refresh=xyz; openestate_csrf=c1",
               "csrf": "c1", "xff": "127.0.0.1", "host": "staging.test"}

upload of a 10,000,000-byte multipart file:  200
upload of a 12,000,000-byte multipart file:  413
HTTP version negotiated:                      2
TLS 1.1 handshake:                            refused (curl exit, no response)
```

## Not checked (still NOT TESTED)

- The two `listen [::]` (IPv6) lines: the sandbox has no IPv6, so `nginx -t` on the unmodified file fails there with
  `socket() [::]:80 failed (97: Address family not supported by protocol)`. The check above used a copy with those two
  lines removed. On a host with IPv6, run `nginx -t` on the real file.
- `/` and `/portal/` (the static frontends): `/opt/openestate/current` does not exist here, so `/` returned 500. Check
  them on staging after an install.
- A real certificate chain, certbot renewal, the real API behind it (cookie `Secure` behaviour with the real app, CSRF
  round trip), and HTTP/2 with a real browser or phone.
- The stub upstream is not the API: the cookie behaviour above proves nginx does not alter cookies and forwards the
  headers, not that the API's cookies work end to end. That is the mobile auth device test.
