# nhentai API v2 — Project Reference

**Base URL:** `https://nhentai.net/api/v2`  
**Spec:** `GET /api/v2/openapi.json` · OAS 3.1 · version `2.0.0+483414f`  
**Full interactive docs:** `https://nhentai.net/api/v2/docs`

---

## Authentication

```
Authorization: Key YOUR_API_KEY
```

- **Public endpoints** work without a key (lower rate limits).
- **API key** unlocks higher rate limits, personalization, and authenticated actions
  (favorites, blacklist, downloads). Generate one in nhentai account settings.
- **User Token / first-party auth** (`POST /api/v2/auth/login`, `/api/v2/auth/*`,
  `/api/v2/user/keys`) is **internal-only and must not be used by third-party clients**.
  The API docs say: *"Third-party applications should authenticate using API keys via
  `Authorization: Key YOUR_API_KEY`."* — do not build a login flow; have the user paste
  their key.
- `GET /api/v2/user` is the one user endpoint that is third-party safe (returns your own
  profile to verify the key is valid).

**User-Agent:** Set a descriptive header per the API guidelines:
```
User-Agent: NHentai-Downloader/3.0 (https://github.com/freeforall1932-design/nh-dw-2.0)
```

---

## Infrastructure

### `GET /api/v2/cdn` — Get CDN Config

**Auth:** Public · No rate limit documented

Returns the current image and thumbnail CDN server list.

```json
{
  "image_servers": ["https://i.nhentai.net"],
  "thumb_servers": ["https://t.nhentai.net"]
}
```

> **Critical:** do not hardcode `i.nhentai.net`. The API docs warn explicitly:
> *"Don't hardcode specific subdomains; the list can change."*
> Call this at startup, cache the result for the session, and construct image URLs
> by prepending the first available server to the `path` returned by
> `GET /api/v2/galleries/{id}`.

**Project impact:** `GallerySource.ts` currently hardcodes `https://i.nhentai.net/galleries/`.
Replace with a startup call to this endpoint.

---

### `GET /api/v2/config` — Get App Config

**Auth:** Public

Returns CDN servers **and** an optional announcement banner.

```json
{
  "image_servers": ["string"],
  "thumb_servers": ["string"],
  "announcement": {
    "message": "string",
    "links": []
  }
}
```

Superset of `/api/v2/cdn`. Use this if you also want to surface announcements in the
extension popup.

---

## Galleries

### `GET /api/v2/galleries/{gallery_id}` — Get Gallery ⭐ Used now

**Auth:** Public (optional key for personalization)  
**Rate limits:** 20/min anon · 45/min with key

The primary metadata endpoint. Supports composite fetching via the `include` query
parameter — a single request can return comments, related galleries, favorite status,
and tag suggestions alongside the gallery.

**Parameters:**

| Name | Type | Description |
|---|---|---|
| `gallery_id` | integer (path) | Gallery ID |
| `include` | string (query) | Comma-separated: `comments`, `related`, `favorite`, `suggestions` |

**Response (200):**
```json
{
  "id": 0,
  "media_id": "string",
  "title": {
    "english": "string",
    "japanese": "string",
    "pretty": "string"
  },
  "cover": { "path": "string", "width": 0, "height": 0 },
  "thumbnail": { "path": "string", "width": 0, "height": 0 },
  "scanlator": "",
  "upload_date": 0,
  "tags": [
    {
      "id": 0,
      "type": "string",
      "name": "string",
      "slug": "string",
      "url": "string",
      "count": 0,
      "description": "string"
    }
  ],
  "num_pages": 0,
  "num_favorites": 0,
  "pages": [],
  "comment_count": 0,
  "comments": [ ... ],
  "related": [ ... ],
  "is_favorited": true,
  "suggestions": { "trending": [...], "active": [...], "mine": [], "counts": {...} }
}
```

> The extension currently reads this from `window._gallery` (v1 embedded format) and
> falls back to `/api/gallery/<id>` (v1 API). Upgrading to this endpoint with
> `?include=related` resolves Backlog item 17 ("More Like This") in the same call.

---

### `GET /api/v2/galleries/{gallery_id}/related` — Get Related Galleries ⭐ Needed for item 17

**Auth:** Public (optional key)  
**Rate limits:** 12/min anon · 30/min with key

Returns galleries similar to the specified gallery. This is the confirmed data source
for the "More Like This" feature (IMPROVEMENT_BACKLOG.md item 17 — previously listed
as data source unresolved).

