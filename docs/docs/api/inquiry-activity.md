---
title: Lead activity API (mobile contract)
sidebar_position: 12
---

# Lead activity API

Generated spec at `/api/v1/docs`. All routes are under `/api/v1`; authenticate with
`Authorization: Bearer <access token>`.

## `GET /inquiries/:id/activity`

A lead's history, newest first, merged from the tables that really record it.

| | |
|---|---|
| Method / path | `GET /api/v1/inquiries/:id/activity` |
| Authentication | Bearer access token |
| Authorization | `presales.inquiry.read`, and the lead must be in the caller's visible team (`TeamScopeService`; admins see the company). A lead outside it, or in another company, is `404`, not an empty list. **Follow-up entries additionally need `presales.follow-up.read`** (they carry notes); without it they are simply not part of the feed |
| Request body | none |

### What is in the feed

| `type` | Source | `details` |
|---|---|---|
| `follow_up` | `follow_ups` (time = `interactionAt`) | `followUpId`, `followUpType {id,name}\|null`, `isSiteVisit`, `notes`, `outcome`, `scheduledAt`, `venue`, `nextActionAt` |
| `stage_change` | `inquiry_stage_history` | `from {id,name}\|null`, `to {id,name}`, `administrative` (true for bulk moves made when a stage is retired) |
| `status_change` | `inquiry_disposition_history` | `from`, `to` (OPEN/CONTINUED/DUMPED/SUCCESSFUL), `reason {id,name}\|null`, `remarks` |
| `assignment` | `inquiry_assignments` | `from {id,name}\|null`, `to {id,name}`, `assignmentType` (`manual`, `auto` for round-robin, `creator` when the creator kept the lead), `reason` |

**Not included, on purpose:** messages sent (there is no read permission for communication
logs and they hold message bodies), call recordings (not stored), and edits to other lead
fields (the audit log is admin-only). Nothing is synthesised: an event appears only if a row records it.

Every item: `id` (`<type>:<row id>`, unique and stable), `type`, `occurredAt`, `actor {id,name}|null`
(null for system events such as automatic assignment), `details`.

### Query parameters

| Name | Type | Notes |
|---|---|---|
| `type` | one or more of `follow_up`, `stage_change`, `status_change`, `assignment` | Comma list or repeated. Unknown values (for example `communication`) are `400`. Omitted: every kind the caller may read |
| `page` | 1 to 10 | Default 1 |
| `limit` | 1 to 100 | Default 20 |

### Response `200`

```json
{
  "data": [
    {
      "id": "follow_up:3f1c…",
      "type": "follow_up",
      "occurredAt": "2026-09-30T09:00:00.000Z",
      "actor": { "id": "…", "name": "Asha Rao" },
      "details": {
        "followUpId": "3f1c…",
        "followUpType": { "id": "…", "name": "Site Visit" },
        "isSiteVisit": true,
        "notes": "Called, wants a visit",
        "outcome": null,
        "scheduledAt": "2026-10-01T05:30:00.000Z",
        "venue": "Site office",
        "nextActionAt": null
      }
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 7, "totalPages": 1, "types": ["follow_up", "stage_change", "status_change", "assignment"] }
}
```

`meta.types` lists the kinds that were actually queried (requested and permitted), so a client can
tell "no follow-ups" from "not allowed to see follow-ups".

### Pagination

Offset pagination over the merged feed: order is `occurredAt` descending, then `id` descending, so
events at the same instant keep a fixed order and pages neither repeat nor drop items. `meta.total`
is the count across the included kinds. The page is capped at 10 (with `limit` at most 100) to keep the
merge window bounded; a page past the end returns `data: []`.

### Errors

| Status | When |
|---|---|
| `400` | `id` not a UUID; `page`/`limit` out of range or not integers; unknown `type` |
| `401` | No or invalid access token |
| `403` | Caller lacks `presales.inquiry.read` |
| `404` | The lead does not exist, is in another company, or is outside the caller's team |

### Example

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://crm.example.com/api/v1/inquiries/$LEAD_ID/activity?type=follow_up,status_change&limit=20"
```

### Compatibility

Additive: a new route. Nothing existing changes.
