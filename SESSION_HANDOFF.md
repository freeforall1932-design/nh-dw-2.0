# Current Session Handoff — nh-dw-2.0

**Updated:** 2026-08-26 (after two-mode API access: first-run gate, keyed
metadata routes with 429 backoff, one-shot server archives, key-persistence
fix — merged on top of the popup split / PDF / CDN work)

- Session branch: `arena/01a023e5-nh-dw-2-0` (only use the current session
  branch; check `git branch --show-current`. Earlier sessions used
  `arena/01a027b3-…`, `arena/01a02b04-…`, `arena/01a02397-…`). Do not trust
  older branch names in historic handoff text.
- PR #22 ("Add optional nhentai API key mode with first-run gate and one-shot
  archive downloads") was merged on 2026-08-26T08:38:07Z as merge commit
  `05cd7c5` (full: `05cd7c537f39d091b01a458519acdd7742051cd7`) —
  https://github.com/freeforall1932-design/nh-dw-2.0/pull/22.
  It incorporated the mid-flight merge of `origin/main` (PRs #18–#21: queue
  controls, pause/resume, popup split + similar galleries, title-named
  archives, PDF output, CDN hardening) and re-validation of the combined
  tree (149 passing / 1 pending, all smoke + e2e green). Follow-up work
  starts from `main` on a fresh session branch.

## Repository and branch

- Checkout: `/home/user/nh-dw-2.0`
- **Only use the current session branch** (check `git branch --show-current`; earlier sessions used `arena/01a027b3-nh-dw-2-0` then `arena/01a02b04-nh-dw-2-0`). Do not trust older branch names in historic handoff text.
- Source: `NHDW_Extension_v3.0.0/`
- Loadable unpacked build: `NHDW_Release_v3.0.0/`
- These are distinct folders. Source contains TypeScript/tests; release is the browser-loadable package. After every build: `cp js/*.js ../NHDW_Release_v3.0.0/js/`, verify `diff -rq js ../NHDW_Release_v3.0.0/js`, and also sync `index.html`, `options.html`, `css/*`, `manifest.json` when they change (the release README intentionally differs).

## Current implemented work

### Popup split + similar-gallery selection (newest)

