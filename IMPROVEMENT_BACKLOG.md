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
  **Correction (3.6.4): that sweep stopped short of the batch-level catch.**
  `downloadAllDoujinshis` / `downloadAllPages` in both pipelines still did
  `errorCallback(String(error))`, so an object-shaped batch failure rendered
  `[object Object]` in the popup — reproduced on the pre-fix bundle by worker
  e2e phase 12c, which reports `got "[object Object]"`. Fixed in 3.6.4
  together with `askOffscreen`'s failure replies, the popup preview
  `statusText`, `apiKey.ts` verification failures and `message.downloadError`.
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

**Progress:** complete — but **not** the way the plan below describes, and the
text here was stale until the 2026-09-05 review corrected it.

`src/preview/selectedGalleryResolver.ts` resolves every selected ID through
**the tab the user is already on** (`fetchGalleryViaTab(sourceTabId, id)`,
sequential, one at a time) and returns only the IDs that pass
`looksLikeGallery`. It **never opens, navigates or closes a tab**: there is no
`chrome.tabs.create` or `chrome.tabs.remove` anywhere in `src/` (verified by
grep on 2026-09-05). A missing ID is simply left out of the map; the batch
pipeline makes its own tab-scoped attempt for that gallery and reports a
metadata failure if the session cannot supply it. With no source tab the
resolver returns an empty map rather than falling back to opening one.

`test/resolver.test.js` asserts exactly that, including
*'resolves selected galleries through the supplied tab without creating or
navigating tabs'* and *'does not try to create a fallback tab when no source
tab was supplied'*. Real Chrome/Brave confirmation remains covered by item 10.

The original proposal (kept for history — **superseded**, do not implement it):

1. Open one temporary gallery tab at a time, or use a small bounded queue.
2. Wait for the gallery page to load.
3. Extract the page's gallery object in the main world.
4. Close the temporary tab.
5. Pass validated metadata to the downloader.

Do not open dozens of tabs, and do not claim that this bypasses Cloudflare.

**Acceptance criteria:** selected result-page galleries can be resolved when they are accessible in the user's browser, with clear failure handling when Cloudflare blocks them.

## Priority 3: optional Tor/onion source

### 8. Add configurable source adapters

**Progress:** complete for the supported clearnet source. The `GallerySource` interface and source registry centralize host matching, gallery/API URLs, and image CDN fallback URLs. `ApiParsing`, `HtmlParsing`, `Downloader`, the popup, the selected-gallery resolver (same-tab; see item 7), and the service-worker icon path use the adapter; parsers and the downloader accept an injectable source. Onion support is intentionally dropped under item 9.

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
  `errorMessage()`. **Reopened and finished in 3.6.4:** the item was scoped to
  the console, which left the *user-facing* batch-level catch un-swept — the
  same `[object Object]` the whole 3.6.1 entry exists to remove. See the
  3.6.4 session log.

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

### Self-review after the change (same session)

Reviewing the diff for collateral damage found a **live bug that two previous
sessions' claims said was already gone**:

- 3.6.1 says raw failures no longer render `Error: [object Object]`; item 34
  (3.6.2) says the message-first sweep is done. Both were scoped too narrowly.
  The **batch-level `.catch`** — the outermost user-facing error path in
  `background.ts` (`downloadAllDoujinshis`, `downloadAllPages`) and
  `offscreen.ts` (both equivalents) — still did `errorCallback(String(error))`,
  and `askOffscreen`'s two failure replies did `error: String(error)`, which
  the relay renders as the popup's `downloadError`.
- **Reproduced, not assumed.** New worker e2e phase 12c throws from
  `chrome.runtime.sendMessage` during `batchProgress` so the batch pipeline
  rejects at top level. On the pre-fix bundle the assertion fails with
  `got "[object Object]"` — the exact string from the original 3.6.1 user
  report. Post-fix both an object shape and an `Error` instance arrive as
  their message alone (no `Error: ` prefix).
- Same pass, lower reach: `popup.ts` preview `statusText` (2 sites),
  `options/apiKey.ts` verification failure, `message.downloadError`'s own
  render. `errorMessage()` already existed and was already imported in both
  bundles. Deliberately left alone: `utils.ts` inside `errorMessage` (the
  documented shapeless-object fallback, now pinned by a test) and the two
  guarded `.message` reads.
- **Alignment fixes** the review also caught: `resolveWorkerBatchOptions`
  passed the raw stored `useZip` (a legacy `"folder"` travelled unnormalized),
  and three consumers re-derived the format with `normalizeFormat` instead of
  the new resolver (single-title retry job, single-title record, fallback
  batch record). All five now go through `resolveJobFormat`.

### Verification

webpack clean; `tsc -p tsconfig.json` and `tsconfig.test.json` clean;
`npm test` **291 passing / 4 pending** (was 277/4 — +14 new cases); smoke
**7 PASS**; `npm run test:e2e` all PASS incl. worker phases 5i, 5j and 12c;
source `js/` byte-identical to `NHDW_Release_v3.0.0/js/`; manifests 3.6.4 in
source + release.

### Not in this drop

P3 queue UI, the raw retry-policy follow-ups, the raw list-mode
`(testing)` label (needs a real browser), the Firefox port, and every
real-browser verification step. No behaviour change was made that a real
browser could contradict offline: with a `formatOverride` present (every
current caller) the resolved format is identical to before.

### Addendum — popup harness + Firefox error parity (same session)

- **`scripts/e2e-popup.js` (new, in `npm run test:e2e`):** window-less coverage
  of the panel's message -> UI layer, which previously had none offline. Five
  phases: object-shaped `downloadError` renders its message; batch-level error
  keeps Go Back (item 29); summary names failures with `Retry failed (N)`;
  Retry re-sends the failed ids and a refused retry restores the failed notice
  (fails pre-fix with `got hidden=true`); Dismiss forgets. Does not bootstrap
  a listing page.
- **Found and fixed by it:** `popup.ts` stringified `request.error` before
  `message.downloadError` — the last hop, defeating the message-first rule even
  though `message.ts` handles objects. Latent, now pinned by phase 1.
- **`NHDW_Firefox_v1.0.0`:** all ten user-facing `String(error)` sites now use
  `errorMessage()` (added to its `utils/utils.ts` verbatim). Suite: 166
  passing / 4 pending, smoke 5 PASS, e2e exit 0, plus a backported worker
  phase 11 that fails pre-backport with `got "[object Object]"`. Still 3.3.1
  and still missing 3.4.0+ work (item 27).

### Addendum — review pass 4: the settings pane (same session)

- **Fixed: opening the Settings tab rewrote the name template.**
  `popupSettings.ts` saved on first paint; `buildTemplate` canonicalises order
  and separator, so `"{id} - {pretty}"` became `"{pretty} - {id}"` with no user
  action. Now only a checkbox change writes. Pinned by `e2e-popup.js` phase 6
  (fails pre-fix) and phase 7 (an explicit tick still saves).
- **Fixed: the panels showed a list format that was not in use.** The
  `listFormat` inheritance chain (`listFormat` -> `useZip` -> zip) is now one
  helper, `resolveListFormat()` in `downloadFormats.ts`, used by
  `buildListSettings`, `listControls.ts`, `popupSettings.ts` and `options.ts`;
  both panels no longer pass `listFormat: "zip"` as a storage default, which is
  what hid "never set". 5 new fixtures + phase 8 (fails with `got zip` on a
  bundle with only that fix reverted).
- **Fixed: `options.ts` wrote the template back on every page open**
  (`saveTemplate(storedTemplate)` -> `renderTemplatePreview`).
- **`e2e-popup.js` grew what it needed to render the settings pane:**
  `classList.toggle`, a stateful `chrome.storage.sync` with a write log, and
  `.id` assignment registering a `createElement` node with `getElementById`
  (last write wins). Without the last one, `popupSettings` reads back fresh
  unchecked boxes instead of the ones it just built.
- **Backported to `NHDW_Firefox_v1.0.0`:** the same `persist` fix and the
  options preview/save split. No list mode there, so no inheritance fix. No
  panel harness in that tree — the backport is build-verified and
  suite-verified (166 passing / 4 pending), not behaviour-verified.
- **`test/download-verify.test.js` (new, 10 tests, added to the mocha list):**
  pins the tail-anchored `chrome.downloads` filename regex and the
  "cannot verify -> never block" rule. Note that `package.json`'s `test`
  script lists mocha files explicitly, so a new fixture file runs nothing
  until it is added there.

## New backlog items — review passes 2026-09-05 (items 35-41)

Items 35 and 36 are done in this session and are recorded for traceability;
37-41 are the honest remainder. Everything here came out of the four review
passes (self-review, older-version audit, list-mode/retry audit, settings-pane
audit), not from a user report.

- **[x] 35. Settings pane: three real defects (pass 4, high).** DONE
  2026-09-05.
  (a) `popupSettings.ts` saved the file-name template on first paint, and
  `buildTemplate()` canonicalises order and separator, so opening the Settings
  tab silently rewrote `"{id} - {pretty}"` to `"{pretty} - {id}"`
  (`isTokenOnlyTemplate` accepts it because the leftover `" - "` matches its
  separator class). Fixed: `renderNamePreview(persist)`, first paint passes
  `false`.
  (b) The documented list-format inheritance (`listFormat` -> `useZip` -> zip)
  was dead in **every** path: `LIST_MODE_DEFAULTS` carried `listFormat: "zip"`
  and is spread into the storage defaults of both runtime readers
  (`listSettings.SYNC_DEFAULTS`, `listControls.readSettings`), and each panel
  passed the same default itself, so an unset key always arrived as `"zip"`.
  Everything resolved ZIP consistently and the inheritance comment on
  `buildListSettings` was dead code. Fixed: `resolveListFormat()` in
  `downloadFormats.ts` at all four call sites, the `listFormat` default dropped
  from both panels **and from `LIST_MODE_DEFAULTS`**. The panels-only first
  half of this fix was caught incomplete by the pre-merge review: it would have
  shown CBZ in the panel for a job that still downloaded ZIP.
  (c) `options.ts` ended `initNameTemplate` with `saveTemplate(storedTemplate)`
  - a write on every page open, firing `storage.onChanged` for a value nobody
  changed. Fixed: preview/save split.
  Tests: `e2e-popup.js` phases 6-8 (6 and 8 both fail on the respective pre-fix
  bundles), the `e2e-list-controls.js` inheritance phase (fails with
  `must inherit cbz, got ..."formatOverride":"zip"` when the default is
  restored), and 19 fixtures in `test/list-mode.test.js` - including 4 that
  drive the real `readListSettings` through a `chrome.storage` stub which
  merges stored values over the caller's defaults, the way Chrome does.

- **[x] 36. `downloadVerify.ts` had zero tests (pass 4, medium).** DONE
  2026-09-05 - `test/download-verify.test.js`, 10 tests. It is worker-only by
  design (the offscreen document must never touch `chrome.downloads`), which is
  why it stayed invisible: nothing in the offline suites loaded it.
  Mutation-checked: removing the `(?:^|[\\/])` anchor fails the
  lookalike-parent test.

- **[ ] 37. Firefox panel harness (blocks clearing the Firefox folder).**
  `NHDW_Firefox_v1.0.0/` has no offline coverage of its popup or Settings pane,
  so the pass-4 fixes backported there are build- and suite-verified only.
  Port `scripts/e2e-popup.js` - the DOM/chrome stub is reusable verbatim, and
  the three traps documented in its header (two `onMessage` listeners,
  `apiKeyGate` in `storage.local`, `.id` registration for `createElement`
  nodes) apply unchanged. Wire into its `npm run test:e2e`. Small job; the
  value is that the next backport can be proven, not just compiled.

