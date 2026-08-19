# NHentai Downloader Improvement Backlog

This document tracks future work for the NHentai Downloader extension. Items are grouped by priority and should be completed in small, reviewable changes.

## Current status

- [x] Manifest V3 service worker configuration
- [x] Replace deprecated `chrome.tabs.executeScript` with `chrome.scripting.executeScript`
- [x] Rebuild the release package from the source package
- [x] Use `chrome.downloads` instead of DOM-based `FileSaver` in the service worker
- [x] Validate and default the concurrent-download setting
- [x] Correct duplicate-title behavior (`rename` and `ignore`)
- [x] Add active-gallery metadata fallback from the open page
- [x] Add original-image CDN fallback between the canonical and numbered image hosts
- [ ] Complete a manual Chrome and Brave end-to-end download test

## Priority 1: reliability and correctness

### 1. Add a real integration test strategy

- Replace the live-only API test with deterministic fixture tests for gallery metadata and image URL generation.
- Keep the live nhentai test optional, for example behind `RUN_LIVE_TESTS=1`.
- Test API success, API 403/503, malformed HTML, missing gallery metadata, and Cloudflare HTML responses.
- Verify that ZIP entries are original page files and not thumbnail files.

**Acceptance criteria:** `npm test` passes without network access, and live tests remain available for manual verification.

### 2. Improve Cloudflare and response detection

- Detect Cloudflare challenge pages by status code, content type, and response body markers.
- Show a specific message explaining that the user must open the page normally and complete any browser challenge.
- Do not add challenge HTML to a ZIP as if it were an image.
- Add retry backoff instead of immediate repeated requests.

**Acceptance criteria:** a blocked request produces a useful error and never creates a corrupt image entry.

### 3. Make original-image validation explicit

- Confirm that every downloaded response has an image content type.
- Reject unexpectedly small responses or HTML responses.
- Preserve the page extension from gallery metadata.
- Continue to avoid thumbnail hosts and thumbnail filename suffixes.

**Acceptance criteria:** ZIP files contain only valid original image responses with the expected page names.

### 4. Replace the base64 ZIP download path for large galleries

The current service-worker workaround converts the ZIP Blob to a base64 data URL. This increases memory use and may fail for large galleries.

Investigate an offscreen document or another MV3-compatible download architecture that can create a downloadable object URL outside the service worker.

**Acceptance criteria:** a large gallery can be archived without duplicating the entire ZIP several times in memory.

## Priority 2: page and search workflow

### 5. Replace search-page regular expressions with DOM extraction

Extract gallery cards from the active page using DOM links such as:

```js
document.querySelectorAll('a[href*="/g/"]')
```

Store stable gallery IDs instead of relying only on visible titles.

Support search, tag, artist, category, favorites, and pagination pages where the same gallery-link structure is present.

**Acceptance criteria:** selected gallery IDs remain correct when titles contain quotes, HTML changes, duplicate names, or additional card markup.

### 6. Add a selected-gallery queue

- Keep the user on the current search/results page.
- Queue selected gallery IDs.
- Show per-gallery progress and failures.
- Continue downloading remaining selected galleries after one failure.
- Prevent duplicate queue entries.

**Acceptance criteria:** a user can select several gallery codes from a result page and receive one ZIP or separate archives according to the option setting.

### 7. Resolve selected galleries through the active browser context

For selected result-page IDs, use a controlled resolver instead of depending only on the API:

1. Open one temporary gallery tab at a time, or use a small bounded queue.
2. Wait for the gallery page to load.
3. Extract the page's gallery object in the main world.
4. Close the temporary tab.
5. Pass validated metadata to the downloader.

Do not open dozens of tabs, and do not claim that this bypasses Cloudflare.

**Acceptance criteria:** selected result-page galleries can be resolved when they are accessible in the user's browser, with clear failure handling when Cloudflare blocks them.

## Priority 3: optional Tor/onion source

### 8. Add configurable source adapters

Create a source abstraction so clearnet and onion URLs are not scattered throughout the code:

```ts
interface GallerySource {
    matchesUrl(url: string): boolean;
    getGalleryId(url: string): string | null;
    getGalleryUrl(id: string): string;
    extractGalleryFromPage(): Promise<any | null>;
    getImageUrls(gallery: any, page: number): string[];
}
```

Implement the clearnet source first. Add an onion source only after the exact onion URL format and image URL behavior are verified.

**Acceptance criteria:** changing source configuration does not require changing downloader logic.

### 9. Add optional onion-site support

- Allow the user to configure an onion base URL.
- Match the onion hostname only when explicitly configured.
- Use active-page extraction for onion pages.
- Do not assume normal Chrome or Brave tabs can reach `.onion` addresses without Tor routing.
- Do not attempt to start Tor or change the browser proxy automatically.
- Verify whether the onion site serves original images itself or redirects to clearnet image hosts.

**Acceptance criteria:** the feature works only when the browser is already configured to reach the onion site, and it fails clearly when the onion service is unavailable.

## Priority 4: Chromium and Brave compatibility

### 10. Test supported browser environments

Test the unpacked release on:

- Current Google Chrome stable
- Current Brave stable
- Brave private window with Tor, if extension access is enabled
- A normal Brave window with Shields enabled
- A normal Brave window with Shields adjusted for the site

Record browser version, operating system, page type, and result.

**Acceptance criteria:** supported environments are documented, and unsupported Tor/private-window combinations show a clear limitation rather than an unexplained failure.

### 11. Verify MV3 lifecycle behavior

- Test popup closing while a download is running.
- Test service-worker suspension and restart.
- Persist active-job state in `chrome.storage.session` or another appropriate mechanism.
- Ensure progress and errors are recoverable when the popup is reopened.

**Acceptance criteria:** a download does not become permanently stuck when the popup closes or the service worker restarts.

## Priority 5: product and UX

### 12. Reconcile README behavior with the implementation

The README currently describes a page-injected "Download Full Archive" button, while the implementation primarily uses the extension popup and injected selection checkboxes.

Choose one direction:

- Implement and document a real page button, or
- Remove the page-button claim and document the popup workflow accurately.

### 13. Improve progress and error reporting

- Show the current gallery and page number.
- Show retry attempts.
- Distinguish metadata failure, Cloudflare failure, image failure, ZIP failure, and cancellation.
- Report the number of successful and failed galleries at the end.

### 14. Make filenames safe and predictable

- Sanitize names consistently in single and multiple download modes.
- Avoid collisions between separate galleries.
- Add gallery ID to the default filename when titles are empty or duplicated.
- Test Unicode titles and reserved Windows filename characters.

### 15. Add cancellation that stops active work

- Abort outstanding `fetch` calls with `AbortController`.
- Stop queued galleries after cancellation.
- Avoid starting new image downloads after the user presses Cancel.
- Report partial-download behavior clearly.

## Security and maintenance

- Keep host permissions limited to the actual clearnet, image, and explicitly configured onion hosts.
- Never log cookies, Cloudflare clearance values, or authentication headers.
- Avoid accepting arbitrary URLs from page messages; validate gallery IDs and source hosts.
- Keep generated release JavaScript synchronized with the TypeScript source.
- Recheck Chrome and Brave MV3 API compatibility before each release.
- Review the project license and the target website's terms before distributing the extension.

## Suggested implementation order

1. Deterministic tests and response validation
2. DOM-based result-page extraction
3. Selected-gallery queue
4. Active-context gallery resolver
5. Large-ZIP/offscreen download architecture
6. README and UX reconciliation
7. Configurable source adapters
8. Optional onion source
9. Chrome/Brave/Tor compatibility matrix