**Response (200):**
```json
{
  "result": [
    {
      "id": 0,
      "media_id": "string",
      "english_title": "string",
      "japanese_title": "string",
      "thumbnail": "string",
      "thumbnail_width": 0,
      "thumbnail_height": 0,
      "num_pages": 0,
      "num_favorites": 0,
      "tag_ids": [],
      "blacklisted": false
    }
  ]
}
```

**Implementation note:** `result[]` maps directly to the `Record<id, title>` shape
consumed by `downloadAllDoujinshis`. Build it as:
```typescript
const record: Record<string, string> = {};
for (const g of result) {
  record[String(g.id)] = g.english_title || g.japanese_title || String(g.id);
}
```
Then pass `record` to the existing batch download path.

**Shortcut:** alternatively, use `GET /api/v2/galleries/{id}?include=related` to get
the related list in the same call as gallery metadata, eliminating one round-trip.

---

### `POST /api/v2/galleries/{gallery_id}/download` — Server-Side Download ⭐ Biggest unlock

**Auth:** API key required  
**Feature flag:** `allow_downloads` must be enabled  
**Rate limits:**

| Scope | ZIP/CBZ | Torrent |
|---|---|---|
| Per IP | 10 / 5 min | 5 / 1 min |
| Per user | 7 / 5 min | 10 / 5 min |
| Per API key owner | 10 / 5 min | 5 / 1 min |

**Parameters:**

| Name | Type | Values | Default |
|---|---|---|---|
| `gallery_id` | integer (path) | — | — |
| `format` | string (query) | `zip`, `cbz`, `torrent` | `zip` |

**Response (200):**
```json
{
  "url": "https://...",
  "expires_at": 1234567890
}
```

Returns a short-lived pre-signed URL. Fetch it before `expires_at` (Unix timestamp).

**Error codes:** `503` = feature flag off · `429` = rate limited

**Project strategy:** try this endpoint first when the user has configured an API key.
On 429 or 503, fall back silently to the existing image-by-image pipeline. This
eliminates the Cloudflare CDN 403 problem for authenticated users entirely — nhentai
builds the archive server-side, so image fetches from `i*.nhentai.net` are bypassed.

> **Do not reconstruct galleries by walking page URLs on the CDN.** The API docs
> explicitly prohibit this: *"full-gallery archives have a dedicated endpoint at
> `POST /api/v2/galleries/{id}/download`"*.

---

### `GET /api/v2/galleries` — Get All Galleries

**Auth:** Public (optional key)  
**Rate limits:** 15/min anon · 30/min with key

Paginated newest-first feed.

**Parameters:**

| Name | Default | Range |
|---|---|---|
| `page` | 1 | ≥ 1 |
| `per_page` | 25 | 1–100 |

**Response (200):**
```json
{
  "result": [ { "id": 0, "media_id": "string", "english_title": "string", ... } ],
  "num_pages": 0,
  "per_page": 25,
  "total": 0
}
```

---

### `GET /api/v2/galleries/tagged` — Get Galleries by Tag

**Auth:** Public (optional key)  
**Rate limits:** 15/min anon · 30/min with key

**Parameters:**

| Name | Type | Values | Default |
|---|---|---|---|
| `tag_id` | integer (required) | — | — |
| `sort` | string | `date`, `popular`, `popular-today`, `popular-week`, `popular-month` | `date` |
| `page` | integer | ≥ 1 | 1 |
| `per_page` | integer | 1–100 | 25 |

**Response:** same shape as `GET /api/v2/galleries`.

---

### `GET /api/v2/galleries/popular` — Get Popular Galleries

**Auth:** Public (optional key)  
**Rate limits:** 8/min per IP

Returns today's popular galleries. No parameters.

**Response (200):** array of gallery card objects (same fields as `result[]` above).

---

### `GET /api/v2/galleries/random` — Get Random Gallery

**Auth:** Public (optional key)  
**Rate limits:** 20/min anon · 30/min with key

Returns a random gallery ID. No parameters. Response shape is unspecified
(`additionalProp1: {}`) — treat as a redirect target or parse for an `id` field.

---

### `GET /api/v2/search` — Search Galleries

**Auth:** Public (optional key)

Full-text search. Enables a search box directly in the extension popup without opening
the website. Parameters and full response shape are collapsed in the exported docs;
expect `q` (query string) and pagination params, with the same `result[]` gallery card
response as other listing endpoints.

---

## Gallery Favorites

### `GET /api/v2/galleries/{gallery_id}/favorite` — Check Favorite

**Auth:** API key  
Returns `{ "favorited": true }` for the current user.

### `POST /api/v2/galleries/{gallery_id}/favorite` — Add to Favorites

**Auth:** API key  
**Feature flag:** `allow_favorites`  
**Rate limits:** 15/min per user · 15/min per API key owner