- **[x] 38. Options-page harness — approved Firefox scope completed 2026-09-21.**
  `scripts/e2e-options.js` executes the built options bundle against real
  `options.html`, including actual select lists/index/value, key-scoped async
  storage, read-only initialization, explicit edits, naming previews, local
  credentials and history. 33 tests; 8 fail against the pre-fix bundle. Added
  to `test:e2e` and focused `test:options`. Only Firefox options production
  code changed by this task; Chrome coverage/fixes were not approved. See the
  session log below and item 59 for the adjacent shared-reader issue.

- **[x] 39. Empty-token separators (LANDED 2026-09-23).**
  `cleanEmptyDelimiters()` added in `src/utils/utils.ts` and called at the end
  of `getDownloadName()`. Collapses dangling separators (e.g. `Pretty||` ->
  `Pretty`, `123456 - Pretty - ` -> `123456 - Pretty`, `Pretty - - 123456` ->
  `Pretty - 123456`, and removes empty brackets `[]` / `()`). Pinned and tested
  in `test/parsing.test.js` across Chrome and Firefox. Also updated example
  file name preview sample tags so settings preview accurately reflects
  individual token toggling.

- **[ ] 40. Popup harness: listing-page bootstrap.** The harness proves the
  panel's message -> UI and storage contracts; it does not build a listing
  page, so the panel's list-job, PDF-merge-warning and similar-galleries paths
  remain covered only by the content-script phases. Extending it means
  stubbing listing injection and `activeTabGallery` - a real piece of work,
  worth doing only if those paths change again. Item 59 directly delivers
  `getGalleries` for format rendering; that partial check does not close 40.

- **[ ] 41. Non-canonical separators are canonicalised on the first tick (UX
  decision).** `isTokenOnlyTemplate("{pretty}_{id}")` is `true`, so the panel
  offers checkboxes, and the first tick writes `buildTemplate(checked)` =
  `"{pretty} - {id}"`. Pass 4 removed the *silent* rewrite on open; this one is
  at least the result of a deliberate click, but the user still loses their
  separator. Suggested: add `isCanonicalTemplate()` (tokens in
  `TEMPLATE_TOKENS` order joined by exactly `" - "`) and route anything else to
  the manual input, the way a truly custom template already is. Affects both
  trees.

### Worries that are not items (recorded so they are not re-litigated)

- **The popup harness is a hand-rolled DOM.** It proves contracts, not
  rendering: layout, focus, `hidden` CSS and Chrome's real listener ordering
  are still real-browser-only.
- **Historical panel-read coverage gap, partly closed offline.** Item 59
  now asserts that saved list formats are read and survive reopen/reload in
  the Firefox panels and card/bar controls. The broader real-browser reload
  instruction and unrelated preference readers still need device coverage;
  the VM tests are not that evidence.
- **`chrome.downloads` assumptions are unobserved.** That `filenameRegex`
  matches Windows backslash paths, and that a deleted file reports
  `exists === false` rather than an absent field. Both failure modes are safe
  (re-download) but silently slower.
- **The inherited list format is a behaviour change.** A user who set `useZip`
  to CBZ/PDF/raw and never touched list mode now gets that format from listing
  pages too, where they previously got ZIP. Documented intent, not yet
  confirmed with the user.
- **Do not "fix" the panels by persisting the inherited format on render.**
  Showing CBZ while `listFormat` is empty is correct: storing it would freeze
  list mode against later single-title changes.
- **Do not put `listFormat` back into `LIST_MODE_DEFAULTS`.** Those defaults
  are spread into `chrome.storage.get` calls, and a value there makes "never
  set" indistinguishable from "chose zip", killing the inheritance again. A
  fixture asserts the key is absent.
- **A display fix is not a fix until every reader of the same storage agrees.**
  `grep -rn LIST_MODE_DEFAULTS src/` was the entire check that caught the
  incomplete half of item 35.

## Session log — 2026-09-08: bookmark queue (3.7.0), items 42–46 added

### Context and goal

Session `arena/01a07d48-nh-dw-2-0`. The user asked for a **bookmark queue**
modelled on the sibling `freeforall1932-design/twitter-batch-download`
extension's side-panel queue, but different in the way that matters: a list
built by **hand** (click a ☆) rather than auto-collected while scrolling, which
**survives a browser close and a PC restart**, shows the card's **cover
thumbnail**, minimises into a **dock**, accepts **pasted ids or links** for
single or batch download, and can be downloaded from **in batch or one at a
time**. Reference UI: `https://cin.lat/bulk?id=366224,177013`, minus that site's
"View Online" button.

This closes the long-carried **P3 queue UI** item *for the bookmark half only*.
The structural blocker recorded in the 2026-09-04 log — "the queue lives
entirely inside the offscreen document (`queuedJobs`) and is only surfaced as a
count" — is **still true of the download job queue** and is now item **45**.
What changed is that there is a second, persistent list which does not have that
problem, because it was never a job queue.

### Correction recorded (a premise I misread)

The user's statement that the toolbar click "is still pop up first instead of
queue sidebar/side panel" was about the **Twitter repo**, not this one, and it
is **correct there**: `twitter-batch-download/extension/manifest.json` sets
`action.default_popup: popup.html` and has **no** `setPanelBehavior` anywhere;
`popup.html` is a pure launcher ("Everything now lives in the Side Panel queue")
whose single button calls `chrome.sidePanel.open({ windowId })` at
`popup.js:37`. This repo has defaulted to the side panel since 3.4.0
(`background.ts:71`), so the two repos start from opposite places.

The design consequence, and why the Twitter shape was **not** copied wholesale:
that repo's popup had nothing left to do, so hollowing it into a launcher was
free. This repo's popup is the primary UI for single-title and list-mode
downloads. It stays functional; the launcher button was added to the **Queue tab
header** (hidden when the document already is the panel) with the Settings copy
kept. Full reasoning in `BOOKMARK_QUEUE_PLAN.md` §3.

### Landed

New: `src/utils/bookmarkQueue.ts` (pure core), `src/background/bookmarkService.ts`
(worker as single writer), `src/preview/bookmarkPanel.ts` (Queue tab),
`test/bookmark-queue.test.js` (51 cases), `BOOKMARK_QUEUE_PLAN.md`.
Changed: `src/preview/activeTabGallery.ts` (`getActiveNhentaiTabId`),
`src/content/listControls.ts` (☆ + `autoCaptureCards` + paint overlay),
`src/background/background.ts` (routing + two bookkeeping hooks),
`src/preview/popupSettings.ts`, `index.html`, both CSS files, `README.md`,
version 3.6.4 → **3.7.0** in both manifests, `NHDW_Release_v3.0.0` re-synced.

### The review this session ran on its own output

Standing rule now recorded in `SESSION_HANDOFF.md`: **review the previous
session's diff before building**, hunting for missing logic (a handler with no
caller, a setting with no reader, a notice that promises what the code never
does), misaligned code (a guard in one path but not its sibling), and broken
code (a state read that clobbers a concurrent write). Six defects found, each
with a test failing on the pre-fix build:

1. **Unguarded tab id.** `enrichBookmarks` used `getActiveTabId()`; the Queue tab
   can be open on any website and `fetchGalleryViaTab` injects into whatever tab
   it is handed. → `getActiveNhentaiTabId()`, used by enrichment *and* the
   Queue's `startDownload`.
2. **Reconcile race.** `mutateBookmarks(() => capturedSnapshot)` clobbered
   concurrent mutations. → applied as a function of the freshly-read state.
3. **Dead auto-capture on an open page.** It lived inside the idempotent
   `injectCardControls`, which skips decorated cards, so flipping the setting
   bookmarked nothing — the exact case its `sync.onChanged` listener existed
   for. → own pass.
4. **Optimistic paint wiped by a re-read.** Star state shared a `Set` that
   `readBookmarkState()` clears, so a sweep re-sent already-queued cards. →
   `bookmarkOverlay` cleared only by the storage-change event. **Found by a test
   that failed first.**
5. **A notice that lied.** "Resolving titles…" never corrected itself when no
   nhentai tab existed. → `{ resolved, skipped }` reported truthfully.
6. **Dead code.** `bookmarkSetStatus` (no sender), `resetBookmarkReconciliationForTests`,
   `fallbackBookmarkState` (no references). → removed.

Plus: `cardPages` regex anchored to end-of-caption (an unanchored match reads a
false page count out of any title containing "<number> pages").

### Verification

`npm test` **366 passing / 4 pending** (from 310/4) · `npm run build` clean ·
`npm run test:smoke` worker + offscreen clean · `npm run test:e2e` **117 PASS,
0 FAIL** (from 101). Load-bearing: worker e2e **13f** re-runs the built
`js/background.js` in the same VM against the same `chrome.storage.local` stub
and proves an in-flight row recovers while a history-backed `done` row and the
dock flag survive.

**Harness gotcha:** bare `npx mocha test/x.test.js` uses a stale `build/test/`;
only `npm test` runs `build:test` first.

**Still unverified:** everything real-browser. `npm run test:browser` has never
run in this environment.

## New backlog items — 2026-09-08 (items 42–46)

### 42. Real-browser pass for the Queue tab

- **Status:** open. **Priority:** highest of the new items.
- Every 3.7.0 claim about rendering, restart and the panel API is a VM result or
  an expectation. Verify, in a real Chrome 116+ profile: bookmark three cards →
  close the browser → restart the machine → reopen → the list, its selection and
  its collapsed state are identical; thumbnails paint from `t.nhentai.net`;
  "Open docked ↗" opens the side panel from the popup and is hidden inside the
  panel; paste `366224,177013` → **Download now** → both files land under the
  list-mode template; auto-capture on a real infinite-scroll page.
- Add the steps to "Required real-browser verification before PR" in
  `SESSION_HANDOFF.md` once run.

### 43. Bookmark control on the single-title preview and on similar-gallery rows — DONE 2026-09-23

- **Landed** together with 44/52/41 in session `arena/01a0cc70-nh-dw-2-0`, both
  trees. `bookmarkTogglePresentation(on)` in `src/utils/bookmarkQueue.ts` is the
  single source of the words/classes, so every surface says the same thing.
- `message.bookmarkButtonHtml(id, extraClass, on, dataId)` renders an
  `input[type=button]` (never a submit button); `message.downloadInfo(...)`
  embeds it beside Download as `#buttonBookmark`, and `message.similarList(...)`
  puts one per row as `input.similarBookmark[data-id]`. The button is rendered
  **outside** each row's `<label>` on purpose: nested inside, a click would also
  toggle that gallery's download checkbox.
- `popup.ts` wires both: optimistic paint, then `bookmarkAdd`/`bookmarkRemove`
  through `sendBookmarkAction`, then a repaint from the worker's answer (or from
  a `readBookmarks` fallback). Similar rows are wired by class + `data-id`
  because the whole list is re-rendered as one HTML block.
- Adds from the preview carry the gallery's real metadata; similar adds use
  `source: "similar"` and an empty thumbnail (there is no cover in hand there).
- **Coverage:** unit tests in `test/message.test.js` (markup contract,
  including the outside-the-label rule) — the preview/similar **wiring** has no
  e2e, because both paths render through `innerHTML` and the popup harness has
  no HTML parser; the harness would end up testing its own parser. Documented in
  `SESSION_HANDOFF.md` rather than papered over.

### 44. Drag-reorder the bookmark list — DONE 2026-09-23

- **Landed.** `moveBookmark(state, id, toIndex)` clamps the target, returns the
  SAME state on a no-op or unknown id, and is keyed through `toGalleryKey`, so a
  `site:id` row is draggable too. **No new stored field** — order is array order,
  exactly as planned: `planBookmarkDownload` already emitted ids in list order,
  so the affordance was the only work.
- The row asks the worker (`bookmarkReorder {id, toIndex}`) and repaints from
  the answer, so the single-writer rule holds. Only the `span.nhdwBmDrag` handle
  is draggable — the row's checkbox / Download / Remove keep their own hit
  targets — and `dragstart` also sets `text/plain` on the transfer because
  Firefox refuses to start a drag with an empty `dataTransfer`.
