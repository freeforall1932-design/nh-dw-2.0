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
- [x] Fix the offscreen document for the API surface Chrome actually exposes there (only `chrome.runtime`): the document no longer touches `chrome.storage` / `chrome.downloads` / `chrome.scripting` (the old code crashed at load in real Chrome with `Cannot read properties of undefined (reading 'sync')` before its message listener registered, so every download failed with "Could not establish connection"). Settings are relayed in the download command, artifacts are saved by the service worker (`saveDownload`), and tab injections run in the worker (`fetchInTab` / `fetchUrlInTab`). Proven by `scripts/e2e-offscreen.js`, which now runs with no storage/downloads/scripting on the chrome stub at all.
- [x] Folder-of-images output option (Options → *Images in a folder (no zip)*): one file per page into `Downloads/<Title>/`, no archive. Same tab-first fetch + mirror fallback + validation as ZIP mode.
- [x] Stop the service worker from keeping message channels open for fire-and-forget messages (the "A listener indicated an asynchronous response by returning true, but the message channel closed" console noise): the listener now returns true only on branches that actually answer.
- [x] Batch metadata for unresolved gallery ids and listing-page fetches in `downloadAllPages` now go through the user's open nhentai tab session (via the worker relay) before falling back to the extension origin.
- [x] Narrow `web_accessible_resources` to the two toolbar icons on `https://nhentai.net/*` (was `*` on `<all_urls>`, exposing every bundled file to any page); guarded by a manifest test.
- [x] CDN configuration hardening (replace the hardcoded `i.nhentai.net`–`i4.nhentai.net` image hosts): the service worker now resolves `GET /api/v2/cdn` per session (source-tab session first, extension fetch second, short timeout, cached in memory + `chrome.storage.session` for one hour), validates every entry as a bare HTTPS `*.nhentai.net` origin, and merges the API order in front of the built-in fallback mirrors. `src/sources/cdnConfig.ts` is the single shared configuration for URL generation (`GallerySource.getImageUrls`) and allowed-image validation (`tabImageFetch.isAllowedImageUrl`), relayed to the offscreen document with each job's options. Hosts outside the static `host_permissions` are covered by `optional_host_permissions: ["https://*.nhentai.net/*"]`: jobs only use permitted hosts (so downloads never stall on CORS-blocked mirrors), and the popup shows a one-click *Grant image host access* notice (`getCdnStatus`) when nhentai reports a host the extension has not been granted yet. No `<all_urls>` anywhere; guarded by manifest and fixture tests (`test/cdn-config.test.js`, 22 cases).
- [x] PDF output format (replacing the retired images-folder mode) via a dependency-free PDF writer (`src/utils/pdfBuilder.ts`): RGB JPEGs embed verbatim (DCTDecode), other formats re-encode through an image canvas; delivered as `<title>.pdf`. Legacy `"folder"` settings map to `"pdf"` everywhere.
- [x] Archive naming/structure: single-gallery ZIP/CBZ/PDF named after the title with pages at the archive root (no `Title/Title` double folder); shared batch archives keep a folder per gallery; raw mode saves `Title/001.jpg`-style numbered pages inside a titled folder; last-mile filename sanitization stops Chrome from dropping names to blob-UUID/number fallbacks.
- [x] Two-column popup: current gallery (format picker + path + Download) on the left, similar-galleries selection panel (checkbox list + All/None + Download selected) on the right; the selected related galleries each download as their own titled archive (`separate: true` per-job override).

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
are last resorts, so a loaded gallery tab does not 403 before the popup can show Download. ZIP page
fetches now prefer the same open tab (`tabImageFetch` / `Downloader.sourceTabId`): the popup passes
the active tab id, the worker relays it to the offscreen document, and each image URL is requested
from the tab (isolated world first so CDN CORS cannot block host_permissions fetches, then MAIN
world) before an extension-origin `fetch`. Tab HTTP
errors skip the extension origin for that URL; CORS / injection failures fall through. HTML and
tiny bodies are still rejected. A blocked image run after successful metadata says so explicitly
("Gallery metadata was read; keep the gallery tab open…"). This is not a Cloudflare bypass: a
challenge interstitial still has no gallery JSON or image bytes. Extension/offscreen image and
batch metadata fetches also request credentials and have Cloudflare-aware error messages. The
`ApiParsing.GetJsonAsync` method now detects HTML content-type before attempting `response.json()`
and produces a clear "Cloudflare blocked" message for 403/503 responses and an "Unexpected response
type" message for 200 HTML pages. The batch download loops in both background.ts and offscreen.ts
distinguish Cloudflare errors (403/503 or HTML content-type) from plain HTTP errors and give the
user actionable guidance. The `isCloudflareResponse()` utility is exported from `ApiParsing.ts` for
reuse. Covered by fixture tests in `test/parsing.test.js` and tab-first image tests in
`test/downloader.test.js`. Retry backoff is now implemented: the Downloader retries page image
fetches with exponential backoff (base 200ms, growing to ~3.2s at the last retry) so repeated
failures don't hammer the server. The `retryBackoffMs` property is configurable. API metadata
parsing also checks response bodies for common Cloudflare challenge markers such as `cf-challenge`,
`cf_chl_`, `Just a moment...`, and `Checking your browser`, including 200 responses with misleading
or missing content types. IMPORTANT REAL-BROWSER FINDING (2026-08-20): the offscreen document
crashed at load in real Chrome because it called `chrome.storage.sync.get` at module top level —
per the Chrome docs only `chrome.runtime` is supported in offscreen documents, so the message
listener never registered and every download failed ("Could not establish connection. Receiving
end does not exist."). Fixed by moving settings reads to the service worker (relayed in the
download command), saving artifacts through the worker (`saveDownload` → `chrome.downloads`), and
performing tab injections in the worker (`fetchInTab` / `fetchUrlInTab`). The same fix lets batch
metadata and listing pages reuse the user tab's Cloudflare clearance. The sandbox harnesses had
hidden this by stubbing `chrome.storage` / `chrome.downloads` in the offscreen context;
`scripts/e2e-offscreen.js` now deliberately provides neither.

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

