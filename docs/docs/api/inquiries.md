---
title: Inquiries API (mobile contract)
sidebar_position: 10
---

# Inquiries API

The interactive OpenAPI spec is served at `/api/v1/docs` (generated from the
controllers' decorators). This page is the human contract for the list endpoint
and the behaviours the OpenEstate mobile app relies on.

All routes are under `/api/v1`. Authenticate with `Authorization: Bearer <access token>`.
Reads need no CSRF token; mutations need the double-submit `X-CSRF-Token`.
Every list is scoped to the caller's team (see [Authorization](#authorization)).

## Authorization

| | |
|---|---|
| Authentication | Bearer access token (staff surface). Unauthenticated: `401` |
| Permission | `presales.inquiry.read`. Missing: `403` |
| Scope | The caller's own leads plus their reporting subtree (`users.manager_id`). Holders of `admin.team-scope.all` see the whole company. Never another company |
| Out-of-scope ids | Reported as `404`, not `403`, so ids cannot be probed |

Search, filters and sorting only ever **narrow** the caller's visible set.

## `GET /inquiries`

List inquiries, newest first by default.

| | |
|---|---|
| Method / path | `GET /api/v1/inquiries` |
| Request body | none |
| Pagination | `page` (default 1, min 1) and `limit` (default 20, max 100). Response `meta` carries `page`, `limit`, `total` (matches, not just this page) and `totalPages`. A page past the end returns `data: []` with the same `meta` |

### Query parameters

| Name | Type | Notes |
|---|---|---|
| `page`, `limit` | integers | As above. Invalid values: `400` |
| `status` | `OPEN`, `CONTINUED`, `SUCCESSFUL`, `DUMPED` | One value, a comma list (`OPEN,CONTINUED`), or repeated (`status=OPEN&status=CONTINUED`): a union. Case-sensitive. Unknown values are `400`. Omitted or empty means no status filter |
| `sortBy` | `createdAt`, `updatedAt`, `nextFollowupAt`, `status` | Default: `createdAt` descending. `nextFollowupAt` puts leads **with no follow-up last**, in both directions. Any other value is `400` (previously any column name was passed to the database layer, and a bad one caused a `500`) |
| `sortOrder` | `asc` \| `desc` | Applies when `sortBy` is given. Default `asc` |
| `search` | string, max 255 | Case-insensitive match on **applicant name**, **applicant email**, **project name**, and **phone**. A phone-like term (digits, spaces, dashes, brackets, leading `+`) of 3+ digits matches the stored number: `98765`, `98765 43210`, `+91 98765 43210` and `098765 43210` all find `9876543210`. Non-Indian numbers, stored as typed, match the text as typed. Fewer than 2 characters, or blank, is **ignored** (unfiltered list). `%` and `_` are matched literally. Alternate phone numbers are not searched |

### Response `200`

```json
{
  "data": [
    {
      "id": "0b1c…",
      "status": "OPEN",
      "nextFollowupAt": "2026-10-01T05:30:00.000Z",
      "applicant": { "id": "…", "name": "Rahul Sharma", "primaryPhone": "9876543210", "email": "rahul.sharma@example.com" },
      "project": { "id": "…", "name": "Green Woods Residency" },
      "temperature": { "id": "…", "name": "Hot" },
      "assignedTo": { "id": "…", "name": "Ashish Kumar", "email": "…" },
      "createdAt": "…", "updatedAt": "…"
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

(Fields shown are those the mobile app reads; the full row is returned. Credential
columns are never included.)

### Errors

| Status | When |
|---|---|
| `400` | `search` longer than 255 characters; `page`/`limit` not integers or out of range; `status` with an unknown value; `sortBy` outside the whitelist; `sortOrder` not `asc`/`desc` |
| `401` | No or invalid access token |
| `403` | Caller lacks `presales.inquiry.read` |

Pages are **stable**: rows are ordered by the sort field and then by `id`, so a
non-unique sort (for example `status`) never repeats or drops rows between pages.

### Examples

```bash
# Anyone in the visible set whose name, email, project or phone matches "rahul"
curl -H "Authorization: Bearer $TOKEN" \
  "https://crm.example.com/api/v1/inquiries?search=rahul&page=1&limit=20"

# The mobile combination: search + status + pagination
curl -H "Authorization: Bearer $TOKEN" \
  "https://crm.example.com/api/v1/inquiries?search=ashish&status=OPEN&page=1&limit=20"

# By phone, however it is typed
curl -H "Authorization: Bearer $TOKEN" \
  "https://crm.example.com/api/v1/inquiries?search=%2B91%2098765%2043210"
```

### Compatibility

Unknown query parameters are ignored (not rejected), so existing callers that add
their own (for example a cache-buster) keep working.

Additive. `search` was previously accepted and silently ignored; callers that sent
it (the web app does not) will now get filtered results. Without `search` the
response is identical to before.

### Behaviour changes in this version

- `sortBy` is now a whitelist (see above). Sorting by another inquiry column, which
  used to work by accident, is now a `400`.
- `GET|PATCH /inquiries/:id` and `PATCH /inquiries/:id/assign` return `400` for an id
  that is not a UUID. They used to return `500`.

## Follow-up filters and `assignedTo` on `GET /inquiries`

These narrow the list further and work together with `search`, `status`, sorting and pagination.
They use the lead's follow-up date, `nextFollowupAt`, which is the field the app treats as "next action".

| Name | Type | Notes |
|---|---|---|
| `followUpAfter` | ISO 8601 instant **with offset** | Inclusive lower bound on `nextFollowupAt`. Date-only or offset-less values (`2026-10-01`, `2026-10-01T00:00:00`) are `400`: they would be read as UTC and give the wrong day to a client in another zone |
| `followUpBefore` | ISO 8601 instant with offset | Exclusive upper bound. Must be later than `followUpAfter` |
| `followUp` | `none` | Leads with no follow-up date. Cannot be combined with `followUpAfter`/`followUpBefore` (`400`) |
| `assignedTo` | `me` or a user id | Narrows to one user's leads. A user id must be inside the caller's visible team; a user outside it is `404`, the same answer as for a lead outside the team, so ids cannot be probed. `me` is the caller. Anything else (`ME`, `all`, a non-UUID) is `400` |

A lead with no follow-up date never matches `followUpAfter`/`followUpBefore`.

"Overdue" for the caller's day is `status=OPEN,CONTINUED&followUpBefore=<dayStart>`. "Due today" is
`status=OPEN,CONTINUED&followUpAfter=<dayStart>&followUpBefore=<dayEnd>`. The client supplies the
boundaries, so the server never guesses the caller's time zone.

### `lastActivityAt` on each row

Each list row carries `lastActivityAt`: the latest of the lead's most recent logged follow-up
(`interactionAt`) and the lead's own `updatedAt`, as an ISO instant. It is computed with one grouped query per page, not one per row.
It is also returned by `GET /inquiries/:id`. It is a hint for "how stale is this lead", not an audit trail.

## `GET /inquiries/summary`

Counts for the caller's dashboard, computed by the database, over the same visible set as the list.

| | |
|---|---|
| Method / path | `GET /api/v1/inquiries/summary` |
| Authentication | Bearer access token |
| Authorization | `presales.inquiry.read`. Scope is the caller's visible team (`TeamScopeService`); `company_admin` and `super_admin` see the company |
| Request body | none |
| Caching | Not cached and not cacheable: the numbers change with every edit. Clients should refetch on focus or pull-to-refresh |

### Query parameters

| Name | Type | Notes |
|---|---|---|
| `dayStart`, `dayEnd` | ISO instants with offset | The caller's "today", `[dayStart, dayEnd)`. Must be given together, `dayEnd` later than `dayStart`, and no longer than 26 hours (covers a DST change). Omitted: the server uses the **company's** day in `CompanyConfig.timezone` (default `Asia/Kolkata`) |
| `since` | ISO instant with offset | "New" leads are those created at or after this. Default: `dayEnd` minus 7 days |
| `assignedTo` | `me` or a user id | As on the list |

### Response `200`

```json
{
  "total": 11,
  "byStatus": { "OPEN": 7, "CONTINUED": 2, "SUCCESSFUL": 1, "DUMPED": 1 },
  "overdue": 2,
  "dueToday": 2,
  "newSince": 10,
  "period": {
    "timeZone": "Asia/Kolkata",
    "dayStart": "2026-09-29T18:30:00.000Z",
    "dayEnd": "2026-09-30T18:30:00.000Z",
    "since": "2026-09-23T18:30:00.000Z"
  }
}
```

- `total` is the sum of `byStatus`; every status key is always present (zero-filled).
- `overdue` and `dueToday` count only `OPEN` and `CONTINUED` leads, using `nextFollowupAt` (before `dayStart`, and within `[dayStart, dayEnd)`).
- All of them equal the totals of the matching `GET /inquiries` queries. This is tested.
- `period.timeZone` is `null` when the client supplied `dayStart`/`dayEnd`.

### Errors

| Status | When |
|---|---|
| `400` | Only one of `dayStart`/`dayEnd`; `dayEnd` not after `dayStart`; a day longer than 26 hours; a date without an offset, or not a date; `assignedTo` not `me` or a UUID |
| `401` | No or invalid access token |
| `403` | Caller lacks `presales.inquiry.read` |
| `404` | `assignedTo` is a user outside the caller's visible team |

### Example

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://crm.example.com/api/v1/inquiries/summary?assignedTo=me&dayStart=2026-09-29T18:30:00.000Z&dayEnd=2026-09-30T18:30:00.000Z"
```

## Time zone semantics

There are two kinds of "day" here, and the difference matters.

**Bounds you send are absolute instants.** `followUpAfter`, `followUpBefore` (and `from`/`to`, `dayStart`, `dayEnd`,
`since` on the other endpoints) must carry an explicit offset (`2026-10-01T00:00:00+05:30` or `...Z`). The server does
not interpret them in any zone: `2026-10-01T00:00:00+05:30` and `2026-09-30T18:30:00Z` are the same request. A value with
no offset is `400`, never guessed as UTC. The mobile app sends the **device's** local day this way, so "today" in the app
is the phone's day.

**When you send no day bounds, "today" is the company's day.** `GET /inquiries/summary` without `dayStart`/`dayEnd` uses
`CompanyConfig.timezone` (an IANA name, default `Asia/Kolkata`) and says so in `period.timeZone`. Local midnight to next
local midnight, so a day is 24 hours except around a daylight-saving change: 23, 24.5 or 23.5 hours are all real
(America/Los_Angeles on 8 Mar 2026 is 23 h and on 1 Nov 2026 is 25 h; Australia/Lord_Howe shifts by 30 minutes; in
Africa/Cairo DST starts at midnight, so the day begins at 01:00). All of these are tested. The value is not validated when
an admin saves it: an unknown name silently falls back to `Asia/Kolkata`.

Consequence: if a device is in a different zone from the company, the app's dashboard shows the device's day while an API
client that omits the bounds gets the company's day. Both are internally consistent (each tile equals the list it opens,
because both use the same bounds); they can differ from each other.