- Single-gallery popup is two columns: **left** = current gallery (title, page count, ZIP/CBZ/PDF/raw picker, path input, Download); **right** = **Similar galleries** panel.
- The panel fetches `GET /api/v2/galleries/{id}/related` only when the user clicks *Show similar galleries*, then renders a checkbox list (title + page count; `(Non-titled) #id` fallback), **All/None** toggles, and **Download selected (n)**.
- Selections send `downloadAllDoujinshis` with `separate: true` → **one archive per selected gallery**, each named after its title (flat layout). The per-job `formatOverride` from the left picker applies. `separate` overrides the stored *download each file separately* option for that job only.
- Untitled related cards use `(Non-titled) #id` (matches nhentai's own display) so files remain traceable.

### Archive naming and structure (newest)

- **Single-gallery ZIP/CBZ/PDF**: named `<clean title>.zip|.cbz|.pdf` with pages at the archive **root** (`001.jpg`, `002.png`, …) — no `Title/Title` double folder. Implemented via `Downloader` setting `archiveLayout: "flat"`.
- **Shared batch archive** (listing-page batches, multi-page batches, non-separate similar): unchanged shape — one folder per gallery inside the single archive (`archiveLayout: "nested"`, the default when unset).
- **Raw mode**: pages now save as `Downloads/<Title>/001.jpg` (titled folder + zero-padded numbering) instead of flat `Title-001.jpg`.
- **Last-mile filename hardening**: `sanitizeArtifactFilename` (exported from `Downloader.ts`) runs inside `#saveArtifact` for every artifact — strips control/reserved characters per path segment, leading dots, trailing dots/spaces, caps segment length, never returns empty. This addresses downloads landing under blob-UUID/number names when Chrome discards an invalid requested filename.

### PDF output format (replaced the folder mode)

- `src/utils/pdfBuilder.ts`: dependency-free PDF 1.4 writer. `jpegInfo(bytes)` parses SOF0/SOF2 frames (dimensions + component count, skips APPn thumbnails); `buildPdfDocument(images)` emits catalog/pages/page/content/image objects with DCTDecode XObjects and a byte-exact xref table.
- `Downloader` `useZip: "pdf"`: collects validated page bytes in order, embeds RGB JPEGs verbatim (no re-encode), re-encodes grayscale/CMYK JPEGs and PNG/GIF/WebP via `createImageBitmap` + `OffscreenCanvas` (white-flattened) when available, delivers `<title>.pdf` through the same object-URL/data-URL path as ZIP.
- **"folder" is retired**: options select and popup pickers now offer zip/cbz/pdf/raw; every legacy `"folder"` value (stored settings, format overrides) maps to `"pdf"` (`Downloader` whitelist, `normalizeFormatOverride` in background.ts, popup extension hints).
- The offscreen document still uses **only** `chrome.runtime`; PDF assembly happens in the same context as ZIP assembly.

### CDN configuration hardening (previous session)

- `src/sources/cdnConfig.ts` is the shared image-server configuration (validated HTTPS `*.nhentai.net` origins only); `src/background/cdnConfigService.ts` resolves `GET /api/v2/cdn` once per session (source-tab first, 6s timeout, cached in memory + `chrome.storage.session`, 1h TTL) and permission-filters the list.
- Manifest: static `host_permissions` unchanged + `optional_host_permissions: ["https://*.nhentai.net/*"]` + `permissions` API. Popup `getCdnStatus` notice with a one-click **Grant image host access** when nhentai reports ungranted hosts; downloads keep using permitted hosts meanwhile.
- Offscreen applies relayed `options.imageServers` per job.

### Download lifecycle (unchanged)

- MV3 worker relays downloads to the offscreen document; offscreen owns fetch/ZIP/PDF work, worker owns storage/downloads/scripting/permissions.
- Queue serialization, session pause/resume, queue/cancel controls, batch summary — all as before. Job start resolves CDN config first; the job marker goes up synchronously when the job is accepted.
- Session-only pause/resume: no durable restart resume — do not claim it.

### Source-tab requirement

- The source nhentai gallery tab must stay open (may be backgrounded; user whitelisted nhentai.net in their suspender) until its job completes; tab-context image fetch and the CDN config fetch prefer its Cloudflare-cleared session.

### API key

- Options page: optional user-pasted key, verified via third-party-safe `GET /api/v2/user` with `Authorization: Key <key>` only. Stored in `chrome.storage.local`, never rendered back. Never use `/api/v2/auth/*`.

### Options-page UX pass (2026-08-26, user live-test feedback)

- API key field now supports explicit paste (intercepted `paste` event; some
  browsers offer no right-click menu on extension pages) — in both the
  options page and the popup gate, with a visible Ctrl+V hint.
- Plain-language explanations for every option: what ZIP/CBZ/PDF/raw
  produce, exactly what Duplicate rename/ignore do, what the server-archive
  toggle does (no programmer-speak), one-line format hints.
- Name template is now **checkboxes** (one per placeholder, canonical order,
  " - " separator) instead of manual typing; stored format unchanged
  (`{pretty} - {id}`) so the engine and old templates are untouched; custom
  templates fall back to the manual input (`src/options/nameTemplate.ts` +
  `test/name-template.test.js`).
- Settings-inside-popup (Download | Settings tabs) is work-list item 20
  (design sketch in `IMPROVEMENT_BACKLOG.md`).

### Two-mode API access (2026-08-26, PR #22)

Boundary table — **API key mode** (a key is stored) vs **open tab mode**
(no key; byte-for-byte the pre-key behaviour):

| Concern | API key mode | Open tab mode |
|---|---|---|
| Metadata route order | keyed official API → open-tab read → plain fetch | open-tab read → plain fetch |
| `Authorization` header | `Key <key>` on `nhentai.net/api/` URLs only | never created |
| `429` handling | `Retry-After` backoff (clamped 0.25–15 s, max 2 retries) | n/a |
| Batch downloads | independent of the open tab's session | resolve through the open tab only |
| One-shot server archives | available (opt-in) | not available (endpoint requires auth) |

- **First-run gate** (popup): a box asks for the key with two explicit exits,
  **Submit key** / **Continue without API key**; the decision is remembered
  (`apiKeyGate` in storage.local). Mode badges ("API key" / "open tab") show
  in single and batch previews. Saving a key in options withdraws a previous
  skip; removing the key re-arms the gate.
- **Keyed routes**: `fetchNhentaiApi()` in `src/utils/apiAuth.ts` (headers
  only for `https://nhentai.net/api/`, best-effort descriptive User-Agent,
  429 backoff). Wired into popup preview, worker batch, offscreen batch —
  always falling through to the keyless routes on failure, so an invalid key
  can never break a download.
- **One-shot server archives** (experimental, opt-in toggle
  `useServerArchive`): `POST /api/v2/galleries/<id>/download?format=zip|cbz`
  (keyed; returns `{ url, expires_at }`) — `src/background/ArchiveDownload.ts`
  + `Downloader.#tryServerArchiveAsync()`. Runs only when this gallery owns
  the whole archive (never mid-shared-batch), only for ZIP/CBZ, and any
  failure (401/403/503/429/network/malformed) falls back to page-by-page.
  The signed delivery URL is fetched **without** the key.
- **Persistence fix**: the popup bootstrap used `storage.local.clear()` on
  URL changes, which would wipe the key — replaced with targeted
  `remove("allIds")`. Guarded by a test asserting the popup bundle never
  contains `storage.local.clear()`.

## Validation

```bash
cd NHDW_Extension_v3.0.0
npm ci
npm run build
npm test              # 149 passing, 1 pending live test
npm run test:smoke
npm run test:e2e      # worker (incl. PDF + CDN phases), offscreen (incl. PDF + CDN), relay, content
cp js/*.js ../NHDW_Release_v3.0.0/js/
diff -rq js ../NHDW_Release_v3.0.0/js
# also diff index.html / options.html / css / manifest.json when they change
```

`npm run test:browser` needs a full Chrome/Brave build (serverless `@sparticuz/chromium` has extensions compiled out). `NHDW_CHROME_EXTRA_ARGS` exists as an escape hatch. CI (`.github/workflows/e2e-browser.yml`) runs the real-Chrome suite.

## Required real-browser verification before PR

Reload unpacked `NHDW_Release_v3.0.0` through `chrome://extensions` or `brave://extensions`.

1. Single-gallery ZIP download: file named exactly the gallery title, pages at the ZIP root (no inner title folder). Repeat for CBZ.
2. **PDF**: same title naming; open the produced PDF — every page present, correct order, correct orientation/aspect.
3. Raw: pages land in `Downloads/<Title>/` as `001.jpg`… — no bare-number filenames anywhere.
4. Popup layout: left column downloads the current gallery; right column *Show similar galleries* lists related titles with checkboxes; uncheck a few; *Download selected (n)* produces one titled file per selected gallery.
5. Similar download with an untitled related gallery → file shows `(Non-titled) #id`-derived name, not a bare random number.
6. Queue two or more jobs; serial order, queue count, Clear queue, Cancel current; pause/resume across popup close/reopen.
7. API key: valid, invalid, remove; saved key never appears in the input. Download similar anonymously and with the key.
8. Keep the source gallery tab backgrounded on another site; confirm completion.
9. CDN hardening: `/api/v2/cdn` fetched once per session (worker console); `chrome.storage.session.get("cdnConfig")` shows the merged list; grant-notice flow when a host lacks permission.

## Next backlog

- ~~Server-side ZIP/CBZ endpoint with API key; fall back on 429/503~~ — DONE
  (PR #22, opt-in `useServerArchive` toggle with page-by-page fallback).
  Remaining: check of whether the account actually gets a usable URL from
  `POST .../download` (`allow_downloads` feature flag / tier), and
  keep-or-remove decision for the toggle based on that result. This can now
  be answered WITHOUT a browser or the extension:
  `NH_API_KEY=<key> npm run test:live` probes the keyed profile endpoint,
  keyed metadata (through the real normalizer), and the archive endpoint,
  then reports availability (200 + ZIP magic) vs gated (401/403/503/429).
- Real-browser verification of the keyed route winning in the worker console
  (previous open question: is a same-tab/worker fetch of `/api/v2/galleries`
  challenged? With a key it uses the official contract).
- Optional: sync the API key across the user's own devices
  (`chrome.storage.sync`) — deliberately local-only today; needs an explicit
  user decision (secret syncing).
- Optional: force the descriptive `User-Agent` via `declarativeNetRequest`
  (fetch() forbids it in some contexts) — deferred, adds a permission.
- Persistent restart-safe resume (checkpoint/rebuild strategy).
- Search/favorites/blacklist/comments API UI features.
- PDF niceties (not required): PDF/AV viewers validate fine, but consider a cover/thumbnail entry or bookmarks outline if ever requested.

## Do not

- Do not switch branches or push to a branch other than the current session branch.
- Do not put `chrome.storage`, `chrome.downloads`, `chrome.scripting`, or `chrome.permissions` in the offscreen document.
- Do not use `/api/v2/auth/*` or `/api/v2/user/keys`.
- Do not remove tab-first fetching or claim Cloudflare bypass.
- Do not run `npm audit fix --force`.
- Do not expand web-accessible resources.
- Do not add `<all_urls>` (or any non-nhentai host) to host/optional-host permissions; all image hosts must validate as HTTPS `*.nhentai.net` origins.
- Do not reintroduce the "folder" output mode; PDF replaced it (legacy `"folder"` values must keep mapping to `"pdf"`).