**Follow-up fix (false "Download interrupted" after a success):** the offscreen document
originally cleared the marker only on its 60s idle close, so for a full minute after a
successful download the popup misreported it as "interrupted" (and a batch between
galleries could look "finished" because `isDownloadFinished` was keyed off the
per-gallery `isDone()`). Now the offscreen document sends `jobFinished` when a job ends
and the worker clears the marker immediately; the offscreen `isDownloadFinished` answers
from a whole-job `jobRunning` flag; and the worker's offscreen-branch `isDownloadFinished`
clears the marker and answers `interrupted:false` whenever the live document reports the
job finished. A genuine interruption (document gone, marker still set) still answers
`interrupted:true`. Covered by `scripts/e2e-relay.js` (finished-vs-interrupted, `jobFinished`)
and `scripts/e2e-offscreen.js` (running flag, `jobFinished` sent).

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

### 16. Bucket list: popup format selection and PDF output

**16a. Choose the download format from the popup (same tab), not just the options page.**

**Progress:** implemented; needs real-browser verification.

The single-gallery popup has a ZIP / CBZ / PDF / raw picker in the left column of the
two-column layout (current gallery left, similar galleries right). Its selection is sent
as a validated one-job override through the service worker to the offscreen pipeline; it
does **not** overwrite the user's saved Options default. The relay e2e test verifies that
an override reaches the offscreen job options. The retired "images in a folder" format
was replaced by PDF (16b): legacy stored/relayed `"folder"` values map to `"pdf"`
everywhere (options select, popup pickers, format overrides, `Downloader` whitelist).

**16b. Add PDF as an output format.**

- Add a "Download as PDF" option alongside ZIP/CBZ/raw. — **Done.**
- Requires converting the fetched page images into a PDF inside the offscreen document,
  then saving through the existing `saveDownload` relay; the whitelist in
  `Downloader.startAsync` was extended (zip/cbz/pdf/raw), not bypassed. — **Done.**

**Progress:** implemented; needs real-browser verification.