**Response (200):**
```json
{ "favorited": true, "num_favorites": 0 }
```

**Error codes:** `401` unauthorized · `404` gallery not found · `503` feature flag off

### `DELETE /api/v2/galleries/{gallery_id}/favorite` — Remove from Favorites

Same auth, rate limits, and response shape as the POST above.

---

## Gallery Comments

### `GET /api/v2/galleries/{gallery_id}/comments` — Get Comments

**Auth:** Public (optional key)

Read comments on a gallery. Alternatively, fetch via
`GET /api/v2/galleries/{id}?include=comments`.

**Response** is included in the full gallery response under `"comments": [...]`:
```json
{
  "id": 0,
  "gallery_id": 0,
  "poster": {
    "id": 0,
    "username": "string",
    "slug": "string",
    "avatar_url": "string",
    "is_superuser": false,
    "is_staff": false
  },
  "post_date": 0,
  "body": "string"
}
```

### `GET /api/v2/galleries/{gallery_id}/comments/count` — Comment Count

**Auth:** Public. Returns a count without fetching full comment bodies.

### `POST /api/v2/galleries/{gallery_id}/comments` — Create Comment

**Auth:** User Token required (first-party only — third-party apps cannot post).  
**Feature flag:** `allow_comments`

---

## Tags

### `POST /api/v2/tags/search` — Search Tags

Tag autocomplete. Useful for a search field in the popup or a future browse-by-tag UI.

### `GET /api/v2/tags/{tag_type}` — Get Tags by Type

Returns all tags of a given type (`artist`, `character`, `parody`, `group`, `language`,
`category`, `tag`). Large response; cache locally.

### `GET /api/v2/tags/{tag_type}/{slug}` — Get Tag by Slug

Returns a single tag by its type and URL slug.

### `GET /api/v2/tags/ids` — Get Tags by IDs

Batch-fetch tag objects by a list of IDs. Useful after receiving `tag_ids[]` from
gallery listing responses.

---

## Favorites

### `GET /api/v2/favorites` — Get Favorites

**Auth:** API key  

Returns the authenticated user's favorited galleries (paginated). Enables a
"Download all favorites" batch action.

### `GET /api/v2/favorites/random` — Get Random Favorite

**Auth:** API key  

Returns one random gallery from the user's favorites.

---

## Blacklist

### `GET /api/v2/blacklist` — Get Blacklist

**Auth:** API key  
**Rate limits:** 15/min per user / API key owner

Returns the user's blacklisted tags with full tag objects:
```json
{
  "tags": [{ "id": 0, "type": "string", "name": "string", "slug": "string", "count": 0 }],
  "count": 0
}
```

### `GET /api/v2/blacklist/ids` — Get Blacklist IDs

**Auth:** API key  
**Rate limits:** 45/min per user

Returns only the tag ID integers: `[0, 1, 2, ...]`

Lighter alternative for filtering — compare against `tag_ids[]` on gallery cards without
fetching full tag objects. Useful when showing gallery listings to hide blacklisted results.

### `POST /api/v2/blacklist` — Update Blacklist

**Auth:** API key  

Replaces the user's blacklisted tag set.

---

## User

### `GET /api/v2/user` — Get My Profile ⭐ Safe for third-party use

**Auth:** API key  
**Rate limits:** 45/min per user / API key owner

The only user endpoint explicitly safe for third-party clients. Use this to validate
that a configured API key is working and to display the logged-in username.

```json
{
  "id": 0,
  "username": "string",
  "slug": "string",
  "avatar_url": "string",
  "theme": "black",
  "is_staff": false,
  "is_superuser": false,
  "about": "",
  "favorite_tags": "",
  "email": "string"
}
```

> **Note:** `email` is hidden when authenticating via API key (returns empty or omitted).

### `GET /api/v2/users/{user_id}/{slug}` — Get Public User Profile

**Auth:** Public (optional key)  
**Rate limits:** 5/min anon · 10/min with key

Returns a user's public profile including recent favorites and recent comments.
Requires both the numeric `user_id` and the username `slug`.

---

## Endpoints NOT for third-party use

The following groups are **first-party internal only**. The API docs state they
*"should NOT be used by third-party clients"* and *"will be enforced."*

