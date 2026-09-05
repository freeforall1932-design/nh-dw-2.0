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
- [x] Raw-mode failures never render `Error: [object Object]` (3.6.1): the browser's object `lastError` was stringified at the worker, wrapped in an `Error`, then stringified again by the raw catch. Every boundary (worker reply, downloadControl interrupted/start errors, offscreen `saveViaServiceWorker`/`awaitDownloadViaServiceWorker`, and the stale Firefox snapshot) is now message-first — `.message` is unwrapped and shapeless objects fall back to readable text. Regression unit tests + an e2e phase with an Error-instance answer.
- [x] 2026-09-05 codebase-review backlog, **items 28–34**: all closed.
  28–32 and 34 in 3.6.2/3.6.3 (batch metadata validation, popup Go Back
  always, sanitized history names, merged ignore no longer drops titles,
  console `errorMessage()` sweep, shared storage-free batch core); **33** in
  3.6.4 — `resolveJobFormat(override, stored)` in `src/utils/downloadFormats.ts`
  is now the only place a job's format is decided. The live gap it closed:
  `resolveMergedBatchName` computed its disk candidates from the raw request
  (`formatOverride || "zip"`), so a merged job with no explicit override
  looked for `.zip` while the artifact is `.cbz`/`.pdf` — the "you already
  have this file" warning could never match and re-runs grew `_partN`
  forever. Full specs in the session log at the end of this file.