`src/utils/pdfBuilder.ts` is a dependency-free PDF 1.4 writer: baseline/progressive RGB
JPEGs are embedded verbatim as DCTDecode XObjects at native size (dimensions parsed
from the SOF frame — `jpegInfo`), and grayscale/CMYK JPEGs plus PNG/GIF/WebP pages are
re-encoded to RGB JPEG through `createImageBitmap` + `OffscreenCanvas` where available
(offscreen document and MV3 worker both qualify; transparent areas flatten onto white).
Pages are collected in order during the fetch loop and assembled once at the end,
delivered as `<gallery title>.pdf` through the same object-URL/data-URL path as ZIP.
Covered by `test/pdf-builder.test.js` (frame parsing, structure, verbatim embedding,
xref offset verification) and PDF phases in the worker/offscreen e2e pipelines.

**Archive naming/structure hardening (same work item):** single-gallery ZIP/CBZ/PDF
files are named after the gallery with pages at the archive **root** — no more
`Title.zip` containing `Title/001.jpg`. Shared batch archives keep one folder per
gallery inside. Raw mode saves numbered pages (`001.jpg`, `002.png`, …) inside a folder
named after the gallery. A last-mile `sanitizeArtifactFilename` guard strips characters
that make Chrome silently drop the requested filename (which is how downloads could
land under blob-URL/number names). `separate: true` from the popup forces one archive
per gallery for the similar-gallery selection.

### 17. "More Like This" batch download

**Progress:** implemented; needs real-browser verification.

The popup's right column is a **similar-galleries panel**: *Show similar galleries*
fetches `GET /api/v2/galleries/{id}/related` once, then lists every related gallery
with a checkbox (title plus page count; untitled cards show `(Non-titled) #id` like
nhentai itself). **All/None** toggle the selection and **Download selected (n)**
downloads exactly the checked galleries — each as its own titled archive
(`separate: true`), using the same per-job format picker as the current gallery.

- An API key is optional; if the user has saved one it is attached to improve the
  endpoint rate limit, otherwise the public endpoint is used.
- The existing gallery tab is supplied to the batch pipeline for its normal
  tab-first metadata resolution. No tabs are opened or navigated automatically.
- Empty, malformed, and HTTP-error responses leave the panel with a clear error
  instead of starting a download.

**Remaining acceptance:** verify a real gallery in Chrome/Brave, including an
anonymous request, a key-authenticated request, an empty related list, unselecting
some entries, and an image/metadata failure within the related batch.

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

---

## Session log — 2026-08-26: optional API key mode, first-run gate, one-shot archives (PR #22)

### Improvements landed this session

1. **[x] Optional API key mode (official API contract).** nhentai's API v2
   documents API keys as the third-party auth method (`Authorization: Key
   YOUR_API_KEY`). The extension now sends it on `nhentai.net/api/` requests
   only (never CDN URLs), with 429 `Retry-After` backoff (clamped 0.25–15 s)
   and a best-effort descriptive `User-Agent`. Keyed metadata limits: 45/min
   vs 20/min per IP anonymous. Implemented in `src/utils/apiAuth.ts`
   (`fetchNhentaiApi`) and wired into the popup preview, the service-worker
   batch loop and the offscreen batch loop.

2. **[x] Two-mode boundary with a first-run gate.** Popup gate box:
   **Submit key** (API key mode) / **Continue without API key** (open tab
   mode, decision remembered). A mode badge shows which mode is active.
   Keyless mode is byte-for-byte the previous behavior; a failing keyed
   request always falls through to the keyless routes, so an invalid key can
   never break a download. Full boundary table in `SESSION_HANDOFF.md` and
   the release README.

3. **[x] One-shot server archive downloads (experimental, opt-in).**
   `POST /api/v2/galleries/<id>/download?format=zip|cbz` (keyed, returns
   `{ url, expires_at }`) — implemented against the live OpenAPI spec,
   opportunistic with automatic page-by-page fallback, and the delivery URL
   is fetched without the key. `src/background/ArchiveDownload.ts` +
   `Downloader.ts`.

4. **[x] Persistent API key storage (and the bug that threatened it).** Key,
   gate decision and archive toggle live in `chrome.storage.local` — they
   survive browser restarts and disabling/re-enabling the extension. Fixed
   `preview.ts` calling `chrome.storage.local.clear()` on every URL change
   (which would have wiped the key); replaced with a targeted
   `remove("allIds")` plus a regression guard asserting the popup bundle
   never contains `storage.local.clear()`.

5. **[x] Secret hygiene.** Key never in `chrome.storage.sync`, never to
   content scripts, never attached to non-API hosts, never sent to the
   archive delivery URL. Options page documents persistence and offers
   Clear key.

