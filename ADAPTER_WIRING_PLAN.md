# Multi-Site Adapter Implementation Plan (v4)

**Recorded:** 2026-09-22 (session `arena/01a0c407-nh-dw-2-0`).
**Status:** All 6 target site captures and HARs verified on `origin/main`. Ready for phased step-by-step implementation.

---

## 1. Complete Target Site Matrix

Every field below is verified against real user captures, HAR traces, and reader scripts.

| Contract Field | nhentai.net | hentaiera.to | imhentai.xxx | hentaienvy.com | hentaifox.com | hitomi.la |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Page Host** | `nhentai.net` | `hentaiera.to` | `imhentai.xxx` | `hentaienvy.com` | `hentaifox.com` | `hitomi.la` |
| **Image Host(s)** | `i*.nhentai.net` | `hentaiera.site` | `m11.imhentai.xxx` | `m11.hentaienvy.com` | `i*.hentaifox.com` | `*.gold-usergeneratedcontent.net` |
| **Gallery URL** | `/g/<id>/` | `/gallery/<id>/` | `/gallery/<id>/` | `/gallery/<id>/` | `/gallery/<id>/` | `/doujinshi/<slug>-<id>.html` or `/galleries/<id>.html` |
| **Reader URL** | `/g/<id>/<n>/` | `/gallery/<id>/<n>/` | `/view/<id>/<n>/` | `/g/<id>/<n>/` | `/g/<id>/<n>/` | `/reader/<id>.html#<n>` |
| **Media Address** | numeric `media_id` | numeric `media_id` | media **token** | media **token** | numeric `media_id` + `image_dir` | SHA256 **hash** per page |
| **Gallery Metadata** | Native JSON API / HTML | `ld+json` ImageGallery | `<title>` + `Pages: N` | `<title>` + `#readerPagesJson` | `#pages`, `#image_dir`, `#gallery_id`, `g_th` | `galleries/<id>.js` (`galleryinfo`) |
| **Reader Full Image** | `#image-container img` | `#reader_img` | `#gimg` | `#readerImg` | `#gimg` | Dynamic `<picture>` / `<img>` via JS |
| **Per-Page Ext Source** | `images.pages[].t` | reader `src` / thumb | reader `src` | `#readerPagesJson` map | `g_th[page]` type code | `galleryinfo.files[].name` / `hasavif` / `haswebp` |
| **Thumb vs Page Ext** | Identical | Identical (`.webp`) | Diff (`.jpg` vs `.webp`) | Diff (`.jpg` vs `.webp`) | From `g_th` map | Dual (`.avif` / `.webp`) |
| **Image Path Scheme** | `/galleries/<media>/<n>.<ext>` | `/galleries/<media>/<n>.<ext>` | `/033/<token>/<n>.<ext>` | `/033/<token>/<n>.<ext>` | `/<dir>/<media>/<n>.<ext>` | `/<gg.b><s(hash)>/<hash>.<ext>` |
| **Referer Needed** | Yes | Yes | No | Yes | Yes | Yes (`gold-usergeneratedcontent.net`) |
| **Cloudflare** | Optional / Managed | Yes | Yes | Yes | Yes | **No** (Direct CDN) |
| **Fetch Strategy** | Tab-fetch / Direct API | Tab-fetch | Tab-fetch | Tab-fetch | Tab-fetch | Direct CDN fetch |

---

## 2. Numbering and Filename Invariant

* **Online CDN Fetch URLs:** Always **unpadded numbers** (`1.jpg`, `2.webp`, `11.jpg`, `111.png`).
  * Managed by `currPage + 1 + format` in `Downloader.ts`.
* **Saved Files & Archive Entries:** Always **3-digit zero-padded numbers** (`001.jpg`, `002.webp`, `011.jpg`, `111.png`).
  * Managed by `getNumberWithZeros(currPage + 1) + format` in `Downloader.ts`.
  * Preserves correct numerical sorting in operating systems and comic archive viewers.

---

## 3. SiteAdapter Interface Contract

Each site implements a standardized `SiteAdapter` extending `GallerySource`:

```typescript
export interface SiteAdapter extends GallerySource {
    readonly site: string;                            // e.g. "nhentai" | "hentaiera" | "imhentai" | "hentaienvy" | "hentaifox" | "hitomi"
    readonly defaultFormat: "zip" | "cbz" | "pdf" | "raw";
    
    // URL matching & routing
    matchesUrl(url: string): boolean;
    getGalleryId(url: string): string | null;
    getGalleryUrl(id: string): string;
    getReaderPageUrl(id: string, page: number): string;
    
    // Metadata extraction & normalization
    extractGallery(htmlOrJson: string, url?: string): any | null; // Normalizes to internal gallery schema
    extractReaderImage?(html: string): string | null;             // Extracts full image URL from reader HTML
    
    // Image addressing & CDN rules
    getImageUrls(mediaId: string, filename: string, extra?: any): string[];
    getImageHosts(): string[];
    getAllowedPathRegex(): RegExp;
    
    // Network behaviors
    needsTabFetch(): boolean;
}
```