- **Coverage:** unit tests (`moveBookmark`, including a plan-order assertion
  that reordering really changes the batch order) and
  `scripts/e2e-bookmark-panel.js` (dragstart → dragover → drop sends the
  reorder; dragleave/dragend send nothing).

### 45. Per-row cancel of an in-flight download

- **Status:** **landed 2026-09-23**.
- Implemented `cancelGallery(id, site)` across `batchPipeline.ts`, `Downloader.ts`,
  `offscreen.ts`, and `background.ts`.
- When a user cancels a gallery currently downloading:
  - In `bookmarkPanel.ts`, an active downloading row renders a red "Cancel" button.
  - Clicking "Cancel" dispatches `action: "cancelGallery"`.
  - The worker / offscreen document aborts the active `Downloader` for that gallery,
    filters out matching entries in `queuedJobs`, and marks the bookmark row as
    failed (`error: "Cancelled"`).
  - In `batchPipeline.ts`, `isGalleryCancelled()` checks allow pre-cancelled galleries
    in a batch loop to be skipped immediately, allowing subsequent galleries in the batch
    to continue downloading cleanly without failing the whole batch job.
  - Styled `.nhdwBmCancel` in `css/style.css` and verified with dedicated tests in
    `test/batch-pipeline.test.js`.

### 46. Firefox port of the bookmark queue

- **Status:** open. `NHDW_Firefox_v1.0.0` is untouched by 3.7.0 and still lags
  at 3.3.1.
- `chrome.sidePanel` has no Firefox equivalent — the analogue is
  `sidebar_action`, and the "Open docked ↗" button must degrade to a message
  rather than a failed call. The rest (storage, worker messages, content-script
  star) ports directly; `bookmarkQueue.ts` is storage-agnostic.
- Blocked behind worklist **37** (the Firefox panel harness) — without it there
  is no way to verify the port.

## Session log — 2026-09-14: multi-site v4 planning (docs only)

**No code changed.** This session settled the multi-site direction in
conversation and recorded it. Full design, decision record and per-site
facts: `MULTISITE_V4_PLAN.md` (new document, same role as
`BOOKMARK_QUEUE_PLAN.md`).

What was settled:

- **One extension end-state.** `chrome.storage` is per-extension-ID, so a
  second installed extension would split history and the bookmark queue —
  the exact failure that ruled out the reference desktop app for the user.
  The user's clone of this repo is an experiment lab only; this repo is the
  merge target; the nhentai adapter stays as the regression control until a
  second site downloads end-to-end.
- **The desktop app is not portable into MV3** (Python/Qt; Native Messaging
  would reintroduce a host program). Only extractor knowledge ports, and
  only for the sites the user actually visits — no 1000-site goal.
- **Site roster:** hitomi.la (first new site, validates the adapter
  contract), the imhentai/hentaienvy/hentaiera mirror network (one adapter,
  pending spike), hentaifox.com (pending spike).
- **Cooldown position:** the mirror network's ~60 s server-side zip cooldown
  is not bypassed and never will be. The plan is reader-page downloads
  (Strategy A), a cooldown-aware scheduler as fallback (Strategy B), decided
  by the user's byte-level reader-vs-zip comparison (Strategy C).

External checks made this session (the sandbox cannot resolve any of the
sites — DNS failure — so nothing site-specific was verified locally):

- KurtBestor/Hitomi-Downloader's supported-sites list does **not** include
  imhentai, hentaifox, hentaienvy or hentaiera (hitomi.la, nhentai and
  AsmHentai are there):
  https://gitfreak.com/KurtBestor/Hitomi-Downloader (README mirror).
