# Site-capture audit — `5 website page source` + `3 live testing note`

**Audited:** 2026-09-15 (session `arena/01a0a3d5-nh-dw-2-0`).
**Input:** commit `c81ba07` ("Add live testing notes for hentai site downloads"),
which added `3 live testing note` (9 lines) and `5 website page source` (3651 lines).
**Question answered:** is the captured material enough to unblock items 49 and 50?

**Answer: no — not for the extractors.** All five captures are **homepage /
listing** pages, not gallery or reader pages. That is the one thing §8 of
`MULTISITE_V4_PLAN.md` asked for and the one thing missing. Scorecard in §4.

But the captures are not wasted: they **disprove two assumptions** the v4 plan
is built on and **confirm one**, and they unblock a real slice of item 48 that
needs no site access at all. Details below, every claim tied to a measurement.

Baseline before any conclusion: `npm test` in `NHDW_Extension_v3.0.0/` →
**389 passing, 4 pending** (matches the count in `WORKLIST.md`). Working tree
clean; this document is the only change.

---

## 1. What was actually captured

Five sections, each prefixed with its `view-source:` URL:

| Line | URL | Chars | Distinct `/gallery/<id>/` | Distinct media paths |
|---:|---|---:|---:|---:|
| 1 | `https://hentaifox.com/` | 43,465 | 31 | 27 |
| 789 | `https://imhentai.xxx/` | 43,370 | 20 | 20 |
| 1534 | `https://hentaiera.to/` | 76,338 | 25 | 25 |
| 2797 | `https://hentaienvy.com/` | 47,974 | 24 | 24 |
| 3616 | `https://hitomi.la/` | 22,239 | **0** | **0** |

All five are **root/listing pages**. Not one gallery page, not one reader page,
not one network-tab capture. Verified by grep across the whole file:
`galleries/<id>.js` → 0 hits, `readerImg` → 0 hits, `/reader/` → 0 hits,
`download.php` → 0 hits, `/zip/` → 0 hits. `gg.js` → 1 hit, and it is only the
`<script src>` *reference*, not the file's contents.

---

## 2. The headline finding: the mirrors do not share gallery ids

`imhentai.xxx` and `hentaienvy.com` serve the **same content store**. Their
image paths are `/033/<token>/` and 19 of 20 imhentai tokens also appear on
hentaienvy — byte-identical paths, different host:

```
token           imhentai gid   hentaienvy gid   match?
w62za5o4v3        1738518         1606086       DIFFERENT
y4vcnbwt1s        1738517         1606085       DIFFERENT
dvrxzlfo9q        1738516         1606084       DIFFERENT
...                ...              ...
identical gallery ids across mirrors: 0 / 19
```

Same title, same media token, different gallery id — e.g.
`[Ochiba/茶座波/堕ち場]魔法少女的秘密` is `imhentai.xxx/gallery/1738518/` **and**
`hentaienvy.com/gallery/1606086/`, both pointing at `/033/w62za5o4v3/`.
imhentai's front page is the 1738499–1738519 range; hentaienvy's is
1606061–1606086. The id spaces are disjoint.

