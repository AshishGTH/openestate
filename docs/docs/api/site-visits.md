---
title: Site Visits API (mobile contract)
sidebar_position: 11
---

# Site Visits API

Also served, generated from the controllers, at `/api/v1/docs`. All routes are under
`/api/v1`; authenticate with `Authorization: Bearer <access token>`. Reads need no CSRF token.

## What a site visit is

A **site visit** is a follow-up (`follow_ups` row) that

1. has a `scheduledAt`, and
2. has a type whose **`is_site_visit` flag** is true (`follow_up_types.is_site_visit`).

The flag is the identity, not the type's name. Names are admin-editable; a type renamed
"Walkthrough" and flagged still counts, and a type still named "Site Visit" but unflagged does not.

- **New installs** are seeded with the "Site Visit" type flagged.
- **Upgrades** add the column (default false) and flag, once, in the migration, every type named
  `Site Visit` ignoring case and surrounding spaces (`Site visit`, `Site Visit `). Names that merely contain it
  (`Site Visit Follow-up`) are not flagged. A company that had renamed that type to something else before upgrading must set the
  flag itself: `PATCH /masters/follow-up-types/:id` with `{ "isSiteVisit": true }`
  (`admin.master.update`). `POST /masters/follow-up-types` accepts the same field.
- Existing site-visit **reports** still match by the type name; they are unchanged by this release.

Log a site visit as before: `POST /inquiries/:id/follow-ups` with the site-visit `typeId`,
`scheduledAt` and `venue`.

## `GET /site-visits`

| | |
|---|---|
| Method / path | `GET /api/v1/site-visits` |
| Authentication | Bearer access token |
| Authorization | `presales.site-visit.read`. Scope: visits on leads assigned to the caller's visible team (`TeamScopeService`); `company_admin`/`super_admin` see the company. Follow-up read permission is not enough |
| Request body | none |
| Pagination | `page` (default 1), `limit` (default 20, max 100). `meta` has `page`, `limit`, `total`, `totalPages`; a page past the end is `data: []` |
| Order | `scheduledAt` (`sortOrder`, default `asc`), then `id`, so pages are stable |

### Query parameters

| Name | Type | Notes |
|---|---|---|
| `from` | ISO 8601 instant with offset | Inclusive lower bound on `scheduledAt`. Date-only or offset-less values are `400` |
| `to` | ISO 8601 instant with offset | Exclusive upper bound. Must be later than `from` |
| `state` | `scheduled`, `awaiting_outcome`, `outcome_recorded` | See below. Anything else, including `cancelled`, is `400` |
| `sortOrder` | `asc` \| `desc` | Default `asc` |
| `assignedTo` | `me` or a user id | Assignee of the **lead**. An id outside the caller's team is `404`; anything else is `400` |

`from`/`to` combine with `state`: the state never widens or replaces the date range.
"Today" is the client's day: pass `from`/`to` as that day's instants, as for `/inquiries/summary`.

### State (derived, not stored)

| `state` | Meaning |
|---|---|
| `scheduled` | No outcome recorded and `scheduledAt` is now or later |
| `awaiting_outcome` | No outcome recorded and `scheduledAt` has passed |
| `outcome_recorded` | An `outcome` is set: `COMPLETED`, `NO_RESPONSE`, `RESCHEDULED`, `NOT_INTERESTED` or `CONVERTED`. Read `outcome` to tell them apart |

There is **no "cancelled"** state: nothing in the data represents one. A visit that was moved
is recorded as outcome `RESCHEDULED` plus a new follow-up.

### Response `200`

```json
{
  "data": [
    {
      "id": "…",
      "inquiryId": "…",
      "scheduledAt": "2026-10-01T05:30:00.000Z",
      "venue": "Green Woods sales office",
      "notes": null,
      "outcome": null,
      "state": "scheduled",
      "interactionAt": "2026-09-30T09:00:00.000Z",
      "type": { "id": "…", "name": "Site Visit" },
      "createdBy": { "id": "…", "name": "Asha Rao" },
      "inquiry": {
        "id": "…",
        "status": "CONTINUED",
        "applicant": { "id": "…", "name": "Rahul Sharma", "primaryPhone": "9876543210" },
        "project": { "id": "…", "name": "Green Woods Residency" },
        "assignedTo": { "id": "…", "name": "Ashish Kumar" }
      }
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

Credential columns are never included. `state` is computed with the server clock at request time.

### Errors

| Status | When |
|---|---|
| `400` | Bad `page`/`limit`/`sortOrder`/`state`; `from`/`to` not an offset-bearing instant; `to` not after `from`; `assignedTo` not `me` or a UUID |
| `401` | No or invalid access token |
| `403` | Caller lacks `presales.site-visit.read` |
| `404` | `assignedTo` is a user outside the caller's team |

### Examples

```bash
# Upcoming visits, soonest first
curl -H "Authorization: Bearer $TOKEN" "https://crm.example.com/api/v1/site-visits?state=scheduled"

# My visits today (IST day)
curl -H "Authorization: Bearer $TOKEN" \
  "https://crm.example.com/api/v1/site-visits?assignedTo=me&from=2026-09-29T18:30:00.000Z&to=2026-09-30T18:30:00.000Z"

# Visits with an outcome, newest first
curl -H "Authorization: Bearer $TOKEN" "https://crm.example.com/api/v1/site-visits?state=outcome_recorded&sortOrder=desc"
```

### Compatibility

Additive: a new route and an optional master field. No existing response changes.
The migration is `20260930120000_follow_up_type_is_site_visit` (adds one column with a constant default; forward-only).
