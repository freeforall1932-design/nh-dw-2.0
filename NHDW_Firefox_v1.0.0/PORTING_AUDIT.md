# Porting audit — NHentai Downloader Chrome → Firefox

**Date:** 2026-09-03
**Source audited:** `NHDW_Extension_v3.0.0` (Chrome MV3, v3.3.0, commit
`4f918c34`) — files referenced below are inside that folder.
**Result:** port is feasible. No offscreen re-architecture is required
(the fallback already exists); required work is one manifest swap,
fallback-path parity for queue controls, and real-Firefox verification.

---

## 1. Question

Can the Chrome extension folder be ported into a Firefox-compatible
extension, and what exactly is needed?

## 2. Method

1. Inventory of every `chrome.*` browser-API usage in `src/` (grep,
   counted per API and per file).
2. Map each used API to its Firefox status using Mozilla-published
   sources (MDN, bugzilla, Extension Workshop, Mozilla add-ons blog).
3. Trace the two runtime branches the code already has (offscreen relay
   vs. non-offscreen worker fallback) and diff their coverage.
4. Check delivery mechanics of finished archives and the context
   assumptions of each bundle (window vs. worker).
5. Record each finding with file:line evidence and a required action.

## 3. Findings

### 3.1 API inventory (from grep of `src/`, counts)

| API | Calls | Firefox status |
|---|---|---|
| `runtime.sendMessage` / `onMessage` / `lastError` | 38 / 5 / 9 | Supported |
| `storage.local` | 36 | Supported |
| `storage.sync` | 23 | Supported |
| `storage.session` | 4 | Supported, Firefox 115+ |
| `tabs.query` / `onUpdated` / `onActivated` | 5 / 1 / 1 | Supported |
| `downloads.download` | 5 | Supported (scheme limits — 3.4) |
| `action.setIcon` | 3 | Supported (MV3) |
| `scripting.executeScript` | 2 | Supported; `world: MAIN` FF 128+ |
| `permissions.request` | 1 | Supported |
| `offscreen.*` | feature-detected | **Not in Firefox** |
| `tabs.executeScript` | 0 (comment only) | n/a |

No promise-only `chrome.*` call exists (`await chrome…` /
`chrome.…(...).then` grep = empty). Every call is callback-style,
fire-and-forget, or wrapped in a dual callback/promise adapter. Firefox's
callback-based `chrome` namespace is sufficient; no
`webextension-polyfill` dependency is required.

### 3.2 The offscreen document is already optional — key finding

- `background.ts:627` — `USE_OFFSCREEN` is true only when
  `chrome.offscreen.createDocument` is a function. Firefox has no
  `chrome.offscreen` (Chromium-only API), so the flag is false.
- `background.ts:1052+` — "Fallback path for browsers without
  chrome.offscreen: the downloads run directly in this worker (base64
  data URL delivery)" implements `downloadDoujinshi`,
  `downloadAllDoujinshis`, `downloadAllPages`, `goBack`,
  `updateProgress`, `isDownloadFinished` in the background context.
- Conclusion: the architectural work Chrome forced on this codebase
  (moving work off the service worker into a document) is already
  complemented by a full non-offscreen path. Firefox uses the second
  path without code changes.

### 3.3 Background context in Firefox: event page, not service worker

- MDN (`manifest.json/background`): Firefox does not support
  `background.service_worker` (bugzilla 1573659). Firefox MV3 runs
  `background.scripts` as an event page (document). From Firefox 121 the
  background page starts even if `service_worker` is also present (bug
  1860304); Chrome ignores `scripts` in MV3 since 121. A dual-key
  manifest is the documented cross-browser pattern; this port uses a
  Firefox-only manifest with `scripts`.
- The background bundle is context-safe: grep shows no `window.` /
  `document.` references in `src/background/*` or `src/offscreen/*` code
  (only comments). The same `js/background.js` bundle therefore runs
  unchanged in a document context. The MV3 rewrite already removed the
  `window` assignments that would have thrown in a worker.

### 3.4 Archive delivery: object URL path is available in Firefox

- `Downloader.ts:388-404`: delivery picks `URL.createObjectURL(blob)`
  when available, else base64 data URL. The base64 path exists only for
  contexts without `createObjectURL` (Chrome service workers).
- In Firefox the background is an event page (document): `window`
  exists, so `createObjectURL` exists and the blob-object-URL path is
  used.
- Firefox `downloads.download` accepts `blob:` URLs created in an
  extension background context (bugzilla 1696174 — Rob Wu's stated
  workaround; MDN "Work with files" documents `URL.createObjectURL` with
  the downloads API). Data-URL downloads are the historically weak case
  (bugzilla 1622986), so the base64 fallback must not be the primary
  Firefox path. **Runtime check required:** confirm a real Firefox
  honors the `filename` argument for `blob:` downloads
  (Chrome-specific anchor-click fix in `offscreen.ts` is not relevant —
  the offscreen document is never loaded in Firefox).

### 3.5 Parity gap in the non-offscreen fallback — required code work

- `background.ts:976-982`: `pause`, `resume`, `clearQueue` are relayed
  to the offscreen document only (`offscreen.ts:653-666` implements
  them). The non-offscreen fallback branch (3.2) has **no** handlers for
  these three actions; a popup message gets no response (listener
  returns false → silent no-op in Firefox).
