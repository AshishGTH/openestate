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
