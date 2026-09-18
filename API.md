# API

OpenNews exposes a small read-only JSON API alongside its server-rendered
pages, plus an authenticated admin API. All responses are `application/json`.
There is no API key for the public endpoints; they're rate-limited per-IP
(120 req/min, see `src/proxy.ts`) rather than gated behind auth.

## Public endpoints

### `GET /api/health`

Liveness/readiness check — verifies the database is reachable.

```json
{ "status": "ok", "time": "2026-01-01T00:00:00.000Z" }
```

### `GET /api/categories`

```json
{ "categories": [{ "id": "...", "slug": "world", "name": "World", "order": 1 }] }
```

### `GET /api/stories`

List story clusters, newest-updated first by default.

| Query param | Description                                           |
| ----------- | ----------------------------------------------------- |
| `category`  | category slug                                         |
| `breaking`  | `"true"` to only return breaking stories              |
| `source`    | source id                                             |
| `sort`      | `"latest"` (default) or `"oldest"`                    |
| `limit`     | page size, max 60                                     |
| `cursor`    | opaque cursor from a previous response's `nextCursor` |

```json
{
  "stories": [
    {
      "id": "...",
      "slug": "...",
      "headline": "...",
      "summary": "...",
      "category": { "slug": "world", "name": "World" },
      "imageUrl": null,
      "breaking": false,
      "sourceCount": 3,
      "articleCount": 4,
      "firstSeenAt": "...",
      "lastUpdatedAt": "...",
      "sources": [{ "id": "...", "name": "...", "homepageUrl": "..." }],
      "articles": [
        {
          "id": "...",
          "title": "...",
          "url": "...",
          "excerpt": "...",
          "imageUrl": null,
          "author": null,
          "publishedAt": "...",
          "source": { "id": "...", "name": "...", "homepageUrl": "..." }
        }
      ]
    }
  ],
  "nextCursor": "clv..."
}
```

### `GET /api/stories/:slug`

Single story cluster, same shape as one item of `/api/stories`. 404 if not
found.

### `GET /api/search`

| Query param   | Description                                     |
| ------------- | ----------------------------------------------- |
| `q`           | free-text query                                 |
| `category`    | category slug                                   |
| `source`      | source id                                       |
| `sort`        | `"relevance"` (default), `"newest"`, `"oldest"` |
| `from` / `to` | ISO date bounds on `lastUpdatedAt`              |
| `page`        | 1-indexed page number                           |

```json
{
  "results": [/* same shape as /api/stories items */],
  "total": 42,
  "page": 1,
  "pageSize": 20,
  "totalPages": 3
}
```

### `GET /api/sources`

Public list of active sources (for attribution / source-filtering UI).

```json
{ "sources": [{ "id": "...", "name": "...", "homepageUrl": "...", "categorySlug": "world" }] }
```

## Admin endpoints (require an authenticated admin session)

All of these require the `opennews_admin_session` cookie (set via
`POST /api/admin/login`). Mutating requests (`POST`/`PATCH`/`PUT`/`DELETE`)
additionally require an `x-opennews-admin: 1` header, or they're rejected
with `403` — see SECURITY.md for why. Unauthenticated requests get `401`.

| Method & path                   | Purpose                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `POST /api/admin/login`         | `{ "password": "..." }` → sets session cookie                                           |
| `POST /api/admin/logout`        | clears session cookie                                                                   |
| `GET /api/admin/sources`        | list all sources (incl. inactive), with article counts                                  |
| `POST /api/admin/sources`       | create a source: `{ name, url, homepageUrl?, categorySlug, fetchIntervalMinutes? }`     |
| `PATCH /api/admin/sources/:id`  | update any of the above fields, or `{ "active": false }` to pause                       |
| `DELETE /api/admin/sources/:id` | remove a source                                                                         |
| `GET /api/admin/categories`     | list categories with article/cluster counts                                             |
| `PATCH /api/admin/categories`   | `{ id, name?, order? }`                                                                 |
| `GET /api/admin/feed-logs`      | recent `FeedFetchLog` rows, optional `?source=<id>`                                     |
| `GET /api/admin/settings`       | current ad + AI settings                                                                |
| `PUT /api/admin/settings`       | `{ ads?: {...}, ai?: {...} }` (see `src/lib/validation/settings.ts` for the full shape) |
| `POST /api/admin/ingest`        | trigger an immediate ingestion run; body `{ sourceId? , force? }`                       |

These aren't versioned (`/api/v1/...`) yet since there's a single first-party
consumer (the admin UI); if a public/versioned admin API becomes a goal,
version the path prefix at that point rather than before it's needed.