- jingth/Hitomi-Downloader (the user's first reference link) is a fork of
  the project's issues repo carrying the same supported-sites table;
  lanyeeee/hitomi-downloader is a single-site Tauri desktop app. None of
  the three reference repos covers the four sites the user listed, so
  custom adapters it is.
- Traffic-analysis affinity for hentaiera/hentaienvy/imhentai
  (similarweb.com) supports the one-operator mirror-network assumption.

## New backlog items — 2026-09-14 (items 47–52, planning mode)

Planning only — no code exists. Depth and rationale:
`MULTISITE_V4_PLAN.md`.

### 47. Composite (site, id) keys for every persistent store

- **Status:** landed in 3.8.0 (2026-09-14).
- `downloadHistory.ts`, `bookmarkQueue.ts` and `failedGalleries.ts` are all
  keyed by the bare numeric gallery id, which collides across sites the
  moment a second adapter exists. Keys become `"<site>:<id>"`; existing rows
  migrate as `nhentai:<id>`. Worth doing even if the multi-site direction
  is later abandoned.

### 48. Site adapter layer v2 + multi-site side panel + site-aware paste box

- **Status:** **landed 2026-09-23** — per-site job splitting (`bySite`),
  per-site metadata resolution via matching adapter, universal paste box
  parsing (supporting bare IDs, URLs from all 6 sites, and `site:id` keys),
  bare-id file naming, and composite history/retry tracking shipped in both
  Chrome (3.9.0) and Firefox (1.3.0).

### 49. Hitomi.la adapter — first new site, the architecture validator

- **Status:** **landed 2026-09-23** (3.9.0 / FF 1.3.0).
- Adapter (`src/sources/hitomiSource.ts`), dynamic subdomain router
  (`src/sources/hitomiResolver.ts` mirroring `gg.js`), metadata extraction
  (`src/parsing/hitomiHtml.ts`), direct CDN fetch from
  `*.gold-usergeneratedcontent.net`, and default format `raw` for
  large-gallery safety. Covered by `test/hitomi.test.js` and e2e suites.

### 50. Mirror-network adapter + reading-vs-zip comparison + pacing

- **Status:** **landed 2026-09-23** (3.9.0 / FF 1.3.0).
- Implemented per-site adapters for `hentaiera`, `imhentai`, `hentaienvy`, and
  `hentaifox` in `src/sources/` and `src/parsing/`. Reading-mode image extraction
  bypasses server-side cooldown limits without hammering endpoints. Covered by
  dedicated unit test suites (`test/imhentai.test.js`, `test/hentaienvy.test.js`,
  `test/hentaifox.test.js`, `test/hentaiera.test.js`).

### 51. Streaming ZIP writer (OPFS / File System Access) — DONE 2026-09-24

- **Status:** **landed 2026-09-24**.
- Built `src/utils/streamingZip.ts` (`StreamingZipWriter`, `OpfsZipSink`, `MemoryZipSink`, `crc32`, and `compressDeflateRaw`).
- Replaced JSZip memory accumulation in `offscreen.ts` with `StreamingZipWriter` targeting Origin Private File System (OPFS):
  - In browser contexts with OPFS support (`navigator.storage.getDirectory()`), pages are written sequentially and directly to an OPFS `FileSystemWritableFileStream` on disk, bounding peak RAM to O(single page) regardless of gallery size.
  - Generates standard PKWARE ZIP archives with 100% specification compliance: Local File Headers (UTF-8 bit 11 set), Central Directory records, and End of Central Directory (EOCD).
  - Automatically selects `STORE` (method 0) for pre-compressed images (`.jpg`, `.png`, `.webp`, `.avif`) eliminating redundant CPU burn, while supporting streaming raw deflate via `CompressionStream("deflate-raw")` when requested.
  - Automatically cleans up temporary OPFS files via `cleanup()` upon archive delivery or abort. **(PR #48 review fix:** the save is an un-awaited anchor click, so `cleanup()` now unlinks after a 60 s grace period — mirroring `revokeObjectUrlDelayMs` — and `OpfsZipSink.create()` sweeps orphaned `nhdw_archive_*.tmp` files older than that grace period before creating its own; a killed document can no longer leak, and a live download can no longer have its blob unlinked mid-read.)
  - In contexts without OPFS (e.g. Node test environment), cleanly falls back to `MemoryZipSink`.
  - **Compression honesty (PR #48 review):** the writer decides compression per entry at append time; the Downloader's `generateAsync({compression:"DEFLATE"})` request is documented-ignored, so production archives are STORE (image payloads are already compressed; PNG pages come out a few percent larger than the old JSZip deflate, in exchange for constant memory). Per-entry DEFLATE remains available via the constructor / `file()` options.
- Verified with dedicated unit test suite in `test/streaming-zip.test.js` and confirmed across end-to-end offscreen document test (`scripts/e2e-offscreen.js`) with zero base64 round-trip. The OPFS runtime itself (real `navigator.storage`) cannot run in the VM harnesses — mocked sinks + the memory fallback are what the suites cover; a real OPFS pass belongs to items 42/58.

### 52. Queue + history export / import (JSON) — DONE 2026-09-23

- **Landed** as one file for **both** stores (the queue is the thing users
  actually carry between machines; the history travels with it).
- New pure module `src/utils/queueTransfer.ts`: `buildTransferPayload`,
  `serializeTransfer` (two-space JSON — a file a human may open or fix),
  `parseTransferPayload` (rejects empty/unparseable/foreign/newer/empty files
  **with a reason**, normalizes every row through the same readers as the live
  path, so an unusable row is dropped rather than failing the import) and
  `mergeImportedHistory`. Policy: **union, local wins**, imported rows are
  appended so an import cannot reshuffle the download order, and **nothing is
  ever deleted** — a wrong file cannot wipe the list.
- Writes stay single-writer: the queue goes through the worker's new
  `bookmarkImport` action, the history through `historyImport` →
  `writeHistory()` (which keeps the file's own timestamps and reuses the
  serialized write chain, so an import cannot race a settling download). The
  panel never writes storage itself.
- UI: Export backup / Import backup in the Queue tab plus a hint, with a
  one-line notice reporting what was actually added; re-importing the same file
  is a no-op.
- **Coverage:** 24 unit tests in `test/queue-transfer.test.js` (format,
  validation, merge policy, the item-41 gate, the item-43 markup is in
  `test/message.test.js`) and `scripts/e2e-bookmark-panel.js` (export blob +
  file contents, import messages, re-import no-op, six refusal cases).

## Session log — 2026-09-14 (second session): item 47 landed as 3.8.0

The planning session above was followed by the implementation of item 47 in
the same day. What changed:

- **New pure module `src/utils/siteKeys.ts`** — the composite-key contract:
  `"<site>:<id>"`, default site `nhentai`, `toGalleryKey()` passes
  already-composite ids through unchanged so the same helper is safe on both
  sides of every comparison. Gallery ids must not contain `":"` (documented
  in the module; every planned site uses numeric ids).
- **Migration semantics:** legacy bare rows read back as `nhentai:<id>` via
  `normalizeHistory` / the bookmark and failure normalizers, and persist in
  composite form on the next write. No stored-shape version bumps.
- **Every identity comparison composes:** `normalizeHistory`,
  `recordHistory`/`writeHistoryEntries`, `partitionKnown` (returns the
  ORIGINAL candidate strings so the pipeline keeps receiving bare ids), the
  batch-pipeline skip guard (`alreadySet`/`redownloadSet` and the per-gallery
  check), bookmark row identity in `bookmarkQueue.ts` (normalize dedupe,
  add/remove/select/patch/reconcile/plan/find), failed-gallery
  merge/drop dedupe, and the ten direct `history[id]` lookups in
  `listControls.ts` / `popup.ts`.
- **New `site` field** on `BookmarkItem`, `BookmarkCandidate` and
  `FailedGallery`/`PendingFailure`, defaulting to `nhentai`.
- **Tests:** new `test/site-keys.test.js` (registered in the explicit mocha
  list), composite-contract cases in the history, bookmark-queue and
  batch-pipeline suites. Six old assertions that pinned the bare-key shape
  were updated to the composite contract (the semantics they pin are
  unchanged). `npm test` 366 → **387 passing**.
- **e2e:** `scripts/e2e-worker.js` history polls read the composite key via a
  `historyKeyFor()` helper; the list-controls fixtures keep seeding bare keys
  on purpose — they now double as the legacy-migration path test. All six
  e2e scripts PASS.
- **Release:** webpack bundles rebuilt and copied to `NHDW_Release_v3.0.0`;
  both manifests at 3.8.0.

## Session log — 2026-09-14 (third session): cin.* mirrors pinned, C chosen, README overhaul

- **cin.* viewer mirrors:** the user named the reference viewer site's mirror
  family (cin.lat, cin.mom, cin.monster, cin.wiki, cin.wtf, …) and expected
  paste-box work. None was needed: `parseGalleryInput` matches URL shapes
  (`/g/<id>`, `/v/<id>`, `?id=…`) and never checks hosts, so every mirror
  already parses. Verified against the built module, pinned by three new
  tests (mirror `/v/`, mirror `?id=` bulk, mixed paste with nhentai links and
  ranges), and the parser comment + README now state the contract explicitly.
  `npm test` 387 → **390 passing**.
- **Strategy C chosen (item 50):** the reading-vs-zip comparison is the
  picked approach for the mirror-network sites, with plain-language
  descriptions of what A (read pages directly, no button, no cooldown) and B
  (server zip via their button, paced one-per-minute with a visible
  countdown) actually do, recorded in `MULTISITE_V4_PLAN.md` §3. Execution
  **waits for the user's explicit confirmation** — recorded as a pending
  USER-owned task in `WORKLIST.md`.
- **Sample-capture checklist (§8 of the v4 plan):** the exact page sources,
  reader HTML, image URLs, `gg.js` and one button-zip the user will capture
  for hitomi.la and the four mirror-network sites. Items 49/50 are blocked on
  these captures; the sandbox cannot resolve any of the hosts.
- **README rewritten** to the polished format the user asked for: feature
  list, site support matrix (nhentai shipped; hitomi + mirror network
  planned), installation, usage, FAQ, roadmap. All claims kept truthful to
  the 3.8.0 code — nothing announced that does not exist yet.

## Session log — 2026-09-14 (fourth session): self-review pass over the day's output

The mandatory own-output review, run over everything the previous three
sessions produced. Findings and fixes:

1. **Lost doc-in-code comment (race casualty).** The `downloadHistory.ts`
   header still said "Keyed on the GALLERY ID" — the composite-keying
   comment was one of the edits clobbered when same-file parallel edits raced
   during implementation. The module documentation contradicted its own
   code. Restored.
2. **Dead export.** `sameGallery()` in `siteKeys.ts` had zero production
   callers (its test was its only user) — removed together with its tests,
   per the standing dead-export rule. `splitGalleryKey()` also has no
   production caller yet but stays deliberately: it is the structural
   inverse of the key format, its tolerant legacy parsing is pinned by
   tests, and item 48's per-site UI is its named consumer (now said in a
   comment so a future review does not delete it or build a second parser).
3. **Wrong count in three documents.** "Nine direct `history[id]` lookups"
   was written into the worklist, backlog log and session handoff; the real
   count is **ten** (seven in `listControls.ts`, three in `popup.ts`).
   Corrected everywhere.
4. **Latent misalignment documented (not a bug today).** Worker messages
   (`bookmarkAdd` / `bookmarkEnrich` / `bookmarkSelect` / `bookmarkRemove`,
   failed-gallery retry & dismiss) carry only bare ids. The queue functions
   compose both sides, so nothing breaks while only nhentai rows exist, but
   a non-default-site row could not be selected, retried or dismissed until
   the messages carry its site. Folded into item 48's scope in
   `MULTISITE_V4_PLAN.md` §4.2.

Verified clean during the same pass: every remaining `history[id]` use
(`background.ts` merged-name occupancy, `pickFreeBatchFilename`,
`verifyHistoryOnDisk`) is filename-based or key-space-internal; all three
bookmarkService status markers route through `patchBookmark` (composing);
bookmarkPanel's history/plan calls route through the composing queue
functions; options.ts reads counts only; updateContent.ts touches no
history; document tails intact (no truncation from the mid-session stops);
the cin.* mirror comment rendered correctly.

Test counts after the pass: `npm test` 390 → **389 passing** (the dead test
was removed with its export); all six e2e suites and the smoke suite PASS;
bundles rebuilt and synced to `NHDW_Release_v3.0.0`.

## Session log — 2026-09-14 (fifth exchange): id-collision audit + doc de-staleness sweep

- The user asked whether colliding ids across sites were actually solved.
  Audit answer: yes for every persistent store — history, bookmark queue and
  failed galleries key records as `"<site>:<id>"`, with the
  "same-numbered ids from different sites stay distinct" contract pinned by
  tests in three suites (`site-keys`, `download-history`, `bookmark-queue`).
- The same audit found the one REMAINING bare-id surface: the job payload.
  `allDoujinshis` is keyed by bare gallery ids and the pipeline's skip guard
  composes every key with the default site, so two same-numbered galleries
  from different sites in one batch would collapse into one entry, and a
  non-nhentai gallery would be skip-checked against `nhentai:<id>` records.
  A mixed-site batch becomes real the moment the bookmark queue holds two
  sites' rows and the user presses "Download N selected". Chosen fix
  (item 48): the queue splits its selection into one job per site;
  documented in `MULTISITE_V4_PLAN.md` §4.2 with a NOTE comment at the exact
  code line so nobody "fixes" it by guessing a site. Composite payload keys
  noted as the more invasive alternative, not needed.
- Doc de-staleness sweep (user request: every MD current after this session,
  untouched where nothing changed):
  - `NHDW_Release_v3.0.0/README.md` — the panel has had THREE tabs since
    3.7.0, not two; added the missing 3.5.0 download-memory, 3.6.0
    failure-naming/retry and 3.7.0 bookmark-queue feature bullets (in its
    own voice, version-labelled), and corrected the test count (149 → 389).
    Auto-capture is mentioned in the queue bullet only — it lives in the
    panel Settings tab, not the full options page (verified in
    `popupSettings.ts`).
  - `BOOKMARK_QUEUE_PLAN.md` — the `BookmarkItem` sketch gained the 3.8.0
    `site` field plus a note that identity compares through
    `src/utils/siteKeys.ts`; stored shape stays `v: 1` with legacy rows
    reading as site `nhentai`.
  - Untouched deliberately: root `README.md` (rewritten this session),
    `MULTISITE_V4_PLAN.md` (current through this exchange),
    `FOLDER_NAMING_STUDY.md` (historical study), `ci/README.md` (workflow
    rules unchanged), the legacy upstream README inside
    `NHDW_Extension_v3.0.0/` (upstream heritage, untouched through 3.x),
    and the Firefox tree's README/PORTING_AUDIT (they describe that tree's
    own lagging state, which the other docs already record).


---

## 2026-09-15 — multi-site v4 groundwork (session `arena/01a0a3d5-nh-dw-2-0`, PR #42)

### 53. Hentaiera adapter core + capture audits + wiring plan

**Landed:** `src/sources/hentaieraSource.ts` (`GallerySource` impl: host consts,
URL/id matchers, `getImageUrls` → `hentaiera.site/galleries/<media>/<file>`) and
`src/parsing/hentaieraHtml.ts` (`extractHentaieraGallery` from the `ld+json`
ImageGallery block + per-gallery extension read off the thumbnail strip;
`extractHentaieraReaderImage` from `<img id="reader_img">`). Tests:
`test/hentaiera.test.js` (9 new; 389→**398** passing), fixtures mirroring the
captures incl. a `.jpg` gallery pinning "extension is read, not assumed".
`tsc` build + smoke green. **Registration into `sources/index.ts` deferred** to
item 48: wiring it now would let `popup.ts` resolve a hentaiera id and feed it
to the nhentai API (id collision → wrong-site metadata); a test pins the
registry nhentai-only.

**Captures resolved (HARs on `origin/main`):** hentaiera (`era to.zip`: reader
`/gallery/<id>/<n>/`, `#reader_img`, webp, Referer sent), imhentai
(`imhen xxx.zip`: reader `/view/<id>/<n>/`, `#gimg`, thumbs jpg but pages webp,
**no** Referer), hentaienvy (`envy com.zip`: reader `/g/<id>/<n>/`, `#readerImg`,
`#readerPagesJson` full per-page `{page,ext,w,h}` map, `data-reader-image-base`
token, Referer sent). Per-site contract table + fox/hitomi lists:
`ADAPTER_WIRING_PLAN.md` §1/§7.

**Corrections to earlier statements (mechanism, not outcome):** the sandbox
block is **egress** (TLS dies; DNS resolves — same for `example.com`), not the
"DNS failure" recorded in the 2026-09-14 logs above; hitomi's CDN is
`ltn.gold-usergeneratedcontent.net`, not `ltn.hitomi.la`; the mirror network is
**two backends / four frontends**, refuting §2.2's "one adapter, host-
parameterized" assumption (recorded as a correction there); and the hentaifox
age modal does **not** fire for `ID` (`allowedGeos.includes(__GEO__)` gates it
to US/FR/IT/GB) — an earlier draft inverted this.

**Remaining:** implement `ADAPTER_WIRING_PLAN.md` §5 (registry → imhentai
adapter → seams with collision guard → cdnConfig allowlists → paste box +
manifest hosts → e2e → real-browser check); capture hentaifox + hitomi; merge
PR #42.

### 54. Firefox-for-Android migration (v1.0.0) — done 2026-09-19

First Android-ready Firefox build: manifest promoted (gecko id, event-page
background, min 142.0 + `data_collection_permissions:none`, true-size icons
48/96/128), viewport metas, compact portrait CSS gated by
`(max-width:640px) and (pointer:coarse)`, first-run host-grant notice
(Firefox MV3 opt-in hosts), job-scoped keep-alive alarm, `web-ext`
lint/package/run/sign scripts + CI lint step. Version sequence is
independent of Chrome by owner decision.

### 55. P1 parity elevation rebase (v1.1.0) — done 2026-09-19

Firefox folder rebased onto current Chrome `src/`: in-page card controls +
floating action bar, bookmark queue, history/verify/retry-failed, batch
pipeline, list-mode settings, PDF-merge warning, hentaiera adapter. Delta
set audited to 4 files (see `FIREFOX_PARITY_PLAN.md` §2, §6). Desktop/mobile
separation rules R1–R3 codified; the v1.0.0 DOM-wrapper violation was
reworked into a runtime relocator before the rebase. 406 tests green.

### 56. Website-embedded UI: invoker + settings drawer in nhentai header — done 2026-09-20

Landed Firefox 1.2.0 (session `arena/01a0bf5f-nh-dw-2-0`). Contract:
`src/utils/embeddedUi.ts`. Injector: `src/content/siteUi.ts` / `js/siteUi.js`.
Drawer reuses `renderSettings` + `renderBookmarks`. Anchored only on
`.navbar`. Toolbar: `handleToolbarClick` (toggle → inject → panel page).
Tests: `test/embedded-ui.test.js`, `scripts/e2e-site-ui.js`. Chrome folder
untouched (`shipsSiteUi()` is the inert path).

### 57. Toolbar popup demotion to settings/API-key fallback — done 2026-09-20

`index.html` stays. Download tab is **not** hidden — progress / similar /
retry-failed have no in-page home; drawer has "Full panel ↗". Toolbar on
nhentai follows the device (drawer on phones, popup on desktop) unless
overridden in Settings → In-page panel.

### 58. Combined P2+P3 verification + sign 1.2.0 — open

Real desktop-Firefox + Android-device matrix after 56/57 (grant prompt,
drawer at 360px, keep-alive over long ZIPs, in-page controls on listings,
queue/history persistence), then unlisted sign as 1.2.0.

## Session log — 2026-09-19 (session `arena/01a0b767-nh-dw-2-0`): Android migration, parity elevation, embedded-UI plan

- Shipped 1.0.0 (Android-ready) then 1.1.0 (P1 rebase) on the Firefox track;
  PR opened from `arena/01a0b767-nh-dw-2-0`.
- Owner decisions recorded: independent version sequence; desktop/mobile
  hard separation (R1–R3); in-page UI primary, popup demoted; nh-only scope
  for the embedded work; P2 folded into 58.
- P1 review found and fixed one defect (popupSettings select normalization);
  `chrome.windows` call sites verified gated; dynamic-id refs verified
  runtime-created. Note for future sessions: `node_modules` not persisted —
  `npm install` first.
- Feasibility of the embedded UI proven from the in-repo page capture;
  design sketch in `FIREFOX_PARITY_PLAN.md` §8.

## Session log — 2026-09-20 (session `arena/01a0bf5f-nh-dw-2-0`): items 56+57, Firefox 1.2.0

- Website-embedded UI is the primary surface on nhentai: header invoker +
  drawer (This page / Queue / Settings), reusing existing renderers.
- Popup demoted, Download tab kept as fallback. Toolbar click on phones
  opens the drawer; desktop keeps the popup unless overridden.
- Firefox `npm test` 406 → **423** passing / 4 pending; e2e gained
  `e2e-site-ui.js`. Manifest 1.2.0. Item 58 (device pass + sign) still open.
  Chrome tree not modified.


## Session log — 2026-09-20 (session `arena/01a0bfa1-nh-dw-2-0`): review of PR #44

Owner scope: read handoff/latest PR, fix verified defects, then propose one
achievable task WITHOUT starting it. Latest PR: #44, Firefox embedded UI.

Verified fixes (regression tests fail against the pre-fix code/bundles):

- Wire the previously inert embedded settings: read defaults/stored values,
  save only on explicit change, remove the toolbar override for Auto. Request
  that key in the worker's storage read; listen to the correctly shaped global
  storage-change event. Preserve clicks racing a toolbar-mode change.
- Ship the reused Settings/Queue CSS as `css/panelRenderers.css`, shared with
  the popup rather than duplicated; inject both CSS files before on-demand JS.
  No global popup element styles leak into the website.
- Stop the badge/MutationObserver feedback loop, retain Queue DOM after drawer
  detachment, refuse unanchored toolbar opening, update listing counts while
  open, and keep the navbar invoker outside the backdrop's hit area.
- Bind Full panel to its originating nhentai tab via `sourceTabId`. Validate
  the source before preview/injection/download/retry and worker-side bookmark
  enrichment. A closed/off-site source does not fall through to the active
  extension tab, including the worker's sender-tab fallback. Report actual
  `tabs.create` failure instead of unconditional success.

Firefox build, 431 unit tests (4 pending), smoke and all offline e2e scripts
pass; lint 0 errors / 0 notices / 30 advisory warnings; clean 25-entry unsigned
1.2.0 package. Chrome tests 398 passing / 4 pending, tracked Chrome trees
unchanged. No real browser/device test and no signing performed. Source delta
allowlist updated in `FIREFOX_PARITY_PLAN.md`; 58 remains the release gate.

**Proposed only, not started:** item 38, a Firefox-only offline options-page
harness. Requires owner approval before implementation. Node/VM + existing
bundles are available; no device, signing access or live-site fetch is needed.


## Session log — 2026-09-21 (session `arena/01a0bfa1-nh-dw-2-0`): approved item 38

Owner said “proceed” to the Firefox-only options harness proposal. Implemented
`scripts/e2e-options.js` + dependency-free `scripts/test-support/options-page.js`;
loads the actual HTML and built bundle, with no live fetches or credentials.
Select/index/value semantics and async, cloned, key-scoped storage have their
own contract checks. Tests cover defaults/stored values, read-only rendering,
all real control choices, folder/template/list previews, local API-key and
server-archive state, mocked verification, and confirmed/cancelled history
clearing. Both complete e2e and focused `test:options` run the new harness.

Regression-first fixes limited to Firefox `src/options/options.ts`:

- Request saved `listFormat` explicitly, with no concrete default that masks
  inheritance; show legacy `folder` as PDF without migrating stored data.
- Hide the unavailable side-panel choice using the existing capability guard;
  rendering does not rewrite old synced `uiMode` values.
- Keep inherited list format live until an explicit list choice; refresh list
  name previews/placeholder for single-title template and replace-spaces edits.
- Honor deliberately empty single/list templates as gallery-ID fallback;
  distinguish a stored empty list template from an explicit blank edit which
  saves `@inherit`. No options redesign or new controls.

Saved pre-fix bundle: **25 pass / 8 fail**. Fixed bundle: **33/33**. Firefox
build, **431 unit tests / 4 pending**, smoke7 and full e2e pass; lint **0 errors /
0 notices / 30 advisory warnings**; rebuilt unsigned **1.2.0**, **25 ZIP entries**.
Chrome, CI, permissions, HTML and generic option classes unchanged by item 38.
No real Firefox/Android run or signing; item 58 stays open. Preserve the prior
PR #44 review fixes in this working tree. Firefox source allowlist gains only
`options/options.ts` (eight changed existing files + two new in total).

### 59. Saved list-format reads in shared Firefox consumers — DONE 2026-09-21

Separately approved by the owner (“ok do 59”), Firefox-only and offline.
The options review found the omitted-key bug in `utils/listSettings.ts` and
`preview/popupSettings.ts`; implementation review found a third independent
reader in `content/listControls.ts`. Object-form `storage.sync.get` only
returns requested keys, so none could see saved `listFormat`. Existing
whole-store/default-merge mocks hid this (even an existing real-reader test
was falsely green).

All three now request an array including the optional key and merge defaults
for other fields afterward. No concrete list-format default, migration or
new normalization policy. Saved ZIP/CBZ/PDF/raw beats `useZip`; unset/null/
blank/invalid inherits it; neither usable means ZIP; legacy `folder` maps to
PDF for use/display only. Reads/rendering are read-only. Explicit changes
write just their own key, preserve sibling/single-title preferences and
survive reopen/reload.

Regression coverage uses shared key-scoped/cloned storage results and async
get callbacks, plus a 36-case independent matrix. It runs against the real
shared reader, popup and Full panel Settings/Queue, delivered `getGalleries`
format markup/preview, in-page card/bar jobs, and embedded Settings/gallery/
Queue jobs. It does not claim full listing bootstrap/pagination (40) or real
browser layout/APIs. Focused units **59 pass / 20 fail → 79/79**; embedded
suite **11 pass / 4 fail → 15/15**; old popup variants and list-controls
bundles also fail. Existing invalid/inherited behavior remains pinned.

Only three production source files and their preview/siteUi/listControls
bundles changed, plus tests/docs; source allowlist now ten existing + two new
files versus Chrome. No Chrome backport, dependency/manifest/permission/UI
redesign or signing change. See the latest session log below for full checks.


## Session log — 2026-09-21 (same session): owner-requested npm maintenance

Owner saw npm's deprecated-package / npm-version / funding messages and asked
where they came from, their project impact, and for necessary upgrades. They
come from the lockfile's development tooling running in the sandbox; the npm
upgrade notice is environment-specific, and sponsorship is optional. No
payment was made and paid support is not necessary to use updated packages.

Upgraded both maintained projects to Mocha 12.0.2, Firefox to web-ext 10.6.0,
and refreshed fast-uri to 3.1.8 within its allowed range. One Firefox override
selects addons-linter 10.13.0 instead of web-ext's affected 10.10.0 pin. Added
the Node engine requirement; lockfile v3 still works with npm 10.9.8 and 12.0.2.
Sandbox npm itself upgraded to 12.0.2 (environment-only, not a repo dependency).

Full audit findings: **Firefox 16→0, Chrome 5→0**; runtime-only audits **0**.
Fresh Chrome install: no deprecations. Fresh Firefox install: **two remaining
upstream deprecations** (ESLint 9; whatwg-encoding through Cheerio). ESLint 10
removes APIs Mozilla's validator still calls, and the replacement codec parent
is an ESM-only major outside Cheerio's declared range. These are explicitly
left visible instead of forcing breaking upgrades, suppressing logs or
maintaining a validator fork. See `DEPENDENCY_MAINTENANCE.md` for follow-up.

Both builds, **Firefox 431/4 and Chrome 398/4** unit suites, smoke7 each and
all offline e2e pass; options33. Firefox lint 0 errors / 0 notices / 30 existing
advisories; safe/unsafe fixture scans confirm validator security rules still
run. Unsigned Firefox 1.2.0 package rechecked (25 entries). Runtime dependency
versions/integrities, bundles, source, manifests, release snapshots and CI are
unchanged. Preserve prior review/options work. Historical source snapshot
was not updated and is excluded from audit claims. At this checkpoint 58/59
remained pending; this maintenance request did not approve the shared-reader
work. The owner separately approved 59 afterward (below).


## Session log — 2026-09-21 (same session): approved Firefox item 59

Owner chose the saved list-format fix instead of the four optional live API
tests. Completed the three-reader regression/fix scope described in item 59,
including the previously missed in-page reader; preserved all prior work.

Firefox webpack, **474 passing / 4 pending** units (43 added), smoke7 and all
offline e2e pass. Built site UI **15**, toolbar **11**, options **33**; popup
and Full panel format/restoration/Queue checks pass. Lint **0 errors / 0
notices / 30 existing advisory warnings**; unsigned **1.2.0**, **25 entries**
with current bundles and no development/offscreen files. The four pending
units are still deliberately opt-in live API tests, not four failed checks.

Task-start SHA comparison confirms Chrome (including earlier authorized
dependency edits), all package/lockfiles, CI, manifest/permissions, HTML/CSS
and unrelated bundles unchanged. No live requests/device/signing, new PR,
commit or push. Item 58 remains the release gate; broader item 40 is not
closed by the limited delivered-message listing-format check. Local ignored
evidence: `NHDW_Firefox_v1.0.0/build/list-format-review/`.


## Session log — 2026-09-23 (session `arena/01a0cc70-nh-dw-2-0`): bookmark icon + gallery-page Bookmark button

Owner request: "change the star into actual bookmark icon" and add the missing
button to add a title to the queue from its page, blue bookmark icon + the word
"Bookmark", sized like the site's own Favorite/Download buttons, persistent like
the rest of the queue.

- **Cards:** the ☆/★ glyph is replaced by an inline SVG bookmark (outline/filled),
  text-free, still the same small box and the same click toggle; Select +
  Bookmark sit in a left group with **Download kept right-most**.
- **Gallery pages, all six sites:** a new content script inserts the button
  immediately after the site's Download button (row: Favorite / Download /
  Bookmark), copying the site's presentational classes for sizing. Anchors,
  classes, title/cover/page-count selectors are one declarative table
  (`src/utils/titleBookmark.ts`); the script no-ops when nothing matches and
  never touches listing or reader pages. Manifest `content_scripts` gained the
  five non-nhentai site patterns (host permissions already covered them).
