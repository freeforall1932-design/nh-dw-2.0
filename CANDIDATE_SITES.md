# Multi-Site Candidate Roster

**Created:** 2026-09-23 (session `arena/01a0cdce-nh-dw-2-0`).
**Reference Source:** Audited against the owner's desktop reference repository
([`freeforall1932-design/all-comic-doujin-website-archiver-for-offline-reading-GUI-Last`](https://github.com/freeforall1932-design/all-comic-doujin-website-archiver-for-offline-reading-GUI-Last) / `Hitomi-Downloader`).

This document tracks potential next candidate sites for extension support, categorized by architectural fit, technical complexity, and feasibility within a Manifest V3 browser extension.

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

## 4. Tier 3: Out of Scope for this Extension

Sites that are video-only or general streaming (e.g. YouTube, TikTok, Pornhub, XVideos, Bilibili) belong in dedicated tools such as `yt-dlp` or `multi-site-video-downloader`. This extension remains focused on comic, doujinshi, and image gallery archives (`ZIP`, `CBZ`, `PDF`, `raw`).

---

## 5. Candidate Onboarding Checklist

When selecting any candidate from Tier 1 to implement:

1. [ ] **Capture 1 Gallery Page HTML** (`view-source:https://<site>/<gallery-path>`)
2. [ ] **Capture 1 Reader Page HTML** (page 1)
3. [ ] **Capture 2–3 Full Image URLs** from DevTools Network tab (`Img` filter)
4. [ ] Check Cloudflare / Anti-bot status (is it behind Turnstile / managed challenge?)
5. [ ] Check numbering invariant (unpadded online URL, zero-padded local file)
6. [ ] Add parser `src/parsing/<site>Html.ts` + adapter `src/sources/<site>Source.ts`
7. [ ] Register in `src/sources/index.ts`, `titleBookmark.ts`, and `bookmarkQueue.ts`
8. [ ] Update Chrome & Firefox `manifest.json` host permissions
9. [ ] Add unit test suite `test/<site>.test.js`