- Relay-only responses: `startRelayedJob` answers
  `{ result: "queued", position }` (`background.ts:~955-965`); the
  fallback always answers `{ result: "started" }` — queue-position UI
  parity differs.
- Port work: implement pause/resume/clearQueue in the fallback path
  (the single-gallery Downloader queue lives in `Downloader.ts`) or
  route the commands through a Firefox helper page. This is the only
  functional gap found in code paths.

### 3.6 Version floors that set the Firefox minimum: 128

| Feature used | Firefox since | Source |
|---|---|---|
| `scripting.executeScript` `world: "MAIN"` | 128 | bugzilla 1736575; blog.mozilla.org/addons 2024-07-10 |
| `optional_host_permissions` | 128 | bugzilla 1766026; MDN optional_permissions |
| `storage.session` | 115 | bugzilla 1823713 (FF115 beta) |
| MV3 `background.scripts` start despite `service_worker` key | 121 | bug 1860304; MDN background |
| MV3 host_permissions granted at install | 127 (≤126 not granted) | Extension Workshop MV3 migration guide |

Code note: `scripting` calls are ISOLATED-first with MAIN as a fallback
(`tabImageFetch.ts:206-216`) and tab-fetch failures fall through to
extension-origin fetch, so pre-128 behavior degrades rather than breaks;
`storage.session` is already used defensively (CDN cache, job marker,
"degrades gracefully when unavailable" — backlog item 11).

### 3.7 Manifest deltas (Chrome → Firefox)

| Key | Chrome (current) | Firefox (draft in `manifest.firefox.json`) |
|---|---|---|
| `manifest_version` | 3 | 3 |
| `permissions` | downloads, tabs, storage, alarms, scripting, **offscreen** | same minus **offscreen** (unknown permission name in Firefox) |
| `background` | `{ "service_worker": "js/background.js" }` | `{ "scripts": ["js/background.js"] }` (event page) |
| `browser_specific_settings.gecko` | absent | add `id` + `strict_min_version: "128.0"` (id needed for AMO signing; temporary loads work without it) |
| everything else | — | unchanged (host_permissions, optional_host_permissions, action, options_ui, content_scripts, web_accessible_resources, icons) |

### 3.8 Tests and CI

- Offline suites (fixtures, smoke, VM e2e) stub `chrome` and run without a
  browser: they run unchanged for the port until code diverges.
- `test/manifest.test.js` reads manifests at repo-root relative paths
  (`../../NHDW_Release_v3.0.0`) and asserts the `offscreen` permission:
  must be repointed / made Firefox-aware when the Firefox manifest lands.
- `.github/workflows/extension-tests.yml` triggers cover
  `NHDW_Release_v3.0.0/**` and `NHDW_Extension_v3.0.0/**` only: add
  `NHDW_Firefox_v1.0.0/**` when port code lands.
- `scripts/e2e-browser.js` drives a real Chromium family browser over CDP
  and loads `NHDW_Release_v3.0.0`: it cannot test Firefox. Real-Firefox
  verification needs a manual checklist or a Marionette/WebDriver-BiDi
  harness (separate decision; item 27 step 5).

## 4. Required-change list (work order)

1. Apply Firefox manifest (`background.scripts`, no `offscreen`
   permission, gecko id, min 128) — draft provided in
   `manifest.firefox.json`.
2. Close fallback-path parity: pause/resume/clearQueue + queue-position
   answers in the non-offscreen path (3.5).
3. Repoint `test/manifest.test.js` paths; add Firefox manifest coverage;
   extend CI trigger paths (3.8).
4. `npx web-ext lint`; temporary load via
   `about:debugging#/runtime/this-firefox`; run offline suites.
5. Real-Firefox pass: single/batch/PDF/raw downloads land with correct
   filenames (blob: download + `filename` honoring), queue controls,
   similar-galleries batch, CDN optional-host grant flow, tab-first
   fetch, pause/resume across popup close/reopen.
6. Decide AMO distribution separately (store policy is outside this
   audit).

## 5. Sources

- MDN `background` manifest key:
  https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background
- bugzilla 1573659 (Firefox service-worker support):
  https://bugzilla.mozilla.org/show_bug.cgi?id=1573659
- bugzilla 1860304 (background page start with service_worker present):
  https://bugzilla.mozilla.org/show_bug.cgi?id=1860304
- bugzilla 1696174 (downloads.download blob: URLs):
  https://bugzilla.mozilla.org/show_bug.cgi?id=1696174
- bugzilla 1622986 (downloads.download data: URLs):
  https://bugzilla.mozilla.org/show_bug.cgi?id=1622986
- MDN "Work with files":
  https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Working_with_files
- MDN `optional_permissions` (optional_host_permissions, Firefox 128,
  bug 1766026):
  https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/optional_permissions
- bugzilla 1736575 (world MAIN in scripting API, FF128):
  https://bugzilla.mozilla.org/show_bug.cgi?id=1736575
- Mozilla add-ons blog, "Manifest V3 updates landed in Firefox 128":
  https://blog.mozilla.org/addons/2024/07/10/manifest-v3-updates-landed-in-firefox-128/
- bugzilla 1823713 (storage.session, FF115):
  https://bugzilla.mozilla.org/show_bug.cgi?id=1823713
- Extension Workshop, MV3 migration guide (host permission behavior):
  https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/
- Code evidence: this audit's findings 3.1–3.8 cite `src/**` paths and
  line numbers in `NHDW_Extension_v3.0.0`.
