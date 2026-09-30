> **SUPERSEDED. DO NOT MERGE THIS BRANCH.** `chore/deps-security-patches` is replaced by **`chore/rc-with-deps`**, which
> contains the same patch set on top of the G1-G7 release candidate. This branch is built from `master`, does not contain
> G1-G7, and its test numbers were reported wrongly earlier (they were never measured on this branch; see section 6). The
> version of this document you are reading is the corrected one. The verified results are on `chore/rc-with-deps`.

# Dependency security triage (API repo)

Audit date 2026-09-30, `pnpm audit` (advisory data from the npm registry), branch `chore/api-release-readiness`
(identical dependency tree to `master`: none of the G1-G7 branches changed a `package.json` or the lockfile).

**Nothing in this document is a claim that OpenEstate is or is not exploitable in production.** "Exposure" is my reading of
the code (which routes reach the vulnerable function, with what input, behind which guard). Where I could not establish it,
it says so.

## Summary

| Set | Advisories | Critical | High | Moderate | Low |
|---|---|---|---|---|---|
| `pnpm audit --prod` (63 distinct advisories on 25 packages) | 63 | 0 | 36 | 21 | 6 |
| dev-only additions (`pnpm audit`, not in `--prod`) | 18 | 1 | 8 | 8 | 1 |
| **Everything** | **81** | **1** | **44** | **29** | **7** |

