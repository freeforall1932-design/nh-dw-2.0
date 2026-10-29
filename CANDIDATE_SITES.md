# Multi-Site Candidate Roster

**Created:** 2026-09-23 (session `arena/01a0cdce-nh-dw-2-0`).
**Reference Source:** Audited against the owner's desktop reference repository
([`freeforall1932-design/all-comic-doujin-website-archiver-for-offline-reading-GUI-Last`](https://github.com/freeforall1932-design/all-comic-doujin-website-archiver-for-offline-reading-GUI-Last) / `Hitomi-Downloader`).

This document tracks potential next candidate sites for extension support, categorized by architectural fit, technical complexity, and feasibility within a Manifest V3 browser extension. **Current new-domain priorities are Sasangeyou and DoujinDesu** (§3.1); the independent lookalikes in §3.2 are deferred. Sasangeyou's offline planner and synthetic-only reader-data parser are not wired or verified against site DOM. Chromium's separate nhentai API archive hardening is offline-tested only; leave the option off. Firefox retains earlier behavior. See [WORKLIST.md](WORKLIST.md).

---

## 1. Currently Supported Sites (Shipped in nh-dw-2.0)

| Site | Status | Page Host(s) | Image CDN Scheme | Fetch Mode |
| :--- | :---: | :--- | :--- | :--- |
| **nhentai.net** | Shipped | `nhentai.net` | `i*.nhentai.net/galleries/<media>/` | Tab-fetch / API |
| **hentaiera.to** | Shipped | `hentaiera.to`, `.com`, `.site` | `hentaiera.site/galleries/<media>/` | Tab-fetch (HTML) |
| **imhentai.xxx** | Shipped | `imhentai.xxx`, `.org`, `.net` | `m11.imhentai.xxx/033/<token>/` | Tab-fetch (HTML) |
| **hentaienvy.com** | Shipped | `hentaienvy.com` | `m11.hentaienvy.com/033/<token>/` | Tab-fetch (HTML) |
| **hentaifox.com** | Shipped | `hentaifox.com` | `i*.hentaifox.com/<dir>/<media>/` | Tab-fetch (HTML) |
| **hitomi.la** | Shipped | `hitomi.la` | `*.gold-usergeneratedcontent.net` | Direct CDN (`gg.js` math) |
| **`cin.*` mirrors** | Shipped | `cin.lat`, `cin.red`, `cin.*` | *Extracted to nhentai core* | Paste-box shape match |

---

## 2. Tier 1: Primary Candidates (Doujinshi & Manga Galleries)

These sites share the same structural model as nhentai and the mirror network: discrete galleries, numbered/token pages, and reader views. They are the natural next targets for `SiteAdapter` implementations.

### 2.1 AsmHentai (`asmhentai.com`)
* **Category:** Doujinshi Gallery
* **URL Shape:** `https://asmhentai.com/g/<id>/`, reader `/g/<id>/<page>/`
* **Architecture Fit:** **Extremely High.** Lineage and layout closely match early nhentai/hentaifox conventions.
* **Metadata Extraction:** Server-side rendered HTML (`div.cover`, `h1`, page counters).
* **Image Addressing:** Predictable unpadded/zero-padded CDN URLs under domain media directories.
* **Requirements to implement:** 1 gallery HTML capture + 1 reader HTML capture + 3 image URLs from Network tab.

### 2.2 E-Hentai / ExHentai (`e-hentai.org` / `exhentai.org`)
* **Category:** Manga / Doujinshi Archive
* **URL Shape:** `https://e-hentai.org/g/<id>/<token>/`, page `/s/<page_token>/<id>-<page>`
* **Architecture Fit:** **High**, but with page-token mechanics.
* **Metadata Extraction:** Official JSON API (`https://api.e-hentai.org/api.php`) supports batch metadata lookup (`gdata` method with `[gid, token]` pairs).
* **Image Addressing:** Reader pages generate dynamic image URLs via `nl(<page_token>)` reload keys to defeat hotlinking.
* **Requirements to implement:** Handle `[id, token]` composite keys; parse reader page image elements (`#img`); support cookie inheritance (especially for ExHentai).

### 2.3 Pururin (`pururin.to` / `pururin.io`)
* **Category:** Doujinshi Gallery
* **URL Shape:** `https://pururin.to/gallery/<id>/<slug>`, reader `/read/<id>/<page>/<slug>`
* **Architecture Fit:** **High.** Modern clean frontend.
* **Metadata Extraction:** Server-rendered HTML with schema tags.
* **Image Addressing:** CDN subdomains with gallery ID directory paths.
* **Requirements to implement:** 1 gallery page source + 3 CDN image requests.

### 2.4 Simply-Hentai (`simply-hentai.com`)
* **Category:** Manga / Comic Reader
* **URL Shape:** `https://www.simply-hentai.com/<series>/<album>`
* **Architecture Fit:** **Medium-High.** Modern frontend/SPA.
* **Metadata Extraction:** Next.js / Nuxt embedded `__NEXT_DATA__` or client API payloads.
* **Image Addressing:** High-resolution CDN delivery.

### 2.5 MyReadingManga (`myreadingmanga.info`)
* **Category:** Manga / Doujinshi Blog
* **URL Shape:** `https://myreadingmanga.info/<slug>/`
* **Architecture Fit:** **Medium.** WordPress blog structure; images embedded in post content across paginated WordPress pages (`/2/`, `/3/`).
* **Metadata Extraction:** Post entry content scraping (`.entry-content img`).

### 2.6 nhentai.com (`nhentai.com`)
* **Category:** Doujinshi Gallery
* **Note:** Completely distinct platform from `nhentai.net`. Different backend, different media servers, different ID space.
* **Architecture Fit:** **High.**

---

## 3. Tier 2: Secondary Candidates (Image Boards / Boorus)

These platforms organize content as tagged single images or multi-image pools rather than discrete book-style doujinshi albums.

| Site | URL | Feasibility Notes |
| :--- | :--- | :--- |
| **Danbooru** | `danbooru.donmai.us` | REST API available (`/posts.json?tags=pool:<id>`); pool downloads map to albums cleanly. |
| **Gelbooru** | `gelbooru.com` | XML / JSON API available. Pool-based batch downloads. |
| **Rule34.xxx** | `rule34.xxx` | Standard Booru API. Can batch download search queries or pool IDs. |
| **Yande.re** | `yande.re` | Moebooru API. High-resolution originals. |
| **Sankaku Complex** | `chan.sankakucomplex.com` | Requires API / session handling. |
| **Kemono / Coomer** | `kemono.cr` / `coomer.st` | Post-based downloads; attachments and full-res image arrays. |

---

## 3.1 Tier 3: Owner-requested chapter and mixed-media feasibility

| Site | URL | Status |
| :--- | :--- | :--- |
| **Sasangeyou** | `sasangeyou.net` | Offline chapter planner and synthetic reader-data candidate; adapter not implemented. External video/game hosts remain on hold. See [`NEW_DOMAIN_PLANNING.md`](NEW_DOMAIN_PLANNING.md#sasangeyounet). |
| **DoujinDesu** | `doujin.desu.xxx` | Unimplemented; series slugs, chapter UUIDs and reader access need validation. See [DoujinDesu feasibility](NEW_DOMAIN_PLANNING.md#doujindesu). |

## 3.2 Tier 4: Deferred NH-like lookalike candidates

These independent, unverified origins are **not current priorities** and are
not assumed to be official nhentai.net aliases, mutually compatible mirrors,
or supported adapters. `nhentai.com` was already listed in Tier 1 above.

| Site | Status |
| :--- | :--- |
| **nhentai.xxx** | Deferred; gallery-shaped homepage links observed, full reader unverified. |
| **nhentai.website** | Deferred; homepage advertises ZIPs, actual download unverified. |
| **nhentai.io** | Deferred; slug-based homepage links observed, reader unverified. |

See the [scope decision](NEW_DOMAIN_PLANNING.md#nh-lookalike-scope) for
credential isolation and the removed `.to` candidate. The existing
[nhentai.net official-archive plan](NEW_DOMAIN_PLANNING.md#nhentainet-official-archives)
is separate and is not a new candidate. Its cross-site isolation fix is
in place in both source trees, but the option should remain **off** while the
other archive-integrity and delivery-safety issues are open.

---

## 4. Scope & the swap decision (2026-09-24, owner-directed)

- **The canonical live roster is `new domain candidate`** — its Tier 1 /
  Tier 2 URL list (asmhentai, e-hentai, pururin, simply-hentai, myreadingmanga,
  nhentai.com; danbooru, gelbooru, rule34.xxx, yande.re, sankaku,
  kemono/coomer) matches this document's analysis tiers (§2/§3). The
  owner-requested Tier 3 and deferred Tier 4 entries (§3.1/§3.2) are also in
  that roster. Keep the two rosters in step; the separate planning notebook
  holds research, not another candidate roster.
- **Sasangeyou and DoujinDesu are specific owner-requested investigations**,
  not a blanket reversal of the chapter-site swap or a decision to download
  video/games in this extension. Their feasibility and unresolved scope are
  recorded in [`NEW_DOMAIN_PLANNING.md`](NEW_DOMAIN_PLANNING.md).
- **Chapter-based webtoon/manhwa sites swapped to the desktop archiver**
  (`all-comic-doujin-website-archiver-for-offline-reading-GUI-Last`):
  tailspace.com, mangak.io and omegascans.org fit that tool's chapter/series
  model better than this extension's single-volume-archive architecture. An
  earlier revision of this file mirrored them as an "owner picks" section; it
  was removed with the swap (no entries are lost — they live on in that
  project). One structural note survives because it will matter if they ever
  come back: they are slug-addressed (no numeric ids), so the `siteKeys`
  contract (ids must not contain `:`) needs a slug-based composite-key and
  paste-box-shape decision before any adapter work.
- **Video-only / general streaming platforms stay out of scope** — they belong
  in dedicated tools such as `yt-dlp` or `multi-site-video-downloader`. This
  extension remains focused on comic, doujinshi, and image gallery archives
  (`ZIP`, `CBZ`, `PDF`, `raw`).

## 5. Candidate Onboarding Checklist

For authorized candidate work, use appropriate, non-sensitive examples and the privacy checklist in
[`NEW_DOMAIN_PLANNING.md`](NEW_DOMAIN_PLANNING.md#evidence-needed-for-a-future-authorized-comic-reader-implementation).
Never share credentials, cookies, tokens, signed URLs or unredacted HARs.

1. [ ] Describe a sanitized gallery-page structure.
2. [ ] Describe a sanitized reader-page structure (page 1).
3. [ ] Record image hostnames and redacted or synthetic URL shapes from Network (`Img` filter), only if needed.
4. [ ] Record a **sanitized listing-page structure** (search/tag/home cards —
      `src/utils/listCards.ts` needs a representative sample for on-card
      Select/Bookmark/Download). Do not collect raw HARs or identifying paths.
5. [ ] Check Cloudflare / Anti-bot status (is it behind Turnstile / managed challenge?)
6. [ ] Check numbering invariant (unpadded online URL, zero-padded local file)
7. [ ] Add parser `src/parsing/<site>Html.ts` + adapter `src/sources/<site>Source.ts`
8. [ ] Register in `src/sources/index.ts`, `titleBookmark.ts`, `listCards.ts`, and `bookmarkQueue.ts`
9. [ ] Update the Chromium `manifest.json` host permissions **and** add the listing host to the second `content_scripts` block. Firefox is a separate optional port, not a Chromium gate.
10. [ ] Add the Chromium unit suite `test/<site>.test.js` (and its `package.json` mocha list) plus an `e2e-list-controls` discovery fixture. If ported to Firefox, add and run its equivalent wiring and tests before a Firefox release.
