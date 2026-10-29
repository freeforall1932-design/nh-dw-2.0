# Multi-Site Adapter Implementation Plan (v4)

**Recorded:** 2026-09-22 (session `arena/01a0c407-nh-dw-2-0`).
**Historical status:** Six existing-site captures informed this plan. This is
an adapter reference, not evidence that Sasangeyou or DoujinDesu is implemented
or that current reader markup and transfers still match. See the current scope
in §6 and [WORKLIST.md](WORKLIST.md).

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
| **Sibling fallback (item 72)** | none (single-site network) | title-match chain: envy → imh | token host-swap: envy (6 hosts), then era by title | token host-swap: imh (2 hosts), then era by title | title-match chain: era → imh | none (single-site network) |

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
    getFallbackImageUrls?(mediaId: string, filename: string): string[]; // item 72: sibling-store URLs for the same media address (token-shared twins only)
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
six seams, follow [SITE_CAPTURE_GUIDE.md](SITE_CAPTURE_GUIDE.md) for sanitized samples first.

## 6. Adding site #7 (the live checklist)

**Current scope:** Sasangeyou chapter work and Chromium nhentai API archive
hardening are authorized. Sasangeyou has an offline chapter planner and a
synthetic-only reader-data candidate parser; neither is wired or verified
against site DOM. No new-site adapter is live-transfer verified. DoujinDesu
remains unimplemented and external video/game hosts remain on hold. Chromium
archive checks are offline-tested but its opt-in must stay off until real
browser and delivery behavior are verified; Firefox retains its earlier
behavior. This checklist is not evidence of new-site support.

**Browser priority (owner decision 2026-10-27):** implement and verify new
work in the Chromium tree first. Firefox porting is optional when low-effort
and otherwise deferred; it does not block Chromium. Retain the Firefox tree,
and if a Firefox change is released, give it its own manifest wiring and tests
rather than implying unverified parity. See [WORKLIST.md](WORKLIST.md).

1. With an authorized non-sensitive example, record sanitized gallery/reader
   **and listing-page** structures and, only if needed, image hostnames and
   redacted/synthetic URL shapes. The listing sample measures card selectors.
   Never request credentials, cookies, tokens, signed URLs or unredacted HARs;
   follow the [privacy checklist](NEW_DOMAIN_PLANNING.md#evidence-needed-for-a-future-authorized-comic-reader-implementation).
2. Add the contract row to §1's matrix (every field measured from the
   capture, never assumed — the 2026-09-15 audit's wrong assumptions are the
   cautionary tale).
3. In the Chromium tree, add `src/parsing/<site>Html.ts` +
   `src/sources/<site>Source.ts`; register in `src/sources/index.ts`; add the
   site slug, host/path allowlists, paste-box shapes, title-button entry and
   narrowly scoped `manifest.json` host permissions.
4. **Card controls:** a row in Chromium's `src/utils/listCards.ts` (container,
   cover/link selector, title selector, id regex — measured from the listing
   capture) **and** the site's listing host in the second `content_scripts`
   block of its `manifest.json`; without both, cards render no controls and
   Select-all has nothing to select.
5. Add Chromium's unit suite `test/<site>.test.js` to its `package.json` mocha
   list, with e2e coverage including `e2e-list-controls` discovery and an
   `e2e-title-bookmark` gallery-page case. If a Firefox port is low-effort and
   undertaken, repeat its browser-specific wiring and tests before its release.
6. Real-browser check is owner-only; Chrome first (item 42), Firefox/device
   verification (item 58) separately if that build is pursued.