- **Persistence:** reuses `chrome.storage.local[BOOKMARK_QUEUE_KEY]` through the
  worker (`bookmarkAdd`, `source: "page"`); adds carry title/cover/pages because
  enrichment only resolves nhentai tabs. Rows store `site:id`.
- **Known gap (unchanged):** the queue's download pipeline is nhentai-keyed
  (item 48 / MULTISITE_V4_PLAN §4.2) — a non-nhentai row downloads correctly
  only once the multi-site job split lands.
- **Tests:** `test/title-bookmark.test.js` (URL/table/icon/label units) and
  `scripts/e2e-title-bookmark.js` (107 checks: all six sites' markup, insertion
  point, classes, click add/remove, storage-driven repaint, negative cases).
  Chrome 459/4, Firefox 535/4, both e2e suites green; Firefox lint 0/0/31.
- **Versions:** Chrome 3.8.0 → **3.9.0**, Firefox 1.2.0 → **1.3.0**, release
  snapshot re-synced (manifest, listControls + preview bundles, new
  titleBookmark bundle, both stylesheets).
- **Follow-up pass (same session):** the sandbox's egress allowlist blocks
  nhentai/hentaifox entirely (even `example.com` fails the TLS handshake), so
  an owner-supplied API key cannot be used — the blocker was never auth. The
  selectors were re-verified from saved/third-party sources instead: imhentai
  from a saved gallery page, nhentai from a current extension that appends to
  `div.buttons`, hentaifox from the four ids its own tooling toggles plus three
  scrapers. Sizing now copies the anchor button's own classes at injection time
  (`presentationalButtonClasses`, behavior hooks excluded), which makes the
  hentaifox row safe despite the missing capture. Chrome 463/4 and Firefox
  539/4 units; title-page e2e grew to **146 checks**.

