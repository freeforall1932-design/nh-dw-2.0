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

## 5. Step-by-Step Implementation Roadmap

To avoid context drift and ensure zero regressions, implementation is split into 6 focused phases:

```
[Phase 1: Adapter Registry & Contracts]
                  │
                  ▼
[Phase 2: Hentaiera & Imhentai Adapters]
                  │
                  ▼
[Phase 3: Hentaienvy & HentaiFox Adapters]
                  │
                  ▼
[Phase 4: Hitomi.la Adapter & Subdomain Resolver]
                  │
                  ▼
[Phase 5: Universal Paste Box & Multi-Site UI]
                  │
                  ▼
[Phase 6: Full Verification & Parity Audit]
```

### Phase 1: Core Adapter Contracts & Registry Refactoring
* [x] Define `SiteAdapter` interface in `src/sources/SiteAdapter.ts` (or `GallerySource.ts`).
* [x] Refactor `src/sources/cdnConfig.ts` to accept multi-site host allowlists and path regexes.
* [x] Build `src/sources/index.ts` registry with lookup methods (`getAdapterForUrl`, `getAdapterForSite`).
* [x] Add unit tests for registry routing and `cdnConfig` multi-site allowlists.

### Phase 2: Hentaiera & Imhentai Adapters
* [x] Integrate `src/sources/hentaieraSource.ts` and `src/parsing/hentaieraHtml.ts` into registry.
* [x] Build `src/sources/imhentaiSource.ts` and `src/parsing/imhentaiHtml.ts` (token-based `/033/` storage).
* [x] Wire Popup preview seam with nhentai-API collision guard.
* [x] Wire Downloader engine to use adapter candidate lists.
* [x] Add unit test suite `test/imhentai.test.js` + `test/hentaiera.test.js`.

### Phase 3: Hentaienvy & HentaiFox Adapters
* [x] Build `src/sources/hentaienvySource.ts` & `src/parsing/hentaienvyHtml.ts` (parsing `#readerPagesJson` + shared token store).
* [x] Build `src/sources/hentaifoxSource.ts` & `src/parsing/hentaifoxHtml.ts` (`g_th` type codes, `/004/` and `/005/` dirs).
* [x] Register both adapters in `src/sources/index.ts`.
* [x] Add unit test suites `test/hentaienvy.test.js` and `test/hentaifox.test.js`.

### Phase 4: Hitomi.la Adapter & Subdomain Resolver
* [x] Build `src/sources/hitomiResolver.ts` (implementing `gg.m`, `gg.s`, `full_path_from_hash`, dynamic subdomain routing).
* [x] Build `src/sources/hitomiSource.ts` and `src/parsing/hitomiHtml.ts` (handling `galleries/<id>.js` metadata and dual AVIF/WEBP paths).
* [x] Set default format for Hitomi to `raw` (with warning for large 1GB+ memory archives until streaming ZIP lands).
* [x] Add unit test suite `test/hitomi.test.js`.

### Phase 5: Universal Paste Box & UI Polish
* [x] Update `CardParsing.ts` and paste-box parser in `popup.ts` / `listControls.ts` to recognize:
  * `/g/<id>/` (nhentai, hentaienvy, hentaifox)
  * `/gallery/<id>/` (hentaiera, imhentai, hentaienvy, hentaifox)
  * `/view/<id>/` (imhentai)
  * `hitomi.la/doujinshi/...-<id>.html` or `hitomi.la/galleries/<id>.html`
  * Composite keys: `nhentai:<id>`, `hentaiera:<id>`, `imhentai:<id>`, `hentaienvy:<id>`, `hentaifox:<id>`, `hitomi:<id>`.
* [x] Update `manifest.json` `host_permissions` across Chrome and Firefox builds.
* [x] Split mixed bookmark batches in `batchPipeline.ts` (one job per site).

### Phase 6: Verification & Test Automation
* [x] Run all unit test suites (`npm test`).
* [x] Run all offline e2e suites (`npm run test:e2e`).
* [x] Sync bundles to Firefox build (`NHDW_Firefox_v1.0.0`) and release directory (`NHDW_Release_v3.0.0`).
* [x] Update `SESSION_HANDOFF.md` and `WORKLIST.md`.