**This rewrites the fallback design in `3 live testing note`.** The note plans
routing chains ("hentaiera → hentaienvy → imhentai", "hentaienvy →
hentaiera → imhentai") by *title matching*. For imhentai↔hentaienvy that whole
step is unnecessary:

- A gallery id from one mirror is **meaningless** on the other — never feed it
  across.
- The `/033/<token>/` path **is** the content address. To fall back, swap the
  host and keep the token: `m11.imhentai.xxx/033/w62za5o4v3/2.webp` →
  `m11.hentaienvy.com/033/w62za5o4v3/2.webp`. No title search, no second
  gallery page fetch, no id translation.
- Title matching is only needed for the pairs that are *not* the same store —
  which is every pair involving hentaiera or hentaifox (see §3).

**Caveat, unchecked:** the shared-token conclusion rests on thumbnails from two
front pages captured within minutes of each other. It is consistent and strong,
but nobody has yet confirmed a *page* image (not a thumb) resolves on the other
host. That is a one-request test the moment a gallery page is captured.

---

## 3. Four sites, **two** storage backends, **four** frontends

`MULTISITE_V4_PLAN.md` §2.2 assumes imhentai / hentaienvy / hentaiera are "one
operator/network: identical frontend" and plans **one adapter parameterized by
host**. The captures refute the "identical frontend" half outright and split the
group:

| Site | Card markup | Image host | Path shape | Thumb |
|---|---|---|---|---|
| hentaifox | `div.thumb` › `inner_thumb` › `h2.g_title` | `i3.hentaifox.com` | `/004/` or `/005/` + **numeric id** | `.jpg` |
| imhentai | `div.thumb` › `thumbnail` › `h2.gallery_title` | `m11.imhentai.xxx` | `/033/` + **token** | `.jpg` |
| hentaienvy | `article.hnv-gallery-card__*` (BEM, Tailwind) | `m11.hentaienvy.com` | `/033/` + **token** | `.jpg` |
| hentaiera | `div.thumb` › `thumbnail` › `h2.gallery_title` + `g_pages` | **`hentaiera.site`** | `/galleries/` + **numeric id** | **`.webp`** |
| hitomi | none — JS shell | `ltn.gold-usergeneratedcontent.net` | unknown | unknown |

Three concrete consequences:

1. **imhentai and hentaienvy share storage but not markup.** hentaienvy is a
   from-scratch frontend: `hnv-gallery-card` BEM classes, `article` cards,
   `@tailwindcss/browser@4`, per-card rating/like stats, `<time datetime=…>`.
   A single DOM scraper cannot serve both. The adapter needs one **CDN
   resolver** (shared, token-based) and **two listing parsers**.
2. **hentaiera is a different backend.** Different CDN domain, and note the
   TLD: the page lives on `hentaiera.to` but images come from
   `hentaiera.site`. Numeric path ids and webp thumbs, not tokens and jpg. It
   has a **two-id system**: gallery `694133` → media `4182258`; hentaifox the
   same shape, gallery `173098` → media `4190711`. The deltas are not
   constant (hentaifox media steps of 6, 4, 2, 2, 12 against gallery steps of
   1), so the media id must be **read, never computed**.
   *Correction (2026-09-15, same session):* this section originally claimed the
   id→media mapping "can only come from the gallery page". That was **wrong**.
   The listing pairs them inside one card — parsed straight from the capture,
   25/25 hentaiera, 20/20 hentaifox, 20/20 imhentai, 24/24 hentaienvy. The
   gallery page is *not* needed to reach a gallery's images from a listing.
3. **Manifest `host_permissions` cannot be one host per site.** hentaiera needs
   both `hentaiera.to` and `hentaiera.site`. hitomi needs `hitomi.la` plus
   `ltn.gold-usergeneratedcontent.net` (plus `nozomi.la`, referenced in the
   shell).

**One thing the captures do confirm:** all four mirror sites use
`/gallery/<numeric id>/` with zero exceptions (0 non-numeric hrefs across all
four files). That is a real, testable win — see §5.

---

## 4. Checklist §8 scorecard

### hitomi.la (item 49) — **0 of 6**

| Requested | Got |
|---|---|
| 1. Gallery page HTML (`/galleries/<id>.html`) | ❌ homepage shell |
| 2. `ltn.<host>/galleries/<id>.js` | ❌ |
| 3. `gg.js` **contents** | ❌ reference only |
| 4. Reader page HTML | ❌ |
| 5. 2–3 full image URLs + `Content-Type` | ❌ |
| 6. A GIF / animated-webp gallery id | ❌ (note says avif was never found either) |

The hitomi capture is **structurally empty**, and this is the most important
single fact about it:

```
<title> | Hitomi.la</title>        <- empty title, JS had not run
distinct gallery links: 0
distinct media paths:  0
```

`view-source:` returns the **pre-JavaScript** HTML. hitomi renders its whole
listing client-side (the shell even contains an `on nozomi.la →` link with an
empty `href`), so what was saved is the skeleton before any content arrives. It
contains no gallery, no id, no image URL — nothing an extractor can be written
against.

Two other hitomi facts that *did* come through:

- **The CDN domain has moved.** `MULTISITE_V4_PLAN.md` §2.1 says
  `ltn.hitomi.la`. The capture shows **`ltn.gold-usergeneratedcontent.net`** —
  21 references, including `gg.js`, `common.js`, `galleryblock.js`,
  `decode_webp.js`, `paging.js`, `searchlib.js`. The plan's "do not hardcode
  subdomains, fetch the config at runtime" rule just proved itself; the
  documented domain needs updating.
- There is a large obfuscated inline script carrying an embedded base64 **WASM
  blob** (`AGFzbQEAAAAB…`) that defines a global (`unvnujxr`) and randomizes
  URL parameters, plus `glimmersmugglingsullen.com/on.js` and
  `js.wpadmngr.com`. That is an **ad network**, not hitomi's own protection —
  noise to strip when parsing, not an anti-bot wall to defeat.

### Mirror network (item 50) — **~0.5 of 5**

| Requested | Got |
|---|---|
| 1. Gallery page HTML per site | ❌ homepages |
| 2. Reader page HTML per site | ❌ |
| 3. 2–3 page-image URLs per site | ⚠️ **partial** — thumbs only, 4/4 sites (`thumb.jpg`, hentaiera `thumb.webp`), plus exactly **one** full-page URL, from the live note: `https://m11.hentaienvy.com/033/fdz7b2qj13/2.webp` |
| 4. What the download button does (URL/POST) + cooldown message | ❌ the note records *outcomes* ("zip download all byte identical", sha256/sha1/md5 identical, size deltas) but never the endpoint or the message text |
| 5. One button-downloaded zip, unopened | ❌ |

The single full-page URL is genuinely useful — it pins hentaienvy's page shape
as `/033/<token>/<page-number>.webp` — but n=1 is not a spec. Unanswered by it:
are all pages `.webp`, or is there a per-page type map (nhentai ships one:
`j`/`p`/`g`/`w` per page)? And there is no full-page URL at all for hentaiera,
hentaifox, or hitomi.

The Strategy C quality comparison in the note is a **result without a
reproduction path**: it tells us reader-mode wins (hentaifox largest, ~1–2%
over baseline; hitomi's zip smallest, ~1–5% under; imhentai/hentaienvy/
hentaiera zips byte-identical) but gives no gallery ids, no hashes, no files.
Good enough to justify **choosing Strategy A**; not good enough to be a test.

---

## 5. Cloudflare — your note checks out, and it splits the sites

The `?__cf_chl_rt_tk=…` hop you saw is Cloudflare's **challenge round-trip
token** — a JS/Managed Challenge interstitial served before the clean URL. The
randomized ticket-looking text is the challenge page's own copy; it is not part
of any site's markup and can be ignored for parsing. What you captured is
correct: you saved the page **after** the challenge cleared, which is the only
version worth saving.

Resolution confirms which sites sit behind Cloudflare (Cloudflare owns
`104.16.0.0/13` and `172.64.0.0/13`):

| Host | IPv4 | Cloudflare? |
|---|---|---|
| `hentaifox.com` | 104.26.12.92 | yes |
| `i3.hentaifox.com` | 104.26.13.92 | yes |
| `imhentai.xxx` / `m11.imhentai.xxx` | 104.26.11.15 | yes |
| `hentaiera.to` | 172.67.192.108 | yes |
| `hentaiera.site` | 104.21.60.70 | yes |
| `hentaienvy.com` / `m11.hentaienvy.com` | 104.21.69.191 | yes |
| **`hitomi.la`** | **185.165.169.231** | **no** |
| `ltn.gold-usergeneratedcontent.net` | 66.187.78.242 | no |

So all four mirror sites are behind Cloudflare; hitomi is not. In-page markers
agree: imhentai carries `window.__CF$cv$params={r:'a3b58be42c1fc26b',t:'MTc4OTQ1MzQ0NQ=='…}`;
hentaifox and imhentai both load `challenges.cloudflare.com/turnstile/v0/api.js`;
hentaiera and hentaienvy load the `cloudflareinsights` beacon.

**Why this constrains the design, and the good news:** a `fetch()` from the MV3
service worker does not execute JavaScript, so it will receive the challenge
HTML (a 403) and no bytes. The repo already solved this shape for nhentai —
`src/background/tabImageFetch.ts` runs the fetch *inside the user's open tab*
with `credentials:"include"`, inheriting the cleared `cf_clearance` cookie. That
path must be reused for all four mirror sites. It is not a bypass and the code
says so; the challenge still has to be completed by the human, once.

Two pieces of existing code are hard-wired to nhentai and must become
per-adapter before any new site can pass a single image:

- `src/sources/cdnConfig.ts` — the host allowlist is
  `/^([a-z0-9-]+\.)+nhentai\.net$/i` and the path allowlist is
  `ALLOWED_IMAGE_PATH = /^\/galleries\/[0-9]+\/[0-9]+\.(jpg|jpeg|png|gif|webp)$/i`.
  **Not one of the four new sites matches either regex.** `/033/<token>/`,
  `/005/<numid>/`, and hitomi's paths all fail.
- `src/sources/GallerySource.ts` — `getApiUrl()` is nhentai-specific; three of
  the four new sites appear to have no JSON API at all, so the contract needs
  an "HTML-only" branch.

### Correction to a stale claim in the plan

`MULTISITE_V4_PLAN.md` §2 states: *"The sandbox cannot resolve any of these
hosts (DNS failure)."* That is wrong in mechanism. Measured this session:
`getent` returns A/AAAA records for all of `hentaienvy.com`, `imhentai.xxx`,
`hentaiera.to`, `hentaifox.com`, `hitomi.la`, `m11.hentaienvy.com`, and
`ltn.gold-usergeneratedcontent.net`. What fails is **egress**:
`curl -sv https://hentaienvy.com/` connects to `172.67.212.52:443` and dies at
`SSL_connect: SSL_ERROR_SYSCALL`, and `https://example.com/` fails identically
(HTTP 000). It is a blanket sandbox egress block, not DNS, and not
site-specific. Same practical outcome — captures must come from you — but the
stated reason should be fixed so nobody wastes a session "fixing DNS".

---

## 6. Verdict

**Not enough to write the extractors. Enough to correct the plan and start part
of item 48.**

*Revised after measurement (2026-09-15):* the blocker is **narrower than this
document first said**. Parsing the captured homepages directly yields, for all
four mirror sites, a complete listing record per card — gallery id, media
address, page count (hentaiera), and title. What is still genuinely unknown is
exactly **one thing per site: the per-page file extension** (and confirmation
that the thumbnail's directory is also the page directory). One gallery page
plus three network-tab image URLs settles it.

What is **not** blocked, and needs no site access:

- `cdnConfig.ts` → per-adapter host + path allowlists (pure refactor, testable
  offline). Today it is nhentai-only in two regexes.
- `GallerySource` → `SiteAdapter`: add an HTML-only branch for sites with no
  JSON API.
- Site-slug registration in `siteKeys.ts` (the contract already allows numeric
  ids and forbids `:` — all four new sites are numeric, verified).
- **Paste-box URL shapes for all four mirror sites.** `/gallery/<id>/` with a
  numeric id is confirmed with zero exceptions across all four captures, so
  `matchesUrl` / `getGalleryId` / `getGalleryUrl` can be written *and pinned by
  tests today*. Only `getImageUrls` has to wait.
- hitomi's documented CDN domain (`ltn.hitomi.la` → `ltn.gold-usergeneratedcontent.net`).

---

## 7. Minimum capture to unblock — the short list

### Per mirror site (imhentai, hentaienvy, hentaiera, hentaifox) — 5 items

1. **`view-source:https://<host>/gallery/<id>/`** ← the critical one. Same
   title on all four if possible; that also settles whether the mirror pair's
   page images really are interchangeable.
2. **The reader page's HTML** — whatever is served when you open page 1. For
   **hentaienvy, capture it with scripts enabled**, so the `readerImg` markup
   is visible; your note found you had to block scripts (`hentaienvy.com###readerImg`)
   to see the image at all, which suggests the element is script-gated and the
   pre-JS HTML may not contain the URL.
3. **Three consecutive page-image URLs** from the Network tab (pages 1, 2, 3),
   plus the `Content-Type` response header on one. This answers numbering and,
   more importantly, whether the extension is constant per gallery or varies
   per page.
4. **The download button**: DevTools → Network → click it once → right-click
   the request → **Copy as cURL**. Plus a screenshot of the cooldown message.
5. **The zip it produced**, unopened (Strategy C's sample).

### hitomi — 5 items

1. `view-source:https://hitomi.la/galleries/<id>.html`
2. The contents of `ltn.gold-usergeneratedcontent.net/galleries/<id>.js`
3. The contents of `ltn.gold-usergeneratedcontent.net/gg.js` — it is a small
   file; **paste the text**, don't link it
4. One reader page's HTML
5. Three full image URLs with `Content-Type`

### Capture tip — why the hitomi save came back empty

`view-source:` shows the HTML **before** JavaScript runs. That is fine for the
four server-rendered mirror sites and fatal for hitomi, which renders
client-side. For hitomi use **DevTools → Elements → right-click `<html>` →
Copy → Copy outerHTML**, or Save As "Webpage, Complete" — that captures the
post-JS DOM. Worth redoing hitomi that way even if nothing else is recaptured;
it is the difference between 0 usable bytes and a real sample.

Your existing habit of saving *after* the `__cf_chl_rt_tk` hop resolves to the
clean URL is exactly right — keep it.