6. **[x] Version + tests.** Extension version 3.1.0 (both manifests + new
   version-sync test). Tests 83 → 109 passing; e2e phases 8–9 prove the mode
   boundary (keyed batch carries `Authorization: Key …`; keyless batch sends
   none).

### New backlog items

- **[ ] 16. Verification of API key mode + archive endpoint**
  (user side; browser steps in `SESSION_HANDOFF.md` work list). Open
  questions: does the account get a usable URL from `POST .../download`
  (`allow_downloads` feature flag / tier)? Confirm the keyed route wins in
  the service-worker console. The archive-availability half is now
  answerable headlessly: `NH_API_KEY=<key> npm run test:live` (keyed checks
  in `test/test.js`) reports AVAILABLE (200 + fetchable keyless URL + ZIP
  magic) or the gating reason, without a browser or the extension.
- **[ ] 17. Decide the fate of the archive toggle** based on item 16: keep
  or remove. Decision input: the user's `NH_API_KEY=... npm run test:live`
  output line ("archive endpoint AVAILABLE ..." vs a gating reason). Until
  then the toggle stays opt-in with automatic page-by-page fallback, and
  the options text is plain-language (no "experimental programmer speak").
- **[ ] 18. Optional: sync the API key across the user's own devices.**
  Currently deliberately `chrome.storage.local`-only; changing to
  `chrome.storage.sync` requires an explicit user decision (secret syncing).
- **[ ] 19. Optional: force the descriptive `User-Agent`** via a
  `declarativeNetRequest` rule (fetch() forbids it in some contexts).
  Deferred: adds a new install-time permission for a courtesy header.

### Integration on top of PR #21 (merged into this PR before merge)

Main advanced while PR #22 was open (PRs #18–#21: queue controls, pause/resume,
popup split + similar galleries, title-named flat archives, PDF output
replacing folder mode, CDN configuration hardening). PR #22 was merged with
`origin/main` and re-validated as one tree:

- Kept PR #21's verified key flow (options **Save & verify** via
  `GET /api/v2/user`, `test/api-key.test.js`) and combined it with the gate:
  saving a key withdraws any "continue without API key" decision, removing
  the key re-arms the gate.
- Archive endpoint guard extended for PR #21's archive layouts: a server
  archive is only delivered when this gallery owns the whole archive (never
  mid-shared-batch, checked via zip contents), so shared batch archives keep
  every gallery.
- Offscreen API-surface rule preserved: the Downloader never touches
  `chrome.storage` in the relayed-settings branch; the worker attaches
  `apiKey`/`useServerArchive` to `gallerySettings` and single-download
  settings instead (e2e-offscreen "chrome.runtime only" check passes).
- Worker single-download path relays stored `useZip`/`maxConcurrentDownloads`
  together with the API fields so raw/PDF/CBZ formats stay correct.
- e2e-worker phases renumbered: CDN hardening stays phase 8; keyed batch is
  phase 9, keyless-no-Authorization is phase 10.
- Result: **149 passing / 1 pending** (123 from main + 26 from PR #22), all
  smoke + e2e suites green, release `js/` in sync.
- **[ ] 20. Settings inside the popup (two tabs: Download | Settings).**
  Opening a new tab/page just to change a setting is inconvenient; the user
  wants settings editable on the fly from the toolbar popup. Design sketch:
  - `index.html` gains a tab bar above the `action` container: **Download**
    (everything the popup renders today — preview, batch list, progress) and
    **Settings** (the same controls as `options.html`).
  - Reuse the option widgets (`Select`/`CheckBox`/`InputField`, the API key
    verify flow from `src/options/apiKey.ts`, the template checkboxes from
    `src/options/nameTemplate.ts`, the archive toggle) by rendering them into
    the Settings tab from shared code — do NOT duplicate the logic.
  - Storage is unchanged: `chrome.storage.sync` for shared preferences,
    `chrome.storage.local` for the key + archive toggle (the popup has
    storage access; the offscreen document does not and stays untouched).
  - Keep `options.html` as the full-page fallback (deep links, browsers
    without the popup context).
  - Dark mode must style the tab bar; progress messages while a download
    runs should still be visible regardless of the active tab.