- [x] Fix `downloadAllPages`: stop mutating `pagesArr` while iterating so the final ZIP is actually downloaded
- [x] Remove dangling `web_accessible_resources` entries (`js/jszip/...`, `js/FileSaver.js/...`) from the release manifest
- [x] Add window-less service-worker tests (`scripts/smoke-mv3.js`, `scripts/e2e-worker.js`): load the built worker in a no-`window` VM context and drive ZIP, raw, and error paths through `chrome.downloads` with zero network access
- [x] Replace the base64 ZIP download path: downloads now run in an MV3 offscreen document (`src/offscreen/offscreen.ts` + `offscreen.html`) that delivers the archive through a real `URL.createObjectURL`; the in-worker base64 path remains only as a fallback for browsers without `chrome.offscreen`. The service worker relays commands (`scripts/e2e-relay.js` verifies relay, idle-close, and no message loops).
- [x] Include the MV3 `offscreen` permission in both source and release manifests so real Chrome/Brave expose `chrome.offscreen` and use the intended object-URL ZIP path.
- [x] Replace the live-only API test with deterministic fixture tests: `test/parsing.test.js` (API/HTML parsers incl. `\u0022` embeds, malformed/Cloudflare HTML rejection, filename utils) and `test/downloader.test.js` (image URL order and CDN fallback, ZIP entry names and original-page bytes, raw mode, object-URL delivery). The live nhentai check is opt-in behind `RUN_LIVE_TESTS=1` (`npm run test:live`).
- [~] Chrome and Brave end-to-end download test: the automated real-browser suite exists (`scripts/e2e-browser.js`, runnable via `npm run test:browser`) and its harness plumbing was validated live; executing the suite itself in an unrestricted environment is still pending (see item 10). The real-browser CI jobs were removed (landed 2026-09-01 via the web UI — GitHub Actions runners cannot launch the MV3 harness), leaving only the offline suites in CI, which pass (`extension-tests.yml`, first run green).
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
- [x] Persistent download history (3.5.0): re-running a listing (search / tag / artist / homepage) skips galleries that already downloaded successfully instead of re-downloading them and uniquifying into `Title (1).zip`. `chrome.storage.local` keyed by gallery ID; recorded on successful completion only (separate mode per gallery; a merged job records all of its ids only when the whole job succeeded; partial galleries never recorded). UI pre-check in the popup (✓ badge + filename, per-row *Download anyway*, live "N selected · M already downloaded · K will download" counts) and the in-page bar (per-card *Downloaded* labels with *Download again?* confirmation, bulk *Include already downloaded*); an authoritative offscreen/worker guard relays the recorded IDs with each job so nothing slips through and skipped ids cost zero API calls. *Clear history* in popup Settings and the options page. No export/import, no new permissions; offscreen still uses `chrome.runtime` only.
- [x] Verify-before-skip + merged naming (3.5.0 follow-up, user decisions): separate-mode skipping is *verify-then-redownload* behind a Settings toggle (default ON) — a recorded gallery is skipped only when `chrome.downloads.search` confirms the file still exists, deleted files re-download automatically, OFF = record-only skip. Merged mode never skips, but an existing merged file warns first and proceeds on confirmation (`{result:"existing"}` ↔ `existingConfirmed`, both pipelines, UI confirms and re-sends). Merged/batch names get `_DDMMYYYY` (`batchNameDate`, default ON, no double stamp), history records the dated name, and the same title+date again becomes `_part2`, `_part3`… with verify deciding reuse (deleted file's name reused) vs growth; multi-page merges keep the part number on the base before the ` (lastPage)` marker. `chrome.downloads.search` is worker-only (`src/utils/downloadVerify.ts`, never imported by offscreen); unit + e2e coverage (phases 5f–5h).
- [x] Named failures + Retry, raw completion tracking (3.6.0): every failed gallery is reported by id + name + reason (single-title `downloadError`, `batchSummary.failedGalleries`, and a session-persistent `#failedNotice` backed by `chrome.storage.session` via the worker); **Retry failed** re-sends exactly those titles with the job's own settings as separate files past the history guard (`src/utils/failedGalleries.ts`); *Dismiss* forgets, a later success drops the id. Raw mode no longer treats "download started" as "page saved": `src/background/downloadControl.ts` follows each `chrome.downloads` item to `complete`/`interrupted` (`onChanged` + `search` poll, 4-minute cap, offscreen relay in 45 s slices), so an interrupted page is retried and a gallery with a missing page fails by name instead of being recorded; raw has its own in-flight cap (`rawMaxConcurrent`, default 3). Contexts without `onChanged` keep the old semantics. Covered by `test/download-control.test.js`, new raw cases in `test/downloader.test.js`, and new e2e phases in all three harnesses.
- ✅ **Work-list status — 3.5.0 done (2026-09-04).** Both items above are implemented, reviewed and shipped together from `arena/01a06b6f-nh-dw-2-0` (commits `57c5a87`, `8fde409`, `7d429c5`) and merged into `main` by a merge-commit PR. Verification at merge time: webpack build + `tsc` test config clean, `npm test` 233 passing / 4 pending, smoke 7 PASS, `npm run test:e2e` 73 PASS / 0 FAIL, and the push-triggered `extension-tests` GitHub Action green on the same offline suites (build → unit → smoke → e2e). No new permissions, offscreen document still uses `chrome.runtime` only; known limits (local-only history starting empty; `chrome.downloads.search` sees profile-downloaded files only) are documented in README and SESSION_HANDOFF.

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
the ZIP on disk (nhentai.net is simulated locally, see the script header).

**CI resolution (decided 2026-08-28, landed 2026-09-01):** the real-Google-Chrome and
real-Brave jobs in `.github/workflows/e2e-browser.yml` failed on **every** run since they
were added (Chrome `Runtime.enable` timeout, Brave SIGTRAP before a DevTools port opens) —
GitHub Actions runners cannot launch the MV3 extension harness, regardless of code changes.
They were removed via the GitHub web UI (workflow files cannot be pushed with the sandbox
token) and replaced by `.github/workflows/extension-tests.yml`, whose first run on `main`
was **green** (~1m: webpack build + 163 mocha fixtures + smoke + window-less VM e2e). The
real-browser suite remains available locally via `npm run test:browser` on a machine with a
full Chrome/Brave build. Do not re-add real-browser CI jobs.

Environment note (why it is still `[~]` rather than `[x]`): the development sandbox could not
execute the suite itself —
1. its network egress is limited to the npm registry and github.com (nhentai.net, Debian
   mirrors, storage.googleapis.com, and GitHub release assets are all unreachable), and
2. the only browser binary obtainable through those channels, `@sparticuz/chromium`, is a
   serverless build with extension support compiled out (verified: even a minimal MV3 test
   extension produces no service worker target).

What was verified in the sandbox: the harness's riskiest plumbing — the local HTTPS
nhentai.net fixture, `--host-resolver-rules` remapping, and the certificate bypass — works in
headless Chromium (the browser loaded the fixture page at `https://nhentai.net/`). To close
this item, run `npm run test:browser` on a machine with Chrome and/or Brave installed
(prefixed with `sudo` so the fixture can bind port 443).

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

**3.6.0 addendum — failures are named and retryable.** The 3.5.0-era summary
still said only "2 galleries failed" and offered no way back. Both pipelines
now attach `failedGalleries: [{id, name, error}]` and a `retryJob` to
`batchSummary`, and `galleryId/galleryName/retryJob` to single-title
`downloadError`; the popup lists the names with per-title reasons and a
*Retry failed (N)* button, and a persistent notice above the preview keeps the
list for the browser session (worker-owned `chrome.storage.session`, see
`src/utils/failedGalleries.ts`). Raw mode's "complete with a page missing"
false positive (the download callback fires at item creation, not at file
write) is closed by `src/background/downloadControl.ts` — see the 3.6.0 entry
under "Current status" and `SESSION_HANDOFF.md`.

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
- **[x] 20. Settings inside the popup (two tabs: Download | Settings).**
  DONE (3.2.0): `index.html` has a tab bar; the Settings tab
  (`src/preview/popupSettings.ts`) renders the API key section (paste-aware
  input, Save & verify via the documented `/api/v2/user` check, Remove key,
  saved-state status line) and the file-name template checkboxes with a live
  "Example file name" preview, reusing `options/apiKey.ts` and
  `options/nameTemplate.ts` so behaviour is identical to the full options
  page, which stays as the fallback.
- **[x] 21. Fix blob artifacts saving under a UUID instead of the gallery
  title (3.2.1).** On some Chromium builds `chrome.downloads.download`
  ignores its `filename` argument for `blob:` URLs, so the ZIP/CBZ/PDF landed
  with the blob's UUID even though the content was correct (ruled out IDM:
  the UUID appeared with download managers disabled). Fix: the offscreen
  document now saves blob artifacts through a same-context anchor whose
  `download` attribute carries the name — the standard HTML5 mechanism, which
  the browser itself honors. Non-blob artifacts (raw-mode CDN URLs) still go
  through the worker relay. `e2e-offscreen` gained a DOM stub that captures
  the clicked anchor and asserts the requested URL + filename for the ZIP,
  tab-ZIP, separate-files, relayed-CDN and PDF phases. `test/artifact-name.
  test.js` pins the name-generation validity for realistic titles.
  CAVEAT / real-browser check still needed: an offscreen document is a hidden
  page; if a browser build blocks programmatic downloads from it, the anchor
  click would be a silent no-op (no file). The code falls back to the worker
  relay on DOM errors, but not on a silent no-op. Confirm a real download
  lands with the correct title right after loading 3.2.1; if nothing lands,
  revert to the worker relay for blobs.

---

## Session log — 2026-09-01: CI retired to offline suites, docs synchronized

### Improvements landed since the 2026-08-26 entry (backfill)

