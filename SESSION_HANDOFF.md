# Session handoff — nh-dw-2.0 / NHentai Downloader

Written 2026-08-20 after the offscreen API-surface fix + folder output mode.
Previous work landed via PR #12 (tab-first image fetches) — now on `main` (`c6530af`).

- Repo checkout: /home/user/nh-dw-2.0
- Session branch (this session; never switch/push any other branch): `arena/01a01f4d-nh-dw-2-0`
- Baseline: `main` at `c6530af` (PR #12 merged) == `fad5476`.

## The bug found this session (real-browser report from the user)

Symptoms on a real machine (Chrome, reload unpacked `NHDW_Release_v3.0.0`):

- Homepage scan + selection worked; clicking Download opened temporary tabs (the
  selected-gallery resolver) and then NOTHING downloaded.
- Console: `Uncaught TypeError: Cannot read properties of undefined (reading 'sync')`
  at offscreen.js module load; `Uncaught (in promise) Error: Could not establish
  connection. Receiving end does not exist.` in background.js; repeated
  `Unchecked runtime.lastError: A listener indicated an asynchronous response by
  returning true, but the message channel closed before a response was received`.

Root cause (confirmed against the Chrome docs): **"The runtime API is the only
extensions API supported by offscreen documents."** The offscreen bundle called
`chrome.storage.sync.get` at module top level (offscreen.ts) → `chrome.storage`
is undefined in a real offscreen document → module crashed BEFORE
`chrome.runtime.onMessage.addListener` registered → every relayed download died
with "Receiving end does not exist". The sandbox harnesses never caught it
because `scripts/e2e-offscreen.js` (and the downloader tests) stubbed
`chrome.storage` / `chrome.downloads` in the offscreen context.
`chrome.scripting` (tab injections) and `chrome.downloads` (zip save, raw mode)
are equally unavailable in offscreen documents.

Secondary bug: the worker's `onMessage` listener returned `true` for
fire-and-forget messages (offscreen progress broadcasts, `getGalleries` from the
content script) without ever answering → the "message channel closed" noise.

## What this session changed (all committed on the session branch)

1. **Offscreen document uses only `chrome.runtime`** (`src/offscreen/offscreen.ts`):
   - No `chrome.storage` anywhere: download options (`useZip`, `downloadName`,
     `duplicateBehaviour`, `replaceSpaces`, `downloadSeparately`,
     `maxConcurrentDownloads`, `htmlParsing`) arrive in the relayed command —
     the service worker reads `chrome.storage.sync` and attaches `options`.
   - Artifacts are saved by the worker: offscreen sends
     `{from:"offscreen", action:"saveDownload", url, filename}` → worker calls
     `chrome.downloads.download` (blob: URLs are extension-origin, so this
     works; raw mode relays the CDN URL the same way).
   - Tab injections run in the worker: `fetchInTab` (image bytes, ISOLATED then
     MAIN) and `fetchUrlInTab` (page text, MAIN) — see `tabImageFetch.ts`
     (`scriptingAvailable()` picks direct vs relay; new `fetchUrlInPage`,
     `fetchUrlFromTab`, exported `fetchImageInPage` — all self-contained
     Promise chains, no async/await).
   - The active-job marker is owned by the worker (`setJobMarker`): set when a
     download is relayed, cleared on goBack / offscreenIdle / fallback finish.
2. **`Downloader`** (`src/background/Downloader.ts`):
   - New constructor `settings` arg (`{useZip, maxConcurrentDownloads}`) — when
     present the class never touches `chrome.storage` (storage read remains the
     fallback for the worker path and tests; now wrapped so an unavailable
     storage cannot silently kill a job).
   - New `saveUrl` hook: when set (offscreen → worker relay), zip blobs,
     folder-mode images and raw CDN URLs all go through it instead of
     `chrome.downloads` directly.
   - **Folder mode** (`useZip === "folder"`): no archive — each validated page
     is saved as `Downloads/<Title>/NNN.ext` through the same tab-first fetch +
     mirror fallback + content-type/size validation. Save failure surfaces as
     "Failed to save image to NNN.ext (…)" (classified as `image`).
3. **Worker** (`src/background/background.ts`):
   - `saveDownload` / `fetchInTab` / `fetchUrlInTab` handlers; `offscreenIdle`
     clears the job marker before closing the document.
   - `askOffscreen` retries once (close + recreate the document) when the
     response is "Receiving end does not exist".
   - Listener returns `true` ONLY on branches that answer (kills the
     lastError noise); unknown actions (e.g. `getGalleries`) return `false`.
   - `isDownloadFinished` treats "no receiving end" as "not downloading".
4. **Batch via the user's tab session**: unresolved batch metadata and
   `downloadAllPages` listing fetches go through the open nhentai tab first
   (`fetchUrlFromTab`) before the extension-origin fallback — reuses any
   completed Cloudflare clearance. Not a bypass: a challenged tab has nothing
   to reuse and the fallback fails as before.
5. **Folder output option**: Options → Download format → "Images in a folder
   (no zip)"; popup shows "(images folder)" for single downloads and no archive
   suffix for batch. `options.html` + `popup.ts`.
6. **Salvaged from the user's `nh-dw-2.0-main-fixed.zip`** (its PR #11-era
   local fixes, verified identical to `d24d735` otherwise):
   - `web_accessible_resources` narrowed from `*` / `<all_urls>` to
     `["Icon.png","Icon-grey.png"]` / `https://nhentai.net/*` (source + release
     manifests; nothing else needs WAR — the only `getURL` use is the
     icon in the worker). Guarded by a new manifest test.
   - `scripts/smoke-mv3.js`: `chrome.storage.session` mock (the worker's
     job marker uses it).
   - `popup.ts`: duplicate `//#region "multiple download"` removed.