## Session log — 2026-09-23 (second pass, same session `arena/01a0cc70-nh-dw-2-0`): items 43, 44, 52 and 41 in both trees

The owner answered "what else can be worked on" by choosing **every** option
offered: finish the bookmark coverage (43), make non-nhentai queue rows
downloadable (the multi-site download path), and the small-wins bundle
(44 + 52 + 41). This pass landed the small-wins bundle plus 43's panel half, in
Chrome and Firefox, and is **uncommitted at the time of writing** (it is being
committed with this log).

- **43 — panel toggles.** `bookmarkTogglePresentation()` (one source for
  label/title/classes); `message.bookmarkButtonHtml()` + `similarList()` rows;
  `popup.ts` wires the preview button (`#buttonBookmark`, optimistic paint) and
  every similar row (`input.similarBookmark[data-id]`, wired by class because
  the list is re-rendered as one block). Bookmarks from the preview carry real
  metadata; similar-row adds use `source: "similar"`.
- **44 — drag-reorder.** `moveBookmark()` (pure, clamped, same-state no-op),
  worker action `bookmarkReorder`, panel handle + row drop targets, CSS in both
  trees. No new stored field; array order **is** the download order.
- **52 — backup file.** New `src/utils/queueTransfer.ts` (export/parse/merge),
  worker actions `bookmarkImport` + `historyImport`, `writeHistory()` keeping
  the file's own timestamps through the existing serialized write chain, and
  Export/Import buttons in the Queue tab. Policy: union, local wins, append
  imported rows, **never delete**.
- **41 — the odd-separator gate.** `isCanonicalTemplate()` = token-only **and**
  byte-identical to `buildTemplate(tokens)`, so `{pretty}_{id}` and
  `{id} - {pretty}` keep the manual field instead of being rewritten by the
  first tick. `options.ts` and `popupSettings.ts` both gate on it.
- **Tests added:** `test/queue-transfer.test.js` (24: the item-41 gate, the
  item-43 presentation, `moveBookmark`, the whole backup contract),
  `test/message.test.js` (+5: the item-43 markup, including the
  button-outside-the-label rule), `scripts/e2e-bookmark-panel.js` (new harness:
  row chrome, dragstart/dragover/drop/dragleave/dragend, export blob + file
  contents, import + re-import + six refusal cases), Firefox
  `scripts/e2e-options.js` (+1: canonical vs non-canonical template routing).
  `e2e-popup.js` phase 6 was re-scoped after the 41 gate changed which branch a
  non-canonical template takes.
- **Verified:** Chrome tsc 0, build OK, **492 unit pass / 4 opt-in pending**,
  full e2e green (title-page suite still 146 checks, new panel suite 8 phases),
  smoke 7 PASS. Firefox tsc 0, build OK, **568 unit pass / 4 pending**, e2e
  green (site-ui 15, embedded-toolbar 11, options 34), smoke 7 PASS, lint **0
  errors / 0 notices / 31 advisories**. Release snapshot re-synced by the
  exhaustive file-by-file loop (`js/background.js`, `js/options.js`,
  `js/preview.js`, `css/style.css` were stale; nothing missing).
- **Honest gap:** the popup preview/similar **wiring** has no e2e — those paths
  render through `innerHTML` and the window-less popup harness has no HTML
  parser, so an e2e there would mostly test the parser. The markup contract is
  unit-tested instead, and this is stated in `SESSION_HANDOFF.md`.
- **Next:** the non-nhentai download path (item 48's per-site job split + the
  per-site metadata resolution that makes a `site:id` queue row downloadable).

## Session log — 2026-09-23 (third pass, same session `arena/01a0cc70-nh-dw-2-0`): item 48, per-site jobs

The owner approved the item at the top of `WORKLIST.md` verbatim ("yes do Next
up … item 48"). The queue's download path is no longer nhentai-keyed: a
`site:id` row is now downloadable, and a mixed selection becomes one job per
site. Both trees; no new host permission, no `<all_urls>`, no new adapter.

- **`BatchJobOptions.site?: string`** — one job carries ONE site; absent means
  the default site, so every pre-existing caller and payload is byte-identical.
  `runBatchDownload` derives `jobSite = normalizeSite(options.site)`,
  `storeKey = toGalleryKey(id, jobSite)` and `bareId = splitGalleryKey(storeKey).id`.
  The skip guard reads the composite key, metadata gets `{site: jobSite}`, and
  the history `records` / `batchKeys` / failure rows (`{id, name, error, site}`)
  are composite — while **titles, the `{id}` token and `cleanName()` use the
  bare id**, so no file name can contain `hitomi:`.
- **`resolveGalleryMetadata(key, {site})`** — a composite key always wins; a bare
  key is normalized through `normalizeSite(args.site)`. That is the single line
  that sends a job's fetch through hentaiera / imhentai / hentaienvy /
  hentaifox / hitomi instead of nhentai.
- **`failedGalleries.ts`** — `RetryJob.site?`, `failureSite(entry, job)`, and
  **`retryJobKey` now includes the site** (undefined/empty → `null`). Without it
  the same bare id on two sites shares one retry bucket. `batch.site` is written
  only for a non-default site, so default-site retry payloads stay identical to
  3.9.0. `groupRetryMessages` buckets on `retryJobKey + "|" + site`.
- **`bookmarkQueue.ts`** — `plan.bySite: BookmarkDownloadGroup[]`
  (`{site, download, skip, titles}` in first-appearance order). **`titles` covers
  only the rows in `download`**: a fully-skipped group is
  `{site, download: [], skip: [...], titles: {}}` and must not be sent as a job.
- **`bookmarkPanel.ts`** — `startDownload(groups, fromQueue, skippedCount)`,
  one message per group in list order (`site` serialized only when
  non-default), composite ids into `bookmarkMarkDownloading`, the "across N
  sites" notice and " (N already downloaded skipped)" appended to **every**
  notice branch. `downloadOne` sends its own row's site; the paste path sends
  `[{site: DEFAULT_SITE, titles}]` (paste input is ids/nhentai URLs only).
- **`background.ts` / `bookmarkService.ts`** — the relay forwards `site`, the
  relay path copies it into the options, `jobOverridesFromRequest` sets it, the
  worker-options merge passes it on, and `markBookmarksFailed` patches by
  `toGalleryKey(entry.id, entry.site)`. The Firefox `background.ts` is not the
  Chrome file: it was patched surgically (six edits) and its FF-only deltas
  re-verified; FF `bookmarkService.ts` gained the `toGalleryKey` import.
- **Tests:** `test/batch-pipeline.test.js` (describe "item 48 — a per-site job":
  adapter routing, bare `{id}` naming, per-site skip guard, failure `site` +
  `retryJob.site`, default site unchanged, bare-vs-composite metadata),
  `test/download-control.test.js` (+2), `test/bookmark-queue.test.js` (+2),
  `test/downloader.test.js` (+1: hitomi URLs, never the nhentai CDN),
  `scripts/e2e-bookmark-panel.js` (phases 7/7b), `scripts/e2e-worker.js`
  (phase 8b: worker fallback resolves/caches/brands/records `hitomi:<id>` with
  zero nhentai API calls), `scripts/e2e-offscreen.js` (composite `jobFinished`).
- **Verified:** Chrome tsc 0, webpack OK, **503 unit pass / 4 pending**, full
  e2e exit 0 (**140 PASS**), smoke 7 PASS. Firefox tsc 0, webpack OK,
  **579 unit pass / 4 pending**, full e2e exit 0 (**172 PASS**), smoke 7 PASS,
  web-ext lint **0 errors / 0 notices / 31 advisories**. Release snapshot
  re-synced with the exhaustive file loop (`js/background.js`,
  `js/offscreen.js`, `js/preview.js` were stale; nothing missing).
- **Not in this task:** the rest of backlog item 48's planning scope (adapter
  interface v2, lab-clone side panel, site-aware paste box) and 42/58
  (real-browser + Android passes, signing — owner only).

## Session log — 2026-09-23 (third pass, same session): CSS tidy-up after the item-44 duplicate

Reviewing the item-43/44 diff turned up a real defect: `css/style.css` (Chrome)
carried **two** overlapping blocks for the drag handle and its row states. The
later block did not redeclare everything the earlier one did, so the earlier
one leaked `border-style: dashed` onto a dragging row and `box-shadow` +
`border-color` onto the drop target — Chrome's list looked different from
Firefox's, whose single scoped block in `css/panelRenderers.css` never had them.
The stale block is deleted, one definition per selector remains in each tree,
and the two trees were checked property by property for all four selectors
(no differences). Release snapshot re-synced; units re-run (503/4 Chrome).

## Session log — 2026-09-24 (session `arena/01a0cdce-nh-dw-2-0`, review pass): PR #48 reviewed, eight defects fixed

The mandatory review-before-building rule was run over this session's own PR
#48 (items 39/45/51, commit `49b355f5`). Eight defects: one parity gap, four
broken behaviours, two misalignments, one doc-honesty fix. Every code defect
got a test that fails on the pre-fix build. Full table with evidence:
`SESSION_HANDOFF.md` "Review pass — PR #48".

1. **Item 45's UI never reached Firefox** — `bookmarkPanel.ts` and the queue CSS
   were untouched there; the FF `cancelGallery` handlers had zero senders.
   Ported (file byte-identical again) + `.nhdwBmCancel` into
   `panelRenderers.css` under the `:where(#queuePane, #nhdwSiteUiQueue)` scope;
   pinned by `e2e-bookmark-panel.js` phase 7d (fails on the pre-fix FF bundle).
2. **Cancel marks were never consumed** — a cancelled gallery's Retry /
   "Retry failed" / re-paste failed instantly for the lifetime of the
   document/worker. Fixed with consume-on-skip in the batch loop plus
   consume-on-enforce (and offscreen-only consume-when-idle) in the handlers;
   pinned by the new `e2e-offscreen.js` cancel phase (retry half fails
   pre-fix) and two unit cases.
3. **Bare-id cancel identity poisoned across sites** — cancelling `hitomi:123`
   also killed `nhentai:123` (mark set, active-Downloader match and queued-job
   filter all had bare fallbacks). Composite-only everywhere; pinned by a unit
   case that fails pre-fix.
4. **A late cancel demoted `done` rows** — `markBookmarksFailed` ran
   unconditionally in both handlers. Now it never demotes a settled row;
   pinned by `e2e-worker.js` phase 13i (fails pre-fix: stored status becomes
   failed "Cancelled").
5. **OPFS temp archives were unlinked instantly** — while the un-awaited anchor
   download might still be reading the blob — and orphans leaked when the
   document died. Delayed unlink (60 s, injectable) + age-gated orphan sweep in
   `OpfsZipSink.create()`; two new unit cases fail pre-fix.
6. **Stray `return true` after a synchronous reply** in the fallback
   `cancelGallery` handler — removed (channel-hygiene rule from the 3.6.x
   console-noise fix).
7. **Docs contradicted the PR they shipped with** — root/Release/Firefox
   READMEs (roadmap 51 unchecked, "no per-item cancel" limitation, 503/579
   counts), `MULTISITE_V4_PLAN.md` M4 "future work". All corrected; counts now
   Chrome **519** / Firefox **595**.