- **[x] 22. Hotfix 3.1.1 (PR #25, 2026-08-27):** remove the invalid
  `permissions` entry from the manifest permission list that made the
  extension fail to load at all.
- **[x] 23. Mojibake in UI strings (PR #28, 2026-08-28, version 3.2.2):**
  charset declarations plus ASCII-safe text so popup/options strings stop
  rendering as garbled characters.
- **[x] 24. Retire the real-browser CI jobs (PR #29 docs + web-UI workflow
  commits + PR #30, 2026-09-01):** `.github/workflows/e2e-browser.yml`
  deleted and `.github/workflows/extension-tests.yml` added via the GitHub
  web UI (the sandbox token cannot write workflow files); first
  `extension-tests` run on `main` **green** (~1m). `SESSION_HANDOFF.md`,
  this backlog, and the README now all describe the same setup: CI = offline
  suites only; real-browser verification = local `npm run test:browser`.
- **[x] 25. Raw master folder (this branch, version 3.3.0):** raw-mode pages
  now land in `Downloads/NHDW/<Title>/001.jpg…` — the per-gallery titled
  folder grouped under one configurable master folder so hundreds of titles
  stay tidy. New `rawMasterFolder` option (chrome.storage.sync; **empty
  string disables**; slashes nest deeper; user input sanitized per path
  segment by the existing `sanitizeArtifactFilename`). Relayed to the
  offscreen document through the relayed settings bag (no chrome.storage
  offscreen — invariant kept); worker contexts read storage directly when
  the bag omits it. Covered by 3 new mocha cases (default/custom/empty/
  sanitize) and e2e-worker phase 2 (on) / phase 3 (off).

### State as of this entry

- Version **3.3.0** on this branch (raw master folder); `main` is 3.2.2 until
  the merge. Source + release manifests in sync.
- Tests: **166 passing / 4 pending** mocha fixtures (was 149/1 in the
  2026-08-26 entry); all smoke + window-less VM e2e suites green; release
  `js/` in sync with source.
- Workflows on `main`: only `extension-tests.yml`. The historical
  `browser-e2e` failures (100% failure rate across every branch) are gone
  from new pushes; pushes that touch the extension dirs now produce one
  green check.

### Still pending (unchanged worklist, details in SESSION_HANDOFF.md)

- **[ ] 16. Server-archive availability probe** — user runs
  `NH_API_KEY=<key> npm run test:live` (headless) — then
- **[ ] 17. keep-or-remove decision for the `useServerArchive` toggle.**
- **[ ] Real-browser verification batch:** item 10 (`npm run test:browser`
  with a full Chrome/Brave build → flip item 10 `[~]`→`[x]`), the item-21
  caveat (real blob save lands title-named), the 3.2.2 string spot-check,
  the keyed-route-wins check in the worker console, and the 3.3.0 step
  (raw master folder ON → `Downloads/NHDW/<Title>/001…`, OFF → `<Title>/`).
- **[ ] 26. Optional: master folder for single-file archives** (ZIP/CBZ/PDF
  save one file per gallery into the download-folder root today; same
  prefixing trick would apply — user decision whether archives should also
  group under `NHDW/`).
- **[ ] 18/19 optional:** API key via `chrome.storage.sync` (user decision),
  `declarativeNetRequest` User-Agent (deferred — extra permission).
- **[ ] Product backlog:** restart-safe resume; search/favorites/blacklist/
  comments UI; PDF cover/bookmarks niceties.

---

## Session log — 2026-09-03: Firefox port scoped (item 27 added)

### New backlog item

- **[ ] 27. Port the extension to Firefox.** Working folder:
  `NHDW_Firefox_v1.0.0/` (working copy of `NHDW_Extension_v3.0.0`, created
  2026-09-03). Verdict: **feasible with targeted changes**; the code already
  contains the main architectural fallback needed (see facts below).
  Evidence + required-change list: `NHDW_Firefox_v1.0.0/PORTING_AUDIT.md`.

### Facts found by the audit (each with evidence)

1. **`chrome.offscreen` does not exist in Firefox** (Chromium-only API).
   The code gates on it: `USE_OFFSCREEN` (background.ts:627) — in Firefox
   the existing full worker-fallback path runs instead
   (`background.ts:~1052`, "Fallback path for browsers without
   chrome.offscreen": downloadDoujinshi / downloadAllDoujinshis /
   downloadAllPages / goBack / updateProgress / isDownloadFinished).
   Therefore no offscreen re-architecture is required for the port;
   `js/offscreen.js` + `offscreen.html` simply stay unused in the Firefox
   package.
2. **Firefox MV3 has no `background.service_worker`** (MDN manifest
   background docs; bugzilla 1573659). Firefox runs `background.scripts` as
   an event page (document context), and from Firefox 121 it starts that
   page even when the manifest also carries `service_worker` (bug
   1860304). Required manifest change: `"background": {"scripts":
   ["js/background.js"]}`. The bundle is context-safe: grep shows no
   `window.`/`document.` references in background code (deliberate — the
   MV3 service-worker rewrite removed them), so the same bundle runs in a
   document context.
3. **Artifact delivery already feature-detects.** Downloader.ts:388-404:
   uses `URL.createObjectURL` when present, else base64 data URL. In the
   Firefox event-page (document) context `createObjectURL` exists, so the
   blob-object-URL path is used. Firefox's `downloads.download` accepts
   `blob:` URLs created in an extension background context (bugzilla
   1696174 workaround; MDN "Work with files" documents
   `URL.createObjectURL` for downloads). Data-URL download support is the
   historical weak spot (bug 1622986) — the base64 path should not be the
   primary FF delivery; runtime-verify blob naming in a real Firefox.
4. **Parity gaps in the non-offscreen fallback:** `pause`/`resume`/
   `clearQueue` are answered only on the offscreen branch
   (background.ts:976-982, relayed to offscreen.ts:653-666). The fallback
   branch has no handlers for them, so in Firefox those popup queue
   controls would be silent no-ops. Also `queued` + `position` responses
   exist only in the relayed (`startRelayedJob`) path; the fallback answers
   `{ result: "started" }`. Port work must add these to the fallback path
   (or route through a Firefox helper page).
5. **`scripting.executeScript` `world: "MAIN"` is Firefox 128+** (bugzilla
   1736575, landed FF128; Mozilla blog 2024-07-10). Code injects ISOLATED
   first and MAIN as fallback (tabImageFetch.ts:206-216); injection
   failures fall through to the extension-origin fetch. Target Firefox 128+
   (`strict_min_version: "128.0"`).
6. **`optional_host_permissions` is Firefox 128+** (bugzilla 1766026; MDN
   optional_permissions note). Manifest already uses the key; the popup
   grant flow uses the permissions API. Also Firefox ≤126 did not grant
   MV3 `host_permissions` at install and ≤126 host-permission semantics
   differed (Extension Workshop migration guide) — another reason for the
   Firefox 128 minimum.
7. **`storage.session` is Firefox 115+** (bugzilla 1823713). Code uses it
   for the CDN-config cache and the job marker and already degrades when
   the area is unavailable — no change needed.
8. **API style is portable as-is.** grep found no promise-only
   `chrome.*` calls (no `await chrome.x` / `chrome.x(...).then`): every
   call is callback-style, fire-and-forget, or wrapped in a dual
   callback/promise adapter. Firefox's `chrome` namespace with callbacks is
   therefore sufficient; `webextension-polyfill` is not required for this
   codebase.
9. **Permissions:** the `offscreen` permission name is unknown to Firefox
   and must be removed from the Firefox manifest. Remaining set
   (downloads/tabs/storage/alarms/scripting) is Firefox-valid.
10. **Tests/CI:** offline suites are browser-free (VM chrome stubs) so they
    run unchanged; `test/manifest.test.js` reads `../../NHDW_Release_v3.0.0`
    (repo-root relative) and must be repointed for the new folder.
    `.github/workflows/extension-tests.yml` triggers do not include
    `NHDW_Firefox_v1.0.0/**` — extend when port code lands.
    `scripts/e2e-browser.js` is Chrome-CDP-specific; a real-Firefox check
    needs a manual pass or a Marionette/BiDi harness (out of scope for this
    item's first step).

### Work order (as recorded in SESSION_HANDOFF.md worklist)

1. Firefox manifest (`background.scripts`; drop `offscreen`; add gecko id +
   strict_min_version 128.0; draft at
   `NHDW_Firefox_v1.0.0/manifest.firefox.json`).
2. Close fallback-path parity gaps (pause/resume/clearQueue + queue
   position answers).
3. Repoint test paths; extend CI trigger paths.
4. `web-ext lint`; temporary load via `about:debugging`.
5. Real-browser pass: blob download filename, queue controls, batch +
   similar galleries, PDF, raw + master folder, CDN optional-host grant
   flow, tab-first fetch under Firefox.
6. AMO distribution decision separately (store policy is outside this
   repo audit).

---

## Session log — 2026-09-04: list-mode parity, side panel, in-page card controls (3.4.0)

### The report this session answers

Verbatim from the user: single-title pages "can do 4 zip cbz pdf and raw", but
"when I go to homepage or search or any artist or genre it's all about the list
with a default of zip and the naming system is the website url itself"; the
folder naming "work just like the other but I want that to be optional"; "I
don't like the extension pop up is hovering with no flexibility to be hovered
elsewhere because my other repo we have side panel instead of pop up"; and
"can you make a feature to have download and or select button around the post
when I'm in list mode". The stated must-haves were the format choice and the
separate-file option; everything else was explicitly optional.

### Root causes found

1. **List mode was ZIP-only** because the listing panel never rendered a format
   picker; the only format input was the stored `useZip`, and the popup's own
   `formatOverride` was sent from the single-title branch only.
2. **List files were named after the page URL** because list mode could only do
   the *merged* output, whose archive name is `finalName` — and `finalName` was
   derived in `Popup.updatePreviewAll` from `self.url`. The per-gallery template
   path already existed but was reachable only through the
   `downloadSeparately` option, which no list UI exposed.
3. **`separate` was a one-way switch.** `background.ts` had
   `if (relayedMessage.separate) options.downloadSeparately = true;` — an
   explicit `false` was indistinguishable from "not specified", so a UI whose
   default is separate could never ask for a merge.
4. **Separate-mode names skipped `cleanName`.** `zipName = title` (raw title)
   in both `background.ts` and `offscreen.ts`, while single-title downloads used
   the cleaned path. `replaceSpaces` therefore silently did not apply to batch
   output.
5. **The folder wrap was raw-only and forced.** `rawMasterFolder` defaulted to
   `NHDW` with no per-job switch, and archives had no equivalent at all.

### Landed

| Area | Change |
|---|---|
| Shared registry | New `src/utils/downloadFormats.ts`: formats, labels, `normalizeFormat` (incl. the retired `folder -> pdf` map), extensions, output mode, `effectiveOutputMode`, `outputModeToSeparate`, `shouldWarnPdfMerge`, list-template inheritance sentinel, list-mode storage defaults. Imported by the panel, the content script, the options page, the worker and the offscreen document. |
| List settings | New `src/utils/listSettings.ts` (`buildListSettings` is a pure, unit-tested mapper). Keys: `listFormat`, `listOutputMode`, `listMasterFolder`, `listDownloadName`. |
| Panel | `Popup.updatePreviewAll` now renders `message.listDownloadOptions()`: format picker, output picker, optional master-folder checkbox, merged-archive name row (only in batch mode) and a live resolved-filename preview. Both entry points (**Download selected** and **Download all (N pages)**) share one `buildJobOptions()` so neither can skip the merge guard. |
| Pipeline | Per-job relay options extended with `nameTemplate` -> `options.downloadName`, `masterFolder` -> `options.rawMasterFolder` + `options.archiveMasterFolder`, and an explicit `separate` (true AND false). Same overrides applied on the non-offscreen fallback path via `jobOverridesFromRequest()`. |
| Downloader | New `archiveMasterFolder` setting applied in `#downloadBlob` (the single funnel for server archives, zip/cbz and pdf) through `#archiveArtifactName()`; `normalizeArchiveMasterFolder` defaults to `""` so single-title behaviour is unchanged. |
| PDF guard | `src/preview/pdfMergeWarning.ts` modal, safe path focused, dismissal scoped to `pdf + batch + >1 title` and only recorded when the user proceeds. Stacks after the existing page-count confirmation. |
| Side panel | `sidePanel` permission + `side_panel.default_path`. `uiMode` setting, applied by the worker with `setPanelBehavior` + `action.setPopup`. Same document for both. `preview.ts` re-bootstraps on tab change and drops the fixed popup width in panel mode. |
| In-page controls | `src/content/listControls.ts` + `css/content.css`. Per-card Download/Select, floating bar, idempotent MutationObserver injection, shared `allIds` selection, `sender.tab.id` fallback in the worker, `inPageControls` toggle, legacy checkbox hidden via `.nhdw-legacy-check`. |

### Deliberate non-goals this session

- **P3 queue UI with thumbnails** — specified in the worklist, not implemented.
  The blocker is structural, not cosmetic: the queue currently lives entirely
  inside the offscreen document (`queuedJobs`) and is only surfaced as a count.
  A per-item UI needs the worker to mirror the queue into
  `chrome.storage.session` (worker-restart safe) with per-item state, and the
  offscreen document to report `queued -> fetching metadata -> downloading
  (x/y) -> packaging -> done/failed` transitions instead of one global
  progress number.
- **Raw remains labelled "(testing)"** until a real browser confirms the folder
  creation end to end.
- **Firefox port** untouched; `chrome.sidePanel` has no Firefox equivalent
  (`sidebar_action` is the analogue) and the new content script must be added
  to that manifest.

### Backlog items closed

- **26. Master folder for single-file archives** — done (`archiveMasterFolder`,
  driven by the list-mode checkbox; off by default for single titles).

### Follow-up — 2026-09-04: workflow trigger paths (manual commit owed)

The 3.4.0 push initially carried a widened `on.push.paths` for
`.github/workflows/extension-tests.yml`. The remote rejected it: the GitHub App
an agent session pushes as has no `workflows` permission, and the rejection
takes the entire push with it, so the hunk was reverted and PR #33 went out
without it.

Workflow files in this repo are, and always have been, a **manual commit**. The
complete intended file now lives at
`NHDW_Extension_v3.0.0/ci/pending-workflows/extension-tests.yml`, with the
rationale, the one-hunk diff and the apply/verify steps in
`NHDW_Extension_v3.0.0/ci/README.md` and a pending-table row in
`SESSION_HANDOFF.md`.

Why it is worth applying: `on.push.paths` covers only `NHDW_Release_v3.0.0/**`
and the extension's `scripts/`, `test/` and `src/` subtrees, so a commit
touching only `manifest.json`, `index.html`, `options.html`, `css/**`,
`webpack.config.js` or the tsconfigs never triggers CI — and `manifest.json`
plus `css/**` are exactly where the 3.4.0 side-panel registration and card
styling live. `test/manifest.test.js` would never run against a manifest-only
regression.

## Session log — 2026-09-04: onDeterminingFilename cross-extension audit (3.4.1)

**Symptom (user, multi-extension Chrome profile):**

```
This extension failed to name the download "Kodomo_Idol.pdf"
because another extension determined a different filename ""
```

The extension Chrome blamed was a downloader for a different site. Question
put to this audit: does *this* extension leak filename authority outside its
own domain?

**Verdict: LEAK CONFIRMED, fixed.** Not a hypothetical — the 3.3.1 guard
registered `chrome.downloads.onDeterminingFilename` during service-worker
module evaluation and never removed it.

Why that is a defect even though the listener never renamed a foreign file:
the event is a profile-wide naming decision. Registering it makes the
extension a participant for every download in the browser. `host_permissions`
and content-script `matches` do not scope it, and returning early for a
foreign item does not withdraw participation — which is precisely what lets
Chrome name an extension in the error above.

**Every registration and removal site (before → after):**

| Location | Before | After |
| --- | --- | --- |
| `src/background/background.ts:30` `installDownloadFilenameGuard()` | added the naming listener at module eval, permanently | installs only the `onChanged` bookkeeping listener; re-attaches naming **only** if the session mirror shows work in flight |
| `src/background/downloadNaming.ts` `attachListener()` | did not exist | called from `recordDownloadRequest` when pending goes 0 → 1 |
| `src/background/downloadNaming.ts` `detachListener()` | did not exist | called from `syncListener()` whenever pending reaches 0 |

**Every `chrome.downloads.download` / filename-construction path reviewed:**

| Path | Filename built by | Cleanup added |
| --- | --- | --- |
| `Downloader.ts:439` raw CDN pages + blob artifacts | `sanitizeArtifactFilename` + `#archiveArtifactName` (master folder) | `discardDownloadRequest(url)` when `downloadId === undefined` |
| `background.ts:940` `saveDownload` relay from the offscreen document | name supplied by the offscreen packer | `discardDownloadRequest(url)` when `downloadId === undefined` |
| `background.ts` `recordDownloadName` relay (offscreen anchor saves) | offscreen packer; never reaches `downloads.download` | covered by TTL + FIFO |

**Drain paths now covered:** suggestion consumed, `onChanged` → `complete`,
`onChanged` → `interrupted`/cancelled, failed download creation, 30-minute
per-entry TTL, 600-entry FIFO eviction, and `resetTrackedNamesForTests`.

**Invariants enforced:** `suggest()` is called exactly once per event; a
foreign or unknown item always gets a bare `suggest()`; `""` is never
suggested and never stored (empty names are rejected at record time).

**Product behaviour preserved unchanged:** master folder, per-title raw
folders, single-title and list-mode templates, archive names, blob/data URL
handling, `conflictAction: "uniquify"`, and the offscreen relay.

**Tests:** `test/download-naming.test.js` gained a `global listener lifetime`
block asserting listener presence/absence directly rather than only checking
that foreign names survive — a permanently registered listener passes the
latter while still being the bug. `scripts/smoke-mv3.js` asserts the shipped
bundle registers zero naming listeners at load, for every worker variant.

**Session mirror** moved to `{ v: 2, pending: {url: {filename, at}}, idToUrl,
order }`, still reading the legacy `{ byId, byUrl }` shape.

**Not cleared:** `NHDW_Firefox_v1.0.0` still ships the 3.3.1 guard in its built
`js/background.js`. Firefox does not implement the event so it is inert, but
that port received no independent audit. No other repository was examined.

**Unrelated issues checked and found clean during the sweep:** object URLs are
revoked by the `revoke` closure returned alongside each one; manifest
permissions (`downloads`, `tabs`, `storage`, `alarms`, `scripting`,
`offscreen`, `sidePanel`) all correspond to live API use; host permissions
remain the six nhentai origins with no `<all_urls>`; web-accessible resources
stay scoped to `https://nhentai.net/*`.

### Open questions carried out of 3.4.1 (for whoever picks this up next)

None of these block the release; each is a judgement call that a reviewer
should either accept or overturn.

| # | Question | Why it is open | Where to resolve it |
| --- | --- | --- | --- |
| A | Is one mis-named file per service-worker restart acceptable? | The naming listener re-attaches only after an async `storage.session` read. Registering synchronously at startup would reintroduce the leak, so the race is deliberate. | Real-browser step 0E |
| B | Is a 30-minute entry TTL right? | Too short loses the name on a very slow gallery; too long keeps the global listener attached on a stuck entry. The value was never measured. | Time the slowest realistic gallery |
| C | Can listener participation be observed more strongly than `hasListeners()`? | Chrome exposes no API for "who is in the naming chain", so verification proves our own state only. | Research / accept |
| D | URL-keyed pending map assumes one artifact per URL | True today for CDN page URLs and blob URLs; a future change that reuses a URL across concurrent jobs would cross names. | Guard only if that design appears |
| E | Does raw actually create one folder per title? | Never confirmed in a browser; still ships behind the "(testing)" label. | Real-browser step 0f |
| F | Does Download All walk every page of a paginated listing, and does the 2-page warning fire? | Asserted by e2e stubs only. | Real-browser steps |
| G | Is the user's original cross-extension naming clash gone? | Two independent fixes (shared list pipeline + non-participating idle guard) are expected to close it, but they have never been observed together on a real profile. | Real-browser steps 0A/0D |
| H | Should `@types/chrome` be unpinned from 0.0.154 (2021)? | `chrome.sidePanel` and `chrome.storage.session` are both reached via `(chrome as any)`. A bump restores type safety but risks unrelated type churn. | Dependency decision |

Also still open and unchanged: **P3 queue UI** (thumbnails, per-item progress
and states, cancel/retry, concurrency limit, retry-with-backoff),
**`NHDW_Firefox_v1.0.0`** (lags at 3.3.1, still carries the old guard in its
built worker, never audited), and the fact that **`npm run test:browser` has
never run in this environment** — every real-browser claim in these documents
is an expectation, not an observation. No other repository was audited.


## Session log — 2026-09-05: post-3.6.1 codebase review; backlog items 28–34 added

### Context

User asked (a) to delete `new 19.txt` (a Chrome `chrome://extensions` error
page for a v3.4.1 raw-mode failure, byte-identical hash to
`NHDW_Extension_v3.0.0/js/offscreen.js` @ `7aa438e`) and (b) to review the
whole codebase after the 3.6.0 rewrite ("2 sessions ago", PR #35/#36).
Deletion: commit `83a13b7`, open as PR #37. Review: full reads of
`downloadControl.ts`, `failedGalleries.ts`, `downloadHistory.ts`,
`downloadVerify.ts`, `Downloader.ts`, `background.ts`, `offscreen.ts`,
`popup.ts`, `message.ts`, parsers, list-controls payloads, plus a
whitespace-normalized diff of the twin `downloadAllDoujinshisAsync` loops and
a 3.4.1-vs-current popup comparison. Verification re-run on the clean tree:
webpack rebuild byte-identical to committed/release `js/`; **258 unit passing
/ 4 pending; smoke 7 PASS; e2e all PASS** (incl. the raw-interrupted→retry,
defective→named-failure and no-`[object Object]` phases).

### Verdict

The 3.6.0/3.6.1 rewrite is a real fix, well tested, and the shipped package
matches the source. It is **not** garbage code, and 3.6.1 needed no follow-up
source change. The review did find four concrete defects (M1–M3, L1) and three
hardening/structural items (L2–L4), recorded below as items 28–34. Suggested
fix order: 28 first, then 29/30/31, then 32/33/34.

### Found clean (no action)

Raw completion tracking + `rawMaxConcurrent` cap + abort-cancels-loose-pages;
failed-gallery session store (serialized read-modify-write, 200 cap, dedupe,
drop-on-success); the retry round-trip end to end (popup →
`groupRetryMessages` → worker → offscreen → `jobFinished` records → history);
history/verify semantics incl. merged naming (date stamp, `_partN`, verify
decides reuse vs growth); `onDeterminingFilename` guard lifetime;
sanitize/cleanName and raw master-folder parity; PDF-merge guard; CDN
config/optional-host flow; manifest permissions; build reproducibility.

### New backlog items

- **[x] 28. Batch metadata must be validated as a gallery before use (M1,
  high).** DONE in 3.6.2 (`requireGallery` after every metadata route in both
  pipelines; worker e2e phase 11). Original symptom: a metadata route that returns 200 with non-gallery JSON
  (`{}`, `{error:...}`) crashes at `json.title.pretty` **outside** the
  metadata try/catch, rejecting the entire `downloadAllDoujinshisAsync`:
  remaining titles are skipped, no `batchSummary` is sent, failures are never
  remembered for Retry, and the popup shows a dead-end error (item 29).
  Evidence: worker `background.ts:648` (try) then `:657` (unguarded deref);
  offscreen `offscreen.ts:596` then `:614` (offscreen already has a partial
  HTML second-chance parse and still derefs unguarded). `ApiParsing.GetJsonAsync`
  returns non-gallery JSON as-is (`coerceGallery(parsed) || parsed`), so this
  does not throw inside the parser. Fix: after each metadata route, require
  `looksLikeGallery(json)` (already imported in offscreen; add to the worker);
  on failure do exactly what the metadata-parse catch does —
  `countFailure(key, error)`, named `errorCallback`, `continue`. Regression
  test: a batch whose one gallery resolves to `{}` must keep going, report
  that gallery by name, list it in the summary, and record nothing for it.
  Also review batch-level `.catch` so it never ends without a summary/back
  (see item 29).

- **[x] 29. Popup error screen must always offer an action (M2, medium).**
  DONE in 3.6.2 (Go Back always rendered + wired; `test/message.test.js`).
  Original symptom: `message.downloadError(error, galleryName?, canRetry)` renders Go
  Back / Retry only when `canRetry` (`src/preview/message.ts:264-279`), and
  the popup wires buttons only for retryable errors (`popup.ts`). Batch-level
  errors carry no `galleryId` (top-level `.catch` in `downloadAllDoujinshis`/
  `downloadAllPages`, "Unable to start the offscreen download document."),
  so the panel is left with **zero buttons** until reopened. Pre-3.6.0 had the
  same quirk, but the rewrite made batch-level failures more common (item 28
  and relay-start failures). Fix: always render a Go Back button; keep Retry
  only when retryable. Test in e2e/popup-stub: a `downloadError` without
  `galleryId` leaves a clickable Go Back.

- **[x] 30. History records must use the sanitized on-disk name (M3,
  medium).** DONE in 3.6.2 (`artifactName.ts` + `artifactRecordFilename`
  sanitizes). Original symptom: every save is sanitized (`sanitizeArtifactFilename`;
  the raw path also strips `\:*?"<>|` from the folder), but history records
  are built from the unsanitized inputs, so "verify before skip"
  (`chrome.downloads.search` on the recorded filename) can never match and the
  gallery re-downloads on every listing run with `(1)`/`(2)` uniquify growth.
  Triggers: a custom `rawMasterFolder`/`archiveMasterFolder` or name that
  sanitizes (contains `:`, trailing dot/space, control chars, >120-char
  segments). Evidence: records at `background.ts:388,708`,
  `offscreen.ts:382,660` via `artifactRecordFilename`; sanitize at save in
  `Downloader.ts` (`#saveArtifact`, raw branch). Fix: one shared helper that
  produces the final artifact-relative path (sanitize each segment, then
  `artifactRecordFilename`) and use it on both the save path and the record
  path so they can never disagree. Test: a master folder with `:`/trailing
  space and an over-length segment records exactly the filename the disk
  verify would search.

- **[x] 31. Merged jobs must not silently drop duplicate-titled galleries
  under "ignore" (L1, medium).** DONE in 3.6.2 (merged id-suffixes; separate
  counts `skipped`; worker e2e 12a/12b). Original symptom: with `duplicateBehaviour =
  "ignore"`, two *different* galleries sharing one title inside a merged
  (batch) job cause the second to be skipped by an uncounted `continue`
  (`background.ts:661`, `offscreen.ts:618`); if a later gallery is the final
  saver, the job is marked clean and the whole title set is recorded even
  though the archive misses that gallery. Separate mode has the same
  uncounted drop in the summary totals. Fix (decide + implement): merged mode
  must never drop silently — force the deterministic id-suffixed rename
  (`title (id)`, as the rename branch already does) or count the drop as a
  failure/skip and refuse to record the job as clean; make every drop visible
  in the summary counts in both modes. Tests: merged two-gallery job with
  duplicate titles under "ignore" and under "rename".

- **[x] 32. Deduplicate the twin worker/offscreen batch pipelines (L2,
  structural).** DONE in 3.6.3 (`src/utils/batchPipeline.ts`: storage-free
  `runBatchDownload` / `runPagedBatchDownload` / `resolveGalleryMetadata`
  with injected IO; worker `makeFallbackBatchHost` + offscreen
  `makeOffscreenBatchHost`). The core never imports `chrome.storage` /
  `chrome.downloads`. Unify on keyed API first → richer `getGalleryViaTab`
  → tab fetch → `fetchImpl` with `Authorization` iff `apiKey`; HTML
  second-chance on a once-read body; keyed `{}` fails that gallery only.
  Worker `downloadAllPages` now remembers `failedGalleries` like
  `downloadAllDoujinshis`. Tests: `test/batch-pipeline.test.js`.

- **[x] 33. Fallback-path format must not silently default to zip (L3, low).**
  DONE in 3.6.4 — see the session log at the end of this file.
  In the no-offscreen fallback the batch record/retry format is
  `normalizeFormat(options.useZip ?? "zip", "zip")` while each Downloader
  reads the *stored* format when no per-job override is present — so a caller
  that omits `formatOverride` would get records saying `.zip` while the file
  is `.cbz`/`.pdf`/raw. All current callers send `formatOverride`, so this is
  theoretical today. Fix: resolve the effective format once at job start
  (per-job override → stored default) and use that everywhere records, retry
  jobs and Downloader settings are built; add a unit test that the record
  format always equals the Downloader's resolved format.

- **[x] 34. Message-first sweep for remaining console paths (L4, cosmetic).**
  DONE in 3.6.2. Downloader retry / server-archive `console.warn` use
  `errorMessage()`.

### Also noticed (no new item — already tracked)

The Firefox snapshot's `manifest.json` still reports 3.3.1 even though its
content received the 3.6.1 error-parity backports and its suite passes (166 /
4 pending); tracked under structural open question 9 and backlog item 27
(Firefox port). PR #37 (deletion + these doc updates) is open awaiting merge.
error-parity backports and its suite passes (166 /
4 pending); tracked under structural open question 9 and backlog item 27
(Firefox port). PR #37 (deletion + these doc updates) is merged.

---

## Session log — 2026-09-05: 3.6.2 review follow-up (items 28–31, 34)

Follow-up session `arena/01a06fb0-nh-dw-2-0` after PR #37. Landed the
concrete bugs from the rewrite audit; left the structural twin-pipeline
dedupe (32) and the theoretical fallback-format default (33) for later.

| Item | Change |
| --- | --- |
| 28 | `requireGallery()` after every metadata route in worker + offscreen |
| 29 | `message.downloadError` always has Go Back; popup always wires it |
| 30 | shared `sanitizeArtifactFilename` in `utils/artifactName.ts`; records use it |
| 31 | merged "ignore" id-suffixes; separate "ignore" counts `skipped` |
| 34 | Downloader console.warn → `errorMessage()` |

Version 3.6.2 in source + release manifests. New tests: parsing
`requireGallery`, download-history sanitized records, `test/message.test.js`,
worker e2e 11/12, offscreen equivalents. Verification: webpack clean,
`npm test` **261 passing / 4 pending**, smoke 7 PASS, `npm run test:e2e` all
PASS; source `js/` byte-identical to release `js/`.

---

## Session log — 2026-09-05: 3.6.3 shared batch pipeline (item 32)

Follow-up session `arena/01a06fb0-nh-dw-2-0` after 3.6.2. Extracted one
storage-free batch core so worker fallback and offscreen cannot drift again.
Item **33** (fallback-path format default) is deliberately not in this drop.

| Area | Change |
| --- | --- |
| Core | `src/utils/batchPipeline.ts`: `runBatchDownload`, `runPagedBatchDownload`, `resolveGalleryMetadata`, `getGalleryViaTab`, `tryParseGalleryText`, `buildRetryJob`. Host injects parsing/abort/sendMessage/fetchUrlFromTab/fetchImpl/newZip/downloadGallery. No `chrome.storage` / `chrome.downloads`. |
| Routes | pre-resolved → keyed API first → richer `getGalleryViaTab` (`parsing.GetUrl`, clearnet api/gallery/page) → `fetchUrlFromTab(parsing.GetUrl)` then `fetchImpl` with `Authorization: Key` iff `apiKey`. Keyed `{}` → `requireGallery` throw → `countFailure`. HTML second-chance on the once-read body (replayable Response). |
| Worker | `makeFallbackBatchHost` + `resolveWorkerBatchOptions` then core. `rememberFailedGalleries` on both `downloadAllDoujinshis` and `downloadAllPages`. |
| Offscreen | `makeOffscreenBatchHost` (`saveUrl=saveArtifactSmart`, extras `{from:"offscreen", queued}`). History via `collectHistoryRecords`. Idle/queue/pause/save-via-worker unchanged. |
| Tests | `test/batch-pipeline.test.js` (keyed auth, keyless no auth, HTML second-chance, fail-one, merged/separate ignore, history skip, extras, paged listing + aggregated paged failures). |

Version 3.6.3 in source + release manifests. Verification: webpack clean,
`npm test` **277 passing / 4 pending**, smoke 7 PASS, `npm run test:e2e` all
PASS; source `js/` byte-identical to release `js/`.

---

## Session log — 2026-09-05: 3.6.4 one format decision per job (item 33)

Session `arena/01a0701c-nh-dw-2-0`, from `main` `08148a6` (PR #38, the
3.6.2/3.6.3 merge). Last open item from the 2026-09-05 review.

### What was actually still broken

The item described the record/retry format diverging from the Downloader's in
the no-offscreen fallback. Auditing every resolution site showed 3.6.3 had
already closed that half: `resolveWorkerBatchOptions` fills `useZip` from
`chrome.storage.sync` before the shared core runs, and both the record
(`normalizeFormat(resolved.useZip)`) and the Downloader settings
(`gallerySettings.useZip`) come from that same value; the offscreen side does
the same with the relayed `jobOptions`. The single-title fallback record was
also already safe — it reads `downloader.useZip` *after* `startAsync()`.

The live gap was a third consumer nobody had listed:
`resolveMergedBatchName` resolved the format from the **raw request**
(`normalizeFormat(relayedMessage.formatOverride || "zip")`) while the artifact
is named from the job's resolved format. A merged job with no explicit
`formatOverride` and a stored default of cbz/pdf therefore computed `.zip`
candidates, so:

- `presentBatchFilenames` never saw the real `.cbz` on disk → the *you already
  have this file* warning could not fire;
- `pickFreeBatchFilename` never saw the history record either (records use the
  real format) → every re-run grew another `_partN`.

Latent rather than live-in-production only because every current UI caller
(popup, list panel, in-page card controls, retry jobs) sends `formatOverride`.
Proven by test: reverting just that one expression makes the new worker e2e
phase 5j fail with `warn-first must match the real cbz artifact, got
{"result":"started"}`.

### The fix

| Area | Change |
| --- | --- |
| Registry | `src/utils/downloadFormats.ts`: `resolveJobFormat(override, stored)` (override → stored → zip) and `normalizeFormatOverride` moved here from `background.ts` (the second copy of the same rule is gone). |
| Worker single-title | `downloadDoujinshi` resolves the format in its existing `chrome.storage.sync.get` (`useZip` added to the defaults) and **always** sets `settings.useZip` plus both concurrency caps, so the Downloader never takes its own storage-read branch and record/retry/file agree by construction. |
| Relay | `startRelayedJob` sets `options.useZip = resolveJobFormat(formatOverride, stored)` unconditionally — the offscreen document has no `chrome.storage`, so it must always be handed a concrete format. |
| Merged naming | `resolveMergedBatchName(relayedMessage, confirmExisting, jobFormat?)` uses the job's resolved format, or resolves override → stored `useZip` → zip itself; the storage read moved above the early `raw`/separate bail-out. Fixes both fallback call sites, which pass no `jobFormat`. |
| Batch core | `batchPipeline.ts` resolves once and passes the **normalized** format down (`gallerySettings.useZip = format`), so normalization happens once instead of again inside every Downloader; `buildRetryJob` and the paged path use the same helper. |
| Offscreen single-title | one `jobFormat` used for the Downloader settings, the history record and the retry job. |

### Tests

- `test/list-mode.test.js` — 5 cases: override wins, stored fallback (incl.
  unrecognized override must not become zip), legacy `"folder"` on both sides,
  zip last resort, `normalizeFormatOverride` keeps unusable values out.
- `test/batch-pipeline.test.js` — new `job format contract (item 33)` block:
  for zip / cbz / pdf / raw / legacy `folder` / no-format-sent, the history
  record suffix, `gallerySettings.useZip` and `batchSummary.retryJob.formatOverride`
  must all be the same resolved value (7 cases).
- `scripts/e2e-worker.js` — phase 5i (stored `cbz` and stored legacy `folder`
  with **no** `formatOverride`: artifact and record both `.cbz` / both `.pdf`)
  and phase 5j (merged job, no override: artifact, record and the warn-first
  `existing` answer all use `Downloads/MergedStored.cbz`). 5j is the real
  regression test; 5i is a pinning test (it passes on the pre-fix code, which
  was already correct for single-title records).

### Verification

webpack clean; `tsc -p tsconfig.json` and `tsconfig.test.json` clean;
`npm test` **289 passing / 4 pending** (was 277/4 — +12 new cases); smoke
**7 PASS**; `npm run test:e2e` all PASS incl. the two new worker phases;
source `js/` byte-identical to `NHDW_Release_v3.0.0/js/`; manifests 3.6.4 in
source + release.

### Not in this drop

P3 queue UI, the raw retry-policy follow-ups, the raw list-mode
`(testing)` label (needs a real browser), the Firefox port, and every
real-browser verification step. No behaviour change was made that a real
browser could contradict offline: with a `formatOverride` present (every
current caller) the resolved format is identical to before.