(The earlier "70 issues, 40 high" was the tool's count of vulnerable paths; advisories are counted once here.)

Where the 63 production advisories actually live:

| Where | Packages | Advisories | Reaches a running server or a user's browser? |
|---|---|---|---|
| **API runtime** (`apps/api`, `packages/db`) | brace-expansion, deepmerge-ts, js-yaml, lodash, multer, sharp, @nestjs/core, file-type, qs, uuid, body-parser | 33 | Yes (the process that serves requests) |
| **Browser bundle** (`apps/web`, `apps/portal`) | react-router | 1 | Yes (code shipped to users' browsers) |
| **Docs-site build tooling** (`docs`, Docusaurus) | browserslist, fast-uri, image-size, joi, nanoid, serialize-javascript, svgo, baseline-browser-mapping, colord, postcss, webpack | 29 | No: runs only when someone builds the static documentation site, on trusted content |

Of the 34 that reach runtime, **only a handful have any realistic route to attacker-controlled input**. That analysis is the
point of this document.

## 1. Production dependencies that reach a running system

Ordered by the priority you set: remote and pre-authentication first, then authentication/security libraries, server/runtime,
customer-data handling, everything else.

| # | Package | Current | Severity | Advisory / CVE | Direct / transitive | Affected functionality | Exposed? | Safe upgrade | Breaking-change risk | Recommended action |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **qs** | 6.14.2 | moderate x3 | CVE-2026-82417 (DoS via attacker-controlled `isBuffer`), CVE-2026-82562 (array-limit bypass via bracket-key comma parsing), CVE-2026-8723 (`stringify` crash) | Transitive: express 4 and body-parser (via `@nestjs/platform-express`) | Parsing of query strings and urlencoded bodies | **Yes, pre-authentication.** Express parses `req.query` with qs on every request before any guard runs, so any client can send a crafted query string. Effect is availability only (CPU/exception), moderate. (`stringify`, CVE-2026-8723, is not called with attacker data) | 6.16.0 (same major) | Low: minor bump inside 6.x | **UPGRADE** (pnpm override) |
| 2 | **multer** | 2.0.2 (via NestJS) and 2.2.0 (direct) | high x10 | CVE-2026-2359, -3304, -3520, -5038, -5079, -77037, -77063, -77078, -82333, -88932 (DoS: resource exhaustion, incomplete cleanup of aborted uploads, deeply nested or oversized field names, file-descriptor leak; one file-size-limit bypass) | Direct (`multer ^2.2.0`) and transitive (platform-express pins 2.0.2) | Multipart uploads | **Authenticated only.** Four routes use it (`FileInterceptor`): inquiry import, inventory import, project media, construction-update media. Every one sits behind a permission guard, and NestJS runs guards before interceptors, so an unauthenticated request never reaches multer. Reachable by a signed-in staff user who holds the specific import/media permission | 2.4.0 (same major) | Low: patch/minor line of 2.x; `limits: { fileSize }` API unchanged | **UPGRADE** (bump direct dep, override the transitive one) |
| 3 | **sharp** | 0.35.3 | high | GHSA-rgj7-g3m4-5g8c (libheif vulnerabilities; upstream RCE class on glibc Linux "under certain conditions") | Direct | Re-encoding uploaded images (`UploadService.processImage`) | **Not reachable in practice.** Uploads are accepted only as `.jpg/.jpeg/.png/.pdf/.xlsx`, validated by extension, MIME and magic bytes (CLAUDE.md upload rules) and re-encoded as png/jpeg; a file that passes that check is decoded as JPEG/PNG, not HEIF. Still a customer-data-handling native library, so patch anyway | 0.35.5 (0.35.4 is the fix) | Low: patch line | **UPGRADE** |
| 4 | @nestjs/core | 10.4.22 | moderate | CVE-2026-35515 (`SseStream` does not neutralise newlines in `message.type`/`id`) | Transitive of the direct `@nestjs/core` | Server-Sent Events | **No.** The code base has no `@Sse` endpoint and never uses `SseStream` (checked) | 11.1.18 (a **major**) | **High**: NestJS 10 -> 11 is a framework upgrade touching every module | **DEFER, plan a dedicated NestJS 11 upgrade.** Not exposed, so not worth the risk inside a release candidate |
| 5 | js-yaml | 4.1.0 / 4.3.0 | high x3 (+2 moderate) | CVE-2025-64718 (prototype pollution in merge), CVE-2026-53550/-59869/-84375 and GHSA-5p4m (quadratic CPU in merge keys / `!!omap`) | Transitive: `@nestjs/swagger` | Parsing/emitting YAML | **No.** Only used by Swagger to serialise the API's own spec; no YAML from users is ever parsed | 4.3.2 (same major) | Low | **UPGRADE** (override; trivial, removes 5 advisories) |
| 6 | lodash | 4.17.21 | high (+2 moderate) | CVE-2026-4800 (code injection via `_.template` `imports` key names), CVE-2026-2950 / CVE-2025-13465 (prototype pollution in `_.unset`/`_.omit`) | Transitive: `@nestjs/config`, `@nestjs/swagger` | Utility functions | **No.** No caller passes untrusted input as `_.template` options or as an `_.unset`/`_.omit` path | 4.18.1 (same major) | Low | **UPGRADE** (override) |
| 7 | brace-expansion | 1.1.16 and 2.1.2 (runtime); 5.0.7 (dev) | high x8 (+2 moderate) | CVE-2026-14257, -69152, -102276, -102278 (DoS: unbounded expansion, deep recursion), CVE-2026-102277 (quadratic time) | Transitive: `minimatch` under `exceljs` -> `archiver`/`unzipper` -> `glob`; and others | Glob-pattern expansion | **No.** The vulnerable `expand()` is fed glob patterns chosen by the libraries themselves, never text from a request. (Excel import parses an uploaded workbook with `exceljs`, but the patterns used internally are fixed) | 1.1.21 / 2.1.7 / 5.0.12 (one fix per major line) | Low: each stays inside its own major | **UPGRADE** (three overrides) |
| 8 | file-type | 20.4.1 | moderate x2 | CVE-2026-31808 (infinite loop parsing ASF), CVE-2026-32630 (ZIP decompression bomb) | Transitive: `@nestjs/common` (used only by its optional `FileTypeValidator`) | Content-type sniffing | **No.** The code base does not use `FileTypeValidator` or `ParseFilePipe` (checked); upload type checks are our own magic-byte code | 21.3.4 (a major bump for a library only NestJS imports) | Medium for an unused code path | **UPGRADE with the NestJS 11 work**, or override to 21.3.4 if the full suite stays green |
| 9 | deepmerge-ts | 7.1.5 | high | CVE-2026-40345 (stack exhaustion on recursive object graphs) | Transitive: `prisma` -> `@prisma/config` (the Prisma CLI's config loading) | Merging configuration objects | **No.** Runs when the Prisma CLI loads its config, never on request data | 8.0.0 (a major; pinned by Prisma) | Medium: internal to Prisma | **DEFER** until the next Prisma upgrade brings it |
| 10 | uuid | 8.3.2 | moderate | CVE-2026-41907 (`v3/v5/v6` with a caller-supplied output buffer) | Transitive: `exceljs` | UUID generation | **No.** Only `v4()` without a buffer is used by `exceljs` | 11.1.1 (a major) | Medium (ESM/CJS change) | **ACCEPT** (not exposed); revisit when `exceljs` updates |
| 11 | body-parser | 1.20.4 | low | CVE-2026-12590 (an *invalid* `limit` option silently disables the size check) | Transitive: `@nestjs/platform-express` | Request body size limit | **No.** We do not configure body-parser with an invalid `limit` value | 1.20.8 | Low | **UPGRADE** (override, one line) |

Direct/transitive is relative to the workspace that declares it: `multer` and `sharp` are the only vulnerable packages that
`apps/api` lists itself.

## 2. Production dependencies in the browser bundle

| Package | Current | Severity | Advisory | Direct / transitive | Affected functionality | Exposed? | Safe upgrade | Risk | Action |
|---|---|---|---|---|---|---|---|---|---|
| react-router | 7.18.1 | high | GHSA-qwww-vcr4-c8h2 (CSRF bypass in the **unstable RSC** code paths) | Transitive of `react-router-dom` in `apps/web` and `apps/portal` | React Server Components mode | **No.** Both apps use library mode (`BrowserRouter`), never the RSC APIs | 7.18.4 (`react-router-dom` 7.18.4) | Low: patch line | **UPGRADE** (bump `react-router-dom` in both apps) |

## 3. Documentation-site build tooling (`docs`, Docusaurus)

29 advisories on 11 packages: browserslist, fast-uri (7), image-size, joi, nanoid, serialize-javascript, svgo, postcss,
colord, baseline-browser-mapping, webpack.
They run only when the documentation site is **built** (`docs` workspace), on content we author, and the result is a static
site. No customer data, no server, no user input. They are counted by `pnpm audit --prod` only because Docusaurus lists them
as dependencies. `fast-uri` and `serialize-javascript` are rated high; neither is reachable from anything a visitor can send.

**Action: ACCEPT for now; refresh with the next Docusaurus minor update** (the fixed versions are all patch bumps that a
Docusaurus update or `pnpm update --filter docs` would normally carry). Not release-blocking.

## 4. Development-only dependencies

| Package | Current | Severity | Advisory | Affected functionality | Exposed? | Fix | Action |
|---|---|---|---|---|---|---|---|
| **vitest** | 2.1.9 | **critical** | CVE-2026-47429 (arbitrary file read/execute when the **Vitest UI server** is listening); CVE-2026-84373 (path traversal via `@vitest/mocker`) | Test runner | Only while `vitest --ui` (or the API server) is listening on a developer's machine. CI and our scripts run it headless; we never start the UI | 3.2.6 or 4.1.11 (**major**) | **DEFER to a dedicated test-tooling upgrade**; meanwhile do not run `vitest --ui` |
| vite | 5.4.21 | high, moderate x2 | CVE-2026-53571 (`server.fs.deny` bypass on Windows), CVE-2026-39365, CVE-2026-53632 | Dev server | Developer machines running `vite dev` (mostly Windows). The production web/portal are static files served by nginx; vite is not on any server | 6.4.3 (major) | DEFER |
| esbuild | 0.21.5 | moderate | GHSA-67mh-4wv8-2f99 (any website can send requests to the dev server) | Dev server | Developer machines only | 0.25.0 | DEFER (comes with vite 6) |
| glob 10.4.5, tmp 0.0.33, picomatch 4.0.1, ajv 8.12.0, brace-expansion 5.0.7 | as listed | high / moderate | CLI command injection (glob `-c`), path traversal (tmp), ReDoS (picomatch, ajv), brace-expansion DoS | Build and lint tooling (`@nestjs/cli`, eslint, etc.) | Run on developer/CI machines against our own files | patch/minor lines | ACCEPT; a routine `pnpm update` |

## 5. Decision

| Action | Items | Why |
|---|---|---|
| **UPGRADE now** (patch/minor inside the same major; overrides where a parent pins it) | qs, multer, sharp, js-yaml, lodash, brace-expansion (x3 lines), body-parser, react-router-dom | Covers the only pre-authentication input path (qs), the direct dependencies (multer, sharp) and everything that is a trivial same-major bump. Applied on branch `chore/deps-security-patches` (section 6) |
| **DEFER, planned** | @nestjs/core -> 11 (SSE not used), deepmerge-ts (Prisma-internal), file-type -> 21 (unused validator), uuid -> 11, vitest/vite/esbuild majors | Not exposed; each needs a major upgrade with real regression risk. Schedule as separate work items |
| **ACCEPT** | docs-site tooling; dev-machine CLI tooling | Build/dev time only, no request path |

Nothing that needs a major upgrade is applied in this release candidate.

## 6. What was applied, and where each number comes from

**Correction (evidence review).** The first version of this section reported "122 files / 892 tests, web 81, portal 215" as
the result on `chore/deps-security-patches`. That was wrong on two counts:

- `chore/deps-security-patches` is built from `master` and does not contain the G1-G7 branches (113 API test files there, 122
  on the release candidate, counted with `git ls-tree` for `*.test.ts` / `*.spec.ts` under `apps/api`), so 122 files / 892 tests cannot have come from it. Those totals match the release candidate
  (`chore/api-release-readiness`) and were not measured on the patch branch. **No test result was ever recorded for
  `chore/deps-security-patches` on its own.**
- "web 81 / portal 215" were the `packages/db` (81) and `packages/shared` (215) counts, mislabelled. The web and portal
  counts are 6 and 4.

The combination that will ship is release candidate + patches. It now exists as **`chore/rc-with-deps`**, and every number
below comes from that branch.

### Patch set (unchanged from the triage)

- Overrides in the root `package.json`: qs 6.16.0, multer 2.4.0, js-yaml 4.3.2, lodash 4.18.1, body-parser 1.20.8,
  brace-expansion 1.1.21 / 2.1.7 / 5.0.12.
- Direct bumps: multer ^2.4.0 and sharp ^0.35.5 (`apps/api`); react-router-dom ^7.18.4 (`apps/web`, `apps/portal`).
- The lockfile was regenerated on this branch (not copied from the patch branch).

### Verification on `chore/rc-with-deps` (2026-09-30)

Procedure: delete every `node_modules` and every `dist`, `pnpm install --frozen-lockfile`, provision the test database with
`scripts/test-setup.sh` (this also runs `prisma generate`), then typecheck, lint, build, then each test suite
(`CI=true PROPERTY_NUM_RUNS=500`). PostgreSQL 16 and Redis 7 on one development machine. Counts are copied from the runner
output.

| Step | Result |
|---|---|
| Install | exit 0, lockfile up to date |
| Typecheck (turbo) | 15 of 15 tasks successful |
| Lint (turbo) | 14 of 14 tasks successful |
| Build (turbo, includes web and portal production builds) | 10 of 10 tasks successful |

| Suite | Test files | Tests |
|---|---|---|
| `apps/api` | 122 passed (122) | 892 passed (892) |
| `packages/db` | 11 passed (11) | 81 passed (81) |
| `packages/shared` | 15 passed (15) | 215 passed (215) |
| `apps/web` | 3 passed (3) | 6 passed (6) |
| `apps/portal` | 2 passed (2) | 4 passed (4) |

Counts are the same as reported earlier for the release candidate (122 / 892, 11 / 81, 15 / 215); only their attribution was
wrong, and the web/portal figures were mislabelled.

An earlier attempt on this branch failed 97 API tests in six inquiry e2e files. The cause was the test run, not the
patches: those tests load the compiled `apps/api/dist`, which was stale from another branch because the script did not
rebuild it. The run above starts from an empty `dist`.

### Audit (`pnpm audit --prod`)

| | Distinct advisories | By severity (advisories) | Tool's per-path count (low / moderate / high) |
|---|---|---|---|
| Release candidate, before patches (measured this session) | 63 | see section 1 | 9 / 21 / 40 |
| `chore/rc-with-deps`, after patches | 29 | 4 low, 10 moderate, 15 high, 0 critical | 6 / 10 / 15 |

Note: the earlier text mixed two measures ("63 to 31"). Advisories (unique) went 63 to **29**; the tool's per-path count went
70 to **31**. Severity split of the 63 before patches is in section 1 (36 high, 21 moderate, 6 low).

What remains, by advisories: docs-site build tooling 24 (accepted, section 5); runtime `@nestjs/core` 1, `file-type` 2,
`uuid` 1, `deepmerge-ts` 1 (deferred, not exposed, section 5). No critical.

**Not tested:** these packages on a staging server. Runtime behaviour of the upgraded multer, sharp and qs on a real host is
`NOT TESTED`.