| Group | Endpoints |
|---|---|
| **auth** | `POST /api/v2/auth/login`, `/register`, `/refresh`, `/logout`, `/logout/all`, `GET /api/v2/auth/sessions`, `DELETE /api/v2/auth/sessions/{id}`, `POST /api/v2/auth/reset`, `POST /api/v2/auth/reset/confirm` |
| **user mutations** | `PUT /api/v2/user` (update profile), `DELETE /api/v2/user` (delete account), `POST /api/v2/user/avatar`, `GET/POST/DELETE /api/v2/user/keys` |
| **moderation** | All `/api/v2/moderation/*` endpoints |
| **gallery edit** | `POST /api/v2/galleries/{id}/edit` (retired anyway) |
| **taxonomy** | `POST/PATCH/DELETE /api/v2/taxonomy/*` (write operations) |
| **comment write** | `POST /api/v2/galleries/{id}/comments`, `DELETE /api/v2/comments/{id}`, `POST /api/v2/comments/{id}/flag` |

Do not implement login/logout flows. API keys are generated by the user on the nhentai
website and pasted into the extension options page.

---

## Rate Limit Summary

| Endpoint | Anon | With API key |
|---|---|---|
| `GET /api/v2/galleries` (feed) | 15/min | 30/min |
| `GET /api/v2/galleries/tagged` | 15/min | 30/min |
| `GET /api/v2/galleries/{id}` | 20/min | 45/min |
| `GET /api/v2/galleries/{id}/related` | 12/min | 30/min |
| `POST /api/v2/galleries/{id}/download` | 10 / 5 min (IP) | 7 / 5 min (user), 10 / 5 min (key) |
| `GET /api/v2/galleries/popular` | 8/min | 8/min |
| `GET /api/v2/galleries/random` | 20/min | 30/min |
| `GET /api/v2/favorites` | — | key required |
| `GET /api/v2/blacklist` | — | 15/min |
| `GET /api/v2/blacklist/ids` | — | 45/min |
| `GET /api/v2/user` | — | 45/min |
| `POST/DELETE /favorites` | — | 15/min |

On `429`: back off and retry with exponential delay. The API docs note that bans are
*"short and self-expiring"* and that *"treat 429 as a backoff signal."*

---

## Response Shapes — Common Objects

### Gallery Card (listing responses)
```json
{
  "id": 0,
  "media_id": "string",
  "english_title": "string",
  "japanese_title": "string",
  "thumbnail": "string",
  "thumbnail_width": 0,
  "thumbnail_height": 0,
  "num_pages": 0,
  "num_favorites": 0,
  "tag_ids": [0],
  "blacklisted": false
}
```

### Tag Object
```json
{
  "id": 0,
  "type": "string",
  "name": "string",
  "slug": "string",
  "url": "string",
  "count": 0,
  "description": "string",
  "is_community": true
}
```

### Error (all endpoints)
```json
{ "error": "string" }
```

### Validation Error (422)
```json
{
  "detail": [
    { "loc": ["string", 0], "msg": "string", "type": "string", "input": "string", "ctx": {} }
  ]
}
```

---

## Mapping to Project Features

| Backlog item | API endpoint | Status |
|---|---|---|
| **Metadata (current)** | `window._gallery` → `/api/gallery/<id>` (v1) | ✅ Done |
| **Image downloads (current)** | CDN hardcoded `i.nhentai.net` | ⚠️ Replace with `/api/v2/cdn` |
| **Server-side ZIP** (item 16b adjacent) | `POST /api/v2/galleries/{id}/download` | ❌ Not started |
| **"More Like This" batch** (item 17) | `GET /api/v2/galleries/{id}/related` or `?include=related` | ❌ Not started — endpoint confirmed |
| **Search from popup** | `GET /api/v2/search` | ❌ Not started |
| **Browse by tag** | `GET /api/v2/galleries/tagged` | ❌ Not started |
| **Show comments in popup** | `GET /api/v2/galleries/{id}/comments` or `?include=comments` | ❌ Not started |
| **Favorites batch download** | `GET /api/v2/favorites` | ❌ Not started |
| **Blacklist filtering** | `GET /api/v2/blacklist/ids` | ❌ Not started |
| **Verify API key** | `GET /api/v2/user` | ❌ Not started |

---

## Adding an API Key to the Extension

1. Add an `apiKey` field to `chrome.storage.sync` defaults (alongside existing
   `htmlParsing`, `maxConcurrentDownloads`, etc.).
2. Add a text input to the options page; store on change.
3. In the service worker, read the key and attach the header to v2 API requests:
   ```typescript
   const headers: Record<string, string> = {
     "User-Agent": "NHentai-Downloader/3.0 (https://github.com/freeforall1932-design/nh-dw-2.0)"
   };
   if (apiKey) {
     headers["Authorization"] = `Key ${apiKey}`;
   }
   ```
4. Route v2-specific fetches (CDN config, download endpoint, favorites, blacklist)
   through this header set.
5. On options page load, call `GET /api/v2/user` to validate the key and display the
   username as confirmation.