8. **DEFLATE request silently ignored** by the streaming writer (per-entry
   compression at append time; production archives STORE-only). Documented in
   the code instead of pretending; no behaviour change.

Known limits recorded, not hidden: the worker fallback cannot cancel a QUEUED
single-title job (no queue visibility — pre-existing); the OPFS runtime itself
is unverifiable in the VM harnesses (mocked sinks + memory fallback only —
real OPFS joins the 42/58 real-browser list).

Verification: both trees tsc 0; Chrome **519/4** units, smoke 7, e2e exit 0
**143 PASS**; Firefox **595/4** units, smoke 7, e2e exit 0 **175 PASS**, lint
**0/0/31**, package `nhentai_downloader-1.3.0.zip` rebuilt. Release snapshot
re-synced (only `js/background.js` + `js/offscreen.js` were stale). No
manifest/permission/dependency/CI/version change.

## Session log — 2026-09-24 (session `arena/01a0cdce-nh-dw-2-0`, owner request): capture sanitization + docs consolidation

Two owner requests in one pass, no product-code change:

### 1. Content-filter sanitization (a session crash-looped reading captures)

An agent session hard-stopped in a crash loop because repository files carried
real gallery titles/tags (romaji, Japanese, Chinese) with explicit terms. The
owner's rule: **sanitize source material, keep website naming schemes.**

- **Sanitized (working tree):** `5 website page source` (34 attr + 38
  text-node titles → `DUMMY_TITLE_nnn`/`DUMMY_TEXT_nnn`, 2 ad blocks removed;
  card counts, media paths and markup classes verified intact),
  `captures/hitomi-id-rendered.html` (34 URL slugs + 32 text nodes, 1 ad
  block), `captures/view-source era to gallery 694133 .txt` (ld+json/og
  titles, 10 slugs, 19 text nodes, 1 ad block), `captures/hitomi The Gallery
  Metadata JS.txt` (title/japanese_title/tag/artist/parody fields → dummies;
  hashes, dimensions, file lists untouched), `captures/hitomi export
  sanitize … .har` (JSON-string-level scrub incl. percent-encoded tag slugs
  inside embedded HTML; 6 ad refs removed). `captures/fox-173098.har`,
  `hitomi-gg.js` and `3 live testing note` scanned clean — untouched.
- **Word-boundary gotcha (recorded):** explicit words adjacent to `%20` runs
  are invisible to `\b` regexes (a digit blocks the boundary) — the sweep
  needs letter-lookarounds `(?<![A-Za-z])…(?![A-Za-z])` or a decoded pass.
  This hid 9 residuals in the hitomi HAR on the first run.
- **Fixtures:** `test/title-bookmark.test.js` + `scripts/e2e-title-bookmark.js`
  (both trees, kept byte-identical) swapped their one realistic title word and
  tag slug for neutral ones; suites re-run green (Chrome 519 / Firefox 595,
  title-bookmark e2e 146 checks each).
- **On `main` (contents API, owner-requested file):** `new domain candidate` —
  the percent-encoded series slug containing an explicit term became
  `[sanitized-series-slug]` (domain + path shape kept). Commit `3d5106b4`.
  The owner's three picks (tailspace.com, mangak.io, omegascans.org) were
  mirrored sanitized into `CANDIDATE_SITES.md` §4a with a dedupe check against
  the tier lists: **no overlap, no double entries**.
- **Honest limit:** git HISTORY still holds the originals (the crash came from
  `git show` of a historical blob). Working-tree sanitization fixes reading
  the files; a history rewrite was deliberately NOT done (destructive to open
  PRs/clones). Rule added to handoff/worklist: do not `git show` pre-2026-09-24
  capture commits in an agent session; sanitize new captures before committing
  (method: `CAPTURE_GUIDE.md` Part B).

### 2. Docs consolidation (owner: "session handoff so bloated")