---

## 4. Pipeline Seams to Wire (The 6 Seams)

1. **Adapter Registry (`src/sources/index.ts`):**
   * Register all adapters.
   * Provide `getAdapterForUrl(url)` and `getAdapterForSite(site)`.
   * Fall back to nhentai reference adapter for legacy calls.

2. **Popup / Single Preview (`src/preview/popup.ts`):**
   * Resolve adapter via `getAdapterForUrl(tabUrl)`.
   * Non-nhentai sites extract metadata via `source.extractGallery(html)` (with strict guard preventing non-nhentai IDs from hitting `/api/v2/galleries`).

3. **Background Worker (`src/background/background.ts`):**
   * Dispatch tab scraping and metadata normalization through the matching adapter.
   * Maintain composite keys (`<site>:<id>`) across message handlers.

4. **Offscreen & Pipeline (`src/offscreen/offscreen.ts`, `src/utils/batchPipeline.ts`):**
   * Thread active site context through download jobs.
   * Split mixed bookmark queue downloads into **one job per site**.

5. **Downloader Engine (`src/background/Downloader.ts`):**
   * Inject matching `SiteAdapter`.
   * Support dynamic type codes (`j`, `p`, `g`, `w`, `b`, `a`) and extension fallback chains.

6. **CDN Configuration & Manifest (`src/sources/cdnConfig.ts`, `manifest.json`):**
   * Allow dynamic host validation via adapter `getImageHosts()`.
   * Allow dynamic path validation via adapter `getAllowedPathRegex()`.
   * Update `manifest.json` `host_permissions` with all target domains.

---

## 5. Implementation status — ALL SIX PHASES SHIPPED (2026-09-22/23, 3.9.0 / FF 1.3.0); listing-card surface shipped 2026-09-25 (3.10.0 / FF 1.4.0, PR #50)

Phase 1 adapter contracts & registry (`src/sources/index.ts`:
`getAdapterForUrl` / `getAdapterForSite`, per-adapter `cdnConfig` allowlists) ·
Phase 2 hentaiera + imhentai · Phase 3 hentaienvy + hentaifox · Phase 4 hitomi
(`hitomiResolver.ts` implementing `gg.m`/`gg.s`/`full_path_from_hash`, default
format `raw`) · Phase 5 universal paste box (all six sites' URL shapes +
composite `site:id` keys) + manifest host permissions + per-site job splitting
(`batchPipeline.ts`) · Phase 6 verification (unit + e2e both trees, release
sync). Per-phase detail and test names: `IMPROVEMENT_BACKLOG.md` session logs
2026-09-22/23. **Listing-card surface (item 63, 2026-09-25, 3.10.0 / FF 1.4.0):** the six
sites' listings are now covered by `src/utils/listCards.ts` (per-site
container/cover/title/id table dispatched from `findCards()` via
`getSourceForUrl(location.href).site`), with a second `content_scripts` block
for the five non-nhentai listing hosts — see §6 step 3.

This document's §§1–4 stay as the operative reference for
adding **site #7+**: copy the matrix row, implement the interface, wire the
six seams, follow `CAPTURE_GUIDE.md` for samples first.

## 6. Adding site #7 (the live checklist)

1. Owner capture per `CAPTURE_GUIDE.md` (one sanitized HAR per site, or
   gallery+reader **and listing-page** HTML and 3 image URLs; rendered DOM
   instead of HAR for client-side-rendered sites). The listing sample is what
   the card-control table is measured from — without it, site #7 ships without
   Select/Bookmark/Download on its cards.
2. Add the contract row to §1's matrix (every field measured from the
   capture, never assumed — the 2026-09-15 audit's wrong assumptions are the
   cautionary tale).
3. `src/parsing/<site>Html.ts` + `src/sources/<site>Source.ts`; register in
   `src/sources/index.ts`; site slug in `siteKeys`; per-adapter host/path
   allowlists in `cdnConfig`; paste-box shapes; `titleBookmark.ts` table entry
   if the site has a gallery page button anchor; manifest `host_permissions`
   (both trees).
4. **Card controls:** a row in `src/utils/listCards.ts` (container, cover/link
   selector, title selector, id regex — measured from the listing capture, never
   assumed) **and** the site's listing host in the second `content_scripts`
   block of both `manifest.json`s; without both, cards render no controls and
   Select-all has nothing to select.
5. Unit suite `test/<site>.test.js` (+ append to BOTH `package.json` mocha
   lists), e2e coverage — including a `e2e-list-controls` per-site discovery
   fixture and an `e2e-title-bookmark` gallery-page case — both trees, release
   sync.
6. Real-browser check is owner-only (items 42/58 pattern).