7. **Honest harnesses**: `scripts/e2e-offscreen.js` now runs with a Proxy-backed
   chrome stub that has NO storage/downloads/scripting (exactly like real
   Chrome) and fails if the bundle touches storage or downloads; it simulates
   the worker side (saveDownload → downloads, fetchInTab/fetchUrlInTab → tab
   fetch) and adds tab-first image + tab-metadata test cases.
   `scripts/e2e-relay.js` asserts the options relay, saveDownload,
   fetchInTab (ISOLATED world), fetchUrlInTab (MAIN world), and that
   broadcasts / unknown actions do not keep the channel open.

## Verification done (sandbox, all offline)

- webpack build OK
- `npm test`: 75 passing, 1 pending (live API, opt-in RUN_LIVE_TESTS=1)
- `npm run test:smoke` OK (worker + offscreen)
- `npm run test:e2e` OK (worker, offscreen with no storage/downloads/scripting,
  relay incl. save/fetch relays, content)
- Release `js/*` copied and diff-identical to source build
- `test:browser`: no Chrome/Brave in this sandbox ("No browser found" is the
  harness, not a regression)

## What is left

- **Real-machine re-test** (the user has a working browser; the previous
  session's must-dos now collapse into one pass after reloading unpacked):
  1. Toolbar icon OK, no console errors on load.
  2. Homepage: select 2+ galleries → Download. Expect: resolver temp tabs open
     and close, then ONE progress run and the ZIP (or folder) landing in
     Downloads. No "Could not establish connection".
  3. Single gallery tab (fully loaded, not a CF interstitial) → Download.
  4. Options → folder mode → single + batch download → `Downloads/<Title>/`
     folders filled with the images.
  5. `cd NHDW_Extension_v3.0.0 && npm run test:browser` (sudo for :443 fixture).
- CI: the e2e-browser workflow runs offline suites + real Chrome/Brave; the
  previous session's Chrome `Runtime.enable` timeout / Brave SIGTRAP were being
  re-checked — confirm on the new commits.

## DO NOT

- npm audit fix --force
- Onion / Tor routing (item 9, intentionally DROPPED; a Chrome MV3 extension
  cannot route through Tor, and the user's `.onion` URL only resolves in a Tor
  browser, which cannot run this extension)
- Claim the extension bypasses Cloudflare
- Treat sandbox test:browser "No browser found" as a new bug
- Switch/push any branch other than `arena/01a01f4d-nh-dw-2-0`
- Delete/rename repo root or .git

## KEY FILES

- `NHDW_Extension_v3.0.0/src/offscreen/offscreen.ts` (runtime-only offscreen)
- `NHDW_Extension_v3.0.0/src/background/tabImageFetch.ts` (direct/relay tab fetch)
- `NHDW_Extension_v3.0.0/src/background/Downloader.ts` (settings, saveUrl, folder)
- `NHDW_Extension_v3.0.0/src/background/background.ts` (save/fetch relays, options, marker, returns)
- `NHDW_Extension_v3.0.0/src/preview/popup.ts` (tabId + folder display)
- `NHDW_Extension_v3.0.0/src/preview/selectedGalleryResolver.ts` (temp tabs for batch metadata)
- `NHDW_Extension_v3.0.0/src/utils/utils.ts` (classifyError incl. "failed to save image")
- `NHDW_Extension_v3.0.0/options.html` (folder option)
- `NHDW_Extension_v3.0.0/test/downloader.test.js` (folder-mode block)
- `NHDW_Extension_v3.0.0/test/manifest.test.js` (WAR guard)
- `NHDW_Extension_v3.0.0/scripts/e2e-offscreen.js` (no storage/downloads/scripting)
- `NHDW_Extension_v3.0.0/scripts/e2e-relay.js` (options + save/fetch relays + returns)
- `NHDW_Extension_v3.0.0/scripts/smoke-mv3.js` (session mock)
- `NHDW_Release_v3.0.0/js/*` must match webpack output

## Layout

- `NHDW_Extension_v3.0.0/` — TypeScript source, webpack → js/, tests, scripts
- `NHDW_Release_v3.0.0/` — unpacked load folder (js must stay in sync)
- `NHDW_Source_v3.0.0/` — older snapshot, do not treat as current
- `nh-dw-2.0-main-fixed.zip` — the user's PR #11-era local snapshot (kept for
  reference; everything salvageable from it has been ported)
