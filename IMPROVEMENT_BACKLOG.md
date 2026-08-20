# NHentai Downloader Improvement Backlog

This document tracks future work for the NHentai Downloader extension. Items are grouped by priority and should be completed in small, reviewable changes.

## Current status

- [x] Manifest V3 service worker configuration
- [x] Replace deprecated `chrome.tabs.executeScript` with `chrome.scripting.executeScript`
- [x] Rebuild the release package from the source package
- [x] Use `chrome.downloads` instead of DOM-based `FileSaver` in the service worker
- [x] Validate and default the concurrent-download setting
- [x] Correct duplicate-title behavior (`rename` and `ignore`)
- [x] Add active-gallery metadata fallback from the open page (tab-first `window._gallery` / script embeds; API last)
- [x] Add original-image CDN fallback between the canonical and numbered image hosts
- [x] Remove legacy `window.*` background assignments that crashed the MV3 service worker before `chrome.runtime.onMessage.addListener` could register (every message from the popup got no response)
- [x] Ship the webpack-built popup (`index.html` + `js/preview.js`) in `NHDW_Release_v3.0.0`; delete the hand-written `js/popup.js` that messaged a nonexistent content-script listener
- [x] Fix `content.ts` / `updateContent.ts` caption-loop crash on pages without `.caption` cards; scope gallery IDs to each card's own gallery link (`closest('a[href*="/g/"]')` — the caption sits inside the cover link on nhentai) instead of a document-wide regex matched by index; verified by `scripts/e2e-content.js`
- [x] Promise-wrap the raw-mode `chrome.downloads.download` callback so failures feed the retry loop and error callback instead of being thrown in a bare callback and silently dropped
- [x] Fix `downloadAllPages`: stop mutating `pagesArr` while iterating so the final ZIP is actually downloaded
- [x] Remove dangling `web_accessible_resources` entries (`js/jszip/...`, `js/FileSaver.js/...`) from the release manifest
- [x] Add window-less service-worker tests (`scripts/smoke-mv3.js`, `scripts/e2e-worker.js`): load the built worker in a no-`window` VM context and drive ZIP, raw, and error paths through `chrome.downloads` with zero network access
- [x] Replace the base64 ZIP download path: downloads now run in an MV3 offscreen document (`src/offscreen/offscreen.ts` + `offscreen.html`) that delivers the archive through a real `URL.createObjectURL`; the in-worker base64 path remains only as a fallback for browsers without `chrome.offscreen`. The service worker relays commands (`scripts/e2e-relay.js` verifies relay, idle-close, and no message loops).
- [x] Include the MV3 `offscreen` permission in both source and release manifests so real Chrome/Brave expose `chrome.offscreen` and use the intended object-URL ZIP path.
- [x] Replace the live-only API test with deterministic fixture tests: `test/parsing.test.js` (API/HTML parsers incl. `\u0022` embeds, malformed/Cloudflare HTML rejection, filename utils) and `test/downloader.test.js` (image URL order and CDN fallback, ZIP entry names and original-page bytes, raw mode, object-URL delivery). The live nhentai check is opt-in behind `RUN_LIVE_TESTS=1` (`npm run test:live`).
- [~] Chrome and Brave end-to-end download test: the automated real-browser suite exists (`scripts/e2e-browser.js`, runnable via `npm run test:browser`, plus a ready-to-run CI workflow for real Chrome and Brave included in `SESSION_HANDOFF.md`) and its harness plumbing was validated live; executing the suite itself in an unrestricted environment is still pending (see item 10).
- [x] Replace the search-page regex flow with DOM extraction: `js/getGalleries.js` extracts gallery cards + pagination from the live DOM (id from each card's own cover link, title from the caption inside the same link), the popup consumes structured cards, and the network path (`downloadAllPagesAsync`) uses the shared `parseGalleryCardsFromHtml` parser (see item 5).
- [x] Selected-gallery queue: unique-by-construction `Record<id, title>`, per-gallery progress, continue-after-failure, and a final summary with per-kind failure counts (see item 6).

## Priority 1: reliability and correctness

### 1. Add a real integration test strategy

- Replace the live-only API test with deterministic fixture tests for gallery metadata and image URL generation.
- Keep the live nhentai test optional, for example behind `RUN_LIVE_TESTS=1`.
- Test API success, API 403/503, malformed HTML, missing gallery metadata, and Cloudflare HTML responses.
- Verify that ZIP entries are original page files and not thumbnail files.

**Acceptance criteria:** `npm test` passes without network access, and live tests remain available for manual verification.

**Progress:** DONE.
`test/parsing.test.js` covers `ApiParsing` / `HtmlParsing` fixtures (including `\u0022`-escaped
gallery embeds and non-JSON Cloudflare responses) and filename utilities; `test/downloader.test.js`
covers image URL generation and CDN fallback order, ZIP entry names and original-page bytes,
raw mode, and object-URL delivery; `scripts/smoke-mv3.js` / `scripts/e2e-worker.js` /
`scripts/e2e-offscreen.js` / `scripts/e2e-relay.js` cover the built bundles with chrome/fetch
stubs and zero network access. The live check is opt-in: `npm run test:live`.

### 2. Improve Cloudflare and response detection

- Detect Cloudflare challenge pages by status code, content type, and response body markers.
- Show a specific message explaining that the user must open the page normally and complete any browser challenge.
- Do not add challenge HTML to a ZIP as if it were an image.
- Add retry backoff instead of immediate repeated requests.

**Acceptance criteria:** a blocked request produces a useful error and never creates a corrupt image entry.

**Progress:** mostly done. Single-gallery metadata now reads the already-open gallery tab first
(`window._gallery` / `window.gallery`, then `_gallery` JSON already in page `<script>` tags via
`GalleryEmbed` / `activeTabGallery`). Same-origin `/api/gallery/<id>` and the extension-origin API
are last resorts, so a loaded gallery tab does not 403 before the popup can show Download. This is
not a Cloudflare bypass: a challenge interstitial still has no gallery JSON. Image fetches from
`i*.nhentai.net` in the offscreen/worker path can still be 403'd independently. Extension/offscreen image and batch metadata fetches also request credentials
and have Cloudflare-aware error messages. The `ApiParsing.GetJsonAsync` method now detects HTML content-type
before attempting `response.json()` and produces a clear "Cloudflare blocked" message for 403/503 responses
and an "Unexpected response type" message for 200 HTML pages. The batch download loops in both background.ts
and offscreen.ts distinguish Cloudflare errors (403/503 or HTML content-type) from plain HTTP errors and
give the user actionable guidance. The `isCloudflareResponse()` utility is exported from `ApiParsing.ts` for
reuse. Covered by 6 new fixture tests in `test/parsing.test.js`. Retry backoff is now implemented: the
Downloader retries page image fetches with exponential backoff (base 200ms, growing to ~3.2s at the last
retry) so repeated failures don't hammer the server. The `retryBackoffMs` property is configurable.
API metadata parsing also checks response bodies for common Cloudflare challenge markers
such as `cf-challenge`, `cf_chl_`, `Just a moment...`, and `Checking your browser`, including
200 responses with misleading or missing content types. Covered by fixture tests in
`test/parsing.test.js`.

### 3. Make original-image validation explicit

- Confirm that every downloaded response has an image content type.
- Reject unexpectedly small responses or HTML responses.
- Preserve the page extension from gallery metadata.
- Continue to avoid thumbnail hosts and thumbnail filename suffixes.

**Acceptance criteria:** ZIP files contain only valid original image responses with the expected page names.

**Progress:** done. `Downloader.#downloadPageInternalAsync` now rejects
any 200 response whose `Content-Type` does not start with `image/` (HTML
challenge pages fall through to the next CDN mirror and surface a clear
"unexpected content-type" error instead of being zipped as images), covered by
two tests in `test/downloader.test.js`. The page extension still comes from
gallery metadata and only original (non-thumbnail) hosts are used. The
"unexpectedly small response" size guard is now also implemented: responses
smaller than `minImageBytes` (default 1024 bytes) are rejected with a
"response too small" error before being added to the ZIP. Covered by a new
test in `test/downloader.test.js`.

### 4. Replace the base64 ZIP download path for large galleries

The current service-worker workaround converts the ZIP Blob to a base64 data URL. This increases memory use and may fail for large galleries.

Investigate an offscreen document or another MV3-compatible download architecture that can create a downloadable object URL outside the service worker.

**Acceptance criteria:** a large gallery can be archived without duplicating the entire ZIP several times in memory.

**Progress:** DONE.
Downloads now run in an MV3 offscreen document (`src/offscreen/offscreen.ts`, `offscreen.html`)
created with the `BLOBS` reason and both source/release manifests now request the required
`offscreen` permission. The ZIP Blob is delivered via `URL.createObjectURL` and the
object URL is revoked after the download is accepted; the base64 data-URL path only remains as
a fallback for environments without `chrome.offscreen`. As a bonus the offscreen document is
not subject to the service worker idle timeout, so long downloads survive MV3 worker
termination. The service worker only relays commands (`isDownloadFinished`, `downloadDoujinshi`,
`downloadAllDoujinshis`, `downloadAllPages`, `goBack`, progress refresh) and closes the
document after 60 s of inactivity. Covered by `scripts/e2e-offscreen.js`, `scripts/e2e-relay.js`,
and the object-URL block in `test/downloader.test.js`.

## Priority 2: page and search workflow

### 5. Replace search-page regular expressions with DOM extraction

Extract gallery cards from the active page using DOM links such as:

```js
document.querySelectorAll('a[href*="/g/"]')
```

Store stable gallery IDs instead of relying only on visible titles.

Support search, tag, artist, category, favorites, and pagination pages where the same gallery-link structure is present.

**Acceptance criteria:** selected gallery IDs remain correct when titles contain quotes, HTML changes, duplicate names, or additional card markup.

**Progress:** DONE for the popup path, and the network path shares the same parser.
`js/getGalleries.js` (new content script, replaces the old `js/getHtml.js` "serialize whole
DOM -> regex in the popup" flow) extracts gallery cards straight from the live DOM:
each card's ID comes from its own cover link (`a[href*="/g/"]`), the title from the
caption inside the same link (with `<br>`-separated injected-checkbox markup stripped and
entities decoded), duplicates by ID are skipped, and pagination (current page from
`.pagination .current`, max page from the last `page=` link) is reported to the popup.
The popup (`updatePreviewAll`) now consumes the structured cards, keeps titles in a plain
`id -> title` map instead of DOM `name` attributes (so quotes can never break the markup),
and escapes displayed titles. The fetched-page path (`downloadAllPagesAsync` in both
background.ts and offscreen.ts) uses the shared pure parser `parseGalleryCardsFromHtml`
(`src/parsing/CardParsing.ts`), which is anchor-scoped so an ID can never be mispaired
with another card's caption, and tolerates newlines/extra markup. Also fixed the old
`/\{[^\}]+\}/` typo in the "{pretty}" strip regexes. Covered by 8 new fixture tests in
`test/parsing.test.js` and a new `getGalleries.js` phase in `scripts/e2e-content.js`
(unique cards, quoted/entity titles, pagination).

### 6. Add a selected-gallery queue

- Keep the user on the current search/results page.
- Queue selected gallery IDs.
- Show per-gallery progress and failures.
- Continue downloading remaining selected galleries after one failure.
- Prevent duplicate queue entries.

**Acceptance criteria:** a user can select several gallery codes from a result page and receive one ZIP or separate archives according to the option setting.

**Progress:** DONE (built on items 5 and 13; verified by new regression phases).
The user stays on the results page (checkboxes are injected by the content script,
the popup only collects the selected IDs). Selected gallery IDs are sent as a
`Record<id, title>` — keys are unique by construction, so duplicate queue entries are
impossible (the content script and `getGalleries.js` also dedupe by ID). Per-gallery
progress is broadcast before each gallery (`batchProgress`), each failure surfaces a
single `downloadError` with its classified kind, the batch continues past both
metadata and image failures, and the final `batchSummary` reports totals plus a
per-kind breakdown. One combined ZIP (or one archive per gallery when
`downloadSeparately` is set) is produced as before. Covered by a new phase 7 in
`scripts/e2e-worker.js` and a matching phase in `scripts/e2e-offscreen.js`: a
three-gallery queue with one metadata failure and one image failure still delivers
the final ZIP, reports 1/2/3 with `failedKinds {metadata:1, image:1}`, emits exactly
one error per failing gallery, and sends `batchProgress` for all three.

### 7. Resolve selected galleries through the active browser context

**Progress:** complete for the resolver and offline coverage. The popup resolves selected IDs through one bounded temporary tab at a time, extracts `window._gallery` in the main world, closes each tab, and passes successful metadata through the worker/offscreen pipeline. API fallback remains available when a gallery cannot be resolved. `test/resolver.test.js` verifies sequential tab usage, cleanup, and already-complete tabs; real Chrome/Brave confirmation remains covered by item 10.

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

**Progress:** complete for the supported clearnet source. The `GallerySource` interface and source registry centralize host matching, gallery/API URLs, and image CDN fallback URLs. `ApiParsing`, `HtmlParsing`, `Downloader`, the popup, the temporary-tab resolver, and the service-worker icon path use the adapter; parsers and the downloader accept an injectable source. Onion support is intentionally dropped under item 9.

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

### 9. Add optional onion-site support — dropped

Onion support is intentionally not being implemented. The extension cannot assume that the
user's browser is configured for Tor, and the onion hostname/availability and page-to-image
behavior cannot be reliably verified in this environment. The extension will continue to
support the normal clearnet source only; no unpredictable onion URL handling or misleading
Tor compatibility claim will be added.

The existing downloader's zero-padded names (for example, `001.webp`) are an intentional
naming convention. If another source were ever added later, preserving source names such as
`1.webp` would be a separate adapter decision.

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

**Progress:** the manual test is automated as `scripts/e2e-browser.js` (`npm run test:browser`):
it loads `NHDW_Release_v3.0.0` in a real Chromium-family browser over the DevTools Protocol
and verifies the service worker, popup, content scripts, offscreen-document ZIP pipeline, and
the ZIP on disk (nhentai.net is simulated locally, see the script header). A GitHub Actions workflow for real Google Chrome + real Brave is at
`.github/workflows/e2e-browser.yml`.

Environment note (why it is still `[~]` rather than `[x]`): the development sandbox could not
execute the suite itself —
1. its network egress is limited to the npm registry and github.com (nhentai.net, Debian
   mirrors, storage.googleapis.com, and GitHub release assets are all unreachable), and
2. the only browser binary obtainable through those channels, `@sparticuz/chromium`, is a
   serverless build with extension support compiled out (verified: even a minimal MV3 test
   extension produces no service worker target), and
3. the sandbox's GitHub token lacks the `workflows` permission, so the CI workflow file
   cannot be pushed from here.

What was verified in the sandbox: the harness's riskiest plumbing — the local HTTPS
nhentai.net fixture, `--host-resolver-rules` remapping, and the certificate bypass — works in
headless Chromium (the browser loaded the fixture page at `https://nhentai.net/`). To close
this item, run `npm run test:browser` on a machine with Chrome and/or Brave installed
(prefixed with `sudo` so the fixture can bind port 443), or enable the CI workflow.

### 11. Verify MV3 lifecycle behavior

- Test popup closing while a download is running.
- Test service-worker suspension and restart.
- Persist active-job state in `chrome.storage.session` or another appropriate mechanism.
- Ensure progress and errors are recoverable when the popup is reopened.

**Acceptance criteria:** a download does not become permanently stuck when the popup closes or the service worker restarts.

**Progress:** mostly done. The offscreen document already survives popup closes and
service-worker restarts (the worker only relays commands, and it is not subject to the
worker idle timeout). Active-job state is now persisted in `chrome.storage.session`
(`downloadJob` marker): both the service-worker fallback path and the offscreen document
write it in `beginJob()` and clear it on completion, error, or `goBack`. When the popup
asks `isDownloadFinished` and no downloader is active but a stale marker exists, the
answer includes `interrupted: true`, and the popup shows a "Download interrupted" notice
with a "Got it" button (`clearJobMarker`) instead of silently forgetting the download.
The marker degrades gracefully when `chrome.storage.session` is unavailable (older
Chrome). Covered by `scripts/e2e-worker.js` phase 6 (marker set/cleared during a real
job, stale-marker detection, dismissible notice) and marker assertions in
`scripts/e2e-offscreen.js`.

## Priority 5: product and UX

### 12. Reconcile README behavior with the implementation

- [x] The release README (`NHDW_Release_v3.0.0/README.md`) has been updated to accurately describe the popup, injected checkboxes, batch download workflow, Cloudflare mitigation, options, and offscreen document pipeline. The root `README.md` was already comprehensive.

**Progress:** DONE.

### 13. Improve progress and error reporting

- Show the current gallery and page number.
- Show retry attempts.
- Distinguish metadata failure, Cloudflare failure, image failure, ZIP failure, and cancellation.
- Report the number of successful and failed galleries at the end.

**Progress:** done. A batch gallery failure is now reported exactly once: the
`Downloader` surfaces its own failure through `errorCallback` and the batch loop
(`downloadAllDoujinshisAsync` in both the service-worker and offscreen paths) swallows
the subsequent re-throw instead of letting the outer catch re-report the same error.
A failing gallery no longer stops the batch: the loop continues with the remaining
galleries and tallies successes/failures. A `batchProgress` message is broadcast before
each gallery ("Gallery X of Y: Downloading <name>") and a `batchSummary` message
("X of Y galleries downloaded successfully") is sent at the end (both paths; offscreen
messages are marked `from:"offscreen"` so the service worker does not relay them back).
**Failure kinds are now distinguished** by `utils.classifyError` (`cancelled`,
`cloudflare`, `image`, `metadata`, `zip`, `unknown`): the popup labels every
`downloadError` with its kind, and the end-of-batch summary shows a per-kind
breakdown ("failed (Cloudflare: 1, image: 2)"). **Retry attempts are surfaced in the
UI**: each page retry emits a progress update with `retry "n/5"`, and the popup shows
"Retrying (n/5)..." under the progress bar. Covered by regression phases 3-5 in
`scripts/e2e-offscreen.js` and `scripts/e2e-worker.js` (exactly-once error, retry
messages, summary counts 1/1/2 with correct failedKinds) and 6 new `classifyError`
unit tests in `test/parsing.test.js`.

### 14. Make filenames safe and predictable

- Sanitize names consistently in single and multiple download modes.
- Avoid collisions between separate galleries.
- Add gallery ID to the default filename when titles are empty or duplicated.
- Test Unicode titles and reserved Windows filename characters.

**Progress:** mostly done. `utils.cleanName` now prefixes Windows reserved device names
(`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) with an underscore and falls back to
`"untitled"` (or `"gallery-<id>"` when a fallbackId is provided) when a title sanitizes
down to an empty string. The batch-download collision disambiguation now uses the gallery
ID as the disambiguating suffix instead of an arbitrary counter. Call sites in
popup.ts, background.ts, and offscreen.ts all pass the gallery ID. Covered by tests in
`test/parsing.test.js` (reserved names, empty fallback with and without fallbackId,
Unicode preservation).

### 15. Add cancellation that stops active work

- Abort outstanding `fetch` calls with `AbortController`.
- Stop queued galleries after cancellation.
- Avoid starting new image downloads after the user presses Cancel.
- Report partial-download behavior clearly.

**Progress:** DONE (code complete; pending real-browser confirmation).
`Downloader` now accepts an optional `AbortSignal` and passes it to every image
`fetch`; `goBack` aborts a per-job `AbortController` (in both the service-worker
fallback path and the offscreen document) so in-flight metadata, listing-page, and
image requests actually cancel instead of only setting the legacy `isAwaitingAbort`
flag. Aborted pages are no longer retried through the 5x/mirror fallback, queued
galleries stop when the loop unwinds, and a user cancellation is not surfaced as a
`downloadError` (the popup already resets its UI on Cancel). Covered by two new
fixture tests in `test/downloader.test.js` (in-flight abort and no-retry-after-abort).

## Security and maintenance

- Keep host permissions limited to the actual clearnet, image, and explicitly configured onion hosts.
- Never log cookies, Cloudflare clearance values, or authentication headers.
- Avoid accepting arbitrary URLs from page messages; validate gallery IDs and source hosts.
- Keep generated release JavaScript synchronized with the TypeScript source.
- Recheck Chrome and Brave MV3 API compatibility before each release.
- Review the project license and the target website's terms before distributing the extension.

## Suggested implementation order

1. ~~Deterministic tests and response validation~~ (done)
2. DOM-based result-page extraction
3. Selected-gallery queue
4. Active-context gallery resolver
5. ~~Large-ZIP/offscreen download architecture~~ (done)
6. README and UX reconciliation
7. Configurable source adapters
8. Optional onion source
9. Chrome/Brave/Tor compatibility matrix