- **`SESSION_HANDOFF.md` rewritten 192 KB → 34 KB:** current state, doc map,
  structural invariants distilled from every shipped version (formats/naming,
  pipeline/lifecycle, identity/history/failures, bookmark queue, multi-site,
  UI surfaces, filename guard), the real-browser checklists (42/58 + PR #48
  additions), current open questions (15), the FULL Do-not list (carried over
  + the PR #48 review additions), and one-line history pointers. The long-form
  original is recoverable from git history (≤ commit `62697a2`).
- **Deleted as complete/superseded** (all recoverable from git history):
  `BOOKMARK_QUEUE_PLAN.md` (3.7.0 shipped; summary lives in the 2026-09-08
  log below and the handoff invariants), `NEXT_CAPTURE.md` (superseded by
  `CAPTURE_GUIDE.md` per its own banner; hentaiera rationale now historical),
  `SITE_CAPTURE_AUDIT.md` (its corrections were carried into
  `ADAPTER_WIRING_PLAN.md` §1 and `CAPTURE_GUIDE.md` Part B; it also quoted a
  real title, resolved by deletion).
- **Trimmed:** `WORKLIST.md` (32→10 KB; done items one-lined, open items +
  harness notes kept), `MULTISITE_V4_PLAN.md` (19→14 KB; roster statuses
  shipped, landed item specs collapsed to pointers, §8 → CAPTURE_GUIDE
  pointer, open questions pruned), `ADAPTER_WIRING_PLAN.md` (9→7 KB; phase
  roadmap collapsed to a shipped one-liner + a new §6 "adding site #7"
  checklist; the §1 contract matrix untouched — it is the operative
  reference), `CAPTURE_GUIDE.md` (15→12 KB; per-site RESOLVED narratives
  condensed into durable gotchas for site #7+).
- **Kept as-is (live/operative):** this backlog (the improvement log — the
  designated keeper of completed-work detail), `DEPENDENCY_MAINTENANCE.md`,
  `FOLDER_NAMING_STUDY.md` (explains the LIVE naming guard + Chromium bug
  579563; README troubleshooting links it), `CANDIDATE_SITES.md`, `ci/README.md`,
  the three READMEs, and the Firefox tree's `PORTING_AUDIT.md` +
  `FIREFOX_PARITY_PLAN.md`. `NHDW_Extension_v3.0.0/README.md` (the stale
  legacy upstream readme) was replaced with an accurate short stub.
- Cross-references swept: no remaining links to the deleted files except this
  log and the deletion notes themselves.

### Follow-up (same day): the owner-directed roster swap landed

The other session's swap (prepared in its sandbox, never pushed) was landed
here on the owner's instruction. `new domain candidate` on `main` was
rewritten (commit `6ad0b5c0`, 21 lines): the owner's three chapter-based
webtoon/manhwa picks (tailspace.com, mangak.io, omegascans.org) swapped to
the desktop archiver project, replaced by the desktop-repo reference roster —
Tier 1 (asmhentai, e-hentai, pururin, simply-hentai, myreadingmanga,
nhentai.com) + Tier 2 boorus (danbooru, gelbooru, rule34.xxx, yande.re,
sankaku, kemono.cr, coomer.st). Site naming schemes kept verbatim; no slugs,
no explicit terms. `CANDIDATE_SITES.md` §4/§4a on the branch was replaced by
the swap-decision section (the owner-picks mirror is superseded; the
slug-addressing `siteKeys` caveat is preserved for the desktop archiver's
benefit), and every cross-reference (WORKLIST, handoff doc map, v4 plan,
capture guide) now names `new domain candidate` as the canonical roster.
Dedupe stands: the roster matches this document's tier analysis 1:1, no
double entries anywhere.

## Session log — 2026-09-24 (session `arena/01a0d31d-nh-dw-2-0`, post-merge review): PR #48 shared-writer cleanup regression fixed

Mandatory review of the merged PR #48 diff found one real regression the PR's
own eight-defect pass had missed, plus three dead-code nits. Red-first as
required.

### The defect (reproducible, fixed)

In merged mode (`downloadSeparately: false`) every gallery shares ONE
`StreamingZipWriter`. PR #48 added `zip.cleanup()` to `Downloader`'s catch —
correct for an owned writer, but intermediate merged galleries have
`downloadName === null` and a SHARED writer. A gallery failing inside the
Downloader (image errors; per-row Cancel → abort → throw) therefore wiped
pages already collected from earlier titles while their central-directory
records stayed behind → `JSZip.loadAsync` reported `Corrupted zip: missing N
bytes` on the final archive. Metadata failures never reached the Downloader,
and every cancel/separate e2e phase forced `downloadSeparately: true`, so the
suite stayed green (false negative).

**Fix:** catch-path cleanup is now gated on `this.downloadName !== null`
(the final-save owner or a separate-mode gallery that owns its writer).
`StreamingZipWriter.cleanup()` also awaits `writeChain` before releasing the
sink so an in-flight `file()` cannot race the wipe. OPFS delayed unlink +
orphan sweep unchanged.

**Red-first proof:** new unit case fails on the pre-fix build with
`Corrupted zip: missing 6153 bytes`; after the fix it asserts gallery-1
pages survive an intermediate failure byte-for-byte. New e2e phase
(success 123456 → image-fail 300000 → final save 654321, integer-key order)
asserts the delivered merged ZIP contains both successful titles' nested
entries — fails on the pre-fix `js/offscreen.js`, passes after rebuild.

### Dead-code nits (fixed)

- Dropped unused `isGalleryCancelled` import from both `background.ts`
  (the offscreen host and batch loop are the only production callers).
- Dropped zero-caller `Downloader.cancel()` alias (both trees).
- Dropped dead `require("jszip")` from both `offscreen.ts` (StreamingZipWriter
  replaced it; worker fallback still uses JSZip via `background.ts`).

### Verification

Chrome: tsc 0 · units **521/4** (+2) · smoke 7 · e2e exit 0 **144 PASS** (+1).
Firefox: tsc 0 · units **597/4** (+2) · smoke 7 · e2e exit 0 **176 PASS** (+1)
· lint exit 0. Shared files byte-identical across trees; release folder
exhaustively re-synced (`js/background.js` + `js/offscreen.js`); manifests
3.9.0 / 1.3.0 / Release 3.9.0 unchanged. Handoff invariant for `cleanup()`
updated to the ownership rule.

## Session log — 2026-09-25 (session `arena/01a0d31d-nh-dw-2-0`): items 62/63/64 recon + red-first (no implementation)

Recon read the panel Download-tab header (62a), site gallery-page Smart
Download (62b), the six-site card-selector surface (63), and Select-all +
title-page select (64) across both trees + all manifests/backgrounds; the
hitomi listing markup was fetched live (`search.html` + `galleryblock.js` +
`getGalleryId`) because the homepage capture has no JS-rendered cards. Red
tests written and verified in **both** trees: `test/list-cards.test.js`
(new, +mocha list) six-site contract tests; `test/message.test.js`
("Save offline" direct control beside `buttonBookmark`);
`test/download-history.test.js` (`partitionKnown` explicit site arg);
`test/manifest.test.js` (item-63 listing-hosts `content_scripts` block);
`test/batch-pipeline.test.js` (bare force id composes with the job site). A
compiling `src/utils/listCards.ts` **stub** (NOT IMPLEMENTED) was added so the
`list-cards` tests fail cleanly instead of crashing the mocha run.
`scripts/e2e-list-controls.js` (both trees) gained multi-site `makeDocument`
fixtures, a `location` in the sandbox, and 3 assertion flips (item-64a bar
visible while cards exist; composite `bookmarkRemove`; `sourceUrl` = page URL).

**Verified red baseline (this is the intentional end-state of this PR):**
Chrome `npm test` **536 pass / 8 red**; Firefox **612 pass / 8 red** (the 8
reds per tree are all new: 4 `list-cards` + manifest + `partitionKnown` +
message + batch-pipeline); both `node scripts/e2e-list-controls.js` red at the
item-64a bar assert. No crashes. **No production logic for 62/63/64 exists
yet** — the next session must debug-review this merged partial state (missing
logic / misaligned cross-tree code / broken code) before implementing.
`WORKLIST.md` items 62/63/64 marked **partial**; scope note: the
`getGalleries.ts` panel-listing port is **out of scope** for 63.

## Session log — 2026-09-25 (session `arena/01a0d7b8-nh-dw-2-0`): items 62/63/64 implemented + the item-59 review finding

**Started from a deliberately partial state.** The previous session merged
recon + **8 red unit tests per tree** and an `e2e-list-controls` fixture set,
with `src/utils/listCards.ts` as a compiling NOT-IMPLEMENTED stub. The mandated
first step was the debug-review of that merged partial state; it found a
**fifth** instance of the pattern the rule exists for (see below).

### A. Debug review of the merged red-first state

Verified baseline before touching code: Chrome `npm test` **536 pass / 8 red**,
Firefox **612 pass / 8 red**, both `e2e-list-controls` red at the item-64a bar
assert — exactly the documented red set, no crashes, no hidden failures. The 8
reds were the spec; every one of them is now green in both trees.

Cross-tree audit of the shared files found no missing sender/handler pair in
the new code, but it did surface three things worth recording:

1. **The relay path dropped `request.site` for `downloadAllPages`** while the
   worker-fallback path carried it inside its overrides — the same asymmetry
   class as PR #48's defect 1 (a guard in one path but not its sibling). Fixed
   in both trees (`site: request.site` on the relay, `site?: string` on the
   paged fallback signature, `site: pageSite` on the panel payload).
2. **A content script cannot call `chrome.sidePanel.open`**, so the gallery
   page's Alt-click had no receiver in Chrome: the message action had a sender
   and no handler. Chrome's worker now answers `siteUiOpenPanel` (the Firefox
   tree already did, by opening a panel tab).
3. **Item 59 shipped Firefox-only** — the big one, below.

### B. Review finding: item 59's saved-list-format fix never reached Chrome

`chrome.storage.get({...defaults})` answers ONLY the keys named in the defaults
object. `listSettings.readListSettings()`, `options/options.ts`,
`preview/popupSettings.ts` and Chrome's `content/listControls.ts` all computed
`resolveListFormat(elems.listFormat, elems.useZip)` **without ever requesting
`listFormat`**, so the key was always `undefined`: a saved list format was
ignored everywhere and the UI advertised the inherited single-title one. The
Firefox tree had the fix (2026-09-21, "three shared readers"); the Chrome tree
— the source of truth — never got it.

Why no test caught it: Chrome's `test/list-mode.test.js` stubbed storage as
`Object.assign({}, defaults, store)` — a whole-store merge that returns
unrequested keys, i.e. the exact trap the harness notes warn about ("a
whole-store merge mock once hid the item-59 defect"). It hid it again, for four
days, one tree over.

Fix and coverage (both trees now identical):
- the four Chrome readers request the key explicitly, with no default
  (`Object.keys(defaults).concat("listFormat")`);
- `scripts/test-support/storage.js` (key-scoped, cloning, async) and
  `scripts/test-support/list-format-cases.js` (36-case matrix) are shared;
- `test/list-mode.test.js` uses the key-scoped store (80 assertions on the real
  reader) — **20 of them were red before the fix**;
- `e2e-list-controls.js` gained the item-59 phase: every case drives the real
  bundle's card + bar jobs and asserts no storage writes on open.

### C. Items 62/63/64 — what shipped

**63 — card controls on all six sites.** `src/utils/listCards.ts` is a real
declarative table (`mode`, `linkSelector`, `linkPattern`, container/title/
caption selectors, hitomi's `containerAncestorClass`) with
`listCardTargetForSite()`, `resolveListCardPage()` (an adapter-owned URL that is
NOT a gallery page) and `cardIdFromHref()`. `findCards()` returns
`{id, site, title, card}`; the site then flows into the history lookup
(`toGalleryKey(id, info.site)`), the skip pre-check
(`partitionKnown(history, ids, forced, site)`), bookmarkAdd (`site:`) /
bookmarkRemove (composite key, and the bookmark mirror is now a composite-key
set) and the job payload (`site:`). The manifest gained a `content_scripts`
block covering the five non-nhentai listing hosts with `content.js` +
`listControls.js` + `css/content.css`.

**62 — Smart Download.** Panel: `#buttonSaveOffline` in
`message.downloadInfo`, wired in `popup.ts` to a single-gallery
`downloadAllDoujinshis` built from `readListSettings()` (format, template,
master folder, always `separate: true`), with a **fresh** `readHistory()` guard
— the bootstrap-time note is cosmetic and may be stale — that asks before
re-downloading and then sends `redownloadIds:[id]`; Alt focuses
`#downloadFormat`. Gallery page: `nhdw-title-save` inserted after the Bookmark
button with the same presentational-class copy, plus `nhdw-title-select`
(64b); both are in `OWN_UI_CLASSES` so the anchor search never mistakes them
for the site's buttons.

**64 — Select all + title-page select.** `#nhdw-select-all` beside Clear; the
bar is visible whenever the page HAS cards (`findCards().length > 0`) instead of
only once something is ticked. The gallery page's Select writes the bare id into
the shared `allIds`, and the wipe is now **site-scoped** through a new
`allIdsSite` key (`content.ts` + `preview.ts`) so a selection survives opening a
title on the same site and is dropped when the namespace changes.

### D. Verification

- Chrome **587 unit passing / 4 pending / 0 failing**; Firefox **620 / 4 / 0**.
- `e2e-list-controls` (both trees): every phase green, including the new
  per-site discovery (6 sites × 3 cards), Select all / Clear, and the 36-case
  item-59 matrix.
- `e2e-title-bookmark` (both trees): **146 → 263 checks**, new phase 10 covers
  the per-site Save offline job, the Alt route, the history guard and the
  Select/cross-site wipe.
- `e2e-worker`, `e2e-offscreen`, `e2e-relay`, `e2e-content`,
  `e2e-bookmark-panel`, `e2e-popup` green in Chrome; Firefox additionally runs
  `e2e-options`, `e2e-site-ui`, `e2e-embedded-toolbar` green.
- Versions: Chrome **3.10.0** (source + release manifests in sync, exhaustive
  release-folder sync re-run), Firefox **1.4.0**.

### E. Known gaps (recorded, not fixed)

- The panel **Save offline** *click handler* has no offline coverage: it is
  registered inside `updatePreviewAsync`, which `scripts/e2e-popup.js` cannot
  reach (item 40). It is on the 42/58 real-browser list.
- The hitomi card row still has no captured listing sample (evidence came from
  a live `search.html` fetch): verify the block boundary in a browser first.
- `runPagedBatchDownload` records history with the default site for
  non-nhentai page walks; `downloadAllPages` only ever runs for nhentai today
  (the `getGalleries` content script is nhentai-only), so this is latent, not
  live — worth folding into item 71/70 rather than a silent fix.

## F. Merge + next-session handoff (end of 2026-09-25)

**Merged to `main`: PR #50** (`arena/01a0d7b8-nh-dw-2-0` → `main`, **merge
commit**, not a squash). CI green on both jobs — *Offline suites (fixtures +
window-less VM bundles)* (~1m54s) and *Firefox snapshot (offline suites)*
(~2m29s) — `mergeStateStatus: CLEAN`, 1 commit at merge time, Chrome **3.10.0**
/ Firefox **1.4.0**, `NHDW_Release_v3.0.0` synced exhaustively (source →
release diff clean, reverse check clean).

What the merge carries: items **62/63/64** in both trees (per-site listing card
controls, panel + gallery-page **Save offline**, **Select all**, site-scoped
`allIds` wipe via `allIdsSite`) **and** the Chrome port of item **59** (saved
list format wins over single-title format — `listSettings.readListSettings`,
`options.ts`, `popupSettings.ts`, `listControls.ts` now request the optional
`listFormat` key, plus the key-scoped storage fixture and the 36-case matrix in
both trees).

**Docs refreshed with the merge** (so a fresh session starts accurate):
`SESSION_HANDOFF.md` (MERGED banner, corrected suite counts, next-session
ordering, history pointers 3.10.0 / FF 1.4.0), `WORKLIST.md` (merge banner;
stale "merge PR #48" owner bullet removed; queue is **65 → 71 → 40**, then
owner-only 42/58), this file (sections A–E above + this one + the item table),
`ADAPTER_WIRING_PLAN.md` §5/§6, `CANDIDATE_SITES.md` §5, `CAPTURE_GUIDE.md`,
`MULTISITE_V4_PLAN.md`, and the root / Chrome / Firefox / Release READMEs.

**Next session, in order:** (1) review this diff first — always; (2) item **65**
(rename the Queue tab to **Bookmark tab**, UI-only: storage key, message actions
and export format stay as-is); (3) item **71** (demote the panel's blanket
"Download all (N pages)" now that on-page Select + Select-all exist);
(4) item **40** (bootstrap a listing page in `scripts/e2e-popup.js` — the only
offline-feasible backlog item, and the reason the panel Save-offline *handler*
has no offline coverage); (5) owner-only **42/58** (real-browser + Android
passes, then signing).

## Item stubs — 2026-09-24 owner roadmap (numbers reserved; specs live in WORKLIST until implemented)

| Item | Title | Status |
|---|---|---|
| 60 | Side-panel query-wash / view-reload bug — **fixed 2026-09-24**: `updatePreviewAsync` only paints `invalidPage` over a placeholder, never a live `#action` view; red-first e2e Chrome phase 9 / FF phase 13 | done |
| 61 | Download-tab auto-fetch fill (page-range v1) | done — range block + dual actions both trees, e2e green, Release synced |
| 62 | Smart Download control (direct + open form) beside Bookmark | **done 2026-09-25 (merged, PR #50)** — label **"Save offline"**: panel preview header (`#buttonSaveOffline`, 62a) and the site gallery page (`nhdw-title-save`, 62b), both trees; primary = one-gallery `downloadAllDoujinshis` with `readListSettings()` format/template, `separate:true`, fresh-history guard → confirm → `redownloadIds:[id]`; secondary (Alt) = focus `#downloadFormat` / open the panel via `siteUiOpenPanel` |
| 63 | Card Select/Bookmark/Download on all six sites | **done 2026-09-25 (merged, PR #50)** — real `utils/listCards.ts` table + `findCards()` per-site dispatch (cards carry their site), site-aware history (`partitionKnown(..., site)`), composite bookmark identity, `site:` on every card/bar job, listing-host `content_scripts` block for the five non-nhentai hosts, per-site e2e discovery; `getGalleries` port out of scope |
| 64 | Select-all on listings + title-page select into `allIds` | **done 2026-09-25 (merged, PR #50)** — `#nhdw-select-all` beside Clear with the bar visible whenever `findCards()` finds cards; gallery-page `nhdw-title-select` writes the bare id into the shared `allIds`; `allIdsSite` makes the wipe site-scoped (selection survives same-site navigation, dropped across sites) |
| 65 | Rename Queue tab → Bookmark tab (UI-only) | open |
| 66 | Bookmark tab per-site filter — **dropdown select + remember last selection** (owner pick, elaboration 2 closed 2026-09-24; free-text: restore last choice after unselect/close) | confirmed — with 65 |
| 67 | On-page cart — **badge + expandable mini-cart** (owner pick, elaboration 1 closed 2026-09-24) | confirmed — after 65/68 |
| 68 | Bookmark list load management + **green-check already-downloaded** (true success only, never fail-midway; works with/without search/filter) | open — after 65 |
| 69 | Bookmark thumbnails — **viewport-lazy + GC both** (distance while scrolling + idle ~15–30s sweep; purge all on close/site-group switch; cross-site search keeps GC for dedupe/batch prep) (owner pick, elaboration 3 closed 2026-09-24) | confirmed — with 67/68 |
| 70 | Live-session auto-fetch (twitter-style phase 2) | open — after 61 |
| 71 | Demote panel Download-all where on-page Select exists | open — after 63/64 |

Do not allocate these numbers to anything else.
